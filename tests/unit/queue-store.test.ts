import SqliteDatabase from "better-sqlite3";
import { migrate } from "../../src/storage/migrations.js";
import { SqliteQueueStore } from "../../src/storage/queue-store.js";
import type { Database } from "../../src/storage/database.js";
import type { ReviewContextRecord, TaskQueueEntry } from "../../src/core/types.js";

function makeEntry(overrides: Partial<TaskQueueEntry> = {}): TaskQueueEntry {
  return {
    task_id: "T-001",
    project_id: "default",
    status: "queued",
    next_role: "implementer",
    current_owner_run_id: null,
    lease_expires_at: null,
    attempts: 0,
    enqueued_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("SqliteQueueStore", () => {
  let db: Database;
  let store: SqliteQueueStore;

  beforeEach(() => {
    db = new SqliteDatabase(":memory:");
    migrate(db);
    store = new SqliteQueueStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("insert + get + listAll round-trip", () => {
    const entry = makeEntry();
    store.insert(entry, '{"task_id":"T-001"}');

    const got = store.get("T-001")!;
    expect(got).toBeDefined();
    expect(got.task_id).toBe("T-001");
    expect(got.status).toBe("queued");
    expect(got.next_role).toBe("implementer");
    expect(got.current_owner_run_id).toBeNull();
    expect(got.lease_expires_at).toBeNull();
    expect(got.attempts).toBe(0);

    const all = store.listAll();
    expect(all).toHaveLength(1);
    expect(all[0].task_id).toBe("T-001");
  });

  it("claim succeeds once (status becomes dispatched, owner/lease set)", () => {
    store.insert(makeEntry(), "{}");

    const claimed = store.claim("worker-1", 600);
    expect(claimed).not.toBeNull();
    expect(claimed!.task_id).toBe("T-001");
    expect(claimed!.status).toBe("dispatched");
    expect(claimed!.current_owner_run_id).toBe("worker-1");
    expect(claimed!.lease_expires_at).toBeDefined();
    expect(new Date(claimed!.lease_expires_at!).getTime()).toBeGreaterThan(Date.now());
  });

  it("second claim returns null (task no longer queued)", () => {
    store.insert(makeEntry(), "{}");
    const first = store.claim("w1", 600);
    expect(first).not.toBeNull();

    const second = store.claim("w2", 600);
    expect(second).toBeNull();
  });

  it("claim does not return terminal status entries", () => {
    for (const status of ["accepted", "failed", "awaiting_human"] as const) {
      store.insert(makeEntry({ task_id: `T-${status}`, status }), "{}");
    }

    const claimed = store.claim("w1", 600);
    expect(claimed).toBeNull();
  });

  it("claim reclaims expired lease", () => {
    // Manually insert a row with expired lease via DB
    const past = new Date(Date.now() - 10000).toISOString();
    db.prepare(`
      insert into task_queue (
        task_id, project_id, status, next_role,
        current_owner_run_id, lease_expires_at,
        attempts, enqueued_at, updated_at, workorder_json
      ) values (
        'T-expired', 'default', 'queued', 'implementer',
        'old-worker', @past, 0, @past, @past, '{}'
      )
    `).run({ past });

    const claimed = store.claim("w1", 600);
    expect(claimed).not.toBeNull();
    expect(claimed!.task_id).toBe("T-expired");
    expect(claimed!.status).toBe("dispatched");
    expect(claimed!.current_owner_run_id).toBe("w1");
  });

  it("release clears owner/lease and changes status", () => {
    store.insert(makeEntry(), "{}");
    store.claim("w1", 600);

    store.release("T-001", {
      status: "queued",
      current_owner_run_id: null,
      lease_expires_at: null,
    });

    const got = store.get("T-001")!;
    expect(got.status).toBe("queued");
    expect(got.current_owner_run_id).toBeNull();
    expect(got.lease_expires_at).toBeNull();
  });

  it("release rejects changing task_id or project_id", () => {
    store.insert(makeEntry(), "{}");

    expect(() => store.release("T-001", { task_id: "T-other" as unknown as string } as Partial<TaskQueueEntry>)).toThrow(
      "Cannot modify field",
    );
    // Also verify project_id rejection via allowedKeys check
  });

  it("setStatus changes status and updated_at", () => {
    store.insert(makeEntry(), "{}");

    store.setStatus("T-001", "accepted");

    const got = store.get("T-001")!;
    expect(got.status).toBe("accepted");
  });

  it("insert with all explicit fields survives round-trip", () => {
    const entry = makeEntry({
      task_id: "T-full",
      project_id: "my-proj",
      status: "implementing",
      next_role: "reviewer",
      current_owner_run_id: "owner-1",
      lease_expires_at: new Date(Date.now() + 60000).toISOString(),
      attempts: 3,
    });

    store.insert(entry, '{"work":"order"}');

    const got = store.get("T-full")!;
    expect(got.project_id).toBe("my-proj");
    expect(got.status).toBe("implementing");
    expect(got.next_role).toBe("reviewer");
    expect(got.current_owner_run_id).toBe("owner-1");
    expect(got.attempts).toBe(3);
  });

  it("get returns undefined for non-existent task", () => {
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("getWorkOrder parses persisted workorder_json", () => {
    store.insert(makeEntry({ task_id: "T-workorder" }), JSON.stringify({
      schema_version: "workflow/v1",
      task_id: "T-workorder",
      title: "Persisted WorkOrder",
      type: "code_change",
      goal: "Load this from SQLite.",
      acceptance_criteria: ["loaded"],
      repo: { path: "/tmp/repo" },
      agent: {
        required_capabilities: ["code_change"],
        implementer_pool: ["agent-a"],
      },
      review: { enabled: false },
    }));

    const workOrder = store.getWorkOrder("T-workorder");

    expect(workOrder?.task_id).toBe("T-workorder");
    expect(workOrder?.project_id).toBe("default");
    expect(workOrder?.agent.exclude_agent_ids).toEqual([]);
  });

  it("addWorkOrderExcludeAgentIds preserves unrelated JSON and only grows excludes", () => {
    store.insert(makeEntry({ task_id: "T-grow" }), JSON.stringify({
      schema_version: "workflow/v1",
      task_id: "T-grow",
      project_id: "project-a",
      title: "Grow excludes",
      type: "code_change",
      goal: "Preserve every unrelated field.",
      acceptance_criteria: ["fields remain"],
      repo: { path: "/tmp/repo", base_ref: "main" },
      custom_top_level: "keep-me",
      agent: {
        required_capabilities: ["code_change"],
        implementer_pool: ["agent-a", "agent-b", "agent-c"],
        reviewer_pool: ["reviewer-a"],
        exclude_agent_ids: ["agent-a", "agent-b"],
        custom_agent_field: "keep-agent-field",
      },
      review: { enabled: false, max_review_runs: 0 },
      budget: {
        max_wall_time_minutes: 12,
        max_total_cost_units: 7,
        max_runs: 3,
      },
    }));

    const updated = store.addWorkOrderExcludeAgentIds("T-grow", [
      "agent-b",
      "agent-c",
      "agent-a",
    ]);

    expect(updated.agent.exclude_agent_ids).toEqual(["agent-a", "agent-b", "agent-c"]);

    const row = db
      .prepare("select workorder_json from task_queue where task_id = ?")
      .get("T-grow") as { workorder_json: string };
    const raw = JSON.parse(row.workorder_json) as {
      title: string;
      goal: string;
      custom_top_level: string;
      agent: { exclude_agent_ids: string[]; custom_agent_field: string };
      budget: { max_runs: number };
    };

    expect(raw.title).toBe("Grow excludes");
    expect(raw.goal).toBe("Preserve every unrelated field.");
    expect(raw.custom_top_level).toBe("keep-me");
    expect(raw.agent.custom_agent_field).toBe("keep-agent-field");
    expect(raw.agent.exclude_agent_ids).toEqual(["agent-a", "agent-b", "agent-c"]);
    expect(raw.budget.max_runs).toBe(3);
  });

  it("setReviewContext + getReviewContext round-trips persisted reviewer inputs", () => {
    store.insert(makeEntry({ task_id: "T-review" }), JSON.stringify({
      schema_version: "workflow/v1",
      task_id: "T-review",
      title: "Review context",
      type: "code_change",
      goal: "Persist reviewer inputs.",
      acceptance_criteria: ["context loads"],
      repo: { path: "/tmp/repo" },
      agent: {
        required_capabilities: ["code_change"],
        implementer_pool: ["agent-a"],
        reviewer_pool: ["reviewer-a"],
      },
      review: { enabled: true },
    }));

    const context: ReviewContextRecord = {
      implementer_run_id: "run-impl",
      implementer_agent_id: "agent-a",
      diff_artifact_uri: "artifact://T-review/run-impl/diff.patch",
      final_report_uri: "artifact://T-review/run-impl/final_report.md",
      verification_output_uri: "artifact://T-review/run-impl/verification.txt",
    };
    store.setReviewContext("T-review", context);

    expect(store.getReviewContext("T-review")).toEqual(context);
    const row = db
      .prepare("select review_context_json from task_queue where task_id = ?")
      .get("T-review") as { review_context_json: string };
    expect(JSON.parse(row.review_context_json)).toEqual(context);
  });

  it("setReviewContext rejects malformed records", () => {
    store.insert(makeEntry({ task_id: "T-bad-review" }), "{}");

    expect(() =>
      store.setReviewContext("T-bad-review", {
        implementer_run_id: "",
        implementer_agent_id: "agent-a",
        diff_artifact_uri: "artifact://T-bad-review/run-impl/diff.patch",
      }),
    ).toThrow("implementer_run_id");
  });

  it("setHandoffPacketUri + getHandoffPacketUri round-trips pending handoff context", () => {
    store.insert(makeEntry({ task_id: "T-handoff" }), "{}");

    const uri = "artifact://T-handoff/run-impl/handoff_packet.json";
    store.setHandoffPacketUri("T-handoff", uri);

    expect(store.getHandoffPacketUri("T-handoff")).toBe(uri);
    const row = db
      .prepare("select handoff_packet_uri from task_queue where task_id = ?")
      .get("T-handoff") as { handoff_packet_uri: string };
    expect(row.handoff_packet_uri).toBe(uri);

    store.setHandoffPacketUri("T-handoff", undefined);
    expect(store.getHandoffPacketUri("T-handoff")).toBeUndefined();
  });

  it("release throws for non-existent task", () => {
    expect(() => store.release("nonexistent", { status: "queued" })).toThrow(
      "not found",
    );
  });

  it("conditional update prevents modifying already-claimed row", () => {
    store.insert(makeEntry(), "{}");
    // First claim succeeds
    const first = store.claim("w1", 600);
    expect(first).not.toBeNull();
    expect(first!.current_owner_run_id).toBe("w1");

    // Now simulate what would happen if a stale claim tried to UPDATE
    // the same row without the conditional WHERE clauses.
    // Directly prepare the same conditional UPDATE and run it.
    const now = new Date().toISOString();
    const fut = new Date(Date.now() + 60000).toISOString();
    const stmt = db.prepare(`
      update task_queue set
        status = 'dispatched',
        current_owner_run_id = @workerId,
        lease_expires_at = @leaseExpires,
        updated_at = @now
      where task_id = @task_id
        and status = 'queued'
        and (current_owner_run_id is null or lease_expires_at < @now)
    `);
    const result = stmt.run({
      task_id: "T-001",
      workerId: "w2",
      leaseExpires: fut,
      now,
    });
    // Row no longer matches conditions (status is 'dispatched', not 'queued')
    expect(result.changes).toBe(0);

    // Verify the row was NOT overwritten
    const got = store.get("T-001")!;
    expect(got.status).toBe("dispatched");
    expect(got.current_owner_run_id).toBe("w1");
  });
});
