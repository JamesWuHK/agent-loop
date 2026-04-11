import { describe, expect, test } from 'bun:test'
import {
  formatIssueRepairResult,
  repairIssueDraft,
} from './issue-repair'

const BROKEN_ISSUE = [
  '## 用户故事',
  '作为维护者，我希望修复 issue contract。',
  '',
  '## Context',
  '### Dependencies',
  '```json',
  '{ "dependsOn": [50, 51] }',
  '```',
  '### AllowedFiles',
  '- frontend files',
  '### ForbiddenFiles',
  '- apps/agent-daemon/src/dashboard.ts',
  '### MustPreserve',
  '- `dependsOn` JSON 必须保持机器可解析',
  '### OutOfScope',
  '- GitHub 远端写回',
  '### RequiredSemantics',
  '- repair 结果必须仍然是 canonical markdown',
  '### ReviewHints',
  '- 优先检查是否偷偷删掉 Dependencies',
  '### Validation',
  '- 观察一下 issue 看起来是否更清楚',
  '',
  '## RED 测试',
  '```ts',
  'expect(true).toBe(false)',
  '```',
  '',
  '## 实现步骤',
  '1. 修一下',
  '',
  '## 验收',
  '- [ ] issue 更好一些',
].join('\n')

const REPAIRED_ISSUE = [
  '## 用户故事',
  '作为维护者，我希望修复 issue contract，从而让 agent-loop 可以稳定消费高质量 issue。',
  '',
  '## Context',
  '### Dependencies',
  '```json',
  '{ "dependsOn": [50, 51] }',
  '```',
  '### Constraints',
  '- 只修 contract 本身，不写 GitHub 远端',
  '### AllowedFiles',
  '- apps/agent-daemon/src/issue-repair.ts',
  '- apps/agent-daemon/src/issue-repair.test.ts',
  '### ForbiddenFiles',
  '- apps/agent-daemon/src/dashboard.ts',
  '### MustPreserve',
  '- `dependsOn` JSON 必须保持机器可解析',
  '### OutOfScope',
  '- GitHub 远端写回',
  '### RequiredSemantics',
  '- repair 结果必须仍然是 canonical markdown',
  '### ReviewHints',
  '- 优先检查是否偷偷删掉 Dependencies',
  '### Validation',
  '- `bun test apps/agent-daemon/src/issue-repair.test.ts`',
  '- `git diff --stat origin/master...HEAD`',
  '',
  '## RED 测试',
  '```ts',
  'expect(true).toBe(false)',
  '```',
  '',
  '## 实现步骤',
  '1. 先让 repair flow 消费 findings',
  '',
  '## 验收',
  '- [ ] repair 输出通过本地 contract 校验',
].join('\n')

describe('repairIssueDraft', () => {
  test('preserves dependency metadata while repairing lint and simulate findings', async () => {
    const result = await repairIssueDraft({
      issueText: BROKEN_ISSUE,
      repoRoot: '/repo',
      includeSimulation: true,
      lintReport: {
        valid: true,
        readyGateBlocked: false,
        readyGateStatus: 'pass',
        readyGateSummary: 'ok',
        score: 70,
        errors: [],
        warnings: [
          'AllowedFiles should use exact paths or tightly scoped directories: frontend files',
        ],
        source: { kind: 'file', path: 'broken.md' },
        contract: {} as never,
      },
      simulationResult: {
        valid: false,
        summary: 'simulation failed',
        failures: [
          'allowed file scope is too broad for reliable reviewer/auto-fix execution',
          'validation commands are too generic to confirm issue-specific semantics',
        ],
        findings: [
          {
            code: 'allowed_files_too_broad',
            stage: 'reviewer',
            message: 'allowed file scope is too broad for reliable reviewer/auto-fix execution: frontend files',
          },
          {
            code: 'validation_too_generic',
            stage: 'reviewer',
            message: 'validation commands are too generic to confirm issue-specific semantics: 观察一下 issue 看起来是否更清楚',
          },
        ],
        plannerPrompt: 'prompt',
        plannerOutput: '1. Read the issue\n2. Think about it',
        plannedSubtasks: ['Read the issue', 'Think about it'],
        checks: {
          commitShapedPlan: false,
          scopedAllowedFiles: false,
          specificValidation: false,
        },
      },
    }, {
      buildRepoAuthoringContext: async () => ({
        candidateValidationCommands: [
          'bun test apps/agent-daemon/src/issue-repair.test.ts',
        ],
        candidateAllowedFiles: [
          'apps/agent-daemon/src/issue-repair.ts',
          'apps/agent-daemon/src/issue-repair.test.ts',
        ],
        candidateForbiddenFiles: [
          'apps/agent-daemon/src/dashboard.ts',
        ],
        candidateReviewHints: [
          '优先检查 repair 流程是否保留合法的 Dependencies JSON',
        ],
        projectIssueRules: {
          preferredValidationCommands: [
            'bun test apps/agent-daemon/src/issue-repair.test.ts',
          ],
          preferredAllowedFiles: [
            'apps/agent-daemon/src/issue-repair.ts',
            'apps/agent-daemon/src/issue-repair.test.ts',
          ],
          forbiddenPaths: [
            'apps/agent-daemon/src/dashboard.ts',
          ],
          reviewHints: [
            '优先检查 repair 流程是否保留合法的 Dependencies JSON',
          ],
        },
      }),
      runPlanner: async () => ({
        responseText: [
          '1. Add issue-repair.ts and issue-repair.test.ts',
          '2. Run bun test apps/agent-daemon/src/issue-repair.test.ts',
        ].join('\n'),
      }),
      runAgent: async ({ prompt }) => {
        expect(prompt).toContain('Project Issue Rules:')
        expect(prompt).toContain('[allowed_files_too_broad]')
        expect(prompt).toContain('{ "dependsOn": [50, 51] }')

        return {
          responseText: REPAIRED_ISSUE,
        }
      },
    })

    expect(result.repairedMarkdown).toContain('{ "dependsOn": [50, 51] }')
    expect(result.appliedFindingCodes).toEqual([
      'allowed_files_too_broad',
      'validation_too_generic',
    ])
    expect(result.after.validation.valid).toBe(true)
    expect(result.after.simulation?.valid).toBe(true)
    expect(result.success).toBe(true)
  })

  test('returns blocking findings when the repaired draft is still invalid', async () => {
    const result = await repairIssueDraft({
      issueText: BROKEN_ISSUE,
      repoRoot: '/repo',
      includeSimulation: false,
    }, {
      buildRepoAuthoringContext: async () => ({
        candidateValidationCommands: [],
        candidateAllowedFiles: [],
        candidateForbiddenFiles: [],
        candidateReviewHints: [],
        projectIssueRules: {
          preferredValidationCommands: [],
          preferredAllowedFiles: [],
          forbiddenPaths: [],
          reviewHints: [],
        },
      }),
      runAgent: async () => ({
        responseText: '## 用户故事\n只有用户故事',
      }),
    })

    expect(result.success).toBe(false)
    expect(result.blockingFindings).toContain('missing ### Dependencies JSON block')
    const output = JSON.parse(formatIssueRepairResult(result, true))
    expect(output.success).toBe(false)
    expect(output.blockingFindings).toContain('missing ### Dependencies JSON block')
  })
})
