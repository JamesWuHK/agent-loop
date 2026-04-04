import { describe, expect, it } from 'bun:test'
import { parseIssueContract, renderIssueContractForPrompt } from './issue-contract'

describe('parseIssueContract', () => {
  it('parses executable contract fields from the issue body', () => {
    const body = [
      '## 用户故事',
      '作为访客，我希望进入系统后先看到登录页。',
      '',
      '## Context',
      '### Dependencies',
      '```json',
      '{ "dependsOn": [41, 42] }',
      '```',
      '### Constraints',
      '- 不接真实 API',
      '- 不改主路由',
      '### AllowedFiles',
      '- apps/web/src/auth.ts',
      '- apps/web/src/login.tsx',
      '### ForbiddenFiles',
      '- apps/web/src/App.tsx',
      '### MustPreserve',
      '- 退出登录后仍然清空本地状态',
      '### OutOfScope',
      '- token 持久化',
      '### RequiredSemantics',
      '- 未登录时只能看到 /login',
      '### ReviewHints',
      '- 检查路由守卫是否被挪到别处',
      '### Validation',
      '- bun test apps/web/src/login.test.tsx',
      '',
      '## 实现步骤',
      '1. 补最小登录态接口',
      '',
      '## RED 测试',
      '```tsx',
      'expect(screen.getByText("登录")).toBeInTheDocument()',
      '```',
      '',
      '## 验收',
      '- 登录前渲染 /login',
      '- 不新增 API 调用',
    ].join('\n')

    expect(parseIssueContract(body)).toEqual({
      userStory: '作为访客，我希望进入系统后先看到登录页。',
      dependencies: [41, 42],
      hasDependencyMetadata: true,
      dependencyParseError: false,
      constraints: ['不接真实 API', '不改主路由'],
      allowedFiles: [
        'apps/web/src/auth.ts',
        'apps/web/src/login.tsx',
      ],
      forbiddenFiles: ['apps/web/src/App.tsx'],
      mustPreserve: ['退出登录后仍然清空本地状态'],
      outOfScope: ['token 持久化'],
      requiredSemantics: ['未登录时只能看到 /login'],
      reviewHints: ['检查路由守卫是否被挪到别处'],
      validation: ['bun test apps/web/src/login.test.tsx'],
      acceptance: ['登录前渲染 /login', '不新增 API 调用'],
      implementationSteps: ['补最小登录态接口'],
      redTest: '```tsx\nexpect(screen.getByText("登录")).toBeInTheDocument()\n```',
    })
  })

  it('renders a compact prompt supplement with machine-readable contract data', () => {
    const rendered = renderIssueContractForPrompt([
      '## Context',
      '### AllowedFiles',
      '- apps/web/src/auth.ts',
      '### ForbiddenFiles',
      '- apps/web/src/App.tsx',
      '### RequiredSemantics',
      '- 未登录时保留在 /login',
    ].join('\n'))

    expect(rendered).toContain('Parsed issue contract (authoritative when present):')
    expect(rendered).toContain('"allowedFiles": [')
    expect(rendered).toContain('apps/web/src/auth.ts')
    expect(rendered).toContain('Forbidden files:')
    expect(rendered).toContain('Required semantics:')
  })
})
