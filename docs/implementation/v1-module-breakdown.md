# v1 Module Implementation Details

This document is the v1 counterpart of `module-breakdown.md`. v0 modules continue to exist; v1 introduces new modules and lightly extends two existing ones (Orchestrator splits into Scheduler + Worker, and the Adapter learns a Reviewer brief variant).

## Module Map (v1)

```text
src/
  cli/
    index.ts
    run-command.ts            # v0/v1 run plus v1 batch dispatch
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
    task-queue.ts             # v1 queue policy wrapper
    worker.ts                 # v1 single Worker
    worker-pool.ts            # v1 WorkerPool
    worker-task-handler.ts    # v1 outcome translation
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
    git-worktree-manager.ts   # v0 git-specific worktree implementation detail
    sandbox-provider.ts       # v1.x SandboxProvider seam + GitWorktreeSandboxProvider
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
    cli-run.test.ts           # v0/v1 CLI and fake-agent coverage
```

## Post-v1 Architecture Notes

This document is still the historical v1 implementation source of truth. The four-layer decoupling direction remains deferred beyond the v1 CLI kernel, except for the v1.x Phase 1 `SandboxProvider` seam, the v1.x Phase 2 read-only `SessionSnapshot` seam, and the v1.x Phase 3 file-state-only fork-from-snapshot worktree reconstruction helper.

Post-v1 order and constraints:

1. `SandboxProvider` now wraps the current `GitWorktreeManager` behavior through `GitWorktreeSandboxProvider`. The first adapter is behavior-preserving; Docker / micro-VM adapters come later.
2. `SessionSnapshot` is implemented as a read-only aggregation contract over existing task_queue, agent_runs, artifacts, review context, and handoff URI state. It does not introduce a new storage table.
3. Forking from a snapshot is implemented for repository file state only: select a persisted diff artifact, prepare a fresh worktree from the selected run base commit or snapshot base ref, and apply the patch through `SandboxProvider`. Do not rely on terminal worktrees being kept forever.
4. Planner / Coordinator first emits flat fan-out WorkOrders for `agentflow batch`. DAG dependency edges, readiness checks, conditionals, or aggregate graph nodes require a later ADR.

Before starting any remaining post-v1 work, read `v1-status.md` and use a separate prompt. These notes are not permission to add Docker/micro-VM or any second sandbox adapter, expand snapshot fork/rebuild beyond file-state reconstruction, add model conversation resume, Redis/KV or external memory, Planner/Coordinator, DAG, HTTP/API, or SessionStore work inside v1 maintenance.

## 1. CLI Entries

### `agentflow run` (v0/v1 shared)

Behavior change in v1:

- After loading WorkOrder, dispatch on `schema_version`:
  - `workflow/v0` -> v0 `runWorkOrder` (unchanged code path).
  - `workflow/v1` -> v1 `runWorkOrderV1` which is itself a thin wrapper that enqueues one task into a single-worker pool and waits for terminal status.
- `--agent <file>` becomes an alias for `--agents <single-file>` for v0 compatibility. v1 accepts one AgentRegistry source path (file or directory).

### `agentflow batch` (implemented)

```text
agentflow batch <work_orders_dir> --agents <agents_file_or_dir> [--workers N] [--database <path>]
```

Responsibilities:

- Read every `*.json` / `*.yaml` / `*.yml` under `<work_orders_dir>`.
- Validate them all up-front; refuse to start if any one is invalid (exit code 2).
- Load AgentRegistry from `<agents_file_or_dir>`.
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
    runId?: string;
    failureReason?: RunFailedReason;
  }): void;
  refreshQuotaHealth(): void;                     // sync in-process quota health
}
```

Acceptance requirements:

- Loads `*.json`, `*.yaml`, and `*.yml` from each source path; rejects duplicates with the same `agent_id`.
- Validates each profile against `AgentProfileV1Schema`. Refuses to start if any profile is invalid.
- `candidatesFor()` filters by:
  - capability set: `requiredCapabilities` must be a subset of `profile.capabilities.kinds`.
  - role: `role` must be in `profile.capabilities.roles`.
  - exclusion: `agent_id` not in `excludeAgentIds`.
  - quota health: not `exhausted`.
- `recordOutcome()` writes one row to `agent_metrics` and refreshes rolling stats by querying the most recent rows. The default rolling window is 50 runs.
- `refreshQuotaHealth()` synchronizes in-process quota health from provider-failure classification state. v1 does not read `agent_usage` for quota ratios and does not poll vendor APIs.

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
    mostRecentImplementerAgentId?: string;
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
  current(taskId: string): BudgetState;
  preLaunch(taskId: string): BudgetState;
  postRun(args: {
    taskId: string;
    runDurationMs: number;
    actualCostUnits?: number;
    estimatedCostUnits: number;
  }): BudgetState;
}
```

Acceptance requirements:

- `init()` writes one row to `task_budget` with caps from `workOrder.budget` (defaults: `max_runs=4`, `max_wall_time_ms=30 * 60_000`, `max_total_cost_units=10`).
- `preLaunch()` is called by `V1WorkerTaskHandler` before launching any agent; this is the pre-launch budget gate and increments `runs_used`.
- `postRun()` is called after a run terminates (success or failure) and records wall time plus estimated/actual cost.
- Same-task budget updates are serialized by the task queue owner in v1; independent optimistic concurrency on `task_budget` is not currently claimed.
- On `soft_warning` first crossing, emit `quota.low` with the per-task scope (the same event name covers per-agent and per-task; payload disambiguates).
- On `exhausted` first crossing, emit `quota.exhausted` and mark `task_budget.status`.

## 6. HandoffManager (`scheduling/handoff-manager.ts`)

Required exported API:

```ts
export interface HandoffManager {
  build(args: {
    taskId: string;
    fromRunId: string;
    fromAgentId: string;
    workOrderGoal: string;
    reason: HandoffPacket["reason"];
    diffArtifactUri?: string;
    verificationOutputUri?: string;
    reviewVerdictUri?: string;
    priorExcludes?: string[];
  }): HandoffPacket;

  persist(packet: HandoffPacket): ArtifactRef;
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
    nextRole?: "implementer" | "reviewer";
  }): TaskQueueEntry;
  claim(workerId: string, leaseDurationSec?: number): TaskQueueEntry | null;
  release(taskId: string, patch: Partial<TaskQueueEntry>): void;
  setStatus(taskId: string, status: TaskQueueEntry["status"]): void;
  get(taskId: string): TaskQueueEntry | undefined;
  getWorkOrder(taskId: string): WorkOrderV1 | undefined;
  addWorkOrderExcludeAgentIds(taskId: string, agentIds: string[]): WorkOrderV1;
  setReviewContext(taskId: string, context: ReviewContextRecord): void;
  getReviewContext(taskId: string): ReviewContextRecord | undefined;
  setHandoffPacketUri(taskId: string, uri: string | undefined): void;
  getHandoffPacketUri(taskId: string): string | undefined;
  listTerminal(): TaskQueueEntry[];
}
```

Acceptance requirements:

- `claim()` is a single SQL transaction:
  - `SELECT ... WHERE status='queued' AND (current_owner_run_id IS NULL OR lease_expires_at < now()) ORDER BY enqueued_at ASC LIMIT 1`
  - `UPDATE ... SET current_owner_run_id=:workerId, lease_expires_at=:future, status='dispatched' WHERE task_id=:id AND ...` with the same conditional clause to avoid races.
- Despite the legacy column name, `current_owner_run_id` stores the claiming worker id as the queue lease owner token; it does not store an `agent_runs.run_id`.
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
  decision = scheduler.decide({...})
  emit task.dispatched(decision)
  if decision.picked_agent_id is null:
    handle refusal:
      either task.failed (no_agent_matches_capability, task_budget_exhausted, all_candidates_quota_exhausted)
      or task.awaiting_human (all_candidates_excluded with no fallback path)
    continue

  budgetManager.preLaunch(entry.task_id)
  runResult = runOneAttempt(entry, decision)   // implementer or reviewer
  budgetManager.postRun(...)
  applyOutcome(runResult)                       // updates queue status, requeues if needed
```

`runOneAttempt` is the per-attempt function: it owns workspace preparation through `SandboxProvider`, capsule writing, agent launch, verification (for implementer role), or verdict parsing (for reviewer role). It reuses `GitWorktreeSandboxProvider`, TaskCapsuleWriter, OfficialCliAdapter, and VerificationRunner.

Do not introduce a second sandbox adapter inside v1 maintenance work. The v1 Worker remains wired to `GitWorktreeSandboxProvider`; any future adapter must preserve the current worktree creation, diff application, artifact, and cleanup behavior before changing semantics.

### WorkerPool

```ts
export interface WorkerPool {
  start(workers: number): void;
  waitForAllTerminal(): Promise<void>;
  stop(graceMs?: number): Promise<void>;
}
```

Acceptance requirements:

- `start()` spawns N workers; each Worker owns its own SQLite database connection, as required by `v1-development-spec`.
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

`V1WorkerTaskHandler` does not treat `reasonTag: "reviewer_unusable"` as a normal `changes_requested` requeue. The current worker outcome is task failure for unusable reviewer output, while explicit `changes_requested` verdicts and `diff_apply_failed` requeue paths remain separate.

### Reviewer worktree

Reviewer runs in a fresh worktree. The Worker:

1. Creates `agent/<task_id>/<reviewer_run_id>` from `base_ref`.
2. Applies the implementer's diff text via `git apply --3way --whitespace=nowarn -` through `SandboxProvider`.
3. Writes the reviewer brief.
4. Launches the reviewer Adapter.
5. Parses verdict.

#### diff_apply_failed (hard rule)

If step 2 fails, the reviewer run is **never** launched. Instead:

- Capture `git apply` stdout and stderr.
- Save both as artifacts under the reviewer's `run_id`: `kind: "stdout_tail"` and `kind: "stderr_tail"` (filename `git_apply_stdout.txt` / `git_apply_stderr.txt`).
- Save the failing diff under the reviewer's `run_id` as `kind: "diff"` (a copy, so the failure is self-contained for inspection).
- Record the run as `run.failed` with `payload.reason: "diff_apply_failed"`.
- Build a HandoffPacket with `reason: "diff_apply_failed"` (the failure is treated as a `changes_requested` outcome on the implementer, not on the reviewer — the **diff itself** is broken). Add the failed implementer's `agent_id` to `exclude_agent_ids`. Do **not** add the reviewer's `agent_id`; the reviewer never ran.
- Emit `task.edge_selected` with `from: "reviewing"`, `to: "requeued"`, `reason: "diff_apply_failed"` so audit can distinguish this from a normal `changes_requested`.

The reviewer's `agent_id` is **not** counted against `agent_metrics` for this run, because the agent never executed. `task_budget.runs_used` **is** incremented (the run row exists), so a repeating apply failure cannot exhaust budget invisibly.

Reviewer and implementer worktrees are retained while the task can still requeue, because subsequent fallback implementer runs may need prior diffs and reports. Cleanup runs only after the task reaches `accepted` or `failed`; `awaiting_human` intentionally keeps worktrees for manual inspection.

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
  workorder_json text not null,
  review_context_json text,
  handoff_packet_uri text
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

This module is the v1 per-attempt executor. It is **not** a Scheduler and does not own the full task lifecycle. `V1WorkerTaskHandler` translates its `RunOutcome` into queue status, handoff, requeue, budget, and metrics updates.

Required exported API:

```ts
export async function runTaskOnce(args: {
  entry: TaskQueueEntry;
  decision: ScheduleDecision;
  agentProfile: AgentProfileV1;
  workOrder: WorkOrderV1;
  services: V1RunTaskServices;
  db: Database;
  parentRunId?: string;
  handoffPacketUri?: string;
  handoffPacket?: HandoffPacket;
  signal?: AbortSignal;
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
  | { kind: "implementer_failed"; runId: string; reason: "agent_nonzero_exit" | "agent_timed_out" | "provider_quota_exhausted" | "provider_rate_limited" | "provider_auth_failed" | "verification_failed" | "spawn_failed" | "internal_error"; diffArtifactUri?: string; verificationOutputUri?: string; finalReportUri?: string }
  | { kind: "reviewer_approved"; runId: string; reviewVerdictUri: string }
  | { kind: "reviewer_changes_requested"; runId: string; reviewVerdictUri: string }
  | { kind: "reviewer_rejected"; runId: string; reviewVerdictUri: string }
  | { kind: "reviewer_unusable"; runId: string; reason: "reviewer_unusable" | "diff_apply_failed" | "agent_nonzero_exit" | "agent_timed_out" | "provider_quota_exhausted" | "provider_rate_limited" | "provider_auth_failed" | "spawn_failed" | "internal_error"; reviewVerdictUri?: string; stdoutArtifactUri?: string; stderrArtifactUri?: string };
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
verification.started   (if verification commands are configured)
verification.passed    (if verification commands are configured)
artifact.published     (verification output, if commands are configured)
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

The provider-specific mapping from `reason` to AgentRegistry quota state is implemented in one place (`AgentRegistry.recordOutcome`) and unit-tested for the provider failure reasons plus ordinary failures. `lease_expired` event emission is not currently claimed.

## 12. Cleanup Policy (v1)

v0 left worktree cleanup as a non-goal. v1 makes it explicit:

- A run's worktree is cleaned up **after the task reaches `accepted` or `failed`**, not after each run. This preserves diffs and stdout for fallback implementer briefs while a task can still requeue.
- `run.cleaned_up` events are emitted in `task_id` order at terminal time, not in run order.
- A task in `awaiting_human` keeps all worktrees so a human can inspect the trail. Cleanup happens when the human decides (out of scope in v1; v2 will add `task.human_decided`).

## 13. Concurrency Invariants

These must hold under any worker count `>= 1`:

- For any `task_id`, at most one row in `agent_runs` has `status='running'` at any time.
- For any `task_id`, the `task_queue.current_owner_run_id` is either the worker id currently holding the queue lease or `NULL`; it is not required to match an `agent_runs.run_id`.
- `agent_metrics` rows are append-only; concurrent observers may interleave but never overwrite.
- Same-task `task_budget` updates are serialized by task queue ownership. Independent optimistic concurrency on `task_budget` is not currently claimed.
- Two Workers picking the same task is impossible — the conditional `UPDATE` in `claim()` enforces this.
- The reviewer worktree's `git apply` is the only place where one run reads another run's diff; this is a one-shot read of an already-persisted artifact, no concurrent writers.
