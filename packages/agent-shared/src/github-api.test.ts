import { describe, expect, test } from 'bun:test'
import {
  applyDependencyClaimability,
  buildListOpenIssuesQuery,
  buildManagedLeaseComment,
  buildGhEnv,
  canDaemonAdoptManagedLease,
  deriveIssueStateFromRaw,
  extractOpenIssueConnectionPage,
  extractManagedLeaseComment,
  getActiveManagedLease,
  getLatestManagedLease,
  isManagedLeaseExpired,
  parseManagedLeaseComments,
  parseGhApiErrorMessage,
  parseMergePrResponse,
  shouldClearIssueAssigneesForStateLabel,
} from './github-api'
import { ISSUE_LABELS } from './types'

describe('buildGhEnv', () => {
  test('removes proxy variables and injects GitHub auth tokens', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
    process.env.http_proxy = 'http://127.0.0.1:7890'
    process.env.NO_PROXY = '127.0.0.1,localhost'

    const env = buildGhEnv({ pat: 'ghp_test' })

    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.http_proxy).toBeUndefined()
    expect(env.NO_PROXY).toBe('127.0.0.1,localhost')
    expect(env.GH_TOKEN).toBe('ghp_test')
    expect(env.GITHUB_TOKEN).toBe('ghp_test')
  })
})

describe('parseGhApiErrorMessage', () => {
  test('prefers JSON message from stdout when present', () => {
    expect(parseGhApiErrorMessage('{"message":"Pull Request is not mergeable"}', '')).toBe(
      'Pull Request is not mergeable',
    )
  })

  test('falls back to stderr when stdout is empty', () => {
    expect(parseGhApiErrorMessage('', 'gh: GraphQL error')).toBe('gh: GraphQL error')
  })
})

describe('parseMergePrResponse', () => {
  test('parses successful merge responses', () => {
    expect(parseMergePrResponse('{"merged":true,"message":"Pull Request successfully merged","sha":"abc123"}')).toEqual({
      merged: true,
      message: 'Pull Request successfully merged',
      sha: 'abc123',
    })
  })

  test('surfaces non-merged API responses', () => {
    expect(parseMergePrResponse('{"merged":false,"message":"Pull Request is not mergeable"}')).toEqual({
      merged: false,
      message: 'Pull Request is not mergeable',
      sha: undefined,
    })
  })
})

describe('deriveIssueStateFromRaw', () => {
  test('treats closed issues as done even if stale labels remain', () => {
    expect(deriveIssueStateFromRaw(['agent:failed'], 'closed')).toBe('done')
  })

  test('treats GitHub GraphQL CLOSED states as done even if stale labels remain', () => {
    expect(deriveIssueStateFromRaw(['agent:failed'], 'CLOSED')).toBe('done')
  })

  test('still infers state from labels for open issues', () => {
    expect(deriveIssueStateFromRaw(['agent:failed'], 'open')).toBe('failed')
  })
})

describe('open issue pagination helpers', () => {
  test('builds an open-issues query with cursor pagination metadata', () => {
    const query = buildListOpenIssuesQuery('JamesWuHK', 'digital-employee')

    expect(query).toContain('query($cursor: String)')
    expect(query).toContain('after: $cursor')
    expect(query).toContain('pageInfo {')
    expect(query).toContain('hasNextPage')
    expect(query).toContain('endCursor')
  })

  test('extracts paginated open issue nodes and pageInfo from GraphQL responses', () => {
    expect(extractOpenIssueConnectionPage({
      data: {
        repository: {
          issues: {
            nodes: [
              {
                number: 92,
                title: '[CI-C1] 固定会话入口 smoke tests',
                body: 'body',
                state: 'OPEN',
                updatedAt: '2026-04-05T08:57:45Z',
                labels: { nodes: [{ name: 'agent:failed' }] },
                assignees: { nodes: [] },
              },
            ],
            pageInfo: {
              hasNextPage: true,
              endCursor: 'cursor-2',
            },
          },
        },
      },
    })).toEqual({
      nodes: [
        {
          number: 92,
          title: '[CI-C1] 固定会话入口 smoke tests',
          body: 'body',
          state: 'OPEN',
          updatedAt: '2026-04-05T08:57:45Z',
          labels: { nodes: [{ name: 'agent:failed' }] },
          assignees: { nodes: [] },
        },
      ],
      hasNextPage: true,
      endCursor: 'cursor-2',
    })

    expect(extractOpenIssueConnectionPage({})).toEqual({
      nodes: [],
      hasNextPage: false,
      endCursor: null,
    })
  })
})

describe('shouldClearIssueAssigneesForStateLabel', () => {
  test('clears assignees when re-queueing an issue into agent:ready', () => {
    expect(shouldClearIssueAssigneesForStateLabel(ISSUE_LABELS.READY)).toBe(true)
  })

  test('keeps assignees intact for in-progress managed states', () => {
    expect(shouldClearIssueAssigneesForStateLabel(ISSUE_LABELS.CLAIMED)).toBe(false)
    expect(shouldClearIssueAssigneesForStateLabel(ISSUE_LABELS.WORKING)).toBe(false)
    expect(shouldClearIssueAssigneesForStateLabel(ISSUE_LABELS.FAILED)).toBe(false)
  })
})

describe('applyDependencyClaimability', () => {
  test('blocks ready issues that do not have an executable contract', () => {
    const [issue] = applyDependencyClaimability([
      {
        number: 46,
        title: 'bad issue',
        body: '## 用户故事\nx',
        state: 'ready',
        labels: ['agent:ready'],
        assignee: null,
        isClaimable: true,
        updatedAt: '2026-04-04T00:00:00Z',
        dependencyIssueNumbers: [],
        hasDependencyMetadata: false,
        dependencyParseError: false,
        claimBlockedBy: [],
        hasExecutableContract: false,
        contractValidationErrors: ['missing ## 实现步骤 / Implementation Steps'],
      },
    ])

    expect(issue?.isClaimable).toBe(false)
    expect(issue?.hasExecutableContract).toBe(false)
    expect(issue?.contractValidationErrors).toEqual(['missing ## 实现步骤 / Implementation Steps'])
  })

  test('keeps valid ready issues claimable when dependencies are satisfied', () => {
    const [issue] = applyDependencyClaimability([
      {
        number: 47,
        title: 'good issue',
        body: 'valid',
        state: 'ready',
        labels: ['agent:ready'],
        assignee: null,
        isClaimable: true,
        updatedAt: '2026-04-04T00:00:00Z',
        dependencyIssueNumbers: [],
        hasDependencyMetadata: true,
        dependencyParseError: false,
        claimBlockedBy: [],
        hasExecutableContract: true,
        contractValidationErrors: [],
      },
    ])

    expect(issue?.isClaimable).toBe(true)
    expect(issue?.claimBlockedBy).toEqual([])
  })
})

describe('managed lease helpers', () => {
  const activeLease = {
    leaseId: 'lease-1',
    scope: 'issue-process' as const,
    issueNumber: 77,
    machineId: 'machine-a',
    daemonInstanceId: 'daemon-a',
    branch: 'agent/77/machine-a',
    worktreeId: 'issue-77-machine-a',
    phase: 'planning',
    startedAt: '2026-04-05T08:00:00.000Z',
    lastHeartbeatAt: '2026-04-05T08:00:30.000Z',
    expiresAt: '2026-04-05T08:01:00.000Z',
    attempt: 1,
    lastProgressAt: '2026-04-05T08:00:30.000Z',
    lastProgressKind: 'phase' as const,
    status: 'active' as const,
  }

  test('round-trips managed lease comments', () => {
    const body = buildManagedLeaseComment(activeLease)

    expect(extractManagedLeaseComment(body)).toEqual(activeLease)
  })

  test('parses scoped lease comments and ignores invalid comments', () => {
    const comments = parseManagedLeaseComments([
      {
        commentId: 10,
        body: buildManagedLeaseComment(activeLease),
        createdAt: '2026-04-05T08:00:00.000Z',
        updatedAt: '2026-04-05T08:00:30.000Z',
      },
      {
        commentId: 11,
        body: 'not a lease',
        createdAt: '2026-04-05T08:00:00.000Z',
        updatedAt: '2026-04-05T08:00:00.000Z',
      },
    ], 'issue-process')

    expect(comments).toHaveLength(1)
    expect(comments[0]?.lease.leaseId).toBe('lease-1')
  })

  test('picks the earliest unexpired active lease as canonical', () => {
    const comments = [
      {
        commentId: 12,
        body: buildManagedLeaseComment({
          ...activeLease,
          leaseId: 'lease-2',
          daemonInstanceId: 'daemon-b',
          startedAt: '2026-04-05T08:00:05.000Z',
        }),
        createdAt: '2026-04-05T08:00:05.000Z',
        updatedAt: '2026-04-05T08:00:05.000Z',
      },
      {
        commentId: 11,
        body: buildManagedLeaseComment(activeLease),
        createdAt: '2026-04-05T08:00:00.000Z',
        updatedAt: '2026-04-05T08:00:30.000Z',
      },
    ]

    expect(getActiveManagedLease(comments, 'issue-process', Date.parse('2026-04-05T08:00:45.000Z'))?.commentId).toBe(11)
    expect(getLatestManagedLease(comments, 'issue-process')?.commentId).toBe(11)
  })

  test('treats expired leases as adoptable by other daemons', () => {
    const expired = {
      commentId: 11,
      body: buildManagedLeaseComment(activeLease),
      createdAt: '2026-04-05T08:00:00.000Z',
      updatedAt: '2026-04-05T08:00:30.000Z',
      lease: activeLease,
    }

    expect(isManagedLeaseExpired(activeLease, Date.parse('2026-04-05T08:01:01.000Z'))).toBe(true)
    expect(canDaemonAdoptManagedLease(expired, 'daemon-b', Date.parse('2026-04-05T08:01:01.000Z'))).toBe(true)
    expect(canDaemonAdoptManagedLease(expired, 'daemon-b', Date.parse('2026-04-05T08:00:45.000Z'))).toBe(false)
    expect(canDaemonAdoptManagedLease(expired, 'daemon-a', Date.parse('2026-04-05T08:00:45.000Z'))).toBe(true)
  })
})
