# v0 Development Spec

This document is the implementation handoff for inexpensive coding agents. It is stricter than the architecture notes and should be treated as the source of truth for v0 code review.

## Goal

Build a local CLI that can run one official CLI agent in one isolated git worktree, collect the result, run verification, and persist enough evidence for review.

The required command is:

```text
agentflow run path/to/work_order.json --agent path/to/agent.yaml
```

## Non-Goals

Do not implement these in v0:

- Scheduler scoring.
- More than one agent per run.
- Context Broker.
- Dashboard or HTTP API.
- Long-running sessions.
- MCP tools.
- Managed proxy or request interception.
- Reviewer Agent.
- Acceptance Verifier.
- Automatic handoff or partial-diff continuation.
- Secret scanning.
- Prompt rollback.

## Recommended File Layout

```text
src/
  cli/
    index.ts
    run-command.ts
  core/
    ids.ts
    schemas.ts
    types.ts
    events.ts
    orchestrator.ts
  storage/
    database.ts
    migrations.ts
    event-log.ts
    run-store.ts
    artifact-store.ts
  workspace/
    git-worktree-manager.ts
    task-capsule-writer.ts
  adapters/
    official-cli-adapter.ts
  verification/
    verification-runner.ts
tests/
  unit/
  integration/
```

The exact filenames may vary, but these module boundaries should not be collapsed into one large script.

## Implementation Order

1. Project scaffold: `package.json`, TypeScript config, test setup, CLI entry.
2. Core contracts: Zod schemas, TypeScript types, event registry constants.
3. SQLite schema and migration runner.
4. `EventLog`, `RunStore`, and `ArtifactStore`.
5. `GitWorktreeManager`.
6. `TaskCapsuleWriter`.
7. `OfficialCliAdapter`.
8. `VerificationRunner`.
9. `runWorkOrder()` orchestration function.
10. End-to-end fixture using a tiny local repository and a fake agent command.

Do not start with the real Claude/Codex/Gemini adapter behavior. First prove the full path with a fake executable that writes a file and exits.

## Core Contracts

Implement the contracts from `docs/contracts/machine-readable-contracts.md` as Zod schemas plus inferred TypeScript types.

Required exported APIs:

```ts
export const WorkOrderSchema: z.ZodType<WorkOrder>;
export const AgentProfileSchema: z.ZodType<AgentProfile>;
export const RunManifestSchema: z.ZodType<RunManifest>;
export const ArtifactRefSchema: z.ZodType<ArtifactRef>;
export const EventEnvelopeSchema: z.ZodType<EventEnvelope>;

export function parseWorkOrder(input: unknown): WorkOrder;
export function parseAgentProfile(input: unknown): AgentProfile;
```

Rules:

- Reject unsupported `schema_version`.
- Default `project_id` to `default` if absent.
- Reject an `AgentProfile` unless `integration_mode` is `official_cli`, `outer_supervised` is `true`, and `inner_tool_control` is `false`.
- Do not silently drop unknown fields in persisted payloads unless the schema explicitly chooses passthrough.

## Event Registry

Implement the v0 event names from `docs/contracts/event-registry.md`.

Required exported APIs:

```ts
export const V0_EVENT_TYPES: readonly string[];
export function assertKnownEventType(eventType: string): void;
export function assertRequiredEventIds(event: EventEnvelope): void;
```

Minimum validation:

- `task.created` requires `task_id`.
- `run.created`, `run.started`, `run.completed`, and `run.failed` require `task_id`, `run_id`, and `agent_id`.
- `artifact.published`, `verification.started`, `verification.passed`, `verification.failed`, and `run.cleaned_up` require `task_id` and `run_id`.

## SQLite Persistence

Use SQLite through `better-sqlite3`.

Required tables:

```sql
create table if not exists task_events (
  id text primary key,
  project_id text not null,
  task_id text,
  run_id text,
  agent_id text,
  event_type text not null,
  payload_json text not null,
  correlation_id text,
  causation_id text,
  side_effect_type text,
  skip_on_replay integer not null default 0,
  created_at text not null
);

create table if not exists agent_runs (
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

create table if not exists artifacts (
  id text primary key,
  project_id text not null,
  task_id text not null,
  run_id text not null,
  kind text not null,
  uri text not null,
  path text not null,
  checksum text,
  summary text,
  created_at text not null
);

create table if not exists agent_usage (
  id text primary key,
  project_id text not null,
  task_id text not null,
  run_id text not null,
  agent_id text not null,
  wall_time_ms integer,
  exit_code integer,
  timed_out integer not null default 0,
  stdout_bytes integer not null default 0,
  stderr_bytes integer not null default 0,
  created_at text not null
);
```

Required exported APIs:

```ts
export function openDatabase(path: string): Database;
export function migrate(database: Database): void;
```

## EventLog

Required exported API:

```ts
export interface EventLog {
  append(event: EventEnvelope): void;
  listByRun(projectId: string, runId: string): EventEnvelope[];
}
```

Acceptance requirements:

- Validate event type and required ids before insert.
- Store payload as JSON.
- Preserve insertion order by `created_at` and row insertion.
- Do not update or delete events during normal operation.

## RunStore

Required exported API:

```ts
export type RunStatus = "preparing" | "running" | "succeeded" | "failed" | "cancelled";

export interface RunRecord {
  id: string;
  project_id: string;
  task_id: string;
  agent_id: string;
  status: RunStatus;
  workspace_path?: string;
  base_commit?: string;
  branch_name?: string;
  run_manifest_ref?: string;
  started_at?: string;
  ended_at?: string;
}

export interface RunStore {
  create(record: RunRecord): void;
  updateStatus(runId: string, status: RunStatus, patch?: Partial<RunRecord>): void;
  get(runId: string): RunRecord | undefined;
}
```

Acceptance requirements:

- A run is created before launching the agent.
- Runs for the same task are never overwritten.
- Terminal statuses are `succeeded`, `failed`, and `cancelled`.

## ArtifactStore

Store artifacts under the target repository, not under this orchestrator repository:

```text
<repo>/.agentflow/artifacts/<task_id>/<run_id>/
```

Required exported API:

```ts
export type ArtifactKind =
  | "diff"
  | "stdout_tail"
  | "stderr_tail"
  | "verification_output"
  | "task_capsule"
  | "final_report";

export interface ArtifactStore {
  saveText(args: {
    projectId: string;
    taskId: string;
    runId: string;
    kind: ArtifactKind;
    filename: string;
    content: string;
    summary?: string;
  }): ArtifactRef;

  saveFile(args: {
    projectId: string;
    taskId: string;
    runId: string;
    kind: ArtifactKind;
    sourcePath: string;
    filename: string;
    summary?: string;
  }): ArtifactRef;
}
```

Acceptance requirements:

- Compute `sha256:<hex>` checksum for every artifact.
- Insert one `artifacts` row per saved artifact.
- Return a URI shaped like `artifact://<task_id>/<run_id>/<filename>`.

## GitWorktreeManager

Required exported API:

```ts
export interface PreparedWorktree {
  repoPath: string;
  workspacePath: string;
  baseCommit: string;
  branchName: string;
}

export interface GitWorktreeManager {
  prepare(args: {
    repoPath: string;
    baseRef?: string;
    taskId: string;
    runId: string;
  }): PreparedWorktree;

  statusPorcelain(workspacePath: string): string;
  diff(workspacePath: string): string;
  cleanup(workspacePath: string): void;
}
```

Acceptance requirements:

- Resolve `repoPath` to an absolute path.
- Read `baseCommit` before creating the worktree.
- Create branch name `agent/<task_id>/<run_id>`.
- Create worktree under `<repo>/.agentflow/worktrees/<task_id>/<run_id>`.
- Add `.agent-workflow/` to the worktree `.git/info/exclude` or an equivalent untracked exclusion.
- Never call `cleanup()` before diff, stdout/stderr, verification output, and task capsule have been saved.

## TaskCapsuleWriter

Required exported API:

```ts
export interface TaskCapsuleWriter {
  write(args: {
    workspacePath: string;
    workOrder: WorkOrder;
    runManifest: RunManifest;
  }): {
    capsulePath: string;
    workOrderPath: string;
    runManifestPath: string;
    promptPath: string;
  };
}
```

Required files:

```text
.agent-workflow/
  work_order.md
  constraints.json
  run_manifest.json
  progress.jsonl
  final_report.md
  artifacts/
  prompt.md
```

`prompt.md` must tell the agent:

- Read `.agent-workflow/work_order.md`.
- Respect allowed and forbidden paths.
- Write the final report to `.agent-workflow/final_report.md`.
- Do not commit changes.
- Do not modify `.agent-workflow/run_manifest.json`.

## OfficialCliAdapter

Required exported API:

```ts
export interface AgentProcessResult {
  exitCode: number | null;
  signal?: string | null;
  timedOut: boolean;
  stdoutTail: string;
  stderrTail: string;
  stdoutBytes: number;
  stderrBytes: number;
  wallTimeMs: number;
}

export interface OfficialCliAdapter {
  run(args: {
    agentProfile: AgentProfile;
    workspacePath: string;
    promptFile: string;
    timeoutSeconds?: number;
  }): Promise<AgentProcessResult>;
}
```

Acceptance requirements:

- Replace `{{prompt_file}}` in command args with the absolute prompt path.
- Run the process with `cwd` set to the worktree unless `agentProfile.command.cwd` is explicitly set.
- Apply `environment.set` and `environment.unset`.
- Capture stdout/stderr tails without keeping unbounded output in memory.
- Enforce timeout from `agentProfile.limits.timeout_seconds`, then `workOrder.budget.max_wall_time_minutes`, then a conservative default.
- Return process result instead of throwing for non-zero exit code.
- Throw only for orchestration errors, such as executable not found or spawn failure.

## VerificationRunner

Required exported API:

```ts
export interface VerificationResult {
  passed: boolean;
  commandResults: Array<{
    command: string;
    exitCode: number | null;
    timedOut: boolean;
    output: string;
    wallTimeMs: number;
  }>;
}

export interface VerificationRunner {
  run(args: {
    workspacePath: string;
    commands: string[];
    timeoutSeconds?: number;
  }): Promise<VerificationResult>;
}
```

Acceptance requirements:

- Run commands after the agent exits.
- Stop at the first failed command in v0.
- Capture combined stdout/stderr output.
- Use the worktree as `cwd`.
- If no commands are configured, return `passed: true` with an empty result list.

## Orchestrator

Required exported API:

```ts
export interface RunWorkOrderResult {
  projectId: string;
  taskId: string;
  runId: string;
  status: "succeeded" | "failed";
  workspacePath: string;
  artifacts: ArtifactRef[];
  verificationPassed: boolean;
}

export async function runWorkOrder(args: {
  workOrder: WorkOrder;
  agentProfile: AgentProfile;
  databasePath?: string;
}): Promise<RunWorkOrderResult>;
```

Required event sequence for a successful process run:

```text
task.created
run.created
run.started
artifact.published   # stdout tail
artifact.published   # stderr tail
artifact.published   # diff
artifact.published   # final report, if present
artifact.published   # task capsule
verification.started # if commands exist
verification.passed  # or verification.failed
artifact.published   # verification output, if commands exist
run.completed        # process perspective only
run.cleaned_up       # if cleanup/archive completed
```

If the agent process fails to launch, still persist `run.failed` and any available snapshot artifacts.

## CLI

Required behavior:

- Exit code `0` only when orchestration succeeds and verification passes.
- Exit code `1` when the agent exits non-zero or verification fails.
- Exit code `2` when input validation fails.
- Print a concise summary containing task id, run id, status, artifact directory, and verification result.

## Testing Requirements

Minimum tests before v0 can be considered complete:

- Schema tests reject malformed `WorkOrder` and `AgentProfile`.
- Event registry rejects unknown event types and missing required ids.
- Migration test creates all required tables.
- ArtifactStore saves content, computes checksum, and inserts metadata.
- GitWorktreeManager creates an isolated worktree and excludes `.agent-workflow/`.
- TaskCapsuleWriter writes all required files.
- OfficialCliAdapter runs a fake local command and captures stdout/stderr.
- VerificationRunner passes and fails with simple commands.
- End-to-end test uses a tiny fixture repo plus a fake agent that edits a file.

## Review Checklist

Use this checklist when reviewing implementation from another agent:

- The implementation follows the v0 scope and does not add Scheduler, Dashboard, MCP, or multi-agent behavior.
- Every persisted object has a `schema_version` when the contract requires it.
- Every run has a unique `run_id`.
- The worktree path is outside the normal working checkout and under `.agentflow/worktrees`.
- `.agent-workflow/` is not tracked by git.
- Non-zero agent exit is recorded as a failed run, not an uncaught crash.
- Artifacts are saved before cleanup.
- SQLite rows exist for `task_events`, `agent_runs`, `artifacts`, and `agent_usage`.
- Verification runs in the worktree after the agent exits.
- Tests use fake agents before relying on real paid CLI agents.
