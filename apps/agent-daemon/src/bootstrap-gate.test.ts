import { describe, expect, test } from 'bun:test'
import {
  buildBootstrapGateReport,
  buildBootstrapGateReportForRepo,
  formatBootstrapGateReport,
  resolveBootstrapGateExitCode,
} from './bootstrap-gate'

describe('buildBootstrapGateReport', () => {
  test('blocks v0.2 when blockers or release evidence are unresolved', () => {
    const report = buildBootstrapGateReport({
      version: 'v0.2',
      blockers: [
        { issueNumber: 37, state: 'open', labels: ['agent:failed'] },
        { issueNumber: 60, state: 'closed', labels: ['agent:done'] },
      ],
      requiredEvidence: [
        { code: 'self_bootstrap_suite_green', satisfied: false },
      ],
    })

    expect(report.ready).toBe(false)
    expect(report.blockingReasons).toContain('issue #37 is not done (state=open, labels=agent:failed)')
    expect(report.blockingReasons).toContain('missing required evidence: self_bootstrap_suite_green')
    expect(resolveBootstrapGateExitCode(report)).toBe(1)
  })

  test('passes when blockers are done and required evidence is satisfied', () => {
    const report = buildBootstrapGateReport({
      version: 'v0.2',
      blockers: [
        { issueNumber: 37, state: 'done', labels: ['agent:done'] },
        { issueNumber: 60, state: 'closed', labels: ['agent:done'] },
      ],
      requiredEvidence: [
        { code: 'self_bootstrap_suite_green', satisfied: true },
      ],
    })

    expect(report.ready).toBe(true)
    expect(report.blockingReasons).toEqual([])
    expect(resolveBootstrapGateExitCode(report)).toBe(0)
    expect(report.suppressedBlockers).toEqual([])
    expect(formatBootstrapGateReport(report)).toContain('ready=true')
  })

  test('treats locally implemented blockers as satisfied for the current branch gate', () => {
    const report = buildBootstrapGateReport({
      version: 'v0.2',
      blockers: [
        {
          issueNumber: 37,
          state: 'failed',
          labels: ['agent:failed'],
          implementedLocally: true,
          localImplementationHeadline: 'feat(#37): add repo authoring context',
        },
      ],
      requiredEvidence: [
        { code: 'self_bootstrap_suite_green', satisfied: true },
      ],
    })

    expect(report.ready).toBe(true)
    expect(report.blockingReasons).toEqual([])
    expect(report.suppressedBlockers).toEqual([
      expect.objectContaining({
        issueNumber: 37,
        suppressionKind: 'local_implementation',
      }),
    ])
    expect(formatBootstrapGateReport(report)).toContain('locallyImplemented=true')
    expect(formatBootstrapGateReport(report)).toContain('suppressedBlockers:')
  })
})

describe('buildBootstrapGateReportForRepo', () => {
  test('uses deterministic blocker and release evidence issue sets', async () => {
    const seen: number[] = []

    const report = await buildBootstrapGateReportForRepo({
      version: 'v0.2',
      fixturesDir: '/tmp/self-bootstrap-fixtures',
      config: {
        repo: 'JamesWuHK/agent-loop',
        pat: 'test-token',
      } as never,
    }, {
      getAgentIssueByNumber: async (issueNumber) => {
        seen.push(issueNumber)

        if (issueNumber === 60 || issueNumber === 61) {
          return {
            number: issueNumber,
            title: `Issue ${issueNumber}`,
            body: '',
            state: 'done',
            labels: ['agent:done'],
            assignee: null,
            isClaimable: false,
            updatedAt: '2026-04-11T00:00:00.000Z',
            dependencyIssueNumbers: [],
            hasDependencyMetadata: false,
            dependencyParseError: false,
            claimBlockedBy: [],
            hasExecutableContract: true,
            contractValidationErrors: [],
          }
        }

        return {
          number: issueNumber,
          title: `Issue ${issueNumber}`,
          body: '',
          state: 'ready',
          labels: ['agent:ready'],
          assignee: null,
          isClaimable: true,
          updatedAt: '2026-04-11T00:00:00.000Z',
          dependencyIssueNumbers: [],
          hasDependencyMetadata: false,
          dependencyParseError: false,
          claimBlockedBy: [],
          hasExecutableContract: true,
          contractValidationErrors: [],
        }
      },
      evaluateBootstrapScenarioFixtureDirectory: (fixturesDir) => {
        expect(fixturesDir).toBe('/tmp/self-bootstrap-fixtures')

        return {
          suite: 'self-bootstrap-v0.2',
          ok: true,
          cases: [],
          failedCases: [],
          summary: {
            requiredCases: 4,
            presentCases: 4,
            passedCases: 4,
            failedCases: 0,
          },
        }
      },
      buildBootstrapScorecardForRepo: async ({ config }) => {
        expect(config.repo).toBe('JamesWuHK/agent-loop')

        return {
          ready: false,
          categoryCounts: {
            contract_failure: 0,
            runtime_failure: 0,
            pr_lifecycle_failure: 0,
            review_failure: 1,
            github_transport_failure: 0,
            release_process_failure: 0,
          },
          topBlockers: [{
            category: 'review_failure',
            issueNumber: 39,
            prNumber: 81,
            reason: 'auto-fix changed files outside AllowedFiles',
          }],
          suppressedCategoryCounts: {
            contract_failure: 0,
            runtime_failure: 0,
            pr_lifecycle_failure: 0,
            review_failure: 0,
            github_transport_failure: 0,
            release_process_failure: 0,
          },
          suppressedBlockers: [],
          auditSummary: {
            managedIssueCount: 10,
            readyIssueCount: 0,
            invalidReadyIssueCount: 0,
            lowScoreIssueCount: 0,
            warningIssueCount: 0,
          },
        }
      },
      buildLocalImplementationIndex: () => new Map(),
    })

    expect(seen).toEqual([37, 38, 39, 40, 50, 51, 53, 54, 60, 61])
    expect(report.blockers.map((blocker) => blocker.issueNumber)).toEqual([37, 38, 39, 40, 50, 51, 53, 54, 60, 61])
    expect(report.requiredEvidence).toEqual([
      {
        code: 'self_bootstrap_suite_green',
        satisfied: true,
        sourceIssueNumber: 69,
        summary: 'scenario suite self-bootstrap-v0.2 passed (4/4 required cases)',
      },
      {
        code: 'bootstrap_scorecard_green',
        satisfied: false,
        sourceIssueNumber: 70,
        summary: 'bootstrap scorecard still reports blockers: review_failure for #39 / PR #81: auto-fix changed files outside AllowedFiles',
      },
    ])
    expect(report.blockingReasons).toContain('issue #37 is not done (state=ready, labels=agent:ready)')
    expect(report.blockingReasons).toContain('missing required evidence: bootstrap_scorecard_green')
    expect(report.suppressedBlockers).toEqual([])
  })

  test('marks executable evidence missing when local suite evaluation throws', async () => {
    const report = await buildBootstrapGateReportForRepo({
      version: 'v0.2',
      config: {
        repo: 'JamesWuHK/agent-loop',
        pat: 'test-token',
      } as never,
    }, {
      getAgentIssueByNumber: async (issueNumber) => ({
        number: issueNumber,
        title: `Issue ${issueNumber}`,
        body: '',
        state: 'done',
        labels: ['agent:done'],
        assignee: null,
        isClaimable: false,
        updatedAt: '2026-04-11T00:00:00.000Z',
        dependencyIssueNumbers: [],
        hasDependencyMetadata: false,
        dependencyParseError: false,
        claimBlockedBy: [],
        hasExecutableContract: true,
        contractValidationErrors: [],
      }),
      evaluateBootstrapScenarioFixtureDirectory: () => {
        throw new Error('fixtures directory is missing')
      },
      buildBootstrapScorecardForRepo: async () => ({
        ready: true,
        categoryCounts: {
          contract_failure: 0,
          runtime_failure: 0,
          pr_lifecycle_failure: 0,
          review_failure: 0,
          github_transport_failure: 0,
          release_process_failure: 0,
        },
        topBlockers: [],
        suppressedCategoryCounts: {
          contract_failure: 0,
          runtime_failure: 0,
          pr_lifecycle_failure: 0,
          review_failure: 0,
          github_transport_failure: 0,
          release_process_failure: 0,
        },
        suppressedBlockers: [],
        auditSummary: {
          managedIssueCount: 0,
          readyIssueCount: 0,
          invalidReadyIssueCount: 0,
          lowScoreIssueCount: 0,
          warningIssueCount: 0,
        },
      }),
      buildLocalImplementationIndex: () => new Map(),
    })

    expect(report.ready).toBe(false)
    expect(report.requiredEvidence).toEqual([
      {
        code: 'self_bootstrap_suite_green',
        satisfied: false,
        sourceIssueNumber: 69,
        summary: 'scenario suite evaluation failed: fixtures directory is missing',
      },
      {
        code: 'bootstrap_scorecard_green',
        satisfied: true,
        sourceIssueNumber: 70,
        summary: 'bootstrap scorecard reported ready with no blockers',
      },
    ])
    expect(report.blockingReasons).toEqual([
      'missing required evidence: self_bootstrap_suite_green',
    ])
    expect(report.suppressedBlockers).toEqual([])
  })

  test('marks remotely failed blockers as satisfied when the current branch already contains their implementation', async () => {
    const report = await buildBootstrapGateReportForRepo({
      version: 'v0.2',
      config: {
        repo: 'JamesWuHK/agent-loop',
        pat: 'test-token',
      } as never,
    }, {
      getAgentIssueByNumber: async (issueNumber) => ({
        number: issueNumber,
        title: `Issue ${issueNumber}`,
        body: '',
        state: 'failed',
        labels: ['agent:failed'],
        assignee: null,
        isClaimable: false,
        updatedAt: '2026-04-11T00:00:00.000Z',
        dependencyIssueNumbers: [],
        hasDependencyMetadata: false,
        dependencyParseError: false,
        claimBlockedBy: [],
        hasExecutableContract: true,
        contractValidationErrors: [],
      }),
      evaluateBootstrapScenarioFixtureDirectory: () => ({
        suite: 'self-bootstrap-v0.2',
        ok: true,
        cases: [],
        failedCases: [],
        summary: {
          requiredCases: 4,
          presentCases: 4,
          passedCases: 4,
          failedCases: 0,
        },
      }),
      buildBootstrapScorecardForRepo: async () => ({
        ready: true,
        categoryCounts: {
          contract_failure: 0,
          runtime_failure: 0,
          pr_lifecycle_failure: 0,
          review_failure: 0,
          github_transport_failure: 0,
          release_process_failure: 0,
        },
        topBlockers: [],
        suppressedCategoryCounts: {
          contract_failure: 0,
          runtime_failure: 0,
          pr_lifecycle_failure: 0,
          review_failure: 0,
          github_transport_failure: 0,
          release_process_failure: 0,
        },
        suppressedBlockers: [],
        auditSummary: {
          managedIssueCount: 0,
          readyIssueCount: 0,
          invalidReadyIssueCount: 0,
          lowScoreIssueCount: 0,
          warningIssueCount: 0,
        },
      }),
      buildLocalImplementationIndex: () => new Map([
        [37, {
          issueNumber: 37,
          latestCommitHeadline: 'feat(#37): add repo authoring context',
          commitCount: 1,
        }],
        [38, {
          issueNumber: 38,
          latestCommitHeadline: 'feat(#38): add issue rewrite cli',
          commitCount: 1,
        }],
        [39, {
          issueNumber: 39,
          latestCommitHeadline: 'feat(#39): add parent issue splitter',
          commitCount: 1,
        }],
        [40, {
          issueNumber: 40,
          latestCommitHeadline: 'feat(#40): add issue simulate command',
          commitCount: 1,
        }],
        [50, {
          issueNumber: 50,
          latestCommitHeadline: 'feat(#50): add repo issue audit command',
          commitCount: 1,
        }],
        [51, {
          issueNumber: 51,
          latestCommitHeadline: 'feat(#51): inject project issue authoring rules',
          commitCount: 1,
        }],
        [53, {
          issueNumber: 53,
          latestCommitHeadline: 'feat(#53): add issue repair cli',
          commitCount: 1,
        }],
        [54, {
          issueNumber: 54,
          latestCommitHeadline: 'feat(#54): add issue apply cli',
          commitCount: 1,
        }],
        [60, {
          issueNumber: 60,
          latestCommitHeadline: 'fix(#60): reopen replacement PR flow',
          commitCount: 1,
        }],
        [61, {
          issueNumber: 61,
          latestCommitHeadline: 'fix(#61): gate approved PR merges on check status',
          commitCount: 1,
        }],
      ]),
    })

    expect(report.ready).toBe(true)
    expect(report.blockingReasons).toEqual([])
    expect(report.blockers.every((blocker) => blocker.implementedLocally)).toBe(true)
    expect(report.suppressedBlockers).toHaveLength(10)
  })
})
