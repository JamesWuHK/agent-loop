import { describe, expect, it } from 'bun:test'
import { parseIssueContract, renderIssueContractForPrompt } from './issue-contract'

describe('parseIssueContract', () => {
  it('parses executable contract fields from the issue body', () => {
    const body = [
      '## 用户故事',
      '作为访客，我希望进入桌面壳后先看到登录页。',
      '',
      '## Context',
      '### Dependencies',
      '```json',
      '{ "dependsOn": [41, 42] }',
      '```',
      '### Constraints',
      '- 不改 App.tsx',
      '- 不接 API',
      '### AllowedFiles',
      '- apps/desktop/src/context/AppContext.tsx',
      '- apps/desktop/src/pages/LoginPage.tsx',
      '### ForbiddenFiles',
      '- apps/desktop/src/App.tsx',
      '### MustPreserve',
      '- navigate("/main") 必须更新 currentPath',
      '### OutOfScope',
      '- token 持久化',
      '### RequiredSemantics',
      '- 未登录时只能看到 /login',
      '### ReviewHints',
      '- 检查登录态切换是否保持原约束',
      '### Validation',
      '- cd apps/desktop && bun run --bun test src/App.test.tsx',
      '',
      '## 实现步骤',
      '1. 补最小 auth/navigation 接口',
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
      userStory: '作为访客，我希望进入桌面壳后先看到登录页。',
      dependencies: [41, 42],
      hasDependencyMetadata: true,
      dependencyParseError: false,
      constraints: ['不改 App.tsx', '不接 API'],
      runtimeRequirements: [],
      runtimeRequirementDuplicateTokens: [],
      runtimeRequirementUnknownTokens: [],
      runtimeRequirementConflicts: [],
      allowedFiles: [
        'apps/desktop/src/context/AppContext.tsx',
        'apps/desktop/src/pages/LoginPage.tsx',
      ],
      forbiddenFiles: ['apps/desktop/src/App.tsx'],
      mustPreserve: ['navigate("/main") 必须更新 currentPath'],
      outOfScope: ['token 持久化'],
      requiredSemantics: ['未登录时只能看到 /login'],
      reviewHints: ['检查登录态切换是否保持原约束'],
      validation: ['cd apps/desktop && bun run --bun test src/App.test.tsx'],
      acceptance: ['登录前渲染 /login', '不新增 API 调用'],
      implementationSteps: ['补最小 auth/navigation 接口'],
      redTest: '```tsx\nexpect(screen.getByText("登录")).toBeInTheDocument()\n```',
    })
  })

  it('parses, normalizes, and deduplicates runtime requirements while preserving diagnostics', () => {
    const contract = parseIssueContract([
      '## 用户故事',
      '作为维护者，我希望 runtime requirements 可被稳定解析。',
      '',
      '## Context',
      '### Dependencies',
      '```json',
      '{ "dependsOn": [] }',
      '```',
      '### Runtime Requirements',
      '- Self Hosting',
      '- managed runtime',
      '- reviewed-bootstrap-manifest',
      '- managed runtime',
      '- Magical Runtime',
      '### AllowedFiles',
      '- packages/agent-shared/src/issue-contract.ts',
      '### Validation',
      '- `bun test packages/agent-shared/src/issue-contract.test.ts`',
      '',
      '## RED 测试',
      '```ts',
      "throw new Error('red')",
      '```',
      '',
      '## 实现步骤',
      '1. 解析 RuntimeRequirements',
      '',
      '## 验收',
      '- runtime requirements 解析稳定',
    ].join('\n'))

    expect(contract.runtimeRequirements).toEqual([
      'self-hosting',
      'managed-runtime',
      'reviewed-bootstrap-manifest',
      'magical-runtime',
    ])
    expect(contract.runtimeRequirementDuplicateTokens).toEqual(['managed-runtime'])
    expect(contract.runtimeRequirementUnknownTokens).toEqual(['magical-runtime'])
    expect(contract.runtimeRequirementConflicts).toEqual([
      ['self-hosting', 'managed-runtime'],
    ])
  })

  it('supports the Chinese RuntimeRequirements heading and keeps legacy issues compatible', () => {
    const contract = parseIssueContract([
      '## 用户故事',
      '作为维护者，我希望旧 issue 不会因为新字段回归。',
      '',
      '## Context',
      '### Dependencies',
      '```json',
      '{ "dependsOn": [] }',
      '```',
      '### 运行时要求',
      '- Reviewed Bootstrap Manifest',
      '### AllowedFiles',
      '- packages/agent-shared/src/issue-contract.ts',
      '### Validation',
      '- `bun test packages/agent-shared/src/issue-contract.test.ts`',
      '',
      '## RED 测试',
      '```ts',
      "throw new Error('red')",
      '```',
      '',
      '## 实现步骤',
      '1. 兼容中英文 heading',
      '',
      '## 验收',
      '- legacy issue 无该 section 也可解析',
    ].join('\n'))

    expect(contract.runtimeRequirements).toEqual(['reviewed-bootstrap-manifest'])
    expect(contract.runtimeRequirementDuplicateTokens).toEqual([])
    expect(contract.runtimeRequirementUnknownTokens).toEqual([])
    expect(contract.runtimeRequirementConflicts).toEqual([])

    expect(parseIssueContract('## 用户故事\nlegacy issue')).toMatchObject({
      runtimeRequirements: [],
      runtimeRequirementDuplicateTokens: [],
      runtimeRequirementUnknownTokens: [],
      runtimeRequirementConflicts: [],
    })
  })

  it('renders a compact prompt supplement with machine-readable contract data', () => {
    const rendered = renderIssueContractForPrompt([
      '## Context',
      '### RuntimeRequirements',
      '- self-hosting',
      '### AllowedFiles',
      '- apps/desktop/src/context/AppContext.tsx',
      '### ForbiddenFiles',
      '- apps/desktop/src/App.tsx',
      '### RequiredSemantics',
      '- 未登录时保留在 /login',
    ].join('\n'))

    expect(rendered).toContain('Parsed issue contract (authoritative when present):')
    expect(rendered).toContain('"allowedFiles": [')
    expect(rendered).toContain('"runtimeRequirements": [')
    expect(rendered).toContain('self-hosting')
    expect(rendered).toContain('apps/desktop/src/context/AppContext.tsx')
    expect(rendered).toContain('Forbidden files:')
    expect(rendered).toContain('Required semantics:')
  })
})
