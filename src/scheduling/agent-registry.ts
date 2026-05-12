import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentRegistryEntry } from "../core/types.js";
import type { ParsedAgentProfileV1 } from "../core/schemas-v1.js";
import { parseAgentProfileV1 } from "../core/schemas-v1.js";
import { parseSimpleYaml } from "../cli/yaml-simple.js";
import type { MetricsStore } from "../storage/metrics-store.js";
import type { EventLog } from "../storage/event-log.js";
import type { RunFailedReason } from "../core/events.js";
import { generateEventId } from "../core/ids.js";

export interface AgentRegistry {
  load(args: { sources: string[] }): void;
  list(): AgentRegistryEntry[];
  get(agentId: string): AgentRegistryEntry | undefined;
  candidatesFor(args: {
    requiredCapabilities: string[];
    role: "implementer" | "reviewer";
    excludeAgentIds: string[];
  }): AgentRegistryEntry[];
  recordOutcome(args: {
    agentId: string;
    success: boolean;
    wallTimeMs: number;
    actualCostUnits?: number;
    runId?: string;
    failureReason?: RunFailedReason;
  }): void;
  refreshQuotaHealth(): void;
}

interface InternalEntry {
  profile: ParsedAgentProfileV1;
  loaded_from: string;
  rolling_metrics: AgentRegistryEntry["rolling_metrics"];
  quota_health: AgentRegistryEntry["quota_health"];
}

export class SqliteAgentRegistry implements AgentRegistry {
  private entries = new Map<string, InternalEntry>();
  private readonly metricsStore: MetricsStore;
  private readonly rollingWindowSize: number;
  private readonly eventLog: EventLog | undefined;
  private readonly projectId: string;
  private readonly sharedQuotaHealth: Map<string, AgentRegistryEntry["quota_health"]>;

  constructor(
    metricsStore: MetricsStore,
    rollingWindowSize = 50,
    eventLog?: EventLog,
    projectId = "default",
    sharedQuotaHealth?: Map<string, AgentRegistryEntry["quota_health"]>,
  ) {
    this.metricsStore = metricsStore;
    this.rollingWindowSize = rollingWindowSize;
    this.eventLog = eventLog;
    this.projectId = projectId;
    this.sharedQuotaHealth = sharedQuotaHealth ?? new Map();
  }

  load(args: { sources: string[] }): void {
    for (const source of args.sources) {
      const resolved = path.resolve(source);

      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolved);
      } catch {
        throw new Error(`AgentRegistry source not found: ${resolved}`);
      }

      if (stat.isDirectory()) {
        this.loadDirectory(resolved);
      } else {
        this.loadFile(resolved);
      }
    }
  }

  private loadDirectory(dirPath: string): void {
    const entries = fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .filter((name) => {
        const ext = path.extname(name).toLowerCase();
        return ext === ".json" || ext === ".yaml" || ext === ".yml";
      })
      .sort(); // deterministic: lexicographic by filename

    for (const name of entries) {
      this.loadFile(path.join(dirPath, name));
    }
  }

  private loadFile(filePath: string): void {
    const ext = path.extname(filePath).toLowerCase();
    const content = fs.readFileSync(filePath, "utf-8");

    let raw: unknown;
    if (ext === ".yaml" || ext === ".yml") {
      try {
        raw = parseSimpleYaml(content);
      } catch (err) {
        throw new Error(
          `Failed to parse YAML agent profile: ${filePath}\n${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      try {
        raw = JSON.parse(content);
      } catch {
        throw new Error(`Failed to parse JSON agent profile: ${filePath}`);
      }
    }

    let profile: ParsedAgentProfileV1;
    try {
      profile = parseAgentProfileV1(raw);
    } catch (err) {
      const zodMsg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Invalid agent profile in ${filePath}: ${zodMsg}`,
      );
    }

    // Reject v0 profiles
    if ((profile as { schema_version: string }).schema_version !== "workflow/v1") {
      throw new Error(
        `Agent profile in ${filePath} has schema_version "${(profile as { schema_version: string }).schema_version}". Only "workflow/v1" is supported by the v1 AgentRegistry.`,
      );
    }

    // Check for duplicate agent_id
    const existing = this.entries.get(profile.agent_id);
    if (existing) {
      throw new Error(
        `Duplicate agent_id "${profile.agent_id}" found in:\n  - ${existing.loaded_from}\n  - ${filePath}`,
      );
    }

    // Initialize metrics from MetricsStore
    const stored = this.metricsStore.rollingFor(profile.agent_id, this.rollingWindowSize);
    const rolling_metrics: AgentRegistryEntry["rolling_metrics"] = stored.runsObserved > 0
      ? {
          success_rate: stored.successRate,
          avg_latency_ms: stored.avgLatencyMs,
          avg_actual_cost_units: stored.avgActualCostUnits,
          runs_observed: stored.runsObserved,
          last_updated_at: new Date().toISOString(),
        }
      : {
          success_rate: profile.reliability.initial_success_rate,
          avg_latency_ms: profile.reliability.initial_avg_latency_ms,
          avg_actual_cost_units: 0,
          runs_observed: 0,
          last_updated_at: new Date().toISOString(),
        };

    this.entries.set(profile.agent_id, {
      profile,
      loaded_from: filePath,
      rolling_metrics,
      quota_health: this.sharedQuotaHealth.get(profile.agent_id) ?? "healthy",
    });
  }

  list(): AgentRegistryEntry[] {
    return [...this.entries.values()].map((e) => this.toExternal(e));
  }

  get(agentId: string): AgentRegistryEntry | undefined {
    const entry = this.entries.get(agentId);
    return entry ? this.toExternal(entry) : undefined;
  }

  candidatesFor(args: {
    requiredCapabilities: string[];
    role: "implementer" | "reviewer";
    excludeAgentIds: string[];
  }): AgentRegistryEntry[] {
    const excludeSet = new Set(args.excludeAgentIds);
    const capabilitySet = new Set(args.requiredCapabilities);

    const results: InternalEntry[] = [];
    for (const entry of this.entries.values()) {
      this.syncQuotaHealth(entry);

      // Filter: quota_health exhausted
      if (entry.quota_health === "exhausted") continue;

      // Filter: excluded
      if (excludeSet.has(entry.profile.agent_id)) continue;

      // Filter: role
      if (!(entry.profile.capabilities.roles as string[]).includes(args.role)) continue;

      // Filter: capabilities (subset check)
      const kindsSet = new Set(entry.profile.capabilities.kinds);
      let capMatch = true;
      for (const cap of capabilitySet) {
        if (!kindsSet.has(cap)) {
          capMatch = false;
          break;
        }
      }
      if (!capMatch) continue;

      results.push(entry);
    }

    // Deterministic: sort by agent_id lexicographic
    results.sort((a, b) => a.profile.agent_id.localeCompare(b.profile.agent_id));

    return results.map((e) => this.toExternal(e));
  }

  recordOutcome(args: {
    agentId: string;
    success: boolean;
    wallTimeMs: number;
    actualCostUnits?: number;
    runId?: string;
    failureReason?: RunFailedReason;
  }): void {
    const entry = this.entries.get(args.agentId);
    if (!entry) {
      throw new Error(`Agent not found in registry: ${args.agentId}`);
    }

    const runId = args.runId ?? `metrics-${args.agentId}-${Date.now()}`;
    this.metricsStore.recordRunOutcome({
      agentId: args.agentId,
      runId,
      success: args.success,
      wallTimeMs: args.wallTimeMs,
      actualCostUnits: args.actualCostUnits,
    });

    // Refresh rolling metrics for this agent
    this.refreshEntryMetrics(entry);
    if (!args.success && args.failureReason) {
      this.applyProviderFailure(entry, args.failureReason, runId);
    }
  }

  refreshQuotaHealth(): void {
    for (const entry of this.entries.values()) {
      this.syncQuotaHealth(entry);
    }
  }

  private refreshEntryMetrics(entry: InternalEntry): void {
    const stored = this.metricsStore.rollingFor(entry.profile.agent_id, this.rollingWindowSize);
    entry.rolling_metrics = stored.runsObserved > 0
      ? {
          success_rate: stored.successRate,
          avg_latency_ms: stored.avgLatencyMs,
          avg_actual_cost_units: stored.avgActualCostUnits,
          runs_observed: stored.runsObserved,
          last_updated_at: new Date().toISOString(),
        }
      : {
          success_rate: entry.profile.reliability.initial_success_rate,
          avg_latency_ms: entry.profile.reliability.initial_avg_latency_ms,
          avg_actual_cost_units: 0,
          runs_observed: 0,
          last_updated_at: new Date().toISOString(),
        };
  }

  private applyProviderFailure(
    entry: InternalEntry,
    reason: RunFailedReason,
    runId: string,
  ): void {
    switch (reason) {
      case "provider_rate_limited": {
        if (this.syncQuotaHealth(entry) !== "healthy") return;
        this.setQuotaHealth(entry, "low");
        this.emitAgentQuotaEvent("quota.low", entry.profile.agent_id, reason, runId);
        return;
      }
      case "provider_quota_exhausted":
      case "provider_auth_failed": {
        if (this.syncQuotaHealth(entry) === "exhausted") return;
        this.setQuotaHealth(entry, "exhausted");
        this.emitAgentQuotaEvent("quota.exhausted", entry.profile.agent_id, reason, runId);
        return;
      }
      default:
        return;
    }
  }

  private syncQuotaHealth(entry: InternalEntry): AgentRegistryEntry["quota_health"] {
    const shared = this.sharedQuotaHealth.get(entry.profile.agent_id);
    if (shared) {
      entry.quota_health = shared;
    }
    return entry.quota_health;
  }

  private setQuotaHealth(
    entry: InternalEntry,
    quotaHealth: AgentRegistryEntry["quota_health"],
  ): void {
    entry.quota_health = quotaHealth;
    this.sharedQuotaHealth.set(entry.profile.agent_id, quotaHealth);
  }

  private emitAgentQuotaEvent(
    eventType: "quota.low" | "quota.exhausted",
    agentId: string,
    reason: RunFailedReason,
    runId: string,
  ): void {
    if (!this.eventLog) return;

    this.eventLog.append({
      event_id: generateEventId(),
      event_type: eventType,
      project_id: this.projectId,
      run_id: runId,
      agent_id: agentId,
      skip_on_replay: true,
      payload: {
        scope: "agent",
        agent_id: agentId,
        reason,
      },
      created_at: new Date().toISOString(),
    });
  }

  private toExternal(entry: InternalEntry): AgentRegistryEntry {
    this.syncQuotaHealth(entry);
    return {
      profile: structuredClone(entry.profile),
      loaded_from: entry.loaded_from,
      rolling_metrics: { ...entry.rolling_metrics },
      quota_health: entry.quota_health,
    };
  }
}
