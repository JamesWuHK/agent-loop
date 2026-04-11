import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentConfig, PrLineageMetadata } from '@agent/shared'
import { createOrFindPr, hasReusableOpenPr, isRetryableManagedBranchPushFailure, pushBranch } from './pr-reporter'
import { buildPrLineageMetadata, renderPrLineageMetadataComment } from './pr-lineage'

const TEST_CONFIG: AgentConfig = {
  machineId: 'codex-dev',
  repo: 'JamesWuHK/agent-loop',
  pat: 'test-token',
  pollIntervalMs: 60_000,
  idlePollIntervalMs: 300_000,
  concurrency: 1,
  requestedConcurrency: 1,
  concurrencyPolicy: {
    requested: 1,
    effective: 1,
    repoCap: null,
    profileCap: null,
    projectCap: null,
  },
  scheduling: {
    concurrencyByRepo: {},
    concurrencyByProfile: {},
  },
  recovery: {
    heartbeatIntervalMs: 30_000,
    leaseTtlMs: 60_000,
    workerIdleTimeoutMs: 300_000,
    leaseAdoptionBackoffMs: 5_000,
    leaseNoProgressTimeoutMs: 360_000,
  },
  worktreesBase: '/tmp/worktrees',
  project: {
    profile: 'desktop-vite',
  },
  agent: {
    primary: 'codex',
    fallback: 'claude',
    claudePath: 'claude',
    codexPath: 'codex',
    timeoutMs: 60_000,
  },
  git: {
    defaultBranch: 'master',
    authorName: 'agent-loop',
    authorEmail: 'agent-loop@local',
  },
}

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

describe('createOrFindPr', () => {
  test('treats only open PR checks as reusable', () => {
    expect(hasReusableOpenPr({ prNumber: 81, prState: 'open' })).toBe(true)
    expect(hasReusableOpenPr({ prNumber: 81, prState: 'closed' })).toBe(false)
    expect(hasReusableOpenPr({ prNumber: 81, prState: 'merged' })).toBe(false)
    expect(hasReusableOpenPr({ prNumber: null, prState: null })).toBe(false)
  })

  test('creates a replacement PR when the latest matching lineage is closed', async () => {
    let pushCalls = 0
    let createCalls = 0
    let preparedBranch = ''
    const supersedeComments: Array<{ prNumber: number; body: string }> = []

    const result = await createOrFindPr(
      '/tmp/agent-loop-terminal-pr',
      'agent/37/codex-dev',
      37,
      'repair terminal PR reuse',
      TEST_CONFIG,
      console,
      {
        listBranchPullRequests: async (requestedBranch) => {
          if (requestedBranch === 'agent/37/codex-dev') {
            return [{
              number: 45,
              prUrl: 'https://example.test/pr/45',
              prState: 'closed',
              headRefName: 'agent/37/codex-dev',
              baseRefName: 'master',
              body: '<!-- agent-loop:pr-lineage {"version":1,"issue":37,"headBranch":"agent/37/codex-dev","baseBranch":"master","baseSha":"0176283","attempt":1,"fingerprint":"old"} -->',
            }]
          }

          return []
        },
        resolvePrLineageContext: async () => ({
          baseBranch: 'master',
          baseSha: '11fc78e',
        }),
        pushBranch: async () => {
          pushCalls += 1
        },
        runPrLineagePreflight: async () => {},
        prepareReplacementBranch: async (_worktreePath, branch) => {
          preparedBranch = branch
        },
        commentOnPr: async (prNumber, body) => {
          supersedeComments.push({ prNumber, body })
        },
        closePullRequest: async () => {},
        createPr: async (replacementBranch, _issueNumber, _issueTitle, body) => {
          createCalls += 1
          expect(replacementBranch).toBe('agent/37-rebuild/codex-dev')
          expect(body).toContain('"attempt":2')
          return { number: 99, url: 'https://example.test/pr/99' }
        },
      },
    )

    expect(result).toEqual({
      kind: 'created',
      prNumber: 99,
      prUrl: 'https://example.test/pr/99',
      branch: 'agent/37-rebuild/codex-dev',
    })
    expect(preparedBranch).toBe('agent/37-rebuild/codex-dev')
    expect(pushCalls).toBe(1)
    expect(createCalls).toBe(1)
    expect(supersedeComments).toHaveLength(1)
    expect(supersedeComments[0]?.prNumber).toBe(45)
    expect(supersedeComments[0]?.body).toContain('This PR has been superseded by #99.')
  })

  test('keeps the open PR idempotent path intact', async () => {
    let pushCalls = 0
    let createCalls = 0
    const lineageMetadata = buildPrLineageMetadata({
      issueNumber: 37,
      headBranch: 'agent/37/codex-dev',
      baseBranch: 'master',
      baseSha: '11fc78e',
      attempt: 1,
    })

    const result = await createOrFindPr(
      '/tmp/agent-loop-open-pr',
      'agent/37/codex-dev',
      37,
      'repair terminal PR reuse',
      TEST_CONFIG,
      console,
      {
        listBranchPullRequests: async () => [{
          number: 78,
          prUrl: 'https://example.test/pr/78',
          prState: 'open',
          headRefName: 'agent/37/codex-dev',
          baseRefName: 'master',
          body: renderPrLineageMetadataComment(lineageMetadata),
        }],
        resolvePrLineageContext: async () => ({
          baseBranch: 'master',
          baseSha: '11fc78e',
        }),
        pushBranch: async () => {
          pushCalls += 1
        },
        runPrLineagePreflight: async () => {},
        createPr: async () => {
          createCalls += 1
          return { number: 99, url: 'https://example.test/pr/99' }
        },
      },
    )

    expect(result).toEqual({
      kind: 'reused',
      prNumber: 78,
      prUrl: 'https://example.test/pr/78',
      branch: 'agent/37/codex-dev',
    })
    expect(pushCalls).toBe(1)
    expect(createCalls).toBe(0)
  })

  test('writes deterministic lineage metadata into newly created PR bodies', async () => {
    let capturedBody = ''
    const lineageMetadata: PrLineageMetadata = {
      version: 1,
      issue: 37,
      headBranch: 'agent/37/codex-dev',
      baseBranch: 'master',
      baseSha: '11fc78e',
      attempt: 1,
      fingerprint: 'lineage-fingerprint',
    }

    const result = await createOrFindPr(
      '/tmp/agent-loop-create-pr',
      'agent/37/codex-dev',
      37,
      'record lineage metadata',
      TEST_CONFIG,
      console,
      {
        listBranchPullRequests: async () => [],
        pushBranch: async () => {},
        runPrLineagePreflight: async () => {},
        resolvePrLineageContext: async () => ({
          baseBranch: 'master',
          baseSha: '11fc78e',
        }),
        createPr: async (_branch, _issueNumber, _issueTitle, body) => {
          capturedBody = body
          return { number: 91, url: 'https://example.test/pr/91' }
        },
      },
    )

    expect(result).toEqual({
      kind: 'created',
      prNumber: 91,
      prUrl: 'https://example.test/pr/91',
      branch: 'agent/37/codex-dev',
    })
    expect(capturedBody).toContain('## Summary')
    expect(capturedBody).toContain('Fixes #37')
    expect(capturedBody).toContain(`<!-- agent-loop:pr-lineage ${JSON.stringify(buildPrLineageMetadata({
      issueNumber: 37,
      headBranch: 'agent/37/codex-dev',
      baseBranch: 'master',
      baseSha: '11fc78e',
      attempt: 1,
    }))} -->`)
    expect(capturedBody).toContain('## Metadata')
    expect(capturedBody).toContain('"generated_by": "agent-loop"')
    expect(capturedBody).toContain('## Test Plan')
  })

  test('reuses an existing open replacement lineage after switching branches', async () => {
    const seenBranches: string[] = []
    const replacementMetadata = buildPrLineageMetadata({
      issueNumber: 37,
      headBranch: 'agent/37-rebuild/codex-dev',
      baseBranch: 'master',
      baseSha: '11fc78e',
      attempt: 2,
    })

    const result = await createOrFindPr(
      '/tmp/agent-loop-replacement-reuse',
      'agent/37/codex-dev',
      37,
      'reuse replacement lineage',
      TEST_CONFIG,
      console,
      {
        listBranchPullRequests: async (requestedBranch) => {
          seenBranches.push(requestedBranch)
          if (requestedBranch === 'agent/37/codex-dev') {
            return [{
              number: 45,
              prUrl: 'https://example.test/pr/45',
              prState: 'closed',
              headRefName: 'agent/37/codex-dev',
              baseRefName: 'master',
              body: '<!-- agent-loop:pr-lineage {"version":1,"issue":37,"headBranch":"agent/37/codex-dev","baseBranch":"master","baseSha":"0176283","attempt":1,"fingerprint":"old"} -->',
            }]
          }

          return [{
            number: 91,
            prUrl: 'https://example.test/pr/91',
            prState: 'open',
            headRefName: 'agent/37-rebuild/codex-dev',
            baseRefName: 'master',
            body: renderPrLineageMetadataComment(replacementMetadata),
          }]
        },
        resolvePrLineageContext: async () => ({
          baseBranch: 'master',
          baseSha: '11fc78e',
        }),
        runPrLineagePreflight: async () => {},
        prepareReplacementBranch: async () => {},
        pushBranch: async () => {},
        commentOnPr: async () => {},
        closePullRequest: async () => {},
        createPr: async () => {
          throw new Error('createPr should not run when replacement PR already exists')
        },
      },
    )

    expect(result).toEqual({
      kind: 'reused',
      prNumber: 91,
      prUrl: 'https://example.test/pr/91',
      branch: 'agent/37-rebuild/codex-dev',
    })
    expect(seenBranches).toEqual([
      'agent/37/codex-dev',
      'agent/37-rebuild/codex-dev',
    ])
  })

  test('fails fast when PR creation preflight reports polluted lineage state', async () => {
    let pushCalls = 0
    let createCalls = 0

    await expect(createOrFindPr(
      '/tmp/agent-loop-preflight-block',
      'agent/37/codex-dev',
      37,
      'block polluted lineage push',
      TEST_CONFIG,
      console,
      {
        listBranchPullRequests: async () => [],
        resolvePrLineageContext: async () => ({
          baseBranch: 'master',
          baseSha: '11fc78e',
        }),
        runPrLineagePreflight: async () => {
          throw new Error('PR lineage preflight failed before PR creation: base sha mismatch: expected 11fc78e but found 0176283')
        },
        pushBranch: async () => {
          pushCalls += 1
        },
        createPr: async () => {
          createCalls += 1
          return { number: 99, url: 'https://example.test/pr/99' }
        },
      },
    )).rejects.toThrow('PR lineage preflight failed before PR creation')

    expect(pushCalls).toBe(0)
    expect(createCalls).toBe(0)
  })
})
