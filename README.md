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

# Configure — daemon 将消费本仓库的 Issues
agent-loop --repo JamesWuHK/agent-loop --pat ghp_xxx --machine-id my-dev-machine
# 或先 gh auth login，daemon 会自动复用 gh auth token

# Run (持续轮询)
agent-loop

# 或一次性验证模式
agent-loop --once
```

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

## CLI Options

| Flag | Description |
|------|-------------|
| `--repo` | GitHub repo (owner/repo) |
| `--pat` | GitHub PAT；也可设置 `GITHUB_TOKEN` / `GH_TOKEN`，或复用 `gh auth login` |
| `--concurrency N` | Max concurrent agent tasks |
| `--poll-interval MS` | Poll interval (default: 60000ms) |
| `--machine-id` | Override machine ID |
| `--health-host HOST` | Health check host (default: 127.0.0.1) |
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

## Key Design Decisions

- **GitHub = coordination layer**: no shared DB; labels + assignee + comments are the state machine
- **Git worktree per issue**: no branch switching, no stale state
- **HEAD verification**: detects "exit 0 but no commit" false positives
- **Idempotent PRs**: check-before-create, safe to retry
- **Graceful shutdown**: SIGTERM marks active issues as `agent:stale`, preserves worktrees
