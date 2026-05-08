import type { WorkOrderV0, WorkOrderV1 } from "./types.js";

/**
 * One-way upgrade from v0 WorkOrder to v1 WorkOrder.
 *
 * Rules:
 * - Common fields copied verbatim.
 * - agent.agent_id → agent.implementer_pool: [agent_id]
 * - agent.required_capabilities synthesized from type (e.g. code_change → ["code_change"])
 * - agent.reviewer_pool: [], agent.exclude_agent_ids: []
 * - review.enabled: false
 * - budget.max_runs: 1, with v0 budget fields mapped where possible
 */
export function upgradeWorkOrderV0ToV1(v0: WorkOrderV0): WorkOrderV1 {
  const v1: WorkOrderV1 = {
    schema_version: "workflow/v1",
    task_id: v0.task_id,
    project_id: v0.project_id,
    title: v0.title,
    type: v0.type,
    goal: v0.goal,
    acceptance_criteria: v0.acceptance_criteria,
    repo: { ...v0.repo },
    agent: {
      required_capabilities: [v0.type],
      implementer_pool: [v0.agent.agent_id],
      reviewer_pool: [],
      exclude_agent_ids: [],
    },
    review: {
      enabled: false,
      max_review_runs: 0,
    },
    budget: {
      max_runs: 1,
      max_wall_time_minutes: v0.budget?.max_wall_time_minutes ?? 30,
      max_total_cost_units: 10,
      max_output_bytes: v0.budget?.max_output_bytes,
    },
  };

  // Copy optional common fields if present
  if (v0.constraints) {
    v1.constraints = { ...v0.constraints };
  }
  if (v0.verification) {
    v1.verification = { ...v0.verification };
  }

  return v1;
}
