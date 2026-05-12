import type { ArtifactStore } from "../storage/artifact-store.js";
import type { SandboxDiffApplyResult, SandboxProvider } from "../workspace/sandbox-provider.js";
import type {
  SessionSnapshotArtifactReadModel,
  SessionSnapshotReadModel,
  SessionSnapshotRunReadModel,
} from "./session-snapshot.js";

export type SessionSnapshotDiffSelection =
  | { run_id: string; diff_artifact_uri?: never }
  | { diff_artifact_uri: string; run_id?: never };

export interface SessionSnapshotReconstructionTarget {
  task_id: string;
  run_id: string;
}

export interface ReconstructWorktreeFromSessionSnapshotArgs {
  snapshot: SessionSnapshotReadModel;
  selection: SessionSnapshotDiffSelection;
  target: SessionSnapshotReconstructionTarget;
  artifactStore: Pick<ArtifactStore, "readText">;
  sandboxProvider: SandboxProvider;
}

export type SessionSnapshotForkErrorCode =
  | "selection_missing"
  | "selected_run_not_found"
  | "diff_artifact_missing"
  | "multiple_diff_artifacts"
  | "diff_artifact_uri_not_in_snapshot"
  | "diff_artifact_uri_not_diff"
  | "snapshot_base_missing";

export class SessionSnapshotForkError extends Error {
  constructor(
    readonly code: SessionSnapshotForkErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SessionSnapshotForkError";
  }
}

export interface SessionSnapshotWorktreeReconstructionBase {
  project_id: string;
  source_task_id: string;
  source_run_id: string;
  target_task_id: string;
  target_run_id: string;
  repo_path: string;
  workspace_path: string;
  branch_name: string;
  snapshot_base_ref?: string;
  source_base_commit?: string;
  reconstruction_base_ref: string;
  prepared_base_commit: string;
  applied_diff_artifact_uri: string;
  applied_diff_artifact_path: string;
  apply_result: SandboxDiffApplyResult;
}

export type SessionSnapshotWorktreeReconstructionResult =
  | (SessionSnapshotWorktreeReconstructionBase & {
      status: "reconstructed";
      apply_result: Extract<SandboxDiffApplyResult, { ok: true }>;
    })
  | (SessionSnapshotWorktreeReconstructionBase & {
      status: "diff_apply_failed";
      apply_result: Extract<SandboxDiffApplyResult, { ok: false }>;
    });

export function reconstructWorktreeFromSessionSnapshot(
  args: ReconstructWorktreeFromSessionSnapshotArgs,
): SessionSnapshotWorktreeReconstructionResult {
  const selected = selectSnapshotDiffArtifact(args.snapshot, args.selection);
  const reconstructionBaseRef =
    nonEmptyString(selected.run.base_commit) ??
    nonEmptyString(args.snapshot.task.work_order.base_ref);

  if (reconstructionBaseRef === undefined) {
    throw new SessionSnapshotForkError(
      "snapshot_base_missing",
      "Cannot reconstruct a worktree without a selected run base_commit or snapshot base_ref",
      {
        task_id: args.snapshot.task_id,
        run_id: selected.run.run_id,
        diff_artifact_uri: selected.artifact.uri,
      },
    );
  }

  const diffText = args.artifactStore.readText(selected.artifact.uri);
  const prepared = args.sandboxProvider.prepareWorkspace({
    repoPath: args.snapshot.task.work_order.repo_path,
    baseRef: reconstructionBaseRef,
    taskId: args.target.task_id,
    runId: args.target.run_id,
  });
  const applyResult = args.sandboxProvider.applyDiff({
    workspacePath: prepared.workspacePath,
    diffText,
  });

  return {
    status: applyResult.ok ? "reconstructed" : "diff_apply_failed",
    project_id: args.snapshot.project_id,
    source_task_id: args.snapshot.task_id,
    source_run_id: selected.run.run_id,
    target_task_id: args.target.task_id,
    target_run_id: args.target.run_id,
    repo_path: prepared.repoPath,
    workspace_path: prepared.workspacePath,
    branch_name: prepared.branchName,
    ...(args.snapshot.task.work_order.base_ref !== undefined
      ? { snapshot_base_ref: args.snapshot.task.work_order.base_ref }
      : {}),
    ...(selected.run.base_commit !== undefined
      ? { source_base_commit: selected.run.base_commit }
      : {}),
    reconstruction_base_ref: reconstructionBaseRef,
    prepared_base_commit: prepared.baseCommit,
    applied_diff_artifact_uri: selected.artifact.uri,
    applied_diff_artifact_path: selected.artifact.path,
    apply_result: applyResult,
  } as SessionSnapshotWorktreeReconstructionResult;
}

function selectSnapshotDiffArtifact(
  snapshot: SessionSnapshotReadModel,
  selection: SessionSnapshotDiffSelection,
): { run: SessionSnapshotRunReadModel; artifact: SessionSnapshotArtifactReadModel } {
  const runId = "run_id" in selection ? nonEmptyString(selection.run_id) : undefined;
  const diffArtifactUri =
    "diff_artifact_uri" in selection
      ? nonEmptyString(selection.diff_artifact_uri)
      : undefined;

  if (runId !== undefined && diffArtifactUri !== undefined) {
    throw new SessionSnapshotForkError(
      "selection_missing",
      "Select exactly one of run_id or diff_artifact_uri",
      { task_id: snapshot.task_id, run_id: runId, diff_artifact_uri: diffArtifactUri },
    );
  }

  if (diffArtifactUri !== undefined) {
    return selectExplicitDiffArtifact(snapshot, diffArtifactUri);
  }

  if (runId !== undefined) {
    return selectSingleRunDiffArtifact(snapshot, runId);
  }

  throw new SessionSnapshotForkError(
    "selection_missing",
    "Select either a run_id or an explicit diff_artifact_uri",
    { task_id: snapshot.task_id },
  );
}

function nonEmptyString(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  return value;
}

function selectSingleRunDiffArtifact(
  snapshot: SessionSnapshotReadModel,
  runId: string,
): { run: SessionSnapshotRunReadModel; artifact: SessionSnapshotArtifactReadModel } {
  const run = snapshot.runs.find((candidate) => candidate.run_id === runId);
  if (run === undefined) {
    throw new SessionSnapshotForkError(
      "selected_run_not_found",
      `Selected run_id is not present in snapshot: ${runId}`,
      { task_id: snapshot.task_id, run_id: runId },
    );
  }

  const diffArtifacts = run.artifacts.filter((artifact) => artifact.kind === "diff");
  if (diffArtifacts.length === 0) {
    throw new SessionSnapshotForkError(
      "diff_artifact_missing",
      `Selected run has no diff artifact: ${runId}`,
      { task_id: snapshot.task_id, run_id: runId },
    );
  }

  if (diffArtifacts.length > 1) {
    throw new SessionSnapshotForkError(
      "multiple_diff_artifacts",
      "Selected run has multiple diff artifacts; pass diff_artifact_uri explicitly",
      {
        task_id: snapshot.task_id,
        run_id: runId,
        diff_artifact_uris: diffArtifacts.map((artifact) => artifact.uri),
      },
    );
  }

  return { run, artifact: diffArtifacts[0] };
}

function selectExplicitDiffArtifact(
  snapshot: SessionSnapshotReadModel,
  diffArtifactUri: string,
): { run: SessionSnapshotRunReadModel; artifact: SessionSnapshotArtifactReadModel } {
  for (const run of snapshot.runs) {
    const artifact = run.artifacts.find((candidate) => candidate.uri === diffArtifactUri);
    if (artifact === undefined) {
      continue;
    }
    if (artifact.kind !== "diff") {
      throw new SessionSnapshotForkError(
        "diff_artifact_uri_not_diff",
        `Selected artifact URI is not a diff artifact: ${diffArtifactUri}`,
        {
          task_id: snapshot.task_id,
          run_id: run.run_id,
          diff_artifact_uri: diffArtifactUri,
          artifact_kind: artifact.kind,
        },
      );
    }

    return { run, artifact };
  }

  throw new SessionSnapshotForkError(
    "diff_artifact_uri_not_in_snapshot",
    `Selected diff artifact URI is not present in snapshot: ${diffArtifactUri}`,
    { task_id: snapshot.task_id, diff_artifact_uri: diffArtifactUri },
  );
}
