# v0 Status

## Supported Command

```
agentflow run <work_order.json> --agent <agent.yaml|agent.json> [--database <path>]
```

- `work_order.json` — WorkOrder JSON file (required)
- `--agent` — AgentProfile file in JSON or YAML format (required)
- `--database` — SQLite database path (optional, defaults to `<repo>/.agentflow/agentflow.sqlite`)

## Capabilities

- Validate WorkOrder and AgentProfile against v0 schemas.
- Create an isolated git worktree for each run.
- Write a task capsule (`.agent-workflow/`) with work order, constraints, manifest, and agent prompt.
- Launch one official CLI agent as a supervised child process.
- Capture agent stdout/stderr (bounded tail), git diff, and final report.
- Run configured verification commands in the worktree.
- Persist all events, run metadata, artifacts, and agent usage to SQLite.
- Exit code 0 on success, 1 on run failure, 2 on input/validation error.

## Not Supported (out of scope for v0)

- Scheduler, scoring, or queue.
- Multiple agents in a single run.
- Context Broker.
- Dashboard or HTTP API.
- Long-running sessions.
- MCP tools, managed proxy, or request interception.
- Reviewer Agent or Acceptance Verifier.
- Automatic handoff or partial-diff continuation.
- Secret scanning or prompt rollback.
- ZIP task capsule archive.
- Automatic worktree cleanup.

## Local Smoke Test with Fake Agent

1. Create a temporary git repo:

```bash
git init -b main /tmp/test-repo
cd /tmp/test-repo
echo "# README" > README.md
git add README.md && git commit -m "init"
```

2. Write `work_order.json`:

```json
{
  "schema_version": "workflow/v0",
  "task_id": "T-smoke",
  "title": "Smoke Test",
  "type": "code_change",
  "goal": "Edit README.md.",
  "acceptance_criteria": ["README is modified."],
  "repo": { "path": "/tmp/test-repo", "base_ref": "main" },
  "verification": { "commands": ["node -e \"process.exit(0)\""] },
  "agent": { "agent_id": "fake" }
}
```

3. Write `agent.json`:

```json
{
  "schema_version": "workflow/v0",
  "agent_id": "fake",
  "integration_mode": "official_cli",
  "command": {
    "executable": "node",
    "args": [
      "-e",
      "require('fs').writeFileSync('.agent-workflow/final_report.md', '# OK'); process.exit(0)",
      "{{prompt_file}}"
    ]
  },
  "capabilities": { "outer_supervised": true, "inner_tool_control": false }
}
```

4. Run:

```bash
pnpm build
node dist/cli/index.js run work_order.json --agent agent.json
```

## v0 Definition of Done

| Requirement | Status |
|---|---|
| `agentflow run work_order.json --agent agent.yaml` | ✅ |
| WorkOrder and AgentProfile schema validation | ✅ |
| Single official CLI agent, one-shot run | ✅ |
| Git worktree isolation | ✅ |
| `.agent-workflow/` task capsule | ✅ |
| Agent stdout/stderr capture (bounded tail) | ✅ |
| Git diff artifact | ✅ |
| Verification command execution | ✅ |
| SQLite persistence (task_events, agent_runs, artifacts, agent_usage) | ✅ |
| Failed run leaves snapshot data | ✅ |
| Exit codes: 0/1/2 | ✅ |
| Fake agent end-to-end test passes | ✅ |
| No Scheduler / Dashboard / MCP / multi-agent | ✅ |
