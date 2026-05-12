// Core TypeScript type definitions for the agent workflow system.
// These are the canonical types; Zod schemas in schemas.ts / schemas-v1.ts derive from these.

// ─── v0 Types (unchanged) ────────────────────────────────────────────────────

export type WorkOrderV0 = {
  schema_version: "workflow/v0";
  task_id: string;
  project_id?: string;
  title: string;
  type: "code_change" | "docs_update" | "research_report" | "ui_review" | "data_analysis";
  goal: string;
  acceptance_criteria: string[];
  repo: {
    path: string;
    base_ref?: string;
  };
  constraints?: {
    allowed_paths?: string[];
    forbidden_paths?: string[];
    max_files_to_touch?: number;
  };
  verification?: {
    commands: string[];
    timeout_seconds?: number;
  };
  agent: {
    agent_id: string;
  };
  budget?: {
    max_wall_time_minutes?: number;
    max_output_bytes?: number;
  };
};

export type AgentProfileV0 = {
  schema_version: "workflow/v0";
  agent_id: string;
  integration_mode: "official_cli";
  command: {
    executable: string;
    args: string[];
    cwd?: string;
  };
  environment?: {
    set?: Record<string, string>;
    unset?: string[];
  };
  capabilities: {
    outer_supervised: true;
    inner_tool_control: false;
  };
  limits?: {
    timeout_seconds?: number;
    max_stdout_bytes?: number;
    max_stderr_bytes?: number;
  };
};

// ─── v0 + v1 Union types (hand-written input shapes) ────────────────────────

/** Canonical union type combining v0 and v1 WorkOrder input shapes.
 *  For parsed types with Zod defaults applied, use `ParsedWorkOrder | ParsedWorkOrderV1` from `schemas.ts`. */
export type WorkOrder = WorkOrderV0 | WorkOrderV1;

/** Canonical union type combining v0 and v1 AgentProfile input shapes.
 *  For parsed types with Zod defaults applied, use `ParsedAgentProfile | ParsedAgentProfileV1` from `schemas.ts`. */
export type AgentProfile = AgentProfileV0 | AgentProfileV1;

// ─── v1 Types ────────────────────────────────────────────────────────────────

export type WorkOrderV1 = {
  schema_version: "workflow/v1";
  task_id: string;
  project_id?: string;
  title: string;
  type: "code_change" | "docs_update" | "research_report" | "ui_review" | "data_analysis";
  goal: string;
  acceptance_criteria: string[];
  repo: {
    path: string;
    base_ref?: string;
  };
  constraints?: {
    allowed_paths?: string[];
    forbidden_paths?: string[];
    max_files_to_touch?: number;
  };
  verification?: {
    commands: string[];
    timeout_seconds?: number;
  };
  agent: {
    required_capabilities: string[];
    implementer_pool: string[];
    reviewer_pool?: string[];
    exclude_agent_ids?: string[];
  };
  review?: {
    enabled: boolean;
    max_review_runs?: number;
  };
  budget?: {
    max_wall_time_minutes?: number;
    max_total_cost_units?: number;
    max_runs?: number;
    max_output_bytes?: number;
  };
};

export type AgentProfileV1 = {
  schema_version: "workflow/v1";
  agent_id: string;
  integration_mode: "official_cli";
  command: {
    executable: string;
    args: string[];
    cwd?: string;
  };
  environment?: {
    set?: Record<string, string>;
    unset?: string[];
  };
  capabilities: {
    outer_supervised: true;
    inner_tool_control: false;
    kinds: string[];
    roles: Array<"implementer" | "reviewer">;
  };
  cost_profile?: {
    billing_unit: "token" | "call" | "wall_time" | "local_compute" | "unknown";
    estimated_cost_per_run_units: number;
  };
  failure_classification?: {
    provider_rate_limited_stderr?: string[];
    provider_quota_exhausted_stderr?: string[];
    provider_auth_failed_stderr?: string[];
  };
  quota?: {
    soft_limit_ratio?: number;
    hard_limit_ratio?: number;
    reset_at?: string | null;
  };
  reliability?: {
    initial_success_rate?: number;
    initial_avg_latency_ms?: number;
  };
  limits?: {
    timeout_seconds?: number;
    max_stdout_bytes?: number;
    max_stderr_bytes?: number;
  };
};

export type RunManifestV1 = {
  schema_version: "agent-workflow/1";
  run_id: string;
  task_id: string;
  project_id: string;
  agent_id: string;
  integration_mode: "official_cli";
  role: "implementer" | "reviewer";
  workspace_uri: string;
  base_commit: string;
  branch: string;
  work_order_hash: string;
  adapter_version: string;
  binary_version?: string;
  parent_run_id?: string;
  handoff_packet_uri?: string;
  started_at: string;
  ended_at?: string | null;
  status: "preparing" | "running" | "succeeded" | "failed" | "cancelled";
};

export type ScheduleDecision = {
  schema_version: "agent-workflow/1";
  decision_id: string;
  task_id: string;
  role: "implementer" | "reviewer";
  picked_agent_id: string | null;
  refusal_reason?:
    | "no_agent_matches_capability"
    | "all_candidates_excluded"
    | "all_candidates_quota_exhausted"
    | "task_budget_exhausted";
  candidate_scores: Array<{
    agent_id: string;
    score: number;
    breakdown: {
      capability_match: number;
      cost_efficiency: number;
      quota_health: number;
      reliability: number;
      latency_score: number;
    };
    excluded?: boolean;
    excluded_reason?: string;
  }>;
  decided_at: string;
};

export type ReviewVerdict = {
  schema_version: "agent-workflow/1";
  verdict: "approved" | "changes_requested" | "rejected";
  summary: string;
  comments: Array<{
    path?: string;
    line?: number;
    severity: "must_fix" | "should_fix" | "nit";
    comment: string;
  }>;
};

export type HandoffPacket = {
  schema_version: "agent-workflow/1";
  task_id: string;
  from_run_id: string;
  from_agent_id: string;
  reason:
    | "verification_failed"
    | "review_changes_requested"
    | "diff_apply_failed"
    | "review_rejected"
    | "agent_timed_out"
    | "agent_nonzero_exit"
    | "quota_exhausted"
    | "scheduler_refusal";
  summary: string;
  diff_artifact_uri?: string;
  verification_output_uri?: string;
  review_verdict_uri?: string;
  remaining_work: string;
  exclude_agent_ids: string[];
  created_at: string;
};

export type BudgetState = {
  task_id: string;
  runs_used: number;
  wall_time_ms_used: number;
  cost_units_used: number;
  caps: {
    max_runs: number;
    max_wall_time_ms: number;
    max_total_cost_units: number;
  };
  status: "ok" | "soft_warning" | "exhausted";
};

export type TaskQueueEntry = {
  task_id: string;
  project_id: string;
  status: "queued" | "dispatched" | "implementing" | "verifying" | "reviewing" | "accepted" | "failed" | "awaiting_human";
  next_role: "implementer" | "reviewer";
  current_owner_run_id: string | null;
  lease_expires_at: string | null;
  attempts: number;
  enqueued_at: string;
  updated_at: string;
};

export type ReviewContextRecord = {
  implementer_run_id: string;
  implementer_agent_id: string;
  diff_artifact_uri: string;
  final_report_uri?: string;
  verification_output_uri?: string;
};

export type AgentRegistryEntry = {
  profile: AgentProfileV1;
  loaded_from: string;
  rolling_metrics: {
    success_rate: number;
    avg_latency_ms: number;
    avg_actual_cost_units: number;
    runs_observed: number;
    last_updated_at: string;
  };
  quota_health: "healthy" | "low" | "exhausted";
};

// ─── Shared Types ────────────────────────────────────────────────────────────

export type RunManifest = {
  schema_version: "agent-workflow/1";
  run_id: string;
  task_id: string;
  project_id: string;
  agent_id: string;
  integration_mode: "official_cli";
  workspace_uri: string;
  base_commit: string;
  branch: string;
  work_order_hash: string;
  adapter_version: string;
  binary_version?: string;
  started_at: string;
  ended_at?: string | null;
  status: "preparing" | "running" | "succeeded" | "failed" | "cancelled";
};

export type ArtifactRef = {
  uri: string;
  kind: ArtifactKindV1;
  checksum?: string;
  summary?: string;
};

export type ArtifactKindV1 =
  | "diff"
  | "stdout_tail"
  | "stderr_tail"
  | "verification_output"
  | "task_capsule"
  | "final_report"
  | "review_verdict"
  | "handoff_packet"
  | "schedule_decision";

export type EventPayload = Record<string, unknown>;

export type EventEnvelope<TPayload extends EventPayload = EventPayload> = {
  event_id: string;
  event_type: string;
  project_id: string;
  task_id?: string;
  run_id?: string;
  agent_id?: string;
  correlation_id?: string;
  causation_id?: string;
  side_effect_type?: string;
  skip_on_replay?: boolean;
  payload: TPayload;
  created_at: string;
};

export type RunStatus = "preparing" | "running" | "succeeded" | "failed" | "cancelled";

export type ArtifactKind = ArtifactKindV1;
