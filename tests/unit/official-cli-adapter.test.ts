import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  ChildProcessOfficialCliAdapter,
  type AgentProcessResult,
} from "../../src/adapters/official-cli-adapter.js";
import type { ParsedAgentProfile } from "../../src/core/schemas.js";

const EXEC = process.execPath;

function baseProfile(overrides: Partial<ParsedAgentProfile> = {}): ParsedAgentProfile {
  return {
    schema_version: "workflow/v0",
    agent_id: "test-agent",
    integration_mode: "official_cli",
    command: {
      executable: EXEC,
      args: ["-e", "process.exit(0)"],
    },
    capabilities: {
      outer_supervised: true,
      inner_tool_control: false,
    },
    ...overrides,
  };
}

describe("ChildProcessOfficialCliAdapter", () => {
  let tmpDir: string;
  let adapter: ChildProcessOfficialCliAdapter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-adapter-"));
    adapter = new ChildProcessOfficialCliAdapter();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function run(
    agentProfile: ParsedAgentProfile,
    overrides: { promptFile?: string; timeoutSeconds?: number } = {},
  ): Promise<AgentProcessResult> {
    const promptFile = overrides.promptFile ?? path.join(tmpDir, "prompt.md");
    fs.mkdirSync(path.dirname(promptFile), { recursive: true });
    if (!fs.existsSync(promptFile)) {
      fs.writeFileSync(promptFile, "# Test prompt", "utf-8");
    }
    return adapter.run({
      agentProfile,
      workspacePath: tmpDir,
      promptFile,
      timeoutSeconds: overrides.timeoutSeconds,
    });
  }

  // ─── basic execution ────────────────────────────────────────────────────

  it("returns exitCode 0 and timedOut false for successful process", async () => {
    const result = await run(baseProfile());
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.wallTimeMs).toBeGreaterThanOrEqual(0);
  });

  // ─── {{prompt_file}} replacement ────────────────────────────────────────

  it("replaces {{prompt_file}} with absolute prompt path", async () => {
    const promptFile = path.join(tmpDir, "my-prompt.txt");
    fs.writeFileSync(promptFile, "hello", "utf-8");
    const profile = baseProfile({
      command: {
        executable: EXEC,
        args: ["-e", `console.log(process.argv[process.argv.length - 1])`, "{{prompt_file}}"],
      },
    });
    const result = await run(profile, { promptFile });
    expect(result.stdoutTail.trim()).toBe(promptFile);
  });

  // ─── cwd ────────────────────────────────────────────────────────────────

  it("default cwd is workspacePath", async () => {
    const profile = baseProfile({
      command: {
        executable: EXEC,
        args: ["-e", `console.log(process.cwd())`],
      },
    });
    const result = await run(profile);
    expect(result.stdoutTail.trim()).toBe(tmpDir);
  });

  it("explicit agentProfile.command.cwd overrides default cwd", async () => {
    const altDir = path.join(tmpDir, "alt-cwd");
    fs.mkdirSync(altDir);
    const profile = baseProfile({
      command: {
        executable: EXEC,
        args: ["-e", `console.log(process.cwd())`],
        cwd: altDir,
      },
    });
    const result = await run(profile);
    expect(result.stdoutTail.trim()).toBe(altDir);
  });

  // ─── environment ────────────────────────────────────────────────────────

  it("passes environment.set variables to child process", async () => {
    const profile = baseProfile({
      command: {
        executable: EXEC,
        args: ["-e", `console.log(process.env.TEST_VAR)`],
      },
      environment: { set: { TEST_VAR: "hello-env" } },
    });
    const result = await run(profile);
    expect(result.stdoutTail.trim()).toBe("hello-env");
  });

  it("environment.unset removes variables from child process", async () => {
    // Set a variable in process.env and then unset it
    process.env.AGENTFLOW_TEST_VAR = "should-be-removed";
    try {
      const profile = baseProfile({
        command: {
          executable: EXEC,
          args: ["-e", `console.log(process.env.AGENTFLOW_TEST_VAR ?? "undefined")`],
        },
        environment: { unset: ["AGENTFLOW_TEST_VAR"] },
      });
      const result = await run(profile);
      expect(result.stdoutTail.trim()).toBe("undefined");
    } finally {
      delete process.env.AGENTFLOW_TEST_VAR;
    }
  });

  // ─── stdout/stderr capture ──────────────────────────────────────────────

  it("captures stdout", async () => {
    const profile = baseProfile({
      command: {
        executable: EXEC,
        args: ["-e", `console.log("hello stdout")`],
      },
    });
    const result = await run(profile);
    expect(result.stdoutTail).toContain("hello stdout");
    expect(result.stdoutBytes).toBeGreaterThan(0);
  });

  it("captures stderr", async () => {
    const profile = baseProfile({
      command: {
        executable: EXEC,
        args: ["-e", `console.error("hello stderr")`],
      },
    });
    const result = await run(profile);
    expect(result.stderrTail).toContain("hello stderr");
    expect(result.stderrBytes).toBeGreaterThan(0);
  });

  it("stdoutBytes and stderrBytes reflect full output size, not tail", async () => {
    const profile = baseProfile({
      command: {
        executable: EXEC,
        args: ["-e", `process.stdout.write(Buffer.alloc(5000, 65).toString())`],
      },
    });
    const result = await run(profile);
    expect(result.stdoutBytes).toBe(5000);
  });

  // ─── tail truncation ────────────────────────────────────────────────────

  it("stdoutTail truncates to configured max bytes, tail from end", async () => {
    // Write 100 KiB (much larger than max 256 bytes)
    const marker = "ZZZENDMARKERZZZ";
    const profile = baseProfile({
      command: {
        executable: EXEC,
        args: ["-e", `process.stdout.write(Buffer.alloc(102400, 65).toString() + "${marker}")`],
      },
      limits: { max_stdout_bytes: 256 },
    });
    const result = await run(profile);
    // Total bytes is full output
    expect(result.stdoutBytes).toBe(102400 + marker.length);
    // Tail is bounded
    const tailLen = Buffer.byteLength(result.stdoutTail, "utf-8");
    expect(tailLen).toBeLessThanOrEqual(256);
    // Tail contains the end marker, not the leading 'A' characters
    expect(result.stdoutTail).toContain(marker);
  });

  it("stderrTail truncates to configured max bytes, tail from end", async () => {
    const marker = "ZZZSTDERRENDZZZ";
    const profile = baseProfile({
      command: {
        executable: EXEC,
        args: ["-e", `process.stderr.write(Buffer.alloc(100000, 66).toString() + "${marker}")`],
      },
      limits: { max_stderr_bytes: 128 },
    });
    const result = await run(profile);
    expect(result.stderrBytes).toBe(100000 + marker.length);
    const tailLen = Buffer.byteLength(result.stderrTail, "utf-8");
    expect(tailLen).toBeLessThanOrEqual(128);
    expect(result.stderrTail).toContain(marker);
  });

  // ─── non-zero exit code ─────────────────────────────────────────────────

  it("does not throw on non-zero exit code", async () => {
    const profile = baseProfile({
      command: {
        executable: EXEC,
        args: ["-e", `process.exit(42)`],
      },
    });
    const result = await run(profile);
    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
  });

  // ─── timeout ────────────────────────────────────────────────────────────

  it("times out and returns timedOut: true", async () => {
    const profile = baseProfile({
      command: {
        executable: EXEC,
        args: ["-e", `setTimeout(() => {}, 30000)`],
      },
    });
    const result = await run(profile, { timeoutSeconds: 1 });
    expect(result.timedOut).toBe(true);
  });

  // ─── error cases ────────────────────────────────────────────────────────

  it("throws for non-existent cwd", async () => {
    const profile = baseProfile({
      command: {
        executable: EXEC,
        args: ["-e", `process.exit(0)`],
        cwd: path.join(tmpDir, "nonexistent"),
      },
    });
    await expect(run(profile)).rejects.toThrow("cwd does not exist");
  });

  it("throws for non-existent executable", async () => {
    const profile = baseProfile({
      command: {
        executable: path.join(tmpDir, "nonexistent-binary"),
        args: [],
      },
    });
    await expect(run(profile)).rejects.toThrow("Failed to spawn");
  });

  // ─── signal ─────────────────────────────────────────────────────────────

  it("signal is null for normal exit", async () => {
    const profile = baseProfile();
    const result = await run(profile);
    expect(result.signal).toBeNull();
  });
});
