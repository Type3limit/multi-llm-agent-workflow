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
- Session resume and model conversation restoration. The read-only `SessionSnapshot` aggregation seam is implemented in post-v1 v1.x Phase 2, and file-state-only fork-from-snapshot worktree reconstruction is implemented in v1.x Phase 3.
- SessionStore or external KV memory.
- Docker / micro-VM sandbox adapters. The `SandboxProvider` seam itself was a historical v1 non-goal and is implemented only in post-v1 v1.x Phase 1.
- MCP / official_extension / managed_proxy modes.
- Multi-WorkOrder DAG with dependency edges across tasks.
- Planner / Coordinator agent that generates WorkOrders.
- Multi-project sharding.
- Distributed scheduler (multiple orchestrator processes).
- Bidding mode (Agent self-reported cost estimates).
- Replay / event sourcing reconstruction.
- Automatic prompt rollback or capability downgrade detection.
- User-initiated cancellation of a specific run or task beyond process SIGINT.
  SIGINT graceful interruption is implemented for v1 run/batch.
- Resource-aware scheduling (CPU/memory/disk fit).
- Locality / privacy scoring.

## Post-v1 Direction

v1 is the local orchestration kernel. Keep the implementation focused on the v1 interfaces below; do not opportunistically add the four-layer architecture pieces while finishing this spec.

The expected post-v1 order is:

1. `SandboxProvider`: implemented in v1.x Phase 1 as a behavior-preserving seam around the current git worktree behavior. Add Docker / micro-VM adapters only when there is a real second implementation.
2. `SessionSnapshot`: implemented in v1.x Phase 2 as a read-only aggregation over existing task_queue, agent_runs, artifacts, review context, and handoff URI state. It adds no table and does not fork or resume sessions.
3. Fork-from-snapshot worktree reconstruction: implemented in v1.x Phase 3 as `SessionSnapshot` base evidence plus a selected persisted diff artifact -> fresh git worktree -> `SandboxProvider.applyDiff`. This reconstructs repository file state only.
4. Planner / Coordinator agent: read a high-level goal and generate a flat fan-out list of independent v1 WorkOrders, then hand execution back to Scheduler + WorkerPool. It must not introduce DAG dependency edges without a later ADR.
5. SessionStore: move snapshot/state storage behind SQLite or external KV only after the snapshot semantics are stable.

Any agent implementing v1 should treat Planner / Coordinator, SessionStore, model conversation resume, Redis/KV or external memory, DAG dependency edges, HTTP/API behavior, second sandbox adapters, and any expansion beyond file-state-only fork-from-snapshot as future work unless a later prompt explicitly changes the scope.

Post-v1 architecture work remains out of scope for the historical v1 spec unless a later prompt explicitly opens it. Use `v1-status.md` for the current implementation and coverage snapshot before starting any adapter work beyond the v1.x `SandboxProvider` seam.

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

Status note, 2026-05-12: the v1 run wiring, batch CLI, Worker outcome translation, and fake-agent CLI integration paths are implemented. This document remains the contract and review checklist; `v1-status.md` is the current status snapshot.

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
- Do not reject WorkOrderV1 solely because `agent.implementer_pool` is empty. Empty means any matching registry implementer may be scheduled; if no usable implementer exists, the Scheduler returns a refusal during worker handling. The narrow exception is the `agentflow run` `review.enabled=false` single-profile path, which validates its one AgentProfile before starting.
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

Required new tables (full DDL is in `v1-module-breakdown.md` §9). `task_queue` includes `project_id` for forward compatibility, even though v1 only uses `default`; current `agent_metrics` and `task_budget` DDL do not include `project_id`.

Required exported APIs (additions only):

```ts
export interface QueueStore {
  insert(entry: TaskQueueEntry, workOrderJson: string): void;
  claim(workerId: string, leaseDurationSec: number): TaskQueueEntry | null;
  release(taskId: string, patch: Partial<TaskQueueEntry>): void;
  setStatus(taskId: string, status: TaskQueueEntry["status"]): void;
  get(taskId: string): TaskQueueEntry | undefined;
  getWorkOrder(taskId: string): WorkOrderV1 | undefined;
  addWorkOrderExcludeAgentIds(taskId: string, agentIds: string[]): WorkOrderV1;
  setReviewContext(taskId: string, context: ReviewContextRecord): void;
  getReviewContext(taskId: string): ReviewContextRecord | undefined;
  setHandoffPacketUri(taskId: string, uri: string | undefined): void;
  getHandoffPacketUri(taskId: string): string | undefined;
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
    runId?: string;
    failureReason?: RunFailedReason;
  }): void;
  refreshQuotaHealth(): void;
}
```

Acceptance requirements:

- Loading a directory: read every `*.json`, `*.yaml`, and `*.yml`. Loading a file: parse one. Mixed lists allowed.
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
    mostRecentImplementerAgentId?: string;
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
- Cap values that conflict with `review.max_review_runs` (e.g. `max_runs < max_review_runs + 1`) are rejected at parse time, not normalized at runtime.

## HandoffManager

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
- v1 currently claims queue/store-level expired-lease reclamation only. Emitting a `run.failed` event with `reason: "lease_expired"` on reclaim is not currently implemented or claimed.

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
- Each Worker uses its **own** SQLite connection (`Database` instance from `better-sqlite3`); connections must **never** be shared across workers. `openDatabase()` enables WAL mode (`PRAGMA journal_mode = WAL;`) and sets `busy_timeout` to at least 5000 ms per connection before the worker runs migrations. A unit test pins this: a fixture starts 4 workers, asserts each holds a distinct `Database` reference, and asserts WAL mode is active.
- A Worker that throws an uncaught exception releases the lease (best-effort) and continues. Structured logging for that path is not currently claimed.

## Orchestrator-v1 (per-attempt executor)

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
verification.started     # if verification commands are configured
verification.passed      # or verification.failed, if commands are configured
artifact.published       # verification output, if commands are configured
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

`agentflow batch` (implemented):

- Accepts a directory of WorkOrders.
- Loads AgentRegistry once.
- Refuses to start if any WorkOrder is invalid (exit 2).
- Starts WorkerPool with `--workers` (default 2, max 16).
- Prints one summary line per task at end.
- Exit code: 0 if all `accepted`; 1 if any `failed`; 3 if any `awaiting_human` (`failed` takes precedence over `awaiting_human` — if a script sees both, it sees 1).
- A SIGINT handler stops the pool gracefully, flushes events, and exits with code 130.

## Testing Requirements

Current v1 coverage should stay traceable to code and tests. The lists below separate unit coverage from CLI integration coverage so unsupported behavior is not implied.

### Unit

- v1 schema parsers reject malformed inputs (one test per required field).
- v0 -> v1 upgrader produces a valid v1 WorkOrder for a representative v0 fixture.
- AgentRegistry rejects duplicate `agent_id` and invalid profiles.
- AgentRegistry `candidatesFor()` correctly filters by capability, role, exclusion, and quota.
- Scheduler score formula is pinned: a fixture with two known agents must produce the same `picked_agent_id` and the same `score` numbers across runs.
- Scheduler refusal precedence is pinned (one test per refusal_reason).
- Scheduler enforces "reviewer != most recent implementer" even when caller forgets to pass the exclusion.
- BudgetManager: `preLaunch` increments only `runs_used`; `postRun` updates wall time and cost; `quota.low` fires once at 0.80; `quota.exhausted` fires once at 1.00; double crossings do not re-emit.
- HandoffManager: produces stable JSON/summary text for fixed inputs; always adds `fromAgentId` to `exclude_agent_ids`.
- ReviewVerdictParser: missing file, malformed JSON, invalid schema, valid verdict — all four cases.
- TaskQueue/QueueStore: after an entry is claimed, a second claim returns `null`, and a conditional update prevents modifying an already-claimed row.
- TaskQueue: expired lease is reclaimable.
- TaskQueue: terminal status entries are never returned by `claim()`.
- MetricsStore rolling stats: zero records, one record, multiple-record success rate, truncation to the requested window size, null cost handling, agent isolation, and same-timestamp tie-breaking. Dedicated 50/60-entry boundary coverage is not currently claimed.
- Event registry rejects every reserved name; accepts every v0 + v1 name.

### CLI Integration

`tests/integration/cli-run.test.ts` currently pins:

- v1 review disabled: fake implementer reaches `accepted`.
- v1 review enabled: fake implementer and reviewer approve through `agentflow run`.
- Reviewer `rejected`: task moves to `awaiting_human` without requeueing.
- Reviewer `changes_requested`: task requeues to a different implementer and a fresh reviewer.
- Reviewer `diff_apply_failed`: reviewer run fails without launching the reviewer agent, git apply artifacts are persisted, the implementer is excluded, reviewer metrics are not recorded, and a later reviewer can approve a fresh diff.
- v1 run SIGINT: exit 130, started run rows become `cancelled`, unfinished task remains non-terminal, and terminal task/cleanup events are not emitted.
- v1 batch SIGINT: exit 130 with the same non-terminal task and cancelled-run guarantees for started batch work.
- `agentflow batch`: multiple v1 WorkOrders from an agents directory reach `accepted` with two workers.
- Scoped batch waiting: old terminal queue rows do not satisfy the wait for the current batch task ids.
- Accepted terminal cleanup: `run.cleaned_up` is emitted and accepted task worktrees are removed.

Provider classification, budget exhaustion, expired leases, failed-task cleanup candidate selection, and WorkerPool per-worker SQLite isolation are covered by unit tests. Killed-worker lease recovery as a fresh CLI invocation is not currently claimed as an end-to-end fixture.

## Review Checklist

Use this checklist when reviewing v1 implementation from another agent:

- v0 path still works for both `agentflow run` and the v0 tests (no regressions).
- v1 path does not invoke the v0 orchestrator function; they share submodules but not control flow.
- Every `agent_runs` row written by v1 has `role` and (where applicable) `parent_run_id` populated.
- Every `task.dispatched` event has a `decision_id` that can be matched to either a picked run or a refusal.
- `exclude_agent_ids` only grows for a given task; no code path shrinks it within a single task.
- Reviewer worktree is always a fresh worktree built off `base_ref`, with the implementer's diff applied via `git apply --3way --whitespace=nowarn -` through `SandboxProvider`. The reviewer never shares a worktree with the implementer.
- Worktree cleanup happens after accepted/failed task status, not per-run. `awaiting_human` retains worktrees for manual inspection, and a failed run's diff remains accessible to the next implementer while the task can still requeue.
- BudgetManager's `preLaunch` is called before `child_process.spawn`. No code path spawns an agent without a budget gate.
- Scheduler refusal always emits `task.dispatched` with `picked_agent_id: null`; never silently aborts.
- A single SQLite connection is **not** shared across worker threads; each Worker opens its own through `openDatabase()`, which enables WAL mode per connection.
- All v0 events still fire correctly under v1; no v0 event has changed semantics except for `run.completed` which is now scoped to "process succeeded" only.
- Reserved event names throw at the EventLog boundary.
- Reviewer Agent's verdict file path is exactly `.agent-workflow/review_verdict.json`. Anything else is treated as missing.
- `agentflow batch` exit codes match the CLI section; keep tests aligned with any exit-code change.
- The implementation does not add Context Broker, Acceptance Verifier, Anomaly Detector, Secret Scanner, or any other v2 component.
- `git apply` stdout/stderr on `diff_apply_failed` are persisted as artifacts; the reviewer's `agent_id` is **not** added to `exclude_agent_ids` for that case; `agent_metrics` has no row for the never-executed reviewer.
- A `changes_requested` outcome never lets the orchestrator accept the task on the strength of a prior `review_verdict` artifact; every acceptance is backed by a `review.completed` whose `run_id` is a reviewer run started **after** the accepted diff was produced.
- `run.failed.payload.reason` always comes from the closed taxonomy (§11.1); the EventLog rejects any other value.
- `SCHEDULER_WEIGHTS` is exported as a frozen object; tests pin the exact values and the sum invariant.
- WorkerPool gives every Worker its own `Database` connection; WAL mode is enabled; no Worker shares a connection with another.
