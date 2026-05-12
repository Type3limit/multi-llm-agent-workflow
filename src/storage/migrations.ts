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

const V1_SCHEMA = `
create table if not exists task_queue (
  task_id text primary key,
  project_id text not null,
  status text not null,
  next_role text not null,
  current_owner_run_id text,
  lease_expires_at text,
  attempts integer not null default 0,
  enqueued_at text not null,
  updated_at text not null,
  workorder_json text not null,
  review_context_json text,
  handoff_packet_uri text
);

create index if not exists task_queue_status_lease_idx
  on task_queue(status, lease_expires_at);

create table if not exists agent_metrics (
  id integer primary key autoincrement,
  agent_id text not null,
  run_id text not null,
  success integer not null,
  wall_time_ms integer not null,
  actual_cost_units real,
  created_at text not null
);

create index if not exists agent_metrics_agent_id_idx
  on agent_metrics(agent_id, created_at);

create table if not exists task_budget (
  task_id text primary key,
  runs_used integer not null default 0,
  wall_time_ms_used integer not null default 0,
  cost_units_used real not null default 0,
  max_runs integer not null,
  max_wall_time_ms integer not null,
  max_total_cost_units real not null,
  status text not null default 'ok'
);
`;

function columnExists(db: Database, table: string, column: string): boolean {
  const rows = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

function addAgentRunsColumns(db: Database): void {
  if (!columnExists(db, "agent_runs", "role")) {
    db.exec("alter table agent_runs add column role text");
  }
  if (!columnExists(db, "agent_runs", "parent_run_id")) {
    db.exec("alter table agent_runs add column parent_run_id text");
  }
  if (!columnExists(db, "agent_runs", "handoff_packet_uri")) {
    db.exec("alter table agent_runs add column handoff_packet_uri text");
  }
}

function addTaskQueueColumns(db: Database): void {
  if (!columnExists(db, "task_queue", "review_context_json")) {
    db.exec("alter table task_queue add column review_context_json text");
  }
  if (!columnExists(db, "task_queue", "handoff_packet_uri")) {
    db.exec("alter table task_queue add column handoff_packet_uri text");
  }
}

export function migrate(database: Database): void {
  database.exec(SCHEMA);
  database.exec(V1_SCHEMA);
  addAgentRunsColumns(database);
  addTaskQueueColumns(database);
}
