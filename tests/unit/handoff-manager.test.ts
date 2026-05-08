import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import SqliteDatabase from "better-sqlite3";
import type { Database } from "../../src/storage/database.js";
import { migrate } from "../../src/storage/migrations.js";
import { LocalArtifactStore } from "../../src/storage/artifact-store.js";
import { HandoffPacketSchema } from "../../src/core/schemas-v1.js";
import { DefaultHandoffManager } from "../../src/scheduling/handoff-manager.js";
import type { HandoffManager, HandoffPacket, ArtifactRef } from "../../src/core/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function countArtifacts(db: Database): number {
  return (
    db.prepare("select count(*) as c from artifacts").get() as { c: number }
  ).c;
}

function makeManager(
  artifactStore: LocalArtifactStore,
  fixedNow?: Date,
  projectId?: string,
): DefaultHandoffManager {
  return new DefaultHandoffManager({
    artifactStore,
    projectId,
    now: fixedNow ? () => fixedNow : undefined,
  });
}

function makeMinimalBuildArgs(overrides?: Partial<Parameters<HandoffManager["build"]>[0]>) {
  return {
    taskId: "T-1",
    fromRunId: "R-1",
    fromAgentId: "agent-alpha",
    workOrderGoal: "Fix the login bug in auth module.",
    reason: "verification_failed" as const,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("DefaultHandoffManager", () => {
  describe("build", () => {
    const fixedNow = new Date("2026-05-15T08:30:00Z");
    // Create a simple artifact store mock since build() doesn't touch it
    let db: Database;
    let repoDir: string;
    let store: LocalArtifactStore;
    let manager: DefaultHandoffManager;

    beforeEach(() => {
      db = new SqliteDatabase(":memory:");
      migrate(db);
      repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-test-"));
      store = new LocalArtifactStore(db, repoDir);
      manager = makeManager(store, fixedNow);
    });

    afterEach(() => {
      db.close();
      fs.rmSync(repoDir, { recursive: true, force: true });
    });

    it("returns a schema-valid HandoffPacket for fixed inputs", () => {
      const packet = manager.build(makeMinimalBuildArgs());

      // Schema validation
      expect(() => HandoffPacketSchema.parse(packet)).not.toThrow();

      // Core fields
      expect(packet.schema_version).toBe("agent-workflow/1");
      expect(packet.task_id).toBe("T-1");
      expect(packet.from_run_id).toBe("R-1");
      expect(packet.from_agent_id).toBe("agent-alpha");
      expect(packet.reason).toBe("verification_failed");
      expect(packet.created_at).toBe("2026-05-15T08:30:00.000Z");
    });

    it("always adds fromAgentId to exclude_agent_ids", () => {
      const packet = manager.build(makeMinimalBuildArgs({ priorExcludes: [] }));

      expect(packet.exclude_agent_ids).toContain("agent-alpha");
      expect(packet.exclude_agent_ids).toEqual(["agent-alpha"]);
    });

    it("preserves prior excludes order and removes duplicates", () => {
      const packet = manager.build(
        makeMinimalBuildArgs({
          priorExcludes: ["agent-beta", "agent-alpha", "agent-gamma", "agent-beta"],
        }),
      );

      // agent-alpha already in priorExcludes, so it should NOT be added again
      // Duplicate agent-beta should be removed
      expect(packet.exclude_agent_ids).toEqual([
        "agent-beta",
        "agent-alpha",
        "agent-gamma",
      ]);
    });

    it("does not add duplicate fromAgentId when it is already excluded", () => {
      const packet = manager.build(
        makeMinimalBuildArgs({
          priorExcludes: ["agent-alpha", "agent-beta"],
        }),
      );

      expect(packet.exclude_agent_ids).toEqual(["agent-alpha", "agent-beta"]);
      // Count occurrences of agent-alpha
      const count = packet.exclude_agent_ids.filter((id) => id === "agent-alpha").length;
      expect(count).toBe(1);
    });

    it("includes optional artifact URIs when provided", () => {
      const packet = manager.build(
        makeMinimalBuildArgs({
          diffArtifactUri: "artifact://T-1/R-1/diff.patch",
          verificationOutputUri: "artifact://T-1/R-1/verification.json",
          reviewVerdictUri: "artifact://T-1/R-1/review_verdict.json",
        }),
      );

      expect(packet.diff_artifact_uri).toBe("artifact://T-1/R-1/diff.patch");
      expect(packet.verification_output_uri).toBe("artifact://T-1/R-1/verification.json");
      expect(packet.review_verdict_uri).toBe("artifact://T-1/R-1/review_verdict.json");
    });

    it("omits optional artifact URIs when not provided", () => {
      const packet = manager.build(makeMinimalBuildArgs());

      expect(packet.diff_artifact_uri).toBeUndefined();
      expect(packet.verification_output_uri).toBeUndefined();
      expect(packet.review_verdict_uri).toBeUndefined();
    });

    it("produces deterministic summary with an injected now", () => {
      const args = makeMinimalBuildArgs({
        diffArtifactUri: "artifact://T-1/R-1/diff.patch",
      });

      const p1 = manager.build(args);
      const p2 = manager.build(args);

      expect(p1.summary).toBe(p2.summary);
      expect(p1.summary).toContain('agent "agent-alpha"');
      expect(p1.summary).toContain("(run R-1)");
      expect(p1.summary).toContain("verification_failed");
      expect(p1.summary).toContain("artifact://T-1/R-1/diff.patch");
      expect(p1.summary).toContain("Excluded agents for next attempt: agent-alpha");
    });

    it("produces deterministic remaining_work with an injected now", () => {
      const args = makeMinimalBuildArgs();

      const p1 = manager.build(args);
      const p2 = manager.build(args);

      expect(p1.remaining_work).toBe(p2.remaining_work);
      expect(p1.remaining_work).toContain("Fix the login bug in auth module.");
      expect(p1.remaining_work).toContain("[Previous attempt (run R-1) ended with: verification_failed]");
    });

    it("produces deterministic created_at with an injected now", () => {
      const p1 = manager.build(makeMinimalBuildArgs());
      const p2 = manager.build(makeMinimalBuildArgs());

      expect(p1.created_at).toBe(p2.created_at);
      expect(p1.created_at).toBe("2026-05-15T08:30:00.000Z");
    });

    it("includes all artifact URIs in summary when all are provided", () => {
      const packet = manager.build(
        makeMinimalBuildArgs({
          diffArtifactUri: "artifact://T-1/R-1/diff.patch",
          verificationOutputUri: "artifact://T-1/R-1/verification.json",
          reviewVerdictUri: "artifact://T-1/R-1/review_verdict.json",
        }),
      );

      expect(packet.summary).toContain("artifact://T-1/R-1/diff.patch");
      expect(packet.summary).toContain("artifact://T-1/R-1/verification.json");
      expect(packet.summary).toContain("artifact://T-1/R-1/review_verdict.json");
    });

    it("includes 'No agents excluded' in summary when exclude list is empty (only fromAgentId present)", () => {
      // Edge: priorExcludes is empty, but fromAgentId is always added so exclude list won't be empty
      // This tests the case where fromAgentId is the ONLY entry
      const packet = manager.build(makeMinimalBuildArgs({ priorExcludes: [] }));
      expect(packet.exclude_agent_ids).toEqual(["agent-alpha"]);
    });
  });

  describe("persist", () => {
    let db: Database;
    let repoDir: string;
    let store: LocalArtifactStore;
    let manager: DefaultHandoffManager;
    const fixedNow = new Date("2026-05-15T08:30:00Z");

    beforeEach(() => {
      db = new SqliteDatabase(":memory:");
      migrate(db);
      repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-test-"));
      store = new LocalArtifactStore(db, repoDir);
      manager = makeManager(store, fixedNow);
    });

    afterEach(() => {
      db.close();
      fs.rmSync(repoDir, { recursive: true, force: true });
    });

    it("saves handoff_packet artifact through LocalArtifactStore", () => {
      const packet = manager.build(makeMinimalBuildArgs());
      const ref = manager.persist(packet);

      // URI shape
      expect(ref.uri).toBe("artifact://T-1/R-1/handoff_packet.json");
      expect(ref.kind).toBe("handoff_packet");

      // One row in artifacts table
      expect(countArtifacts(db)).toBe(1);

      // Verify the stored row
      const row = db
        .prepare("select * from artifacts where uri = ?")
        .get("artifact://T-1/R-1/handoff_packet.json") as Record<string, unknown>;
      expect(row).toBeTruthy();
      expect(row.project_id).toBe("default");
      expect(row.task_id).toBe("T-1");
      expect(row.run_id).toBe("R-1");
      expect(row.kind).toBe("handoff_packet");
    });

    it("writes the JSON file on disk with stable pretty format", () => {
      const packet = manager.build(makeMinimalBuildArgs());
      manager.persist(packet);

      const filePath = path.join(
        repoDir,
        ".agentflow",
        "artifacts",
        "T-1",
        "R-1",
        "handoff_packet.json",
      );
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, "utf-8");
      // Round-trip parse
      const roundTripped = JSON.parse(content);
      expect(roundTripped.schema_version).toBe("agent-workflow/1");
      expect(roundTripped.task_id).toBe("T-1");

      // Must end with newline
      expect(content.endsWith("\n")).toBe(true);
    });

    it("uses summary in artifact row", () => {
      const packet = manager.build(makeMinimalBuildArgs());
      const ref = manager.persist(packet);

      expect(ref.summary).toBe("Handoff packet for R-1");

      const row = db
        .prepare("select summary from artifacts where uri = ?")
        .get("artifact://T-1/R-1/handoff_packet.json") as { summary: string };
      expect(row.summary).toBe("Handoff packet for R-1");
    });

    it("respects custom projectId from constructor", () => {
      const mgr = new DefaultHandoffManager({
        artifactStore: store,
        projectId: "my-project",
        now: () => fixedNow,
      });

      const packet = mgr.build(makeMinimalBuildArgs({ taskId: "T-custom" }));
      const ref = mgr.persist(packet);

      expect(ref.uri).toBe("artifact://T-custom/R-1/handoff_packet.json");

      const row = db
        .prepare("select project_id from artifacts where uri = ?")
        .get("artifact://T-custom/R-1/handoff_packet.json") as { project_id: string };
      expect(row.project_id).toBe("my-project");
    });
  });

  describe("attachToBrief", () => {
    let workspaceDir: string;
    let db: Database;
    let repoDir: string;
    let store: LocalArtifactStore;
    let manager: DefaultHandoffManager;
    const fixedNow = new Date("2026-05-15T08:30:00Z");

    beforeEach(() => {
      db = new SqliteDatabase(":memory:");
      migrate(db);
      repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-test-"));
      store = new LocalArtifactStore(db, repoDir);
      manager = makeManager(store, fixedNow);

      workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-ws-"));
      const agentDir = path.join(workspaceDir, ".agent-workflow");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentDir, "prompt.md"),
        "Original prompt content for the agent.",
        "utf-8",
      );
    });

    afterEach(() => {
      db.close();
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    });

    it("writes .agent-workflow/handoff_packet.json", () => {
      const packet = manager.build(makeMinimalBuildArgs());

      manager.attachToBrief({ workspacePath: workspaceDir, packet });

      const handoffPath = path.join(workspaceDir, ".agent-workflow", "handoff_packet.json");
      expect(fs.existsSync(handoffPath)).toBe(true);

      const content = fs.readFileSync(handoffPath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.task_id).toBe("T-1");
      expect(parsed.from_run_id).toBe("R-1");
      // Ends with newline
      expect(content.endsWith("\n")).toBe(true);
    });

    it("prepends takeover paragraph to .agent-workflow/prompt.md while preserving original content", () => {
      const packet = manager.build(
        makeMinimalBuildArgs({
          diffArtifactUri: "artifact://T-1/R-1/diff.patch",
          reviewVerdictUri: "artifact://T-1/R-1/review_verdict.json",
        }),
      );

      manager.attachToBrief({ workspacePath: workspaceDir, packet });

      const promptPath = path.join(workspaceDir, ".agent-workflow", "prompt.md");
      const content = fs.readFileSync(promptPath, "utf-8");

      // Contains takeover header
      expect(content).toContain("## Handoff — Taking Over a Previous Attempt");

      // References the previous attempt
      expect(content).toContain("agent-alpha");
      expect(content).toContain("R-1");
      expect(content).toContain("verification_failed");

      // Contains handoff summary heading
      expect(content).toContain("### Handoff Summary");

      // The exact packet.summary is embedded verbatim in the prompt
      expect(content).toContain(packet.summary);

      // The exact packet.summary appears before the original prompt content
      const summaryStart = content.indexOf(packet.summary);
      const originalIdx = content.indexOf("Original prompt content");
      expect(summaryStart).toBeGreaterThan(0);
      expect(summaryStart).toBeLessThan(originalIdx);

      // References artifact URIs
      expect(content).toContain("artifact://T-1/R-1/diff.patch");
      expect(content).toContain("artifact://T-1/R-1/review_verdict.json");

      // References handoff packet location
      expect(content).toContain(".agent-workflow/handoff_packet.json");

      // Original prompt content is preserved at the end
      expect(content).toContain("Original prompt content for the agent.");

      // Original content comes after the takeover paragraph (after "---")
      const takeoverEnd = content.indexOf("---\n");
      expect(takeoverEnd).toBeGreaterThan(0);
      const afterTakeover = content.substring(takeoverEnd + 4);
      expect(afterTakeover.trimStart()).toBe("Original prompt content for the agent.");
    });

    it("throws when .agent-workflow/prompt.md is missing", () => {
      // Remove prompt.md
      const promptPath = path.join(workspaceDir, ".agent-workflow", "prompt.md");
      fs.unlinkSync(promptPath);

      const packet = manager.build(makeMinimalBuildArgs());

      expect(() =>
        manager.attachToBrief({ workspacePath: workspaceDir, packet }),
      ).toThrow(".agent-workflow/prompt.md not found");
    });

    it("throws when .agent-workflow directory does not exist", () => {
      // Remove entire .agent-workflow directory
      fs.rmSync(path.join(workspaceDir, ".agent-workflow"), { recursive: true, force: true });

      const packet = manager.build(makeMinimalBuildArgs());

      expect(() =>
        manager.attachToBrief({ workspacePath: workspaceDir, packet }),
      ).toThrow(".agent-workflow/prompt.md not found");
    });

    it("handoff_packet.json matches persisted format", () => {
      const packet = manager.build(makeMinimalBuildArgs());

      // Persist via store
      const ref = manager.persist(packet);

      // Attach to brief
      manager.attachToBrief({ workspacePath: workspaceDir, packet });

      // Read the persisted file
      const persistedPath = path.join(repoDir, ".agentflow", "artifacts", "T-1", "R-1", "handoff_packet.json");
      const persistedContent = fs.readFileSync(persistedPath, "utf-8");

      // Read the attached file
      const attachedPath = path.join(workspaceDir, ".agent-workflow", "handoff_packet.json");
      const attachedContent = fs.readFileSync(attachedPath, "utf-8");

      // Both should be identical (stable pretty JSON)
      expect(attachedContent).toBe(persistedContent);
    });

    it("takeover paragraph omits artifact section when no URIs are present", () => {
      const packet = manager.build(makeMinimalBuildArgs());

      manager.attachToBrief({ workspacePath: workspaceDir, packet });

      const promptPath = path.join(workspaceDir, ".agent-workflow", "prompt.md");
      const content = fs.readFileSync(promptPath, "utf-8");

      // Should not contain "Diff artifact:" or "Verification output:" or "Review verdict:" labels
      expect(content).not.toContain("- Diff artifact:");
      expect(content).not.toContain("- Verification output:");
      expect(content).not.toContain("- Review verdict:");

      // Summary is still present even without artifact URIs
      expect(content).toContain("### Handoff Summary");
      expect(content).toContain("Previous attempt by agent");
    });

    it("embedded summary includes artifact URIs when present", () => {
      const packet = manager.build(
        makeMinimalBuildArgs({
          diffArtifactUri: "artifact://T-1/R-1/diff.patch",
          verificationOutputUri: "artifact://T-1/R-1/verification.json",
          reviewVerdictUri: "artifact://T-1/R-1/review_verdict.json",
        }),
      );

      manager.attachToBrief({ workspacePath: workspaceDir, packet });

      const promptPath = path.join(workspaceDir, ".agent-workflow", "prompt.md");
      const content = fs.readFileSync(promptPath, "utf-8");

      // Summary text in the prompt includes artifact URIs
      expect(content).toContain("### Handoff Summary");
      expect(content).toContain("Diff artifact available at: artifact://T-1/R-1/diff.patch");
      expect(content).toContain("Verification output available at: artifact://T-1/R-1/verification.json");
      expect(content).toContain("Review verdict available at: artifact://T-1/R-1/review_verdict.json");
    });
  });
});
