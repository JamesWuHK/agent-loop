import { describe, expect, test } from 'bun:test'
import { buildManagedLeaseComment, type AgentConfig, type IssueComment, type ManagedLease } from '@agent/shared'
import { acquireManagedLease, getLeaseCommentsForScope, type LeaseApiAdapter } from './lease'

const TEST_CONFIG: AgentConfig = {
  machineId: 'machine-a',
  repo: 'JamesWuHK/agent-loop',
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

function buildLease(overrides: Partial<ManagedLease> = {}): ManagedLease {
  return {
    leaseId: 'lease-1',
    scope: 'issue-process',
    issueNumber: 77,
    machineId: 'machine-a',
    daemonInstanceId: 'daemon-a',
    branch: 'agent/77/machine-a',
    worktreeId: 'issue-77-machine-a',
    phase: 'planning',
    startedAt: '2026-04-05T08:00:00.000Z',
    lastHeartbeatAt: '2026-04-05T08:00:30.000Z',
    expiresAt: '2099-04-05T08:01:00.000Z',
    attempt: 1,
    lastProgressAt: '2026-04-05T08:00:30.000Z',
    lastProgressKind: 'phase',
    status: 'active',
    ...overrides,
  }
}

function buildComment(commentId: number, lease: ManagedLease, createdAt = '2026-04-05T08:00:00.000Z'): IssueComment {
  return {
    commentId,
    body: buildManagedLeaseComment(lease),
    createdAt,
    updatedAt: createdAt,
  }
}

function createFakeLeaseApi(initialComments: IssueComment[] = [], afterCreateList?: () => IssueComment[]): {
  api: LeaseApiAdapter
  comments: IssueComment[]
} {
  const comments = [...initialComments]
  let nextCommentId = Math.max(0, ...comments.map((comment) => comment.commentId)) + 1
  let created = false

  const api: LeaseApiAdapter = {
    async listIssueComments() {
      if (created && afterCreateList) {
        return afterCreateList().map((comment) => ({ ...comment }))
      }
      return comments.map((comment) => ({ ...comment }))
    },
    async createManagedLeaseComment(_issueNumber, lease) {
      created = true
      const createdComment = buildComment(
        nextCommentId++,
        lease,
        '2026-04-05T08:00:10.000Z',
      )
      comments.push(createdComment)
      return { ...createdComment }
    },
    async updateManagedLeaseComment(commentId, lease) {
      const index = comments.findIndex((comment) => comment.commentId === commentId)
      const updated = buildComment(commentId, lease, comments[index]?.createdAt ?? '2026-04-05T08:00:10.000Z')
      updated.updatedAt = '2026-04-05T08:00:20.000Z'
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

describe('lease acquisition', () => {
  test('blocks when another daemon still holds an active lease', async () => {
    const foreign = buildComment(11, buildLease({
      machineId: 'machine-b',
      daemonInstanceId: 'daemon-b',
    }))
    const { api } = createFakeLeaseApi([foreign])

    const result = await acquireManagedLease({
      targetNumber: 77,
      scope: 'issue-process',
      daemonInstanceId: 'daemon-a',
      machineId: 'machine-a',
      config: TEST_CONFIG,
      phase: 'planning',
      issueNumber: 77,
      api,
    })

    expect(result.status).toBe('blocked')
    if (result.status !== 'blocked') return
    expect(result.activeLease?.commentId).toBe(11)
  })

  test('reuses a self-held active lease without creating a new comment', async () => {
    const existing = buildComment(11, buildLease())
    const { api, comments } = createFakeLeaseApi([existing])

    const result = await acquireManagedLease({
      targetNumber: 77,
      scope: 'issue-process',
      daemonInstanceId: 'daemon-a',
      machineId: 'machine-a',
      config: TEST_CONFIG,
      phase: 'issue-recovery',
      issueNumber: 77,
      api,
    })

    expect(result.status).toBe('acquired')
    if (result.status !== 'acquired') return
    expect(result.adopted).toBe(true)
    expect(result.handle.getCommentId()).toBe(11)
    expect(result.handle.getSnapshot().phase).toBe('issue-recovery')
    expect(comments).toHaveLength(1)
    await result.handle.complete('released')
  })

  test('releases its freshly-created lease if another canonical lease wins after creation', async () => {
    const foreign = buildComment(
      10,
      buildLease({
        leaseId: 'lease-foreign',
        machineId: 'machine-b',
        daemonInstanceId: 'daemon-b',
      }),
      '2026-04-05T08:00:00.000Z',
    )
    const { api, comments } = createFakeLeaseApi([], () => [foreign, ...comments])

    const result = await acquireManagedLease({
      targetNumber: 77,
      scope: 'issue-process',
      daemonInstanceId: 'daemon-a',
      machineId: 'machine-a',
      config: TEST_CONFIG,
      phase: 'planning',
      issueNumber: 77,
      api,
    })

    expect(result.status).toBe('blocked')
    if (result.status !== 'blocked') return
    expect(result.activeLease?.commentId).toBe(10)
    expect(comments.at(-1)?.body).toContain('"status":"released"')
    expect(comments.at(-1)?.body).toContain('lease-conflict-with-comment-10')
  })

  test('updates heartbeat and terminal status through the injected API', async () => {
    const { api, comments } = createFakeLeaseApi([])

    const result = await acquireManagedLease({
      targetNumber: 77,
      scope: 'issue-process',
      daemonInstanceId: 'daemon-a',
      machineId: 'machine-a',
      config: TEST_CONFIG,
      phase: 'planning',
      issueNumber: 77,
      api,
    })

    expect(result.status).toBe('acquired')
    if (result.status !== 'acquired') return

    await result.handle.flushHeartbeat()
    expect(comments[0]?.body).toContain('"status":"active"')

    await result.handle.complete('recoverable', 'idle-timeout')
    expect(comments[0]?.body).toContain('"status":"recoverable"')
    expect(comments[0]?.body).toContain('"recoveryReason":"idle-timeout"')
  })
})

describe('lease comment queries', () => {
  test('returns only comments for the requested scope', async () => {
    const { api } = createFakeLeaseApi([
      buildComment(11, buildLease({ scope: 'issue-process' })),
      buildComment(12, buildLease({ scope: 'pr-review', prNumber: 88 })),
    ])

    const issueLeases = await getLeaseCommentsForScope(77, 'issue-process', TEST_CONFIG, api)
    const prLeases = await getLeaseCommentsForScope(77, 'pr-review', TEST_CONFIG, api)

    expect(issueLeases).toHaveLength(1)
    expect(issueLeases[0]?.lease.scope).toBe('issue-process')
    expect(prLeases).toHaveLength(1)
    expect(prLeases[0]?.lease.scope).toBe('pr-review')
  })
})
