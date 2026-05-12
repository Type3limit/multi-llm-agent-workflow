import { describe, expect, it } from "vitest";
import { DefaultWorker, type WorkerTaskHandler } from "../../src/queue/worker.js";
import type { TaskQueue } from "../../src/queue/task-queue.js";
import type { TaskQueueEntry } from "../../src/core/types.js";
import type { ParsedWorkOrderV1 } from "../../src/core/schemas-v1.js";

function makeEntry(taskId: string, overrides: Partial<TaskQueueEntry> = {}): TaskQueueEntry {
  return {
    task_id: taskId,
    project_id: "default",
    status: "queued",
    next_role: "implementer",
    current_owner_run_id: null,
    lease_expires_at: null,
    attempts: 0,
    enqueued_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeWorkOrder(taskId: string): ParsedWorkOrderV1 {
  return { task_id: taskId } as ParsedWorkOrderV1;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function waitFor(assertion: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!assertion()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FakeQueue implements TaskQueue {
  readonly entries: TaskQueueEntry[] = [];
  readonly releases: Array<{ taskId: string; patch: Partial<TaskQueueEntry> }> = [];
  claimCount = 0;
  moveReleasedEntriesToEnd = false;

  enqueue(args: { workOrder: ParsedWorkOrderV1; nextRole?: "implementer" | "reviewer" }): TaskQueueEntry {
    const entry = makeEntry(args.workOrder.task_id, {
      next_role: args.nextRole ?? "implementer",
    });
    this.entries.push(entry);
    return entry;
  }

  claim(workerId: string): TaskQueueEntry | null {
    this.claimCount++;
    const entry = this.entries.find((candidate) => candidate.status === "queued");
    if (!entry) {
      return null;
    }
    entry.status = "dispatched";
    entry.current_owner_run_id = workerId;
    entry.lease_expires_at = "2026-01-01T00:10:00.000Z";
    entry.updated_at = "2026-01-01T00:00:01.000Z";
    return entry;
  }

  release(taskId: string, patch: Partial<TaskQueueEntry>): void {
    const index = this.entries.findIndex((entry) => entry.task_id === taskId);
    if (index === -1) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const entry = this.entries[index];
    Object.assign(entry, patch);
    this.releases.push({ taskId, patch });

    if (this.moveReleasedEntriesToEnd) {
      this.entries.splice(index, 1);
      this.entries.push(entry);
    }
  }

  setStatus(taskId: string, status: TaskQueueEntry["status"]): void {
    const entry = this.get(taskId);
    if (!entry) {
      throw new Error(`Task not found: ${taskId}`);
    }
    entry.status = status;
  }

  get(taskId: string): TaskQueueEntry | undefined {
    return this.entries.find((entry) => entry.task_id === taskId);
  }

  getWorkOrder(taskId: string): ParsedWorkOrderV1 | undefined {
    return makeWorkOrder(taskId);
  }

  addWorkOrderExcludeAgentIds(taskId: string): ParsedWorkOrderV1 {
    return makeWorkOrder(taskId);
  }

  setReviewContext(): void {}

  getReviewContext(): undefined {
    return undefined;
  }

  setHandoffPacketUri(): void {}

  getHandoffPacketUri(): undefined {
    return undefined;
  }

  listTerminal(): TaskQueueEntry[] {
    return this.entries.filter((entry) =>
      ["accepted", "failed", "awaiting_human"].includes(entry.status),
    );
  }
}

describe("DefaultWorker", () => {
  it("claims a queued entry and passes it to the handler with the correct workerId", async () => {
    const queue = new FakeQueue();
    queue.enqueue({ workOrder: makeWorkOrder("T-1") });

    let handlerArgs: { workerId: string; entry: TaskQueueEntry } | undefined;
    const handler: WorkerTaskHandler = {
      handle: async (args) => {
        handlerArgs = { workerId: args.workerId, entry: args.entry };
      },
    };

    const worker = new DefaultWorker({
      workerId: "worker-a",
      queue,
      handler,
      backoffMs: 1,
    });

    worker.start();
    await waitFor(() => handlerArgs !== undefined);
    await worker.stop();

    expect(handlerArgs?.workerId).toBe("worker-a");
    expect(handlerArgs?.entry.task_id).toBe("T-1");
  });

  it("backs off when no entry is claimable, then claims a later entry", async () => {
    const queue = new FakeQueue();
    let sleepCalls = 0;
    let handled = false;

    const handler: WorkerTaskHandler = {
      handle: async () => {
        handled = true;
      },
    };

    const worker = new DefaultWorker({
      workerId: "worker-a",
      queue,
      handler,
      backoffMs: 1,
      sleep: async () => {
        sleepCalls++;
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
    });

    worker.start();
    await waitFor(() => sleepCalls > 0);
    queue.enqueue({ workOrder: makeWorkOrder("T-late") });
    await waitFor(() => handled);
    await worker.stop();

    expect(sleepCalls).toBeGreaterThan(0);
    expect(queue.get("T-late")?.current_owner_run_id).toBe("worker-a");
  });

  it("stop prevents additional claim calls after the current handler finishes", async () => {
    const queue = new FakeQueue();
    queue.enqueue({ workOrder: makeWorkOrder("T-1") });
    queue.enqueue({ workOrder: makeWorkOrder("T-2") });

    const handlerEntered = deferred();
    const finishHandler = deferred();
    let handleCount = 0;

    const handler: WorkerTaskHandler = {
      handle: async () => {
        handleCount++;
        handlerEntered.resolve();
        await finishHandler.promise;
      },
    };

    const worker = new DefaultWorker({
      workerId: "worker-a",
      queue,
      handler,
      backoffMs: 1,
    });

    worker.start();
    await handlerEntered.promise;
    const stopPromise = worker.stop();
    finishHandler.resolve();
    await stopPromise;

    expect(handleCount).toBe(1);
    expect(queue.get("T-2")?.status).toBe("queued");
  });

  it("handler throw releases the claimed entry back to queued with owner and lease cleared", async () => {
    const queue = new FakeQueue();
    queue.enqueue({ workOrder: makeWorkOrder("T-err") });

    const handler: WorkerTaskHandler = {
      handle: async () => {
        throw new Error("simulated failure");
      },
    };

    const worker = new DefaultWorker({
      workerId: "worker-a",
      queue,
      handler,
      backoffMs: 1,
      sleep: () => new Promise(() => {}),
    });

    worker.start();
    await waitFor(() => queue.releases.length === 1);
    await worker.stop();

    const entry = queue.get("T-err");
    expect(entry?.status).toBe("queued");
    expect(entry?.current_owner_run_id).toBeNull();
    expect(entry?.lease_expires_at).toBeNull();
  });

  it("handler throw does not permanently stop the worker loop", async () => {
    const queue = new FakeQueue();
    queue.moveReleasedEntriesToEnd = true;
    queue.enqueue({ workOrder: makeWorkOrder("T-fail") });
    queue.enqueue({ workOrder: makeWorkOrder("T-ok") });

    let firstHandled = false;
    let secondHandled = false;
    let worker: DefaultWorker;

    const handler: WorkerTaskHandler = {
      handle: async (args) => {
        if (args.entry.task_id === "T-fail") {
          firstHandled = true;
          throw new Error("fail once");
        }
        if (args.entry.task_id === "T-ok") {
          secondHandled = true;
          void worker.stop(0);
        }
      },
    };

    worker = new DefaultWorker({
      workerId: "worker-a",
      queue,
      handler,
      backoffMs: 1,
      sleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
    });

    worker.start();
    await worker.waitUntilStopped();

    expect(firstHandled).toBe(true);
    expect(secondHandled).toBe(true);
    expect(queue.releases).toHaveLength(1);
  });

  it("passes an AbortSignal to the handler and aborts it after grace expires", async () => {
    const queue = new FakeQueue();
    queue.enqueue({ workOrder: makeWorkOrder("T-signal") });

    let receivedSignal: AbortSignal | undefined;
    const handler: WorkerTaskHandler = {
      handle: async (args) => {
        receivedSignal = args.signal;
        await new Promise<void>((resolve) => {
          args.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };

    const worker = new DefaultWorker({
      workerId: "worker-a",
      queue,
      handler,
      backoffMs: 1,
    });

    worker.start();
    await waitFor(() => receivedSignal !== undefined);
    await worker.stop(5);
    await worker.waitUntilStopped();

    expect(receivedSignal?.aborted).toBe(true);
  });

  it("stop with grace waits until an abort-aware handler actually exits", async () => {
    const queue = new FakeQueue();
    queue.enqueue({ workOrder: makeWorkOrder("T-slow-abort") });

    const abortObserved = deferred();
    const finishHandler = deferred();
    let receivedSignal: AbortSignal | undefined;
    let stopResolved = false;

    const handler: WorkerTaskHandler = {
      handle: async (args) => {
        receivedSignal = args.signal;
        args.signal.addEventListener("abort", () => abortObserved.resolve(), { once: true });
        await abortObserved.promise;
        await finishHandler.promise;
      },
    };

    const worker = new DefaultWorker({
      workerId: "worker-a",
      queue,
      handler,
      backoffMs: 1,
    });

    worker.start();
    await waitFor(() => receivedSignal !== undefined);
    const stopPromise = worker.stop(5).then(() => {
      stopResolved = true;
    });

    await abortObserved.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopResolved).toBe(false);

    finishHandler.resolve();
    await stopPromise;

    expect(stopResolved).toBe(true);
  });
});
