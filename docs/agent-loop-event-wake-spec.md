# Agent Loop Event Wake Spec

- Status: draft
- Owner: engineering
- Last updated: 2026-04-10
- Related: `docs/issue-writing.md`, `.github/workflows/agent-ready-gate.yml`

## Summary

Today `agent-loop` primarily discovers work by polling GitHub on a schedule. That is reliable enough, but it creates avoidable idle scans, increases GraphQL pressure, and makes the daemon slower to react when GitHub is slow.

This document proposes a hybrid model:

- GitHub Actions detect issue and PR events
- a self-hosted runner on the target machine invokes a local wake command
- the local daemon performs a targeted reconcile
- low-frequency polling remains as a safety net

This is a design draft only. It does not change the current daemon behavior by itself.

## Goals

1. Prefer event-driven wakeups over high-frequency repo scans.
2. Reduce GitHub GraphQL usage during idle periods.
3. Keep GitHub as the coordination layer for issue, PR, lease, and label state.
4. Avoid exposing the local daemon directly to the public internet.
5. Preserve recovery behavior when events are dropped or machines restart.

## Non-goals

- Replacing GitHub as the coordination layer
- Removing polling entirely
- Adding a central database or always-on relay service
- Reworking the existing lease, worktree, or recovery model in the first phase

## Current Pain Points

- Idle daemons still scan the repo to discover new work.
- Startup recovery and full poll cycles are expensive when GitHub is slow.
- GraphQL quotas are consumed even when there is no actionable work.
- Actions can validate issue state today, but they do not wake a local daemon.

## Proposed Architecture

```text
GitHub issue / PR event
  -> GitHub Actions workflow
  -> self-hosted runner on target machine
  -> local command: agent-loop --wake-issue / --wake-pr / --wake-now
  -> append durable wake request locally
  -> notify local daemon over loopback
  -> daemon performs targeted reconcile

fallback:
  low-frequency poll
  + startup recovery on restart
```

Key decisions:

- Prefer `self-hosted` runners for cloud-to-local delivery.
- Do not depend on `repository_dispatch` as the final hop to the daemon.
- Do not expose a public webhook endpoint to the local machine in phase 1.

## Event Matrix

| Source | Condition | Wake |
| --- | --- | --- |
| `issues` | issue labeled `agent:ready` | `--wake-issue <issue>` |
| `issues` | issue edited while still actionable | `--wake-issue <issue>` |
| `pull_request` | opened, reopened, ready for review | `--wake-pr <pr>` |
| `pull_request` | synchronize | `--wake-pr <pr>` |
| `pull_request` | review or merge label changes | `--wake-pr <pr>` |
| `issue_comment` | structured unblock or feedback event | issue- or PR-targeted wake |
| `workflow_dispatch` | manual operations | `--wake-now` |

The workflow should avoid turning every event into a full repo reconcile.

## Local Wake Contract

Recommended CLI:

```bash
agent-loop --wake-now
agent-loop --wake-issue 374
agent-loop --wake-pr 381
```

Recommended request shape:

```json
{
  "kind": "issue",
  "issueNumber": 374,
  "reason": "issues.labeled:agent:ready",
  "sourceEvent": "issues.labeled",
  "dedupeKey": "issues:labeled:374:agent:ready",
  "requestedAt": "2026-04-10T03:40:00.000Z"
}
```

Suggested local queue path:

```text
~/.agent-loop/wake-queue/{owner}-{repo}/{machineId}.jsonl
```

Behavior:

- CLI writes a durable wake request first.
- CLI then best-effort notifies the local daemon.
- The daemon drains the queue on startup and during normal operation.
- Duplicate wake requests are coalesced by `dedupeKey` in a short debounce window.

## Local API

Recommended loopback-only endpoint:

```text
POST /wake
```

Constraints:

- bind only to `127.0.0.1`
- accept authenticated local requests only if an auth layer is needed later
- never require this endpoint for durability; queue-first remains the source of truth

## Routing

Phase 1 should stay conservative:

- one repo maps to one default runner target, or one primary machine
- one GitHub event wakes one machine
- lease adoption and issue claiming still rely on GitHub state, not workflow decisions

Possible future routing:

- hash by issue number
- route by project profile
- route by issue/PR type

## Polling Strategy After Wake Support

Wake support should reduce, not eliminate, polling.

Recommended behavior:

- keep startup recovery unchanged
- keep a slower full poll as a safety net
- prefer targeted reconcile immediately after a wake
- reserve full scans for recovery, drift correction, and missed events

## Impact on GraphQL Limits

This design should materially reduce GraphQL pressure because idle discovery moves from periodic full scans to targeted wakeups. It does not remove GraphQL usage completely, because startup recovery, fallback polling, and some coordination flows still need GitHub reads.

In practice, this should help with rate limits, but it is not a full replacement for timeout handling, REST fallbacks, and scoped recovery reads.

## Rollout

1. Add CLI wake commands and a durable local wake queue.
2. Add a loopback wake endpoint in the daemon.
3. Add a GitHub Actions workflow that routes events to self-hosted runners.
4. Reduce idle poll frequency after wake delivery is stable.
5. Measure wake latency, missed-event recovery, and GraphQL consumption.

## Acceptance

- actionable issue and PR events wake the target machine in seconds to low minutes
- daemon still recovers correctly after restart with no event loss
- missed events are eventually healed by fallback polling
- idle GraphQL usage drops meaningfully versus the current high-frequency polling model
