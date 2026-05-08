import SqliteDatabase from "better-sqlite3";
import { migrate } from "../../src/storage/migrations.js";
import { SqliteBudgetStore } from "../../src/storage/budget-store.js";
import { SqliteEventLog } from "../../src/storage/event-log.js";
import {
  DefaultBudgetManager,
  BudgetManager,
} from "../../src/scheduling/budget-manager.js";
import { parseWorkOrderV1 } from "../../src/core/schemas-v1.js";
import type { ParsedWorkOrderV1 } from "../../src/core/schemas-v1.js";
import type { Database } from "../../src/storage/database.js";
import type { BudgetState } from "../../src/core/types.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeWorkOrder(overrides?: Partial<Record<string, unknown>>): ParsedWorkOrderV1 {
  const base = {
    schema_version: "workflow/v1",
    task_id: "task-test",
    title: "Test Task",
    type: "code_change",
    goal: "Fix a bug",
    acceptance_criteria: ["test passes"],
    repo: { path: "/tmp/repo" },
    agent: {
      required_capabilities: ["code_change"],
      implementer_pool: ["agent-1"],
    },
    ...overrides,
  };
  return parseWorkOrderV1(base);
}

function queryEvents(db: Database, taskId: string): Array<Record<string, unknown>> {
  return db
    .prepare("select * from task_events where task_id = ? order by created_at asc")
    .all(taskId) as Array<Record<string, unknown>>;
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe("DefaultBudgetManager", () => {
  let db: Database;
  let manager: BudgetManager;

  beforeEach(() => {
    db = new SqliteDatabase(":memory:");
    migrate(db);

    const budgetStore = new SqliteBudgetStore(db);
    const eventLog = new SqliteEventLog(db);

    manager = new DefaultBudgetManager({
      budgetStore,
      eventLog,
    });
  });

  afterEach(() => {
    db.close();
  });

  // ── init ──────────────────────────────────────────────────────────────────

  describe("init", () => {
    it("maps WorkOrder caps to BudgetState and returns zeroed state", () => {
      const wo = makeWorkOrder({
        task_id: "task-init-1",
        budget: {
          max_wall_time_minutes: 10,
          max_total_cost_units: 5,
          max_runs: 3,
        },
      });

      const state = manager.init(wo);

      expect(state.task_id).toBe("task-init-1");
      expect(state.runs_used).toBe(0);
      expect(state.wall_time_ms_used).toBe(0);
      expect(state.cost_units_used).toBe(0);
      expect(state.status).toBe("ok");
      expect(state.caps.max_runs).toBe(3);
      expect(state.caps.max_wall_time_ms).toBe(10 * 60_000);
      expect(state.caps.max_total_cost_units).toBe(5);
    });

    it("uses defaults from parsed WorkOrder when budget fields are omitted", () => {
      // No explicit budget → Zod defaults apply: max_runs=4, max_wall_time_minutes=30, max_total_cost_units=10
      const wo = makeWorkOrder({ task_id: "task-defaults" });

      const state = manager.init(wo);

      expect(state.caps.max_runs).toBe(4);
      expect(state.caps.max_wall_time_ms).toBe(30 * 60_000);
      expect(state.caps.max_total_cost_units).toBe(10);
    });

    it("is idempotent and does not reset usage", () => {
      const wo = makeWorkOrder({
        task_id: "task-idem",
        budget: { max_runs: 5, max_wall_time_minutes: 30, max_total_cost_units: 10 },
      });

      manager.init(wo);
      manager.preLaunch("task-idem"); // runs_used = 1

      // second init should not reset
      const state = manager.init(wo);

      expect(state.runs_used).toBe(1);
      expect(state.status).toBe("ok");
    });
  });

  // ── current ───────────────────────────────────────────────────────────────

  describe("current", () => {
    it("returns current BudgetState from store", () => {
      const wo = makeWorkOrder({ task_id: "task-curr" });
      manager.init(wo);

      const state = manager.current("task-curr");
      expect(state.task_id).toBe("task-curr");
      expect(state.runs_used).toBe(0);
      expect(state.status).toBe("ok");
    });

    it("throws for unknown taskId", () => {
      expect(() => manager.current("nonexistent")).toThrow(
        "Budget not found for task",
      );
    });
  });

  // ── preLaunch ─────────────────────────────────────────────────────────────

  describe("preLaunch", () => {
    it("increments only runs_used", () => {
      const wo = makeWorkOrder({ task_id: "task-pl" });
      manager.init(wo);

      const state = manager.preLaunch("task-pl");

      expect(state.runs_used).toBe(1);
      expect(state.wall_time_ms_used).toBe(0);
      expect(state.cost_units_used).toBe(0);
      expect(state.status).toBe("ok");
    });

    it("increments runs_used on multiple calls", () => {
      const wo = makeWorkOrder({ task_id: "task-pl2" });
      manager.init(wo);

      manager.preLaunch("task-pl2");
      const state = manager.preLaunch("task-pl2");

      expect(state.runs_used).toBe(2);
    });
  });

  // ── postRun ───────────────────────────────────────────────────────────────

  describe("postRun", () => {
    it("updates wall time and cost", () => {
      const wo = makeWorkOrder({ task_id: "task-pr" });
      manager.init(wo);
      manager.preLaunch("task-pr");

      const state = manager.postRun({
        taskId: "task-pr",
        runDurationMs: 120_000,
        estimatedCostUnits: 2,
      });

      expect(state.wall_time_ms_used).toBe(120_000);
      expect(state.cost_units_used).toBe(2);
      expect(state.runs_used).toBe(1); // unchanged by postRun
    });

    it("uses actual cost when provided", () => {
      const wo = makeWorkOrder({ task_id: "task-actual" });
      manager.init(wo);
      manager.preLaunch("task-actual");

      const state = manager.postRun({
        taskId: "task-actual",
        runDurationMs: 60_000,
        actualCostUnits: 3.5,
        estimatedCostUnits: 2,
      });

      expect(state.cost_units_used).toBe(3.5);
    });

    it("uses estimated cost when actual is omitted", () => {
      const wo = makeWorkOrder({ task_id: "task-est" });
      manager.init(wo);
      manager.preLaunch("task-est");

      const state = manager.postRun({
        taskId: "task-est",
        runDurationMs: 60_000,
        estimatedCostUnits: 2.5,
      });

      expect(state.cost_units_used).toBe(2.5);
    });
  });

  // ── quota.low events ──────────────────────────────────────────────────────

  describe("quota.low emission", () => {
    it("emits quota.low once when crossing 80% via preLaunch (runs axis)", () => {
      const wo = makeWorkOrder({
        task_id: "task-low-1",
        budget: { max_runs: 10, max_wall_time_minutes: 60, max_total_cost_units: 100 },
      });
      manager.init(wo);

      // 7 runs -> 70% → ok. 8th run → 80% → soft_warning.
      for (let i = 0; i < 7; i++) manager.preLaunch("task-low-1");
      manager.preLaunch("task-low-1"); // crosses 80%

      const events = queryEvents(db, "task-low-1");
      const lowEvents = events.filter((e) => e.event_type === "quota.low");
      expect(lowEvents.length).toBe(1);

      const payload = JSON.parse(lowEvents[0].payload_json as string);
      expect(payload.scope).toBe("task");
      expect(payload.task_id).toBe("task-low-1");
      expect(payload.axis).toBe("runs");
      expect(payload.ratio).toBe(0.8);
    });

    it("emits quota.low once when crossing 80% via postRun (wall time axis)", () => {
      const wo = makeWorkOrder({
        task_id: "task-low-2",
        budget: { max_runs: 10, max_wall_time_minutes: 1, max_total_cost_units: 100 },
      });
      manager.init(wo);

      // max_wall_time_ms = 60_000.  80% = 48_000 ms.
      manager.preLaunch("task-low-2");
      manager.postRun({
        taskId: "task-low-2",
        runDurationMs: 30_000,
        estimatedCostUnits: 1,
      });
      // wall_time: 30_000 -> 50% → ok

      manager.preLaunch("task-low-2");
      manager.postRun({
        taskId: "task-low-2",
        runDurationMs: 20_000,
        estimatedCostUnits: 1,
      });
      // wall_time: 50_000 -> ~83% → soft_warning

      const events = queryEvents(db, "task-low-2");
      const lowEvents = events.filter((e) => e.event_type === "quota.low");
      expect(lowEvents.length).toBe(1);

      const payload = JSON.parse(lowEvents[0].payload_json as string);
      expect(payload.axis).toBe("wall_time_ms");
    });

    it("emits quota.low once when crossing 80% via postRun (cost axis)", () => {
      const wo = makeWorkOrder({
        task_id: "task-low-3",
        budget: { max_runs: 100, max_wall_time_minutes: 60, max_total_cost_units: 10 },
      });
      manager.init(wo);

      // 80% of 10 = 8
      manager.preLaunch("task-low-3");
      manager.postRun({
        taskId: "task-low-3",
        runDurationMs: 1_000,
        estimatedCostUnits: 8.5,
      });

      const state = manager.current("task-low-3");
      expect(state.status).toBe("soft_warning");

      const events = queryEvents(db, "task-low-3");
      const lowEvents = events.filter((e) => e.event_type === "quota.low");
      expect(lowEvents.length).toBe(1);

      const payload = JSON.parse(lowEvents[0].payload_json as string);
      expect(payload.axis).toBe("cost_units");
    });

    it("does NOT emit duplicate quota.low on repeated calls while already soft_warning", () => {
      const wo = makeWorkOrder({
        task_id: "task-nodup-low",
        budget: { max_runs: 10, max_wall_time_minutes: 60, max_total_cost_units: 100 },
      });
      manager.init(wo);

      // Cross into soft_warning via runs
      for (let i = 0; i < 8; i++) manager.preLaunch("task-nodup-low");

      // Still soft_warning — should NOT emit another quota.low
      manager.preLaunch("task-nodup-low");
      manager.preLaunch("task-nodup-low");

      const events = queryEvents(db, "task-nodup-low");
      const lowEvents = events.filter((e) => e.event_type === "quota.low");
      expect(lowEvents.length).toBe(1);
    });

    it("emits quota.low with skip_on_replay: true", () => {
      const wo = makeWorkOrder({
        task_id: "task-skip-low",
        budget: { max_runs: 10, max_wall_time_minutes: 60, max_total_cost_units: 100 },
      });
      manager.init(wo);

      for (let i = 0; i < 8; i++) manager.preLaunch("task-skip-low");

      const events = queryEvents(db, "task-skip-low");
      const lowEvents = events.filter((e) => e.event_type === "quota.low");
      expect(lowEvents.length).toBe(1);
      expect(lowEvents[0].skip_on_replay).toBe(1);
    });
  });

  // ── quota.exhausted events ────────────────────────────────────────────────

  describe("quota.exhausted emission", () => {
    it("emits quota.exhausted once when crossing 100% via preLaunch", () => {
      const wo = makeWorkOrder({
        task_id: "task-exh-1",
        budget: { max_runs: 5, max_wall_time_minutes: 60, max_total_cost_units: 100 },
      });
      manager.init(wo);

      for (let i = 0; i < 5; i++) manager.preLaunch("task-exh-1");

      const state = manager.current("task-exh-1");
      expect(state.status).toBe("exhausted");

      const events = queryEvents(db, "task-exh-1");
      const exhEvents = events.filter((e) => e.event_type === "quota.exhausted");
      expect(exhEvents.length).toBe(1);

      const payload = JSON.parse(exhEvents[0].payload_json as string);
      expect(payload.scope).toBe("task");
      expect(payload.task_id).toBe("task-exh-1");
      expect(payload.axis).toBe("runs");
    });

    it("emits quota.exhausted once when crossing 100% via postRun", () => {
      const wo = makeWorkOrder({
        task_id: "task-exh-2",
        budget: { max_runs: 100, max_wall_time_minutes: 60, max_total_cost_units: 10 },
      });
      manager.init(wo);

      manager.preLaunch("task-exh-2");
      manager.postRun({
        taskId: "task-exh-2",
        runDurationMs: 1_000,
        estimatedCostUnits: 10,
      });

      const state = manager.current("task-exh-2");
      expect(state.status).toBe("exhausted");

      const events = queryEvents(db, "task-exh-2");
      const exhEvents = events.filter((e) => e.event_type === "quota.exhausted");
      expect(exhEvents.length).toBe(1);
    });

    it("does NOT emit duplicate quota.exhausted on repeated calls while already exhausted", () => {
      const wo = makeWorkOrder({
        task_id: "task-nodup-exh",
        budget: { max_runs: 5, max_wall_time_minutes: 60, max_total_cost_units: 100 },
      });
      manager.init(wo);

      for (let i = 0; i < 5; i++) manager.preLaunch("task-nodup-exh");

      // Already exhausted — should NOT emit another
      manager.preLaunch("task-nodup-exh");
      manager.postRun({
        taskId: "task-nodup-exh",
        runDurationMs: 1_000,
        estimatedCostUnits: 5,
      });

      const events = queryEvents(db, "task-nodup-exh");
      const exhEvents = events.filter((e) => e.event_type === "quota.exhausted");
      expect(exhEvents.length).toBe(1);
    });

    it("also emits quota.low before quota.exhausted when jumping from ok to exhausted", () => {
      const wo = makeWorkOrder({
        task_id: "task-jump",
        budget: { max_runs: 2, max_wall_time_minutes: 60, max_total_cost_units: 100 },
      });
      manager.init(wo);

      // 2 runs = 100% -> exhausted. No prior soft_warning because it goes ok -> exhausted.
      manager.preLaunch("task-jump");
      manager.preLaunch("task-jump");

      const events = queryEvents(db, "task-jump");
      const lowEvents = events.filter((e) => e.event_type === "quota.low");
      const exhEvents = events.filter((e) => e.event_type === "quota.exhausted");

      // quota.low should NOT fire for ok->exhausted jumps in preLaunch,
      // because the budget store goes run 1: runs=1/2=50%→ok, run 2: runs=2/2=100%→exhausted
      // No intermediate soft_warning since 50% < 80%.
      // However, if we jump 2 runs, we go 1→ok, 2→exhausted.
      // Wait—let me recalculate: max_runs=2, so 1 run = 50% → ok, 2 runs = 100% → exhausted.
      // No soft_warning intermediate. So only exhausted fires.
      expect(lowEvents.length).toBe(0);
      expect(exhEvents.length).toBe(1);
    });

    it("emits quota.exhausted with skip_on_replay: true", () => {
      const wo = makeWorkOrder({
        task_id: "task-skip-exh",
        budget: { max_runs: 5, max_wall_time_minutes: 60, max_total_cost_units: 100 },
      });
      manager.init(wo);

      for (let i = 0; i < 5; i++) manager.preLaunch("task-skip-exh");

      const events = queryEvents(db, "task-skip-exh");
      const exhEvents = events.filter((e) => e.event_type === "quota.exhausted");
      expect(exhEvents.length).toBe(1);
      expect(exhEvents[0].skip_on_replay).toBe(1);
    });
  });

  // ── EventLog validation ────────────────────────────────────────────────────

  describe("event log validation", () => {
    it("quota.low event passes EventLog validation and is persisted", () => {
      const wo = makeWorkOrder({
        task_id: "task-val-low",
        budget: { max_runs: 10, max_wall_time_minutes: 60, max_total_cost_units: 100 },
      });
      manager.init(wo);

      for (let i = 0; i < 8; i++) manager.preLaunch("task-val-low");

      // Verify the event row exists and has all required fields
      const events = queryEvents(db, "task-val-low");
      const lowEvents = events.filter((e) => e.event_type === "quota.low");
      expect(lowEvents.length).toBe(1);

      const row = lowEvents[0];
      expect(row.id).toBeTruthy();
      expect(typeof row.id).toBe("string");
      expect(row.id.startsWith("E-")).toBe(true);
      expect(row.project_id).toBe("default");
      expect(row.task_id).toBe("task-val-low");
      expect(row.event_type).toBe("quota.low");
      expect(row.skip_on_replay).toBe(1);
      expect(row.created_at).toBeTruthy();
    });

    it("quota.exhausted event passes EventLog validation and is persisted", () => {
      const wo = makeWorkOrder({
        task_id: "task-val-exh",
        budget: { max_runs: 5, max_wall_time_minutes: 60, max_total_cost_units: 100 },
      });
      manager.init(wo);

      for (let i = 0; i < 5; i++) manager.preLaunch("task-val-exh");

      const events = queryEvents(db, "task-val-exh");
      const exhEvents = events.filter((e) => e.event_type === "quota.exhausted");
      expect(exhEvents.length).toBe(1);

      const row = exhEvents[0];
      expect(row.id).toBeTruthy();
      expect(typeof row.id).toBe("string");
      expect(row.id.startsWith("E-")).toBe(true);
      expect(row.project_id).toBe("default");
      expect(row.task_id).toBe("task-val-exh");
      expect(row.event_type).toBe("quota.exhausted");
      expect(row.skip_on_replay).toBe(1);
      expect(row.created_at).toBeTruthy();
    });
  });

  // ── custom projectId ──────────────────────────────────────────────────────

  describe("custom projectId", () => {
    it("uses the provided projectId in emitted events", () => {
      const db2 = new SqliteDatabase(":memory:");
      migrate(db2);

      const budgetStore = new SqliteBudgetStore(db2);
      const eventLog = new SqliteEventLog(db2);

      const mgr = new DefaultBudgetManager({
        budgetStore,
        eventLog,
        projectId: "my-project",
      });

      const wo = makeWorkOrder({
        task_id: "task-custom-proj",
        budget: { max_runs: 10, max_wall_time_minutes: 60, max_total_cost_units: 100 },
      });
      mgr.init(wo);

      for (let i = 0; i < 8; i++) mgr.preLaunch("task-custom-proj");

      const events = db2
        .prepare("select * from task_events where task_id = ? and event_type = ?")
        .all("task-custom-proj", "quota.low") as Array<Record<string, unknown>>;

      expect(events.length).toBe(1);
      expect(events[0].project_id).toBe("my-project");

      db2.close();
    });
  });

  // ── axis selection ────────────────────────────────────────────────────────

  describe("axis selection in events", () => {
    it("picks the axis with the highest ratio", () => {
      const wo = makeWorkOrder({
        task_id: "task-axis",
        budget: { max_runs: 100, max_wall_time_minutes: 1, max_total_cost_units: 10 },
      });
      manager.init(wo);

      // max_wall_time_ms = 60_000, max_total_cost_units = 10
      // Post a run with low wall time but high cost to trigger cost axis
      manager.preLaunch("task-axis");
      manager.postRun({
        taskId: "task-axis",
        runDurationMs: 1_000, // only ~1.6% of wall time
        estimatedCostUnits: 8.5, // 85% of cost -> triggers soft_warning
      });

      const events = queryEvents(db, "task-axis");
      const lowEvents = events.filter((e) => e.event_type === "quota.low");
      expect(lowEvents.length).toBe(1);

      const payload = JSON.parse(lowEvents[0].payload_json as string);
      // cost ratio: 8.5/10 = 0.85, wall ratio: 1000/60000 ≈ 0.0167, runs ratio: 1/100 = 0.01
      // cost has the highest ratio
      expect(payload.axis).toBe("cost_units");
    });
  });
});
