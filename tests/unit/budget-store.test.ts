import SqliteDatabase from "better-sqlite3";
import { migrate } from "../../src/storage/migrations.js";
import { SqliteBudgetStore } from "../../src/storage/budget-store.js";
import type { Database } from "../../src/storage/database.js";
import type { BudgetState } from "../../src/core/types.js";

const DEFAULT_CAPS: BudgetState["caps"] = {
  max_runs: 4,
  max_wall_time_ms: 1_800_000,
  max_total_cost_units: 10,
};

describe("SqliteBudgetStore", () => {
  let db: Database;
  let store: SqliteBudgetStore;

  beforeEach(() => {
    db = new SqliteDatabase(":memory:");
    migrate(db);
    store = new SqliteBudgetStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("init + current returns fresh zeroed state with ok status", () => {
    store.init("task-1", DEFAULT_CAPS);
    const state = store.current("task-1");

    expect(state.runs_used).toBe(0);
    expect(state.wall_time_ms_used).toBe(0);
    expect(state.cost_units_used).toBe(0);
    expect(state.status).toBe("ok");
    expect(state.caps).toEqual(DEFAULT_CAPS);
  });

  it("init is idempotent — second init does not reset usage", () => {
    store.init("task-2", DEFAULT_CAPS);
    store.applyPreLaunch("task-2");

    // second init should be a no-op
    store.init("task-2", DEFAULT_CAPS);

    const state = store.current("task-2");
    expect(state.runs_used).toBe(1);
  });

  it("applyPreLaunch increments only runs_used", () => {
    store.init("task-3", DEFAULT_CAPS);
    const state = store.applyPreLaunch("task-3");

    expect(state.runs_used).toBe(1);
    expect(state.wall_time_ms_used).toBe(0);
    expect(state.cost_units_used).toBe(0);
    expect(state.status).toBe("ok");
  });

  it("applyPostRun increments wall time and cost", () => {
    store.init("task-4", DEFAULT_CAPS);
    store.applyPreLaunch("task-4");

    const state = store.applyPostRun("task-4", 300_000, 5);

    expect(state.wall_time_ms_used).toBe(300_000);
    expect(state.cost_units_used).toBe(5);
    expect(state.runs_used).toBe(1);
  });

  it("transitions to soft_warning at 80% usage", () => {
    const caps: BudgetState["caps"] = {
      max_runs: 10,
      max_wall_time_ms: 1_000_000,
      max_total_cost_units: 100,
    };
    store.init("task-5", caps);

    for (let i = 0; i < 8; i++) {
      store.applyPreLaunch("task-5");
    }

    const state = store.current("task-5");
    expect(state.runs_used).toBe(8);
    expect(state.status).toBe("soft_warning");
  });

  it("transitions to exhausted at 100% usage", () => {
    const caps: BudgetState["caps"] = {
      max_runs: 5,
      max_wall_time_ms: 1_000_000,
      max_total_cost_units: 100,
    };
    store.init("task-6", caps);

    for (let i = 0; i < 5; i++) {
      store.applyPreLaunch("task-6");
    }

    const state = store.current("task-6");
    expect(state.runs_used).toBe(5);
    expect(state.status).toBe("exhausted");
  });

  it("current throws for non-existent task", () => {
    expect(() => store.current("nonexistent")).toThrow("Budget not found for task");
  });
});
