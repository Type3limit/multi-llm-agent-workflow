# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`agentflow` — a Node.js/TypeScript orchestrator that supervises official agent CLIs (Codex, Claude Code, Gemini, Copilot-style, local models) as workers. The principle is **orchestration, not interception**: launch official tools, isolate each run in a git worktree, exchange state through `.agent-workflow/`, persist events/runs/artifacts to SQLite.

Package manager is **pnpm**. Module system is **ESM with NodeNext** — import paths in `src/` use `.js` extensions even when the source is `.ts`.

## Commands

```bash
pnpm install
pnpm build                          # tsc -> dist/
pnpm dev                            # tsx src/cli/index.ts
pnpm test                           # vitest run (all)
pnpm test:watch
pnpm vitest run tests/unit/scheduler.test.ts   # single file
pnpm vitest run -t "scoring"                   # single test by name
node dist/cli/index.js run <work_order.json> --agent <agent.json> [--database <path>]
```

Tests live in `tests/` (excluded from `tsc` via `tsconfig.json`); vitest config picks them up directly from TS via `tests/**/*.test.ts`.

## Architecture

The codebase is staged as **v0** (single-agent one-shot) and **v1** (queue + scheduler + reviewer). Both versions share the same storage and contracts; v1 is dispatched on `schema_version` in the WorkOrder. The v0 path is preserved and must keep passing as v1 is wired.

### Layers

| Layer | Directory | Role |
|---|---|---|
| CLI | `src/cli/` | `agentflow run` argument parsing and dispatch. `run` accepts v0 and v1 WorkOrders; `batch` runs independent v1 WorkOrders through the WorkerPool. |
| Core | `src/core/` | Pure domain: schemas (`schemas.ts` v0, `schemas-v1.ts` v1, union dispatch in `types.ts`), event registry (`events.ts`), v0 orchestrator (`orchestrator.ts`), v1 per-attempt executor `runTaskOnce()` in `orchestrator-v1.ts`, `upgrader.ts` for v0→v1. |
| Scheduling | `src/scheduling/` | `AgentRegistry`, `Scheduler` (frozen `SCHEDULER_WEIGHTS`), `BudgetManager` (run/time/cost counters), `HandoffManager` (review packets). |
| Queue | `src/queue/` | `TaskQueue`, `Worker`, `WorkerPool` (single-process, async loops, **one SQLite connection per worker**). |
| Storage | `src/storage/` | SQLite migrations and stores: `event-log`, `run-store`, `queue-store`, `metrics-store`, `budget-store`, `artifact-store`. |
| Workspace | `src/workspace/` | `GitWorktreeManager`, `TaskCapsuleWriter` (writes `.agent-workflow/work_order.md`), `ReviewBriefWriter`. |
| Adapters | `src/adapters/` | `OfficialCliAdapter` spawns supervised CLIs with bounded stdout/stderr capture; `ReviewVerdictParser` reads reviewer output. |
| Verification | `src/verification/` | Runs configured verification commands and records results. |

### v0 happy path (`orchestrator.ts`)

```
load WorkOrder + AgentProfile → create worktree → write task capsule
  → spawn agent (one-shot) → capture diff + stdout/stderr tail
  → run one verification command → persist events/run/artifacts
```

### v1 per-attempt path (`orchestrator-v1.ts::runTaskOnce`)

```
implementer role: Scheduler picks agent → runTaskOnce →
  save artifacts, emit events, run verification
reviewer role:    apply diff with `git apply --3way` in a SEPARATE worktree
                  (NEVER share the implementer's worktree)
                  → if apply fails: do NOT launch reviewer; record diff_apply_failed
                  → else run reviewer agent → parse verdict
```

The v1 Worker outcome-translation layer is implemented: it turns `RunOutcome` into queue transitions, handoff creation, budget observation, metrics, and requeue. See `docs/implementation/v1-status.md` for the current v1/v1.x boundary.

### Four-layer direction

`docs/architecture/four-layer-decoupling.md` is a long-term compass, not current v1 scope. The order is:

1. v1 local CLI kernel is implemented and covered by fake-agent approve / changes_requested / parallel batch e2e.
2. v1.x adds `SandboxProvider` as a behavior-preserving seam around current git worktrees.
3. v1.x adds `SessionSnapshot` as a read-only aggregation over existing task/run/artifact state.
4. v1.x adds file-state-only fork-from-snapshot reconstruction by rebuilding from base evidence plus a selected diff artifact.
5. The next larger direction is Planner / Coordinator as flat fan-out WorkOrder generation only. Do not add DAG semantics without a new ADR.

Do not implement Docker sandboxes, SessionStore, long-running model conversation resume, Coordinator fan-out, or DAG behavior unless a later prompt explicitly opens that scope.

### Frozen v1 decisions (any change needs a new ADR in `docs/decisions/`)

1. Reviewer runs in a separate worktree with `git apply --3way`.
2. On reviewer diff-apply failure, reviewer agent is **not** launched; status edge is `reviewing → requeued` with reason `diff_apply_failed`.
3. No live quota probing — provider failures use explicit `provider_*` `run.failed` reasons.
4. WorkerPool is single-process; each worker owns its own SQLite connection.
5. `changes_requested` always triggers a fresh reviewer run; prior verdicts are context only.
6. `review.enabled: false` skips reviewer entirely and accepts after verification.
7. `SCHEDULER_WEIGHTS` are frozen.
8. No DAG — `agentflow batch` parallelizes independent WorkOrders only.

### Event and schema rules

- Event types must come from the registry in `src/core/events.ts`; `EventLog` validates payloads and rejects reserved names.
- `run.failed.payload.reason` is closed-taxonomy validated.
- Task-level lifecycle uses `task.*`; per-attempt process lifecycle uses `run.*`. Task status and run status are independent.
- `agent_runs` rows carry `role`, `parent_run_id`, `handoff_packet_uri` for v1.
- Append-only event log; replay handlers must ignore rows where `skip_on_replay = 1`.

## Conventions

- **Surgical changes** — only touch what the task requires; v0 paths must keep passing.
- Prefer extending existing stores/adapters over adding new ones.
- Keep `tsconfig.json` `rootDir: src` honored — tests import from `src/` via relative paths.
- When importing local TS modules, use `.js` extensions (NodeNext requirement).

## Documentation map

- `docs/architecture/multi-agent-llm-workflow-design.md` — full design
- `docs/architecture/four-layer-decoupling.md` — four-layer decoupling interpretation and post-v1 route
- `docs/decisions/000{1,2}-*.md` — ADRs (tech stack, v1 scheduler/reviewer)
- `docs/contracts/` — machine-readable contracts and event registries (v0 + v1)
- `docs/implementation/v0-{development-spec,status}.md`, `vertical-slice-v0.md` — v0 spec/state
- `docs/implementation/v1-{development-spec,module-breakdown,status}.md`, `vertical-slice-v1.md` — v1 spec/state and "Next Agent" notes
