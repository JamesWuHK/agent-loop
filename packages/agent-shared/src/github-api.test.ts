import { describe, expect, test } from 'bun:test'
import {
  applyDependencyClaimability,
  buildListOpenIssuesQuery,
  buildDirectGitHubApiRequest,
  buildManagedLeaseComment,
  buildGhEnv,
  canDaemonAdoptManagedLease,
  derivePullRequestStateFromRaw,
  deriveIssueStateFromRaw,
  extractNextPageUrl,
  extractRestOpenIssueListPage,
  extractRestPullRequest,
  extractRestPullRequestListPage,
  extractOpenIssueConnectionPage,
  extractManagedLeaseComment,
  getActiveManagedLease,
  getLatestManagedLease,
  getPullRequestChecksStatus,
  interpretPullRequestChecksResult,
  isGraphQlRateLimitErrorMessage,
  isManagedLeaseExpired,
  isManagedLeaseProgressStale,
  mergePaginatedRestBodies,
  parseManagedLeaseComments,
  parseGhApiErrorMessage,
  parseMergePrResponse,
  qualifyGhApiArgs,
  ghApiRaw,
  setGitHubApiRequestObserver,
  sortClaimableIssuesForScheduling,
  shouldClearIssueAssigneesForStateLabel,
} from './github-api'
import { ISSUE_LABELS, ISSUE_PRIORITY_LABELS, type AgentConfig, type AgentIssue } from './types'

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

  test('leaves GitHub auth env unset when no PAT is configured', () => {
    process.env.GH_TOKEN = 'stale-token'
    process.env.GITHUB_TOKEN = 'stale-token'

    const env = buildGhEnv({ pat: '' })

    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
  })
})

describe('qualifyGhApiArgs', () => {
  test('prefixes repo-relative REST endpoints with repos/<owner>/<repo>/', () => {
    expect(qualifyGhApiArgs(
      ['issues/334/comments'],
      { repo: 'JamesWuHK/digital-employee' },
    )).toEqual(['repos/JamesWuHK/digital-employee/issues/334/comments'])

    expect(qualifyGhApiArgs(
      ['pulls?state=open&page=1'],
      { repo: 'JamesWuHK/digital-employee' },
    )).toEqual(['repos/JamesWuHK/digital-employee/pulls?state=open&page=1'])
  })

  test('leaves graphql and fully-qualified endpoints unchanged', () => {
    expect(qualifyGhApiArgs(
      ['graphql', '--raw-field', 'query=query { viewer { login } }'],
      { repo: 'JamesWuHK/digital-employee' },
    )).toEqual(['graphql', '--raw-field', 'query=query { viewer { login } }'])

    expect(qualifyGhApiArgs(
      ['repos/JamesWuHK/digital-employee/issues/334/comments'],
      { repo: 'JamesWuHK/digital-employee' },
    )).toEqual(['repos/JamesWuHK/digital-employee/issues/334/comments'])
  })
})

describe('buildDirectGitHubApiRequest', () => {
  test('converts graphql raw fields into a direct GraphQL payload', () => {
    const request = buildDirectGitHubApiRequest(
      [
        'graphql',
        '--raw-field',
        'query=query($cursor: String) { viewer { login } }',
        '--raw-field',
        'cursor=cursor-2',
      ],
      { repo: 'JamesWuHK/digital-employee' },
    )

    expect(request).toMatchObject({
      kind: 'graphql',
      method: 'POST',
      url: 'https://api.github.com/graphql',
      paginate: false,
    })
    expect(JSON.parse(request.body ?? '{}')).toEqual({
      query: 'query($cursor: String) { viewer { login } }',
      variables: {
        cursor: 'cursor-2',
      },
    })
  })

  test('converts repeated REST form fields into a JSON array payload', () => {
    const request = buildDirectGitHubApiRequest(
      [
        'repos/JamesWuHK/digital-employee/issues/334/labels',
        '-X',
        'POST',
        '-f',
        'labels[]=agent:ready',
        '-f',
        'labels[]=agent:claimed',
      ],
      { repo: 'JamesWuHK/digital-employee' },
    )

    expect(request).toMatchObject({
      kind: 'rest',
      method: 'POST',
      url: 'https://api.github.com/repos/JamesWuHK/digital-employee/issues/334/labels',
      paginate: false,
    })
    expect(JSON.parse(request.body ?? '{}')).toEqual({
      labels: ['agent:ready', 'agent:claimed'],
    })
  })

  test('rejects unsupported gh api flags so callers can fall back to gh', () => {
    expect(() => buildDirectGitHubApiRequest(
      [
        'repos/JamesWuHK/digital-employee/issues/334',
        '--cache',
        '1h',
      ],
      { repo: 'JamesWuHK/digital-employee' },
    )).toThrow('unsupported gh api option for direct mode: --cache')
  })
})

describe('ghApiRaw', () => {
  test('uses direct fetch for PAT-backed paginated REST requests and emits request observations', async () => {
    const originalFetch = globalThis.fetch
    const seen: string[] = []
    const observations: Array<{
      transport: string
      mode: string
      outcome: string
      durationMs: number
    }> = []
    const config = {
      repo: 'JamesWuHK/digital-employee',
      pat: 'ghp_test',
    } as AgentConfig

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
      seen.push(url)

      if (seen.length === 1) {
        expect(init?.headers).toMatchObject({
          Authorization: 'token ghp_test',
          Accept: 'application/vnd.github+json',
        })
        return new Response(
          JSON.stringify([{ id: 11, body: 'page-1', created_at: '2026-04-11T10:00:00.000Z', updated_at: '2026-04-11T10:00:00.000Z' }]),
          {
            status: 200,
            headers: {
              link: '<https://api.github.com/repos/JamesWuHK/digital-employee/issues/334/comments?page=2>; rel="next"',
            },
          },
        )
      }

      return new Response(
        JSON.stringify([{ id: 12, body: 'page-2', created_at: '2026-04-11T10:00:01.000Z', updated_at: '2026-04-11T10:00:01.000Z' }]),
        { status: 200 },
      )
    }) as typeof fetch

    try {
      setGitHubApiRequestObserver((observation) => {
        observations.push(observation)
      })
      const result = await ghApiRaw(
        ['repos/JamesWuHK/digital-employee/issues/334/comments', '--paginate'],
        config,
      )

      expect(result.exitCode).toBe(0)
      expect(seen).toEqual([
        'https://api.github.com/repos/JamesWuHK/digital-employee/issues/334/comments',
        'https://api.github.com/repos/JamesWuHK/digital-employee/issues/334/comments?page=2',
      ])
      expect(JSON.parse(result.stdout)).toEqual([
        { id: 11, body: 'page-1', created_at: '2026-04-11T10:00:00.000Z', updated_at: '2026-04-11T10:00:00.000Z' },
        { id: 12, body: 'page-2', created_at: '2026-04-11T10:00:01.000Z', updated_at: '2026-04-11T10:00:01.000Z' },
      ])
      expect(observations).toHaveLength(1)
      expect(observations[0]).toMatchObject({
        transport: 'rest',
        mode: 'direct',
        outcome: 'success',
      })
      expect((observations[0]?.durationMs ?? 0) >= 0).toBe(true)
    } finally {
      setGitHubApiRequestObserver(null)
      globalThis.fetch = originalFetch
    }
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

describe('isGraphQlRateLimitErrorMessage', () => {
  test('matches explicit GraphQL rate limit errors', () => {
    expect(isGraphQlRateLimitErrorMessage('GraphQL: API rate limit already exceeded for user ID 1.')).toBe(true)
  })

  test('matches generic gh api rate limit errors emitted by gh api graphql', () => {
    expect(isGraphQlRateLimitErrorMessage('gh: API rate limit already exceeded for user ID 1.')).toBe(true)
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

describe('interpretPullRequestChecksResult', () => {
  test('treats failing checks as a merge blocker', () => {
    expect(interpretPullRequestChecksResult({
      stdout: 'build-and-test\tfail\t2m46s\thttps://example.test/run/1',
      stderr: '',
      exitCode: 1,
      timedOut: false,
    })).toEqual({
      state: 'fail',
      summary: 'build-and-test is fail',
    })
  })

  test('treats pending checks as not ready yet', () => {
    expect(interpretPullRequestChecksResult({
      stdout: 'build-and-test\tpending\t0\thttps://example.test/run/1',
      stderr: '',
      exitCode: 8,
      timedOut: false,
    })).toEqual({
      state: 'pending',
      summary: 'build-and-test is pending',
    })
  })

  test('allows merge when GitHub reports that no checks exist', () => {
    expect(interpretPullRequestChecksResult({
      stdout: "no checks reported on the 'agent/350/codex-dev-r1' branch",
      stderr: '',
      exitCode: 1,
      timedOut: false,
    })).toEqual({
      state: 'pass',
      summary: 'No checks reported',
    })
  })
})

describe('getPullRequestChecksStatus', () => {
  test('runs gh pr checks against the configured repository', async () => {
    const calls: Array<{ args: string[]; pat: string }> = []

    const status = await getPullRequestChecksStatus(
      390,
      {
        repo: 'JamesWuHK/agent-loop',
        pat: 'test-token',
      } as never,
      async (args, config) => {
        calls.push({ args, pat: config.pat })
        return {
          stdout: 'build-and-test\tpass\t2m43s\thttps://example.test/run/1',
          stderr: '',
          exitCode: 0,
          timedOut: false,
        }
      },
    )

    expect(status).toEqual({
      state: 'pass',
      summary: '1 check(s) passed',
    })
    expect(calls).toEqual([{
      args: ['pr', 'checks', '390', '-R', 'JamesWuHK/agent-loop'],
      pat: 'test-token',
    }])
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

describe('REST pagination helpers', () => {
  test('extracts open issue items from REST responses', () => {
    expect(extractRestOpenIssueListPage([
      {
        number: 113,
        title: 'artifact bridge',
        state: 'open',
        updated_at: '2026-04-06T11:59:25Z',
        labels: [{ name: 'agent:failed' }],
        assignees: [{ login: 'JamesWuHK' }],
      },
    ])).toEqual([
      {
        number: 113,
        title: 'artifact bridge',
        state: 'open',
        updated_at: '2026-04-06T11:59:25Z',
        labels: [{ name: 'agent:failed' }],
        assignees: [{ login: 'JamesWuHK' }],
      },
    ])

    expect(extractRestOpenIssueListPage({})).toEqual([])
  })

  test('extracts pull request items from REST responses', () => {
    expect(extractRestPullRequestListPage([
      {
        number: 247,
        title: 'Fix #125',
        html_url: 'https://github.com/example/repo/pull/247',
        state: 'open',
        draft: false,
        head: { ref: 'agent/125/codex-20260403', sha: 'abc123' },
        labels: [{ name: 'agent:review-approved' }],
      },
    ])).toEqual([
      {
        number: 247,
        title: 'Fix #125',
        html_url: 'https://github.com/example/repo/pull/247',
        state: 'open',
        draft: false,
        head: { ref: 'agent/125/codex-20260403', sha: 'abc123' },
        labels: [{ name: 'agent:review-approved' }],
      },
    ])

    expect(extractRestPullRequestListPage(null)).toEqual([])
  })

  test('extracts a single pull request object from REST responses', () => {
    expect(extractRestPullRequest({
      number: 247,
      title: 'Fix #125',
      html_url: 'https://github.com/example/repo/pull/247',
      state: 'open',
      draft: false,
      head: { ref: 'agent/125/codex-20260403', sha: 'abc123' },
      labels: [{ name: 'agent:review-approved' }],
    })).toEqual({
      number: 247,
      title: 'Fix #125',
      html_url: 'https://github.com/example/repo/pull/247',
      state: 'open',
      draft: false,
      head: { ref: 'agent/125/codex-20260403', sha: 'abc123' },
      labels: [{ name: 'agent:review-approved' }],
    })

    expect(extractRestPullRequest([])).toBeNull()
  })

  test('extracts the next REST pagination link', () => {
    expect(extractNextPageUrl(
      '<https://api.github.com/resource?page=2>; rel="next", <https://api.github.com/resource?page=4>; rel="last"',
    )).toBe('https://api.github.com/resource?page=2')
    expect(extractNextPageUrl(null)).toBeNull()
  })

  test('merges paginated REST array bodies into one JSON array', () => {
    expect(mergePaginatedRestBodies([
      '[{"id":1}]',
      '[{"id":2},{"id":3}]',
    ])).toBe('[{"id":1},{"id":2},{"id":3}]')
  })
})

describe('derivePullRequestStateFromRaw', () => {
  test('returns open for open pull requests', () => {
    expect(derivePullRequestStateFromRaw('open', null)).toBe('open')
  })

  test('returns merged when a closed pull request has merged_at', () => {
    expect(derivePullRequestStateFromRaw('closed', '2026-04-06T11:51:11Z')).toBe('merged')
  })

  test('returns closed when a closed pull request has not merged', () => {
    expect(derivePullRequestStateFromRaw('closed', null)).toBe('closed')
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

describe('sortClaimableIssuesForScheduling', () => {
  function buildIssue(input: Partial<AgentIssue> & Pick<AgentIssue, 'number'>): AgentIssue {
    const { number, ...rest } = input

    return {
      number,
      title: `issue-${number}`,
      body: '',
      state: 'ready',
      labels: [ISSUE_LABELS.READY],
      assignee: null,
      isClaimable: true,
      updatedAt: '2026-04-11T08:00:00.000Z',
      dependencyIssueNumbers: [],
      hasDependencyMetadata: true,
      dependencyParseError: false,
      claimBlockedBy: [],
      hasExecutableContract: true,
      contractValidationErrors: [],
      ...rest,
    }
  }

  test('orders high before default before low and keeps ties deterministic', () => {
    const ordered = sortClaimableIssuesForScheduling([
      buildIssue({ number: 14 }),
      buildIssue({ number: 13, labels: [ISSUE_LABELS.READY, ISSUE_PRIORITY_LABELS.LOW] }),
      buildIssue({
        number: 12,
        labels: [ISSUE_LABELS.READY, ISSUE_PRIORITY_LABELS.HIGH],
        updatedAt: '2026-04-11T08:05:00.000Z',
      }),
      buildIssue({
        number: 11,
        labels: [ISSUE_LABELS.READY, ISSUE_PRIORITY_LABELS.HIGH],
        updatedAt: '2026-04-11T08:01:00.000Z',
      }),
      buildIssue({
        number: 10,
        labels: [ISSUE_LABELS.READY, 'agent:custom-priority'],
        updatedAt: '2026-04-11T07:55:00.000Z',
      }),
      buildIssue({
        number: 9,
        updatedAt: '2026-04-11T07:55:00.000Z',
      }),
    ])

    expect(ordered.map((issue) => issue.number)).toEqual([11, 12, 9, 10, 14, 13])
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

  test('treats heartbeating leases with stale progress as adoptable by other daemons', () => {
    const now = Date.parse('2026-04-05T08:01:00.000Z')
    const stalledLease = {
      ...activeLease,
      lastHeartbeatAt: '2026-04-05T08:00:55.000Z',
      expiresAt: '2026-04-05T08:01:55.000Z',
      lastProgressAt: '2026-04-05T08:00:10.000Z',
      lastProgressKind: 'stdout' as const,
    }
    const stalled = {
      commentId: 11,
      body: buildManagedLeaseComment(stalledLease),
      createdAt: '2026-04-05T08:00:00.000Z',
      updatedAt: '2026-04-05T08:00:55.000Z',
      lease: stalledLease,
    }

    expect(isManagedLeaseExpired(stalledLease, now)).toBe(false)
    expect(isManagedLeaseProgressStale(stalledLease, 45_000, now)).toBe(true)
    expect(canDaemonAdoptManagedLease(stalled, 'daemon-b', now, 45_000)).toBe(true)
    expect(canDaemonAdoptManagedLease(stalled, 'daemon-b', now, 90_000)).toBe(false)
    expect(canDaemonAdoptManagedLease(stalled, 'daemon-a', now, 45_000)).toBe(true)
  })

  test('ignores stale-progress leases when choosing the canonical active lease for adoption', () => {
    const now = Date.parse('2026-04-05T08:01:00.000Z')
    const comments = [
      {
        commentId: 11,
        body: buildManagedLeaseComment({
          ...activeLease,
          lastHeartbeatAt: '2026-04-05T08:00:55.000Z',
          expiresAt: '2026-04-05T08:01:55.000Z',
          lastProgressAt: '2026-04-05T08:00:10.000Z',
        }),
        createdAt: '2026-04-05T08:00:00.000Z',
        updatedAt: '2026-04-05T08:00:55.000Z',
      },
      {
        commentId: 12,
        body: buildManagedLeaseComment({
          ...activeLease,
          leaseId: 'lease-2',
          daemonInstanceId: 'daemon-b',
          machineId: 'machine-b',
          startedAt: '2026-04-05T08:00:40.000Z',
          lastHeartbeatAt: '2026-04-05T08:00:58.000Z',
          expiresAt: '2026-04-05T08:01:58.000Z',
          lastProgressAt: '2026-04-05T08:00:58.000Z',
        }),
        createdAt: '2026-04-05T08:00:40.000Z',
        updatedAt: '2026-04-05T08:00:58.000Z',
      },
    ]

    expect(getActiveManagedLease(comments, 'issue-process', now)?.commentId).toBe(11)
    expect(getActiveManagedLease(comments, 'issue-process', now, 45_000)?.commentId).toBe(12)
    expect(getLatestManagedLease(comments, 'issue-process')?.commentId).toBe(12)
  })
})
