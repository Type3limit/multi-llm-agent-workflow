# Machine-Readable Contracts (v1)

v1 keeps every v0 contract working. New shapes either bump `schema_version` (`workflow/v1`) or add brand-new top-level types (`AgentRegistryEntry`, `ScheduleDecision`, `ReviewVerdict`, `HandoffPacket`, `BudgetState`, `TaskQueueEntry`).

All shapes are TypeScript types plus Zod schemas. JSON Schema can be generated later if needed.

## Backwards Compatibility Rule

- Code that parses WorkOrder must accept both `schema_version: "workflow/v0"` and `schema_version: "workflow/v1"`.
- v0 WorkOrders are run through a one-way **upgrader** that synthesizes the v1 fields:
  - `agent.agent_id` -> `agent.implementer_pool: [agent_id]`, `reviewer_pool: []`, `review.enabled: false`.
- v1 AgentProfiles are accepted alongside v0; profile parser dispatches on `schema_version`.
- Persisted rows retain their original `schema_version`; the orchestrator never silently rewrites them.

## WorkOrder (workflow/v1)

```ts
export type WorkOrderV1 = {
  schema_version: "workflow/v1";
  task_id: string;
  project_id?: string;            // defaults to "default"
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
    required_capabilities: string[];      // e.g. ["code_change"]; matches AgentProfile.capabilities.kinds
    implementer_pool: string[];           // ordered preference list of agent_ids; empty -> any agent with required_capabilities
    reviewer_pool?: string[];             // empty -> Scheduler picks any reviewer-marked agent that meets required_capabilities
    exclude_agent_ids?: string[];         // hard exclusions (e.g. previously failed); Scheduler must never pick these
  };

  review?: {
    enabled: boolean;                     // default true
    max_review_runs?: number;             // default 1; reviewers are not re-tried within a run, only across requeues
  };

  budget?: {
    max_wall_time_minutes?: number;       // total wall time across all runs of this task
    max_total_cost_units?: number;        // total cost units across all runs
    max_runs?: number;                    // hard ceiling on attempts; default 4
    max_output_bytes?: number;            // forwarded to per-run adapter
  };
};
```

Validation rules:

- `agent.required_capabilities` must be non-empty.
- Pools must contain only `agent_id` strings; resolution to AgentProfiles happens at Scheduler time, not parse time.
- An `agent_id` listed in both `implementer_pool` and `reviewer_pool` is allowed; the Scheduler resolves which role to use per run.
- `review.max_review_runs` is bounded by `budget.max_runs`.

## AgentProfile (workflow/v1)

```ts
export type AgentProfileV1 = {
  schema_version: "workflow/v1";
  agent_id: string;
  integration_mode: "official_cli";

  command: {
    executable: string;
    args: string[];                       // {{prompt_file}} substitution per v0
    cwd?: string;
  };

  environment?: {
    set?: Record<string, string>;
    unset?: string[];
  };

  capabilities: {
    outer_supervised: true;               // hard requirement, same as v0
    inner_tool_control: false;            // hard requirement, same as v0
    kinds: string[];                      // e.g. ["code_change", "ui_review"]
    roles: Array<"implementer" | "reviewer">;
  };

  cost_profile?: {
    billing_unit: "token" | "call" | "wall_time" | "local_compute" | "unknown";
    estimated_cost_per_run_units: number; // coarse estimate used by Scheduler
  };

  quota?: {
    soft_limit_ratio?: number;            // default 0.85
    hard_limit_ratio?: number;            // default 0.98
    reset_at?: string | null;             // ISO timestamp when quota resets, or null if unknown
  };

  reliability?: {
    initial_success_rate?: number;        // default 0.8; Scheduler tracks rolling actuals from agent_usage
    initial_avg_latency_ms?: number;      // default 60000; Scheduler tracks rolling actuals
  };

  limits?: {
    timeout_seconds?: number;
    max_stdout_bytes?: number;
    max_stderr_bytes?: number;
  };
};
```

Validation rules:

- `capabilities.kinds` must be non-empty.
- `capabilities.roles` must be non-empty; an agent that is only an implementer simply omits `"reviewer"`.
- `cost_profile.estimated_cost_per_run_units` must be `>= 0`.
- `quota.soft_limit_ratio < quota.hard_limit_ratio <= 1`.

Hot-reload is not supported in v1. AgentRegistry is loaded once per CLI invocation.

## AgentRegistryEntry

In-memory record after a profile is loaded:

```ts
export type AgentRegistryEntry = {
  profile: AgentProfileV1;
  loaded_from: string;                    // absolute path
  rolling_metrics: {
    success_rate: number;                 // 0..1
    avg_latency_ms: number;
    avg_actual_cost_units: number;        // rolling mean
    runs_observed: number;
    last_updated_at: string;
  };
  quota_health: "healthy" | "low" | "exhausted";
};
```

`rolling_metrics` are persisted in the `agent_metrics` table (see v1-development-spec) and reloaded on next CLI invocation. There is no global gossip protocol — single process, single SQLite file.

## ScheduleDecision

The Scheduler emits one of these per dispatch attempt; it is the payload of `task.dispatched`.

```ts
export type ScheduleDecision = {
  schema_version: "agent-workflow/1";
  decision_id: string;
  task_id: string;
  role: "implementer" | "reviewer";
  picked_agent_id: string | null;         // null when Scheduler refuses (no eligible agent)
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
      cost_efficiency:  number;
      quota_health:     number;
      reliability:      number;
      latency_score:    number;
    };
    excluded?: boolean;
    excluded_reason?: string;
  }>;
  decided_at: string;
};
```

Rules:

- Scheduler must always emit a decision, even on refusal. A refusal still writes `task.dispatched` with `picked_agent_id: null` and a `refusal_reason`.
- `breakdown.*` values are normalized to `0..1`; `score` is the weighted sum (weights live in v1-development-spec).
- `excluded` candidates are still listed for auditability.

## ReviewVerdict

Written by the Reviewer Agent into `.agent-workflow/review_verdict.json` and ingested as an artifact:

```ts
export type ReviewVerdict = {
  schema_version: "agent-workflow/1";
  verdict: "approved" | "changes_requested" | "rejected";
  summary: string;                        // one paragraph max
  comments: Array<{
    path?: string;
    line?: number;
    severity: "must_fix" | "should_fix" | "nit";
    comment: string;
  }>;
};
```

Parser rules:

- File missing -> synthesize `{ verdict: "changes_requested", summary: "Reviewer did not produce a verdict file.", comments: [], reason_tag: "reviewer_unusable" }` for downstream logic but persist the original failure.
- File exists but JSON invalid -> same fallback as above, with `reason_tag: "reviewer_unusable"` and the raw file content saved as a `final_report` artifact for human inspection.
- `verdict: "rejected"` is a strong signal; orchestrator must not auto-requeue, must transition the task to `awaiting_human`.
- A verdict's `comments[]` may be empty even for `changes_requested`; the `summary` is the canonical text fed to the next implementer.

## HandoffPacket

Built by HandoffManager when a task is requeued. Persisted as an artifact (`kind: "handoff_packet"`) and referenced by the next implementer's prompt.

```ts
export type HandoffPacket = {
  schema_version: "agent-workflow/1";
  task_id: string;
  from_run_id: string;
  from_agent_id: string;
  reason:
    | "verification_failed"
    | "review_changes_requested"
    | "review_rejected"          // requeue NOT used in this case; recorded for symmetry
    | "agent_timed_out"
    | "agent_nonzero_exit"
    | "quota_exhausted"
    | "scheduler_refusal";
  summary: string;                          // 5-10 lines, written by HandoffManager
  diff_artifact_uri?: string;               // last implementer's diff, if any
  verification_output_uri?: string;         // if verification ran
  review_verdict_uri?: string;              // if reviewer ran
  remaining_work: string;                   // a hint of what is still left; in v1 this is a templated text
  exclude_agent_ids: string[];              // agents the next attempt must avoid
  created_at: string;
};
```

Composition rule: the next implementer's brief is `prompt.md` + the embedded HandoffPacket summary, plus references to its three artifact URIs. The brief explicitly tells the agent: *"You are taking over from a previous attempt. Read the diff and review verdict before proposing changes."*

## BudgetState

Per-task in-memory ledger; persisted snapshot in the `task_budget` table.

```ts
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
```

Update rules:

- `runs_used` increments at run creation, **not** at run completion. A spawned-but-failed-to-launch run still counts.
- `wall_time_ms_used` is incremented by the actual `agent_runs.ended_at - agent_runs.started_at` after completion.
- `cost_units_used` is incremented by `agent_metrics.avg_actual_cost_units` if known, else `cost_profile.estimated_cost_per_run_units`.
- `status: "soft_warning"` when any axis crosses 80% of cap; emit `quota.low`.
- `status: "exhausted"` when any axis is at or beyond 100% of cap; emit `quota.exhausted` and Scheduler refuses further dispatches.

## TaskQueueEntry

Row shape in the `task_queue` SQLite table; not a contract for external systems but worth pinning:

```ts
export type TaskQueueEntry = {
  task_id: string;
  project_id: string;
  status: "queued" | "dispatched" | "implementing" | "verifying" | "reviewing" | "accepted" | "failed" | "awaiting_human";
  next_role: "implementer" | "reviewer";       // what the next pick should be
  current_owner_run_id: string | null;
  lease_expires_at: string | null;
  attempts: number;
  enqueued_at: string;
  updated_at: string;
};
```

Lease rules:

- Default lease duration: `max_wall_time_minutes * 60 + 60` seconds (one minute slack), capped at 60 minutes.
- A Worker that crashes leaves the lease; expired leases are reclaimable by any Worker via conditional update `WHERE lease_expires_at < now()`.
- A Worker that finishes normally clears `current_owner_run_id` and `lease_expires_at` to `NULL` in the same transaction that writes the next status.

## RunManifest (unchanged shape, new role field)

```ts
export type RunManifestV1 = {
  schema_version: "agent-workflow/1";
  run_id: string;
  task_id: string;
  project_id: string;
  agent_id: string;
  integration_mode: "official_cli";
  role: "implementer" | "reviewer";        // NEW in v1
  workspace_uri: string;
  base_commit: string;
  branch: string;
  work_order_hash: string;
  adapter_version: string;
  binary_version?: string;
  parent_run_id?: string;                   // NEW: reviewer's parent is the implementer; fallback implementer's parent is the previous failed run
  handoff_packet_uri?: string;              // NEW: present when this run inherited from a prior attempt
  started_at: string;
  ended_at?: string | null;
  status: "preparing" | "running" | "succeeded" | "failed" | "cancelled";
};
```

`role` and `parent_run_id` are required when persisting v1 runs; existing v0 runs in the database remain untouched.

## ArtifactRef (extended kinds)

```ts
export type ArtifactKindV1 =
  | "diff"
  | "stdout_tail"
  | "stderr_tail"
  | "verification_output"
  | "task_capsule"
  | "final_report"
  | "review_verdict"        // NEW
  | "handoff_packet"        // NEW
  | "schedule_decision";    // NEW (one per task.dispatched, optional but useful for audit)
```

URI shape stays `artifact://<task_id>/<run_id>/<filename>` for run-scoped artifacts. Schedule decisions are task-scoped and use `artifact://<task_id>/decisions/<decision_id>.json`.

## EventEnvelope (unchanged)

`EventEnvelope` shape is unchanged from v0. New event types are listed in `v1-event-registry.md`.

## Design Rules (cumulative with v0)

- Every persisted object includes a `schema_version`.
- Every Agent execution attempt has a `run_id`.
- Every Run has a `role`. Implementer runs and Reviewer runs are first-class peers, not nested concepts.
- Every Scheduler decision (including refusals) is persisted as a `task.dispatched` event with a full score breakdown.
- Every requeue is preceded by a HandoffPacket artifact.
- A task's `exclude_agent_ids` is monotonic — once an agent is excluded for a task, it is never reconsidered for that task.
- The Reviewer Agent must never be the same as the most recent Implementer Agent.
