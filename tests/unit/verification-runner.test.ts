import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  ShellVerificationRunner,
  type VerificationResult,
} from "../../src/verification/verification-runner.js";

const NODE = JSON.stringify(process.execPath);

function cmd(js: string): string {
  return `${NODE} -e "${js.replace(/"/g, '\\"')}"`;
}

describe("ShellVerificationRunner", () => {
  let tmpDir: string;
  let runner: ShellVerificationRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-verify-"));
    runner = new ShellVerificationRunner();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function run(
    commands: string[],
    timeoutSeconds?: number,
  ): Promise<VerificationResult> {
    return runner.run({ workspacePath: tmpDir, commands, timeoutSeconds });
  }

  // ─── empty commands ─────────────────────────────────────────────────────

  it("empty commands returns passed true and empty commandResults", async () => {
    const result = await run([]);
    expect(result.passed).toBe(true);
    expect(result.commandResults).toEqual([]);
  });

  // ─── successful command ─────────────────────────────────────────────────

  it("successful command returns passed true, exitCode 0, timedOut false", async () => {
    const result = await run([cmd("process.exit(0)")]);
    expect(result.passed).toBe(true);
    expect(result.commandResults).toHaveLength(1);
    expect(result.commandResults[0].exitCode).toBe(0);
    expect(result.commandResults[0].timedOut).toBe(false);
  });

  // ─── cwd ────────────────────────────────────────────────────────────────

  it("command runs in workspacePath", async () => {
    // Use console.log with proper escaping
    const result = await run([cmd(`console.log(process.cwd())`)]);
    expect(result.passed).toBe(true);
    expect(result.commandResults[0].output.trim()).toBe(tmpDir);
  });

  // ─── stdout capture ─────────────────────────────────────────────────────

  it("stdout is captured to output", async () => {
    const result = await run([cmd(`console.log("hello verify")`)]);
    expect(result.commandResults[0].output).toContain("hello verify");
  });

  // ─── stderr capture ─────────────────────────────────────────────────────

  it("stderr is captured to output", async () => {
    const result = await run([cmd(`console.error("verify error")`)]);
    expect(result.commandResults[0].output).toContain("verify error");
  });

  // ─── non-zero exit ──────────────────────────────────────────────────────

  it("non-zero exit code returns passed false, no throw", async () => {
    const result = await run([cmd("process.exit(3)")]);
    expect(result.passed).toBe(false);
    expect(result.commandResults[0].exitCode).toBe(3);
  });

  // ─── stop on first failure ──────────────────────────────────────────────

  it("stops at first failed command, does not execute subsequent", async () => {
    const result = await run([
      cmd("process.exit(1)"),
      cmd(`console.log("SHOULD NOT RUN")`),
    ]);
    expect(result.passed).toBe(false);
    expect(result.commandResults).toHaveLength(1);
  });

  // ─── multiple successful commands ───────────────────────────────────────

  it("multiple successful commands execute in order", async () => {
    const result = await run([
      cmd(`console.log("first")`),
      cmd(`console.log("second")`),
    ]);
    expect(result.passed).toBe(true);
    expect(result.commandResults).toHaveLength(2);
    expect(result.commandResults[0].output).toContain("first");
    expect(result.commandResults[1].output).toContain("second");
  });

  // ─── timeout ────────────────────────────────────────────────────────────

  it("timeout returns passed false, timedOut true, no throw", { timeout: 15000 }, async () => {
    const result = await run(
      [cmd(`setTimeout(() => {}, 60000)`)],
      2,
    );
    expect(result.passed).toBe(false);
    expect(result.commandResults[0].timedOut).toBe(true);
  });

  it("timeout stops subsequent commands", { timeout: 15000 }, async () => {
    const result = await run(
      [
        cmd(`setTimeout(() => {}, 60000)`),
        cmd(`console.log("SHOULD NOT RUN")`),
      ],
      2,
    );
    expect(result.commandResults).toHaveLength(1);
  });

  // ─── workspace validation ───────────────────────────────────────────────

  it("throws for non-existent workspacePath", async () => {
    await expect(
      runner.run({
        workspacePath: path.join(tmpDir, "nonexistent"),
        commands: [cmd("process.exit(0)")],
      }),
    ).rejects.toThrow("Workspace path does not exist");
  });

  it("throws for file as workspacePath", async () => {
    const filePath = path.join(tmpDir, "not-a-dir.txt");
    fs.writeFileSync(filePath, "hello", "utf-8");
    await expect(
      runner.run({
        workspacePath: filePath,
        commands: [cmd("process.exit(0)")],
      }),
    ).rejects.toThrow("Workspace path is not a directory");
  });

  // ─── output truncation ──────────────────────────────────────────────────

  it("large output is truncated with marker, tail from end", async () => {
    const marker = "VERIFY_END_MARKER";
    // Generate ~300 KiB output (exceeds 256 KiB default max)
    const result = await run([
      cmd(
        `process.stdout.write(Buffer.alloc(300 * 1024, 65).toString() + "${marker}")`,
      ),
    ]);
    expect(result.commandResults[0].output).toContain(
      "[output truncated to last",
    );
    // The tail should contain our end marker
    expect(result.commandResults[0].output).toContain(marker);
  });
});
