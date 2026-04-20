import { describe, expect, test } from 'bun:test'
import type { AgentIssue } from '@agent/shared'
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

function buildScorecardAgentIssue(
  input: Partial<AgentIssue> & Pick<AgentIssue, 'number'>,
): AgentIssue & { runtimeRequirements: never[] } {
  return {
    title: `Issue ${input.number}`,
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
    runtimeRequirements: [] as never[],
    ...input,
  }
}

describe('buildBootstrapScorecard', () => {
  test('groups blockers into stable failure taxonomy buckets', () => {
    expect(classifyBootstrapFailureKind('closed PR blocked fresh PR creation')).toBe('pr_lifecycle_failure')
    expect(classifyBootstrapFailureKind('linked PR #461 is in terminal agent:human-needed after failing merge checks')).toBe('pr_lifecycle_failure')
    expect(classifyBootstrapFailureKind('linked PR #452 is still waiting for required self-bootstrap checks to finish before merge can resume')).toBe('pr_lifecycle_failure')
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
  test('assigns a failed issue and linked human-needed pr to one taxonomy bucket when review feedback overlaps', async () => {
    const scorecard = await buildBootstrapScorecardForRepo({
      config: {
        repo: 'JamesWuHK/agent-loop',
        pat: 'test-token',
      } as never,
    }, {
      listOpenAgentIssues: async () => [
        buildScorecardAgentIssue({
          number: 50,
          title: '[AL-11] issue audit',
          body: '## 用户故事\n\n作为维护者，我希望 scorecard 统计 invalid ready issue。\n\n## Context\n\n### Dependencies\n```json\n{"dependsOn":[]}\n```\n\n### AllowedFiles\n- apps/agent-daemon/src/bootstrap-scorecard.ts\n\n### Validation\n- `bun test apps/agent-daemon/src/bootstrap-scorecard.test.ts`\n\n## RED 测试\n```ts\nthrow new Error("red")\n```\n\n## 实现步骤\n1. add scorecard\n\n## 验收\n- [ ] valid',
          state: 'ready',
          labels: ['agent:ready'],
          hasExecutableContract: false,
          contractValidationErrors: ['missing ### RequiredSemantics section'],
        }),
        buildScorecardAgentIssue({
          number: 61,
          title: 'issue recovery remains blocked',
          body: '',
          state: 'failed',
          labels: ['agent:failed'],
        }),
        buildScorecardAgentIssue({
          number: 69,
          title: 'self_bootstrap_suite_green release evidence still missing',
          body: '',
          state: 'working',
          labels: ['agent:working'],
        }),
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
      getAgentIssueByNumber: async (issueNumber) => buildScorecardAgentIssue({
        number: issueNumber,
      }),
    })

    expect(scorecard.categoryCounts).toMatchObject({
      contract_failure: 1,
      pr_lifecycle_failure: 1,
      review_failure: 0,
      release_process_failure: 2,
      runtime_failure: 0,
      github_transport_failure: 0,
    })
    expect(scorecard.topBlockers).toEqual([
      expect.objectContaining({
        category: 'contract_failure',
        reason: '1 invalid ready issue(s) require executable contracts',
      }),
      expect.objectContaining({
        category: 'pr_lifecycle_failure',
        issueNumber: 61,
        prNumber: 91,
      }),
      expect.objectContaining({
        category: 'release_process_failure',
        reason: 'missing required evidence: self_bootstrap_suite_green',
      }),
    ])
    expect(scorecard.topBlockers.filter((blocker) => blocker.issueNumber === 61 && blocker.prNumber === 91)).toEqual([
      expect.objectContaining({
        category: 'pr_lifecycle_failure',
        issueNumber: 61,
        prNumber: 91,
      }),
    ])
  })

  test('ignores unrelated managed issues and prs outside the bootstrap blocker scope', async () => {
    const baseDeps = {
      listOpenAgentIssues: async () => [
        buildScorecardAgentIssue({
          number: 50,
          title: '[AL-11] issue audit',
          body: '## 用户故事\n\n作为维护者，我希望 scorecard 统计 invalid ready issue。\n\n## Context\n\n### Dependencies\n```json\n{"dependsOn":[]}\n```\n\n### AllowedFiles\n- apps/agent-daemon/src/bootstrap-scorecard.ts\n\n### Validation\n- `bun test apps/agent-daemon/src/bootstrap-scorecard.test.ts`\n\n## RED 测试\n```ts\nthrow new Error("red")\n```\n\n## 实现步骤\n1. add scorecard\n\n## 验收\n- [ ] valid',
          state: 'ready',
          labels: ['agent:ready'],
          hasExecutableContract: false,
          contractValidationErrors: ['missing ### RequiredSemantics section'],
        }),
        buildScorecardAgentIssue({
          number: 61,
          state: 'working',
        }),
        buildScorecardAgentIssue({
          number: 69,
          title: 'self_bootstrap_suite_green release evidence still missing',
          state: 'working',
        }),
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
      listIssueComments: async (number: number) => {
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
      getAgentIssueByNumber: async (issueNumber: number) => buildScorecardAgentIssue({
        number: issueNumber,
      }),
    }
    const baseline = await buildBootstrapScorecardForRepo({
      config: {
        repo: 'JamesWuHK/agent-loop',
        pat: 'test-token',
      } as never,
    }, baseDeps)
    const withUnrelatedManagedWork = await buildBootstrapScorecardForRepo({
      config: {
        repo: 'JamesWuHK/agent-loop',
        pat: 'test-token',
      } as never,
    }, {
      ...baseDeps,
      listOpenAgentIssues: async () => [
        ...(await baseDeps.listOpenAgentIssues()),
        buildScorecardAgentIssue({
          number: 999,
          title: 'unrelated invalid ready issue',
          state: 'ready',
          labels: ['agent:ready'],
          hasExecutableContract: false,
          contractValidationErrors: ['missing ### Validation section'],
        }),
      ],
      listOpenAgentPullRequests: async () => [
        ...(await baseDeps.listOpenAgentPullRequests()),
        {
          number: 777,
          title: 'Unrelated review blocker',
          url: 'https://example.test/pr/777',
          headRefName: 'agent/999/codex-dev',
          headRefOid: 'def456',
          isDraft: false,
          labels: ['agent:human-needed'],
        },
      ],
      listIssueComments: async (number: number) => {
        if (number === 777) {
          return [{
            commentId: 77701,
            body: buildStructuredReviewBlockerComment(777, 'Unrelated review failed', {
              headRefOid: 'def456',
            }),
            createdAt: '2026-04-11T09:00:00.000Z',
            updatedAt: '2026-04-11T09:05:00.000Z',
          }]
        }

        return baseDeps.listIssueComments(number)
      },
    })

    expect(withUnrelatedManagedWork.categoryCounts).toEqual(baseline.categoryCounts)
    expect(withUnrelatedManagedWork.topBlockers).toEqual(baseline.topBlockers)
    expect(resolveBootstrapScorecardExitCode(withUnrelatedManagedWork)).toBe(
      resolveBootstrapScorecardExitCode(baseline),
    )
  })

  test('sources release blockers from bootstrap gate required evidence instead of open-issue body scans', async () => {
    const scorecard = await buildBootstrapScorecardForRepo({
      config: {
        repo: 'JamesWuHK/agent-loop',
        pat: 'test-token',
      } as never,
    }, {
      listOpenAgentIssues: async () => [
        buildScorecardAgentIssue({
          number: 69,
          title: 'self_bootstrap_suite_green release evidence tracking',
          state: 'working',
          labels: ['agent:working'],
        }),
      ],
      listOpenAgentPullRequests: async () => [],
      listIssueComments: async () => [],
      getAgentIssueByNumber: async (issueNumber) => buildScorecardAgentIssue({
        number: issueNumber,
        state: issueNumber === 69 ? 'done' : 'working',
        labels: issueNumber === 69 ? ['agent:done'] : ['agent:working'],
      }),
    })

    expect(scorecard.categoryCounts.release_process_failure).toBe(1)
    expect(scorecard.topBlockers).toContainEqual(expect.objectContaining({
      category: 'release_process_failure',
      reason: 'missing required evidence: bootstrap_scorecard_green',
    }))
    expect(scorecard.categoryCounts.runtime_failure).toBe(0)
  })

  test('surfaces runtime blockers from unresolved blocked-resume escalation comments', async () => {
    const scorecard = await buildBootstrapScorecardForRepo({
      config: {
        repo: 'JamesWuHK/agent-loop',
        pat: 'test-token',
      } as never,
    }, {
      listOpenAgentIssues: async () => [
        buildScorecardAgentIssue({
          number: 60,
          title: 'issue recovery is blocked by daemon runtime failure',
          state: 'failed',
          labels: ['agent:failed'],
        }),
      ],
      listOpenAgentPullRequests: async () => [],
      listIssueComments: async (number) => {
        if (number !== 60) {
          return []
        }

        return [{
          commentId: 6301,
          body: buildBlockedResumeEscalationComment(60, 'daemon runtime failure: startup recovery deferred by local runtime health failure'),
          createdAt: '2026-04-11T09:00:00.000Z',
          updatedAt: '2026-04-11T09:05:00.000Z',
        }]
      },
      getAgentIssueByNumber: async () => null,
    })

    expect(scorecard.categoryCounts.runtime_failure).toBe(1)
    expect(scorecard.topBlockers).toContainEqual(expect.objectContaining({
      category: 'runtime_failure',
      issueNumber: 60,
      prNumber: null,
      reason: 'daemon runtime failure: startup recovery deferred by local runtime health failure',
    }))
  })

  test('surfaces closed-pr lifecycle blockers from blocked-resume escalation comments without an open linked PR', async () => {
    const scorecard = await buildBootstrapScorecardForRepo({
      config: {
        repo: 'JamesWuHK/agent-loop',
        pat: 'test-token',
      } as never,
    }, {
      listOpenAgentIssues: async () => [
        buildScorecardAgentIssue({
          number: 60,
          title: 'issue recovery remains blocked',
          state: 'failed',
          labels: ['agent:failed'],
        }),
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

  test('keeps merge-check lifecycle blockers in the pr lifecycle bucket even when the linked pr is human-needed', async () => {
    const scorecard = await buildBootstrapScorecardForRepo({
      config: {
        repo: 'JamesWuHK/agent-loop',
        pat: 'test-token',
      } as never,
    }, {
      listOpenAgentIssues: async () => [
        buildScorecardAgentIssue({
          number: 61,
          title: 'issue recovery remains blocked',
          state: 'failed',
          labels: ['agent:failed'],
        }),
      ],
      listOpenAgentPullRequests: async () => [
        {
          number: 461,
          title: 'Fix merge-check blocker',
          url: 'https://example.test/pr/461',
          headRefName: 'agent/61/codex-dev',
          headRefOid: 'abc123',
          isDraft: false,
          labels: ['agent:human-needed'],
        },
      ],
      listIssueComments: async (number) => {
        if (number === 61) {
          return [{
            commentId: 6101,
            body: buildBlockedResumeEscalationComment(
              61,
              'linked PR #461 is in terminal agent:human-needed after failing merge checks',
              { prNumber: 461 },
            ),
            createdAt: '2026-04-11T09:00:00.000Z',
            updatedAt: '2026-04-11T09:05:00.000Z',
          }]
        }

        if (number === 461) {
          return [{
            commentId: 46101,
            body: buildExecutionFailureReviewComment(461, 'abc123'),
            createdAt: '2026-04-11T09:00:00.000Z',
            updatedAt: '2026-04-11T09:05:00.000Z',
          }]
        }

        return []
      },
      getAgentIssueByNumber: async () => null,
    })

    expect(scorecard.categoryCounts.pr_lifecycle_failure).toBe(1)
    expect(scorecard.topBlockers).toContainEqual(expect.objectContaining({
      category: 'pr_lifecycle_failure',
      issueNumber: 61,
      prNumber: 461,
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
      getAgentIssueByNumber: async (issueNumber) => buildScorecardAgentIssue({
        number: issueNumber,
        state: issueNumber === 69 ? 'done' : 'working',
        labels: issueNumber === 69 ? ['agent:done'] : ['agent:working'],
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
        buildScorecardAgentIssue({
          number: 61,
          title: 'review follow-up',
          state: 'working',
          labels: ['agent:working'],
        }),
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
        buildScorecardAgentIssue({
          number: 50,
          title: '[AL-11] issue audit',
          body: '## 用户故事\n\n作为维护者，我希望 scorecard 统计 invalid ready issue。\n\n## Context\n\n### Dependencies\n```json\n{"dependsOn":[]}\n```\n\n### AllowedFiles\n- apps/agent-daemon/src/bootstrap-scorecard.ts\n\n### Validation\n- `bun test apps/agent-daemon/src/bootstrap-scorecard.test.ts`\n\n## RED 测试\n```ts\nthrow new Error("red")\n```\n\n## 实现步骤\n1. add scorecard\n\n## 验收\n- [ ] valid',
          state: 'ready',
          labels: ['agent:ready'],
          hasExecutableContract: false,
          contractValidationErrors: ['missing ### RequiredSemantics section'],
        }),
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
      github_transport_failure: 4,
      runtime_failure: 0,
      pr_lifecycle_failure: 0,
      release_process_failure: 2,
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
      expect.objectContaining({
        category: 'release_process_failure',
        reason: 'missing required evidence: self_bootstrap_suite_green',
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

  test('keeps readable release evidence when an unrelated bootstrap issue lookup fails', async () => {
    const scorecard = await buildBootstrapScorecardForRepo({
      config: {
        repo: 'JamesWuHK/agent-loop',
        pat: 'test-token',
      } as never,
    }, {
      listOpenAgentIssues: async () => [],
      listOpenAgentPullRequests: async () => [],
      listIssueComments: async () => [],
      getAgentIssueByNumber: async (issueNumber) => {
        if (issueNumber === 37) {
          throw new Error('The socket connection was closed unexpectedly.')
        }

        return buildScorecardAgentIssue({
          number: issueNumber,
          state: 'working',
          labels: ['agent:working'],
        })
      },
    })

    expect(scorecard.ready).toBe(false)
    expect(scorecard.categoryCounts).toMatchObject({
      contract_failure: 0,
      runtime_failure: 0,
      pr_lifecycle_failure: 0,
      review_failure: 0,
      github_transport_failure: 1,
      release_process_failure: 2,
    })
    expect(scorecard.topBlockers).toEqual([
      expect.objectContaining({
        category: 'github_transport_failure',
        reason: 'release evidence: The socket connection was closed unexpectedly.',
      }),
      expect.objectContaining({
        category: 'release_process_failure',
        reason: 'missing required evidence: self_bootstrap_suite_green',
      }),
    ])
  })
})
