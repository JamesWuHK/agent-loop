import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectPrLineagePreflightActualState,
  evaluatePrLineagePreflight,
  isCommitAncestorInWorktree,
} from './pr-lineage-preflight'

describe('evaluatePrLineagePreflight', () => {
  test('fails when the branch was rebuilt onto an unexpected base branch', async () => {
    const result = evaluatePrLineagePreflight({
      expected: {
        issueNumber: 37,
        headBranch: 'agent/37-rebuild/codex-dev',
        baseBranch: 'master',
        baseSha: '11fc78e',
      },
      actual: {
        headBranch: 'agent/37-rebuild/codex-dev',
        baseBranch: 'agent/36/codex-dev',
        baseSha: '0176283',
        changedFiles: [
          'apps/agent-daemon/src/issue-authoring-context.ts',
        ],
      },
    })

    expect(result.ok).toBe(false)
    expect(result.failures).toContain(
      'base branch mismatch: expected master but found agent/36/codex-dev',
    )
    expect(result.failures).toContain(
      'base sha mismatch: expected 11fc78e but found 0176283',
    )
  })

  test('fails when the diff is polluted outside the expected lineage scope', () => {
    const result = evaluatePrLineagePreflight({
      expected: {
        issueNumber: 37,
        headBranch: 'agent/37/codex-dev',
        baseBranch: 'master',
        baseSha: '11fc78e',
        allowedChangedFiles: [
          'apps/agent-daemon/src/daemon.ts',
        ],
      },
      actual: {
        headBranch: 'agent/37/codex-dev',
        baseBranch: 'master',
        baseSha: '11fc78e',
        changedFiles: [
          'apps/agent-daemon/src/daemon.ts',
          'apps/agent-daemon/src/issue-authoring-context.ts',
        ],
      },
    })

    expect(result.ok).toBe(false)
    expect(result.failures).toContain(
      'unexpected changed files outside lineage scope: apps/agent-daemon/src/issue-authoring-context.ts',
    )
  })
})

describe('collectPrLineagePreflightActualState', () => {
  test('reads the current branch, merge-base, and changed file set from a worktree', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pr-lineage-preflight-'))
    const remoteDir = join(tempDir, 'remote.git')
    const repoDir = join(tempDir, 'repo')
    const branch = 'agent/37/codex-dev'

    try {
      mkdirSync(remoteDir, { recursive: true })
      mkdirSync(repoDir, { recursive: true })

      await Bun.$`git -C ${remoteDir} init --bare`.quiet()
      await Bun.$`git -C ${repoDir} init -b master`.quiet()
      await Bun.$`git -C ${repoDir} config user.name test`.quiet()
      await Bun.$`git -C ${repoDir} config user.email test@example.com`.quiet()
      await Bun.$`git -C ${repoDir} remote add origin ${remoteDir}`.quiet()

      writeFileSync(join(repoDir, 'README.md'), 'base\n', 'utf-8')
      await Bun.$`git -C ${repoDir} add README.md`.quiet()
      await Bun.$`git -C ${repoDir} commit -m "base"`.quiet()
      await Bun.$`git -C ${repoDir} push -u origin master`.quiet()

      await Bun.$`git -C ${repoDir} checkout -b ${branch}`.quiet()
      mkdirSync(join(repoDir, 'apps', 'agent-daemon', 'src'), { recursive: true })
      writeFileSync(join(repoDir, 'apps', 'agent-daemon', 'src', 'daemon.ts'), 'export const updated = true\n', 'utf-8')
      await Bun.$`git -C ${repoDir} add apps/agent-daemon/src/daemon.ts`.quiet()
      await Bun.$`git -C ${repoDir} commit -m "feature"`.quiet()

      const actual = await collectPrLineagePreflightActualState({
        worktreePath: repoDir,
        expectedBaseBranch: 'master',
      })
      const baseSha = (await Bun.$`git -C ${repoDir} rev-parse origin/master`.quiet().text()).trim()

      expect(actual).toEqual({
        headBranch: branch,
        baseBranch: null,
        baseSha,
        changedFiles: ['apps/agent-daemon/src/daemon.ts'],
      })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('treats forward rebases as descendant base-sha evolution', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pr-lineage-preflight-ancestor-'))
    const remoteDir = join(tempDir, 'remote.git')
    const repoDir = join(tempDir, 'repo')
    const branch = 'agent/37/codex-dev'

    try {
      mkdirSync(remoteDir, { recursive: true })
      mkdirSync(repoDir, { recursive: true })

      await Bun.$`git -C ${remoteDir} init --bare`.quiet()
      await Bun.$`git -C ${repoDir} init -b master`.quiet()
      await Bun.$`git -C ${repoDir} config user.name test`.quiet()
      await Bun.$`git -C ${repoDir} config user.email test@example.com`.quiet()
      await Bun.$`git -C ${repoDir} remote add origin ${remoteDir}`.quiet()

      writeFileSync(join(repoDir, 'README.md'), 'base\n', 'utf-8')
      await Bun.$`git -C ${repoDir} add README.md`.quiet()
      await Bun.$`git -C ${repoDir} commit -m "base"`.quiet()
      await Bun.$`git -C ${repoDir} push -u origin master`.quiet()

      const originalBaseSha = (await Bun.$`git -C ${repoDir} rev-parse HEAD`.quiet().text()).trim()

      writeFileSync(join(repoDir, 'README.md'), 'base\nnext\n', 'utf-8')
      await Bun.$`git -C ${repoDir} add README.md`.quiet()
      await Bun.$`git -C ${repoDir} commit -m "base-2"`.quiet()
      await Bun.$`git -C ${repoDir} push origin master`.quiet()

      const advancedBaseSha = (await Bun.$`git -C ${repoDir} rev-parse HEAD`.quiet().text()).trim()

      await Bun.$`git -C ${repoDir} checkout -b ${branch} ${advancedBaseSha}`.quiet()

      expect(await isCommitAncestorInWorktree(repoDir, originalBaseSha, advancedBaseSha)).toBe(true)
      expect(await isCommitAncestorInWorktree(repoDir, advancedBaseSha, originalBaseSha)).toBe(false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
