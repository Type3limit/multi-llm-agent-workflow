import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Database } from "../../src/storage/database.js";
import { openDatabase } from "../../src/storage/database.js";
import { migrate } from "../../src/storage/migrations.js";
import type { TaskQueue } from "../../src/queue/task-queue.js";
import type { TaskQueueEntry } from "../../src/core/types.js";
import type { ParsedWorkOrderV1 } from "../../src/core/schemas-v1.js";
import type { Worker, WorkerTaskHandler } from "../../src/queue/worker.js";
import { DefaultWorkerPool, type WorkerServiceFactory } from "../../src/queue/worker-pool.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function makeEntry(taskId: string, status: TaskQueueEntry["status"] = "queued"): TaskQueueEntry {
  return {
    task_id: taskId,
    project_id: "default",
    status,
    next_role: "implementer",
    current_owner_run_id: null,
    lease_expires_at: null,
    attempts: 0,
    enqueued_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

class FakeQueue implements TaskQueue {
  terminalCount = 0;

  enqueue(args: { workOrder: ParsedWorkOrderV1; nextRole?: "implementer" | "reviewer" }): TaskQueueEntry {
    return makeEntry(args.workOrder.task_id);
  }

  claim(): TaskQueueEntry | null {
    return null;
  }

  release(): void {}

  setStatus(): void {}

  get(): TaskQueueEntry | undefined {
    return undefined;
  }

  listTerminal(): TaskQueueEntry[] {
    return Array.from({ length: this.terminalCount }, (_, index) =>
      makeEntry(`T-${index}`, "accepted"),
    );
  }
}

class FakeWorker implements Worker {
  started = false;
  stopCalls: Array<number | undefined> = [];
  private readonly stopped = deferred();

  constructor(
    public readonly workerId: string,
    private readonly autoResolveStop = true,
  ) {}

  start(): void {
    this.started = true;
  }

  async stop(graceMs?: number): Promise<void> {
    this.stopCalls.push(graceMs);
    if (this.autoResolveStop) {
      this.resolveStopped();
    }
  }

  async waitUntilStopped(): Promise<void> {
    await this.stopped.promise;
  }

  resolveStopped(): void {
    this.stopped.resolve();
  }
}

function noopServices(): { queue: TaskQueue; handler: WorkerTaskHandler } {
  return {
    queue: new FakeQueue(),
    handler: { handle: async () => {} },
  };
}

describe("DefaultWorkerPool", () => {
  it("rejects worker counts outside 1..16", () => {
    const pool = new DefaultWorkerPool({
      factory: { create: noopServices },
    });

    expect(() => pool.start(0)).toThrow("Worker count must be between 1 and 16");
    expect(() => pool.start(17)).toThrow("Worker count must be between 1 and 16");
  });

  it("start(N) creates exactly N workers with unique IDs", () => {
    const createdIds: string[] = [];
    const workers: FakeWorker[] = [];

    const pool = new DefaultWorkerPool({
      factory: {
        create: (workerId) => {
          createdIds.push(workerId);
          return noopServices();
        },
      },
      createWorker: (args) => {
        const worker = new FakeWorker(args.workerId);
        workers.push(worker);
        return worker;
      },
    });

    pool.start(3);

    expect(createdIds).toHaveLength(3);
    expect(new Set(createdIds).size).toBe(3);
    expect(createdIds.every((id) => id.startsWith("worker-"))).toBe(true);
    expect(workers).toHaveLength(3);
    expect(workers.every((worker) => worker.started)).toBe(true);
  });

  it("calls the service factory once per worker", () => {
    let calls = 0;
    const pool = new DefaultWorkerPool({
      factory: {
        create: () => {
          calls++;
          return noopServices();
        },
      },
      createWorker: (args) => new FakeWorker(args.workerId),
    });

    pool.start(4);

    expect(calls).toBe(4);
  });

  it("throws when started twice", () => {
    const pool = new DefaultWorkerPool({
      factory: { create: noopServices },
      createWorker: (args) => new FakeWorker(args.workerId),
    });

    pool.start(1);

    expect(() => pool.start(1)).toThrow("already started");
  });

  it("cleans up created workers and resources when start fails partway through", async () => {
    const createdWorkers: FakeWorker[] = [];
    const closedWorkerIds: string[] = [];

    const pool = new DefaultWorkerPool({
      factory: {
        create: (_workerId, index) => {
          if (index === 2) {
            throw new Error("factory boom");
          }
          return noopServices();
        },
        close: (workerId) => {
          closedWorkerIds.push(workerId);
        },
      },
      createWorker: (args) => {
        const worker = new FakeWorker(args.workerId);
        createdWorkers.push(worker);
        return worker;
      },
    });

    expect(() => pool.start(4)).toThrow("factory boom");
    await pool.stop();

    expect(createdWorkers).toHaveLength(2);
    expect(createdWorkers.every((worker) => worker.started === false)).toBe(true);
    expect(createdWorkers.map((worker) => worker.stopCalls)).toEqual([[0], [0]]);
    expect(new Set(closedWorkerIds)).toEqual(
      new Set(createdWorkers.map((worker) => worker.workerId)),
    );
  });

  it("stop stops all workers and closes per-worker resources", async () => {
    const workers: FakeWorker[] = [];
    const closedWorkerIds: string[] = [];

    const pool = new DefaultWorkerPool({
      factory: {
        create: noopServices,
        close: (workerId) => {
          closedWorkerIds.push(workerId);
        },
      },
      createWorker: (args) => {
        const worker = new FakeWorker(args.workerId);
        workers.push(worker);
        return worker;
      },
    });

    pool.start(3);
    await pool.stop(250);

    expect(workers.map((worker) => worker.stopCalls)).toEqual([[250], [250], [250]]);
    expect(closedWorkerIds).toEqual(workers.map((worker) => worker.workerId));
  });

  it("does not close per-worker resources until the worker is actually stopped", async () => {
    let worker: FakeWorker | undefined;
    const closedWorkerIds: string[] = [];

    const pool = new DefaultWorkerPool({
      factory: {
        create: noopServices,
        close: (workerId) => {
          closedWorkerIds.push(workerId);
        },
      },
      createWorker: (args) => {
        worker = new FakeWorker(args.workerId, false);
        return worker;
      },
    });

    pool.start(1);
    const stopPromise = pool.stop(5);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker?.stopCalls).toEqual([5]);
    expect(closedWorkerIds).toEqual([]);

    worker?.resolveStopped();
    await stopPromise;

    expect(closedWorkerIds).toEqual([worker?.workerId]);
  });

  it("waitForAllTerminal resolves when the expected terminal count is reached", async () => {
    const monitorQueue = new FakeQueue();
    let sleepCalls = 0;

    const pool = new DefaultWorkerPool({
      factory: { create: noopServices },
      monitorQueue,
      expectedTerminalCount: 2,
      terminalPollMs: 1,
      sleep: async () => {
        sleepCalls++;
        monitorQueue.terminalCount = 2;
      },
      createWorker: (args) => new FakeWorker(args.workerId),
    });

    await pool.waitForAllTerminal();

    expect(sleepCalls).toBe(1);
  });
});

describe("WorkerPool SQLite isolation", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("opens one WAL-enabled Database instance per worker with busy_timeout >= 5000", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-pool-db-"));
    const dbPath = path.join(tmpDir, "agentflow.sqlite");
    const databasesByWorkerId = new Map<string, Database>();
    const closedWorkerIds: string[] = [];

    const factory: WorkerServiceFactory = {
      create: (workerId) => {
        const db = openDatabase(dbPath);
        migrate(db);
        databasesByWorkerId.set(workerId, db);
        return noopServices();
      },
      close: (workerId) => {
        databasesByWorkerId.get(workerId)?.close();
        closedWorkerIds.push(workerId);
      },
    };

    const pool = new DefaultWorkerPool({
      factory,
      createWorker: (args) => new FakeWorker(args.workerId),
    });

    pool.start(4);

    const databases = [...databasesByWorkerId.values()];
    expect(databases).toHaveLength(4);
    expect(new Set(databases).size).toBe(4);

    for (const db of databases) {
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("busy_timeout", { simple: true })).toBeGreaterThanOrEqual(5000);
    }

    await pool.stop();

    expect(closedWorkerIds).toEqual([...databasesByWorkerId.keys()]);
  });
});
