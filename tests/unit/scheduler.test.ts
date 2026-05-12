import { describe, it, expect } from "vitest";
import { DefaultScheduler, SCHEDULER_WEIGHTS } from "../../src/scheduling/scheduler.js";
import type { AgentRegistryEntry, BudgetState } from "../../src/core/types.js";
import type { ParsedWorkOrderV1 } from "../../src/core/schemas-v1.js";
import type { AgentRegistry } from "../../src/scheduling/agent-registry.js";

// ─── Fake Registry ───────────────────────────────────────────────────────────

class FakeRegistry implements AgentRegistry {
  private entries = new Map<string, AgentRegistryEntry>();
  add(entry: AgentRegistryEntry): void { this.entries.set(entry.profile.agent_id, entry); }
  load(_args: { sources: string[] }): void { throw new Error("not implemented"); }
  list(): AgentRegistryEntry[] { return [...this.entries.values()]; }
  get(agentId: string): AgentRegistryEntry | undefined { return this.entries.get(agentId); }
  candidatesFor(args: {
    requiredCapabilities: string[];
    role: "implementer" | "reviewer";
    excludeAgentIds: string[];
  }): AgentRegistryEntry[] {
    const excludeSet = new Set(args.excludeAgentIds);
    const capSet = new Set(args.requiredCapabilities);
    return [...this.entries.values()]
      .filter((e) => {
        if (excludeSet.has(e.profile.agent_id)) return false;
        if (e.quota_health === "exhausted") return false;
        if (!(e.profile.capabilities.roles as string[]).includes(args.role)) return false;
        return [...capSet].every((c) => (e.profile.capabilities.kinds as string[]).includes(c));
      })
      .sort((a, b) => a.profile.agent_id.localeCompare(b.profile.agent_id));
  }
  recordOutcome(_args: unknown): void { throw new Error("not implemented"); }
  refreshQuotaHealth(): void {}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<AgentRegistryEntry> = {}): AgentRegistryEntry {
  const { profile: profileOverride, rolling_metrics: metricsOverride, quota_health: qhOverride, ...restOverrides } = overrides;
  return {
    profile: {
      schema_version: "workflow/v1",
      agent_id: "agent-default",
      integration_mode: "official_cli",
      command: { executable: "node", args: ["-p", "x"] },
      capabilities: {
        outer_supervised: true as const,
        inner_tool_control: false as const,
        kinds: ["code_change"],
        roles: ["implementer"],
      },
      cost_profile: { billing_unit: "token", estimated_cost_per_run_units: 1 },
      quota: { soft_limit_ratio: 0.85, hard_limit_ratio: 0.98 },
      reliability: { initial_success_rate: 0.8, initial_avg_latency_ms: 60000 },
      ...profileOverride,
    },
    loaded_from: "/fake/agent.json",
    rolling_metrics: {
      success_rate: 0.9,
      avg_latency_ms: 30000,
      avg_actual_cost_units: 5,
      runs_observed: 10,
      last_updated_at: new Date().toISOString(),
      ...metricsOverride,
    },
    quota_health: qhOverride ?? "healthy",
    ...restOverrides,
  } as unknown as AgentRegistryEntry;
}

function makeWorkOrder(overrides: Partial<ParsedWorkOrderV1> = {}): ParsedWorkOrderV1 {
  return {
    schema_version: "workflow/v1",
    task_id: "T-test",
    project_id: "default",
    title: "Test",
    type: "code_change",
    goal: "Do something.",
    acceptance_criteria: ["Done."],
    repo: { path: "/tmp" },
    agent: { required_capabilities: ["code_change"], implementer_pool: [], reviewer_pool: [], exclude_agent_ids: [] },
    review: { enabled: false, max_review_runs: 0 },
    budget: { max_runs: 4, max_wall_time_minutes: 30, max_total_cost_units: 10 },
    ...overrides,
  } as unknown as ParsedWorkOrderV1;
}

function makeBudget(overrides: Partial<BudgetState> = {}): BudgetState {
  return {
    task_id: "T-test",
    runs_used: 0,
    wall_time_ms_used: 0,
    cost_units_used: 0,
    caps: { max_runs: 4, max_wall_time_ms: 1_800_000, max_total_cost_units: 10 },
    status: "ok",
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("SCHEDULER_WEIGHTS", () => {
  it("has exact values from spec", () => {
    expect(SCHEDULER_WEIGHTS.capability_match).toBe(0.40);
    expect(SCHEDULER_WEIGHTS.cost_efficiency).toBe(0.20);
    expect(SCHEDULER_WEIGHTS.quota_health).toBe(0.20);
    expect(SCHEDULER_WEIGHTS.reliability).toBe(0.10);
    expect(SCHEDULER_WEIGHTS.latency_score).toBe(0.10);
  });

  it("sums to 1.0", () => {
    const sum = Object.values(SCHEDULER_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 9);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(SCHEDULER_WEIGHTS)).toBe(true);
  });
});

describe("DefaultScheduler", () => {
  it("deterministic pick: same inputs → same picked_agent_id", () => {
    const registry = new FakeRegistry();
    registry.add(makeEntry({ profile: { agent_id: "a" } as AgentRegistryEntry["profile"] }));
    const scheduler = new DefaultScheduler();

    const d1 = scheduler.decide({
      workOrder: makeWorkOrder(),
      role: "implementer",
      excludeAgentIds: [],
      registry,
      budget: makeBudget(),
    });
    const d2 = scheduler.decide({
      workOrder: makeWorkOrder(),
      role: "implementer",
      excludeAgentIds: [],
      registry,
      budget: makeBudget(),
    });

    expect(d1.picked_agent_id).toBe("a");
    expect(d2.picked_agent_id).toBe("a");
  });

  it("tie-break by agent_id (lexicographic smallest wins)", () => {
    const registry = new FakeRegistry();
    // Two identical agents except agent_id
    registry.add(makeEntry({
      profile: { agent_id: "b-agent" } as AgentRegistryEntry["profile"],
      rolling_metrics: { success_rate: 1, avg_latency_ms: 10000, avg_actual_cost_units: 0, runs_observed: 10, last_updated_at: "" },
    }));
    registry.add(makeEntry({
      profile: { agent_id: "a-agent" } as AgentRegistryEntry["profile"],
      rolling_metrics: { success_rate: 1, avg_latency_ms: 10000, avg_actual_cost_units: 0, runs_observed: 10, last_updated_at: "" },
    }));
    const scheduler = new DefaultScheduler();

    const d = scheduler.decide({
      workOrder: makeWorkOrder(),
      role: "implementer",
      excludeAgentIds: [],
      registry,
      budget: makeBudget(),
    });

    expect(d.picked_agent_id).toBe("a-agent");
  });

  it("excludes implementer candidates outside a non-empty implementer_pool", () => {
    const registry = new FakeRegistry();
    registry.add(makeEntry({
      profile: { agent_id: "aaa-not-in-pool" } as AgentRegistryEntry["profile"],
    }));
    registry.add(makeEntry({
      profile: { agent_id: "allowed-z" } as AgentRegistryEntry["profile"],
    }));
    const scheduler = new DefaultScheduler();

    const d = scheduler.decide({
      workOrder: makeWorkOrder({
        agent: {
          required_capabilities: ["code_change"],
          implementer_pool: ["allowed-z"],
          reviewer_pool: [],
          exclude_agent_ids: [],
        },
      }),
      role: "implementer",
      excludeAgentIds: [],
      registry,
      budget: makeBudget(),
    });

    expect(d.picked_agent_id).toBe("allowed-z");
    const outsidePool = d.candidate_scores.find((c) => c.agent_id === "aaa-not-in-pool");
    expect(outsidePool).toBeDefined();
    expect(outsidePool!.excluded).toBe(true);
    expect(outsidePool!.excluded_reason).toBe("not_in_implementer_pool");
  });

  it("excludes reviewer candidates outside a non-empty reviewer_pool and still excludes the most recent implementer", () => {
    const registry = new FakeRegistry();
    registry.add(makeEntry({
      profile: {
        agent_id: "aaa-not-in-pool",
        capabilities: { outer_supervised: true, inner_tool_control: false, kinds: ["code_change"], roles: ["reviewer"] },
      } as AgentRegistryEntry["profile"],
    }));
    registry.add(makeEntry({
      profile: {
        agent_id: "recent-implementer",
        capabilities: { outer_supervised: true, inner_tool_control: false, kinds: ["code_change"], roles: ["implementer", "reviewer"] },
      } as AgentRegistryEntry["profile"],
    }));
    registry.add(makeEntry({
      profile: {
        agent_id: "reviewer-z",
        capabilities: { outer_supervised: true, inner_tool_control: false, kinds: ["code_change"], roles: ["reviewer"] },
      } as AgentRegistryEntry["profile"],
    }));
    const scheduler = new DefaultScheduler();

    const d = scheduler.decide({
      workOrder: makeWorkOrder({
        agent: {
          required_capabilities: ["code_change"],
          implementer_pool: [],
          reviewer_pool: ["recent-implementer", "reviewer-z"],
          exclude_agent_ids: [],
        },
      }),
      role: "reviewer",
      excludeAgentIds: [],
      registry,
      budget: makeBudget(),
      mostRecentImplementerAgentId: "recent-implementer",
    });

    expect(d.picked_agent_id).toBe("reviewer-z");
    const outsidePool = d.candidate_scores.find((c) => c.agent_id === "aaa-not-in-pool");
    expect(outsidePool).toBeDefined();
    expect(outsidePool!.excluded).toBe(true);
    expect(outsidePool!.excluded_reason).toBe("not_in_reviewer_pool");

    const recentImplementer = d.candidate_scores.find((c) => c.agent_id === "recent-implementer");
    expect(recentImplementer).toBeDefined();
    expect(recentImplementer!.excluded).toBe(true);
    expect(recentImplementer!.excluded_reason).toBe("excluded_agent");
  });

  it("capability mismatch agent in candidate_scores with excluded_reason", () => {
    const registry = new FakeRegistry();
    registry.add(makeEntry({
      profile: { agent_id: "no-match", capabilities: { outer_supervised: true, inner_tool_control: false, kinds: ["docs_update"], roles: ["implementer"] } } as AgentRegistryEntry["profile"],
    }));
    registry.add(makeEntry({
      profile: { agent_id: "match" } as AgentRegistryEntry["profile"],
    }));
    const scheduler = new DefaultScheduler();

    const d = scheduler.decide({
      workOrder: makeWorkOrder({ agent: { required_capabilities: ["code_change"], implementer_pool: [], reviewer_pool: [], exclude_agent_ids: [] } }),
      role: "implementer",
      excludeAgentIds: [],
      registry,
      budget: makeBudget(),
    });

    const cs = d.candidate_scores.find((c) => c.agent_id === "no-match");
    expect(cs).toBeDefined();
    expect(cs!.excluded).toBe(true);
    expect(cs!.excluded_reason).toBe("capability_mismatch");

    expect(d.picked_agent_id).toBe("match");
  });

  it("role mismatch agent in candidate_scores with excluded_reason", () => {
    const registry = new FakeRegistry();
    registry.add(makeEntry({
      profile: { agent_id: "impl-only", capabilities: { outer_supervised: true, inner_tool_control: false, kinds: ["code_change"], roles: ["implementer"] } } as AgentRegistryEntry["profile"],
    }));
    registry.add(makeEntry({
      profile: { agent_id: "reviewer", capabilities: { outer_supervised: true, inner_tool_control: false, kinds: ["code_change"], roles: ["reviewer"] } } as AgentRegistryEntry["profile"],
    }));
    const scheduler = new DefaultScheduler();

    const d = scheduler.decide({
      workOrder: makeWorkOrder(),
      role: "reviewer",
      excludeAgentIds: [],
      registry,
      budget: makeBudget(),
    });

    const cs = d.candidate_scores.find((c) => c.agent_id === "impl-only");
    expect(cs).toBeDefined();
    expect(cs!.excluded).toBe(true);
    expect(cs!.excluded_reason).toBe("role_mismatch");

    expect(d.picked_agent_id).toBe("reviewer");
  });

  it("excluded agent appears in candidate_scores with excluded_agent", () => {
    const registry = new FakeRegistry();
    registry.add(makeEntry({ profile: { agent_id: "a" } as AgentRegistryEntry["profile"] }));
    registry.add(makeEntry({ profile: { agent_id: "b" } as AgentRegistryEntry["profile"] }));
    const scheduler = new DefaultScheduler();

    const d = scheduler.decide({
      workOrder: makeWorkOrder(),
      role: "implementer",
      excludeAgentIds: ["a"],
      registry,
      budget: makeBudget(),
    });

    const cs = d.candidate_scores.find((c) => c.agent_id === "a");
    expect(cs).toBeDefined();
    expect(cs!.excluded).toBe(true);
    expect(cs!.excluded_reason).toBe("excluded_agent");

    expect(d.picked_agent_id).toBe("b");
  });

  it("quota exhausted agent not picked, candidate_scores marks quota_exhausted", () => {
    const registry = new FakeRegistry();
    registry.add(makeEntry({ profile: { agent_id: "exhausted" } as AgentRegistryEntry["profile"], quota_health: "exhausted" }));
    registry.add(makeEntry({ profile: { agent_id: "healthy" } as AgentRegistryEntry["profile"] }));
    const scheduler = new DefaultScheduler();

    const d = scheduler.decide({
      workOrder: makeWorkOrder(),
      role: "implementer",
      excludeAgentIds: [],
      registry,
      budget: makeBudget(),
    });

    const cs = d.candidate_scores.find((c) => c.agent_id === "exhausted");
    expect(cs).toBeDefined();
    expect(cs!.excluded).toBe(true);
    expect(cs!.excluded_reason).toBe("quota_exhausted");

    expect(d.picked_agent_id).toBe("healthy");
  });

  it("scores low quota health as 0.5 and keeps the agent eligible", () => {
    const registry = new FakeRegistry();
    registry.add(makeEntry({
      profile: { agent_id: "low-agent" } as AgentRegistryEntry["profile"],
      quota_health: "low",
    }));
    const scheduler = new DefaultScheduler();

    const d = scheduler.decide({
      workOrder: makeWorkOrder(),
      role: "implementer",
      excludeAgentIds: [],
      registry,
      budget: makeBudget(),
    });

    const cs = d.candidate_scores.find((c) => c.agent_id === "low-agent");
    expect(d.picked_agent_id).toBe("low-agent");
    expect(cs).toBeDefined();
    expect(cs!.excluded).toBeUndefined();
    expect(cs!.breakdown.quota_health).toBe(0.5);
  });

  it("refusal: budget exhausted → task_budget_exhausted", () => {
    const registry = new FakeRegistry();
    registry.add(makeEntry({ profile: { agent_id: "a" } as AgentRegistryEntry["profile"] }));
    const scheduler = new DefaultScheduler();

    const d = scheduler.decide({
      workOrder: makeWorkOrder(),
      role: "implementer",
      excludeAgentIds: [],
      registry,
      budget: makeBudget({ status: "exhausted" }),
    });

    expect(d.picked_agent_id).toBeNull();
    expect(d.refusal_reason).toBe("task_budget_exhausted");
  });

  it("refusal: no capability match → no_agent_matches_capability", () => {
    const registry = new FakeRegistry();
    registry.add(makeEntry({
      profile: { agent_id: "a", capabilities: { outer_supervised: true, inner_tool_control: false, kinds: ["docs_update"], roles: ["implementer"] } } as AgentRegistryEntry["profile"],
    }));
    const scheduler = new DefaultScheduler();

    const d = scheduler.decide({
      workOrder: makeWorkOrder({ agent: { required_capabilities: ["code_change"], implementer_pool: [], reviewer_pool: [], exclude_agent_ids: [] } }),
      role: "implementer",
      excludeAgentIds: [],
      registry,
      budget: makeBudget(),
    });

    expect(d.picked_agent_id).toBeNull();
    expect(d.refusal_reason).toBe("no_agent_matches_capability");
  });

  it("refusal: cap match but no role match → no_agent_matches_capability (v1 folds role-only into capability refusal)", () => {
    const registry = new FakeRegistry();
    // Agent matches required capabilities but only has "implementer" role
    registry.add(makeEntry({
      profile: {
        agent_id: "impl-only",
        capabilities: { outer_supervised: true, inner_tool_control: false, kinds: ["code_change"], roles: ["implementer"] },
      } as AgentRegistryEntry["profile"],
    }));
    const scheduler = new DefaultScheduler();

    const d = scheduler.decide({
      workOrder: makeWorkOrder(),
      role: "reviewer",
      excludeAgentIds: [],
      registry,
      budget: makeBudget(),
    });

    expect(d.picked_agent_id).toBeNull();
    expect(d.refusal_reason).toBe("no_agent_matches_capability");

    const cs = d.candidate_scores.find((c) => c.agent_id === "impl-only");
    expect(cs).toBeDefined();
    expect(cs!.excluded).toBe(true);
    expect(cs!.excluded_reason).toBe("role_mismatch");
  });

  it("refusal: all excluded → all_candidates_excluded", () => {
    const registry = new FakeRegistry();
    registry.add(makeEntry({ profile: { agent_id: "a" } as AgentRegistryEntry["profile"] }));
    const scheduler = new DefaultScheduler();

    const d = scheduler.decide({
      workOrder: makeWorkOrder(),
      role: "implementer",
      excludeAgentIds: ["a"],
      registry,
      budget: makeBudget(),
    });

    expect(d.picked_agent_id).toBeNull();
    expect(d.refusal_reason).toBe("all_candidates_excluded");
  });

  it("refusal: all quota exhausted → all_candidates_quota_exhausted", () => {
    const registry = new FakeRegistry();
    registry.add(makeEntry({ profile: { agent_id: "a" } as AgentRegistryEntry["profile"], quota_health: "exhausted" }));
    const scheduler = new DefaultScheduler();

    const d = scheduler.decide({
      workOrder: makeWorkOrder(),
      role: "implementer",
      excludeAgentIds: [],
      registry,
      budget: makeBudget(),
    });

    expect(d.picked_agent_id).toBeNull();
    expect(d.refusal_reason).toBe("all_candidates_quota_exhausted");
  });

  it("reviewer auto-excludes mostRecentImplementerAgentId", () => {
    const registry = new FakeRegistry();
    registry.add(makeEntry({
      profile: { agent_id: "impl-a", capabilities: { outer_supervised: true, inner_tool_control: false, kinds: ["code_change"], roles: ["implementer", "reviewer"] } } as AgentRegistryEntry["profile"],
    }));
    registry.add(makeEntry({
      profile: { agent_id: "impl-b", capabilities: { outer_supervised: true, inner_tool_control: false, kinds: ["code_change"], roles: ["implementer", "reviewer"] } } as AgentRegistryEntry["profile"],
    }));
    const scheduler = new DefaultScheduler();

    const d = scheduler.decide({
      workOrder: makeWorkOrder(),
      role: "reviewer",
      excludeAgentIds: [], // caller forgot to exclude
      registry,
      budget: makeBudget(),
      mostRecentImplementerAgentId: "impl-a",
    });

    // impl-a should be excluded even though not in excludeAgentIds
    expect(d.picked_agent_id).toBe("impl-b");
  });

  it("score fixture: two agents with known scores", () => {
    const registry = new FakeRegistry();
    registry.add(makeEntry({
      profile: {
        agent_id: "agent-1",
        capabilities: { outer_supervised: true, inner_tool_control: false, kinds: ["code_change"], roles: ["implementer"] },
        cost_profile: { billing_unit: "token", estimated_cost_per_run_units: 1 },
        reliability: { initial_success_rate: 0.9, initial_avg_latency_ms: 30000 },
      } as AgentRegistryEntry["profile"],
      rolling_metrics: { success_rate: 0.95, avg_latency_ms: 20000, avg_actual_cost_units: 3, runs_observed: 10, last_updated_at: "" },
      quota_health: "healthy",
    }));
    registry.add(makeEntry({
      profile: {
        agent_id: "agent-2",
        capabilities: { outer_supervised: true, inner_tool_control: false, kinds: ["code_change"], roles: ["implementer"] },
        cost_profile: { billing_unit: "token", estimated_cost_per_run_units: 10 },
        reliability: { initial_success_rate: 0.7, initial_avg_latency_ms: 60000 },
      } as AgentRegistryEntry["profile"],
      rolling_metrics: { success_rate: 0.7, avg_latency_ms: 500000, avg_actual_cost_units: 8, runs_observed: 3, last_updated_at: "" },
      quota_health: "healthy",
    }));
    const scheduler = new DefaultScheduler();

    const d = scheduler.decide({
      workOrder: makeWorkOrder(),
      role: "implementer",
      excludeAgentIds: [],
      registry,
      budget: makeBudget(),
    });

    expect(d.picked_agent_id).toBe("agent-1");

    const cs1 = d.candidate_scores.find((c) => c.agent_id === "agent-1")!;
    const cs2 = d.candidate_scores.find((c) => c.agent_id === "agent-2")!;

    // agent-1 breakdown (healthy, cheap, reliable)
    expect(cs1.breakdown.capability_match).toBe(1);
    expect(cs1.breakdown.cost_efficiency).toBeCloseTo(1 - 1 / 10, 5); // max cost = 10
    expect(cs1.breakdown.quota_health).toBe(1);
    expect(cs1.breakdown.reliability).toBe(0.95); // runs_observed=10, rolling
    expect(cs1.breakdown.latency_score).toBeCloseTo(1 - 20000 / 600000, 5);

    // agent-2 breakdown
    expect(cs2.breakdown.capability_match).toBe(1);
    expect(cs2.breakdown.cost_efficiency).toBeCloseTo(1 - 10 / 10, 5); // expensive
    expect(cs2.breakdown.reliability).toBe(0.7); // runs_observed=3, initial
    expect(cs2.breakdown.latency_score).toBeCloseTo(1 - 500000 / 600000, 5);

    // agent-1 score should be higher
    expect(cs1.score).toBeGreaterThan(cs2.score);

    // Score computed by formula
    const w = SCHEDULER_WEIGHTS;
    const s1 =
      cs1.breakdown.capability_match * w.capability_match +
      cs1.breakdown.cost_efficiency * w.cost_efficiency +
      cs1.breakdown.quota_health * w.quota_health +
      cs1.breakdown.reliability * w.reliability +
      cs1.breakdown.latency_score * w.latency_score;
    expect(cs1.score).toBeCloseTo(s1, 9);
  });

  it("reliability: runs_observed < 5 uses initial_success_rate", () => {
    const registry = new FakeRegistry();
    registry.add(makeEntry({
      profile: {
        agent_id: "a",
        reliability: { initial_success_rate: 0.6, initial_avg_latency_ms: 10000 },
      } as AgentRegistryEntry["profile"],
      rolling_metrics: { success_rate: 0.99, avg_latency_ms: 10000, avg_actual_cost_units: 0, runs_observed: 3, last_updated_at: "" },
    }));
    const scheduler = new DefaultScheduler();

    const d = scheduler.decide({
      workOrder: makeWorkOrder(),
      role: "implementer",
      excludeAgentIds: [],
      registry,
      budget: makeBudget(),
    });

    const cs = d.candidate_scores.find((c) => c.agent_id === "a")!;
    expect(cs.breakdown.reliability).toBe(0.6);
  });

  it("reliability: runs_observed >= 5 uses rolling success_rate", () => {
    const registry = new FakeRegistry();
    registry.add(makeEntry({
      profile: {
        agent_id: "a",
        reliability: { initial_success_rate: 0.6, initial_avg_latency_ms: 10000 },
      } as AgentRegistryEntry["profile"],
      rolling_metrics: { success_rate: 0.88, avg_latency_ms: 10000, avg_actual_cost_units: 0, runs_observed: 7, last_updated_at: "" },
    }));
    const scheduler = new DefaultScheduler();

    const d = scheduler.decide({
      workOrder: makeWorkOrder(),
      role: "implementer",
      excludeAgentIds: [],
      registry,
      budget: makeBudget(),
    });

    const cs = d.candidate_scores.find((c) => c.agent_id === "a")!;
    expect(cs.breakdown.reliability).toBe(0.88);
  });

  it("latency_score clamp: >=600000ms → 0", () => {
    const registry = new FakeRegistry();
    registry.add(makeEntry({
      profile: { agent_id: "slow" } as AgentRegistryEntry["profile"],
      rolling_metrics: { success_rate: 0.5, avg_latency_ms: 600000, avg_actual_cost_units: 0, runs_observed: 10, last_updated_at: "" },
    }));
    const scheduler = new DefaultScheduler();

    const d = scheduler.decide({
      workOrder: makeWorkOrder(),
      role: "implementer",
      excludeAgentIds: [],
      registry,
      budget: makeBudget(),
    });

    const cs = d.candidate_scores.find((c) => c.agent_id === "slow")!;
    expect(cs.breakdown.latency_score).toBeCloseTo(0, 5);
  });

  it("latency_score: unknown latency → 0.5", () => {
    const registry = new FakeRegistry();
    registry.add(makeEntry({
      profile: { agent_id: "a" } as AgentRegistryEntry["profile"],
      rolling_metrics: { success_rate: 0.5, avg_latency_ms: 0, avg_actual_cost_units: 0, runs_observed: 0, last_updated_at: "" },
    }));
    const scheduler = new DefaultScheduler();

    const d = scheduler.decide({
      workOrder: makeWorkOrder(),
      role: "implementer",
      excludeAgentIds: [],
      registry,
      budget: makeBudget(),
    });

    const cs = d.candidate_scores.find((c) => c.agent_id === "a")!;
    expect(cs.breakdown.latency_score).toBe(0.5);
  });

  it("cost_efficiency: single candidate → 1.0", () => {
    const registry = new FakeRegistry();
    registry.add(makeEntry({
      profile: { agent_id: "only", cost_profile: { billing_unit: "token", estimated_cost_per_run_units: 999 } } as AgentRegistryEntry["profile"],
    }));
    const scheduler = new DefaultScheduler();

    const d = scheduler.decide({
      workOrder: makeWorkOrder(),
      role: "implementer",
      excludeAgentIds: [],
      registry,
      budget: makeBudget(),
    });

    const cs = d.candidate_scores.find((c) => c.agent_id === "only")!;
    expect(cs.breakdown.cost_efficiency).toBe(1.0);
  });

  it("decision has schema_version agent-workflow/1 and includes all fields", () => {
    const registry = new FakeRegistry();
    registry.add(makeEntry({ profile: { agent_id: "a" } as AgentRegistryEntry["profile"] }));
    const scheduler = new DefaultScheduler();

    const d = scheduler.decide({
      workOrder: makeWorkOrder(),
      role: "implementer",
      excludeAgentIds: [],
      registry,
      budget: makeBudget(),
    });

    expect(d.schema_version).toBe("agent-workflow/1");
    expect(d.decision_id).toMatch(/^D-/);
    expect(d.task_id).toBe("T-test");
    expect(d.role).toBe("implementer");
    expect(d.picked_agent_id).toBe("a");
    expect(d.decided_at).toBeDefined();
    expect(d.candidate_scores.length).toBe(1);
  });
});
