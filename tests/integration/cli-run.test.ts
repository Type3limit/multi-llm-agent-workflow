import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runCli, parseArgs } from "../../src/cli/run-command.js";

const EXEC = process.execPath;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(repoPath: string): void {
  git(["init", "-b", "main"], repoPath);
  git(["config", "user.name", "test"], repoPath);
  git(["config", "user.email", "test@test.test"], repoPath);
}

const SIMPLE_VERIFY_CMD = `${JSON.stringify(EXEC)} -e "process.exit(0)"`;
const FAIL_VERIFY_CMD = `${JSON.stringify(EXEC)} -e "process.exit(1)"`;

describe("CLI integration", () => {
  let repoDir: string;
  let workOrderPath: string;
  let agentPath: string;
  let databasePath: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-cli-run-"));
    initRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Initial", "utf-8");
    git(["add", "README.md"], repoDir);
    git(["commit", "-m", "init"], repoDir);

    databasePath = path.join(repoDir, ".agentflow", "test.sqlite");

    // Write fake agent script as JSON profile using process.execPath
    const agentProfile = {
      schema_version: "workflow/v0",
      agent_id: "fake-agent",
      integration_mode: "official_cli",
      command: {
        executable: EXEC,
        args: [
          "-e",
          `
const fs = require('fs');
const path = require('path');
const ws = process.cwd();
fs.writeFileSync(path.join(ws, 'README.md'), '# Modified by agent\\n', 'utf-8');
console.log('fake stdout');
console.error('fake stderr');
const rd = path.join(ws, '.agent-workflow');
fs.mkdirSync(rd, { recursive: true });
fs.writeFileSync(path.join(rd, 'final_report.md'), '# Report\\n\\nDone.', 'utf-8');
process.exit(0);
`,
          "{{prompt_file}}",
        ],
      },
      capabilities: { outer_supervised: true, inner_tool_control: false },
    };

    agentPath = path.join(repoDir, "agent.json");
    fs.writeFileSync(agentPath, JSON.stringify(agentProfile));
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  function makeWorkOrder(
    overrides: Record<string, unknown> = {},
  ): string {
    const woPath = path.join(repoDir, "work_order.json");
    const wo = {
      schema_version: "workflow/v0",
      task_id: "T-cli-test",
      title: "CLI Integration Test",
      type: "code_change",
      goal: "Test CLI integration.",
      acceptance_criteria: ["Test passes."],
      repo: { path: repoDir, base_ref: "main" },
      verification: { commands: [SIMPLE_VERIFY_CMD] },
      agent: { agent_id: "fake-agent" },
      ...overrides,
    };
    fs.writeFileSync(woPath, JSON.stringify(wo, null, 2));
    return woPath;
  }

  // ─── Happy path ─────────────────────────────────────────────────────────

  it("happy path: exitCode 0, summary contains expected fields", async () => {
    const woPath = makeWorkOrder();
    const args = parseArgs([
      "node",
      "agentflow",
      "run",
      woPath,
      "--agent",
      agentPath,
      "--database",
      databasePath,
    ]);

    const result = await runCli(args);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("Task: T-cli-test");
    expect(result.message).toContain("Status: succeeded");
    expect(result.message).toContain("Verification: passed");
    expect(result.message).toContain("Artifacts:");

    // Check SQLite
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(databasePath);
    const events = (
      db.prepare("select count(*) as c from task_events").get() as {
        c: number;
      }
    ).c;
    expect(events).toBeGreaterThanOrEqual(6);

    const runs = (
      db.prepare("select count(*) as c from agent_runs").get() as {
        c: number;
      }
    ).c;
    expect(runs).toBe(1);

    const artifacts = (
      db.prepare("select count(*) as c from artifacts").get() as {
        c: number;
      }
    ).c;
    expect(artifacts).toBeGreaterThanOrEqual(4);

    const usage = (
      db.prepare("select count(*) as c from agent_usage").get() as {
        c: number;
      }
    ).c;
    expect(usage).toBe(1);

    db.close();
  });

  // ─── Verification failed ────────────────────────────────────────────────

  it("verification failed: exitCode 1", async () => {
    const woPath = makeWorkOrder({
      verification: { commands: [FAIL_VERIFY_CMD] },
      task_id: "T-cli-fail",
    });
    const args = parseArgs([
      "node",
      "agentflow",
      "run",
      woPath,
      "--agent",
      agentPath,
      "--database",
      databasePath,
    ]);

    const result = await runCli(args);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Status: failed");
    expect(result.message).toContain("Verification: failed");
  });
});
