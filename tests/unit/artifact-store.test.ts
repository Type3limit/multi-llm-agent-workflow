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
});
