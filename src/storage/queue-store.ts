import type { Database } from "./database.js";
import type { ReviewContextRecord, TaskQueueEntry } from "../core/types.js";
import { parseWorkOrderV1, type ParsedWorkOrderV1 } from "../core/schemas-v1.js";

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
  getWorkOrder(taskId: string): ParsedWorkOrderV1 | undefined;
  addWorkOrderExcludeAgentIds(taskId: string, agentIds: string[]): ParsedWorkOrderV1;
  setReviewContext(taskId: string, context: ReviewContextRecord): void;
  getReviewContext(taskId: string): ReviewContextRecord | undefined;
  setHandoffPacketUri(taskId: string, uri: string | undefined): void;
  getHandoffPacketUri(taskId: string): string | undefined;
  listAll(): TaskQueueEntry[];
}

const TERMINAL_STATUSES: TaskQueueEntry["status"][] = ["accepted", "failed", "awaiting_human"];

export class SqliteQueueStore implements QueueStore {
  private insertStmt: Stmt;
  private claimSelectStmt: Stmt;
  private claimUpdateStmt: Stmt;
  private releaseStmt: Stmt;
  private getStmt: Stmt;
  private getWorkOrderJsonStmt: Stmt;
  private updateWorkOrderJsonStmt: Stmt;
  private getReviewContextJsonStmt: Stmt;
  private updateReviewContextJsonStmt: Stmt;
  private getHandoffPacketUriStmt: Stmt;
  private updateHandoffPacketUriStmt: Stmt;
  private listStmt: Stmt;

  constructor(private db: Database) {
    this.insertStmt = db.prepare(`
      insert into task_queue (
        task_id, project_id, status, next_role,
        current_owner_run_id, lease_expires_at,
        attempts, enqueued_at, updated_at, workorder_json,
        review_context_json, handoff_packet_uri
      ) values (
        @task_id, @project_id, @status, @next_role,
        @current_owner_run_id, @lease_expires_at,
        @attempts, @enqueued_at, @updated_at, @workorder_json,
        @review_context_json, @handoff_packet_uri
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

    this.getWorkOrderJsonStmt = db.prepare(
      "select workorder_json from task_queue where task_id = ?",
    ) as unknown as Stmt;

    this.updateWorkOrderJsonStmt = db.prepare(`
      update task_queue set workorder_json = @workorder_json, updated_at = @updated_at
      where task_id = @task_id
    `) as unknown as Stmt;

    this.getReviewContextJsonStmt = db.prepare(
      "select review_context_json from task_queue where task_id = ?",
    ) as unknown as Stmt;

    this.updateReviewContextJsonStmt = db.prepare(`
      update task_queue set review_context_json = @review_context_json, updated_at = @updated_at
      where task_id = @task_id
    `) as unknown as Stmt;

    this.getHandoffPacketUriStmt = db.prepare(
      "select handoff_packet_uri from task_queue where task_id = ?",
    ) as unknown as Stmt;

    this.updateHandoffPacketUriStmt = db.prepare(`
      update task_queue set handoff_packet_uri = @handoff_packet_uri, updated_at = @updated_at
      where task_id = @task_id
    `) as unknown as Stmt;

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
      review_context_json: null,
      handoff_packet_uri: null,
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

  getWorkOrder(taskId: string): ParsedWorkOrderV1 | undefined {
    const row = this.getWorkOrderJsonStmt.get(taskId) as Record<string, unknown> | undefined;
    if (!row) return undefined;

    return parseWorkOrderV1(JSON.parse(row.workorder_json as string));
  }

  addWorkOrderExcludeAgentIds(taskId: string, agentIds: string[]): ParsedWorkOrderV1 {
    const row = this.getWorkOrderJsonStmt.get(taskId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`TaskQueue entry not found: ${taskId}`);
    }

    const raw = JSON.parse(row.workorder_json as string) as unknown;
    const parsed = parseWorkOrderV1(raw);
    const excludeAgentIds = dedupeFirstSeen([
      ...parsed.agent.exclude_agent_ids,
      ...agentIds,
    ]);

    const rawRecord = isObjectRecord(raw) ? raw : {};
    const rawAgent = isObjectRecord(rawRecord.agent) ? rawRecord.agent : {};
    const updatedRaw = {
      ...rawRecord,
      agent: {
        ...rawAgent,
        exclude_agent_ids: excludeAgentIds,
      },
    };
    const updated = parseWorkOrderV1(updatedRaw);

    this.updateWorkOrderJsonStmt.run({
      task_id: taskId,
      workorder_json: JSON.stringify(updatedRaw),
      updated_at: new Date().toISOString(),
    });

    return updated;
  }

  setReviewContext(taskId: string, context: ReviewContextRecord): void {
    if (!this.get(taskId)) {
      throw new Error(`TaskQueue entry not found: ${taskId}`);
    }

    const parsed = parseReviewContextRecord(context);
    this.updateReviewContextJsonStmt.run({
      task_id: taskId,
      review_context_json: JSON.stringify(parsed),
      updated_at: new Date().toISOString(),
    });
  }

  getReviewContext(taskId: string): ReviewContextRecord | undefined {
    const row = this.getReviewContextJsonStmt.get(taskId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const rawJson = row.review_context_json;
    if (typeof rawJson !== "string" || rawJson.trim() === "") {
      return undefined;
    }

    return parseReviewContextRecord(JSON.parse(rawJson));
  }

  setHandoffPacketUri(taskId: string, uri: string | undefined): void {
    if (!this.get(taskId)) {
      throw new Error(`TaskQueue entry not found: ${taskId}`);
    }
    if (uri !== undefined && uri.trim() === "") {
      throw new Error("handoff_packet_uri must be a non-empty string when provided");
    }

    this.updateHandoffPacketUriStmt.run({
      task_id: taskId,
      handoff_packet_uri: uri ?? null,
      updated_at: new Date().toISOString(),
    });
  }

  getHandoffPacketUri(taskId: string): string | undefined {
    const row = this.getHandoffPacketUriStmt.get(taskId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const uri = row.handoff_packet_uri;
    if (typeof uri !== "string" || uri.trim() === "") {
      return undefined;
    }
    return uri;
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dedupeFirstSeen(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function parseReviewContextRecord(input: unknown): ReviewContextRecord {
  if (!isObjectRecord(input)) {
    throw new Error("Review context must be an object");
  }

  const implementerRunId = requireNonEmptyString(input, "implementer_run_id");
  const implementerAgentId = requireNonEmptyString(input, "implementer_agent_id");
  const diffArtifactUri = requireNonEmptyString(input, "diff_artifact_uri");
  const finalReportUri = optionalNonEmptyString(input, "final_report_uri");
  const verificationOutputUri = optionalNonEmptyString(input, "verification_output_uri");

  return {
    implementer_run_id: implementerRunId,
    implementer_agent_id: implementerAgentId,
    diff_artifact_uri: diffArtifactUri,
    ...(finalReportUri !== undefined ? { final_report_uri: finalReportUri } : {}),
    ...(verificationOutputUri !== undefined ? { verification_output_uri: verificationOutputUri } : {}),
  };
}

function requireNonEmptyString(input: Record<string, unknown>, key: keyof ReviewContextRecord): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Review context ${key} must be a non-empty string`);
  }
  return value;
}

function optionalNonEmptyString(input: Record<string, unknown>, key: keyof ReviewContextRecord): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Review context ${key} must be a non-empty string when provided`);
  }
  return value;
}
