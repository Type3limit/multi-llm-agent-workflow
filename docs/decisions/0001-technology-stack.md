# 0001. Technology Stack Decision

## Status

Accepted for the first vertical slice.

## Goal

Pick one concrete stack for the first implementation so the project does not start with branching choices such as TypeScript vs Python, SQLite vs Postgres, or CLI vs daemon.

## Decision

The first implementation uses:

| Layer | Choice | Reason |
|---|---|---|
| Language | TypeScript | Strong enough typing for contracts, good CLI ecosystem, easy JSON handling. |
| Runtime | Node.js LTS | Cross-platform, works well on Windows/macOS/Linux, good process supervision APIs. |
| Package manager | pnpm | Fast, deterministic lockfile, good monorepo ergonomics if packages split later. |
| Entry point | CLI first | Avoid daemon/API complexity until the happy path works. |
| CLI framework | Commander or built-in argument parsing | Keep the CLI simple; no TUI in v0. |
| Validation | Zod | Runtime validation plus TypeScript inference for WorkOrder/Event contracts. |
| Database | SQLite | Single-file persistence, easy local development, enough for v0 event log. |
| SQLite driver | better-sqlite3 | Simple synchronous API; fine for a local orchestrator v0. |
| Artifact store | Local filesystem | Simple, inspectable, no object-store dependency. |
| Process runner | execa or Node child_process wrapper | Needed to launch official CLI agents and verification commands. |
| Git integration | Native `git` CLI wrapper | Git worktree behavior is best treated as the source of truth. |
| Tests | Vitest | Lightweight TypeScript test runner. |
| Logging | pino or structured console JSON | v0 needs structured logs, not a full observability stack. |

## Non-Goals for v0

- No HTTP API.
- No daemon.
- No Dashboard.
- No Redis, NATS, or distributed queue.
- No Postgres.
- No managed proxy or request interception.
- No partial-diff automatic handoff.
- No long-running agent sessions.

## Why TypeScript Instead of Python

Python is viable, especially for ML-heavy systems, but the first slice is mostly:

- CLI orchestration.
- JSON schema validation.
- process supervision.
- SQLite persistence.
- filesystem and git operations.

TypeScript gives a good balance of type safety and implementation speed for those needs. Python can still be used later for local model workers, analysis helpers, or eval jobs behind an adapter boundary.

## Initial Repository Shape

Recommended once code starts:

```text
.
  docs/
  src/
    cli/
    core/
    storage/
    workspace/
    adapters/
    verification/
  schemas/
  tests/
  package.json
  pnpm-lock.yaml
```

Keep it a single package until module boundaries are proven by code.

## Migration Path

When the local CLI becomes useful:

- SQLite can remain for single-user local mode.
- Postgres can be added for team mode.
- HTTP API can wrap the same core services.
- Dashboard can consume the same SQLite/Postgres event log.
- Redis/NATS can be introduced only if multiple workers need real queue semantics.

