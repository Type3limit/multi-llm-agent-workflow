import { z } from "zod";
import type { Database } from "../storage/database.js";
import { parseWorkOrderV1 } from "../core/schemas-v1.js";
import type { ArtifactKindV1, ReviewContextRecord, RunStatus, TaskQueueEntry } from "../core/types.js";

export const SESSION_SNAPSHOT_SCHEMA_VERSION = "agentflow/session-snapshot/1" as const;

export interface SessionSnapshotArtifactReadModel {
  kind: ArtifactKindV1;
  uri: string;
  path: string;
  checksum?: string;
  summary?: string;
  created_at: string;
}

export interface SessionSnapshotRunReadModel {
  run_id: string;
  role?: "implementer" | "reviewer";
  agent_id: string;
  status: RunStatus;
  parent_run_id?: string;
  handoff_packet_uri?: string;
  workspace_path?: string;
  base_commit?: string;
  branch_name?: string;
  run_manifest_ref?: string;
  started_at?: string;
  ended_at?: string;
  artifacts: SessionSnapshotArtifactReadModel[];
}

export interface SessionSnapshotTaskReadModel {
  status: TaskQueueEntry["status"];
  attempts: number;
  work_order: {
    repo_path: string;
    base_ref?: string;
  };
  review_context?: ReviewContextRecord;
  handoff_packet_uri?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Read-only aggregation over persisted v1 task state.
 *
 * This is deliberately a read model, not SessionStore: it does not own
 * lifecycle, memory, process handles, model conversation state, or worktree
 * reconstruction.
 */
export interface SessionSnapshotReadModel {
  schema_version: typeof SESSION_SNAPSHOT_SCHEMA_VERSION;
  project_id: string;
  task_id: string;
  task: SessionSnapshotTaskReadModel;
  runs: SessionSnapshotRunReadModel[];
  generated_at: string;
}

export type SessionSnapshot = SessionSnapshotReadModel;

export interface SessionSnapshotReadModelReader {
  get(taskId: string): SessionSnapshotReadModel | undefined;
}

const ReviewContextRecordSchema = z.object({
  implementer_run_id: z.string().min(1),
  implementer_agent_id: z.string().min(1),
  diff_artifact_uri: z.string().min(1),
  final_report_uri: z.string().min(1).optional(),
  verification_output_uri: z.string().min(1).optional(),
});

interface Stmt {
  get(...params: unknown[]): unknown | undefined;
  all(...params: unknown[]): unknown[];
}

interface TaskQueueSnapshotRow {
  task_id: string;
  project_id: string;
  status: TaskQueueEntry["status"];
  attempts: number;
  enqueued_at: string;
  updated_at: string;
  workorder_json: string;
  review_context_json: string | null;
  handoff_packet_uri: string | null;
}

interface RunSnapshotRow {
  id: string;
  agent_id: string;
  status: RunStatus;
  workspace_path: string | null;
  base_commit: string | null;
  branch_name: string | null;
  run_manifest_ref: string | null;
  started_at: string | null;
  ended_at: string | null;
  role: "implementer" | "reviewer" | null;
  parent_run_id: string | null;
  handoff_packet_uri: string | null;
}

interface ArtifactSnapshotRow {
  run_id: string;
  kind: ArtifactKindV1;
  uri: string;
  path: string;
  checksum: string | null;
  summary: string | null;
  created_at: string;
}

export class SqliteSessionSnapshotReader implements SessionSnapshotReadModelReader {
  private readonly getTaskStmt: Stmt;
  private readonly listRunsStmt: Stmt;

  constructor(
    private readonly db: Database,
    private readonly options: { now?: () => Date } = {},
  ) {
    this.getTaskStmt = db.prepare(`
      select
        task_id,
        project_id,
        status,
        attempts,
        enqueued_at,
        updated_at,
        workorder_json,
        review_context_json,
        handoff_packet_uri
      from task_queue
      where task_id = ?
    `) as unknown as Stmt;

    this.listRunsStmt = db.prepare(`
      select
        id,
        agent_id,
        status,
        workspace_path,
        base_commit,
        branch_name,
        run_manifest_ref,
        started_at,
        ended_at,
        role,
        parent_run_id,
        handoff_packet_uri
      from agent_runs
      where project_id = ? and task_id = ?
      order by rowid asc
    `) as unknown as Stmt;
  }

  get(taskId: string): SessionSnapshotReadModel | undefined {
    const taskRow = this.getTaskStmt.get(taskId) as TaskQueueSnapshotRow | undefined;
    if (!taskRow) {
      return undefined;
    }

    const workOrder = parseWorkOrderV1(JSON.parse(taskRow.workorder_json));
    const runRows = this.listRunsStmt.all(taskRow.project_id, taskRow.task_id) as RunSnapshotRow[];
    const artifactsByRunId = this.artifactsByRunId({
      projectId: taskRow.project_id,
      taskId: taskRow.task_id,
      runIds: runRows.map((row) => row.id),
    });
    const reviewContext = parseOptionalReviewContext(taskRow.review_context_json);
    const taskHandoffPacketUri = nonEmptyString(taskRow.handoff_packet_uri);

    const task: SessionSnapshotTaskReadModel = {
      status: taskRow.status,
      attempts: taskRow.attempts,
      work_order: {
        repo_path: workOrder.repo.path,
        ...(workOrder.repo.base_ref !== undefined ? { base_ref: workOrder.repo.base_ref } : {}),
      },
      ...(reviewContext !== undefined ? { review_context: reviewContext } : {}),
      ...(taskHandoffPacketUri !== undefined ? { handoff_packet_uri: taskHandoffPacketUri } : {}),
      created_at: taskRow.enqueued_at,
      updated_at: taskRow.updated_at,
    };

    return {
      schema_version: SESSION_SNAPSHOT_SCHEMA_VERSION,
      project_id: taskRow.project_id,
      task_id: taskRow.task_id,
      task,
      runs: runRows.map((row) => toRunReadModel(row, artifactsByRunId.get(row.id) ?? [])),
      generated_at: this.now().toISOString(),
    };
  }

  private artifactsByRunId(args: {
    projectId: string;
    taskId: string;
    runIds: string[];
  }): Map<string, SessionSnapshotArtifactReadModel[]> {
    if (args.runIds.length === 0) {
      return new Map();
    }

    const placeholders = args.runIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`
        select
          run_id,
          kind,
          uri,
          path,
          checksum,
          summary,
          created_at
        from artifacts
        where project_id = ? and task_id = ? and run_id in (${placeholders})
        order by rowid asc
      `)
      .all(args.projectId, args.taskId, ...args.runIds) as ArtifactSnapshotRow[];

    const byRunId = new Map<string, SessionSnapshotArtifactReadModel[]>();
    for (const row of rows) {
      const artifacts = byRunId.get(row.run_id) ?? [];
      artifacts.push({
        kind: row.kind,
        uri: row.uri,
        path: row.path,
        ...(nonEmptyString(row.checksum) !== undefined ? { checksum: nonEmptyString(row.checksum) } : {}),
        ...(nonEmptyString(row.summary) !== undefined ? { summary: nonEmptyString(row.summary) } : {}),
        created_at: row.created_at,
      });
      byRunId.set(row.run_id, artifacts);
    }

    return byRunId;
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }
}

function parseOptionalReviewContext(rawJson: string | null): ReviewContextRecord | undefined {
  const raw = nonEmptyString(rawJson);
  if (raw === undefined) {
    return undefined;
  }
  return ReviewContextRecordSchema.parse(JSON.parse(raw)) as ReviewContextRecord;
}

function toRunReadModel(
  row: RunSnapshotRow,
  artifacts: SessionSnapshotArtifactReadModel[],
): SessionSnapshotRunReadModel {
  const parentRunId = nonEmptyString(row.parent_run_id);
  const handoffPacketUri = nonEmptyString(row.handoff_packet_uri);
  const workspacePath = nonEmptyString(row.workspace_path);
  const baseCommit = nonEmptyString(row.base_commit);
  const branchName = nonEmptyString(row.branch_name);
  const runManifestRef = nonEmptyString(row.run_manifest_ref);
  const startedAt = nonEmptyString(row.started_at);
  const endedAt = nonEmptyString(row.ended_at);

  return {
    run_id: row.id,
    ...(row.role !== null ? { role: row.role } : {}),
    agent_id: row.agent_id,
    status: row.status,
    ...(parentRunId !== undefined ? { parent_run_id: parentRunId } : {}),
    ...(handoffPacketUri !== undefined ? { handoff_packet_uri: handoffPacketUri } : {}),
    ...(workspacePath !== undefined ? { workspace_path: workspacePath } : {}),
    ...(baseCommit !== undefined ? { base_commit: baseCommit } : {}),
    ...(branchName !== undefined ? { branch_name: branchName } : {}),
    ...(runManifestRef !== undefined ? { run_manifest_ref: runManifestRef } : {}),
    ...(startedAt !== undefined ? { started_at: startedAt } : {}),
    ...(endedAt !== undefined ? { ended_at: endedAt } : {}),
    artifacts,
  };
}

function nonEmptyString(value: string | null): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  return value;
}
