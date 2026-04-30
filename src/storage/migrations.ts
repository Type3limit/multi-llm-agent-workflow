import type { Database } from "./database.js";

const SCHEMA = `
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
`;

export function migrate(database: Database): void {
  database.exec(SCHEMA);
}
