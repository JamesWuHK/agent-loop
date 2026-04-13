import { describe, expect, it } from 'bun:test'
import { parseIssueContract } from './issue-contract'
import { buildIssueQualityReport } from './issue-quality'
import { validateIssueContract } from './issue-contract-validator'

describe('buildIssueQualityReport', () => {
  it('keeps vague scope as a warning while preserving hard validation semantics', () => {
    const body = `## 用户故事

作为 维护者，我希望 lint 能发现 issue 质量风险，从而在进入 ready pool 之前修正合同。

## Context

### Dependencies
\`\`\`json
{"dependsOn":[]}
\`\`\`

### AllowedFiles
- frontend files

### ForbiddenFiles
- apps/agent-daemon/src/daemon.ts

### MustPreserve
- ready gate 的 hard errors 语义不变

### OutOfScope
- 自动改写 issue body

### RequiredSemantics
- lint 结果要能区分 errors 和 warnings

### ReviewHints
- 检查 AllowedFiles 是否足够具体

### Validation
- \`bun test packages/agent-shared/src/issue-quality.test.ts\`
- \`git diff --stat origin/main...HEAD\`

## RED 测试

\`\`\`ts
throw new Error('red')
\`\`\`

## 实现步骤

1. 补充 quality report
2. 增加 lint 输出
3. 跑验证

## 验收

- [ ] lint 能输出 warning
- [ ] hard errors 语义不变`

    const report = buildIssueQualityReport(parseIssueContract(body))

    expect(report.valid).toBe(true)
    expect(report.errors).toEqual([])
    expect(report.warnings).toContain(
      'AllowedFiles should use exact paths or tightly scoped directories: frontend files',
    )
    expect(report.score).toBeLessThan(100)
  })

  it('emits warnings for fuzzy allowed files and generic validation guidance', () => {
    const body = [
      '## 用户故事',
      '作为用户，我希望补充 issue quality lint 输出。',
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
      'expect(report.warnings.length).toBeGreaterThan(0)',
      '```',
      '',
      '## 实现步骤',
      '1. 构建质量报告',
      '',
      '## 验收',
      '- lint 可以输出 warning',
    ].join('\n')

    const report = buildIssueQualityReport(parseIssueContract(body))

    expect(report.valid).toBe(true)
    expect(report.errors).toEqual([])
    expect(report.warnings).toContain(
      'AllowedFiles should use exact paths or tightly scoped directories: frontend files',
    )
    expect(report.warnings).toContain(
      'Validation should use concrete executable commands instead of generic guidance: run tests before merge',
    )
    expect(report.score).toBeLessThan(100)
  })

  it('does not warn on tightly scoped directories and executable validation commands', () => {
    const body = [
      '## 用户故事',
      '作为用户，我希望 lint 输出稳定报告。',
      '',
      '## Context',
      '### Dependencies',
      '```json',
      '{ "dependsOn": [] }',
      '```',
      '### AllowedFiles',
      '- packages/agent-shared/src',
      '### RequiredSemantics',
      '- ready gate 行为保持稳定',
      '### Validation',
      '- `bun test packages/agent-shared/src/issue-contract-validator.test.ts packages/agent-shared/src/issue-quality.test.ts`',
      '- `bun run typecheck`',
      '',
      '## RED 测试',
      '```ts',
      'expect(report.errors).toEqual([])',
      '```',
      '',
      '## 实现步骤',
      '1. 运行质量检查',
      '',
      '## 验收',
      '- 输出 machine-readable report',
    ].join('\n')

    const report = buildIssueQualityReport(parseIssueContract(body))

    expect(report).toEqual({
      valid: true,
      score: 100,
      errors: [],
      warnings: [],
    })
  })

  it('does not warn on exact allowed file paths even when segments use broad words', () => {
    const body = [
      '## 用户故事',
      '作为用户，我希望精确文件路径不会被误判为模糊范围。',
      '',
      '## Context',
      '### Dependencies',
      '```json',
      '{ "dependsOn": [] }',
      '```',
      '### AllowedFiles',
      '- README.md',
      '- package.json',
      '- packages/ui/button.ts',
      '### RequiredSemantics',
      '- warning 与 error 语义分离',
      '### Validation',
      '- `bun test packages/agent-shared/src/issue-quality.test.ts`',
      '',
      '## RED 测试',
      '```ts',
      "expect(report.warnings).not.toContain('AllowedFiles should use exact paths or tightly scoped directories: README.md')",
      '```',
      '',
      '## 实现步骤',
      '1. 收紧启发式',
      '',
      '## 验收',
      '- 精确路径不误报 warning',
    ].join('\n')

    const report = buildIssueQualityReport(parseIssueContract(body))

    expect(report.valid).toBe(true)
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([])
  })

  it('preserves hard validation errors while still surfacing warnings', () => {
    const body = [
      '## 用户故事',
      '作为用户，我希望 ready gate 仍然只由 hard errors 阻塞。',
      '',
      '## Context',
      '### Dependencies',
      '```json',
      '{ "dependsOn": [] }',
      '```',
      '### AllowedFiles',
      '- frontend files',
      '### RequiredSemantics',
      '- warning 不应改变 ready gate',
      '### Validation',
      '- `git diff --stat origin/main...HEAD`',
      '- verify behavior manually',
      '',
      '## 实现步骤',
      '1. 仅新增 warning',
      '',
      '## 验收',
      '- hard error 不变',
    ].join('\n')

    const contract = parseIssueContract(body)
    const validation = validateIssueContract(contract)
    const report = buildIssueQualityReport(contract, validation)

    expect(validation).toEqual({
      valid: false,
      errors: [
        'missing ## RED 测试 / RED Tests',
        'missing executable test/build/check command in ### Validation',
      ],
    })
    expect(report.valid).toBe(false)
    expect(report.errors).toEqual(validation.errors)
    expect(report.warnings).toContain(
      'AllowedFiles should use exact paths or tightly scoped directories: frontend files',
    )
    expect(report.warnings).toContain(
      'Validation should use concrete executable commands instead of generic guidance: verify behavior manually',
    )
  })

  it('surfaces runtime requirement validation errors through the shared contract validation path', () => {
    const body = [
      '## 用户故事',
      '作为维护者，我希望 quality report 复用 runtime requirement 校验结果。',
      '',
      '## Context',
      '### Dependencies',
      '```json',
      '{ "dependsOn": [] }',
      '```',
      '### RuntimeRequirements',
      '- managed runtime',
      '- magical-runtime',
      '- self-hosting',
      '- managed-runtime',
      '### AllowedFiles',
      '- packages/agent-shared/src/issue-quality.ts',
      '### RequiredSemantics',
      '- runtime requirement 问题进入 errors',
      '### Validation',
      '- `bun test packages/agent-shared/src/issue-quality.test.ts`',
      '',
      '## RED 测试',
      '```ts',
      'expect(report.errors.length).toBeGreaterThan(0)',
      '```',
      '',
      '## 实现步骤',
      '1. 复用 validator 输出',
      '',
      '## 验收',
      '- quality report 暴露 runtime requirement 错误',
    ].join('\n')

    const report = buildIssueQualityReport(parseIssueContract(body))

    expect(report.valid).toBe(false)
    expect(report.errors).toEqual([
      'duplicate runtime requirement token: managed-runtime',
      'unknown runtime requirement token: magical-runtime',
      'conflicting runtime requirement tokens: self-hosting, managed-runtime',
    ])
    expect(report.warnings).toEqual([])
  })
})
