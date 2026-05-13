# 设计调整与补充

> 本文是对 [`multi-agent-llm-workflow-design.md`](./multi-agent-llm-workflow-design.md)、[`vertical-slice-v0.md`](../implementation/vertical-slice-v0.md)、[`module-breakdown.md`](../implementation/module-breakdown.md)、[`event-registry.md`](../contracts/event-registry.md)、[`machine-readable-contracts.md`](../contracts/machine-readable-contracts.md) 的补充。
>
> 现有蓝图在编排原则、Adapter 抽象、调度评分、失败分类、安全边界等方向已经讨论得比较充分。本文只收口蓝图中**尚未明确**或**只是顺带提过**、但落地时一定会被问到的点。每条都给一个可执行的初版规则，避免开工时再次发散。

## A. 文档语言一致性

现状：架构蓝图使用中文，`decisions/` `implementation/` `contracts/` 与 `README.md` 使用英文。同一仓库内中英混用本身不致命，但对新读者会形成认知摩擦，也让外部协作者难以判断主语种。

建议：

- **架构蓝图保持中文**：它的目标读者是项目内部决策者，中文表达更精确。
- **契约 / 实现 / 决策文档保持英文**：这些会直接对应代码、Schema、API；英文与代码标识符的距离更短。
- **README 保持英文**：作为入口，需要面向更广受众。
- 在每个文档顶部写一行 `> Language: zh-CN`（或 `en`）标注主语种，避免读者中途切换语言时困惑。
- 新增文档落地前先确认所属类别（架构 / 契约 / 实现 / 决策），按类别选语言，不要在同一文档中混写正文。

## B. Schema 演进与迁移策略

现状：[`machine-readable-contracts.md`](../contracts/machine-readable-contracts.md) 要求“每个持久化对象必须带 `schema_version`”，但没有说明字段如何演进、旧 run 的 manifest 如何被新版本系统读取。

建议把 schema 演进规则显式写进契约文档：

- **可加字段（minor bump）**：新增可选字段、新增 enum 值（消费方必须容忍未知 enum）、新增事件类型 → schema_version 的次版本号 +1，旧消费方不应因为遇到未知字段而失败。
- **不可加字段（major bump）**：删除字段、字段重命名、字段语义改变、必填 enum 缩小 → schema_version 的主版本号 +1，且必须提供：
  - 双读窗口：新版本代码同时能读旧版本数据。
  - 一次性 backfill 脚本或惰性升级路径。
  - Event Log 中标注 `schema_migration` 事件，记录迁移开始/结束。
- **运行中 run 的 manifest 永不重写**：迁移只影响新写入；旧 run 的 `run_manifest.json` 永远以它写入时的 schema 解析。
- **Zod / JSON Schema 单一来源**：TS 类型由 Zod schema 推导而非反向；JSON Schema 由 Zod 生成，避免三处定义飘移。

## C. Orchestrator 自身的可观测性 SLI/SLO

现状：[`§6.4`](./multi-agent-llm-workflow-design.md) 引入了 OpenTelemetry trace、`correlation_id` / `causation_id`，[`§17`](./multi-agent-llm-workflow-design.md) 提到 Cost Heatmap，但都聚焦在“一个任务的 token / 成本”这一维度。系统自身（Orchestrator、Scheduler、Event Log、Artifact Store）的健康度没有指标。

建议至少先定义这几个 SLI，独立于 LLM 成本遥测：

| 维度 | SLI | 初版 SLO 建议 |
|---|---|---|
| 调度延迟 | WorkOrder 入队到 `run.created` 的 P95 时间 | < 2s（无候选 Agent 时不算） |
| Event Log 写入 | `task_events` insert 的 P95 延迟 | < 50ms |
| Artifact 写入 | artifact 落盘 + checksum + Event Log 入库整体 P95 | < 500ms |
| Run 成功率 | 24h 内 `run.completed` / 总 run 数 | ≥ 90%（不计 `policy_violation` 与 `awaiting_human`） |
| 心跳健康 | 进入 `stale` 的 run 占比 | < 2% |
| 队列堆积 | `queued` 任务数 / 已配置 Agent 并发上限 | < 3x |

这些指标和 Agent 质量指标（成功率、返工率）分开记录。Agent 质量差和 Orchestrator 自身慢是两类问题，混在一起会误判。

## D. 背压、队列容量上限与公平性

现状：[`§14`](./multi-agent-llm-workflow-design.md) 的调度伪代码把“没有可用 Agent”当正常状态，但没说明 WorkOrder 提交速率超过 Agent 吞吐时会发生什么。蓝图里所有队列是隐式无限的。

建议：

- **入口 admission control**：CLI / API 提交 WorkOrder 时检查队列深度。超过 `max_queue_depth` 时直接拒绝并返回结构化错误（`queue_full`），而不是无限堆积。
- **每项目并发上限**：单个 `project_id` 的同时 `running` run 数有硬上限，避免单项目把整个 worker 池吃光。
- **饥饿防护**：长期等待的任务每隔 `starvation_window`（如 30 min）调度评分加 bonus，避免高优先级任务永远压住低优任务。
- **背压向上传播**：Orchestrator 队列饱和时，`task.created` 事件应携带 `queue_pressure` 字段，调用方据此决定是否延迟提交后续任务。

这些规则在 v0 不一定全部实现，但 `max_queue_depth` 和 `max_concurrent_runs_per_project` 应该是 v0 的配置项之一，不能默认无穷。

## E. 时钟、心跳与单调时间

现状：[`§6.2`](./multi-agent-llm-workflow-design.md) 的 lease 用 `expires_at: 2026-04-28T11:00:00+08:00` 这样的墙钟时间。蓝图全程使用 ISO 8601 +08:00 时间戳，没有讨论时钟漂移、跨机器时区差异或单调时钟。

建议：

- **超时判断使用单调时钟**：`heartbeat_timeout`、`lease_timeout`、`grace_period` 都基于 `monotonic_now() - run_started_monotonic` 计算，不直接相减墙钟时间戳。墙钟跳变（NTP 校正、用户改时间）不应触发误判 `stale`。
- **持久化时间使用 UTC**：Event Log、artifact metadata、run manifest 中的所有时间字段都以 UTC 写入（`Z` 结尾），展示层再按用户时区渲染。`+08:00` 这类时间戳只能出现在文档示例和用户可见 UI，不在内部存储。
- **跨机器场景标记时钟来源**：分布式部署时（多 Orchestrator 实例、远程 worker），事件携带 `clock_source` 字段，标注是哪个节点写的，便于事后排查时序异常。
- **MVP 单机部署可以放过这一条**，但 v0 的 Event Log 列就应该是 UTC，避免之后迁移。

## F. 数据保留、PII 与删除权

现状：[`§13`](./multi-agent-llm-workflow-design.md) 的 `credential_profiles` 和 `projects` 表带 `data_region` / `privacy_tier`，[`§4.4`](./multi-agent-llm-workflow-design.md) 讲了信任边界，但全文没有讨论：日志和 artifact 保留多久？项目删除时怎么级联？用户行使删除权时怎么找到所有副本？

建议加一节数据生命周期：

- **保留期分层**：
  - Event Log：默认 90 天热存，之后归档（呼应 [`§17`](./multi-agent-llm-workflow-design.md) 的 Event Log Snapshot / Archive）。
  - Artifact Store：按 kind 分层。`task_capsule`、`final_report`、`diff` 至少保留与项目同样长度；`stdout_tail`、`stderr_tail`、`verification_output` 默认 30 天；带 `security_findings` 的 artifact 单独长期保留。
  - `agent_usage`：保留至少一个完整结算周期 + 90 天，便于复盘。
- **删除语义**：项目删除时，所有 `project_id = X` 的行级联软删除（`deleted_at`），物理清理放到异步任务，并在 Event Log 写一条独立的 `project.deletion_completed`（这条事件本身 `skip_on_replay: true`）。
- **PII 范围声明**：在 `projects.privacy_policy_json` 中显式列出哪些字段视为 PII（用户邮箱、issue 评论作者、commit author）。Context Broker 的脱敏过滤器以这份声明为准。
- **删除权（GDPR-style）**：导出/删除请求按 `correlation_id` 或用户标识 join 整个事件链，包括 artifact 和 dialogue threads。这意味着 `dialogue_threads` 必须能被反向索引到用户，不只是项目。

v0 不需要全部实现，但 `tasks` / `artifacts` / `task_events` 表加 `deleted_at` 列的代价极小，应一开始就加。

## G. 备份与灾难恢复

现状：[`0001-technology-stack.md`](../decisions/0001-technology-stack.md) 决定 v0 用 SQLite + 本地文件系统 artifact。蓝图里没有任何关于备份、快照、宕机恢复的讨论。SQLite 单文件意味着一次磁盘故障可能丢光 Event Log，这对“事件可回放”的承诺是致命的。

建议：

- **v0 最小要求**：每次 `agentflow run` 结束后调用 `VACUUM INTO` 写一份 SQLite 副本到 `.agentflow/backups/YYYY-MM-DD/`。同时把 `.agentflow/artifacts/` 的当日变更做 `tar.gz` 增量。
- **完整 task capsule 是天然冷备**：`§2.1.1.1.1.2` 的 task capsule 已经包含 work_order、run_manifest、diff、final_report，把它写到独立目录或对象存储等于一份分散的备份。
- **恢复演练**：v1 之前至少做一次“删 SQLite + 删 artifact 目录，仅靠 task capsule 重建任务列表”的演练，验证 capsule 是否真够用。如果发现重建不完整，反推 capsule 内容缺什么。
- **不要等到 Phase 4 再做**：备份成本极低，丢数据成本极高。

## H. 非代码任务的 workspace

现状：[`§11.5`](./multi-agent-llm-workflow-design.md) 把 `type` 扩展到 `docs_update` / `research_report` / `ui_review` / `data_analysis`，但 [`§16`](./multi-agent-llm-workflow-design.md) 的隔离规则全是“每个 Coding Agent 在独立 git worktree 跑”。如果任务是 `research_report`，根本没有 base repo；如果是 `ui_review`，可能只有截图和 Figma 链接。

建议引入 **WorkspaceKind** 概念，让 Orchestrator 按任务类型选不同的 workspace 后端：

| WorkspaceKind | 适用 type | 隔离机制 |
|---|---|---|
| `git_worktree` | `code_change`、`docs_update`（仓库内文档） | 现有 [`§16`](./multi-agent-llm-workflow-design.md) 流程 |
| `scratch_dir` | `research_report`、`data_analysis` | 临时目录 + `.agent-workflow/`，不与 git 关联，结束时归档为 capsule |
| `readonly_assets` | `ui_review` | 只读挂载素材目录 + 可写 `.agent-workflow/output/` |

`.agent-workflow/` 协议本身是 workspace-kind 中立的。GitWorktreeManager 应被抽象成 `WorkspaceProvider` 接口，v0 只实现 `git_worktree`，但接口形状保留 `scratch_dir`，避免后续要回过头改 [`§7 Task Capsule Writer`](../implementation/module-breakdown.md) 模块。

这也修了一个隐性 bug：`code_change` 之外的任务类型现在没有验收路径，因为 `git diff` 是空的。`scratch_dir` 类任务以 `final_report.md` 和 `artifacts/` 内容作为验收基础。

## I. 术语表

现状：蓝图里以下术语在不同章节边界略有漂移，开工时容易踩到：

| 术语 | 一句话定义 | 不做什么 |
|---|---|---|
| Orchestrator | 整体状态机和策略协调者 | 不直接拼上下文、不直接跑 CLI、不做评分 |
| Scheduler | 给定候选 Agent 集合做派发评分 | 不执行任务、不收集产物 |
| Tool Executor | 系统级动作（worktree、进程、验证）执行者 | 不做模型判断、不替代 Agent 内部 tool_use |
| Context Broker | 上下文路由与脱敏 | 不评估代码质量、不决定派发 |
| Adapter | 单个外部 Agent 工具的 Process Supervisor + Artifact Collector + Protocol Translator | 不做调度、不存事件 |
| Verifier | 确定性 / 验收证据检查 | 不做语义审查 |
| Reviewer | LLM 语义审查 | 不跑测试、不替代验收 |
| Integrator | 把多 Agent patch 合并入主分支 | 不做语义判断 |
| Planner | 拆任务、生成 DAG、必要时 replan | 不执行任务 |

新增章节或新组件前应先对照此表，确认其职责不与现有组件重叠（呼应 [`§3.1`](./multi-agent-llm-workflow-design.md) 验证类组件登记表的同款约束）。

## J. Orchestrator 自身的测试策略

现状：[`§17`](./multi-agent-llm-workflow-design.md) 的 Eval Suite 测 Agent 智能质量，[`§15.0.0`](./multi-agent-llm-workflow-design.md) 的 Adapter Contract Tests 测工具接入是否还能跑，[`§17`](./multi-agent-llm-workflow-design.md) 的 Workflow Canary 测端到端。这三套都对外。Orchestrator 代码自己的单元/集成测试没有讨论。

建议补一层：

- **Unit Tests**：`Scheduler.score()`、`HandoffQualityGate.evaluate()`、`ContextPacket.cacheKey()`、failure_class 路由表 → 全部用纯函数 + 假数据覆盖。Vitest（[`0001-technology-stack.md`](../decisions/0001-technology-stack.md) 已选）。
- **Integration Tests with Fake Adapter**：定义一个 `FakeAdapter`，可配置成“成功”、“超时”、“崩溃”、“partial diff”、“credential_required”，跑完整的 `runWorkOrder()` 流程，断言 Event Log 内容、artifact 落盘、status 转移。
- **Replay Tests**：选一组录制的 task_events，断言投影到 task / run / artifact 状态确定可重现，且开启 `replay_mode=true` 时不触发任何副作用 handler。
- **Schema Round-Trip Tests**：每个 `schema_version` 都要有“写入 → 读出 → 等价”的测试，配合 §B 的迁移规则。

这一层不依赖任何真实 Agent，应在 CI 每次 PR 上跑；Eval Suite / Canary / Adapter Contract Tests 因为依赖外部工具，按 nightly 跑。

## K. Event 与 Schema 的弃用策略

现状：[`event-registry.md`](../contracts/event-registry.md) 区分了 v0 events 和 later events，[`§6.4.1`](./multi-agent-llm-workflow-design.md) 讲了 replay 副作用抑制，但没有说一个事件类型如何被弃用、字段如何被重命名而不破坏历史数据。

建议：

- **事件类型只追加，不删除**。需要替换时新增一条 `*.v2`，老类型在 registry 标 `deprecated_at`，replay handler 仍能消费。
- **payload 字段使用 additive 演进**。重命名 = 新字段 + 双写一段时间 + 老字段标 deprecated + 一定窗口后停写。Event Log 永不 rewrite 既有行。
- **registry 是 single source of truth**。Event Log 拒绝任何不在 registry 里的事件类型。`later events`（[`event-registry.md`](../contracts/event-registry.md) 第二张表）的 schema 在被首次实现前应被锁定到一个具体 PR，避免“先用着，后面改改”。
- **side_effect_type 不可改**。已经发出去的副作用类型决定 replay 时如何判定 skip，不能事后修。

## L. 显式风险登记表 / 已知未知

蓝图全文有不少“假设”/“等真实压力出现再处理”的地方，散在各章节。建议在文档侧维护一份显式列表，每条带：风险描述、当前缓解、触发再处理的信号、责任章节。

初版列表（开工时再增补）：

| 风险 | 当前缓解 | 触发再处理 | 关联章节 |
|---|---|---|---|
| 官方 CLI 升级破坏 JSON event schema | Adapter Contract Tests 探测 + capability_downgraded | 任一 Adapter 连续 N 天 contract test 红 | [`§15.0.0`](./multi-agent-llm-workflow-design.md) |
| `.agent-workflow/` 被误提交进版本控制 | `prepareWorkspace()` 写 `.git/info/exclude` | 任意 PR diff 出现 `.agent-workflow/` 路径 | [`§2.1.1.1.1.1`](./multi-agent-llm-workflow-design.md) |
| Agent 自报 evidence 自证清白 | 独立 Acceptance Verifier + 机器可验证证据 | 验收通过率与实际线上回归率背离 | [`§6.5.2`](./multi-agent-llm-workflow-design.md) |
| 同 Pro 订阅被多个 Agent profile 共享耗尽 | quota_health 按 credential_profile 计 | 出现 quota_exhausted 但单 Agent 显示健康 | [`§2.1.3.1`](./multi-agent-llm-workflow-design.md) |
| Context Broker 单点 | 降级到静态 Context Packet + `broker.degraded` 事件 | broker 故障期间整体任务失败率 | [`§7.0.1`](./multi-agent-llm-workflow-design.md) |
| Replan 风暴 | replan 次数计入任务图预算 | 任一项目日均 replan/task > 1 | [`§9.5`](./multi-agent-llm-workflow-design.md) |
| SQLite 单文件丢失 | task capsule 兜底 + 每日 VACUUM INTO 备份 | 任一次 v0 dogfood 出现数据丢失 | 本文 §G |
| 时钟漂移导致误判 stale | 超时使用单调时钟 | lease 失败但 Agent 仍在产出 artifact | 本文 §E |
| 队列无限堆积 | admission control + 项目级并发上限 | 任一项目排队 > 1h | 本文 §D |

风险登记表本身随项目演进。每次 incident 复盘后应至少更新一行（新增、调整缓解、关闭风险）。

## M. 文档自身的演进规则

现状：本仓库目前是纯文档仓库，但已经接近 3000 行，已经出现“在哪一节加新内容”的歧义（例如本文第 H 节关于非代码 workspace，本可以塞进 [`§16`](./multi-agent-llm-workflow-design.md)，也可以塞进 [`§11.5`](./multi-agent-llm-workflow-design.md)）。

建议：

- **新约定先入小文档**：像本文这样的“补丁式调整”先以独立文档形式提出，跑过一个迭代后再决定是否合入主蓝图，避免主蓝图频繁震荡。
- **主蓝图只接受经过实战验证的修订**：实现层踩过坑、写出代码或测试支撑，再合并主蓝图。
- **每条新规则带可执行触发条件**：避免“原则上应该”的空话，必须能落到代码 / 配置 / CI / Schema 中至少一处。
- **保持现有 § 编号稳定**：增补优先用 `§X.Y.Z` 子节附加，不要重排已有编号，避免 PR 引用全部失效。

---

以上 13 条不是全部 TODO，而是把蓝图阅读过程中可被立刻明确的“暂未明确”收口。开工后必然还有更多调整，应优先回到本文 §L 的风险登记表更新，而不是再开新章。
