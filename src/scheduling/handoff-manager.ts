import * as fs from "node:fs";
import * as path from "node:path";
import type { HandoffPacket, ArtifactRef } from "../core/types.js";
import { HandoffPacketSchema } from "../core/schemas-v1.js";
import type { ArtifactStore } from "../storage/artifact-store.js";

// ─── Interface ───────────────────────────────────────────────────────────────

export interface HandoffManager {
  build(args: {
    taskId: string;
    fromRunId: string;
    fromAgentId: string;
    workOrderGoal: string;
    reason: HandoffPacket["reason"];
    diffArtifactUri?: string;
    verificationOutputUri?: string;
    reviewVerdictUri?: string;
    priorExcludes?: string[];
  }): HandoffPacket;

  persist(packet: HandoffPacket): ArtifactRef;

  attachToBrief(args: {
    workspacePath: string;
    packet: HandoffPacket;
  }): void;
}

// ─── Stable template constants ───────────────────────────────────────────────

function buildSummary(packet: HandoffPacket): string {
  const lines: string[] = [];
  lines.push(`Previous attempt by agent "${packet.from_agent_id}" (run ${packet.from_run_id}) was not successful.`);
  lines.push(`Reason: ${packet.reason}.`);

  if (packet.diff_artifact_uri) {
    lines.push(`Diff artifact available at: ${packet.diff_artifact_uri}`);
  }
  if (packet.verification_output_uri) {
    lines.push(`Verification output available at: ${packet.verification_output_uri}`);
  }
  if (packet.review_verdict_uri) {
    lines.push(`Review verdict available at: ${packet.review_verdict_uri}`);
  }

  const excludes = packet.exclude_agent_ids;
  if (excludes.length > 0) {
    lines.push(`Excluded agents for next attempt: ${excludes.join(", ")}`);
  } else {
    lines.push("No agents excluded for next attempt.");
  }

  return lines.join("\n");
}

function buildRemainingWork(workOrderGoal: string, reason: string, fromRunId: string): string {
  return [
    workOrderGoal,
    "",
    `[Previous attempt (run ${fromRunId}) ended with: ${reason}]`,
  ].join("\n");
}

// ─── Default implementation ──────────────────────────────────────────────────

export class DefaultHandoffManager implements HandoffManager {
  private readonly artifactStore: ArtifactStore;
  private readonly projectId: string;
  private readonly now: () => Date;

  constructor(args: {
    artifactStore: ArtifactStore;
    projectId?: string;
    now?: () => Date;
  }) {
    this.artifactStore = args.artifactStore;
    this.projectId = args.projectId ?? "default";
    this.now = args.now ?? (() => new Date());
  }

  build(args: {
    taskId: string;
    fromRunId: string;
    fromAgentId: string;
    workOrderGoal: string;
    reason: HandoffPacket["reason"];
    diffArtifactUri?: string;
    verificationOutputUri?: string;
    reviewVerdictUri?: string;
    priorExcludes?: string[];
  }): HandoffPacket {
    // Build exclude_agent_ids: priorExcludes + fromAgentId, dedup first-seen order
    const prior = args.priorExcludes ?? [];
    const seen = new Set<string>();
    const exclude_agent_ids: string[] = [];

    for (const id of prior) {
      if (!seen.has(id)) {
        seen.add(id);
        exclude_agent_ids.push(id);
      }
    }
    if (!seen.has(args.fromAgentId)) {
      exclude_agent_ids.push(args.fromAgentId);
    }

    const raw: HandoffPacket = {
      schema_version: "agent-workflow/1",
      task_id: args.taskId,
      from_run_id: args.fromRunId,
      from_agent_id: args.fromAgentId,
      reason: args.reason,
      summary: "", // filled below
      remaining_work: "", // filled below
      exclude_agent_ids,
      created_at: this.now().toISOString(),
    };

    // Optional URI fields — only include when provided
    if (args.diffArtifactUri !== undefined) {
      raw.diff_artifact_uri = args.diffArtifactUri;
    }
    if (args.verificationOutputUri !== undefined) {
      raw.verification_output_uri = args.verificationOutputUri;
    }
    if (args.reviewVerdictUri !== undefined) {
      raw.review_verdict_uri = args.reviewVerdictUri;
    }

    // Build template-based fields (must be done after the packet shape is stable)
    raw.summary = buildSummary(raw);
    raw.remaining_work = buildRemainingWork(args.workOrderGoal, args.reason, args.fromRunId);

    // Validate before returning
    return HandoffPacketSchema.parse(raw) as HandoffPacket;
  }

  persist(packet: HandoffPacket): ArtifactRef {
    const prettyJson = JSON.stringify(packet, null, 2) + "\n";

    return this.artifactStore.saveText({
      projectId: this.projectId,
      taskId: packet.task_id,
      runId: packet.from_run_id,
      kind: "handoff_packet",
      filename: "handoff_packet.json",
      content: prettyJson,
      summary: `Handoff packet for ${packet.from_run_id}`,
    });
  }

  attachToBrief(args: {
    workspacePath: string;
    packet: HandoffPacket;
  }): void {
    const agentDir = path.join(args.workspacePath, ".agent-workflow");
    const promptPath = path.join(agentDir, "prompt.md");

    // Require existing prompt.md
    if (!fs.existsSync(promptPath)) {
      throw new Error(
        `.agent-workflow/prompt.md not found at ${promptPath}. ` +
        `Cannot attach handoff context without an existing prompt.`,
      );
    }

    // Write handoff_packet.json alongside prompt.md
    const handoffPath = path.join(agentDir, "handoff_packet.json");
    const prettyJson = JSON.stringify(args.packet, null, 2) + "\n";
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(handoffPath, prettyJson, "utf-8");

    // Prepend takeover paragraph
    const existingContent = fs.readFileSync(promptPath, "utf-8");
    const takeover = buildTakeoverParagraph(args.packet);
    fs.writeFileSync(promptPath, takeover + existingContent, "utf-8");
  }
}

// ─── Takeover paragraph template ─────────────────────────────────────────────

function buildTakeoverParagraph(packet: HandoffPacket): string {
  const lines: string[] = [];
  lines.push("## Handoff — Taking Over a Previous Attempt");
  lines.push("");
  lines.push(
    `You are taking over from a previous attempt by agent \`${packet.from_agent_id}\` ` +
    `(run \`${packet.from_run_id}\`), which ended with reason: **${packet.reason}**.`,
  );
  lines.push("");

  lines.push("### Handoff Summary");
  lines.push("");
  lines.push(packet.summary);
  lines.push("");

  if (packet.diff_artifact_uri) {
    lines.push(`- Diff artifact: \`${packet.diff_artifact_uri}\``);
  }
  if (packet.verification_output_uri) {
    lines.push(`- Verification output: \`${packet.verification_output_uri}\``);
  }
  if (packet.review_verdict_uri) {
    lines.push(`- Review verdict: \`${packet.review_verdict_uri}\``);
  }

  if (
    packet.diff_artifact_uri ||
    packet.verification_output_uri ||
    packet.review_verdict_uri
  ) {
    lines.push("");
  }

  lines.push("Read the artifacts above before proposing changes. The handoff packet is available at `.agent-workflow/handoff_packet.json`.");
  lines.push("");
  lines.push("---");
  lines.push("");

  return lines.join("\n");
}
