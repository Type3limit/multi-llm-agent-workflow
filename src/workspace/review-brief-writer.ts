import * as fs from "node:fs";
import * as path from "node:path";
import type { ParsedWorkOrderV1 } from "../core/schemas-v1.js";

export interface ReviewBriefWriteResult {
  capsulePath: string;
  workOrderPath: string;
  reviewBriefPath: string;
  reviewerPromptPath: string;
  diffUnderReviewPath: string;
  priorFinalReportPath?: string;
}

export interface ReviewBriefWriter {
  write(args: {
    workspacePath: string;
    workOrder: ParsedWorkOrderV1;
    diffText: string;
    priorFinalReportText?: string;
  }): ReviewBriefWriteResult;
}

export class FileReviewBriefWriter implements ReviewBriefWriter {
  write(args: {
    workspacePath: string;
    workOrder: ParsedWorkOrderV1;
    diffText: string;
    priorFinalReportText?: string;
  }): ReviewBriefWriteResult {
    const ws = path.resolve(args.workspacePath);

    // Validate workspace path
    let stat: fs.Stats;
    try {
      stat = fs.statSync(ws);
    } catch {
      throw new Error(`Workspace path does not exist: ${ws}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Workspace path is not a directory: ${ws}`);
    }

    // Create .agent-workflow capsule directory
    const capsuleDir = path.join(ws, ".agent-workflow");
    fs.mkdirSync(capsuleDir, { recursive: true });

    // Clean up reserved reviewer output files from a previous write so that
    // stale files from a prior reviewer run cannot be misinterpreted.
    this.removeReservedFile(capsuleDir, "review_verdict.json");
    if (args.priorFinalReportText === undefined) {
      this.removeReservedFile(capsuleDir, "prior_final_report.md");
    }

    // Write required files
    const workOrderPath = this.writeWorkOrderMd(capsuleDir, args.workOrder);
    const reviewBriefPath = this.writeReviewBriefMd(
      capsuleDir,
      args.workOrder,
      args.diffText,
      args.priorFinalReportText,
    );
    const reviewerPromptPath = this.writeReviewerPromptMd(capsuleDir);
    const diffUnderReviewPath = this.writeDiffUnderReviewPatch(
      capsuleDir,
      args.diffText,
    );

    // Write prior_final_report.md only when priorFinalReportText is provided
    let priorFinalReportPath: string | undefined;
    if (args.priorFinalReportText !== undefined) {
      priorFinalReportPath = this.writePriorFinalReportMd(
        capsuleDir,
        args.priorFinalReportText,
      );
    }

    // Do not precreate review_verdict.json — the reviewer agent must create it.

    return {
      capsulePath: capsuleDir,
      workOrderPath,
      reviewBriefPath,
      reviewerPromptPath,
      diffUnderReviewPath,
      priorFinalReportPath,
    };
  }

  private removeReservedFile(capsuleDir: string, filename: string): void {
    const filePath = path.join(capsuleDir, filename);
    if (!fs.existsSync(filePath)) {
      return;
    }
    const stat = fs.lstatSync(filePath);
    if (stat.isDirectory()) {
      throw new Error(
        `Reserved reviewer output path is a directory, not a file: ${filePath}`,
      );
    }
    fs.rmSync(filePath);
  }

  private writeWorkOrderMd(
    capsuleDir: string,
    wo: ParsedWorkOrderV1,
  ): string {
    const filePath = path.join(capsuleDir, "work_order.md");
    const lines = [
      "# Work Order",
      "",
      `- **Task ID**: ${wo.task_id}`,
      `- **Project ID**: ${wo.project_id}`,
      `- **Title**: ${wo.title}`,
      `- **Type**: ${wo.type}`,
      `- **Goal**: ${wo.goal}`,
      "",
      "## Acceptance Criteria",
      ...wo.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`),
      "",
      "## Repository",
      `- **Path**: ${wo.repo.path}`,
      `- **Base Ref**: ${wo.repo.base_ref ?? "None"}`,
    ];

    // Constraints when present
    if (
      wo.constraints?.allowed_paths ||
      wo.constraints?.forbidden_paths ||
      wo.constraints?.max_files_to_touch
    ) {
      lines.push("");
      lines.push("## Constraints");
      if (wo.constraints.allowed_paths?.length) {
        lines.push(
          `- **Allowed Paths**: ${wo.constraints.allowed_paths.join(", ")}`,
        );
      }
      if (wo.constraints.forbidden_paths?.length) {
        lines.push(
          `- **Forbidden Paths**: ${wo.constraints.forbidden_paths.join(", ")}`,
        );
      }
      if (wo.constraints.max_files_to_touch !== undefined) {
        lines.push(
          `- **Max Files to Touch**: ${wo.constraints.max_files_to_touch}`,
        );
      }
    }

    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
    return filePath;
  }

  private writeReviewBriefMd(
    capsuleDir: string,
    wo: ParsedWorkOrderV1,
    diffText: string,
    priorFinalReportText?: string,
  ): string {
    const filePath = path.join(capsuleDir, "review_brief.md");
    const lines: string[] = [
      "# Review Brief",
      "",
      "## Task",
      `- **Task ID**: ${wo.task_id}`,
      `- **Project ID**: ${wo.project_id}`,
      `- **Title**: ${wo.title}`,
      `- **Type**: ${wo.type}`,
      `- **Goal**: ${wo.goal}`,
      "",
      "## Acceptance Criteria",
      ...wo.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`),
      "",
      "## Repository",
      `- **Path**: ${wo.repo.path}`,
      `- **Base Ref**: ${wo.repo.base_ref ?? "None"}`,
    ];

    // Constraints when present
    if (wo.constraints?.allowed_paths?.length) {
      lines.push(
        `- **Allowed Paths**: ${wo.constraints.allowed_paths.join(", ")}`,
      );
    }
    if (wo.constraints?.forbidden_paths?.length) {
      lines.push(
        `- **Forbidden Paths**: ${wo.constraints.forbidden_paths.join(", ")}`,
      );
    }
    if (wo.constraints?.max_files_to_touch !== undefined) {
      lines.push(
        `- **Max Files to Touch**: ${wo.constraints.max_files_to_touch}`,
      );
    }

    lines.push("");
    lines.push("## Diff Under Review");
    lines.push("");
    lines.push("```diff");
    lines.push(diffText);
    lines.push("```");

    if (priorFinalReportText !== undefined) {
      lines.push("");
      lines.push("## Prior Final Report");
      lines.push("");
      lines.push(priorFinalReportText);
    }

    lines.push("");
    lines.push("## Reviewer Instructions");
    lines.push("");
    lines.push(
      "You are reviewing an implementer agent's changes. Your job is to assess whether the diff meets the acceptance criteria and is safe to apply.",
    );
    lines.push("");
    lines.push("### Required Output");
    lines.push("");
    lines.push(
      "You MUST write a JSON file at `.agent-workflow/review_verdict.json` with exactly these fields:",
    );
    lines.push("");
    lines.push("```json");
    lines.push("{");
    lines.push('  "schema_version": "agent-workflow/1",');
    lines.push('  "verdict": "approved" | "changes_requested" | "rejected",');
    lines.push('  "summary": "<one paragraph explaining your verdict>",');
    lines.push('  "comments": [');
    lines.push("    {");
    lines.push('      "path": "<file path, optional>",');
    lines.push('      "line": <line number, optional>,');
    lines.push(
      '      "severity": "must_fix" | "should_fix" | "nit",',
    );
    lines.push('      "comment": "<your comment>"');
    lines.push("    }");
    lines.push("  ]");
    lines.push("}");
    lines.push("```");
    lines.push("");
    lines.push("### Rules");
    lines.push("");
    lines.push("- Do NOT modify any repository files.");
    lines.push("- Do NOT run tests (v1 reviewer does not run verification).");
    lines.push("- Write ONLY `.agent-workflow/review_verdict.json`.");
    lines.push(
      "- The `comments` array may be empty even for `changes_requested` — use `summary` to explain what needs to change.",
    );

    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
    return filePath;
  }

  private writeReviewerPromptMd(capsuleDir: string): string {
    const filePath = path.join(capsuleDir, "reviewer_prompt.md");
    const lines = [
      "# Reviewer Agent Instructions",
      "",
      "1. Read `.agent-workflow/review_brief.md` to understand the task and see the diff under review.",
      "2. Assess whether the implementer's changes meet the acceptance criteria.",
      "3. Write your verdict to `.agent-workflow/review_verdict.json` using the schema described in the review brief.",
      "4. Do NOT modify any repository files.",
      "5. Do NOT run tests or verification commands.",
      "6. Do NOT write any files other than `.agent-workflow/review_verdict.json`.",
    ];
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
    return filePath;
  }

  private writeDiffUnderReviewPatch(
    capsuleDir: string,
    diffText: string,
  ): string {
    const filePath = path.join(capsuleDir, "diff_under_review.patch");
    // Preserve diffText exactly; add trailing newline only if missing
    const content = diffText.endsWith("\n") ? diffText : diffText + "\n";
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  private writePriorFinalReportMd(
    capsuleDir: string,
    priorFinalReportText: string,
  ): string {
    const filePath = path.join(capsuleDir, "prior_final_report.md");
    const content = priorFinalReportText.endsWith("\n")
      ? priorFinalReportText
      : priorFinalReportText + "\n";
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  }
}
