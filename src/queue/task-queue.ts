import type { QueueStore } from "../storage/queue-store.js";
import type { ReviewContextRecord, TaskQueueEntry } from "../core/types.js";
import type { ParsedWorkOrderV1 } from "../core/schemas-v1.js";

// ─── TaskQueue interface ─────────────────────────────────────────────────────

export interface TaskQueue {
  enqueue(args: {
    workOrder: ParsedWorkOrderV1;
    nextRole?: "implementer" | "reviewer";
  }): TaskQueueEntry;

  claim(workerId: string, leaseDurationSec?: number): TaskQueueEntry | null;

  release(taskId: string, patch: Partial<TaskQueueEntry>): void;

  setStatus(taskId: string, status: TaskQueueEntry["status"]): void;

  get(taskId: string): TaskQueueEntry | undefined;

  getWorkOrder(taskId: string): ParsedWorkOrderV1 | undefined;

  addWorkOrderExcludeAgentIds(taskId: string, agentIds: string[]): ParsedWorkOrderV1;

  setReviewContext(taskId: string, context: ReviewContextRecord): void;

  getReviewContext(taskId: string): ReviewContextRecord | undefined;

  setHandoffPacketUri(taskId: string, uri: string | undefined): void;

  getHandoffPacketUri(taskId: string): string | undefined;

  listTerminal(): TaskQueueEntry[];
}

// ─── Default lease duration helper ───────────────────────────────────────────

/**
 * Compute the default lease duration for a WorkOrder.
 *
 * Formula: min(60 minutes, max_wall_time_minutes * 60 + 60 seconds)
 *
 * The extra 60 seconds gives a graceful buffer after the budgeted wall time.
 */
export function defaultLeaseDurationSeconds(workOrder: ParsedWorkOrderV1): number {
  const fromBudget = workOrder.budget.max_wall_time_minutes * 60 + 60;
  return Math.min(3600, fromBudget);
}

// ─── Terminal statuses ───────────────────────────────────────────────────────

const TERMINAL_STATUSES: TaskQueueEntry["status"][] = ["accepted", "failed", "awaiting_human"];

// ─── DefaultTaskQueue ────────────────────────────────────────────────────────

export class DefaultTaskQueue implements TaskQueue {
  private store: QueueStore;
  private now: () => Date;
  private workOrders: Map<string, ParsedWorkOrderV1> = new Map();

  constructor(args: { store: QueueStore; now?: () => Date }) {
    this.store = args.store;
    this.now = args.now ?? (() => new Date());
  }

  enqueue(args: {
    workOrder: ParsedWorkOrderV1;
    nextRole?: "implementer" | "reviewer";
  }): TaskQueueEntry {
    const workOrder = args.workOrder;
    const nextRole = args.nextRole ?? "implementer";
    const ts = this.now().toISOString();

    const entry: TaskQueueEntry = {
      task_id: workOrder.task_id,
      project_id: workOrder.project_id ?? "default",
      status: "queued",
      next_role: nextRole,
      current_owner_run_id: null,
      lease_expires_at: null,
      attempts: 0,
      enqueued_at: ts,
      updated_at: ts,
    };

    const workOrderJson = JSON.stringify(workOrder);
    this.store.insert(entry, workOrderJson);
    this.workOrders.set(workOrder.task_id, workOrder);

    return entry;
  }

  claim(workerId: string, leaseDurationSec?: number): TaskQueueEntry | null {
    let leaseDuration: number;

    if (leaseDurationSec !== undefined) {
      leaseDuration = leaseDurationSec;
    } else {
      leaseDuration = this.computeDefaultLeaseForNextClaimable();
    }

    return this.store.claim(workerId, leaseDuration);
  }

  /**
   * Identify the first row that matches the store claim predicate and return
   * its lease duration.
   *
   * Store predicate (SqliteQueueStore.claim):
   *   WHERE status = 'queued'
   *     AND (current_owner_run_id IS NULL OR lease_expires_at < @now)
   *   ORDER BY enqueued_at ASC
   *   LIMIT 1
   *
   * Equivalence rules:
   *   - skip rows whose status is not 'queued';
   *   - if current_owner_run_id is null, the row is claimable;
   *   - otherwise the row is claimable only when lease_expires_at is non-null
   *     AND strictly earlier than this.now() (NULL < @now is not true in SQLite).
   *
   * - If that row has a cached WorkOrder, use defaultLeaseDurationSeconds(wo).
   * - If that row has no cached WorkOrder, load it from persisted storage,
   *   cache it, and use defaultLeaseDurationSeconds(wo).
   * - If that row has no parseable persisted WorkOrder, use the 3600s fallback.
   * - If no row is claimable, returns 3600s (the value is not behaviorally
   *   important since store.claim() will return null anyway).
   */
  private computeDefaultLeaseForNextClaimable(): number {
    const all = this.store.listAll();
    const now = this.now();

    for (const entry of all) {
      if (entry.status !== "queued") continue;

      // Must match the store claim predicate exactly.
      // pred: current_owner_run_id IS NULL OR lease_expires_at < @now
      if (entry.current_owner_run_id !== null) {
        // Has an owner — only claimable when lease_expires_at is non-null
        // AND strictly before now (matching SQLite's < operator).
        if (entry.lease_expires_at === null) continue;
        if (new Date(entry.lease_expires_at).getTime() >= now.getTime()) continue;
      }

      // This is the row store.claim() will claim.
      const wo = this.workOrders.get(entry.task_id);
      if (wo) {
        return defaultLeaseDurationSeconds(wo);
      }

      try {
        const persisted = this.store.getWorkOrder(entry.task_id);
        if (persisted) {
          this.workOrders.set(entry.task_id, persisted);
          return defaultLeaseDurationSeconds(persisted);
        }
      } catch {
        // Unknown or unparseable persisted WorkOrders retain the conservative fallback.
      }
      return 3600; // unknown WorkOrder → 3600s fallback
    }

    // No claimable row — value not behaviorally important; keep it simple.
    return 3600;
  }

  release(taskId: string, patch: Partial<TaskQueueEntry>): void {
    this.store.release(taskId, patch);
  }

  setStatus(taskId: string, status: TaskQueueEntry["status"]): void {
    this.store.setStatus(taskId, status);
  }

  get(taskId: string): TaskQueueEntry | undefined {
    return this.store.get(taskId);
  }

  getWorkOrder(taskId: string): ParsedWorkOrderV1 | undefined {
    const cached = this.workOrders.get(taskId);
    if (cached) {
      return structuredClone(cached);
    }

    const workOrder = this.store.getWorkOrder(taskId);
    if (workOrder) {
      this.workOrders.set(taskId, workOrder);
      return structuredClone(workOrder);
    }
    return workOrder;
  }

  addWorkOrderExcludeAgentIds(taskId: string, agentIds: string[]): ParsedWorkOrderV1 {
    const workOrder = this.store.addWorkOrderExcludeAgentIds(taskId, agentIds);
    this.workOrders.set(taskId, workOrder);
    return structuredClone(workOrder);
  }

  setReviewContext(taskId: string, context: ReviewContextRecord): void {
    this.store.setReviewContext(taskId, context);
  }

  getReviewContext(taskId: string): ReviewContextRecord | undefined {
    const context = this.store.getReviewContext(taskId);
    return context ? structuredClone(context) : undefined;
  }

  setHandoffPacketUri(taskId: string, uri: string | undefined): void {
    this.store.setHandoffPacketUri(taskId, uri);
  }

  getHandoffPacketUri(taskId: string): string | undefined {
    return this.store.getHandoffPacketUri(taskId);
  }

  listTerminal(): TaskQueueEntry[] {
    return this.store.listAll().filter((entry) =>
      TERMINAL_STATUSES.includes(entry.status),
    );
  }
}
