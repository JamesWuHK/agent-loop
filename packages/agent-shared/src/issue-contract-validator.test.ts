import { describe, expect, it } from 'bun:test'
import { parseIssueContract } from './issue-contract'
import { validateIssueContract } from './issue-contract-validator'

function buildExecutableIssue(runtimeRequirementsLines: string[] = []): string {
  const runtimeSection = runtimeRequirementsLines.length > 0
    ? ['### RuntimeRequirements', ...runtimeRequirementsLines]
    : []

  return [
    '## 用户故事',
    '作为用户，我希望完成最小登录页切片。',
    '',
    '## Context',
    '### Dependencies',
    '```json',
    '{ "dependsOn": [] }',
    '```',
    ...runtimeSection,
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
  ].join('\n')
}

describe('validateIssueContract', () => {
  it('accepts executable issue contracts', () => {
    const contract = parseIssueContract(buildExecutableIssue())

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

  it('accepts supported runtime requirements and stays backward compatible when the section is absent', () => {
    const withRuntimeRequirements = parseIssueContract(buildExecutableIssue([
      '- self-hosting',
      '- reviewed-bootstrap-manifest',
    ]))
    const legacyContract = parseIssueContract(buildExecutableIssue())

    expect(validateIssueContract(withRuntimeRequirements)).toEqual({
      valid: true,
      errors: [],
    })
    expect(validateIssueContract(legacyContract)).toEqual({
      valid: true,
      errors: [],
    })
  })

  it('accepts documented backticked runtime requirement tokens', () => {
    const contract = parseIssueContract(buildExecutableIssue([
      '- `self-hosting`',
      '- `reviewed-bootstrap-manifest`',
    ]))

    expect(contract.runtimeRequirements).toEqual([
      'self-hosting',
      'reviewed-bootstrap-manifest',
    ])
    expect(validateIssueContract(contract)).toEqual({
      valid: true,
      errors: [],
    })
  })

  it('rejects unknown runtime requirement tokens', () => {
    const contract = parseIssueContract(buildExecutableIssue([
      '- managed-runtime',
      '- magical-runtime',
    ]))

    expect(validateIssueContract(contract)).toEqual({
      valid: false,
      errors: ['unknown runtime requirement token: magical-runtime'],
    })
  })

  it('rejects duplicate runtime requirement tokens after normalization', () => {
    const contract = parseIssueContract(buildExecutableIssue([
      '- Managed Runtime',
      '- managed runtime',
    ]))

    expect(validateIssueContract(contract)).toEqual({
      valid: false,
      errors: ['duplicate runtime requirement token: managed-runtime'],
    })
  })

  it('rejects explicitly conflicting runtime requirement tokens', () => {
    const contract = parseIssueContract(buildExecutableIssue([
      '- self-hosting',
      '- managed-runtime',
    ]))

    expect(validateIssueContract(contract)).toEqual({
      valid: false,
      errors: ['conflicting runtime requirement tokens: self-hosting, managed-runtime'],
    })
  })
})
