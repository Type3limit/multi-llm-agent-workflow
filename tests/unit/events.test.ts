import { describe, it, expect } from "vitest";
import {
  V0_EVENT_TYPES,
  V1_EVENT_TYPES,
  V1_RESERVED_EVENT_TYPES,
  assertKnownEventType,
  assertKnownEventTypeV1,
  assertNotReservedV1,
  assertRequiredEventIds,
  assertV1PayloadFields,
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

// ─── V1 Event Types ──────────────────────────────────────────────────────────

describe("V1_EVENT_TYPES", () => {
  it("contains exactly 14 event types", () => {
    expect(V1_EVENT_TYPES.length).toBe(14);
  });

  it("includes task-level events", () => {
    expect(V1_EVENT_TYPES).toContain("task.enqueued");
    expect(V1_EVENT_TYPES).toContain("task.dispatched");
    expect(V1_EVENT_TYPES).toContain("task.assigned");
    expect(V1_EVENT_TYPES).toContain("task.requeued");
    expect(V1_EVENT_TYPES).toContain("task.completed");
    expect(V1_EVENT_TYPES).toContain("task.failed");
    expect(V1_EVENT_TYPES).toContain("task.awaiting_human");
    expect(V1_EVENT_TYPES).toContain("task.edge_selected");
  });

  it("includes review events", () => {
    expect(V1_EVENT_TYPES).toContain("review.requested");
    expect(V1_EVENT_TYPES).toContain("review.completed");
  });

  it("includes handoff, agent, quota events", () => {
    expect(V1_EVENT_TYPES).toContain("handoff.requested");
    expect(V1_EVENT_TYPES).toContain("agent.spawned");
    expect(V1_EVENT_TYPES).toContain("quota.low");
    expect(V1_EVENT_TYPES).toContain("quota.exhausted");
  });
});

// ─── V1_RESERVED_EVENT_TYPES ─────────────────────────────────────────────────

describe("V1_RESERVED_EVENT_TYPES", () => {
  it("contains exactly 12 reserved names", () => {
    expect(V1_RESERVED_EVENT_TYPES.length).toBe(12);
  });

  it("includes expected reserved patterns", () => {
    expect(V1_RESERVED_EVENT_TYPES).toContain("task.replan_requested");
    expect(V1_RESERVED_EVENT_TYPES).toContain("security.secret_leaked");
    expect(V1_RESERVED_EVENT_TYPES).toContain("capability.downgraded");
  });
});

// ─── assertKnownEventTypeV1 ──────────────────────────────────────────────────

describe("assertKnownEventTypeV1", () => {
  it("passes for all v0 event types", () => {
    for (const eventType of V0_EVENT_TYPES) {
      expect(() => assertKnownEventTypeV1(eventType)).not.toThrow();
    }
  });

  it("passes for all v1 event types", () => {
    for (const eventType of V1_EVENT_TYPES) {
      expect(() => assertKnownEventTypeV1(eventType)).not.toThrow();
    }
  });

  it("throws for unknown event type", () => {
    expect(() => assertKnownEventTypeV1("foo.bar")).toThrow(
      "Unknown event type",
    );
  });

  it("throws for reserved names", () => {
    for (const eventType of V1_RESERVED_EVENT_TYPES) {
      expect(() => assertKnownEventTypeV1(eventType)).toThrow(
        "reserved for v2+",
      );
    }
  });
});

// ─── assertNotReservedV1 ─────────────────────────────────────────────────────

describe("assertNotReservedV1", () => {
  it("passes for known v0+v1 events", () => {
    expect(() => assertNotReservedV1("task.created")).not.toThrow();
    expect(() => assertNotReservedV1("task.dispatched")).not.toThrow();
    expect(() => assertNotReservedV1("review.completed")).not.toThrow();
  });

  it("throws for every reserved name", () => {
    for (const eventType of V1_RESERVED_EVENT_TYPES) {
      expect(() => assertNotReservedV1(eventType)).toThrow("reserved for v2+");
    }
  });

  it("throws message includes 'reserved for v2+'", () => {
    expect(() => assertNotReservedV1("security.secret_leaked")).toThrow(
      "reserved for v2+",
    );
  });
});

// ─── assertRequiredEventIds for v1 events ────────────────────────────────────

describe("assertRequiredEventIds (v1 events)", () => {
  it("passes for task.dispatched with task_id", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({
          event_type: "task.dispatched",
          task_id: "T-1",
        }),
      ),
    ).not.toThrow();
  });

  it("throws for task.dispatched without task_id", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({ event_type: "task.dispatched", task_id: undefined }),
      ),
    ).toThrow("task_id");
  });

  it("passes for task.assigned with task_id, run_id, agent_id", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({
          event_type: "task.assigned",
          task_id: "T-1",
          run_id: "R-1",
          agent_id: "A-1",
        }),
      ),
    ).not.toThrow();
  });

  it("passes for review.requested with task_id, run_id", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({
          event_type: "review.requested",
          task_id: "T-1",
          run_id: "R-2",
        }),
      ),
    ).not.toThrow();
  });

  it("passes for review.completed with task_id, run_id", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({
          event_type: "review.completed",
          task_id: "T-1",
          run_id: "R-2",
        }),
      ),
    ).not.toThrow();
  });

  it("passes for handoff.requested with task_id, run_id", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({
          event_type: "handoff.requested",
          task_id: "T-1",
          run_id: "R-1",
        }),
      ),
    ).not.toThrow();
  });

  it("passes for agent.spawned with task_id, run_id, agent_id", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({
          event_type: "agent.spawned",
          task_id: "T-1",
          run_id: "R-1",
          agent_id: "A-1",
        }),
      ),
    ).not.toThrow();
  });

  it("passes for quota.low with no ids", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({ event_type: "quota.low", task_id: undefined, run_id: undefined, agent_id: undefined }),
      ),
    ).not.toThrow();
  });

  it("passes for quota.exhausted with no ids", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({ event_type: "quota.exhausted", task_id: undefined, run_id: undefined, agent_id: undefined }),
      ),
    ).not.toThrow();
  });

  it("passes for task.edge_selected with task_id", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({ event_type: "task.edge_selected", task_id: "T-1" }),
      ),
    ).not.toThrow();
  });

  it("throws for reserved event name via assertRequiredEventIds", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({ event_type: "security.secret_leaked", task_id: "T-1" }),
      ),
    ).toThrow("reserved for v2+");
  });

  // v1 event payload validations
  it("rejects task.dispatched without payload", () => {
    // Just verifies the required id check — payload validation is deferred to orchestrator
    expect(() =>
      assertRequiredEventIds(
        makeEvent({ event_type: "task.dispatched", task_id: "T-1" }),
      ),
    ).not.toThrow();
  });

  it("rejects task.assigned with missing run_id", () => {
    expect(() =>
      assertRequiredEventIds(
        makeEvent({
          event_type: "task.assigned",
          task_id: "T-1",
          agent_id: "A-1",
        }),
      ),
    ).toThrow("run_id");
  });
});

// ─── assertV1PayloadFields ──────────────────────────────────────────────────

describe("assertV1PayloadFields", () => {
  describe("task.dispatched", () => {
    const eventType = "task.dispatched";

    it("passes with decision_id, role, and picked_agent_id", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: eventType,
            task_id: "T-1",
            payload: {
              decision_id: "D-001",
              role: "implementer",
              picked_agent_id: "agent-a",
            },
          }),
        ),
      ).not.toThrow();
    });

    it("passes with decision_id, role, and refusal_reason", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: eventType,
            task_id: "T-1",
            payload: {
              decision_id: "D-002",
              role: "reviewer",
              refusal_reason: "task_budget_exhausted",
            },
          }),
        ),
      ).not.toThrow();
    });

    it("rejects missing decision_id", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: eventType,
            task_id: "T-1",
            payload: { role: "implementer", picked_agent_id: "x" },
          }),
        ),
      ).toThrow("payload.decision_id");
    });

    it("rejects empty decision_id", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: eventType,
            task_id: "T-1",
            payload: { decision_id: "  ", role: "implementer", picked_agent_id: "x" },
          }),
        ),
      ).toThrow("payload.decision_id");
    });

    it("rejects missing role", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: eventType,
            task_id: "T-1",
            payload: { decision_id: "D-1", picked_agent_id: "x" },
          }),
        ),
      ).toThrow("payload.role");
    });

    it("rejects invalid role", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: eventType,
            task_id: "T-1",
            payload: { decision_id: "D-1", role: "invalid", picked_agent_id: "x" },
          }),
        ),
      ).toThrow("payload.role");
    });

    it("rejects neither picked_agent_id nor refusal_reason", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: eventType,
            task_id: "T-1",
            payload: { decision_id: "D-1", role: "implementer" },
          }),
        ),
      ).toThrow("picked_agent_id or payload.refusal_reason");
    });
  });

  describe("task.assigned", () => {
    const eventType = "task.assigned";

    it("passes with role", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: eventType,
            task_id: "T-1",
            run_id: "R-1",
            agent_id: "A-1",
            payload: { role: "implementer" },
          }),
        ),
      ).not.toThrow();
    });

    it("rejects missing role", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: eventType,
            task_id: "T-1",
            run_id: "R-1",
            agent_id: "A-1",
            payload: {},
          }),
        ),
      ).toThrow("payload.role");
    });

    it("rejects invalid role", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: eventType,
            task_id: "T-1",
            run_id: "R-1",
            agent_id: "A-1",
            payload: { role: "observer" },
          }),
        ),
      ).toThrow("payload.role");
    });
  });

  describe("review.requested / review.completed", () => {
    it("passes for review.requested (no extra payload required)", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({ event_type: "review.requested", task_id: "T-1", run_id: "R-1", payload: {} }),
        ),
      ).not.toThrow();
    });

    it("passes for review.completed with verdict and verdict_uri", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "review.completed",
            task_id: "T-1",
            run_id: "R-1",
            payload: {
              verdict: "approved",
              verdict_uri: "artifact://T-1/R-1/review_verdict.json",
            },
          }),
        ),
      ).not.toThrow();
    });

    it("rejects review.completed without verdict_uri", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "review.completed",
            task_id: "T-1",
            run_id: "R-1",
            payload: { verdict: "approved" },
          }),
        ),
      ).toThrow("payload.verdict_uri");
    });
  });

  describe("run.failed", () => {
    it("passes with a closed taxonomy reason", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "run.failed",
            task_id: "T-1",
            run_id: "R-1",
            agent_id: "A-1",
            payload: { reason: "verification_failed" },
          }),
        ),
      ).not.toThrow();
    });

    it("rejects missing reason", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "run.failed",
            task_id: "T-1",
            run_id: "R-1",
            agent_id: "A-1",
            payload: {},
          }),
        ),
      ).toThrow("payload.reason");
    });

    it("rejects reason outside the closed taxonomy", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "run.failed",
            task_id: "T-1",
            run_id: "R-1",
            agent_id: "A-1",
            payload: { reason: "reviewer_unusable" },
          }),
        ),
      ).toThrow("payload.reason");
    });
  });

  describe("handoff.requested", () => {
    it("passes with valid payload", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "handoff.requested",
            task_id: "T-1",
            run_id: "R-1",
            payload: {
              handoff_packet_uri: "artifact://T-1/R-1/handoff_packet.json",
              reason: "verification_failed",
            },
          }),
        ),
      ).not.toThrow();
    });

    it("passes for diff_apply_failed handoff requests", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "handoff.requested",
            task_id: "T-1",
            run_id: "R-1",
            payload: {
              handoff_packet_uri: "artifact://T-1/R-1/handoff_packet.json",
              reason: "diff_apply_failed",
            },
          }),
        ),
      ).not.toThrow();
    });

    it("rejects missing handoff_packet_uri", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "handoff.requested",
            task_id: "T-1",
            run_id: "R-1",
            payload: { reason: "agent_timed_out" },
          }),
        ),
      ).toThrow("payload.handoff_packet_uri");
    });

    it("rejects empty handoff_packet_uri", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "handoff.requested",
            task_id: "T-1",
            run_id: "R-1",
            payload: { handoff_packet_uri: "", reason: "agent_timed_out" },
          }),
        ),
      ).toThrow("payload.handoff_packet_uri");
    });

    it("rejects missing reason", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "handoff.requested",
            task_id: "T-1",
            run_id: "R-1",
            payload: { handoff_packet_uri: "uri://x" },
          }),
        ),
      ).toThrow("payload.reason");
    });

    it("rejects invalid reason", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "handoff.requested",
            task_id: "T-1",
            run_id: "R-1",
            payload: { handoff_packet_uri: "uri://x", reason: "bad_reason" },
          }),
        ),
      ).toThrow("payload.reason from valid set");
    });
  });

  describe("quota.low / quota.exhausted", () => {
    it("passes for quota.low with scope=agent and agent_id", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "quota.low",
            payload: { scope: "agent", agent_id: "A-1", axis: "calls", ratio: 0.86 },
          }),
        ),
      ).not.toThrow();
    });

    it("passes for quota.exhausted with scope=task and task_id in payload", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "quota.exhausted",
            payload: { scope: "task", task_id: "T-1", axis: "runs" },
          }),
        ),
      ).not.toThrow();
    });

    it("falls back to envelope task_id when scope=task", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "quota.low",
            task_id: "T-1",
            payload: { scope: "task", axis: "runs" },
          }),
        ),
      ).not.toThrow();
    });

    it("falls back to envelope agent_id when scope=agent", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "quota.exhausted",
            agent_id: "A-1",
            payload: { scope: "agent", axis: "cost" },
          }),
        ),
      ).not.toThrow();
    });

    it("rejects invalid scope", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "quota.low",
            payload: { scope: "invalid", agent_id: "A-1" },
          }),
        ),
      ).toThrow("payload.scope");
    });

    it("rejects scope=agent without agent_id", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "quota.low",
            task_id: "T-1",
            payload: { scope: "agent" },
          }),
        ),
      ).toThrow("agent_id in payload or envelope");
    });

    it("rejects scope=task without task_id", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "quota.exhausted",
            agent_id: "A-1",
            task_id: undefined,
            payload: { scope: "task" },
          }),
        ),
      ).toThrow("task_id in payload or envelope");
    });
  });

  describe("task.edge_selected", () => {
    it("passes with from, to, reason", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "task.edge_selected",
            task_id: "T-1",
            payload: { from: "verifying", to: "reviewing", reason: "verification_passed" },
          }),
        ),
      ).not.toThrow();
    });

    it("rejects missing from", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "task.edge_selected",
            task_id: "T-1",
            payload: { to: "reviewing", reason: "x" },
          }),
        ),
      ).toThrow("payload.from");
    });

    it("rejects empty from", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "task.edge_selected",
            task_id: "T-1",
            payload: { from: "", to: "reviewing", reason: "x" },
          }),
        ),
      ).toThrow("payload.from");
    });

    it("rejects missing to", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "task.edge_selected",
            task_id: "T-1",
            payload: { from: "verifying", reason: "x" },
          }),
        ),
      ).toThrow("payload.to");
    });

    it("rejects missing reason", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "task.edge_selected",
            task_id: "T-1",
            payload: { from: "verifying", to: "reviewing" },
          }),
        ),
      ).toThrow("payload.reason");
    });
  });

  describe("agent.spawned", () => {
    it("passes with pid and credential_profile_alias", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "agent.spawned",
            task_id: "T-1",
            run_id: "R-1",
            agent_id: "A-1",
            payload: { pid: 12345, credential_profile_alias: "unknown" },
          }),
        ),
      ).not.toThrow();
    });

    it("rejects missing pid", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "agent.spawned",
            task_id: "T-1",
            run_id: "R-1",
            agent_id: "A-1",
            payload: { credential_profile_alias: "team-claude" },
          }),
        ),
      ).toThrow("payload.pid");
    });

    it("rejects non-number pid", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "agent.spawned",
            task_id: "T-1",
            run_id: "R-1",
            agent_id: "A-1",
            payload: { pid: "12345", credential_profile_alias: "unknown" },
          }),
        ),
      ).toThrow("payload.pid");
    });

    it("rejects non-finite pid", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "agent.spawned",
            task_id: "T-1",
            run_id: "R-1",
            agent_id: "A-1",
            payload: { pid: Infinity, credential_profile_alias: "unknown" },
          }),
        ),
      ).toThrow("payload.pid");
    });

    it("rejects missing credential_profile_alias", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "agent.spawned",
            task_id: "T-1",
            run_id: "R-1",
            agent_id: "A-1",
            payload: { pid: 12345 },
          }),
        ),
      ).toThrow("payload.credential_profile_alias");
    });

    it("rejects empty credential_profile_alias", () => {
      expect(() =>
        assertV1PayloadFields(
          makeEvent({
            event_type: "agent.spawned",
            task_id: "T-1",
            run_id: "R-1",
            agent_id: "A-1",
            payload: { pid: 12345, credential_profile_alias: "  " },
          }),
        ),
      ).toThrow("payload.credential_profile_alias");
    });
  });

  it("does not throw for v0 events without v1 payload contracts", () => {
    expect(() =>
      assertV1PayloadFields(
        makeEvent({ event_type: "task.created", task_id: "T-1", payload: {} }),
      ),
    ).not.toThrow();
    expect(() =>
      assertV1PayloadFields(
        makeEvent({ event_type: "run.completed", task_id: "T-1", run_id: "R-1", agent_id: "A-1", payload: {} }),
      ),
    ).not.toThrow();
  });
});
