import { describe, expect, it } from 'bun:test'
import { parseIssueContract } from './issue-contract'
import { validateIssueContract } from './issue-contract-validator'

function buildIssue(runtimeRequirementsSection?: string): string {
  const runtimeRequirementsBlock = runtimeRequirementsSection
    ? `### RuntimeRequirements
${runtimeRequirementsSection}
`
    : ''

  return `## 用户故事

作为维护者，我希望 self-hosting issue 显式声明运行前提。

## Context

### Dependencies
\`\`\`json
{"dependsOn":[]}
\`\`\`

### AllowedFiles
- packages/agent-shared/src/issue-contract.ts

### ForbiddenFiles
- apps/agent-daemon/src/daemon.ts

### MustPreserve
- legacy issue compatibility

### OutOfScope
- ready gate enforcement

### RequiredSemantics
- parser returns normalized runtime requirement tokens

${runtimeRequirementsBlock}### Validation
- \`bun test packages/agent-shared/src/issue-contract-validator.test.ts\`

## RED 测试

\`\`\`ts
throw new Error('red')
\`\`\`

## 实现步骤

1. add validator coverage

## 验收

- [ ] runtime requirements are validated
`
}

describe('validateIssueContract', () => {
  it('accepts executable issue contracts', () => {
    const contract = parseIssueContract([
      '## 用户故事',
      '作为用户，我希望完成最小登录页切片。',
      '',
      '## Context',
      '### Dependencies',
      '```json',
      '{ "dependsOn": [] }',
      '```',
      '### AllowedFiles',
      '- apps/desktop/src/pages/LoginPage.tsx',
      '### RequiredSemantics',
      '- 未登录时显示登录页',
      '### Validation',
      '- `bun --cwd apps/desktop test src/pages/LoginPage.test.tsx`',
      '- `git diff --stat origin/main...HEAD`',
      '',
      '## RED 测试',
      '```tsx',
      'expect(true).toBe(false)',
      '```',
      '',
      '## 实现步骤',
      '1. 实现登录页',
      '',
      '## 验收',
      '- 登录页渲染成功',
    ].join('\n'))

    expect(validateIssueContract(contract)).toEqual({
      valid: true,
      errors: [],
    })
  })

  it('keeps legacy issues without runtime requirements valid', () => {
    const contract = parseIssueContract(buildIssue())

    expect(validateIssueContract(contract)).toEqual({
      valid: true,
      errors: [],
    })
  })

  it('accepts known runtime requirement tokens', () => {
    const contract = parseIssueContract(buildIssue(`
- self-hosting
- reviewed bootstrap manifest
`))

    expect(validateIssueContract(contract)).toEqual({
      valid: true,
      errors: [],
    })
  })

  it('reports missing executable fields', () => {
    const contract = parseIssueContract([
      '## 用户故事',
      '只有用户故事，没有其他结构。',
    ].join('\n'))

    expect(validateIssueContract(contract)).toEqual({
      valid: false,
      errors: [
        'missing ### Dependencies JSON block',
        'missing ## 实现步骤 / Implementation Steps',
        'missing ## 验收 / Acceptance',
        'missing ## RED 测试 / RED Tests',
        'missing ### Validation / Validation Commands',
        'missing executable scope contract (AllowedFiles/ForbiddenFiles/MustPreserve/OutOfScope/RequiredSemantics)',
      ],
    })
  })

  it('rejects validation sections without an executable test command', () => {
    const contract = parseIssueContract([
      '## 用户故事',
      '作为用户，我希望完成最小登录页切片。',
      '',
      '## Context',
      '### Dependencies',
      '```json',
      '{ "dependsOn": [] }',
      '```',
      '### AllowedFiles',
      '- apps/desktop/src/pages/LoginPage.tsx',
      '### RequiredSemantics',
      '- 未登录时显示登录页',
      '### Validation',
      '- `git diff --stat origin/main...HEAD`',
      '- 观察页面是否正常',
      '',
      '## RED 测试',
      '```tsx',
      'expect(true).toBe(false)',
      '```',
      '',
      '## 实现步骤',
      '1. 实现登录页',
      '',
      '## 验收',
      '- 登录页渲染成功',
    ].join('\n'))

    expect(validateIssueContract(contract)).toEqual({
      valid: false,
      errors: [
        'missing executable test/build/check command in ### Validation',
      ],
    })
  })

  it('keeps generic test guidance as a hard validation error until a runnable command exists', () => {
    const contract = parseIssueContract([
      '## 用户故事',
      '作为用户，我希望 lint 能稳定识别不可执行的 Validation 描述。',
      '',
      '## Context',
      '### Dependencies',
      '```json',
      '{ "dependsOn": [] }',
      '```',
      '### AllowedFiles',
      '- packages/agent-shared/src/issue-quality.ts',
      '### RequiredSemantics',
      '- warning 不能改变 ready gate',
      '### Validation',
      '- run tests before merge',
      '- verify manually',
      '',
      '## RED 测试',
      '```ts',
      'expect(true).toBe(false)',
      '```',
      '',
      '## 实现步骤',
      '1. 保持 validation 语义稳定',
      '',
      '## 验收',
      '- 不可执行描述仍会阻塞',
    ].join('\n'))

    expect(validateIssueContract(contract)).toEqual({
      valid: false,
      errors: [
        'missing executable validation command in ### Validation',
        'missing executable test/build/check command in ### Validation',
      ],
    })
  })

  it('reports runtime requirement validation errors in a stable order', () => {
    const contract = parseIssueContract(buildIssue(`
- managed runtime
- magical-runtime
- self-hosting
- managed-runtime
`))

    expect(validateIssueContract(contract)).toEqual({
      valid: false,
      errors: [
        'duplicate runtime requirement token: managed-runtime',
        'unknown runtime requirement token: magical-runtime',
        'conflicting runtime requirement tokens: self-hosting, managed-runtime',
      ],
    })
  })
})
