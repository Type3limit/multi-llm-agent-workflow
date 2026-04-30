import { describe, it, expect } from "vitest";
import {
  V0_EVENT_TYPES,
  assertKnownEventType,
  assertRequiredEventIds,
} from "../../src/core/events.js";
import type { EventEnvelope, EventPayload } from "../../src/core/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope<EventPayload> {
  return {
    event_id: "E-001",
    event_type: "task.created",
    project_id: "default",
    task_id: "T-1",
    payload: {},
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ─── V0_EVENT_TYPES ──────────────────────────────────────────────────────────

describe("V0_EVENT_TYPES", () => {
  it("contains exactly 10 event types", () => {
    expect(V0_EVENT_TYPES.length).toBe(10);
  });

  it("includes all required v0 event names", () => {
    const required = [
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
    ];
    for (const name of required) {
      expect(V0_EVENT_TYPES).toContain(name);
    }
  });
});

// ─── assertKnownEventType ────────────────────────────────────────────────────

describe("assertKnownEventType", () => {
  it("passes for all v0 event types", () => {
    for (const eventType of V0_EVENT_TYPES) {
      expect(() => assertKnownEventType(eventType)).not.toThrow();
    }
  });

  it("throws for unknown event type", () => {
    expect(() => assertKnownEventType("task.requeued")).toThrow(
      'Unknown event type: "task.requeued"',
    );
  });

  it("throws for empty string", () => {
    expect(() => assertKnownEventType("")).toThrow();
  });

  it("throws for completely bogus value", () => {
    expect(() => assertKnownEventType("not.an.event")).toThrow();
  });
});

// ─── assertRequiredEventIds ──────────────────────────────────────────────────

describe("assertRequiredEventIds", () => {
  it("passes for task.created with task_id", () => {
    expect(() =>
      assertRequiredEventIds(makeEvent({ event_type: "task.created", task_id: "T-1" })),
    ).not.toThrow();
  });

  it("throws for task.created without task_id", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({ event_type: "task.created", task_id: undefined }),
      ),
    ).toThrow("task.created");
  });

  it("passes for run.created with task_id, run_id, agent_id", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({
          event_type: "run.created",
          task_id: "T-1",
          run_id: "R-1",
          agent_id: "A-1",
        }),
      ),
    ).not.toThrow();
  });

  it("throws for run.created without run_id", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({
          event_type: "run.created",
          task_id: "T-1",
          agent_id: "A-1",
        }),
      ),
    ).toThrow("run_id");
  });

  it("throws for run.created without agent_id", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({
          event_type: "run.created",
          task_id: "T-1",
          run_id: "R-1",
        }),
      ),
    ).toThrow("agent_id");
  });

  it("passes for artifact.published with task_id and run_id", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({
          event_type: "artifact.published",
          task_id: "T-1",
          run_id: "R-1",
        }),
      ),
    ).not.toThrow();
  });

  it("throws for artifact.published without run_id", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({
          event_type: "artifact.published",
          task_id: "T-1",
        }),
      ),
    ).toThrow("run_id");
  });

  it("passes for verification.started with task_id and run_id", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({
          event_type: "verification.started",
          task_id: "T-1",
          run_id: "R-1",
        }),
      ),
    ).not.toThrow();
  });

  it("passes for verification.passed with task_id and run_id", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({
          event_type: "verification.passed",
          task_id: "T-1",
          run_id: "R-1",
        }),
      ),
    ).not.toThrow();
  });

  it("passes for verification.failed with task_id and run_id", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({
          event_type: "verification.failed",
          task_id: "T-1",
          run_id: "R-1",
        }),
      ),
    ).not.toThrow();
  });

  it("passes for run.completed with task_id, run_id, agent_id", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({
          event_type: "run.completed",
          task_id: "T-1",
          run_id: "R-1",
          agent_id: "A-1",
        }),
      ),
    ).not.toThrow();
  });

  it("throws for run.failed without agent_id", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({
          event_type: "run.failed",
          task_id: "T-1",
          run_id: "R-1",
        }),
      ),
    ).toThrow("agent_id");
  });

  it("passes for run.cleaned_up with task_id and run_id", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({
          event_type: "run.cleaned_up",
          task_id: "T-1",
          run_id: "R-1",
        }),
      ),
    ).not.toThrow();
  });

  it("throws for unknown event type before checking ids", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({ event_type: "unknown.event", task_id: "T-1" }),
      ),
    ).toThrow("Unknown event type");
  });

  it("rejects empty string task_id", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({ event_type: "task.created", task_id: "" }),
      ),
    ).toThrow("task_id");
  });

  it("rejects whitespace-only run_id", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({
          event_type: "run.created",
          task_id: "T-1",
          run_id: "   ",
          agent_id: "A-1",
        }),
      ),
    ).toThrow("run_id");
  });

  it("rejects null agent_id", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({
          event_type: "run.created",
          task_id: "T-1",
          run_id: "R-1",
          agent_id: null as unknown as string | undefined,
        }),
      ),
    ).toThrow("agent_id");
  });

  it("rejects empty string for artifact.published run_id", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({ event_type: "artifact.published", task_id: "T-1", run_id: "" }),
      ),
    ).toThrow("run_id");
  });

  it("rejects whitespace-only task_id for run.cleaned_up", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({
          event_type: "run.cleaned_up",
          task_id: "  ",
          run_id: "R-1",
        }),
      ),
    ).toThrow("task_id");
  });
});
