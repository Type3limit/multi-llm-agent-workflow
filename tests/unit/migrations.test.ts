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

  it("creates exactly 4 tables", () => {
    const tables = tableNames(db);
    expect(tables).toHaveLength(4);
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

  it("migrate() is idempotent", () => {
    expect(() => migrate(db)).not.toThrow();
    const tables = tableNames(db);
    expect(tables).toHaveLength(4);
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
