import { describe, expect, test } from 'bun:test'
import {
  auditIssues,
  buildGhIssueViewArgs,
  buildIssueLintReport,
  fetchRemoteIssueDocument,
  formatAuditOutput,
  formatAuditLine,
  formatInvalidReadySection,
  formatIssueLintReport,
  formatIssueLintReportJson,
} from './audit-issue-contracts'

const VALID_CONTRACT = [
  '## 用户故事',
  '作为维护者，我希望批量审计 issue contract。',
  '',
  '## Context',
  '### Dependencies',
  '```json',
  '{ "dependsOn": [] }',
  '```',
  '### AllowedFiles',
  '- apps/agent-daemon/src/audit-issue-contracts.ts',
  '### ForbiddenFiles',
  '- apps/agent-daemon/src/dashboard.ts',
  '### MustPreserve',
  '- 默认 human-readable 输出仍可用',
  '### OutOfScope',
  '- dashboard 可视化',
  '### RequiredSemantics',
  '- 支持 repo-level 审计摘要',
  '### ReviewHints',
  '- 检查 JSON 输出是否稳定',
  '### Validation',
  '- `bun test apps/agent-daemon/src/audit-issue-contracts.test.ts`',
  '',
  '## RED 测试',
  '```ts',
  'expect(true).toBe(false)',
  '```',
  '',
  '## 实现步骤',
  '1. 增加 repo-level summary',
  '',
  '## 验收',
  '- [ ] repo-level summary 可用',
].join('\n')

describe('audit-issue-contracts', () => {
  test('builds a lint report that keeps warnings separate from hard errors', () => {
    const report = buildIssueLintReport([
      '## 用户故事',
      '作为维护者，我希望 issue lint 能发现模糊合同。',
      '',
      '## Context',
      '### Dependencies',
      '```json',
      '{ "dependsOn": [] }',
      '```',
      '### AllowedFiles',
      '- frontend files',
      '### RequiredSemantics',
      '- lint 输出 warning 与 error',
      '### Validation',
      '- `bun test packages/agent-shared/src/issue-quality.test.ts`',
      '- run tests before merge',
      '',
      '## RED 测试',
      '```ts',
      'throw new Error("red")',
      '```',
      '',
      '## 实现步骤',
      '1. 增加 lint 报告',
      '',
      '## 验收',
      '- 输出 warning',
    ].join('\n'), {
      kind: 'file',
      path: '/tmp/issue.md',
    })

    expect(report.valid).toBe(true)
    expect(report.readyGateBlocked).toBe(false)
    expect(report.warnings).toContain(
      'AllowedFiles should use exact paths or tightly scoped directories: frontend files',
    )
    expect(report.warnings).toContain(
      'Validation should use concrete executable commands instead of generic guidance: run tests before merge',
    )
    expect(report.contract).toMatchObject({
      allowedFiles: ['frontend files'],
      hasRedTest: true,
    })
  })

  test('formats blocked lint output with an explicit ready gate summary', () => {
    const report = buildIssueLintReport([
      '## 用户故事',
      '作为维护者，我希望 ready gate 保持 hard error 语义。',
      '',
      '## Context',
      '### Dependencies',
      '```json',
      '{ "dependsOn": [] }',
      '```',
      '### AllowedFiles',
      '- frontend files',
      '### Validation',
      '- `git diff --stat origin/main...HEAD`',
      '',
      '## 实现步骤',
      '1. 只新增 lint',
      '',
      '## 验收',
      '- 保持 ready gate',
    ].join('\n'), {
      kind: 'issue',
      issueNumber: 36,
      repo: 'JamesWuHK/agent-loop',
    })

    expect(formatIssueLintReport(report)).toContain('readyGate=blocked')
    expect(formatIssueLintReport(report)).toContain(
      'readyGateSummary=ready gate would still block on hard validation errors',
    )

    const jsonReport = JSON.parse(formatIssueLintReportJson(report))
    expect(jsonReport).toMatchObject({
      valid: false,
      readyGateBlocked: true,
      readyGateStatus: 'blocked',
      source: {
        kind: 'issue',
        issueNumber: 36,
        repo: 'JamesWuHK/agent-loop',
      },
    })
  })

  test('formats claimability, quality score, and contract errors on one line', () => {
    expect(
      formatAuditLine({
        number: 51,
        title: '[CI-A1] 固定登录相关 smoke tests',
        state: 'ready',
        labels: ['agent:ready'],
        isClaimable: false,
        hasExecutableContract: false,
        claimBlockedBy: [49, 50],
        contractValidationErrors: ['missing ## RED 测试 / RED Tests'],
        qualityScore: 75,
        contractWarnings: ['AllowedFiles should use exact paths or tightly scoped directories: frontend files'],
        contract: {
          source: {
            kind: 'issue',
            issueNumber: 51,
            repo: 'JamesWuHK/agent-loop',
          },
          valid: false,
          readyGateBlocked: true,
          readyGateStatus: 'blocked',
          readyGateSummary: 'ready gate would still block on hard validation errors',
          score: 75,
          errors: ['missing ## RED 测试 / RED Tests'],
          warnings: ['AllowedFiles should use exact paths or tightly scoped directories: frontend files'],
          contract: {
            allowedFiles: ['frontend files'],
          },
        } as any,
      }),
    ).toBe(
      '#51 state=ready claimable=false contract=false score=75 warnings=1 blockedBy=49,50 errors=missing ## RED 测试 / RED Tests',
    )
  })

  test('renders invalid ready sections with both errors and warnings', () => {
    const section = formatInvalidReadySection([
      {
        number: 52,
        title: '[CI-A2] Sprint A 发布前最小检查清单',
        state: 'ready',
        labels: ['agent:ready'],
        isClaimable: false,
        hasExecutableContract: false,
        claimBlockedBy: [],
        contractValidationErrors: [
          'missing ### Dependencies JSON block',
          'missing executable scope contract (AllowedFiles/ForbiddenFiles/MustPreserve/OutOfScope/RequiredSemantics)',
        ],
        qualityScore: 40,
        contractWarnings: [
          'AllowedFiles should use exact paths or tightly scoped directories: frontend files',
        ],
        contract: {
          source: {
            kind: 'issue',
            issueNumber: 52,
            repo: 'JamesWuHK/agent-loop',
          },
          valid: false,
          readyGateBlocked: true,
          readyGateStatus: 'blocked',
          readyGateSummary: 'ready gate would still block on hard validation errors',
          score: 40,
          errors: [
            'missing ### Dependencies JSON block',
            'missing executable scope contract (AllowedFiles/ForbiddenFiles/MustPreserve/OutOfScope/RequiredSemantics)',
          ],
          warnings: [
            'AllowedFiles should use exact paths or tightly scoped directories: frontend files',
          ],
          contract: {
            allowedFiles: ['frontend files'],
          },
        } as any,
      },
    ])

    expect(section).toContain('invalid ready issues:')
    expect(section).toContain('#52 [CI-A2] Sprint A 发布前最小检查清单')
    expect(section).toContain('- missing ### Dependencies JSON block')
    expect(section).toContain('- warning: AllowedFiles should use exact paths or tightly scoped directories: frontend files')
  })

  test('fetches remote issue bodies through gh issue view', async () => {
    expect(buildGhIssueViewArgs(36, 'JamesWuHK/agent-loop')).toEqual([
      'issue',
      'view',
      '36',
      '--repo',
      'JamesWuHK/agent-loop',
      '--json',
      'number,title,body,url',
    ])

    const issue = await fetchRemoteIssueDocument({
      issueNumber: 36,
      config: {
        repo: 'JamesWuHK/agent-loop',
        pat: '',
        machineId: 'codex-dev',
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
        pollIntervalMs: 60_000,
        idlePollIntervalMs: 300_000,
        recovery: {
          heartbeatIntervalMs: 30_000,
          leaseTtlMs: 60_000,
          workerIdleTimeoutMs: 300_000,
          leaseAdoptionBackoffMs: 5_000,
          leaseNoProgressTimeoutMs: 360_000,
        },
        worktreesBase: '/tmp/agent-worktrees',
        project: {
          profile: 'generic',
        },
        agent: {
          primary: 'codex',
          fallback: 'claude',
          claudePath: 'claude',
          codexPath: 'codex',
          timeoutMs: 300_000,
        },
        git: {
          defaultBranch: 'main',
          authorName: 'agent-loop',
          authorEmail: 'agent-loop@example.com',
        },
      },
    }, {
      runIssueViewCommand: async () => ({
        stdout: JSON.stringify({
          number: 36,
          title: '[AL-6] 引入 issue quality report 与 lint CLI',
          body: '## 用户故事\n作为维护者，我希望 lint 输出稳定 JSON。',
          url: 'https://github.com/JamesWuHK/agent-loop/issues/36',
        }),
        stderr: '',
        exitCode: 0,
      }),
    })

    expect(issue).toEqual({
      number: 36,
      title: '[AL-6] 引入 issue quality report 与 lint CLI',
      body: '## 用户故事\n作为维护者，我希望 lint 输出稳定 JSON。',
      url: 'https://github.com/JamesWuHK/agent-loop/issues/36',
    })
  })

  test('returns stable repo summary and issue quality findings in json mode', async () => {
    const result = await auditIssues({
      issues: [
        {
          number: 71,
          title: '[AL-X] invalid contract',
          body: '## 用户故事\n只有用户故事',
          state: 'ready',
          labels: ['agent:ready'],
          isClaimable: true,
          claimBlockedBy: [],
          hasExecutableContract: false,
          contractValidationErrors: ['missing ### Dependencies JSON block'],
        },
        {
          number: 72,
          title: '[AL-Y] valid contract',
          body: VALID_CONTRACT,
          state: 'ready',
          labels: ['agent:ready'],
          isClaimable: true,
          claimBlockedBy: [],
          hasExecutableContract: true,
          contractValidationErrors: [],
        },
      ],
      repo: 'JamesWuHK/agent-loop',
      includeSimulation: false,
    })

    expect(result.summary).toEqual({
      auditedIssueCount: 2,
      invalidIssueCount: 1,
      invalidReadyIssueCount: 1,
      lowScoreIssueCount: 1,
      warningIssueCount: 0,
    })
    expect(result.issues[0]?.contract.errors).toContain('missing ### Dependencies JSON block')
    const parsed = JSON.parse(formatAuditOutput(result, true))
    expect(parsed.summary).toMatchObject({
      invalidIssueCount: 1,
    })
    expect(parsed.issues[0]).toMatchObject({
      number: 71,
      state: 'ready',
    })
  })
})
