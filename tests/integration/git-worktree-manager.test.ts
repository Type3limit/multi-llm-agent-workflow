import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  CliGitWorktreeManager,
  type PreparedWorktree,
} from "../../src/workspace/git-worktree-manager.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initRepo(repoPath: string): void {
  git(["init", "-b", "main"], repoPath);
  git(["config", "user.name", "test"], repoPath);
  git(["config", "user.email", "test@test.test"], repoPath);
}

function commitFile(repoPath: string, filename: string, content: string): string {
  fs.writeFileSync(path.join(repoPath, filename), content, "utf-8");
  git(["add", filename], repoPath);
  git(["commit", "-m", `add ${filename}`], repoPath);
  return git(["rev-parse", "HEAD"], repoPath);
}

describe("CliGitWorktreeManager", () => {
  let repoDir: string;
  let manager: CliGitWorktreeManager;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-git-"));
    initRepo(repoDir);
    commitFile(repoDir, "README.md", "# Test Repo");
    manager = new CliGitWorktreeManager();
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  // ─── prepare() ───────────────────────────────────────────────────────────

  describe("prepare()", () => {
    let result: PreparedWorktree;

    beforeEach(() => {
      result = manager.prepare({
        repoPath: repoDir,
        taskId: "T-001",
        runId: "R-001",
      });
    });

    afterEach(() => {
      try { manager.cleanup(result.workspacePath); } catch { /* already cleaned */ }
    });

    it("creates an independent worktree", () => {
      expect(fs.existsSync(result.workspacePath)).toBe(true);
    });

    it("returns absolute repoPath", () => {
      expect(path.isAbsolute(result.repoPath)).toBe(true);
      expect(result.repoPath).toBe(repoDir);
    });

    it("returns baseCommit equal to HEAD of the original repo", () => {
      const headCommit = git(["rev-parse", "HEAD"], repoDir);
      expect(result.baseCommit).toBe(headCommit);
    });

    it("returns branchName as agent/<taskId>/<runId>", () => {
      expect(result.branchName).toBe("agent/T-001/R-001");
    });

    it("returns workspacePath under .agentflow/worktrees", () => {
      const expectedDir = path.join(repoDir, ".agentflow", "worktrees", "T-001", "R-001");
      expect(result.workspacePath).toBe(expectedDir);
    });

    it("worktree has the README.md file from original commit", () => {
      const readmePath = path.join(result.workspacePath, "README.md");
      expect(fs.existsSync(readmePath)).toBe(true);
      expect(fs.readFileSync(readmePath, "utf-8")).toBe("# Test Repo");
    });

    it("throws for non-git repo", () => {
      const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-nogit-"));
      try {
        expect(() =>
          manager.prepare({
            repoPath: nonGitDir,
            taskId: "T-1",
            runId: "R-1",
          }),
        ).toThrow("Not a git repository");
      } finally {
        fs.rmSync(nonGitDir, { recursive: true, force: true });
      }
    });

    it("throws for taskId path traversal", () => {
      expect(() =>
        manager.prepare({
          repoPath: repoDir,
          taskId: "../escape",
          runId: "R-1",
        }),
      ).toThrow("taskId");
    });

    it("throws for runId path traversal", () => {
      expect(() =>
        manager.prepare({
          repoPath: repoDir,
          taskId: "T-1",
          runId: "../escape",
        }),
      ).toThrow("runId");
    });

    it("supports custom baseRef", () => {
      const secondCommit = commitFile(repoDir, "second.txt", "second");
      const result2 = manager.prepare({
        repoPath: repoDir,
        baseRef: "HEAD~1",
        taskId: "T-002",
        runId: "R-002",
      });
      try {
        // At HEAD~1, second.txt should not exist
        expect(fs.existsSync(path.join(result2.workspacePath, "second.txt"))).toBe(false);
        expect(result2.baseCommit).not.toBe(secondCommit);
      } finally {
        manager.cleanup(result2.workspacePath);
      }
    });
  });

  // ─── statusPorcelain() ────────────────────────────────────────────────────

  describe("statusPorcelain()", () => {
    it("shows modifications made in the worktree", () => {
      const result = manager.prepare({
        repoPath: repoDir,
        taskId: "T-status",
        runId: "R-status",
      });
      try {
        // Modify README in worktree
        fs.writeFileSync(path.join(result.workspacePath, "README.md"), "# Modified", "utf-8");
        const status = manager.statusPorcelain(result.workspacePath);
        expect(status).toContain("README.md");
      } finally {
        manager.cleanup(result.workspacePath);
      }
    });
  });

  // ─── diff() ───────────────────────────────────────────────────────────────

  describe("diff()", () => {
    it("returns diff content for worktree changes", () => {
      const result = manager.prepare({
        repoPath: repoDir,
        taskId: "T-diff",
        runId: "R-diff",
      });
      try {
        fs.writeFileSync(path.join(result.workspacePath, "README.md"), "# Changed", "utf-8");
        const d = manager.diff(result.workspacePath);
        expect(d).toContain("diff --git");
        expect(d).toContain("README.md");
      } finally {
        manager.cleanup(result.workspacePath);
      }
    });
  });

  // ─── .agent-workflow/ exclusion ───────────────────────────────────────────

  describe(".agent-workflow/ exclusion", () => {
    it("does not show .agent-workflow/ in statusPorcelain", () => {
      const result = manager.prepare({
        repoPath: repoDir,
        taskId: "T-excl",
        runId: "R-excl",
      });
      try {
        const capsuleDir = path.join(result.workspacePath, ".agent-workflow");
        fs.mkdirSync(capsuleDir, { recursive: true });
        fs.writeFileSync(path.join(capsuleDir, "work_order.md"), "# Task", "utf-8");
        const status = manager.statusPorcelain(result.workspacePath);
        // .agent-workflow/ must be excluded — status should not mention it
        expect(status).not.toContain(".agent-workflow");
        expect(status).not.toContain("work_order.md");
      } finally {
        manager.cleanup(result.workspacePath);
      }
    });
  });

  // ─── cleanup() ────────────────────────────────────────────────────────────

  describe("cleanup()", () => {
    it("removes the worktree path", () => {
      const result = manager.prepare({
        repoPath: repoDir,
        taskId: "T-clean",
        runId: "R-clean",
      });
      expect(fs.existsSync(result.workspacePath)).toBe(true);

      manager.cleanup(result.workspacePath);
      expect(fs.existsSync(result.workspacePath)).toBe(false);
    });

    it("throws for non-existent worktree path", () => {
      expect(() =>
        manager.cleanup(path.join(os.tmpdir(), "nonexistent-worktree")),
      ).toThrow();
    });
  });
});
