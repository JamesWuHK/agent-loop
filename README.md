# Agent Loop

**Distributed automation daemon** — GitHub Issues as a task queue, Claude Code as the executor.

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
# Install dependencies
bun install

# Configure (creates ~/.agent-loop/config.json)
agent-loop --repo owner/repo --pat ghp_xxx

# Run
agent-loop

# Or one-shot mode (for CI/testing)
agent-loop --once
```

## Configuration

Config file: `~/.agent-loop/config.json`

```json
{
  "machineId": "uuid-v4",
  "repo": "owner/repo",
  "pat": "ghp_xxx",
  "pollIntervalMs": 60000,
  "concurrency": 2,
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

## Architecture

```
apps/agent-daemon/     # Daemon process
  src/
    daemon.ts          # Main loop (poll → claim → process)
    claimer.ts         # Atomic claim via GitHub assignee lock
    worktree-manager.ts # git worktree lifecycle + orphan cleanup
    subtask-executor.ts # Planning agent + sequential subtask loop
    agent-executor.ts  # Claude Code CLI runner
    pr-reporter.ts     # Idempotent PR creation
    config.ts          # Config loading

packages/agent-shared/ # Shared types + GitHub API
  src/
    types.ts           # Core types (AgentConfig, Subtask, etc.)
    github-api.ts      # gh CLI wrapper (GraphQL + REST)
    state-machine.ts   # Label-based state inference
    subtask-parser.ts  # Planning prompt + output parser
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
