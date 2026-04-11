import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRepoAuthoringContext } from './issue-authoring-context'

describe('buildRepoAuthoringContext', () => {
  test('collects workspace validation commands and repo-relative file candidates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-loop-authoring-'))
    mkdirSync(join(root, 'apps/example/src/pages'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'fixture-repo',
      scripts: {
        test: 'bun test',
        typecheck: 'bun run typecheck',
      },
      workspaces: ['apps/*'],
    }))
    writeFileSync(join(root, 'apps/example/package.json'), JSON.stringify({
      name: 'example',
      scripts: {
        test: 'bun run --bun test src/pages/LoginPage.test.tsx',
      },
    }))
    writeFileSync(join(root, 'apps/example/src/pages/LoginPage.tsx'), 'export function LoginPage() { return null }\n')
    writeFileSync(join(root, 'apps/example/src/pages/LoginPage.test.tsx'), 'export {}\n')

    const context = await buildRepoAuthoringContext({
      repoRoot: root,
      issueText: '修复 LoginPage 的登录重定向，并补上对应测试',
    })

    expect(context.candidateValidationCommands).toContain(
      'bun run --bun test apps/example/src/pages/LoginPage.test.tsx',
    )
    expect(context.candidateAllowedFiles).toContain('apps/example/src/pages/LoginPage.tsx')
    expect(context.candidateAllowedFiles).toContain('apps/example/src/pages/LoginPage.test.tsx')
    expect(context.candidateAllowedFiles.some((value) => value.startsWith(root))).toBe(false)
  })

  test('keeps config-like forbidden candidates repo-relative for product issues', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-loop-authoring-forbidden-'))
    mkdirSync(join(root, 'apps/example/src/pages'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'fixture-repo',
      scripts: {
        test: 'bun test',
      },
    }))
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        strict: true,
      },
    }))
    writeFileSync(join(root, 'apps/example/src/pages/BillingPage.tsx'), 'export function BillingPage() { return null }\n')

    const context = await buildRepoAuthoringContext({
      repoRoot: root,
      issueText: '调整 BillingPage 的文案和状态展示',
    })

    expect(context.candidateForbiddenFiles).toContain('package.json')
    expect(context.candidateForbiddenFiles).toContain('tsconfig.json')
    expect(context.candidateForbiddenFiles.some((value) => value.startsWith(root))).toBe(false)
  })
})
