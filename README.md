# Multi-LLM Agent Workflow

This repository contains the implementation plan and contracts for a multi-agent workflow system that coordinates official agent tools such as Codex CLI, Claude Code, Gemini, Copilot-style tools, and local models.

The core principle is **orchestration, not interception**:

- Launch official tools as supervised workers.
- Isolate each run in a git worktree.
- Exchange state through `.agent-workflow/`, events, and artifacts.
- Keep the first implementation narrow enough to run end to end.

## Documentation Map

- [Architecture Blueprint](docs/architecture/multi-agent-llm-workflow-design.md)  
  Full product and architecture design.

- [Technology Stack Decision](docs/decisions/0001-technology-stack.md)  
  Concrete stack choices for the first implementation.

- [First Vertical Slice](docs/implementation/vertical-slice-v0.md)  
  The narrow happy path to build first.

- [Module Implementation Details](docs/implementation/module-breakdown.md)  
  Responsibilities, inputs, outputs, and first-pass implementation details for each block.

- [Machine-Readable Contracts](docs/contracts/machine-readable-contracts.md)  
  Initial TypeScript/JSON-schema-shaped contracts for WorkOrder, ContextPacket, RunManifest, AgentProfile, and EventEnvelope.

- [Event Registry](docs/contracts/event-registry.md)  
  Single source of truth for event names and required payload shape.

## Current Implementation Direction

The first version should not attempt the full platform. Build only:

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

