import * as fs from "node:fs";
import * as path from "node:path";
import { parseWorkOrder, parseAgentProfile } from "../core/schemas.js";
import type { ParsedWorkOrder, ParsedAgentProfile, WorkOrder, AgentProfile } from "../core/schemas.js";
import { runWorkOrder, type RunWorkOrderResult } from "../core/orchestrator.js";
import { runTaskOnce } from "../core/orchestrator-v1.js";
import { parseAgentProfileV1, type ParsedAgentProfileV1, type ParsedWorkOrderV1 } from "../core/schemas-v1.js";
import type { Database } from "../storage/database.js";
import { openDatabase } from "../storage/database.js";
import { migrate } from "../storage/migrations.js";
import { SqliteEventLog } from "../storage/event-log.js";
import { SqliteRunStore } from "../storage/run-store.js";
import { LocalArtifactStore } from "../storage/artifact-store.js";
import { SqliteQueueStore } from "../storage/queue-store.js";
import { SqliteMetricsStore } from "../storage/metrics-store.js";
import { SqliteBudgetStore } from "../storage/budget-store.js";
import { DefaultTaskQueue } from "../queue/task-queue.js";
import type { TaskQueue } from "../queue/task-queue.js";
import { V1WorkerTaskHandler } from "../queue/worker-task-handler.js";
import { DefaultWorkerPool, type WorkerPool } from "../queue/worker-pool.js";
import { SqliteAgentRegistry } from "../scheduling/agent-registry.js";
import { DefaultScheduler } from "../scheduling/scheduler.js";
import { DefaultBudgetManager } from "../scheduling/budget-manager.js";
import { DefaultHandoffManager } from "../scheduling/handoff-manager.js";
import { GitWorktreeSandboxProvider } from "../workspace/sandbox-provider.js";
import { FileTaskCapsuleWriter } from "../workspace/task-capsule-writer.js";
import { FileReviewBriefWriter } from "../workspace/review-brief-writer.js";
import { ChildProcessOfficialCliAdapter } from "../adapters/official-cli-adapter.js";
import { ShellVerificationRunner } from "../verification/verification-runner.js";
import { generateEventId } from "../core/ids.js";
import { parseSimpleYaml } from "./yaml-simple.js";
import type { AgentRegistryEntry } from "../core/types.js";

export interface CliArgs {
  subcommand: string;
  workOrderPath?: string;
  agentPath?: string;
  databasePath?: string;
  workers?: string;
  parseErrors?: string[];
}

export interface CliResult {
  exitCode: number;
  message: string;
  result?: RunWorkOrderResult | RunWorkOrderV1Result | RunBatchV1Result;
}

export interface RunWorkOrderV1Result {
  projectId: string;
  taskId: string;
  status: "accepted" | "failed" | "awaiting_human";
  attempts: number;
  databasePath: string;
  runs: Array<{
    runId: string;
    agentId: string;
    status: string;
    role?: "implementer" | "reviewer";
    workspacePath?: string;
  }>;
  artifacts: Array<{
    runId: string;
    kind: string;
    uri: string;
    path: string;
  }>;
}

export interface BatchWorkOrderInput {
  filePath: string;
  fileName: string;
  workOrder: ParsedWorkOrderV1;
}

export interface RunBatchV1Result {
  databasePath: string;
  workers: number;
  tasks: Array<{
    inputPath: string;
    taskId: string;
    status: "accepted" | "failed" | "awaiting_human";
    attempts: number;
    runCount: number;
    artifactCount: number;
  }>;
}

const WORK_ORDER_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);
const DEFAULT_BATCH_WORKERS = 2;
const MIN_BATCH_WORKERS = 1;
const MAX_BATCH_WORKERS = 16;
export const V1_SIGINT_GRACE_MS = 10_000;

export interface SigintSignalSource {
  onSigint(handler: () => void): { dispose: () => void };
}

export interface CliRuntimeServices {
  signalSource?: SigintSignalSource;
  sigintGraceMs?: number;
}

export class V1OrchestrationInterruptedError extends Error {
  constructor() {
    super("v1 orchestration interrupted.");
    this.name = "V1OrchestrationInterruptedError";
  }
}

export const PROCESS_SIGINT_SIGNAL_SOURCE: SigintSignalSource = {
  onSigint(handler: () => void): { dispose: () => void } {
    process.once("SIGINT", handler);
    return {
      dispose: () => {
        process.off("SIGINT", handler);
      },
    };
  },
};

const V1_INTERRUPTED_MESSAGE =
  "v1 orchestration interrupted. Workers stopped; no final task summary was produced.";

export async function waitForV1PoolTerminalOrInterrupt(args: {
  pool: WorkerPool;
  signalSource?: SigintSignalSource;
  graceMs?: number;
}): Promise<void> {
  const signalSource = args.signalSource ?? PROCESS_SIGINT_SIGNAL_SOURCE;
  const graceMs = args.graceMs ?? V1_SIGINT_GRACE_MS;
  let interrupted = false;
  let stopPromise: Promise<void> | undefined;
  let resolveInterrupted: () => void = () => {};
  const interruptedPromise = new Promise<void>((resolve) => {
    resolveInterrupted = resolve;
  });
  const terminalWaitAbort = new AbortController();
  const terminalWaitPromise = args.pool
    .waitForAllTerminal({ signal: terminalWaitAbort.signal })
    .then(() => "terminal" as const);

  const subscription = signalSource.onSigint(() => {
    if (interrupted) {
      return;
    }
    interrupted = true;
    stopPromise = args.pool.stop(graceMs);
    resolveInterrupted();
  });

  try {
    const result = await Promise.race([
      terminalWaitPromise,
      interruptedPromise.then(() => "interrupted" as const),
    ]);

    if (result === "interrupted") {
      terminalWaitAbort.abort();
      await Promise.all([
        stopPromise ?? Promise.resolve(),
        settleInterruptedTerminalWait(terminalWaitPromise),
      ]);
      throw new V1OrchestrationInterruptedError();
    }
  } finally {
    terminalWaitAbort.abort();
    subscription.dispose();
  }
}

async function settleInterruptedTerminalWait(waitPromise: Promise<unknown>): Promise<void> {
  try {
    await waitPromise;
  } catch {
    // SIGINT owns the result; the terminal waiter is only being settled to stop polling.
  }
}

export function parseArgs(rawArgs: string[]): CliArgs {
  const args = rawArgs.slice(2); // skip node and script path
  const result: CliArgs = { subcommand: "", parseErrors: [] };

  if (args.length === 0) {
    delete result.parseErrors;
    return result;
  }

  result.subcommand = args[0];

  let i = 1;
  const takeValue = (option: string): string | undefined => {
    if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
      result.parseErrors?.push(`Missing value for ${option}.`);
      return undefined;
    }
    i++;
    return args[i];
  };

  while (i < args.length) {
    const arg = args[i];
    if (arg === "--agent" || arg === "-a" || arg === "--agents") {
      const value = takeValue(arg);
      if (value !== undefined) {
        result.agentPath = value;
      }
    } else if (arg === "--database" || arg === "-d") {
      const value = takeValue(arg);
      if (value !== undefined) {
        result.databasePath = value;
      }
    } else if (arg === "--workers" || arg === "-w") {
      const value = takeValue(arg);
      if (value !== undefined) {
        result.workers = value;
      }
    } else if (arg.startsWith("-")) {
      result.parseErrors?.push(`Unknown option: ${arg}.`);
    } else if (!arg.startsWith("-")) {
      if (!result.workOrderPath) {
        result.workOrderPath = arg;
      } else {
        result.parseErrors?.push(`Unexpected positional argument: ${arg}.`);
      }
    }
    i++;
  }

  if (result.parseErrors?.length === 0) {
    delete result.parseErrors;
  }
  return result;
}

export function loadWorkOrder(filePath: string): WorkOrder {
  const content = fs.readFileSync(filePath, "utf-8");
  const ext = path.extname(filePath).toLowerCase();
  let raw: unknown;

  if (ext === ".yaml" || ext === ".yml") {
    try {
      raw = parseSimpleYaml(content);
    } catch (err) {
      throw new Error(
        `Failed to parse WorkOrder YAML: ${filePath}\n${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    try {
      raw = JSON.parse(content);
    } catch {
      throw new Error(`Failed to parse WorkOrder JSON: ${filePath}`);
    }
  }

  return parseWorkOrder(raw);
}

export function loadAgentProfile(filePath: string): AgentProfile {
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

  return parseAgentProfile(raw);
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

function summaryV1(result: RunWorkOrderV1Result): string {
  const lines = [
    `Task: ${result.taskId}`,
    `Final task status: ${result.status}`,
    `Attempts: ${result.attempts}`,
    `Database: ${result.databasePath}`,
    "Worktrees:",
    ...(result.runs.length > 0
      ? result.runs.map(
          (run) =>
            `  - ${run.role ?? "unknown"} ${run.runId} ${run.status} ${run.workspacePath ?? "(none)"}`,
        )
      : ["  - (none)"]),
    "Artifacts:",
    ...(result.artifacts.length > 0
      ? result.artifacts.map(
          (artifact) =>
            `  - ${artifact.runId} ${artifact.kind} ${artifact.uri} ${artifact.path}`,
        )
      : ["  - (none)"]),
  ];
  return lines.join("\n");
}

function summaryBatch(result: RunBatchV1Result): string {
  return result.tasks
    .map(
      (task) =>
        `Task: ${task.taskId} | Status: ${task.status} | Attempts: ${task.attempts} | Database: ${result.databasePath} | Runs: ${task.runCount} | Artifacts: ${task.artifactCount}`,
    )
    .join("\n");
}

function isV0WorkOrder(workOrder: WorkOrder): workOrder is ParsedWorkOrder {
  return workOrder.schema_version === "workflow/v0";
}

function isV0AgentProfile(agentProfile: AgentProfile): agentProfile is ParsedAgentProfile {
  return agentProfile.schema_version === "workflow/v0";
}

function isV1WorkOrder(workOrder: WorkOrder): workOrder is ParsedWorkOrderV1 {
  return workOrder.schema_version === "workflow/v1";
}

function resolveDatabasePath(workOrder: ParsedWorkOrderV1, databasePath?: string): string {
  return path.resolve(
    databasePath ?? path.join(workOrder.repo.path, ".agentflow", "agentflow.sqlite"),
  );
}

function resolveBatchDatabasePath(
  workOrders: readonly BatchWorkOrderInput[],
  databasePath?: string,
): string {
  if (workOrders.length === 0) {
    throw new Error("Cannot resolve a batch database path without WorkOrders.");
  }
  return path.resolve(
    databasePath ??
      path.join(workOrders[0].workOrder.repo.path, ".agentflow", "agentflow.sqlite"),
  );
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function validateWorkerCount(
  rawWorkers?: string,
): { ok: true; value: number } | { ok: false; message: string } {
  if (rawWorkers === undefined) {
    return { ok: true, value: DEFAULT_BATCH_WORKERS };
  }

  if (!/^\d+$/.test(rawWorkers)) {
    return {
      ok: false,
      message: `Invalid --workers value "${rawWorkers}". Expected an integer from ${MIN_BATCH_WORKERS} through ${MAX_BATCH_WORKERS}.`,
    };
  }

  const value = Number(rawWorkers);
  if (
    !Number.isInteger(value) ||
    value < MIN_BATCH_WORKERS ||
    value > MAX_BATCH_WORKERS
  ) {
    return {
      ok: false,
      message: `Invalid --workers value "${rawWorkers}". Expected an integer from ${MIN_BATCH_WORKERS} through ${MAX_BATCH_WORKERS}.`,
    };
  }

  return { ok: true, value };
}

function scopedTerminalMonitor(
  monitorQueue: Pick<TaskQueue, "listTerminal">,
  taskIds: Iterable<string>,
): Pick<TaskQueue, "listTerminal"> {
  const taskIdSet = new Set(taskIds);
  return {
    listTerminal: () =>
      monitorQueue.listTerminal().filter((entry) => taskIdSet.has(entry.task_id)),
  };
}

export function loadBatchWorkOrders(directoryPath: string): BatchWorkOrderInput[] {
  const resolvedDir = path.resolve(directoryPath);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedDir);
  } catch {
    throw new Error(`WorkOrders directory not found: ${resolvedDir}`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`WorkOrders path is not a directory: ${resolvedDir}`);
  }

  const fileNames = fs
    .readdirSync(resolvedDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => WORK_ORDER_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort(compareText);

  if (fileNames.length === 0) {
    throw new Error(
      `No WorkOrder files found in ${resolvedDir}. Expected .json, .yaml, or .yml files.`,
    );
  }

  const seenTaskIds = new Map<string, string>();
  const inputs: BatchWorkOrderInput[] = [];

  for (const fileName of fileNames) {
    const filePath = path.join(resolvedDir, fileName);
    let workOrder: WorkOrder;
    try {
      workOrder = loadWorkOrder(filePath);
    } catch (err) {
      throw new Error(
        `Invalid WorkOrder in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!isV1WorkOrder(workOrder)) {
      throw new Error(
        `Batch WorkOrder ${filePath} uses schema_version "${workOrder.schema_version}". ` +
          `agentflow batch supports only "workflow/v1"; use agentflow run for workflow/v0 WorkOrders.`,
      );
    }

    const existingPath = seenTaskIds.get(workOrder.task_id);
    if (existingPath) {
      throw new Error(
        `Duplicate task_id "${workOrder.task_id}" found in batch inputs:\n  - ${existingPath}\n  - ${filePath}`,
      );
    }

    seenTaskIds.set(workOrder.task_id, filePath);
    inputs.push({ filePath, fileName, workOrder });
  }

  return inputs;
}

function validateSingleProfileV1Run(
  workOrder: ParsedWorkOrderV1,
  agentProfile: ParsedAgentProfileV1,
): string | undefined {
  if (!agentProfile.capabilities.roles.includes("implementer")) {
    return `AgentProfile "${agentProfile.agent_id}" cannot run this WorkOrder: missing implementer role.`;
  }

  const missingCapabilities = workOrder.agent.required_capabilities.filter(
    (capability) => !agentProfile.capabilities.kinds.includes(capability),
  );
  if (missingCapabilities.length > 0) {
    return (
      `AgentProfile "${agentProfile.agent_id}" cannot run this WorkOrder: ` +
      `missing required capabilities ${missingCapabilities.join(", ")}.`
    );
  }

  if (
    workOrder.agent.implementer_pool.length > 0 &&
    !workOrder.agent.implementer_pool.includes(agentProfile.agent_id)
  ) {
    return (
      `AgentProfile "${agentProfile.agent_id}" cannot run this WorkOrder: ` +
      "it is not listed in agent.implementer_pool."
    );
  }

  if (workOrder.agent.exclude_agent_ids.includes(agentProfile.agent_id)) {
    return (
      `AgentProfile "${agentProfile.agent_id}" cannot run this WorkOrder: ` +
      "it is already listed in agent.exclude_agent_ids."
    );
  }

  return undefined;
}

function emitTaskEnqueued(args: {
  queue: TaskQueue;
  eventLog: SqliteEventLog;
  workOrder: ParsedWorkOrderV1;
}): void {
  const entry = args.queue.enqueue({ workOrder: args.workOrder, nextRole: "implementer" });
  args.eventLog.append({
    event_id: generateEventId(),
    event_type: "task.enqueued",
    project_id: entry.project_id,
    task_id: entry.task_id,
    payload: {
      next_role: entry.next_role,
      status: entry.status,
    },
    created_at: new Date().toISOString(),
  });
}

function cleanupV1TerminalWorktrees(args: {
  db: Database;
  taskIds: readonly string[];
}): void {
  const runStore = new SqliteRunStore(args.db);
  const eventLog = new SqliteEventLog(args.db);
  const sandboxProvider = new GitWorktreeSandboxProvider();
  const seenRunIds = new Set<string>();

  for (const run of runStore.listCleanupCandidates(args.taskIds)) {
    if (seenRunIds.has(run.run_id)) {
      continue;
    }
    seenRunIds.add(run.run_id);

    if (!run.workspace_path) {
      continue;
    }

    try {
      sandboxProvider.cleanup({ workspacePath: run.workspace_path });
    } catch (err) {
      throw new Error(
        `Failed to clean worktree for task ${run.task_id}, run ${run.run_id} at ${run.workspace_path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    eventLog.append({
      event_id: generateEventId(),
      event_type: "run.cleaned_up",
      project_id: run.project_id,
      task_id: run.task_id,
      run_id: run.run_id,
      agent_id: run.agent_id,
      payload: {},
      created_at: new Date().toISOString(),
    });
  }
}

function makeV1WorkerServices(args: {
  db: Database;
  agentPath: string;
  artifactRepoPath: string;
  projectId?: string;
  sharedQuotaHealth?: Map<string, AgentRegistryEntry["quota_health"]>;
}): {
  queue: DefaultTaskQueue;
  handler: V1WorkerTaskHandler;
} {
  migrate(args.db);

  const eventLog = new SqliteEventLog(args.db);
  const runStore = new SqliteRunStore(args.db);
  const metricsStore = new SqliteMetricsStore(args.db);
  const registry = new SqliteAgentRegistry(
    metricsStore,
    50,
    eventLog,
    args.projectId,
    args.sharedQuotaHealth,
  );
  registry.load({ sources: [args.agentPath] });

  const queue = new DefaultTaskQueue({
    store: new SqliteQueueStore(args.db),
  });
  const artifactStore = new LocalArtifactStore(args.db, args.artifactRepoPath);
  const handoffManager = new DefaultHandoffManager({
    artifactStore,
    projectId: args.projectId,
  });
  const runTaskServices = {
    eventLog,
    runStore,
    artifactStore,
    sandboxProvider: new GitWorktreeSandboxProvider(),
    taskCapsuleWriter: new FileTaskCapsuleWriter(),
    reviewBriefWriter: new FileReviewBriefWriter(),
    adapter: new ChildProcessOfficialCliAdapter(),
    verifier: new ShellVerificationRunner(),
    handoffManager,
  };

  const handler = new V1WorkerTaskHandler({
    queue,
    eventLog,
    registry,
    scheduler: new DefaultScheduler(),
    budgetManager: new DefaultBudgetManager({
      budgetStore: new SqliteBudgetStore(args.db),
      eventLog,
      projectId: args.projectId,
    }),
    handoffManager,
    runTaskOnce,
    runTaskServices,
    db: args.db,
  });

  return { queue, handler };
}

class BatchInputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchInputValidationError";
  }
}

class RunInputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunInputValidationError";
  }
}

function assertValidAgentRegistrySource(args: {
  db: Database;
  agentPath: string;
}): void {
  const registry = new SqliteAgentRegistry(new SqliteMetricsStore(args.db));
  try {
    registry.load({ sources: [args.agentPath] });
  } catch (err) {
    throw new BatchInputValidationError(
      `AgentRegistry validation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (registry.list().length === 0) {
    throw new BatchInputValidationError(
      `AgentRegistry validation failed: no workflow/v1 AgentProfiles found in ${path.resolve(args.agentPath)}.`,
    );
  }
}

function assertValidV1RunAgentRegistrySource(args: {
  registry: SqliteAgentRegistry;
  agentPath: string;
  workOrder: ParsedWorkOrderV1;
}): void {
  const entries = args.registry.list();
  if (entries.length === 0) {
    throw new RunInputValidationError(
      `AgentRegistry validation failed: no workflow/v1 AgentProfiles found in ${path.resolve(args.agentPath)}.`,
    );
  }

  if (args.workOrder.review.enabled) {
    if (entries.length === 1) {
      throw new RunInputValidationError(
        "workflow/v1 agentflow run no longer uses the single-profile smoke path when review.enabled=true. " +
          "Provide an AgentRegistry source with separate implementer and reviewer profiles.",
      );
    }
    return;
  }

  if (entries.length !== 1) {
    throw new RunInputValidationError(
      "workflow/v1 agentflow run with review.enabled=false requires exactly one AgentProfile.",
    );
  }

  const validationError = validateSingleProfileV1Run(
    args.workOrder,
    parseAgentProfileV1(entries[0].profile),
  );
  if (validationError) {
    throw new RunInputValidationError(validationError);
  }
}

function buildV1Result(args: {
  db: Database;
  workOrder: ParsedWorkOrderV1;
  databasePath: string;
}): RunWorkOrderV1Result {
  const entry = args.db
    .prepare("select * from task_queue where task_id = ?")
    .get(args.workOrder.task_id) as
    | {
        project_id: string;
        task_id: string;
        status: RunWorkOrderV1Result["status"];
        attempts: number;
      }
    | undefined;

  if (!entry) {
    throw new Error(`TaskQueue entry not found after v1 run: ${args.workOrder.task_id}`);
  }
  if (
    entry.status !== "accepted" &&
    entry.status !== "failed" &&
    entry.status !== "awaiting_human"
  ) {
    throw new Error(`Task did not reach a terminal status: ${entry.status}`);
  }

  const runs = args.db
    .prepare(
      `select id, agent_id, status, role, workspace_path
       from agent_runs
       where task_id = ?
       order by rowid asc`,
    )
    .all(args.workOrder.task_id) as Array<{
    id: string;
    agent_id: string;
    status: string;
    role: "implementer" | "reviewer" | null;
    workspace_path: string | null;
  }>;

  const artifacts = args.db
    .prepare(
      `select run_id, kind, uri, path
       from artifacts
       where task_id = ?
       order by rowid asc`,
    )
    .all(args.workOrder.task_id) as Array<{
    run_id: string;
    kind: string;
    uri: string;
    path: string;
  }>;

  return {
    projectId: entry.project_id,
    taskId: entry.task_id,
    status: entry.status,
    attempts: entry.attempts,
    databasePath: args.databasePath,
    runs: runs.map((run) => ({
      runId: run.id,
      agentId: run.agent_id,
      status: run.status,
      role: run.role ?? undefined,
      workspacePath: run.workspace_path ?? undefined,
    })),
    artifacts: artifacts.map((artifact) => ({
      runId: artifact.run_id,
      kind: artifact.kind,
      uri: artifact.uri,
      path: artifact.path,
    })),
  };
}

function buildBatchResult(args: {
  db: Database;
  inputs: readonly BatchWorkOrderInput[];
  databasePath: string;
  workers: number;
}): RunBatchV1Result {
  const orderedInputs = [...args.inputs].sort((a, b) =>
    compareText(a.workOrder.task_id, b.workOrder.task_id),
  );

  const tasks = orderedInputs.map((input) => {
    const entry = args.db
      .prepare("select task_id, status, attempts from task_queue where task_id = ?")
      .get(input.workOrder.task_id) as
      | {
          task_id: string;
          status: RunBatchV1Result["tasks"][number]["status"];
          attempts: number;
        }
      | undefined;

    if (!entry) {
      throw new Error(`TaskQueue entry not found after batch run: ${input.workOrder.task_id}`);
    }
    if (
      entry.status !== "accepted" &&
      entry.status !== "failed" &&
      entry.status !== "awaiting_human"
    ) {
      throw new Error(`Task did not reach a terminal status: ${entry.status}`);
    }

    const runCount = (
      args.db
        .prepare("select count(*) as c from agent_runs where task_id = ?")
        .get(entry.task_id) as { c: number }
    ).c;
    const artifactCount = (
      args.db
        .prepare("select count(*) as c from artifacts where task_id = ?")
        .get(entry.task_id) as { c: number }
    ).c;

    return {
      inputPath: input.filePath,
      taskId: entry.task_id,
      status: entry.status,
      attempts: entry.attempts,
      runCount,
      artifactCount,
    };
  });

  return {
    databasePath: args.databasePath,
    workers: args.workers,
    tasks,
  };
}

export async function runWorkOrderV1(args: {
  workOrder: ParsedWorkOrderV1;
  agentPath: string;
  databasePath?: string;
  signalSource?: SigintSignalSource;
  sigintGraceMs?: number;
}): Promise<RunWorkOrderV1Result> {
  const databasePath = resolveDatabasePath(args.workOrder, args.databasePath);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const mainDb = openDatabase(databasePath);
  let pool: DefaultWorkerPool | undefined;
  const workerDbs = new Map<string, Database>();
  const sharedQuotaHealth = new Map<string, AgentRegistryEntry["quota_health"]>();

  try {
    migrate(mainDb);

    const registry = new SqliteAgentRegistry(new SqliteMetricsStore(mainDb));
    try {
      registry.load({ sources: [args.agentPath] });
    } catch (err) {
      throw new RunInputValidationError(
        `AgentRegistry validation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    assertValidV1RunAgentRegistrySource({
      registry,
      agentPath: args.agentPath,
      workOrder: args.workOrder,
    });

    const monitorQueue = new DefaultTaskQueue({
      store: new SqliteQueueStore(mainDb),
    });
    emitTaskEnqueued({
      queue: monitorQueue,
      eventLog: new SqliteEventLog(mainDb),
      workOrder: args.workOrder,
    });

    pool = new DefaultWorkerPool({
      expectedTerminalCount: 1,
      monitorQueue: scopedTerminalMonitor(monitorQueue, [args.workOrder.task_id]),
      factory: {
        create: (workerId) => {
          const workerDb = openDatabase(databasePath);
          workerDbs.set(workerId, workerDb);
          return makeV1WorkerServices({
            db: workerDb,
            agentPath: args.agentPath,
            artifactRepoPath: args.workOrder.repo.path,
            projectId: args.workOrder.project_id,
            sharedQuotaHealth,
          });
        },
        close: (workerId) => {
          const workerDb = workerDbs.get(workerId);
          if (!workerDb) return;
          workerDb.close();
          workerDbs.delete(workerId);
        },
      },
    });

    pool.start(1);
    await waitForV1PoolTerminalOrInterrupt({
      pool,
      signalSource: args.signalSource,
      graceMs: args.sigintGraceMs,
    });
    await pool.stop();
    cleanupV1TerminalWorktrees({
      db: mainDb,
      taskIds: [args.workOrder.task_id],
    });

    return buildV1Result({
      db: mainDb,
      workOrder: args.workOrder,
      databasePath,
    });
  } finally {
    if (pool) {
      await pool.stop();
    }
    for (const workerDb of workerDbs.values()) {
      workerDb.close();
    }
    workerDbs.clear();
    mainDb.close();
  }
}

export async function runBatchV1(args: {
  inputs: readonly BatchWorkOrderInput[];
  agentPath: string;
  workers: number;
  databasePath?: string;
  signalSource?: SigintSignalSource;
  sigintGraceMs?: number;
}): Promise<RunBatchV1Result> {
  const databasePath = resolveBatchDatabasePath(args.inputs, args.databasePath);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const mainDb = openDatabase(databasePath);
  let pool: DefaultWorkerPool | undefined;
  const workerDbs = new Map<string, Database>();
  const firstWorkOrder = args.inputs[0].workOrder;
  const sharedQuotaHealth = new Map<string, AgentRegistryEntry["quota_health"]>();

  try {
    migrate(mainDb);
    assertValidAgentRegistrySource({ db: mainDb, agentPath: args.agentPath });

    const monitorQueue = new DefaultTaskQueue({
      store: new SqliteQueueStore(mainDb),
    });
    const eventLog = new SqliteEventLog(mainDb);

    for (const input of args.inputs) {
      emitTaskEnqueued({
        queue: monitorQueue,
        eventLog,
        workOrder: input.workOrder,
      });
    }

    pool = new DefaultWorkerPool({
      expectedTerminalCount: args.inputs.length,
      monitorQueue: scopedTerminalMonitor(
        monitorQueue,
        args.inputs.map((input) => input.workOrder.task_id),
      ),
      factory: {
        create: (workerId) => {
          const workerDb = openDatabase(databasePath);
          workerDbs.set(workerId, workerDb);
          return makeV1WorkerServices({
            db: workerDb,
            agentPath: args.agentPath,
            artifactRepoPath: firstWorkOrder.repo.path,
            projectId: firstWorkOrder.project_id,
            sharedQuotaHealth,
          });
        },
        close: (workerId) => {
          const workerDb = workerDbs.get(workerId);
          if (!workerDb) return;
          workerDb.close();
          workerDbs.delete(workerId);
        },
      },
    });

    pool.start(args.workers);
    await waitForV1PoolTerminalOrInterrupt({
      pool,
      signalSource: args.signalSource,
      graceMs: args.sigintGraceMs,
    });
    await pool.stop();
    cleanupV1TerminalWorktrees({
      db: mainDb,
      taskIds: args.inputs.map((input) => input.workOrder.task_id),
    });

    return buildBatchResult({
      db: mainDb,
      inputs: args.inputs,
      databasePath,
      workers: args.workers,
    });
  } finally {
    if (pool) {
      await pool.stop();
    }
    for (const workerDb of workerDbs.values()) {
      workerDb.close();
    }
    workerDbs.clear();
    mainDb.close();
  }
}

const USAGE = `Usage:
  agentflow run <work_order.json> --agent <agent.yaml|agent.json> [--database <path>]
  agentflow batch <work_orders_dir> --agents <agents_file_or_dir> [--workers N] [--database <path>]

Required:
  run:
    work_order.json    Path to the WorkOrder file (JSON or YAML).
    --agent <path>     Path to the AgentProfile file (JSON or YAML).

  batch:
    work_orders_dir    Directory containing workflow/v1 WorkOrders.
    --agents <path>    Path to a workflow/v1 AgentProfile file or directory.

Optional:
  --workers N        Batch worker count, 1 through 16. Default: 2.
  --database <path>  Path to the SQLite database file.
                     Default: <first repo>/.agentflow/agentflow.sqlite

Exit codes:
  0  Orchestration succeeded.
  1  Orchestration completed but run failed.
  2  Input validation or argument error.
  3  Batch completed with at least one task awaiting human input and no failures.
  130  v1 orchestration interrupted by SIGINT.
`;

export function cliError(message: string): CliResult {
  return { exitCode: 2, message };
}

export async function runCli(
  args: CliArgs,
  services: CliRuntimeServices = {},
): Promise<CliResult> {
  // Validate subcommand
  if (args.subcommand === "") {
    return { exitCode: 2, message: `Missing command.\n\n${USAGE}` };
  }

  if (args.subcommand === "help" || args.subcommand === "--help" || args.subcommand === "-h") {
    return { exitCode: 0, message: USAGE };
  }

  if (args.parseErrors?.length) {
    return cliError(`${args.parseErrors.join("\n")}\n\n${USAGE}`);
  }

  if (args.subcommand !== "run" && args.subcommand !== "batch") {
    return cliError(`Unknown command: ${args.subcommand}\n\n${USAGE}`);
  }

  if (args.subcommand === "batch") {
    if (!args.workOrderPath) {
      return cliError(`Missing work_orders_dir argument.\n\n${USAGE}`);
    }

    if (!args.agentPath) {
      return cliError(`Missing --agents argument.\n\n${USAGE}`);
    }

    const workers = validateWorkerCount(args.workers);
    if (!workers.ok) {
      return cliError(`${workers.message}\n\n${USAGE}`);
    }

    let inputs: BatchWorkOrderInput[];
    try {
      inputs = loadBatchWorkOrders(args.workOrderPath);
    } catch (err) {
      return cliError(
        `Batch WorkOrder validation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const result = await runBatchV1({
        inputs,
        agentPath: args.agentPath,
        workers: workers.value,
        databasePath: args.databasePath,
        signalSource: services.signalSource,
        sigintGraceMs: services.sigintGraceMs,
      });

      const exitCode = result.tasks.some((task) => task.status === "failed")
        ? 1
        : result.tasks.some((task) => task.status === "awaiting_human")
          ? 3
          : 0;
      return { exitCode, message: summaryBatch(result), result };
    } catch (err) {
      if (err instanceof V1OrchestrationInterruptedError) {
        return { exitCode: 130, message: V1_INTERRUPTED_MESSAGE };
      }
      if (err instanceof BatchInputValidationError) {
        return cliError(err.message);
      }
      return {
        exitCode: 1,
        message: `Batch orchestration error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (!args.workOrderPath) {
    return cliError(`Missing work_order.json argument.\n\n${USAGE}`);
  }

  if (!args.agentPath) {
    return cliError(`Missing --agent argument.\n\n${USAGE}`);
  }

  // Load and validate inputs
  let workOrder: WorkOrder;
  try {
    workOrder = loadWorkOrder(args.workOrderPath);
  } catch (err) {
    return cliError(
      `WorkOrder validation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (isV0WorkOrder(workOrder)) {
    let agentProfile: AgentProfile;
    try {
      agentProfile = loadAgentProfile(args.agentPath);
    } catch (err) {
      return cliError(
        `AgentProfile validation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!isV0AgentProfile(agentProfile)) {
      return cliError(
        `AgentProfile schema_version "${agentProfile.schema_version}" cannot run workflow/v0 WorkOrders. Expected "workflow/v0".`,
      );
    }

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

  if (isV1WorkOrder(workOrder)) {
    try {
      const result = await runWorkOrderV1({
        workOrder,
        agentPath: args.agentPath,
        databasePath: args.databasePath,
        signalSource: services.signalSource,
        sigintGraceMs: services.sigintGraceMs,
      });

      const msg = summaryV1(result);
      const exitCode =
        result.status === "accepted" ? 0 : result.status === "awaiting_human" ? 3 : 1;
      return { exitCode, message: msg, result };
    } catch (err) {
      if (err instanceof V1OrchestrationInterruptedError) {
        return { exitCode: 130, message: V1_INTERRUPTED_MESSAGE };
      }
      if (err instanceof RunInputValidationError) {
        return cliError(err.message);
      }
      return {
        exitCode: 1,
        message: `Orchestration error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return cliError(`Unsupported WorkOrder schema_version: ${(workOrder as WorkOrder).schema_version}`);
}
