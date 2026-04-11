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
    expect(formatBootstrapGateReport(report)).toContain('ready=true')
  })
})

describe('buildBootstrapGateReportForRepo', () => {
  test('uses deterministic blocker and release evidence issue sets', async () => {
    const seen: number[] = []

    const report = await buildBootstrapGateReportForRepo({
      version: 'v0.2',
      config: {
        repo: 'JamesWuHK/agent-loop',
        pat: 'test-token',
      } as never,
    }, {
      getAgentIssueByNumber: async (issueNumber) => {
        seen.push(issueNumber)

        if (issueNumber === 60 || issueNumber === 61 || issueNumber === 69) {
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
    })

    expect(seen).toEqual([37, 38, 39, 40, 50, 51, 53, 54, 60, 61, 69, 70])
    expect(report.blockers.map((blocker) => blocker.issueNumber)).toEqual([37, 38, 39, 40, 50, 51, 53, 54, 60, 61])
    expect(report.requiredEvidence).toEqual([
      {
        code: 'self_bootstrap_suite_green',
        satisfied: true,
        sourceIssueNumber: 69,
        summary: 'tracked by #69 and currently done',
      },
      {
        code: 'bootstrap_scorecard_green',
        satisfied: false,
        sourceIssueNumber: 70,
        summary: 'awaiting the bootstrap scorecard taxonomy report tracked by #70',
      },
    ])
    expect(report.blockingReasons).toContain('issue #37 is not done (state=ready, labels=agent:ready)')
    expect(report.blockingReasons).toContain('missing required evidence: bootstrap_scorecard_green')
  })
})
