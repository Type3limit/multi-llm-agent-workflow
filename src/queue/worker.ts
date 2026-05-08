import { randomUUID } from "node:crypto";
import type { TaskQueue } from "./task-queue.js";
import type { TaskQueueEntry } from "../core/types.js";

export interface WorkerTaskHandler {
  handle(args: {
    workerId: string;
    entry: TaskQueueEntry;
    signal: AbortSignal;
  }): Promise<void>;
}

export interface Worker {
  readonly workerId: string;
  start(): void;
  stop(graceMs?: number): Promise<void>;
  waitUntilStopped(): Promise<void>;
}

export interface DefaultWorkerOptions {
  workerId?: string;
  queue: TaskQueue;
  handler: WorkerTaskHandler;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class DefaultWorker implements Worker {
  public readonly workerId: string;

  private readonly queue: TaskQueue;
  private readonly handler: WorkerTaskHandler;
  private readonly backoffMs: number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly stopWaiters = new Set<() => void>();

  private stopRequested = false;
  private started = false;
  private running = false;
  private currentAbortController: AbortController | undefined;
  private stoppedPromise: Promise<void> = Promise.resolve();
  private resolveStopped: () => void = () => {};

  constructor(options: DefaultWorkerOptions) {
    this.workerId = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.queue = options.queue;
    this.handler = options.handler;
    this.backoffMs = options.backoffMs ?? 200;
    this.sleepFn =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.running = true;
    this.stopRequested = false;
    this.stoppedPromise = new Promise<void>((resolve) => {
      this.resolveStopped = resolve;
    });

    void this.loop();
  }

  async stop(graceMs?: number): Promise<void> {
    this.stopRequested = true;
    this.wakeStopWaiters();

    if (!this.running) {
      await this.stoppedPromise;
      return;
    }

    if (graceMs === undefined) {
      await this.stoppedPromise;
      return;
    }

    const stoppedBeforeGrace = await this.waitUntilStoppedOrTimeout(graceMs);
    if (!stoppedBeforeGrace) {
      this.currentAbortController?.abort();
      this.wakeStopWaiters();
    }

    await this.stoppedPromise;
  }

  async waitUntilStopped(): Promise<void> {
    await this.stoppedPromise;
  }

  private async loop(): Promise<void> {
    try {
      while (!this.stopRequested) {
        const entry = this.queue.claim(this.workerId);
        if (!entry) {
          await this.waitForBackoff();
          continue;
        }

        const abortController = new AbortController();
        this.currentAbortController = abortController;

        try {
          await this.handler.handle({
            workerId: this.workerId,
            entry,
            signal: abortController.signal,
          });
        } catch {
          this.releaseAfterHandlerFailure(entry);
          if (!this.stopRequested) {
            await this.waitForBackoff();
          }
        } finally {
          if (this.currentAbortController === abortController) {
            this.currentAbortController = undefined;
          }
        }
      }
    } finally {
      this.running = false;
      this.wakeStopWaiters();
      this.resolveStopped();
    }
  }

  private releaseAfterHandlerFailure(entry: TaskQueueEntry): void {
    try {
      this.queue.release(entry.task_id, {
        status: "queued",
        current_owner_run_id: null,
        lease_expires_at: null,
      });
    } catch {
      // Best effort only. The handler or another component may already have moved the entry.
    }
  }

  private async waitForBackoff(): Promise<void> {
    if (this.stopRequested) {
      return;
    }

    const stopWaiter = this.createStopWaiter();
    try {
      await Promise.race([this.sleepFn(this.backoffMs), stopWaiter.promise]);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
      stopWaiter.dispose();
    }
  }

  private createStopWaiter(): { promise: Promise<void>; dispose: () => void } {
    if (this.stopRequested) {
      return { promise: Promise.resolve(), dispose: () => {} };
    }

    let resolvePromise: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    this.stopWaiters.add(resolvePromise);

    return {
      promise,
      dispose: () => {
        this.stopWaiters.delete(resolvePromise);
      },
    };
  }

  private wakeStopWaiters(): void {
    for (const resolve of this.stopWaiters) {
      resolve();
    }
    this.stopWaiters.clear();
  }

  private async waitUntilStoppedOrTimeout(timeoutMs: number): Promise<boolean> {
    if (timeoutMs <= 0) {
      return false;
    }

    return await Promise.race([
      this.stoppedPromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }
}
