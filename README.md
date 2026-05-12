# Multi-LLM Agent Workflow

[中文配置与使用指南](README.zh-CN.md)

This repository contains the v0 and v1 local CLI implementation, implementation plans, and contracts for a multi-agent workflow system that coordinates official agent tools such as Codex CLI, Claude Code, Gemini, Copilot-style tools, and local models.

The core principle is **orchestration, not interception**:

- Launch official tools as supervised workers.
- Isolate each run in a git worktree.
- Exchange state through `.agent-workflow/`, events, and artifacts.
- Keep the first implementation narrow enough to run end to end.

## Status

v0 is implemented as a local single-agent CLI workflow:

```text
agentflow run <work_order.json> --agent <agent.yaml|agent.json> [--database <path>]
```

It supports one supervised official CLI agent in one-shot mode, isolated git worktrees, `.agent-workflow/` task capsules, SQLite event/run/artifact/usage persistence, bounded stdout/stderr capture, git diff artifacts, and configured verification commands.

v1 is implemented as a local queued worker workflow:

```text
agentflow run <work_order.json> --agents <agent_file_or_dir> [--database <path>]
agentflow batch <work_orders_dir> --agents <agent_file_or_dir> [--workers N] [--database <path>]
```

It adds v1 WorkOrders, AgentRegistry, Scheduler, BudgetManager, HandoffManager, Reviewer flow, TaskQueue, WorkerPool, v1 run/batch CLI wiring, terminal cleanup for accepted/failed tasks, and fake-agent integration coverage for the main v1 paths.

See [v0 Status](docs/implementation/v0-status.md) and [v1 Status](docs/implementation/v1-status.md) for current capability lists, non-goals, and test coverage.

## Quick Start

```bash
pnpm install
pnpm build
pnpm test
node dist/cli/index.js run path/to/work_order.json --agent path/to/agent.json
node dist/cli/index.js run path/to/work_order_v1.json --agents path/to/agents/
node dist/cli/index.js batch path/to/work_orders/ --agents path/to/agents/ --workers 2
```

## Documentation Map

- [Architecture Blueprint](docs/architecture/multi-agent-llm-workflow-design.md)  
  Full product and architecture design.

- [Technology Stack Decision](docs/decisions/0001-technology-stack.md)  
  Concrete stack choices for the first implementation.

- [First Vertical Slice](docs/implementation/vertical-slice-v0.md)  
  The narrow happy path to build first.

- [Second Vertical Slice](docs/implementation/vertical-slice-v1.md)
  The v1 queued worker, scheduler, reviewer, handoff, and batch path.

- [Module Implementation Details](docs/implementation/module-breakdown.md)  
  Responsibilities, inputs, outputs, and first-pass implementation details for each block.

- [v0 Development Spec](docs/implementation/v0-development-spec.md)  
  Strict module interfaces, implementation order, acceptance requirements, and review checklist for the first coding pass.

- [v1 Development Spec](docs/implementation/v1-development-spec.md)
  v1 module interfaces, CLI behavior, testing expectations, and deferred post-v1 scope.

- [v0 Status](docs/implementation/v0-status.md)  
  Current v0 capabilities, non-goals, smoke test, and Definition of Done checklist.

- [v1 Status](docs/implementation/v1-status.md)
  Current v1 capabilities, deferred items, coverage notes, and frozen v1 decisions.

- [Machine-Readable Contracts](docs/contracts/machine-readable-contracts.md)  
  Initial TypeScript/JSON-schema-shaped contracts for WorkOrder, RunManifest, AgentProfile, ArtifactRef, and EventEnvelope.

- [Event Registry](docs/contracts/event-registry.md)  
  Single source of truth for event names and required payload shape.

## v0 Flow

The first version intentionally avoids the full platform and runs only:

```text
one official CLI agent, one-shot
  -> create git worktree
  -> write .agent-workflow/work_order.md
  -> launch agent
  -> collect diff and stdout/stderr tail
  -> run one verification command
  -> write SQLite events, runs, and artifacts
```

## v1 Flow

v1 keeps the v0 path intact and adds:

```text
workflow/v1 WorkOrder(s)
  -> enqueue task(s)
  -> Scheduler picks implementer/reviewer agents from AgentRegistry
  -> WorkerPool runs isolated attempts
  -> verification and Reviewer verdict gate acceptance
  -> HandoffPacket requeues changes_requested or retryable failures
  -> terminal accepted/failed tasks clean their worktrees
```

v1.x Phase 1 adds a behavior-preserving `SandboxProvider` seam around the current git worktree environment. v1.x Phase 2 adds a read-only `SessionSnapshot` aggregation seam over existing SQLite task, run, artifact, review-context, and handoff rows. v1.x Phase 3 adds file-state-only fork-from-snapshot worktree reconstruction: a fresh worktree is prepared from snapshot base evidence plus a selected persisted diff artifact and patched through `SandboxProvider`.

Model conversation restoration, session resume, `SessionStore`, Redis/KV or external memory, Docker/micro-VM or other second sandbox adapters, Planner/Coordinator, DAG execution, and HTTP/API behavior remain deferred.

