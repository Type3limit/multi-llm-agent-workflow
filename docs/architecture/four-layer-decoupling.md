# 四层解耦：Anthropic Managed Agents 架构观察

> 来源：B 站视频《比 OpenClaw 更好！我发现了多 Agent 协作架构的版本答案》（BV1DB546wEb8）的文字稿提炼。
>
> 本文是**对视频的转述与解读**，不是一手考据。视频作者声称的外部证据包括：Anthropic 2026 年 4 月初的一篇工程博客（主旨"扩大 agent 规模要把脑和手解耦"）、`anthropic` Python SDK `beta/` 目录下的接口（agents / environments / sessions / skills / memories / doors / vaults）、以及 cloud-code SDK 在 2026 年 4 月合并的 `SessionStore` 相关 PR。**这些项目名和日期本文未独立核实**，按视频转述记录；后续若要据此做决策，应直接查证博客原文、SDK 源码和 PR 提交记录。

---

## 1. 核心问题：harness 注定过时

> "你为模型写的修补代码注定会过时——模型的进化速度永远比你重构代码的速度快。"

Anthropic 工程师曾经写了几千行 harness 去弥补旧模型的记忆缺陷，新模型一发布，这些精妙补丁就成了负债。

**结论**：不要在编排层重新实现 agent 的"思考"。把易变的部分（模型能力）和稳定的部分（执行框架）切开。

## 2. 宠物 vs. 牛马

服务器架构里的经典对比：

| 宠物（Pet） | 牛马（Cattle） |
|---|---|
| 有名字，长期维护 | 无状态，可批量替换 |
| 配置漂移导致越来越脆弱 | 跑崩了直接干掉重建 |
| 记忆和环境绑死 | 记忆外置，环境随用随抛 |

很多人本地"养小龙虾"养着养着就死了，根因就是把 agent 当宠物：模型记忆 + 本地环境 + 配置全绑在一起，任何一处污染都会让系统整体崩坏。

**Managed Agents 的方向是把 agent 当牛马**：大脑只发指令，双手是一次性沙盒，崩了就换。

## 3. 四层解耦

视频作者根据 Anthropic 的博客 + SDK + PR 时间线推断出的分层（非官方命名，但模型清晰）：

```
┌─────────────────────────────────────────────────┐
│ L4  SessionStore  云端记忆（Redis 等）            │  agent 彻底无状态
├─────────────────────────────────────────────────┤
│ L3  Session       动态运行实例：对话/进程/挂载    │  可 fork / 回滚 / 克隆
├─────────────────────────────────────────────────┤
│ L2  Coordinator   编排角色（一个 agent）：拆任务、派活 │  一个指挥官 + ≤20 个专业 agent
├─────────────────────────────────────────────────┤
│ L1  Agent ↔ Sandbox  大脑和双手解耦              │  沙盒崩了换一双
└─────────────────────────────────────────────────┘
```

### L1：Agent ↔ Sandbox

- **Agent = 大脑**：模型 + 系统提示词 + 工具清单 + MCP 配置。静态模板。
- **Sandbox = 双手**：无状态的隔离执行环境（容器 / micro-VM / worktree）。
- 双手坏了不重启大脑，直接换沙盒。

### L2：Coordinator — 编排角色是一个 agent，不是规则调度器

视频反复强调的关键点是：**"协调者变成了一个 agent"**——它本身是一个用模型驱动的 agent，能读懂目标、拆任务、派活，而不是按权重打分的静态调度器。SDK 的 `agents.coordinator` 字段透露：

- **不干活，只拆活**：唯一职责是任务分解和派发。
- **最多 20 个下属 agent**，每个有独立 prompt / 工具 / MCP。
- **替代人类编排**：以前你在多窗口之间复制粘贴（编码 → review → 测试），现在 coordinator agent 替你做。

> ⚠️ 注意区分：本项目现有的 `Scheduler` 是按 `SCHEDULER_WEIGHTS` 打分的"选 agent"组件，**不是** L2 意义上的 Coordinator。要对齐 L2，需要新增一个"Planner / Coordinator agent"角色，让 LLM 来拆任务。

### L3：Session — Agent 和运行解耦

> "Agent 负责'我是谁'，Session 负责'我在干什么'。"

- **Agent 静态**：定义"用什么模型 / 工具 / 提示词"。
- **Session 动态**：跑起来产生的对话、进程、挂载的文件、记忆。
- 一个 Agent 可以同时跑 N 个互不干扰的 Session。
- **Session 可 fork / 回滚 / 克隆**：在 agent "刚搜完代码库、最聪明的状态"打快照，后面有针对性的任务就从这个快照分叉，避免上下文不断稀释。

### L4：SessionStore — 记忆外置

- 记忆从 agent 进程里搬到云端 KV（Redis 之类）。
- agent 容器随时销毁，下一次随便从哪个节点拉起都能恢复上下文。
- 这一层完成后，**agent 进程变成纯粹的无状态计算单元**——这才是"牛马"的完全体。

## 4. 衍生设计含义

### 4.1 任务图（Task Graph）替代单 agent 长程对话

不依赖单个 agent 的超长上下文，把流程切成独立节点。每个节点：

- 用**新鲜上下文**启动
- 可以是**不同模型**（大模型规划、小模型执行）
- 节点之间**靠工件传递**，不靠对话历史

举例（视频里给的两个场景）：

- 编码流水线：并发多个 coding 节点 → 并发 review 节点 → 汇总节点
- Deep research：并发搜索节点 → 并发写作节点 → PPT/报告节点

### 4.2 Token Efficiency

每个节点上下文短 → 每 token 信息密度高 → 大小模型按任务分工 → 总成本下降。这是单 agent 长对话拿不到的红利。

### 4.3 沙盒启动速度成为新瓶颈

Docker 启动几百毫秒到几秒，对"每个任务一个新沙盒"的模式来说太慢。视频提到腾讯系开源的一款"Kube Sandbox"类项目（按视频说法在 2026 年 4 月末前后发布，声称毫秒级启动）方向上对齐——具体项目名/版本本文未独立核实。

### 4.4 计费模型可能变化

视频里的原话只是"计算资源的分配和计价可能也会变革"。可以预期的方向是：**从"长期实例 + 按时长计费"转向更适配短命沙盒的资源调度/计价模型**（例如按沙盒生命周期、按调用、或按底层 micro-VM 秒级粒度），具体形态视频没有定论。

## 5. 对本项目（agentflow）的对照

我们目前的 v0/v1 设计大致命中**一层半到两层**——L1 思想对齐但实现弱（worktree 不等于真沙盒），L2 只有调度基础设施的一半，L3/L4 基本没有：

| Anthropic 四层 | agentflow 现状 | 匹配度 |
|---|---|---|
| L1 Agent ↔ Sandbox | `OfficialCliAdapter` 启动官方 CLI + `GitWorktreeManager` 每次跑一个隔离 worktree | ⚠️ 思想对齐但弱：worktree 只隔离文件，不隔离进程/网络/依赖 |
| L2 Coordinator | `Scheduler` + `BudgetManager` 提供了**调度基础设施的一半**，但没有"会拆任务的 agent"——拆任务靠人写 WorkOrder | ⚠️ 一半：调度有了，规划没有 |
| L3 Session（fork / 回滚 / 克隆） | v1.x Phase 2 has a read-only `SessionSnapshot` over SQLite task/run/artifact/review/handoff evidence. v1.x Phase 3 adds L3-lite fork-from-snapshot worktree reconstruction from persisted base evidence plus a diff artifact. Model conversation restore, rollback, and clone semantics are still absent | partial |
| L4 SessionStore（记忆外置） | 事件/run/artifact 在 SQLite 里，但这是**审计日志**，不是**可恢复的运行态**。无 KV 形态的 session 上下文 | ❌ |

### 视频作者自己的实现也没做到"纯净四层"

视频约 7:39 处作者承认：**他自己的复刻"并没有完全解耦"——把 agent 的 harness 塞进了 worker 节点（一个 Docker）**。也就是说，"大脑 + 双手"在他的实现里仍然合在沙盒容器内，只是沙盒之间相互隔离。这对我们很关键：

- agentflow 也是以官方 CLI / `OfficialCliAdapter` 作为 harness 边界，"大脑"（模型对话循环）跑在官方 CLI 进程里，"双手"（执行环境）跑在 worktree 里。**这本身就和视频里的实际实现处在同一种工程妥协上**，不必把"没做到 L1 纯净解耦"当作我们独有的缺陷。
- 真正纯净的 L1 解耦需要把 agent 内部对话循环从 CLI 进程里拆出来，但那会违反"编排而非拦截"原则。**视频作者也没做到这一点**——所以"完全四层解耦"目前更像愿景，不是已落地的工程范式。

### 我们做对了什么

- **解耦"启动 agent"和"agent 内部循环"**：和 Anthropic"不重新实现 harness、只编排官方工具"的态度一致。我们的"编排而非拦截"原则等价于 L1 思想。
- **每次跑用新 worktree**：方向上对应"无状态双手"。
- **Reviewer 用独立 worktree + `SandboxProvider.applyDiff`（git apply --3way --whitespace=nowarn -）**：物理隔离，符合"双手崩了换一双"。
- **append-only 事件日志 + closed-taxonomy 失败原因**：审计、重放、追责的基础——这是 L4 之外、Anthropic 没强调但我们做对的工程基础。

### 我们的盲点

1. **没有"会规划的 coordinator agent"**。`Scheduler` 是按权重打分的调度器，不会读 WorkOrder 然后拆成子任务。要做 L2，得引入一个"Planner Agent" 角色，输入一个高层目标，产出多个 sub-WorkOrder。
2. **Session is only file-state forkable, not conversation-resumable**. v1.x Phase 2 can read a `SessionSnapshot` for persisted task evidence. v1.x Phase 3 can rebuild a fresh worktree from snapshot base evidence plus a selected diff artifact. It still cannot restore model conversation state, process state, rollback points, or full clone semantics.
3. **沙盒粒度太粗**。Git worktree 只隔离了文件，没隔离进程/网络/依赖。要逼近"双手"的强隔离，需要接 Docker / Kube Sandbox / Firecracker 类的方案。
4. **记忆没外置**。`agent_runs.workspace_path` 和 `.agent-workflow/work_order.md` 是文件路径，不是可异地恢复的运行态快照。

## 6. 对 agentflow 的演进路线

这个视频最值得吸收的不是"立刻复刻 Managed Agents"，而是一个更稳的工程方向：**把 agentflow 逐步做成可靠的本地 agent 编排内核，然后在内核外侧长出 Sandbox、Session、Coordinator 和 Memory。**

因此路线应该分四步走，而不是把四层一次性塞进 v1：

| 阶段 | 目标 | 做什么 | 不做什么 |
|---|---|---|---|
| v1 收口 | 先让现有多 agent 内核可用 | 完成 Worker outcome translation、v1 `agentflow run`、`agentflow batch`、fake-agent e2e | 不做 Docker 沙盒、不做 Session、不做 Coordinator DAG |
| v1.x / L1 | 把执行环境变成可替换 seam | 已引入 `SandboxProvider` interface；`GitWorktreeSandboxProvider` 作为第一个 adapter 复用当前 git worktree 行为；预留 Docker / micro-VM adapter | 不改变官方 CLI harness，不拦截 agent 内部工具调用 |
| v1.x / L3 read model | 让 task 终态可被读取 | 已引入 read-only `SessionSnapshot` 聚合契约：从现有 queue/run/artifact/review_context/handoff 数据读出 base repo/ref、runs、artifact refs、review context 和 handoff URI | 不重建 worktree，不 fork session，不恢复 Claude/Codex 内部对话状态，不新增持久化表 |
| v1.x / L3 lite | 让 run 终态可 fork | Implemented `reconstructWorktreeFromSessionSnapshot`: select a persisted snapshot diff artifact, create a fresh git worktree from the selected run base commit or snapshot base ref, and apply the diff via `SandboxProvider` | 不承诺恢复 Claude/Codex 的内部对话状态；不新建第三套存储；不长期保留旧 worktree |
| v2+ / L2 | 让规划成为一个 agent 角色 | 引入 Planner / Coordinator agent，第一版只产出扁平 fan-out WorkOrders，并可选一个最终聚合 WorkOrder | 不让 Coordinator 直接执行任务，不绕过 Scheduler/Budget/EventLog，不做 DAG dependency edges |
| v3 / L4 | 外置可恢复运行态 | 在 SQLite snapshot 模型跑稳后，再考虑 Redis/KV 形态的 SessionStore | 不提前引入云端依赖 |

### 6.1 近期原则

1. **先完成 v1，不提前铺空壳**。v1 的价值是证明 Scheduler + Reviewer + WorkerPool + Budget + Handoff 能稳定跑通。四层架构不能成为拖慢 v1 的新范围。
2. **v1 到 L1 之间要有闸门**。这个闸门已经在 v1.x Phase 1 打开：`SandboxProvider` 只包住既有 git worktree 行为，不引入第二种沙盒。
3. **先做 seam，再做新 adapter**。`SandboxProvider` 的第一版已经落地为 `GitWorktreeSandboxProvider`，保留当前 `.agentflow/worktrees/<task_id>/<run_id>`、branch/base ref、diff/status/cleanup 和 reviewer `git apply --3way --whitespace=nowarn -` 语义；当出现第二个 adapter（Docker / Kube Sandbox / Firecracker）时，这个 seam 才真正变深。
4. **SessionSnapshot 是聚合契约，不是新存储**。v1.x Phase 2 implements it as a read-only contract over existing `task_queue`, `agent_runs`, `artifacts`, review context, and handoff URI data, with no new table.
5. **fork from snapshot 优先走重建，不长期保留 worktree**。v1.x Phase 3 implements the first L3-lite version as `snapshot base evidence + diff artifact -> git worktree add -> git apply`, reusing `SandboxProvider.applyDiff` semantics. This reconstructs repository file state only.
6. **先 snapshot，再 session resume**。我们能可靠保存的是 repo 状态、artifact、handoff 和 summary；模型内部上下文恢复属于更高风险的 long-running session 能力，不能混进 v2 的第一步。
7. **Coordinator 第一版只做扁平 fan-out**。真正的 L2 不是把 `Scheduler` 改成 LLM，而是新增一个 Planner / Coordinator agent，产出 N 个独立 WorkOrder，直接喂给 `agentflow batch`。DAG dependency edges、条件分支、聚合节点语义需要单独 ADR。
8. **SessionStore 从 SQLite 开始**。在本地 CLI 场景里，SQLite 的 session snapshot 足够验证接口；Redis/KV 是部署形态，不是最先要证明的产品假设。

## 7. 一句话总结

> **Anthropic 的方向是"agent 操作系统"——把 agent 从工具变成基础设施，靠四层解耦让模型升级时编排层不用重写。**
>
> agentflow 应该沿这个方向靠拢，但路线是：**v1 先成为可靠的本地编排内核；v1.x 已补上 behavior-preserving `SandboxProvider` seam、read-only `SessionSnapshot` seam、以及 file-state-only fork-from-snapshot worktree reconstruction；后续再做会拆任务的 Coordinator agent。**
