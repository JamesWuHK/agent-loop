import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatIssueSimulationOutput,
  simulateIssueExecutability,
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
- \`bun test\`
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
      repoRoot: '/tmp/repo',
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
    expect(result.failures).toContain(
      'allowed file scope is too broad for reliable review/auto-fix: apps/agent-daemon/src',
    )
  })

  test('passes when planning output is commit-shaped and validation is issue-specific', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'issue-simulate-pass-'))

    try {
      mkdirSync(join(repoRoot, 'apps', 'agent-daemon', 'src'), { recursive: true })
      writeFileSync(join(repoRoot, 'apps', 'agent-daemon', 'src', 'issue-simulate.test.ts'), 'test', 'utf-8')

      const result = await simulateIssueExecutability({
        issueTitle: '[AL-X] 增加 issue simulate',
        issueBody: `## 用户故事

作为 维护者，我希望 issue simulate 能提前暴露 contract 执行风险。

## Context

### Dependencies
\`\`\`json
{"dependsOn":[]}
\`\`\`

### AllowedFiles
- apps/agent-daemon/src/issue-simulate.ts
- apps/agent-daemon/src/issue-simulate.test.ts

### ForbiddenFiles
- apps/agent-daemon/src/daemon.ts

### MustPreserve
- simulation 保持只读

### OutOfScope
- runtime evaluator

### RequiredSemantics
- 输出结构化 simulation 结果

### ReviewHints
- 检查 failures 是否可解释

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

- [ ] simulation 可输出结构化结果`,
        repoRoot,
        runPlanner: async () => ({
          responseText: `1. Add simulation result structures in apps/agent-daemon/src/issue-simulate.ts
2. Update CLI tests in apps/agent-daemon/src/index.test.ts`,
        }),
      })

      expect(result.valid).toBe(true)
      expect(result.failures).toEqual([])
      expect(result.plannedSubtasks).toHaveLength(2)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  test('returns a structured planner failure instead of throwing', async () => {
    const result = await simulateIssueExecutability({
      issueTitle: '[AL-X] 增加 issue simulate',
      issueBody: validIssueBody(),
      repoRoot: '/tmp/repo',
      runPlanner: async () => {
        throw new Error('planner offline')
      },
    })

    expect(result.valid).toBe(false)
    expect(result.failures).toContain('planner simulation failed: planner offline')
  })
})

describe('formatIssueSimulationOutput', () => {
  test('renders human and json outputs', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'issue-simulate-format-'))

    try {
      mkdirSync(join(repoRoot, 'apps', 'agent-daemon', 'src'), { recursive: true })
      writeFileSync(join(repoRoot, 'apps', 'agent-daemon', 'src', 'issue-simulate.test.ts'), 'test', 'utf-8')

      const result = await simulateIssueExecutability({
        issueTitle: '[AL-X] 增加 issue simulate',
        issueBody: validIssueBody(),
        repoRoot,
        runPlanner: async () => ({
          responseText: '1. Add issue simulate CLI',
        }),
      })

      expect(formatIssueSimulationOutput(result)).toContain('simulate=pass')
      expect(JSON.parse(formatIssueSimulationOutput(result, true))).toMatchObject({
        valid: true,
        plannedSubtasks: ['Add issue simulate CLI'],
      })
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })
})

function validIssueBody(): string {
  return `## 用户故事

作为 维护者，我希望 issue simulate 能提前暴露 contract 执行风险。

## Context

### Dependencies
\`\`\`json
{"dependsOn":[]}
\`\`\`

### AllowedFiles
- apps/agent-daemon/src/issue-simulate.ts

### ForbiddenFiles
- apps/agent-daemon/src/daemon.ts

### MustPreserve
- simulation 保持只读

### OutOfScope
- runtime evaluator

### RequiredSemantics
- 输出结构化 simulation 结果

### ReviewHints
- 检查 failures 是否可解释

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

- [ ] simulation 可输出结构化结果`
}
