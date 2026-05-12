import { spawn, execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { OperationAbortedError, throwIfAborted } from "../core/abort-error.js";

export interface VerificationResult {
  passed: boolean;
  commandResults: Array<{
    command: string;
    exitCode: number | null;
    timedOut: boolean;
    output: string;
    wallTimeMs: number;
  }>;
}

export interface VerificationRunner {
  run(args: {
    workspacePath: string;
    commands: string[];
    timeoutSeconds?: number;
    signal?: AbortSignal;
  }): Promise<VerificationResult>;
}

const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

class OutputTailBuffer {
  totalBytes = 0;
  private buf = Buffer.alloc(0);
  private max: number;

  constructor(maxBytes: number) {
    this.max = maxBytes;
  }

  append(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    const combined = Buffer.concat([this.buf, chunk]);
    if (combined.length <= this.max) {
      this.buf = combined;
    } else {
      this.buf = combined.subarray(combined.length - this.max);
    }
  }

  tailString(): string {
    return this.buf.toString("utf-8");
  }
}

function runSingleCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutSeconds: number,
  maxOutputBytes: number,
  signal?: AbortSignal,
): Promise<VerificationResult["commandResults"][0]> {
  throwIfAborted(signal);
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    let timedOut = false;
    let aborted = false;

    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const killChildTree = (): void => {
      try {
        if (child.pid) {
          if (os.platform() === "win32") {
            execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: "ignore" });
          } else {
            child.kill("SIGKILL");
          }
        }
      } catch {
        // best effort
      }
    };

    const abortHandler = (): void => {
      aborted = true;
      killChildTree();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChildTree();
    }, timeoutSeconds * 1000);

    signal?.addEventListener("abort", abortHandler, { once: true });
    if (signal?.aborted) {
      abortHandler();
    }

    const outputBuf = new OutputTailBuffer(maxOutputBytes);

    child.stdout?.on("data", (chunk: Buffer) => outputBuf.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => outputBuf.append(chunk));

    child.on("error", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
      if (aborted) {
        reject(new OperationAbortedError());
        return;
      }
      resolve({
        command,
        exitCode: null,
        timedOut: false,
        output: outputBuf.tailString(),
        wallTimeMs: Date.now() - startTime,
      });
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
      if (aborted) {
        reject(new OperationAbortedError());
        return;
      }
      const wallTimeMs = Date.now() - startTime;
      let output = outputBuf.tailString();

      if (outputBuf.totalBytes > maxOutputBytes) {
        output = `[output truncated to last ${maxOutputBytes} bytes]\n${output}`;
      }

      resolve({
        command,
        exitCode,
        timedOut,
        output,
        wallTimeMs,
      });
    });
  });
}

export class ShellVerificationRunner implements VerificationRunner {
  async run(args: {
    workspacePath: string;
    commands: string[];
    timeoutSeconds?: number;
    signal?: AbortSignal;
  }): Promise<VerificationResult> {
    throwIfAborted(args.signal);

    const ws = path.resolve(args.workspacePath);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(ws);
    } catch {
      throw new Error(`Workspace path does not exist: ${ws}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Workspace path is not a directory: ${ws}`);
    }

    if (args.commands.length === 0) {
      return { passed: true, commandResults: [] };
    }

    const timeoutSeconds = args.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    const env = { ...process.env };

    const commandResults: VerificationResult["commandResults"] = [];

    for (const command of args.commands) {
      throwIfAborted(args.signal);
      const result = await runSingleCommand(
        command,
        ws,
        env,
        timeoutSeconds,
        DEFAULT_MAX_OUTPUT_BYTES,
        args.signal,
      );
      commandResults.push(result);

      // Stop at first failure
      if (result.exitCode !== 0 || result.timedOut) {
        return {
          passed: false,
          commandResults,
        };
      }
    }

    return {
      passed: true,
      commandResults,
    };
  }
}
