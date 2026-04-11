import { describe, expect, test } from 'bun:test'
import {
  formatIssueSimulationResult,
  parseIssueSimulationDocument,
  simulateIssueExecutability,
  type IssueSimulationResult,
} from './issue-simulate'

describe('simulateIssueExecutability', () => {
  test('fails when the simulated plan is not commit-shaped and validation is too weak', async () => {
    const result = await simulateIssueExecutability({
      issueTitle: '[AL-X] 修复 issue 质量',
      issueBody: `## 用户故事

作为 维护者，我希望 issue 能被稳定执行，从而减少 daemon 空转。

## Context

### Dependencies
\`\`\`json
{"dependsOn":[]}
\`\`\`

### AllowedFiles
- apps/agent-daemon/src

### ForbiddenFiles
- apps/agent-daemon/src/daemon.ts

### MustPreserve
- ready gate 现有错误语义不变

### OutOfScope
- runtime evaluator

### RequiredSemantics
- issue 能被稳定拆分并验证

### ReviewHints
- 检查任务是否会退化成纯分析

### Validation
- verify behavior manually
- \`git diff --stat origin/main...HEAD\`

## RED 测试

\`\`\`ts
throw new Error('red')
\`\`\`

## 实现步骤

1. 研究代码
2. 思考方案
3. 之后再实现

## 验收

- [ ] issue 可以被执行`,
      runPlanner: async () => ({
        responseText: `1. Read the codebase and inspect options
2. Analyze the issue and propose an approach`,
      }),
    })

    expect(result.valid).toBe(false)
    expect(result.failures).toContain(
      'planning output does not contain commit-shaped subtasks',
    )
    expect(result.failures).toContain(
      'validation commands are too generic to confirm issue-specific semantics',
    )
    expect(result.summary).toBe('simulation failed')
    expect(result.findings.map((finding) => finding.code)).toEqual([
      'planning_not_commit_shaped',
      'validation_too_generic',
    ])
  })

  test('passes when planner output is commit-shaped and contract boundaries are specific', async () => {
    const result = await simulateIssueExecutability({
      issueTitle: '[AL-Y] 增加 simulate CLI',
      issueBody: `## 用户故事

作为 维护者，我希望 simulate CLI 能稳定输出结构化结果，从而在 ready gate 前发现不可执行 issue。

## Context

### Dependencies
\`\`\`json
{"dependsOn":[17,18,19]}
\`\`\`

### AllowedFiles
- apps/agent-daemon/src/issue-simulate.ts
- apps/agent-daemon/src/issue-simulate.test.ts

### ForbiddenFiles
- apps/agent-daemon/src/daemon.ts

### MustPreserve
- 默认 ready gate 行为不变

### OutOfScope
- 自动创建 GitHub issue

### RequiredSemantics
- simulate 输出结构化 failures

### ReviewHints
- 检查是否保持只读

### Validation
- \`bun test apps/agent-daemon/src/issue-simulate.test.ts\`
- \`git diff --stat origin/main...HEAD\`

## RED 测试

\`\`\`ts
throw new Error('red')
\`\`\`

## 实现步骤

1. 先补失败测试
2. 再补最小实现
3. 最后跑验证

## 验收

- [ ] simulate 可解释失败原因`,
      runPlanner: async () => ({
        responseText: `1. Add the failing issue-simulate test coverage
2. Implement the minimal read-only simulation result checks
3. Run bun test apps/agent-daemon/src/issue-simulate.test.ts`,
      }),
    })

    expect(result.valid).toBe(true)
    expect(result.failures).toEqual([])
    expect(result.summary).toBe('simulation passed')
    expect(result.findings).toEqual([])
  })

  test('parses local markdown documents and preserves full body when there is no h1 title', () => {
    expect(parseIssueSimulationDocument('## 用户故事\nbody', 'draft.md')).toEqual({
      title: 'draft.md',
      body: '## 用户故事\nbody',
    })
  })

  test('formats simulation output as text or json', () => {
    const result: IssueSimulationResult = {
      valid: false,
      summary: 'simulation failed',
      failures: ['planning output does not contain commit-shaped subtasks'],
      findings: [
        {
          code: 'planning_not_commit_shaped',
          stage: 'planner',
          message: 'planning output does not contain commit-shaped subtasks',
        },
      ],
      plannerPrompt: 'prompt',
      plannerOutput: '1. Read the code',
      plannedSubtasks: ['Read the code'],
      checks: {
        commitShapedPlan: false,
        scopedAllowedFiles: true,
        specificValidation: true,
      },
    }

    expect(formatIssueSimulationResult(result)).toContain('valid=false')
    expect(formatIssueSimulationResult(result)).toContain('summary=simulation failed')
    expect(JSON.parse(formatIssueSimulationResult(result, true))).toMatchObject({
      valid: false,
      summary: 'simulation failed',
      failures: ['planning output does not contain commit-shaped subtasks'],
    })
  })
})
