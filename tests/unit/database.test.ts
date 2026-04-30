import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDatabase, type Database } from "../../src/storage/database.js";
import { migrate } from "../../src/storage/migrations.js";

describe("openDatabase()", () => {
  let db: Database;

  afterAll(() => {
    db?.close();
  });

  it("opens :memory: database and returns a Database instance", () => {
    db = openDatabase(":memory:");
    expect(db).toBeDefined();
    expect(db.open).toBe(true);
  });

  it("after migrate, all four tables exist", () => {
    migrate(db);
    const tables = db
      .prepare(
        "select name from sqlite_master where type = 'table' order by name",
      )
      .all()
      .map((r: unknown) => (r as Record<string, string>).name);
    expect(tables).toEqual([
      "agent_runs",
      "agent_usage",
      "artifacts",
      "task_events",
    ]);
  });

  it("can close the database", () => {
    db.close();
    expect(db.open).toBe(false);
  });
});
