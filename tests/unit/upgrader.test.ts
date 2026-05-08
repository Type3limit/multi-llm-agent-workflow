import { describe, it, expect } from "vitest";
import { upgradeWorkOrderV0ToV1 } from "../../src/core/upgrader.js";
import { WorkOrderV1Schema } from "../../src/core/schemas-v1.js";
import type { WorkOrderV0 } from "../../src/core/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const validV0: WorkOrderV0 = {
  schema_version: "workflow/v0",
  task_id: "T-smoke",
  title: "Smoke Test",
  type: "code_change",
  goal: "Edit README.md.",
  acceptance_criteria: ["README is modified."],
  repo: { path: "/tmp/test-repo", base_ref: "main" },
  verification: { commands: ["node -e 'process.exit(0)'"] },
  agent: { agent_id: "claude-local" },
  budget: { max_wall_time_minutes: 30 },
};

describe("upgradeWorkOrderV0ToV1", () => {
  it("produces output that passes WorkOrderV1Schema", () => {
    const result = upgradeWorkOrderV0ToV1(validV0);
    expect(() => WorkOrderV1Schema.parse(result)).not.toThrow();
  });

  it("sets schema_version to workflow/v1", () => {
    const result = upgradeWorkOrderV0ToV1(validV0);
    expect(result.schema_version).toBe("workflow/v1");
  });

  it("copies common fields verbatim", () => {
    const result = upgradeWorkOrderV0ToV1(validV0);
    expect(result.task_id).toBe("T-smoke");
    expect(result.title).toBe("Smoke Test");
    expect(result.type).toBe("code_change");
    expect(result.goal).toBe("Edit README.md.");
    expect(result.acceptance_criteria).toEqual(["README is modified."]);
    expect(result.repo).toEqual({ path: "/tmp/test-repo", base_ref: "main" });
  });

  it("maps agent.agent_id to implementer_pool", () => {
    const result = upgradeWorkOrderV0ToV1(validV0);
    expect(result.agent.implementer_pool).toEqual(["claude-local"]);
  });

  it("sets reviewer_pool and exclude_agent_ids to empty", () => {
    const result = upgradeWorkOrderV0ToV1(validV0);
    expect(result.agent.reviewer_pool).toEqual([]);
    expect(result.agent.exclude_agent_ids).toEqual([]);
  });

  it("synthesizes required_capabilities from type", () => {
    const result = upgradeWorkOrderV0ToV1(validV0);
    expect(result.agent.required_capabilities).toEqual(["code_change"]);
  });

  it("synthesizes required_capabilities for docs_update type", () => {
    const v0: WorkOrderV0 = {
      ...validV0,
      type: "docs_update",
    };
    const result = upgradeWorkOrderV0ToV1(v0);
    expect(result.agent.required_capabilities).toEqual(["docs_update"]);
  });

  it("sets review.enabled to false", () => {
    const result = upgradeWorkOrderV0ToV1(validV0);
    expect(result.review.enabled).toBe(false);
  });

  it("sets review.max_review_runs to 0 (disabled)", () => {
    const result = upgradeWorkOrderV0ToV1(validV0);
    expect(result.review.max_review_runs).toBe(0);
  });

  it("sets budget.max_runs to 1", () => {
    const result = upgradeWorkOrderV0ToV1(validV0);
    expect(result.budget.max_runs).toBe(1);
  });

  it("preserves v0 budget.max_wall_time_minutes", () => {
    const result = upgradeWorkOrderV0ToV1(validV0);
    expect(result.budget.max_wall_time_minutes).toBe(30);
  });

  it("defaults max_wall_time_minutes to 30 if v0 has no budget", () => {
    const { budget, ...v0NoBudget } = validV0;
    const result = upgradeWorkOrderV0ToV1(v0NoBudget as WorkOrderV0);
    expect(result.budget.max_wall_time_minutes).toBe(30);
  });

  it("defaults max_total_cost_units to 10", () => {
    const result = upgradeWorkOrderV0ToV1(validV0);
    expect(result.budget.max_total_cost_units).toBe(10);
  });

  it("copies constraints if present", () => {
    const v0: WorkOrderV0 = {
      ...validV0,
      constraints: {
        allowed_paths: ["src/**"],
        forbidden_paths: [".env"],
        max_files_to_touch: 5,
      },
    };
    const result = upgradeWorkOrderV0ToV1(v0);
    expect(result.constraints).toEqual(v0.constraints);
  });

  it("does not add constraints if absent", () => {
    const result = upgradeWorkOrderV0ToV1(validV0);
    expect(result.constraints).toBeUndefined();
  });

  it("copies verification if present", () => {
    const result = upgradeWorkOrderV0ToV1(validV0);
    expect(result.verification).toEqual(validV0.verification);
  });

  it("preserves explicit project_id", () => {
    const v0: WorkOrderV0 = { ...validV0, project_id: "my-project" };
    const result = upgradeWorkOrderV0ToV1(v0);
    expect(result.project_id).toBe("my-project");
  });

  it("output satisfies budget.max_runs >= review.max_review_runs + 1 constraint", () => {
    const result = upgradeWorkOrderV0ToV1(validV0);
    expect(result.review.enabled).toBe(false);
    expect(result.review.max_review_runs).toBe(0);
    expect(result.budget.max_runs).toBe(1);
    expect(() => WorkOrderV1Schema.parse(result)).not.toThrow();
  });
});
