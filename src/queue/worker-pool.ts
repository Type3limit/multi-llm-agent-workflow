import { randomUUID } from "node:crypto";
import { DefaultWorker, type Worker, type WorkerTaskHandler } from "./worker.js";
import type { TaskQueue } from "./task-queue.js";
import { OperationAbortedError, throwIfAborted } from "../core/abort-error.js";

export interface WorkerPool {
  start(workers: number): void;
  waitForAllTerminal(options?: WaitForAllTerminalOptions): Promise<void>;
  stop(graceMs?: number): Promise<void>;
}

export interface WaitForAllTerminalOptions {
  signal?: AbortSignal;
}

export interface WorkerServiceFactory {
  create(workerId: string, index: number): {
    queue: TaskQueue;
    handler: WorkerTaskHandler;
  };
  close?(workerId: string): void;
}

export interface DefaultWorkerPoolOptions {
  factory: WorkerServiceFactory;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  createWorker?: (args: {
    workerId: string;
    queue: TaskQueue;
    handler: WorkerTaskHandler;
    sleep: (ms: number) => Promise<void>;
  }) => Worker;
  expectedTerminalCount?: number;
  monitorQueue?: Pick<TaskQueue, "listTerminal">;
  terminalPollMs?: number;
}

interface WorkerStartupRecord {
  workerId: string;
  worker?: Worker;
}

export class DefaultWorkerPool implements WorkerPool {
  private readonly factory: WorkerServiceFactory;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly createWorkerFn: NonNullable<DefaultWorkerPoolOptions["createWorker"]>;
  private readonly expectedTerminalCount: number | undefined;
  private readonly monitorQueue: Pick<TaskQueue, "listTerminal"> | undefined;
  private readonly terminalPollMs: number;

  private readonly workers: Worker[] = [];
  private started = false;
  private stopped = false;
  private pendingStartFailureCleanup: Promise<void> = Promise.resolve();

  constructor(options: DefaultWorkerPoolOptions) {
    this.factory = options.factory;
    this.sleepFn = options.sleep ?? abortableDelay;
    this.createWorkerFn =
      options.createWorker ??
      ((args) =>
        new DefaultWorker({
          workerId: args.workerId,
          queue: args.queue,
          handler: args.handler,
          sleep: args.sleep,
        }));
    this.expectedTerminalCount = options.expectedTerminalCount;
    this.monitorQueue = options.monitorQueue;
    this.terminalPollMs = options.terminalPollMs ?? 200;
  }

  start(workers: number): void {
    if (this.started) {
      throw new Error("WorkerPool already started. Create a new pool for a new run.");
    }
    if (!Number.isInteger(workers) || workers < 1 || workers > 16) {
      throw new Error(`Worker count must be between 1 and 16, got ${workers}`);
    }

    this.started = true;
    const records: WorkerStartupRecord[] = [];

    try {
      for (let index = 0; index < workers; index++) {
        const workerId = `worker-${randomUUID().slice(0, 8)}`;
        const services = this.factory.create(workerId, index);
        const record: WorkerStartupRecord = { workerId };
        records.push(record);
        record.worker = this.createWorkerFn({
          workerId,
          queue: services.queue,
          handler: services.handler,
          sleep: this.sleepFn,
        });
      }

      for (const record of records) {
        record.worker?.start();
      }

      this.workers.push(...records.map((record) => record.worker).filter((worker): worker is Worker => worker !== undefined));
    } catch (error) {
      this.pendingStartFailureCleanup = this.cleanupAfterStartFailure(records);
      throw error;
    }
  }

  async waitForAllTerminal(options: WaitForAllTerminalOptions = {}): Promise<void> {
    if (!this.monitorQueue || this.expectedTerminalCount === undefined) {
      throw new Error(
        "waitForAllTerminal requires monitorQueue and expectedTerminalCount in constructor options.",
      );
    }

    throwIfAborted(options.signal);
    while (this.monitorQueue.listTerminal().length < this.expectedTerminalCount) {
      await waitForPromiseOrAbort(this.sleepFn(this.terminalPollMs, options.signal), options.signal);
      await abortableDelay(0, options.signal);
      throwIfAborted(options.signal);
    }
  }

  async stop(graceMs?: number): Promise<void> {
    await this.pendingStartFailureCleanup;

    if (this.stopped) {
      return;
    }
    this.stopped = true;

    await Promise.all(
      this.workers.map(async (worker) => {
        await worker.stop(graceMs);
        await worker.waitUntilStopped();
      }),
    );

    for (const worker of this.workers) {
      try {
        this.factory.close?.(worker.workerId);
      } catch {
        // Best effort close. Later orchestration can surface close errors if needed.
      }
    }
  }

  private async cleanupAfterStartFailure(records: WorkerStartupRecord[]): Promise<void> {
    for (const record of [...records].reverse()) {
      if (record.worker) {
        try {
          await record.worker.stop(0);
          await record.worker.waitUntilStopped();
        } catch {
          // Best effort cleanup. The original start error remains the important failure.
        }
      }

      try {
        this.factory.close?.(record.workerId);
      } catch {
        // Best effort cleanup. The original start error remains the important failure.
      }
    }
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(new OperationAbortedError());
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForPromiseOrAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  if (!signal) {
    return await promise;
  }

  let onAbort: () => void = () => {};
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new OperationAbortedError());
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
