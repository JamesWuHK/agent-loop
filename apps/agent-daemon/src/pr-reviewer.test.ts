import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  buildPrReviewComment,
  buildReviewRepairPrompt,
  buildReviewPrompt,
  canResumeAutomatedPrReview,
  canResumeHumanNeededPrReview,
  classifyPrReviewOutcome,
  buildReviewFeedback,
  collectDependencyDirectories,
  extractLatestAutomatedPrReviewBlockerSummary,
  extractLatestAutomatedPrReviewState,
  extractIssueNumberFromPrBody,
  extractIssueNumberFromPrTitle,
  extractAutomatedReviewReasons,
  getNextAutomatedPrReviewAttempt,
  getReusableAutomatedPrReviewFeedback,
  hydrateDetachedReviewWorktree,
  normalizeWorktreePath,
  parsePrReviewResponse,
  reviewPrAgainstContext,
  shouldRestartAutomatedPrReviewOnIssueUpdate,
  shouldRestartAutomatedPrReviewOnNewHead,
  validateRejectedReviewFindings,
} from './pr-reviewer'
import type { AgentConfig } from '@agent/shared'

const TEST_CONFIG: AgentConfig = {
  machineId: 'test-machine',
  repo: 'JamesWuHK/digital-employee',
  pat: 'test-token',
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
  worktreesBase: '/tmp',
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

describe('pr-reviewer', () => {
  test('parses reason directly from JSON response', () => {
    expect(parsePrReviewResponse(`{
      "approved": true,
      "canMerge": true,
      "reason": "ready to merge"
    }`)).toEqual({
      approved: true,
      canMerge: true,
      reason: 'ready to merge',
    })
  })

  test('falls back to first finding when reason is omitted', () => {
    expect(parsePrReviewResponse(`{
      "approved": false,
      "canMerge": false,
      "findings": [
        {
          "severity": "high",
          "file": "apps/desktop/src/App.tsx",
          "summary": "logout leaves auth state behind"
        }
      ]
    }`)).toEqual({
      approved: false,
      canMerge: false,
      reason: 'Review output failed validation: every rejection finding must include mustFix, mustNotDo, validation, and scopeRationale. finding 1 in apps/desktop/src/App.tsx (logout leaves auth state behind) missing mustFix, mustNotDo, validation, scopeRationale',
      reviewFailed: true,
      findings: [
        {
          severity: 'high',
          file: 'apps/desktop/src/App.tsx',
          summary: 'logout leaves auth state behind',
        },
      ],
    })
  })

  test('classifies approved, rejected, invalid-output, and execution-failed review outcomes', () => {
    expect(classifyPrReviewOutcome({
      approved: true,
      canMerge: true,
      reason: 'ready',
    })).toBe('approved')

    expect(classifyPrReviewOutcome({
      approved: false,
      canMerge: false,
      reason: 'contract mismatch',
    })).toBe('rejected')

    expect(classifyPrReviewOutcome({
      approved: false,
      canMerge: false,
      reason: 'Review output failed validation: missing mustFix',
      reviewFailed: true,
    })).toBe('invalid_output')

    expect(classifyPrReviewOutcome({
      approved: false,
      canMerge: false,
      reason: 'Review failed: Agent exited with code 1',
      reviewFailed: true,
    })).toBe('execution_failed')
  })

  test('builds detailed review feedback from findings', () => {
    expect(buildReviewFeedback({
      approved: false,
      canMerge: false,
      reason: 'Routing contract is still broken.',
      findings: [
        {
          severity: 'high',
          file: 'apps/desktop/src/App.tsx',
          summary: 'login route still boots dashboard side effects',
          mustFix: ['remove dashboard bootstrap from the login path'],
          mustNotDo: ['do not move the route guard into App.tsx'],
          validation: ['cd apps/desktop && bun run --bun test src/App.test.tsx'],
          scopeRationale: 'issue #46 only allows the AppContext-side wiring',
        },
        {
          severity: 'medium',
          file: 'apps/desktop/src/context/AppContext.tsx',
          summary: 'currentPath can drift from rendered route',
        },
      ],
    })).toContain('Structured review feedback:')
  })

  test('embeds structured review feedback in PR comments for auto-fix handoff', () => {
    const comment = buildPrReviewComment(61, {
      approved: false,
      canMerge: false,
      reason: 'Routing contract is still broken.',
      findings: [
        {
          severity: 'high',
          file: 'apps/desktop/src/App.tsx',
          summary: 'login route still boots dashboard side effects',
          mustFix: ['remove dashboard bootstrap from the login path'],
          mustNotDo: ['do not move the route guard into App.tsx'],
          validation: ['cd apps/desktop && bun run --bun test src/App.test.tsx'],
          scopeRationale: 'issue #46 only allows the AppContext-side wiring',
        },
      ],
    }, 2, 'human-needed')

    expect(comment).toContain('<!-- agent-loop:review-feedback ')
    expect(comment).toContain('"mustFix":["remove dashboard bootstrap from the login path"]')
    expect(comment).toContain('## Automated review still failing')
  })

  test('includes headRefOid metadata when provided in PR review comments', () => {
    const comment = buildPrReviewComment(61, {
      approved: true,
      canMerge: true,
      reason: 'ready',
      findings: [],
    }, 2, 'approved', 'abc123def456')

    expect(comment).toContain('"headRefOid":"abc123def456"')
  })

  test('embeds linked issue contract fingerprint when provided in PR review comments', () => {
    const issueBody = `## Constraints
- keep the approval bar minimal

## Acceptance
- renders allow once / always allow / reject`
    const comment = buildPrReviewComment(61, {
      approved: true,
      canMerge: true,
      reason: 'ready',
      findings: [],
    }, 2, 'approved', 'abc123def456', issueBody)

    expect(comment).toContain('"issueContractFingerprint":"')
  })

  test('does not embed structured review feedback when the reviewer output itself failed validation', () => {
    const comment = buildPrReviewComment(61, {
      approved: false,
      canMerge: false,
      reason: 'Review output failed validation: missing mustFix',
      reviewFailed: true,
      findings: [
        {
          severity: 'high',
          file: 'apps/desktop/src/App.tsx',
          summary: 'missing contract fields',
        },
      ],
    }, 1, 'human-needed')

    expect(comment).not.toContain('<!-- agent-loop:review-feedback ')
    expect(comment).toContain('## Automated review still failing')
  })

  test('extracts issue number from generated PR titles', () => {
    expect(extractIssueNumberFromPrTitle('Fix #45: [US1-1] App 路由守卫最小骨架')).toBe(45)
    expect(extractIssueNumberFromPrTitle('[US1-1] App 路由守卫最小骨架')).toBeNull()
  })

  test('extracts linked issue number from PR body closing keywords', () => {
    expect(extractIssueNumberFromPrBody('## Summary\n\nFixes #46\n')).toBe(46)
    expect(extractIssueNumberFromPrBody('Resolves #108 with follow-up cleanup')).toBe(108)
    expect(extractIssueNumberFromPrBody('No linked issue here')).toBeNull()
  })

  test('builds review prompt with linked issue scope and out-of-scope guardrails', () => {
    const prompt = buildReviewPrompt(61, 'https://example.com/pr/61', 'owner/repo', {
      title: 'Fix #46: [US1-2] AppContext 增加最小 auth/navigation 接口',
      body: 'Fixes #46',
      headRefName: 'agent/46/codex-20260403',
      files: [
        {
          path: 'apps/desktop/src/context/AppContext.tsx',
          additions: 10,
          deletions: 0,
        },
      ],
      diff: 'diff --git a/apps/desktop/src/context/AppContext.tsx b/apps/desktop/src/context/AppContext.tsx',
      linkedIssue: {
        number: 46,
        title: '[US1-2] AppContext 增加最小 auth/navigation 接口',
        body: `## Constraints
- 只补以下最小接口：token、currentPath、navigate、setAuth、clearAuth。
- 不接 API，不做 token 持久化。`,
      },
    })

    expect(prompt).toContain('Linked Issue #46: [US1-2] AppContext 增加最小 auth/navigation 接口')
    expect(prompt).toContain('Use the linked issue as the primary scope and acceptance contract for the review.')
    expect(prompt).toContain('Do not reject for intentionally out-of-scope work')
    expect(prompt).toContain('treat them as an executable review contract')
    expect(prompt).toContain('不接 API，不做 token 持久化')
    expect(prompt).toContain('Every rejection finding is mandatory contract data')
  })

  test('builds a repair prompt that feeds validation failures back into the reviewer before commenting', () => {
    const prompt = buildReviewRepairPrompt(
      'Base review prompt',
      '{"approved":false,"canMerge":false,"findings":[{"summary":"missing fields"}]}',
      'Review output failed validation: missing mustFix',
      2,
    )

    expect(prompt).toContain('Base review prompt')
    expect(prompt).toContain('Repair attempt: 2')
    expect(prompt).toContain('Review output failed validation: missing mustFix')
    expect(prompt).toContain('Previous response:')
    expect(prompt).toContain('Return corrected JSON only.')
  })

  test('extracts the latest automated review reasons from PR comments', () => {
    expect(extractAutomatedReviewReasons([
      {
        body: `<!-- agent-loop:pr-review {"pr":60,"attempt":1,"approved":false,"canMerge":false} -->
## Automated review found blocking issues — starting one auto-fix retry

- Attempt: 1
- Merge ready: no
- Reason: First blocker

Next step: daemon will attempt one automatic fix on the same branch.`,
      },
      {
        body: `<!-- agent-loop:pr-review {"pr":60,"attempt":2,"approved":false,"canMerge":false} -->
<!-- agent-loop:review-feedback {"approved":false,"canMerge":false,"reason":"Second blocker","findings":[{"severity":"high","file":"apps/desktop/src/App.tsx","summary":"login page never renders","mustFix":["restore the login route"],"mustNotDo":["do not add API calls"],"validation":["cd apps/desktop && bun run --bun test src/App.test.tsx"],"scopeRationale":"required by the linked issue contract"},{"severity":"medium","file":"apps/desktop/src/test/setup.ts","summary":"root test command is broken"}]} -->
## Automated review still failing — human intervention required

- Attempt: 2
- Merge ready: no
- Reason: Second blocker
- Findings:
  - high in apps/desktop/src/App.tsx: login page never renders
  - medium in apps/desktop/src/test/setup.ts: root test command is broken

Next step: stopping automation and leaving the worktree/branch for a human.`,
      },
    ])).toEqual([
      'First blocker',
    ])
  })

  test('extracts the latest automated PR review attempt metadata', () => {
    expect(extractLatestAutomatedPrReviewState([
      {
        createdAt: '2026-04-05T08:00:00.000Z',
        updatedAt: '2026-04-05T08:10:00.000Z',
        body: `<!-- agent-loop:pr-review {"pr":84,"attempt":1,"approved":false,"canMerge":false,"headRefOid":"abc123"} -->
<!-- agent-loop:review-feedback {"approved":false,"canMerge":false,"reason":"First blocker","findings":[{"severity":"high","file":"apps/desktop/src/pages/MainPage.tsx","summary":"retry success regressed","mustFix":["restore success-list semantics"],"mustNotDo":["do not add selection state"],"validation":["bun --cwd apps/desktop test src/pages/MainPage.test.tsx"],"scopeRationale":"issue #76 requires preserving success semantics"}]} -->
## Automated review found blocking issues — starting one auto-fix retry`,
      },
    ])).toEqual({
      metadata: {
        pr: 84,
        attempt: 1,
        approved: false,
        canMerge: false,
        headRefOid: 'abc123',
      },
      feedback: {
        approved: false,
        canMerge: false,
        reason: 'First blocker',
        findings: [
          {
            severity: 'high',
            file: 'apps/desktop/src/pages/MainPage.tsx',
            summary: 'retry success regressed',
            mustFix: ['restore success-list semantics'],
            mustNotDo: ['do not add selection state'],
            validation: ['bun --cwd apps/desktop test src/pages/MainPage.test.tsx'],
            scopeRationale: 'issue #76 requires preserving success semantics',
          },
        ],
      },
      commentCreatedAt: '2026-04-05T08:00:00.000Z',
      commentUpdatedAt: '2026-04-05T08:10:00.000Z',
    })
  })

  test('extracts the latest automated PR review blocker summary', () => {
    expect(extractLatestAutomatedPrReviewBlockerSummary([
      {
        createdAt: '2026-04-05T08:00:00.000Z',
        updatedAt: '2026-04-05T08:10:00.000Z',
        body: `<!-- agent-loop:pr-review {"pr":84,"attempt":1,"approved":false,"canMerge":false,"headRefOid":"abc123"} -->
<!-- agent-loop:review-feedback {"approved":false,"canMerge":false,"reason":"Approval bar flow regressed","findings":[{"severity":"high","file":"apps/desktop/src/pages/MainPage.tsx","summary":"approval CTA no longer opens the existing action flow","mustFix":["restore the approval action handlers"],"mustNotDo":["do not replace the approval bar with execution log UI"],"validation":["bun --cwd apps/desktop test src/pages/MainPage.approval-bar.test.tsx"],"scopeRationale":"issue #105 requires preserving the approval-bar contract while adding logging"}]} -->
## Automated review still failing — human intervention required`,
      },
    ])).toEqual({
      attempt: 1,
      reason: 'Approval bar flow regressed',
      findingSummary: 'approval CTA no longer opens the existing action flow',
      commentCreatedAt: '2026-04-05T08:00:00.000Z',
      commentUpdatedAt: '2026-04-05T08:10:00.000Z',
    })
  })

  test('allows standalone review to resume from a valid structured human-needed comment', () => {
    const comments = [
      {
        body: `<!-- agent-loop:pr-review {"pr":84,"attempt":1,"approved":false,"canMerge":false,"headRefOid":"abc123"} -->
<!-- agent-loop:review-feedback {"approved":false,"canMerge":false,"reason":"First blocker","findings":[{"severity":"high","file":"apps/desktop/src/pages/MainPage.tsx","summary":"retry success regressed","mustFix":["restore success-list semantics"],"mustNotDo":["do not add selection state"],"validation":["bun --cwd apps/desktop test src/pages/MainPage.test.tsx"],"scopeRationale":"issue #76 requires preserving success semantics"}]} -->
## Automated review found blocking issues — starting one auto-fix retry`,
      },
    ]

    expect(canResumeAutomatedPrReview(comments, 3)).toBe(true)
    expect(getNextAutomatedPrReviewAttempt(comments)).toBe(2)
  })

  test('does not resume standalone review when the latest automated comment lacks valid structured feedback', () => {
    const comments = [
      {
        body: `<!-- agent-loop:pr-review {"pr":84,"attempt":2,"approved":false,"canMerge":false,"headRefOid":"abc123"} -->
<!-- agent-loop:review-feedback {"approved":false,"canMerge":false,"reason":"Bad blocker","findings":[{"severity":"high","file":"apps/desktop/src/pages/MainPage.tsx","summary":"missing repair contract"}]} -->
## Automated review still failing — human intervention required`,
      },
    ]

    expect(canResumeAutomatedPrReview(comments, 3)).toBe(false)
    expect(getNextAutomatedPrReviewAttempt(comments)).toBe(3)
  })

  test('restarts standalone review when a terminal human-needed PR has a new head commit', () => {
    const comments = [
      {
        body: `<!-- agent-loop:pr-review {"pr":84,"attempt":9,"approved":false,"canMerge":false,"headRefOid":"abc123"} -->
<!-- agent-loop:review-feedback {"approved":false,"canMerge":false,"reason":"Final blocker","findings":[{"severity":"high","file":"apps/desktop/src/pages/MainPage.tsx","summary":"scope violation","mustFix":["remove forbidden diff"],"mustNotDo":["do not broaden scope"],"validation":["bun --cwd apps/desktop test src/pages/MainPage.sessions-sidebar.test.tsx"],"scopeRationale":"issue #91 limits allowed files"}]} -->
## Automated review still failing — human intervention required`,
      },
    ]

    expect(canResumeAutomatedPrReview(comments, 3)).toBe(false)
    expect(shouldRestartAutomatedPrReviewOnNewHead(comments, 'def456')).toBe(true)
    expect(shouldRestartAutomatedPrReviewOnNewHead(comments, 'abc123')).toBe(false)
  })

  test('restarts standalone review only when the linked issue contract changes after the latest automated review', () => {
    const issueBody = `## Constraints
- keep the approval bar minimal

## Acceptance
- renders allow once / always allow / reject`
    const comments = [
      {
        createdAt: '2026-04-05T08:00:00.000Z',
        updatedAt: '2026-04-05T08:10:00.000Z',
        body: buildPrReviewComment(84, {
          approved: false,
          canMerge: false,
          reason: 'Final blocker',
          findings: [{
            severity: 'high',
            file: 'apps/desktop/src/pages/MainPage.tsx',
            summary: 'scope violation',
            mustFix: ['remove forbidden diff'],
            mustNotDo: ['do not broaden scope'],
            validation: ['bun --cwd apps/desktop test src/pages/MainPage.sessions-sidebar.test.tsx'],
            scopeRationale: 'issue #91 limits allowed files',
          }],
        }, 9, 'human-needed', 'abc123', issueBody),
      },
    ]

    const updatedIssueBody = `## Constraints
- keep the approval bar minimal

## Acceptance
- renders allow once / always allow / reject
- preserves the approval event payload names`

    expect(shouldRestartAutomatedPrReviewOnIssueUpdate(comments, issueBody)).toBe(false)
    expect(shouldRestartAutomatedPrReviewOnIssueUpdate(comments, updatedIssueBody)).toBe(true)
    expect(canResumeHumanNeededPrReview(comments, 3, 'abc123', issueBody)).toBe(false)
    expect(canResumeHumanNeededPrReview(comments, 3, 'abc123', updatedIssueBody)).toBe(true)
  })

  test('does not restart standalone review from legacy comments that only differ by issue timestamp', () => {
    const comments = [
      {
        createdAt: '2026-04-05T08:00:00.000Z',
        updatedAt: '2026-04-05T08:10:00.000Z',
        body: `<!-- agent-loop:pr-review {"pr":84,"attempt":9,"approved":false,"canMerge":false,"headRefOid":"abc123"} -->
<!-- agent-loop:review-feedback {"approved":false,"canMerge":false,"reason":"Final blocker","findings":[{"severity":"high","file":"apps/desktop/src/pages/MainPage.tsx","summary":"scope violation","mustFix":["remove forbidden diff"],"mustNotDo":["do not broaden scope"],"validation":["bun --cwd apps/desktop test src/pages/MainPage.sessions-sidebar.test.tsx"],"scopeRationale":"issue #91 limits allowed files"}]} -->
## Automated review still failing — human intervention required`,
      },
    ]

    expect(shouldRestartAutomatedPrReviewOnIssueUpdate(comments, '2026-04-05T08:10:01.000Z')).toBe(false)
  })

  test('reuses the latest structured review feedback when the PR head sha is unchanged', () => {
    const comments = [
      {
        body: `<!-- agent-loop:pr-review {"pr":84,"attempt":2,"approved":false,"canMerge":false,"headRefOid":"abc123"} -->
<!-- agent-loop:review-feedback {"approved":false,"canMerge":false,"reason":"Second blocker","findings":[{"severity":"high","file":"apps/desktop/src/pages/MainPage.tsx","summary":"retry success regressed","mustFix":["restore success-list semantics"],"mustNotDo":["do not add selection state"],"validation":["bun --cwd apps/desktop test src/pages/MainPage.test.tsx"],"scopeRationale":"issue #76 requires preserving success semantics"}]} -->
## Automated review still failing — human intervention required`,
      },
    ]

    expect(getReusableAutomatedPrReviewFeedback(comments, 'abc123', 3)).toEqual({
      attempt: 2,
      feedback: {
        approved: false,
        canMerge: false,
        reason: 'Second blocker',
        findings: [
          {
            severity: 'high',
            file: 'apps/desktop/src/pages/MainPage.tsx',
            summary: 'retry success regressed',
            mustFix: ['restore success-list semantics'],
            mustNotDo: ['do not add selection state'],
            validation: ['bun --cwd apps/desktop test src/pages/MainPage.test.tsx'],
            scopeRationale: 'issue #76 requires preserving success semantics',
          },
        ],
      },
    })
    expect(getReusableAutomatedPrReviewFeedback(comments, 'def456', 3)).toBeNull()
  })

  test('parses structured review findings with repair constraints', () => {
    expect(parsePrReviewResponse(`{
      "approved": false,
      "canMerge": false,
      "reason": "routing contract broken",
      "findings": [
        {
          "severity": "high",
          "file": "apps/desktop/src/context/AppContext.tsx",
          "summary": "navigate no longer preserves currentPath",
          "mustFix": ["restore currentPath updates"],
          "mustNotDo": ["do not add login persistence"],
          "validation": ["cd apps/desktop && bun run --bun test src/App.test.tsx"],
          "scopeRationale": "the linked issue explicitly requires currentPath + navigate semantics"
        }
      ]
    }`)).toEqual({
      approved: false,
      canMerge: false,
      reason: 'routing contract broken',
      findings: [
        {
          severity: 'high',
          file: 'apps/desktop/src/context/AppContext.tsx',
          summary: 'navigate no longer preserves currentPath',
          mustFix: ['restore currentPath updates'],
          mustNotDo: ['do not add login persistence'],
          validation: ['cd apps/desktop && bun run --bun test src/App.test.tsx'],
          scopeRationale: 'the linked issue explicitly requires currentPath + navigate semantics',
        },
      ],
    })
  })

  test('marks rejection output invalid when a finding omits required repair contract fields', () => {
    expect(parsePrReviewResponse(`{
      "approved": false,
      "canMerge": false,
      "reason": "routing contract broken",
      "findings": [
        {
          "severity": "high",
          "file": "apps/desktop/src/context/AppContext.tsx",
          "summary": "navigate no longer preserves currentPath"
        }
      ]
    }`)).toEqual({
      approved: false,
      canMerge: false,
      reason: 'Review output failed validation: every rejection finding must include mustFix, mustNotDo, validation, and scopeRationale. finding 1 in apps/desktop/src/context/AppContext.tsx (navigate no longer preserves currentPath) missing mustFix, mustNotDo, validation, scopeRationale',
      reviewFailed: true,
      findings: [
        {
          severity: 'high',
          file: 'apps/desktop/src/context/AppContext.tsx',
          summary: 'navigate no longer preserves currentPath',
        },
      ],
    })
  })

  test('flags rejected reviews without findings as invalid', () => {
    expect(validateRejectedReviewFindings({
      approved: false,
      canMerge: false,
      findings: [],
    })).toEqual([
      {
        findingIndex: 1,
        file: '',
        summary: 'missing rejection finding',
        missingFields: ['mustFix', 'mustNotDo', 'validation', 'scopeRationale'],
      },
    ])
  })

  test('ignores invalid structured review comments when extracting retry context', () => {
    expect(extractAutomatedReviewReasons([
      {
        body: `<!-- agent-loop:pr-review {"pr":63,"attempt":1,"approved":false,"canMerge":false} -->
<!-- agent-loop:review-feedback {"approved":false,"canMerge":false,"reason":"Bad blocker","findings":[{"severity":"high","file":"apps/desktop/src/App.tsx","summary":"missing contract fields"}]} -->
## Automated review found blocking issues

- Attempt: 1
- Merge ready: no
- Reason: Bad blocker`,
      },
    ])).toEqual([])
  })

  test('retries invalid reviewer output internally before returning a result', async () => {
    const prompts: string[] = []
    let calls = 0

    const result = await reviewPrAgainstContext(
      61,
      'https://example.com/pr/61',
      '/tmp/review-worktree',
      'JamesWuHK/digital-employee',
      {
        title: 'Fix #46: [US1-2] AppContext 增加最小 auth/navigation 接口',
        body: 'Fixes #46',
        headRefName: 'agent/46/codex-20260403',
        files: [
          {
            path: 'apps/desktop/src/context/AppContext.tsx',
            additions: 10,
            deletions: 0,
          },
        ],
        diff: 'diff --git a/apps/desktop/src/context/AppContext.tsx b/apps/desktop/src/context/AppContext.tsx',
        linkedIssue: {
          number: 46,
          title: '[US1-2] AppContext 增加最小 auth/navigation 接口',
          body: `## Constraints
- 只补最小接口
- 不接 API，不做 token 持久化`,
        },
      },
      TEST_CONFIG,
      console,
      async (prompt) => {
        prompts.push(prompt)
        calls += 1

        if (calls === 1) {
          return {
            responseText: `{
              "approved": false,
              "canMerge": false,
              "reason": "routing contract broken",
              "findings": [
                {
                  "severity": "high",
                  "file": "apps/desktop/src/context/AppContext.tsx",
                  "summary": "navigate no longer preserves currentPath"
                }
              ]
            }`,
          }
        }

        return {
          responseText: `{
            "approved": false,
            "canMerge": false,
            "reason": "routing contract broken",
            "findings": [
              {
                "severity": "high",
                "file": "apps/desktop/src/context/AppContext.tsx",
                "summary": "navigate no longer preserves currentPath",
                "mustFix": ["restore currentPath updates"],
                "mustNotDo": ["do not add login persistence"],
                "validation": ["cd apps/desktop && bun run --bun test src/App.test.tsx"],
                "scopeRationale": "the linked issue explicitly requires currentPath + navigate semantics"
              }
            ]
          }`,
        }
      },
    )

    expect(calls).toBe(2)
    expect(prompts[1]).toContain('Repair attempt: 2')
    expect(result).toEqual({
      approved: false,
      canMerge: false,
      reason: 'routing contract broken',
      findings: [
        {
          severity: 'high',
          file: 'apps/desktop/src/context/AppContext.tsx',
          summary: 'navigate no longer preserves currentPath',
          mustFix: ['restore currentPath updates'],
          mustNotDo: ['do not add login persistence'],
          validation: ['cd apps/desktop && bun run --bun test src/App.test.tsx'],
          scopeRationale: 'the linked issue explicitly requires currentPath + navigate semantics',
        },
      ],
    })
  })

  test('normalizes detached review worktree paths to their real path', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pr-reviewer-test-'))

    try {
      expect(normalizeWorktreePath(tempDir)).toBe(realpathSync(tempDir))
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('collects repo dependency directories without descending into node_modules contents', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pr-reviewer-test-'))
    const repoRoot = join(tempDir, 'repo')

    try {
      mkdirSync(join(repoRoot, 'node_modules'), { recursive: true })
      mkdirSync(join(repoRoot, 'apps', 'desktop', 'node_modules'), { recursive: true })
      mkdirSync(join(repoRoot, 'packages', 'agent-shared', 'node_modules'), { recursive: true })
      mkdirSync(join(repoRoot, 'node_modules', '.bun', 'node_modules'), { recursive: true })

      expect(collectDependencyDirectories(repoRoot)).toEqual([
        'apps/desktop/node_modules',
        'node_modules',
        'packages/agent-shared/node_modules',
      ])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('hydrates detached review worktree with dependency symlinks', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pr-reviewer-test-'))
    const repoRoot = join(tempDir, 'repo')
    const worktreePath = join(tempDir, 'worktree')

    try {
      mkdirSync(join(repoRoot, 'node_modules'), { recursive: true })
      mkdirSync(join(repoRoot, 'apps', 'desktop', 'node_modules'), { recursive: true })
      mkdirSync(join(worktreePath, 'apps', 'desktop'), { recursive: true })

      hydrateDetachedReviewWorktree(repoRoot, worktreePath, console)

      const rootNodeModules = join(worktreePath, 'node_modules')
      const desktopNodeModules = join(worktreePath, 'apps', 'desktop', 'node_modules')

      expect(existsSync(rootNodeModules)).toBe(true)
      expect(existsSync(desktopNodeModules)).toBe(true)
      expect(lstatSync(rootNodeModules).isSymbolicLink()).toBe(true)
      expect(lstatSync(desktopNodeModules).isSymbolicLink()).toBe(true)
      expect(realpathSync(rootNodeModules)).toBe(realpathSync(join(repoRoot, 'node_modules')))
      expect(realpathSync(desktopNodeModules)).toBe(realpathSync(join(repoRoot, 'apps', 'desktop', 'node_modules')))
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('hydrates detached review worktree by replacing stale dependency directories', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pr-reviewer-test-'))
    const repoRoot = join(tempDir, 'repo')
    const worktreePath = join(tempDir, 'worktree')

    try {
      mkdirSync(join(repoRoot, 'node_modules'), { recursive: true })
      mkdirSync(join(repoRoot, 'apps', 'desktop', 'node_modules'), { recursive: true })
      writeFileSync(join(repoRoot, 'apps', 'desktop', 'node_modules', 'vitest'), 'source\n', 'utf8')

      mkdirSync(join(worktreePath, 'node_modules'), { recursive: true })
      mkdirSync(join(worktreePath, 'apps', 'desktop', 'node_modules'), { recursive: true })
      writeFileSync(join(worktreePath, 'apps', 'desktop', 'node_modules', 'stale.txt'), 'stale\n', 'utf8')

      hydrateDetachedReviewWorktree(repoRoot, worktreePath, console)

      const rootNodeModules = join(worktreePath, 'node_modules')
      const desktopNodeModules = join(worktreePath, 'apps', 'desktop', 'node_modules')

      expect(lstatSync(rootNodeModules).isSymbolicLink()).toBe(true)
      expect(lstatSync(desktopNodeModules).isSymbolicLink()).toBe(true)
      expect(realpathSync(rootNodeModules)).toBe(realpathSync(join(repoRoot, 'node_modules')))
      expect(realpathSync(desktopNodeModules)).toBe(realpathSync(join(repoRoot, 'apps', 'desktop', 'node_modules')))
      expect(existsSync(join(desktopNodeModules, 'stale.txt'))).toBe(false)
      expect(readFileSync(join(desktopNodeModules, 'vitest'), 'utf8')).toBe('source\n')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('hydrates detached review worktree without surfacing dependency symlinks as git changes', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pr-reviewer-test-'))
    const repoRoot = join(tempDir, 'repo')
    const worktreePath = join(tempDir, 'worktree')

    try {
      mkdirSync(join(repoRoot, 'node_modules'), { recursive: true })
      mkdirSync(join(repoRoot, '.kilo', 'node_modules'), { recursive: true })
      mkdirSync(join(repoRoot, 'apps', 'desktop', 'node_modules'), { recursive: true })
      writeFileSync(join(repoRoot, 'README.md'), 'seed\n', 'utf8')
      writeFileSync(join(repoRoot, '.kilo', 'config.json'), '{}\n', 'utf8')
      writeFileSync(join(repoRoot, 'apps', 'desktop', 'package.json'), '{}\n', 'utf8')

      await Bun.$`git -C ${repoRoot} init -b main`.quiet()
      await Bun.$`git -C ${repoRoot} config user.name ${TEST_CONFIG.git.authorName}`.quiet()
      await Bun.$`git -C ${repoRoot} config user.email ${TEST_CONFIG.git.authorEmail}`.quiet()
      await Bun.$`git -C ${repoRoot} add README.md .kilo/config.json apps/desktop/package.json`.quiet()
      await Bun.$`git -C ${repoRoot} commit -m "chore: init"`.quiet()
      await Bun.$`git -C ${repoRoot} worktree add --detach ${worktreePath} HEAD`.quiet()

      hydrateDetachedReviewWorktree(repoRoot, worktreePath, console)

      const status = (await Bun.$`git -C ${worktreePath} status --short`.quiet().text()).trim()
      const excludePath = (await Bun.$`git -C ${worktreePath} rev-parse --git-path info/exclude`.quiet().text()).trim()
      const excludeContent = readFileSync(excludePath, 'utf8')

      expect(status).toBe('')
      expect(excludeContent).toContain('/node_modules')
      expect(excludeContent).toContain('/.kilo/node_modules')
      expect(excludeContent).toContain('/apps/desktop/node_modules')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
