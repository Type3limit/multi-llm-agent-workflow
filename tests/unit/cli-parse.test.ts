import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseSimpleYaml } from "../../src/cli/yaml-simple.js";
import { parseArgs, loadWorkOrder, loadAgentProfile, runCli, type CliArgs } from "../../src/cli/run-command.js";

// ─── parseArgs ────────────────────────────────────────────────────────────

describe("parseArgs", () => {
  it("parses run with work_order and --agent", () => {
    const result = parseArgs([
      "node",
      "agentflow",
      "run",
      "wo.json",
      "--agent",
      "agent.yaml",
    ]);
    expect(result.subcommand).toBe("run");
    expect(result.workOrderPath).toBe("wo.json");
    expect(result.agentPath).toBe("agent.yaml");
  });

  it("parses --database optional", () => {
    const result = parseArgs([
      "node",
      "agentflow",
      "run",
      "wo.json",
      "--agent",
      "agent.yaml",
      "--database",
      "db.sqlite",
    ]);
    expect(result.databasePath).toBe("db.sqlite");
  });
});

// ─── runCli argument errors ───────────────────────────────────────────────

describe("runCli argument errors", () => {
  it("returns exitCode 2 for empty subcommand (no args)", async () => {
    const r = await runCli({ subcommand: "" } as CliArgs);
    expect(r.exitCode).toBe(2);
    expect(r.message).toContain("Missing command");
  });

  it("returns exitCode 0 for help subcommand", async () => {
    const r = await runCli({ subcommand: "help" } as CliArgs);
    expect(r.exitCode).toBe(0);
    expect(r.message).toContain("Usage:");
  });

  it("returns exitCode 0 for --help flag", async () => {
    const r = await runCli({ subcommand: "--help" } as CliArgs);
    expect(r.exitCode).toBe(0);
    expect(r.message).toContain("Usage:");
  });

  it("returns exitCode 0 for -h flag", async () => {
    const r = await runCli({ subcommand: "-h" } as CliArgs);
    expect(r.exitCode).toBe(0);
    expect(r.message).toContain("Usage:");
  });

  it("returns exitCode 2 for unknown subcommand", async () => {
    const r = await runCli({ subcommand: "unknown" } as CliArgs);
    expect(r.exitCode).toBe(2);
  });

  it("returns exitCode 2 for missing work_order", async () => {
    const r = await runCli({
      subcommand: "run",
      agentPath: "agent.yaml",
    } as CliArgs);
    expect(r.exitCode).toBe(2);
  });

  it("returns exitCode 2 for missing --agent", async () => {
    const r = await runCli({
      subcommand: "run",
      workOrderPath: "wo.json",
    } as CliArgs);
    expect(r.exitCode).toBe(2);
  });
});

// ─── loadWorkOrder ────────────────────────────────────────────────────────

describe("loadWorkOrder", () => {
  it("loads valid JSON WorkOrder", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-cli-"));
    const p = path.join(dir, "wo.json");
    fs.writeFileSync(
      p,
      JSON.stringify({
        schema_version: "workflow/v0",
        task_id: "T-test",
        title: "Test",
        type: "code_change",
        goal: "Test.",
        acceptance_criteria: ["T"],
        repo: { path: "/tmp/r" },
        agent: { agent_id: "a" },
      }),
    );
    try {
      const wo = loadWorkOrder(p);
      expect(wo.task_id).toBe("T-test");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws for invalid schema_version", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-cli-"));
    const p = path.join(dir, "wo.json");
    fs.writeFileSync(
      p,
      JSON.stringify({ schema_version: "v9", task_id: "T" }),
    );
    try {
      expect(() => loadWorkOrder(p)).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── loadAgentProfile ──────────────────────────────────────────────────────

describe("loadAgentProfile", () => {
  it("loads valid JSON AgentProfile", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-cli-"));
    const p = path.join(dir, "agent.json");
    fs.writeFileSync(
      p,
      JSON.stringify({
        schema_version: "workflow/v0",
        agent_id: "test",
        integration_mode: "official_cli",
        command: { executable: "node", args: ["-e", "1"] },
        capabilities: { outer_supervised: true, inner_tool_control: false },
      }),
    );
    try {
      const ap = loadAgentProfile(p);
      expect(ap.agent_id).toBe("test");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads valid YAML AgentProfile", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-cli-"));
    const p = path.join(dir, "agent.yaml");
    fs.writeFileSync(
      p,
      `schema_version: workflow/v0
agent_id: fake-agent
integration_mode: official_cli
command:
  executable: node
  args:
    - "-e"
    - "console.log('hi')"
    - "{{prompt_file}}"
capabilities:
  outer_supervised: true
  inner_tool_control: false
limits:
  timeout_seconds: 30
`,
    );
    try {
      const ap = loadAgentProfile(p);
      expect(ap.agent_id).toBe("fake-agent");
      expect(ap.command.executable).toBe("node");
      expect(ap.command.args).toEqual(["-e", "console.log('hi')", "{{prompt_file}}"]);
      expect(ap.limits?.timeout_seconds).toBe(30);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid AgentProfile schema", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-cli-"));
    const p = path.join(dir, "agent.json");
    fs.writeFileSync(p, JSON.stringify({ schema_version: "v9" }));
    try {
      expect(() => loadAgentProfile(p)).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── YAML parser ──────────────────────────────────────────────────────────

describe("parseSimpleYaml", () => {
  it("parses simple key-value pairs", () => {
    const result = parseSimpleYaml("key1: value1\nkey2: 42\nkey3: true") as Record<string, unknown>;
    expect(result.key1).toBe("value1");
    expect(result.key2).toBe(42);
    expect(result.key3).toBe(true);
  });

  it("parses nested objects", () => {
    const yaml = `outer:
  inner: hello
  count: 3`;
    const result = parseSimpleYaml(yaml) as Record<string, unknown>;
    const outer = result.outer as Record<string, unknown>;
    expect(outer.inner).toBe("hello");
    expect(outer.count).toBe(3);
  });

  it("parses arrays", () => {
    const yaml = `items:
  - first
  - second
  - third`;
    const result = parseSimpleYaml(yaml) as Record<string, unknown>;
    expect(result.items).toEqual(["first", "second", "third"]);
  });

  it("parses quoted strings", () => {
    const yaml = `cmd: "echo hello"`;
    const result = parseSimpleYaml(yaml) as Record<string, unknown>;
    expect(result.cmd).toBe("echo hello");
  });

  it("parses boolean and null", () => {
    const yaml = `a: true\nb: false\nc: null`;
    const result = parseSimpleYaml(yaml) as Record<string, unknown>;
    expect(result.a).toBe(true);
    expect(result.b).toBe(false);
    expect(result.c).toBeNull();
  });
});

// ─── runCli validation errors ────────────────────────────────────────────

describe("runCli validation", () => {
  it("returns exitCode 2 for invalid WorkOrder file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-cli-"));
    const wo = path.join(dir, "wo.json");
    fs.writeFileSync(wo, JSON.stringify({ schema_version: "v9" }));
    const ag = path.join(dir, "agent.json");
    fs.writeFileSync(
      ag,
      JSON.stringify({
        schema_version: "workflow/v0",
        agent_id: "x",
        integration_mode: "official_cli",
        command: { executable: "n", args: [] },
        capabilities: { outer_supervised: true, inner_tool_control: false },
      }),
    );
    try {
      const r = await runCli({
        subcommand: "run",
        workOrderPath: wo,
        agentPath: ag,
      });
      expect(r.exitCode).toBe(2);
      expect(r.message).toContain("WorkOrder");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns exitCode 2 for invalid AgentProfile file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-cli-"));
    const wo = path.join(dir, "wo.json");
    fs.writeFileSync(
      wo,
      JSON.stringify({
        schema_version: "workflow/v0",
        task_id: "T",
        title: "T",
        type: "code_change",
        goal: "G",
        acceptance_criteria: [],
        repo: { path: "/r" },
        agent: { agent_id: "x" },
      }),
    );
    const ag = path.join(dir, "agent.json");
    fs.writeFileSync(ag, JSON.stringify({ schema_version: "v9" }));
    try {
      const r = await runCli({
        subcommand: "run",
        workOrderPath: wo,
        agentPath: ag,
      });
      expect(r.exitCode).toBe(2);
      expect(r.message).toContain("AgentProfile");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
