# Second Vertical Slice (v1)

## Purpose

v0 proved that one official CLI agent can be supervised, isolated in a git worktree, and verified end to end. v1 implements the second narrow path without pulling in the full architecture. It proves whether the core multi-LLM assumptions survive contact with real agents and real workloads:

- Can the Scheduler pick an agent dynamically based on declared capability and cost, instead of being told `agent_id` directly in the WorkOrder?
- Can a second LLM (Reviewer Agent) read the first agent's diff and return a structured verdict that meaningfully gates acceptance?
- Can the orchestrator run several agent processes concurrently without corrupting each other's worktrees, runs, or events?
- Can a task be requeued with a handoff packet when the first attempt fails or the reviewer rejects the diff, and have a different agent finish it?

Everything above is "multi-LLM" in the most basic sense: more than one model participates, and the system — not the human — decides who, when, and what to hand them.

## Scope

v1 implements this path:

```text
agentflow run work_order.json --agents agents/
  -> validate WorkOrder (workflow/v1)
  -> load AgentRegistry from agents/
  -> enqueue task into TaskQueue
  -> Scheduler picks an Implementer agent by score
  -> create run (implementer) in its own worktree
  -> launch Implementer agent (reuses v0 OfficialCliAdapter)
  -> collect diff + stdout/stderr + final report
  -> run deterministic verification (reuses v0 VerificationRunner)
  -> if verification passes:
       Scheduler picks a Reviewer agent (must differ from Implementer)
       create run (reviewer) in a fresh worktree applying the diff
       launch Reviewer agent with review brief
       parse .agent-workflow/review_verdict.json
       if approved -> task accepted
       if changes_requested -> handoff + requeue
       if rejected -> awaiting_human
  -> if verification fails OR review changes_requested:
       build HandoffPacket
       requeue task into TaskQueue (excluding failed agent)
       Scheduler picks fallback Implementer
       repeat until max_runs reached or task budget exhausted
  -> persist events, runs, artifacts, agent_metrics, and review verdict artifacts
  -> a single Worker pool runs N implementer/reviewer runs in parallel,
     each in its own worktree
```

## Explicitly Out of Scope

These belong to v2 or later. v1 must not introduce them, even partially:

- Context Broker (per-task minimal-context selection, summarization, redaction).
- Acceptance Verifier (LLM-based per-criterion acceptance evidence).
- Adversarial Reviewer / Eval Suite.
- Agent Anomaly Detector.
- Artifact Instruction Scanner.
- Secret Leak Scanner.
- Dashboard / HTTP API.
- Long-running interactive sessions or session resume.
- Historical v1 excluded SessionSnapshot, SessionStore, and forkable session state. v1.x Phase 2 later added only a read-only `SessionSnapshot` aggregation seam, and v1.x Phase 3 later added file-state-only worktree reconstruction from snapshot base evidence plus a selected diff artifact. Model conversation resume, `SessionStore`, Redis/KV, and external memory remain out of scope.
- Docker sandboxes, micro-VM sandboxes, or any second sandbox adapter. The `SandboxProvider` seam itself is a post-v1 v1.x addition, not part of the historical v1 slice.
- MCP tools, official_extension mode, managed_proxy mode.
- DAG with dependency edges across user-level tasks. v1 batch runs independent user-supplied WorkOrders only.
- Conditional edges across multiple WorkOrders.
- Planner / Coordinator agent that creates WorkOrders.
- Multi-project sharding (one `project_id` per CLI invocation; v1 does not assume a long-lived project router).
- Distributed scheduler / multiple orchestrator processes (single-process worker pool only).
- Bidding mode (Agent self-reported cost estimates).
- Replay / event sourcing reconstruction (Event Log is still append-only, but no replay engine).
- Automatic prompt rollback or capability downgrade detection.
- User-initiated cancellation of a specific run or task beyond process SIGINT. SIGINT graceful interruption is implemented for v1 run/batch.
- Resource-aware scheduling (CPU/memory/disk fit).
- Locality / privacy scoring.

These are valuable. They should be pulled in by real pressure from v1, not prebuilt as empty framework.

## Relationship to Four-Layer Decoupling

The four-layer direction is useful, but v1 deliberately proves a narrower kernel:

- Historical v1 L1 alignment was represented by one-shot official CLI runs inside isolated git worktrees. v1.x Phase 1 now hides that behavior behind a behavior-preserving `SandboxProvider`, but worktree isolation is still not a true sandbox.
- L2 alignment is limited to Scheduler + Reviewer collaboration. The Scheduler chooses an agent; it does not plan or decompose user goals.
- L3/L4 are not in scope for historical v1. v1.x Phase 2 exposes artifacts, handoff packets, queue rows, and run rows through a read-only `SessionSnapshot`; v1.x Phase 3 can reconstruct repository file state in a fresh worktree from that snapshot's base evidence plus one diff artifact. They remain audit/recovery evidence rather than resumable model sessions or external memory.

The first credible step after v1 was `SandboxProvider`, now implemented in v1.x Phase 1. The second was read-only `SessionSnapshot`, implemented in v1.x Phase 2. The third was file-state-only fork-from-snapshot worktree reconstruction, implemented in v1.x Phase 3. The next steps remain Planner / Coordinator, session resume, Redis/KV or external memory, and external SessionStore work. Do not skip ahead without a separate post-v1 prompt.

Post-v1 gates and constraints:

- `SandboxProvider` starts only after this slice has fake-agent approve, changes_requested/requeue, and parallel batch e2e coverage; that gate has been used for v1.x Phase 1.
- `SessionSnapshot` is a read model over existing queue/run/artifact/review-context/handoff data; v1.x Phase 3 fork behavior reconstructs a worktree from snapshot base evidence plus a selected diff artifact, not from an indefinitely retained worktree.
- Planner / Coordinator first emits flat fan-out WorkOrders. Dependency edges, conditional branches, and aggregate DAG semantics are outside v1 and require a later ADR.

## Two-Agent Reviewer Flow

This is the heart of the v1 slice. The simplest meaningful "multi-LLM" pattern is one model implements, another model reviews. v1 makes this real:

```text
Implementer Run (R-1)
  agent_id  = picked by Scheduler from "implementer" pool
  worktree  = agent/<task>/R-1
  output    = diff + stdout/stderr + final_report.md

Verification (deterministic, same as v0)
  pass -> Review Run is created
  fail -> Handoff (no Reviewer needed)

Reviewer Run (R-2)
  agent_id  = picked by Scheduler from "reviewer" pool, must != R-1.agent_id
  worktree  = agent/<task>/R-2 (fresh worktree, R-1's diff applied as a single patch)
  brief     = work_order.md + R-1's diff + R-1's final_report + acceptance_criteria
  output    = .agent-workflow/review_verdict.json
              {
                "schema_version": "agent-workflow/1",
                "verdict": "approved" | "changes_requested" | "rejected",
                "summary": "<short>",
                "comments": [
                  { "path": "src/foo.ts", "line": 12, "severity": "must_fix" | "should_fix" | "nit", "comment": "..." }
                ]
              }
```

Outcome rules:

- `approved` -> task `accepted`.
- `changes_requested` -> Handoff requeue (R-2's verdict becomes part of next implementer's brief).
- `rejected` -> task `awaiting_human` (do not auto-requeue; reviewer thinks the goal itself is wrong).
- Reviewer process exit code non-zero, missing verdict file, malformed verdict JSON, or other unusable reviewer output -> review run is `failed` and the task fails with reviewer/provider failure context. Only an explicit `changes_requested` verdict and the `diff_apply_failed` path requeue automatically.

Re-review rule (hard):

- A given `ReviewVerdict` applies to **exactly one diff** — the diff that was applied into the reviewer's worktree. It is **never** reused as the acceptance signal for any subsequent diff.
- After `changes_requested`, the next implementer produces a new diff. The new diff must go through a fresh reviewer run (Scheduler picks again from `reviewer_pool`); the prior verdict is included in the new implementer's HandoffPacket as **context only**, not as an acceptance signal.
- The orchestrator must never short-circuit reviewer dispatch by reading a stale `review_verdict` artifact from a previous run. Each task acceptance requires a `review.completed` event whose `run_id` matches a reviewer run launched **after** the diff under review was produced.

## Concurrency Model

Single orchestrator process. Internally, an in-process Worker pool with `--workers N` (default 2). Each Worker:

1. Polls `task_queue` for an entry whose lease is free (`current_owner_run_id` is null or expired).
2. Atomically acquires the lease with a conditional `UPDATE` (SQLite transaction).
3. Runs one full attempt: Scheduler pick, prepare worktree, launch agent, verification, possibly Reviewer.
4. Releases the lease, writes outcome, requeues if needed.

A single WorkOrder produces a sequence of attempts (R-1 implementer, R-2 reviewer, possibly R-3 fallback implementer, R-4 second reviewer, ...). v1 does **not** allow two implementer attempts on the same task to run in parallel — they would race on diff semantics. But two **different** WorkOrders submitted in the same `agentflow batch` invocation can run in parallel.

v1 keeps `agentflow run <one work_order>` (sequential within a single task) and adds:

```text
agentflow batch <work_orders_dir> --agents <agents_dir> --workers 4
```

`agentflow run` still works for one WorkOrder; `agentflow batch` is the parallel mode.

## First Agents

Two AgentProfiles are required, both `integration_mode: official_cli`:

```text
agents/
  claude-code-implementer.yaml
  claude-code-reviewer.yaml
```

The two profiles can wrap the same binary (e.g. `claude -p`) but with different prompts and `capabilities.roles: ["implementer"]` vs `capabilities.roles: ["reviewer"]`. This is enough to prove the two-agent flow without depending on two paid vendors.

A v1 smoke test should also work with two **fake** node executables to keep CI offline.

## WorkOrder Example (workflow/v1)

```json
{
  "schema_version": "workflow/v1",
  "task_id": "T-demo-001",
  "title": "Make the failing unit test pass",
  "type": "code_change",
  "goal": "Make the failing unit test pass with the smallest safe code change.",
  "acceptance_criteria": [
    "The configured verification command exits with code 0.",
    "The final report explains which files changed."
  ],
  "repo": {
    "path": "C:/path/to/repo",
    "base_ref": "main"
  },
  "constraints": {
    "allowed_paths": ["src/**", "tests/**"],
    "forbidden_paths": [".env", ".git/**"],
    "max_files_to_touch": 5
  },
  "verification": {
    "commands": ["npm test"]
  },
  "agent": {
    "required_capabilities": ["code_change"],
    "implementer_pool": ["claude-code-implementer", "codex-implementer"],
    "reviewer_pool":    ["claude-code-reviewer",    "codex-reviewer"],
    "exclude_agent_ids": []
  },
  "review": {
    "enabled": true,
    "max_review_runs": 1
  },
  "budget": {
    "max_wall_time_minutes": 30,
    "max_total_cost_units": 2.0,
    "max_runs": 4
  }
}
```

Notes:

- `agent.agent_id` from v0 is gone. Scheduler picks from the configured pool; with `review.enabled: false` and one eligible implementer, the path is closest to v0.
- `review.enabled: false` skips the Reviewer step entirely (useful for tasks where the verification command is the full acceptance check).
- `budget.max_runs` is the hard ceiling for total runs (implementer + reviewer combined) for one task.

## Current Status

The second slice is implemented with the following traceable capabilities:

- A v1 WorkOrder can start a task even without a hard-coded `agent_id`.
- AgentRegistry can load `>=2` AgentProfiles and report each one's capabilities and current quota_health.
- Scheduler picks an Implementer agent and writes a `task.dispatched` event with the score breakdown.
- A successful implementer run that passes deterministic verification triggers a Reviewer run with the diff applied to a fresh worktree.
- Reviewer Agent writes `.agent-workflow/review_verdict.json`; the orchestrator parses it, persists `review.completed`, and either accepts the task or requeues it.
- A failed implementer run produces a HandoffPacket and the next Scheduler pick excludes the failed agent.
- Two independent WorkOrders submitted via `agentflow batch` run in parallel without corrupting each other's worktrees, SQLite rows, or artifact directories.
- Per-task budget (`max_runs`, `max_wall_time_minutes`, `max_total_cost_units`) is enforced; the task ends in `failed` or `awaiting_human` when exceeded, never silently spins.
- A run that times out on the OS layer is recorded as `run.failed { reason: "agent_timed_out" }` and the task is requeued (subject to budget) with `exclude_agent_ids` updated.
- All v0 events still fire correctly; new v1 events are validated at the EventLog boundary.
- A failed run still leaves enough snapshot data for manual debugging — same v0 invariant.
- Smoke test with two fake agents (one implementer, one reviewer) produces an `accepted` task end-to-end.
- Fake-agent `changes_requested` coverage produces a requeue, a second implementer run, a fresh reviewer run, and acceptance.
- Fake-agent `diff_apply_failed` coverage proves the reviewer agent is not launched, git apply artifacts are persisted, the implementer is excluded, and a fresh later reviewer can approve.
- Fake-agent `rejected` coverage moves the task to `awaiting_human` without requeue.
- SIGINT coverage for v1 run and batch exits 130, finalizes started run rows as `cancelled`, and leaves unfinished tasks non-terminal.
- Terminal cleanup removes accepted/failed task worktrees; tests cover accepted CLI cleanup and accepted/failed cleanup candidates. `awaiting_human` worktrees are intentionally retained.

## Historical Build Order

1. Schema bump: introduce `workflow/v1` for WorkOrder and AgentProfile alongside `workflow/v0`. v0 schemas keep working until the v1 path is stable.
2. AgentRegistry: filesystem loader, capability index, quota cache.
3. TaskQueue: SQLite-backed queue with row-level lease.
4. Scheduler: scoring function + dispatch decision recorder.
5. Run lifecycle: split `task` lifecycle from `run` lifecycle in code (storage already supports it).
6. HandoffManager: HandoffPacket builder + requeue path.
7. ReviewerAgentAdapter: same as OfficialCliAdapter but with a different brief template and verdict parser.
8. WorkerPool: in-process workers polling the queue.
9. BudgetManager: per-task budget tracker; AgentRegistry handles per-agent quota health from provider failure classification.
10. CLI: add `agentflow batch`; keep `agentflow run` working with both v0 and v1 WorkOrders.
11. End-to-end fixture: two fake agents, two scenarios (always-approve, always-request-changes), assert event sequence and final task status.
