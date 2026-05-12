import type { Database } from "../storage/database.js";
import type { EventLog } from "../storage/event-log.js";
import type { AgentRegistry } from "../scheduling/agent-registry.js";
import type { Scheduler } from "../scheduling/scheduler.js";
import type { BudgetManager } from "../scheduling/budget-manager.js";
import type { HandoffManager } from "../scheduling/handoff-manager.js";
import {
  runTaskOnce,
  type ImplementerFailureReason,
  type RunOutcome,
  type V1RunTaskServices,
} from "../core/orchestrator-v1.js";
import { OperationAbortedError, isOperationAbortedError, throwIfAborted } from "../core/abort-error.js";
import { generateEventId } from "../core/ids.js";
import type { RunFailedReason } from "../core/events.js";
import { HandoffPacketSchema, parseAgentProfileV1, type ParsedWorkOrderV1 } from "../core/schemas-v1.js";
import type {
  AgentRegistryEntry,
  BudgetState,
  EventEnvelope,
  HandoffPacket,
  ReviewContextRecord,
  ScheduleDecision,
  TaskQueueEntry,
} from "../core/types.js";
import type { TaskQueue } from "./task-queue.js";
import type { WorkerTaskHandler } from "./worker.js";

export interface V1WorkerTaskHandlerServices {
  queue: TaskQueue;
  eventLog: EventLog;
  registry: AgentRegistry;
  scheduler: Scheduler;
  budgetManager: BudgetManager;
  handoffManager: HandoffManager;
  runTaskOnce: typeof runTaskOnce;
  runTaskServices: V1RunTaskServices;
  db: Database;
  now?: () => Date;
}

type SchedulerRefusalReason = NonNullable<ScheduleDecision["refusal_reason"]>;

export class V1WorkerTaskHandler implements WorkerTaskHandler {
  private readonly services: V1WorkerTaskHandlerServices;

  constructor(services: V1WorkerTaskHandlerServices) {
    this.services = services;
  }

  async handle(args: {
    workerId: string;
    entry: TaskQueueEntry;
    signal: AbortSignal;
  }): Promise<void> {
    void args.workerId;
    throwIfAborted(args.signal);

    const { entry } = args;
    const workOrder = this.services.queue.getWorkOrder(entry.task_id);
    if (!workOrder) {
      this.failWithoutAttempt(entry, {
        reason: "work_order_not_found",
      });
      return;
    }

    const persistedReviewContext =
      entry.next_role === "reviewer"
        ? this.services.queue.getReviewContext(entry.task_id)
        : undefined;
    const pendingHandoffPacketUri =
      entry.next_role === "implementer"
        ? this.services.queue.getHandoffPacketUri(entry.task_id)
        : undefined;
    if (entry.next_role === "reviewer" && !persistedReviewContext) {
      this.failTask(entry, {
        status: "failed",
        reason: "review_context_not_found",
        attempts: entry.attempts,
      });
      return;
    }

    let budget = this.services.budgetManager.init(workOrder);
    budget = this.services.budgetManager.current(entry.task_id);

    const decision = this.services.scheduler.decide({
      workOrder,
      role: entry.next_role,
      excludeAgentIds: workOrder.agent.exclude_agent_ids,
      registry: this.services.registry,
      budget,
      mostRecentImplementerAgentId: persistedReviewContext?.implementer_agent_id,
    });
    this.emitTaskDispatched(entry, decision);

    if (!decision.picked_agent_id) {
      this.handleSchedulerRefusal(entry, decision);
      return;
    }

    const agentEntry = this.services.registry.get(decision.picked_agent_id);
    if (!agentEntry) {
      this.failTask(entry, {
        status: "failed",
        reason: "picked_agent_not_found",
        attempts: entry.attempts,
        payload: { picked_agent_id: decision.picked_agent_id },
      });
      return;
    }

    let pendingHandoffPacket: HandoffPacket | undefined;
    if (pendingHandoffPacketUri) {
      try {
        pendingHandoffPacket = this.materializeHandoffPacket(pendingHandoffPacketUri);
      } catch {
        this.failTask(entry, {
          status: "failed",
          reason: "handoff_packet_read_failed",
          attempts: entry.attempts,
          payload: { handoff_packet_uri: pendingHandoffPacketUri },
        });
        return;
      }
    }

    throwIfAborted(args.signal);
    this.services.budgetManager.preLaunch(entry.task_id);

    if (args.signal.aborted) {
      throw new OperationAbortedError();
    }

    const startedAtMs = this.now().getTime();
    let outcome: RunOutcome;
    try {
      const reviewContext = persistedReviewContext
        ? this.materializeReviewContext(persistedReviewContext)
        : undefined;
      outcome = await this.services.runTaskOnce({
        entry,
        decision,
        agentProfile: parseAgentProfileV1(agentEntry.profile),
        workOrder,
        services: this.services.runTaskServices,
        db: this.services.db,
        parentRunId: persistedReviewContext?.implementer_run_id,
        handoffPacketUri: pendingHandoffPacketUri,
        handoffPacket: pendingHandoffPacket,
        reviewContext,
        signal: args.signal,
      });
    } catch (error) {
      if (isOperationAbortedError(error) || args.signal.aborted) {
        throw error instanceof Error ? error : new OperationAbortedError();
      }
      this.failTask(entry, {
        status: "failed",
        reason: persistedReviewContext ? "review_context_read_or_run_task_once_threw" : "run_task_once_threw",
        attempts: entry.attempts,
      });
      return;
    }

    if (entry.next_role === "implementer" && pendingHandoffPacketUri) {
      this.services.queue.setHandoffPacketUri(entry.task_id, undefined);
    }

    const wallTimeMs = Math.max(0, this.now().getTime() - startedAtMs);
    const estimatedCostUnits = estimatedCostFor(agentEntry);
    const postRunBudget = this.services.budgetManager.postRun({
      taskId: entry.task_id,
      runDurationMs: wallTimeMs,
      estimatedCostUnits,
    });

    this.recordAgentOutcome(agentEntry, outcome, wallTimeMs);

    if (isImplementerSucceeded(outcome)) {
      this.handleImplementerSuccess(entry, workOrder, agentEntry, outcome, postRunBudget);
      return;
    }

    if (isImplementerFailed(outcome)) {
      this.handleImplementerFailure(entry, workOrder, agentEntry, outcome, postRunBudget);
      return;
    }

    if (!persistedReviewContext) {
      this.failTask(entry, {
        status: "failed",
        reason: "unexpected_reviewer_outcome_for_implementer_entry",
        attempts: entry.attempts + 1,
      });
      return;
    }

    this.handleReviewerOutcome(
      entry,
      workOrder,
      agentEntry,
      persistedReviewContext,
      outcome,
      postRunBudget,
    );
  }

  private handleSchedulerRefusal(entry: TaskQueueEntry, decision: ScheduleDecision): void {
    const reason = decision.refusal_reason;
    if (!reason) {
      this.failTask(entry, {
        status: "failed",
        reason: "scheduler_refusal_missing_reason",
        attempts: entry.attempts,
        payload: { decision_id: decision.decision_id },
      });
      return;
    }

    if (reason === "all_candidates_excluded") {
      this.release(entry, {
        status: "awaiting_human",
        attempts: entry.attempts,
      });
      this.appendEvent({
        eventType: "task.awaiting_human",
        entry,
        payload: this.refusalPayload(decision, reason),
      });
      return;
    }

    this.release(entry, {
      status: "failed",
      attempts: entry.attempts,
    });
    this.appendEvent({
      eventType: "task.failed",
      entry,
      payload: this.refusalPayload(decision, reason),
    });
  }

  private handleImplementerSuccess(
    entry: TaskQueueEntry,
    workOrder: ParsedWorkOrderV1,
    agentEntry: AgentRegistryEntry,
    outcome: Extract<RunOutcome, { kind: "implementer_succeeded" }>,
    postRunBudget: BudgetState,
  ): void {
    if (workOrder.review.enabled) {
      if (postRunBudget.status === "exhausted") {
        this.failTask(entry, {
          status: "failed",
          reason: "task_budget_exhausted",
          attempts: entry.attempts + 1,
          runId: outcome.runId,
          payload: {
            source: "postRun",
            next_role: "reviewer",
          },
        });
        return;
      }

      this.services.queue.setReviewContext(entry.task_id, {
        implementer_run_id: outcome.runId,
        implementer_agent_id: agentEntry.profile.agent_id,
        diff_artifact_uri: outcome.diffArtifactUri,
        ...(outcome.finalReportUri !== undefined ? { final_report_uri: outcome.finalReportUri } : {}),
        ...(outcome.verificationOutputUri !== undefined ? { verification_output_uri: outcome.verificationOutputUri } : {}),
      });
      this.release(entry, {
        status: "queued",
        next_role: "reviewer",
        attempts: entry.attempts + 1,
      });
      this.appendEvent({
        eventType: "task.requeued",
        entry,
        runId: outcome.runId,
        agentId: agentEntry.profile.agent_id,
        payload: {
          reason: "review_required",
          next_role: "reviewer",
          diff_artifact_uri: outcome.diffArtifactUri,
          final_report_uri: outcome.finalReportUri,
          verification_output_uri: outcome.verificationOutputUri,
        },
      });
      return;
    }

    this.release(entry, {
      status: "accepted",
      attempts: entry.attempts + 1,
    });
    this.appendEvent({
      eventType: "task.completed",
      entry,
      runId: outcome.runId,
      payload: {
        reason: "review_disabled",
        diff_artifact_uri: outcome.diffArtifactUri,
        verification_output_uri: outcome.verificationOutputUri,
        final_report_uri: outcome.finalReportUri,
      },
    });
  }

  private handleReviewerOutcome(
    entry: TaskQueueEntry,
    workOrder: ParsedWorkOrderV1,
    agentEntry: AgentRegistryEntry,
    reviewContext: ReviewContextRecord,
    outcome: Exclude<RunOutcome, Extract<RunOutcome, { kind: "implementer_succeeded" | "implementer_failed" }>>,
    postRunBudget: BudgetState,
  ): void {
    if (outcome.kind === "reviewer_approved") {
      this.release(entry, {
        status: "accepted",
        attempts: entry.attempts + 1,
      });
      this.appendEvent({
        eventType: "task.completed",
        entry,
        runId: outcome.runId,
        agentId: agentEntry.profile.agent_id,
        payload: {
          reason: "review_approved",
          review_verdict_uri: outcome.reviewVerdictUri,
          implementer_run_id: reviewContext.implementer_run_id,
          diff_artifact_uri: reviewContext.diff_artifact_uri,
        },
      });
      return;
    }

    if (outcome.kind === "reviewer_rejected") {
      this.release(entry, {
        status: "awaiting_human",
        attempts: entry.attempts + 1,
      });
      this.appendEvent({
        eventType: "task.awaiting_human",
        entry,
        runId: outcome.runId,
        agentId: agentEntry.profile.agent_id,
        payload: {
          reason: "review_rejected",
          review_verdict_uri: outcome.reviewVerdictUri,
          implementer_run_id: reviewContext.implementer_run_id,
        },
      });
      return;
    }

    if (outcome.kind === "reviewer_changes_requested") {
      if (postRunBudget.status === "exhausted") {
        this.failTask(entry, {
          status: "failed",
          reason: "task_budget_exhausted",
          attempts: entry.attempts + 1,
          runId: outcome.runId,
          payload: {
            source: "postRun",
            reviewer_outcome: outcome.kind,
            review_verdict_uri: outcome.reviewVerdictUri,
          },
        });
        return;
      }

      this.requeueImplementerAfterReview(entry, workOrder, agentEntry, reviewContext, {
        runId: outcome.runId,
        reason: "review_changes_requested",
        reviewVerdictUri: outcome.reviewVerdictUri,
      });
      return;
    }

    if (outcome.kind === "reviewer_unusable" && outcome.reason === "diff_apply_failed") {
      if (postRunBudget.status === "exhausted") {
        this.failTask(entry, {
          status: "failed",
          reason: "task_budget_exhausted",
          attempts: entry.attempts + 1,
          runId: outcome.runId,
          payload: {
            source: "postRun",
            reviewer_outcome: outcome.kind,
            failed_reason: outcome.reason,
          },
        });
        return;
      }

      this.requeueImplementerAfterReview(entry, workOrder, agentEntry, reviewContext, {
        runId: outcome.runId,
        reason: "diff_apply_failed",
      });
      return;
    }

    this.failTask(entry, {
      status: "failed",
      reason: outcome.reason,
      attempts: entry.attempts + 1,
      runId: outcome.runId,
      payload: {
        reviewer_outcome: outcome.kind,
        review_verdict_uri: outcome.reviewVerdictUri,
      },
    });
  }

  private requeueImplementerAfterReview(
    entry: TaskQueueEntry,
    workOrder: ParsedWorkOrderV1,
    reviewerEntry: AgentRegistryEntry,
    reviewContext: ReviewContextRecord,
    args: {
      runId: string;
      reason: "review_changes_requested" | "diff_apply_failed";
      reviewVerdictUri?: string;
    },
  ): void {
    const packet = this.services.handoffManager.build({
      taskId: entry.task_id,
      fromRunId: reviewContext.implementer_run_id,
      fromAgentId: reviewContext.implementer_agent_id,
      workOrderGoal: workOrder.goal,
      reason: args.reason,
      diffArtifactUri: reviewContext.diff_artifact_uri,
      verificationOutputUri: reviewContext.verification_output_uri,
      reviewVerdictUri: args.reviewVerdictUri,
      priorExcludes: workOrder.agent.exclude_agent_ids,
    });
    const artifact = this.services.handoffManager.persist(packet);
    this.emitHandoffRequested(entry, args.runId, reviewerEntry.profile.agent_id, packet, artifact.uri);
    this.services.queue.addWorkOrderExcludeAgentIds(entry.task_id, packet.exclude_agent_ids);
    this.services.queue.setHandoffPacketUri(entry.task_id, artifact.uri);

    this.release(entry, {
      status: "queued",
      next_role: "implementer",
      attempts: entry.attempts + 1,
    });
    this.appendEvent({
      eventType: "task.requeued",
      entry,
      runId: args.runId,
      agentId: reviewerEntry.profile.agent_id,
      payload: {
        reason: args.reason,
        next_role: "implementer",
        handoff_packet_uri: artifact.uri,
        review_verdict_uri: args.reviewVerdictUri,
        implementer_run_id: reviewContext.implementer_run_id,
        implementer_agent_id: reviewContext.implementer_agent_id,
        diff_artifact_uri: reviewContext.diff_artifact_uri,
      },
    });
  }

  private handleImplementerFailure(
    entry: TaskQueueEntry,
    workOrder: ParsedWorkOrderV1,
    agentEntry: AgentRegistryEntry,
    outcome: Extract<RunOutcome, { kind: "implementer_failed" }>,
    postRunBudget: BudgetState,
  ): void {
    const handoffReason = handoffReasonForImplementerFailure(outcome.reason);
    if (!handoffReason) {
      this.failTask(entry, {
        status: "failed",
        reason: outcome.reason,
        attempts: entry.attempts + 1,
        runId: outcome.runId,
      });
      return;
    }

    const packet = this.services.handoffManager.build({
      taskId: entry.task_id,
      fromRunId: outcome.runId,
      fromAgentId: agentEntry.profile.agent_id,
      workOrderGoal: workOrder.goal,
      reason: handoffReason,
      diffArtifactUri: outcome.diffArtifactUri,
      verificationOutputUri: outcome.verificationOutputUri,
      priorExcludes: workOrder.agent.exclude_agent_ids,
    });
    const artifact = this.services.handoffManager.persist(packet);
    this.emitHandoffRequested(entry, outcome.runId, agentEntry.profile.agent_id, packet, artifact.uri);
    this.services.queue.addWorkOrderExcludeAgentIds(entry.task_id, packet.exclude_agent_ids);
    this.services.queue.setHandoffPacketUri(entry.task_id, artifact.uri);

    if (postRunBudget.status === "exhausted") {
      this.failTask(entry, {
        status: "failed",
        reason: "task_budget_exhausted",
        attempts: entry.attempts + 1,
        runId: outcome.runId,
        payload: {
          source: "postRun",
          handoff_packet_uri: artifact.uri,
          failed_reason: outcome.reason,
        },
      });
      return;
    }

    this.release(entry, {
      status: "queued",
      next_role: "implementer",
      attempts: entry.attempts + 1,
    });
    this.appendEvent({
      eventType: "task.requeued",
      entry,
      runId: outcome.runId,
      agentId: agentEntry.profile.agent_id,
      payload: {
        reason: outcome.reason,
        next_role: "implementer",
        handoff_packet_uri: artifact.uri,
      },
    });
  }

  private emitTaskDispatched(entry: TaskQueueEntry, decision: ScheduleDecision): void {
    this.appendEvent({
      eventType: "task.dispatched",
      entry,
      payload: {
        ...decision,
        decision_id: decision.decision_id,
        role: decision.role,
        picked_agent_id: decision.picked_agent_id,
        refusal_reason: decision.refusal_reason,
      },
    });
  }

  private emitHandoffRequested(
    entry: TaskQueueEntry,
    runId: string,
    agentId: string,
    packet: HandoffPacket,
    handoffPacketUri: string,
  ): void {
    this.appendEvent({
      eventType: "handoff.requested",
      entry,
      runId,
      agentId,
      payload: {
        handoff_packet_uri: handoffPacketUri,
        reason: packet.reason,
        exclude_agent_ids: packet.exclude_agent_ids,
      },
    });
  }

  private failWithoutAttempt(entry: TaskQueueEntry, args: { reason: string }): void {
    this.failTask(entry, {
      status: "failed",
      reason: args.reason,
      attempts: entry.attempts,
    });
  }

  private failTask(
    entry: TaskQueueEntry,
    args: {
      status: "failed";
      reason: string;
      attempts: number;
      runId?: string;
      payload?: Record<string, unknown>;
    },
  ): void {
    this.release(entry, {
      status: args.status,
      attempts: args.attempts,
    });
    this.appendEvent({
      eventType: "task.failed",
      entry,
      runId: args.runId,
      payload: {
        reason: args.reason,
        ...args.payload,
      },
    });
  }

  private release(
    entry: TaskQueueEntry,
    patch: {
      status: TaskQueueEntry["status"];
      next_role?: TaskQueueEntry["next_role"];
      attempts: number;
    },
  ): void {
    this.services.queue.release(entry.task_id, {
      status: patch.status,
      next_role: patch.next_role ?? entry.next_role,
      attempts: patch.attempts,
      current_owner_run_id: null,
      lease_expires_at: null,
      updated_at: this.now().toISOString(),
    });
  }

  private appendEvent(args: {
    eventType: string;
    entry: TaskQueueEntry;
    runId?: string;
    agentId?: string;
    payload?: Record<string, unknown>;
  }): void {
    const event: EventEnvelope = {
      event_id: generateEventId(),
      event_type: args.eventType,
      project_id: args.entry.project_id,
      task_id: args.entry.task_id,
      run_id: args.runId,
      agent_id: args.agentId,
      payload: args.payload ?? {},
      created_at: this.now().toISOString(),
    };
    this.services.eventLog.append(event);
  }

  private refusalPayload(
    decision: ScheduleDecision,
    reason: SchedulerRefusalReason,
  ): Record<string, unknown> {
    return {
      reason: "scheduler_refusal",
      refusal_reason: reason,
      decision_id: decision.decision_id,
      role: decision.role,
    };
  }

  private recordAgentOutcome(
    agentEntry: AgentRegistryEntry,
    outcome: RunOutcome,
    wallTimeMs: number,
  ): void {
    if (isImplementerFailed(outcome) && outcome.reason === "internal_error") {
      return;
    }
    if (isReviewerUnusable(outcome) && (outcome.reason === "diff_apply_failed" || outcome.reason === "internal_error")) {
      return;
    }

    this.services.registry.recordOutcome({
      agentId: agentEntry.profile.agent_id,
      runId: outcome.runId,
      success: isImplementerSucceeded(outcome) || isReviewerVerdictOutcome(outcome),
      wallTimeMs,
      failureReason: runFailedReasonForOutcome(outcome),
    });
  }

  private now(): Date {
    return (this.services.now ?? (() => new Date()))();
  }

  private materializeReviewContext(record: ReviewContextRecord): {
    diffText: string;
    diffArtifactUri: string;
    priorFinalReportText?: string;
    implementerRunId: string;
    implementerAgentId: string;
  } {
    const artifactStore = this.services.runTaskServices.artifactStore;
    const diffText = artifactStore.readText(record.diff_artifact_uri);
    const priorFinalReportText = record.final_report_uri
      ? artifactStore.readText(record.final_report_uri)
      : undefined;

    return {
      diffText,
      diffArtifactUri: record.diff_artifact_uri,
      ...(priorFinalReportText !== undefined ? { priorFinalReportText } : {}),
      implementerRunId: record.implementer_run_id,
      implementerAgentId: record.implementer_agent_id,
    };
  }

  private materializeHandoffPacket(uri: string): HandoffPacket {
    const raw = this.services.runTaskServices.artifactStore.readText(uri);
    return HandoffPacketSchema.parse(JSON.parse(raw)) as HandoffPacket;
  }
}

function estimatedCostFor(agentEntry: AgentRegistryEntry): number {
  return agentEntry.profile.cost_profile?.estimated_cost_per_run_units ?? 0;
}

function isImplementerSucceeded(
  outcome: RunOutcome,
): outcome is Extract<RunOutcome, { kind: "implementer_succeeded" }> {
  return outcome.kind === "implementer_succeeded";
}

function isImplementerFailed(
  outcome: RunOutcome,
): outcome is Extract<RunOutcome, { kind: "implementer_failed" }> {
  return outcome.kind === "implementer_failed";
}

function isReviewerVerdictOutcome(
  outcome: RunOutcome,
): outcome is Extract<RunOutcome, { kind: "reviewer_approved" | "reviewer_changes_requested" | "reviewer_rejected" }> {
  return (
    outcome.kind === "reviewer_approved" ||
    outcome.kind === "reviewer_changes_requested" ||
    outcome.kind === "reviewer_rejected"
  );
}

function isReviewerUnusable(
  outcome: RunOutcome,
): outcome is Extract<RunOutcome, { kind: "reviewer_unusable" }> {
  return outcome.kind === "reviewer_unusable";
}

function handoffReasonForImplementerFailure(
  reason: ImplementerFailureReason,
): HandoffPacket["reason"] | undefined {
  switch (reason) {
    case "verification_failed":
      return "verification_failed";
    case "agent_nonzero_exit":
      return "agent_nonzero_exit";
    case "agent_timed_out":
      return "agent_timed_out";
    case "provider_quota_exhausted":
    case "provider_rate_limited":
    case "provider_auth_failed":
      return "quota_exhausted";
    case "spawn_failed":
    case "internal_error":
      return undefined;
  }
}

function runFailedReasonForOutcome(outcome: RunOutcome): RunFailedReason | undefined {
  if (isImplementerFailed(outcome)) {
    return outcome.reason;
  }
  if (isReviewerUnusable(outcome) && outcome.reason !== "reviewer_unusable") {
    return outcome.reason;
  }
  return undefined;
}
