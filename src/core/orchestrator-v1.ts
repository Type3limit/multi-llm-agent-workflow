import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Database } from "../storage/database.js";
import type { EventLog } from "../storage/event-log.js";
import type { RunStore } from "../storage/run-store.js";
import type { ArtifactStore } from "../storage/artifact-store.js";
import type { GitWorktreeManager, PreparedWorktree } from "../workspace/git-worktree-manager.js";
import type { TaskCapsuleWriter, TaskCapsuleWriteResult } from "../workspace/task-capsule-writer.js";
import type { ReviewBriefWriter, ReviewBriefWriteResult } from "../workspace/review-brief-writer.js";
import type { OfficialCliAdapter, AgentProcessResult } from "../adapters/official-cli-adapter.js";
import type { VerificationRunner, VerificationResult } from "../verification/verification-runner.js";
import { parseReviewVerdict, type ReviewVerdictParseResult } from "../adapters/review-verdict-parser.js";
import type { ParsedAgentProfileV1, ParsedWorkOrderV1 } from "./schemas-v1.js";
import type {
  ArtifactRef,
  EventEnvelope,
  RunManifestV1,
  ScheduleDecision,
  TaskQueueEntry,
} from "./types.js";
import { generateEventId, generateRunId, sha256hex } from "./ids.js";

export type ImplementerFailureReason =
  | "agent_nonzero_exit"
  | "agent_timed_out"
  | "verification_failed"
  | "spawn_failed"
  | "internal_error";

export type ReviewerUnusableReason =
  | "reviewer_unusable"
  | "diff_apply_failed"
  | "agent_nonzero_exit"
  | "agent_timed_out"
  | "spawn_failed"
  | "internal_error";

export type RunOutcome =
  | {
      kind: "implementer_succeeded";
      runId: string;
      diffArtifactUri: string;
      verificationOutputUri?: string;
      finalReportUri?: string;
    }
  | {
      kind: "implementer_failed";
      runId: string;
      reason: ImplementerFailureReason;
      diffArtifactUri?: string;
      verificationOutputUri?: string;
      finalReportUri?: string;
    }
  | {
      kind: "reviewer_approved";
      runId: string;
      reviewVerdictUri: string;
    }
  | {
      kind: "reviewer_changes_requested";
      runId: string;
      reviewVerdictUri: string;
    }
  | {
      kind: "reviewer_rejected";
      runId: string;
      reviewVerdictUri: string;
    }
  | {
      kind: "reviewer_unusable";
      runId: string;
      reason: ReviewerUnusableReason;
      reviewVerdictUri?: string;
      stdoutArtifactUri?: string;
      stderrArtifactUri?: string;
    };

export interface V1RunTaskServices {
  eventLog: EventLog;
  runStore: RunStore;
  artifactStore: ArtifactStore;
  gitManager: GitWorktreeManager;
  taskCapsuleWriter: TaskCapsuleWriter;
  reviewBriefWriter: ReviewBriefWriter;
  adapter: OfficialCliAdapter;
  verifier: VerificationRunner;
  reviewVerdictParser?: typeof parseReviewVerdict;
  applyDiffToWorkspace?: (args: {
    workspacePath: string;
    diffText: string;
  }) =>
    | { ok: true; stdout: string; stderr: string }
    | { ok: false; stdout: string; stderr: string };
  now?: () => Date;
}

interface RunContext {
  runId: string;
  taskId: string;
  projectId: string;
  role: "implementer" | "reviewer";
  startedAt: string;
  worktree: PreparedWorktree;
  manifest: RunManifestV1;
  runManifestRef: string;
}

interface PublishedArtifacts {
  stdout?: ArtifactRef;
  stderr?: ArtifactRef;
  diff?: ArtifactRef;
  finalReport?: ArtifactRef;
  verification?: ArtifactRef;
  verdict?: ArtifactRef;
}

class RunContextCreationFailure extends Error {
  constructor(
    readonly details: {
      runId: string;
      taskId: string;
      projectId: string;
      role: "implementer" | "reviewer";
    },
  ) {
    super("Failed to create v1 run context.");
  }
}

function nowIso(services: V1RunTaskServices): string {
  return (services.now ?? (() => new Date()))().toISOString();
}

function makeEvent(args: {
  services: V1RunTaskServices;
  eventType: string;
  projectId: string;
  taskId: string;
  runId?: string;
  agentId?: string;
  payload?: Record<string, unknown>;
}): EventEnvelope {
  return {
    event_id: generateEventId(),
    event_type: args.eventType,
    project_id: args.projectId,
    task_id: args.taskId,
    run_id: args.runId,
    agent_id: args.agentId,
    payload: args.payload ?? {},
    created_at: nowIso(args.services),
  };
}

function appendEvent(args: {
  services: V1RunTaskServices;
  eventType: string;
  projectId: string;
  taskId: string;
  runId?: string;
  agentId?: string;
  payload?: Record<string, unknown>;
}): void {
  args.services.eventLog.append(makeEvent(args));
}

function publishArtifact(args: {
  services: V1RunTaskServices;
  projectId: string;
  taskId: string;
  runId: string;
  agentId: string;
  artifact: ArtifactRef;
}): ArtifactRef {
  appendEvent({
    services: args.services,
    eventType: "artifact.published",
    projectId: args.projectId,
    taskId: args.taskId,
    runId: args.runId,
    agentId: args.agentId,
    payload: {
      artifact: {
        uri: args.artifact.uri,
        kind: args.artifact.kind,
      },
    },
  });
  return args.artifact;
}

function saveTextArtifact(args: {
  services: V1RunTaskServices;
  projectId: string;
  taskId: string;
  runId: string;
  agentId: string;
  kind: ArtifactRef["kind"];
  filename: string;
  content: string;
  summary?: string;
}): ArtifactRef {
  const artifact = args.services.artifactStore.saveText({
    projectId: args.projectId,
    taskId: args.taskId,
    runId: args.runId,
    kind: args.kind,
    filename: args.filename,
    content: args.content,
    summary: args.summary,
  });
  return publishArtifact({ ...args, artifact });
}

function saveFileArtifact(args: {
  services: V1RunTaskServices;
  projectId: string;
  taskId: string;
  runId: string;
  agentId: string;
  kind: ArtifactRef["kind"];
  filename: string;
  sourcePath: string;
  summary?: string;
}): ArtifactRef {
  const artifact = args.services.artifactStore.saveFile({
    projectId: args.projectId,
    taskId: args.taskId,
    runId: args.runId,
    kind: args.kind,
    filename: args.filename,
    sourcePath: args.sourcePath,
    summary: args.summary,
  });
  return publishArtifact({ ...args, artifact });
}

function buildRunManifest(args: {
  workOrder: ParsedWorkOrderV1;
  agentProfile: ParsedAgentProfileV1;
  runId: string;
  role: "implementer" | "reviewer";
  worktree: PreparedWorktree;
  startedAt: string;
  parentRunId?: string;
  handoffPacketUri?: string;
}): RunManifestV1 {
  const workOrderJson = JSON.stringify(args.workOrder);
  return {
    schema_version: "agent-workflow/1",
    run_id: args.runId,
    task_id: args.workOrder.task_id,
    project_id: args.workOrder.project_id,
    agent_id: args.agentProfile.agent_id,
    integration_mode: "official_cli",
    role: args.role,
    workspace_uri: `file://${args.worktree.workspacePath}`,
    base_commit: args.worktree.baseCommit,
    branch: args.worktree.branchName,
    work_order_hash: `sha256:${sha256hex(workOrderJson)}`,
    adapter_version: "0.1.0",
    parent_run_id: args.parentRunId,
    handoff_packet_uri: args.handoffPacketUri,
    started_at: args.startedAt,
    ended_at: null,
    status: "preparing",
  };
}

function defaultApplyDiffToWorkspace(args: {
  workspacePath: string;
  diffText: string;
}): { ok: true; stdout: string; stderr: string } | { ok: false; stdout: string; stderr: string } {
  const result = spawnSync("git", ["apply", "--3way", "--whitespace=nowarn", "-"], {
    cwd: args.workspacePath,
    input: args.diffText,
    encoding: "utf-8",
  });

  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function agentFailureReason(result: AgentProcessResult): "agent_timed_out" | "agent_nonzero_exit" | undefined {
  if (result.timedOut) {
    return "agent_timed_out";
  }
  if (result.exitCode !== 0) {
    return "agent_nonzero_exit";
  }
  return undefined;
}

function verificationOutput(result: VerificationResult): string {
  return result.commandResults
    .map(
      (entry) =>
        `$ ${entry.command}\n[exit=${entry.exitCode} timedOut=${entry.timedOut} ${entry.wallTimeMs}ms]\n${entry.output}`,
    )
    .join("\n---\n");
}

async function createRunContext(args: {
  entry: TaskQueueEntry;
  decision: ScheduleDecision;
  agentProfile: ParsedAgentProfileV1;
  workOrder: ParsedWorkOrderV1;
  services: V1RunTaskServices;
  parentRunId?: string;
  handoffPacketUri?: string;
}): Promise<RunContext> {
  const { entry, agentProfile, workOrder, services } = args;
  const role = entry.next_role;
  const taskId = entry.task_id;
  const projectId = entry.project_id;
  const runId = generateRunId();
  const startedAt = nowIso(services);

  services.runStore.create({
    id: runId,
    project_id: projectId,
    task_id: taskId,
    agent_id: agentProfile.agent_id,
    status: "preparing",
    role,
    parent_run_id: args.parentRunId,
    handoff_packet_uri: args.handoffPacketUri,
  });

  appendEvent({
    services,
    eventType: "task.assigned",
    projectId,
    taskId,
    runId,
    agentId: agentProfile.agent_id,
    payload: { role },
  });
  appendEvent({
    services,
    eventType: "run.created",
    projectId,
    taskId,
    runId,
    agentId: agentProfile.agent_id,
  });

  try {
    const worktree = services.gitManager.prepare({
      repoPath: workOrder.repo.path,
      baseRef: workOrder.repo.base_ref,
      taskId,
      runId,
    });
    const manifest = buildRunManifest({
      workOrder,
      agentProfile,
      runId,
      role,
      worktree,
      startedAt,
      parentRunId: args.parentRunId,
      handoffPacketUri: args.handoffPacketUri,
    });
    const manifestArtifact = saveTextArtifact({
      services,
      projectId,
      taskId,
      runId,
      agentId: agentProfile.agent_id,
      kind: "task_capsule",
      filename: "run_manifest.json",
      content: JSON.stringify(manifest, null, 2) + "\n",
      summary: role === "reviewer" ? "Reviewer run manifest" : "Run manifest",
    });

    services.runStore.updateStatus(runId, "running", {
      workspace_path: worktree.workspacePath,
      base_commit: worktree.baseCommit,
      branch_name: worktree.branchName,
      run_manifest_ref: manifestArtifact.uri,
      started_at: startedAt,
      role,
      parent_run_id: args.parentRunId,
      handoff_packet_uri: args.handoffPacketUri,
    });

    appendEvent({
      services,
      eventType: "run.started",
      projectId,
      taskId,
      runId,
      agentId: agentProfile.agent_id,
      payload: {
        workspace_path: worktree.workspacePath,
        started_at: startedAt,
      },
    });

    return {
      runId,
      taskId,
      projectId,
      role,
      startedAt,
      worktree,
      manifest,
      runManifestRef: manifestArtifact.uri,
    };
  } catch {
    try {
      services.runStore.updateStatus(runId, "failed", {
        ended_at: nowIso(services),
      });
    } catch {
      // Best effort: preserve the original preparation failure.
    }
    try {
      appendEvent({
        services,
        eventType: "run.failed",
        projectId,
        taskId,
        runId,
        agentId: agentProfile.agent_id,
        payload: { reason: "internal_error" },
      });
    } catch {
      // Best effort: preserve the original preparation failure.
    }
    throw new RunContextCreationFailure({ runId, taskId, projectId, role });
  }
}

function emitAgentSpawned(args: {
  services: V1RunTaskServices;
  context: RunContext;
  agentId: string;
}): void {
  appendEvent({
    services: args.services,
    eventType: "agent.spawned",
    projectId: args.context.projectId,
    taskId: args.context.taskId,
    runId: args.context.runId,
    agentId: args.agentId,
    payload: {
      pid: 0,
      credential_profile_alias: "unknown",
    },
  });
}

function finishRun(args: {
  services: V1RunTaskServices;
  context: RunContext;
  agentId: string;
  status: "succeeded" | "failed";
  reason?: string;
}): void {
  args.services.runStore.updateStatus(args.context.runId, args.status, {
    ended_at: nowIso(args.services),
  });
  appendEvent({
    services: args.services,
    eventType: args.status === "succeeded" ? "run.completed" : "run.failed",
    projectId: args.context.projectId,
    taskId: args.context.taskId,
    runId: args.context.runId,
    agentId: args.agentId,
    payload: args.reason ? { reason: args.reason } : {},
  });
}

async function runImplementer(args: {
  context: RunContext;
  workOrder: ParsedWorkOrderV1;
  agentProfile: ParsedAgentProfileV1;
  services: V1RunTaskServices;
}): Promise<RunOutcome> {
  const { context, workOrder, agentProfile, services } = args;
  const artifacts: PublishedArtifacts = {};

  let capsule: TaskCapsuleWriteResult | undefined;
  try {
    capsule = services.taskCapsuleWriter.write({
      workspacePath: context.worktree.workspacePath,
      workOrder,
      runManifest: context.manifest,
    });

    emitAgentSpawned({ services, context, agentId: agentProfile.agent_id });

    const timeoutSeconds =
      workOrder.budget?.max_wall_time_minutes !== undefined
        ? workOrder.budget.max_wall_time_minutes * 60
        : agentProfile.limits?.timeout_seconds;
    let agentResult: AgentProcessResult;
    try {
      agentResult = await services.adapter.run({
        agentProfile,
        workspacePath: context.worktree.workspacePath,
        promptFile: capsule.promptPath,
        timeoutSeconds,
      });
    } catch {
      finishRun({ services, context, agentId: agentProfile.agent_id, status: "failed", reason: "spawn_failed" });
      return {
        kind: "implementer_failed",
        runId: context.runId,
        reason: "spawn_failed",
      };
    }

    artifacts.stdout = saveTextArtifact({
      services,
      projectId: context.projectId,
      taskId: context.taskId,
      runId: context.runId,
      agentId: agentProfile.agent_id,
      kind: "stdout_tail",
      filename: "stdout.txt",
      content: agentResult.stdoutTail || "(empty)",
      summary: `${agentResult.stdoutBytes} bytes`,
    });
    artifacts.stderr = saveTextArtifact({
      services,
      projectId: context.projectId,
      taskId: context.taskId,
      runId: context.runId,
      agentId: agentProfile.agent_id,
      kind: "stderr_tail",
      filename: "stderr.txt",
      content: agentResult.stderrTail || "(empty)",
      summary: `${agentResult.stderrBytes} bytes`,
    });
    artifacts.diff = saveTextArtifact({
      services,
      projectId: context.projectId,
      taskId: context.taskId,
      runId: context.runId,
      agentId: agentProfile.agent_id,
      kind: "diff",
      filename: "diff.patch",
      content: services.gitManager.diff(context.worktree.workspacePath),
      summary: "Git diff of agent changes",
    });

    const finalReportPath = path.join(
      context.worktree.workspacePath,
      ".agent-workflow",
      "final_report.md",
    );
    if (fs.existsSync(finalReportPath)) {
      const finalReport = fs.readFileSync(finalReportPath, "utf-8");
      if (finalReport.trim().length > 0) {
        artifacts.finalReport = saveFileArtifact({
          services,
          projectId: context.projectId,
          taskId: context.taskId,
          runId: context.runId,
          agentId: agentProfile.agent_id,
          kind: "final_report",
          filename: "final_report.md",
          sourcePath: finalReportPath,
          summary: "Agent final report",
        });
      }
    }

    saveTextArtifact({
      services,
      projectId: context.projectId,
      taskId: context.taskId,
      runId: context.runId,
      agentId: agentProfile.agent_id,
      kind: "task_capsule",
      filename: "task-capsule.txt",
      content: `Task capsule at: ${capsule.capsulePath}\nWork order: ${capsule.workOrderPath}\nRun manifest: ${capsule.runManifestPath}\nPrompt: ${capsule.promptPath}\n`,
      summary: "Task capsule location",
    });

    const agentReason = agentFailureReason(agentResult);
    if (agentReason) {
      finishRun({ services, context, agentId: agentProfile.agent_id, status: "failed", reason: agentReason });
      return {
        kind: "implementer_failed",
        runId: context.runId,
        reason: agentReason,
        diffArtifactUri: artifacts.diff.uri,
        finalReportUri: artifacts.finalReport?.uri,
      };
    }

    let verificationPassed = true;
    if (workOrder.verification?.commands.length) {
      appendEvent({
        services,
        eventType: "verification.started",
        projectId: context.projectId,
        taskId: context.taskId,
        runId: context.runId,
        agentId: agentProfile.agent_id,
        payload: { commands: workOrder.verification.commands },
      });
      const verification = await services.verifier.run({
        workspacePath: context.worktree.workspacePath,
        commands: workOrder.verification.commands,
        timeoutSeconds: workOrder.verification.timeout_seconds,
      });
      artifacts.verification = saveTextArtifact({
        services,
        projectId: context.projectId,
        taskId: context.taskId,
        runId: context.runId,
        agentId: agentProfile.agent_id,
        kind: "verification_output",
        filename: "verification.txt",
        content: verificationOutput(verification),
        summary: verification.passed ? "All passed" : "Verification failed",
      });
      appendEvent({
        services,
        eventType: verification.passed ? "verification.passed" : "verification.failed",
        projectId: context.projectId,
        taskId: context.taskId,
        runId: context.runId,
        agentId: agentProfile.agent_id,
        payload: {
          result: verification.passed ? "passed" : "failed",
          output_ref: artifacts.verification.uri,
        },
      });
      verificationPassed = verification.passed;
    }

    if (!verificationPassed) {
      finishRun({ services, context, agentId: agentProfile.agent_id, status: "failed", reason: "verification_failed" });
      return {
        kind: "implementer_failed",
        runId: context.runId,
        reason: "verification_failed",
        diffArtifactUri: artifacts.diff.uri,
        verificationOutputUri: artifacts.verification?.uri,
        finalReportUri: artifacts.finalReport?.uri,
      };
    }

    finishRun({ services, context, agentId: agentProfile.agent_id, status: "succeeded" });
    appendEvent({
      services,
      eventType: "task.edge_selected",
      projectId: context.projectId,
      taskId: context.taskId,
      runId: context.runId,
      agentId: agentProfile.agent_id,
      payload: {
        from: "verifying",
        to: workOrder.review.enabled ? "reviewing" : "accepted",
        reason: workOrder.review.enabled ? "review_required" : "review_disabled",
      },
    });

    return {
      kind: "implementer_succeeded",
      runId: context.runId,
      diffArtifactUri: artifacts.diff.uri,
      verificationOutputUri: artifacts.verification?.uri,
      finalReportUri: artifacts.finalReport?.uri,
    };
  } catch (error) {
    const reason: ImplementerFailureReason = "internal_error";
    finishRun({ services, context, agentId: agentProfile.agent_id, status: "failed", reason });
    return {
      kind: "implementer_failed",
      runId: context.runId,
      reason,
      diffArtifactUri: artifacts.diff?.uri,
      verificationOutputUri: artifacts.verification?.uri,
      finalReportUri: artifacts.finalReport?.uri,
    };
  }
}

async function runReviewer(args: {
  context: RunContext;
  workOrder: ParsedWorkOrderV1;
  agentProfile: ParsedAgentProfileV1;
  services: V1RunTaskServices;
  reviewContext?: {
    diffText: string;
    diffArtifactUri: string;
    priorFinalReportText?: string;
    implementerRunId?: string;
    implementerAgentId?: string;
  };
}): Promise<RunOutcome> {
  const { context, workOrder, agentProfile, services } = args;
  if (!args.reviewContext) {
    finishRun({ services, context, agentId: agentProfile.agent_id, status: "failed", reason: "internal_error" });
    return { kind: "reviewer_unusable", runId: context.runId, reason: "internal_error" };
  }

  const applyDiff = services.applyDiffToWorkspace ?? defaultApplyDiffToWorkspace;
  const applyResult = applyDiff({
    workspacePath: context.worktree.workspacePath,
    diffText: args.reviewContext.diffText,
  });

  if (!applyResult.ok) {
    const stdoutArtifact = saveTextArtifact({
      services,
      projectId: context.projectId,
      taskId: context.taskId,
      runId: context.runId,
      agentId: agentProfile.agent_id,
      kind: "stdout_tail",
      filename: "git_apply_stdout.txt",
      content: applyResult.stdout,
      summary: "git apply stdout",
    });
    const stderrArtifact = saveTextArtifact({
      services,
      projectId: context.projectId,
      taskId: context.taskId,
      runId: context.runId,
      agentId: agentProfile.agent_id,
      kind: "stderr_tail",
      filename: "git_apply_stderr.txt",
      content: applyResult.stderr,
      summary: "git apply stderr",
    });
    saveTextArtifact({
      services,
      projectId: context.projectId,
      taskId: context.taskId,
      runId: context.runId,
      agentId: agentProfile.agent_id,
      kind: "diff",
      filename: "diff_under_review.patch",
      content: args.reviewContext.diffText,
      summary: "Diff that failed to apply",
    });
    finishRun({ services, context, agentId: agentProfile.agent_id, status: "failed", reason: "diff_apply_failed" });
    appendEvent({
      services,
      eventType: "task.edge_selected",
      projectId: context.projectId,
      taskId: context.taskId,
      runId: context.runId,
      agentId: agentProfile.agent_id,
      payload: { from: "reviewing", to: "requeued", reason: "diff_apply_failed" },
    });
    return {
      kind: "reviewer_unusable",
      runId: context.runId,
      reason: "diff_apply_failed",
      stdoutArtifactUri: stdoutArtifact.uri,
      stderrArtifactUri: stderrArtifact.uri,
    };
  }

  try {
    const brief: ReviewBriefWriteResult = services.reviewBriefWriter.write({
      workspacePath: context.worktree.workspacePath,
      workOrder,
      diffText: args.reviewContext.diffText,
      priorFinalReportText: args.reviewContext.priorFinalReportText,
    });
    saveFileArtifact({
      services,
      projectId: context.projectId,
      taskId: context.taskId,
      runId: context.runId,
      agentId: agentProfile.agent_id,
      kind: "task_capsule",
      filename: "review_brief.md",
      sourcePath: brief.reviewBriefPath,
      summary: "Reviewer brief",
    });
    saveFileArtifact({
      services,
      projectId: context.projectId,
      taskId: context.taskId,
      runId: context.runId,
      agentId: agentProfile.agent_id,
      kind: "diff",
      filename: "diff_under_review.patch",
      sourcePath: brief.diffUnderReviewPath,
      summary: "Diff under review",
    });

    appendEvent({
      services,
      eventType: "review.requested",
      projectId: context.projectId,
      taskId: context.taskId,
      runId: context.runId,
      agentId: agentProfile.agent_id,
      payload: {
        diff_artifact_uri: args.reviewContext.diffArtifactUri,
      },
    });
    emitAgentSpawned({ services, context, agentId: agentProfile.agent_id });

    let agentResult: AgentProcessResult;
    try {
      agentResult = await services.adapter.run({
        agentProfile,
        workspacePath: context.worktree.workspacePath,
        promptFile: brief.reviewerPromptPath,
        timeoutSeconds: agentProfile.limits?.timeout_seconds,
      });
    } catch {
      finishRun({ services, context, agentId: agentProfile.agent_id, status: "failed", reason: "spawn_failed" });
      return { kind: "reviewer_unusable", runId: context.runId, reason: "spawn_failed" };
    }
    const stdoutArtifact = saveTextArtifact({
      services,
      projectId: context.projectId,
      taskId: context.taskId,
      runId: context.runId,
      agentId: agentProfile.agent_id,
      kind: "stdout_tail",
      filename: "stdout.txt",
      content: agentResult.stdoutTail || "(empty)",
      summary: `${agentResult.stdoutBytes} bytes`,
    });
    const stderrArtifact = saveTextArtifact({
      services,
      projectId: context.projectId,
      taskId: context.taskId,
      runId: context.runId,
      agentId: agentProfile.agent_id,
      kind: "stderr_tail",
      filename: "stderr.txt",
      content: agentResult.stderrTail || "(empty)",
      summary: `${agentResult.stderrBytes} bytes`,
    });

    const agentReason = agentFailureReason(agentResult);
    if (agentReason) {
      finishRun({ services, context, agentId: agentProfile.agent_id, status: "failed", reason: agentReason });
      return {
        kind: "reviewer_unusable",
        runId: context.runId,
        reason: agentReason,
        stdoutArtifactUri: stdoutArtifact.uri,
        stderrArtifactUri: stderrArtifact.uri,
      };
    }

    const parser = services.reviewVerdictParser ?? parseReviewVerdict;
    const parsed: ReviewVerdictParseResult = parser({
      workspacePath: context.worktree.workspacePath,
    });
    const verdictArtifact = saveTextArtifact({
      services,
      projectId: context.projectId,
      taskId: context.taskId,
      runId: context.runId,
      agentId: agentProfile.agent_id,
      kind: "review_verdict",
      filename: "review_verdict.json",
      content: JSON.stringify(parsed.verdict, null, 2) + "\n",
      summary: parsed.verdict.summary,
    });

    if (parsed.unusableRawText !== undefined) {
      saveTextArtifact({
        services,
        projectId: context.projectId,
        taskId: context.taskId,
        runId: context.runId,
        agentId: agentProfile.agent_id,
        kind: "final_report",
        filename: "reviewer_unusable_output.txt",
        content: parsed.unusableRawText,
        summary: parsed.errorMessage ?? "Reviewer output was unusable",
      });
    }

    if (parsed.reasonTag === "reviewer_unusable") {
      finishRun({ services, context, agentId: agentProfile.agent_id, status: "failed", reason: "internal_error" });
      return {
        kind: "reviewer_unusable",
        runId: context.runId,
        reason: "reviewer_unusable",
        reviewVerdictUri: verdictArtifact.uri,
        stdoutArtifactUri: stdoutArtifact.uri,
        stderrArtifactUri: stderrArtifact.uri,
      };
    }

    finishRun({ services, context, agentId: agentProfile.agent_id, status: "succeeded" });
    appendEvent({
      services,
      eventType: "review.completed",
      projectId: context.projectId,
      taskId: context.taskId,
      runId: context.runId,
      agentId: agentProfile.agent_id,
      payload: {
        verdict: parsed.verdict.verdict,
        verdict_uri: verdictArtifact.uri,
        summary: parsed.verdict.summary,
        comments_count: parsed.verdict.comments.length,
      },
    });

    const edgeTo =
      parsed.verdict.verdict === "approved"
        ? "accepted"
        : parsed.verdict.verdict === "changes_requested"
          ? "requeued"
          : "awaiting_human";
    appendEvent({
      services,
      eventType: "task.edge_selected",
      projectId: context.projectId,
      taskId: context.taskId,
      runId: context.runId,
      agentId: agentProfile.agent_id,
      payload: { from: "reviewing", to: edgeTo, reason: parsed.verdict.verdict },
    });

    if (parsed.verdict.verdict === "approved") {
      return { kind: "reviewer_approved", runId: context.runId, reviewVerdictUri: verdictArtifact.uri };
    }
    if (parsed.verdict.verdict === "changes_requested") {
      return { kind: "reviewer_changes_requested", runId: context.runId, reviewVerdictUri: verdictArtifact.uri };
    }
    return { kind: "reviewer_rejected", runId: context.runId, reviewVerdictUri: verdictArtifact.uri };
  } catch {
    finishRun({ services, context, agentId: agentProfile.agent_id, status: "failed", reason: "internal_error" });
    return { kind: "reviewer_unusable", runId: context.runId, reason: "internal_error" };
  }
}

export async function runTaskOnce(args: {
  entry: TaskQueueEntry;
  decision: ScheduleDecision;
  agentProfile: ParsedAgentProfileV1;
  workOrder: ParsedWorkOrderV1;
  services: V1RunTaskServices;
  db: Database;
  parentRunId?: string;
  handoffPacketUri?: string;
  reviewContext?: {
    diffText: string;
    diffArtifactUri: string;
    priorFinalReportText?: string;
    implementerRunId?: string;
    implementerAgentId?: string;
  };
}): Promise<RunOutcome> {
  void args.db;

  let context: RunContext;
  try {
    context = await createRunContext({
      entry: args.entry,
      decision: args.decision,
      agentProfile: args.agentProfile,
      workOrder: args.workOrder,
      services: args.services,
      parentRunId: args.parentRunId,
      handoffPacketUri: args.handoffPacketUri,
    });
  } catch (error) {
    if (error instanceof RunContextCreationFailure) {
      if (error.details.role === "implementer") {
        return {
          kind: "implementer_failed",
          runId: error.details.runId,
          reason: "internal_error",
        };
      }
      return {
        kind: "reviewer_unusable",
        runId: error.details.runId,
        reason: "internal_error",
      };
    }
    throw error;
  }

  if (context.role === "implementer") {
    return runImplementer({
      context,
      workOrder: args.workOrder,
      agentProfile: args.agentProfile,
      services: args.services,
    });
  }

  return runReviewer({
    context,
    workOrder: args.workOrder,
    agentProfile: args.agentProfile,
    services: args.services,
    reviewContext: args.reviewContext,
  });
}
