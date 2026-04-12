import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentConfig } from '@agent/shared'
import {
  buildIssueRecoveryPrompt,
  buildReviewAutoFixPrompt,
  resolveAgentExecutionTimeoutMs,
  runIssueBranchPreflight,
  runIssueRecovery,
  salvageDirtyWorktree,
  shouldTreatCleanNoCommitSubtaskAsSuccess,
  validateReviewAutoFixScope,
} from './subtask-executor'

const TEST_CONFIG: AgentConfig = {
  machineId: 'test-machine',
  repo: 'JamesWuHK/digital-employee',
  pat: 'test-token',
  pollIntervalMs: 60_000,
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
  worktreesBase: '/tmp',
  project: {
    profile: 'desktop-vite',
  },
  agent: {
    primary: 'codex',
    fallback: null,
    claudePath: 'claude',
    codexPath: 'codex',
    timeoutMs: 60_000,
  },
  git: {
    defaultBranch: 'main',
    authorName: 'agent-loop',
    authorEmail: 'agent-loop@local',
  },
}

const tempDirs: string[] = []
const spawnedPids: number[] = []

afterEach(() => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Process already exited.
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function createGitRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'subtask-executor-test-'))
  tempDirs.push(dir)

  await Bun.$`git -C ${dir} init -b main`.quiet()
  await Bun.$`git -C ${dir} config user.name ${TEST_CONFIG.git.authorName}`.quiet()
  await Bun.$`git -C ${dir} config user.email ${TEST_CONFIG.git.authorEmail}`.quiet()

  writeFileSync(join(dir, 'demo.txt'), 'before\n', 'utf-8')
  await Bun.$`git -C ${dir} add demo.txt`.quiet()
  await Bun.$`git -C ${dir} commit -m "chore: init"`.quiet()

  return dir
}

describe('salvageDirtyWorktree', () => {
  it('returns null when the worktree is already clean', async () => {
    const dir = await createGitRepo()

    const result = await salvageDirtyWorktree(dir, 'fix: salvage clean repo', TEST_CONFIG)

    expect(result).toBeNull()
  })

  it('creates a commit from dirty tracked changes', async () => {
    const dir = await createGitRepo()
    writeFileSync(join(dir, 'demo.txt'), 'after\n', 'utf-8')

    const result = await salvageDirtyWorktree(dir, 'fix: salvage dirty repo', TEST_CONFIG)
    const status = (await Bun.$`git -C ${dir} status --short`.quiet().text()).trim()
    const subject = (await Bun.$`git -C ${dir} log -1 --pretty=%s`.quiet().text()).trim()

    expect(result).toBeString()
    expect(result?.length).toBeGreaterThan(0)
    expect(status).toBe('')
    expect(subject).toBe('fix: salvage dirty repo')
  })
})

describe('shouldTreatCleanNoCommitSubtaskAsSuccess', () => {
  it('returns true for later subtasks when earlier commits already exist and the worktree is clean', async () => {
    const dir = await createGitRepo()
    await Bun.$`git -C ${dir} checkout -b agent/test`.quiet()
    writeFileSync(join(dir, 'demo.txt'), 'after\n', 'utf-8')
    await Bun.$`git -C ${dir} add demo.txt`.quiet()
    await Bun.$`git -C ${dir} commit -m "feat: progress"`.quiet()

    const result = await shouldTreatCleanNoCommitSubtaskAsSuccess(
      dir,
      TEST_CONFIG.git.defaultBranch,
      2,
    )

    expect(result).toBe(true)
  })

  it('returns false for the first subtask even when earlier commits exist', async () => {
    const dir = await createGitRepo()
    await Bun.$`git -C ${dir} checkout -b agent/test`.quiet()
    writeFileSync(join(dir, 'demo.txt'), 'after\n', 'utf-8')
    await Bun.$`git -C ${dir} add demo.txt`.quiet()
    await Bun.$`git -C ${dir} commit -m "feat: progress"`.quiet()

    const result = await shouldTreatCleanNoCommitSubtaskAsSuccess(
      dir,
      TEST_CONFIG.git.defaultBranch,
      1,
    )

    expect(result).toBe(false)
  })

  it('returns false when the worktree is dirty', async () => {
    const dir = await createGitRepo()
    writeFileSync(join(dir, 'demo.txt'), 'after\n', 'utf-8')

    const result = await shouldTreatCleanNoCommitSubtaskAsSuccess(
      dir,
      TEST_CONFIG.git.defaultBranch,
      2,
    )

    expect(result).toBe(false)
  })
})

describe('buildIssueRecoveryPrompt', () => {
  it('tells the recovery agent to verify blockers against issue scope', () => {
    const prompt = buildIssueRecoveryPrompt(
      46,
      '[US1-2] AppContext 增加最小 auth/navigation 接口',
      `## Constraints
- 只补最小接口
- 不接 API，不做 token 持久化`,
      TEST_CONFIG.repo,
      {
        number: 61,
        url: 'https://example.com/pr/61',
        branch: 'agent/46/codex-20260403',
      },
      [
        'App stays on /login because there is no real login flow yet.',
      ],
      TEST_CONFIG.project,
    )

    expect(prompt).toContain('Treat the latest blocking review feedback as input, but verify it against the issue scope before changing code.')
    expect(prompt).toContain('If a blocker conflicts with the issue\'s explicit constraints or asks for later-scope work, do not expand scope just to satisfy that blocker.')
    expect(prompt).toContain('Preserve the issue\'s explicit acceptance semantics.')
    expect(prompt).toContain('Do not introduce new API logic, persistence, gateway handlers, or broader app rewrites unless the issue explicitly requires them.')
    expect(prompt).toContain('Run `git diff --stat origin/main...HEAD` and sanity-check that the changed files still match the issue scope.')
    expect(prompt).toContain('already merge-ready for this issue scope')
    expect(prompt).toContain('App stays on /login because there is no real login flow yet.')
    expect(prompt).toContain('cd apps/desktop && bun run --bun test src/App.test.tsx')
    expect(prompt).toContain('Prefer Bun-native execution to avoid host Node mismatches')
  })
})

describe('resolveAgentExecutionTimeoutMs', () => {
  it('uses the configured agent timeout instead of a hard-coded 10 minute cap', () => {
    const timeoutMs = resolveAgentExecutionTimeoutMs({
      ...TEST_CONFIG,
      agent: {
        ...TEST_CONFIG.agent,
        timeoutMs: 45 * 60 * 1000,
      },
    })

    expect(timeoutMs).toBe(45 * 60 * 1000)
  })
})

describe('runIssueRecovery', () => {
  it('returns remote_closed without salvaging when the linked issue is already done elsewhere', async () => {
    const dir = await createGitRepo()
    const scriptDir = mkdtempSync(join(tmpdir(), 'subtask-executor-agent-'))
    tempDirs.push(scriptDir)
    const scriptPath = join(scriptDir, 'fake-claude.sh')

    writeFileSync(
      scriptPath,
      '#!/bin/sh\ncat >/dev/null\nwhile :; do :; done\n',
      'utf-8',
    )
    chmodSync(scriptPath, 0o755)

    const result = await runIssueRecovery(
      dir,
      104,
      'test issue',
      'test body',
      {
        ...TEST_CONFIG,
        agent: {
          ...TEST_CONFIG.agent,
          primary: 'claude',
          fallback: null,
          claudePath: scriptPath,
        },
      },
      console,
      null,
      [],
      {
        agentMonitor: {
          heartbeatIntervalMs: 50,
          idleTimeoutMs: 2_000,
          shouldAbort: () => true,
        },
      },
    )

    expect(result.success).toBe(false)
    expect(result.failureKind).toBe('remote_closed')
    expect(result.commitCreated).toBe(false)
    expect(result.error).toContain('remote issue is already done')

    const status = (await Bun.$`git -C ${dir} status --short`.quiet().text()).trim()
    expect(status).toBe('')
  })
})

describe('buildReviewAutoFixPrompt', () => {
  it('tells the auto-fix agent how to run desktop Vitest with jsdom', () => {
    const prompt = buildReviewAutoFixPrompt(
      46,
      61,
      'https://example.com/pr/61',
      'Fix the unauthenticated login route regression.',
      `## Context
### AllowedFiles
- apps/desktop/src/App.tsx
### ForbiddenFiles
- apps/desktop/src/context/AppContext.tsx`,
      TEST_CONFIG.project,
    )

    expect(prompt).toContain('cd apps/desktop && bun run --bun test src/App.test.tsx')
    expect(prompt).toContain('Prefer Bun-native execution to avoid host Node mismatches')
    expect(prompt).toContain('Vitest loads `vite.config.ts` and the `jsdom` environment')
    expect(prompt).toContain('Preserve the linked issue\'s explicit acceptance contract')
    expect(prompt).toContain('Do not introduce new API calls, persistence, gateway actions, or unrelated refactors')
    expect(prompt).toContain('Linked issue contract:')
    expect(prompt).toContain('Allowed files')
    expect(prompt).toContain('Forbidden files')
    expect(prompt).toContain('Never modify files listed under `ForbiddenFiles`')
    expect(prompt).toContain('git diff --name-only origin/main...HEAD')
  })

  it('falls back to generic toolchain guidance when no project profile is provided', () => {
    const prompt = buildReviewAutoFixPrompt(
      46,
      61,
      'https://example.com/pr/61',
      'Fix the unauthenticated login route regression.',
      '',
    )

    expect(prompt).toContain('Validate fixes with the repository\'s existing commands')
    expect(prompt).not.toContain('Vitest loads `vite.config.ts` and the `jsdom` environment')
  })
})

describe('validateReviewAutoFixScope', () => {
  it('accepts changed files that stay within AllowedFiles', async () => {
    const dir = await createGitRepo()
    await Bun.$`git -C ${dir} checkout -b agent/test`.quiet()
    writeFileSync(join(dir, 'demo.txt'), 'after\n', 'utf-8')
    await Bun.$`git -C ${dir} add demo.txt`.quiet()
    await Bun.$`git -C ${dir} commit -m "feat: demo"`.quiet()

    const result = await validateReviewAutoFixScope(
      dir,
      `## Context
### AllowedFiles
- demo.txt
### ForbiddenFiles
- blocked.txt`,
      TEST_CONFIG.git.defaultBranch,
    )

    expect(result.valid).toBe(true)
    expect(result.violations).toEqual([])
    expect(result.changedFiles).toEqual(['demo.txt'])
  })

  it('rejects branches that touch ForbiddenFiles or files outside AllowedFiles', async () => {
    const dir = await createGitRepo()
    await Bun.$`git -C ${dir} checkout -b agent/test`.quiet()
    writeFileSync(join(dir, 'demo.txt'), 'after\n', 'utf-8')
    writeFileSync(join(dir, 'blocked.txt'), 'blocked\n', 'utf-8')
    await Bun.$`git -C ${dir} add demo.txt blocked.txt`.quiet()
    await Bun.$`git -C ${dir} commit -m "feat: invalid scope"`.quiet()

    const result = await validateReviewAutoFixScope(
      dir,
      `## Context
### AllowedFiles
- demo.txt
### ForbiddenFiles
- blocked.txt`,
      TEST_CONFIG.git.defaultBranch,
    )

    expect(result.valid).toBe(false)
    expect(result.violations).toContain('changed forbidden files: blocked.txt')
  })
})

describe('runIssueBranchPreflight', () => {
  it('runs executable validation commands and ignores narrative validation entries', async () => {
    const dir = await createGitRepo()
    await Bun.$`git -C ${dir} checkout -b agent/test`.quiet()
    writeFileSync(join(dir, 'demo.txt'), 'after\n', 'utf-8')
    await Bun.$`git -C ${dir} add demo.txt`.quiet()
    await Bun.$`git -C ${dir} commit -m "feat: demo"`.quiet()

    const result = await runIssueBranchPreflight(
      dir,
      `## Context
### AllowedFiles
- demo.txt
### Validation
- \`sh -lc "test -f demo.txt"\`
- 观察页面是否正常`,
      TEST_CONFIG,
    )

    expect(result.valid).toBe(true)
    expect(result.scopeViolations).toEqual([])
    expect(result.validationFailures).toEqual([])
    expect(result.executableValidationCommands).toEqual(['sh -lc "test -f demo.txt"'])
  })

  it('fails preflight when an executable validation command fails', async () => {
    const dir = await createGitRepo()
    await Bun.$`git -C ${dir} checkout -b agent/test`.quiet()
    writeFileSync(join(dir, 'demo.txt'), 'after\n', 'utf-8')
    await Bun.$`git -C ${dir} add demo.txt`.quiet()
    await Bun.$`git -C ${dir} commit -m "feat: demo"`.quiet()

    const result = await runIssueBranchPreflight(
      dir,
      `## Context
### AllowedFiles
- demo.txt
### Validation
- \`sh -lc "test -f missing.txt"\``,
      TEST_CONFIG,
    )

    expect(result.valid).toBe(false)
    expect(result.validationFailures).toHaveLength(1)
    expect(result.validationFailures[0]?.command).toBe('sh -lc "test -f missing.txt"')
    expect(result.violations[0]).toContain('validation failed: sh -lc "test -f missing.txt"')
  })

  it('runs validation commands without a login shell so local profiles cannot override PATH', async () => {
    const dir = await createGitRepo()
    await Bun.$`git -C ${dir} checkout -b agent/test`.quiet()
    writeFileSync(join(dir, 'demo.txt'), 'after\n', 'utf-8')
    await Bun.$`git -C ${dir} add demo.txt`.quiet()
    await Bun.$`git -C ${dir} commit -m "feat: demo"`.quiet()

    const fakeHome = mkdtempSync(join(tmpdir(), 'subtask-executor-home-'))
    tempDirs.push(fakeHome)
    const fakeBin = join(fakeHome, 'fake-bin')
    await Bun.$`mkdir -p ${fakeBin}`.quiet()
    writeFileSync(
      join(fakeBin, 'node'),
      '#!/bin/sh\nexit 42\n',
      'utf-8',
    )
    chmodSync(join(fakeBin, 'node'), 0o755)
    writeFileSync(
      join(fakeHome, '.profile'),
      `export PATH="${fakeBin}:$PATH"\n`,
      'utf-8',
    )

    const previousHome = process.env.HOME

    try {
      process.env.HOME = fakeHome

      const result = await runIssueBranchPreflight(
        dir,
        `## Context
### AllowedFiles
- demo.txt
### Validation
- \`node -e "process.exit(0)"\``,
        TEST_CONFIG,
      )

      expect(result.valid).toBe(true)
      expect(result.validationFailures).toEqual([])
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
    }
  })

  it('kills timed out validation command process trees so preflight returns cleanly', async () => {
    const dir = await createGitRepo()
    await Bun.$`git -C ${dir} checkout -b agent/test`.quiet()
    writeFileSync(join(dir, 'demo.txt'), 'after\n', 'utf-8')
    await Bun.$`git -C ${dir} add demo.txt`.quiet()
    await Bun.$`git -C ${dir} commit -m "feat: demo"`.quiet()

    const scriptDir = mkdtempSync(join(tmpdir(), 'subtask-executor-timeout-'))
    tempDirs.push(scriptDir)
    const scriptPath = join(scriptDir, 'hang-validation.js')
    const pidPath = join(scriptDir, 'validation.pid')

    writeFileSync(
      scriptPath,
      `const fs = require('node:fs')
fs.writeFileSync(process.argv[2], String(process.pid))
setInterval(() => {}, 1000)
`,
      'utf-8',
    )

    const config: AgentConfig = {
      ...TEST_CONFIG,
      recovery: {
        ...TEST_CONFIG.recovery,
        workerIdleTimeoutMs: 200,
      },
    }

    const preflightPromise = runIssueBranchPreflight(
      dir,
      `## Context
### AllowedFiles
- demo.txt
### Validation
- \`node ${JSON.stringify(scriptPath)} ${JSON.stringify(pidPath)}\``,
      config,
    )
    const outcome = await Promise.race([
      preflightPromise,
      Bun.sleep(4_000).then(() => 'timeout' as const),
    ])

    if (outcome === 'timeout') {
      if (existsSync(pidPath)) {
        const pid = Number(readFileSync(pidPath, 'utf-8').trim())
        if (Number.isInteger(pid) && pid > 0) {
          spawnedPids.push(pid)
        }
      }
      throw new Error('runIssueBranchPreflight did not return after timing out the validation command')
    }

    expect(outcome.valid).toBe(false)
    expect(outcome.validationFailures).toHaveLength(1)
    expect(outcome.validationFailures[0]?.timedOut).toBe(true)

    const pid = Number(readFileSync(pidPath, 'utf-8').trim())
    expect(pid).toBeGreaterThan(0)
    spawnedPids.push(pid)
    await Bun.sleep(100)
    expect(isProcessAlive(pid)).toBe(false)
  })
})
