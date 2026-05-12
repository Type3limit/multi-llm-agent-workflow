import { describe, it, expect, beforeEach, afterEach } from "vitest";
import SqliteDatabase from "better-sqlite3";
import type { Database } from "../../src/storage/database.js";
import { migrate } from "../../src/storage/migrations.js";
import { SqliteRunStore, type RunRecord } from "../../src/storage/run-store.js";

function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "R-001",
    project_id: "default",
    task_id: "T-001",
    agent_id: "A-001",
    status: "preparing",
    ...overrides,
  };
}

describe("SqliteRunStore", () => {
  let db: Database;
  let store: SqliteRunStore;

  beforeEach(() => {
    db = new SqliteDatabase(":memory:");
    migrate(db);
    store = new SqliteRunStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates a run and retrieves it", () => {
    store.create(makeRecord());
    const record = store.get("R-001");
    expect(record).toBeDefined();
    expect(record!.id).toBe("R-001");
    expect(record!.status).toBe("preparing");
    expect(record!.task_id).toBe("T-001");
  });

  it("allows multiple runs for the same task", () => {
    store.create(makeRecord({ id: "R-001" }));
    store.create(makeRecord({ id: "R-002", task_id: "T-001" }));
    expect(store.get("R-001")).toBeDefined();
    expect(store.get("R-002")).toBeDefined();
  });

  it("throws on duplicate run id (primary key violation)", () => {
    store.create(makeRecord({ id: "R-001" }));
    expect(() => store.create(makeRecord({ id: "R-001" }))).toThrow();
  });

  it("updateStatus changes status and allowed fields", () => {
    store.create(makeRecord());
    store.updateStatus("R-001", "running", {
      workspace_path: "/tmp/ws",
      base_commit: "abc123",
      started_at: "2026-01-01T00:00:00Z",
    });

    const record = store.get("R-001")!;
    expect(record.status).toBe("running");
    expect(record.workspace_path).toBe("/tmp/ws");
    expect(record.base_commit).toBe("abc123");
    expect(record.started_at).toBe("2026-01-01T00:00:00Z");
  });

  it("updateStatus preserves existing values when only status changes", () => {
    store.create(makeRecord({ workspace_path: "/tmp/original" }));
    store.updateStatus("R-001", "running");
    const record = store.get("R-001")!;
    expect(record.status).toBe("running");
    expect(record.workspace_path).toBe("/tmp/original");
  });

  it("updateStatus rejects patch modifying immutable field id", () => {
    store.create(makeRecord());
    expect(() =>
      store.updateStatus("R-001", "running", { id: "R-002" }),
    ).toThrow("id");
  });

  it("updateStatus rejects patch modifying project_id", () => {
    store.create(makeRecord());
    expect(() =>
      store.updateStatus("R-001", "running", { project_id: "other" }),
    ).toThrow("project_id");
  });

  it("updateStatus rejects patch modifying task_id", () => {
    store.create(makeRecord());
    expect(() =>
      store.updateStatus("R-001", "running", { task_id: "T-other" }),
    ).toThrow("task_id");
  });

  it("updateStatus rejects patch modifying agent_id", () => {
    store.create(makeRecord());
    expect(() =>
      store.updateStatus("R-001", "running", { agent_id: "A-other" }),
    ).toThrow("agent_id");
  });

  it("get returns undefined for non-existent run", () => {
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("updateStatus throws for non-existent run", () => {
    expect(() => store.updateStatus("nonexistent", "running")).toThrow(
      "Run not found",
    );
  });

  it("can update all allowed optional fields", () => {
    store.create(makeRecord());
    store.updateStatus("R-001", "succeeded", {
      workspace_path: "/ws",
      base_commit: "def456",
      branch_name: "agent/T-001/R-001",
      run_manifest_ref: "manifest.json",
      started_at: "2026-01-01T00:00:00Z",
      ended_at: "2026-01-01T00:05:00Z",
    });
    const r = store.get("R-001")!;
    expect(r.status).toBe("succeeded");
    expect(r.workspace_path).toBe("/ws");
    expect(r.base_commit).toBe("def456");
    expect(r.branch_name).toBe("agent/T-001/R-001");
    expect(r.run_manifest_ref).toBe("manifest.json");
    expect(r.started_at).toBe("2026-01-01T00:00:00Z");
    expect(r.ended_at).toBe("2026-01-01T00:05:00Z");
  });

  it("optional fields are undefined (not null) after create with only required fields", () => {
    store.create(makeRecord());
    const record = store.get("R-001")!;
    expect(record.workspace_path).toBeUndefined();
    expect(record.base_commit).toBeUndefined();
    expect(record.branch_name).toBeUndefined();
    expect(record.run_manifest_ref).toBeUndefined();
    expect(record.started_at).toBeUndefined();
    expect(record.ended_at).toBeUndefined();
  });

  it("supports terminal statuses succeeded/failed/cancelled", () => {
    store.create(makeRecord({ id: "R-s" }));
    store.create(makeRecord({ id: "R-f" }));
    store.create(makeRecord({ id: "R-c" }));

    store.updateStatus("R-s", "succeeded");
    store.updateStatus("R-f", "failed");
    store.updateStatus("R-c", "cancelled");

    expect(store.get("R-s")!.status).toBe("succeeded");
    expect(store.get("R-f")!.status).toBe("failed");
    expect(store.get("R-c")!.status).toBe("cancelled");
  });

  // ─── v1 fields ──────────────────────────────────────────────────────

  it("v0 record (no role) still create/get works, role/parent/handoff are undefined", () => {
    store.create(makeRecord());
    const r = store.get("R-001")!;
    expect(r.role).toBeUndefined();
    expect(r.parent_run_id).toBeUndefined();
    expect(r.handoff_packet_uri).toBeUndefined();
  });

  it("v1 record with role, parent_run_id, handoff_packet_uri survives round-trip", () => {
    store.create(makeRecord({
      role: "implementer",
      parent_run_id: "R-parent",
      handoff_packet_uri: "artifact://T-1/R-parent/handoff_packet.json",
    }));
    const r = store.get("R-001")!;
    expect(r.role).toBe("implementer");
    expect(r.parent_run_id).toBe("R-parent");
    expect(r.handoff_packet_uri).toBe("artifact://T-1/R-parent/handoff_packet.json");
  });

  it("v1 reviewer role survives round-trip", () => {
    store.create(makeRecord({ id: "R-review", role: "reviewer" }));
    const r = store.get("R-review")!;
    expect(r.role).toBe("reviewer");
  });

  it("updateStatus can patch role, parent_run_id, handoff_packet_uri", () => {
    store.create(makeRecord());
    store.updateStatus("R-001", "running", {
      role: "reviewer",
      parent_run_id: "R-parent",
      handoff_packet_uri: "uri://handoff",
    });
    const r = store.get("R-001")!;
    expect(r.role).toBe("reviewer");
    expect(r.parent_run_id).toBe("R-parent");
    expect(r.handoff_packet_uri).toBe("uri://handoff");
  });

  it("listCleanupCandidates returns accepted and failed v1 runs by task_id then run insertion order", () => {
    insertTaskQueueRow(db, { taskId: "T-z", status: "accepted", index: 0 });
    insertTaskQueueRow(db, { taskId: "T-a", status: "accepted", index: 1 });
    insertTaskQueueRow(db, { taskId: "T-f", status: "failed", index: 2 });
    insertTaskQueueRow(db, { taskId: "T-human", status: "awaiting_human", index: 3 });

    store.create(makeRecord({
      id: "R-z-1",
      task_id: "T-z",
      role: "implementer",
      workspace_path: "/ws/z-1",
    }));
    store.create(makeRecord({
      id: "R-a-1",
      task_id: "T-a",
      role: "implementer",
      workspace_path: "/ws/a-1",
    }));
    store.create(makeRecord({
      id: "R-a-2",
      task_id: "T-a",
      role: "reviewer",
    }));
    store.create(makeRecord({
      id: "R-f-1",
      task_id: "T-f",
      status: "failed",
      role: "implementer",
      workspace_path: "/ws/f-1",
    }));
    store.create(makeRecord({
      id: "R-human-1",
      task_id: "T-human",
      role: "reviewer",
      workspace_path: "/ws/human-1",
    }));

    const candidates = store.listCleanupCandidates([
      "T-z",
      "T-human",
      "T-a",
      "T-f",
    ]);

    expect(candidates.map((record) => record.run_id)).toEqual([
      "R-a-1",
      "R-a-2",
      "R-f-1",
      "R-z-1",
    ]);
    expect(candidates.map((record) => record.task_id)).toEqual([
      "T-a",
      "T-a",
      "T-f",
      "T-z",
    ]);
    expect(candidates[1]).toMatchObject({
      run_id: "R-a-2",
      role: "reviewer",
    });
    expect(candidates[1].workspace_path).toBeUndefined();
  });
});

function insertTaskQueueRow(
  db: Database,
  args: {
    taskId: string;
    status: "accepted" | "failed" | "awaiting_human";
    index: number;
  },
): void {
  const ts = `2026-01-01T00:00:${String(args.index).padStart(2, "0")}.000Z`;
  db.prepare(`
    insert into task_queue (
      task_id, project_id, status, next_role,
      current_owner_run_id, lease_expires_at,
      attempts, enqueued_at, updated_at, workorder_json
    ) values (
      @task_id, 'default', @status, 'implementer',
      null, null, 1, @ts, @ts, '{}'
    )
  `).run({
    task_id: args.taskId,
    status: args.status,
    ts,
  });
}
