import { spawnSync } from "node:child_process";
import {
  CliGitWorktreeManager,
  type GitWorktreeManager,
  type PreparedWorktree,
} from "./git-worktree-manager.js";

export type PreparedSandboxWorkspace = PreparedWorktree;

export type SandboxDiffApplyResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; stdout: string; stderr: string };

export interface SandboxProvider {
  prepareWorkspace(args: {
    repoPath: string;
    baseRef?: string;
    taskId: string;
    runId: string;
  }): PreparedSandboxWorkspace;

  status(args: { workspacePath: string }): string;
  diff(args: { workspacePath: string }): string;
  applyDiff(args: {
    workspacePath: string;
    diffText: string;
  }): SandboxDiffApplyResult;
  cleanup(args: { workspacePath: string }): void;
}

export class GitWorktreeSandboxProvider implements SandboxProvider {
  constructor(
    private readonly gitManager: GitWorktreeManager = new CliGitWorktreeManager(),
  ) {}

  prepareWorkspace(args: {
    repoPath: string;
    baseRef?: string;
    taskId: string;
    runId: string;
  }): PreparedSandboxWorkspace {
    return this.gitManager.prepare(args);
  }

  status(args: { workspacePath: string }): string {
    return this.gitManager.statusPorcelain(args.workspacePath);
  }

  diff(args: { workspacePath: string }): string {
    return this.gitManager.diff(args.workspacePath);
  }

  applyDiff(args: {
    workspacePath: string;
    diffText: string;
  }): SandboxDiffApplyResult {
    const result = spawnSync(
      "git",
      ["apply", "--3way", "--whitespace=nowarn", "-"],
      {
        cwd: args.workspacePath,
        input: args.diffText,
        encoding: "utf-8",
      },
    );

    return {
      ok: result.status === 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  cleanup(args: { workspacePath: string }): void {
    this.gitManager.cleanup(args.workspacePath);
  }
}
