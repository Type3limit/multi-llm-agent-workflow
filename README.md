# Multi-LLM Agent Workflow

This repository contains the v0 implementation, implementation plan, and contracts for a multi-agent workflow system that coordinates official agent tools such as Codex CLI, Claude Code, Gemini, Copilot-style tools, and local models.

The core principle is **orchestration, not interception**:

- Launch official tools as supervised workers.
- Isolate each run in a git worktree.
- Exchange state through `.agent-workflow/`, events, and artifacts.
- Keep the first implementation narrow enough to run end to end.

## v0 Status

v0 is implemented as a local single-agent CLI workflow:

```text
agentflow run <work_order.json> --agent <agent.yaml|agent.json> [--database <path>]
```

It supports one supervised official CLI agent in one-shot mode, isolated git worktrees, `.agent-workflow/` task capsules, SQLite event/run/artifact/usage persistence, bounded stdout/stderr capture, git diff artifacts, and configured verification commands.

See [v0 Status](docs/implementation/v0-status.md) for the current capability list, non-goals, and a fake-agent smoke test.

## Quick Start

```bash
pnpm install
pnpm build
pnpm test
node dist/cli/index.js run path/to/work_order.json --agent path/to/agent.json
```

## Documentation Map

- [Architecture Blueprint](docs/architecture/multi-agent-llm-workflow-design.md)  
  Full product and architecture design.

- [Technology Stack Decision](docs/decisions/0001-technology-stack.md)  
  Concrete stack choices for the first implementation.

- [First Vertical Slice](docs/implementation/vertical-slice-v0.md)  
  The narrow happy path to build first.

- [Module Implementation Details](docs/implementation/module-breakdown.md)  
  Responsibilities, inputs, outputs, and first-pass implementation details for each block.

- [v0 Development Spec](docs/implementation/v0-development-spec.md)  
  Strict module interfaces, implementation order, acceptance requirements, and review checklist for the first coding pass.

- [v0 Status](docs/implementation/v0-status.md)  
  Current v0 capabilities, non-goals, smoke test, and Definition of Done checklist.

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

Everything else should be added only after this path works.

