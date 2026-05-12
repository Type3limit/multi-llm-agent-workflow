# v1 Status

Last updated: 2026-05-12.

## Summary

v1 is now wired as a user-facing local CLI path. `agentflow run` accepts `workflow/v0` and `workflow/v1` WorkOrders, and `agentflow batch` runs a directory of independent `workflow/v1` WorkOrders through a single-process WorkerPool.

The reusable per-attempt executor is connected through `V1WorkerTaskHandler` to Scheduler decisions, BudgetManager pre/post run accounting, HandoffManager packets, AgentRegistry metrics/quota health, and TaskQueue status transitions. The v0 CLI path remains preserved.

SIGINT on v1 run or batch exits 130, stops the pool, finalizes started interrupted `agent_runs` as `cancelled`, and leaves unfinished tasks non-terminal. Terminal worktree cleanup is implemented for accepted and failed tasks; `awaiting_human` intentionally retains worktrees for manual inspection.

v1.x Phase 1 adds the first L1 seam: `SandboxProvider` now wraps the behavior-preserving git worktree execution environment through `GitWorktreeSandboxProvider`. The adapter still uses `.agentflow/worktrees/<task_id>/<run_id>`, the existing branch/base-ref behavior, `.agent-workflow/` git exclusion, current diff/status/cleanup behavior, and reviewer patch application through `git apply --3way --whitespace=nowarn -`.

v1.x Phase 2 adds the first L3 read-model seam: `SessionSnapshot` now aggregates existing SQLite task, run, artifact, review-context, and handoff rows for a v1 `task_id`. It is read-only and does not restore model conversation state, rebuild worktrees, fork sessions, or add new persistence tables.

v1.x Phase 3 adds an L3-lite reconstruction helper: `reconstructWorktreeFromSessionSnapshot` selects a persisted diff artifact from a `SessionSnapshot`, prepares a fresh git worktree from the snapshot base evidence, and applies the diff through `SandboxProvider`. This reconstructs repository file state only. It does not resume model conversations, keep old worktrees alive, or add persistence.

## Four-Layer Alignment

The four-layer decoupling direction in `docs/architecture/four-layer-decoupling.md` remains a post-v1 compass and does **not** change the historical v1 scope.

Current v1.x alignment:

1. `SandboxProvider` is implemented as a small workspace-layer interface.
2. `GitWorktreeSandboxProvider` is the only adapter and preserves the existing git worktree behavior.
3. `SessionSnapshot` is implemented as a read-only aggregation contract in `src/session/session-snapshot.ts`.
4. Fork-from-snapshot worktree reconstruction is implemented as `src/session/session-fork.ts` and remains limited to `base evidence + diff artifact -> fresh worktree`.
5. Planner / Coordinator, DAG dependency edges, SessionStore, Docker/micro-VM adapters, HTTP/API behavior, and long-running session resume remain deferred.

## Implemented

| Area | Status | Primary files |
|---|---|---|
| v1 schemas and union parsers | Done | `src/core/schemas-v1.ts`, `src/core/schemas.ts`, `src/core/types.ts` |
| v1 event registry and payload validation | Done | `src/core/events.ts`, `src/storage/event-log.ts` |
| SQLite migrations and stores | Done | `src/storage/migrations.ts`, `queue-store.ts`, `metrics-store.ts`, `budget-store.ts`, `run-store.ts` |
| AgentRegistry | Done | `src/scheduling/agent-registry.ts` |
| Scheduler | Done | `src/scheduling/scheduler.ts` |
| BudgetManager | Done | `src/scheduling/budget-manager.ts` |
| TaskQueue | Done | `src/queue/task-queue.ts`, `src/storage/queue-store.ts` |
| HandoffManager | Done | `src/scheduling/handoff-manager.ts` |
| Review brief writer and verdict parser | Done | `src/workspace/review-brief-writer.ts`, `src/adapters/review-verdict-parser.ts` |
| Worker and WorkerPool primitives | Done | `src/queue/worker.ts`, `src/queue/worker-pool.ts` |
| Worker outcome translation | Done | `src/queue/worker-task-handler.ts` |
| Orchestrator-v1 per-attempt executor | Done | `src/core/orchestrator-v1.ts` |
| Provider failure classification | Done | `src/adapters/official-cli-adapter.ts`, `src/scheduling/agent-registry.ts` |
| v0 CLI path | Preserved | `src/cli/run-command.ts`, `src/core/orchestrator.ts` |
| v1 `agentflow run` wiring | Done | `src/cli/run-command.ts` |
| `agentflow batch` command | Done | `src/cli/run-command.ts` |
| Terminal worktree cleanup for accepted/failed tasks | Done | `src/cli/run-command.ts`, `src/storage/run-store.ts` |
| v1 SIGINT graceful interruption | Done | `src/cli/run-command.ts`, `src/queue/worker-pool.ts`, `src/core/orchestrator-v1.ts` |
| v1.x SandboxProvider seam | Done | `src/workspace/sandbox-provider.ts`, `src/core/orchestrator-v1.ts`, `src/core/orchestrator.ts`, `src/cli/run-command.ts` |
| v1.x SessionSnapshot read model | Done | `src/session/session-snapshot.ts` |
| v1.x fork-from-snapshot worktree reconstruction | Done | `src/session/session-fork.ts` |

## Current Coverage

Traceable fake-agent integration coverage in `tests/integration/cli-run.test.ts` includes:

- v1 review disabled accepted path.
- v1 review enabled approve path through `agentflow run`.
- reviewer `rejected` moving the task to `awaiting_human` without requeue.
- reviewer `changes_requested` requeueing to a different implementer and a fresh reviewer.
- reviewer `diff_apply_failed` requeueing without launching the reviewer agent, while excluding the implementer and not recording reviewer metrics.
- v1 run SIGINT returning 130, cancelling started run rows, and leaving the task non-terminal.
- v1 batch SIGINT returning 130, cancelling started run rows, and leaving tasks non-terminal.
- `agentflow batch` accepting multiple WorkOrders with two workers.
- batch waiting scoped to the current task ids when the database already contains old terminal rows.
- accepted-task cleanup emitting `run.cleaned_up` and removing worktrees.

Additional unit coverage includes:

- Worker outcome translation for implementer success/failure, reviewer approve/changes_requested/rejected, Scheduler refusals, budget exhaustion, provider failure reasons, handoff packets, and `diff_apply_failed`.
- Provider stderr classification and AgentRegistry quota-health updates for `provider_rate_limited`, `provider_quota_exhausted`, and `provider_auth_failed`.
- WorkerPool SIGINT terminal-wait cancellation and per-worker WAL-enabled SQLite connections.
- RunStore cleanup candidates for accepted and failed tasks while excluding `awaiting_human`.
- `GitWorktreeSandboxProvider` applying a clean diff into a prepared worktree.
- `SqliteSessionSnapshotReader` covering accepted implementer/reviewer state, review context, handoff URI, missing tasks, and terminal failed/awaiting_human states.
- `reconstructWorktreeFromSessionSnapshot` covering run-id diff selection, explicit diff URI selection, missing diff artifacts, ambiguous multiple diff artifacts, and rejecting URIs absent from the snapshot.
- Orchestrator-v1 reviewer patch application through a fake `SandboxProvider`.
- Queue expired-lease reclamation, BudgetManager quota events, Scheduler scoring/refusals, and v1 schema/event validation.

## Deferred Or Not Claimed

| Item | Status | Notes |
|---|---|---|
| Docker / micro-VM sandbox adapters | Deferred | `SandboxProvider` currently has only the behavior-preserving git worktree adapter. |
| SessionStore / Redis/KV / external memory / session resume | Deferred | Fork-from-`SessionSnapshot` now reconstructs file state in a fresh worktree only; it is not resumable model state. |
| Planner / Coordinator / DAG | Deferred | `agentflow batch` only runs user- or fixture-supplied independent WorkOrders. |
| HTTP/API/dashboard behavior | Deferred | CLI-only in v1. |
| Human-decision cleanup for `awaiting_human` | Deferred | Worktrees are intentionally retained until a future human-decision flow exists. |
| Live provider quota probes | Deferred | v1 uses stderr classification and in-process quota-health updates, not vendor API polling. |
| Killed-process lease recovery CLI e2e | Not currently claimed | Expired lease behavior is covered at the queue/store level. |

## Current Definition Of Done

| Requirement | Status |
|---|---|
| v1 schemas parse/default all machine-readable contracts | Done |
| v0/v1 union parsers dispatch on `schema_version` | Done |
| SQLite v1 tables migrate cleanly | Done |
| `agent_runs` supports `role`, `parent_run_id`, `handoff_packet_uri` | Done |
| EventLog accepts v0+v1 events and rejects reserved names | Done |
| EventLog validates v1 required payload fields | Done |
| `run.failed.payload.reason` is closed-taxonomy validated | Done |
| AgentRegistry loads profiles and protects internal state | Done |
| Scheduler scoring/refusal behavior is unit-tested | Done |
| BudgetManager enforces run/time/cost counters | Done |
| HandoffManager builds, persists, and attaches packets | Done |
| ReviewBriefWriter writes isolated reviewer capsules | Done |
| ReviewVerdictParser handles valid, missing, malformed, and invalid verdict files | Done |
| WorkerPool creates isolated SQLite connections per worker | Done |
| `runTaskOnce()` implementer path saves artifacts, emits events, and runs verification | Done |
| `runTaskOnce()` reviewer path applies diff, runs reviewer, and parses verdict | Done |
| Reviewer diff apply failure is self-contained and does not launch the reviewer agent | Done |
| `review.completed` includes `verdict_uri` for replay/audit consumers | Done |
| v0 tests still pass after v1 additions | Done |
| `agentflow run` supports v1 WorkOrders | Done |
| `agentflow batch` supports multiple WorkOrders and `--workers` | Done |
| Worker connects Scheduler + BudgetManager + `runTaskOnce()` + HandoffManager | Done |
| End-to-end v1 fake-agent approve flow passes | Done |
| End-to-end v1 requeue / `changes_requested` flow passes | Done |
| End-to-end v1 `diff_apply_failed` requeue flow passes | Done |
| End-to-end parallel batch smoke test passes | Done |
| SIGINT interruption exits 130 without making unfinished tasks terminal | Done |

## Validation Snapshot

Requested validation for this phase:

```bash
pnpm build
pnpm test
```

Both commands should pass before accepting documentation changes.

## Notes For Future Agents

For v1 behavior changes, start from these modules:

- `src/cli/run-command.ts` for v0/v1 dispatch, batch, SIGINT, summaries, and cleanup.
- `src/queue/worker-task-handler.ts` for lifecycle outcome translation.
- `src/core/orchestrator-v1.ts` for per-attempt implementer/reviewer execution.
- `tests/integration/cli-run.test.ts` for the current fake-agent CLI coverage.

Do not add Docker/micro-VM or other second sandbox adapters, SessionStore, Redis/KV or external memory, Planner/Coordinator, DAG behavior, HTTP/API behavior, model conversation resume, or any expansion beyond file-state-only snapshot reconstruction while maintaining the v1 CLI unless a later prompt explicitly changes scope.

## Frozen v1 Decisions

The following design choices are frozen for v1. Any future change requires a new ADR.

1. Reviewer Agent runs in a separate worktree with `git apply --3way --whitespace=nowarn -` through `SandboxProvider`; it never shares the implementer's worktree.
2. On reviewer diff apply failure, the reviewer agent is not launched, git apply stdout/stderr/diff are saved under the reviewer run, and the edge is `reviewing -> requeued` with reason `diff_apply_failed`.
3. No live quota probe in v1. Provider-side failures are represented by explicit `provider_*` `run.failed` reasons.
4. WorkerPool is single-process with async worker loops; each worker owns its own SQLite connection.
5. `changes_requested` requires a fresh reviewer run on the new diff. Prior verdicts are context only.
6. `review.enabled: false` skips reviewer dispatch entirely and accepts after verification passes.
7. Scheduler weights are frozen as `SCHEDULER_WEIGHTS`.
8. No DAG. `agentflow batch` parallelizes independent WorkOrders only.
9. Historical v1 shipped without `SandboxProvider`; v1.x Phase 1 adds the behavior-preserving seam while continuing to use git worktrees as the only adapter.
10. No resumable Session / SessionStore in v1. The v1.x Phase 2 `SessionSnapshot` is a read-only aggregation over audit/recovery evidence, not resumable model state.
11. No Coordinator fan-out or DAG in v1. `agentflow batch` only runs WorkOrders supplied by the user or test fixtures.
