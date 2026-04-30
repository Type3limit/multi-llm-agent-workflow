import { createHash, randomUUID } from "node:crypto";

export function generateRunId(): string {
  return `R-${randomUUID().slice(0, 8)}`;
}

export function generateEventId(): string {
  return `E-${randomUUID().slice(0, 8)}`;
}

export function generateArtifactId(): string {
  return `A-${randomUUID().slice(0, 8)}`;
}

export function sha256hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
