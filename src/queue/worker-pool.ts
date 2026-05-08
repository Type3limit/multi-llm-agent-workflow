import { randomUUID } from "node:crypto";
import { DefaultWorker, type Worker, type WorkerTaskHandler } from "./worker.js";
import type { TaskQueue } from "./task-queue.js";

export interface WorkerPool {
  start(workers: number): void;
  waitForAllTerminal(): Promise<void>;
  stop(graceMs?: number): Promise<void>;
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
  sleep?: (ms: number) => Promise<void>;
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
  private readonly sleepFn: (ms: number) => Promise<void>;
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
    this.sleepFn =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
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

  async waitForAllTerminal(): Promise<void> {
    if (!this.monitorQueue || this.expectedTerminalCount === undefined) {
      throw new Error(
        "waitForAllTerminal requires monitorQueue and expectedTerminalCount in constructor options.",
      );
    }

    while (this.monitorQueue.listTerminal().length < this.expectedTerminalCount) {
      await this.sleepFn(this.terminalPollMs);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
