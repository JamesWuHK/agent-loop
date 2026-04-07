# Control Console 状态模型设计

日期：2026-04-07
仓库：`agent-loop`
分支：`feat/control-console`

## 背景

当前 `agent-loop` 已具备基础的 GitHub issue 消费、PR review、merge recovery、lease 恢复能力，但状态表达仍然混杂在多处：

- GitHub issue 生命周期 label
- GitHub PR review label
- GitHub issue/PR comment 中的事件与 lease
- daemon 进程内存运行态
- metrics 与 dashboard 的观测口径

这导致系统虽然能运行，但解释力不足。典型问题：

- GitHub 上有很多 `agent:ready`，但 daemon 实际判定为 `claimable=false`
- dashboard 只能显示“就绪 issue”，不能解释为什么现在没有继续消费
- metrics 使用 `no_issues`，但现场真实含义通常是“没有可运行 issue”
- 静态状态机与 daemon 运行时状态转移不完全一致

本设计的目标不是立刻重写调度器，而是先把状态层级、存储边界、控制台口径统一，让 dashboard 能替代大部分运行态问答。

## 目标

- 统一 issue 生命周期、PR 状态、lease 状态、控制台派生状态的边界
- 保留 GitHub 作为跨机器共享真相源
- 明确哪些状态需要持久化，哪些应为派生视图
- 建立 `agent-loop` 自身的版本号管理与运行时版本可见性
- 为单一 control console 服务打下状态模型基础
- 让 dashboard 能明确回答“为什么当前没有消费 issue”

## 非目标

- 本期不引入中心数据库作为调度真相源
- 本期不重写 claim / resume / merge 主流程
- 本期不改变 GitHub 作为多机协作共享载体的角色
- 本期不一次性完成 daemon + dashboard 单进程合并

## 问题总结

### 1. 现有 `ready` 语义失真

当前 `ready` 既被人理解为“马上可跑”，又被代码用作“已入池但仍需二次判定”的状态。日志现场中经常出现：

- issue state=`ready`
- `blockedBy` 非空
- `claimable=false`

这会误导用户和 dashboard。

### 2. 状态层次混杂

当前系统混用了四类状态：

1. issue 生命周期
2. PR review 生命周期
3. lease / worker 运行态
4. dashboard 解释态

这些状态不应该在同一层被表达为 GitHub label。

### 3. 观测口径失真

`no_issues` 这类指标与真实运行语义不一致。它表达的通常不是“仓库里没有 issue”，而是“当前没有可运行 issue”。

### 4. 版本号缺少统一管理

当前仓库根 `package.json`、`apps/agent-daemon/package.json`、`packages/agent-shared/package.json` 都写着 `0.1.0`，但运行态没有真正统一的版本管理：

- health 接口直接硬编码 `0.1.0`
- GitHub presence 心跳不带版本号
- runtime record 不带版本号
- dashboard 无法直接看出各台机器正在跑哪个 `agent-loop` 版本

这会直接影响：

- 多机运行时的版本核对
- 灰度/回滚判断
- “当前机器为什么行为不同”的排查效率

## 设计原则

1. GitHub 只保存跨机器必须共享的事实
2. daemon 负责根据 GitHub 事实计算派生状态并执行调度
3. dashboard 展示派生状态，不再把 GitHub label 直接等同于用户心智
4. 本地数据库如果引入，只作为读模型，不参与 claim / resume / merge 仲裁
5. 尽量减少新增 issue label，优先增加派生视图
6. 版本号必须有单一真相源，并且所有对外心跳/监控入口都报告同一版本信息

## 三层状态模型

### 第一层：Issue 生命周期

这一层是跨机器共享的主状态，写回 GitHub。

建议对外控制台口径：

- `未入队`
- `已入队`
- `执行中`
- `失败`
- `已完成`

内部兼容当前实现：

- `ready` => 控制台显示 `已入队`
- `working` => 控制台显示 `执行中`
- `failed` => 控制台显示 `失败`
- `done` => 控制台显示 `已完成`
- `unknown` => 控制台显示 `未入队`
- `claimed` => 先保留为内部短暂过渡态
- `stale` => 先保留为内部恢复态，不作为主要用户心智

### 第二层：控制台派生状态

这一层不作为 GitHub 主状态保存，而是由 daemon 计算，供 dashboard 使用。

- `可运行`
- `依赖阻塞`
- `合同无效`
- `等待评审`
- `等待合并`
- `需要人工`
- `可恢复`
- `执行卡住`

这一层回答的是：

- 为什么还没开始消费？
- 当前需要等待什么？
- 现在该不该人工介入？

### 第三层：Lease / Worker 运行态

这一层用于恢复、接管、卡住检测，继续以 GitHub lease comment + 本机 runtime 组合表达。

- `active`
- `recoverable`
- `completed`
- `released`

同时保留这些字段：

- `phase`
- `attempt`
- `lastHeartbeatAt`
- `lastProgressAt`
- `lastProgressKind`
- `expiresAt`
- `recoveryReason`

## 状态存储方案

### 结论

不引入中心数据库作为状态真相源。

采用：

- GitHub 作为共享真相源
- daemon 内存 + runtime 文件作为本机运行态
- 本地 SQLite 作为控制台读模型（Phase 2 引入）

### 存储分层表

| 分类 | 数据 | 主存储地点 | 是否跨机器共享 | 说明 |
| --- | --- | --- | --- | --- |
| Issue 生命周期 | `ready/working/failed/done/stale` | GitHub issue labels | 是 | 共享主事实 |
| PR review 事实 | `review-approved/review-failed/retry/human-needed` | GitHub PR labels | 是 | 共享主事实 |
| Issue 事件流 | claimed / failed / done / stale / requeue 事件 | GitHub issue comments | 是 | 共享状态变迁历史 |
| Lease 真相 | lease + heartbeat/progress 字段 | GitHub comments | 是 | 多机恢复与接管依据 |
| 运行态 | 当前 daemon、本机 worktree、当前活跃任务 | daemon 内存 + runtime json | 否 | 本机进程状态 |
| 派生控制台状态 | `可运行/依赖阻塞/等待评审...` | daemon 计算 | 否 | 读模型 / dashboard 展示 |
| 历史快照与播报 | issue 视图快照、状态时间线、告警记录 | 本地 SQLite | 否 | Phase 2 引入 |
| 指标 | poll、lease、恢复、卡住计数 | `/metrics` | 否 | 观测数据，不是主状态 |
| 日志 | 原始过程日志 | 本机日志文件 | 否 | 诊断证据 |

## 版本号管理方案

### 结论

`agent-loop` 必须把“自身版本”作为一类正式运行元数据管理，而不是只靠 `package.json` 文本存在。

建议运行时统一暴露：

- `version`
- `gitCommit`
- `gitCommitShort`
- `gitBranch`
- `buildSource`
- `buildDirty`

其中：

- `version`：面向人类的主版本号
- `gitCommit`：精确定位运行代码
- `buildSource`：说明该版本来自 tag、package version，还是开发态
- `buildDirty`：标记当前运行工作树是否带未提交修改

### 单一真相源

建议使用仓库根 `package.json` 的 `version` 作为 `agent-loop` 控制平面的单一主版本号。

原因：

- 当前 monorepo 是私有仓库，不是独立发布多个 npm package
- daemon、shared、dashboard 作为同一控制平面一起演进
- 对运维和监控来说，最重要的是“这台 daemon 跑的是哪版框架”，而不是 workspace 单独版本

不建议在 Phase 1 同时引入多 package 独立版本策略。

### 运行时版本元数据

建议新增统一结构：

```ts
interface AgentLoopBuildInfo {
  version: string
  gitCommit: string | null
  gitCommitShort: string | null
  gitBranch: string | null
  buildSource: 'tag' | 'package' | 'dev'
  buildDirty: boolean | null
}
```

### 版本解析规则

启动时按以下顺序构造版本信息：

1. 读取仓库根 `package.json.version`
2. 读取当前 Git commit SHA
3. 读取当前 branch
4. 检查工作树是否 dirty
5. 如果当前 commit 正好命中发布 tag，可将 `buildSource` 标记为 `tag`
6. 如果无法读取 Git 信息，则至少保留 `version`

### 必须带版本号的出口

以下所有出口都必须报告同一份 `AgentLoopBuildInfo`：

| 出口 | 当前状态 | 目标 |
| --- | --- | --- |
| health JSON | 只有硬编码 `version: 0.1.0` | 改为统一 build info |
| GitHub presence 心跳 | 不带版本 | 增加 `version` / `gitCommitShort` |
| runtime record json | 不带版本 | 增加 `buildInfo` |
| dashboard 机器卡片 | 不显示版本 | 显示版本 + commit short |
| status / doctor 输出 | 只显示 `v${health.version}` | 显示 `version + commit` |

### 控制台展示要求

dashboard 至少要能直接看到：

- 当前机器运行的 `agent-loop` 版本号
- 当前 commit short SHA
- 是否为 dirty build

建议展示方式：

- 机器卡片 chip：`v0.1.0`
- 机器卡片 chip：`a718d1e`
- 若 dirty：额外显示 `dirty`

### 心跳兼容性

presence comment 新增版本字段时，解析逻辑必须向后兼容旧 comment：

- 旧 comment 没有版本字段时，不判定为非法
- dashboard 对旧 heartbeat 显示为 `版本未知`
- 新版本 daemon 发布心跳后，新的 comment 自动覆盖旧 comment

### 发布与回滚管理

版本管理不仅用于显示，也用于回滚判断。

建议规则：

- 每次准备让新框架进入稳定运行前，打一个可回滚 tag
- dashboard 和 health 必须能让人一眼看到当前实际运行的版本与 commit
- 多机环境下，如果版本不一致，dashboard 必须能直接看出来

### Phase 1 范围

Phase 1 不需要建立完整发布流水线，但至少要完成：

- 统一构建 `AgentLoopBuildInfo`
- health 报告真实版本信息
- presence 心跳带版本号
- runtime record 带版本号
- dashboard 机器卡片显示版本号

## 控制台状态字典

| 控制台状态 | 作用对象 | 是否写回 GitHub 主状态 | 主要来源 | 判定说明 |
| --- | --- | --- | --- | --- |
| `未入队` | Issue | 否 | GitHub issue | open issue 且无生命周期 label |
| `已入队` | Issue | 是 | GitHub issue label | lifecycle=`ready` |
| `执行中` | Issue | 是 | GitHub issue label + lease | lifecycle=`working` 且 lease active 更可信 |
| `失败` | Issue | 是 | GitHub issue label | lifecycle=`failed` |
| `已完成` | Issue | 是 | GitHub closed / done | closed issue 或 lifecycle=`done` |
| `可运行` | Issue | 否 | daemon 派生 | `已入队` 且依赖满足、合同有效、无 PR/人工阻塞 |
| `依赖阻塞` | Issue | 否 | 依赖解析 + issue 状态 | `claimBlockedBy` 非空 |
| `合同无效` | Issue | 否 | ready-gate / contract 校验 | 合同不完整或解析失败 |
| `等待评审` | Issue/PR | 否 | open PR + review labels | 有 PR 且尚未 approved / merged |
| `等待合并` | Issue/PR | 否 | approved PR | review 已通过但未 merge |
| `需要人工` | Issue/PR | 否 | PR label / 恢复升级逻辑 | `human-needed` 或自动恢复失败 |
| `可恢复` | Issue | 否 | lease + worktree/branch 状态 | `failed/stale` 但存在自动恢复路径 |
| `执行卡住` | Issue | 否 | lease heartbeat/progress | active lease 长时间无进展 |

## 控制台首页口径

首页应固定展示以下聚合值：

- `Open`
- `已入队`
- `可运行`
- `执行中`
- `依赖阻塞`
- `等待评审`
- `等待合并`
- `需要人工`

### 首页字段定义

| 字段 | 计算方式 |
| --- | --- |
| `Open` | GitHub open issue 总数 |
| `已入队` | lifecycle=`ready` 的 open issue 数 |
| `可运行` | 派生状态=`可运行` 的 issue 数 |
| `执行中` | lifecycle=`working` 的 issue 数 |
| `依赖阻塞` | 派生状态=`依赖阻塞` 的 issue 数 |
| `等待评审` | 派生状态=`等待评审` 的 issue 数 |
| `等待合并` | 派生状态=`等待合并` 的 issue 数 |
| `需要人工` | 派生状态=`需要人工` 的 issue 数 |

### 首页解释原则

控制台不能只告诉用户“没有 issue”，必须明确区分：

- 仓库 open issue 总数
- 已入队 issue 总数
- 当前可运行 issue 总数

典型展示示例：

- Open: `127`
- 已入队: `30`
- 可运行: `0`
- 依赖阻塞: `27`
- 等待评审: `2`
- 需要人工: `1`

## 告警规则

### 信息

- 可运行 issue 数为 0，但全部为依赖阻塞

### 提醒

- 等待评审时间超过阈值
- 等待合并时间超过阈值

### 警告

- active lease 长时间无进展
- failed issue 长时间未能 requeue 或 resume

### 严重

- `human-needed`
- 合同无效且已入队
- 自动恢复失败并升级

严重告警同时写入：

- dashboard 红警
- GitHub comment
- 聊天提醒

## Phase 1 实施范围

### 包 A：补派生状态计算器

新增共享派生状态层，不动调度主流程。

建议新增模块：

- `packages/agent-shared/src/issue-dashboard-state.ts`

功能：

- 输入 issue + PR + lease 现场
- 输出 lifecycleState、derivedState、reasonSummary

### 包 B：改 dashboard 快照结构

将当前摘要从：

- `readyIssueCount`
- `workingIssueCount`
- `failedIssueCount`

扩展为：

- `queuedIssueCount`
- `runnableIssueCount`
- `dependencyBlockedIssueCount`
- `contractInvalidIssueCount`
- `waitingReviewIssueCount`
- `waitingMergeIssueCount`
- `humanNeededIssueCount`

同时在机器维度新增：

- `agentLoopVersion`
- `agentLoopCommitShort`
- `agentLoopBuildDirty`

### 包 C：改 dashboard 文案

最低要求：

- `ready` 中文从“就绪”改为“已入队”
- issue 表格拆分“生命周期”和“当前状态”
- 当前状态列展示派生状态
- 原因列给出中文摘要
- 机器卡片明确展示 `agent-loop` 版本号与 commit short

### 包 D：改 metrics 口径

将 `no_issues` 语义替换为 `no_runnable_issues`。

为兼容历史采样，状态聚合可短期同时接受：

- `no_issues`
- `no_runnable_issues`

但控制台对外统一显示：

- `当前无可运行 issue`

### 包 E：补运行时版本信息

至少覆盖：

- 统一 build info 解析模块
- health 返回真实版本，不再硬编码 `0.1.0`
- GitHub presence comment 带版本字段
- background runtime record 带版本字段
- dashboard / status / doctor 输出可见版本与 commit

### 包 F：补测试

至少覆盖：

- `ready + blockedBy > 0` => `已入队 + 依赖阻塞`
- `ready + claimable` => `已入队 + 可运行`
- `ready + 合同无效` => `已入队/移除 ready 前后逻辑一致`
- `open PR + 未 approved` => `等待评审`
- `approved + 未 merge` => `等待合并`
- `human-needed` => `需要人工`
- 新旧 poll metrics label 的兼容聚合
- 旧版 presence comment 无版本字段仍可解析
- health / runtime record / dashboard 都能读到同一版本信息

## Phase 2 规划

引入本地 SQLite 读模型，只做控制台查询与历史追踪。

建议最小表：

- `issue_view`
- `state_transition_log`
- `alert_log`
- `daemon_presence`

禁止：

- 使用 SQLite 决定 claim 胜负
- 使用 SQLite 代替 GitHub 作为共享真相源

## Phase 3 规划

将 daemon + dashboard 合并为单一 control console 进程，统一提供：

- `/health`
- `/metrics`
- `/dashboard`

目标：

- 单一 launchd 服务
- 单一控制台入口
- 关闭聊天窗口后仍可长期运行

## 风险与取舍

### 1. 为什么不直接上中心数据库

因为当前系统的共享事实已经建立在 GitHub 上。此时引入中心数据库会形成第二真相源，增加双写一致性风险。

### 2. 为什么不继续增加 GitHub label

因为大多数“为什么没消费”的信息不是生命周期，而是调度解释态。继续加 label 只会让状态更混乱。

### 3. 为什么 `claimed` 暂不移除

它虽然不适合作为主要用户心智，但仍承担分布式 claim 的短暂过渡角色。可在后续稳定后重新评估是否弱化。

## 验收标准

Phase 1 完成后，控制台必须能稳定回答：

1. 当前仓库 open issue 有多少
2. 已入队 issue 有多少
3. 当前可运行 issue 有多少
4. 为什么当前没有继续消费
5. 当前是否存在需要人工介入的 issue / PR

同时满足：

- `ready` 不再被中文展示为“就绪”
- 不再用 `no_issues` 对用户解释“当前无可运行任务”
- dashboard 能显式区分“已入队”和“可运行”

## 推荐下一步

按以下顺序推进：

1. Phase 1：状态口径清洗
2. Phase 2：SQLite 读模型
3. Phase 3：单服务 control console

先把系统从“能跑但难解释”变成“能跑也能解释”，再进一步追求自治与部署整合。
