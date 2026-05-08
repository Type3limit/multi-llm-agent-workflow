# v1 Status

Last updated: 2026-05-08.

## Summary

v1 is implemented through the reusable per-attempt executor layer. The codebase now has the v1 contracts, storage, scheduler, registry, budget, handoff, review brief/parser, worker primitives, and `runTaskOnce()` module with focused unit coverage.

The remaining work before user-facing v1 is complete is the final wiring layer: connect Worker outcome translation to Scheduler/Budget/Handoff/Metrics, add `agentflow batch`, extend `agentflow run` for v1, and add end-to-end fake-agent integration tests.

## Implemented

| Area | Status | Primary files |
|---|---|---|
| v1 schemas and union parsers | Done | `src/core/schemas-v1.ts`, `src/core/schemas.ts`, `src/core/types.ts` |
| v1 event registry and payload validation | Done | `src/core/events.ts`, `src/storage/event-log.ts` |
| SQLite migrations and stores | Done | `src/storage/migrations.ts`, `queue-store.ts`, `metrics-store.ts`, `budget-store.ts`, `run-store.ts` |
| AgentRegistry | Done | `src/scheduling/agent-registry.ts` |
| Scheduler | Done | `src/scheduling/scheduler.ts` |
| BudgetManager | Done | `src/scheduling/budget-manager.ts` |
| HandoffManager | Done | `src/scheduling/handoff-manager.ts` |
| Review brief writer and verdict parser | Done | `src/workspace/review-brief-writer.ts`, `src/adapters/review-verdict-parser.ts` |
| Worker and WorkerPool primitives | Done | `src/queue/worker.ts`, `src/queue/worker-pool.ts` |
| Orchestrator-v1 per-attempt executor | Done | `src/core/orchestrator-v1.ts` |
| v0 CLI path | Preserved | `src/cli/run-command.ts`, `src/core/orchestrator.ts` |

## Remaining

| Area | Status | Notes |
|---|---|---|
| Worker outcome translation | Pending | Needs to translate `RunOutcome` into queue status, handoff, budget observation, metrics, and requeue behavior. |
| v1 `agentflow run` wiring | Pending | Current `agentflow run` intentionally accepts only v0 and rejects v1 with a clear message. |
| `agentflow batch` command | Pending | CLI entry, argument parsing, enqueue-all, WorkerPool lifecycle, final summary, and exit codes are not wired yet. |
| End-to-end v1 fake-agent tests | Pending | Need implementer+reviewer fixtures covering approve, changes requested, rejected, budget exhaustion, diff apply failure, and parallel workers. |
| Provider quota/rate/auth classification | Pending | The taxonomy and registry states exist; adapter-side stderr regex classification is still deferred. |
| Terminal worktree cleanup | Pending | Worktree cleanup policy is documented but not wired to terminal task status yet. |

## Current Definition of Done

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
| BudgetManager enforces run/time/cost counters at module level | Done |
| HandoffManager builds/persists/attaches packets at module level | Done |
| ReviewBriefWriter writes isolated reviewer capsule | Done |
| ReviewVerdictParser handles valid, missing, malformed, and invalid verdict files | Done |
| WorkerPool creates isolated SQLite connections per worker | Done |
| `runTaskOnce()` implementer path saves artifacts, emits events, runs verification | Done |
| `runTaskOnce()` reviewer path applies diff, runs reviewer, parses verdict | Done |
| Reviewer diff apply failure is self-contained and does not launch the reviewer agent | Done |
| `review.completed` includes `verdict_uri` for replay/audit consumers | Done |
| v0 tests still pass after v1 additions | Done |
| `agentflow run` supports v1 WorkOrders | Pending |
| `agentflow batch` supports multiple WorkOrders and `--workers` | Pending |
| Worker connects Scheduler + BudgetManager + runTaskOnce + HandoffManager | Pending |
| End-to-end v1 fake-agent approve flow passes | Pending |
| End-to-end v1 requeue / changes_requested flow passes | Pending |
| End-to-end parallel batch smoke test passes | Pending |

## Validation Snapshot

Latest local validation for this milestone:

```bash
pnpm build
pnpm test
```

Expected result at this point: build passes and the full unit/integration suite passes. v1 CLI end-to-end tests are not present yet because the final wiring layer is still pending.

## Notes for the Next Agent

Start from `src/core/orchestrator-v1.ts` and `tests/unit/orchestrator-v1.test.ts` to understand the `RunOutcome` contract. Then implement a Worker task handler that:

1. Claims or receives a `TaskQueueEntry`.
2. Loads the WorkOrder from the queue row.
3. Checks BudgetManager before launch.
4. Calls Scheduler and emits `task.dispatched`.
5. Calls `runTaskOnce()` for the picked agent.
6. Observes budget and metrics after the attempt.
7. Converts `RunOutcome` into queue transitions, HandoffPacket creation, requeue, terminal events, and final task status.

Only after that handler exists should `agentflow batch` and v1 `agentflow run` be wired.

## Frozen v1 Decisions

The following design choices are frozen for v1. Any future change requires a new ADR.

1. Reviewer Agent runs in a separate worktree with `git apply --3way`; it never shares the implementer's worktree.
2. On reviewer diff apply failure, the reviewer agent is not launched, git apply stdout/stderr/diff are saved under the reviewer run, and the edge is `reviewing -> requeued` with reason `diff_apply_failed`.
3. No live quota probe in v1. Provider-side failures are represented by explicit `provider_*` `run.failed` reasons.
4. WorkerPool is single-process with async worker loops; each worker owns its own SQLite connection.
5. `changes_requested` requires a fresh reviewer run on the new diff. Prior verdicts are context only.
6. `review.enabled: false` skips reviewer dispatch entirely and accepts after verification passes.
7. Scheduler weights are frozen as `SCHEDULER_WEIGHTS`.
8. No DAG. `agentflow batch` parallelizes independent WorkOrders only.
