import { describe, it, expect, beforeAll, afterAll } from "vitest";
import SqliteDatabase from "better-sqlite3";
import type { Database } from "../../src/storage/database.js";
import { migrate } from "../../src/storage/migrations.js";

const EXPECTED_TABLES: Record<string, string[]> = {
  task_events: [
    "id", "project_id", "task_id", "run_id", "agent_id",
    "event_type", "payload_json", "correlation_id",
    "causation_id", "side_effect_type", "skip_on_replay", "created_at",
  ],
  agent_runs: [
    "id", "project_id", "task_id", "agent_id", "status",
    "workspace_path", "base_commit", "branch_name",
    "run_manifest_ref", "started_at", "ended_at",
  ],
  artifacts: [
    "id", "project_id", "task_id", "run_id", "kind",
    "uri", "path", "checksum", "summary", "created_at",
  ],
  agent_usage: [
    "id", "project_id", "task_id", "run_id", "agent_id",
    "wall_time_ms", "exit_code", "timed_out",
    "stdout_bytes", "stderr_bytes", "created_at",
  ],
  task_queue: [
    "task_id", "project_id", "status", "next_role",
    "current_owner_run_id", "lease_expires_at",
    "attempts", "enqueued_at", "updated_at", "workorder_json",
    "review_context_json", "handoff_packet_uri",
  ],
  agent_metrics: [
    "id", "agent_id", "run_id", "success", "wall_time_ms",
    "actual_cost_units", "created_at",
  ],
  task_budget: [
    "task_id", "runs_used", "wall_time_ms_used", "cost_units_used",
    "max_runs", "max_wall_time_ms", "max_total_cost_units", "status",
  ],
};

function tableColumns(db: Database, table: string): string[] {
  return db
    .prepare(`pragma table_info('${table}')`)
    .all()
    .map((r: unknown) => (r as Record<string, unknown>).name as string);
}

function tableNames(db: Database): string[] {
  return db
    .prepare(
      "select name from sqlite_master where type = 'table' order by name",
    )
    .all()
    .map((r: unknown) => (r as Record<string, unknown>).name as string);
}

describe("migrate()", () => {
  let db: Database;

  beforeAll(() => {
    db = new SqliteDatabase(":memory:");
    migrate(db);
  });

  afterAll(() => {
    db.close();
  });

  it("creates 7 user tables (plus sqlite_sequence)", () => {
    const tables = tableNames(db).filter((t) => t !== "sqlite_sequence");
    expect(tables).toHaveLength(7);
  });

  for (const [table, columns] of Object.entries(EXPECTED_TABLES)) {
    it(`creates table '${table}' with required columns`, () => {
      const names = tableNames(db);
      expect(names).toContain(table);

      const actual = tableColumns(db, table);
      for (const col of columns) {
        expect(actual).toContain(col);
      }
    });
  }

  it("migrate() is idempotent (double call does not crash)", () => {
    expect(() => migrate(db)).not.toThrow();
    const tables = tableNames(db).filter((t) => t !== "sqlite_sequence");
    expect(tables).toHaveLength(7);
  });

  it("agent_runs has v1 columns (role, parent_run_id, handoff_packet_uri)", () => {
    const cols = tableColumns(db, "agent_runs");
    expect(cols).toContain("role");
    expect(cols).toContain("parent_run_id");
    expect(cols).toContain("handoff_packet_uri");
  });

  it("task_queue has status/lease index", () => {
    const indexes = db
      .prepare("select name from sqlite_master where type = 'index' and name = 'task_queue_status_lease_idx'")
      .all();
    expect(indexes).toHaveLength(1);
  });

  it("agent_metrics has agent_id/created_at index", () => {
    const indexes = db
      .prepare("select name from sqlite_master where type = 'index' and name = 'agent_metrics_agent_id_idx'")
      .all();
    expect(indexes).toHaveLength(1);
  });

  it("task_events has skip_on_replay default 0", () => {
    const col = db
      .prepare("pragma table_info('task_events')")
      .all()
      .find(
        (r: unknown) => (r as Record<string, unknown>).name === "skip_on_replay",
      ) as Record<string, unknown>;
    expect(col.dflt_value).toBe("0");
  });

  it("agent_usage has timed_out default 0", () => {
    const col = db
      .prepare("pragma table_info('agent_usage')")
      .all()
      .find(
        (r: unknown) => (r as Record<string, unknown>).name === "timed_out",
      ) as Record<string, unknown>;
    expect(col.dflt_value).toBe("0");
  });
});
