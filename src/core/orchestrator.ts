import * as fs from "node:fs";
import * as path from "node:path";
import type { Database } from "../storage/database.js";
import { openDatabase } from "../storage/database.js";
import { migrate } from "../storage/migrations.js";
import { SqliteEventLog } from "../storage/event-log.js";
import { SqliteRunStore, type RunRecord } from "../storage/run-store.js";
import { LocalArtifactStore } from "../storage/artifact-store.js";
import {
  GitWorktreeSandboxProvider,
  type SandboxProvider,
} from "../workspace/sandbox-provider.js";
import { FileTaskCapsuleWriter } from "../workspace/task-capsule-writer.js";
import { ChildProcessOfficialCliAdapter } from "../adapters/official-cli-adapter.js";
import { ShellVerificationRunner } from "../verification/verification-runner.js";
import { generateRunId, generateEventId, sha256hex } from "./ids.js";
import type { ParsedWorkOrder, ParsedAgentProfile } from "./schemas.js";
import type { ArtifactRef, RunManifest, EventEnvelope } from "./types.js";

export interface RunWorkOrderResult {
  projectId: string;
  taskId: string;
  runId: string;
  status: "succeeded" | "failed";
  workspacePath: string;
  artifacts: ArtifactRef[];
  verificationPassed: boolean;
}

interface OrchestratorServices {
  eventLog: SqliteEventLog;
  runStore: SqliteRunStore;
  artifactStore: LocalArtifactStore;
  sandboxProvider: SandboxProvider;
  capsuleWriter: FileTaskCapsuleWriter;
  adapter: ChildProcessOfficialCliAdapter;
  verifier: ShellVerificationRunner;
}

function makeServices(db: Database, repoPath: string): OrchestratorServices {
  return {
    eventLog: new SqliteEventLog(db),
    runStore: new SqliteRunStore(db),
    artifactStore: new LocalArtifactStore(db, repoPath),
    sandboxProvider: new GitWorktreeSandboxProvider(),
    capsuleWriter: new FileTaskCapsuleWriter(),
    adapter: new ChildProcessOfficialCliAdapter(),
    verifier: new ShellVerificationRunner(),
  };
}

function makeEvent(
  type: string,
  projectId: string,
  taskId: string,
  runId: string | undefined,
  agentId: string | undefined,
  payload: Record<string, unknown>,
): EventEnvelope {
  return {
    event_id: generateEventId(),
    event_type: type,
    project_id: projectId,
    task_id: taskId,
    run_id: runId,
    agent_id: agentId,
    payload,
    created_at: new Date().toISOString(),
  };
}

async function tryCatch<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

export async function runWorkOrder(args: {
  workOrder: ParsedWorkOrder;
  agentProfile: ParsedAgentProfile;
  databasePath?: string;
}): Promise<RunWorkOrderResult> {
  const wo = args.workOrder;
  const profile = args.agentProfile;

  const dbPath =
    args.databasePath ??
    path.join(wo.repo.path, ".agentflow", "agentflow.sqlite");

  const dbDir = path.dirname(dbPath);
  fs.mkdirSync(dbDir, { recursive: true });

  const db = openDatabase(dbPath);
  migrate(db);

  const svc = makeServices(db, wo.repo.path);

  return runWorkOrderWithServices({
    workOrder: wo,
    agentProfile: profile,
    databasePath: args.databasePath,
    services: svc,
    db,
  });
}

export async function runWorkOrderWithServices(args: {
  workOrder: ParsedWorkOrder;
  agentProfile: ParsedAgentProfile;
  databasePath?: string;
  services: OrchestratorServices;
  db: Database;
}): Promise<RunWorkOrderResult> {
  const wo = args.workOrder;
  const profile = args.agentProfile;
  const svc = args.services;
  const db = args.db;

  const projectId = wo.project_id;
  const taskId = wo.task_id;
  const runId = generateRunId();
  const startedAt = new Date().toISOString();

  const artifacts: ArtifactRef[] = [];
  let verificationPassed = false;
  let finalStatus: "succeeded" | "failed" = "failed";

  function append(type: string, payload: Record<string, unknown> = {}): void {
    svc.eventLog.append(
      makeEvent(type, projectId, taskId, runId, profile.agent_id, payload),
    );
  }

  try {
    // 1. task.created
    append("task.created", { task_id: taskId });

    // 2. Create run row
    const runRecord: RunRecord = {
      id: runId,
      project_id: projectId,
      task_id: taskId,
      agent_id: profile.agent_id,
      status: "preparing",
    };
    svc.runStore.create(runRecord);

    // 3. run.created
    append("run.created");

    // 4. Prepare git worktree
    const worktree = svc.sandboxProvider.prepareWorkspace({
      repoPath: wo.repo.path,
      baseRef: wo.repo.base_ref,
      taskId,
      runId,
    });

    // 5. Construct RunManifest
    const workOrderJson = JSON.stringify(wo);
    const manifest: RunManifest = {
      schema_version: "agent-workflow/1",
      run_id: runId,
      task_id: taskId,
      project_id: projectId,
      agent_id: profile.agent_id,
      integration_mode: "official_cli",
      workspace_uri: `file://${worktree.workspacePath}`,
      base_commit: worktree.baseCommit,
      branch: worktree.branchName,
      work_order_hash: `sha256:${sha256hex(workOrderJson)}`,
      adapter_version: "0.1.0",
      started_at: startedAt,
      ended_at: null,
      status: "preparing",
    };

    // 6. Write task capsule
    const capsule = svc.capsuleWriter.write({
      workspacePath: worktree.workspacePath,
      workOrder: wo,
      runManifest: manifest,
    });

    // 7. Save run_manifest.json as artifact
    const manifestArtifact = svc.artifactStore.saveFile({
      projectId,
      taskId,
      runId,
      kind: "task_capsule",
      sourcePath: capsule.runManifestPath,
      filename: "run_manifest.json",
      summary: "Run manifest",
    });
    artifacts.push(manifestArtifact);
    append("artifact.published", {
      artifact: { uri: manifestArtifact.uri, kind: manifestArtifact.kind },
    });

    // 8. Update run to running
    svc.runStore.updateStatus(runId, "running", {
      workspace_path: worktree.workspacePath,
      base_commit: worktree.baseCommit,
      branch_name: worktree.branchName,
      run_manifest_ref: manifestArtifact.uri,
      started_at: startedAt,
    });

    // 9. run.started
    append("run.started", {
      pid: null,
      command: `${profile.command.executable} ${profile.command.args.join(" ")}`,
      workspace_path: worktree.workspacePath,
      started_at: startedAt,
    });

    // 10. Run agent
    const timeoutMinutes = wo.budget?.max_wall_time_minutes;
    const timeoutSeconds = timeoutMinutes
      ? timeoutMinutes * 60
      : profile.limits?.timeout_seconds;

    const agentResult = await svc.adapter.run({
      agentProfile: profile,
      workspacePath: worktree.workspacePath,
      promptFile: capsule.promptPath,
      timeoutSeconds,
    });

    // 11. Collect artifacts from agent run
    // stdout tail
    const stdoutArtifact = svc.artifactStore.saveText({
      projectId,
      taskId,
      runId,
      kind: "stdout_tail",
      filename: "stdout.txt",
      content: agentResult.stdoutTail || "(empty)",
      summary: `${agentResult.stdoutBytes} bytes`,
    });
    artifacts.push(stdoutArtifact);
    append("artifact.published", {
      artifact: { uri: stdoutArtifact.uri, kind: stdoutArtifact.kind },
    });

    // stderr tail
    const stderrArtifact = svc.artifactStore.saveText({
      projectId,
      taskId,
      runId,
      kind: "stderr_tail",
      filename: "stderr.txt",
      content: agentResult.stderrTail || "(empty)",
      summary: `${agentResult.stderrBytes} bytes`,
    });
    artifacts.push(stderrArtifact);
    append("artifact.published", {
      artifact: { uri: stderrArtifact.uri, kind: stderrArtifact.kind },
    });

    // diff — always save, even if empty
    const diffContent = svc.sandboxProvider.diff({
      workspacePath: worktree.workspacePath,
    });
    const diffArtifact = svc.artifactStore.saveText({
      projectId,
      taskId,
      runId,
      kind: "diff",
      filename: "diff.patch",
      content: diffContent || "",
      summary: diffContent
        ? "Git diff of agent changes"
        : "Git diff of agent changes (empty)",
    });
    artifacts.push(diffArtifact);
    append("artifact.published", {
      artifact: { uri: diffArtifact.uri, kind: diffArtifact.kind },
    });

    // final_report.md
    const finalReportPath = path.join(
      worktree.workspacePath,
      ".agent-workflow",
      "final_report.md",
    );
    if (fs.existsSync(finalReportPath)) {
      const reportContent = fs.readFileSync(finalReportPath, "utf-8");
      if (reportContent.trim().length > 0) {
        const reportArtifact = svc.artifactStore.saveFile({
          projectId,
          taskId,
          runId,
          kind: "final_report",
          sourcePath: finalReportPath,
          filename: "final_report.md",
          summary: "Agent final report",
        });
        artifacts.push(reportArtifact);
        append("artifact.published", {
          artifact: { uri: reportArtifact.uri, kind: reportArtifact.kind },
        });
      }
    }

    // task capsule summary
    const capsuleArtifact = svc.artifactStore.saveText({
      projectId,
      taskId,
      runId,
      kind: "task_capsule",
      filename: "task-capsule.txt",
      content: `Task capsule at: ${capsule.capsulePath}\nWork order: ${capsule.workOrderPath}\nRun manifest: ${capsule.runManifestPath}\nPrompt: ${capsule.promptPath}`,
      summary: "Task capsule location",
    });
    artifacts.push(capsuleArtifact);
    append("artifact.published", {
      artifact: { uri: capsuleArtifact.uri, kind: capsuleArtifact.kind },
    });

    // 12. Insert agent_usage
    db.prepare(
      `insert into agent_usage (
        id, project_id, task_id, run_id, agent_id,
        wall_time_ms, exit_code, timed_out,
        stdout_bytes, stderr_bytes, created_at
      ) values (
        @id, @project_id, @task_id, @run_id, @agent_id,
        @wall_time_ms, @exit_code, @timed_out,
        @stdout_bytes, @stderr_bytes, @created_at
      )`,
    ).run({
      id: generateEventId(),
      project_id: projectId,
      task_id: taskId,
      run_id: runId,
      agent_id: profile.agent_id,
      wall_time_ms: agentResult.wallTimeMs,
      exit_code: agentResult.exitCode,
      timed_out: agentResult.timedOut ? 1 : 0,
      stdout_bytes: agentResult.stdoutBytes,
      stderr_bytes: agentResult.stderrBytes,
      created_at: new Date().toISOString(),
    });

    // 13. Verification
    const verificationCommands = wo.verification?.commands;
    if (verificationCommands && verificationCommands.length > 0) {
      append("verification.started", { commands: verificationCommands });

      const verifResult = await svc.verifier.run({
        workspacePath: worktree.workspacePath,
        commands: verificationCommands,
        timeoutSeconds: wo.verification?.timeout_seconds,
      });

      const verifOutput = verifResult.commandResults
        .map(
          (r) =>
            `$ ${r.command}\n[exit=${r.exitCode} timedOut=${r.timedOut} ${r.wallTimeMs}ms]\n${r.output}`,
        )
        .join("\n---\n");

      const verifArtifact = svc.artifactStore.saveText({
        projectId,
        taskId,
        runId,
        kind: "verification_output",
        filename: "verification.txt",
        content: verifOutput,
        summary: verifResult.passed ? "All passed" : "Verification failed",
      });
      artifacts.push(verifArtifact);
      append("artifact.published", {
        artifact: { uri: verifArtifact.uri, kind: verifArtifact.kind },
      });

      if (verifResult.passed) {
        append("verification.passed", {
          result: "passed",
          output_ref: verifArtifact.uri,
        });
      } else {
        append("verification.failed", {
          result: "failed",
          output_ref: verifArtifact.uri,
          failed_count: verifResult.commandResults.filter(
            (r) => r.exitCode !== 0 || r.timedOut,
          ).length,
        });
      }

      verificationPassed = verifResult.passed;
    } else {
      verificationPassed = true;
    }

    // 14. Determine final status
    if (
      agentResult.exitCode === 0 &&
      !agentResult.timedOut &&
      verificationPassed
    ) {
      finalStatus = "succeeded";
      svc.runStore.updateStatus(runId, "succeeded", {
        ended_at: new Date().toISOString(),
      });
      append("run.completed");
    } else {
      finalStatus = "failed";
      svc.runStore.updateStatus(runId, "failed", {
        ended_at: new Date().toISOString(),
      });
      const reason = agentResult.timedOut
        ? "agent_timed_out"
        : agentResult.exitCode !== 0
          ? "agent_nonzero_exit"
          : "verification_failed";
      append("run.failed", { reason });
    }

    return {
      projectId,
      taskId,
      runId,
      status: finalStatus,
      workspacePath: worktree.workspacePath,
      artifacts,
      verificationPassed,
    };
  } catch (err) {
    // Failure path: record what we can
    try {
      svc.runStore.updateStatus(runId, "failed", {
        ended_at: new Date().toISOString(),
      });
    } catch {
      // best effort
    }
    try {
      append("run.failed", {
        reason: "internal_error",
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // best effort
    }
    throw err;
  } finally {
    try {
      db.close();
    } catch {
      // best effort
    }
  }
}
