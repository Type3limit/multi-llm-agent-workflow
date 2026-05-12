import { describe, it, expect, beforeEach } from "vitest";
import SqliteDatabase from "better-sqlite3";
import {
  DefaultTaskQueue,
  defaultLeaseDurationSeconds,
} from "../../src/queue/task-queue.js";
import type { TaskQueue } from "../../src/queue/task-queue.js";
import { SqliteQueueStore } from "../../src/storage/queue-store.js";
import type { QueueStore } from "../../src/storage/queue-store.js";
import type { Database } from "../../src/storage/database.js";
import { migrate } from "../../src/storage/migrations.js";
import type { TaskQueueEntry } from "../../src/core/types.js";
import type { ReviewContextRecord } from "../../src/core/types.js";
import type { ParsedWorkOrderV1 } from "../../src/core/schemas-v1.js";
import { parseWorkOrderV1 } from "../../src/core/schemas-v1.js";

// ─── Minimal valid WorkOrder fixture ─────────────────────────────────────────

function makeWorkOrder(overrides: Partial<Record<string, unknown>> = {}): ParsedWorkOrderV1 {
  return parseWorkOrderV1({
    schema_version: "workflow/v1",
    task_id: "T-001",
    title: "Test Task",
    type: "code_change",
    goal: "Do something useful",
    acceptance_criteria: ["it works"],
    repo: { path: "/tmp/test" },
    agent: {
      required_capabilities: ["code_change"],
      implementer_pool: ["agent-a"],
    },
    ...overrides,
  });
}

// ─── Fake QueueStore for delegation/unit tests ───────────────────────────────

class FakeQueueStore implements QueueStore {
  private entries: Map<string, TaskQueueEntry> = new Map();
  private workOrders: Map<string, string> = new Map();
  private reviewContexts: Map<string, ReviewContextRecord> = new Map();
  private handoffPacketUris: Map<string, string> = new Map();
  private order: string[] = [];
  private _now: () => Date;

  /** The last lease duration passed to claim(). Reset on each claim() call. */
  lastClaimLeaseDurationSec: number | null = null;

  constructor(now?: () => Date) {
    this._now = now ?? (() => new Date());
  }

  insert(entry: TaskQueueEntry, workOrderJson: string): void {
    this.entries.set(entry.task_id, { ...entry });
    this.workOrders.set(entry.task_id, workOrderJson);
    this.order.push(entry.task_id);
  }

  claim(workerId: string, leaseDurationSec: number): TaskQueueEntry | null {
    this.lastClaimLeaseDurationSec = leaseDurationSec;
    const now = this._now();
    for (const taskId of this.order) {
      const entry = this.entries.get(taskId)!;
      if (entry.status !== "queued") continue;

      // Must match SqliteQueueStore.claim() predicate exactly:
      // WHERE status='queued' AND (current_owner_run_id IS NULL OR lease_expires_at < @now)
      if (entry.current_owner_run_id !== null) {
        // Has an owner — only claimable when lease_expires_at is non-null
        // AND strictly before now (matching SQLite's < operator; NULL < @now is not true).
        if (entry.lease_expires_at === null) continue;
        if (new Date(entry.lease_expires_at).getTime() >= now.getTime()) continue;
      }
      // Claim it
      const nowIso = now.toISOString();
      const expires = new Date(now.getTime() + leaseDurationSec * 1000).toISOString();
      const claimed: TaskQueueEntry = {
        ...entry,
        status: "dispatched",
        current_owner_run_id: workerId,
        lease_expires_at: expires,
        updated_at: nowIso,
      };
      this.entries.set(taskId, claimed);
      return claimed;
    }
    return null;
  }

  release(taskId: string, patch: Partial<TaskQueueEntry>): void {
    const existing = this.entries.get(taskId);
    if (!existing) throw new Error(`TaskQueue entry not found: ${taskId}`);
    const updated: TaskQueueEntry = {
      ...existing,
      status: patch.status ?? existing.status,
      next_role: patch.next_role ?? existing.next_role,
      current_owner_run_id: patch.current_owner_run_id !== undefined ? patch.current_owner_run_id : existing.current_owner_run_id,
      lease_expires_at: patch.lease_expires_at !== undefined ? patch.lease_expires_at : existing.lease_expires_at,
      attempts: patch.attempts ?? existing.attempts,
      updated_at: patch.updated_at ?? new Date().toISOString(),
    };
    this.entries.set(taskId, updated);
  }

  setStatus(taskId: string, status: TaskQueueEntry["status"]): void {
    const existing = this.entries.get(taskId);
    if (existing) {
      this.entries.set(taskId, { ...existing, status, updated_at: new Date().toISOString() });
    }
  }

  get(taskId: string): TaskQueueEntry | undefined {
    return this.entries.get(taskId);
  }

  getWorkOrder(taskId: string): ParsedWorkOrderV1 | undefined {
    const json = this.workOrders.get(taskId);
    return json ? parseWorkOrderV1(JSON.parse(json)) : undefined;
  }

  addWorkOrderExcludeAgentIds(taskId: string, agentIds: string[]): ParsedWorkOrderV1 {
    const existingJson = this.workOrders.get(taskId);
    if (!existingJson) throw new Error(`TaskQueue entry not found: ${taskId}`);
    const existing = parseWorkOrderV1(JSON.parse(existingJson));
    const exclude_agent_ids = dedupeFirstSeen([
      ...existing.agent.exclude_agent_ids,
      ...agentIds,
    ]);
    const updated = parseWorkOrderV1({
      ...existing,
      agent: {
        ...existing.agent,
        exclude_agent_ids,
      },
    });
    this.workOrders.set(taskId, JSON.stringify(updated));
    return updated;
  }

  setReviewContext(taskId: string, context: ReviewContextRecord): void {
    if (!this.entries.has(taskId)) throw new Error(`TaskQueue entry not found: ${taskId}`);
    this.reviewContexts.set(taskId, structuredClone(context));
  }

  getReviewContext(taskId: string): ReviewContextRecord | undefined {
    const context = this.reviewContexts.get(taskId);
    return context ? structuredClone(context) : undefined;
  }

  setHandoffPacketUri(taskId: string, uri: string | undefined): void {
    if (!this.entries.has(taskId)) throw new Error(`TaskQueue entry not found: ${taskId}`);
    if (uri === undefined) {
      this.handoffPacketUris.delete(taskId);
      return;
    }
    this.handoffPacketUris.set(taskId, uri);
  }

  getHandoffPacketUri(taskId: string): string | undefined {
    return this.handoffPacketUris.get(taskId);
  }

  listAll(): TaskQueueEntry[] {
    return this.order.map((id) => this.entries.get(id)!);
  }

  // Test helpers
  getWorkOrderJson(taskId: string): string | undefined {
    return this.workOrders.get(taskId);
  }
}

function dedupeFirstSeen(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("defaultLeaseDurationSeconds", () => {
  it("returns budget.max_wall_time_minutes * 60 + 60 when below cap", () => {
    const wo = makeWorkOrder({ budget: { max_wall_time_minutes: 10 } });
    // 10 * 60 + 60 = 660
    expect(defaultLeaseDurationSeconds(wo)).toBe(660);
  });

  it("caps at 3600 seconds (60 minutes)", () => {
    // 60 * 60 + 60 = 3660 -> capped to 3600
    const wo = makeWorkOrder({ budget: { max_wall_time_minutes: 60 } });
    expect(defaultLeaseDurationSeconds(wo)).toBe(3600);
  });

  it("uses default max_wall_time_minutes=30 when omitted", () => {
    const wo = makeWorkOrder({ budget: {} });
    // 30 * 60 + 60 = 1860
    expect(defaultLeaseDurationSeconds(wo)).toBe(1860);
  });
});

describe("DefaultTaskQueue", () => {
  let store: FakeQueueStore;
  let queue: TaskQueue;

  beforeEach(() => {
    store = new FakeQueueStore();
    queue = new DefaultTaskQueue({ store });
  });

  // ─── enqueue ───────────────────────────────────────────────────────────

  it("enqueue() inserts and returns a queued implementer entry", () => {
    const wo = makeWorkOrder();
    const entry = queue.enqueue({ workOrder: wo });

    expect(entry.task_id).toBe("T-001");
    expect(entry.project_id).toBe("default");
    expect(entry.status).toBe("queued");
    expect(entry.next_role).toBe("implementer");
    expect(entry.current_owner_run_id).toBeNull();
    expect(entry.lease_expires_at).toBeNull();
    expect(entry.attempts).toBe(0);
    expect(entry.enqueued_at).toBeDefined();
    expect(entry.updated_at).toBe(entry.enqueued_at);

    // Verify via store
    const stored = store.get("T-001")!;
    expect(stored.task_id).toBe("T-001");
    expect(stored.status).toBe("queued");
  });

  it("enqueue() uses workOrder.project_id when present", () => {
    const wo = makeWorkOrder({ project_id: "my-project" });
    const entry = queue.enqueue({ workOrder: wo });
    expect(entry.project_id).toBe("my-project");
  });

  it("enqueue() defaults missing project_id to 'default'", () => {
    const wo = makeWorkOrder();
    // project_id omitted from the override
    expect(wo.project_id).toBe("default"); // Zod default
    const entry = queue.enqueue({ workOrder: wo });
    expect(entry.project_id).toBe("default");
  });

  it("enqueue({ nextRole: 'reviewer' }) sets next_role: 'reviewer'", () => {
    const wo = makeWorkOrder();
    const entry = queue.enqueue({ workOrder: wo, nextRole: "reviewer" });
    expect(entry.next_role).toBe("reviewer");
  });

  it("enqueue() persists the parsed WorkOrder JSON through the store", () => {
    const wo = makeWorkOrder({ task_id: "T-json" });
    queue.enqueue({ workOrder: wo });

    const storedJson = store.getWorkOrderJson("T-json")!;
    expect(storedJson).toBeDefined();
    const parsed = JSON.parse(storedJson);
    expect(parsed.task_id).toBe("T-json");
    expect(parsed.schema_version).toBe("workflow/v1");
  });

  it("enqueue() uses deterministic timestamps from injected now", () => {
    const fixedDate = new Date("2026-01-15T12:00:00Z");
    const queue2 = new DefaultTaskQueue({ store, now: () => fixedDate });

    const wo = makeWorkOrder({ task_id: "T-ts" });
    const entry = queue2.enqueue({ workOrder: wo });

    expect(entry.enqueued_at).toBe("2026-01-15T12:00:00.000Z");
    expect(entry.updated_at).toBe("2026-01-15T12:00:00.000Z");
  });

  // ─── claim ─────────────────────────────────────────────────────────────

  it("claim(workerId, explicitLease) delegates the explicit lease duration", () => {
    const wo = makeWorkOrder();
    queue.enqueue({ workOrder: wo });

    const claimed = queue.claim("worker-1", 300);
    expect(claimed).not.toBeNull();
    expect(claimed!.current_owner_run_id).toBe("worker-1");
    expect(claimed!.status).toBe("dispatched");

    // Verify lease is approximately now + 300s
    const expires = new Date(claimed!.lease_expires_at!).getTime();
    const now = Date.now();
    expect(expires).toBeGreaterThan(now + 290_000);
    expect(expires).toBeLessThan(now + 310_000);
  });

  it("claim(workerId) uses defaultLeaseDurationSeconds for enqueued tasks", () => {
    const wo = makeWorkOrder({ budget: { max_wall_time_minutes: 5 } });
    queue.enqueue({ workOrder: wo });

    const claimed = queue.claim("worker-1");
    expect(claimed).not.toBeNull();

    // 5 * 60 + 60 = 360 seconds
    const expires = new Date(claimed!.lease_expires_at!).getTime();
    const now = Date.now();
    expect(expires).toBeGreaterThan(now + 350_000);
    expect(expires).toBeLessThan(now + 370_000);
  });

  it("claim() uses persisted WorkOrder lease for a fresh queue sharing the enqueuer store", () => {
    const fixedDate = new Date("2026-02-01T12:00:00Z");
    const fixedNow = () => fixedDate;
    const store2 = new FakeQueueStore(fixedNow);
    const enqueuerQueue = new DefaultTaskQueue({ store: store2, now: fixedNow });
    const workerQueue = new DefaultTaskQueue({ store: store2, now: fixedNow });
    const wo = makeWorkOrder({
      task_id: "T-persisted-lease",
      budget: { max_wall_time_minutes: 5 },
    });

    enqueuerQueue.enqueue({ workOrder: wo });
    const claimed = workerQueue.claim("fresh-worker");

    expect(claimed).not.toBeNull();
    expect(claimed!.task_id).toBe("T-persisted-lease");
    expect(store2.lastClaimLeaseDurationSec).toBe(360);
    expect(claimed!.lease_expires_at).toBe("2026-02-01T12:06:00.000Z");
  });

  it("claim() falls back to 60 minutes for unknown tasks", () => {
    // Tasks inserted directly into the store (not via enqueue) have no
    // cached WorkOrder, so claim() should use the 3600s fallback.
    const pastDate = new Date().toISOString();
    store.insert(
      {
        task_id: "T-unknown",
        project_id: "default",
        status: "queued",
        next_role: "implementer",
        current_owner_run_id: null,
        lease_expires_at: null,
        attempts: 0,
        enqueued_at: pastDate,
        updated_at: pastDate,
      },
      "{}",
    );

    const claimed = queue.claim("worker-1");
    expect(claimed).not.toBeNull();
    expect(claimed!.task_id).toBe("T-unknown");

    // Should be ~3600 seconds
    const expires = new Date(claimed!.lease_expires_at!).getTime();
    const now = Date.now();
    expect(expires).toBeGreaterThan(now + 3_590_000);
    expect(expires).toBeLessThan(now + 3_610_000);
  });

  it("claim() returns null when nothing is claimable", () => {
    const claimed = queue.claim("worker-1");
    expect(claimed).toBeNull();
  });

  // ─── claim default-lease edge cases (Phase 6 fix) ──────────────────────

  it("claim() uses 3600s lease for unknown queued task that precedes a known enqueued task", () => {
    // Regression: computeDefaultLeaseForNextClaimable must identify the
    // first row matching the store claim predicate, not skip unknown rows
    // and pick up the lease from a later known task.
    const fixedDate = new Date("2026-02-01T12:00:00Z");
    const fixedNow = () => fixedDate;
    const store2 = new FakeQueueStore(fixedNow);
    const queue2 = new DefaultTaskQueue({ store: store2, now: fixedNow });

    // Insert an unknown task first (not via enqueue, so no cached WorkOrder).
    store2.insert(
      {
        task_id: "T-unknown-first",
        project_id: "default",
        status: "queued",
        next_role: "implementer",
        current_owner_run_id: null,
        lease_expires_at: null,
        attempts: 0,
        enqueued_at: new Date(fixedDate.getTime() - 2000).toISOString(),
        updated_at: new Date(fixedDate.getTime() - 2000).toISOString(),
      },
      "{}",
    );

    // Then enqueue a known task with a short lease.
    const wo = makeWorkOrder({
      task_id: "T-known-second",
      budget: { max_wall_time_minutes: 5 },
    });
    queue2.enqueue({ workOrder: wo });

    // claim() should pick T-unknown-first (first in order) with 3600s lease,
    // NOT T-known-second's 360s lease.
    const claimed = queue2.claim("w1");
    expect(claimed).not.toBeNull();
    expect(claimed!.task_id).toBe("T-unknown-first");
    expect(store2.lastClaimLeaseDurationSec).toBe(3600);
  });

  it("claim() ignores non-queued cached WorkOrder rows when computing default lease", () => {
    // A cached WorkOrder row that is not claimable (status != "queued")
    // must not determine the lease for the next queued task.
    const fixedDate = new Date("2026-02-01T12:00:00Z");
    const fixedNow = () => fixedDate;
    const store2 = new FakeQueueStore(fixedNow);
    const queue2 = new DefaultTaskQueue({ store: store2, now: fixedNow });

    // Enqueue and claim task A (now dispatched, not queued).
    const woA = makeWorkOrder({
      task_id: "T-A",
      budget: { max_wall_time_minutes: 5 },
    });
    queue2.enqueue({ workOrder: woA });
    queue2.claim("w1", 300); // T-A is now dispatched

    // Enqueue task B (still queued) with a different lease profile.
    const woB = makeWorkOrder({
      task_id: "T-B",
      budget: { max_wall_time_minutes: 20 },
    });
    queue2.enqueue({ workOrder: woB });

    // claim() should pick T-B (the only queued one), using T-B's lease (20*60+60=1260),
    // NOT T-A's 360s lease from the dispatched row.
    const claimed = queue2.claim("w2");
    expect(claimed).not.toBeNull();
    expect(claimed!.task_id).toBe("T-B");
    // 20 * 60 + 60 = 1260
    expect(store2.lastClaimLeaseDurationSec).toBe(1260);
  });

  it("claim() ignores queued cached WorkOrder row with non-expired lease when computing default lease", () => {
    // A queued row with a non-null owner and a future lease_expires_at is
    // not claimable. Its cached WorkOrder must not determine the lease for
    // the next claimable queued task.
    const fixedDate = new Date("2026-02-01T12:00:00Z");
    const fixedNow = () => fixedDate;
    const store2 = new FakeQueueStore(fixedNow);
    const queue2 = new DefaultTaskQueue({ store: store2, now: fixedNow });

    // Enqueue task A (short lease profile).
    const woA = makeWorkOrder({
      task_id: "T-A",
      budget: { max_wall_time_minutes: 5 },
    });
    queue2.enqueue({ workOrder: woA });

    // Directly manipulate the store entry: set status back to "queued" but
    // with a non-null owner and a future lease_expires_at.
    store2.release("T-A", {
      status: "queued",
      current_owner_run_id: "stale-worker",
      lease_expires_at: new Date(fixedDate.getTime() + 3600_000).toISOString(),
      attempts: 1,
    });

    // Enqueue task B with a different lease profile.
    const woB = makeWorkOrder({
      task_id: "T-B",
      budget: { max_wall_time_minutes: 10 },
    });
    queue2.enqueue({ workOrder: woB });

    // T-A is queued but its lease hasn't expired yet → not claimable.
    // claim() should pick T-B and use T-B's lease duration (10*60+60=660).
    const claimed = queue2.claim("w2");
    expect(claimed).not.toBeNull();
    expect(claimed!.task_id).toBe("T-B");
    // 10 * 60 + 60 = 660
    expect(store2.lastClaimLeaseDurationSec).toBe(660);
  });

  it("claim() skips queued row with non-null owner and null lease_expires_at (Phase 6 null-lease fix)", () => {
    // Regression: a queued row with current_owner_run_id set and
    // lease_expires_at: null must NOT be treated as claimable.
    // SQLite: lease_expires_at < @now is NULL (not true) for NULL values.
    const fixedDate = new Date("2026-03-01T12:00:00Z");
    const fixedNow = () => fixedDate;
    const store2 = new FakeQueueStore(fixedNow);
    const queue2 = new DefaultTaskQueue({ store: store2, now: fixedNow });

    // Insert a queued row with an owner but null lease.
    store2.insert(
      {
        task_id: "T-null-lease",
        project_id: "default",
        status: "queued",
        next_role: "implementer",
        current_owner_run_id: "stale-worker",
        lease_expires_at: null, // NULL — not claimable per SQLite predicate
        attempts: 0,
        enqueued_at: new Date(fixedDate.getTime() - 2000).toISOString(),
        updated_at: new Date(fixedDate.getTime() - 2000).toISOString(),
      },
      "{}",
    );

    // Enqueue a later task with a known lease profile.
    const wo = makeWorkOrder({
      task_id: "T-known",
      budget: { max_wall_time_minutes: 5 },
    });
    queue2.enqueue({ workOrder: wo }); // cached, lease = 5*60+60 = 360

    // claim() must skip T-null-lease and pick T-known instead.
    const claimed = queue2.claim("w1");
    expect(claimed).not.toBeNull();
    expect(claimed!.task_id).toBe("T-known");
    // Use T-known's lease (360), NOT 3600s fallback from null-lease row.
    expect(store2.lastClaimLeaseDurationSec).toBe(360);
  });

  it("claim() skips queued row with lease_expires_at exactly equal to now() (Phase 6 strict-less-than fix)", () => {
    // Regression: a queued row with lease_expires_at exactly equal to now()
    // must NOT be treated as expired. SQLite uses strict '<' comparison.
    const fixedDate = new Date("2026-03-01T12:00:00Z");
    const fixedNow = () => fixedDate;
    const store2 = new FakeQueueStore(fixedNow);
    const queue2 = new DefaultTaskQueue({ store: store2, now: fixedNow });

    // Insert a queued row whose lease expires exactly at now.
    store2.insert(
      {
        task_id: "T-exact-lease",
        project_id: "default",
        status: "queued",
        next_role: "implementer",
        current_owner_run_id: "stale-worker",
        lease_expires_at: fixedDate.toISOString(), // exactly equal to now()
        attempts: 0,
        enqueued_at: new Date(fixedDate.getTime() - 2000).toISOString(),
        updated_at: new Date(fixedDate.getTime() - 2000).toISOString(),
      },
      "{}",
    );

    // Enqueue a later task with a known lease profile.
    const wo = makeWorkOrder({
      task_id: "T-known",
      budget: { max_wall_time_minutes: 10 },
    });
    queue2.enqueue({ workOrder: wo }); // cached, lease = 10*60+60 = 660

    // claim() must skip T-exact-lease and pick T-known instead.
    const claimed = queue2.claim("w1");
    expect(claimed).not.toBeNull();
    expect(claimed!.task_id).toBe("T-known");
    // Use T-known's lease (660), NOT 3600s fallback.
    expect(store2.lastClaimLeaseDurationSec).toBe(660);
  });

  // ─── release ───────────────────────────────────────────────────────────

  it("release() delegates to the store", () => {
    const wo = makeWorkOrder();
    queue.enqueue({ workOrder: wo });
    queue.claim("worker-1", 600);

    queue.release("T-001", {
      status: "queued",
      current_owner_run_id: null,
      lease_expires_at: null,
    });

    const stored = store.get("T-001")!;
    expect(stored.status).toBe("queued");
    expect(stored.current_owner_run_id).toBeNull();
    expect(stored.lease_expires_at).toBeNull();
  });

  // ─── setStatus ─────────────────────────────────────────────────────────

  it("setStatus() delegates to the store", () => {
    const wo = makeWorkOrder();
    queue.enqueue({ workOrder: wo });

    queue.setStatus("T-001", "accepted");

    const stored = store.get("T-001")!;
    expect(stored.status).toBe("accepted");
  });

  // ─── get ───────────────────────────────────────────────────────────────

  it("get() delegates to the store", () => {
    const wo = makeWorkOrder();
    queue.enqueue({ workOrder: wo });

    const got = queue.get("T-001")!;
    expect(got).toBeDefined();
    expect(got.task_id).toBe("T-001");
  });

  it("get() returns undefined for unknown task", () => {
    expect(queue.get("nonexistent")).toBeUndefined();
  });

  it("getWorkOrder() loads a parsed WorkOrder from the store when not cached", () => {
    const wo = makeWorkOrder({ task_id: "T-direct" });
    store.insert(
      {
        task_id: "T-direct",
        project_id: "default",
        status: "queued",
        next_role: "implementer",
        current_owner_run_id: null,
        lease_expires_at: null,
        attempts: 0,
        enqueued_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      JSON.stringify(wo),
    );

    const loaded = queue.getWorkOrder("T-direct");

    expect(loaded?.task_id).toBe("T-direct");
    expect(loaded?.schema_version).toBe("workflow/v1");
  });

  it("addWorkOrderExcludeAgentIds() grows excludes in first-seen order", () => {
    const wo = makeWorkOrder({
      task_id: "T-excludes",
      agent: {
        required_capabilities: ["code_change"],
        implementer_pool: ["agent-a", "agent-b", "agent-c"],
        exclude_agent_ids: ["agent-a"],
      },
    });
    queue.enqueue({ workOrder: wo });

    const updated = queue.addWorkOrderExcludeAgentIds("T-excludes", [
      "agent-b",
      "agent-a",
      "agent-c",
    ]);

    expect(updated.agent.exclude_agent_ids).toEqual(["agent-a", "agent-b", "agent-c"]);
    expect(queue.getWorkOrder("T-excludes")?.agent.exclude_agent_ids).toEqual([
      "agent-a",
      "agent-b",
      "agent-c",
    ]);
  });

  it("setReviewContext()/getReviewContext() delegates persisted reviewer inputs", () => {
    const wo = makeWorkOrder({ task_id: "T-review-context" });
    queue.enqueue({ workOrder: wo });

    const context: ReviewContextRecord = {
      implementer_run_id: "run-impl",
      implementer_agent_id: "agent-a",
      diff_artifact_uri: "artifact://T-review-context/run-impl/diff.patch",
      final_report_uri: "artifact://T-review-context/run-impl/final_report.md",
    };
    queue.setReviewContext("T-review-context", context);

    expect(queue.getReviewContext("T-review-context")).toEqual(context);
  });

  // ─── listTerminal ──────────────────────────────────────────────────────

  it("listTerminal() returns only accepted, failed, and awaiting_human entries", () => {
    const allStatuses: TaskQueueEntry["status"][] = [
      "queued",
      "dispatched",
      "implementing",
      "verifying",
      "reviewing",
      "accepted",
      "failed",
      "awaiting_human",
    ];

    for (let i = 0; i < allStatuses.length; i++) {
      const status = allStatuses[i];
      store.insert(
        {
          task_id: `T-${status}`,
          project_id: "default",
          status,
          next_role: "implementer",
          current_owner_run_id: null,
          lease_expires_at: null,
          attempts: 0,
          enqueued_at: new Date(Date.now() + i * 1000).toISOString(),
          updated_at: new Date(Date.now() + i * 1000).toISOString(),
        },
        "{}",
      );
    }

    const terminal = queue.listTerminal();
    const terminalIds = terminal.map((e) => e.task_id);
    expect(terminalIds).toEqual(["T-accepted", "T-failed", "T-awaiting_human"]);
  });

  it("listTerminal() preserves store ordering", () => {
    // Insert in specific order
    store.insert(
      {
        task_id: "T-first",
        project_id: "default",
        status: "failed",
        next_role: "implementer",
        current_owner_run_id: null,
        lease_expires_at: null,
        attempts: 0,
        enqueued_at: new Date(1000).toISOString(),
        updated_at: new Date(1000).toISOString(),
      },
      "{}",
    );
    store.insert(
      {
        task_id: "T-second",
        project_id: "default",
        status: "accepted",
        next_role: "implementer",
        current_owner_run_id: null,
        lease_expires_at: null,
        attempts: 0,
        enqueued_at: new Date(2000).toISOString(),
        updated_at: new Date(2000).toISOString(),
      },
      "{}",
    );
    store.insert(
      {
        task_id: "T-third",
        project_id: "default",
        status: "awaiting_human",
        next_role: "implementer",
        current_owner_run_id: null,
        lease_expires_at: null,
        attempts: 0,
        enqueued_at: new Date(3000).toISOString(),
        updated_at: new Date(3000).toISOString(),
      },
      "{}",
    );
    // Non-terminal in between
    store.insert(
      {
        task_id: "T-middle",
        project_id: "default",
        status: "queued",
        next_role: "implementer",
        current_owner_run_id: null,
        lease_expires_at: null,
        attempts: 0,
        enqueued_at: new Date(1500).toISOString(),
        updated_at: new Date(1500).toISOString(),
      },
      "{}",
    );

    const terminal = queue.listTerminal();
    expect(terminal.map((e) => e.task_id)).toEqual(["T-first", "T-second", "T-third"]);
  });

  it("listTerminal() returns empty array when no terminal entries exist", () => {
    const wo = makeWorkOrder();
    queue.enqueue({ workOrder: wo });

    expect(queue.listTerminal()).toEqual([]);
  });
});

// ─── Integration tests with real SQLite ──────────────────────────────────────

describe("DefaultTaskQueue + SqliteQueueStore integration", () => {
  let db: Database;
  let queue: TaskQueue;

  beforeEach(() => {
    db = new SqliteDatabase(":memory:");
    migrate(db);
    const store = new SqliteQueueStore(db);
    queue = new DefaultTaskQueue({ store });
  });

  afterEach(() => {
    db.close();
  });

  it("full enqueue → claim → release → setStatus cycle", () => {
    const wo = makeWorkOrder({ task_id: "T-int" });

    // Enqueue
    const entry = queue.enqueue({ workOrder: wo });
    expect(entry.status).toBe("queued");

    // Claim
    const claimed = queue.claim("w1", 600);
    expect(claimed).not.toBeNull();
    expect(claimed!.task_id).toBe("T-int");
    expect(claimed!.status).toBe("dispatched");
    expect(claimed!.current_owner_run_id).toBe("w1");

    // Second claim returns null
    const second = queue.claim("w2", 600);
    expect(second).toBeNull();

    // Release
    queue.release("T-int", {
      status: "implementing",
      current_owner_run_id: null,
      lease_expires_at: null,
    });

    const afterRelease = queue.get("T-int")!;
    expect(afterRelease.status).toBe("implementing");
    expect(afterRelease.current_owner_run_id).toBeNull();

    // Set terminal status
    queue.setStatus("T-int", "accepted");
    expect(queue.get("T-int")!.status).toBe("accepted");

    // listTerminal includes it now
    const terminal = queue.listTerminal();
    expect(terminal.map((e) => e.task_id)).toContain("T-int");
  });

  it("claim with default lease via SQLite store", () => {
    const wo = makeWorkOrder({
      task_id: "T-lease",
      budget: { max_wall_time_minutes: 10 },
    });
    queue.enqueue({ workOrder: wo });

    // claim() without explicit lease → uses default from WorkOrder
    const claimed = queue.claim("w1");
    expect(claimed).not.toBeNull();

    // 10 * 60 + 60 = 660 seconds
    const expires = new Date(claimed!.lease_expires_at!).getTime();
    const now = Date.now();
    expect(expires).toBeGreaterThan(now + 650_000);
    expect(expires).toBeLessThan(now + 670_000);
  });
});
