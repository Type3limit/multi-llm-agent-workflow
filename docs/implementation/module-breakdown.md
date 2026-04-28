# Module Implementation Details

## 1. CLI Entry

Initial command:

```text
agentflow run path/to/work_order.json --agent path/to/agent.yaml
```

Responsibilities:

- load config.
- validate WorkOrder.
- open SQLite database.
- create task/run records.
- call the orchestrator service.
- print final run summary.

Do not implement a daemon or HTTP API in v0.

## 2. Core Domain

Owns pure types and state transitions:

- `WorkOrder`
- `RunManifest`
- `AgentProfile`
- `EventEnvelope`
- `ArtifactRef`
- task/run status enums

Rules:

- task status and run status are separate.
- every execution attempt has a `run_id`.
- process lifecycle events use `run.*`.
- user-goal lifecycle events use `task.*`.

## 3. Event Log

Persistence: SQLite.

Minimum table:

```sql
create table task_events (
  id text primary key,
  project_id text not null,
  task_id text,
  run_id text,
  event_type text not null,
  payload_json text not null,
  correlation_id text,
  causation_id text,
  side_effect_type text,
  skip_on_replay integer not null default 0,
  created_at text not null
);
```

Implementation details:

- event types must come from the event registry.
- payloads are validated before insert.
- append-only in normal operation.
- replay handlers must ignore side effects.

## 4. Run Store

Minimum table:

```sql
create table agent_runs (
  id text primary key,
  project_id text not null,
  task_id text not null,
  agent_id text not null,
  status text not null,
  workspace_path text,
  base_commit text,
  branch_name text,
  run_manifest_ref text,
  started_at text,
  ended_at text
);
```

Implementation details:

- create run before launching the agent.
- update status from `preparing` to `running`, then `succeeded` or `failed`.
- do not overwrite previous runs for the same task.

## 5. Artifact Store

v0 storage:

```text
.agentflow/
  artifacts/
    T-demo-001/
      R-demo-001/
        diff.patch
        stdout.tail.txt
        stderr.tail.txt
        verification.txt
        task-capsule.zip
```

Responsibilities:

- save text artifacts.
- save diff.
- save task capsule archive.
- compute checksum.
- return `artifact://...` refs.

## 6. Git Worktree Manager

Responsibilities:

- resolve repo path.
- read base commit.
- create branch name like `agent/T-demo-001/R-demo-001`.
- create worktree under `.agentflow/worktrees/...`.
- run `git status --porcelain`.
- collect `git diff`.
- remove worktree only after artifacts are saved.

Important:

- never run destructive cleanup before snapshot.
- `.agent-workflow/` must be excluded from git tracking.

## 7. Task Capsule Writer

Writes:

```text
.agent-workflow/
  work_order.md
  constraints.json
  run_manifest.json
  progress.jsonl
  final_report.md
  artifacts/
```

`work_order.md` should be human-readable and include:

- goal.
- acceptance criteria.
- allowed/forbidden paths.
- verification command.
- expected final report location.

## 8. Official CLI Adapter

Responsibilities:

- render prompt file.
- spawn official CLI process.
- set isolated environment variables.
- stream stdout/stderr to rotating buffers.
- enforce timeout.
- return process result.

v0 does not need:

- MCP.
- JSON event mode.
- interactive TUI.
- managed proxy.

## 9. Verification Runner

Responsibilities:

- run configured verification commands after agent exits.
- capture exit code and output.
- write `verification.passed` or `verification.failed`.

v0 only needs one command list from WorkOrder.

## 10. Orchestrator Service

For v0 this can be a simple function:

```text
runWorkOrder(workOrder, agentProfile)
```

Steps:

1. validate inputs.
2. create task/run.
3. create worktree.
4. write task capsule.
5. launch agent.
6. collect diff/output.
7. run verification.
8. persist artifacts/events.
9. print result.

No Scheduler class is required until there is a second Agent.

