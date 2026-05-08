import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTaskOnce } from "../../src/core/orchestrator-v1.js";
import type {
  ArtifactKindV1,
  ArtifactRef,
  EventEnvelope,
  ReviewVerdict,
  ScheduleDecision,
  TaskQueueEntry,
} from "../../src/core/types.js";
import { EventEnvelopeSchema } from "../../src/core/schemas.js";
import {
  parseAgentProfileV1,
  parseWorkOrderV1,
  type ParsedAgentProfileV1,
  type ParsedWorkOrderV1,
} from "../../src/core/schemas-v1.js";
import {
  assertKnownEventTypeV1,
  assertRequiredEventIds,
  assertV1PayloadFields,
} from "../../src/core/events.js";
import type { EventLog } from "../../src/storage/event-log.js";
import type { RunRecord, RunStore } from "../../src/storage/run-store.js";
import type { ArtifactStore } from "../../src/storage/artifact-store.js";
import type {
  GitWorktreeManager,
  PreparedWorktree,
} from "../../src/workspace/git-worktree-manager.js";
import { FileTaskCapsuleWriter } from "../../src/workspace/task-capsule-writer.js";
import { FileReviewBriefWriter } from "../../src/workspace/review-brief-writer.js";
import type {
  AgentProcessResult,
  OfficialCliAdapter,
} from "../../src/adapters/official-cli-adapter.js";
import type {
  VerificationResult,
  VerificationRunner,
} from "../../src/verification/verification-runner.js";
import type { Database } from "../../src/storage/database.js";

class FakeEventLog implements EventLog {
  readonly events: EventEnvelope[] = [];

  append(event: EventEnvelope): void {
    EventEnvelopeSchema.parse(event);
    assertKnownEventTypeV1(event.event_type);
    assertRequiredEventIds(event);
    assertV1PayloadFields(event);
    this.events.push(event);
  }

  listByRun(projectId: string, runId: string): EventEnvelope[] {
    return this.events.filter(
      (event) => event.project_id === projectId && event.run_id === runId,
    );
  }
}

class FakeRunStore implements RunStore {
  readonly records = new Map<string, RunRecord>();

  create(record: RunRecord): void {
    this.records.set(record.id, { ...record });
  }

  updateStatus(
    runId: string,
    status: RunRecord["status"],
    patch: Partial<RunRecord> = {},
  ): void {
    const existing = this.records.get(runId);
    if (!existing) {
      throw new Error(`Run not found: ${runId}`);
    }
    this.records.set(runId, { ...existing, ...patch, status });
  }

  get(runId: string): RunRecord | undefined {
    const record = this.records.get(runId);
    return record ? { ...record } : undefined;
  }
}

interface StoredArtifact {
  ref: ArtifactRef;
  content: string;
  filename: string;
}

class FakeArtifactStore implements ArtifactStore {
  readonly artifacts: StoredArtifact[] = [];

  saveText(args: {
    taskId: string;
    runId: string;
    kind: ArtifactKindV1;
    filename: string;
    content: string;
    summary?: string;
  }): ArtifactRef {
    return this.store({
      taskId: args.taskId,
      runId: args.runId,
      kind: args.kind,
      filename: args.filename,
      content: args.content,
      summary: args.summary,
    });
  }

  saveFile(args: {
    taskId: string;
    runId: string;
    kind: ArtifactKindV1;
    sourcePath: string;
    filename: string;
    summary?: string;
  }): ArtifactRef {
    return this.store({
      taskId: args.taskId,
      runId: args.runId,
      kind: args.kind,
      filename: args.filename,
      content: fs.readFileSync(args.sourcePath, "utf-8"),
      summary: args.summary,
    });
  }

  byKind(kind: ArtifactKindV1): StoredArtifact[] {
    return this.artifacts.filter((artifact) => artifact.ref.kind === kind);
  }

  private store(args: {
    taskId: string;
    runId: string;
    kind: ArtifactKindV1;
    filename: string;
    content: string;
    summary?: string;
  }): ArtifactRef {
    const ref: ArtifactRef = {
      uri: `artifact://${args.taskId}/${args.runId}/${args.filename}`,
      kind: args.kind,
      summary: args.summary,
    };
    this.artifacts.push({
      ref,
      content: args.content,
      filename: args.filename,
    });
    return ref;
  }
}

class FakeGitWorktreeManager implements GitWorktreeManager {
  readonly prepared: PreparedWorktree[] = [];
  diffText = "diff --git a/file.txt b/file.txt\n+changed\n";

  constructor(private readonly root: string) {}

  prepare(args: {
    repoPath: string;
    taskId: string;
    runId: string;
  }): PreparedWorktree {
    const workspacePath = path.join(this.root, "worktrees", args.runId);
    fs.mkdirSync(workspacePath, { recursive: true });
    const prepared = {
      repoPath: args.repoPath,
      workspacePath,
      baseCommit: "base-commit",
      branchName: `agent/${args.taskId}/${args.runId}`,
    };
    this.prepared.push(prepared);
    return prepared;
  }

  statusPorcelain(): string {
    return "";
  }

  diff(): string {
    return this.diffText;
  }

  cleanup(): void {}
}

type AdapterMode =
  | {
      kind: "result";
      exitCode?: number | null;
      timedOut?: boolean;
      stdout?: string;
      stderr?: string;
      finalReport?: string;
      verdict?: ReviewVerdict;
      rawVerdict?: string;
    }
  | { kind: "throw" };

class FakeAdapter implements OfficialCliAdapter {
  readonly runCalls: Array<Parameters<OfficialCliAdapter["run"]>[0]> = [];

  constructor(private mode: AdapterMode = { kind: "result" }) {}

  setMode(mode: AdapterMode): void {
    this.mode = mode;
  }

  async run(
    args: Parameters<OfficialCliAdapter["run"]>[0],
  ): Promise<AgentProcessResult> {
    this.runCalls.push(args);
    if (this.mode.kind === "throw") {
      throw new Error("spawn failed");
    }

    const capsuleDir = path.join(args.workspacePath, ".agent-workflow");
    fs.mkdirSync(capsuleDir, { recursive: true });
    if (this.mode.finalReport !== undefined) {
      fs.writeFileSync(
        path.join(capsuleDir, "final_report.md"),
        this.mode.finalReport,
        "utf-8",
      );
    }
    if (this.mode.verdict !== undefined) {
      fs.writeFileSync(
        path.join(capsuleDir, "review_verdict.json"),
        JSON.stringify(this.mode.verdict, null, 2) + "\n",
        "utf-8",
      );
    }
    if (this.mode.rawVerdict !== undefined) {
      fs.writeFileSync(
        path.join(capsuleDir, "review_verdict.json"),
        this.mode.rawVerdict,
        "utf-8",
      );
    }

    const stdout = this.mode.stdout ?? "agent stdout";
    const stderr = this.mode.stderr ?? "agent stderr";
    return {
      exitCode: this.mode.exitCode ?? 0,
      signal: null,
      timedOut: this.mode.timedOut ?? false,
      stdoutTail: stdout,
      stderrTail: stderr,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
      wallTimeMs: 123,
    };
  }
}

class FakeVerificationRunner implements VerificationRunner {
  readonly runCalls: Array<Parameters<VerificationRunner["run"]>[0]> = [];

  constructor(private result: VerificationResult = verificationResult(true)) {}

  setResult(result: VerificationResult): void {
    this.result = result;
  }

  async run(
    args: Parameters<VerificationRunner["run"]>[0],
  ): Promise<VerificationResult> {
    this.runCalls.push(args);
    return this.result;
  }
}

interface Harness {
  root: string;
  eventLog: FakeEventLog;
  runStore: FakeRunStore;
  artifactStore: FakeArtifactStore;
  gitManager: FakeGitWorktreeManager;
  adapter: FakeAdapter;
  verifier: FakeVerificationRunner;
  applyCalls: Array<{ workspacePath: string; diffText: string }>;
  services: Parameters<typeof runTaskOnce>[0]["services"];
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeHarness(args: {
  adapterMode?: AdapterMode;
  verification?: VerificationResult;
  applyResult?: { ok: true; stdout: string; stderr: string } | { ok: false; stdout: string; stderr: string };
} = {}): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-v1-"));
  tempRoots.push(root);
  const eventLog = new FakeEventLog();
  const runStore = new FakeRunStore();
  const artifactStore = new FakeArtifactStore();
  const gitManager = new FakeGitWorktreeManager(root);
  const adapter = new FakeAdapter(args.adapterMode);
  const verifier = new FakeVerificationRunner(args.verification);
  const applyCalls: Array<{ workspacePath: string; diffText: string }> = [];
  const applyResult = args.applyResult ?? { ok: true as const, stdout: "", stderr: "" };

  return {
    root,
    eventLog,
    runStore,
    artifactStore,
    gitManager,
    adapter,
    verifier,
    applyCalls,
    services: {
      eventLog,
      runStore,
      artifactStore,
      gitManager,
      taskCapsuleWriter: new FileTaskCapsuleWriter(),
      reviewBriefWriter: new FileReviewBriefWriter(),
      adapter,
      verifier,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      applyDiffToWorkspace: (applyArgs) => {
        applyCalls.push(applyArgs);
        return applyResult;
      },
    },
  };
}

function verificationResult(passed: boolean): VerificationResult {
  return {
    passed,
    commandResults: [
      {
        command: "pnpm test",
        exitCode: passed ? 0 : 1,
        timedOut: false,
        output: passed ? "ok" : "failed",
        wallTimeMs: 12,
      },
    ],
  };
}

function makeWorkOrder(
  repoPath: string,
  overrides: Record<string, unknown> = {},
): ParsedWorkOrderV1 {
  return parseWorkOrderV1({
    schema_version: "workflow/v1",
    task_id: "T-v1",
    project_id: "P-v1",
    title: "Implement v1 task",
    type: "code_change",
    goal: "Change the code.",
    acceptance_criteria: ["The change is correct."],
    repo: { path: repoPath, base_ref: "main" },
    verification: { commands: ["pnpm test"], timeout_seconds: 30 },
    agent: {
      required_capabilities: ["typescript"],
      implementer_pool: ["agent-a"],
      reviewer_pool: ["agent-a"],
      exclude_agent_ids: [],
    },
    review: { enabled: true, max_review_runs: 1 },
    budget: {
      max_wall_time_minutes: 10,
      max_total_cost_units: 10,
      max_runs: 4,
    },
    ...overrides,
  });
}

function makeAgentProfile(
  overrides: Record<string, unknown> = {},
): ParsedAgentProfileV1 {
  return parseAgentProfileV1({
    schema_version: "workflow/v1",
    agent_id: "agent-a",
    integration_mode: "official_cli",
    command: {
      executable: "agent",
      args: ["run", "{{prompt_file}}"],
    },
    capabilities: {
      outer_supervised: true,
      inner_tool_control: false,
      kinds: ["typescript"],
      roles: ["implementer", "reviewer"],
    },
    limits: { timeout_seconds: 60 },
    ...overrides,
  });
}

function makeEntry(role: "implementer" | "reviewer"): TaskQueueEntry {
  return {
    task_id: "T-v1",
    project_id: "P-v1",
    status: "dispatched",
    next_role: role,
    current_owner_run_id: "worker-1",
    lease_expires_at: "2026-01-01T00:05:00.000Z",
    attempts: 0,
    enqueued_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function makeDecision(role: "implementer" | "reviewer"): ScheduleDecision {
  return {
    schema_version: "agent-workflow/1",
    decision_id: `D-${role}`,
    task_id: "T-v1",
    role,
    picked_agent_id: "agent-a",
    candidate_scores: [],
    decided_at: "2026-01-01T00:00:00.000Z",
  };
}

function makeVerdict(verdict: ReviewVerdict["verdict"]): ReviewVerdict {
  return {
    schema_version: "agent-workflow/1",
    verdict,
    summary: `${verdict} summary`,
    comments: [],
  };
}

function eventTypes(harness: Harness, runId: string): string[] {
  return harness.eventLog
    .listByRun("P-v1", runId)
    .map((event) => event.event_type);
}

function lastEdge(harness: Harness, runId: string): EventEnvelope | undefined {
  return harness.eventLog
    .listByRun("P-v1", runId)
    .findLast((event) => event.event_type === "task.edge_selected");
}

async function runImplementer(
  harness: Harness,
  workOrderOverrides: Record<string, unknown> = {},
) {
  const workOrder = makeWorkOrder(harness.root, workOrderOverrides);
  return runTaskOnce({
    entry: makeEntry("implementer"),
    decision: makeDecision("implementer"),
    agentProfile: makeAgentProfile(),
    workOrder,
    services: harness.services,
    db: {} as Database,
  });
}

async function runReviewer(
  harness: Harness,
  verdict: ReviewVerdict["verdict"] = "approved",
) {
  return runTaskOnce({
    entry: makeEntry("reviewer"),
    decision: makeDecision("reviewer"),
    agentProfile: makeAgentProfile(),
    workOrder: makeWorkOrder(harness.root),
    services: harness.services,
    db: {} as Database,
    parentRunId: "run-implementer",
    handoffPacketUri: "artifact://T-v1/run-implementer/handoff_packet.json",
    reviewContext: {
      diffText: "diff --git a/file.txt b/file.txt\n+review me\n",
      diffArtifactUri: "artifact://T-v1/run-implementer/diff.patch",
      priorFinalReportText: "Implemented the task.",
      implementerRunId: "run-implementer",
      implementerAgentId: "agent-impl",
    },
  });
}

describe("runTaskOnce implementer path", () => {
  it("succeeds and accepts the task when review is disabled", async () => {
    const harness = makeHarness({
      adapterMode: { kind: "result", finalReport: "# Done\n" },
    });

    const outcome = await runImplementer(harness, {
      review: { enabled: false, max_review_runs: 0 },
    });

    expect(outcome.kind).toBe("implementer_succeeded");
    expect(harness.runStore.get(outcome.runId)?.status).toBe("succeeded");
    expect(harness.runStore.get(outcome.runId)?.role).toBe("implementer");
    expect(harness.adapter.runCalls[0]?.promptFile).toMatch(/prompt\.md$/);
    expect(outcome.diffArtifactUri).toContain("diff.patch");
    expect(outcome.verificationOutputUri).toContain("verification.txt");
    expect(outcome.finalReportUri).toContain("final_report.md");

    expect(eventTypes(harness, outcome.runId)).toEqual(
      expect.arrayContaining([
        "task.assigned",
        "run.created",
        "run.started",
        "agent.spawned",
        "artifact.published",
        "verification.started",
        "verification.passed",
        "run.completed",
        "task.edge_selected",
      ]),
    );
    expect(lastEdge(harness, outcome.runId)?.payload).toMatchObject({
      from: "verifying",
      to: "accepted",
      reason: "review_disabled",
    });
    expect(harness.artifactStore.byKind("diff")[0]?.content).toContain(
      "diff --git",
    );
  });

  it("moves to reviewing when review is enabled", async () => {
    const harness = makeHarness();
    const outcome = await runImplementer(harness, {
      verification: undefined,
    });

    expect(outcome.kind).toBe("implementer_succeeded");
    expect(outcome.verificationOutputUri).toBeUndefined();
    expect(lastEdge(harness, outcome.runId)?.payload).toMatchObject({
      from: "verifying",
      to: "reviewing",
      reason: "review_required",
    });
    expect(eventTypes(harness, outcome.runId)).not.toContain(
      "verification.started",
    );
  });

  it("fails with agent_nonzero_exit when the adapter exits non-zero", async () => {
    const harness = makeHarness({
      adapterMode: { kind: "result", exitCode: 2 },
    });
    const outcome = await runImplementer(harness, {
      verification: undefined,
    });

    expect(outcome).toMatchObject({
      kind: "implementer_failed",
      reason: "agent_nonzero_exit",
    });
    expect(harness.runStore.get(outcome.runId)?.status).toBe("failed");
    const failed = harness.eventLog
      .listByRun("P-v1", outcome.runId)
      .find((event) => event.event_type === "run.failed");
    expect(failed?.payload).toMatchObject({ reason: "agent_nonzero_exit" });
    expect(outcome.diffArtifactUri).toContain("diff.patch");
  });

  it("fails with agent_timed_out when the adapter times out", async () => {
    const harness = makeHarness({
      adapterMode: { kind: "result", exitCode: null, timedOut: true },
    });
    const outcome = await runImplementer(harness, {
      verification: undefined,
    });

    expect(outcome).toMatchObject({
      kind: "implementer_failed",
      reason: "agent_timed_out",
    });
    const failed = harness.eventLog
      .listByRun("P-v1", outcome.runId)
      .find((event) => event.event_type === "run.failed");
    expect(failed?.payload).toMatchObject({ reason: "agent_timed_out" });
  });

  it("fails with verification_failed when verification does not pass", async () => {
    const harness = makeHarness({
      verification: verificationResult(false),
    });
    const outcome = await runImplementer(harness);

    expect(outcome).toMatchObject({
      kind: "implementer_failed",
      reason: "verification_failed",
    });
    expect(outcome.verificationOutputUri).toContain("verification.txt");
    expect(eventTypes(harness, outcome.runId)).toEqual(
      expect.arrayContaining(["verification.failed", "run.failed"]),
    );
  });

  it("classifies adapter spawn errors as spawn_failed", async () => {
    const harness = makeHarness({
      adapterMode: { kind: "throw" },
    });
    const outcome = await runImplementer(harness);

    expect(outcome).toMatchObject({
      kind: "implementer_failed",
      reason: "spawn_failed",
    });
    expect(outcome.diffArtifactUri).toBeUndefined();
    const failed = harness.eventLog
      .listByRun("P-v1", outcome.runId)
      .find((event) => event.event_type === "run.failed");
    expect(failed?.payload).toMatchObject({ reason: "spawn_failed" });
  });
});

describe("runTaskOnce reviewer path", () => {
  it("approves a valid reviewer verdict and accepts the task", async () => {
    const harness = makeHarness({
      adapterMode: { kind: "result", verdict: makeVerdict("approved") },
    });
    const outcome = await runReviewer(harness, "approved");

    expect(outcome.kind).toBe("reviewer_approved");
    expect(outcome.reviewVerdictUri).toContain("review_verdict.json");
    expect(harness.applyCalls[0]?.diffText).toContain("review me");
    expect(eventTypes(harness, outcome.runId)).toEqual(
      expect.arrayContaining([
        "review.requested",
        "agent.spawned",
        "review.completed",
        "run.completed",
        "task.edge_selected",
      ]),
    );
    expect(lastEdge(harness, outcome.runId)?.payload).toMatchObject({
      from: "reviewing",
      to: "accepted",
      reason: "approved",
    });
    const completed = harness.eventLog
      .listByRun("P-v1", outcome.runId)
      .find((event) => event.event_type === "review.completed");
    expect(completed?.payload).toMatchObject({
      verdict: "approved",
      verdict_uri: outcome.reviewVerdictUri,
      comments_count: 0,
    });
  });

  it.each([
    ["changes_requested", "reviewer_changes_requested", "requeued"],
    ["rejected", "reviewer_rejected", "awaiting_human"],
  ] as const)(
    "maps %s verdict to %s and the %s edge",
    async (verdict, expectedKind, expectedEdge) => {
      const harness = makeHarness({
        adapterMode: { kind: "result", verdict: makeVerdict(verdict) },
      });
      const outcome = await runReviewer(harness, verdict);

      expect(outcome.kind).toBe(expectedKind);
      expect(lastEdge(harness, outcome.runId)?.payload).toMatchObject({
        from: "reviewing",
        to: expectedEdge,
        reason: verdict,
      });
    },
  );

  it("returns reviewer_unusable when the verdict file is invalid", async () => {
    const harness = makeHarness({
      adapterMode: { kind: "result", rawVerdict: "{ not json" },
    });
    const outcome = await runReviewer(harness);

    expect(outcome).toMatchObject({
      kind: "reviewer_unusable",
      reason: "reviewer_unusable",
    });
    expect(outcome.reviewVerdictUri).toContain("review_verdict.json");
    expect(harness.artifactStore.byKind("final_report")[0]?.filename).toBe(
      "reviewer_unusable_output.txt",
    );
    const failed = harness.eventLog
      .listByRun("P-v1", outcome.runId)
      .find((event) => event.event_type === "run.failed");
    expect(failed?.payload).toMatchObject({ reason: "internal_error" });
    expect(eventTypes(harness, outcome.runId)).not.toContain(
      "review.completed",
    );
  });

  it("does not run the reviewer agent when applying the diff fails", async () => {
    const harness = makeHarness({
      applyResult: {
        ok: false,
        stdout: "apply stdout",
        stderr: "apply stderr",
      },
    });
    const outcome = await runTaskOnce({
      entry: makeEntry("reviewer"),
      decision: makeDecision("reviewer"),
      agentProfile: makeAgentProfile(),
      workOrder: makeWorkOrder(harness.root),
      services: harness.services,
      db: {} as Database,
      reviewContext: {
        diffText: "bad diff",
        diffArtifactUri: "artifact://T-v1/run-impl/diff.patch",
      },
    });

    expect(outcome).toMatchObject({
      kind: "reviewer_unusable",
      reason: "diff_apply_failed",
    });
    expect(harness.runStore.get(outcome.runId)?.run_manifest_ref).toContain(
      "run_manifest.json",
    );
    expect(harness.adapter.runCalls).toHaveLength(0);
    expect(harness.artifactStore.byKind("stdout_tail")[0]?.content).toBe(
      "apply stdout",
    );
    expect(harness.artifactStore.byKind("stderr_tail")[0]?.content).toBe(
      "apply stderr",
    );
    expect(lastEdge(harness, outcome.runId)?.payload).toMatchObject({
      from: "reviewing",
      to: "requeued",
      reason: "diff_apply_failed",
    });
  });

  it("classifies reviewer adapter spawn errors as spawn_failed", async () => {
    const harness = makeHarness({
      adapterMode: { kind: "throw" },
    });
    const outcome = await runReviewer(harness);

    expect(outcome).toMatchObject({
      kind: "reviewer_unusable",
      reason: "spawn_failed",
    });
    const failed = harness.eventLog
      .listByRun("P-v1", outcome.runId)
      .find((event) => event.event_type === "run.failed");
    expect(failed?.payload).toMatchObject({ reason: "spawn_failed" });
  });
});
