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

// ─── Required ID sets per event type ─────────────────────────────────────────

const REQUIRED_IDS: Record<V0EventType, readonly (keyof Pick<EventEnvelope, "task_id" | "run_id" | "agent_id">)[]> = {
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

export function assertRequiredEventIds(
  event: EventEnvelope<EventPayload>,
): void {
  assertKnownEventType(event.event_type);

  const requiredIds = REQUIRED_IDS[event.event_type];
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
