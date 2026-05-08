# Event Registry (v1)

This file is the human-readable v1 event registry. The codebase should mirror the union of v0 and v1 events as `events.ts` constants. v0 events keep their original semantics; v1 only adds new types and refines the meaning of `run.*` and `task.*` so that task-level lifecycle is no longer collapsed into the single run.

## Naming Rules (cumulative)

- `task.*` describes the user goal and DAG node — created once per WorkOrder.
- `run.*` describes one Agent execution attempt — many runs per task in v1.
- `artifact.*` describes saved files or generated outputs.
- `verification.*` describes deterministic validation.
- `review.*` describes LLM Reviewer activity (NEW in v1).
- `handoff.*` describes requeue / cross-run transfer (NEW in v1).
- `agent.*` describes Agent process/profile lifecycle.
- `quota.*` describes per-agent quota state changes (NEW in v1).
- `capability.*`, `broker.*`, `prompt.*`, `security.*` reserved for v2+.

## v0 Events (still required)

Unchanged from `event-registry.md`. Listed here for context only:

| Event Type | Required IDs | Purpose |
|---|---|---|
| `task.created` | `task_id` | WorkOrder accepted and stored. |
| `run.created` | `task_id`, `run_id`, `agent_id` | Run row created before execution. |
| `run.started` | `task_id`, `run_id`, `agent_id` | Official CLI process launched. |
| `run.completed` | `task_id`, `run_id`, `agent_id` | Run completed successfully (process). |
| `run.failed` | `task_id`, `run_id`, `agent_id` | Process or orchestration failed. |
| `run.cleaned_up` | `task_id`, `run_id` | Worktree cleanup done. |
| `artifact.published` | `task_id`, `run_id` | Artifact saved. |
| `verification.started` | `task_id`, `run_id` | Verification began. |
| `verification.passed` | `task_id`, `run_id` | Verification succeeded. |
| `verification.failed` | `task_id`, `run_id` | Verification failed. |

Semantic refinement in v1:

- `run.completed` is **process perspective only**. It does not imply the task is done. A successful implementer run with a reviewer queued behind it still emits `run.completed` for the implementer; the task remains in `reviewing` state.
- `task.created` fires once per WorkOrder, not once per run.

## New v1 Events

| Event Type | Required IDs | Purpose |
|---|---|---|
| `task.enqueued` | `task_id` | Task placed into `task_queue`, status `queued`. |
| `task.dispatched` | `task_id` | Scheduler made a decision (pick or refuse). Payload: `ScheduleDecision`. |
| `task.assigned` | `task_id`, `run_id`, `agent_id` | Run row created with the chosen agent; lease acquired. |
| `task.requeued` | `task_id` | Task returned to `queued` after a failed run or `changes_requested`. |
| `task.completed` | `task_id` | Task reached terminal `accepted`. |
| `task.failed` | `task_id` | Task reached terminal `failed` (budget exhausted or unrecoverable). |
| `task.awaiting_human` | `task_id` | Task suspended; reviewer rejected or refusal_reason needs human. |
| `review.requested` | `task_id`, `run_id` | Reviewer run started. `run_id` is the **reviewer** run id. |
| `review.completed` | `task_id`, `run_id` | Reviewer wrote a verdict. Payload requires `verdict` and `verdict_uri`; `summary` and `comments_count` are recommended. |
| `handoff.requested` | `task_id`, `run_id` | HandoffPacket built; `run_id` is the **failed/requested-changes** run. |
| `agent.spawned` | `task_id`, `run_id`, `agent_id` | OS process spawned. Distinct from `run.started`: `spawned` happens once OS confirms a pid; `run.started` happens just before in orchestrator code. (v0 collapses these; v1 may emit both, see Implementation Note.) |
| `quota.low` | none | An agent's quota crossed soft limit. Payload: `agent_id`, `axis`, `ratio`. |
| `quota.exhausted` | none | An agent's quota crossed hard limit. Same payload. |
| `task.edge_selected` | `task_id` | Conditional transition recorded (e.g. `verifying -> reviewing` vs `verifying -> requeued`). |

## Reserved (NOT implemented in v1)

These names are reserved so v1 does not accidentally use them:

| Event Type | Why reserved |
|---|---|
| `task.replan_requested` | Requires Planner. v2+. |
| `task.dependency_invalidated` | Requires multi-task DAG. v2+. |
| `task.human_decided` | Requires human-in-the-loop UI. v2+. |
| `run.cancel_requested` | User-initiated cancellation. v2+. |
| `run.heartbeat` | Requires long-running session model. v2+. |
| `agent.anomaly_detected` | Requires anomaly detector. v2+. |
| `capability.downgraded` | Requires capability probe. v2+. |
| `broker.degraded` | Requires Context Broker. v2+. |
| `prompt.rollback_triggered` | Requires prompt versioning. v2+. |
| `security.artifact_flagged` | Requires Artifact Instruction Scanner. v2+. |
| `security.secret_leaked` | Requires Secret Scanner. v2+. |
| `security.agent_quarantined` | Requires anomaly response. v2+. |

EventLog must reject any reserved name in v1 with a clear error: `event type '<name>' is reserved for v2+`.

## Required Event Sequences

### Successful task with one implementer + one reviewer (happy path)

```text
task.created
task.enqueued
task.dispatched           // role=implementer, picked_agent_id=<I>
task.assigned             // run_id=R-1
run.created
run.started
agent.spawned             // optional, see Implementation Note
artifact.published        // stdout tail
artifact.published        // stderr tail
artifact.published        // diff
artifact.published        // final report (if any)
artifact.published        // task capsule
verification.started
verification.passed
artifact.published        // verification output
run.completed             // R-1 process succeeded
task.edge_selected        // verifying -> reviewing
task.dispatched           // role=reviewer, picked_agent_id=<R> (R != I)
task.assigned             // run_id=R-2
run.created
run.started
agent.spawned
review.requested
artifact.published        // diff applied marker (informational)
artifact.published        // review brief artifact (optional)
run.completed             // R-2 process succeeded
artifact.published        // review_verdict artifact
review.completed          // verdict=approved
task.edge_selected        // reviewing -> accepted
task.completed
run.cleaned_up            // R-1 (deferred until task terminal)
run.cleaned_up            // R-2
```

### Verification fails, requeue, second implementer succeeds, reviewer approves

```text
task.created
task.enqueued
task.dispatched           // role=implementer, picked=<I1>
task.assigned             // R-1
run.created -> run.started -> ... -> verification.failed -> run.failed
handoff.requested         // run_id=R-1, reason=verification_failed
task.requeued
task.dispatched           // role=implementer, picked=<I2>, exclude_agent_ids includes <I1>
task.assigned             // R-2
... (full implementer happy path) ...
verification.passed -> run.completed
task.edge_selected        // verifying -> reviewing
task.dispatched           // role=reviewer, picked=<R1>
task.assigned             // R-3
... (reviewer happy path) ...
review.completed          // verdict=approved
task.completed
```

### Reviewer requests changes, requeue

```text
... (R-1 implementer succeeds, verification passes) ...
task.dispatched (reviewer) -> task.assigned -> ... -> review.completed (changes_requested)
task.edge_selected        // reviewing -> requeued
handoff.requested         // run_id=R-2 (the reviewer run); reason=review_changes_requested
task.requeued
task.dispatched           // role=implementer, exclude_agent_ids includes <I1>
... (continues until accepted, or budget exhausted -> task.failed)
```

### Reviewer rejects (terminal, no auto-requeue)

```text
... -> review.completed (verdict=rejected)
task.edge_selected        // reviewing -> awaiting_human
task.awaiting_human
```

### Budget exhausted

```text
... task.requeued ...
task.dispatched           // refusal_reason=task_budget_exhausted, picked_agent_id=null
task.edge_selected        // queued -> failed
task.failed
```

### Scheduler refuses on first dispatch

```text
task.created
task.enqueued
task.dispatched           // refusal_reason=no_agent_matches_capability, picked_agent_id=null
task.edge_selected        // queued -> failed
task.failed
```

## Payload Examples

### `task.dispatched` (pick)

```json
{
  "decision_id": "D-7f2e",
  "role": "implementer",
  "picked_agent_id": "claude-code-implementer",
  "candidate_scores": [
    {
      "agent_id": "claude-code-implementer",
      "score": 0.78,
      "breakdown": {
        "capability_match": 1.0,
        "cost_efficiency": 0.6,
        "quota_health": 0.9,
        "reliability": 0.92,
        "latency_score": 0.5
      }
    },
    {
      "agent_id": "codex-implementer",
      "score": 0.71,
      "breakdown": {
        "capability_match": 1.0,
        "cost_efficiency": 0.7,
        "quota_health": 0.5,
        "reliability": 0.88,
        "latency_score": 0.6
      }
    }
  ],
  "decided_at": "2026-05-06T10:00:00+08:00"
}
```

### `task.dispatched` (refuse)

```json
{
  "decision_id": "D-7f31",
  "role": "implementer",
  "picked_agent_id": null,
  "refusal_reason": "task_budget_exhausted",
  "candidate_scores": [],
  "decided_at": "2026-05-06T10:42:11+08:00"
}
```

### `review.completed`

```json
{
  "verdict": "changes_requested",
  "verdict_uri": "artifact://T-203/R-203-0002/review_verdict.json",
  "summary": "Logic looks correct but the new branch swallows the original error path.",
  "comments_count": 3
}
```

### `handoff.requested`

```json
{
  "reason": "review_changes_requested",
  "handoff_packet_uri": "artifact://T-203/R-203-0002/handoff_packet.json",
  "exclude_agent_ids_added": ["claude-code-implementer"]
}
```

### `quota.low`

```json
{
  "agent_id": "codex-implementer",
  "axis": "calls",
  "ratio": 0.86,
  "soft_limit_ratio": 0.85
}
```

### `task.edge_selected`

```json
{
  "from": "reviewing",
  "to": "requeued",
  "reason": "review_changes_requested"
}
```

## `run.failed` payload.reason Taxonomy

`run.failed` events must carry `payload.reason` from a closed set; EventLog rejects any other value. Source of truth and effects on AgentRegistry are in `v1-module-breakdown.md` §11.1. The set:

```
"spawn_failed" | "agent_nonzero_exit" | "agent_timed_out"
| "provider_quota_exhausted" | "provider_rate_limited" | "provider_auth_failed"
| "verification_failed" | "diff_apply_failed"
| "lease_expired" | "internal_error"
```

The three `provider_*` reasons are the v1 mechanism for surfacing vendor-side quota/rate/auth failures **without** any live quota probe: the OfficialCliAdapter classifies the failure based on a small per-AgentProfile regex set against stderr; AgentRegistry then marks the agent's `quota_health` accordingly and emits `quota.low` (scope=`agent`) or `quota.exhausted` (scope=`agent`) so the Scheduler refuses further dispatches to that agent within the same CLI invocation.

## Replay Rule (unchanged from v0)

Side-effecting events still set `skip_on_replay: true`. v1 does not implement a replay engine, but the field must be set correctly so v2+ can rely on it.

The following v1 events are side-effects and must set `skip_on_replay: true`:

- `agent.spawned`
- `run.cleaned_up`
- `quota.low`, `quota.exhausted` (because they trigger Scheduler refusal logic; replay must use the persisted state, not re-derive)

The following v1 events are pure observations and `skip_on_replay: false` (or unset, default false):

- `task.created`, `task.enqueued`, `task.dispatched`, `task.assigned`, `task.requeued`, `task.completed`, `task.failed`, `task.awaiting_human`, `task.edge_selected`
- `run.created`, `run.started`, `run.completed`, `run.failed`
- `review.requested`, `review.completed`
- `handoff.requested`
- `artifact.published`, `verification.started`, `verification.passed`, `verification.failed`

## Implementation Note: `run.started` vs `agent.spawned`

v0 emitted only `run.started`. v1 keeps `run.started` as the orchestrator-side run-start marker and adds `agent.spawned` as the agent-launch marker. The current `OfficialCliAdapter` does not expose a child pid through its public result, so `orchestrator-v1` emits `agent.spawned` with `pid: 0` and `credential_profile_alias: "unknown"`.

- `run.started` is fired after the run row has workspace/base/branch/manifest metadata.
- `agent.spawned` is fired immediately before invoking the adapter and uses `pid: 0` until the adapter API grows pid reporting.

If adapter invocation fails before returning an `AgentProcessResult`, the run emits `run.failed` with `reason: "spawn_failed"`.

This split makes credential isolation auditable per §2.1.3.1: every actually-spawned process has a corresponding `agent.spawned` row.
