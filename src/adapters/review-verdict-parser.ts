import * as fs from "node:fs";
import * as path from "node:path";
import type { ReviewVerdict } from "../core/types.js";
import { parseReviewVerdictFile } from "../core/schemas-v1.js";

export type ReviewVerdictReasonTag = "reviewer_unusable";

export interface ReviewVerdictParseResult {
  verdict: ReviewVerdict;
  reasonTag?: ReviewVerdictReasonTag;
  unusableRawText?: string;
  errorMessage?: string;
}

const SYNTHESIZED_VERDICT: ReviewVerdict = {
  schema_version: "agent-workflow/1",
  verdict: "changes_requested",
  summary: "Reviewer did not produce a verdict file.",
  comments: [],
};

export function parseReviewVerdict(args: {
  workspacePath: string;
}): ReviewVerdictParseResult {
  const ws = path.resolve(args.workspacePath);
  const verdictFilePath = path.join(ws, ".agent-workflow", "review_verdict.json");

  // Try to read the file
  let rawText: string;
  try {
    rawText = fs.readFileSync(verdictFilePath, "utf-8");
  } catch (err: unknown) {
    // File missing — return synthesized fallback
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return {
        verdict: { ...SYNTHESIZED_VERDICT },
        reasonTag: "reviewer_unusable",
      };
    }
    // Some other read error — treat as missing
    return {
      verdict: { ...SYNTHESIZED_VERDICT },
      reasonTag: "reviewer_unusable",
      errorMessage: `Failed to read review verdict file: ${String(err)}`,
    };
  }

  // File exists — try to parse and validate
  try {
    const verdict = parseReviewVerdictFile(rawText);
    return { verdict };
  } catch (err: unknown) {
    // JSON parse error or schema validation error
    const errorMessage =
      err instanceof Error ? err.message : String(err);

    return {
      verdict: { ...SYNTHESIZED_VERDICT },
      reasonTag: "reviewer_unusable",
      unusableRawText: rawText,
      errorMessage,
    };
  }
}
