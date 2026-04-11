import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRepoAuthoringContext } from './issue-authoring-context'

describe('buildRepoAuthoringContext', () => {
  test('collects workspace validation commands and repo-relative file candidates from repo scan', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-loop-authoring-'))
    mkdirSync(join(root, 'apps/example/src/pages'), { recursive: true })
    mkdirSync(join(root, '.agent-loop/drafts'), { recursive: true })

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
    writeFileSync(join(root, 'apps/example/src/App.tsx'), 'export function App() { return null }\n')
    writeFileSync(join(root, 'apps/example/src/main.tsx'), 'export const main = true\n')
    writeFileSync(join(root, 'apps/example/src/pages/LoginPage.tsx'), 'export function LoginPage() { return null }\n')
    writeFileSync(join(root, 'apps/example/src/pages/LoginPage.test.tsx'), 'export {}\n')
    writeFileSync(join(root, '.agent-loop/drafts/LoginPage.tsx'), 'export const ignored = true\n')

    const context = await buildRepoAuthoringContext({
      repoRoot: root,
      issueText: '修复 LoginPage 的登录重定向，并补上对应测试',
    })

    expect(context.candidateValidationCommands).toEqual([
      'bun run --bun test apps/example/src/pages/LoginPage.test.tsx',
      'bun run typecheck',
      'bun test',
    ])
    expect(context.candidateAllowedFiles).toEqual([
      'apps/example/src/pages/LoginPage.tsx',
      'apps/example/src/pages/LoginPage.test.tsx',
    ])
    expect(context.candidateForbiddenFiles).toEqual([
      'apps/example/src/App.tsx',
      'apps/example/src/main.tsx',
    ])
    expect(context.candidateAllowedFiles.some((value) => value.startsWith(root))).toBe(false)
    expect(context.candidateAllowedFiles.some((value) => value.includes('.agent-loop'))).toBe(false)
    expect(context.candidateValidationCommands.some((value) => value.startsWith(root))).toBe(false)
  })

  test('keeps validation command ordering stable across root and injected workspace manifests', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-loop-authoring-order-'))
    mkdirSync(join(root, 'apps/web'), { recursive: true })
    mkdirSync(join(root, 'packages/shared'), { recursive: true })

    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'fixture-repo',
      scripts: {
        lint: 'bun run lint',
        test: 'bun test',
        typecheck: 'bun run typecheck',
      },
    }))
    writeFileSync(join(root, 'apps/web/package.json'), JSON.stringify({
      name: 'web',
      scripts: {
        test: 'bun run --cwd src/pages test LoginPage.test.tsx',
      },
    }))
    writeFileSync(join(root, 'packages/shared/package.json'), JSON.stringify({
      name: 'shared',
      scripts: {
        verify: 'bun test src/index.test.ts',
      },
    }))

    const context = await buildRepoAuthoringContext({
      repoRoot: root,
      issueTitle: '调整 LoginPage 文案并确认测试',
      issueBody: '需要补齐登录页回归。',
      issueText: '',
      repoRelativeFilePaths: [
        'apps/web/src/pages/LoginPage.tsx',
        'apps/web/src/pages/LoginPage.test.tsx',
        'packages/shared/src/index.test.ts',
      ],
      rootPackageJsonPath: 'package.json',
      workspacePackageJsonPaths: [
        'packages/shared/package.json',
        'apps/web/package.json',
      ],
    })

    expect(context.candidateValidationCommands).toEqual([
      'bun run --cwd apps/web/src/pages test apps/web/src/pages/LoginPage.test.tsx',
      'bun run lint',
      'bun run typecheck',
      'bun test',
      'bun test packages/shared/src/index.test.ts',
    ])
  })

  test('ignores absolute and parent-relative file inputs when ranking candidates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-loop-authoring-paths-'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'fixture-repo',
      scripts: {
        test: 'bun test',
      },
    }))

    const context = await buildRepoAuthoringContext({
      repoRoot: root,
      issueText: '修复 packages/agent-shared/src/project-profile.ts 的提示文案',
      repoRelativeFilePaths: [
        '/tmp/escape.ts',
        '../outside.ts',
        'packages/agent-shared/src/project-profile.test.ts',
        'packages/agent-shared/src/project-profile.ts',
      ],
      rootPackageJsonPath: 'package.json',
      workspacePackageJsonPaths: [],
    })

    expect(context.candidateAllowedFiles).toEqual([
      'packages/agent-shared/src/project-profile.ts',
      'packages/agent-shared/src/project-profile.test.ts',
    ])
    expect(context.candidateAllowedFiles.some((value) => value.startsWith('/'))).toBe(false)
  })

  test('ignores injected manifest paths that resolve outside the repo root', async () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), 'agent-loop-authoring-manifests-'))
    const root = join(sandboxRoot, 'repo')
    const outsideRoot = join(sandboxRoot, 'outside')

    mkdirSync(join(root, 'apps/web/src/pages'), { recursive: true })
    mkdirSync(outsideRoot, { recursive: true })

    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'fixture-repo',
      scripts: {
        test: 'bun test',
      },
    }))
    writeFileSync(join(root, 'apps/web/package.json'), JSON.stringify({
      name: 'web',
      scripts: {
        verify: 'bun test src/pages/LoginPage.test.tsx',
      },
    }))
    writeFileSync(join(outsideRoot, 'package.json'), JSON.stringify({
      name: 'outside',
      scripts: {
        lint: 'bun run lint ../secrets.ts',
      },
    }))

    const context = await buildRepoAuthoringContext({
      repoRoot: root,
      issueText: '更新 LoginPage 交互并补测试',
      repoRelativeFilePaths: [
        'apps/web/src/pages/LoginPage.tsx',
        'apps/web/src/pages/LoginPage.test.tsx',
        'apps/web/src/App.tsx',
      ],
      rootPackageJsonPath: 'package.json',
      workspacePackageJsonPaths: [
        'apps/web/package.json',
        '../outside/package.json',
      ],
    })

    expect(context).toEqual({
      candidateValidationCommands: [
        'bun test',
        'bun test apps/web/src/pages/LoginPage.test.tsx',
      ],
      candidateAllowedFiles: [
        'apps/web/src/pages/LoginPage.tsx',
        'apps/web/src/pages/LoginPage.test.tsx',
      ],
      candidateForbiddenFiles: [
        'apps/web/src/App.tsx',
      ],
    })
  })

  test('keeps allowed and forbidden file ordering stable for unsorted repo-relative inputs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-loop-authoring-stable-files-'))
    mkdirSync(join(root, 'apps/web'), { recursive: true })

    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'fixture-repo',
      scripts: {
        test: 'bun test',
      },
    }))
    writeFileSync(join(root, 'apps/web/package.json'), JSON.stringify({
      name: 'web',
      scripts: {
        verify: 'bun test src/pages/LoginPage.test.tsx',
      },
    }))

    const firstContext = await buildRepoAuthoringContext({
      repoRoot: root,
      issueText: '更新 LoginPage 交互并补测试',
      repoRelativeFilePaths: [
        'apps/web/src/pages/LoginPage.test.tsx',
        'apps/web/src/router.tsx',
        'apps/web/src/pages/LoginPage.tsx',
        'apps/web/src/main.tsx',
        'apps/web/src/App.tsx',
      ],
      rootPackageJsonPath: 'package.json',
      workspacePackageJsonPaths: ['apps/web/package.json'],
    })

    const secondContext = await buildRepoAuthoringContext({
      repoRoot: root,
      issueText: '更新 LoginPage 交互并补测试',
      repoRelativeFilePaths: [
        'apps/web/src/main.tsx',
        'apps/web/src/App.tsx',
        'apps/web/src/pages/LoginPage.tsx',
        'apps/web/src/router.tsx',
        'apps/web/src/pages/LoginPage.test.tsx',
      ],
      rootPackageJsonPath: 'package.json',
      workspacePackageJsonPaths: ['apps/web/package.json'],
    })

    expect(firstContext).toEqual(secondContext)
    expect(firstContext).toEqual({
      candidateValidationCommands: [
        'bun test',
        'bun test apps/web/src/pages/LoginPage.test.tsx',
      ],
      candidateAllowedFiles: [
        'apps/web/src/pages/LoginPage.tsx',
        'apps/web/src/pages/LoginPage.test.tsx',
      ],
      candidateForbiddenFiles: [
        'apps/web/src/App.tsx',
        'apps/web/src/main.tsx',
        'apps/web/src/router.tsx',
      ],
    })
    expect(firstContext.candidateForbiddenFiles.some((value) => value.startsWith('/'))).toBe(false)
  })
})
