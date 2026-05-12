import type { EventEnvelope, EventPayload } from "./types.js";

// ─── v0 Event Types ──────────────────────────────────────────────────────────
//
// Single source of truth matching docs/contracts/event-registry.md.
// Only the ten types required for the first vertical slice.

export const V0_EVENT_TYPES = [
  "task.created",
  "run.created",
  "run.started",
  "artifact.published",
  "verification.started",
  "verification.passed",
  "verification.failed",
  "run.completed",
  "run.failed",
  "run.cleaned_up",
] as const;

export type V0EventType = (typeof V0_EVENT_TYPES)[number];

// ─── v1 Event Types ──────────────────────────────────────────────────────────

export const V1_EVENT_TYPES = [
  "task.enqueued",
  "task.dispatched",
  "task.assigned",
  "task.requeued",
  "task.completed",
  "task.failed",
  "task.awaiting_human",
  "review.requested",
  "review.completed",
  "handoff.requested",
  "agent.spawned",
  "quota.low",
  "quota.exhausted",
  "task.edge_selected",
] as const;

export type V1EventType = (typeof V1_EVENT_TYPES)[number];

export const RUN_FAILED_REASONS = [
  "spawn_failed",
  "agent_nonzero_exit",
  "agent_timed_out",
  "provider_quota_exhausted",
  "provider_rate_limited",
  "provider_auth_failed",
  "verification_failed",
  "diff_apply_failed",
  "lease_expired",
  "internal_error",
] as const;

export type RunFailedReason = (typeof RUN_FAILED_REASONS)[number];

// ─── Reserved for v2+ (NOT implemented in v1) ────────────────────────────────

export const V1_RESERVED_EVENT_TYPES = [
  "task.replan_requested",
  "task.dependency_invalidated",
  "task.human_decided",
  "run.cancel_requested",
  "run.heartbeat",
  "agent.anomaly_detected",
  "capability.downgraded",
  "broker.degraded",
  "prompt.rollback_triggered",
  "security.artifact_flagged",
  "security.secret_leaked",
  "security.agent_quarantined",
] as const;

// ─── All known event types (v0 + v1) ─────────────────────────────────────────

export const ALL_KNOWN_EVENT_TYPES: readonly string[] = [
  ...V0_EVENT_TYPES,
  ...V1_EVENT_TYPES,
] as const;

// ─── Required ID sets per event type ─────────────────────────────────────────

type RequiredIdFields = (keyof Pick<EventEnvelope, "task_id" | "run_id" | "agent_id">)[];

const REQUIRED_IDS: Record<string, RequiredIdFields> = {
  // v0
  "task.created":        ["task_id"],
  "run.created":         ["task_id", "run_id", "agent_id"],
  "run.started":         ["task_id", "run_id", "agent_id"],
  "artifact.published":  ["task_id", "run_id"],
  "verification.started":["task_id", "run_id"],
  "verification.passed": ["task_id", "run_id"],
  "verification.failed": ["task_id", "run_id"],
  "run.completed":       ["task_id", "run_id", "agent_id"],
  "run.failed":          ["task_id", "run_id", "agent_id"],
  "run.cleaned_up":      ["task_id", "run_id"],
  // v1
  "task.enqueued":       ["task_id"],
  "task.dispatched":     ["task_id"],
  "task.assigned":       ["task_id", "run_id", "agent_id"],
  "task.requeued":       ["task_id"],
  "task.completed":      ["task_id"],
  "task.failed":         ["task_id"],
  "task.awaiting_human": ["task_id"],
  "review.requested":    ["task_id", "run_id"],
  "review.completed":    ["task_id", "run_id"],
  "handoff.requested":   ["task_id", "run_id"],
  "agent.spawned":       ["task_id", "run_id", "agent_id"],
  "quota.low":           [],
  "quota.exhausted":     [],
  "task.edge_selected":  ["task_id"],
};

// ─── Guards ──────────────────────────────────────────────────────────────────

export function assertKnownEventType(
  eventType: string,
): asserts eventType is V0EventType {
  if (!(V0_EVENT_TYPES as readonly string[]).includes(eventType)) {
    throw new Error(
      `Unknown event type: "${eventType}". Must be one of: ${V0_EVENT_TYPES.join(", ")}`,
    );
  }
}

export function assertKnownEventTypeV1(
  eventType: string,
): asserts eventType is V0EventType | V1EventType {
  assertNotReservedV1(eventType);
  if (!ALL_KNOWN_EVENT_TYPES.includes(eventType)) {
    throw new Error(
      `Unknown event type: "${eventType}". Must be one of: ${ALL_KNOWN_EVENT_TYPES.join(", ")}`,
    );
  }
}

export function assertNotReservedV1(eventType: string): void {
  if ((V1_RESERVED_EVENT_TYPES as readonly string[]).includes(eventType)) {
    throw new Error(
      `Event type "${eventType}" is reserved for v2+.`,
    );
  }
}

export function assertV1PayloadFields(event: EventEnvelope<EventPayload>): void {
  const { event_type, payload } = event;

  switch (event_type) {
    case "task.dispatched": {
      const decisionId = payload.decision_id;
      const role = payload.role;
      const pickedAgentId = payload.picked_agent_id;
      const refusalReason = payload.refusal_reason;

      if (typeof decisionId !== "string" || decisionId.trim() === "") {
        throw new Error(
          `Event "task.dispatched" requires payload.decision_id (non-empty string)`,
        );
      }
      if (typeof role !== "string" || (role !== "implementer" && role !== "reviewer")) {
        throw new Error(
          `Event "task.dispatched" requires payload.role ("implementer" or "reviewer")`,
        );
      }
      const hasPick = typeof pickedAgentId === "string" && pickedAgentId.trim() !== "";
      const hasRefusal = typeof refusalReason === "string" && refusalReason.trim() !== "";
      if (!hasPick && !hasRefusal) {
        throw new Error(
          `Event "task.dispatched" requires payload.picked_agent_id or payload.refusal_reason`,
        );
      }
      break;
    }

    case "task.assigned": {
      const role = payload.role;
      if (typeof role !== "string" || (role !== "implementer" && role !== "reviewer")) {
        throw new Error(
          `Event "task.assigned" requires payload.role ("implementer" or "reviewer")`,
        );
      }
      break;
    }

    case "review.requested":
      // No extra payload fields required beyond IDs (already checked by assertRequiredEventIds)
      break;

    case "review.completed": {
      const verdict = payload.verdict;
      const verdictUri = payload.verdict_uri;
      if (
        verdict !== "approved" &&
        verdict !== "changes_requested" &&
        verdict !== "rejected"
      ) {
        throw new Error(
          `Event "review.completed" requires payload.verdict ("approved", "changes_requested", or "rejected")`,
        );
      }
      if (typeof verdictUri !== "string" || verdictUri.trim() === "") {
        throw new Error(
          `Event "review.completed" requires payload.verdict_uri (non-empty string)`,
        );
      }
      break;
    }

    case "run.failed": {
      const reason = payload.reason;
      if (typeof reason !== "string" || !(RUN_FAILED_REASONS as readonly string[]).includes(reason)) {
        throw new Error(
          `Event "run.failed" requires payload.reason from valid set: ${RUN_FAILED_REASONS.join(", ")}`,
        );
      }
      break;
    }

    case "handoff.requested": {
      const handoffPacketUri = payload.handoff_packet_uri;
      const reason = payload.reason;
      if (typeof handoffPacketUri !== "string" || handoffPacketUri.trim() === "") {
        throw new Error(
          `Event "handoff.requested" requires payload.handoff_packet_uri (non-empty string)`,
        );
      }
      const validReasons = [
        "verification_failed",
        "review_changes_requested",
        "diff_apply_failed",
        "review_rejected",
        "agent_timed_out",
        "agent_nonzero_exit",
        "quota_exhausted",
        "scheduler_refusal",
      ];
      if (typeof reason !== "string" || !validReasons.includes(reason)) {
        throw new Error(
          `Event "handoff.requested" requires payload.reason from valid set: ${validReasons.join(", ")}`,
        );
      }
      break;
    }

    case "quota.low":
    case "quota.exhausted": {
      const scope = payload.scope;
      if (scope !== "agent" && scope !== "task") {
        throw new Error(
          `Event "${event_type}" requires payload.scope ("agent" or "task")`,
        );
      }
      if (scope === "agent") {
        const agentId = payload.agent_id ?? event.agent_id;
        if (typeof agentId !== "string" || agentId.trim() === "") {
          throw new Error(
            `Event "${event_type}" with scope="agent" requires an agent_id in payload or envelope`,
          );
        }
      }
      if (scope === "task") {
        const taskId = payload.task_id ?? event.task_id;
        if (typeof taskId !== "string" || taskId.trim() === "") {
          throw new Error(
            `Event "${event_type}" with scope="task" requires a task_id in payload or envelope`,
          );
        }
      }
      break;
    }

    case "task.edge_selected": {
      const from = payload.from;
      const to = payload.to;
      const reason = payload.reason;
      if (typeof from !== "string" || from.trim() === "") {
        throw new Error(
          `Event "task.edge_selected" requires payload.from (non-empty string)`,
        );
      }
      if (typeof to !== "string" || to.trim() === "") {
        throw new Error(
          `Event "task.edge_selected" requires payload.to (non-empty string)`,
        );
      }
      if (typeof reason !== "string" || reason.trim() === "") {
        throw new Error(
          `Event "task.edge_selected" requires payload.reason (non-empty string)`,
        );
      }
      break;
    }

    case "agent.spawned": {
      const pid = payload.pid;
      const credAlias = payload.credential_profile_alias;
      if (typeof pid !== "number" || !Number.isFinite(pid)) {
        throw new Error(
          `Event "agent.spawned" requires payload.pid (finite number)`,
        );
      }
      if (typeof credAlias !== "string" || credAlias.trim() === "") {
        throw new Error(
          `Event "agent.spawned" requires payload.credential_profile_alias (non-empty string or "unknown")`,
        );
      }
      break;
    }

    default:
      // v0 events and unknown events are not validated here
      break;
  }
}

export function assertRequiredEventIds(
  event: EventEnvelope<EventPayload>,
): void {
  // Accept both v0 and v1 events
  const knownTypes = [
    ...V0_EVENT_TYPES as readonly string[],
    ...V1_EVENT_TYPES as readonly string[],
  ];

  if (!knownTypes.includes(event.event_type)) {
    // Check reserved first
    if ((V1_RESERVED_EVENT_TYPES as readonly string[]).includes(event.event_type)) {
      throw new Error(
        `Event type "${event.event_type}" is reserved for v2+.`,
      );
    }
    throw new Error(
      `Unknown event type: "${event.event_type}". Must be one of: ${knownTypes.join(", ")}`,
    );
  }

  const requiredIds = REQUIRED_IDS[event.event_type];
  if (!requiredIds || requiredIds.length === 0) return;

  const missing: string[] = [];

  for (const id of requiredIds) {
    const val = event[id];
    if (val == null || (typeof val === "string" && val.trim() === "")) {
      missing.push(id);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Event "${event.event_type}" is missing required ids: ${missing.join(", ")}`,
    );
  }
}
