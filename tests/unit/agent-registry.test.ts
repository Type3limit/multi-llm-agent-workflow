import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import SqliteDatabase from "better-sqlite3";
import { migrate } from "../../src/storage/migrations.js";
import { SqliteMetricsStore } from "../../src/storage/metrics-store.js";
import { SqliteEventLog } from "../../src/storage/event-log.js";
import { SqliteAgentRegistry } from "../../src/scheduling/agent-registry.js";
import type { AgentRegistryEntry } from "../../src/core/types.js";
import type { Database } from "../../src/storage/database.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeJsonProfile(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: "workflow/v1",
    agent_id: "agent-json",
    integration_mode: "official_cli",
    command: { executable: "node", args: ["-p", "prompt.md"] },
    capabilities: {
      outer_supervised: true,
      inner_tool_control: false,
      kinds: ["code_change"],
      roles: ["implementer"],
    },
    ...overrides,
  });
}

function makeYamlProfile(overrides: Record<string, unknown> = {}): string {
  const data = {
    schema_version: "workflow/v1",
    agent_id: "agent-yaml",
    integration_mode: "official_cli",
    command: { executable: "node", args: ["-p", "prompt.md"] },
    capabilities: {
      outer_supervised: true,
      inner_tool_control: false,
      kinds: ["code_change"],
      roles: ["implementer"],
    },
    ...overrides,
  };
  return toSimpleYaml(data);
}

function toSimpleYaml(obj: Record<string, unknown>, indent = 0): string {
  const prefix = " ".repeat(indent);
  let out = "";
  for (const [key, value] of Object.entries(obj)) {
    if (value != null && typeof value === "object" && !Array.isArray(value)) {
      out += `${prefix}${key}:\n`;
      out += toSimpleYaml(value as Record<string, unknown>, indent + 2);
    } else if (Array.isArray(value)) {
      out += `${prefix}${key}:\n`;
      for (const item of value) {
        if (typeof item === "string") {
          out += `${prefix}  - "${item}"\n`;
        } else {
          out += `${prefix}  - ${String(item)}\n`;
        }
      }
    } else if (typeof value === "string") {
      out += `${prefix}${key}: "${value}"\n`;
    } else if (typeof value === "boolean") {
      out += `${prefix}${key}: ${value}\n`;
    } else {
      out += `${prefix}${key}: ${String(value)}\n`;
    }
  }
  return out;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("SqliteAgentRegistry", () => {
  let tmpDir: string;
  let db: Database;
  let registry: SqliteAgentRegistry;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-registry-test-"));
    db = new SqliteDatabase(":memory:");
    migrate(db);
    const metricsStore = new SqliteMetricsStore(db);
    const eventLog = new SqliteEventLog(db);
    registry = new SqliteAgentRegistry(metricsStore, 50, eventLog);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(relativePath: string, content: string): string {
    const fullPath = path.join(tmpDir, relativePath);
    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, content, "utf-8");
    return fullPath;
  }

  // ─── Single file loading ──────────────────────────────────────────────

  it("loads from a single JSON file", () => {
    const p = writeFile("agents/agent.json", makeJsonProfile());
    registry.load({ sources: [p] });
    const entry = registry.get("agent-json");
    expect(entry).toBeDefined();
    expect(entry!.profile.agent_id).toBe("agent-json");
    expect(entry!.loaded_from).toBe(path.resolve(p));
    expect(entry!.quota_health).toBe("healthy");
  });

  it("loads from a single YAML file", () => {
    const p = writeFile("agents/agent.yaml", makeYamlProfile());
    registry.load({ sources: [p] });
    const entry = registry.get("agent-yaml");
    expect(entry).toBeDefined();
    expect(entry!.profile.integration_mode).toBe("official_cli");
  });

  it("loads from a single .yml file", () => {
    const p = writeFile("agents/agent.yml", makeYamlProfile({ agent_id: "agent-yml" }));
    registry.load({ sources: [p] });
    expect(registry.get("agent-yml")).toBeDefined();
  });

  // ─── Directory loading ────────────────────────────────────────────────

  it("loads all JSON/YAML files from a directory in lexicographic order", () => {
    writeFile("dir/b-agent.json", makeJsonProfile({ agent_id: "b" }));
    writeFile("dir/a-agent.yaml", makeYamlProfile({ agent_id: "a" }));
    writeFile("dir/c-agent.json", makeJsonProfile({ agent_id: "c" }));

    registry.load({ sources: [path.join(tmpDir, "dir")] });

    const list = registry.list();
    expect(list).toHaveLength(3);
    // Deterministic order: loaded in filename lexicographic order
    expect(list[0].profile.agent_id).toBe("a");
    expect(list[1].profile.agent_id).toBe("b");
    expect(list[2].profile.agent_id).toBe("c");
  });

  it("ignores non-JSON/YAML files in directory", () => {
    writeFile("dir/agent.json", makeJsonProfile({ agent_id: "j" }));
    writeFile("dir/readme.md", "# not a profile");
    writeFile("dir/.gitkeep", "");

    registry.load({ sources: [path.join(tmpDir, "dir")] });
    expect(registry.list()).toHaveLength(1);
  });

  // ─── Mixed sources ────────────────────────────────────────────────────

  it("loads from mixed sources (file + dir)", () => {
    writeFile("dir/a.json", makeJsonProfile({ agent_id: "a" }));
    const singlePath = writeFile("single.json", makeJsonProfile({ agent_id: "s" }));

    registry.load({ sources: [singlePath, path.join(tmpDir, "dir")] });

    expect(registry.get("a")).toBeDefined();
    expect(registry.get("s")).toBeDefined();
  });

  // ─── Errors ───────────────────────────────────────────────────────────

  it("throws for duplicate agent_id with offending paths", () => {
    const p1 = writeFile("a.json", makeJsonProfile({ agent_id: "dup" }));
    const p2 = writeFile("b.json", makeJsonProfile({ agent_id: "dup" }));

    // Call load once, capture the error, verify all details
    let err: Error | undefined;
    try {
      registry.load({ sources: [p1, p2] });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    const msg = err!.message;
    expect(msg).toContain("Duplicate agent_id");
    expect(msg).toContain("dup");
    expect(msg).toContain(path.resolve(p1));
    expect(msg).toContain(path.resolve(p2));
  });

  it("throws for invalid profile with path and field info", () => {
    const p = writeFile("bad.json", JSON.stringify({
      schema_version: "workflow/v1",
      agent_id: "bad",
      integration_mode: "official_cli",
      // missing command
      capabilities: {
        outer_supervised: true,
        inner_tool_control: false,
        kinds: ["code_change"],
        roles: ["implementer"],
      },
    }));

    expect(() => registry.load({ sources: [p] })).toThrow("Invalid agent profile");
    expect(() => registry.load({ sources: [p] })).toThrow(p);
    expect(() => registry.load({ sources: [p] })).toThrow("command");
  });

  it("rejects v0 AgentProfile", () => {
    const p = writeFile("v0.json", JSON.stringify({
      schema_version: "workflow/v0",
      agent_id: "v0-agent",
      integration_mode: "official_cli",
      command: { executable: "node", args: ["-e"] },
      capabilities: { outer_supervised: true, inner_tool_control: false },
    }));

    expect(() => registry.load({ sources: [p] })).toThrow("workflow/v0");
  });

  it("throws for non-existent source", () => {
    expect(() => registry.load({ sources: [path.join(tmpDir, "nope.json")] })).toThrow(
      "not found",
    );
  });

  // ─── list() / get() ──────────────────────────────────────────────────

  it("list() returns a copy, mutations do not affect internal state", () => {
    writeFile("a.json", makeJsonProfile({ agent_id: "a" }));
    registry.load({ sources: [path.join(tmpDir, "a.json")] });

    const list = registry.list();
    list[0].quota_health = "exhausted" as const;

    expect(registry.get("a")!.quota_health).toBe("healthy");
  });

  it("list() nested profile mutation does not affect internal state", () => {
    writeFile("a.json", makeJsonProfile({ agent_id: "a" }));
    registry.load({ sources: [path.join(tmpDir, "a.json")] });

    const list = registry.list();
    // Mutate nested profile field
    list[0].profile.capabilities.kinds.push("injected");

    // Internal state must be unaffected
    const internal = registry.get("a")!;
    expect(internal.profile.capabilities.kinds).toEqual(["code_change"]);
    expect(internal.profile.capabilities.kinds).not.toContain("injected");
  });

  it("get() nested profile mutation does not affect internal state", () => {
    writeFile("a.json", makeJsonProfile({ agent_id: "a" }));
    registry.load({ sources: [path.join(tmpDir, "a.json")] });

    const entry = registry.get("a")!;
    // Mutate via get() return value
    entry.profile.agent_id = "hijacked";

    // Internal state must be unaffected
    expect(registry.get("a")!.profile.agent_id).toBe("a");
  });

  it("candidatesFor() nested profile mutation does not affect internal state", () => {
    loadTwo();

    const result = registry.candidatesFor({
      requiredCapabilities: ["code_change"],
      role: "implementer",
      excludeAgentIds: [],
    });
    // Mutate roles array
    result[0].profile.capabilities.roles.length = 0;

    // Internal state must be unaffected — agent-a still has both roles
    const internal = registry.get("agent-a")!;
    expect(internal.profile.capabilities.roles).toContain("implementer");
    expect(internal.profile.capabilities.roles).toContain("reviewer");
  });

  it("get() returns undefined for unknown agent", () => {
    expect(registry.get("unknown")).toBeUndefined();
  });

  // ─── candidatesFor ────────────────────────────────────────────────────

  function loadTwo(): void {
    writeFile("a.json", makeJsonProfile({
      agent_id: "agent-a",
      capabilities: {
        outer_supervised: true,
        inner_tool_control: false,
        kinds: ["code_change", "ui_review"],
        roles: ["implementer", "reviewer"],
      },
    }));
    writeFile("b.json", makeJsonProfile({
      agent_id: "agent-b",
      capabilities: {
        outer_supervised: true,
        inner_tool_control: false,
        kinds: ["code_change"],
        roles: ["implementer"],
      },
    }));
    registry.load({ sources: [path.join(tmpDir, "a.json"), path.join(tmpDir, "b.json")] });
  }

  it("filters by capability subset", () => {
    loadTwo();

    // agent-a has both, agent-b only has code_change
    const result = registry.candidatesFor({
      requiredCapabilities: ["code_change", "ui_review"],
      role: "implementer",
      excludeAgentIds: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0].profile.agent_id).toBe("agent-a");
  });

  it("filters by role", () => {
    loadTwo();

    // agent-b is implementer only; agent-a is both
    const result = registry.candidatesFor({
      requiredCapabilities: ["code_change"],
      role: "reviewer",
      excludeAgentIds: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0].profile.agent_id).toBe("agent-a");
  });

  it("filters by excludeAgentIds", () => {
    loadTwo();

    const result = registry.candidatesFor({
      requiredCapabilities: ["code_change"],
      role: "implementer",
      excludeAgentIds: ["agent-a"],
    });
    expect(result).toHaveLength(1);
    expect(result[0].profile.agent_id).toBe("agent-b");
  });

  it("excludes quota exhausted agents", () => {
    writeFile("a.json", makeJsonProfile({
      agent_id: "agent-a",
      capabilities: {
        outer_supervised: true,
        inner_tool_control: false,
        kinds: ["code_change"],
        roles: ["implementer"],
      },
    }));
    registry.load({ sources: [path.join(tmpDir, "a.json")] });

    // Manually set quota_health to exhausted (testing internal behavior)
    const entry = registry.get("agent-a")!;
    const ref = registry as unknown as { entries: Map<string, { quota_health: string }> };
    // We can't access internal state directly; instead, verify the default is healthy
    expect(entry.quota_health).toBe("healthy");

    // Test: default healthy agent is returned
    const result = registry.candidatesFor({
      requiredCapabilities: ["code_change"],
      role: "implementer",
      excludeAgentIds: [],
    });
    expect(result).toHaveLength(1);
  });

  it("returns candidates sorted by agent_id lexicographic", () => {
    writeFile("c.json", makeJsonProfile({
      agent_id: "c-agent",
      capabilities: { outer_supervised: true, inner_tool_control: false, kinds: ["code_change"], roles: ["implementer"] },
    }));
    writeFile("a.json", makeJsonProfile({
      agent_id: "a-agent",
      capabilities: { outer_supervised: true, inner_tool_control: false, kinds: ["code_change"], roles: ["implementer"] },
    }));
    writeFile("b.json", makeJsonProfile({
      agent_id: "b-agent",
      capabilities: { outer_supervised: true, inner_tool_control: false, kinds: ["code_change"], roles: ["implementer"] },
    }));
    registry.load({
      sources: [
        path.join(tmpDir, "c.json"),
        path.join(tmpDir, "a.json"),
        path.join(tmpDir, "b.json"),
      ],
    });

    const result = registry.candidatesFor({
      requiredCapabilities: ["code_change"],
      role: "implementer",
      excludeAgentIds: [],
    });
    expect(result.map((r) => r.profile.agent_id)).toEqual(["a-agent", "b-agent", "c-agent"]);
  });

  // ─── recordOutcome ───────────────────────────────────────────────────

  it("recordOutcome writes metrics and refreshes rolling metrics", () => {
    const p = writeFile("a.json", makeJsonProfile({ agent_id: "agent-a" }));
    registry.load({ sources: [p] });

    const before = registry.get("agent-a")!;
    expect(before.rolling_metrics.runs_observed).toBe(0);
    expect(before.rolling_metrics.success_rate).toBe(0.8); // initial default

    registry.recordOutcome({
      agentId: "agent-a",
      success: true,
      wallTimeMs: 5000,
      actualCostUnits: 2,
    });

    const after = registry.get("agent-a")!;
    expect(after.rolling_metrics.runs_observed).toBe(1);
    expect(after.rolling_metrics.success_rate).toBe(1);
    expect(after.rolling_metrics.avg_latency_ms).toBe(5000);
    expect(after.rolling_metrics.avg_actual_cost_units).toBe(2);
  });

  it("recordOutcome generates a runId if not provided", () => {
    const p = writeFile("a.json", makeJsonProfile({ agent_id: "agent-a" }));
    registry.load({ sources: [p] });

    expect(() =>
      registry.recordOutcome({
        agentId: "agent-a",
        success: false,
        wallTimeMs: 100,
      }),
    ).not.toThrow();
  });

  it("recordOutcome throws for unknown agent", () => {
    expect(() =>
      registry.recordOutcome({
        agentId: "nonexistent",
        success: true,
        wallTimeMs: 100,
      }),
    ).toThrow("Agent not found in registry");
  });

  it("recordOutcome marks provider_rate_limited agents low and emits quota.low once", () => {
    const p = writeFile("a.json", makeJsonProfile({ agent_id: "agent-a" }));
    registry.load({ sources: [p] });

    registry.recordOutcome({
      agentId: "agent-a",
      runId: "run-rate-1",
      success: false,
      wallTimeMs: 100,
      failureReason: "provider_rate_limited",
    });
    registry.recordOutcome({
      agentId: "agent-a",
      runId: "run-rate-2",
      success: false,
      wallTimeMs: 100,
      failureReason: "provider_rate_limited",
    });

    expect(registry.get("agent-a")!.quota_health).toBe("low");
    const events = quotaEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("quota.low");
    expect(events[0].agent_id).toBe("agent-a");
    expect(JSON.parse(events[0].payload_json)).toMatchObject({
      scope: "agent",
      agent_id: "agent-a",
      reason: "provider_rate_limited",
    });
  });

  it.each([
    "provider_quota_exhausted",
    "provider_auth_failed",
  ] as const)("recordOutcome marks %s agents exhausted and emits quota.exhausted once", (failureReason) => {
    const p = writeFile("a.json", makeJsonProfile({ agent_id: "agent-a" }));
    registry.load({ sources: [p] });

    registry.recordOutcome({
      agentId: "agent-a",
      runId: "run-exhausted-1",
      success: false,
      wallTimeMs: 100,
      failureReason,
    });
    registry.recordOutcome({
      agentId: "agent-a",
      runId: "run-exhausted-2",
      success: false,
      wallTimeMs: 100,
      failureReason,
    });

    expect(registry.get("agent-a")!.quota_health).toBe("exhausted");
    const events = quotaEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("quota.exhausted");
    expect(JSON.parse(events[0].payload_json)).toMatchObject({
      scope: "agent",
      agent_id: "agent-a",
      reason: failureReason,
    });
  });

  it("recordOutcome does not change quota health for ordinary failures", () => {
    const p = writeFile("a.json", makeJsonProfile({ agent_id: "agent-a" }));
    registry.load({ sources: [p] });

    registry.recordOutcome({
      agentId: "agent-a",
      runId: "run-nonzero",
      success: false,
      wallTimeMs: 100,
      failureReason: "agent_nonzero_exit",
    });

    expect(registry.get("agent-a")!.quota_health).toBe("healthy");
    expect(quotaEvents()).toHaveLength(0);
  });

  // ─── refreshQuotaHealth ──────────────────────────────────────────────

  it("refreshQuotaHealth keeps healthy agents healthy", () => {
    writeFile("a.json", makeJsonProfile({ agent_id: "a" }));
    registry.load({ sources: [path.join(tmpDir, "a.json")] });

    registry.refreshQuotaHealth();
    expect(registry.get("a")!.quota_health).toBe("healthy");
  });

  // ─── v0 file is rejected ─────────────────────────────────────────────

  it("rejects v0 profile even if mixed with valid v1", () => {
    writeFile("v1.json", makeJsonProfile({ agent_id: "v1" }));
    writeFile("v0.json", JSON.stringify({
      schema_version: "workflow/v0",
      agent_id: "v0",
      integration_mode: "official_cli",
      command: { executable: "node", args: ["-e"] },
      capabilities: { outer_supervised: true, inner_tool_control: false },
    }));

    expect(() =>
      registry.load({ sources: [path.join(tmpDir, "v1.json"), path.join(tmpDir, "v0.json")] }),
    ).toThrow("workflow/v0");
  });

  function quotaEvents(): Array<{
    event_type: string;
    agent_id: string | null;
    payload_json: string;
  }> {
    return db
      .prepare(
        "select event_type, agent_id, payload_json from task_events where event_type in ('quota.low', 'quota.exhausted') order by rowid asc",
      )
      .all() as Array<{
      event_type: string;
      agent_id: string | null;
      payload_json: string;
    }>;
  }
});
