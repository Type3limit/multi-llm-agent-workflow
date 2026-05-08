import type { Database } from "./database.js";
import type { TaskQueueEntry } from "../core/types.js";
import { nullableString } from "./helpers.js";

interface Stmt {
  run(params: Record<string, unknown>): { changes: number };
  get(...params: unknown[]): unknown | undefined;
  all(...params: unknown[]): unknown[];
}

export interface QueueStore {
  insert(entry: TaskQueueEntry, workOrderJson: string): void;
  claim(workerId: string, leaseDurationSec: number): TaskQueueEntry | null;
  release(taskId: string, patch: Partial<TaskQueueEntry>): void;
  setStatus(taskId: string, status: TaskQueueEntry["status"]): void;
  get(taskId: string): TaskQueueEntry | undefined;
  listAll(): TaskQueueEntry[];
}

const TERMINAL_STATUSES: TaskQueueEntry["status"][] = ["accepted", "failed", "awaiting_human"];

export class SqliteQueueStore implements QueueStore {
  private insertStmt: Stmt;
  private claimSelectStmt: Stmt;
  private claimUpdateStmt: Stmt;
  private releaseStmt: Stmt;
  private getStmt: Stmt;
  private listStmt: Stmt;

  constructor(private db: Database) {
    this.insertStmt = db.prepare(`
      insert into task_queue (
        task_id, project_id, status, next_role,
        current_owner_run_id, lease_expires_at,
        attempts, enqueued_at, updated_at, workorder_json
      ) values (
        @task_id, @project_id, @status, @next_role,
        @current_owner_run_id, @lease_expires_at,
        @attempts, @enqueued_at, @updated_at, @workorder_json
      )
    `) as unknown as Stmt;

    this.claimSelectStmt = db.prepare(`
      select * from task_queue
      where status = 'queued'
        and (current_owner_run_id is null or lease_expires_at < @now)
      order by enqueued_at asc
      limit 1
    `) as unknown as Stmt;

    this.claimUpdateStmt = db.prepare(`
      update task_queue set
        status = 'dispatched',
        current_owner_run_id = @workerId,
        lease_expires_at = @leaseExpires,
        updated_at = @now
      where task_id = @task_id
        and status = 'queued'
        and (current_owner_run_id is null or lease_expires_at < @now)
    `) as unknown as Stmt;

    this.releaseStmt = db.prepare(`
      update task_queue set
        status = @status,
        next_role = @next_role,
        current_owner_run_id = @current_owner_run_id,
        lease_expires_at = @lease_expires_at,
        attempts = @attempts,
        updated_at = @updated_at
      where task_id = @task_id
    `) as unknown as Stmt;

    this.getStmt = db.prepare("select * from task_queue where task_id = ?") as unknown as Stmt;

    this.listStmt = db.prepare("select * from task_queue order by enqueued_at asc") as unknown as Stmt;
  }

  insert(entry: TaskQueueEntry, workOrderJson: string): void {
    this.insertStmt.run({
      task_id: entry.task_id,
      project_id: entry.project_id,
      status: entry.status,
      next_role: entry.next_role,
      current_owner_run_id: entry.current_owner_run_id,
      lease_expires_at: entry.lease_expires_at,
      attempts: entry.attempts,
      enqueued_at: entry.enqueued_at,
      updated_at: entry.updated_at,
      workorder_json: workOrderJson,
    });
  }

  claim(workerId: string, leaseDurationSec: number): TaskQueueEntry | null {
    const now = new Date().toISOString();
    const leaseExpires = new Date(Date.now() + leaseDurationSec * 1000).toISOString();

    const claimFn = this.db.transaction(() => {
      const row = this.claimSelectStmt.get({ now }) as Record<string, unknown> | undefined;
      if (!row) return null;

      const result = this.claimUpdateStmt.run({
        task_id: row.task_id,
        workerId,
        leaseExpires,
        now,
      });

      // Conditional UPDATE: if the row was modified between SELECT and UPDATE
      // (e.g. by another connection), changes will be 0.
      if (result.changes !== 1) return null;

      return row;
    });

    const row = claimFn();
    if (!row) return null;

    return this.rowToEntry(row, { status: "dispatched", currentOwnerRunId: workerId, leaseExpires, updatedAt: now });
  }

  release(taskId: string, patch: Partial<TaskQueueEntry>): void {
    const existing = this.get(taskId);
    if (!existing) {
      throw new Error(`TaskQueue entry not found: ${taskId}`);
    }

    const allowedKeys = new Set(["status", "next_role", "current_owner_run_id", "lease_expires_at", "attempts", "updated_at"]);
    for (const key of Object.keys(patch)) {
      if (!allowedKeys.has(key)) {
        throw new Error(`Cannot modify field "${key}" via release`);
      }
    }

    this.releaseStmt.run({
      task_id: taskId,
      status: patch.status ?? existing.status,
      next_role: patch.next_role ?? existing.next_role,
      current_owner_run_id: patch.current_owner_run_id !== undefined ? patch.current_owner_run_id : existing.current_owner_run_id,
      lease_expires_at: patch.lease_expires_at !== undefined ? patch.lease_expires_at : existing.lease_expires_at,
      attempts: patch.attempts ?? existing.attempts,
      updated_at: patch.updated_at ?? new Date().toISOString(),
    });
  }

  setStatus(taskId: string, status: TaskQueueEntry["status"]): void {
    this.db.prepare(`
      update task_queue set status = @status, updated_at = @now where task_id = @task_id
    `).run({
      task_id: taskId,
      status,
      now: new Date().toISOString(),
    });
  }

  get(taskId: string): TaskQueueEntry | undefined {
    const row = this.getStmt.get(taskId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.rowToEntry(row);
  }

  listAll(): TaskQueueEntry[] {
    const rows = this.listStmt.all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToEntry(row));
  }

  private rowToEntry(
    row: Record<string, unknown>,
    overrides?: Partial<{ status: string; currentOwnerRunId: string; leaseExpires: string; updatedAt: string }>,
  ): TaskQueueEntry {
    return {
      task_id: row.task_id as string,
      project_id: row.project_id as string,
      status: (overrides?.status ?? row.status) as TaskQueueEntry["status"],
      next_role: row.next_role as TaskQueueEntry["next_role"],
      current_owner_run_id: (overrides?.currentOwnerRunId ?? row.current_owner_run_id) as string | null,
      lease_expires_at: (overrides?.leaseExpires ?? row.lease_expires_at) as string | null,
      attempts: row.attempts as number,
      enqueued_at: row.enqueued_at as string,
      updated_at: (overrides?.updatedAt ?? row.updated_at) as string,
    };
  }
}
