import { z } from "zod";
import type {
  RunManifest,
  ArtifactRef,
  EventEnvelope,
  EventPayload,
  WorkOrderV0,
  WorkOrderV1,
  AgentProfileV0,
  AgentProfileV1,
} from "./types.js";
import { WorkOrderV1Schema, AgentProfileV1Schema } from "./schemas-v1.js";
import type { ParsedWorkOrderV1, ParsedAgentProfileV1 } from "./schemas-v1.js";

// ─── WorkOrder v0 ────────────────────────────────────────────────────────────

export const WorkOrderSchema = z.object({
  schema_version: z.literal("workflow/v0"),
  task_id: z.string().min(1),
  project_id: z.string().min(1).default("default"),
  title: z.string().min(1),
  type: z.enum([
    "code_change",
    "docs_update",
    "research_report",
    "ui_review",
    "data_analysis",
  ]),
  goal: z.string().min(1),
  acceptance_criteria: z.array(z.string().min(1)),
  repo: z.object({
    path: z.string().min(1),
    base_ref: z.string().optional(),
  }),
  constraints: z
    .object({
      allowed_paths: z.array(z.string()).optional(),
      forbidden_paths: z.array(z.string()).optional(),
      max_files_to_touch: z.number().int().positive().optional(),
    })
    .optional(),
  verification: z
    .object({
      commands: z.array(z.string().min(1)),
      timeout_seconds: z.number().int().positive().optional(),
    })
    .optional(),
  agent: z.object({
    agent_id: z.string().min(1),
  }),
  budget: z
    .object({
      max_wall_time_minutes: z.number().positive().optional(),
      max_output_bytes: z.number().int().positive().optional(),
    })
    .optional(),
});

export type ParsedWorkOrder = z.infer<typeof WorkOrderSchema>;

// ─── WorkOrder v0/v1 discriminated dispatch ──────────────────────────────────

export type WorkOrder = ParsedWorkOrder | ParsedWorkOrderV1;

export function parseWorkOrder(input: unknown): WorkOrder {
  const schemaVersion = getSchemaVersion(input);
  if (schemaVersion === "workflow/v0") {
    return WorkOrderSchema.parse(input);
  }
  if (schemaVersion === "workflow/v1") {
    return WorkOrderV1Schema.parse(input);
  }
  throw new Error(
    `Unsupported schema_version: "${schemaVersion}". Only "workflow/v0" and "workflow/v1" are accepted in v1.`,
  );
}

// ─── AgentProfile v0 ─────────────────────────────────────────────────────────

export const AgentProfileSchema = z.object({
  schema_version: z.literal("workflow/v0"),
  agent_id: z.string().min(1),
  integration_mode: z.literal("official_cli"),
  command: z.object({
    executable: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().optional(),
  }),
  environment: z
    .object({
      set: z.record(z.string()).optional(),
      unset: z.array(z.string()).optional(),
    })
    .optional(),
  capabilities: z.object({
    outer_supervised: z.literal(true),
    inner_tool_control: z.literal(false),
  }),
  limits: z
    .object({
      timeout_seconds: z.number().int().positive().optional(),
      max_stdout_bytes: z.number().int().positive().optional(),
      max_stderr_bytes: z.number().int().positive().optional(),
    })
    .optional(),
});

export type ParsedAgentProfile = z.infer<typeof AgentProfileSchema>;

// ─── AgentProfile v0/v1 discriminated dispatch ───────────────────────────────

export type AgentProfile = ParsedAgentProfile | ParsedAgentProfileV1;

export function parseAgentProfile(input: unknown): AgentProfile {
  const schemaVersion = getSchemaVersion(input);
  if (schemaVersion === "workflow/v0") {
    return AgentProfileSchema.parse(input);
  }
  if (schemaVersion === "workflow/v1") {
    return AgentProfileV1Schema.parse(input);
  }
  throw new Error(
    `Unsupported schema_version: "${schemaVersion}". Only "workflow/v0" and "workflow/v1" are accepted in v1.`,
  );
}

// ─── Version extraction helper ───────────────────────────────────────────────

function getSchemaVersion(input: unknown): string {
  if (input != null && typeof input === "object" && "schema_version" in input) {
    const v = (input as Record<string, unknown>).schema_version;
    if (typeof v === "string") return v;
  }
  return "<missing>";
}

// ─── RunManifest ─────────────────────────────────────────────────────────────

export const RunManifestSchema = z.object({
  schema_version: z.literal("agent-workflow/1"),
  run_id: z.string().min(1),
  task_id: z.string().min(1),
  project_id: z.string().min(1),
  agent_id: z.string().min(1),
  integration_mode: z.literal("official_cli"),
  workspace_uri: z.string().min(1),
  base_commit: z.string().min(1),
  branch: z.string().min(1),
  work_order_hash: z.string().min(1),
  adapter_version: z.string().min(1),
  binary_version: z.string().optional(),
  started_at: z.string().min(1),
  ended_at: z.string().nullable().optional(),
  status: z.enum(["preparing", "running", "succeeded", "failed", "cancelled"]),
});

// ─── ArtifactRef ─────────────────────────────────────────────────────────────

export const ArtifactRefSchema = z.object({
  uri: z.string().min(1),
  kind: z.enum([
    "diff",
    "stdout_tail",
    "stderr_tail",
    "verification_output",
    "task_capsule",
    "final_report",
    "review_verdict",
    "handoff_packet",
    "schedule_decision",
  ]),
  checksum: z.string().optional(),
  summary: z.string().optional(),
});

// ─── EventEnvelope ───────────────────────────────────────────────────────────

export function eventEnvelopeSchema<TPayload extends z.ZodTypeAny>(
  payloadSchema: TPayload,
) {
  return z.object({
    event_id: z.string().min(1),
    event_type: z.string().min(1),
    project_id: z.string().min(1),
    task_id: z.string().optional(),
    run_id: z.string().optional(),
    agent_id: z.string().optional(),
    correlation_id: z.string().optional(),
    causation_id: z.string().optional(),
    side_effect_type: z.string().optional(),
    skip_on_replay: z.boolean().optional(),
    payload: payloadSchema,
    created_at: z.string().min(1),
  });
}

export const EventEnvelopeSchema: z.ZodType<EventEnvelope<EventPayload>> =
  eventEnvelopeSchema(z.record(z.unknown()));
