import type { ScheduleDecision, AgentRegistryEntry, BudgetState } from "../core/types.js";
import type { ParsedWorkOrderV1 } from "../core/schemas-v1.js";
import type { AgentRegistry } from "./agent-registry.js";
import { generateDecisionId } from "../core/ids.js";

// ─── Weights ─────────────────────────────────────────────────────────────────

export const SCHEDULER_WEIGHTS = Object.freeze({
  capability_match: 0.40,
  cost_efficiency: 0.20,
  quota_health: 0.20,
  reliability: 0.10,
  latency_score: 0.10,
} as const);

// ─── Scheduler interface ─────────────────────────────────────────────────────

export interface Scheduler {
  decide(args: {
    workOrder: ParsedWorkOrderV1;
    role: "implementer" | "reviewer";
    excludeAgentIds: string[];
    registry: AgentRegistry;
    budget: BudgetState;
    mostRecentImplementerAgentId?: string;
  }): ScheduleDecision;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clamp(val: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, val));
}

function isSubset(sub: Set<string>, sup: Set<string>): boolean {
  for (const item of sub) {
    if (!sup.has(item)) return false;
  }
  return true;
}

function computeCostEfficiency(
  entry: AgentRegistryEntry,
  maxCostInPool: number,
  candidateCount: number,
): number {
  if (candidateCount <= 1) return 1.0;
  if (maxCostInPool <= 0) return 1.0;
  const estimatedCost = entry.profile.cost_profile?.estimated_cost_per_run_units ?? 0;
  return clamp(1 - estimatedCost / maxCostInPool, 0, 1);
}

function computeLatencyScore(entry: AgentRegistryEntry): number {
  const latency = entry.rolling_metrics.avg_latency_ms;
  if (latency <= 0) return 0.5;
  return clamp(1 - latency / 600_000, 0, 1);
}

function computeReliability(entry: AgentRegistryEntry): number {
  const m = entry.rolling_metrics;
  if (m.runs_observed >= 5) {
    return m.success_rate;
  }
  return entry.profile.reliability?.initial_success_rate ?? 0.8;
}

function quotaHealthToScore(qh: AgentRegistryEntry["quota_health"]): number {
  switch (qh) {
    case "healthy": return 1.0;
    case "low": return 0.5;
    case "exhausted": return 0.0;
  }
}

// ─── Candidate analysis ─────────────────────────────────────────────────────

interface CandidateAnalysis {
  entry: AgentRegistryEntry;
  capabilityMatch: boolean;
  roleMatch: boolean;
  excluded: boolean;
  excludedReason?: string;
  quotaExhausted: boolean;
}

function analyzeCandidates(
  registry: AgentRegistry,
  requiredCaps: Set<string>,
  role: string,
  excludeSet: Set<string>,
): CandidateAnalysis[] {
  const results: CandidateAnalysis[] = [];

  for (const entry of registry.list()) {
    const kindsSet = new Set(entry.profile.capabilities.kinds);
    const capabilityMatch = isSubset(requiredCaps, kindsSet);
    const roleMatch = (entry.profile.capabilities.roles as readonly string[]).includes(role);
    const quotaExhausted = entry.quota_health === "exhausted";
    const isExcluded = excludeSet.has(entry.profile.agent_id);

    let excluded = false;
    let excludedReason: string | undefined;

    if (isExcluded) {
      excluded = true;
      excludedReason = "excluded_agent";
    } else if (!capabilityMatch) {
      excluded = true;
      excludedReason = "capability_mismatch";
    } else if (!roleMatch) {
      excluded = true;
      excludedReason = "role_mismatch";
    } else if (quotaExhausted) {
      excluded = true;
      excludedReason = "quota_exhausted";
    }

    results.push({
      entry,
      capabilityMatch,
      roleMatch,
      excluded,
      excludedReason,
      quotaExhausted,
    });
  }

  // Deterministic ordering
  results.sort((a, b) => a.entry.profile.agent_id.localeCompare(b.entry.profile.agent_id));
  return results;
}

// ─── DefaultScheduler ────────────────────────────────────────────────────────

export class DefaultScheduler implements Scheduler {
  decide(args: {
    workOrder: ParsedWorkOrderV1;
    role: "implementer" | "reviewer";
    excludeAgentIds: string[];
    registry: AgentRegistry;
    budget: BudgetState;
    mostRecentImplementerAgentId?: string;
  }): ScheduleDecision {
    const { workOrder, role, registry, budget } = args;

    // Build effective exclusion set
    const excludeSet = new Set(args.excludeAgentIds);

    // Defense-in-depth for reviewer: exclude most recent implementer
    if (role === "reviewer" && args.mostRecentImplementerAgentId) {
      excludeSet.add(args.mostRecentImplementerAgentId);
    }

    const requiredCaps = new Set(workOrder.agent.required_capabilities);

    // Analyze all candidates
    const analyses = analyzeCandidates(registry, requiredCaps, role, excludeSet);

    // Eligible candidates: not excluded
    const eligible = analyses.filter((a) => !a.excluded);

    // ─── Refusal checks (in order) ──────────────────────────────────────

    // 1. Budget exhausted
    if (budget.status === "exhausted") {
      return this.buildDecision(workOrder.task_id, role, null, "task_budget_exhausted", analyses, eligible);
    }

    // 2. No capability match at all
    const anyCapMatch = analyses.some((a) => a.capabilityMatch);
    if (!anyCapMatch) {
      return this.buildDecision(workOrder.task_id, role, null, "no_agent_matches_capability", analyses, eligible);
    }

    // 2b. Capability match exists, but no agent matches the requested role.
    // v1 folds role-only mismatch into no_agent_matches_capability because
    // the v1 refusal reason set has no dedicated role-mismatch reason.
    const anyCapRoleMatch = analyses.some((a) => a.capabilityMatch && a.roleMatch);
    if (!anyCapRoleMatch) {
      return this.buildDecision(workOrder.task_id, role, null, "no_agent_matches_capability", analyses, eligible);
    }

    // 3. All capability+role matching candidates are excluded or exhausted
    const capRoleNotExplicitlyExcluded = analyses.filter(
      (a) => a.capabilityMatch && a.roleMatch && a.excludedReason !== "excluded_agent",
    );
    if (capRoleNotExplicitlyExcluded.length === 0) {
      // All matching candidates were explicitly excluded
      return this.buildDecision(workOrder.task_id, role, null, "all_candidates_excluded", analyses, eligible);
    }

    // Check if all non-excluded cap+role matches are quota exhausted
    const capRoleNonExhausted = capRoleNotExplicitlyExcluded.filter(
      (a) => !a.quotaExhausted,
    );
    if (capRoleNonExhausted.length === 0) {
      // All remaining are quota exhausted
      return this.buildDecision(workOrder.task_id, role, null, "all_candidates_quota_exhausted", analyses, eligible);
    }

    // ─── Scoring ────────────────────────────────────────────────────────

    // Find max cost in pool for cost_efficiency normalization
    let maxCost = 0;
    for (const a of eligible) {
      const c = a.entry.profile.cost_profile?.estimated_cost_per_run_units ?? 0;
      if (c > maxCost) maxCost = c;
    }

    const scored = eligible.map((a) => {
      const breakdown = {
        capability_match: a.capabilityMatch ? 1.0 : 0.0,
        cost_efficiency: computeCostEfficiency(a.entry, maxCost, eligible.length),
        quota_health: quotaHealthToScore(a.entry.quota_health),
        reliability: computeReliability(a.entry),
        latency_score: computeLatencyScore(a.entry),
      };

      const score =
        breakdown.capability_match * SCHEDULER_WEIGHTS.capability_match +
        breakdown.cost_efficiency * SCHEDULER_WEIGHTS.cost_efficiency +
        breakdown.quota_health * SCHEDULER_WEIGHTS.quota_health +
        breakdown.reliability * SCHEDULER_WEIGHTS.reliability +
        breakdown.latency_score * SCHEDULER_WEIGHTS.latency_score;

      return { entry: a.entry, score, breakdown };
    });

    // Pick best: highest score, tie-break by agent_id lexicographic (smallest first)
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.entry.profile.agent_id.localeCompare(b.entry.profile.agent_id);
    });

    const best = scored[0];

    // Build candidate scores list for all agents (deterministic: by agent_id)
    const candidateScores = analyses.map((a) => {
      const scoreEntry = scored.find((s) => s.entry.profile.agent_id === a.entry.profile.agent_id);
      return {
        agent_id: a.entry.profile.agent_id,
        score: scoreEntry?.score ?? 0,
        breakdown: scoreEntry?.breakdown ?? {
          capability_match: a.capabilityMatch ? 1.0 : 0.0,
          cost_efficiency: 0,
          quota_health: quotaHealthToScore(a.entry.quota_health),
          reliability: computeReliability(a.entry),
          latency_score: computeLatencyScore(a.entry),
        },
        excluded: a.excluded || undefined,
        excluded_reason: a.excludedReason,
      };
    });

    // Sort by agent_id
    candidateScores.sort((a, b) => a.agent_id.localeCompare(b.agent_id));

    return {
      schema_version: "agent-workflow/1",
      decision_id: generateDecisionId(),
      task_id: workOrder.task_id,
      role,
      picked_agent_id: best.entry.profile.agent_id,
      candidate_scores: candidateScores,
      decided_at: new Date().toISOString(),
    };
  }

  private buildDecision(
    taskId: string,
    role: "implementer" | "reviewer",
    pickedAgentId: string | null,
    refusalReason: ScheduleDecision["refusal_reason"],
    analyses: CandidateAnalysis[],
    eligible: CandidateAnalysis[],
  ): ScheduleDecision {
    const decisionId = generateDecisionId();

    // Build excluded-only candidate_scores (no one was scored)
    const candidateScores = analyses.map((a) => ({
      agent_id: a.entry.profile.agent_id,
      score: 0,
      breakdown: {
        capability_match: a.capabilityMatch ? 1.0 : 0.0,
        cost_efficiency: 0,
        quota_health: quotaHealthToScore(a.entry.quota_health),
        reliability: computeReliability(a.entry),
        latency_score: computeLatencyScore(a.entry),
      },
      excluded: a.excluded || undefined,
      excluded_reason: a.excludedReason,
    }));

    candidateScores.sort((a, b) => a.agent_id.localeCompare(b.agent_id));

    return {
      schema_version: "agent-workflow/1",
      decision_id: decisionId,
      task_id: taskId,
      role,
      picked_agent_id: pickedAgentId,
      refusal_reason: refusalReason,
      candidate_scores: candidateScores,
      decided_at: new Date().toISOString(),
    };
  }
}
