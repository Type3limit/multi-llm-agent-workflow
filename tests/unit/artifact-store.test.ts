import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import SqliteDatabase from "better-sqlite3";
import type { Database } from "../../src/storage/database.js";
import { migrate } from "../../src/storage/migrations.js";
import { LocalArtifactStore } from "../../src/storage/artifact-store.js";
import { ArtifactRefSchema } from "../../src/core/schemas.js";
import type { ArtifactRef } from "../../src/core/types.js";

function countArtifacts(db: Database): number {
  return (
    db.prepare("select count(*) as c from artifacts").get() as { c: number }
  ).c;
}

describe("LocalArtifactStore", () => {
  let db: Database;
  let repoDir: string;
  let store: LocalArtifactStore;

  beforeEach(() => {
    db = new SqliteDatabase(":memory:");
    migrate(db);
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-test-"));
    store = new LocalArtifactStore(db, repoDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  describe("saveText", () => {
    it("writes a file, returns ArtifactRef, and inserts artifacts row", () => {
      const ref = store.saveText({
        projectId: "default",
        taskId: "T-1",
        runId: "R-1",
        kind: "stdout_tail",
        filename: "stdout.txt",
        content: "Hello, world!",
      });

      // Valid ArtifactRef
      expect(() => ArtifactRefSchema.parse(ref)).not.toThrow();

      // URI
      expect(ref.uri).toBe("artifact://T-1/R-1/stdout.txt");

      // Checksum
      expect(ref.checksum).toMatch(/^sha256:[a-f0-9]{64}$/);

      // File on disk
      const filePath = path.join(repoDir, ".agentflow", "artifacts", "T-1", "R-1", "stdout.txt");
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, "utf-8")).toBe("Hello, world!");

      // Row in DB
      expect(countArtifacts(db)).toBe(1);
    });

    it("uses summary when provided", () => {
      const ref = store.saveText({
        projectId: "default",
        taskId: "T-1",
        runId: "R-1",
        kind: "diff",
        filename: "diff.patch",
        content: "diff content",
        summary: "3 files changed",
      });
      expect(ref.summary).toBe("3 files changed");
    });

    it("stores different task/run artifacts in separate directories", () => {
      store.saveText({
        projectId: "p1", taskId: "T-1", runId: "R-1", kind: "diff", filename: "a.txt", content: "a",
      });
      store.saveText({
        projectId: "p2", taskId: "T-2", runId: "R-2", kind: "diff", filename: "b.txt", content: "b",
      });

      expect(countArtifacts(db)).toBe(2);

      const dir1 = path.join(repoDir, ".agentflow", "artifacts", "T-1", "R-1");
      const dir2 = path.join(repoDir, ".agentflow", "artifacts", "T-2", "R-2");
      expect(fs.existsSync(path.join(dir1, "a.txt"))).toBe(true);
      expect(fs.existsSync(path.join(dir2, "b.txt"))).toBe(true);
    });
  });

  describe("readText", () => {
    it("reads text back from a LocalArtifactStore artifact URI", () => {
      const ref = store.saveText({
        projectId: "default",
        taskId: "T-read",
        runId: "R-read",
        kind: "diff",
        filename: "diff.patch",
        content: "diff --git a/a b/a\n+change\n",
      });

      expect(store.readText(ref.uri)).toBe("diff --git a/a b/a\n+change\n");
    });

    it("rejects malformed artifact URIs", () => {
      expect(() => store.readText("file:///tmp/diff.patch")).toThrow(
        "Invalid artifact URI",
      );
      expect(() => store.readText("artifact://T/R")).toThrow(
        "Invalid artifact URI",
      );
    });

    it("rejects artifact URI path traversal and encoded segments", () => {
      expect(() => store.readText("artifact://T/R/..")).toThrow(
        "path traversal",
      );
      expect(() => store.readText("artifact://T/R/%2e%2e")).toThrow(
        "encoded path segment",
      );
      expect(() => store.readText("artifact://T/R/sub/file.txt")).toThrow(
        "Invalid artifact URI",
      );
    });
  });

  describe("saveFile", () => {
    it("copies a file, computes checksum, and inserts row", () => {
      // Create a source file
      const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-src-"));
      const srcPath = path.join(srcDir, "source.txt");
      fs.writeFileSync(srcPath, "source content");

      const ref = store.saveFile({
        projectId: "default",
        taskId: "T-1",
        runId: "R-1",
        kind: "diff",
        sourcePath: srcPath,
        filename: "copied.txt",
        summary: "copied file",
      });

      expect(ref.uri).toBe("artifact://T-1/R-1/copied.txt");
      expect(ref.checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(ref.summary).toBe("copied file");
      expect(countArtifacts(db)).toBe(1);

      // Verify content matches
      const destPath = path.join(repoDir, ".agentflow", "artifacts", "T-1", "R-1", "copied.txt");
      expect(fs.readFileSync(destPath, "utf-8")).toBe("source content");

      fs.rmSync(srcDir, { recursive: true, force: true });
    });
  });

  describe("path segment validation", () => {
    it("rejects taskId with '..'", () => {
      expect(() =>
        store.saveText({
          projectId: "p", taskId: "../escape", runId: "R", kind: "diff",
          filename: "f.txt", content: "x",
        }),
      ).toThrow("taskId");
    });

    it("rejects runId with '..'", () => {
      expect(() =>
        store.saveText({
          projectId: "p", taskId: "T", runId: "../escape", kind: "diff",
          filename: "f.txt", content: "x",
        }),
      ).toThrow("runId");
    });

    it("rejects whitespace-only taskId", () => {
      expect(() =>
        store.saveText({
          projectId: "p", taskId: "  ", runId: "R", kind: "diff",
          filename: "f.txt", content: "x",
        }),
      ).toThrow("taskId");
    });

    it("rejects runId with path separator", () => {
      expect(() =>
        store.saveText({
          projectId: "p", taskId: "T", runId: "R/1", kind: "diff",
          filename: "f.txt", content: "x",
        }),
      ).toThrow("runId");
    });
  });

  describe("filename validation", () => {
    it("rejects '..' in filename", () => {
      expect(() =>
        store.saveText({
          projectId: "p", taskId: "T", runId: "R", kind: "diff",
          filename: "../escape.txt", content: "x",
        }),
      ).toThrow("path traversal");
    });

    it("rejects absolute path", () => {
      expect(() =>
        store.saveText({
          projectId: "p", taskId: "T", runId: "R", kind: "diff",
          filename: "/etc/passwd", content: "x",
        }),
      ).toThrow("absolute path");
    });

    it("rejects path separator in filename", () => {
      expect(() =>
        store.saveText({
          projectId: "p", taskId: "T", runId: "R", kind: "diff",
          filename: "subdir/file.txt", content: "x",
        }),
      ).toThrow("path separator");
    });

    it("rejects empty filename", () => {
      expect(() =>
        store.saveText({
          projectId: "p", taskId: "T", runId: "R", kind: "diff",
          filename: "", content: "x",
        }),
      ).toThrow("empty string");
    });
  });

  // ─── v1 artifact kinds ──────────────────────────────────────────────

  describe("v1 artifact kinds", () => {
    it("accepts review_verdict kind", () => {
      const ref = store.saveText({
        projectId: "default",
        taskId: "T-v1",
        runId: "R-v1",
        kind: "review_verdict",
        filename: "review_verdict.json",
        content: '{"verdict":"approved"}',
      });
      expect(ref.kind).toBe("review_verdict");
      expect(() => ArtifactRefSchema.parse(ref)).not.toThrow();
    });

    it("accepts handoff_packet kind", () => {
      const ref = store.saveText({
        projectId: "default",
        taskId: "T-v1",
        runId: "R-v1",
        kind: "handoff_packet",
        filename: "handoff.json",
        content: '{}',
      });
      expect(ref.kind).toBe("handoff_packet");
    });

    it("accepts schedule_decision kind", () => {
      const ref = store.saveText({
        projectId: "default",
        taskId: "T-v1",
        runId: "R-v1",
        kind: "schedule_decision",
        filename: "decision.json",
        content: '{"picked_agent_id":"a"}',
      });
      expect(ref.kind).toBe("schedule_decision");
    });
  });
});
