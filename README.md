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

这条命令会复用 daemon 的同一套认证配置，所以也需要你已经配置好 `~/.agent-loop/config.json`，或者先提供 `GH_TOKEN` / `GITHUB_TOKEN`。它只读取当前 open managed issues，输出 `state`、`claimable`、`blockedBy`、`errors` 等信息，帮助你判断是依赖未满足、contract 不完整，还是 ready 池本身为空。它不会自动修改 issue label、assignee 或 comment。

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
  "worktreesDir": "~/.agent-worktrees",
  "agent": {
    "primary": "claude",
    "fallback": null,
    "claudePath": "claude",
    "codexPath": "codex",
    "timeoutMs": 600000
  }
}
```

## CLI Options

| Flag | Description |
|------|-------------|
| `--repo` | GitHub repo (owner/repo) |
| `--pat` | GitHub PAT (or set `GITHUB_TOKEN`) |
| `--concurrency N` | Max concurrent agent tasks |
| `--poll-interval MS` | Poll interval (default: 60000ms) |
| `--machine-id` | Override machine ID |
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
agent:stale    → ready (re-enqueue)
```

## Health & Metrics

```bash
# Health check
curl http://127.0.0.1:9310/health

# Prometheus metrics
curl http://localhost:9090/metrics
```

## Key Design Decisions

- **GitHub = coordination layer**: no shared DB; labels + assignee + comments are the state machine
- **Git worktree per issue**: no branch switching, no stale state
- **HEAD verification**: detects "exit 0 but no commit" false positives
- **Idempotent PRs**: check-before-create, safe to retry
- **Graceful shutdown**: SIGTERM marks active issues as `agent:stale`, preserves worktrees
