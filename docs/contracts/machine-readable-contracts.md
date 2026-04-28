# Machine-Readable Contracts

The full architecture uses many concepts. The first implementation should define only the contracts needed by the vertical slice.

Use TypeScript types plus Zod schemas. JSON Schema can be generated later if needed.

## WorkOrder

```ts
export type WorkOrder = {
  schema_version: "workflow/v0";
  task_id: string;
  project_id?: string;
  title: string;
  type: "code_change" | "docs_update" | "research_report" | "ui_review" | "data_analysis";
  goal: string;
  acceptance_criteria: string[];
  repo: {
    path: string;
    base_ref?: string;
  };
  constraints?: {
    allowed_paths?: string[];
    forbidden_paths?: string[];
    max_files_to_touch?: number;
  };
  verification?: {
    commands: string[];
    timeout_seconds?: number;
  };
  agent: {
    agent_id: string;
  };
  budget?: {
    max_wall_time_minutes?: number;
    max_output_bytes?: number;
  };
};
```

## AgentProfile

```ts
export type AgentProfile = {
  schema_version: "workflow/v0";
  agent_id: string;
  integration_mode: "official_cli";
  command: {
    executable: string;
    args: string[];
    cwd?: string;
  };
  environment?: {
    set?: Record<string, string>;
    unset?: string[];
  };
  capabilities: {
    outer_supervised: true;
    inner_tool_control: false;
  };
  limits?: {
    timeout_seconds?: number;
    max_stdout_bytes?: number;
    max_stderr_bytes?: number;
  };
};
```

## RunManifest

```ts
export type RunManifest = {
  schema_version: "agent-workflow/1";
  run_id: string;
  task_id: string;
  project_id: string;
  agent_id: string;
  integration_mode: "official_cli";
  workspace_uri: string;
  base_commit: string;
  branch: string;
  work_order_hash: string;
  adapter_version: string;
  binary_version?: string;
  started_at: string;
  ended_at?: string | null;
  status: "preparing" | "running" | "succeeded" | "failed" | "cancelled";
};
```

## ArtifactRef

```ts
export type ArtifactRef = {
  uri: string;
  kind:
    | "diff"
    | "stdout_tail"
    | "stderr_tail"
    | "verification_output"
    | "task_capsule"
    | "final_report";
  checksum?: string;
  summary?: string;
};
```

## EventEnvelope

```ts
export type EventEnvelope<TPayload = unknown> = {
  event_id: string;
  event_type: string;
  project_id: string;
  task_id?: string;
  run_id?: string;
  agent_id?: string;
  correlation_id?: string;
  causation_id?: string;
  side_effect_type?: string;
  skip_on_replay?: boolean;
  payload: TPayload;
  created_at: string;
};
```

## Design Rule

Every persisted object must include a `schema_version`.

Every Agent execution attempt must have a `run_id`.

Every EventLog insert must validate:

- event type is registered.
- required ids are present.
- payload matches the event schema.

