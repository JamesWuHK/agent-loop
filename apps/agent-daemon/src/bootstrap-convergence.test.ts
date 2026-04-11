import { describe, expect, test } from 'bun:test'
import {
  buildBootstrapConvergenceReportForRepo,
  formatBootstrapConvergenceReport,
  resolveBootstrapConvergenceExitCode,
} from './bootstrap-convergence'

describe('buildBootstrapConvergenceReportForRepo', () => {
  test('aggregates suppressed issue and PR drift into actionable convergence items', async () => {
    const report = await buildBootstrapConvergenceReportForRepo({
      config: {
        repo: 'JamesWuHK/agent-loop',
        pat: 'test-token',
      } as never,
    }, {
      buildBootstrapGateReportForRepo: async () => ({
        version: 'v0.2',
        ready: true,
        blockers: [],
        suppressedBlockers: [
          {
            issueNumber: 37,
            state: 'failed',
            labels: ['agent:failed'],
            title: '[AL-7] repo grounded context',
            implementedLocally: true,
            localImplementationHeadline: 'feat(#37): add repo authoring context',
            suppressionKind: 'local_implementation',
          },
        ],
        requiredEvidence: [],
        blockingReasons: [],
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
          pr_lifecycle_failure: 1,
          review_failure: 1,
          github_transport_failure: 0,
          release_process_failure: 0,
        },
        suppressedBlockers: [
          {
            category: 'pr_lifecycle_failure',
            issueNumber: 61,
            prNumber: 73,
            reason: 'linked PR #73 is in terminal agent:human-needed',
            suppressionKind: 'local_implementation',
            localImplementationHeadline: 'Fix #61 gate approved PR merges on check status',
          },
          {
            category: 'review_failure',
            issueNumber: 61,
            prNumber: 73,
            reason: 'checks gate previously misclassified failing checks',
            suppressionKind: 'local_implementation',
            localImplementationHeadline: 'Fix #61 gate approved PR merges on check status',
          },
        ],
        auditSummary: {
          managedIssueCount: 0,
          readyIssueCount: 0,
          invalidReadyIssueCount: 0,
          lowScoreIssueCount: 0,
          warningIssueCount: 0,
        },
      }),
    })

    expect(report.gateReady).toBe(true)
    expect(report.scorecardReady).toBe(true)
    expect(report.converged).toBe(false)
    expect(report.summary).toEqual({
      totalActions: 2,
      issueActions: 1,
      pullRequestActions: 1,
    })
    expect(report.actions).toEqual([
      expect.objectContaining({
        kind: 'issue_state_sync',
        issueNumber: 37,
        remoteState: 'failed',
        recommendedAction: 'sync_issue_state',
      }),
      expect.objectContaining({
        kind: 'pull_request_cleanup',
        issueNumber: 61,
        prNumber: 73,
        recommendedAction: 'close_or_supersede_pr',
        categories: ['pr_lifecycle_failure', 'review_failure'],
        reasons: [
          'linked PR #73 is in terminal agent:human-needed',
          'checks gate previously misclassified failing checks',
        ],
      }),
    ])
    expect(resolveBootstrapConvergenceExitCode(report)).toBe(1)
    expect(formatBootstrapConvergenceReport(report)).toContain('Bootstrap Convergence')
    expect(formatBootstrapConvergenceReport(report)).toContain('pull_request_cleanup')
  })

  test('reports convergence when no suppressed remote drift remains', async () => {
    const report = await buildBootstrapConvergenceReportForRepo({
      config: {
        repo: 'JamesWuHK/agent-loop',
        pat: 'test-token',
      } as never,
    }, {
      buildBootstrapGateReportForRepo: async () => ({
        version: 'v0.2',
        ready: true,
        blockers: [],
        suppressedBlockers: [],
        requiredEvidence: [],
        blockingReasons: [],
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
    })

    expect(report.converged).toBe(true)
    expect(report.actions).toEqual([])
    expect(resolveBootstrapConvergenceExitCode(report)).toBe(0)
  })
})
