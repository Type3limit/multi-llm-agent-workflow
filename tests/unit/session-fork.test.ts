import { describe, expect, it } from "vitest";
import {
  reconstructWorktreeFromSessionSnapshot,
  SessionSnapshotForkError,
} from "../../src/session/session-fork.js";
import type { SessionSnapshotReadModel } from "../../src/session/session-snapshot.js";
import { SESSION_SNAPSHOT_SCHEMA_VERSION } from "../../src/session/session-snapshot.js";
import type { SandboxDiffApplyResult, SandboxProvider } from "../../src/workspace/sandbox-provider.js";

class FakeArtifactStore {
  readonly readUris: string[] = [];

  readText(uri: string): string {
    this.readUris.push(uri);
    return "diff --git a/README.md b/README.md\n";
  }
}

class FakeSandboxProvider implements SandboxProvider {
  preparedArgs:
    | {
        repoPath: string;
        baseRef?: string;
        taskId: string;
        runId: string;
      }
    | undefined;
  applyArgs: { workspacePath: string; diffText: string } | undefined;

  constructor(private readonly applyResult: SandboxDiffApplyResult = { ok: true, stdout: "", stderr: "" }) {}

  prepareWorkspace(args: {
    repoPath: string;
    baseRef?: string;
    taskId: string;
    runId: string;
  }) {
    this.preparedArgs = args;
    return {
      repoPath: args.repoPath,
      workspacePath: `${args.repoPath}/.agentflow/worktrees/${args.taskId}/${args.runId}`,
      baseCommit: `resolved:${args.baseRef ?? "HEAD"}`,
      branchName: `agent/${args.taskId}/${args.runId}`,
    };
  }

  status(): string {
    return "";
  }

  diff(): string {
    return "";
  }

  applyDiff(args: { workspacePath: string; diffText: string }): SandboxDiffApplyResult {
    this.applyArgs = args;
    return this.applyResult;
  }

  cleanup(): void {
    // no-op fake
  }
}

function makeSnapshot(overrides: Partial<SessionSnapshotReadModel> = {}): SessionSnapshotReadModel {
  return {
    schema_version: SESSION_SNAPSHOT_SCHEMA_VERSION,
    project_id: "project-a",
    task_id: "T-source",
    task: {
      status: "accepted",
      attempts: 1,
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
        base_commit: "abc123",
        branch_name: "agent/T-source/R-impl",
        artifacts: [
          {
            kind: "diff",
            uri: "artifact://T-source/R-impl/diff.patch",
            path: "G:/Code/example-repo/.agentflow/artifacts/T-source/R-impl/diff.patch",
            created_at: "2026-05-12T08:10:00.000Z",
          },
        ],
      },
    ],
    generated_at: "2026-05-12T10:00:00.000Z",
    ...overrides,
  };
}

function expectForkError(fn: () => unknown, code: SessionSnapshotForkError["code"]): void {
  try {
    fn();
    throw new Error("Expected SessionSnapshotForkError");
  } catch (err) {
    expect(err).toBeInstanceOf(SessionSnapshotForkError);
    expect((err as SessionSnapshotForkError).code).toBe(code);
  }
}

describe("reconstructWorktreeFromSessionSnapshot", () => {
  it("reconstructs a worktree from a snapshot run with one implementer diff artifact", () => {
    const artifactStore = new FakeArtifactStore();
    const sandboxProvider = new FakeSandboxProvider();

    const result = reconstructWorktreeFromSessionSnapshot({
      snapshot: makeSnapshot(),
      selection: { run_id: "R-impl" },
      target: { task_id: "T-fork", run_id: "R-fork" },
      artifactStore,
      sandboxProvider,
    });

    expect(result).toMatchObject({
      status: "reconstructed",
      project_id: "project-a",
      source_task_id: "T-source",
      source_run_id: "R-impl",
      target_task_id: "T-fork",
      target_run_id: "R-fork",
      repo_path: "G:/Code/example-repo",
      workspace_path: "G:/Code/example-repo/.agentflow/worktrees/T-fork/R-fork",
      branch_name: "agent/T-fork/R-fork",
      snapshot_base_ref: "main",
      source_base_commit: "abc123",
      reconstruction_base_ref: "abc123",
      prepared_base_commit: "resolved:abc123",
      applied_diff_artifact_uri: "artifact://T-source/R-impl/diff.patch",
      apply_result: { ok: true },
    });
    expect(artifactStore.readUris).toEqual(["artifact://T-source/R-impl/diff.patch"]);
    expect(sandboxProvider.preparedArgs).toEqual({
      repoPath: "G:/Code/example-repo",
      baseRef: "abc123",
      taskId: "T-fork",
      runId: "R-fork",
    });
    expect(sandboxProvider.applyArgs).toEqual({
      workspacePath: "G:/Code/example-repo/.agentflow/worktrees/T-fork/R-fork",
      diffText: "diff --git a/README.md b/README.md\n",
    });
  });

  it("uses an explicit diff artifact URI selection", () => {
    const snapshot = makeSnapshot({
      runs: [
        {
          run_id: "R-impl",
          role: "implementer",
          agent_id: "impl-a",
          status: "succeeded",
          base_commit: "abc123",
          artifacts: [
            {
              kind: "diff",
              uri: "artifact://T-source/R-impl/first.patch",
              path: "G:/Code/example-repo/.agentflow/artifacts/T-source/R-impl/first.patch",
              created_at: "2026-05-12T08:10:00.000Z",
            },
            {
              kind: "diff",
              uri: "artifact://T-source/R-impl/second.patch",
              path: "G:/Code/example-repo/.agentflow/artifacts/T-source/R-impl/second.patch",
              created_at: "2026-05-12T08:11:00.000Z",
            },
          ],
        },
      ],
    });
    const artifactStore = new FakeArtifactStore();
    const sandboxProvider = new FakeSandboxProvider();

    const result = reconstructWorktreeFromSessionSnapshot({
      snapshot,
      selection: { diff_artifact_uri: "artifact://T-source/R-impl/second.patch" },
      target: { task_id: "T-fork", run_id: "R-fork" },
      artifactStore,
      sandboxProvider,
    });

    expect(result.status).toBe("reconstructed");
    expect(result.applied_diff_artifact_uri).toBe("artifact://T-source/R-impl/second.patch");
    expect(result.applied_diff_artifact_path).toBe(
      "G:/Code/example-repo/.agentflow/artifacts/T-source/R-impl/second.patch",
    );
    expect(artifactStore.readUris).toEqual(["artifact://T-source/R-impl/second.patch"]);
  });

  it("throws a typed error when the selected run has no diff artifact", () => {
    const sandboxProvider = new FakeSandboxProvider();

    expectForkError(
      () =>
        reconstructWorktreeFromSessionSnapshot({
          snapshot: makeSnapshot({
            runs: [
              {
                run_id: "R-impl",
                role: "implementer",
                agent_id: "impl-a",
                status: "succeeded",
                base_commit: "abc123",
                artifacts: [],
              },
            ],
          }),
          selection: { run_id: "R-impl" },
          target: { task_id: "T-fork", run_id: "R-fork" },
          artifactStore: new FakeArtifactStore(),
          sandboxProvider,
        }),
      "diff_artifact_missing",
    );
    expect(sandboxProvider.preparedArgs).toBeUndefined();
  });

  it("throws a typed error when a selected run has multiple diff artifacts", () => {
    expectForkError(
      () =>
        reconstructWorktreeFromSessionSnapshot({
          snapshot: makeSnapshot({
            runs: [
              {
                run_id: "R-impl",
                role: "implementer",
                agent_id: "impl-a",
                status: "succeeded",
                base_commit: "abc123",
                artifacts: [
                  {
                    kind: "diff",
                    uri: "artifact://T-source/R-impl/first.patch",
                    path: "G:/Code/example-repo/.agentflow/artifacts/T-source/R-impl/first.patch",
                    created_at: "2026-05-12T08:10:00.000Z",
                  },
                  {
                    kind: "diff",
                    uri: "artifact://T-source/R-impl/second.patch",
                    path: "G:/Code/example-repo/.agentflow/artifacts/T-source/R-impl/second.patch",
                    created_at: "2026-05-12T08:11:00.000Z",
                  },
                ],
              },
            ],
          }),
          selection: { run_id: "R-impl" },
          target: { task_id: "T-fork", run_id: "R-fork" },
          artifactStore: new FakeArtifactStore(),
          sandboxProvider: new FakeSandboxProvider(),
        }),
      "multiple_diff_artifacts",
    );
  });

  it("rejects an explicit diff artifact URI that is not present in the snapshot", () => {
    const sandboxProvider = new FakeSandboxProvider();

    expectForkError(
      () =>
        reconstructWorktreeFromSessionSnapshot({
          snapshot: makeSnapshot(),
          selection: { diff_artifact_uri: "artifact://T-source/R-missing/diff.patch" },
          target: { task_id: "T-fork", run_id: "R-fork" },
          artifactStore: new FakeArtifactStore(),
          sandboxProvider,
        }),
      "diff_artifact_uri_not_in_snapshot",
    );
    expect(sandboxProvider.preparedArgs).toBeUndefined();
  });
});
