import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assertRequiredEventIds } from "../../src/core/events.js";
import SqliteDatabase from "better-sqlite3";
import type { Database } from "../../src/storage/database.js";
import { migrate } from "../../src/storage/migrations.js";
import { SqliteEventLog } from "../../src/storage/event-log.js";
import type { EventEnvelope, EventPayload } from "../../src/core/types.js";

function ts(): string {
  return new Date().toISOString();
}

function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    event_id: "E-001",
    event_type: "task.created",
    project_id: "default",
    task_id: "T-1",
    payload: { hello: "world" },
    created_at: ts(),
    ...overrides,
  };
}

describe("SqliteEventLog", () => {
  let db: Database;
  let log: SqliteEventLog;

  beforeEach(() => {
    db = new SqliteDatabase(":memory:");
    migrate(db);
    log = new SqliteEventLog(db);
  });

  afterEach(() => {
    db.close();
  });

  it("appends an event and retrieves it via listByRun", () => {
    const event = makeEvent({ event_type: "task.created", task_id: "T-1" });
    log.append(event);

    const events = log.listByRun("default", "R-1");
    expect(events).toHaveLength(0); // different run_id

    // The event had no run_id set; use listByRun with matching params
    // Since task.created has no run_id, list happens via project_id + run_id
    // For this test, let's use an event with run_id
  });

  it("appends and listByRun with matching run_id", () => {
    const event = makeEvent({
      event_id: "E-run",
      event_type: "run.started",
      task_id: "T-1",
      run_id: "R-1",
      agent_id: "A-1",
      payload: {},
      created_at: ts(),
    });
    log.append(event);

    const events = log.listByRun("default", "R-1");
    expect(events).toHaveLength(1);
    expect(events[0].event_id).toBe("E-run");
    expect(events[0].payload).toEqual({});
  });

  it("throws for unknown event type and does not insert", () => {
    const event = makeEvent({
      event_type: "task.requeued",
      task_id: "T-1",
    });
    expect(() => log.append(event)).toThrow("Unknown event type");
    // Verify nothing inserted
    const count = db
      .prepare("select count(*) as c from task_events")
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("throws for missing required ids and does not insert", () => {
    const event = makeEvent({
      event_id: "E-bad",
      event_type: "run.created",
      task_id: "T-1",
      // missing run_id and agent_id
    });
    expect(() => log.append(event)).toThrow("run_id");
    const count = db
      .prepare("select count(*) as c from task_events")
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("payload round-trips through JSON", () => {
    const payload = { key: "value", nested: { num: 42 }, arr: [1, 2, 3] };
    const event = makeEvent({
      event_id: "E-payload",
      event_type: "task.created",
      task_id: "T-1",
      payload: payload as EventPayload,
    });
    log.append(event);

    // listByRun with matching empty/null run_id won't work since run_id is null.
    // Use direct SQL to verify.
    const rows = db
      .prepare("select payload_json from task_events where id = ?")
      .all("E-payload") as Array<{ payload_json: string }>;
    const parsed = JSON.parse(rows[0].payload_json);
    expect(parsed).toEqual(payload);
  });

  it("skip_on_replay round-trips", () => {
    const event = makeEvent({
      event_id: "E-skip",
      event_type: "task.created",
      task_id: "T-1",
      skip_on_replay: true,
    });
    log.append(event);

    const row = db
      .prepare("select skip_on_replay from task_events where id = ?")
      .get("E-skip") as { skip_on_replay: number };
    expect(row.skip_on_replay).toBe(1);
  });

  it("different project/run events don't mix", () => {
    log.append(
      makeEvent({
        event_id: "E-a",
        event_type: "artifact.published",
        project_id: "proj-a",
        task_id: "T-1",
        run_id: "R-1",
        payload: {},
      }),
    );
    log.append(
      makeEvent({
        event_id: "E-b",
        event_type: "artifact.published",
        project_id: "proj-b",
        task_id: "T-2",
        run_id: "R-2",
        payload: {},
      }),
    );

    const eventsA = log.listByRun("proj-a", "R-1");
    expect(eventsA).toHaveLength(1);
    expect(eventsA[0].event_id).toBe("E-a");

    const eventsB = log.listByRun("proj-b", "R-2");
    expect(eventsB).toHaveLength(1);
    expect(eventsB[0].event_id).toBe("E-b");
  });

  it("agent_id round-trips through append and listByRun", () => {
    const event = makeEvent({
      event_id: "E-agent",
      event_type: "run.started",
      task_id: "T-1",
      run_id: "R-1",
      agent_id: "agent-claude-1",
      payload: {},
    });
    log.append(event);

    const events = log.listByRun("default", "R-1");
    expect(events).toHaveLength(1);
    expect(events[0].agent_id).toBe("agent-claude-1");
  });

  it("listByRun result passes assertRequiredEventIds for run.started", () => {
    const event = makeEvent({
      event_id: "E-req",
      event_type: "run.started",
      task_id: "T-1",
      run_id: "R-1",
      agent_id: "A-1",
      payload: {},
    });
    log.append(event);

    const events = log.listByRun("default", "R-1");
    expect(events).toHaveLength(1);
    expect(() => assertRequiredEventIds(events[0])).not.toThrow();
  });

  it("missing agent_id is undefined after listByRun, not null", () => {
    const event = makeEvent({
      event_id: "E-noagent",
      event_type: "artifact.published",
      task_id: "T-1",
      run_id: "R-1",
      payload: {},
    });
    // artifact.published does not require agent_id
    log.append(event);

    const events = log.listByRun("default", "R-1");
    expect(events).toHaveLength(1);
    expect(events[0].agent_id).toBeUndefined();
    expect(events[0].agent_id).not.toBeNull();
  });

  it("events are ordered by created_at asc, rowid asc (insertion order)", () => {
    const sameTime = "2026-01-01T00:00:00Z";
    // Insert in reverse alphabetical id order
    log.append(
      makeEvent({
        event_id: "E-ZZZ",
        event_type: "artifact.published",
        task_id: "T-1",
        run_id: "R-1",
        payload: {},
        created_at: sameTime,
      }),
    );
    log.append(
      makeEvent({
        event_id: "E-AAA",
        event_type: "artifact.published",
        task_id: "T-1",
        run_id: "R-1",
        payload: {},
        created_at: sameTime,
      }),
    );

    const events = log.listByRun("default", "R-1");
    expect(events).toHaveLength(2);
    // Must be insertion order, not alphabetical by id
    expect(events[0].event_id).toBe("E-ZZZ");
    expect(events[1].event_id).toBe("E-AAA");
  });
});
