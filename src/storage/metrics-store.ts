import type { Database } from "./database.js";


interface Stmt {
  run(params: Record<string, unknown>): void;
  all(...params: unknown[]): unknown[];
}

export interface MetricsStore {
  recordRunOutcome(args: {
    agentId: string;
    runId: string;
    success: boolean;
    wallTimeMs: number;
    actualCostUnits?: number;
  }): void;
  rollingFor(agentId: string, windowSize: number): {
    successRate: number;
    avgLatencyMs: number;
    avgActualCostUnits: number;
    runsObserved: number;
  };
}

export class SqliteMetricsStore implements MetricsStore {
  private insertStmt: Stmt;
  private rollingStmt: Stmt;

  constructor(private db: Database) {
    this.insertStmt = db.prepare(`
      insert into agent_metrics (
        agent_id, run_id, success, wall_time_ms, actual_cost_units, created_at
      ) values (
        @agent_id, @run_id, @success, @wall_time_ms, @actual_cost_units, @created_at
      )
    `) as unknown as Stmt;

    this.rollingStmt = db.prepare(`
      select success, wall_time_ms, actual_cost_units
      from agent_metrics
      where agent_id = ?
      order by created_at desc, id desc
      limit ?
    `) as unknown as Stmt;
  }

  recordRunOutcome(args: {
    agentId: string;
    runId: string;
    success: boolean;
    wallTimeMs: number;
    actualCostUnits?: number;
  }): void {
    this.insertStmt.run({
      agent_id: args.agentId,
      run_id: args.runId,
      success: args.success ? 1 : 0,
      wall_time_ms: args.wallTimeMs,
      actual_cost_units: args.actualCostUnits ?? null,
      created_at: new Date().toISOString(),
    });
  }

  rollingFor(agentId: string, windowSize: number): {
    successRate: number;
    avgLatencyMs: number;
    avgActualCostUnits: number;
    runsObserved: number;
  } {
    const rows = this.rollingStmt.all(agentId, windowSize) as Array<{
      success: number;
      wall_time_ms: number;
      actual_cost_units: number | null;
    }>;

    if (rows.length === 0) {
      return {
        successRate: 0,
        avgLatencyMs: 0,
        avgActualCostUnits: 0,
        runsObserved: 0,
      };
    }

    const runsObserved = rows.length;
    const successCount = rows.filter((r) => r.success !== 0).length;
    const totalWallMs = rows.reduce((sum, r) => sum + r.wall_time_ms, 0);
    const costRows = rows.filter((r) => r.actual_cost_units != null);
    const totalCost = costRows.reduce((sum, r) => sum + (r.actual_cost_units as number), 0);

    return {
      successRate: successCount / runsObserved,
      avgLatencyMs: Math.round(totalWallMs / runsObserved),
      avgActualCostUnits: costRows.length > 0 ? totalCost / costRows.length : 0,
      runsObserved,
    };
  }
}
