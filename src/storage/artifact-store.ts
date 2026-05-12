import * as fs from "node:fs";
import * as path from "node:path";
import type { Database } from "./database.js";
import type { ArtifactRef, ArtifactKindV1 } from "../core/types.js";
import { generateArtifactId, sha256hex } from "../core/ids.js";

interface Stmt {
  run(params: Record<string, unknown>): void;
}

export interface ArtifactStore {
  saveText(args: {
    projectId: string;
    taskId: string;
    runId: string;
    kind: ArtifactKindV1;
    filename: string;
    content: string;
    summary?: string;
  }): ArtifactRef;

  saveFile(args: {
    projectId: string;
    taskId: string;
    runId: string;
    kind: ArtifactKindV1;
    sourcePath: string;
    filename: string;
    summary?: string;
  }): ArtifactRef;

  readText(uri: string): string;
}

function validatePathSegment(name: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`Invalid ${name}: empty string`);
  }
  if (value.trim().length === 0) {
    throw new Error(`Invalid ${name}: whitespace only`);
  }
  if (value.includes("..")) {
    throw new Error(`Invalid ${name} (path traversal): "${value}"`);
  }
  if (value.includes("%")) {
    throw new Error(`Invalid ${name} (encoded path segment): "${value}"`);
  }
  if (path.isAbsolute(value)) {
    throw new Error(`Invalid ${name} (absolute path): "${value}"`);
  }
  if (value !== path.basename(value)) {
    throw new Error(`Invalid ${name} (contains path separator): "${value}"`);
  }
}

export function parseArtifactUri(uri: string): {
  taskId: string;
  runId: string;
  filename: string;
} {
  const prefix = "artifact://";
  if (!uri.startsWith(prefix)) {
    throw new Error(`Invalid artifact URI: ${uri}`);
  }
  const rest = uri.slice(prefix.length);
  if (rest.includes("?") || rest.includes("#") || rest.includes("\\")) {
    throw new Error(`Invalid artifact URI: ${uri}`);
  }

  const parts = rest.split("/");
  if (parts.length !== 3) {
    throw new Error(`Invalid artifact URI: ${uri}`);
  }

  const [taskId, runId, filename] = parts;
  validatePathSegment("taskId", taskId);
  validatePathSegment("runId", runId);
  validatePathSegment("filename", filename);
  return { taskId, runId, filename };
}

export class LocalArtifactStore implements ArtifactStore {
  private insertStmt: Stmt;

  constructor(
    private db: Database,
    private repoPath: string,
  ) {
    this.insertStmt = db.prepare(`
      insert into artifacts (
        id, project_id, task_id, run_id, kind, uri, path, checksum, summary, created_at
      ) values (
        @id, @project_id, @task_id, @run_id, @kind, @uri, @path, @checksum, @summary, @created_at
      )
    `) as unknown as Stmt;
  }

  private artifactDir(taskId: string, runId: string): string {
    return path.resolve(this.repoPath, ".agentflow", "artifacts", taskId, runId);
  }

  private artifactUri(taskId: string, runId: string, filename: string): string {
    return `artifact://${taskId}/${runId}/${filename}`;
  }

  private artifactPath(taskId: string, runId: string, filename: string): string {
    const baseDir = this.artifactDir(taskId, runId);
    const filePath = path.resolve(baseDir, filename);
    const relative = path.relative(baseDir, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Invalid artifact URI path traversal: ${filename}`);
    }
    return filePath;
  }

  private insertArtifact(params: {
    id: string;
    projectId: string;
    taskId: string;
    runId: string;
    kind: ArtifactKindV1;
    filePath: string;
    checksum: string;
    summary?: string;
    filename: string;
  }): ArtifactRef {
    const uri = this.artifactUri(params.taskId, params.runId, params.filename);
    this.insertStmt.run({
      id: params.id,
      project_id: params.projectId,
      task_id: params.taskId,
      run_id: params.runId,
      kind: params.kind,
      uri,
      path: params.filePath,
      checksum: params.checksum,
      summary: params.summary ?? null,
      created_at: new Date().toISOString(),
    });

    return {
      uri,
      kind: params.kind,
      checksum: params.checksum,
      summary: params.summary,
    };
  }

  saveText(args: {
    projectId: string;
    taskId: string;
    runId: string;
    kind: ArtifactKindV1;
    filename: string;
    content: string;
    summary?: string;
  }): ArtifactRef {
    validatePathSegment("taskId", args.taskId);
    validatePathSegment("runId", args.runId);
    validatePathSegment("filename", args.filename);

    const dir = this.artifactDir(args.taskId, args.runId);
    fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, args.filename);
    fs.writeFileSync(filePath, args.content, "utf-8");

    const checksum = `sha256:${sha256hex(args.content)}`;

    return this.insertArtifact({
      id: generateArtifactId(),
      projectId: args.projectId,
      taskId: args.taskId,
      runId: args.runId,
      kind: args.kind,
      filePath,
      checksum,
      summary: args.summary,
      filename: args.filename,
    });
  }

  saveFile(args: {
    projectId: string;
    taskId: string;
    runId: string;
    kind: ArtifactKindV1;
    sourcePath: string;
    filename: string;
    summary?: string;
  }): ArtifactRef {
    validatePathSegment("taskId", args.taskId);
    validatePathSegment("runId", args.runId);
    validatePathSegment("filename", args.filename);

    const dir = this.artifactDir(args.taskId, args.runId);
    fs.mkdirSync(dir, { recursive: true });

    const destPath = path.join(dir, args.filename);
    fs.copyFileSync(args.sourcePath, destPath);

    const content = fs.readFileSync(destPath);
    const checksum = `sha256:${sha256hex(content)}`;

    return this.insertArtifact({
      id: generateArtifactId(),
      projectId: args.projectId,
      taskId: args.taskId,
      runId: args.runId,
      kind: args.kind,
      filePath: destPath,
      checksum,
      summary: args.summary,
      filename: args.filename,
    });
  }

  readText(uri: string): string {
    const parsed = parseArtifactUri(uri);
    const filePath = this.artifactPath(parsed.taskId, parsed.runId, parsed.filename);
    return fs.readFileSync(filePath, "utf-8");
  }
}
