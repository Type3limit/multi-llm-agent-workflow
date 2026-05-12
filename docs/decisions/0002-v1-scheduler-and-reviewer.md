# 0002. v1 Scope: Scheduler + Reviewer + Parallel Workers

## Status

Accepted for v1.

## Context

v0 shipped a single supervised official CLI agent in one-shot mode. The architecture document (`docs/architecture/multi-agent-llm-workflow-design.md`) describes the full platform: Intake & Planner, Task Graph / DAG, Scheduler, Budget & Quota Manager, Context Broker, Tool Executor, Policy Engine, Event Log, Artifact Store, Memory & Summary Store, plus a list of verifier-class components (Deterministic Checks, Acceptance Verifier, Reviewer Agent, Adversarial Reviewer, Handoff Quality Gate, Eval Suite, Context Broker policy filter, Artifact Instruction Scanner, Secret Leak Scanner, Agent Anomaly Detector).

If v1 tried to land all of that, it would either:

1. Stay vapourware for many months, or
2. Land thin shells of every component that would warp under pressure from the first real user.

The first vertical slice (v0) deliberately picked the single most important block — *can we supervise an official CLI agent in an isolated worktree at all?* — and proved it. v1 must pick the next single most important block.

## Decision

v1 introduces the smallest set of components that turn the system from "single supervised agent" into "multi-LLM orchestration":

1. **AgentRegistry** — multiple AgentProfiles loaded at once, each with declared capability/cost/quota.
2. **Scheduler** — score-based pick over candidates filtered by capability, role, exclusion, and quota.
3. **Reviewer Agent** — a second LLM run that produces a structured `ReviewVerdict` over the implementer's diff. This is the simplest meaningful "more than one model collaborates on one task" pattern.
4. **TaskQueue + Worker Pool** — SQLite-backed queue with row leases; multiple WorkOrders run in parallel via in-process workers.
5. **HandoffManager** — every requeue produces a HandoffPacket; failed agents are excluded from the next pick for that task.
6. **BudgetManager** — per-task wall time / cost / run-count caps that the Scheduler honours.

That is the entirety of v1's new control plane. The data plane gets three new SQLite tables (`task_queue`, `agent_metrics`, `task_budget`) and three new artifact kinds (`review_verdict`, `handoff_packet`, `schedule_decision`).

## Relationship to Four-Layer Decoupling

The four-layer direction (`Agent/Sandbox`, `Coordinator`, `Session`, `SessionStore`) is accepted as a useful post-v1 compass, but it does not expand v1.

There is an explicit gate before any L1/L3/L2 work starts: the v1 Remaining list in `docs/implementation/v1-status.md` must be complete, and the fake-agent approve, changes_requested/requeue, and parallel batch e2e scenarios must pass. Until that gate is green, new abstraction work risks hiding unfinished v1 wiring bugs.

Post-v1 order:

1. **SandboxProvider seam**: implemented in v1.x Phase 1 by wrapping current git worktree behavior first. Docker / micro-VM adapters are later adapters, not part of this ADR.
2. **SessionSnapshot**: implemented in v1.x Phase 2 as a read-only aggregation contract over existing task_queue, agent_runs, artifacts, review-context, and handoff rows. It introduces no table and does not resume model conversation state.
3. **Fork from snapshot**: implemented in v1.x Phase 3 for repository file state only. It prefers reconstruction over retaining old worktrees forever: selected run base commit or snapshot base ref + selected persisted diff artifact -> fresh git worktree -> `SandboxProvider.applyDiff`. This reuses the reviewer flow's patch application semantics and keeps disk use bounded. It requires diff artifacts to remain durable and base commits not to be garbage-collected before snapshot expiry.
4. **Coordinator agent**: first version generates flat fan-out WorkOrders that can be submitted to `agentflow batch`. It must not introduce dependency edges, conditional graph execution, or a general DAG without a new ADR.
5. **SessionStore**: only after the SQLite-backed snapshot contract has proven useful should storage move behind Redis/KV or another external runtime store.

## Consequences (positive)

- Multi-LLM behaviour becomes real: Implementer and Reviewer can be different vendors, different models, different cost profiles.
- The Scheduler's score breakdown is persisted, so post-hoc analysis can ask "why did we pick this agent?"
- Failed agents are systematically excluded for a given task; we don't loop on the same broken combination.
- Reviewer worktrees are independent of Implementer worktrees, so the reviewer is not seeded with the implementer's stdout, environment, or partial state. This makes the reviewer's verdict more independent.
- The TaskQueue lease model survives a worker crash: an expired lease is reclaimable on the next invocation.
- Per-task budget gates make runaway spend visible at the planning layer, not after a credit-card alert.

## Consequences (negative / accepted tradeoffs)

- Reviewer worktree means `git apply` may fail for diffs the implementer already had to fight (rebase conflicts, generated files, etc.). v1 folds `diff_apply_failed` into `changes_requested`. v2 may need `git apply --reject` plus structured per-hunk results.
- BudgetManager only does bookkeeping. There is no live per-vendor quota probe; if a vendor's API quota changes mid-batch, v1 cannot know until calls start failing. The tradeoff is implementation simplicity; v2 can add Adapter-specific probes.
- The Scheduler weights (`capability_match=0.40, cost_efficiency=0.20, quota_health=0.20, reliability=0.10, latency_score=0.10`) are constants. Tuning per project is a v2 concern. v1 pins them in unit tests so the behaviour is reproducible.
- The Reviewer never re-reviews the same diff. If `changes_requested` happens, the next attempt is always a fresh Implementer. This means a single bad reviewer can block a task and burn budget. We mitigate by allowing the WorkOrder to set `review.enabled: false` to opt out entirely, and by counting reviewer runs against `budget.max_runs`.
- Worker pool is in-process. A single Node process owns all parallelism. This is fine for local CLI use but caps practical parallelism well below team-server territory. v2's HTTP API + multi-process workers solve this.
- Hot-reload of AgentRegistry is not supported. A new agent is only picked up on the next CLI invocation. This is acceptable because v1 is a CLI, not a daemon.

## Alternatives Considered

### A. Add Context Broker before Reviewer Agent

Rationale: the architecture lists Context Broker as a foundational service. Without it, v1's brief is "the whole WorkOrder + the whole diff", which can blow context windows on big diffs.

Rejected because:

- v0 already passes briefs successfully for small, real diffs. v1's smoke tests use small diffs.
- A real Context Broker requires a meaningful corpus of artifacts to summarize; v1 has at most a diff and a verdict.
- Reviewer Agent value is testable today with naive context. Context Broker value is not testable without Reviewer (or another consumer).
- Postponing Context Broker to v2 lets it be designed against a real consumer's needs, instead of guessed.

### B. Add Acceptance Verifier instead of Reviewer Agent

Acceptance Verifier is per-criterion structured pass/unknown/fail; Reviewer Agent is open-ended natural-language critique. Both are listed in the architecture verifier table.

Rejected for v1 because:

- Reviewer Agent is a less constrained, more general second-opinion mechanism. It surfaces problems the WorkOrder author didn't think to write as criteria.
- Acceptance Verifier requires per-criterion evidence collection, which couples to artifact format conventions the project has not yet stabilized.
- Reviewer Agent's verdict is a single JSON file in `.agent-workflow/`, which slots cleanly into the existing capsule contract.

Acceptance Verifier is a good v2 addition — it can run **after** Reviewer Agent passes, providing a deterministic-ish gate on top of the LLM gate.

### C. Multi-process / queue-server architecture

Rejected because v1 targets local CLI use. Adding Redis / NATS / Postgres turns v1 into v3 work. The TaskQueue's lease model is forward-compatible: the same SQL pattern works in Postgres, and the queue contract is interchangeable with a real broker.

### D. Bidding mode (Agents self-report cost estimates)

Rejected because:

- v1 has no live quota probe to cross-check bids.
- Section 5.3 of the architecture warns "竞标模式不能完全相信 Agent 自报", and v1 has no `bid_trust_score` to enforce this.
- Score-based static selection is more deterministic and easier to test.

Bidding is a good v2/v3 addition once `agent_metrics` has accumulated real estimate-vs-actual data per agent.

### E. DAG with conditional edges across WorkOrders

Rejected because no real workflow yet exists with proven multi-WorkOrder dependencies. v1 keeps each WorkOrder independent. `agentflow batch` runs them in parallel, but does not honor cross-WorkOrder dependencies. v2's Planner introduces the DAG, driven by a real user-facing goal that needs it.

Clarification after the four-layer review: a future Coordinator agent may still emit a **flat fan-out** list of independent WorkOrders without reopening this decision. That uses the existing `agentflow batch` semantics. A true DAG means dependency edges, readiness checks, aggregate node semantics, or conditional branches; that requires a new ADR.

## Why This Is the Right Slice

A vertical slice should answer one question that cannot be answered without building it. v1 answers:

> When two LLMs collaborate on one task — one writing, one critiquing — does the system stay coherent, observable, and bounded?

To answer that, we need exactly:

- More than one Agent in the registry (otherwise no real choice).
- A Scheduler (otherwise the choice is a hard-coded `agent_id`).
- A Reviewer flow (otherwise the second LLM has no role).
- Concurrency (otherwise the parallel-tasks failure modes never surface).
- Handoff (otherwise failure cases collapse silently).
- Budget enforcement (otherwise a runaway loop is harmless to test until it isn't).

Anything less and the answer is hypothetical. Anything more and v1 ships features the answer doesn't depend on.

## Forward Compatibility

v1's contracts are designed to compose with v2 components without rewrite:

- `ScheduleDecision` includes a full candidate score breakdown; v2's bidding can append a `bid` field per candidate.
- `HandoffPacket` has `remaining_work` as a free-text field; v2's Planner can populate it with a structured plan.
- `ReviewVerdict` has `comments[]` with `severity`; v2's Acceptance Verifier can consume `must_fix` items as criterion checks.
- `task_queue` is a single-table queue; v2 can wrap it with a Postgres equivalent or a real broker behind the same interface.
- `agent_metrics` already records `actual_cost_units`; v2's bidding mode plugs in directly.

## Migration Path from v0

- v0 WorkOrders (`schema_version: workflow/v0`) keep running on the v0 code path unchanged.
- v0 AgentProfiles keep running on the v0 path unchanged.
- A v0 -> v1 upgrader exists (`upgradeWorkOrderV0ToV1`) but is opt-in via a future `--upgrade` flag, not automatic.
- v1 SQLite migrations only **add** columns and tables; they do not modify v0 columns. The same database can host v0 and v1 runs side by side.

## Migration Path to v2

When v1 is in steady use, v2 should pick the next-most-pressured block. Likely candidates, in rough order of expected pressure:

1. **SandboxProvider seam** immediately after the v1 gate is green. This is implemented in v1.x Phase 1 with the behavior-preserving git worktree adapter.
2. **Expand beyond file-state-only snapshot reconstruction** only if repeated related runs need model conversation resume or richer session semantics. v1.x Phase 3 already reconstructs repository file state in a fresh worktree from snapshot base evidence plus a selected diff artifact.
3. **Flat fan-out Coordinator agent** when users keep manually writing several independent WorkOrders from one high-level goal.
4. **Context Broker** if `budget.max_total_cost_units` is consistently exceeded by overlong briefs.
5. **Acceptance Verifier** if reviewer verdicts are frequently overturned by humans (i.e. reviewers approve things humans reject).
6. **Anomaly Detector + Secret Scanner** when v1 is deployed to a real codebase with secrets and CI hooks.
7. **HTTP API + multi-process workers** when local-CLI parallelism is not enough.
8. **DAG Planner** only after flat fan-out has proven insufficient and a new ADR defines dependency semantics.

The decision of which to do first should be made when v1 has run on real workloads for at least a few weeks; not now.
