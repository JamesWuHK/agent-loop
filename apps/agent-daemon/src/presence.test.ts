import { describe, expect, test } from 'bun:test'
import type { AgentConfig, IssueComment } from '@agent/shared'
import {
  buildManagedDaemonPresenceComment,
  extractManagedDaemonPresenceIssueNumber,
  extractManagedDaemonPresenceComment,
  listActiveManagedDaemonPresenceComments,
  ManagedDaemonPresencePublisher,
  type ManagedDaemonPresence,
  type PresenceApiAdapter,
} from './presence'

const TEST_CONFIG: AgentConfig = {
  machineId: 'machine-a',
  repo: 'JamesWuHK/digital-employee',
  pat: 'ghp_test',
  pollIntervalMs: 60_000,
  concurrency: 1,
  requestedConcurrency: 1,
  concurrencyPolicy: {
    requested: 1,
    effective: 1,
    repoCap: null,
    profileCap: null,
    projectCap: null,
  },
  scheduling: {
    concurrencyByRepo: {},
    concurrencyByProfile: {},
  },
  recovery: {
    heartbeatIntervalMs: 30_000,
    leaseTtlMs: 60_000,
    workerIdleTimeoutMs: 300_000,
    leaseAdoptionBackoffMs: 5_000,
    leaseNoProgressTimeoutMs: 360_000,
  },
  worktreesBase: '/tmp/agent-loop-test',
  project: {
    profile: 'generic',
  },
  agent: {
    primary: 'codex',
    fallback: null,
    claudePath: 'claude',
    codexPath: 'codex',
    timeoutMs: 60_000,
  },
  git: {
    defaultBranch: 'main',
    authorName: 'agent-loop',
    authorEmail: 'agent-loop@local',
  },
}

function buildPresence(overrides: Partial<ManagedDaemonPresence> = {}): ManagedDaemonPresence {
  return {
    repo: 'JamesWuHK/digital-employee',
    machineId: 'machine-a',
    daemonInstanceId: 'daemon-a',
    status: 'idle',
    startedAt: '2026-04-05T08:00:00.000Z',
    lastHeartbeatAt: '2026-04-05T08:00:30.000Z',
    expiresAt: '2026-04-05T08:02:00.000Z',
    healthPort: 9312,
    metricsPort: 9092,
    activeLeaseCount: 0,
    activeWorktreeCount: 0,
    effectiveActiveTasks: 0,
    buildInfo: null,
    ...overrides,
  }
}

function buildComment(commentId: number, presence: ManagedDaemonPresence): IssueComment {
  return {
    commentId,
    body: buildManagedDaemonPresenceComment(presence),
    createdAt: presence.startedAt,
    updatedAt: presence.lastHeartbeatAt,
  }
}

function createFakePresenceApi(initialComments: IssueComment[] = []): {
  api: PresenceApiAdapter
  comments: IssueComment[]
} {
  const comments = [...initialComments]
  let nextCommentId = Math.max(0, ...comments.map((comment) => comment.commentId)) + 1

  const api: PresenceApiAdapter = {
    async ensurePresenceIssue() {
      return 500
    },
    async listIssueComments() {
      return comments.map((comment) => ({ ...comment }))
    },
    async commentOnIssue(_issueNumber, body) {
      const created: IssueComment = {
        commentId: nextCommentId++,
        body,
        createdAt: '2026-04-05T08:00:00.000Z',
        updatedAt: '2026-04-05T08:00:00.000Z',
      }
      comments.push(created)
      return { ...created }
    },
    async updateIssueComment(commentId, body) {
      const index = comments.findIndex((comment) => comment.commentId === commentId)
      const updated: IssueComment = {
        commentId,
        body,
        createdAt: comments[index]?.createdAt ?? '2026-04-05T08:00:00.000Z',
        updatedAt: '2026-04-05T08:00:30.000Z',
      }
      if (index >= 0) {
        comments[index] = updated
      } else {
        comments.push(updated)
      }
      return { ...updated }
    },
  }

  return { api, comments }
}

describe('managed daemon presence helpers', () => {
  test('round-trips managed daemon presence comments', () => {
    const presence = buildPresence()
    const body = buildManagedDaemonPresenceComment(presence)

    expect(extractManagedDaemonPresenceComment(body)).toEqual(presence)
  })

  test('keeps parsing legacy presence comments that do not include build info', () => {
    const legacyBody = `<!-- agent-loop:presence {"repo":"JamesWuHK/digital-employee","machineId":"machine-a","daemonInstanceId":"daemon-a","status":"idle","startedAt":"2026-04-05T08:00:00.000Z","lastHeartbeatAt":"2026-04-05T08:00:30.000Z","expiresAt":"2026-04-05T08:02:00.000Z","healthPort":9312,"metricsPort":9092,"activeLeaseCount":0,"activeWorktreeCount":0,"effectiveActiveTasks":0} -->
## Managed daemon presence`

    expect(extractManagedDaemonPresenceComment(legacyBody)).toMatchObject({
      machineId: 'machine-a',
      buildInfo: null,
    })
  })

  test('filters active managed daemon presence comments by repo and expiry', () => {
    const comments = [
      buildComment(11, buildPresence({
        machineId: 'machine-a',
        lastHeartbeatAt: '2026-04-05T08:00:30.000Z',
        expiresAt: '2026-04-05T08:02:00.000Z',
      })),
      buildComment(12, buildPresence({
        machineId: 'machine-b',
        status: 'stopped',
      })),
      buildComment(13, buildPresence({
        repo: 'JamesWuHK/another-repo',
      })),
      buildComment(14, buildPresence({
        machineId: 'machine-c',
        expiresAt: '2026-04-05T08:00:10.000Z',
      })),
    ]

    const active = listActiveManagedDaemonPresenceComments(
      comments,
      'JamesWuHK/digital-employee',
      Date.parse('2026-04-05T08:01:00.000Z'),
    )

    expect(active).toHaveLength(1)
    expect(active[0]?.presence.machineId).toBe('machine-a')
  })

  test('finds the managed presence registry issue from REST issue pages', () => {
    expect(extractManagedDaemonPresenceIssueNumber([
      {
        number: 41,
        title: 'Unrelated issue',
        body: 'no marker here',
      },
      {
        number: 42,
        title: 'Agent Loop Presence',
        body: 'registry body',
      },
    ])).toBe(42)

    expect(extractManagedDaemonPresenceIssueNumber([
      {
        number: 43,
        title: 'Agent Loop Presence',
        body: 'registry body',
        pull_request: {},
      },
      {
        number: 44,
        title: 'Infra',
        body: '<!-- agent-loop:presence-registry -->',
      },
    ])).toBe(44)
  })
})

describe('managed daemon presence publisher', () => {
  test('publishes idle, busy, and stopped presence updates through the injected API', async () => {
    const { api, comments } = createFakePresenceApi()
    const runtime = {
      activeLeaseCount: 0,
      activeWorktreeCount: 0,
      effectiveActiveTasks: 0,
    }

    const publisher = new ManagedDaemonPresencePublisher({
      config: TEST_CONFIG,
      daemonInstanceId: 'daemon-a',
      healthPort: 9312,
      metricsPort: 9092,
      api,
      readRuntimeState: () => runtime,
    })

    await publisher.start()
    expect(comments).toHaveLength(1)
    expect(comments[0]?.body).toContain('"status":"idle"')

    runtime.activeLeaseCount = 1
    runtime.activeWorktreeCount = 1
    runtime.effectiveActiveTasks = 1

    await publisher.flushHeartbeat()
    expect(comments).toHaveLength(1)
    expect(comments[0]?.body).toContain('"status":"busy"')
    expect(comments[0]?.body).toContain('"activeLeaseCount":1')

    await publisher.stop()
    expect(comments[0]?.body).toContain('"status":"stopped"')
  })
})
