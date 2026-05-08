import { spawn } from "node:child_process";
import * as path from "node:path";
import type { ParsedAgentProfile } from "../core/schemas.js";
import type { ParsedAgentProfileV1 } from "../core/schemas-v1.js";

type RunnableAgentProfile = ParsedAgentProfile | ParsedAgentProfileV1;

export interface AgentProcessResult {
  exitCode: number | null;
  signal?: string | null;
  timedOut: boolean;
  stdoutTail: string;
  stderrTail: string;
  stdoutBytes: number;
  stderrBytes: number;
  wallTimeMs: number;
}

export interface OfficialCliAdapter {
  run(args: {
    agentProfile: RunnableAgentProfile;
    workspacePath: string;
    promptFile: string;
    timeoutSeconds?: number;
  }): Promise<AgentProcessResult>;
}

const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_STDOUT_BYTES = 64 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

function renderArgs(args: string[], promptFile: string): string[] {
  return args.map((a) => a.replaceAll("{{prompt_file}}", promptFile));
}

function timeoutMs(seconds: number): number {
  return seconds * 1000;
}

class OutputTailBuffer {
  totalBytes = 0;
  private buf = Buffer.alloc(0);
  private max: number;

  constructor(maxBytes: number) {
    this.max = maxBytes;
  }

  append(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    if (this.buf.length + chunk.length <= this.max) {
      this.buf = Buffer.concat([this.buf, chunk]);
    } else {
      // Keep only the tail: drop from the front, keep new chunk
      const combined = Buffer.concat([this.buf, chunk]);
      this.buf = combined.subarray(combined.length - this.max);
    }
  }

  tailString(): string {
    return this.buf.toString("utf-8");
  }
}

export class ChildProcessOfficialCliAdapter implements OfficialCliAdapter {
  async run(args: {
    agentProfile: RunnableAgentProfile;
    workspacePath: string;
    promptFile: string;
    timeoutSeconds?: number;
  }): Promise<AgentProcessResult> {
    const profile = args.agentProfile;
    const promptFile = path.resolve(args.promptFile);
    const workspacePath = path.resolve(args.workspacePath);

    const cwdRaw = profile.command.cwd ?? workspacePath;
    const cwd = path.resolve(cwdRaw);
    let cwdStat: import("node:fs").Stats;
    try {
      cwdStat = await import("node:fs/promises").then((fs) => fs.stat(cwd));
    } catch {
      throw new Error(`cwd does not exist: ${cwd}`);
    }
    if (!cwdStat.isDirectory()) {
      throw new Error(`cwd is not a directory: ${cwd}`);
    }

    const env = { ...process.env };
    if (profile.environment?.set) {
      Object.assign(env, profile.environment.set);
    }
    if (profile.environment?.unset) {
      for (const key of profile.environment.unset) {
        delete env[key];
      }
    }

    const timeout =
      args.timeoutSeconds ??
      profile.limits?.timeout_seconds ??
      DEFAULT_TIMEOUT_SECONDS;

    const maxStdout = profile.limits?.max_stdout_bytes ?? DEFAULT_MAX_STDOUT_BYTES;
    const maxStderr = profile.limits?.max_stderr_bytes ?? DEFAULT_MAX_STDERR_BYTES;

    const executable = profile.command.executable;
    const renderedArgs = renderArgs(profile.command.args, promptFile);

    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      let timedOut = false;
      let killed = false;

      const child = spawn(executable, renderedArgs, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.on("error", (err) => {
        if (killed) return;
        reject(
          new Error(
            `Failed to spawn "${executable}": ${err.message}`,
          ),
        );
      });

      const timer = setTimeout(() => {
        timedOut = true;
        killed = true;
        child.kill();
      }, timeoutMs(timeout));

      const stdoutBuf = new OutputTailBuffer(maxStdout);
      const stderrBuf = new OutputTailBuffer(maxStderr);

      child.stdout?.on("data", (chunk: Buffer) => stdoutBuf.append(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderrBuf.append(chunk));

      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        killed = true;

        const wallTimeMs = Date.now() - startTime;

        resolve({
          exitCode,
          signal,
          timedOut,
          stdoutTail: stdoutBuf.tailString(),
          stderrTail: stderrBuf.tailString(),
          stdoutBytes: stdoutBuf.totalBytes,
          stderrBytes: stderrBuf.totalBytes,
          wallTimeMs,
        });
      });
    });
  }
}
