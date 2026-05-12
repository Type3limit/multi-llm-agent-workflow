import { describe, it, expect, beforeEach, afterEach } from "vitest";
import SqliteDatabase from "better-sqlite3";
import type { Database } from "../../src/storage/database.js";
import { migrate } from "../../src/storage/migrations.js";
import { SqliteQueueStore } from "../../src/storage/queue-store.js";
import { SqliteRunStore } from "../../src/storage/run-store.js";
import {
  SESSION_SNAPSHOT_SCHEMA_VERSION,
  SqliteSessionSnapshotReader,
} from "../../src/session/session-snapshot.js";
import { parseWorkOrderV1, type ParsedWorkOrderV1 } from "../../src/core/schemas-v1.js";
import type { ArtifactKindV1, ReviewContextRecord, TaskQueueEntry } from "../../src/core/types.js";

const GENERATED_AT = "2026-05-12T10:00:00.000Z";

function makeWorkOrder(overrides: Partial<ParsedWorkOrderV1> = {}): ParsedWorkOrderV1 {
  return parseWorkOrderV1({
    schema_version: "workflow/v1",
    task_id: "T-snapshot",
    project_id: "project-a",
    title: "Snapshot task",
    type: "code_change",
    goal: "Create snapshot coverage.",
    acceptance_criteria: ["Snapshot is readable."],
    repo: { path: "G:/Code/example-repo", base_ref: "main" },
    agent: {
      required_capabilities: ["code_change"],
      implementer_pool: ["impl-a", "impl-b"],
      reviewer_pool: ["reviewer-a"],
      exclude_agent_ids: [],
    },
    review: { enabled: true, max_review_runs: 1 },
    budget: {
      max_wall_time_minutes: 10,
      max_total_cost_units: 5,
      max_runs: 4,
    },
    ...overrides,
  });
}

function makeEntry(
  workOrder: ParsedWorkOrderV1,
  overrides: Partial<TaskQueueEntry> = {},
): TaskQueueEntry {
  return {
    task_id: workOrder.task_id,
    project_id: workOrder.project_id,
    status: "queued",
    next_role: "implementer",
    current_owner_run_id: null,
    lease_expires_at: null,
    attempts: 0,
    enqueued_at: "2026-05-12T08:00:00.000Z",
    updated_at: "2026-05-12T08:00:00.000Z",
    ...overrides,
  };
}

function insertTask(
  queueStore: SqliteQueueStore,
  workOrder: ParsedWorkOrderV1,
  overrides: Partial<TaskQueueEntry> = {},
): void {
  queueStore.insert(makeEntry(workOrder, overrides), JSON.stringify(workOrder));
}

function insertArtifact(
  db: Database,
  args: {
    id: string;
    projectId?: string;
    taskId?: string;
    runId: string;
    kind: ArtifactKindV1;
    filename: string;
    checksum?: string;
    summary?: string;
    createdAt: string;
  },
): void {
  const projectId = args.projectId ?? "project-a";
  const taskId = args.taskId ?? "T-snapshot";
  db.prepare(`
    insert into artifacts (
      id, project_id, task_id, run_id, kind, uri, path, checksum, summary, created_at
    ) values (
      @id, @project_id, @task_id, @run_id, @kind, @uri, @path, @checksum, @summary, @created_at
    )
  `).run({
    id: args.id,
    project_id: projectId,
    task_id: taskId,
    run_id: args.runId,
    kind: args.kind,
    uri: `artifact://${taskId}/${args.runId}/${args.filename}`,
    path: `G:/Code/example-repo/.agentflow/artifacts/${taskId}/${args.runId}/${args.filename}`,
    checksum: args.checksum ?? null,
    summary: args.summary ?? null,
    created_at: args.createdAt,
  });
}

describe("SqliteSessionSnapshotReader", () => {
  let db: Database;
  let queueStore: SqliteQueueStore;
  let runStore: SqliteRunStore;
  let reader: SqliteSessionSnapshotReader;

  beforeEach(() => {
    db = new SqliteDatabase(":memory:");
    migrate(db);
    queueStore = new SqliteQueueStore(db);
    runStore = new SqliteRunStore(db);
    reader = new SqliteSessionSnapshotReader(db, {
      now: () => new Date(GENERATED_AT),
    });
  });

  afterEach(() => {
    db.close();
  });

  it("snapshots an accepted task with implementer and reviewer runs plus artifacts", () => {
    const workOrder = makeWorkOrder();
    insertTask(queueStore, workOrder, {
      status: "accepted",
      attempts: 2,
      updated_at: "2026-05-12T08:30:00.000Z",
    });

    runStore.create({
      id: "R-impl",
      project_id: "project-a",
      task_id: "T-snapshot",
      agent_id: "impl-a",
      role: "implementer",
      status: "succeeded",
      workspace_path: "G:/Code/example-repo/.agentflow/worktrees/T-snapshot/R-impl",
      base_commit: "abc123",
      branch_name: "agent/T-snapshot/R-impl",
      run_manifest_ref: "artifact://T-snapshot/R-impl/run_manifest.json",
      started_at: "2026-05-12T08:01:00.000Z",
      ended_at: "2026-05-12T08:10:00.000Z",
    });
    runStore.create({
      id: "R-review",
      project_id: "project-a",
      task_id: "T-snapshot",
      agent_id: "reviewer-a",
      role: "reviewer",
      status: "succeeded",
      parent_run_id: "R-impl",
      workspace_path: "G:/Code/example-repo/.agentflow/worktrees/T-snapshot/R-review",
      base_commit: "abc123",
      branch_name: "agent/T-snapshot/R-review",
      run_manifest_ref: "artifact://T-snapshot/R-review/run_manifest.json",
      started_at: "2026-05-12T08:11:00.000Z",
      ended_at: "2026-05-12T08:20:00.000Z",
    });
    insertArtifact(db, {
      id: "A-impl-manifest",
      runId: "R-impl",
      kind: "task_capsule",
      filename: "run_manifest.json",
      checksum: "sha256:implmanifest",
      summary: "Run manifest",
      createdAt: "2026-05-12T08:01:01.000Z",
    });
    insertArtifact(db, {
      id: "A-impl-diff",
      runId: "R-impl",
      kind: "diff",
      filename: "diff.patch",
      checksum: "sha256:impldiff",
      summary: "Git diff",
      createdAt: "2026-05-12T08:09:00.000Z",
    });
    insertArtifact(db, {
      id: "A-review-verdict",
      runId: "R-review",
      kind: "review_verdict",
      filename: "review_verdict.json",
      checksum: "sha256:verdict",
      summary: "Approved",
      createdAt: "2026-05-12T08:19:00.000Z",
    });

    const snapshot = reader.get("T-snapshot");

    expect(snapshot).toEqual({
      schema_version: SESSION_SNAPSHOT_SCHEMA_VERSION,
      project_id: "project-a",
      task_id: "T-snapshot",
      task: {
        status: "accepted",
        attempts: 2,
        work_order: {
          repo_path: "G:/Code/example-repo",
          base_ref: "main",
        },
        created_at: "2026-05-12T08:00:00.000Z",
        updated_at: "2026-05-12T08:30:00.000Z",
      },
      runs: [
        {
          run_id: "R-impl",
          role: "implementer",
          agent_id: "impl-a",
          status: "succeeded",
          workspace_path: "G:/Code/example-repo/.agentflow/worktrees/T-snapshot/R-impl",
          base_commit: "abc123",
          branch_name: "agent/T-snapshot/R-impl",
          run_manifest_ref: "artifact://T-snapshot/R-impl/run_manifest.json",
          started_at: "2026-05-12T08:01:00.000Z",
          ended_at: "2026-05-12T08:10:00.000Z",
          artifacts: [
            {
              kind: "task_capsule",
              uri: "artifact://T-snapshot/R-impl/run_manifest.json",
              path: "G:/Code/example-repo/.agentflow/artifacts/T-snapshot/R-impl/run_manifest.json",
              checksum: "sha256:implmanifest",
              summary: "Run manifest",
              created_at: "2026-05-12T08:01:01.000Z",
            },
            {
              kind: "diff",
              uri: "artifact://T-snapshot/R-impl/diff.patch",
              path: "G:/Code/example-repo/.agentflow/artifacts/T-snapshot/R-impl/diff.patch",
              checksum: "sha256:impldiff",
              summary: "Git diff",
              created_at: "2026-05-12T08:09:00.000Z",
            },
          ],
        },
        {
          run_id: "R-review",
          role: "reviewer",
          agent_id: "reviewer-a",
          status: "succeeded",
          parent_run_id: "R-impl",
          workspace_path: "G:/Code/example-repo/.agentflow/worktrees/T-snapshot/R-review",
          base_commit: "abc123",
          branch_name: "agent/T-snapshot/R-review",
          run_manifest_ref: "artifact://T-snapshot/R-review/run_manifest.json",
          started_at: "2026-05-12T08:11:00.000Z",
          ended_at: "2026-05-12T08:20:00.000Z",
          artifacts: [
            {
              kind: "review_verdict",
              uri: "artifact://T-snapshot/R-review/review_verdict.json",
              path: "G:/Code/example-repo/.agentflow/artifacts/T-snapshot/R-review/review_verdict.json",
              checksum: "sha256:verdict",
              summary: "Approved",
              created_at: "2026-05-12T08:19:00.000Z",
            },
          ],
        },
      ],
      generated_at: GENERATED_AT,
    });
  });

  it("includes review_context_json and handoff_packet_uri when present", () => {
    const workOrder = makeWorkOrder({
      task_id: "T-context",
      agent: {
        required_capabilities: ["code_change"],
        implementer_pool: ["impl-a", "impl-b"],
        reviewer_pool: ["reviewer-a"],
        exclude_agent_ids: ["impl-a"],
      },
    });
    insertTask(queueStore, workOrder, {
      task_id: "T-context",
      status: "queued",
      next_role: "implementer",
      attempts: 2,
    });
    const reviewContext: ReviewContextRecord = {
      implementer_run_id: "R-impl",
      implementer_agent_id: "impl-a",
      diff_artifact_uri: "artifact://T-context/R-impl/diff.patch",
      final_report_uri: "artifact://T-context/R-impl/final_report.md",
      verification_output_uri: "artifact://T-context/R-impl/verification.txt",
    };
    queueStore.setReviewContext("T-context", reviewContext);
    queueStore.setHandoffPacketUri("T-context", "artifact://T-context/R-impl/handoff_packet.json");
    runStore.create({
      id: "R-takeover",
      project_id: "project-a",
      task_id: "T-context",
      agent_id: "impl-b",
      role: "implementer",
      status: "running",
      parent_run_id: "R-impl",
      handoff_packet_uri: "artifact://T-context/R-impl/handoff_packet.json",
    });

    const snapshot = reader.get("T-context");

    expect(snapshot?.task.review_context).toEqual(reviewContext);
    expect(snapshot?.task.handoff_packet_uri).toBe("artifact://T-context/R-impl/handoff_packet.json");
    expect(snapshot?.runs[0]).toMatchObject({
      run_id: "R-takeover",
      parent_run_id: "R-impl",
      handoff_packet_uri: "artifact://T-context/R-impl/handoff_packet.json",
    });
  });

  it("returns undefined for a missing task_id", () => {
    expect(reader.get("does-not-exist")).toBeUndefined();
  });

  it("snapshots awaiting_human and failed terminal task states", () => {
    const awaiting = makeWorkOrder({ task_id: "T-awaiting" });
    const failed = makeWorkOrder({ task_id: "T-failed" });
    insertTask(queueStore, awaiting, {
      task_id: "T-awaiting",
      status: "awaiting_human",
      attempts: 2,
    });
    insertTask(queueStore, failed, {
      task_id: "T-failed",
      status: "failed",
      attempts: 3,
    });

    expect(reader.get("T-awaiting")?.task).toMatchObject({
      status: "awaiting_human",
      attempts: 2,
    });
    expect(reader.get("T-failed")?.task).toMatchObject({
      status: "failed",
      attempts: 3,
    });
  });
});
