import type { Database } from "./database.js";
import type { EventEnvelope, EventPayload } from "../core/types.js";
import { EventEnvelopeSchema } from "../core/schemas.js";
import { assertKnownEventTypeV1, assertRequiredEventIds, assertV1PayloadFields } from "../core/events.js";
import { nullableString } from "./helpers.js";

interface Stmt {
  run(params: Record<string, unknown>): void;
  all(...params: unknown[]): unknown[];
}

export interface EventLog {
  append(event: EventEnvelope): void;
  listByRun(projectId: string, runId: string): EventEnvelope[];
}

export class SqliteEventLog implements EventLog {
  private insertStmt: Stmt;
  private listStmt: Stmt;

  constructor(private db: Database) {
    this.insertStmt = db.prepare(`
      insert into task_events (
        id, project_id, task_id, run_id, agent_id, event_type, payload_json,
        correlation_id, causation_id, side_effect_type, skip_on_replay, created_at
      ) values (
        @id, @project_id, @task_id, @run_id, @agent_id, @event_type, @payload_json,
        @correlation_id, @causation_id, @side_effect_type, @skip_on_replay, @created_at
      )
    `) as unknown as Stmt;

    this.listStmt = db.prepare(`
      select rowid, * from task_events
      where project_id = ? and run_id = ?
      order by created_at asc, rowid asc
    `) as unknown as Stmt;
  }

  append(event: EventEnvelope): void {
    EventEnvelopeSchema.parse(event);
    assertKnownEventTypeV1(event.event_type);
    assertRequiredEventIds(event);
    assertV1PayloadFields(event);

    this.insertStmt.run({
      id: event.event_id,
      project_id: event.project_id,
      task_id: event.task_id ?? null,
      run_id: event.run_id ?? null,
      agent_id: event.agent_id ?? null,
      event_type: event.event_type,
      payload_json: JSON.stringify(event.payload),
      correlation_id: event.correlation_id ?? null,
      causation_id: event.causation_id ?? null,
      side_effect_type: event.side_effect_type ?? null,
      skip_on_replay: event.skip_on_replay ? 1 : 0,
      created_at: event.created_at,
    });
  }

  listByRun(projectId: string, runId: string): EventEnvelope[] {
    const rows = this.listStmt.all(projectId, runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      event_id: row.id as string,
      event_type: row.event_type as string,
      project_id: row.project_id as string,
      task_id: nullableString(row.task_id),
      run_id: nullableString(row.run_id),
      agent_id: nullableString(row.agent_id),
      correlation_id: nullableString(row.correlation_id),
      causation_id: nullableString(row.causation_id),
      side_effect_type: nullableString(row.side_effect_type),
      skip_on_replay: (row.skip_on_replay as number) === 1,
      payload: JSON.parse(row.payload_json as string) as EventPayload,
      created_at: row.created_at as string,
    }));
  }
}
