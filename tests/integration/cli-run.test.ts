import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runCli, parseArgs, type SigintSignalSource } from "../../src/cli/run-command.js";
import type { TaskQueueEntry } from "../../src/core/types.js";
import { openDatabase } from "../../src/storage/database.js";
import { migrate } from "../../src/storage/migrations.js";
import { SqliteQueueStore } from "../../src/storage/queue-store.js";

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

function seedAcceptedTaskQueueRows(databasePath: string, taskIds: string[]): void {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = openDatabase(databasePath);

  try {
    migrate(db);
    const store = new SqliteQueueStore(db);
    for (const [index, taskId] of taskIds.entries()) {
      const ts = `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`;
      const entry: TaskQueueEntry = {
        task_id: taskId,
        project_id: "default",
        status: "accepted",
        next_role: "implementer",
        current_owner_run_id: null,
        lease_expires_at: null,
        attempts: 1,
        enqueued_at: ts,
        updated_at: ts,
      };
      store.insert(entry, "{}");
    }
  } finally {
    db.close();
  }
}

class ManualSigintSignalSource implements SigintSignalSource {
  private handler: (() => void) | undefined;

  onSigint(handler: () => void): { dispose: () => void } {
    this.handler = handler;
    return {
      dispose: () => {
        if (this.handler === handler) {
          this.handler = undefined;
        }
      },
    };
  }

  trigger(): void {
    this.handler?.();
  }
}

interface AgentRunRow {
  id: string;
  task_id: string;
  status: string;
  ended_at: string | null;
}

function listAgentRuns(databasePath: string, taskIds: readonly string[]): AgentRunRow[] {
  if (!fs.existsSync(databasePath)) {
    return [];
  }

  const db = openDatabase(databasePath);
  try {
    const placeholders = taskIds.map(() => "?").join(", ");
    return db
      .prepare(
        `select id, task_id, status, ended_at
         from agent_runs
         where task_id in (${placeholders})
         order by task_id asc, rowid asc`,
      )
      .all(...taskIds) as AgentRunRow[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

async function waitForRunningAgentRuns(args: {
  databasePath: string;
  taskIds: readonly string[];
  expectedCount: number;
  timeoutMs?: number;
}): Promise<AgentRunRow[]> {
  const deadline = Date.now() + (args.timeoutMs ?? 5_000);
  let rows: AgentRunRow[] = [];

  while (Date.now() < deadline) {
    rows = listAgentRuns(args.databasePath, args.taskIds);
    const runningRows = rows.filter((row) => row.status === "running");
    if (runningRows.length >= args.expectedCount) {
      return runningRows;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(
    `Timed out waiting for ${args.expectedCount} running agent run(s); saw ${JSON.stringify(rows)}`,
  );
}

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

  it("v1 review disabled: fake implementer reaches accepted", async () => {
    const v1AgentPath = path.join(repoDir, "agent-v1.json");
    fs.writeFileSync(
      v1AgentPath,
      JSON.stringify({
        schema_version: "workflow/v1",
        agent_id: "fake-v1-agent",
        integration_mode: "official_cli",
        command: {
          executable: EXEC,
          args: [
            "-e",
            `
const fs = require('fs');
const path = require('path');
const ws = process.cwd();
fs.writeFileSync(path.join(ws, 'README.md'), '# Modified by v1 agent\\n', 'utf-8');
console.log('fake v1 stdout');
console.error('fake v1 stderr');
const rd = path.join(ws, '.agent-workflow');
fs.mkdirSync(rd, { recursive: true });
fs.writeFileSync(path.join(rd, 'final_report.md'), '# V1 Report\\n\\nDone.', 'utf-8');
process.exit(0);
`,
            "{{prompt_file}}",
          ],
        },
        capabilities: {
          outer_supervised: true,
          inner_tool_control: false,
          kinds: ["code_change"],
          roles: ["implementer"],
        },
        cost_profile: {
          billing_unit: "call",
          estimated_cost_per_run_units: 1,
        },
      }),
    );

    const woPath = path.join(repoDir, "work_order_v1.json");
    fs.writeFileSync(
      woPath,
      JSON.stringify(
        {
          schema_version: "workflow/v1",
          task_id: "T-cli-v1",
          title: "CLI v1 Integration Test",
          type: "code_change",
          goal: "Test v1 CLI integration.",
          acceptance_criteria: ["Test passes."],
          repo: { path: repoDir, base_ref: "main" },
          verification: { commands: [SIMPLE_VERIFY_CMD] },
          agent: {
            required_capabilities: ["code_change"],
            implementer_pool: ["fake-v1-agent"],
            reviewer_pool: [],
            exclude_agent_ids: [],
          },
          review: { enabled: false, max_review_runs: 0 },
          budget: {
            max_wall_time_minutes: 5,
            max_total_cost_units: 10,
            max_runs: 2,
          },
        },
        null,
        2,
      ),
    );

    const args = parseArgs([
      "node",
      "agentflow",
      "run",
      woPath,
      "--agent",
      v1AgentPath,
      "--database",
      databasePath,
    ]);

    const result = await runCli(args);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("Task: T-cli-v1");
    expect(result.message).toContain("Final task status: accepted");
    expect(result.message).toContain("Attempts: 1");
    expect(result.message).toContain(`Database: ${databasePath}`);
    expect(result.message).toContain("Worktrees:");
    expect(result.message).toContain("Artifacts:");

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(databasePath);
    const task = db.prepare("select status, attempts from task_queue where task_id = ?").get("T-cli-v1") as {
      status: string;
      attempts: number;
    };
    expect(task.status).toBe("accepted");
    expect(task.attempts).toBe(1);

    const run = db.prepare("select role, status from agent_runs where task_id = ?").get("T-cli-v1") as {
      role: string;
      status: string;
    };
    expect(run.role).toBe("implementer");
    expect(run.status).toBe("succeeded");

    const artifactCount = (
      db.prepare("select count(*) as c from artifacts where task_id = ?").get("T-cli-v1") as {
        c: number;
      }
    ).c;
    expect(artifactCount).toBeGreaterThanOrEqual(5);
    db.close();
  });

  it("v1 run interrupted by SIGINT returns 130 without a terminal summary", async () => {
    const v1AgentPath = path.join(repoDir, "agent-v1-slow.json");
    fs.writeFileSync(
      v1AgentPath,
      JSON.stringify({
        schema_version: "workflow/v1",
        agent_id: "fake-v1-slow-agent",
        integration_mode: "official_cli",
        command: {
          executable: EXEC,
          args: [
            "-e",
            `
setTimeout(() => process.exit(0), 30000);
`,
            "{{prompt_file}}",
          ],
        },
        capabilities: {
          outer_supervised: true,
          inner_tool_control: false,
          kinds: ["code_change"],
          roles: ["implementer"],
        },
        cost_profile: {
          billing_unit: "call",
          estimated_cost_per_run_units: 1,
        },
      }),
    );

    const woPath = path.join(repoDir, "work_order_v1_interrupted.json");
    fs.writeFileSync(
      woPath,
      JSON.stringify(
        {
          schema_version: "workflow/v1",
          task_id: "T-cli-v1-interrupted",
          title: "CLI v1 Interrupted Test",
          type: "code_change",
          goal: "Exercise SIGINT interruption for v1 run.",
          acceptance_criteria: ["The run is interrupted."],
          repo: { path: repoDir, base_ref: "main" },
          verification: { commands: [SIMPLE_VERIFY_CMD] },
          agent: {
            required_capabilities: ["code_change"],
            implementer_pool: ["fake-v1-slow-agent"],
            reviewer_pool: [],
            exclude_agent_ids: [],
          },
          review: { enabled: false, max_review_runs: 0 },
          budget: {
            max_wall_time_minutes: 5,
            max_total_cost_units: 10,
            max_runs: 2,
          },
        },
        null,
        2,
      ),
    );

    const args = parseArgs([
      "node",
      "agentflow",
      "run",
      woPath,
      "--agent",
      v1AgentPath,
      "--database",
      databasePath,
    ]);

    const signalSource = new ManualSigintSignalSource();
    const resultPromise = runCli(args, {
      signalSource,
      sigintGraceMs: 5,
    });
    const startedRuns = await waitForRunningAgentRuns({
      databasePath,
      taskIds: ["T-cli-v1-interrupted"],
      expectedCount: 1,
    });

    signalSource.trigger();
    const result = await resultPromise;

    expect(result.exitCode).toBe(130);
    expect(result.message).toContain("v1 orchestration interrupted");
    expect(result.message).not.toContain("Final task status:");
    expect(result.message).not.toContain("Status: accepted");
    expect(result.message).not.toContain("Status: failed");

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(databasePath);
    const task = db
      .prepare("select status from task_queue where task_id = ?")
      .get("T-cli-v1-interrupted") as { status: string };
    expect(["accepted", "failed", "awaiting_human"]).not.toContain(task.status);

    const runRows = db
      .prepare("select id, status, ended_at from agent_runs where task_id = ? order by rowid asc")
      .all("T-cli-v1-interrupted") as Array<{
      id: string;
      status: string;
      ended_at: string | null;
    }>;
    expect(runRows.map((run) => run.id)).toEqual(startedRuns.map((run) => run.id));
    for (const run of runRows) {
      expect(run.status).toBe("cancelled");
      expect(run.status).not.toBe("running");
      expect(run.ended_at).toEqual(expect.any(String));
    }

    const misleadingEvents = db
      .prepare(
        "select event_type from task_events where task_id = ? and event_type in ('task.completed', 'task.failed', 'task.awaiting_human', 'run.cleaned_up')",
      )
      .all("T-cli-v1-interrupted") as Array<{ event_type: string }>;
    expect(misleadingEvents).toEqual([]);
    db.close();
  });

  it("v1 review enabled: fake implementer and reviewer approve through agentflow run", async () => {
    fs.writeFileSync(path.join(repoDir, "review-target.txt"), "original\n", "utf-8");
    git(["add", "review-target.txt"], repoDir);
    git(["commit", "-m", "add review target"], repoDir);

    const agentsDir = path.join(repoDir, "agents-review");
    fs.mkdirSync(agentsDir, { recursive: true });

    fs.writeFileSync(
      path.join(agentsDir, "aaa-decoy-implementer.json"),
      JSON.stringify({
        schema_version: "workflow/v1",
        agent_id: "aaa-not-in-implementer-pool",
        integration_mode: "official_cli",
        command: {
          executable: EXEC,
          args: [
            "-e",
            `
console.error('decoy implementer should not run');
process.exit(87);
`,
            "{{prompt_file}}",
          ],
        },
        capabilities: {
          outer_supervised: true,
          inner_tool_control: false,
          kinds: ["code_change"],
          roles: ["implementer"],
        },
        cost_profile: {
          billing_unit: "call",
          estimated_cost_per_run_units: 1,
        },
      }),
    );

    fs.writeFileSync(
      path.join(agentsDir, "implementer.json"),
      JSON.stringify({
        schema_version: "workflow/v1",
        agent_id: "fake-review-implementer",
        integration_mode: "official_cli",
        command: {
          executable: EXEC,
          args: [
            "-e",
            `
const fs = require('fs');
const path = require('path');
const ws = process.cwd();
fs.writeFileSync(path.join(ws, 'review-target.txt'), 'original\\nReviewed approval path change.\\n', 'utf-8');
const rd = path.join(ws, '.agent-workflow');
fs.mkdirSync(rd, { recursive: true });
fs.writeFileSync(path.join(rd, 'final_report.md'), '# Implementer Report\\n\\nUpdated review target for reviewer approval.', 'utf-8');
console.log('implementer complete');
process.exit(0);
`,
            "{{prompt_file}}",
          ],
        },
        capabilities: {
          outer_supervised: true,
          inner_tool_control: false,
          kinds: ["code_change"],
          roles: ["implementer"],
        },
        cost_profile: {
          billing_unit: "call",
          estimated_cost_per_run_units: 1,
        },
      }),
    );

    fs.writeFileSync(
      path.join(agentsDir, "aaa-decoy-reviewer.json"),
      JSON.stringify({
        schema_version: "workflow/v1",
        agent_id: "aaa-not-in-reviewer-pool",
        integration_mode: "official_cli",
        command: {
          executable: EXEC,
          args: [
            "-e",
            `
console.error('decoy reviewer should not run');
process.exit(88);
`,
            "{{prompt_file}}",
          ],
        },
        capabilities: {
          outer_supervised: true,
          inner_tool_control: false,
          kinds: ["code_change"],
          roles: ["reviewer"],
        },
        cost_profile: {
          billing_unit: "call",
          estimated_cost_per_run_units: 1,
        },
      }),
    );

    fs.writeFileSync(
      path.join(agentsDir, "reviewer.json"),
      JSON.stringify({
        schema_version: "workflow/v1",
        agent_id: "fake-approve-reviewer",
        integration_mode: "official_cli",
        command: {
          executable: EXEC,
          args: [
            "-e",
            `
const fs = require('fs');
const path = require('path');
const ws = process.cwd();
const rd = path.join(ws, '.agent-workflow');
const brief = fs.readFileSync(path.join(rd, 'review_brief.md'), 'utf-8');
if (!brief.includes('Reviewed approval path change.')) {
  console.error('review brief did not include implementer diff');
  process.exit(2);
}
fs.writeFileSync(
  path.join(rd, 'review_verdict.json'),
  JSON.stringify({
    schema_version: 'agent-workflow/1',
    verdict: 'approved',
    summary: 'The implementer diff satisfies the review-enabled CLI approve fixture.',
    comments: []
  }, null, 2) + '\\n',
  'utf-8'
);
console.log('reviewer approved');
process.exit(0);
`,
            "{{prompt_file}}",
          ],
        },
        capabilities: {
          outer_supervised: true,
          inner_tool_control: false,
          kinds: ["code_change"],
          roles: ["reviewer"],
        },
        cost_profile: {
          billing_unit: "call",
          estimated_cost_per_run_units: 1,
        },
      }),
    );

    const woPath = path.join(repoDir, "work_order_v1_review.json");
    fs.writeFileSync(
      woPath,
      JSON.stringify(
        {
          schema_version: "workflow/v1",
          task_id: "T-cli-v1-review-approve",
          title: "CLI v1 Review Approve Test",
          type: "code_change",
          goal: "Exercise the v1 CLI approve path with a reviewer.",
          acceptance_criteria: ["The reviewer approves the implementer diff."],
          repo: { path: repoDir, base_ref: "main" },
          verification: { commands: [SIMPLE_VERIFY_CMD] },
          agent: {
            required_capabilities: ["code_change"],
            implementer_pool: ["fake-review-implementer"],
            reviewer_pool: ["fake-approve-reviewer"],
            exclude_agent_ids: [],
          },
          review: { enabled: true, max_review_runs: 1 },
          budget: {
            max_wall_time_minutes: 5,
            max_total_cost_units: 10,
            max_runs: 2,
          },
        },
        null,
        2,
      ),
    );

    const args = parseArgs([
      "node",
      "agentflow",
      "run",
      woPath,
      "--agents",
      agentsDir,
      "--database",
      databasePath,
    ]);

    const result = await runCli(args);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("Task: T-cli-v1-review-approve");
    expect(result.message).toContain("Final task status: accepted");

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(databasePath);
    const task = db
      .prepare("select status, attempts from task_queue where task_id = ?")
      .get("T-cli-v1-review-approve") as {
      status: string;
      attempts: number;
    };
    expect(task.status).toBe("accepted");
    expect(task.attempts).toBe(2);

    const runs = db
      .prepare("select id, agent_id, role, status, workspace_path from agent_runs where task_id = ? order by rowid asc")
      .all("T-cli-v1-review-approve") as Array<{
      id: string;
      agent_id: string;
      role: string;
      status: string;
      workspace_path: string;
    }>;
    expect(runs.filter((run) => run.role === "implementer")).toHaveLength(1);
    expect(runs.filter((run) => run.role === "reviewer")).toHaveLength(1);
    const implementerRun = runs.find((run) => run.role === "implementer");
    expect(implementerRun).toMatchObject({
      agent_id: "fake-review-implementer",
      role: "implementer",
      status: "succeeded",
    });
    const reviewerRun = runs.find((run) => run.role === "reviewer");
    expect(reviewerRun).toMatchObject({
      agent_id: "fake-approve-reviewer",
      role: "reviewer",
      status: "succeeded",
    });

    const reviewCompletedRows = db
      .prepare("select run_id, payload_json from task_events where task_id = ? and event_type = 'review.completed'")
      .all("T-cli-v1-review-approve") as Array<{
      run_id: string;
      payload_json: string;
    }>;
    expect(reviewCompletedRows).toHaveLength(1);
    expect(reviewCompletedRows[0].run_id).toBe(reviewerRun?.id);
    const reviewPayload = JSON.parse(reviewCompletedRows[0].payload_json) as {
      verdict?: string;
      verdict_uri?: string;
    };
    expect(reviewPayload.verdict).toBe("approved");
    expect(reviewPayload.verdict_uri).toEqual(expect.any(String));
    expect(reviewPayload.verdict_uri?.length).toBeGreaterThan(0);

    const reviewVerdictArtifacts = db
      .prepare("select run_id, kind, uri from artifacts where task_id = ? and kind = 'review_verdict'")
      .all("T-cli-v1-review-approve") as Array<{
      run_id: string;
      kind: string;
      uri: string;
    }>;
    expect(reviewVerdictArtifacts).toEqual([
      expect.objectContaining({
        run_id: reviewerRun?.id,
        kind: "review_verdict",
        uri: reviewPayload.verdict_uri,
      }),
    ]);

    expect(implementerRun?.workspace_path).toEqual(expect.any(String));
    expect(reviewerRun?.workspace_path).toEqual(expect.any(String));
    expect(fs.existsSync(implementerRun!.workspace_path)).toBe(false);
    expect(fs.existsSync(reviewerRun!.workspace_path)).toBe(false);

    const cleanedUpRows = db
      .prepare("select run_id, agent_id, payload_json from task_events where task_id = ? and event_type = 'run.cleaned_up' order by rowid asc")
      .all("T-cli-v1-review-approve") as Array<{
      run_id: string;
      agent_id: string;
      payload_json: string;
    }>;
    expect(cleanedUpRows).toEqual([
      {
        run_id: implementerRun!.id,
        agent_id: "fake-review-implementer",
        payload_json: "{}",
      },
      {
        run_id: reviewerRun!.id,
        agent_id: "fake-approve-reviewer",
        payload_json: "{}",
      },
    ]);
    db.close();
  });

  it("v1 review enabled: reviewer rejected moves task to awaiting_human without requeueing", async () => {
    fs.writeFileSync(path.join(repoDir, "review-rejected-target.txt"), "base\n", "utf-8");
    git(["add", "review-rejected-target.txt"], repoDir);
    git(["commit", "-m", "add review rejected target"], repoDir);

    const agentsDir = path.join(repoDir, "agents-review-rejected");
    fs.mkdirSync(agentsDir, { recursive: true });

    fs.writeFileSync(
      path.join(agentsDir, "implementer.json"),
      JSON.stringify({
        schema_version: "workflow/v1",
        agent_id: "phase17-impl",
        integration_mode: "official_cli",
        command: {
          executable: EXEC,
          args: [
            "-e",
            `
const fs = require('fs');
const path = require('path');
const ws = process.cwd();
fs.writeFileSync(path.join(ws, 'review-rejected-target.txt'), 'base\\nrejected implementation change\\n', 'utf-8');
const rd = path.join(ws, '.agent-workflow');
fs.mkdirSync(rd, { recursive: true });
fs.writeFileSync(path.join(rd, 'final_report.md'), '# Rejected Implementer Report\\n\\nMade a tracked repository change for the reviewer rejected fixture.', 'utf-8');
console.log('implementer complete');
process.exit(0);
`,
            "{{prompt_file}}",
          ],
        },
        capabilities: {
          outer_supervised: true,
          inner_tool_control: false,
          kinds: ["code_change"],
          roles: ["implementer"],
        },
        cost_profile: {
          billing_unit: "call",
          estimated_cost_per_run_units: 1,
        },
      }),
    );

    fs.writeFileSync(
      path.join(agentsDir, "reviewer.json"),
      JSON.stringify({
        schema_version: "workflow/v1",
        agent_id: "phase17-reviewer",
        integration_mode: "official_cli",
        command: {
          executable: EXEC,
          args: [
            "-e",
            `
const fs = require('fs');
const path = require('path');
const ws = process.cwd();
const rd = path.join(ws, '.agent-workflow');
const diff = fs.readFileSync(path.join(rd, 'diff_under_review.patch'), 'utf-8');
const brief = fs.readFileSync(path.join(rd, 'review_brief.md'), 'utf-8');
if (!diff.includes('rejected implementation change')) {
  console.error('diff under review did not include the implementer change');
  process.exit(31);
}
if (!brief.includes('rejected implementation change')) {
  console.error('review brief did not include the implementer change');
  process.exit(32);
}
fs.writeFileSync(
  path.join(rd, 'review_verdict.json'),
  JSON.stringify({
    schema_version: 'agent-workflow/1',
    verdict: 'rejected',
    summary: 'The reviewer rejects this implementation and requires human handling.',
    comments: [
      {
        path: 'review-rejected-target.txt',
        severity: 'must_fix',
        comment: 'The fixture intentionally rejects this diff.'
      }
    ]
  }, null, 2) + '\\n',
  'utf-8'
);
console.log('reviewer rejected');
process.exit(0);
`,
            "{{prompt_file}}",
          ],
        },
        capabilities: {
          outer_supervised: true,
          inner_tool_control: false,
          kinds: ["code_change"],
          roles: ["reviewer"],
        },
        cost_profile: {
          billing_unit: "call",
          estimated_cost_per_run_units: 1,
        },
      }),
    );

    const woPath = path.join(repoDir, "work_order_v1_review_rejected.json");
    fs.writeFileSync(
      woPath,
      JSON.stringify(
        {
          schema_version: "workflow/v1",
          task_id: "T-cli-v1-review-rejected",
          title: "CLI v1 Review Rejected Test",
          type: "code_change",
          goal: "Exercise the v1 CLI reviewer rejected path.",
          acceptance_criteria: ["The rejected review leaves the task awaiting human input."],
          repo: { path: repoDir, base_ref: "main" },
          verification: { commands: [SIMPLE_VERIFY_CMD] },
          agent: {
            required_capabilities: ["code_change"],
            implementer_pool: ["phase17-impl"],
            reviewer_pool: ["phase17-reviewer"],
            exclude_agent_ids: [],
          },
          review: { enabled: true, max_review_runs: 1 },
          budget: {
            max_wall_time_minutes: 5,
            max_total_cost_units: 10,
            max_runs: 2,
          },
        },
        null,
        2,
      ),
    );

    const args = parseArgs([
      "node",
      "agentflow",
      "run",
      woPath,
      "--agents",
      agentsDir,
      "--database",
      databasePath,
    ]);

    const result = await runCli(args);
    expect(result.exitCode).toBe(3);
    expect(result.message).toContain("Task: T-cli-v1-review-rejected");
    expect(result.message).toContain("Final task status: awaiting_human");
    expect(result.message).toContain("Attempts: 2");

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(databasePath);
    const task = db
      .prepare("select status, attempts from task_queue where task_id = ?")
      .get("T-cli-v1-review-rejected") as {
      status: string;
      attempts: number;
    };
    expect(task.status).toBe("awaiting_human");
    expect(task.attempts).toBe(2);

    const runs = db
      .prepare("select id, agent_id, role, status, workspace_path from agent_runs where task_id = ? order by rowid asc")
      .all("T-cli-v1-review-rejected") as Array<{
      id: string;
      agent_id: string;
      role: string;
      status: string;
      workspace_path: string;
    }>;
    const implementerRuns = runs.filter((run) => run.role === "implementer");
    const reviewerRuns = runs.filter((run) => run.role === "reviewer");
    expect(implementerRuns).toHaveLength(1);
    expect(reviewerRuns).toHaveLength(1);
    expect(implementerRuns[0]).toMatchObject({
      agent_id: "phase17-impl",
      role: "implementer",
      status: "succeeded",
    });
    expect(reviewerRuns[0]).toMatchObject({
      agent_id: "phase17-reviewer",
      role: "reviewer",
      status: "succeeded",
    });

    const reviewCompletedRows = db
      .prepare("select rowid, run_id, payload_json from task_events where task_id = ? and event_type = 'review.completed' order by rowid asc")
      .all("T-cli-v1-review-rejected") as Array<{
      rowid: number;
      run_id: string;
      payload_json: string;
    }>;
    expect(reviewCompletedRows).toHaveLength(1);
    expect(reviewCompletedRows[0].run_id).toBe(reviewerRuns[0].id);
    const reviewPayload = JSON.parse(reviewCompletedRows[0].payload_json) as {
      verdict?: string;
      verdict_uri?: string;
    };
    expect(reviewPayload.verdict).toBe("rejected");
    expect(reviewPayload.verdict_uri).toEqual(expect.any(String));
    expect(reviewPayload.verdict_uri?.length).toBeGreaterThan(0);

    const awaitingHumanRows = db
      .prepare("select rowid, run_id, payload_json from task_events where task_id = ? and event_type = 'task.awaiting_human' order by rowid asc")
      .all("T-cli-v1-review-rejected") as Array<{
      rowid: number;
      run_id: string;
      payload_json: string;
    }>;
    expect(awaitingHumanRows).toHaveLength(1);
    expect(awaitingHumanRows[0].run_id).toBe(reviewerRuns[0].id);
    expect(awaitingHumanRows[0].rowid).toBeGreaterThan(reviewCompletedRows[0].rowid);
    const awaitingPayload = JSON.parse(awaitingHumanRows[0].payload_json) as {
      reason?: string;
      review_verdict_uri?: string;
      implementer_run_id?: string;
    };
    expect(awaitingPayload).toMatchObject({
      reason: "review_rejected",
      review_verdict_uri: reviewPayload.verdict_uri,
      implementer_run_id: implementerRuns[0].id,
    });

    const handoffRequestedCount = (
      db
        .prepare("select count(*) as c from task_events where task_id = ? and event_type = 'handoff.requested'")
        .get("T-cli-v1-review-rejected") as { c: number }
    ).c;
    expect(handoffRequestedCount).toBe(0);

    const requeueRows = db
      .prepare("select rowid, payload_json from task_events where task_id = ? and event_type = 'task.requeued' order by rowid asc")
      .all("T-cli-v1-review-rejected") as Array<{
      rowid: number;
      payload_json: string;
    }>;
    expect(requeueRows).toHaveLength(1);
    expect(requeueRows[0].rowid).toBeLessThan(reviewCompletedRows[0].rowid);
    expect(JSON.parse(requeueRows[0].payload_json)).toMatchObject({
      reason: "review_required",
      next_role: "reviewer",
    });

    const requeueAfterReviewCount = (
      db
        .prepare("select count(*) as c from task_events where task_id = ? and event_type = 'task.requeued' and rowid > ?")
        .get("T-cli-v1-review-rejected", reviewCompletedRows[0].rowid) as { c: number }
    ).c;
    expect(requeueAfterReviewCount).toBe(0);

    expect(implementerRuns[0].workspace_path).toEqual(expect.any(String));
    expect(reviewerRuns[0].workspace_path).toEqual(expect.any(String));
    expect(fs.existsSync(implementerRuns[0].workspace_path)).toBe(true);
    expect(fs.existsSync(reviewerRuns[0].workspace_path)).toBe(true);

    const cleanedUpCount = (
      db
        .prepare("select count(*) as c from task_events where task_id = ? and event_type = 'run.cleaned_up'")
        .get("T-cli-v1-review-rejected") as { c: number }
    ).c;
    expect(cleanedUpCount).toBe(0);
    db.close();
  });

  it("v1 review enabled: changes_requested requeues to a different implementer and fresh reviewer", async () => {
    fs.writeFileSync(path.join(repoDir, "review-requeue-target.txt"), "base\n", "utf-8");
    git(["add", "review-requeue-target.txt"], repoDir);
    git(["commit", "-m", "add review requeue target"], repoDir);

    const agentsDir = path.join(repoDir, "agents-review-requeue");
    fs.mkdirSync(agentsDir, { recursive: true });

    fs.writeFileSync(
      path.join(agentsDir, "implementer-a.json"),
      JSON.stringify({
        schema_version: "workflow/v1",
        agent_id: "phase16-impl-a",
        integration_mode: "official_cli",
        command: {
          executable: EXEC,
          args: [
            "-e",
            `
const fs = require('fs');
const path = require('path');
const ws = process.cwd();
fs.writeFileSync(path.join(ws, 'review-requeue-target.txt'), 'base\\nfirst implementer change\\n', 'utf-8');
const rd = path.join(ws, '.agent-workflow');
fs.mkdirSync(rd, { recursive: true });
fs.writeFileSync(path.join(rd, 'final_report.md'), '# First Implementer Report\\n\\nMade the first change.', 'utf-8');
console.log('first implementer complete');
process.exit(0);
`,
            "{{prompt_file}}",
          ],
        },
        capabilities: {
          outer_supervised: true,
          inner_tool_control: false,
          kinds: ["code_change"],
          roles: ["implementer"],
        },
        cost_profile: {
          billing_unit: "call",
          estimated_cost_per_run_units: 1,
        },
      }),
    );

    fs.writeFileSync(
      path.join(agentsDir, "implementer-b.json"),
      JSON.stringify({
        schema_version: "workflow/v1",
        agent_id: "phase16-impl-b",
        integration_mode: "official_cli",
        command: {
          executable: EXEC,
          args: [
            "-e",
            `
const fs = require('fs');
const path = require('path');
const ws = process.cwd();
const rd = path.join(ws, '.agent-workflow');
const handoffPath = path.join(rd, 'handoff_packet.json');
if (!fs.existsSync(handoffPath)) {
  console.error('missing handoff packet');
  process.exit(11);
}
const handoff = fs.readFileSync(handoffPath, 'utf-8');
if (!handoff.includes('phase16-impl-a') || !handoff.includes('review_changes_requested')) {
  console.error('handoff packet did not identify the first implementer review failure');
  process.exit(12);
}
const prompt = fs.readFileSync(path.join(rd, 'prompt.md'), 'utf-8');
if (!prompt.includes('Taking Over a Previous Attempt')) {
  console.error('prompt did not include handoff takeover text');
  process.exit(13);
}
fs.writeFileSync(path.join(ws, 'review-requeue-target.txt'), 'base\\nsecond implementer change\\n', 'utf-8');
fs.writeFileSync(path.join(rd, 'final_report.md'), '# Second Implementer Report\\n\\nMade the replacement change.', 'utf-8');
console.log('second implementer complete');
process.exit(0);
`,
            "{{prompt_file}}",
          ],
        },
        capabilities: {
          outer_supervised: true,
          inner_tool_control: false,
          kinds: ["code_change"],
          roles: ["implementer"],
        },
        cost_profile: {
          billing_unit: "call",
          estimated_cost_per_run_units: 1,
        },
      }),
    );

    fs.writeFileSync(
      path.join(agentsDir, "reviewer.json"),
      JSON.stringify({
        schema_version: "workflow/v1",
        agent_id: "phase16-reviewer",
        integration_mode: "official_cli",
        command: {
          executable: EXEC,
          args: [
            "-e",
            `
const fs = require('fs');
const path = require('path');
const ws = process.cwd();
const rd = path.join(ws, '.agent-workflow');
const diff = fs.readFileSync(path.join(rd, 'diff_under_review.patch'), 'utf-8');
let verdict;
let summary;
if (diff.includes('first implementer change')) {
  verdict = 'changes_requested';
  summary = 'The first diff needs a replacement implementation.';
} else if (diff.includes('second implementer change')) {
  verdict = 'approved';
  summary = 'The second diff satisfies the requested change.';
} else {
  console.error('reviewer could not identify the diff under review');
  process.exit(21);
}
fs.writeFileSync(
  path.join(rd, 'review_verdict.json'),
  JSON.stringify({
    schema_version: 'agent-workflow/1',
    verdict,
    summary,
    comments: verdict === 'changes_requested'
      ? [{ severity: 'must_fix', comment: 'Replace the first implementation.' }]
      : []
  }, null, 2) + '\\n',
  'utf-8'
);
console.log('reviewer wrote ' + verdict);
process.exit(0);
`,
            "{{prompt_file}}",
          ],
        },
        capabilities: {
          outer_supervised: true,
          inner_tool_control: false,
          kinds: ["code_change"],
          roles: ["reviewer"],
        },
        cost_profile: {
          billing_unit: "call",
          estimated_cost_per_run_units: 1,
        },
      }),
    );

    const woPath = path.join(repoDir, "work_order_v1_review_changes_requested.json");
    fs.writeFileSync(
      woPath,
      JSON.stringify(
        {
          schema_version: "workflow/v1",
          task_id: "T-cli-v1-review-changes-requested",
          title: "CLI v1 Review Changes Requested Test",
          type: "code_change",
          goal: "Exercise the v1 CLI changes_requested requeue path with a reviewer.",
          acceptance_criteria: ["The second implementer change is reviewed and accepted."],
          repo: { path: repoDir, base_ref: "main" },
          verification: { commands: [SIMPLE_VERIFY_CMD] },
          agent: {
            required_capabilities: ["code_change"],
            implementer_pool: ["phase16-impl-a", "phase16-impl-b"],
            reviewer_pool: ["phase16-reviewer"],
            exclude_agent_ids: [],
          },
          review: { enabled: true, max_review_runs: 2 },
          budget: {
            max_wall_time_minutes: 5,
            max_total_cost_units: 10,
            max_runs: 4,
          },
        },
        null,
        2,
      ),
    );

    const args = parseArgs([
      "node",
      "agentflow",
      "run",
      woPath,
      "--agents",
      agentsDir,
      "--database",
      databasePath,
    ]);

    const result = await runCli(args);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("Task: T-cli-v1-review-changes-requested");
    expect(result.message).toContain("Final task status: accepted");
    expect(result.message).toContain("Attempts: 4");

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(databasePath);
    const task = db
      .prepare("select status, attempts, workorder_json from task_queue where task_id = ?")
      .get("T-cli-v1-review-changes-requested") as {
      status: string;
      attempts: number;
      workorder_json: string;
    };
    expect(task.status).toBe("accepted");
    expect(task.attempts).toBe(4);

    const runs = db
      .prepare("select id, agent_id, role, status, handoff_packet_uri from agent_runs where task_id = ? order by rowid asc")
      .all("T-cli-v1-review-changes-requested") as Array<{
      id: string;
      agent_id: string;
      role: string;
      status: string;
      handoff_packet_uri: string | null;
    }>;
    const implementerRuns = runs.filter((run) => run.role === "implementer");
    const reviewerRuns = runs.filter((run) => run.role === "reviewer");
    expect(implementerRuns).toHaveLength(2);
    expect(reviewerRuns).toHaveLength(2);
    expect(implementerRuns.map((run) => run.agent_id)).toEqual([
      "phase16-impl-a",
      "phase16-impl-b",
    ]);
    expect(implementerRuns[0].agent_id).not.toBe(implementerRuns[1].agent_id);
    expect(implementerRuns[1].handoff_packet_uri).toEqual(
      expect.stringContaining("handoff_packet.json"),
    );
    expect(reviewerRuns.every((run) => run.status === "succeeded")).toBe(true);

    const reviewCompletedRows = db
      .prepare("select run_id, payload_json from task_events where task_id = ? and event_type = 'review.completed' order by rowid asc")
      .all("T-cli-v1-review-changes-requested") as Array<{
      run_id: string;
      payload_json: string;
    }>;
    expect(reviewCompletedRows).toHaveLength(2);
    const reviewPayloads = reviewCompletedRows.map((row) => JSON.parse(row.payload_json) as {
      verdict: string;
      verdict_uri: string;
    });
    expect(reviewPayloads.map((payload) => payload.verdict)).toEqual([
      "changes_requested",
      "approved",
    ]);
    expect(reviewCompletedRows[0].run_id).toBe(reviewerRuns[0].id);
    expect(reviewCompletedRows[1].run_id).toBe(reviewerRuns[1].id);
    expect(reviewCompletedRows[1].run_id).not.toBe(reviewCompletedRows[0].run_id);

    const handoffRows = db
      .prepare("select payload_json from task_events where task_id = ? and event_type = 'handoff.requested'")
      .all("T-cli-v1-review-changes-requested") as Array<{ payload_json: string }>;
    expect(handoffRows.length).toBeGreaterThanOrEqual(1);
    expect(handoffRows.map((row) => JSON.parse(row.payload_json))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "review_changes_requested",
          exclude_agent_ids: expect.arrayContaining(["phase16-impl-a"]),
        }),
      ]),
    );

    const persistedWorkOrder = JSON.parse(task.workorder_json) as {
      agent: { exclude_agent_ids: string[] };
    };
    expect(persistedWorkOrder.agent.exclude_agent_ids).toContain("phase16-impl-a");
    db.close();
  });

  it("v1 review enabled: reviewer diff_apply_failed requeues to a different implementer and fresh reviewer", async () => {
    const taskId = "T-cli-v1-review-diff-apply-failed";
    fs.writeFileSync(path.join(repoDir, "review-fallback-target.txt"), "base\n", "utf-8");
    fs.writeFileSync(path.join(repoDir, "binary-target.bin"), Buffer.from([0, 1, 2, 3, 0, 4, 5]));
    git(["add", "review-fallback-target.txt", "binary-target.bin"], repoDir);
    git(["commit", "-m", "add diff apply failure targets"], repoDir);

    const agentsDir = path.join(repoDir, "agents-review-diff-apply-failed");
    fs.mkdirSync(agentsDir, { recursive: true });

    fs.writeFileSync(
      path.join(agentsDir, "implementer-a.json"),
      JSON.stringify({
        schema_version: "workflow/v1",
        agent_id: "phase18-impl-a",
        integration_mode: "official_cli",
        command: {
          executable: EXEC,
          args: [
            "-e",
            `
const fs = require('fs');
const path = require('path');
const ws = process.cwd();
fs.writeFileSync(path.join(ws, 'binary-target.bin'), Buffer.from([0, 9, 2, 3, 0, 4, 5, 6]));
const rd = path.join(ws, '.agent-workflow');
fs.mkdirSync(rd, { recursive: true });
fs.writeFileSync(path.join(rd, 'final_report.md'), '# First Implementer Report\\n\\nChanged a tracked binary file so plain git diff cannot be applied by the reviewer.', 'utf-8');
console.log('first implementer complete');
process.exit(0);
`,
            "{{prompt_file}}",
          ],
        },
        capabilities: {
          outer_supervised: true,
          inner_tool_control: false,
          kinds: ["code_change"],
          roles: ["implementer"],
        },
        cost_profile: {
          billing_unit: "call",
          estimated_cost_per_run_units: 1,
        },
      }),
    );

    fs.writeFileSync(
      path.join(agentsDir, "implementer-b.json"),
      JSON.stringify({
        schema_version: "workflow/v1",
        agent_id: "phase18-impl-b",
        integration_mode: "official_cli",
        command: {
          executable: EXEC,
          args: [
            "-e",
            `
const fs = require('fs');
const path = require('path');
const ws = process.cwd();
const rd = path.join(ws, '.agent-workflow');
const handoffPath = path.join(rd, 'handoff_packet.json');
if (!fs.existsSync(handoffPath)) {
  console.error('missing handoff packet');
  process.exit(11);
}
const handoff = fs.readFileSync(handoffPath, 'utf-8');
if (!handoff.includes('diff_apply_failed') || !handoff.includes('phase18-impl-a')) {
  console.error('handoff packet did not identify the first implementer diff apply failure');
  process.exit(12);
}
const prompt = fs.readFileSync(path.join(rd, 'prompt.md'), 'utf-8');
if (!prompt.includes('diff_apply_failed') || !prompt.includes('phase18-impl-a')) {
  console.error('prompt did not include diff apply failure handoff text');
  process.exit(13);
}
fs.writeFileSync(path.join(ws, 'review-fallback-target.txt'), 'base\\nsecond implementer text change\\n', 'utf-8');
fs.writeFileSync(path.join(rd, 'final_report.md'), '# Second Implementer Report\\n\\nMade a replacement text change after the binary diff could not be applied.', 'utf-8');
console.log('second implementer complete');
process.exit(0);
`,
            "{{prompt_file}}",
          ],
        },
        capabilities: {
          outer_supervised: true,
          inner_tool_control: false,
          kinds: ["code_change"],
          roles: ["implementer"],
        },
        cost_profile: {
          billing_unit: "call",
          estimated_cost_per_run_units: 1,
        },
      }),
    );

    fs.writeFileSync(
      path.join(agentsDir, "reviewer.json"),
      JSON.stringify({
        schema_version: "workflow/v1",
        agent_id: "phase18-reviewer",
        integration_mode: "official_cli",
        command: {
          executable: EXEC,
          args: [
            "-e",
            `
const fs = require('fs');
const path = require('path');
const ws = process.cwd();
const rd = path.join(ws, '.agent-workflow');
const diffPath = path.join(rd, 'diff_under_review.patch');
if (!fs.existsSync(diffPath)) {
  console.error('reviewer launched before a diff_under_review patch was available');
  process.exit(21);
}
const diff = fs.readFileSync(diffPath, 'utf-8');
if (diff.includes('binary-target.bin') || diff.includes('Binary files')) {
  console.error('reviewer launched for a diff that should have failed git apply first');
  process.exit(22);
}
if (!diff.includes('second implementer text change')) {
  console.error('reviewer did not receive the second implementer diff');
  process.exit(23);
}
fs.writeFileSync(
  path.join(rd, 'review_verdict.json'),
  JSON.stringify({
    schema_version: 'agent-workflow/1',
    verdict: 'approved',
    summary: 'The replacement text diff is approved after the binary diff apply failure.',
    comments: []
  }, null, 2) + '\\n',
  'utf-8'
);
console.log('reviewer approved replacement diff');
process.exit(0);
`,
            "{{prompt_file}}",
          ],
        },
        capabilities: {
          outer_supervised: true,
          inner_tool_control: false,
          kinds: ["code_change"],
          roles: ["reviewer"],
        },
        cost_profile: {
          billing_unit: "call",
          estimated_cost_per_run_units: 1,
        },
      }),
    );

    const woPath = path.join(repoDir, "work_order_v1_review_diff_apply_failed.json");
    fs.writeFileSync(
      woPath,
      JSON.stringify(
        {
          schema_version: "workflow/v1",
          task_id: taskId,
          title: "CLI v1 Reviewer Diff Apply Failed Test",
          type: "code_change",
          goal: "Exercise the v1 CLI reviewer diff_apply_failed requeue path.",
          acceptance_criteria: ["The second implementer change is reviewed and accepted."],
          repo: { path: repoDir, base_ref: "main" },
          verification: { commands: [SIMPLE_VERIFY_CMD] },
          agent: {
            required_capabilities: ["code_change"],
            implementer_pool: ["phase18-impl-a", "phase18-impl-b"],
            reviewer_pool: ["phase18-reviewer"],
            exclude_agent_ids: [],
          },
          review: { enabled: true, max_review_runs: 2 },
          budget: {
            max_wall_time_minutes: 5,
            max_total_cost_units: 10,
            max_runs: 4,
          },
        },
        null,
        2,
      ),
    );

    const args = parseArgs([
      "node",
      "agentflow",
      "run",
      woPath,
      "--agents",
      agentsDir,
      "--database",
      databasePath,
    ]);

    const result = await runCli(args);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain(`Task: ${taskId}`);
    expect(result.message).toContain("Final task status: accepted");

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(databasePath);
    const task = db
      .prepare("select status, attempts, workorder_json from task_queue where task_id = ?")
      .get(taskId) as {
      status: string;
      attempts: number;
      workorder_json: string;
    };
    expect(task.status).toBe("accepted");
    expect(task.attempts).toBe(4);

    const runs = db
      .prepare("select id, agent_id, role, status from agent_runs where task_id = ? order by rowid asc")
      .all(taskId) as Array<{
      id: string;
      agent_id: string;
      role: string;
      status: string;
    }>;
    const implementerRuns = runs.filter((run) => run.role === "implementer");
    const reviewerRuns = runs.filter((run) => run.role === "reviewer");
    expect(implementerRuns).toHaveLength(2);
    expect(reviewerRuns).toHaveLength(2);
    expect(implementerRuns.map((run) => run.agent_id)).toEqual([
      "phase18-impl-a",
      "phase18-impl-b",
    ]);
    expect(reviewerRuns.map((run) => run.agent_id)).toEqual([
      "phase18-reviewer",
      "phase18-reviewer",
    ]);
    expect(reviewerRuns[0]).toMatchObject({
      agent_id: "phase18-reviewer",
      role: "reviewer",
      status: "failed",
    });
    expect(reviewerRuns[1]).toMatchObject({
      agent_id: "phase18-reviewer",
      role: "reviewer",
      status: "succeeded",
    });

    const firstReviewerFailedRows = db
      .prepare("select rowid, payload_json from task_events where task_id = ? and run_id = ? and event_type = 'run.failed'")
      .all(taskId, reviewerRuns[0].id) as Array<{
      rowid: number;
      payload_json: string;
    }>;
    expect(firstReviewerFailedRows).toHaveLength(1);
    expect(JSON.parse(firstReviewerFailedRows[0].payload_json)).toMatchObject({
      reason: "diff_apply_failed",
    });

    const forbiddenFirstReviewerEvents = db
      .prepare(
        "select event_type from task_events where task_id = ? and run_id = ? and event_type in ('review.requested', 'agent.spawned', 'review.completed')",
      )
      .all(taskId, reviewerRuns[0].id) as Array<{ event_type: string }>;
    expect(forbiddenFirstReviewerEvents).toEqual([]);

    const firstReviewerArtifacts = db
      .prepare("select kind, uri, path from artifacts where task_id = ? and run_id = ? order by rowid asc")
      .all(taskId, reviewerRuns[0].id) as Array<{
      kind: string;
      uri: string;
      path: string;
    }>;
    const applyStdoutArtifact = firstReviewerArtifacts.find(
      (artifact) =>
        artifact.kind === "stdout_tail" &&
        path.basename(artifact.path) === "git_apply_stdout.txt",
    );
    const applyStderrArtifact = firstReviewerArtifacts.find(
      (artifact) =>
        artifact.kind === "stderr_tail" &&
        path.basename(artifact.path) === "git_apply_stderr.txt",
    );
    const failedDiffArtifact = firstReviewerArtifacts.find(
      (artifact) =>
        artifact.kind === "diff" &&
        path.basename(artifact.path) === "diff_under_review.patch",
    );
    expect(applyStdoutArtifact).toBeDefined();
    expect(applyStderrArtifact).toBeDefined();
    expect(failedDiffArtifact).toBeDefined();
    expect(fs.existsSync(applyStdoutArtifact!.path)).toBe(true);
    expect(fs.readFileSync(applyStderrArtifact!.path, "utf-8")).toMatch(/patch/i);
    const failedDiff = fs.readFileSync(failedDiffArtifact!.path, "utf-8");
    expect(failedDiff).toContain("binary-target.bin");
    expect(failedDiff).toContain("Binary files");

    const firstReviewerEdgeRows = db
      .prepare("select rowid, payload_json from task_events where task_id = ? and run_id = ? and event_type = 'task.edge_selected'")
      .all(taskId, reviewerRuns[0].id) as Array<{
      rowid: number;
      payload_json: string;
    }>;
    expect(firstReviewerEdgeRows).toHaveLength(1);
    expect(JSON.parse(firstReviewerEdgeRows[0].payload_json)).toMatchObject({
      from: "reviewing",
      to: "requeued",
      reason: "diff_apply_failed",
    });

    const handoffRows = db
      .prepare("select rowid, run_id, payload_json from task_events where task_id = ? and event_type = 'handoff.requested' order by rowid asc")
      .all(taskId) as Array<{
      rowid: number;
      run_id: string;
      payload_json: string;
    }>;
    expect(handoffRows).toHaveLength(1);
    expect(handoffRows[0].run_id).toBe(reviewerRuns[0].id);
    const handoffPayload = JSON.parse(handoffRows[0].payload_json) as {
      reason?: string;
      exclude_agent_ids?: string[];
    };
    expect(handoffPayload.reason).toBe("diff_apply_failed");
    expect(handoffPayload.exclude_agent_ids).toContain("phase18-impl-a");
    expect(handoffPayload.exclude_agent_ids).not.toContain("phase18-reviewer");

    const requeueRows = db
      .prepare("select rowid, run_id, payload_json from task_events where task_id = ? and event_type = 'task.requeued' order by rowid asc")
      .all(taskId) as Array<{
      rowid: number;
      run_id: string;
      payload_json: string;
    }>;
    const diffApplyRequeueRows = requeueRows.filter((row) => {
      const payload = JSON.parse(row.payload_json) as { reason?: string };
      return payload.reason === "diff_apply_failed";
    });
    expect(diffApplyRequeueRows).toHaveLength(1);
    expect(diffApplyRequeueRows[0].run_id).toBe(reviewerRuns[0].id);
    expect(diffApplyRequeueRows[0].rowid).toBeGreaterThan(firstReviewerFailedRows[0].rowid);
    expect(JSON.parse(diffApplyRequeueRows[0].payload_json)).toMatchObject({
      reason: "diff_apply_failed",
      next_role: "implementer",
    });

    const persistedWorkOrder = JSON.parse(task.workorder_json) as {
      agent: { exclude_agent_ids: string[] };
    };
    expect(persistedWorkOrder.agent.exclude_agent_ids).toContain("phase18-impl-a");
    expect(persistedWorkOrder.agent.exclude_agent_ids).not.toContain("phase18-reviewer");

    const firstReviewerMetricsCount = (
      db
        .prepare("select count(*) as c from agent_metrics where run_id = ?")
        .get(reviewerRuns[0].id) as { c: number }
    ).c;
    expect(firstReviewerMetricsCount).toBe(0);

    const reviewCompletedRows = db
      .prepare("select run_id, payload_json from task_events where task_id = ? and event_type = 'review.completed' order by rowid asc")
      .all(taskId) as Array<{
      run_id: string;
      payload_json: string;
    }>;
    expect(reviewCompletedRows).toHaveLength(1);
    expect(reviewCompletedRows[0].run_id).toBe(reviewerRuns[1].id);
    expect(JSON.parse(reviewCompletedRows[0].payload_json)).toMatchObject({
      verdict: "approved",
    });
    db.close();
  });

  it("batch interrupted by SIGINT returns 130 without accepted or failed summaries", async () => {
    const agentsDir = path.join(repoDir, "agents-batch-interrupted");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "slow-implementer.json"),
      JSON.stringify({
        schema_version: "workflow/v1",
        agent_id: "fake-batch-slow-implementer",
        integration_mode: "official_cli",
        command: {
          executable: EXEC,
          args: [
            "-e",
            `
setTimeout(() => process.exit(0), 30000);
`,
            "{{prompt_file}}",
          ],
        },
        capabilities: {
          outer_supervised: true,
          inner_tool_control: false,
          kinds: ["code_change"],
          roles: ["implementer"],
        },
        cost_profile: {
          billing_unit: "call",
          estimated_cost_per_run_units: 1,
        },
      }),
    );

    const workOrdersDir = path.join(repoDir, "work-orders-interrupted");
    fs.mkdirSync(workOrdersDir, { recursive: true });
    for (const suffix of ["a", "b"]) {
      fs.writeFileSync(
        path.join(workOrdersDir, `${suffix}.json`),
        JSON.stringify(
          {
            schema_version: "workflow/v1",
            task_id: `T-batch-interrupted-${suffix}`,
            title: `Interrupted batch ${suffix}`,
            type: "code_change",
            goal: `Exercise SIGINT interruption for batch task ${suffix}.`,
            acceptance_criteria: ["The batch is interrupted."],
            repo: { path: repoDir, base_ref: "main" },
            verification: { commands: [SIMPLE_VERIFY_CMD] },
            agent: {
              required_capabilities: ["code_change"],
              implementer_pool: ["fake-batch-slow-implementer"],
              reviewer_pool: [],
              exclude_agent_ids: [],
            },
            review: { enabled: false, max_review_runs: 0 },
            budget: {
              max_wall_time_minutes: 5,
              max_total_cost_units: 10,
              max_runs: 2,
            },
          },
          null,
          2,
        ),
      );
    }

    const args = parseArgs([
      "node",
      "agentflow",
      "batch",
      workOrdersDir,
      "--agents",
      agentsDir,
      "--workers",
      "2",
      "--database",
      databasePath,
    ]);

    const interruptedTaskIds = ["T-batch-interrupted-a", "T-batch-interrupted-b"];
    const signalSource = new ManualSigintSignalSource();
    const resultPromise = runCli(args, {
      signalSource,
      sigintGraceMs: 5,
    });
    const startedRuns = await waitForRunningAgentRuns({
      databasePath,
      taskIds: interruptedTaskIds,
      expectedCount: 2,
    });

    signalSource.trigger();
    const result = await resultPromise;

    expect(result.exitCode).toBe(130);
    expect(result.message).toContain("v1 orchestration interrupted");
    expect(result.message).not.toContain(" | Status: accepted");
    expect(result.message).not.toContain(" | Status: failed");

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(databasePath);
    const taskRows = db
      .prepare("select task_id, status from task_queue where task_id like 'T-batch-interrupted-%' order by task_id asc")
      .all() as Array<{
      task_id: string;
      status: string;
    }>;
    expect(taskRows).toHaveLength(2);
    for (const task of taskRows) {
      expect(["accepted", "failed", "awaiting_human"]).not.toContain(task.status);
    }

    const runRows = db
      .prepare(
        "select id, task_id, status, ended_at from agent_runs where task_id like 'T-batch-interrupted-%' order by task_id asc, rowid asc",
      )
      .all() as Array<{
      id: string;
      task_id: string;
      status: string;
      ended_at: string | null;
    }>;
    expect(runRows.map((run) => run.id)).toEqual(startedRuns.map((run) => run.id));
    for (const run of runRows) {
      expect(run.status).toBe("cancelled");
      expect(run.status).not.toBe("running");
      expect(run.ended_at).toEqual(expect.any(String));
    }

    const misleadingEvents = db
      .prepare(
        "select event_type from task_events where task_id like 'T-batch-interrupted-%' and event_type in ('task.completed', 'task.failed', 'task.awaiting_human', 'run.cleaned_up')",
      )
      .all() as Array<{ event_type: string }>;
    expect(misleadingEvents).toEqual([]);
    db.close();
  });

  it("batch: two v1 workorders loaded from an agents directory reach accepted with two workers", async () => {
    const agentsDir = path.join(repoDir, "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "fake-implementer.json"),
      JSON.stringify({
        schema_version: "workflow/v1",
        agent_id: "fake-batch-implementer",
        integration_mode: "official_cli",
        command: {
          executable: EXEC,
          args: [
            "-e",
            `
const fs = require('fs');
const path = require('path');
const ws = process.cwd();
const marker = path.join(ws, 'batch-output.txt');
fs.writeFileSync(marker, 'batch task complete\\n', 'utf-8');
console.log('fake batch stdout');
console.error('fake batch stderr');
const rd = path.join(ws, '.agent-workflow');
fs.mkdirSync(rd, { recursive: true });
fs.writeFileSync(path.join(rd, 'final_report.md'), '# Batch Report\\n\\nDone.', 'utf-8');
process.exit(0);
`,
            "{{prompt_file}}",
          ],
        },
        capabilities: {
          outer_supervised: true,
          inner_tool_control: false,
          kinds: ["code_change"],
          roles: ["implementer"],
        },
        cost_profile: {
          billing_unit: "call",
          estimated_cost_per_run_units: 1,
        },
      }),
    );

    const workOrdersDir = path.join(repoDir, "work-orders");
    fs.mkdirSync(workOrdersDir, { recursive: true });
    const batchInputs = [
      { fileName: "01-b.json", suffix: "b" },
      { fileName: "02-a.json", suffix: "a" },
    ];
    for (const input of batchInputs) {
      fs.writeFileSync(
        path.join(workOrdersDir, input.fileName),
        JSON.stringify(
          {
            schema_version: "workflow/v1",
            task_id: `T-batch-${input.suffix}`,
            title: `Batch ${input.suffix}`,
            type: "code_change",
            goal: `Run batch task ${input.suffix}.`,
            acceptance_criteria: ["Task reaches accepted."],
            repo: { path: repoDir, base_ref: "main" },
            verification: { commands: [SIMPLE_VERIFY_CMD] },
            agent: {
              required_capabilities: ["code_change"],
              implementer_pool: ["fake-batch-implementer"],
              reviewer_pool: [],
              exclude_agent_ids: [],
            },
            review: { enabled: false, max_review_runs: 0 },
            budget: {
              max_wall_time_minutes: 5,
              max_total_cost_units: 10,
              max_runs: 2,
            },
          },
          null,
          2,
        ),
      );
    }

    const args = parseArgs([
      "node",
      "agentflow",
      "batch",
      workOrdersDir,
      "--agents",
      agentsDir,
      "--workers",
      "2",
      "--database",
      databasePath,
    ]);

    const result = await runCli(args);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("Task: T-batch-a | Status: accepted | Attempts: 1");
    expect(result.message).toContain("Task: T-batch-b | Status: accepted | Attempts: 1");
    expect(result.message).toContain(`Database: ${databasePath}`);

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(databasePath);
    const accepted = (
      db.prepare("select count(*) as c from task_queue where status = 'accepted'").get() as {
        c: number;
      }
    ).c;
    expect(accepted).toBe(2);

    const enqueued = (
      db.prepare("select count(*) as c from task_events where event_type = 'task.enqueued'").get() as {
        c: number;
      }
    ).c;
    expect(enqueued).toBe(2);

    const taskRows = db.prepare("select task_id, attempts from task_queue order by task_id asc").all() as Array<{
      task_id: string;
      attempts: number;
    }>;
    expect(taskRows).toEqual([
      { task_id: "T-batch-a", attempts: 1 },
      { task_id: "T-batch-b", attempts: 1 },
    ]);

    const cleanedUpRows = db
      .prepare("select task_id, run_id, agent_id, payload_json from task_events where event_type = 'run.cleaned_up' order by rowid asc")
      .all() as Array<{
      task_id: string;
      run_id: string;
      agent_id: string;
      payload_json: string;
    }>;
    expect(cleanedUpRows.map((row) => row.task_id)).toEqual([
      "T-batch-a",
      "T-batch-b",
    ]);
    expect(cleanedUpRows).toEqual([
      expect.objectContaining({
        task_id: "T-batch-a",
        agent_id: "fake-batch-implementer",
        payload_json: "{}",
      }),
      expect.objectContaining({
        task_id: "T-batch-b",
        agent_id: "fake-batch-implementer",
        payload_json: "{}",
      }),
    ]);

    const runRows = db
      .prepare("select task_id, id, workspace_path from agent_runs where task_id in ('T-batch-a', 'T-batch-b') order by task_id asc")
      .all() as Array<{
      task_id: string;
      id: string;
      workspace_path: string;
    }>;
    expect(runRows).toHaveLength(2);
    for (const run of runRows) {
      expect(cleanedUpRows.map((row) => row.run_id)).toContain(run.id);
      expect(fs.existsSync(run.workspace_path)).toBe(false);
    }
    db.close();
  });

  it("batch waits for current task ids when the database already has terminal rows", async () => {
    const agentsDir = path.join(repoDir, "agents-scoped");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "fake-implementer.json"),
      JSON.stringify({
        schema_version: "workflow/v1",
        agent_id: "fake-scoped-batch-implementer",
        integration_mode: "official_cli",
        command: {
          executable: EXEC,
          args: [
            "-e",
            `
const fs = require('fs');
const path = require('path');
const ws = process.cwd();
fs.writeFileSync(path.join(ws, 'scoped-batch-output.txt'), 'batch task complete\\n', 'utf-8');
const rd = path.join(ws, '.agent-workflow');
fs.mkdirSync(rd, { recursive: true });
fs.writeFileSync(path.join(rd, 'final_report.md'), '# Scoped Batch Report\\n\\nDone.', 'utf-8');
process.exit(0);
`,
            "{{prompt_file}}",
          ],
        },
        capabilities: {
          outer_supervised: true,
          inner_tool_control: false,
          kinds: ["code_change"],
          roles: ["implementer"],
        },
        cost_profile: {
          billing_unit: "call",
          estimated_cost_per_run_units: 1,
        },
      }),
    );

    seedAcceptedTaskQueueRows(databasePath, [
      "T-old-terminal-a",
      "T-old-terminal-b",
    ]);

    const workOrdersDir = path.join(repoDir, "work-orders-scoped");
    fs.mkdirSync(workOrdersDir, { recursive: true });
    for (const suffix of ["a", "b"]) {
      fs.writeFileSync(
        path.join(workOrdersDir, `${suffix}.json`),
        JSON.stringify(
          {
            schema_version: "workflow/v1",
            task_id: `T-scoped-batch-${suffix}`,
            title: `Scoped batch ${suffix}`,
            type: "code_change",
            goal: `Run scoped batch task ${suffix}.`,
            acceptance_criteria: ["Task reaches accepted."],
            repo: { path: repoDir, base_ref: "main" },
            verification: { commands: [SIMPLE_VERIFY_CMD] },
            agent: {
              required_capabilities: ["code_change"],
              implementer_pool: ["fake-scoped-batch-implementer"],
              reviewer_pool: [],
              exclude_agent_ids: [],
            },
            review: { enabled: false, max_review_runs: 0 },
            budget: {
              max_wall_time_minutes: 5,
              max_total_cost_units: 10,
              max_runs: 2,
            },
          },
          null,
          2,
        ),
      );
    }

    const args = parseArgs([
      "node",
      "agentflow",
      "batch",
      workOrdersDir,
      "--agents",
      agentsDir,
      "--workers",
      "1",
      "--database",
      databasePath,
    ]);

    const result = await runCli(args);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("Task: T-scoped-batch-a | Status: accepted | Attempts: 1");
    expect(result.message).toContain("Task: T-scoped-batch-b | Status: accepted | Attempts: 1");

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(databasePath);
    const taskRows = db
      .prepare(
        "select task_id, status, attempts from task_queue where task_id like 'T-scoped-batch-%' order by task_id asc",
      )
      .all() as Array<{
      task_id: string;
      status: string;
      attempts: number;
    }>;
    expect(taskRows).toEqual([
      { task_id: "T-scoped-batch-a", status: "accepted", attempts: 1 },
      { task_id: "T-scoped-batch-b", status: "accepted", attempts: 1 },
    ]);

    const oldTerminalRows = (
      db
        .prepare(
          "select count(*) as c from task_queue where task_id like 'T-old-terminal-%' and status = 'accepted'",
        )
        .get() as { c: number }
    ).c;
    expect(oldTerminalRows).toBe(2);
    db.close();
  });
});
