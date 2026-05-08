import { z } from "zod";
import type {
  WorkOrderV1,
  AgentProfileV1,
  RunManifestV1,
  ScheduleDecision,
  ReviewVerdict,
  HandoffPacket,
  BudgetState,
  TaskQueueEntry,
} from "./types.js";

// ─── WorkOrderV1 ─────────────────────────────────────────────────────────────

export const WorkOrderV1Schema = z.object({
  schema_version: z.literal("workflow/v1"),
  task_id: z.string().min(1),
  project_id: z.string().min(1).default("default"),
  title: z.string().min(1),
  type: z.enum([
    "code_change",
    "docs_update",
    "research_report",
    "ui_review",
    "data_analysis",
  ]),
  goal: z.string().min(1),
  acceptance_criteria: z.array(z.string().min(1)),
  repo: z.object({
    path: z.string().min(1),
    base_ref: z.string().optional(),
  }),
  constraints: z
    .object({
      allowed_paths: z.array(z.string()).optional(),
      forbidden_paths: z.array(z.string()).optional(),
      max_files_to_touch: z.number().int().positive().optional(),
    })
    .optional(),
  verification: z
    .object({
      commands: z.array(z.string().min(1)),
      timeout_seconds: z.number().int().positive().optional(),
    })
    .optional(),
  agent: z.object({
    required_capabilities: z.array(z.string().min(1)).min(1),
    implementer_pool: z.array(z.string()),
    reviewer_pool: z.array(z.string()).default([]),
    exclude_agent_ids: z.array(z.string()).default([]),
  }),
  review: z
    .object({
      enabled: z.boolean().default(true),
      max_review_runs: z.number().int().min(0).default(1),
    })
    .default({ enabled: true, max_review_runs: 1 }),
  budget: z
    .object({
      max_wall_time_minutes: z.number().positive().default(30),
      max_total_cost_units: z.number().positive().default(10),
      max_runs: z.number().int().positive().default(4),
      max_output_bytes: z.number().int().positive().optional(),
    })
    .default({ max_wall_time_minutes: 30, max_total_cost_units: 10, max_runs: 4 }),
}).refine(
  (data) => !data.review.enabled || data.budget.max_runs >= data.review.max_review_runs + 1,
  {
    message:
      "budget.max_runs must be >= review.max_review_runs + 1 when review is enabled (i.e. at least one implementer run plus review runs)",
    path: ["budget", "max_runs"],
  },
);

export type ParsedWorkOrderV1 = z.infer<typeof WorkOrderV1Schema>;

export function parseWorkOrderV1(input: unknown): ParsedWorkOrderV1 {
  return WorkOrderV1Schema.parse(input);
}

// ─── AgentProfileV1 ──────────────────────────────────────────────────────────

export const AgentProfileV1Schema = z.object({
  schema_version: z.literal("workflow/v1"),
  agent_id: z.string().min(1),
  integration_mode: z.literal("official_cli"),
  command: z.object({
    executable: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().optional(),
  }),
  environment: z
    .object({
      set: z.record(z.string()).optional(),
      unset: z.array(z.string()).optional(),
    })
    .optional(),
  capabilities: z
    .object({
      outer_supervised: z.literal(true),
      inner_tool_control: z.literal(false),
      kinds: z.array(z.string().min(1)).min(1),
      roles: z
        .array(z.enum(["implementer", "reviewer"]))
        .min(1),
    }),
  cost_profile: z
    .object({
      billing_unit: z.enum([
        "token",
        "call",
        "wall_time",
        "local_compute",
        "unknown",
      ]),
      estimated_cost_per_run_units: z.number().min(0),
    })
    .optional(),
  quota: z
    .object({
      soft_limit_ratio: z.number().default(0.85),
      hard_limit_ratio: z.number().default(0.98),
      reset_at: z.string().nullable().optional(),
    })
    .optional()
    .default({ soft_limit_ratio: 0.85, hard_limit_ratio: 0.98 }),
  reliability: z
    .object({
      initial_success_rate: z.number().min(0).max(1).default(0.8),
      initial_avg_latency_ms: z.number().positive().default(60000),
    })
    .optional()
    .default({ initial_success_rate: 0.8, initial_avg_latency_ms: 60000 }),
  limits: z
    .object({
      timeout_seconds: z.number().int().positive().optional(),
      max_stdout_bytes: z.number().int().positive().optional(),
      max_stderr_bytes: z.number().int().positive().optional(),
    })
    .optional(),
}).refine(
  (data) => data.quota.soft_limit_ratio < data.quota.hard_limit_ratio,
  {
    message: "quota.soft_limit_ratio must be < quota.hard_limit_ratio",
    path: ["quota", "soft_limit_ratio"],
  },
).refine(
  (data) => data.quota.hard_limit_ratio <= 1,
  {
    message: "quota.hard_limit_ratio must be <= 1",
    path: ["quota", "hard_limit_ratio"],
  },
);

export type ParsedAgentProfileV1 = z.infer<typeof AgentProfileV1Schema>;

export function parseAgentProfileV1(input: unknown): ParsedAgentProfileV1 {
  return AgentProfileV1Schema.parse(input);
}

// ─── RunManifestV1 ───────────────────────────────────────────────────────────

export const RunManifestV1Schema = z.object({
  schema_version: z.literal("agent-workflow/1"),
  run_id: z.string().min(1),
  task_id: z.string().min(1),
  project_id: z.string().min(1),
  agent_id: z.string().min(1),
  integration_mode: z.literal("official_cli"),
  role: z.enum(["implementer", "reviewer"]),
  workspace_uri: z.string().min(1),
  base_commit: z.string().min(1),
  branch: z.string().min(1),
  work_order_hash: z.string().min(1),
  adapter_version: z.string().min(1),
  binary_version: z.string().optional(),
  parent_run_id: z.string().optional(),
  handoff_packet_uri: z.string().optional(),
  started_at: z.string().min(1),
  ended_at: z.string().nullable().optional(),
  status: z.enum(["preparing", "running", "succeeded", "failed", "cancelled"]),
});

// ─── ScheduleDecision ────────────────────────────────────────────────────────

export const ScheduleDecisionSchema = z.object({
  schema_version: z.literal("agent-workflow/1"),
  decision_id: z.string().min(1),
  task_id: z.string().min(1),
  role: z.enum(["implementer", "reviewer"]),
  picked_agent_id: z.string().nullable(),
  refusal_reason: z
    .enum([
      "no_agent_matches_capability",
      "all_candidates_excluded",
      "all_candidates_quota_exhausted",
      "task_budget_exhausted",
    ])
    .optional(),
  candidate_scores: z.array(
    z.object({
      agent_id: z.string(),
      score: z.number(),
      breakdown: z.object({
        capability_match: z.number(),
        cost_efficiency: z.number(),
        quota_health: z.number(),
        reliability: z.number(),
        latency_score: z.number(),
      }),
      excluded: z.boolean().optional(),
      excluded_reason: z.string().optional(),
    }),
  ),
  decided_at: z.string().min(1),
});

// ─── ReviewVerdict ───────────────────────────────────────────────────────────

export const ReviewVerdictSchema = z.object({
  schema_version: z.literal("agent-workflow/1"),
  verdict: z.enum(["approved", "changes_requested", "rejected"]),
  summary: z.string().min(1),
  comments: z.array(
    z.object({
      path: z.string().optional(),
      line: z.number().optional(),
      severity: z.enum(["must_fix", "should_fix", "nit"]),
      comment: z.string().min(1),
    }),
  ),
});

export function parseReviewVerdictFile(text: string): ReviewVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      "Failed to parse review verdict: file contains invalid JSON",
    );
  }
  return ReviewVerdictSchema.parse(parsed) as ReviewVerdict;
}

// ─── HandoffPacket ───────────────────────────────────────────────────────────

export const HandoffPacketSchema = z.object({
  schema_version: z.literal("agent-workflow/1"),
  task_id: z.string().min(1),
  from_run_id: z.string().min(1),
  from_agent_id: z.string().min(1),
  reason: z.enum([
    "verification_failed",
    "review_changes_requested",
    "review_rejected",
    "agent_timed_out",
    "agent_nonzero_exit",
    "quota_exhausted",
    "scheduler_refusal",
  ]),
  summary: z.string().min(1),
  diff_artifact_uri: z.string().optional(),
  verification_output_uri: z.string().optional(),
  review_verdict_uri: z.string().optional(),
  remaining_work: z.string().min(1),
  exclude_agent_ids: z.array(z.string()),
  created_at: z.string().min(1),
});

// ─── BudgetState ─────────────────────────────────────────────────────────────

export const BudgetStateSchema = z.object({
  task_id: z.string().min(1),
  runs_used: z.number().int().min(0),
  wall_time_ms_used: z.number().min(0),
  cost_units_used: z.number().min(0),
  caps: z.object({
    max_runs: z.number().int().positive(),
    max_wall_time_ms: z.number().positive(),
    max_total_cost_units: z.number().positive(),
  }),
  status: z.enum(["ok", "soft_warning", "exhausted"]),
});

// ─── TaskQueueEntry ──────────────────────────────────────────────────────────

export const TaskQueueEntrySchema = z.object({
  task_id: z.string().min(1),
  project_id: z.string().min(1),
  status: z.enum([
    "queued",
    "dispatched",
    "implementing",
    "verifying",
    "reviewing",
    "accepted",
    "failed",
    "awaiting_human",
  ]),
  next_role: z.enum(["implementer", "reviewer"]),
  current_owner_run_id: z.string().nullable(),
  lease_expires_at: z.string().nullable(),
  attempts: z.number().int().min(0),
  enqueued_at: z.string().min(1),
  updated_at: z.string().min(1),
});
