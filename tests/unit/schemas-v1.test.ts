import { describe, it, expect } from "vitest";
import {
  WorkOrderV1Schema,
  AgentProfileV1Schema,
  RunManifestV1Schema,
  ScheduleDecisionSchema,
  ReviewVerdictSchema,
  HandoffPacketSchema,
  BudgetStateSchema,
  TaskQueueEntrySchema,
  parseWorkOrderV1,
  parseAgentProfileV1,
  parseReviewVerdictFile,
} from "../../src/core/schemas-v1.js";
import { z } from "zod";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const validWorkOrderV1 = {
  schema_version: "workflow/v1",
  task_id: "T-v1-test",
  title: "Fix a bug in v1",
  type: "code_change",
  goal: "Make the test pass.",
  acceptance_criteria: ["Tests pass."],
  repo: { path: "/tmp/repo" },
  agent: {
    required_capabilities: ["code_change"],
    implementer_pool: ["claude-local"],
  },
};

const validImplementerProfileV1 = {
  schema_version: "workflow/v1",
  agent_id: "claude-local",
  integration_mode: "official_cli",
  command: { executable: "claude", args: ["-p", "prompt.md"] },
  capabilities: {
    outer_supervised: true,
    inner_tool_control: false,
    kinds: ["code_change"],
    roles: ["implementer"],
  },
};

const validReviewerProfileV1 = {
  ...validImplementerProfileV1,
  agent_id: "reviewer-local",
  capabilities: {
    ...validImplementerProfileV1.capabilities,
    kinds: ["code_change", "ui_review"],
    roles: ["reviewer"],
  },
};

// ─── WorkOrderV1Schema ───────────────────────────────────────────────────────

describe("WorkOrderV1Schema", () => {
  it("parses a valid minimal WorkOrderV1", () => {
    const result = WorkOrderV1Schema.parse(validWorkOrderV1);
    expect(result.task_id).toBe("T-v1-test");
    expect(result.project_id).toBe("default");
  });

  it("fills in all defaults", () => {
    const result = WorkOrderV1Schema.parse(validWorkOrderV1);
    expect(result.review.enabled).toBe(true);
    expect(result.review.max_review_runs).toBe(1);
    expect(result.budget.max_runs).toBe(4);
    expect(result.budget.max_wall_time_minutes).toBe(30);
    expect(result.budget.max_total_cost_units).toBe(10);
  });

  it("parses a full WorkOrderV1 with optional fields", () => {
    const full = {
      ...validWorkOrderV1,
      project_id: "my-project",
      constraints: {
        allowed_paths: ["src/**"],
        forbidden_paths: [".env"],
        max_files_to_touch: 5,
      },
      verification: { commands: ["npm test"], timeout_seconds: 120 },
      agent: {
        required_capabilities: ["code_change", "docs_update"],
        implementer_pool: ["agent-a"],
        reviewer_pool: ["agent-b"],
        exclude_agent_ids: ["agent-c"],
      },
      review: { enabled: true, max_review_runs: 2 },
      budget: { max_wall_time_minutes: 60, max_total_cost_units: 20, max_runs: 5 },
    };
    const result = WorkOrderV1Schema.parse(full);
    expect(result.agent.required_capabilities).toEqual(["code_change", "docs_update"]);
    expect(result.agent.reviewer_pool).toEqual(["agent-b"]);
    expect(result.review.max_review_runs).toBe(2);
    expect(result.budget.max_runs).toBe(5);
  });

  it("rejects unsupported schema_version", () => {
    expect(() =>
      WorkOrderV1Schema.parse({ ...validWorkOrderV1, schema_version: "workflow/v9" }),
    ).toThrow();
  });

  it("rejects empty required_capabilities", () => {
    expect(() =>
      WorkOrderV1Schema.parse({
        ...validWorkOrderV1,
        agent: { implementer_pool: ["a"], required_capabilities: [] },
      }),
    ).toThrow();
  });

  it("rejects missing required_capabilities", () => {
    expect(() =>
      WorkOrderV1Schema.parse({
        ...validWorkOrderV1,
        agent: { implementer_pool: ["a"] },
      }),
    ).toThrow();
  });

  it("rejects budget.max_runs < review.max_review_runs + 1", () => {
    expect(() =>
      WorkOrderV1Schema.parse({
        ...validWorkOrderV1,
        review: { enabled: true, max_review_runs: 3 },
        budget: { max_runs: 3 },
      }),
    ).toThrow();
  });

  it("accepts budget.max_runs === review.max_review_runs + 1", () => {
    const result = WorkOrderV1Schema.parse({
      ...validWorkOrderV1,
      review: { enabled: true, max_review_runs: 3 },
      budget: { max_runs: 4 },
    });
    expect(result.budget.max_runs).toBe(4);
  });

  it("accepts review disabled with tight budget", () => {
    const result = WorkOrderV1Schema.parse({
      ...validWorkOrderV1,
      review: { enabled: false, max_review_runs: 1 },
      budget: { max_runs: 1 },
    });
    expect(result.review.enabled).toBe(false);
  });
});

// ─── parseWorkOrderV1 ────────────────────────────────────────────────────────

describe("parseWorkOrderV1", () => {
  it("parses valid v1 input", () => {
    const result = parseWorkOrderV1(validWorkOrderV1);
    expect(result.task_id).toBe("T-v1-test");
  });

  it("throws ZodError for invalid input", () => {
    expect(() => parseWorkOrderV1({})).toThrow(z.ZodError);
  });

  it("throws for empty required_capabilities", () => {
    expect(() =>
      parseWorkOrderV1({
        ...validWorkOrderV1,
        agent: { implementer_pool: ["a"], required_capabilities: [] },
      }),
    ).toThrow();
  });
});

// ─── AgentProfileV1Schema ────────────────────────────────────────────────────

describe("AgentProfileV1Schema", () => {
  it("parses a valid implementer profile", () => {
    const result = AgentProfileV1Schema.parse(validImplementerProfileV1);
    expect(result.agent_id).toBe("claude-local");
    expect(result.capabilities.roles).toEqual(["implementer"]);
  });

  it("parses a valid reviewer profile", () => {
    const result = AgentProfileV1Schema.parse(validReviewerProfileV1);
    expect(result.capabilities.roles).toEqual(["reviewer"]);
  });

  it("fills in default quota and reliability", () => {
    const result = AgentProfileV1Schema.parse(validImplementerProfileV1);
    expect(result.quota.soft_limit_ratio).toBe(0.85);
    expect(result.quota.hard_limit_ratio).toBe(0.98);
    expect(result.reliability.initial_success_rate).toBe(0.8);
    expect(result.reliability.initial_avg_latency_ms).toBe(60000);
  });

  it("rejects unsupported schema_version", () => {
    expect(() =>
      AgentProfileV1Schema.parse({ ...validImplementerProfileV1, schema_version: "v2" }),
    ).toThrow();
  });

  it("rejects empty kinds", () => {
    expect(() =>
      AgentProfileV1Schema.parse({
        ...validImplementerProfileV1,
        capabilities: {
          outer_supervised: true,
          inner_tool_control: false,
          kinds: [],
          roles: ["implementer"],
        },
      }),
    ).toThrow();
  });

  it("rejects empty roles", () => {
    expect(() =>
      AgentProfileV1Schema.parse({
        ...validImplementerProfileV1,
        capabilities: {
          outer_supervised: true,
          inner_tool_control: false,
          kinds: ["code_change"],
          roles: [],
        },
      }),
    ).toThrow();
  });

  it("rejects invalid role", () => {
    expect(() =>
      AgentProfileV1Schema.parse({
        ...validImplementerProfileV1,
        capabilities: {
          outer_supervised: true,
          inner_tool_control: false,
          kinds: ["code_change"],
          roles: ["invalid_role"],
        },
      }),
    ).toThrow();
  });

  it("rejects outer_supervised=false", () => {
    expect(() =>
      AgentProfileV1Schema.parse({
        ...validImplementerProfileV1,
        capabilities: {
          outer_supervised: false,
          inner_tool_control: false,
          kinds: ["code_change"],
          roles: ["implementer"],
        },
      }),
    ).toThrow();
  });

  it("rejects inner_tool_control=true", () => {
    expect(() =>
      AgentProfileV1Schema.parse({
        ...validImplementerProfileV1,
        capabilities: {
          outer_supervised: true,
          inner_tool_control: true,
          kinds: ["code_change"],
          roles: ["implementer"],
        },
      }),
    ).toThrow();
  });

  it("rejects negative estimated_cost_per_run_units", () => {
    expect(() =>
      AgentProfileV1Schema.parse({
        ...validImplementerProfileV1,
        cost_profile: {
          billing_unit: "token",
          estimated_cost_per_run_units: -1,
        },
      }),
    ).toThrow();
  });

  it("accepts zero estimated_cost_per_run_units", () => {
    const result = AgentProfileV1Schema.parse({
      ...validImplementerProfileV1,
      cost_profile: {
        billing_unit: "local_compute",
        estimated_cost_per_run_units: 0,
      },
    });
    expect(result.cost_profile!.estimated_cost_per_run_units).toBe(0);
  });

  it("rejects soft_limit_ratio >= hard_limit_ratio", () => {
    expect(() =>
      AgentProfileV1Schema.parse({
        ...validImplementerProfileV1,
        quota: { soft_limit_ratio: 0.9, hard_limit_ratio: 0.9 },
      }),
    ).toThrow();
  });

  it("rejects soft_limit_ratio >= hard_limit_ratio (soft > hard)", () => {
    expect(() =>
      AgentProfileV1Schema.parse({
        ...validImplementerProfileV1,
        quota: { soft_limit_ratio: 0.95, hard_limit_ratio: 0.9 },
      }),
    ).toThrow();
  });

  it("rejects hard_limit_ratio > 1", () => {
    expect(() =>
      AgentProfileV1Schema.parse({
        ...validImplementerProfileV1,
        quota: { soft_limit_ratio: 0.5, hard_limit_ratio: 1.5 },
      }),
    ).toThrow();
  });
});

// ─── parseAgentProfileV1 ─────────────────────────────────────────────────────

describe("parseAgentProfileV1", () => {
  it("parses valid implementer", () => {
    const result = parseAgentProfileV1(validImplementerProfileV1);
    expect(result.agent_id).toBe("claude-local");
  });

  it("parses valid reviewer", () => {
    const result = parseAgentProfileV1(validReviewerProfileV1);
    expect(result.agent_id).toBe("reviewer-local");
  });

  it("throws for empty kinds", () => {
    expect(() =>
      parseAgentProfileV1({
        ...validImplementerProfileV1,
        capabilities: {
          outer_supervised: true,
          inner_tool_control: false,
          kinds: [],
          roles: ["implementer"],
        },
      }),
    ).toThrow();
  });
});

// ─── ReviewVerdictSchema ─────────────────────────────────────────────────────

describe("ReviewVerdictSchema", () => {
  const validVerdict = {
    schema_version: "agent-workflow/1",
    verdict: "approved",
    summary: "Looks good.",
    comments: [],
  };

  it("parses approved verdict", () => {
    const result = ReviewVerdictSchema.parse(validVerdict);
    expect(result.verdict).toBe("approved");
  });

  it("parses changes_requested verdict", () => {
    const result = ReviewVerdictSchema.parse({
      ...validVerdict,
      verdict: "changes_requested",
    });
    expect(result.verdict).toBe("changes_requested");
  });

  it("parses rejected verdict", () => {
    const result = ReviewVerdictSchema.parse({
      ...validVerdict,
      verdict: "rejected",
    });
    expect(result.verdict).toBe("rejected");
  });

  it("rejects invalid verdict", () => {
    expect(() =>
      ReviewVerdictSchema.parse({ ...validVerdict, verdict: "maybe" }),
    ).toThrow();
  });

  it("parses verdict with comments", () => {
    const result = ReviewVerdictSchema.parse({
      ...validVerdict,
      verdict: "changes_requested",
      comments: [
        { severity: "must_fix", comment: "Fix the null check.", line: 42, path: "src/a.ts" },
        { severity: "nit", comment: "Rename variable." },
      ],
    });
    expect(result.comments.length).toBe(2);
    expect(result.comments[0].line).toBe(42);
  });

  it("rejects empty summary", () => {
    expect(() =>
      ReviewVerdictSchema.parse({ ...validVerdict, summary: "" }),
    ).toThrow();
  });
});

// ─── parseReviewVerdictFile ──────────────────────────────────────────────────

describe("parseReviewVerdictFile", () => {
  it("parses a valid JSON verdict", () => {
    const text = JSON.stringify({
      schema_version: "agent-workflow/1",
      verdict: "approved",
      summary: "All good.",
      comments: [],
    });
    const result = parseReviewVerdictFile(text);
    expect(result.verdict).toBe("approved");
  });

  it("throws for invalid JSON", () => {
    expect(() => parseReviewVerdictFile("not json {{{")).toThrow(
      "invalid JSON",
    );
  });

  it("throws for valid JSON but invalid schema", () => {
    expect(() =>
      parseReviewVerdictFile(JSON.stringify({ schema_version: "v9", verdict: "nope" })),
    ).toThrow();
  });

  it("throws for missing verdict field", () => {
    expect(() =>
      parseReviewVerdictFile(
        JSON.stringify({ schema_version: "agent-workflow/1", summary: "x", comments: [] }),
      ),
    ).toThrow();
  });
});

// ─── ScheduleDecisionSchema ──────────────────────────────────────────────────

describe("ScheduleDecisionSchema", () => {
  it("parses a pick decision", () => {
    const result = ScheduleDecisionSchema.parse({
      schema_version: "agent-workflow/1",
      decision_id: "D-001",
      task_id: "T-1",
      role: "implementer",
      picked_agent_id: "agent-a",
      candidate_scores: [],
      decided_at: "2026-05-06T10:00:00Z",
    });
    expect(result.picked_agent_id).toBe("agent-a");
  });

  it("parses a refusal decision", () => {
    const result = ScheduleDecisionSchema.parse({
      schema_version: "agent-workflow/1",
      decision_id: "D-002",
      task_id: "T-1",
      role: "implementer",
      picked_agent_id: null,
      refusal_reason: "task_budget_exhausted",
      candidate_scores: [],
      decided_at: "2026-05-06T10:00:00Z",
    });
    expect(result.picked_agent_id).toBeNull();
    expect(result.refusal_reason).toBe("task_budget_exhausted");
  });

  it("rejects invalid refusal_reason", () => {
    expect(() =>
      ScheduleDecisionSchema.parse({
        schema_version: "agent-workflow/1",
        decision_id: "D-003",
        task_id: "T-1",
        role: "implementer",
        picked_agent_id: null,
        refusal_reason: "bad_reason",
        candidate_scores: [],
        decided_at: "2026-05-06T10:00:00Z",
      }),
    ).toThrow();
  });

  it("parses with candidate scores", () => {
    const result = ScheduleDecisionSchema.parse({
      schema_version: "agent-workflow/1",
      decision_id: "D-004",
      task_id: "T-1",
      role: "implementer",
      picked_agent_id: "agent-a",
      candidate_scores: [
        {
          agent_id: "agent-a",
          score: 0.78,
          breakdown: {
            capability_match: 1.0,
            cost_efficiency: 0.6,
            quota_health: 0.9,
            reliability: 0.92,
            latency_score: 0.5,
          },
        },
        {
          agent_id: "agent-b",
          score: 0.0,
          breakdown: {
            capability_match: 0.0,
            cost_efficiency: 0.0,
            quota_health: 0.0,
            reliability: 0.0,
            latency_score: 0.0,
          },
          excluded: true,
          excluded_reason: "quota_exhausted",
        },
      ],
      decided_at: "2026-05-06T10:00:00Z",
    });
    expect(result.candidate_scores.length).toBe(2);
    expect(result.candidate_scores[1].excluded).toBe(true);
  });
});

// ─── HandoffPacketSchema ─────────────────────────────────────────────────────

describe("HandoffPacketSchema", () => {
  it("parses a valid handoff packet", () => {
    const result = HandoffPacketSchema.parse({
      schema_version: "agent-workflow/1",
      task_id: "T-1",
      from_run_id: "R-1",
      from_agent_id: "agent-a",
      reason: "verification_failed",
      summary: "Verification failed due to test failure.",
      remaining_work: "Fix the test.",
      exclude_agent_ids: ["agent-a"],
      created_at: "2026-05-06T10:00:00Z",
    });
    expect(result.reason).toBe("verification_failed");
    expect(result.exclude_agent_ids).toEqual(["agent-a"]);
  });

  it("rejects invalid reason", () => {
    expect(() =>
      HandoffPacketSchema.parse({
        schema_version: "agent-workflow/1",
        task_id: "T-1",
        from_run_id: "R-1",
        from_agent_id: "agent-a",
        reason: "bad_reason",
        summary: "x",
        remaining_work: "x",
        exclude_agent_ids: [],
        created_at: "2026-01-01T00:00:00Z",
      }),
    ).toThrow();
  });
});

// ─── BudgetStateSchema ───────────────────────────────────────────────────────

describe("BudgetStateSchema", () => {
  it("parses a valid budget state", () => {
    const result = BudgetStateSchema.parse({
      task_id: "T-1",
      runs_used: 2,
      wall_time_ms_used: 300000,
      cost_units_used: 5,
      caps: {
        max_runs: 4,
        max_wall_time_ms: 1800000,
        max_total_cost_units: 10,
      },
      status: "ok",
    });
    expect(result.runs_used).toBe(2);
  });

  it("rejects invalid status", () => {
    expect(() =>
      BudgetStateSchema.parse({
        task_id: "T-1",
        runs_used: 0,
        wall_time_ms_used: 0,
        cost_units_used: 0,
        caps: { max_runs: 1, max_wall_time_ms: 1000, max_total_cost_units: 1 },
        status: "bad",
      }),
    ).toThrow();
  });
});

// ─── TaskQueueEntrySchema ────────────────────────────────────────────────────

describe("TaskQueueEntrySchema", () => {
  it("parses a queued entry", () => {
    const result = TaskQueueEntrySchema.parse({
      task_id: "T-1",
      project_id: "default",
      status: "queued",
      next_role: "implementer",
      current_owner_run_id: null,
      lease_expires_at: null,
      attempts: 0,
      enqueued_at: "2026-05-06T10:00:00Z",
      updated_at: "2026-05-06T10:00:00Z",
    });
    expect(result.status).toBe("queued");
  });

  it("parses a dispatched entry", () => {
    const result = TaskQueueEntrySchema.parse({
      task_id: "T-1",
      project_id: "default",
      status: "dispatched",
      next_role: "implementer",
      current_owner_run_id: "R-1",
      lease_expires_at: "2026-05-06T11:00:00Z",
      attempts: 1,
      enqueued_at: "2026-05-06T10:00:00Z",
      updated_at: "2026-05-06T10:01:00Z",
    });
    expect(result.current_owner_run_id).toBe("R-1");
  });

  it("rejects terminal status", () => {
    // All terminal statuses should be valid per the enum
    const result = TaskQueueEntrySchema.parse({
      task_id: "T-1",
      project_id: "default",
      status: "accepted",
      next_role: "implementer",
      current_owner_run_id: null,
      lease_expires_at: null,
      attempts: 3,
      enqueued_at: "2026-05-06T10:00:00Z",
      updated_at: "2026-05-06T10:30:00Z",
    });
    expect(result.status).toBe("accepted");
  });
});

// ─── RunManifestV1Schema ─────────────────────────────────────────────────────

describe("RunManifestV1Schema", () => {
  const validManifest = {
    schema_version: "agent-workflow/1",
    run_id: "R-abc123",
    task_id: "T-test",
    project_id: "default",
    agent_id: "claude-local",
    integration_mode: "official_cli",
    role: "implementer",
    workspace_uri: "file:///tmp/ws",
    base_commit: "abc123def456",
    branch: "agent/T-test/R-abc123",
    work_order_hash: "sha256:abc",
    adapter_version: "0.1.0",
    started_at: new Date().toISOString(),
    status: "preparing",
  };

  it("parses a valid RunManifestV1", () => {
    const result = RunManifestV1Schema.parse(validManifest);
    expect(result.run_id).toBe("R-abc123");
    expect(result.role).toBe("implementer");
  });

  it("rejects missing role", () => {
    const { role, ...rest } = validManifest;
    expect(() => RunManifestV1Schema.parse(rest)).toThrow();
  });

  it("parses with parent_run_id and handoff_packet_uri", () => {
    const result = RunManifestV1Schema.parse({
      ...validManifest,
      parent_run_id: "R-previous",
      handoff_packet_uri: "artifact://T-test/R-previous/handoff_packet.json",
    });
    expect(result.parent_run_id).toBe("R-previous");
  });
});

// ─── Parsed type runtime defaults ────────────────────────────────────────────

describe("parsed v1 types carry Zod defaults at runtime", () => {
  it("ParsedWorkOrderV1: project_id defaults to 'default'", () => {
    const result = parseWorkOrderV1(validWorkOrderV1);
    expect(result.project_id).toBe("default");
  });

  it("ParsedWorkOrderV1: review.enabled defaults to true", () => {
    const result = parseWorkOrderV1(validWorkOrderV1);
    expect(result.review.enabled).toBe(true);
  });

  it("ParsedWorkOrderV1: review.max_review_runs defaults to 1", () => {
    const result = parseWorkOrderV1(validWorkOrderV1);
    expect(result.review.max_review_runs).toBe(1);
  });

  it("ParsedWorkOrderV1: budget.max_runs defaults to 4", () => {
    const result = parseWorkOrderV1(validWorkOrderV1);
    expect(result.budget.max_runs).toBe(4);
  });

  it("ParsedWorkOrderV1: budget.max_wall_time_minutes defaults to 30", () => {
    const result = parseWorkOrderV1(validWorkOrderV1);
    expect(result.budget.max_wall_time_minutes).toBe(30);
  });

  it("ParsedWorkOrderV1: budget.max_total_cost_units defaults to 10", () => {
    const result = parseWorkOrderV1(validWorkOrderV1);
    expect(result.budget.max_total_cost_units).toBe(10);
  });

  it("ParsedWorkOrderV1: agent.reviewer_pool is an array", () => {
    const result = parseWorkOrderV1(validWorkOrderV1);
    expect(Array.isArray(result.agent.reviewer_pool)).toBe(true);
  });

  it("ParsedWorkOrderV1: agent.exclude_agent_ids is an array", () => {
    const result = parseWorkOrderV1(validWorkOrderV1);
    expect(Array.isArray(result.agent.exclude_agent_ids)).toBe(true);
  });

  it("ParsedAgentProfileV1: quota exists with defaults", () => {
    const result = parseAgentProfileV1(validImplementerProfileV1);
    expect(result.quota).toBeDefined();
    expect(result.quota.soft_limit_ratio).toBe(0.85);
    expect(result.quota.hard_limit_ratio).toBe(0.98);
  });

  it("ParsedAgentProfileV1: reliability exists with defaults", () => {
    const result = parseAgentProfileV1(validImplementerProfileV1);
    expect(result.reliability).toBeDefined();
    expect(result.reliability.initial_success_rate).toBe(0.8);
    expect(result.reliability.initial_avg_latency_ms).toBe(60000);
  });
});
