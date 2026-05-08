import type { Database } from "./database.js";
import type { BudgetState } from "../core/types.js";

interface Stmt {
  run(params: Record<string, unknown>): void;
  get(...params: unknown[]): unknown | undefined;
}

export interface BudgetStore {
  init(taskId: string, caps: BudgetState["caps"]): void;
  current(taskId: string): BudgetState;
  applyPreLaunch(taskId: string): BudgetState;
  applyPostRun(taskId: string, deltaWallMs: number, deltaCostUnits: number): BudgetState;
}

function computeStatus(used: { runs: number; wallMs: number; cost: number }, caps: BudgetState["caps"]): BudgetState["status"] {
  const runRatio = caps.max_runs > 0 ? used.runs / caps.max_runs : 0;
  const wallRatio = caps.max_wall_time_ms > 0 ? used.wallMs / caps.max_wall_time_ms : 0;
  const costRatio = caps.max_total_cost_units > 0 ? used.cost / caps.max_total_cost_units : 0;

  if (runRatio >= 1 || wallRatio >= 1 || costRatio >= 1) return "exhausted";
  if (runRatio >= 0.8 || wallRatio >= 0.8 || costRatio >= 0.8) return "soft_warning";
  return "ok";
}

export class SqliteBudgetStore implements BudgetStore {
  private insertStmt: Stmt;
  private getStmt: Stmt;
  private updateStmt: Stmt;

  constructor(private db: Database) {
    this.insertStmt = db.prepare(`
      insert into task_budget (
        task_id, runs_used, wall_time_ms_used, cost_units_used,
        max_runs, max_wall_time_ms, max_total_cost_units, status
      ) values (
        @task_id, @runs_used, @wall_time_ms_used, @cost_units_used,
        @max_runs, @max_wall_time_ms, @max_total_cost_units, @status
      )
    `) as unknown as Stmt;

    this.getStmt = db.prepare("select * from task_budget where task_id = ?") as unknown as Stmt;

    this.updateStmt = db.prepare(`
      update task_budget set
        runs_used = @runs_used,
        wall_time_ms_used = @wall_time_ms_used,
        cost_units_used = @cost_units_used,
        status = @status
      where task_id = @task_id
    `) as unknown as Stmt;
  }

  init(taskId: string, caps: BudgetState["caps"]): void {
    const existing = this.getStmt.get(taskId);
    if (existing) return; // idempotent

    this.insertStmt.run({
      task_id: taskId,
      runs_used: 0,
      wall_time_ms_used: 0,
      cost_units_used: 0,
      max_runs: caps.max_runs,
      max_wall_time_ms: caps.max_wall_time_ms,
      max_total_cost_units: caps.max_total_cost_units,
      status: "ok",
    });
  }

  current(taskId: string): BudgetState {
    const row = this.getStmt.get(taskId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Budget not found for task: ${taskId}`);
    }
    return this.rowToState(row);
  }

  applyPreLaunch(taskId: string): BudgetState {
    const state = this.current(taskId);
    const runsUsed = state.runs_used + 1;
    const status = computeStatus(
      { runs: runsUsed, wallMs: state.wall_time_ms_used, cost: state.cost_units_used },
      state.caps,
    );

    this.updateStmt.run({
      task_id: taskId,
      runs_used: runsUsed,
      wall_time_ms_used: state.wall_time_ms_used,
      cost_units_used: state.cost_units_used,
      status,
    });

    return {
      task_id: taskId,
      runs_used: runsUsed,
      wall_time_ms_used: state.wall_time_ms_used,
      cost_units_used: state.cost_units_used,
      caps: state.caps,
      status,
    };
  }

  applyPostRun(taskId: string, deltaWallMs: number, deltaCostUnits: number): BudgetState {
    const state = this.current(taskId);
    const wallMsUsed = state.wall_time_ms_used + deltaWallMs;
    const costUsed = state.cost_units_used + deltaCostUnits;
    const status = computeStatus(
      { runs: state.runs_used, wallMs: wallMsUsed, cost: costUsed },
      state.caps,
    );

    this.updateStmt.run({
      task_id: taskId,
      runs_used: state.runs_used,
      wall_time_ms_used: wallMsUsed,
      cost_units_used: costUsed,
      status,
    });

    return {
      task_id: taskId,
      runs_used: state.runs_used,
      wall_time_ms_used: wallMsUsed,
      cost_units_used: costUsed,
      caps: state.caps,
      status,
    };
  }

  private rowToState(row: Record<string, unknown>): BudgetState {
    return {
      task_id: row.task_id as string,
      runs_used: row.runs_used as number,
      wall_time_ms_used: row.wall_time_ms_used as number,
      cost_units_used: row.cost_units_used as number,
      caps: {
        max_runs: row.max_runs as number,
        max_wall_time_ms: row.max_wall_time_ms as number,
        max_total_cost_units: row.max_total_cost_units as number,
      },
      status: row.status as BudgetState["status"],
    };
  }
}
