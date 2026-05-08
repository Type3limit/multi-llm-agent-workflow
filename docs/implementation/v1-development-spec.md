# v1 Development Spec

This document is the implementation handoff for inexpensive coding agents working on v1. It is stricter than the v1 architecture and slice notes and should be treated as the source of truth for v1 code review.

## Goal

Build a local CLI that can run multiple supervised official CLI agents per task in isolated git worktrees, with a Scheduler that picks agents dynamically, a Reviewer Agent that gates acceptance, and a TaskQueue that runs independent WorkOrders in parallel.

The required commands are:

```text
agentflow run   path/to/work_order.json --agents path/to/agents/[file_or_dir]
agentflow batch path/to/work_orders/    --agents path/to/agents/  [--workers N]
```

## Non-Goals

Do not implement these in v1 (deferred to v2+):

- Context Broker.
- Acceptance Verifier.
- Adversarial Reviewer.
- Eval Suite.
- Agent Anomaly Detector.
- Artifact Instruction Scanner.
- Secret Leak Scanner.
- Dashboard / HTTP API.
- Long-running interactive sessions.
- MCP / official_extension / managed_proxy modes.
- Multi-WorkOrder DAG with dependency edges across tasks.
- Multi-project sharding.
- Distributed scheduler (multiple orchestrator processes).
- Bidding mode (Agent self-reported cost estimates).
- Replay / event sourcing reconstruction.
- Automatic prompt rollback or capability downgrade detection.
- User-initiated run cancellation.
- Resource-aware scheduling (CPU/memory/disk fit).
- Locality / privacy scoring.

## Recommended File Layout

See `v1-module-breakdown.md`. Module boundaries listed there are normative. Filenames may vary. Do not collapse modules into one large file.

## Implementation Order

1. Add v1 schemas alongside v0 (`schemas-v1.ts` or merged discriminated union). Add `WorkOrderV1`, `AgentProfileV1`, `RunManifestV1`, `ScheduleDecision`, `ReviewVerdict`, `HandoffPacket`, `BudgetState`, `TaskQueueEntry`. Reject reserved event names.
2. Migrations: add `task_queue`, `agent_metrics`, `task_budget`. Extend `agent_runs` with `role`, `parent_run_id`, `handoff_packet_uri`.
3. `AgentRegistry`.
4. `Scheduler` + `ScheduleDecision` persistence.
5. `BudgetManager`.
6. `TaskQueue` + leasing.
7. `HandoffManager`.
8. `ReviewBriefWriter` + `ReviewVerdictParser`.
9. `Worker` + `WorkerPool`.
10. `Orchestrator-v1` (per-attempt run executor).
11. `agentflow batch` CLI; extend `agentflow run` to handle v1 schemas.
12. End-to-end integration tests with two fake agents (implementer + reviewer).

Do not start with real Claude/Codex/Gemini Reviewer behavior. First prove the full path with two fake node executables: one writes a diff and exits 0, the other writes `review_verdict.json` and exits 0.

## Core Contracts

Implement contracts from `docs/contracts/v1-machine-readable-contracts.md` as Zod schemas plus inferred TypeScript types.

Required exported APIs:

```ts
export const WorkOrderV1Schema:    z.ZodType<WorkOrderV1>;
export const AgentProfileV1Schema: z.ZodType<AgentProfileV1>;
export const RunManifestV1Schema:  z.ZodType<RunManifestV1>;
export const ScheduleDecisionSchema: z.ZodType<ScheduleDecision>;
export const ReviewVerdictSchema:    z.ZodType<ReviewVerdict>;
export const HandoffPacketSchema:    z.ZodType<HandoffPacket>;

export function parseWorkOrderV1(input: unknown): WorkOrderV1;
export function parseAgentProfileV1(input: unknown): AgentProfileV1;
export function parseReviewVerdictFile(text: string): ReviewVerdict;
```

Discriminated union parser:

```ts
export function parseWorkOrder(input: unknown): WorkOrderV0 | WorkOrderV1;   // dispatches on schema_version
export function parseAgentProfile(input: unknown): AgentProfileV0 | AgentProfileV1;
```

Rules:

- Reject unsupported `schema_version` (only `workflow/v0` and `workflow/v1` are valid in v1).
- Reject AgentProfile unless `outer_supervised: true` and `inner_tool_control: false`.
- Reject WorkOrderV1 if `agent.required_capabilities` is empty.
- Reject WorkOrderV1 if `agent.implementer_pool` is empty AND no agent in the registry exposes `roles: ["implementer"]` with matching capabilities. (Validated at AgentRegistry binding time, not parse time.)
- Reject AgentProfileV1 with `capabilities.kinds` empty or `capabilities.roles` empty.
- Reject AgentProfileV1 with `cost_profile.estimated_cost_per_run_units < 0`.
- Reject ReviewVerdict with `verdict` outside `{approved, changes_requested, rejected}`.

## Event Registry

Implement v1 event names from `docs/contracts/v1-event-registry.md`.

```ts
export const V1_EVENT_TYPES: readonly string[];
export const V1_RESERVED_EVENT_TYPES: readonly string[];
export function assertKnownEventTypeV1(eventType: string): void;
export function assertNotReservedV1(eventType: string): void;
```

Minimum validation:

- `task.dispatched` requires `task_id` and `payload.decision_id` plus a `payload.role` and either `payload.picked_agent_id` or `payload.refusal_reason`.
- `task.assigned` requires `task_id`, `run_id`, `agent_id`, plus `payload.role`.
- `review.requested` and `review.completed` require `task_id` and `run_id` (the **reviewer** run id).
- `review.completed` also requires `payload.verdict` and `payload.verdict_uri`; `summary` and `comments_count` should be included for audit summaries.
- `handoff.requested` requires `task_id`, `run_id`, `payload.handoff_packet_uri`, `payload.reason`.
- `quota.low` and `quota.exhausted` require `payload.scope` (`"agent"` or `"task"`) and the corresponding id.
- `task.edge_selected` requires `payload.from`, `payload.to`, `payload.reason`.
- `agent.spawned` requires `task_id`, `run_id`, `agent_id`, plus `payload.pid` (number) and `payload.credential_profile_alias` (string or `"unknown"`).
- `run.failed` requires `task_id`, `run_id`, `agent_id`, plus `payload.reason` from the closed taxonomy in `v1-module-breakdown.md` §11.1: `"spawn_failed" | "agent_nonzero_exit" | "agent_timed_out" | "provider_quota_exhausted" | "provider_rate_limited" | "provider_auth_failed" | "verification_failed" | "diff_apply_failed" | "lease_expired" | "internal_error"`. Free-form messages outside this set are rejected at the EventLog boundary.

Reserved names listed in `v1-event-registry.md` must throw on append.

## SQLite Persistence

Use SQLite through `better-sqlite3` (unchanged from v0).

Required new tables (full DDL is in `v1-module-breakdown.md` §9). All tables include `project_id` for forward compatibility, even though v1 only uses `default`.

Required exported APIs (additions only):

```ts
export interface QueueStore {
  insert(entry: TaskQueueEntry, workOrderJson: string): void;
  claim(workerId: string, leaseDurationSec: number): TaskQueueEntry | null;
  release(taskId: string, patch: Partial<TaskQueueEntry>): void;
  setStatus(taskId: string, status: TaskQueueEntry["status"]): void;
  get(taskId: string): TaskQueueEntry | undefined;
  listAll(): TaskQueueEntry[];
}

export interface MetricsStore {
  recordRunOutcome(args: {
    agentId: string;
    runId: string;
    success: boolean;
    wallTimeMs: number;
    actualCostUnits?: number;
  }): void;
  rollingFor(agentId: string, windowSize: number): {
    successRate: number;
    avgLatencyMs: number;
    avgActualCostUnits: number;
    runsObserved: number;
  };
}

export interface BudgetStore {
  init(taskId: string, caps: BudgetState["caps"]): void;
  current(taskId: string): BudgetState;
  applyPreLaunch(taskId: string): BudgetState;        // increments runs_used
  applyPostRun(taskId: string, deltaWallMs: number, deltaCostUnits: number): BudgetState;
}
```

## AgentRegistry

Required exported API:

```ts
export interface AgentRegistry {
  load(args: { sources: string[] }): void;
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
  refreshQuotaHealth(): void;
}
```

Acceptance requirements:

- Loading a directory: read every `*.json` and `*.yaml`. Loading a file: parse one. Mixed lists allowed.
- Duplicate `agent_id` -> throw with the offending paths in the error.
- Invalid profile -> throw with the field path.
- `candidatesFor` is deterministic: same inputs -> same ordering. Use stable sort by `agent_id` after filtering, then let Scheduler order by score.
- `recordOutcome` writes one `agent_metrics` row and refreshes the in-memory rolling window.
- Rolling window size defaults to 50; configurable via constructor.

## Scheduler

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

Acceptance requirements:

- Implements the score formula and weights from `v1-module-breakdown.md` §4. Weights are exported as a frozen constant:
  ```ts
  export const SCHEDULER_WEIGHTS = Object.freeze({
    capability_match: 0.40,
    cost_efficiency:  0.20,
    quota_health:     0.20,
    reliability:      0.10,
    latency_score:    0.10,
  } as const);
  ```
  Tests must (a) assert the exact numeric values of `SCHEDULER_WEIGHTS`, (b) assert the sum equals `1.0` within `1e-9`, and (c) feed a fixed two-agent fixture and assert exact `score` values plus the `picked_agent_id` byte-for-byte.
- Refusal precedence (in order): budget exhausted, no capability match, all excluded, all quota_exhausted.
- Reviewer pick must exclude the most recent implementer agent_id; if the orchestrator passes an excludeAgentIds list that does not contain it, Scheduler adds it before filtering. A unit test must pin this defense.
- Returns a `ScheduleDecision` with `decision_id` and full candidate score breakdown for every candidate considered (including filtered/excluded ones, with `excluded: true`).
- Same WorkOrder + same registry state must produce the same `picked_agent_id` (deterministic). Ties are broken by `agent_id` lexicographic order.

## BudgetManager

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

- `init()` is idempotent: calling twice for the same `task_id` does not reset usage.
- `preLaunch()` is the **only** function that increments `runs_used`. Run row creation must call this before spawning the agent.
- `postRun()` adds wall time and cost; uses `actualCostUnits` if provided, else `estimatedCostUnits`.
- Status transitions emit events:
  - First time any axis crosses 0.80 -> `quota.low` (scope=`task`).
  - First time any axis crosses 1.00 -> `quota.exhausted` (scope=`task`).
- Defaults if WorkOrder omits caps: `max_runs=4`, `max_wall_time_minutes=30`, `max_total_cost_units=10`.
- Cap values that conflict with `review.max_review_runs` (e.g. `max_runs < max_review_runs + 1`) are normalized at parse time, not at runtime: parser should reject the WorkOrder with a clear error.

## HandoffManager

Required exported API:

```ts
export interface HandoffManager {
  build(args: {
    fromRunId: string;
    fromAgentId: string;
    workOrderGoal: string;
    reason: HandoffPacket["reason"];
    diffArtifactUri?: string;
    verificationOutputUri?: string;
    reviewVerdictUri?: string;
    priorExcludes: string[];
  }): HandoffPacket;

  persist(packet: HandoffPacket, taskId: string): ArtifactRef;

  attachToBrief(args: {
    workspacePath: string;
    packet: HandoffPacket;
  }): void;
}
```

Acceptance requirements:

- Always **adds** `fromAgentId` to `exclude_agent_ids` if not already present.
- Persists as `artifact://<task_id>/<from_run_id>/handoff_packet.json` with kind `handoff_packet`.
- `attachToBrief()` writes `.agent-workflow/handoff_packet.json` AND prepends a "You are taking over a previous attempt" paragraph to `.agent-workflow/prompt.md`. Both writes are required.
- Template strings live in code constants and are unit-tested for stable output.

## TaskQueue

Required exported API: see `QueueStore` above. The `TaskQueue` class is a thin wrapper that adds policy (default lease duration, retry backoff) on top of `QueueStore`.

Acceptance requirements:

- Default lease duration: `min(60 minutes, max_wall_time_minutes * 60 + 60 seconds)`.
- `claim()` is atomic via SQLite transaction; never returns the same task to two workers.
- `claim()` does not return tasks in a terminal status.
- `claim()` reclaims expired leases (i.e. a lease whose `lease_expires_at < now()`).
- A reclaimed expired lease emits a single `run.failed` event (best-effort; payload `reason: "lease_expired"`) for the prior owner before re-dispatching.

## Worker / WorkerPool

Required exported API:

```ts
export interface WorkerPool {
  start(workers: number): void;
  waitForAllTerminal(): Promise<void>;
  stop(graceMs?: number): Promise<void>;
}
```

Acceptance requirements:

- `start(N)` spawns N async loops sharing the orchestrator's database. Each Worker has a unique `workerId` (uuid).
- Workers poll `claim()` with a 200 ms backoff when nothing is claimable.
- A Worker that is shutting down does not call `claim()` again. In-flight runs finish or hit `graceMs`.
- Each Worker uses its **own** SQLite connection (`Database` instance from `better-sqlite3`); connections must **never** be shared across workers. WAL mode must be enabled at migration time (`PRAGMA journal_mode = WAL;`) and `busy_timeout` set to at least 5000 ms per connection. A unit test pins this: a fixture starts 4 workers, asserts each holds a distinct `Database` reference, and asserts WAL mode is active.
- A Worker that throws an uncaught exception logs the error, releases the lease (best-effort), and continues. The pool does not crash the whole process for one bad iteration.

## Orchestrator-v1 (per-attempt executor)

Required exported API:

```ts
export async function runTaskOnce(args: {
  entry: TaskQueueEntry;
  decision: ScheduleDecision;
  agentProfile: AgentProfileV1;
  workOrder: WorkOrderV1;
  services: V1Services;
  db: Database;
}): Promise<RunOutcome>;
```

Required event sequence — **implementer success path**:

```text
task.assigned
run.created
artifact.published       # run manifest (sets run_manifest_ref)
run.started
agent.spawned
artifact.published       # stdout tail
artifact.published       # stderr tail
artifact.published       # diff
artifact.published       # final report (if present)
artifact.published       # task capsule
verification.started
verification.passed      # or verification.failed
artifact.published       # verification output
run.completed            # OR run.failed
task.edge_selected       # verifying -> reviewing  (review.enabled=true)
                         # OR verifying -> accepted (review.enabled=false)
```

Required event sequence — **reviewer success path** (verdict=approved):

```text
task.assigned
run.created
artifact.published       # run manifest (sets run_manifest_ref)
run.started
review.requested
artifact.published       # review brief (optional but recommended)
artifact.published       # diff under review
agent.spawned
artifact.published       # stdout tail
artifact.published       # stderr tail
artifact.published       # review_verdict
run.completed
review.completed         # payload includes verdict_uri
task.edge_selected       # reviewing -> accepted
```

Required event sequence — **reviewer changes_requested**:

```text
... up to review.completed (verdict=changes_requested) ...
task.edge_selected       # reviewing -> requeued
```

Required event sequence — **reviewer rejected**:

```text
... up to review.completed (verdict=rejected) ...
task.edge_selected       # reviewing -> awaiting_human
```

## CLI

`agentflow run` (extended):

- Accepts both `workflow/v0` and `workflow/v1` WorkOrders.
- v0 path: same as v0 (single-shot orchestrator). v1 path: enqueue + start a 1-worker pool.
- `--agent` (singular) is accepted as an alias for `--agents` with one path.
- Exit code 0 = task accepted, 1 = task failed, 2 = input invalid, 3 = task awaiting_human.

`agentflow batch` (NEW):

- Accepts a directory of WorkOrders.
- Loads AgentRegistry once.
- Refuses to start if any WorkOrder is invalid (exit 2).
- Starts WorkerPool with `--workers` (default 2, max 16).
- Prints one summary line per task at end.
- Exit code: 0 if all `accepted`; 1 if any `failed`; 3 if any `awaiting_human` (`failed` takes precedence over `awaiting_human` — if a script sees both, it sees 1).
- A SIGINT handler stops the pool gracefully, flushes events, and exits with code 130.

## Testing Requirements

Minimum tests before v1 can be considered complete:

### Unit

- v1 schema parsers reject malformed inputs (one test per required field).
- v0 -> v1 upgrader produces a valid v1 WorkOrder for a representative v0 fixture.
- AgentRegistry rejects duplicate `agent_id` and invalid profiles.
- AgentRegistry `candidatesFor()` correctly filters by capability, role, exclusion, and quota.
- Scheduler score formula is pinned: a fixture with two known agents must produce the same `picked_agent_id` and the same `score` numbers across runs.
- Scheduler refusal precedence is pinned (one test per refusal_reason).
- Scheduler enforces "reviewer != most recent implementer" even when caller forgets to pass the exclusion.
- BudgetManager: `preLaunch` increments only `runs_used`; `postRun` updates wall time and cost; `quota.low` fires once at 0.80; `quota.exhausted` fires once at 1.00; double crossings do not re-emit.
- HandoffManager: produces stable JSON for fixed inputs (golden file); always adds `fromAgentId` to `exclude_agent_ids`.
- ReviewVerdictParser: missing file, malformed JSON, invalid schema, valid verdict — all four cases.
- TaskQueue: two concurrent `claim()` calls in a `Promise.all` only one returns the entry; the other returns `null`.
- TaskQueue: expired lease is reclaimable.
- TaskQueue: terminal status entries are never returned by `claim()`.
- MetricsStore rolling window correctness with 0, 1, 50, 60 entries.
- Event registry rejects every reserved name; accepts every v0 + v1 name.

### Integration

- Two fake agents end-to-end (implementer always succeeds + reviewer always approves) -> task accepted.
- Implementer succeeds + reviewer always `changes_requested` + only one implementer in pool -> after `max_review_runs` exceeded, task ends `awaiting_human` (or `failed` if budget hits first; pin one of the two with a fixture).
- Implementer fails verification + fallback implementer succeeds + reviewer approves -> task accepted, `exclude_agent_ids` contains the failed agent.
- Reviewer rejects -> task `awaiting_human`, no requeue happens.
- `agentflow batch` with 4 WorkOrders, 2 workers: every task reaches a terminal status, no two workers ever own the same task simultaneously (asserted via event log).
- Budget exhaustion mid-flight: a task with `max_runs=2` that needs 3 runs ends `failed`.
- Lease expiration: a worker that is killed mid-run leaves the lease; a fresh `agentflow batch` invocation reclaims it (test by manually inserting an expired-lease row).
- Reviewer worktree `git apply` failure -> reviewer run `failed` with `payload.reason: "diff_apply_failed"`; `git apply` stdout and stderr are persisted as artifacts under the reviewer `run_id`; the **implementer**'s `agent_id` is added to `exclude_agent_ids`; the **reviewer**'s `agent_id` is **not** added; `agent_metrics` does **not** record a row for the reviewer (it never executed); `task_budget.runs_used` is incremented.
- Re-review on requeue: after a `changes_requested` outcome, the next implementer produces a new diff; the test asserts a fresh reviewer run is launched and a new `review.completed` event is emitted whose `run_id` is the new reviewer run, not a stale one. The orchestrator must not accept the task by reusing the prior verdict artifact.
- Provider quota classification: a fake adapter that prints a known "rate limit exceeded" line on stderr and exits non-zero must produce `run.failed` with `payload.reason: "provider_rate_limited"`, and the next Scheduler call for that agent must score it `quota_health = 0.5` (or refuse it if it crosses the hard threshold). Same fixture for `provider_quota_exhausted` (Scheduler refuses) and `provider_auth_failed` (Scheduler refuses).
- WorkerPool SQLite isolation: 4 workers in a single `agentflow batch` invocation each hold a distinct `Database` instance; `PRAGMA journal_mode` returns `wal` on every connection.

## Review Checklist

Use this checklist when reviewing v1 implementation from another agent:

- v0 path still works for both `agentflow run` and the v0 tests (no regressions).
- v1 path does not invoke the v0 orchestrator function; they share submodules but not control flow.
- Every `agent_runs` row written by v1 has `role` and (where applicable) `parent_run_id` populated.
- Every `task.dispatched` event has a `decision_id` that can be matched to either a picked run or a refusal.
- `exclude_agent_ids` only grows for a given task; no code path shrinks it within a single task.
- Reviewer worktree is always a fresh worktree built off `base_ref`, with the implementer's diff applied via `git apply --3way`. The reviewer never shares a worktree with the implementer.
- Worktree cleanup happens at task terminal status, not per-run. A failed run's diff remains accessible to the next implementer.
- BudgetManager's `preLaunch` is called before `child_process.spawn`. No code path spawns an agent without a budget gate.
- Scheduler refusal always emits `task.dispatched` with `picked_agent_id: null`; never silently aborts.
- A single SQLite connection is **not** shared across worker threads; each Worker opens its own. WAL mode is enabled in migrations.
- All v0 events still fire correctly under v1; no v0 event has changed semantics except for `run.completed` which is now scoped to "process succeeded" only.
- Reserved event names throw at the EventLog boundary.
- Reviewer Agent's verdict file path is exactly `.agent-workflow/review_verdict.json`. Anything else is treated as missing.
- `agentflow batch` exit codes match the CLI section; tests pin all four.
- The implementation does not add Context Broker, Acceptance Verifier, Anomaly Detector, Secret Scanner, or any other v2 component.
- `git apply` stdout/stderr on `diff_apply_failed` are persisted as artifacts; the reviewer's `agent_id` is **not** added to `exclude_agent_ids` for that case; `agent_metrics` has no row for the never-executed reviewer.
- A `changes_requested` outcome never lets the orchestrator accept the task on the strength of a prior `review_verdict` artifact; every acceptance is backed by a `review.completed` whose `run_id` is a reviewer run started **after** the accepted diff was produced.
- `run.failed.payload.reason` always comes from the closed taxonomy (§11.1); the EventLog rejects any other value.
- `SCHEDULER_WEIGHTS` is exported as a frozen object; tests pin the exact values and the sum invariant.
- WorkerPool gives every Worker its own `Database` connection; WAL mode is enabled; no Worker shares a connection with another.
