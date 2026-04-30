import * as fs from "node:fs";
import * as path from "node:path";
import type { ParsedWorkOrder } from "../core/schemas.js";
import type { RunManifest } from "../core/types.js";
import { RunManifestSchema } from "../core/schemas.js";

export interface TaskCapsuleWriteResult {
  capsulePath: string;
  workOrderPath: string;
  runManifestPath: string;
  promptPath: string;
}

export interface TaskCapsuleWriter {
  write(args: {
    workspacePath: string;
    workOrder: ParsedWorkOrder;
    runManifest: RunManifest;
  }): TaskCapsuleWriteResult;
}

export class FileTaskCapsuleWriter implements TaskCapsuleWriter {
  write(args: {
    workspacePath: string;
    workOrder: ParsedWorkOrder;
    runManifest: RunManifest;
  }): TaskCapsuleWriteResult {
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

    const capsuleDir = path.join(ws, ".agent-workflow");
    fs.mkdirSync(capsuleDir, { recursive: true });

    const artifactsDir = path.join(capsuleDir, "artifacts");
    fs.mkdirSync(artifactsDir, { recursive: true });

    const workOrderPath = this.writeWorkOrderMd(capsuleDir, args.workOrder);
    this.writeConstraintsJson(capsuleDir, args.workOrder, args.runManifest);
    const runManifestPath = this.writeRunManifestJson(capsuleDir, args.runManifest);
    this.writeEmptyFile(capsuleDir, "progress.jsonl");
    this.writeEmptyFile(capsuleDir, "final_report.md");
    const promptPath = this.writePromptMd(capsuleDir);

    return {
      capsulePath: capsuleDir,
      workOrderPath,
      runManifestPath,
      promptPath,
    };
  }

  private writeWorkOrderMd(capsuleDir: string, wo: ParsedWorkOrder): string {
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
      "",
      "## Constraints",
      `- **Allowed Paths**: ${wo.constraints?.allowed_paths?.join(", ") ?? "None"}`,
      `- **Forbidden Paths**: ${wo.constraints?.forbidden_paths?.join(", ") ?? "None"}`,
      `- **Max Files to Touch**: ${wo.constraints?.max_files_to_touch?.toString() ?? "None"}`,
      "",
      "## Verification",
      `- **Commands**: ${wo.verification?.commands?.join(", ") ?? "None"}`,
      `- **Timeout Seconds**: ${wo.verification?.timeout_seconds?.toString() ?? "None"}`,
      "",
      "## Expected Output",
      "- Write the final report to `.agent-workflow/final_report.md`",
    ];
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
    return filePath;
  }

  private writeConstraintsJson(
    capsuleDir: string,
    wo: ParsedWorkOrder,
    rm: RunManifest,
  ): string {
    const filePath = path.join(capsuleDir, "constraints.json");
    const content = {
      schema_version: "agent-workflow/1",
      task_id: wo.task_id,
      run_id: rm.run_id,
      allowed_paths: wo.constraints?.allowed_paths ?? [],
      forbidden_paths: wo.constraints?.forbidden_paths ?? [],
      max_files_to_touch: wo.constraints?.max_files_to_touch ?? null,
      verification_commands: wo.verification?.commands ?? [],
      budget: {
        max_wall_time_minutes: wo.budget?.max_wall_time_minutes ?? null,
        max_output_bytes: wo.budget?.max_output_bytes ?? null,
      },
    };
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2) + "\n", "utf-8");
    return filePath;
  }

  private writeRunManifestJson(capsuleDir: string, rm: RunManifest): string {
    RunManifestSchema.parse(rm);
    const filePath = path.join(capsuleDir, "run_manifest.json");
    fs.writeFileSync(filePath, JSON.stringify(rm, null, 2) + "\n", "utf-8");
    return filePath;
  }

  private writeEmptyFile(capsuleDir: string, filename: string): string {
    const filePath = path.join(capsuleDir, filename);
    fs.writeFileSync(filePath, "", "utf-8");
    return filePath;
  }

  private writePromptMd(capsuleDir: string): string {
    const filePath = path.join(capsuleDir, "prompt.md");
    const lines = [
      "# Agent Instructions",
      "",
      "1. Read `.agent-workflow/work_order.md` to understand the task.",
      "2. Respect allowed and forbidden paths defined in the work order.",
      "3. Write the final report to `.agent-workflow/final_report.md`.",
      "4. Do not commit any changes to the repository.",
      "5. Do not modify `.agent-workflow/run_manifest.json`.",
      "6. Keep changes focused on the work order goal.",
    ];
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
    return filePath;
  }
}
