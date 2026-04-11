import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRepoAuthoringContext } from './issue-authoring-context'

describe('buildRepoAuthoringContext', () => {
  test('collects workspace validation commands and repo-relative file candidates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-loop-authoring-'))
    mkdirSync(join(root, 'apps/example'), { recursive: true })

    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'fixture-repo',
      scripts: {
        test: 'bun test',
        typecheck: 'bun run typecheck',
      },
    }))
    writeFileSync(join(root, 'apps/example/package.json'), JSON.stringify({
      name: 'example',
      scripts: {
        test: 'bun run --bun test src/pages/LoginPage.test.tsx',
      },
    }))

    const context = await buildRepoAuthoringContext({
      repoRoot: root,
      issueText: '修复 LoginPage 的登录重定向，并补上对应测试',
      repoRelativeFilePaths: [
        'apps/example/src/App.tsx',
        'apps/example/src/main.tsx',
        'apps/example/src/pages/LoginPage.test.tsx',
        'apps/example/src/pages/LoginPage.tsx',
      ],
      rootPackageJsonPath: 'package.json',
      workspacePackageJsonPaths: ['apps/example/package.json'],
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
    expect(context.candidateAllowedFiles.some((value: string) => value.startsWith(root))).toBe(false)
    expect(context.candidateValidationCommands.some((value: string) => value.startsWith(root))).toBe(false)
  })

  test('keeps validation command ordering stable across root and workspace manifests', async () => {
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
    expect(context.candidateAllowedFiles.some((value: string) => value.startsWith('/'))).toBe(false)
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
    expect(firstContext.candidateForbiddenFiles.some((value: string) => value.startsWith('/'))).toBe(false)
  })

  test('merges project issue rules into authoring context without dropping repo-grounded candidates', async () => {
    const context = await buildRepoAuthoringContext({
      repoRoot: '/repo',
      issueText: '增加 issue repair CLI',
      repoRelativeFilePaths: [
        'apps/agent-daemon/src/issue-repair.ts',
        'apps/agent-daemon/src/issue-repair.test.ts',
        'apps/agent-daemon/src/dashboard.ts',
      ],
      project: {
        profile: 'generic',
        issueAuthoring: {
          preferredValidationCommands: [
            'bun test apps/agent-daemon/src/issue-repair.test.ts',
          ],
          preferredAllowedFiles: [
            'apps/agent-daemon/src/issue-repair.ts',
            'apps/agent-daemon/src/issue-repair.test.ts',
          ],
          forbiddenPaths: [
            'apps/agent-daemon/src/dashboard.ts',
          ],
          reviewHints: [
            '优先检查 repair 流程是否保留合法的 Dependencies JSON',
          ],
        },
      },
    })

    expect(context.candidateValidationCommands).toContain(
      'bun test apps/agent-daemon/src/issue-repair.test.ts',
    )
    expect(context.candidateAllowedFiles.slice(0, 2)).toEqual([
      'apps/agent-daemon/src/issue-repair.ts',
      'apps/agent-daemon/src/issue-repair.test.ts',
    ])
    expect(context.candidateForbiddenFiles).toContain('apps/agent-daemon/src/dashboard.ts')
    expect(context.projectIssueRules).toEqual({
      preferredValidationCommands: [
        'bun test apps/agent-daemon/src/issue-repair.test.ts',
      ],
      preferredAllowedFiles: [
        'apps/agent-daemon/src/issue-repair.ts',
        'apps/agent-daemon/src/issue-repair.test.ts',
      ],
      forbiddenPaths: [
        'apps/agent-daemon/src/dashboard.ts',
      ],
      reviewHints: [
        '优先检查 repair 流程是否保留合法的 Dependencies JSON',
      ],
    })
  })
})
