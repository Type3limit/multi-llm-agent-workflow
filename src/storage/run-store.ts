import type { Database } from "./database.js";
import type { RunStatus } from "../core/types.js";
import { nullableString } from "./helpers.js";

interface Stmt {
  run(params: Record<string, unknown>): void;
  get(...params: unknown[]): unknown | undefined;
}

export interface RunRecord {
  id: string;
  project_id: string;
  task_id: string;
  agent_id: string;
  status: RunStatus;
  workspace_path?: string;
  base_commit?: string;
  branch_name?: string;
  run_manifest_ref?: string;
  started_at?: string;
  ended_at?: string;
}

export interface RunStore {
  create(record: RunRecord): void;
  updateStatus(runId: string, status: RunStatus, patch?: Partial<RunRecord>): void;
  get(runId: string): RunRecord | undefined;
}

const IMMUTABLE_FIELDS = new Set(["id", "project_id", "task_id", "agent_id"]);

export class SqliteRunStore implements RunStore {
  private insertStmt: Stmt;
  private getStmt: Stmt;
  private updateStmt: Stmt;

  constructor(private db: Database) {
    this.insertStmt = db.prepare(`
      insert into agent_runs (
        id, project_id, task_id, agent_id, status,
        workspace_path, base_commit, branch_name, run_manifest_ref,
        started_at, ended_at
      ) values (
        @id, @project_id, @task_id, @agent_id, @status,
        @workspace_path, @base_commit, @branch_name, @run_manifest_ref,
        @started_at, @ended_at
      )
    `) as unknown as Stmt;

    this.getStmt = db.prepare("select * from agent_runs where id = ?") as unknown as Stmt;

    this.updateStmt = db.prepare(`
      update agent_runs set
        status = @status,
        workspace_path = @workspace_path,
        base_commit = @base_commit,
        branch_name = @branch_name,
        run_manifest_ref = @run_manifest_ref,
        started_at = @started_at,
        ended_at = @ended_at
      where id = @id
    `) as unknown as Stmt;
  }

  create(record: RunRecord): void {
    this.insertStmt.run({
      id: record.id,
      project_id: record.project_id,
      task_id: record.task_id,
      agent_id: record.agent_id,
      status: record.status,
      workspace_path: record.workspace_path ?? null,
      base_commit: record.base_commit ?? null,
      branch_name: record.branch_name ?? null,
      run_manifest_ref: record.run_manifest_ref ?? null,
      started_at: record.started_at ?? null,
      ended_at: record.ended_at ?? null,
    });
  }

  updateStatus(runId: string, status: RunStatus, patch?: Partial<RunRecord>): void {
    const existing = this.get(runId);
    if (!existing) {
      throw new Error(`Run not found: ${runId}`);
    }

    if (patch) {
      for (const key of Object.keys(patch)) {
        if (IMMUTABLE_FIELDS.has(key)) {
          throw new Error(`Cannot modify immutable field "${key}" via updateStatus`);
        }
      }
    }

    this.updateStmt.run({
      id: runId,
      status,
      workspace_path: patch?.workspace_path ?? existing.workspace_path ?? null,
      base_commit: patch?.base_commit ?? existing.base_commit ?? null,
      branch_name: patch?.branch_name ?? existing.branch_name ?? null,
      run_manifest_ref: patch?.run_manifest_ref ?? existing.run_manifest_ref ?? null,
      started_at: patch?.started_at ?? existing.started_at ?? null,
      ended_at: patch?.ended_at ?? existing.ended_at ?? null,
    });
  }

  get(runId: string): RunRecord | undefined {
    const row = this.getStmt.get(runId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: row.id as string,
      project_id: row.project_id as string,
      task_id: row.task_id as string,
      agent_id: row.agent_id as string,
      status: row.status as RunStatus,
      workspace_path: nullableString(row.workspace_path),
      base_commit: nullableString(row.base_commit),
      branch_name: nullableString(row.branch_name),
      run_manifest_ref: nullableString(row.run_manifest_ref),
      started_at: nullableString(row.started_at),
      ended_at: nullableString(row.ended_at),
    };
  }
}
