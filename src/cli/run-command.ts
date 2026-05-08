import * as fs from "node:fs";
import * as path from "node:path";
import { parseWorkOrder, parseAgentProfile } from "../core/schemas.js";
import type { ParsedWorkOrder, ParsedAgentProfile, WorkOrder, AgentProfile } from "../core/schemas.js";
import { runWorkOrder, type RunWorkOrderResult } from "../core/orchestrator.js";
import { parseSimpleYaml } from "./yaml-simple.js";

export interface CliArgs {
  subcommand: string;
  workOrderPath?: string;
  agentPath?: string;
  databasePath?: string;
}

export interface CliResult {
  exitCode: number;
  message: string;
  result?: RunWorkOrderResult;
}

export function parseArgs(rawArgs: string[]): CliArgs {
  const args = rawArgs.slice(2); // skip node and script path
  const result: CliArgs = { subcommand: "" };

  if (args.length === 0) {
    return result;
  }

  result.subcommand = args[0];

  let i = 1;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--agent" || arg === "-a") {
      i++;
      if (i < args.length) {
        result.agentPath = args[i];
      }
    } else if (arg === "--database" || arg === "-d") {
      i++;
      if (i < args.length) {
        result.databasePath = args[i];
      }
    } else if (!arg.startsWith("-")) {
      if (!result.workOrderPath) {
        result.workOrderPath = arg;
      }
    }
    i++;
  }

  return result;
}

export function loadWorkOrder(filePath: string): ParsedWorkOrder {
  const content = fs.readFileSync(filePath, "utf-8");
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error(`Failed to parse WorkOrder JSON: ${filePath}`);
  }
  const parsed = parseWorkOrder(raw);
  return narrowToV0WorkOrder(parsed);
}

function narrowToV0WorkOrder(wo: WorkOrder): ParsedWorkOrder {
  if (wo.schema_version !== "workflow/v0") {
    throw new Error(
      `WorkOrder schema_version "${wo.schema_version}" is not supported by the 'run' command. ` +
      `Only "workflow/v0" is supported. For v1 WorkOrders, use 'agentflow batch' (coming in v1).`,
    );
  }
  return wo;
}

export function loadAgentProfile(filePath: string): ParsedAgentProfile {
  const content = fs.readFileSync(filePath, "utf-8");
  const ext = path.extname(filePath).toLowerCase();
  let raw: unknown;

  if (ext === ".yaml" || ext === ".yml") {
    try {
      raw = parseSimpleYaml(content);
    } catch (err) {
      throw new Error(
        `Failed to parse AgentProfile YAML: ${filePath}\n${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    try {
      raw = JSON.parse(content);
    } catch {
      throw new Error(`Failed to parse AgentProfile JSON: ${filePath}`);
    }
  }

  const parsed = parseAgentProfile(raw);
  return narrowToV0AgentProfile(parsed);
}

function narrowToV0AgentProfile(ap: AgentProfile): ParsedAgentProfile {
  if (ap.schema_version !== "workflow/v0") {
    throw new Error(
      `AgentProfile schema_version "${ap.schema_version}" is not supported by the 'run' command. ` +
      `Only "workflow/v0" is supported. For v1 AgentProfiles, use 'agentflow batch' (coming in v1).`,
    );
  }
  return ap;
}

function summary(result: RunWorkOrderResult): string {
  const lines = [
    `Task: ${result.taskId}`,
    `Run: ${result.runId}`,
    `Status: ${result.status}`,
    `Workspace: ${result.workspacePath}`,
    `Verification: ${result.verificationPassed ? "passed" : "failed"}`,
    "Artifacts:",
    ...result.artifacts.map((a) => `  - ${a.kind} ${a.uri}`),
  ];
  return lines.join("\n");
}

const USAGE = `Usage: agentflow run <work_order.json> --agent <agent.yaml|agent.json> [--database <path>]

Required:
  work_order.json    Path to the WorkOrder JSON file.
  --agent <path>     Path to the AgentProfile file (JSON or YAML).

Optional:
  --database <path>  Path to the SQLite database file.
                     Default: <repo>/.agentflow/agentflow.sqlite

Exit codes:
  0  Orchestration succeeded.
  1  Orchestration completed but run failed.
  2  Input validation or argument error.
`;

export function cliError(message: string): CliResult {
  return { exitCode: 2, message };
}

export async function runCli(args: CliArgs): Promise<CliResult> {
  // Validate subcommand
  if (args.subcommand === "") {
    return { exitCode: 2, message: `Missing command.\n\n${USAGE}` };
  }

  if (args.subcommand === "help" || args.subcommand === "--help" || args.subcommand === "-h") {
    return { exitCode: 0, message: USAGE };
  }

  if (args.subcommand !== "run") {
    return cliError(`Unknown command: ${args.subcommand}\n\n${USAGE}`);
  }

  if (!args.workOrderPath) {
    return cliError(`Missing work_order.json argument.\n\n${USAGE}`);
  }

  if (!args.agentPath) {
    return cliError(`Missing --agent argument.\n\n${USAGE}`);
  }

  // Load and validate inputs
  let workOrder: ParsedWorkOrder;
  try {
    workOrder = loadWorkOrder(args.workOrderPath);
  } catch (err) {
    return cliError(
      `WorkOrder validation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let agentProfile: ParsedAgentProfile;
  try {
    agentProfile = loadAgentProfile(args.agentPath);
  } catch (err) {
    return cliError(
      `AgentProfile validation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Run orchestration
  try {
    const result = await runWorkOrder({
      workOrder,
      agentProfile,
      databasePath: args.databasePath,
    });

    const msg = summary(result);
    const exitCode = result.status === "succeeded" ? 0 : 1;
    return { exitCode, message: msg, result };
  } catch (err) {
    return {
      exitCode: 1,
      message: `Orchestration error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
