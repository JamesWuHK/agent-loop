import { describe, expect, test } from 'bun:test'
import {
  buildBootstrapScorecard,
  buildBootstrapScorecardForRepo,
  classifyBootstrapFailureKind,
  formatBootstrapScorecard,
  resolveBootstrapScorecardExitCode,
} from './bootstrap-scorecard'

function buildStructuredReviewBlockerComment(
  prNumber: number,
  reason: string,
  options: {
    attempt?: number
    headRefOid?: string
  } = {},
): string {
  const metadata = {
    pr: prNumber,
    attempt: options.attempt ?? 9,
    approved: false,
    canMerge: false,
    ...(options.headRefOid ? { headRefOid: options.headRefOid } : {}),
  }

  return `<!-- agent-loop:pr-review ${JSON.stringify(metadata)} -->
<!-- agent-loop:review-feedback {"approved":false,"canMerge":false,"reason":${JSON.stringify(reason)},"findings":[{"severity":"high","file":"apps/agent-daemon/src/bootstrap-scorecard.ts","summary":"scorecard signal mismatch","mustFix":["reuse authoritative blocker signals"],"mustNotDo":["do not infer blockers from labels alone"],"validation":["bun test apps/agent-daemon/src/bootstrap-scorecard.test.ts"],"scopeRationale":"issue #70 requires stable taxonomy output"}]} -->
## Automated review still failing — human intervention required`
}

function buildExecutionFailureReviewComment(
  prNumber: number,
  headRefOid: string,
): string {
  return `<!-- agent-loop:pr-review {"pr":${prNumber},"attempt":2,"approved":false,"canMerge":false,"headRefOid":"${headRefOid}"} -->
## Automated review still failing — human intervention required

- Attempt: 2
- Merge ready: no
- Reason: Review failed: ReviewAgentExecutionError: Agent exited with code 1`
}

function buildBlockedResumeEscalationComment(
  issueNumber: number,
  reason: string,
  options: {
    prNumber?: number | null
    escalatedAt?: string
  } = {},
): string {
  return `<!-- agent-loop:issue-resume-blocked ${JSON.stringify({
    issueNumber,
    prNumber: options.prNumber ?? null,
    blockedSince: '2026-04-11T09:00:00.000Z',
    escalatedAt: options.escalatedAt ?? '2026-04-11T09:05:00.000Z',
    thresholdSeconds: 300,
    reason,
    machineId: 'codex-dev',
    daemonInstanceId: 'daemon-1',
  })} -->
## agent-loop blocked resume escalation`
}

describe('buildBootstrapScorecard', () => {
  test('groups blockers into stable failure taxonomy buckets', () => {
    expect(classifyBootstrapFailureKind('closed PR blocked fresh PR creation')).toBe('pr_lifecycle_failure')
    expect(classifyBootstrapFailureKind('missing executable test/build/check command in ### Validation')).toBe('contract_failure')

    const scorecard = buildBootstrapScorecard({
      audit: { managedIssueCount: 8, readyIssueCount: 3, invalidReadyIssueCount: 2, lowScoreIssueCount: 3, warningIssueCount: 1 },
      prBlockers: [{ issueNumber: 60, reason: 'closed PR blocked fresh PR creation' }],
      reviewBlockers: [{ issueNumber: 61, reason: 'agent:human-needed review blocker remains open' }],
      releaseEvidenceMissing: ['self_bootstrap_suite_green'],
    })

    expect(scorecard.ready).toBe(false)
    expect(scorecard.categoryCounts.pr_lifecycle_failure).toBe(1)
    expect(scorecard.categoryCounts.release_process_failure).toBe(1)
    expect(scorecard.categoryCounts.contract_failure).toBe(2)
    expect(resolveBootstrapScorecardExitCode(scorecard)).toBe(1)
    expect(formatBootstrapScorecard(scorecard)).toContain('Bootstrap Scorecard')
  })
})

describe('buildBootstrapScorecardForRepo', () => {
  test('keeps terminal human-needed review blockers out of pr lifecycle failures', async () => {
    const scorecard = await buildBootstrapScorecardForRepo({
      config: {
        repo: 'JamesWuHK/agent-loop',
        pat: 'test-token',
      } as never,
    }, {
      listOpenAgentIssues: async () => [
        {
          number: 50,
          title: '[AL-11] issue audit',
          body: '## 用户故事\n\n作为维护者，我希望 scorecard 统计 invalid ready issue。\n\n## Context\n\n### Dependencies\n```json\n{"dependsOn":[]}\n```\n\n### AllowedFiles\n- apps/agent-daemon/src/bootstrap-scorecard.ts\n\n### Validation\n- `bun test apps/agent-daemon/src/bootstrap-scorecard.test.ts`\n\n## RED 测试\n```ts\nthrow new Error("red")\n```\n\n## 实现步骤\n1. add scorecard\n\n## 验收\n- [ ] valid',
          state: 'ready',
          labels: ['agent:ready'],
          assignee: null,
          isClaimable: false,
          updatedAt: '2026-04-11T10:00:00.000Z',
          dependencyIssueNumbers: [],
          hasDependencyMetadata: false,
          dependencyParseError: false,
          claimBlockedBy: [],
          hasExecutableContract: false,
          contractValidationErrors: ['missing ### RequiredSemantics section'],
        },
        {
          number: 61,
          title: 'issue recovery remains blocked',
          body: '',
          state: 'failed',
          labels: ['agent:failed'],
          assignee: null,
          isClaimable: false,
          updatedAt: '2026-04-11T10:00:00.000Z',
          dependencyIssueNumbers: [],
          hasDependencyMetadata: false,
          dependencyParseError: false,
          claimBlockedBy: [],
          hasExecutableContract: true,
          contractValidationErrors: [],
        },
      ],
      listOpenAgentPullRequests: async () => [
        {
          number: 91,
          title: 'Fix lifecycle blocker',
          url: 'https://example.test/pr/91',
          headRefName: 'agent/61/codex-dev',
          headRefOid: 'abc123',
          isDraft: false,
          labels: ['agent:human-needed'],
        },
      ],
      listIssueComments: async (number) => {
        if (number === 61) return []
        if (number === 91) {
          return [{
            commentId: 9101,
            body: buildStructuredReviewBlockerComment(91, 'Approval bar flow regressed', {
              headRefOid: 'abc123',
            }),
            createdAt: '2026-04-11T09:00:00.000Z',
            updatedAt: '2026-04-11T09:05:00.000Z',
          }]
        }
        return []
      },
      getAgentIssueByNumber: async (issueNumber) => ({
        number: issueNumber,
        title: `Issue ${issueNumber}`,
        body: '',
        state: issueNumber === 69 ? 'done' : 'working',
        labels: issueNumber === 69 ? ['agent:done'] : ['agent:working'],
        assignee: null,
        isClaimable: false,
        updatedAt: '2026-04-11T10:00:00.000Z',
        dependencyIssueNumbers: [],
        hasDependencyMetadata: false,
        dependencyParseError: false,
        claimBlockedBy: [],
        hasExecutableContract: true,
        contractValidationErrors: [],
      }),
    })

    expect(scorecard.categoryCounts).toMatchObject({
      contract_failure: 1,
      pr_lifecycle_failure: 0,
      review_failure: 1,
      release_process_failure: 1,
      runtime_failure: 0,
      github_transport_failure: 0,
    })
    expect(scorecard.topBlockers).toEqual([
      expect.objectContaining({
        category: 'contract_failure',
        reason: '1 invalid ready issue(s) require executable contracts',
      }),
      expect.objectContaining({
        category: 'review_failure',
        issueNumber: 61,
        prNumber: 91,
        reason: 'Approval bar flow regressed',
      }),
      expect.objectContaining({
        category: 'release_process_failure',
        reason: 'missing required evidence: bootstrap_scorecard_green',
      }),
    ])
  })

  test('sources release blockers from bootstrap gate required evidence instead of open-issue body scans', async () => {
    const scorecard = await buildBootstrapScorecardForRepo({
      config: {
        repo: 'JamesWuHK/agent-loop',
        pat: 'test-token',
      } as never,
    }, {
      listOpenAgentIssues: async () => [
        {
          number: 69,
          title: 'self_bootstrap_suite_green release evidence tracking',
          body: '',
          state: 'working',
          labels: ['agent:working'],
          assignee: null,
          isClaimable: false,
          updatedAt: '2026-04-11T10:00:00.000Z',
          dependencyIssueNumbers: [],
          hasDependencyMetadata: false,
          dependencyParseError: false,
          claimBlockedBy: [],
          hasExecutableContract: true,
          contractValidationErrors: [],
        },
      ],
      listOpenAgentPullRequests: async () => [],
      listIssueComments: async () => [],
      getAgentIssueByNumber: async (issueNumber) => ({
        number: issueNumber,
        title: `Issue ${issueNumber}`,
        body: '',
        state: issueNumber === 69 ? 'done' : 'working',
        labels: issueNumber === 69 ? ['agent:done'] : ['agent:working'],
        assignee: null,
        isClaimable: false,
        updatedAt: '2026-04-11T10:00:00.000Z',
        dependencyIssueNumbers: [],
        hasDependencyMetadata: false,
        dependencyParseError: false,
        claimBlockedBy: [],
        hasExecutableContract: true,
        contractValidationErrors: [],
      }),
    })

    expect(scorecard.categoryCounts.release_process_failure).toBe(1)
    expect(scorecard.topBlockers).toContainEqual(expect.objectContaining({
      category: 'release_process_failure',
      reason: 'missing required evidence: bootstrap_scorecard_green',
    }))
    expect(scorecard.categoryCounts.runtime_failure).toBe(0)
  })

  test('surfaces closed-pr lifecycle blockers from blocked-resume escalation comments without an open linked PR', async () => {
    const scorecard = await buildBootstrapScorecardForRepo({
      config: {
        repo: 'JamesWuHK/agent-loop',
        pat: 'test-token',
      } as never,
    }, {
      listOpenAgentIssues: async () => [
        {
          number: 60,
          title: 'issue recovery remains blocked',
          body: '',
          state: 'failed',
          labels: ['agent:failed'],
          assignee: null,
          isClaimable: false,
          updatedAt: '2026-04-11T10:00:00.000Z',
          dependencyIssueNumbers: [],
          hasDependencyMetadata: false,
          dependencyParseError: false,
          claimBlockedBy: [],
          hasExecutableContract: true,
          contractValidationErrors: [],
        },
      ],
      listOpenAgentPullRequests: async () => [],
      listIssueComments: async (number) => {
        if (number !== 60) {
          return []
        }

        return [{
          commentId: 6001,
          body: buildBlockedResumeEscalationComment(60, 'closed PR blocked fresh PR creation', {
            prNumber: 88,
          }),
          createdAt: '2026-04-11T09:00:00.000Z',
          updatedAt: '2026-04-11T09:05:00.000Z',
        }]
      },
      getAgentIssueByNumber: async () => null,
    })

    expect(scorecard.categoryCounts.pr_lifecycle_failure).toBe(1)
    expect(scorecard.topBlockers).toContainEqual(expect.objectContaining({
      category: 'pr_lifecycle_failure',
      issueNumber: 60,
      prNumber: 88,
      reason: 'closed PR blocked fresh PR creation',
    }))
  })

  test('counts failed issues blocked by a non-resumable linked PR as pr lifecycle failures', async () => {
    const scorecard = await buildBootstrapScorecardForRepo({
      config: {
        repo: 'JamesWuHK/agent-loop',
        pat: 'test-token',
      } as never,
    }, {
      listOpenAgentIssues: async () => [
        {
          number: 62,
          title: 'issue recovery remains blocked by linked pr state',
          body: '',
          state: 'failed',
          labels: ['agent:failed'],
          assignee: null,
          isClaimable: false,
          updatedAt: '2026-04-11T10:00:00.000Z',
          dependencyIssueNumbers: [],
          hasDependencyMetadata: false,
          dependencyParseError: false,
          claimBlockedBy: [],
          hasExecutableContract: true,
          contractValidationErrors: [],
        },
      ],
      listOpenAgentPullRequests: async () => [
        {
          number: 123,
          title: 'linked pr is stuck',
          url: 'https://example.test/pr/123',
          headRefName: 'agent/62/codex-dev',
          headRefOid: 'def456',
          isDraft: false,
          labels: ['stalled'],
        },
      ],
      listIssueComments: async (number) => {
        if (number !== 62) {
          return []
        }

        return [{
          commentId: 6201,
          body: buildBlockedResumeEscalationComment(62, 'linked PR #123 is not in a resumable automated state (stalled)', {
            prNumber: 123,
          }),
          createdAt: '2026-04-11T09:00:00.000Z',
          updatedAt: '2026-04-11T09:05:00.000Z',
        }]
      },
      getAgentIssueByNumber: async () => null,
    })

    expect(scorecard.categoryCounts.pr_lifecycle_failure).toBe(1)
    expect(scorecard.topBlockers).toContainEqual(expect.objectContaining({
      category: 'pr_lifecycle_failure',
      issueNumber: 62,
      prNumber: 123,
      reason: 'linked PR #123 is not in a resumable automated state (stalled)',
    }))
  })

  test('mirrors bootstrap gate release evidence codes even when open issues are empty', async () => {
    const scorecard = await buildBootstrapScorecardForRepo({
      config: {
        repo: 'JamesWuHK/agent-loop',
        pat: 'test-token',
      } as never,
    }, {
      listOpenAgentIssues: async () => [],
      listOpenAgentPullRequests: async () => [],
      listIssueComments: async () => [],
      getAgentIssueByNumber: async (issueNumber) => ({
        number: issueNumber,
        title: `Issue ${issueNumber}`,
        body: '',
        state: issueNumber === 69 ? 'done' : 'working',
        labels: issueNumber === 69 ? ['agent:done'] : ['agent:working'],
        assignee: null,
        isClaimable: false,
        updatedAt: '2026-04-11T10:00:00.000Z',
        dependencyIssueNumbers: [],
        hasDependencyMetadata: false,
        dependencyParseError: false,
        claimBlockedBy: [],
        hasExecutableContract: true,
        contractValidationErrors: [],
      }),
    })

    expect(scorecard.ready).toBe(false)
    expect(scorecard.categoryCounts.release_process_failure).toBe(1)
    expect(scorecard.topBlockers).toEqual([
      expect.objectContaining({
        category: 'release_process_failure',
        reason: 'missing required evidence: bootstrap_scorecard_green',
      }),
    ])
  })

  test('suppresses review blockers for resumable human-needed pull requests', async () => {
    const scorecard = await buildBootstrapScorecardForRepo({
      config: {
        repo: 'JamesWuHK/agent-loop',
        pat: 'test-token',
      } as never,
    }, {
      listOpenAgentIssues: async () => [
        {
          number: 61,
          title: 'review follow-up',
          body: '',
          state: 'working',
          labels: ['agent:working'],
          assignee: null,
          isClaimable: false,
          updatedAt: '2026-04-11T10:00:00.000Z',
          dependencyIssueNumbers: [],
          hasDependencyMetadata: false,
          dependencyParseError: false,
          claimBlockedBy: [],
          hasExecutableContract: true,
          contractValidationErrors: [],
        },
      ],
      listOpenAgentPullRequests: async () => [
        {
          number: 91,
          title: 'Fix lifecycle blocker',
          url: 'https://example.test/pr/91',
          headRefName: 'agent/61/codex-dev',
          headRefOid: 'abc123',
          isDraft: false,
          labels: ['agent:human-needed'],
        },
      ],
      listIssueComments: async (number) => {
        if (number === 91) {
          return [{
            commentId: 9101,
            body: buildExecutionFailureReviewComment(91, 'abc123'),
            createdAt: '2026-04-11T09:00:00.000Z',
            updatedAt: '2026-04-11T09:05:00.000Z',
          }]
        }
        return []
      },
      getAgentIssueByNumber: async () => null,
    })

    expect(scorecard.categoryCounts.review_failure).toBe(0)
    expect(scorecard.categoryCounts.github_transport_failure).toBe(0)
  })

  test('preserves successful signals when a linked GitHub lookup fails', async () => {
    const scorecard = await buildBootstrapScorecardForRepo({
      config: {
        repo: 'JamesWuHK/agent-loop',
        pat: 'test-token',
      } as never,
    }, {
      listOpenAgentIssues: async () => [
        {
          number: 50,
          title: '[AL-11] issue audit',
          body: '## 用户故事\n\n作为维护者，我希望 scorecard 统计 invalid ready issue。\n\n## Context\n\n### Dependencies\n```json\n{"dependsOn":[]}\n```\n\n### AllowedFiles\n- apps/agent-daemon/src/bootstrap-scorecard.ts\n\n### Validation\n- `bun test apps/agent-daemon/src/bootstrap-scorecard.test.ts`\n\n## RED 测试\n```ts\nthrow new Error("red")\n```\n\n## 实现步骤\n1. add scorecard\n\n## 验收\n- [ ] valid',
          state: 'ready',
          labels: ['agent:ready'],
          assignee: null,
          isClaimable: false,
          updatedAt: '2026-04-11T10:00:00.000Z',
          dependencyIssueNumbers: [],
          hasDependencyMetadata: false,
          dependencyParseError: false,
          claimBlockedBy: [],
          hasExecutableContract: false,
          contractValidationErrors: ['missing ### RequiredSemantics section'],
        },
      ],
      listOpenAgentPullRequests: async () => [
        {
          number: 91,
          title: 'Fix lifecycle blocker',
          url: 'https://example.test/pr/91',
          headRefName: 'agent/61/codex-dev',
          headRefOid: 'abc123',
          isDraft: false,
          labels: ['agent:human-needed'],
        },
      ],
      listIssueComments: async (number) => {
        if (number === 91) {
          return [{
            commentId: 9101,
            body: buildStructuredReviewBlockerComment(91, 'Approval bar flow regressed', {
              headRefOid: 'abc123',
            }),
            createdAt: '2026-04-11T09:00:00.000Z',
            updatedAt: '2026-04-11T09:05:00.000Z',
          }]
        }
        return []
      },
      getAgentIssueByNumber: async () => {
        throw new Error('The socket connection was closed unexpectedly.')
      },
    })

    expect(scorecard.ready).toBe(false)
    expect(scorecard.categoryCounts).toMatchObject({
      contract_failure: 1,
      review_failure: 1,
      github_transport_failure: 2,
      runtime_failure: 0,
      pr_lifecycle_failure: 0,
      release_process_failure: 0,
    })
    expect(scorecard.topBlockers).toEqual([
      expect.objectContaining({
        category: 'contract_failure',
      }),
      expect.objectContaining({
        category: 'review_failure',
        prNumber: 91,
      }),
      expect.objectContaining({
        category: 'github_transport_failure',
      }),
    ])
  })

  test('downgrades repo fetch failures into transport blockers instead of throwing', async () => {
    const scorecard = await buildBootstrapScorecardForRepo({
      config: {
        repo: 'JamesWuHK/agent-loop',
        pat: 'test-token',
      } as never,
    }, {
      listOpenAgentIssues: async () => {
        throw new Error('The socket connection was closed unexpectedly.')
      },
      listOpenAgentPullRequests: async () => [],
      listIssueComments: async () => [],
      getAgentIssueByNumber: async () => null,
    })

    expect(scorecard.ready).toBe(false)
    expect(scorecard.categoryCounts.github_transport_failure).toBe(1)
    expect(scorecard.topBlockers).toEqual([
      expect.objectContaining({
        category: 'github_transport_failure',
      }),
      expect.objectContaining({
        category: 'release_process_failure',
        reason: 'missing required evidence: self_bootstrap_suite_green',
      }),
    ])
  })
})
