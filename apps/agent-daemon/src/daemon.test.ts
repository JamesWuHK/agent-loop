import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPrMergeRetryComment, isMergeabilityFailure, rebaseManagedBranchOntoDefault, shouldResumeManagedIssue } from './daemon'

describe('daemon merge recovery helpers', () => {
  test('resumes working issues with a local worktree after daemon restart', () => {
    expect(shouldResumeManagedIssue(
      { state: 'working' },
      true,
      0,
      0,
      Date.now(),
      2,
    )).toBe(true)
  })

  test('respects failed-issue retry cooldowns while still requiring a local worktree', () => {
    const now = Date.now()

    expect(shouldResumeManagedIssue(
      { state: 'failed' },
      true,
      0,
      now - 1,
      now,
      2,
    )).toBe(true)

    expect(shouldResumeManagedIssue(
      { state: 'failed' },
      true,
      2,
      now - 1,
      now,
      2,
    )).toBe(false)

    expect(shouldResumeManagedIssue(
      { state: 'failed' },
      true,
      0,
      now + 60_000,
      now,
      2,
    )).toBe(false)
  })

  test('detects mergeability failures from GitHub merge API messages', () => {
    expect(isMergeabilityFailure('Pull Request is not mergeable')).toBe(true)
    expect(isMergeabilityFailure('Merge conflict between base and head')).toBe(true)
    expect(isMergeabilityFailure('Required status check "test" is failing')).toBe(false)
  })

  test('builds a merge retry comment with recovery details', () => {
    expect(buildPrMergeRetryComment(
      61,
      'agent/46/codex-20260403',
      'main',
      'Pull Request is not mergeable',
    )).toContain('rebuild the approved branch snapshot on top of `origin/main`')
  })

  test('falls back to rebuilding the approved branch snapshot when rebase conflicts', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'daemon-merge-recovery-'))
    const remoteDir = join(tempDir, 'remote.git')
    const repoDir = join(tempDir, 'repo')

    try {
      mkdirSync(remoteDir, { recursive: true })
      mkdirSync(repoDir, { recursive: true })

      await Bun.$`git -C ${remoteDir} init --bare`.quiet()
      await Bun.$`git -C ${repoDir} init -b main`.quiet()
      await Bun.$`git -C ${repoDir} config user.name test`.quiet()
      await Bun.$`git -C ${repoDir} config user.email test@example.com`.quiet()
      await Bun.$`git -C ${repoDir} remote add origin ${remoteDir}`.quiet()

      writeFileSync(join(repoDir, 'shared.txt'), 'base\n', 'utf-8')
      await Bun.$`git -C ${repoDir} add shared.txt`.quiet()
      await Bun.$`git -C ${repoDir} commit -m "base"`.quiet()
      await Bun.$`git -C ${repoDir} push -u origin main`.quiet()

      await Bun.$`git -C ${repoDir} checkout -b agent/46/codex-20260403`.quiet()
      writeFileSync(join(repoDir, 'shared.txt'), 'feature-final\n', 'utf-8')
      writeFileSync(join(repoDir, 'feature.txt'), 'feature-only\n', 'utf-8')
      await Bun.$`git -C ${repoDir} add shared.txt feature.txt`.quiet()
      await Bun.$`git -C ${repoDir} commit -m "feature change"`.quiet()
      await Bun.$`git -C ${repoDir} push -u origin agent/46/codex-20260403`.quiet()

      await Bun.$`git -C ${repoDir} checkout main`.quiet()
      writeFileSync(join(repoDir, 'shared.txt'), 'main-conflict\n', 'utf-8')
      writeFileSync(join(repoDir, 'base-only.txt'), 'keep-me\n', 'utf-8')
      await Bun.$`git -C ${repoDir} add shared.txt base-only.txt`.quiet()
      await Bun.$`git -C ${repoDir} commit -m "main conflict"`.quiet()
      await Bun.$`git -C ${repoDir} push`.quiet()

      const result = await rebaseManagedBranchOntoDefault(
        repoDir,
        'agent/46/codex-20260403',
        'main',
        console,
      )

      expect(result).toEqual({ success: true })
      expect((await Bun.$`git -C ${repoDir} rev-parse --abbrev-ref HEAD`.quiet().text()).trim()).toBe(
        'agent/46/codex-20260403',
      )
      expect((await Bun.$`git -C ${repoDir} status --short`.quiet().text()).trim()).toBe('')
      expect((await Bun.$`cat ${join(repoDir, 'shared.txt')}`.text()).trim()).toBe('feature-final')
      expect((await Bun.$`cat ${join(repoDir, 'feature.txt')}`.text()).trim()).toBe('feature-only')
      expect((await Bun.$`cat ${join(repoDir, 'base-only.txt')}`.text()).trim()).toBe('keep-me')
      expect(Number.parseInt((await Bun.$`git -C ${repoDir} rev-list --count HEAD..origin/main`.quiet().text()).trim(), 10)).toBe(0)
      expect(Number.parseInt((await Bun.$`git -C ${repoDir} rev-list --count origin/main..HEAD`.quiet().text()).trim(), 10)).toBeGreaterThan(0)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
