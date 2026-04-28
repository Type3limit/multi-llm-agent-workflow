# First Vertical Slice

## Purpose

The architecture document is mature enough. The next useful step is not more architecture. It is a narrow end-to-end path that proves whether the main assumptions survive contact with a real CLI agent and a real repository.

## Scope

Build only this path:

```text
agentflow run work_order.json
  -> validate WorkOrder
  -> create task + run rows in SQLite
  -> create git worktree
  -> write .agent-workflow/work_order.md
  -> write .agent-workflow/run_manifest.json
  -> launch one official CLI Agent in one-shot mode
  -> wait for process exit
  -> collect stdout/stderr tail
  -> collect git diff
  -> run one configured verification command
  -> write events, artifacts, and run status to SQLite
```

## Explicitly Out of Scope

- Scheduler scoring.
- Context Broker.
- multiple agents.
- fallback routing.
- Handoff Quality Gate.
- partial diff continuation.
- Reviewer Agent.
- Acceptance Verifier.
- Dashboard.
- long-running sessions.
- secret scanning.
- prompt auto-rollback.

These are valuable, but they should be pulled in by real pressure from the first path, not prebuilt as empty framework.

## First Agent

Use a single official CLI Agent in one-shot mode.

The adapter should treat the agent as a black box:

- prepare the workspace.
- provide the prompt/brief.
- launch the process.
- capture output.
- collect artifacts.
- never intercept internal requests.

The exact command should be configured in `agent.yaml`, for example:

```yaml
agent_id: claude-code-local
integration_mode: official_cli
command:
  executable: claude
  args:
    - "-p"
    - "{{prompt_file}}"
capabilities:
  outer_supervised: true
  inner_tool_control: false
```

If `claude -p` is unavailable on the target machine, replace it with whichever official one-shot CLI command is actually installed. The adapter contract should not care.

## WorkOrder Example

```json
{
  "schema_version": "workflow/v0",
  "task_id": "T-demo-001",
  "title": "Fix a small known test failure",
  "type": "code_change",
  "goal": "Make the failing unit test pass with the smallest safe code change.",
  "acceptance_criteria": [
    "The configured verification command exits with code 0.",
    "The final report explains which files changed."
  ],
  "repo": {
    "path": "C:/path/to/repo",
    "base_ref": "main"
  },
  "constraints": {
    "allowed_paths": ["src/**", "tests/**"],
    "forbidden_paths": [".env", ".git/**"],
    "max_files_to_touch": 5
  },
  "verification": {
    "commands": ["npm test"]
  },
  "agent": {
    "agent_id": "claude-code-local"
  }
}
```

## Definition of Done

The first slice is done when:

- A JSON WorkOrder can start a run.
- A git worktree is created and cleaned up or archived.
- `.agent-workflow/work_order.md` and `run_manifest.json` are written.
- One official CLI Agent can be launched.
- stdout/stderr tail is captured.
- git diff is saved as an artifact.
- one verification command is executed.
- SQLite contains `task_events`, `agent_runs`, `artifacts`, and `agent_usage` rows.
- A failed run still leaves enough snapshot data for manual debugging.

## Suggested Build Order

1. Define TypeScript types and Zod schemas.
2. Create SQLite schema and migrations.
3. Implement EventLog repository.
4. Implement ArtifactStore repository.
5. Implement GitWorktreeManager.
6. Implement TaskCapsuleWriter.
7. Implement OfficialCliAdapter.
8. Implement VerificationRunner.
9. Wire `agentflow run`.
10. Test against a tiny local repository.

