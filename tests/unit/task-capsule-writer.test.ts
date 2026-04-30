import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  FileTaskCapsuleWriter,
  type TaskCapsuleWriteResult,
} from "../../src/workspace/task-capsule-writer.js";
import type { ParsedWorkOrder } from "../../src/core/schemas.js";
import type { RunManifest } from "../../src/core/types.js";
import { RunManifestSchema } from "../../src/core/schemas.js";

const sampleWorkOrder: ParsedWorkOrder = {
  schema_version: "workflow/v0",
  task_id: "T-capsule",
  project_id: "test-project",
  title: "Fix a test failure",
  type: "code_change",
  goal: "Make the failing unit test pass.",
  acceptance_criteria: ["The test exits with code 0.", "The report explains changes."],
  repo: { path: "/fake/repo", base_ref: "main" },
  constraints: {
    allowed_paths: ["src/**", "tests/**"],
    forbidden_paths: [".env"],
    max_files_to_touch: 3,
  },
  verification: {
    commands: ["npm test"],
    timeout_seconds: 120,
  },
  agent: { agent_id: "claude-local" },
  budget: { max_wall_time_minutes: 10, max_output_bytes: 100_000 },
};

const sampleManifest: RunManifest = {
  schema_version: "agent-workflow/1",
  run_id: "R-capsule",
  task_id: "T-capsule",
  project_id: "test-project",
  agent_id: "claude-local",
  integration_mode: "official_cli",
  workspace_uri: "file:///fake/repo/.agentflow/worktrees/T-capsule/R-capsule",
  base_commit: "abc123def456",
  branch: "agent/T-capsule/R-capsule",
  work_order_hash: "sha256:deadbeef",
  adapter_version: "0.1.0",
  started_at: new Date().toISOString(),
  status: "preparing",
};

describe("FileTaskCapsuleWriter", () => {
  let tmpDir: string;
  let capsuleDir: string;
  let writer: FileTaskCapsuleWriter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-capsule-"));
    capsuleDir = path.join(tmpDir, ".agent-workflow");
    writer = new FileTaskCapsuleWriter();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(): TaskCapsuleWriteResult {
    return writer.write({
      workspacePath: tmpDir,
      workOrder: sampleWorkOrder,
      runManifest: sampleManifest,
    });
  }

  describe("write()", () => {
    it("creates .agent-workflow/ directory", () => {
      write();
      expect(fs.existsSync(capsuleDir)).toBe(true);
      expect(fs.statSync(capsuleDir).isDirectory()).toBe(true);
    });

    it("returns all paths as absolute paths", () => {
      const result = write();
      expect(path.isAbsolute(result.capsulePath)).toBe(true);
      expect(path.isAbsolute(result.workOrderPath)).toBe(true);
      expect(path.isAbsolute(result.runManifestPath)).toBe(true);
      expect(path.isAbsolute(result.promptPath)).toBe(true);
    });

    it("writes work_order.md with required content", () => {
      const result = write();
      const content = fs.readFileSync(result.workOrderPath, "utf-8");
      expect(content).toContain("# Work Order");
      expect(content).toContain("T-capsule");
      expect(content).toContain("test-project");
      expect(content).toContain("Fix a test failure");
      expect(content).toContain("code_change");
      expect(content).toContain("Make the failing unit test pass.");
      expect(content).toContain("The test exits with code 0.");
      expect(content).toContain("/fake/repo");
      expect(content).toContain("main");
      expect(content).toContain("src/**");
      expect(content).toContain(".env");
      expect(content).toContain("npm test");
      expect(content).toContain(".agent-workflow/final_report.md");
    });

    it("work_order.md shows None for missing optional fields", () => {
      const result = writer.write({
        workspacePath: tmpDir,
        workOrder: {
          schema_version: "workflow/v0",
          task_id: "T-min",
          project_id: "default",
          title: "Minimal",
          type: "research_report",
          goal: "Research something.",
          acceptance_criteria: [],
          repo: { path: "/r" },
          agent: { agent_id: "x" },
        },
        runManifest: sampleManifest,
      });
      const content = fs.readFileSync(result.workOrderPath, "utf-8");
      expect(content).toContain("Allowed Paths**: None");
      expect(content).toContain("Forbidden Paths**: None");
      expect(content).toContain("Max Files to Touch**: None");
      expect(content).toContain("Commands**: None");
    });

    it("writes constraints.json as valid JSON with fields from WorkOrder/RunManifest", () => {
      write();
      const content = fs.readFileSync(path.join(capsuleDir, "constraints.json"), "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.schema_version).toBe("agent-workflow/1");
      expect(parsed.task_id).toBe("T-capsule");
      expect(parsed.run_id).toBe("R-capsule");
      expect(parsed.allowed_paths).toEqual(["src/**", "tests/**"]);
      expect(parsed.forbidden_paths).toEqual([".env"]);
      expect(parsed.max_files_to_touch).toBe(3);
      expect(parsed.verification_commands).toEqual(["npm test"]);
      expect(parsed.budget.max_wall_time_minutes).toBe(10);
      expect(parsed.budget.max_output_bytes).toBe(100_000);
    });

    it("writes run_manifest.json that matches input and passes validation", () => {
      write();
      const content = fs.readFileSync(path.join(capsuleDir, "run_manifest.json"), "utf-8");
      const parsed = JSON.parse(content);

      // Validates with schema
      expect(() => RunManifestSchema.parse(parsed)).not.toThrow();

      expect(parsed.run_id).toBe("R-capsule");
      expect(parsed.task_id).toBe("T-capsule");
      expect(parsed.agent_id).toBe("claude-local");
    });

    it("writes prompt.md with all required instructions", () => {
      const result = write();
      const content = fs.readFileSync(result.promptPath, "utf-8");
      expect(content).toContain("Read `.agent-workflow/work_order.md`");
      expect(content).toContain("Respect allowed and forbidden paths");
      expect(content).toContain("Write the final report to `.agent-workflow/final_report.md`");
      expect(content).toContain("Do not commit any changes");
      expect(content).toContain("Do not modify `.agent-workflow/run_manifest.json`");
      expect(content).toContain("Keep changes focused on the work order");
    });

    it("progress.jsonl and final_report.md are empty files", () => {
      write();
      const progressContent = fs.readFileSync(path.join(capsuleDir, "progress.jsonl"), "utf-8");
      const reportContent = fs.readFileSync(path.join(capsuleDir, "final_report.md"), "utf-8");
      expect(progressContent).toBe("");
      expect(reportContent).toBe("");
    });

    it("artifacts/ is a directory", () => {
      write();
      const artifactsDir = path.join(capsuleDir, "artifacts");
      expect(fs.existsSync(artifactsDir)).toBe(true);
      expect(fs.statSync(artifactsDir).isDirectory()).toBe(true);
    });

    it("throws for non-existent workspacePath", () => {
      expect(() =>
        writer.write({
          workspacePath: path.join(tmpDir, "nonexistent"),
          workOrder: sampleWorkOrder,
          runManifest: sampleManifest,
        }),
      ).toThrow("Workspace path does not exist");
    });

    it("throws for a file path as workspacePath", () => {
      const filePath = path.join(tmpDir, "not-a-dir.txt");
      fs.writeFileSync(filePath, "hello", "utf-8");
      expect(() =>
        writer.write({
          workspacePath: filePath,
          workOrder: sampleWorkOrder,
          runManifest: sampleManifest,
        }),
      ).toThrow("Workspace path is not a directory");
    });

    it("second write() does not delete files in artifacts/", () => {
      write();
      const sentinelPath = path.join(capsuleDir, "artifacts", "sentinel.txt");
      fs.writeFileSync(sentinelPath, "keep me", "utf-8");

      // Write again
      writer.write({
        workspacePath: tmpDir,
        workOrder: sampleWorkOrder,
        runManifest: sampleManifest,
      });

      expect(fs.existsSync(sentinelPath)).toBe(true);
      expect(fs.readFileSync(sentinelPath, "utf-8")).toBe("keep me");
    });
  });
});
