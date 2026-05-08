import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  parseReviewVerdict,
  type ReviewVerdictParseResult,
  type ReviewVerdictReasonTag,
} from "../../src/adapters/review-verdict-parser.js";
import type { ReviewVerdict } from "../../src/core/types.js";

function synthesizeExpectedVerdict(): ReviewVerdict {
  return {
    schema_version: "agent-workflow/1",
    verdict: "changes_requested",
    summary: "Reviewer did not produce a verdict file.",
    comments: [],
  };
}

describe("parseReviewVerdict", () => {
  let tmpDir: string;
  let agentWorkflowDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-verdict-parser-"));
    agentWorkflowDir = path.join(tmpDir, ".agent-workflow");
    fs.mkdirSync(agentWorkflowDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeVerdictFile(content: string): void {
    fs.writeFileSync(
      path.join(agentWorkflowDir, "review_verdict.json"),
      content,
      "utf-8",
    );
  }

  function callParser(): ReviewVerdictParseResult {
    return parseReviewVerdict({ workspacePath: tmpDir });
  }

  describe("valid verdict file", () => {
    it("returns the parsed verdict with no reasonTag", () => {
      writeVerdictFile(
        JSON.stringify({
          schema_version: "agent-workflow/1",
          verdict: "approved",
          summary: "LGTM, the changes are correct.",
          comments: [
            {
              path: "src/auth/tokens.ts",
              line: 14,
              severity: "nit",
              comment: "Consider adding a docstring.",
            },
          ],
        }),
      );

      const result = callParser();
      expect(result.verdict.schema_version).toBe("agent-workflow/1");
      expect(result.verdict.verdict).toBe("approved");
      expect(result.verdict.summary).toBe("LGTM, the changes are correct.");
      expect(result.verdict.comments).toHaveLength(1);
      expect(result.verdict.comments[0].severity).toBe("nit");
      expect(result.reasonTag).toBeUndefined();
      expect(result.unusableRawText).toBeUndefined();
      expect(result.errorMessage).toBeUndefined();
    });

    it("returns changes_requested verdict with no reasonTag", () => {
      writeVerdictFile(
        JSON.stringify({
          schema_version: "agent-workflow/1",
          verdict: "changes_requested",
          summary: "Missing edge case handling.",
          comments: [
            {
              severity: "must_fix",
              comment: "Handle null input.",
            },
          ],
        }),
      );

      const result = callParser();
      expect(result.verdict.verdict).toBe("changes_requested");
      expect(result.verdict.summary).toBe("Missing edge case handling.");
      expect(result.reasonTag).toBeUndefined();
    });

    it("returns rejected verdict with no reasonTag", () => {
      writeVerdictFile(
        JSON.stringify({
          schema_version: "agent-workflow/1",
          verdict: "rejected",
          summary: "This approach is fundamentally broken.",
          comments: [],
        }),
      );

      const result = callParser();
      expect(result.verdict.verdict).toBe("rejected");
      expect(result.reasonTag).toBeUndefined();
    });
  });

  describe("missing verdict file", () => {
    it("returns synthesized changes_requested verdict with reasonTag reviewer_unusable", () => {
      const result = callParser();
      const expected = synthesizeExpectedVerdict();
      expect(result.verdict.verdict).toBe(expected.verdict);
      expect(result.verdict.summary).toBe(expected.summary);
      expect(result.verdict.schema_version).toBe(expected.schema_version);
      expect(result.verdict.comments).toEqual(expected.comments);
      expect(result.reasonTag).toBe("reviewer_unusable");
      // Should not set unusableRawText or errorMessage for missing file
      expect(result.unusableRawText).toBeUndefined();
      expect(result.errorMessage).toBeUndefined();
    });

    it("verdict is a distinct object (not mutated by later calls)", () => {
      const result1 = callParser();
      const result2 = callParser();
      expect(result1.verdict).not.toBe(result2.verdict);
    });
  });

  describe("malformed JSON", () => {
    it("returns fallback verdict with reasonTag, raw text, and error message", () => {
      const malformed = '{ schema_version: "agent-workflow/1" NOT VALID }';
      writeVerdictFile(malformed);

      const result = callParser();
      expect(result.verdict.verdict).toBe("changes_requested");
      expect(result.verdict.summary).toBe("Reviewer did not produce a verdict file.");
      expect(result.reasonTag).toBe("reviewer_unusable");
      expect(result.unusableRawText).toBe(malformed);
      expect(result.errorMessage).toBeDefined();
      expect(result.errorMessage!.length).toBeGreaterThan(0);
    });
  });

  describe("schema-invalid JSON", () => {
    it("returns fallback when verdict field is missing", () => {
      const invalid = JSON.stringify({
        schema_version: "agent-workflow/1",
        summary: "No verdict field here.",
        comments: [],
      });
      writeVerdictFile(invalid);

      const result = callParser();
      expect(result.verdict.verdict).toBe("changes_requested");
      expect(result.reasonTag).toBe("reviewer_unusable");
      expect(result.unusableRawText).toBe(invalid);
      expect(result.errorMessage).toBeDefined();
    });

    it("returns fallback when verdict is an invalid value", () => {
      const invalid = JSON.stringify({
        schema_version: "agent-workflow/1",
        verdict: "maybe",
        summary: "Not a valid verdict.",
        comments: [],
      });
      writeVerdictFile(invalid);

      const result = callParser();
      expect(result.verdict.verdict).toBe("changes_requested");
      expect(result.reasonTag).toBe("reviewer_unusable");
      expect(result.unusableRawText).toBe(invalid);
      expect(result.errorMessage).toBeDefined();
    });

    it("returns fallback when schema_version is wrong", () => {
      const invalid = JSON.stringify({
        schema_version: "agent-workflow/2",
        verdict: "approved",
        summary: "Wrong version.",
        comments: [],
      });
      writeVerdictFile(invalid);

      const result = callParser();
      expect(result.verdict.verdict).toBe("changes_requested");
      expect(result.reasonTag).toBe("reviewer_unusable");
      expect(result.unusableRawText).toBe(invalid);
      expect(result.errorMessage).toBeDefined();
    });

    it("returns fallback when comments is not an array", () => {
      const invalid = JSON.stringify({
        schema_version: "agent-workflow/1",
        verdict: "approved",
        summary: "Good.",
        comments: "not an array",
      });
      writeVerdictFile(invalid);

      const result = callParser();
      expect(result.verdict.verdict).toBe("changes_requested");
      expect(result.reasonTag).toBe("reviewer_unusable");
      expect(result.unusableRawText).toBe(invalid);
      expect(result.errorMessage).toBeDefined();
    });

    it("returns fallback when a comment is missing severity", () => {
      const invalid = JSON.stringify({
        schema_version: "agent-workflow/1",
        verdict: "changes_requested",
        summary: "Missing severity field.",
        comments: [{ comment: "no severity" }],
      });
      writeVerdictFile(invalid);

      const result = callParser();
      expect(result.verdict.verdict).toBe("changes_requested");
      expect(result.reasonTag).toBe("reviewer_unusable");
      expect(result.unusableRawText).toBe(invalid);
      expect(result.errorMessage).toBeDefined();
    });

    it("returns fallback when summary is empty", () => {
      const invalid = JSON.stringify({
        schema_version: "agent-workflow/1",
        verdict: "approved",
        summary: "",
        comments: [],
      });
      writeVerdictFile(invalid);

      const result = callParser();
      expect(result.verdict.verdict).toBe("changes_requested");
      expect(result.reasonTag).toBe("reviewer_unusable");
      expect(result.unusableRawText).toBe(invalid);
      expect(result.errorMessage).toBeDefined();
    });
  });

  describe("ignores review_verdict.json in workspace root", () => {
    it("treats root-level review_verdict.json as missing", () => {
      // Write a valid verdict to the workspace root (not under .agent-workflow)
      fs.writeFileSync(
        path.join(tmpDir, "review_verdict.json"),
        JSON.stringify({
          schema_version: "agent-workflow/1",
          verdict: "approved",
          summary: "This file is in the wrong place.",
          comments: [],
        }),
        "utf-8",
      );

      // The parser should only look under .agent-workflow/
      const result = callParser();
      expect(result.verdict.verdict).toBe("changes_requested");
      expect(result.verdict.summary).toBe("Reviewer did not produce a verdict file.");
      expect(result.reasonTag).toBe("reviewer_unusable");
    });
  });

  describe("does not throw", () => {
    it("does not throw for any input scenario", () => {
      // Missing file
      expect(() => callParser()).not.toThrow();

      // Malformed JSON
      writeVerdictFile("not json");
      expect(() => callParser()).not.toThrow();

      // Write nothing and remove the .agent-workflow dir entirely
      fs.rmSync(agentWorkflowDir, { recursive: true });
      expect(() => callParser()).not.toThrow();

      // Empty directory (no .agent-workflow)
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-empty-"));
      try {
        expect(() =>
          parseReviewVerdict({ workspacePath: emptyDir }),
        ).not.toThrow();
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });
});
