# AgentFlow 中文配置与使用指南

这份文档说明如何在本地配置并运行 `agentflow`。当前项目已经支持两条本地 CLI 流程：

- `workflow/v0`：单个 Agent 一次性执行一个 WorkOrder。
- `workflow/v1`：队列化 WorkerPool，支持调度、review、handoff/requeue、batch、SIGINT 中断和 accepted/failed worktree cleanup。

## 1. 环境要求

建议环境：

- Node.js 22 或兼容版本。
- pnpm。
- Git，并且目标仓库本身必须是一个 git repository。
- 至少一个可被命令行启动的 Agent 工具，例如 `codex`、`claude`、自定义脚本或测试用 fake agent。

检查命令：

```powershell
node --version
pnpm --version
git --version
```

如果要调用真实 CLI Agent，也检查对应命令：

```powershell
codex --version
claude --version
```

## 2. 安装与构建

在项目根目录执行：

```powershell
pnpm install
pnpm build
pnpm test
```

当前 release-candidate 验证快照为：

```text
pnpm build: pass
pnpm test: pass, 30 test files / 660 tests
```

开发态运行可以用：

```powershell
pnpm dev -- run path\to\work_order.json --agent path\to\agent.json
```

构建后运行可以用：

```powershell
node dist\cli\index.js run path\to\work_order.json --agent path\to\agent.json
```

如果你希望直接使用 `agentflow` 命令，可以在构建后按自己的包管理习惯做本地 link；最稳妥的方式仍然是直接调用 `node dist\cli\index.js`。

## 3. 核心概念

### WorkOrder

WorkOrder 是任务说明文件。它告诉系统：

- 要处理哪个仓库。
- 目标是什么。
- 验收标准是什么。
- 允许哪些 Agent 参与。
- 要执行哪些验证命令。
- 是否需要 reviewer。
- 预算上限是多少。

### AgentProfile

AgentProfile 是 Agent 配置文件。它告诉系统：

- Agent 的 ID。
- 如何启动这个 Agent。
- Agent 能做 implementer 还是 reviewer。
- Agent 具备哪些 capability。
- stdout/stderr/timeout 限制。
- provider rate limit、quota、auth 失败时如何从 stderr 分类。

### 工作目录与产物

每次运行会创建独立 git worktree，并在 worktree 内写入：

```text
.agent-workflow/
  work_order.md
  prompt.md
  run_manifest.json
  constraints.json
  final_report.md
```

reviewer 运行时还会看到：

```text
.agent-workflow/
  review_brief.md
  reviewer_prompt.md
  diff_under_review.patch
  review_verdict.json
```

运行结果会写入目标仓库下的 `.agentflow/`：

```text
.agentflow/
  agentflow.sqlite
  artifacts/
```

## 4. 配置 v0 单 Agent 任务

v0 适合最简单的一次性任务：一个 WorkOrder 只交给一个 Agent。

### v0 WorkOrder 示例

保存为 `work_order_v0.json`：

```json
{
  "schema_version": "workflow/v0",
  "task_id": "T-v0-docs-001",
  "title": "Update README",
  "type": "docs_update",
  "goal": "Add a short usage note to the README.",
  "acceptance_criteria": [
    "README contains the new usage note.",
    "pnpm build passes."
  ],
  "repo": {
    "path": "G:\\Code\\target-repo",
    "base_ref": "main"
  },
  "verification": {
    "commands": [
      "pnpm build"
    ],
    "timeout_seconds": 120
  },
  "agent": {
    "agent_id": "codex-v0"
  },
  "budget": {
    "max_wall_time_minutes": 30,
    "max_output_bytes": 65536
  }
}
```

### v0 AgentProfile 示例

保存为 `agent_v0.json`：

```json
{
  "schema_version": "workflow/v0",
  "agent_id": "codex-v0",
  "integration_mode": "official_cli",
  "command": {
    "executable": "codex",
    "args": [
      "exec",
      "--sandbox",
      "danger-full-access",
      "{{prompt_file}}"
    ]
  },
  "capabilities": {
    "outer_supervised": true,
    "inner_tool_control": false
  },
  "limits": {
    "timeout_seconds": 1800,
    "max_stdout_bytes": 65536,
    "max_stderr_bytes": 65536
  }
}
```

`{{prompt_file}}` 会被系统替换成 `.agent-workflow/prompt.md` 的绝对路径。

### 运行 v0

```powershell
pnpm build
node dist\cli\index.js run .\work_order_v0.json --agent .\agent_v0.json
```

常见退出码：

```text
0  任务成功
1  任务执行失败
2  参数或输入文件错误
```

## 5. 配置 v1 单任务

v1 单任务通过队列和 WorkerPool 执行。它可以启用 reviewer，也可以关闭 reviewer。

### v1 WorkOrder 示例：不启用 review

保存为 `work_order_v1_no_review.json`：

```json
{
  "schema_version": "workflow/v1",
  "task_id": "T-v1-docs-001",
  "title": "Update README through v1",
  "type": "docs_update",
  "goal": "Add a short usage note to the README.",
  "acceptance_criteria": [
    "README contains the new usage note.",
    "pnpm build passes."
  ],
  "repo": {
    "path": "G:\\Code\\target-repo",
    "base_ref": "main"
  },
  "verification": {
    "commands": [
      "pnpm build"
    ],
    "timeout_seconds": 120
  },
  "agent": {
    "required_capabilities": ["docs_update"],
    "implementer_pool": ["codex-implementer"],
    "reviewer_pool": [],
    "exclude_agent_ids": []
  },
  "review": {
    "enabled": false,
    "max_review_runs": 0
  },
  "budget": {
    "max_wall_time_minutes": 30,
    "max_total_cost_units": 10,
    "max_runs": 2
  }
}
```

### v1 WorkOrder 示例：启用 review

保存为 `work_order_v1_review.json`：

```json
{
  "schema_version": "workflow/v1",
  "task_id": "T-v1-review-001",
  "title": "Implement and review a small change",
  "type": "code_change",
  "goal": "Make the requested code change and have it reviewed.",
  "acceptance_criteria": [
    "The requested behavior is implemented.",
    "The verification command passes.",
    "Reviewer verdict is approved."
  ],
  "repo": {
    "path": "G:\\Code\\target-repo",
    "base_ref": "main"
  },
  "verification": {
    "commands": [
      "pnpm test"
    ],
    "timeout_seconds": 300
  },
  "agent": {
    "required_capabilities": ["code_change"],
    "implementer_pool": ["codex-implementer"],
    "reviewer_pool": ["codex-reviewer"],
    "exclude_agent_ids": []
  },
  "review": {
    "enabled": true,
    "max_review_runs": 1
  },
  "budget": {
    "max_wall_time_minutes": 60,
    "max_total_cost_units": 20,
    "max_runs": 4
  }
}
```

注意：当 `review.enabled=true` 时，`budget.max_runs` 必须大于等于 `review.max_review_runs + 1`。

### v1 Implementer AgentProfile

保存为 `agents/codex-implementer.json`：

```json
{
  "schema_version": "workflow/v1",
  "agent_id": "codex-implementer",
  "integration_mode": "official_cli",
  "command": {
    "executable": "codex",
    "args": [
      "exec",
      "--sandbox",
      "danger-full-access",
      "{{prompt_file}}"
    ]
  },
  "capabilities": {
    "outer_supervised": true,
    "inner_tool_control": false,
    "kinds": ["code_change", "docs_update"],
    "roles": ["implementer"]
  },
  "cost_profile": {
    "billing_unit": "call",
    "estimated_cost_per_run_units": 1
  },
  "failure_classification": {
    "provider_rate_limited_stderr": ["rate limit", "too many requests"],
    "provider_quota_exhausted_stderr": ["quota exceeded", "insufficient quota"],
    "provider_auth_failed_stderr": ["unauthorized", "invalid api key", "authentication failed"]
  },
  "limits": {
    "timeout_seconds": 1800,
    "max_stdout_bytes": 65536,
    "max_stderr_bytes": 65536
  }
}
```

### v1 Reviewer AgentProfile

保存为 `agents/codex-reviewer.json`：

```json
{
  "schema_version": "workflow/v1",
  "agent_id": "codex-reviewer",
  "integration_mode": "official_cli",
  "command": {
    "executable": "codex",
    "args": [
      "exec",
      "--sandbox",
      "danger-full-access",
      "{{prompt_file}}"
    ]
  },
  "capabilities": {
    "outer_supervised": true,
    "inner_tool_control": false,
    "kinds": ["code_change", "docs_update"],
    "roles": ["reviewer"]
  },
  "cost_profile": {
    "billing_unit": "call",
    "estimated_cost_per_run_units": 1
  },
  "limits": {
    "timeout_seconds": 1800,
    "max_stdout_bytes": 65536,
    "max_stderr_bytes": 65536
  }
}
```

reviewer 必须写出：

```text
.agent-workflow/review_verdict.json
```

格式如下：

```json
{
  "schema_version": "agent-workflow/1",
  "verdict": "approved",
  "summary": "The change satisfies the acceptance criteria.",
  "comments": []
}
```

`verdict` 可选值：

```text
approved
changes_requested
rejected
```

## 6. 运行 v1 单任务

不启用 review：

```powershell
pnpm build
node dist\cli\index.js run .\work_order_v1_no_review.json --agents .\agents
```

启用 review：

```powershell
pnpm build
node dist\cli\index.js run .\work_order_v1_review.json --agents .\agents
```

常见退出码：

```text
0  task accepted
1  task failed
2  input validation or argument error
3  task awaiting_human
130  v1 run/batch was interrupted by SIGINT
```

## 7. 配置 v1 batch 批处理

目录结构示例：

```text
run-config/
  agents/
    codex-implementer.json
    codex-reviewer.json
  work-orders/
    T-001.json
    T-002.json
    T-003.yaml
```

`work-orders` 目录中支持：

```text
*.json
*.yaml
*.yml
```

每个 WorkOrder 必须是 `workflow/v1`，并且 `task_id` 不能重复。

运行：

```powershell
pnpm build
node dist\cli\index.js batch .\run-config\work-orders --agents .\run-config\agents --workers 2
```

指定数据库位置：

```powershell
node dist\cli\index.js batch .\run-config\work-orders --agents .\run-config\agents --workers 4 --database G:\Code\target-repo\.agentflow\agentflow.sqlite
```

说明：

- `--workers` 范围是 1 到 16。
- 默认 worker 数是 2。
- batch 只处理彼此独立的 WorkOrder；当前 v1 不支持 DAG 依赖图。

## 8. Agent 命令怎么写

`command.executable` 是要启动的命令。

`command.args` 是传给它的参数。

例如：

```json
{
  "command": {
    "executable": "codex",
    "args": [
      "exec",
      "--sandbox",
      "danger-full-access",
      "{{prompt_file}}"
    ]
  }
}
```

系统会：

1. 创建 worktree。
2. 写 `.agent-workflow/prompt.md`。
3. 把 `{{prompt_file}}` 替换为 prompt 文件绝对路径。
4. 在 worktree 下启动 Agent 进程。

如果你的 Agent CLI 需要从 stdin 读 prompt，目前建议写一个小 wrapper 脚本，把 `{{prompt_file}}` 读出来后再传给真实 CLI。

## 9. Agent 运行时必须遵守的输出约定

### Implementer

Implementer 应该：

- 阅读 `.agent-workflow/work_order.md`。
- 修改仓库文件。
- 不要提交 git commit。
- 写 `.agent-workflow/final_report.md`。
- 退出码为 0 表示 Agent 进程成功结束。

后续是否 accepted 还取决于：

- verification commands 是否通过。
- reviewer 是否 approved。

### Reviewer

Reviewer 应该：

- 阅读 `.agent-workflow/review_brief.md`。
- 查看 `.agent-workflow/diff_under_review.patch`。
- 不要修改仓库文件。
- 不要运行测试。
- 只写 `.agent-workflow/review_verdict.json`。

`changes_requested` 会触发 handoff/requeue。

`rejected` 会让任务进入 `awaiting_human`。

## 10. 结果在哪里看

默认数据库：

```text
<repo.path>\.agentflow\agentflow.sqlite
```

artifact 目录：

```text
<repo.path>\.agentflow\artifacts\
```

常见 artifact：

```text
diff.patch
stdout.txt / stderr.txt
verification.txt
final_report.md
review_verdict.json
handoff_packet.json
schedule_decision.json
```

可以用 SQLite 工具查看：

```powershell
sqlite3 G:\Code\target-repo\.agentflow\agentflow.sqlite ".tables"
sqlite3 G:\Code\target-repo\.agentflow\agentflow.sqlite "select event_type, task_id, run_id, created_at from task_events order by rowid;"
sqlite3 G:\Code\target-repo\.agentflow\agentflow.sqlite "select task_id, status, attempts from task_queue;"
sqlite3 G:\Code\target-repo\.agentflow\agentflow.sqlite "select id, task_id, agent_id, role, status from agent_runs;"
```

## 11. 清理策略

v1 当前清理策略：

- `accepted` 和 `failed` 的任务会清理对应 worktree。
- `awaiting_human` 会保留 worktree，方便人工检查。
- cleanup 成功后才会写 `run.cleaned_up` 事件。
- SIGINT 中断不会把未完成任务伪装成成功或失败。

## 12. Provider 失败分类

你可以在 v1 AgentProfile 中配置 stderr 正则：

```json
{
  "failure_classification": {
    "provider_rate_limited_stderr": ["rate limit", "too many requests"],
    "provider_quota_exhausted_stderr": ["quota exceeded", "insufficient quota"],
    "provider_auth_failed_stderr": ["unauthorized", "invalid api key"]
  }
}
```

匹配结果会进入 closed taxonomy：

```text
provider_rate_limited
provider_quota_exhausted
provider_auth_failed
agent_nonzero_exit
agent_timed_out
spawn_failed
verification_failed
```

其中 provider quota/auth/rate 相关失败会影响本次 CLI invocation 内的调度健康状态。

## 13. 常见问题

### Unsupported schema_version

检查 WorkOrder / AgentProfile 的：

```json
"schema_version": "workflow/v1"
```

或 v0：

```json
"schema_version": "workflow/v0"
```

### 找不到 Agent

确认：

- `--agents` 指向的是正确文件或目录。
- `agent_id` 与 WorkOrder 中的 `implementer_pool` / `reviewer_pool` 一致。
- `capabilities.kinds` 包含 WorkOrder 的 `agent.required_capabilities`。
- `capabilities.roles` 包含 `implementer` 或 `reviewer`。

### verification failed

verification command 是在 agent worktree 中执行的。确认：

- 命令在目标仓库里能独立运行。
- 依赖已经安装。
- timeout 足够长。

### reviewer 没有产出 verdict

确认 reviewer 写的是：

```text
.agent-workflow/review_verdict.json
```

不是仓库根目录的 `review_verdict.json`。

### task 进入 awaiting_human

常见原因：

- reviewer 返回 `rejected`。
- 没有可用的下一位 implementer。
- budget 或 review 尝试次数耗尽。

`awaiting_human` 的 worktree 会保留。

### Windows 路径问题

JSON 中的 Windows 路径需要双反斜杠：

```json
"path": "G:\\Code\\target-repo"
```

PowerShell 命令中可以使用普通反斜杠：

```powershell
node dist\cli\index.js run .\work_order.json --agents .\agents
```

## 14. 当前 v1 / v1.x 不包含什么

当前 v1.x 已经包含：

- SandboxProvider 抽象，以及保持现有 git worktree 行为的 GitWorktreeSandboxProvider。
- SessionSnapshot read-only aggregation seam over existing SQLite task, run, artifact, review-context, and handoff rows.
- v1.x Phase 3 的 file-state-only fork-from-snapshot worktree reconstruction：从 snapshot base evidence 加一个已持久化的 diff artifact 准备 fresh worktree，并通过 SandboxProvider 应用 patch。

以下内容仍是 post-v1：

- Docker / micro-VM 或其他第二种 sandbox adapter。
- model conversation restoration / session resume。
- SessionStore / Redis/KV / external memory。
- Planner / Coordinator 自动拆任务。
- DAG 依赖图。
- HTTP API / dashboard。
- live provider quota probe。
- `awaiting_human` 后的人类决策 cleanup。

当前 v1 是本地 CLI kernel：能跑任务、调度 Agent、审查 diff、返工重派、批处理、记录审计证据，并处理 SIGINT 中断。
