import { beforeEach, describe, expect, it, vi } from "vitest";
import { V1WorkerTaskHandler } from "../../src/queue/worker-task-handler.js";
import type { TaskQueue } from "../../src/queue/task-queue.js";
import type { EventLog } from "../../src/storage/event-log.js";
import type { AgentRegistry } from "../../src/scheduling/agent-registry.js";
import type { Scheduler } from "../../src/scheduling/scheduler.js";
import type { BudgetManager } from "../../src/scheduling/budget-manager.js";
import type { HandoffManager } from "../../src/scheduling/handoff-manager.js";
import type { Database } from "../../src/storage/database.js";
import { EventEnvelopeSchema } from "../../src/core/schemas.js";
import {
  assertKnownEventTypeV1,
  assertRequiredEventIds,
  assertV1PayloadFields,
} from "../../src/core/events.js";
import {
  parseAgentProfileV1,
  parseWorkOrderV1,
  type ParsedWorkOrderV1,
} from "../../src/core/schemas-v1.js";
import { runTaskOnce, type RunOutcome, type V1RunTaskServices } from "../../src/core/orchestrator-v1.js";
import type {
  AgentRegistryEntry,
  BudgetState,
  EventEnvelope,
  HandoffPacket,
  ReviewContextRecord,
  ScheduleDecision,
  TaskQueueEntry,
} from "../../src/core/types.js";

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

  byType(eventType: string): EventEnvelope[] {
    return this.events.filter((event) => event.event_type === eventType);
  }
}

class FakeQueue implements TaskQueue {
  entry: TaskQueueEntry;
  workOrder: ParsedWorkOrderV1;
  reviewContext: ReviewContextRecord | undefined;
  handoffPacketUri: string | undefined = undefined;
  readonly getWorkOrderCalls: string[] = [];
  readonly releaseCalls: Array<{ taskId: string; patch: Partial<TaskQueueEntry> }> = [];

  constructor(workOrder: ParsedWorkOrderV1, entry: TaskQueueEntry = makeEntry()) {
    this.workOrder = workOrder;
    this.entry = entry;
  }

  enqueue(): TaskQueueEntry {
    return this.entry;
  }

  claim(): TaskQueueEntry | null {
    return this.entry;
  }

  release(taskId: string, patch: Partial<TaskQueueEntry>): void {
    this.releaseCalls.push({ taskId, patch });
    this.entry = {
      ...this.entry,
      status: patch.status ?? this.entry.status,
      next_role: patch.next_role ?? this.entry.next_role,
      current_owner_run_id:
        patch.current_owner_run_id !== undefined
          ? patch.current_owner_run_id
          : this.entry.current_owner_run_id,
      lease_expires_at:
        patch.lease_expires_at !== undefined
          ? patch.lease_expires_at
          : this.entry.lease_expires_at,
      attempts: patch.attempts ?? this.entry.attempts,
      updated_at: patch.updated_at ?? this.entry.updated_at,
    };
  }

  setStatus(taskId: string, status: TaskQueueEntry["status"]): void {
    if (taskId === this.entry.task_id) {
      this.entry = { ...this.entry, status };
    }
  }

  get(taskId: string): TaskQueueEntry | undefined {
    return taskId === this.entry.task_id ? this.entry : undefined;
  }

  getWorkOrder(taskId: string): ParsedWorkOrderV1 | undefined {
    this.getWorkOrderCalls.push(taskId);
    return taskId === this.workOrder.task_id ? this.workOrder : undefined;
  }

  addWorkOrderExcludeAgentIds(taskId: string, agentIds: string[]): ParsedWorkOrderV1 {
    if (taskId !== this.workOrder.task_id) {
      throw new Error(`TaskQueue entry not found: ${taskId}`);
    }
    this.workOrder = parseWorkOrderV1({
      ...this.workOrder,
      agent: {
        ...this.workOrder.agent,
        exclude_agent_ids: dedupeFirstSeen([
          ...this.workOrder.agent.exclude_agent_ids,
          ...agentIds,
        ]),
      },
    });
    return this.workOrder;
  }

  setReviewContext(taskId: string, context: ReviewContextRecord): void {
    if (taskId !== this.workOrder.task_id) {
      throw new Error(`TaskQueue entry not found: ${taskId}`);
    }
    this.reviewContext = structuredClone(context);
  }

  getReviewContext(taskId: string): ReviewContextRecord | undefined {
    return taskId === this.workOrder.task_id && this.reviewContext
      ? structuredClone(this.reviewContext)
      : undefined;
  }

  setHandoffPacketUri(taskId: string, uri: string | undefined): void {
    if (taskId !== this.workOrder.task_id) {
      throw new Error(`TaskQueue entry not found: ${taskId}`);
    }
    this.handoffPacketUri = uri;
  }

  getHandoffPacketUri(taskId: string): string | undefined {
    return taskId === this.workOrder.task_id ? this.handoffPacketUri : undefined;
  }

  listTerminal(): TaskQueueEntry[] {
    return ["accepted", "failed", "awaiting_human"].includes(this.entry.status)
      ? [this.entry]
      : [];
  }
}

class FakeScheduler implements Scheduler {
  readonly calls: Array<Parameters<Scheduler["decide"]>[0]> = [];

  constructor(private decision: ScheduleDecision) {}

  setDecision(decision: ScheduleDecision): void {
    this.decision = decision;
  }

  decide(args: Parameters<Scheduler["decide"]>[0]): ScheduleDecision {
    this.calls.push(args);
    return this.decision;
  }
}

class FakeBudgetManager implements BudgetManager {
  readonly initCalls: ParsedWorkOrderV1[] = [];
  readonly currentCalls: string[] = [];
  readonly preLaunchCalls: string[] = [];
  readonly postRunCalls: Array<Parameters<BudgetManager["postRun"]>[0]> = [];

  currentState = makeBudgetState();
  preLaunchState = makeBudgetState({ runs_used: 1 });
  postRunState = makeBudgetState({ runs_used: 1, wall_time_ms_used: 1 });

  init(workOrder: ParsedWorkOrderV1): BudgetState {
    this.initCalls.push(workOrder);
    return this.currentState;
  }

  current(taskId: string): BudgetState {
    this.currentCalls.push(taskId);
    return this.currentState;
  }

  preLaunch(taskId: string): BudgetState {
    this.preLaunchCalls.push(taskId);
    return this.preLaunchState;
  }

  postRun(args: Parameters<BudgetManager["postRun"]>[0]): BudgetState {
    this.postRunCalls.push(args);
    return this.postRunState;
  }
}

class FakeRegistry implements AgentRegistry {
  readonly recordOutcomeCalls: Array<Parameters<AgentRegistry["recordOutcome"]>[0]> = [];

  constructor(readonly entries: AgentRegistryEntry[] = [makeAgentEntry()]) {}

  load(): void {}

  list(): AgentRegistryEntry[] {
    return this.entries;
  }

  get(agentId: string): AgentRegistryEntry | undefined {
    return this.entries.find((entry) => entry.profile.agent_id === agentId);
  }

  candidatesFor(): AgentRegistryEntry[] {
    return this.entries;
  }

  recordOutcome(args: Parameters<AgentRegistry["recordOutcome"]>[0]): void {
    this.recordOutcomeCalls.push(args);
  }

  refreshQuotaHealth(): void {}
}

class FakeHandoffManager implements HandoffManager {
  readonly buildCalls: Array<Parameters<HandoffManager["build"]>[0]> = [];
  readonly persistedPackets: HandoffPacket[] = [];

  build(args: Parameters<HandoffManager["build"]>[0]): HandoffPacket {
    this.buildCalls.push(args);
    const exclude_agent_ids = dedupeFirstSeen([
      ...(args.priorExcludes ?? []),
      args.fromAgentId,
    ]);
    return {
      schema_version: "agent-workflow/1",
      task_id: args.taskId,
      from_run_id: args.fromRunId,
      from_agent_id: args.fromAgentId,
      reason: args.reason,
      summary: "handoff summary",
      diff_artifact_uri: args.diffArtifactUri,
      verification_output_uri: args.verificationOutputUri,
      review_verdict_uri: args.reviewVerdictUri,
      remaining_work: args.workOrderGoal,
      exclude_agent_ids,
      created_at: "2026-01-01T00:00:00.000Z",
    };
  }

  persist(packet: HandoffPacket) {
    this.persistedPackets.push(packet);
    return {
      uri: `artifact://${packet.task_id}/${packet.from_run_id}/handoff_packet.json`,
      kind: "handoff_packet" as const,
    };
  }

  attachToBrief(): void {}
}

class FakeArtifactStore {
  readonly readCalls: string[] = [];
  private readonly texts = new Map<string, string>();

  constructor(initialTexts: Record<string, string> = {}) {
    for (const [uri, text] of Object.entries(initialTexts)) {
      this.texts.set(uri, text);
    }
  }

  readText(uri: string): string {
    this.readCalls.push(uri);
    const text = this.texts.get(uri);
    if (text === undefined) {
      throw new Error(`Artifact not found: ${uri}`);
    }
    return text;
  }
}

interface Harness {
  eventLog: FakeEventLog;
  queue: FakeQueue;
  scheduler: FakeScheduler;
  budgetManager: FakeBudgetManager;
  registry: FakeRegistry;
  handoffManager: FakeHandoffManager;
  artifactStore: FakeArtifactStore;
  runTaskOnceMock: ReturnType<typeof vi.fn>;
  handler: V1WorkerTaskHandler;
}

function makeHarness(args: {
  workOrder?: ParsedWorkOrderV1;
  decision?: ScheduleDecision;
  outcome?: RunOutcome;
  entry?: TaskQueueEntry;
  registryEntries?: AgentRegistryEntry[];
  reviewContext?: ReviewContextRecord;
  artifactTexts?: Record<string, string>;
} = {}): Harness {
  const workOrder = args.workOrder ?? makeWorkOrder({ review: { enabled: false, max_review_runs: 0 } });
  const eventLog = new FakeEventLog();
  const queue = new FakeQueue(workOrder, args.entry ?? makeEntry());
  if (args.reviewContext) {
    queue.setReviewContext(workOrder.task_id, args.reviewContext);
  }
  const scheduler = new FakeScheduler(args.decision ?? makeDecision({ pickedAgentId: "agent-a" }));
  const budgetManager = new FakeBudgetManager();
  const registry = new FakeRegistry(args.registryEntries);
  const handoffManager = new FakeHandoffManager();
  const artifactStore = new FakeArtifactStore(args.artifactTexts);
  const runTaskOnceMock = vi.fn(async () => args.outcome ?? implementerSucceeded());

  const handler = new V1WorkerTaskHandler({
    queue,
    eventLog,
    registry,
    scheduler,
    budgetManager,
    handoffManager,
    runTaskOnce: runTaskOnceMock as unknown as typeof runTaskOnce,
    runTaskServices: { artifactStore } as unknown as V1RunTaskServices,
    db: {} as Database,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  return {
    eventLog,
    queue,
    scheduler,
    budgetManager,
    registry,
    handoffManager,
    artifactStore,
    runTaskOnceMock,
    handler,
  };
}

describe("V1WorkerTaskHandler", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("loads WorkOrder JSON from queue storage and emits task.dispatched for a picked implementer", async () => {
    const harness = makeHarness();

    await harness.handler.handle({
      workerId: "worker-1",
      entry: harness.queue.entry,
      signal: new AbortController().signal,
    });

    expect(harness.queue.getWorkOrderCalls).toEqual(["T-handler"]);
    expect(harness.scheduler.calls[0].workOrder.task_id).toBe("T-handler");
    expect(harness.scheduler.calls[0].excludeAgentIds).toEqual([]);
    expect(harness.eventLog.byType("task.dispatched")[0].payload).toMatchObject({
      decision_id: "D-implementer",
      role: "implementer",
      picked_agent_id: "agent-a",
    });
  });

  it("accepts successful implementer attempts when review is disabled", async () => {
    const harness = makeHarness({
      outcome: implementerSucceeded({ runId: "run-success" }),
    });

    await harness.handler.handle({
      workerId: "worker-1",
      entry: harness.queue.entry,
      signal: new AbortController().signal,
    });

    expect(harness.queue.entry.status).toBe("accepted");
    expect(harness.queue.entry.current_owner_run_id).toBeNull();
    expect(harness.queue.entry.lease_expires_at).toBeNull();
    expect(harness.queue.entry.attempts).toBe(1);
    expect(harness.budgetManager.preLaunchCalls).toEqual(["T-handler"]);
    expect(harness.budgetManager.postRunCalls).toHaveLength(1);
    expect(harness.registry.recordOutcomeCalls).toEqual([
      expect.objectContaining({
        agentId: "agent-a",
        runId: "run-success",
        success: true,
      }),
    ]);
    expect(harness.eventLog.byType("task.completed")).toHaveLength(1);
  });

  it("accepts final allowed implementer successes when review is disabled", async () => {
    const harness = makeHarness({
      workOrder: makeWorkOrder({
        review: { enabled: false, max_review_runs: 0 },
        budget: {
          max_runs: 1,
          max_wall_time_minutes: 30,
          max_total_cost_units: 10,
        },
      }),
      outcome: implementerSucceeded({ runId: "run-final" }),
    });
    harness.budgetManager.preLaunchState = makeBudgetState({
      runs_used: 1,
      caps: finalRunCaps(),
      status: "exhausted",
    });
    harness.budgetManager.postRunState = makeBudgetState({
      runs_used: 1,
      wall_time_ms_used: 1,
      caps: finalRunCaps(),
      status: "exhausted",
    });

    await harness.handler.handle({
      workerId: "worker-1",
      entry: harness.queue.entry,
      signal: new AbortController().signal,
    });

    expect(harness.runTaskOnceMock).toHaveBeenCalledOnce();
    expect(harness.queue.entry.status).toBe("accepted");
    expect(harness.queue.entry.attempts).toBe(1);
    expect(harness.eventLog.byType("task.completed")[0].payload).toMatchObject({
      reason: "review_disabled",
    });
    expect(harness.eventLog.byType("task.failed")).toHaveLength(0);
  });

  it("fails scheduler task_budget_exhausted refusals without running an agent", async () => {
    const harness = makeHarness({
      decision: makeDecision({
        pickedAgentId: null,
        refusalReason: "task_budget_exhausted",
      }),
    });

    await harness.handler.handle({
      workerId: "worker-1",
      entry: harness.queue.entry,
      signal: new AbortController().signal,
    });

    expect(harness.queue.entry.status).toBe("failed");
    expect(harness.runTaskOnceMock).not.toHaveBeenCalled();
    expect(harness.eventLog.byType("task.dispatched")).toHaveLength(1);
    expect(harness.eventLog.byType("task.failed")[0].payload).toMatchObject({
      reason: "scheduler_refusal",
      refusal_reason: "task_budget_exhausted",
    });
  });

  it("moves all_candidates_excluded scheduler refusals to awaiting_human", async () => {
    const harness = makeHarness({
      decision: makeDecision({
        pickedAgentId: null,
        refusalReason: "all_candidates_excluded",
      }),
    });

    await harness.handler.handle({
      workerId: "worker-1",
      entry: harness.queue.entry,
      signal: new AbortController().signal,
    });

    expect(harness.queue.entry.status).toBe("awaiting_human");
    expect(harness.queue.entry.current_owner_run_id).toBeNull();
    expect(harness.queue.entry.lease_expires_at).toBeNull();
    expect(harness.runTaskOnceMock).not.toHaveBeenCalled();
    expect(harness.eventLog.byType("task.awaiting_human")[0].payload).toMatchObject({
      reason: "scheduler_refusal",
      refusal_reason: "all_candidates_excluded",
    });
  });

  it("requeues verification failures with a handoff packet and a grown exclude list", async () => {
    const harness = makeHarness({
      workOrder: makeWorkOrder({
        review: { enabled: false, max_review_runs: 0 },
        agent: {
          required_capabilities: ["code_change"],
          implementer_pool: ["agent-prior", "agent-a"],
          exclude_agent_ids: ["agent-prior"],
        },
      }),
      outcome: implementerFailedVerification(),
    });

    await harness.handler.handle({
      workerId: "worker-1",
      entry: harness.queue.entry,
      signal: new AbortController().signal,
    });

    expect(harness.queue.entry.status).toBe("queued");
    expect(harness.queue.entry.next_role).toBe("implementer");
    expect(harness.queue.entry.current_owner_run_id).toBeNull();
    expect(harness.queue.entry.lease_expires_at).toBeNull();
    expect(harness.queue.workOrder.agent.exclude_agent_ids).toEqual([
      "agent-prior",
      "agent-a",
    ]);
    expect(harness.handoffManager.persistedPackets[0]).toMatchObject({
      from_run_id: "run-fail",
      from_agent_id: "agent-a",
      reason: "verification_failed",
      exclude_agent_ids: ["agent-prior", "agent-a"],
    });
    expect(harness.eventLog.byType("handoff.requested")).toHaveLength(1);
    expect(harness.eventLog.byType("task.requeued")).toHaveLength(1);
  });

  it("records provider failure reasons and requeues through quota handoff", async () => {
    const harness = makeHarness({
      outcome: implementerFailedProviderRateLimited(),
    });

    await harness.handler.handle({
      workerId: "worker-1",
      entry: harness.queue.entry,
      signal: new AbortController().signal,
    });

    expect(harness.queue.entry.status).toBe("queued");
    expect(harness.registry.recordOutcomeCalls).toEqual([
      expect.objectContaining({
        agentId: "agent-a",
        runId: "run-provider-rate",
        success: false,
        failureReason: "provider_rate_limited",
      }),
    ]);
    expect(harness.handoffManager.persistedPackets[0]).toMatchObject({
      from_run_id: "run-provider-rate",
      from_agent_id: "agent-a",
      reason: "quota_exhausted",
    });
    expect(harness.eventLog.byType("task.requeued")[0].payload).toMatchObject({
      reason: "provider_rate_limited",
      next_role: "implementer",
    });
  });

  it("fails instead of requeueing when postRun exhausts budget after a failed attempt", async () => {
    const harness = makeHarness({
      outcome: implementerFailedVerification(),
    });
    harness.budgetManager.postRunState = makeBudgetState({
      runs_used: 2,
      status: "exhausted",
    });

    await harness.handler.handle({
      workerId: "worker-1",
      entry: harness.queue.entry,
      signal: new AbortController().signal,
    });

    expect(harness.queue.entry.status).toBe("failed");
    expect(harness.eventLog.byType("task.requeued")).toHaveLength(0);
    expect(harness.eventLog.byType("task.failed")[0].payload).toMatchObject({
      reason: "task_budget_exhausted",
      source: "postRun",
      failed_reason: "verification_failed",
    });
  });

  it("queues a reviewer entry and persists review context when review is enabled", async () => {
    const harness = makeHarness({
      workOrder: makeWorkOrder({ review: { enabled: true, max_review_runs: 1 } }),
      outcome: implementerSucceeded({
        runId: "run-impl",
        diffArtifactUri: "artifact://T-handler/run-impl/diff.patch",
        finalReportUri: "artifact://T-handler/run-impl/final_report.md",
        verificationOutputUri: "artifact://T-handler/run-impl/verification.txt",
      }),
    });

    await harness.handler.handle({
      workerId: "worker-1",
      entry: harness.queue.entry,
      signal: new AbortController().signal,
    });

    expect(harness.queue.entry.status).toBe("queued");
    expect(harness.queue.entry.next_role).toBe("reviewer");
    expect(harness.queue.entry.current_owner_run_id).toBeNull();
    expect(harness.queue.entry.lease_expires_at).toBeNull();
    expect(harness.queue.entry.attempts).toBe(1);
    expect(harness.queue.reviewContext).toEqual({
      implementer_run_id: "run-impl",
      implementer_agent_id: "agent-a",
      diff_artifact_uri: "artifact://T-handler/run-impl/diff.patch",
      final_report_uri: "artifact://T-handler/run-impl/final_report.md",
      verification_output_uri: "artifact://T-handler/run-impl/verification.txt",
    });
    expect(harness.eventLog.byType("task.requeued")[0].payload).toMatchObject({
      reason: "review_required",
      next_role: "reviewer",
    });
    expect(harness.eventLog.byType("task.failed")).toHaveLength(0);
    expect(harness.eventLog.byType("task.completed")).toHaveLength(0);
  });

  it("loads persisted review context, dispatches reviewer, and passes diff text to runTaskOnce", async () => {
    const reviewContext = makeReviewContext();
    const harness = makeReviewerHarness({
      outcome: reviewerApproved(),
      reviewContext,
      artifactTexts: {
        [reviewContext.diff_artifact_uri]: "diff --git a/a.ts b/a.ts\n+review me\n",
        [reviewContext.final_report_uri!]: "Implemented the task.",
      },
    });

    await harness.handler.handle({
      workerId: "worker-1",
      entry: harness.queue.entry,
      signal: new AbortController().signal,
    });

    expect(harness.scheduler.calls[0]).toMatchObject({
      role: "reviewer",
      mostRecentImplementerAgentId: "agent-impl",
    });
    expect(harness.eventLog.byType("task.dispatched")[0].payload).toMatchObject({
      role: "reviewer",
      picked_agent_id: "reviewer-a",
    });
    expect(harness.artifactStore.readCalls).toEqual([
      reviewContext.diff_artifact_uri,
      reviewContext.final_report_uri,
    ]);
    expect(harness.runTaskOnceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        parentRunId: "run-impl",
        reviewContext: {
          diffText: "diff --git a/a.ts b/a.ts\n+review me\n",
          diffArtifactUri: reviewContext.diff_artifact_uri,
          priorFinalReportText: "Implemented the task.",
          implementerRunId: "run-impl",
          implementerAgentId: "agent-impl",
        },
      }),
    );
  });

  it("passes pending handoff context into the next implementer attempt", async () => {
    const handoffPacket = makeHandoffPacket();
    const handoffPacketUri = "artifact://T-handler/run-impl/handoff_packet.json";
    const harness = makeHarness({
      outcome: implementerSucceeded({ runId: "run-next" }),
      artifactTexts: {
        [handoffPacketUri]: JSON.stringify(handoffPacket, null, 2) + "\n",
      },
    });
    harness.queue.setHandoffPacketUri("T-handler", handoffPacketUri);

    await harness.handler.handle({
      workerId: "worker-1",
      entry: harness.queue.entry,
      signal: new AbortController().signal,
    });

    expect(harness.artifactStore.readCalls).toEqual([handoffPacketUri]);
    expect(harness.runTaskOnceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        handoffPacketUri,
        handoffPacket,
      }),
    );
    expect(harness.queue.handoffPacketUri).toBeUndefined();
  });

  it("accepts reviewer approvals and records reviewer metrics", async () => {
    const harness = makeReviewerHarness({
      outcome: reviewerApproved({ runId: "run-review" }),
    });

    await harness.handler.handle({
      workerId: "worker-1",
      entry: harness.queue.entry,
      signal: new AbortController().signal,
    });

    expect(harness.queue.entry.status).toBe("accepted");
    expect(harness.queue.entry.current_owner_run_id).toBeNull();
    expect(harness.queue.entry.lease_expires_at).toBeNull();
    expect(harness.queue.entry.attempts).toBe(1);
    expect(harness.budgetManager.preLaunchCalls).toEqual(["T-handler"]);
    expect(harness.budgetManager.postRunCalls).toHaveLength(1);
    expect(harness.registry.recordOutcomeCalls).toEqual([
      expect.objectContaining({
        agentId: "reviewer-a",
        runId: "run-review",
        success: true,
      }),
    ]);
    expect(harness.eventLog.byType("task.completed")[0].payload).toMatchObject({
      reason: "review_approved",
      review_verdict_uri: "artifact://T-handler/run-review/review_verdict.json",
    });
  });

  it("accepts final allowed reviewer approvals", async () => {
    const harness = makeReviewerHarness({
      workOrder: makeWorkOrder({
        review: { enabled: true, max_review_runs: 1 },
        budget: {
          max_runs: 2,
          max_wall_time_minutes: 30,
          max_total_cost_units: 10,
        },
      }),
      outcome: reviewerApproved({ runId: "run-review-final" }),
    });
    harness.budgetManager.preLaunchState = makeBudgetState({
      runs_used: 2,
      caps: twoRunCaps(),
      status: "exhausted",
    });
    harness.budgetManager.postRunState = makeBudgetState({
      runs_used: 2,
      wall_time_ms_used: 1,
      caps: twoRunCaps(),
      status: "exhausted",
    });

    await harness.handler.handle({
      workerId: "worker-1",
      entry: harness.queue.entry,
      signal: new AbortController().signal,
    });

    expect(harness.runTaskOnceMock).toHaveBeenCalledOnce();
    expect(harness.queue.entry.status).toBe("accepted");
    expect(harness.eventLog.byType("task.completed")[0].payload).toMatchObject({
      reason: "review_approved",
      review_verdict_uri: "artifact://T-handler/run-review-final/review_verdict.json",
    });
    expect(harness.eventLog.byType("task.failed")).toHaveLength(0);
  });

  it("requeues reviewer changes_requested with a handoff and excludes the implementer", async () => {
    const harness = makeReviewerHarness({
      workOrder: makeWorkOrder({
        review: { enabled: true, max_review_runs: 1 },
        agent: {
          required_capabilities: ["code_change"],
          implementer_pool: ["agent-prior", "agent-impl", "agent-next"],
          reviewer_pool: ["reviewer-a"],
          exclude_agent_ids: ["agent-prior"],
        },
      }),
      outcome: reviewerChangesRequested(),
    });

    await harness.handler.handle({
      workerId: "worker-1",
      entry: harness.queue.entry,
      signal: new AbortController().signal,
    });

    expect(harness.queue.entry.status).toBe("queued");
    expect(harness.queue.entry.next_role).toBe("implementer");
    expect(harness.queue.entry.current_owner_run_id).toBeNull();
    expect(harness.queue.entry.lease_expires_at).toBeNull();
    expect(harness.queue.workOrder.agent.exclude_agent_ids).toEqual([
      "agent-prior",
      "agent-impl",
    ]);
    expect(harness.handoffManager.persistedPackets[0]).toMatchObject({
      from_run_id: "run-impl",
      from_agent_id: "agent-impl",
      reason: "review_changes_requested",
      review_verdict_uri: "artifact://T-handler/run-review/review_verdict.json",
      exclude_agent_ids: ["agent-prior", "agent-impl"],
    });
    expect(harness.eventLog.byType("handoff.requested")).toHaveLength(1);
    expect(harness.eventLog.byType("handoff.requested")[0].payload).toMatchObject({
      reason: "review_changes_requested",
      handoff_packet_uri: "artifact://T-handler/run-impl/handoff_packet.json",
      exclude_agent_ids: ["agent-prior", "agent-impl"],
    });
    expect(harness.eventLog.byType("task.requeued")[0].payload).toMatchObject({
      reason: "review_changes_requested",
      next_role: "implementer",
    });
  });

  it("fails reviewer changes_requested instead of requeueing when postRun exhausts budget", async () => {
    const harness = makeReviewerHarness({
      outcome: reviewerChangesRequested({ runId: "run-review-final" }),
    });
    harness.budgetManager.postRunState = makeBudgetState({
      runs_used: 2,
      caps: twoRunCaps(),
      status: "exhausted",
    });

    await harness.handler.handle({
      workerId: "worker-1",
      entry: harness.queue.entry,
      signal: new AbortController().signal,
    });

    expect(harness.queue.entry.status).toBe("failed");
    expect(harness.queue.workOrder.agent.exclude_agent_ids).toEqual([]);
    expect(harness.handoffManager.persistedPackets).toHaveLength(0);
    expect(harness.eventLog.byType("task.requeued")).toHaveLength(0);
    expect(harness.eventLog.byType("task.failed")[0].payload).toMatchObject({
      reason: "task_budget_exhausted",
      source: "postRun",
      reviewer_outcome: "reviewer_changes_requested",
    });
  });

  it("moves reviewer rejections to awaiting_human", async () => {
    const harness = makeReviewerHarness({
      outcome: reviewerRejected(),
    });

    await harness.handler.handle({
      workerId: "worker-1",
      entry: harness.queue.entry,
      signal: new AbortController().signal,
    });

    expect(harness.queue.entry.status).toBe("awaiting_human");
    expect(harness.queue.entry.current_owner_run_id).toBeNull();
    expect(harness.queue.entry.lease_expires_at).toBeNull();
    expect(harness.eventLog.byType("task.awaiting_human")[0].payload).toMatchObject({
      reason: "review_rejected",
      review_verdict_uri: "artifact://T-handler/run-review/review_verdict.json",
    });
  });

  it("moves final allowed reviewer rejections to awaiting_human", async () => {
    const harness = makeReviewerHarness({
      outcome: reviewerRejected({ runId: "run-review-final" }),
    });
    harness.budgetManager.preLaunchState = makeBudgetState({
      runs_used: 2,
      caps: twoRunCaps(),
      status: "exhausted",
    });
    harness.budgetManager.postRunState = makeBudgetState({
      runs_used: 2,
      wall_time_ms_used: 1,
      caps: twoRunCaps(),
      status: "exhausted",
    });

    await harness.handler.handle({
      workerId: "worker-1",
      entry: harness.queue.entry,
      signal: new AbortController().signal,
    });

    expect(harness.runTaskOnceMock).toHaveBeenCalledOnce();
    expect(harness.queue.entry.status).toBe("awaiting_human");
    expect(harness.eventLog.byType("task.awaiting_human")[0].payload).toMatchObject({
      reason: "review_rejected",
      review_verdict_uri: "artifact://T-handler/run-review-final/review_verdict.json",
    });
    expect(harness.eventLog.byType("task.failed")).toHaveLength(0);
  });

  it("treats reviewer diff_apply_failed as implementer changes requested without reviewer metrics", async () => {
    const harness = makeReviewerHarness({
      outcome: reviewerDiffApplyFailed(),
    });

    await harness.handler.handle({
      workerId: "worker-1",
      entry: harness.queue.entry,
      signal: new AbortController().signal,
    });

    expect(harness.queue.entry.status).toBe("queued");
    expect(harness.queue.entry.next_role).toBe("implementer");
    expect(harness.queue.workOrder.agent.exclude_agent_ids).toEqual(["agent-impl"]);
    expect(harness.queue.workOrder.agent.exclude_agent_ids).not.toContain("reviewer-a");
    expect(harness.registry.recordOutcomeCalls).toEqual([]);
    expect(harness.handoffManager.persistedPackets[0]).toMatchObject({
      from_run_id: "run-impl",
      from_agent_id: "agent-impl",
      reason: "diff_apply_failed",
      exclude_agent_ids: ["agent-impl"],
    });
    expect(harness.eventLog.byType("handoff.requested")[0].payload).toMatchObject({
      reason: "diff_apply_failed",
      handoff_packet_uri: "artifact://T-handler/run-impl/handoff_packet.json",
      exclude_agent_ids: ["agent-impl"],
    });
    expect(harness.eventLog.byType("task.requeued")[0].payload).toMatchObject({
      reason: "diff_apply_failed",
      next_role: "implementer",
    });
  });

  it.each([
    "agent_nonzero_exit",
    "agent_timed_out",
    "spawn_failed",
    "reviewer_unusable",
  ] as const)("fails reviewer_unusable %s outcomes and records reviewer metrics", async (reason) => {
    const runId = `run-${reason}`;
    const harness = makeReviewerHarness({
      outcome: reviewerUnusable(reason, { runId }),
    });

    await harness.handler.handle({
      workerId: "worker-1",
      entry: harness.queue.entry,
      signal: new AbortController().signal,
    });

    expect(harness.queue.entry.status).toBe("failed");
    expect(harness.eventLog.byType("task.failed")[0].payload).toMatchObject({
      reason,
      reviewer_outcome: "reviewer_unusable",
    });
    expect(harness.eventLog.byType("task.requeued")).toHaveLength(0);
    expect(harness.registry.recordOutcomeCalls).toEqual([
      expect.objectContaining({
        agentId: "reviewer-a",
        runId,
        success: false,
      }),
    ]);
  });

  it("fails reviewer_unusable internal_error outcomes without recording reviewer metrics", async () => {
    const harness = makeReviewerHarness({
      outcome: reviewerUnusable("internal_error", { runId: "run-internal-error" }),
    });

    await harness.handler.handle({
      workerId: "worker-1",
      entry: harness.queue.entry,
      signal: new AbortController().signal,
    });

    expect(harness.queue.entry.status).toBe("failed");
    expect(harness.eventLog.byType("task.failed")[0].payload).toMatchObject({
      reason: "internal_error",
      reviewer_outcome: "reviewer_unusable",
    });
    expect(harness.eventLog.byType("task.requeued")).toHaveLength(0);
    expect(harness.registry.recordOutcomeCalls).toEqual([]);
  });

  it("moves reviewer all_candidates_excluded scheduler refusals to awaiting_human without running", async () => {
    const harness = makeReviewerHarness({
      decision: makeDecision({
        role: "reviewer",
        pickedAgentId: null,
        refusalReason: "all_candidates_excluded",
      }),
      outcome: reviewerApproved(),
    });

    await harness.handler.handle({
      workerId: "worker-1",
      entry: harness.queue.entry,
      signal: new AbortController().signal,
    });

    expect(harness.queue.entry.status).toBe("awaiting_human");
    expect(harness.runTaskOnceMock).not.toHaveBeenCalled();
    expect(harness.eventLog.byType("task.dispatched")[0].payload).toMatchObject({
      role: "reviewer",
      refusal_reason: "all_candidates_excluded",
    });
    expect(harness.eventLog.byType("task.awaiting_human")).toHaveLength(1);
  });
});

function makeEntry(overrides: Partial<TaskQueueEntry> = {}): TaskQueueEntry {
  return {
    task_id: "T-handler",
    project_id: "default",
    status: "dispatched",
    next_role: "implementer",
    current_owner_run_id: "worker-1",
    lease_expires_at: "2026-01-01T00:05:00.000Z",
    attempts: 0,
    enqueued_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeWorkOrder(overrides: Record<string, unknown> = {}): ParsedWorkOrderV1 {
  return parseWorkOrderV1({
    schema_version: "workflow/v1",
    task_id: "T-handler",
    project_id: "default",
    title: "Worker handler task",
    type: "code_change",
    goal: "Implement a handler.",
    acceptance_criteria: ["handler works"],
    repo: { path: "/tmp/repo" },
    agent: {
      required_capabilities: ["code_change"],
      implementer_pool: ["agent-a"],
      exclude_agent_ids: [],
    },
    review: { enabled: false, max_review_runs: 0 },
    budget: {
      max_runs: 4,
      max_wall_time_minutes: 30,
      max_total_cost_units: 10,
    },
    ...overrides,
  });
}

function makeAgentEntry(args: {
  agentId?: string;
  roles?: Array<"implementer" | "reviewer">;
} = {}): AgentRegistryEntry {
  const agentId = args.agentId ?? "agent-a";
  const roles = args.roles ?? ["implementer"];
  return {
    profile: parseAgentProfileV1({
      schema_version: "workflow/v1",
      agent_id: agentId,
      integration_mode: "official_cli",
      command: {
        executable: "agent",
        args: ["run", "{{prompt_file}}"],
      },
      capabilities: {
        outer_supervised: true,
        inner_tool_control: false,
        kinds: ["code_change"],
        roles,
      },
      cost_profile: {
        billing_unit: "call",
        estimated_cost_per_run_units: 2,
      },
    }),
    loaded_from: "/tmp/agent-a.json",
    quota_health: "healthy",
    rolling_metrics: {
      success_rate: 0.8,
      avg_latency_ms: 100,
      avg_actual_cost_units: 0,
      runs_observed: 0,
      last_updated_at: "2026-01-01T00:00:00.000Z",
    },
  };
}

function makeDecision(args: {
  pickedAgentId: string | null;
  role?: "implementer" | "reviewer";
  refusalReason?: ScheduleDecision["refusal_reason"];
}): ScheduleDecision {
  const role = args.role ?? "implementer";
  return {
    schema_version: "agent-workflow/1",
    decision_id: `D-${role}`,
    task_id: "T-handler",
    role,
    picked_agent_id: args.pickedAgentId,
    refusal_reason: args.refusalReason,
    candidate_scores: [],
    decided_at: "2026-01-01T00:00:00.000Z",
  };
}

function makeBudgetState(overrides: Partial<BudgetState> = {}): BudgetState {
  return {
    task_id: "T-handler",
    runs_used: 0,
    wall_time_ms_used: 0,
    cost_units_used: 0,
    caps: {
      max_runs: 4,
      max_wall_time_ms: 30 * 60_000,
      max_total_cost_units: 10,
    },
    status: "ok",
    ...overrides,
  };
}

function finalRunCaps(): BudgetState["caps"] {
  return {
    max_runs: 1,
    max_wall_time_ms: 30 * 60_000,
    max_total_cost_units: 10,
  };
}

function twoRunCaps(): BudgetState["caps"] {
  return {
    max_runs: 2,
    max_wall_time_ms: 30 * 60_000,
    max_total_cost_units: 10,
  };
}

function implementerSucceeded(
  overrides: Partial<Extract<RunOutcome, { kind: "implementer_succeeded" }>> = {},
): Extract<RunOutcome, { kind: "implementer_succeeded" }> {
  return {
    kind: "implementer_succeeded",
    runId: "run-success",
    diffArtifactUri: "artifact://T-handler/run-success/diff.patch",
    verificationOutputUri: "artifact://T-handler/run-success/verification.txt",
    ...overrides,
  };
}

function implementerFailedVerification(): Extract<RunOutcome, { kind: "implementer_failed" }> {
  return {
    kind: "implementer_failed",
    runId: "run-fail",
    reason: "verification_failed",
    diffArtifactUri: "artifact://T-handler/run-fail/diff.patch",
    verificationOutputUri: "artifact://T-handler/run-fail/verification.txt",
  };
}

function implementerFailedProviderRateLimited(): Extract<RunOutcome, { kind: "implementer_failed" }> {
  return {
    kind: "implementer_failed",
    runId: "run-provider-rate",
    reason: "provider_rate_limited",
    diffArtifactUri: "artifact://T-handler/run-provider-rate/diff.patch",
  };
}

function makeReviewContext(
  overrides: Partial<ReviewContextRecord> = {},
): ReviewContextRecord {
  return {
    implementer_run_id: "run-impl",
    implementer_agent_id: "agent-impl",
    diff_artifact_uri: "artifact://T-handler/run-impl/diff.patch",
    final_report_uri: "artifact://T-handler/run-impl/final_report.md",
    verification_output_uri: "artifact://T-handler/run-impl/verification.txt",
    ...overrides,
  };
}

function makeHandoffPacket(
  overrides: Partial<HandoffPacket> = {},
): HandoffPacket {
  return {
    schema_version: "agent-workflow/1",
    task_id: "T-handler",
    from_run_id: "run-impl",
    from_agent_id: "agent-impl",
    reason: "review_changes_requested",
    summary: "Review requested changes.",
    diff_artifact_uri: "artifact://T-handler/run-impl/diff.patch",
    review_verdict_uri: "artifact://T-handler/run-review/review_verdict.json",
    remaining_work: "Implement a handler.",
    exclude_agent_ids: ["agent-impl"],
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeReviewerHarness(args: {
  workOrder?: ParsedWorkOrderV1;
  decision?: ScheduleDecision;
  outcome?: RunOutcome;
  reviewContext?: ReviewContextRecord;
  artifactTexts?: Record<string, string>;
} = {}): Harness {
  const reviewContext = args.reviewContext ?? makeReviewContext();
  return makeHarness({
    workOrder: args.workOrder ?? makeWorkOrder({ review: { enabled: true, max_review_runs: 1 } }),
    entry: makeEntry({ next_role: "reviewer" }),
    decision: args.decision ?? makeDecision({ role: "reviewer", pickedAgentId: "reviewer-a" }),
    outcome: args.outcome,
    registryEntries: [
      makeAgentEntry({ agentId: "reviewer-a", roles: ["reviewer"] }),
    ],
    reviewContext,
    artifactTexts: args.artifactTexts ?? {
      [reviewContext.diff_artifact_uri]: "diff --git a/a.ts b/a.ts\n+review me\n",
      ...(reviewContext.final_report_uri !== undefined
        ? { [reviewContext.final_report_uri]: "Implemented the task." }
        : {}),
    },
  });
}

function reviewerApproved(
  overrides: Partial<Extract<RunOutcome, { kind: "reviewer_approved" }>> = {},
): Extract<RunOutcome, { kind: "reviewer_approved" }> {
  const runId = overrides.runId ?? "run-review";
  return {
    kind: "reviewer_approved",
    runId,
    reviewVerdictUri: `artifact://T-handler/${runId}/review_verdict.json`,
    ...overrides,
  };
}

function reviewerChangesRequested(
  overrides: Partial<Extract<RunOutcome, { kind: "reviewer_changes_requested" }>> = {},
): Extract<RunOutcome, { kind: "reviewer_changes_requested" }> {
  const runId = overrides.runId ?? "run-review";
  return {
    kind: "reviewer_changes_requested",
    runId,
    reviewVerdictUri: `artifact://T-handler/${runId}/review_verdict.json`,
    ...overrides,
  };
}

function reviewerRejected(
  overrides: Partial<Extract<RunOutcome, { kind: "reviewer_rejected" }>> = {},
): Extract<RunOutcome, { kind: "reviewer_rejected" }> {
  const runId = overrides.runId ?? "run-review";
  return {
    kind: "reviewer_rejected",
    runId,
    reviewVerdictUri: `artifact://T-handler/${runId}/review_verdict.json`,
    ...overrides,
  };
}

function reviewerDiffApplyFailed(
  overrides: Partial<Extract<RunOutcome, { kind: "reviewer_unusable" }>> = {},
): Extract<RunOutcome, { kind: "reviewer_unusable" }> {
  return reviewerUnusable("diff_apply_failed", overrides);
}

function reviewerUnusable(
  reason: Extract<RunOutcome, { kind: "reviewer_unusable" }>["reason"],
  overrides: Partial<Extract<RunOutcome, { kind: "reviewer_unusable" }>> = {},
): Extract<RunOutcome, { kind: "reviewer_unusable" }> {
  return {
    kind: "reviewer_unusable",
    runId: "run-review",
    reason,
    ...overrides,
  };
}

function dedupeFirstSeen(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
