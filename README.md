# Agent Loop

**Distributed automation daemon** — GitHub Issues as a task queue, Claude Code as the executor.

Agent Loop 是一个用自身驱动自身开发的框架：把它的 Issues 作为任务源，用它自己跑出来的代码来处理这些 Issues。

## How It Works

```
GitHub Issues (agent:ready)
        ↓ claim (atomic: assignee + label)
worktree: git worktree add agent/{issue}/{machine-id}
        ↓
[Planning Agent] → Subtask[] (numbered list)
        ↓
[Subtask 1] → commit + push (HEAD verified)
        ↓
[Subtask N] → ...
        ↓
PR: gh pr create (idempotent)
        ↓
GitHub: agent:working → agent:done
worktree: auto-cleaned
```

## Quick Start

```bash
# Clone this repo
git clone https://github.com/JamesWuHK/agent-loop.git
cd agent-loop

# Install dependencies
bun install

# Join the current repo from a new machine and start a managed daemon
agent-loop --join-project --machine-id macbook-pro-b --health-port 9312 --metrics-port 9092 --repo-cap 2
# or:
bun run agent:join-project -- --machine-id macbook-pro-b --health-port 9312 --metrics-port 9092 --repo-cap 2

# Configure — daemon 将消费本仓库的 Issues
agent-loop --repo JamesWuHK/agent-loop --pat ghp_xxx --machine-id my-dev-machine
# 或先 gh auth login，daemon 会自动复用 gh auth token

# Run (持续轮询)
agent-loop

# Run detached so it survives closing the current terminal/Codex window
agent-loop --daemonize --health-port 9311 --metrics-port 9091

# Re-open a fresh Codex/terminal session and rediscover local daemons
agent-loop --runtimes

# Print the recent managed daemon log without remembering the file path
agent-loop --logs --health-port 9311

# Start a managed daemon again after it has been stopped
agent-loop --start --health-port 9311

# Install a macOS launchd service so the daemon comes back after login/reboot
agent-loop --launchd-install --health-port 9311 --metrics-port 9091

# 或一次性验证模式
agent-loop --once
```

## Single-Repo Multi-Machine Mode

当前这一版的重点不是“模仿 OpenHands”，而是把“多台机器协同开发同一个仓库”做稳定：

- 显式调度优先级：给 issue 加 `agent:priority-high` 或 `agent:priority-low`；未打标的 issue 走默认优先级。claim 顺序固定为 `high > default > low`，同优先级内再按更早的 `updatedAt` 和更小的 issue number 稳定排序。
- 低延迟唤醒：除了周期性 polling，还可以主动唤醒本机 daemon。

```bash
agent-loop --wake-now
agent-loop --wake-issue 123
agent-loop --wake-pr 456
```

这些 wake request 会先落到本地 durable queue，再由 daemon 在启动时和空闲期间消费，所以即使 loopback notify 失败，也不会直接丢信号。默认路径：

```text
~/.agent-loop/wake-queue/{owner-repo}/{machineId}.jsonl
```

如果你已经在目标开发机上装了 GitHub self-hosted runner，现在仓库里的 [`agent-daemon-wake.yml`](.github/workflows/agent-daemon-wake.yml) 和 [`agent-ready-gate.yml`](.github/workflows/agent-ready-gate.yml) 会把 issue / PR / manual dispatch 事件翻译成这类本地 wake request：

- `agent:ready` 的 issue 会先过 ready-gate，再 wake 本机 daemon，避免校验和认领抢跑
- PR 的 `opened / reopened / ready_for_review / synchronize / review label changes` 会直接 wake
- `workflow_dispatch` 支持手工发 `now / issue / pr` 三类 wake

接线方式很简单：

1. 在目标机器上把这个仓库注册成 GitHub self-hosted runner，并带上 `agent-loop` label
2. 确保这台机器已经通过 `agent-loop --join-project` 或 `--start` 跑着本地 daemon
3. workflow 会在 runner 上执行 `bun apps/agent-daemon/src/index.ts --wake-from-github-event --repo <owner/repo>`，把 GitHub 事件落成 durable wake queue，再 best-effort 通知本地 daemon

- 离线回放评估：daemon 行为变更可以用 fixture 目录做 replay/eval，而不是只靠手工盯日志。

```bash
bun run agent:replay:eval -- --fixtures-dir apps/agent-daemon/src/fixtures/replay
```

- 人机接力恢复：如果某个 failed issue 被关联 PR 的 `agent:human-needed` 状态卡住，可以在 issue 评论区写入一个更新、更晚的 resolution comment，daemon 就会在下一次 reconcile 尝试恢复。

```md
<!-- agent-loop:issue-resume-resolved {"issueNumber":104,"prNumber":205,"resolvedAt":"2026-04-11T09:10:00.000Z","resolution":"manual fix applied and ready for daemon retry"} -->
## agent-loop issue resume resolution

This blocked failed issue has a matching manual resolution signal and may be retried.
```

这个 resolution signal 必须发在 issue comment，不是 PR comment。`agent-loop --status` 和 `agent-loop --doctor` 也会把它识别出来并报告出来。

## Self-Hosting（用 Agent Loop 开发 Agent Loop）

Issue body format is defined in [docs/issue-writing.md](docs/issue-writing.md).

Agent Loop 用自己的 Issues 管理自己的开发任务：

1. 在本仓库创建父 issue（tracking）和带 `dependsOn` 元数据的子 issue
2. 子 issue 编排完成后默认打上 `agent:ready`；由 daemon 基于依赖自动判断 claimability
3. 启动 daemon，指向本仓库：`--repo JamesWuHK/agent-loop`
4. Daemon 自动认领、规划、执行、提交 PR
5. Review PR → Merge → Issue 自动标记 `agent:done`

当 daemon 以 continuous mode 跑着，但看起来“没有继续消费”时，先做只读 queue audit：

```bash
cd apps/agent-daemon
bun run issues:audit -- --repo JamesWuHK/agent-loop
```

这条命令会复用 daemon 的同一套认证配置，所以也需要你已经配置好 `~/.agent-loop/config.json`、提供 `GH_TOKEN` / `GITHUB_TOKEN`，或先执行过 `gh auth login`。它只读取当前 open managed issues，输出 `state`、`claimable`、`blockedBy`、`errors` 等信息，帮助你判断是依赖未满足、contract 不完整，还是 ready 池本身为空。它不会自动修改 issue label、assignee 或 comment。

```
JamesWuHK/agent-loop
  Issues (agent:ready) ← daemon polling
         ↓
  Planning Agent → Subtasks
         ↓
  Claude Code → Changes
         ↓
  PR → Review → Merge
         ↓
  Issue (agent:done)
```

## Architecture

```
agent-loop/
├── apps/agent-daemon/     # Daemon process (bin: agent-loop)
│   └── src/
│       ├── daemon.ts          # Main loop (poll → claim → process)
│       ├── subtask-executor.ts # Planning agent + subtask loop + HEAD verify
│       ├── claimer.ts         # Atomic claim via GitHub assignee lock
│       ├── worktree-manager.ts # git worktree lifecycle + orphan cleanup
│       ├── agent-executor.ts  # Claude Code CLI runner
│       ├── pr-reporter.ts    # Idempotent PR creation
│       ├── config.ts          # Config loading
│       └── metrics.ts        # Prometheus metrics
│
└── packages/agent-shared/  # Shared types + GitHub API
    └── src/
        ├── types.ts           # Core types (AgentConfig, Subtask, etc.)
        ├── github-api.ts     # gh CLI wrapper (GraphQL + REST)
        ├── state-machine.ts   # Label-based state inference
        └── subtask-parser.ts  # Planning prompt + output parser
```

## Configuration

`~/.agent-loop/config.json`（自动生成，可手动编辑）：

```json
{
  "machineId": "uuid-v4",
  "repo": "owner/repo",
  "pat": "ghp_xxx",
  "pollIntervalMs": 60000,
  "concurrency": 1,
  "scheduling": {
    "concurrencyByRepo": {
      "JamesWuHK/digital-employee": 2
    },
    "concurrencyByProfile": {
      "desktop-vite": 1
    }
  },
  "project": {
    "profile": "generic"
  },
  "agent": {
    "primary": "claude",
    "fallback": null,
    "claudePath": "claude",
    "codexPath": "codex",
    "timeoutMs": 600000
  }
}
```

如果这里没有配置 `pat`，daemon 也会尝试复用本机 `gh auth login` 的登录态，相当于回退到 `gh auth token`。

当前 git 仓库也可以提交一份项目级配置：`./.agent-loop/project.json`。它适合存放“这个产品本身应该如何被 agent-loop 理解”的默认值，例如项目 profile、仓库级 prompt guidance、默认分支和推荐 agent。机器相关或带密钥的信息仍然只放在 `~/.agent-loop/config.json`。

```json
{
  "project": {
    "profile": "desktop-vite",
    "maxConcurrency": 2,
    "promptGuidance": {
      "implementation": [
        "Run desktop frontend tests via `bun --cwd apps/desktop test ...` so Vitest loads jsdom from apps/desktop/vite.config.ts."
      ]
    }
  },
  "agent": {
    "primary": "codex",
    "fallback": "claude"
  },
  "git": {
    "defaultBranch": "main"
  }
}
```

加载优先级：

- `--repo` / `--pat` / CLI 参数 与环境变量优先处理机器运行时配置
- `~/.agent-loop/config.json` 提供跨项目的默认值、本机 agent 路径，以及 `scheduling.concurrencyByRepo` / `scheduling.concurrencyByProfile`
- `./.agent-loop/project.json` 覆盖项目相关字段（例如 `project.profile`、`project.promptGuidance`、`project.maxConcurrency`、`agent.primary/fallback`、`git.defaultBranch`）

并发控制现在区分“请求值”和“生效值”：

- `concurrency` 是 daemon 请求的本地最大并发
- 生效并发 = `min(concurrency, repo cap, profile cap, project.maxConcurrency)`，其中不存在或非法的 cap 会被忽略
- daemon 的实际 claim / review / merge 调度使用生效并发，而不是只做观测

`project.profile` 用来告诉 daemon 当前要开发的产品大致属于哪种工程形态。当前内置：

- `generic`：默认值。适合大多数仓库，prompt 会优先强调“复用仓库已有的测试/构建/校验命令”，不假设前端框架。
- `desktop-vite`：给类似 `digital-employee` 这种桌面前端仓库用，会额外提示 agent 复用 `apps/desktop` 下的 `Vitest/jsdom` 测试入口。

如果你的项目是 Python、Go、Rust、Java 或其他技术栈，通常先用 `generic`，再通过 issue contract 里的 `Validation` 明确命令即可。后续也可以在 `project.promptGuidance` 里追加你自己的仓库级提示。

要让 repo-local 配置生效，请从目标产品仓库根目录启动 daemon，而不是从别的仓库目录代跑。

如果希望 daemon 在关闭当前终端或 Codex 对话窗口后仍继续运行，使用 `--daemonize` 从目标产品仓库根目录启动。运行实例记录和日志会写到 `~/.agent-loop/runtime/`，便于后续 `--stop`、排障和机器重启后的现场确认。

```bash
cd /path/to/product-repo
agent-loop --daemonize --health-port 9311 --metrics-port 9091

# 查看本地控制面
agent-loop --runtimes
agent-loop --logs
agent-loop --start
agent-loop --reconcile
agent-loop --restart
agent-loop --status
agent-loop --doctor
agent-loop --status --health-port 9311 --metrics-port 9091
agent-loop --doctor --health-port 9311 --metrics-port 9091

# 停止 / 启动 / 修复 同一个 repo/machine-id/health-port 对应的托管 daemon
agent-loop --start
agent-loop --reconcile
agent-loop --restart
agent-loop --stop
agent-loop --stop --health-port 9311
```

推荐语义：

- `--start`：把一个当前没在跑、但仍受 agent-loop 管理的 daemon 拉起来。对 `launchd` 会重新 load service；对 detached runtime 会重新拉起后台进程。
- `--reconcile`：做幂等恢复检查。如果 daemon 已经健康，它会直接返回 healthy；如果 runtime record 丢了、pid 变了或 service 没 load，会按当前 supervisor 自动修复。
- `--restart`：强制重启托管 daemon。
- `--stop`：停止托管 daemon。对 `launchd` 会 `bootout` 但保留 plist 和 runtime record，方便后续 `--status` / `--doctor` / `--start` 接回控制面。
- `--logs`：直接打印最近一段 daemon log，默认展示最近 200 行，不需要手工找 `~/.agent-loop/runtime/*.log`。

如果希望 daemon 在机器重启、用户重新登录之后也能自动恢复，macOS 上可以安装 `launchd` 服务：

```bash
cd /path/to/product-repo

# 安装并立即启动 launchd service
agent-loop --launchd-install --health-port 9311 --metrics-port 9091

# 查看 launchd service
agent-loop --launchd-status --health-port 9311

# 卸载 launchd service
agent-loop --launchd-uninstall --health-port 9311
```

`launchd` 模式会把 plist 写到 `~/Library/LaunchAgents/`，并继续复用 `~/.agent-loop/runtime/` 下的 runtime record 和日志，所以新打开的 Codex/终端仍可以用 `agent-loop --runtimes`、`--status`、`--doctor` 接回控制面。

如果 launchd daemon 被手动停掉、网络抖动后需要本地恢复，推荐先跑：

```bash
agent-loop --status --health-port 9311
agent-loop --doctor --health-port 9311
agent-loop --logs --health-port 9311
agent-loop --start --health-port 9311
```

现在 `--status` / `--doctor` 在 health endpoint 不通但本地还能识别出 runtime record 和 launchd service 时，会直接打印可执行的 `--start` / `--restart` 建议，而不是只告诉你 “daemon unreachable”。

如果是第二台电脑要加入同一个项目，推荐直接从目标产品仓库根目录运行：

```bash
agent-loop --join-project --machine-id macbook-pro-b --health-port 9312 --metrics-port 9092 --repo-cap 2
```

这个命令会：

- 解析当前仓库对应的 GitHub repo，并把本机 `machineId` / `repo` 写入 `~/.agent-loop/config.json`
- 可选把 `repo-cap` 一起写入 `scheduling.concurrencyByRepo`
- 校验当前机器是否已经具备 GitHub 认证能力
- macOS 默认安装并启动 `launchd` service；其他平台默认启动 detached daemon
- 输出固定的 `agent-loop --status ...` / `agent-loop --doctor ...` 命令，方便 agent 继续排障或验收

如果只想先看将要发生什么，不立刻写配置或启动 daemon，可以加 `--dry-run`。

## CLI Options

| Flag | Description |
|------|-------------|
| `--repo` | GitHub repo (owner/repo) |
| `--pat` | GitHub PAT；也可设置 `GITHUB_TOKEN` / `GH_TOKEN`，或复用 `gh auth login` |
| `--concurrency N` | Max concurrent agent tasks |
| `--poll-interval MS` | Poll interval (default: 60000ms) |
| `--machine-id` | Override machine ID |
| `--health-host HOST` | Health check host (default: 127.0.0.1) |
| `--join-project` | Persist machine config for the current repo and start a managed daemon on this machine |
| `--repo-cap N` | With `--join-project`, persist a repo-level concurrency cap for this repo in `~/.agent-loop/config.json` |
| `--daemonize` | Start the daemon detached from the current terminal |
| `--runtimes` | List local background daemon runtime records found on this machine |
| `--logs` | Print the recent local daemon log for the managed daemon matching repo/machine-id/health-port |
| `--start` | Start the managed daemon matching repo/machine-id/health-port if it is not already running |
| `--reconcile` | Reconcile and, if needed, repair the managed daemon matching repo/machine-id/health-port |
| `--restart` | Force-restart the managed daemon matching repo/machine-id/health-port |
| `--launchd-install` | Install and start a macOS launchd service for this daemon |
| `--launchd-uninstall` | Remove the macOS launchd service matching repo/machine-id/health-port |
| `--launchd-status` | Inspect the macOS launchd service matching repo/machine-id/health-port |
| `--stop` | Stop the managed daemon matching repo/machine-id/health-port |
| `--status` | Query the local daemon health + metrics summary and exit |
| `--doctor` | Query the local daemon and print a detailed diagnostic report |
| `--dry-run` | Simulate without making changes |
| `--once` | Run one cycle then exit |
| `--health-port PORT` | Health check port (default: 9310) |
| `--metrics-port PORT` | Prometheus metrics port (default: 9090) |

## State Machine

```
agent:ready    → claimed (assignee + label)
agent:claimed  → working (daemon starts)
agent:working  → done (PR created)
                → failed (agent error)
                → stale (daemon shutdown / 30min timeout)
agent:failed   → working (resume existing local worktree)
                → ready (auto requeue after cooldown when no local worktree / open PR remains)
agent:stale    → ready (re-enqueue)
```

## Health & Metrics

```bash
# Health check
curl http://127.0.0.1:9310/health

# Prometheus metrics
curl http://localhost:9090/metrics

# Human / agent friendly local diagnostics
agent-loop --status
agent-loop --doctor
```

`/health` 现在会返回：
- 当前项目 profile 和默认分支
- primary / fallback agent 选择
- requested / effective concurrency，以及 repo/profile/project cap 来源
- active worktrees、active PR reviews、in-flight issue/review loops
- startup recovery 是否仍在 pending（例如启动时 GitHub/网络暂时不可达）
- effective active task count（daemon 并发控制实际使用的值）
- failed issue resume attempt / cooldown 跟踪计数
- health / metrics endpoint 元信息，方便 `status` / `doctor` 自动发现

`/metrics` 现在额外暴露：
- `agent_loop_active_pr_reviews`
- `agent_loop_inflight_issue_processes`
- `agent_loop_inflight_pr_reviews`
- `agent_loop_startup_recovery_pending`
- `agent_loop_effective_active_tasks`
- `agent_loop_project_info`
- `agent_loop_concurrency_policy`
- `agent_loop_pr_reviews_total`
- `agent_loop_review_auto_fixes_total`
- `agent_loop_pr_merge_recovery_total`
- `agent_loop_polls_total`

职责边界建议：

- `/health` 保持为紧凑控制面摘要，适合 readiness / liveness 和快速判断 daemon 是否卡住
- `/metrics` 承载细粒度 outcome、counter 和趋势，适合 dashboard、告警和 agent 读数
- `agent-loop --status` / `agent-loop --doctor` 组合读取 `/health` + `/metrics`，给人和 agent 都提供可直接消费的排障视图

后台模式额外提供：

- `~/.agent-loop/runtime/*.json`：运行实例记录，便于本地 stop / 排障
- `~/.agent-loop/runtime/*.log`：daemon 标准输出与错误日志
- 从目标 repo 根目录执行 `agent-loop --logs` / `agent-loop --start` / `agent-loop --reconcile` / `agent-loop --restart` / `agent-loop --status` / `agent-loop --doctor` / `agent-loop --stop` 时，如果本机只有一个匹配的 runtime record，CLI 会自动发现对应 health/metrics 端口，不必手动再记一次端口号
- `agent-loop --runtimes` 可以让新打开的 Codex/终端会话快速找回当前机器上正在运行的 daemon 实例
- `launchd` service 会把 plist 写到 `~/Library/LaunchAgents/`，并沿用同一套 runtime record/log 路径，方便和 detached 模式统一排障

## Agent Loop Upgrade Channel

agent-loop 现在内置了一套“多机感知 + 空闲自升级”机制，目标是让参与开发的多台机器在发现新版本后尽快同步到最新版，并在升级完成后继续投入开发。

默认行为：

- daemon 会后台检查 `agent-loop` 自身仓库的目标 channel 最新版本与 commit
- `--status` / `--doctor` / `/health` 会显示本机 `agent-loop` 的本地版本、revision、upgrade 状态
- GitHub presence 心跳也会上报这些字段，所以 dashboard 和远端机器视图能直接看出谁落后、谁现在空闲可升
- 任意一台机器发现新版本后，会在 shared presence registry 里广播一个 upgrade announcement；其他机器会在下一次 presence 心跳周期内强制刷新本地 upgrade 状态，而不是死等自己的 `checkIntervalMs`
- 只有在 daemon 当前没有 startup recovery、active worktree、active lease、in-flight issue/review task 时，才会把 `safeToUpgradeNow` 标记为 `true`

默认策略可以在 `~/.agent-loop/config.json` 里配置：

```json
{
  "upgrade": {
    "enabled": true,
    "repo": "JamesWuHK/agent-loop",
    "channel": "master",
    "checkIntervalMs": 900000,
    "reminderIntervalMs": 3600000,
    "autoApply": false
  }
}
```

字段说明：

- `enabled`：是否启用升级检查
- `repo`：用于比较版本的 agent-loop 仓库 slug；不填时默认取当前 agent-loop 仓库 origin
- `channel`：跟踪的分支；不填时默认取目标仓库 default branch
- `checkIntervalMs`：后台检查最新版本的最小间隔
- `reminderIntervalMs`：升级提醒日志的冷却时间，避免刷屏
- `autoApply`：默认关闭；当本机 daemon 已空闲且本轮 poll 最终没有领到新活时，是否自动执行升级并重启托管 runtime

版本发布时，统一用下面的命令 bump 根版本号，避免手改：

```bash
bun run agent:version:bump patch
bun run agent:version:bump minor
bun run agent:version:bump major
bun run agent:version:bump set 0.2.0
```

开启 `upgrade.autoApply=true` 后，daemon 会在满足 `safeToUpgradeNow=true` 且本轮 poll 最终没有启动任何新任务时，自动执行下面的升级流程：

- 在本地 `agent-loop` checkout 上执行 `git pull --ff-only origin <channel>`
- 执行 `bun install --frozen-lockfile`
- `detached` runtime 会自举拉起新版后台进程，再退出旧进程
- `launchd` runtime 会优雅退出，让 launchd 自动拉起新版

保守限制：

- 只对托管 runtime 生效；`direct` 模式仍保持提醒，不会擅自接管你当前终端
- 本地 `agent-loop` checkout 有未提交改动时不会自动升级
- 当前 checkout 分支必须和配置的 `channel` 一致，避免开发分支被自动切回稳定分支

## Key Design Decisions

- **GitHub = coordination layer**: no shared DB; labels + assignee + comments are the state machine
- **Git worktree per issue**: no branch switching, no stale state
- **HEAD verification**: detects "exit 0 but no commit" false positives
- **Idempotent PRs**: check-before-create, safe to retry
- **Graceful shutdown**: SIGTERM marks active issues as `agent:stale`, preserves worktrees
