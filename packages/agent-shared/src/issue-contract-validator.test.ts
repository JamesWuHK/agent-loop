import { describe, expect, it } from 'bun:test'
import { parseIssueContract } from './issue-contract'
import { validateIssueContract } from './issue-contract-validator'

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
})
