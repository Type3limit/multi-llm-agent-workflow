# Event Registry

This file is the human-readable event registry. The codebase should later mirror it as `events.ts` or `events.schema.json`.

## Naming Rules

- `task.*` describes the user goal or DAG node.
- `run.*` describes a concrete Agent execution attempt.
- `artifact.*` describes saved files or generated outputs.
- `verification.*` describes deterministic validation.
- `agent.*` describes Agent process/profile events.
- `capability.*` describes adapter capability changes.
- `security.*` describes security findings.

## v0 Events

Only these are required for the first vertical slice.

| Event Type | Required IDs | Purpose |
|---|---|---|
| `task.created` | `task_id` | WorkOrder accepted and stored. |
| `run.created` | `task_id`, `run_id`, `agent_id` | Run row created before execution. |
| `run.started` | `task_id`, `run_id`, `agent_id` | Official CLI process launched. |
| `artifact.published` | `task_id`, `run_id` | Diff, stdout tail, stderr tail, capsule, or report saved. |
| `verification.started` | `task_id`, `run_id` | Verification command started. |
| `verification.passed` | `task_id`, `run_id` | Verification command exited successfully. |
| `verification.failed` | `task_id`, `run_id` | Verification command failed. |
| `run.completed` | `task_id`, `run_id`, `agent_id` | Run completed successfully from process perspective. |
| `run.failed` | `task_id`, `run_id`, `agent_id` | Process or orchestration failed. |
| `run.cleaned_up` | `task_id`, `run_id` | Worktree cleanup or archive completed. |

## Later Events

Do not implement these in the first slice unless needed.

| Event Type | Purpose |
|---|---|
| `task.requeued` | Task returned to queue. |
| `task.replan_requested` | Agent or verifier requests new plan. |
| `task.dependency_invalidated` | Replan invalidated downstream task. |
| `task.awaiting_human` | Human approval needed. |
| `task.human_decided` | Human made a decision. |
| `run.cancel_requested` | Run cancellation requested. |
| `agent.spawned` | Agent process spawned with credential alias. |
| `agent.anomaly_detected` | Runtime behavior looks abnormal. |
| `capability.downgraded` | Adapter feature no longer works. |
| `broker.degraded` | Context Broker degraded. |
| `prompt.rollback_triggered` | Prompt auto-rollback triggered. |
| `security.artifact_flagged` | Artifact contains suspicious instructions. |
| `security.secret_leaked` | Secret leak suspected. |
| `security.agent_quarantined` | Agent/run outputs quarantined. |

## Payload Examples

### `run.started`

```json
{
  "pid": 12345,
  "command": "claude -p <prompt_file>",
  "workspace_path": "C:/repo/.agentflow/worktrees/T-demo/R-demo",
  "started_at": "2026-04-29T01:00:00+08:00"
}
```

### `artifact.published`

```json
{
  "artifact": {
    "uri": "artifact://T-demo/R-demo/diff.patch",
    "kind": "diff",
    "checksum": "sha256:..."
  }
}
```

### `verification.failed`

```json
{
  "command": "npm test",
  "exit_code": 1,
  "output_ref": "artifact://T-demo/R-demo/verification.txt"
}
```

## Replay Rule

Events that produce external side effects must set:

```json
{
  "skip_on_replay": true
}
```

The first slice should avoid side-effect events entirely except process execution, which is not replayed.

