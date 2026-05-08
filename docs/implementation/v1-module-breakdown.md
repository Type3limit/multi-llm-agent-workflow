# v1 Module Implementation Details

This document is the v1 counterpart of `module-breakdown.md`. v0 modules continue to exist; v1 introduces new modules and lightly extends two existing ones (Orchestrator splits into Scheduler + Worker, and the Adapter learns a Reviewer brief variant).

## Module Map (v1)

```text
src/
  cli/
    index.ts
    run-command.ts            # v0 (still works for single WorkOrder, both v0 and v1 schemas)
    batch-command.ts          # NEW: agentflow batch
    yaml-simple.ts            # v0
  core/
    ids.ts                    # v0 (extend with generateDecisionId, generateHandoffId)
    schemas.ts                # extend with v1 schemas, keep v0 schemas
    schemas-v1.ts             # NEW (or merged into schemas.ts behind discriminated union)
    types.ts                  # extend with v1 types
    events.ts                 # extend with v1 event names
    upgrader.ts               # NEW: v0 WorkOrder -> v1 WorkOrder one-way upgrader
    orchestrator.ts           # v0 (kept for v0 path)
    orchestrator-v1.ts        # NEW: v1 per-attempt executor
  scheduling/
    agent-registry.ts         # NEW
    scheduler.ts              # NEW
    budget-manager.ts         # NEW
    handoff-manager.ts        # NEW
  queue/
    task-queue.ts             # NEW
    worker.ts                 # NEW (single Worker)
    worker-pool.ts            # NEW
  storage/
    database.ts               # v0
    migrations.ts             # extend with v1 tables
    event-log.ts              # v0 (extend known event types)
    run-store.ts              # v0 (extend with role + parent_run_id)
    artifact-store.ts         # v0 (extend with new ArtifactKind)
    queue-store.ts            # NEW
    metrics-store.ts          # NEW (agent_metrics)
    budget-store.ts           # NEW (task_budget)
  workspace/
    git-worktree-manager.ts   # v0 (extend with applyDiff)
    task-capsule-writer.ts    # v0 (extend brief templates)
    review-brief-writer.ts    # NEW
  adapters/
    official-cli-adapter.ts   # v0 adapter, accepts parsed v0/v1 official_cli profiles
    review-verdict-parser.ts  # NEW
  verification/
    verification-runner.ts    # v0
tests/
  unit/
    ...                       # one test file per new module
  integration/
    batch-run.test.ts
    scheduler-pick.test.ts
    reviewer-flow.test.ts
    handoff-requeue.test.ts
    budget-exhaustion.test.ts
    parallel-workers.test.ts
```

## 1. CLI Entries

### `agentflow run` (v0/v1 shared)

Behavior change in v1:

- After loading WorkOrder, dispatch on `schema_version`:
  - `workflow/v0` -> v0 `runWorkOrder` (unchanged code path).
  - `workflow/v1` -> v1 `runWorkOrderV1` which is itself a thin wrapper that enqueues one task into a single-worker pool and waits for terminal status.
- `--agent <file>` becomes an alias for `--agents <single-file>` for v0 compatibility. v1 requires `--agents <dir-or-file-list>`.

### `agentflow batch` (NEW)

```text
agentflow batch <work_orders_dir> --agents <agents_dir> [--workers N] [--database <path>]
```

Responsibilities:

- Read every `*.json` / `*.yaml` under `<work_orders_dir>`.
- Validate them all up-front; refuse to start if any one is invalid (exit code 2).
- Load AgentRegistry from `<agents_dir>`.
- Open SQLite, run migrations.
- Enqueue all tasks.
- Start a WorkerPool with `--workers` (default 2, max 16).
- Wait until every task reaches terminal status (`accepted`, `failed`, `awaiting_human`).
- Print one summary line per task.
- Exit code 0 if all tasks `accepted`, 1 if any task is `failed`, 3 if any task is `awaiting_human` (distinct so a CI script can branch).

## 2. Core Domain Updates

### types.ts / schemas.ts

Add v1 types from `v1-machine-readable-contracts.md`. WorkOrder and AgentProfile become discriminated unions on `schema_version`.

```ts
export type WorkOrder = WorkOrderV0 | WorkOrderV1;
export type AgentProfile = AgentProfileV0 | AgentProfileV1;
```

### upgrader.ts

```ts
export function upgradeWorkOrderV0ToV1(v0: WorkOrderV0): WorkOrderV1;
```

Rules:

- Copy all common fields verbatim.
- Synthesize `agent.required_capabilities` from `type` (e.g. `code_change` -> `["code_change"]`).
- Set `agent.implementer_pool: [v0.agent.agent_id]`, `reviewer_pool: []`, `exclude_agent_ids: []`.
- Set `review.enabled: false` so a v0 WorkOrder under the v1 orchestrator never silently grows a reviewer.
- Set `budget.max_runs: 1` to preserve v0's "one run per task" expectation.

The upgrader is invoked only when the user explicitly opts in (a future `--upgrade` flag); by default v0 WorkOrders run on the v0 code path. This avoids accidental behaviour drift.

## 3. AgentRegistry (`scheduling/agent-registry.ts`)

Required exported API:

```ts
export interface AgentRegistry {
  load(args: { sources: string[] }): void;        // file or dir paths
  list(): AgentRegistryEntry[];
  get(agentId: string): AgentRegistryEntry | undefined;
  candidatesFor(args: {
    requiredCapabilities: string[];
    role: "implementer" | "reviewer";
    excludeAgentIds: string[];
  }): AgentRegistryEntry[];
  recordOutcome(args: {
    agentId: string;
    success: boolean;
    wallTimeMs: number;
    actualCostUnits?: number;
  }): void;
  refreshQuotaHealth(): void;                     // recompute based on metrics
}
```

Acceptance requirements:

- Loads `*.yaml` and `*.json` from each source path; rejects duplicates with the same `agent_id`.
- Validates each profile against `AgentProfileV1Schema`. Refuses to start if any profile is invalid.
- `candidatesFor()` filters by:
  - capability set: `requiredCapabilities` must be a subset of `profile.capabilities.kinds`.
  - role: `role` must be in `profile.capabilities.roles`.
  - exclusion: `agent_id` not in `excludeAgentIds`.
  - quota health: not `exhausted`.
- `recordOutcome()` writes one row to `agent_metrics` and updates the in-memory rolling stats. Rolling window: last 50 runs (in-memory ring buffer; persisted as aggregated counts).
- `refreshQuotaHealth()` reads `agent_usage` rows for runs newer than `quota.reset_at` and computes ratios. v1 has no live API quota probe; this is bookkeeping only.

## 4. Scheduler (`scheduling/scheduler.ts`)

Required exported API:

```ts
export interface Scheduler {
  decide(args: {
    workOrder: WorkOrderV1;
    role: "implementer" | "reviewer";
    excludeAgentIds: string[];
    registry: AgentRegistry;
    budget: BudgetState;
  }): ScheduleDecision;
}
```

Score formula (v1, normalized weights sum to 1.0):

```text
score =
  capability_match * 0.40
+ cost_efficiency  * 0.20
+ quota_health     * 0.20
+ reliability      * 0.10
+ latency_score    * 0.10
```

Component definitions:

- `capability_match`: `1.0` if `required_capabilities` is a subset, `0.0` otherwise. (v1 does not do partial matching; it is a hard filter, but kept in the score for traceability.)
- `cost_efficiency`: `clamp(1 - (estimated_cost_per_run_units / max_estimated_in_pool), 0, 1)`. If only one candidate, this is `1.0`.
- `quota_health`: `1.0` if `healthy`, `0.5` if `low`, `0.0` if `exhausted`. `exhausted` candidates are pre-filtered, so this practically maps `healthy/low`.
- `reliability`: `rolling_metrics.success_rate` if `runs_observed >= 5`, else `profile.reliability.initial_success_rate`.
- `latency_score`: `clamp(1 - rolling_metrics.avg_latency_ms / 600000, 0, 1)` (10 minutes is the floor that scores 0). If pool average latency is unknown, all candidates score `0.5`.

Refusal conditions (in order):

1. `budget.status === "exhausted"` -> `refusal_reason: "task_budget_exhausted"`.
2. `candidatesFor()` returns empty due to no capability match -> `no_agent_matches_capability`.
3. `candidatesFor()` returns empty due to all excluded -> `all_candidates_excluded`.
4. All remaining candidates have `quota_health: "exhausted"` -> `all_candidates_quota_exhausted`.

For reviewer role, a hard rule applies on top:

- `excludeAgentIds` for the reviewer pick must include the most recent implementer's `agent_id`. Scheduler enforces this even if the orchestrator forgets to pass it. (Defense in depth; a unit test pins this.)

## 5. BudgetManager (`scheduling/budget-manager.ts`)

Required exported API:

```ts
export interface BudgetManager {
  init(workOrder: WorkOrderV1): BudgetState;
  observe(args: {
    taskId: string;
    runDurationMs: number;
    actualCostUnits?: number;
    estimatedCostUnits: number;
  }): BudgetState;
  incrementRunCount(taskId: string): BudgetState;
  current(taskId: string): BudgetState;
}
```

Acceptance requirements:

- `init()` writes one row to `task_budget` with caps from `workOrder.budget` (defaults: `max_runs=4`, `max_wall_time_ms=30 * 60_000`, `max_total_cost_units=10`).
- `incrementRunCount()` is called by the Worker before launching any agent; this is the **pre-launch** budget gate.
- `observe()` is called after a run terminates (success or failure).
- Status transitions are atomic in SQLite: read-modify-write inside a single transaction.
- On `soft_warning` first crossing, emit `quota.low` with the per-task scope (the same event name covers per-agent and per-task; payload disambiguates).
- On `exhausted` first crossing, emit `quota.exhausted` and mark `task_budget.status`.

## 6. HandoffManager (`scheduling/handoff-manager.ts`)

Required exported API:

```ts
export interface HandoffManager {
  build(args: {
    fromRunId: string;
    fromAgentId: string;
    reason: HandoffPacket["reason"];
    diffArtifactUri?: string;
    verificationOutputUri?: string;
    reviewVerdictUri?: string;
  }): HandoffPacket;

  persist(packet: HandoffPacket, taskId: string): ArtifactRef;
  attachToBrief(args: {
    workspacePath: string;
    packet: HandoffPacket;
  }): void;
}
```

Acceptance requirements:

- `summary` is generated by a small templated formatter; v1 does not call an LLM to summarize the handoff. Template includes: which agent failed, why, what artifacts to read first, and whether the reviewer was involved.
- `remaining_work` is the literal text from `WorkOrder.goal` plus a one-line "previous attempt status" footer; v1 does not attempt smarter remaining-work synthesis.
- `persist()` saves the packet as `artifact://<task_id>/<from_run_id>/handoff_packet.json` (kind `handoff_packet`).
- `attachToBrief()` writes a `.agent-workflow/handoff_packet.json` and prepends a "You are taking over a previous attempt" paragraph to `prompt.md` referencing the diff and verdict by URI.

## 7. TaskQueue (`queue/task-queue.ts`) and Worker (`queue/worker.ts`, `queue/worker-pool.ts`)

### TaskQueue

Required exported API:

```ts
export interface TaskQueue {
  enqueue(args: {
    workOrder: WorkOrderV1;
    nextRole: "implementer" | "reviewer";
  }): void;
  claim(workerId: string, leaseDurationSec: number): TaskQueueEntry | null;
  release(taskId: string, patch: Partial<TaskQueueEntry>): void;
  setStatus(taskId: string, status: TaskQueueEntry["status"]): void;
  get(taskId: string): TaskQueueEntry | undefined;
  listTerminal(): TaskQueueEntry[];
}
```

Acceptance requirements:

- `claim()` is a single SQL transaction:
  - `SELECT ... WHERE status='queued' AND (current_owner_run_id IS NULL OR lease_expires_at < now()) ORDER BY enqueued_at ASC LIMIT 1`
  - `UPDATE ... SET current_owner_run_id=:tempRunId, lease_expires_at=:future, status='dispatched' WHERE task_id=:id AND ...` with the same conditional clause to avoid races.
- `claim()` returns `null` when nothing is claimable (caller backs off with `setTimeout` 200 ms).
- `release()` clears `current_owner_run_id` and `lease_expires_at` and writes the next status atomically.
- `setStatus("accepted" | "failed" | "awaiting_human")` is terminal; further claims for that task always return `null`.

### Worker

Each Worker runs a loop:

```text
while (!stopRequested):
  entry = queue.claim(workerId, lease)
  if entry is null:
    sleep(200 ms)
    continue

  budget = budgetManager.current(entry.task_id)
  if budget.status == "exhausted":
    queue.setStatus(entry.task_id, "failed")
    emit task.failed
    queue.release(entry.task_id, ...)
    continue

  decision = scheduler.decide({...})
  emit task.dispatched(decision)
  if decision.picked_agent_id is null:
    handle refusal:
      either task.failed (no_agent_matches_capability, task_budget_exhausted, all_candidates_quota_exhausted)
      or task.awaiting_human (all_candidates_excluded with no fallback path)
    continue

  budgetManager.incrementRunCount(entry.task_id)
  runResult = runOneAttempt(entry, decision)   // implementer or reviewer
  budgetManager.observe(...)
  applyOutcome(runResult)                       // updates queue status, requeues if needed
```

`runOneAttempt` is the per-attempt function: it owns worktree creation, capsule writing, agent launch, verification (for implementer role), or verdict parsing (for reviewer role). It reuses the v0 GitWorktreeManager, TaskCapsuleWriter, OfficialCliAdapter, and VerificationRunner.

### WorkerPool

```ts
export interface WorkerPool {
  start(workers: number): void;
  waitForAllTerminal(): Promise<void>;
  stop(graceMs?: number): Promise<void>;
}
```

Acceptance requirements:

- `start()` spawns N workers; workers share the same SQLite database connection or hold their own (decided in v1-development-spec).
- `waitForAllTerminal()` resolves when every enqueued task is in a terminal state.
- `stop()` lets in-flight runs finish up to `graceMs`, then aborts (releasing leases for reclamation on a future invocation).

## 8. Reviewer Flow Modules

### review-brief-writer.ts (`workspace/`)

Writes a Reviewer-specific `.agent-workflow/` capsule:

```text
.agent-workflow/
  work_order.md
  review_brief.md         # NEW: tells the reviewer what to do
  reviewer_prompt.md      # NEW: literal prompt for the agent
  diff_under_review.patch # NEW: the implementer's diff
  prior_final_report.md   # NEW: the implementer's final_report.md if present
  review_verdict.json     # MUST be written by the agent
```

`review_brief.md` includes:

- A copy of the WorkOrder goal and acceptance_criteria.
- The diff content (also written as `diff_under_review.patch`).
- The implementer's final report if available.
- Explicit instructions: write a JSON file `review_verdict.json` matching the schema; do not modify any other files; do not run tests (v1 reviewer does not have a verification step).

`reviewer_prompt.md` is the literal text passed to the agent's `{{prompt_file}}` substitution.

### review-verdict-parser.ts (`adapters/`)

```ts
export function parseReviewVerdict(args: {
  workspacePath: string;
}): { verdict: ReviewVerdict; reasonTag?: "reviewer_unusable" };
```

Acceptance requirements:

- File missing -> synthesized `changes_requested` verdict with `reasonTag: "reviewer_unusable"`.
- File present but JSON invalid or schema invalid -> same fallback, the raw text is saved as a `final_report` artifact for human inspection.
- File present and valid -> parsed verdict is returned as-is.

### Reviewer worktree

Reviewer runs in a fresh worktree. The Worker:

1. Creates `agent/<task_id>/<reviewer_run_id>` from `base_ref`.
2. Applies the implementer's diff via `git apply --3way <diff_path>`.
3. Writes the reviewer brief.
4. Launches the reviewer Adapter.
5. Parses verdict.

#### diff_apply_failed (hard rule)

If step 2 fails, the reviewer run is **never** launched. Instead:

- Capture `git apply` stdout and stderr.
- Save both as artifacts under the reviewer's `run_id`: `kind: "stdout_tail"` and `kind: "stderr_tail"` (filename `git_apply_stdout.txt` / `git_apply_stderr.txt`).
- Save the failing diff under the reviewer's `run_id` as `kind: "diff"` (a copy, so the failure is self-contained for inspection).
- Record the run as `run.failed` with `payload.reason: "diff_apply_failed"`.
- Build a HandoffPacket with `reason: "review_changes_requested"` (the failure is treated as a `changes_requested` outcome on the implementer, not on the reviewer — the **diff itself** is broken). Add the failed implementer's `agent_id` to `exclude_agent_ids`. Do **not** add the reviewer's `agent_id`; the reviewer never ran.
- Emit `task.edge_selected` with `from: "reviewing"`, `to: "requeued"`, `reason: "diff_apply_failed"` so audit can distinguish this from a normal `changes_requested`.

The reviewer's `agent_id` is **not** counted against `agent_metrics` for this run, because the agent never executed. `task_budget.runs_used` **is** incremented (the run row exists), so a repeating apply failure cannot exhaust budget invisibly.

Reviewer worktrees are removed after the verdict is persisted; the implementer's worktree is **not** removed until the task reaches a terminal status, because subsequent fallback implementer runs may want to reference its diff.

## 9. Storage Updates

### New tables (`storage/migrations.ts`)

```sql
create table if not exists task_queue (
  task_id text primary key,
  project_id text not null,
  status text not null,
  next_role text not null,
  current_owner_run_id text,
  lease_expires_at text,
  attempts integer not null default 0,
  enqueued_at text not null,
  updated_at text not null,
  workorder_json text not null
);

create index if not exists task_queue_status_lease_idx
  on task_queue(status, lease_expires_at);

create table if not exists agent_metrics (
  id integer primary key autoincrement,
  agent_id text not null,
  run_id text not null,
  success integer not null,
  wall_time_ms integer not null,
  actual_cost_units real,
  created_at text not null
);

create index if not exists agent_metrics_agent_id_idx
  on agent_metrics(agent_id, created_at);

create table if not exists task_budget (
  task_id text primary key,
  runs_used integer not null default 0,
  wall_time_ms_used integer not null default 0,
  cost_units_used real not null default 0,
  max_runs integer not null,
  max_wall_time_ms integer not null,
  max_total_cost_units real not null,
  status text not null default 'ok'
);
```

### `agent_runs` extension

Add columns:

```sql
alter table agent_runs add column role text;
alter table agent_runs add column parent_run_id text;
alter table agent_runs add column handoff_packet_uri text;
```

Old v0 rows have `NULL` in these columns. The v1 RunStore writes `role` for every run it creates; it never updates v0 rows.

### `artifacts` extension

No schema change needed; `kind` column already accepts arbitrary strings. v1 documents the new kinds (`review_verdict`, `handoff_packet`, `schedule_decision`).

## 10. Orchestrator-v1 (`core/orchestrator-v1.ts`)

This module is the v1 per-attempt executor. It is **not** a Scheduler and does not own the full task lifecycle. Worker/WorkerPool will translate its `RunOutcome` into queue status, handoff, requeue, budget, and metrics updates.

Required exported API:

```ts
export async function runTaskOnce(args: {
  entry: TaskQueueEntry;
  decision: ScheduleDecision;
  agentProfile: AgentProfileV1;
  workOrder: WorkOrderV1;
  services: V1Services;
  db: Database;
  parentRunId?: string;
  handoffPacketUri?: string;
  reviewContext?: {
    diffText: string;
    diffArtifactUri: string;
    priorFinalReportText?: string;
    implementerRunId?: string;
    implementerAgentId?: string;
  };
}): Promise<RunOutcome>;
```

`RunOutcome`:

```ts
export type RunOutcome =
  | { kind: "implementer_succeeded"; runId: string; diffArtifactUri: string; verificationOutputUri?: string; finalReportUri?: string }
  | { kind: "implementer_failed"; runId: string; reason: "agent_nonzero_exit" | "agent_timed_out" | "verification_failed" | "spawn_failed" | "internal_error"; diffArtifactUri?: string; verificationOutputUri?: string; finalReportUri?: string }
  | { kind: "reviewer_approved"; runId: string; reviewVerdictUri: string }
  | { kind: "reviewer_changes_requested"; runId: string; reviewVerdictUri: string }
  | { kind: "reviewer_rejected"; runId: string; reviewVerdictUri: string }
  | { kind: "reviewer_unusable"; runId: string; reason: "reviewer_unusable" | "diff_apply_failed" | "agent_nonzero_exit" | "agent_timed_out" | "spawn_failed" | "internal_error"; reviewVerdictUri?: string; stdoutArtifactUri?: string; stderrArtifactUri?: string };
```

The `runTaskOnce` function is essentially the v0 `runWorkOrderWithServices` split in two paths (implementer / reviewer), sharing 90% of the machinery. Worker translates `RunOutcome` into the next queue status / handoff / requeue.

## 11. Orchestrator-v1 Event Sequence

For an implementer run (success):

```text
task.assigned          (Worker, after queue.claim and Scheduler.decide)
run.created
artifact.published     (run_manifest.json; run_manifest_ref set before run.started)
run.started
agent.spawned
artifact.published     (stdout, stderr, diff, final report, capsule)
verification.started
verification.passed
artifact.published     (verification output)
run.completed
task.edge_selected     (verifying -> reviewing OR verifying -> accepted if review.enabled=false)
```

For a reviewer run (approved):

```text
task.assigned
run.created
artifact.published     (run_manifest.json; run_manifest_ref set before run.started)
run.started
review.requested
artifact.published     (review brief + diff under review)
agent.spawned
artifact.published     (stdout + stderr)
artifact.published     (review_verdict)
run.completed
review.completed       (payload includes verdict_uri)
task.edge_selected     (reviewing -> accepted)
task.completed
```

For a reviewer run (changes_requested):

```text
... (same up to review.completed)
task.edge_selected     (reviewing -> requeued)
handoff.requested
task.requeued
```

## 11.1 Run Failure Reason Taxonomy (run.failed payload.reason)

`run.failed` events must carry an explicit `payload.reason` from this closed set. Adapters and the orchestrator must classify failures rather than emit free-form messages.

| `reason` | Source | Effect on AgentRegistry / Metrics |
|---|---|---|
| `spawn_failed` | OS-level spawn error (executable not found, permission denied) | Recorded in `agent_metrics` with `success=false`. No quota signal. |
| `agent_nonzero_exit` | Process exited with non-zero exit code | `success=false`. No quota signal. |
| `agent_timed_out` | Wall-time timeout enforced by adapter | `success=false`. No quota signal. |
| `provider_quota_exhausted` | Adapter detected vendor-side quota / rate-limit error in stderr or exit code | `success=false`. AgentRegistry must mark the agent's `quota_health = "exhausted"` for the rest of the CLI invocation, and emit `quota.exhausted` (scope=`agent`). |
| `provider_rate_limited` | Adapter detected vendor-side throttling that is expected to recover | `success=false`. AgentRegistry must mark `quota_health = "low"` and emit `quota.low` (scope=`agent`). |
| `provider_auth_failed` | Adapter detected auth/credential failure | `success=false`. AgentRegistry must mark `quota_health = "exhausted"` (the agent is unusable until creds are fixed) and emit `quota.exhausted`. |
| `verification_failed` | Verification command(s) returned non-zero | `success=false`. No quota signal. |
| `diff_apply_failed` | Reviewer-side `git apply` failed | `success=false`, but **not** recorded against the reviewer's `agent_metrics` (see §8 hard rule). |
| `lease_expired` | Worker crashed; lease reclaimed by another invocation | `success=false`. No quota signal. |
| `internal_error` | Orchestrator-level uncaught exception | `success=false`. No quota signal. |

Provider-class detection (the three `provider_*` reasons) is best-effort in v1: the OfficialCliAdapter inspects stderr against a small regex set declared per AgentProfile (a v2 feature is to formalize this as adapter plug-ins). When detection misfires, the failure falls back to `agent_nonzero_exit` or `agent_timed_out`. v1 does **not** poll vendor APIs.

The mapping from `reason` to AgentRegistry quota state is implemented in one place (`AgentRegistry.recordOutcome`) and unit-tested with one fixture per row above.

## 12. Cleanup Policy (v1)

v0 left worktree cleanup as a non-goal. v1 makes it explicit:

- A run's worktree is cleaned up **after the task reaches a terminal status** (`accepted`, `failed`, `awaiting_human`), not after each run. This preserves diffs and stdout for fallback implementer briefs.
- `run.cleaned_up` events are emitted in `task_id` order at terminal time, not in run order.
- A failed task in `awaiting_human` keeps all worktrees so a human can inspect the trail. Cleanup happens when the human decides (out of scope in v1; v2 will add `task.human_decided`).

## 13. Concurrency Invariants

These must hold under any worker count `>= 1`:

- For any `task_id`, at most one row in `agent_runs` has `status='running'` at any time.
- For any `task_id`, the `task_queue.current_owner_run_id` either matches the unique running run or is `NULL`.
- `agent_metrics` rows are append-only; concurrent observers may interleave but never overwrite.
- `task_budget` updates use `UPDATE ... WHERE task_id=? AND runs_used=?` (optimistic concurrency) or are wrapped in a transaction; never blind UPDATEs.
- Two Workers picking the same task is impossible — the conditional `UPDATE` in `claim()` enforces this.
- The reviewer worktree's `git apply` is the only place where one run reads another run's diff; this is a one-shot read of an already-persisted artifact, no concurrent writers.
