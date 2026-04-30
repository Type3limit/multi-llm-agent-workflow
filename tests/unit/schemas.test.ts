import { describe, it, expect } from "vitest";
import {
  WorkOrderSchema,
  AgentProfileSchema,
  RunManifestSchema,
  ArtifactRefSchema,
  EventEnvelopeSchema,
  parseWorkOrder,
  parseAgentProfile,
  eventEnvelopeSchema,
} from "../../src/core/schemas.js";
import { z } from "zod";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const validWorkOrder = {
  schema_version: "workflow/v0",
  task_id: "T-test",
  title: "Fix a bug",
  type: "code_change",
  goal: "Make the test pass.",
  acceptance_criteria: ["Tests pass."],
  repo: { path: "/tmp/repo" },
  agent: { agent_id: "claude-local" },
};

const validAgentProfile = {
  schema_version: "workflow/v0",
  agent_id: "claude-local",
  integration_mode: "official_cli",
  command: { executable: "claude", args: ["-p", "prompt.md"] },
  capabilities: { outer_supervised: true, inner_tool_control: false },
};

// ─── WorkOrder ───────────────────────────────────────────────────────────────

describe("WorkOrderSchema", () => {
  it("parses a valid minimal WorkOrder", () => {
    const result = WorkOrderSchema.parse(validWorkOrder);
    expect(result.task_id).toBe("T-test");
    expect(result.project_id).toBe("default");
  });

  it("parses a full WorkOrder with optional fields", () => {
    const full = {
      ...validWorkOrder,
      project_id: "my-project",
      constraints: {
        allowed_paths: ["src/**"],
        forbidden_paths: [".env"],
        max_files_to_touch: 5,
      },
      verification: { commands: ["npm test"], timeout_seconds: 120 },
      budget: { max_wall_time_minutes: 30, max_output_bytes: 1_000_000 },
    };
    const result = WorkOrderSchema.parse(full);
    expect(result.project_id).toBe("my-project");
    expect(result.constraints!.max_files_to_touch).toBe(5);
    expect(result.verification!.commands).toEqual(["npm test"]);
  });

  it("rejects an unsupported schema_version", () => {
    expect(() =>
      WorkOrderSchema.parse({ ...validWorkOrder, schema_version: "workflow/v9" }),
    ).toThrow();
  });

  it("rejects missing task_id", () => {
    const { task_id, ...rest } = validWorkOrder;
    expect(() => WorkOrderSchema.parse(rest)).toThrow();
  });

  it("rejects empty title", () => {
    expect(() =>
      WorkOrderSchema.parse({ ...validWorkOrder, title: "" }),
    ).toThrow();
  });

  it("rejects invalid type", () => {
    expect(() =>
      WorkOrderSchema.parse({ ...validWorkOrder, type: "invalid_type" }),
    ).toThrow();
  });

  it("rejects empty acceptance_criteria array element", () => {
    expect(() =>
      WorkOrderSchema.parse({ ...validWorkOrder, acceptance_criteria: [""] }),
    ).toThrow();
  });

  it("rejects missing repo.path", () => {
    expect(() =>
      WorkOrderSchema.parse({
        ...validWorkOrder,
        repo: {},
      }),
    ).toThrow();
  });

  it("rejects missing agent.agent_id", () => {
    expect(() =>
      WorkOrderSchema.parse({
        ...validWorkOrder,
        agent: {},
      }),
    ).toThrow();
  });

  it("rejects negative max_files_to_touch", () => {
    expect(() =>
      WorkOrderSchema.parse({
        ...validWorkOrder,
        constraints: { max_files_to_touch: -1 },
      }),
    ).toThrow();
  });
});

describe("parseWorkOrder", () => {
  it("defaults project_id to 'default' when absent", () => {
    const result = parseWorkOrder(validWorkOrder);
    expect(result.project_id).toBe("default");
  });

  it("preserves explicit project_id", () => {
    const result = parseWorkOrder({ ...validWorkOrder, project_id: "p1" });
    expect(result.project_id).toBe("p1");
  });

  it("throws ZodError for invalid input", () => {
    expect(() => parseWorkOrder({})).toThrow(z.ZodError);
  });
});

// ─── AgentProfile ────────────────────────────────────────────────────────────

describe("AgentProfileSchema", () => {
  it("parses a valid AgentProfile", () => {
    const result = AgentProfileSchema.parse(validAgentProfile);
    expect(result.agent_id).toBe("claude-local");
  });

  it("rejects unsupported schema_version", () => {
    expect(() =>
      AgentProfileSchema.parse({ ...validAgentProfile, schema_version: "v9" }),
    ).toThrow();
  });

  it("rejects integration_mode other than official_cli", () => {
    expect(() =>
      AgentProfileSchema.parse({
        ...validAgentProfile,
        integration_mode: "mcp_bridge",
      }),
    ).toThrow();
  });

  it("rejects outer_supervised other than true", () => {
    expect(() =>
      AgentProfileSchema.parse({
        ...validAgentProfile,
        capabilities: { outer_supervised: false, inner_tool_control: false },
      }),
    ).toThrow();
  });

  it("rejects inner_tool_control other than false", () => {
    expect(() =>
      AgentProfileSchema.parse({
        ...validAgentProfile,
        capabilities: { outer_supervised: true, inner_tool_control: true },
      }),
    ).toThrow();
  });

  it("rejects missing command.executable", () => {
    expect(() =>
      AgentProfileSchema.parse({
        ...validAgentProfile,
        command: { args: [] },
      }),
    ).toThrow();
  });

  it("parses optional environment and limits", () => {
    const full = {
      ...validAgentProfile,
      environment: {
        set: { NODE_ENV: "production" },
        unset: ["DEBUG"],
      },
      limits: {
        timeout_seconds: 600,
        max_stdout_bytes: 10000,
        max_stderr_bytes: 5000,
      },
    };
    const result = AgentProfileSchema.parse(full);
    expect(result.environment!.set!.NODE_ENV).toBe("production");
    expect(result.limits!.timeout_seconds).toBe(600);
  });
});

describe("parseAgentProfile", () => {
  it("parses valid input", () => {
    const result = parseAgentProfile(validAgentProfile);
    expect(result.agent_id).toBe("claude-local");
  });

  it("throws ZodError for invalid input", () => {
    expect(() => parseAgentProfile({})).toThrow(z.ZodError);
  });
});

// ─── RunManifest ─────────────────────────────────────────────────────────────

describe("RunManifestSchema", () => {
  const validManifest = {
    schema_version: "agent-workflow/1",
    run_id: "R-abc123",
    task_id: "T-test",
    project_id: "default",
    agent_id: "claude-local",
    integration_mode: "official_cli",
    workspace_uri: "file:///tmp/ws",
    base_commit: "abc123def456",
    branch: "agent/T-test/R-abc123",
    work_order_hash: "sha256:abc",
    adapter_version: "0.1.0",
    started_at: new Date().toISOString(),
    status: "preparing",
  };

  it("parses a valid RunManifest", () => {
    const result = RunManifestSchema.parse(validManifest);
    expect(result.run_id).toBe("R-abc123");
    expect(result.status).toBe("preparing");
  });

  it("rejects invalid status", () => {
    expect(() =>
      RunManifestSchema.parse({ ...validManifest, status: "unknown" }),
    ).toThrow();
  });
});

// ─── ArtifactRef ─────────────────────────────────────────────────────────────

describe("ArtifactRefSchema", () => {
  it("parses a valid ArtifactRef", () => {
    const result = ArtifactRefSchema.parse({
      uri: "artifact://T-test/R-abc/diff.patch",
      kind: "diff",
      checksum: "sha256:abcdef",
    });
    expect(result.kind).toBe("diff");
    expect(result.uri).toBe("artifact://T-test/R-abc/diff.patch");
  });

  it("rejects invalid kind", () => {
    expect(() =>
      ArtifactRefSchema.parse({ uri: "a://b", kind: "unknown" }),
    ).toThrow();
  });
});

// ─── EventEnvelope ───────────────────────────────────────────────────────────

describe("EventEnvelopeSchema", () => {
  it("parses a minimal EventEnvelope", () => {
    const result = EventEnvelopeSchema.parse({
      event_id: "E-001",
      event_type: "task.created",
      project_id: "default",
      payload: { key: "value" },
      created_at: new Date().toISOString(),
    });
    expect(result.event_id).toBe("E-001");
    expect(result.payload).toEqual({ key: "value" });
  });

  it("parses an EventEnvelope with optional fields", () => {
    const result = EventEnvelopeSchema.parse({
      event_id: "E-002",
      event_type: "run.started",
      project_id: "p1",
      task_id: "T-1",
      run_id: "R-1",
      agent_id: "A-1",
      correlation_id: "C-1",
      causation_id: "CA-1",
      side_effect_type: "none",
      skip_on_replay: false,
      payload: {},
      created_at: new Date().toISOString(),
    });
    expect(result.correlation_id).toBe("C-1");
  });

  it("rejects missing event_id", () => {
    expect(() =>
      EventEnvelopeSchema.parse({
        event_type: "task.created",
        project_id: "p1",
        payload: {},
        created_at: new Date().toISOString(),
      }),
    ).toThrow();
  });

  it("typed payload schema works", () => {
    const runStartedSchema = eventEnvelopeSchema(
      z.object({
        pid: z.number(),
        command: z.string(),
      }),
    );
    const result = runStartedSchema.parse({
      event_id: "E-003",
      event_type: "run.started",
      project_id: "p1",
      task_id: "T-1",
      run_id: "R-1",
      payload: { pid: 12345, command: "claude -p prompt.md" },
      created_at: new Date().toISOString(),
    });
    expect(result.payload.pid).toBe(12345);
  });
});
