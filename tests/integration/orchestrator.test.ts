import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runWorkOrder } from "../../src/core/orchestrator.js";
import type { ParsedWorkOrder, ParsedAgentProfile } from "../../src/core/schemas.js";

const EXEC = process.execPath;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initRepo(repoPath: string): void {
  git(["init", "-b", "main"], repoPath);
  git(["config", "user.name", "test"], repoPath);
  git(["config", "user.email", "test@test.test"], repoPath);
}

interface TestContext {
  repoDir: string;
  databasePath: string;
}

function makeFakeAgentArgs(exitCode: number, editFile: string, editContent: string): string[] {
  // A fake agent that edits a file, writes a report, outputs to stdout/stderr
  const script = `
const fs = require('fs');
const path = require('path');
const promptPath = process.argv[process.argv.length - 1];
const ws = process.cwd();
// Edit a file
fs.writeFileSync(path.join(ws, '${editFile}'), '${editContent}', 'utf-8');
// Output some stdout/stderr
console.log('Fake agent stdout output');
console.error('Fake agent stderr output');
// Write final report
const reportDir = path.join(ws, '.agent-workflow');
fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(path.join(reportDir, 'final_report.md'), '# Final Report\\n\\nTask completed.', 'utf-8');
process.exit(${exitCode});
`;
  return ["-e", script, "{{prompt_file}}"];
}

const SIMPLE_VERIFY_CMD = `${JSON.stringify(EXEC)} -e "process.exit(0)"`;
const FAIL_VERIFY_CMD = `${JSON.stringify(EXEC)} -e "process.exit(1)"`;

describe("runWorkOrder", () => {
  let ctx: TestContext;
  let workOrder: ParsedWorkOrder;
  let agentProfile: ParsedAgentProfile;

  beforeEach(() => {
    ctx = {
      repoDir: fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-orch-")),
      databasePath: "",
    };
    initRepo(ctx.repoDir);
    // Create initial file
    fs.writeFileSync(path.join(ctx.repoDir, "README.md"), "# Initial", "utf-8");
    git(["add", "README.md"], ctx.repoDir);
    git(["commit", "-m", "initial commit"], ctx.repoDir);
    ctx.databasePath = path.join(ctx.repoDir, ".agentflow", "test.sqlite");
  });

  afterEach(() => {
    fs.rmSync(ctx.repoDir, { recursive: true, force: true });
  });

  function baseWorkOrder(overrides: Partial<ParsedWorkOrder> = {}): ParsedWorkOrder {
    return {
      schema_version: "workflow/v0",
      task_id: "T-happy",
      project_id: "test-project",
      title: "Test fake agent run",
      type: "code_change",
      goal: "Edit README.md.",
      acceptance_criteria: ["File is edited."],
      repo: { path: ctx.repoDir, base_ref: "main" },
      verification: { commands: [SIMPLE_VERIFY_CMD] },
      agent: { agent_id: "fake-agent" },
      ...overrides,
    };
  }

  function baseAgentProfile(
    overrides: Partial<ParsedAgentProfile> = {},
  ): ParsedAgentProfile {
    return {
      schema_version: "workflow/v0",
      agent_id: "fake-agent",
      integration_mode: "official_cli",
      command: {
        executable: EXEC,
        args: makeFakeAgentArgs(0, "README.md", "# Modified by agent\\n"),
      },
      capabilities: { outer_supervised: true, inner_tool_control: false },
      ...overrides,
    };
  }

  // ─── 1. Happy path ─────────────────────────────────────────────────────

  describe("happy path", () => {
    it("returns succeeded, creates worktree, artifacts, events, usage", async () => {
      const result = await runWorkOrder({
        workOrder: baseWorkOrder(),
        agentProfile: baseAgentProfile(),
        databasePath: ctx.databasePath,
      });

      expect(result.status).toBe("succeeded");
      expect(result.verificationPassed).toBe(true);
      expect(result.artifacts.length).toBeGreaterThanOrEqual(4);
      expect(fs.existsSync(result.workspacePath)).toBe(true);

      // Worktree has agent modifications
      const readme = fs.readFileSync(
        path.join(result.workspacePath, "README.md"),
        "utf-8",
      );
      expect(readme).toContain("Modified by agent");

      // task capsule files exist
      const capsuleDir = path.join(result.workspacePath, ".agent-workflow");
      expect(fs.existsSync(path.join(capsuleDir, "work_order.md"))).toBe(true);
      expect(fs.existsSync(path.join(capsuleDir, "run_manifest.json"))).toBe(
        true,
      );

      // Artifacts exist
      const diffArtifact = result.artifacts.find((a) => a.kind === "diff");
      expect(diffArtifact).toBeDefined();

      const stdoutArtifact = result.artifacts.find(
        (a) => a.kind === "stdout_tail",
      );
      expect(stdoutArtifact).toBeDefined();

      const stderrArtifact = result.artifacts.find(
        (a) => a.kind === "stderr_tail",
      );
      expect(stderrArtifact).toBeDefined();

      const reportArtifact = result.artifacts.find(
        (a) => a.kind === "final_report",
      );
      expect(reportArtifact).toBeDefined();

      const verifArtifact = result.artifacts.find(
        (a) => a.kind === "verification_output",
      );
      expect(verifArtifact).toBeDefined();

      // SQLite rows exist
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(ctx.databasePath);

      const eventCount = (
        db.prepare("select count(*) as c from task_events").get() as {
          c: number;
        }
      ).c;
      expect(eventCount).toBeGreaterThanOrEqual(6);

      const runRow = db
        .prepare("select * from agent_runs where id = ?")
        .get(result.runId) as Record<string, unknown> | undefined;
      expect(runRow).toBeDefined();
      expect(runRow!.status).toBe("succeeded");

      const artifactCount = (
        db.prepare("select count(*) as c from artifacts").get() as {
          c: number;
        }
      ).c;
      expect(artifactCount).toBeGreaterThanOrEqual(4);

      const usageRow = db
        .prepare("select * from agent_usage where run_id = ?")
        .get(result.runId) as Record<string, unknown> | undefined;
      expect(usageRow).toBeDefined();
      expect(usageRow!.exit_code).toBe(0);

      db.close();
    });
  });

  // ─── 2. Verification failed ────────────────────────────────────────────

  describe("verification failed", () => {
    it("returns failed when verification fails", async () => {
      const result = await runWorkOrder({
        workOrder: baseWorkOrder({
          task_id: "T-verif-fail",
          verification: { commands: [FAIL_VERIFY_CMD] },
        }),
        agentProfile: baseAgentProfile(),
        databasePath: ctx.databasePath,
      });

      expect(result.status).toBe("failed");
      expect(result.verificationPassed).toBe(false);

      // Stdout/stderr/diff artifacts still saved
      expect(result.artifacts.find((a) => a.kind === "stdout_tail")).toBeDefined();
      expect(result.artifacts.find((a) => a.kind === "diff")).toBeDefined();

      // verification.failed event exists
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(ctx.databasePath);
      const verifFailEvent = db
        .prepare(
          "select * from task_events where event_type = ? and run_id = ?",
        )
        .get("verification.failed", result.runId) as
        | Record<string, unknown>
        | undefined;
      expect(verifFailEvent).toBeDefined();

      // verification_output artifact.published event exists
      const verifArtEvents = db
        .prepare(
          "select payload_json from task_events where event_type = ? and run_id = ? and payload_json like ?",
        )
        .all(
          "artifact.published",
          result.runId,
          "%verification_output%",
        ) as Array<{ payload_json: string }>;
      expect(verifArtEvents.length).toBeGreaterThanOrEqual(1);

      const runRow = db
        .prepare("select * from agent_runs where id = ?")
        .get(result.runId) as Record<string, unknown> | undefined;
      expect(runRow!.status).toBe("failed");

      db.close();
    });
  });

  // ─── 3. Agent non-zero exit ────────────────────────────────────────────

  describe("agent non-zero exit", () => {
    it("returns failed but still saves artifacts", async () => {
      const result = await runWorkOrder({
        workOrder: baseWorkOrder({ task_id: "T-agent-fail" }),
        agentProfile: baseAgentProfile({
          command: {
            executable: EXEC,
            args: makeFakeAgentArgs(1, "README.md", "# Failed run\\n"),
          },
        }),
        databasePath: ctx.databasePath,
      });

      expect(result.status).toBe("failed");

      // stdout/stderr/diff artifacts still saved
      expect(
        result.artifacts.find((a) => a.kind === "stdout_tail"),
      ).toBeDefined();
      expect(result.artifacts.find((a) => a.kind === "diff")).toBeDefined();

      // run.failed event exists
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(ctx.databasePath);
      const failedEvent = db
        .prepare(
          "select * from task_events where event_type = ? and run_id = ?",
        )
        .get("run.failed", result.runId) as
        | Record<string, unknown>
        | undefined;
      expect(failedEvent).toBeDefined();

      const runRow = db
        .prepare("select * from agent_runs where id = ?")
        .get(result.runId) as Record<string, unknown> | undefined;
      expect(runRow!.status).toBe("failed");

      db.close();
    });
  });

  // ─── 4. Event sequence sanity ──────────────────────────────────────────

  describe("event sequence", () => {
    it("happy path has required events in order", async () => {
      const result = await runWorkOrder({
        workOrder: baseWorkOrder({ task_id: "T-events" }),
        agentProfile: baseAgentProfile(),
        databasePath: ctx.databasePath,
      });

      const Database = (await import("better-sqlite3")).default;
      const db = new Database(ctx.databasePath);

      const events = db
        .prepare(
          "select event_type from task_events where task_id = ? order by created_at asc, id asc",
        )
        .all("T-events") as Array<{ event_type: string }>;
      db.close();

      const types = events.map((e) => e.event_type);
      expect(types).toContain("task.created");
      expect(types).toContain("run.created");
      expect(types).toContain("run.started");
      expect(types).toContain("artifact.published");
      expect(types).toContain("verification.started");
      expect(types).toContain("verification.passed");
      expect(types).toContain("run.completed");

      // Order check: task.created before run.started
      const taskCreatedIdx = types.indexOf("task.created");
      const runStartedIdx = types.indexOf("run.started");
      expect(taskCreatedIdx).toBeLessThan(runStartedIdx);

      // run.created should appear before run.started
      const runCreatedIdx = types.indexOf("run.created");
      expect(runCreatedIdx).toBeLessThan(runStartedIdx);

      // verification.started should come before run.completed
      const verifStartedIdx = types.indexOf("verification.started");
      const runCompletedIdx = types.indexOf("run.completed");
      expect(verifStartedIdx).toBeLessThan(runCompletedIdx);

      expect(result.status).toBe("succeeded");
    });
  });
});
