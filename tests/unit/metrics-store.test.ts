import SqliteDatabase from "better-sqlite3";
import { SqliteMetricsStore } from "../../src/storage/metrics-store.js";
import { migrate } from "../../src/storage/migrations.js";
import type { Database } from "../../src/storage/database.js";

let db: Database;
let store: SqliteMetricsStore;

beforeEach(() => {
  db = new SqliteDatabase(":memory:") as Database;
  migrate(db);
  store = new SqliteMetricsStore(db);
});

afterEach(() => {
  db.close();
});

describe("SqliteMetricsStore", () => {
  describe("rollingFor", () => {
    it("returns zeros for an agent with no records", () => {
      const result = store.rollingFor("agent-1", 10);
      expect(result).toEqual({
        successRate: 0,
        avgLatencyMs: 0,
        avgActualCostUnits: 0,
        runsObserved: 0,
      });
    });

    it("returns correct stats for a single successful run", () => {
      store.recordRunOutcome({
        agentId: "agent-1",
        runId: "run-1",
        success: true,
        wallTimeMs: 5000,
      });

      const result = store.rollingFor("agent-1", 10);

      expect(result.successRate).toBe(1);
      expect(result.avgLatencyMs).toBe(5000);
      expect(result.runsObserved).toBe(1);
      expect(result.avgActualCostUnits).toBe(0);
    });

    it("computes successRate from multiple records (2 success, 1 failure)", () => {
      store.recordRunOutcome({ agentId: "a", runId: "r1", success: true, wallTimeMs: 100 });
      store.recordRunOutcome({ agentId: "a", runId: "r2", success: false, wallTimeMs: 200 });
      store.recordRunOutcome({ agentId: "a", runId: "r3", success: true, wallTimeMs: 300 });

      const result = store.rollingFor("a", 10);

      expect(result.successRate).toBeCloseTo(2 / 3);
      expect(result.runsObserved).toBe(3);
    });

    it("truncates to windowSize most recent runs", () => {
      for (let i = 1; i <= 5; i++) {
        store.recordRunOutcome({
          agentId: "a",
          runId: `r${i}`,
          success: true,
          wallTimeMs: 100 * i,
        });
      }

      const result = store.rollingFor("a", 3);

      expect(result.runsObserved).toBe(3);
      // Most recent 3: r5 (500), r4 (400), r3 (300) → avg = 400
      expect(result.avgLatencyMs).toBe(400);
    });

    it("excludes null actualCostUnits from average cost", () => {
      store.recordRunOutcome({
        agentId: "a",
        runId: "r1",
        success: true,
        wallTimeMs: 100,
        actualCostUnits: 10,
      });
      store.recordRunOutcome({
        agentId: "a",
        runId: "r2",
        success: true,
        wallTimeMs: 100,
        // actualCostUnits omitted → stored as null
      });

      const result = store.rollingFor("a", 10);

      expect(result.avgActualCostUnits).toBe(10);
    });

    it("returns avgActualCostUnits=0 when all costs are null", () => {
      store.recordRunOutcome({ agentId: "a", runId: "r1", success: true, wallTimeMs: 100 });
      store.recordRunOutcome({ agentId: "a", runId: "r2", success: true, wallTimeMs: 100 });

      const result = store.rollingFor("a", 10);

      expect(result.avgActualCostUnits).toBe(0);
    });

    it("does not mix records across different agents", () => {
      store.recordRunOutcome({ agentId: "agent-A", runId: "r1", success: true, wallTimeMs: 100 });

      const result = store.rollingFor("agent-B", 10);

      expect(result).toEqual({
        successRate: 0,
        avgLatencyMs: 0,
        avgActualCostUnits: 0,
        runsObserved: 0,
      });
    });

    it("uses id desc as tiebreaker when created_at is identical", () => {
      // Insert multiple rows with identical created_at via direct SQL
      const sameTime = "2026-01-01T00:00:00Z";
      db.prepare(`
        insert into agent_metrics (agent_id, run_id, success, wall_time_ms, actual_cost_units, created_at)
        values
          ('a', 'r1', 1, 100, null, '${sameTime}'),
          ('a', 'r2', 1, 200, null, '${sameTime}'),
          ('a', 'r3', 1, 300, null, '${sameTime}'),
          ('a', 'r4', 1, 400, null, '${sameTime}'),
          ('a', 'r5', 1, 500, null, '${sameTime}')
      `).run();

      // windowSize=3 should return the 3 rows with highest id (r5=500, r4=400, r3=300)
      const result = store.rollingFor("a", 3);
      expect(result.runsObserved).toBe(3);
      // avg = (500+400+300)/3 = 400
      expect(result.avgLatencyMs).toBe(400);
    });
  });
});
