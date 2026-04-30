import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface PreparedWorktree {
  repoPath: string;
  workspacePath: string;
  baseCommit: string;
  branchName: string;
}

export interface GitWorktreeManager {
  prepare(args: {
    repoPath: string;
    baseRef?: string;
    taskId: string;
    runId: string;
  }): PreparedWorktree;

  statusPorcelain(workspacePath: string): string;
  diff(workspacePath: string): string;
  cleanup(workspacePath: string): void;
}

function validatePathSegment(name: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`Invalid ${name}: empty string`);
  }
  if (value.trim().length === 0) {
    throw new Error(`Invalid ${name}: whitespace only`);
  }
  if (value.includes("..")) {
    throw new Error(`Invalid ${name} (path traversal): "${value}"`);
  }
  if (path.isAbsolute(value)) {
    throw new Error(`Invalid ${name} (absolute path): "${value}"`);
  }
  if (value !== path.basename(value)) {
    throw new Error(`Invalid ${name} (contains path separator): "${value}"`);
  }
}

function git(args: string[], cwd?: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }).trim();
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const stdout = (err as { stdout?: string }).stdout ?? "";
    const message = (err as { message?: string }).message ?? String(err);
    throw new Error(
      `git ${args.join(" ")} failed: ${message}\nstdout: ${stdout}\nstderr: ${stderr}`,
    );
  }
}

function isGitRepo(repoPath: string): boolean {
  try {
    git(["rev-parse", "--git-dir"], repoPath);
    return true;
  } catch {
    return false;
  }
}

function getMainRepoPath(workspacePath: string): string {
  const marker = `${path.sep}.agentflow${path.sep}worktrees${path.sep}`;
  const idx = workspacePath.indexOf(marker);
  if (idx === -1) {
    throw new Error(`Cannot determine main repo from worktree path: ${workspacePath}`);
  }
  return workspacePath.slice(0, idx);
}

export class CliGitWorktreeManager implements GitWorktreeManager {
  statusPorcelain(workspacePath: string): string {
    return git(["status", "--porcelain"], workspacePath);
  }

  diff(workspacePath: string): string {
    return git(["diff"], workspacePath);
  }

  cleanup(workspacePath: string): void {
    const repoPath = getMainRepoPath(workspacePath);
    git(["worktree", "remove", workspacePath, "--force"], repoPath);
  }

  prepare(args: {
    repoPath: string;
    baseRef?: string;
    taskId: string;
    runId: string;
  }): PreparedWorktree {
    validatePathSegment("taskId", args.taskId);
    validatePathSegment("runId", args.runId);

    const repoPath = path.resolve(args.repoPath);

    if (!isGitRepo(repoPath)) {
      throw new Error(`Not a git repository: ${repoPath}`);
    }

    const baseRef = args.baseRef ?? "HEAD";
    const baseCommit = git(["rev-parse", baseRef], repoPath);

    const branchName = `agent/${args.taskId}/${args.runId}`;
    const workspacePath = path.join(
      repoPath,
      ".agentflow",
      "worktrees",
      args.taskId,
      args.runId,
    );

    git(
      ["worktree", "add", "-b", branchName, workspacePath, baseCommit],
      repoPath,
    );

    // Exclude .agent-workflow/ from git tracking via main repo's exclude file.
    // The main repo's .git/info/exclude applies to all worktrees.
    const mainGitDir = path.join(repoPath, ".git");
    const excludePath = path.join(mainGitDir, "info", "exclude");
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    fs.appendFileSync(excludePath, "\n.agent-workflow/\n", "utf-8");

    return {
      repoPath,
      workspacePath,
      baseCommit,
      branchName,
    };
  }
}
