import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRetryableManagedBranchPushFailure, pushBranch } from './pr-reporter'

async function runGit(
  worktreePath: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['git', '-C', worktreePath, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited

  return { exitCode, stdout, stderr }
}

describe('pr reporter push recovery', () => {
  test('detects retryable managed-branch push failures', () => {
    expect(isRetryableManagedBranchPushFailure('! [rejected] agent/78/codex -> agent/78/codex (fetch first)')).toBe(true)
    expect(isRetryableManagedBranchPushFailure('To origin\n ! [rejected] agent/78/codex -> agent/78/codex (stale info)\nerror: failed to push some refs')).toBe(true)
    expect(isRetryableManagedBranchPushFailure('remote: Permission to repo denied')).toBe(false)
  })

  test('retries after the managed branch changes remotely between sync and push', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pr-reporter-push-'))
    const remoteDir = join(tempDir, 'remote.git')
    const repoADir = join(tempDir, 'repo-a')
    const repoBDir = join(tempDir, 'repo-b')
    const branch = 'agent/78/codex-20260404'

    try {
      mkdirSync(remoteDir, { recursive: true })
      mkdirSync(repoADir, { recursive: true })

      await Bun.$`git -C ${remoteDir} init --bare`.quiet()
      await Bun.$`git -C ${repoADir} init -b main`.quiet()
      await Bun.$`git -C ${repoADir} config user.name repo-a`.quiet()
      await Bun.$`git -C ${repoADir} config user.email repo-a@example.com`.quiet()
      await Bun.$`git -C ${repoADir} remote add origin ${remoteDir}`.quiet()

      writeFileSync(join(repoADir, 'README.md'), 'base\n', 'utf-8')
      await Bun.$`git -C ${repoADir} add README.md`.quiet()
      await Bun.$`git -C ${repoADir} commit -m "base"`.quiet()
      await Bun.$`git -C ${repoADir} push -u origin main`.quiet()

      await Bun.$`git -C ${repoADir} checkout -b ${branch}`.quiet()
      writeFileSync(join(repoADir, 'feature.txt'), 'initial\n', 'utf-8')
      await Bun.$`git -C ${repoADir} add feature.txt`.quiet()
      await Bun.$`git -C ${repoADir} commit -m "initial branch"`.quiet()
      await Bun.$`git -C ${repoADir} push -u origin ${branch}`.quiet()

      await Bun.$`git clone ${remoteDir} ${repoBDir}`.quiet()
      await Bun.$`git -C ${repoBDir} config user.name repo-b`.quiet()
      await Bun.$`git -C ${repoBDir} config user.email repo-b@example.com`.quiet()
      await Bun.$`git -C ${repoBDir} checkout -b ${branch} origin/${branch}`.quiet()

      writeFileSync(join(repoADir, 'feature.txt'), 'repo-a-local\n', 'utf-8')
      await Bun.$`git -C ${repoADir} add feature.txt`.quiet()
      await Bun.$`git -C ${repoADir} commit -m "repo-a update"`.quiet()

      let remoteAdvanced = false
      await pushBranch(repoADir, branch, console, {
        runGit,
        beforePushAttempt: async ({ attempt }) => {
          if (attempt !== 1 || remoteAdvanced) return
          remoteAdvanced = true

          writeFileSync(join(repoBDir, 'feature.txt'), 'repo-b-remote\n', 'utf-8')
          await Bun.$`git -C ${repoBDir} add feature.txt`.quiet()
          await Bun.$`git -C ${repoBDir} commit -m "repo-b update"`.quiet()
          await Bun.$`git -C ${repoBDir} push origin ${branch}`.quiet()
        },
      })

      const localHead = (await Bun.$`git -C ${repoADir} rev-parse HEAD`.quiet().text()).trim()
      const remoteHead = (await Bun.$`git -C ${repoADir} ls-remote origin refs/heads/${branch}`.quiet().text())
        .trim()
        .split(/\s+/)[0]

      expect(remoteAdvanced).toBe(true)
      expect(remoteHead).toBe(localHead)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('pushes detached review-worktree commits back to the managed branch', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pr-reporter-detached-'))
    const remoteDir = join(tempDir, 'remote.git')
    const repoDir = join(tempDir, 'repo')
    const reviewDir = join(tempDir, 'review')
    const branch = 'agent/92/codex-20260405'

    try {
      mkdirSync(remoteDir, { recursive: true })
      mkdirSync(repoDir, { recursive: true })

      await Bun.$`git -C ${remoteDir} init --bare`.quiet()
      await Bun.$`git -C ${repoDir} init -b main`.quiet()
      await Bun.$`git -C ${repoDir} config user.name repo`.quiet()
      await Bun.$`git -C ${repoDir} config user.email repo@example.com`.quiet()
      await Bun.$`git -C ${repoDir} remote add origin ${remoteDir}`.quiet()

      writeFileSync(join(repoDir, 'README.md'), 'base\n', 'utf-8')
      await Bun.$`git -C ${repoDir} add README.md`.quiet()
      await Bun.$`git -C ${repoDir} commit -m "base"`.quiet()
      await Bun.$`git -C ${repoDir} push -u origin main`.quiet()

      await Bun.$`git -C ${repoDir} checkout -b ${branch}`.quiet()
      writeFileSync(join(repoDir, 'feature.txt'), 'initial\n', 'utf-8')
      await Bun.$`git -C ${repoDir} add feature.txt`.quiet()
      await Bun.$`git -C ${repoDir} commit -m "initial branch"`.quiet()
      await Bun.$`git -C ${repoDir} push -u origin ${branch}`.quiet()

      await Bun.$`git -C ${repoDir} fetch origin ${branch}`.quiet()
      await Bun.$`git -C ${repoDir} worktree add --detach ${reviewDir} origin/${branch}`.quiet()
      await Bun.$`git -C ${reviewDir} config user.name review`.quiet()
      await Bun.$`git -C ${reviewDir} config user.email review@example.com`.quiet()

      writeFileSync(join(reviewDir, 'feature.txt'), 'detached-update\n', 'utf-8')
      await Bun.$`git -C ${reviewDir} add feature.txt`.quiet()
      await Bun.$`git -C ${reviewDir} commit -m "detached review fix"`.quiet()

      const detachedHead = (await Bun.$`git -C ${reviewDir} rev-parse HEAD`.quiet().text()).trim()
      await pushBranch(reviewDir, branch, console, { runGit })

      const remoteHead = (await Bun.$`git -C ${repoDir} ls-remote origin refs/heads/${branch}`.quiet().text())
        .trim()
        .split(/\s+/)[0]

      expect(remoteHead).toBe(detachedHead)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
