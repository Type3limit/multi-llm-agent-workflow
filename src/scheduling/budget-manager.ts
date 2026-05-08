import type { BudgetStore } from "../storage/budget-store.js";
import type { EventLog } from "../storage/event-log.js";
import type { BudgetState } from "../core/types.js";
import type { ParsedWorkOrderV1 } from "../core/schemas-v1.js";
import { generateEventId } from "../core/ids.js";

// ─── Public interface ────────────────────────────────────────────────────────

export interface BudgetManager {
  init(workOrder: ParsedWorkOrderV1): BudgetState;
  current(taskId: string): BudgetState;
  preLaunch(taskId: string): BudgetState;
  postRun(args: {
    taskId: string;
    runDurationMs: number;
    actualCostUnits?: number;
    estimatedCostUnits: number;
  }): BudgetState;
}

// ─── Axis helper ─────────────────────────────────────────────────────────────

type BudgetAxis = "runs" | "wall_time_ms" | "cost_units";

function pickAxis(state: BudgetState): { axis: BudgetAxis; ratio: number } {
  const runRatio = state.caps.max_runs > 0 ? state.runs_used / state.caps.max_runs : 0;
  const wallRatio =
    state.caps.max_wall_time_ms > 0
      ? state.wall_time_ms_used / state.caps.max_wall_time_ms
      : 0;
  const costRatio =
    state.caps.max_total_cost_units > 0
      ? state.cost_units_used / state.caps.max_total_cost_units
      : 0;

  if (runRatio >= wallRatio && runRatio >= costRatio) {
    return { axis: "runs", ratio: runRatio };
  }
  if (wallRatio >= costRatio) {
    return { axis: "wall_time_ms", ratio: wallRatio };
  }
  return { axis: "cost_units", ratio: costRatio };
}

// ─── Implementation ──────────────────────────────────────────────────────────

export class DefaultBudgetManager implements BudgetManager {
  private budgetStore: BudgetStore;
  private eventLog: EventLog;
  private projectId: string;

  // Track which task-status transitions have already emitted events.
  // Key: `${taskId}::low` or `${taskId}::exhausted`
  private emitted: Set<string> = new Set();

  constructor(args: {
    budgetStore: BudgetStore;
    eventLog: EventLog;
    projectId?: string;
  }) {
    this.budgetStore = args.budgetStore;
    this.eventLog = args.eventLog;
    this.projectId = args.projectId ?? "default";
  }

  // ── init ──────────────────────────────────────────────────────────────────

  init(workOrder: ParsedWorkOrderV1): BudgetState {
    const caps: BudgetState["caps"] = {
      max_runs: workOrder.budget.max_runs,
      max_wall_time_ms: workOrder.budget.max_wall_time_minutes * 60_000,
      max_total_cost_units: workOrder.budget.max_total_cost_units,
    };

    this.budgetStore.init(workOrder.task_id, caps);

    const current = this.budgetStore.current(workOrder.task_id);
    this.syncEmitted(current);
    return current;
  }

  // ── current ───────────────────────────────────────────────────────────────

  current(taskId: string): BudgetState {
    return this.budgetStore.current(taskId);
  }

  // ── preLaunch ─────────────────────────────────────────────────────────────

  preLaunch(taskId: string): BudgetState {
    const before = this.budgetStore.current(taskId);
    const after = this.budgetStore.applyPreLaunch(taskId);
    this.emitTransitionEvents(taskId, before.status, after.status, after);
    return after;
  }

  // ── postRun ───────────────────────────────────────────────────────────────

  postRun(args: {
    taskId: string;
    runDurationMs: number;
    actualCostUnits?: number;
    estimatedCostUnits: number;
  }): BudgetState {
    const costDelta = args.actualCostUnits ?? args.estimatedCostUnits;

    const before = this.budgetStore.current(args.taskId);
    const after = this.budgetStore.applyPostRun(
      args.taskId,
      args.runDurationMs,
      costDelta,
    );
    this.emitTransitionEvents(args.taskId, before.status, after.status, after);
    return after;
  }

  // ── internal helpers ──────────────────────────────────────────────────────

  private emitTransitionEvents(
    taskId: string,
    from: BudgetState["status"],
    to: BudgetState["status"],
    state: BudgetState,
  ): void {
    if (from === to) return;

    // soft_warning
    if (from === "ok" && to === "soft_warning") {
      this.emitQuotaLow(taskId, state);
      return;
    }

    // exhausted — can come from ok or soft_warning
    if ((from === "ok" || from === "soft_warning") && to === "exhausted") {
      this.emitQuotaExhausted(taskId, state);
      return;
    }
  }

  private emitQuotaLow(taskId: string, state: BudgetState): void {
    const key = `${taskId}::low`;
    if (this.emitted.has(key)) return;

    const { axis, ratio } = pickAxis(state);

    this.eventLog.append({
      event_id: generateEventId(),
      event_type: "quota.low",
      project_id: this.projectId,
      task_id: taskId,
      skip_on_replay: true,
      payload: {
        scope: "task",
        task_id: taskId,
        axis,
        ratio,
      },
      created_at: new Date().toISOString(),
    });

    this.emitted.add(key);
  }

  private emitQuotaExhausted(taskId: string, state: BudgetState): void {
    const key = `${taskId}::exhausted`;
    if (this.emitted.has(key)) return;

    const { axis, ratio } = pickAxis(state);

    this.eventLog.append({
      event_id: generateEventId(),
      event_type: "quota.exhausted",
      project_id: this.projectId,
      task_id: taskId,
      skip_on_replay: true,
      payload: {
        scope: "task",
        task_id: taskId,
        axis,
        ratio,
      },
      created_at: new Date().toISOString(),
    });

    this.emitted.add(key);
  }

  /**
   * Sync the emitted tracker with the current BudgetState after an `init()`
   * call so that a later `preLaunch()`/`postRun()` doesn't re-fire events for
   * a status that already exists on disk.
   */
  private syncEmitted(state: BudgetState): void {
    if (state.status === "soft_warning" || state.status === "exhausted") {
      this.emitted.add(`${state.task_id}::low`);
    }
    if (state.status === "exhausted") {
      this.emitted.add(`${state.task_id}::exhausted`);
    }
  }
}
