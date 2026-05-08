import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  FileReviewBriefWriter,
  type ReviewBriefWriteResult,
} from "../../src/workspace/review-brief-writer.js";
import type { ParsedWorkOrderV1 } from "../../src/core/schemas-v1.js";

const sampleWorkOrder: ParsedWorkOrderV1 = {
  schema_version: "workflow/v1" as const,
  task_id: "T-review-brief",
  project_id: "test-project",
  title: "Fix a critical bug in auth module",
  type: "code_change" as const,
  goal: "Make the auth module handle expired tokens correctly.",
  acceptance_criteria: [
    "Expired tokens return 401.",
    "Valid tokens still work.",
    "The fix includes a unit test.",
  ],
  repo: {
    path: "/fake/repo",
    base_ref: "main",
  },
  constraints: {
    allowed_paths: ["src/auth/**", "tests/auth/**"],
    forbidden_paths: [".env"],
    max_files_to_touch: 5,
  },
  verification: {
    commands: ["npm test -- --testPathPattern=auth"],
    timeout_seconds: 60,
  },
  agent: {
    required_capabilities: ["code_change"],
    implementer_pool: ["claude-code"],
    reviewer_pool: [],
    exclude_agent_ids: [],
  },
  review: {
    enabled: true,
    max_review_runs: 1,
  },
  budget: {
    max_wall_time_minutes: 30,
    max_total_cost_units: 10,
    max_runs: 4,
  },
};

const sampleDiffText = `diff --git a/src/auth/tokens.ts b/src/auth/tokens.ts
index abc123..def456 100644
--- a/src/auth/tokens.ts
+++ b/src/auth/tokens.ts
@@ -10,6 +10,8 @@ export function validateToken(token: string): boolean {
   if (!token) {
     return false;
   }
+  if (isExpired(token)) {
+    return false;
+  }
   return true;
 }
`;

const samplePriorReport = `# Final Report

Fixed the auth module to handle expired tokens.

Changes:
- Added isExpired() check in validateToken()
- Added unit test for expired token case
`;

describe("FileReviewBriefWriter", () => {
  let tmpDir: string;
  let capsuleDir: string;
  let writer: FileReviewBriefWriter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-review-brief-"));
    capsuleDir = path.join(tmpDir, ".agent-workflow");
    writer = new FileReviewBriefWriter();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(
    overrides?: Partial<{
      workOrder: ParsedWorkOrderV1;
      diffText: string;
      priorFinalReportText: string | undefined;
    }>,
  ): ReviewBriefWriteResult {
    return writer.write({
      workspacePath: tmpDir,
      workOrder: overrides?.workOrder ?? sampleWorkOrder,
      diffText: overrides?.diffText ?? sampleDiffText,
      priorFinalReportText: overrides?.priorFinalReportText,
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
      expect(path.isAbsolute(result.reviewBriefPath)).toBe(true);
      expect(path.isAbsolute(result.reviewerPromptPath)).toBe(true);
      expect(path.isAbsolute(result.diffUnderReviewPath)).toBe(true);
    });

    it("creates all required reviewer files", () => {
      write();
      expect(fs.existsSync(path.join(capsuleDir, "work_order.md"))).toBe(true);
      expect(fs.existsSync(path.join(capsuleDir, "review_brief.md"))).toBe(true);
      expect(fs.existsSync(path.join(capsuleDir, "reviewer_prompt.md"))).toBe(true);
      expect(fs.existsSync(path.join(capsuleDir, "diff_under_review.patch"))).toBe(true);
    });

    it("does not precreate review_verdict.json", () => {
      write();
      expect(fs.existsSync(path.join(capsuleDir, "review_verdict.json"))).toBe(false);
    });

    it("removes a stale review_verdict.json left from a previous write", () => {
      // Precreate the capsule dir and a stale verdict file
      fs.mkdirSync(capsuleDir, { recursive: true });
      const verdictPath = path.join(capsuleDir, "review_verdict.json");
      fs.writeFileSync(
        verdictPath,
        JSON.stringify({ schema_version: "agent-workflow/1", verdict: "approved", summary: "stale", comments: [] }),
        "utf-8",
      );
      expect(fs.existsSync(verdictPath)).toBe(true);

      // write() must remove it
      write();
      expect(fs.existsSync(verdictPath)).toBe(false);
    });

    it("throws if stale review_verdict.json path exists as a directory", () => {
      fs.mkdirSync(capsuleDir, { recursive: true });
      const verdictDir = path.join(capsuleDir, "review_verdict.json");
      fs.mkdirSync(verdictDir);
      expect(() => write()).toThrow(/directory/);
    });

    it("removes a stale prior_final_report.md when priorFinalReportText is undefined", () => {
      // Precreate the capsule dir and a stale prior report file
      fs.mkdirSync(capsuleDir, { recursive: true });
      const reportPath = path.join(capsuleDir, "prior_final_report.md");
      fs.writeFileSync(reportPath, "# Stale prior report\n", "utf-8");
      expect(fs.existsSync(reportPath)).toBe(true);

      // write() without priorFinalReportText must remove it
      const result = write({ priorFinalReportText: undefined });
      expect(fs.existsSync(reportPath)).toBe(false);
      expect(result.priorFinalReportPath).toBeUndefined();
    });

    it("preserves unrelated files in .agent-workflow/", () => {
      // Precreate the capsule dir and an unrelated file
      fs.mkdirSync(capsuleDir, { recursive: true });
      const unrelatedPath = path.join(capsuleDir, "unrelated.log");
      fs.writeFileSync(unrelatedPath, "keep me\n", "utf-8");
      expect(fs.existsSync(unrelatedPath)).toBe(true);

      // write() must not touch the unrelated file
      write();
      expect(fs.existsSync(unrelatedPath)).toBe(true);
      const content = fs.readFileSync(unrelatedPath, "utf-8");
      expect(content).toBe("keep me\n");
    });

    it("review_brief.md includes task id, project id, title, type, and goal", () => {
      const result = write();
      const content = fs.readFileSync(result.reviewBriefPath, "utf-8");
      expect(content).toContain("T-review-brief");
      expect(content).toContain("test-project");
      expect(content).toContain("Fix a critical bug in auth module");
      expect(content).toContain("code_change");
      expect(content).toContain("Make the auth module handle expired tokens correctly.");
    });

    it("review_brief.md includes every acceptance criterion", () => {
      const result = write();
      const content = fs.readFileSync(result.reviewBriefPath, "utf-8");
      expect(content).toContain("Expired tokens return 401.");
      expect(content).toContain("Valid tokens still work.");
      expect(content).toContain("The fix includes a unit test.");
    });

    it("review_brief.md includes repository path and base ref", () => {
      const result = write();
      const content = fs.readFileSync(result.reviewBriefPath, "utf-8");
      expect(content).toContain("/fake/repo");
      expect(content).toContain("main");
    });

    it("review_brief.md includes constraints when present", () => {
      const result = write();
      const content = fs.readFileSync(result.reviewBriefPath, "utf-8");
      expect(content).toContain("src/auth/**");
      expect(content).toContain(".env");
      expect(content).toContain("5");
    });

    it("review_brief.md includes the complete diff text", () => {
      const result = write();
      const content = fs.readFileSync(result.reviewBriefPath, "utf-8");
      expect(content).toContain(sampleDiffText);
    });

    it("review_brief.md includes reviewer instructions about verdict JSON schema", () => {
      const result = write();
      const content = fs.readFileSync(result.reviewBriefPath, "utf-8");
      expect(content).toContain("review_verdict.json");
      expect(content).toContain('"schema_version"');
      expect(content).toContain('"verdict"');
      expect(content).toContain('"approved" | "changes_requested" | "rejected"');
      expect(content).toContain('"summary"');
      expect(content).toContain('"comments"');
      expect(content).toContain('"must_fix" | "should_fix" | "nit"');
    });

    it("review_brief.md instructs reviewer not to modify repository files", () => {
      const result = write();
      const content = fs.readFileSync(result.reviewBriefPath, "utf-8");
      expect(content).toContain("Do NOT modify any repository files");
    });

    it("review_brief.md instructs reviewer not to run tests in v1", () => {
      const result = write();
      const content = fs.readFileSync(result.reviewBriefPath, "utf-8");
      expect(content).toContain("Do NOT run tests");
    });

    it("review_brief.md includes prior final report when provided", () => {
      const result = write({ priorFinalReportText: samplePriorReport });
      const content = fs.readFileSync(result.reviewBriefPath, "utf-8");
      expect(content).toContain("## Prior Final Report");
      expect(content).toContain(samplePriorReport);
    });

    it("review_brief.md does not include Prior Final Report section when not provided", () => {
      const result = write({ priorFinalReportText: undefined });
      const content = fs.readFileSync(result.reviewBriefPath, "utf-8");
      expect(content).not.toContain("## Prior Final Report");
    });

    it("omits prior_final_report.md when no priorFinalReportText is provided", () => {
      const result = write({ priorFinalReportText: undefined });
      expect(result.priorFinalReportPath).toBeUndefined();
      expect(fs.existsSync(path.join(capsuleDir, "prior_final_report.md"))).toBe(false);
    });

    it("writes prior_final_report.md when priorFinalReportText is provided", () => {
      const result = write({ priorFinalReportText: samplePriorReport });
      expect(result.priorFinalReportPath).toBeDefined();
      expect(path.isAbsolute(result.priorFinalReportPath!)).toBe(true);
      expect(fs.existsSync(path.join(capsuleDir, "prior_final_report.md"))).toBe(true);
      const content = fs.readFileSync(path.join(capsuleDir, "prior_final_report.md"), "utf-8");
      expect(content).toContain(samplePriorReport);
      expect(content.endsWith("\n")).toBe(true);
    });

    it("reviewer_prompt.md instructs to read review_brief.md", () => {
      const result = write();
      const content = fs.readFileSync(result.reviewerPromptPath, "utf-8");
      expect(content).toContain(".agent-workflow/review_brief.md");
      expect(content).toContain("Read");
    });

    it("reviewer_prompt.md instructs to write review_verdict.json", () => {
      const result = write();
      const content = fs.readFileSync(result.reviewerPromptPath, "utf-8");
      expect(content).toContain(".agent-workflow/review_verdict.json");
      expect(content).toContain("Write your verdict");
    });

    it("reviewer_prompt.md instructs not to modify repository files", () => {
      const result = write();
      const content = fs.readFileSync(result.reviewerPromptPath, "utf-8");
      expect(content).toContain("Do NOT modify any repository files");
    });

    it("reviewer_prompt.md instructs not to run tests", () => {
      const result = write();
      const content = fs.readFileSync(result.reviewerPromptPath, "utf-8");
      expect(content).toContain("Do NOT run tests");
    });

    it("diff_under_review.patch contains the exact diff text", () => {
      const result = write();
      const content = fs.readFileSync(result.diffUnderReviewPath, "utf-8");
      // The diff text is preserved; the file has a trailing newline added
      expect(content).toContain(sampleDiffText.trimEnd());
    });

    it("diff_under_review.patch ends with a newline", () => {
      const result = write();
      const content = fs.readFileSync(result.diffUnderReviewPath, "utf-8");
      expect(content.endsWith("\n")).toBe(true);
    });

    it("diff_under_review.patch has exactly one trailing newline when input lacks one", () => {
      const diffWithoutNewline = "diff --git a/file b/file\n+change";
      const result = write({ diffText: diffWithoutNewline });
      const content = fs.readFileSync(result.diffUnderReviewPath, "utf-8");
      expect(content).toBe("diff --git a/file b/file\n+change\n");
    });

    it("diff_under_review.patch does not double newline when input already has one", () => {
      const diffWithNewline = "diff --git a/file b/file\n+change\n";
      const result = write({ diffText: diffWithNewline });
      const content = fs.readFileSync(result.diffUnderReviewPath, "utf-8");
      expect(content).toBe("diff --git a/file b/file\n+change\n");
    });

    it("throws for missing workspace path", () => {
      expect(() =>
        writer.write({
          workspacePath: path.join(tmpDir, "nonexistent"),
          workOrder: sampleWorkOrder,
          diffText: sampleDiffText,
        }),
      ).toThrow("Workspace path does not exist");
    });

    it("throws when workspace path is a file", () => {
      const filePath = path.join(tmpDir, "not-a-dir.txt");
      fs.writeFileSync(filePath, "hello", "utf-8");
      expect(() =>
        writer.write({
          workspacePath: filePath,
          workOrder: sampleWorkOrder,
          diffText: sampleDiffText,
        }),
      ).toThrow("Workspace path is not a directory");
    });

    it("all files end with a newline", () => {
      const result = write({ priorFinalReportText: samplePriorReport });
      const files = [
        result.workOrderPath,
        result.reviewBriefPath,
        result.reviewerPromptPath,
        result.diffUnderReviewPath,
        result.priorFinalReportPath!,
      ];
      for (const file of files) {
        const content = fs.readFileSync(file, "utf-8");
        expect(content.endsWith("\n")).toBe(true);
      }
    });

    it("work_order.md includes task info", () => {
      const result = write();
      const content = fs.readFileSync(result.workOrderPath, "utf-8");
      expect(content).toContain("# Work Order");
      expect(content).toContain("T-review-brief");
      expect(content).toContain("test-project");
      expect(content).toContain("Fix a critical bug in auth module");
      expect(content).toContain("code_change");
    });
  });
});
