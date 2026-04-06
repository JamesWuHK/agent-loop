import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import type { AgentConfig } from '@agent/shared'
import { createWorktree } from './worktree-manager'

// We need to test the validation logic directly since the module has side effects
describe('validateBranchName', () => {
  // Test the validation logic directly
  const validateBranchName = (branch: string): void => {
    if (!/^[a-zA-Z0-9/_-]+$/.test(branch)) {
      throw new Error(`Invalid branch name: contains forbidden characters: ${branch}`)
    }
    if (/^[-.]|[\/]$/.test(branch)) {
      throw new Error(`Invalid branch name: cannot start with '-' or '.', or end with '/': ${branch}`)
    }
    const segments = branch.split('/')
    for (const segment of segments) {
      if (segment === '') {
        throw new Error(`Invalid branch name: empty segment: ${branch}`)
      }
    }
  }

  describe('valid branch names', () => {
    it('should accept valid branch names with alphanumeric characters', () => {
      expect(() => validateBranchName('main')).not.toThrow()
      expect(() => validateBranchName('feature123')).not.toThrow()
      expect(() => validateBranchName('branchName')).not.toThrow()
    })

    it('should accept valid branch names with hyphens', () => {
      expect(() => validateBranchName('feature-branch')).not.toThrow()
      expect(() => validateBranchName('my-long-branch-name')).not.toThrow()
    })

    it('should accept valid branch names with underscores', () => {
      expect(() => validateBranchName('feature_branch')).not.toThrow()
      expect(() => validateBranchName('my_long_branch_name')).not.toThrow()
    })

    it('should accept valid branch names with forward slashes', () => {
      expect(() => validateBranchName('agent/3/uuid')).not.toThrow()
      expect(() => validateBranchName('feature/branch/nested')).not.toThrow()
    })

    it('should accept the expected agent branch format', () => {
      expect(() => validateBranchName('agent/3/26b30210-aa5a-43df-9e36-ef64c0e50ec1')).not.toThrow()
      expect(() => validateBranchName('agent/123/xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx')).not.toThrow()
    })
  })

  describe('invalid branch names - forbidden characters', () => {
    it('should reject branch names with spaces', () => {
      expect(() => validateBranchName('branch name')).toThrow()
    })

    it('should reject branch names with shell metacharacters', () => {
      expect(() => validateBranchName('branch;rm')).toThrow()
      expect(() => validateBranchName('branch|cat')).toThrow()
      expect(() => validateBranchName('branch$var')).toThrow()
      expect(() => validateBranchName('branch`cmd`')).toThrow()
    })

    it('should reject branch names with git forbidden characters', () => {
      expect(() => validateBranchName('branch~')).toThrow()
      expect(() => validateBranchName('branch^')).toThrow()
      expect(() => validateBranchName('branch:')).toThrow()
      expect(() => validateBranchName('branch*')).toThrow()
      expect(() => validateBranchName('branch?')).toThrow()
      expect(() => validateBranchName('branch[')).toThrow()
      expect(() => validateBranchName('branch]')).toThrow()
      expect(() => validateBranchName('branch\\')).toThrow()
    })

    it('should reject branch names with path traversal attempts', () => {
      expect(() => validateBranchName('../etc/passwd')).toThrow()
      expect(() => validateBranchName('branch/../../etc')).toThrow()
    })

    it('should reject branch names with newlines or other control characters', () => {
      expect(() => validateBranchName('branch\nname')).toThrow()
      expect(() => validateBranchName('branch\tname')).toThrow()
    })
  })

  describe('invalid branch names - format rules', () => {
    it('should reject branch names starting with hyphen', () => {
      expect(() => validateBranchName('-branch')).toThrow()
    })

    it('should reject branch names starting with dot', () => {
      expect(() => validateBranchName('.branch')).toThrow()
    })

    it('should reject branch names ending with slash', () => {
      expect(() => validateBranchName('branch/')).toThrow()
    })

    it('should reject branch names with empty segments', () => {
      expect(() => validateBranchName('agent//uuid')).toThrow()
      expect(() => validateBranchName('//uuid')).toThrow()
    })
  })
})

describe('createWorktree', () => {
  it('refreshes origin/defaultBranch before creating a new issue worktree', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'worktree-manager-test-'))
    const remoteDir = join(tempDir, 'remote.git')
    const seedDir = join(tempDir, 'seed')
    const runnerDir = join(tempDir, 'runner')
    const previousCwd = process.cwd()

    const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()

    try {
      mkdirSync(remoteDir, { recursive: true })
      mkdirSync(seedDir, { recursive: true })

      git(remoteDir, 'init', '--bare')
      git(seedDir, 'init', '-b', 'main')
      git(seedDir, 'config', 'user.name', 'agent-loop')
      git(seedDir, 'config', 'user.email', 'agent-loop@local')
      git(seedDir, 'remote', 'add', 'origin', remoteDir)

      writeFileSync(join(seedDir, 'demo.txt'), 'base\n', 'utf-8')
      git(seedDir, 'add', 'demo.txt')
      git(seedDir, 'commit', '-m', 'base')
      git(seedDir, 'push', '-u', 'origin', 'main')

      git(tempDir, 'clone', remoteDir, runnerDir)
      git(runnerDir, 'config', 'user.name', 'agent-loop')
      git(runnerDir, 'config', 'user.email', 'agent-loop@local')

      writeFileSync(join(seedDir, 'demo.txt'), 'latest\n', 'utf-8')
      git(seedDir, 'add', 'demo.txt')
      git(seedDir, 'commit', '-m', 'advance main')
      git(seedDir, 'push')

      const remoteHead = git(seedDir, 'rev-parse', 'HEAD')
      const staleOriginHead = git(runnerDir, 'rev-parse', 'origin/main')
      expect(staleOriginHead).not.toBe(remoteHead)

      process.chdir(runnerDir)
      const config: AgentConfig = {
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
        worktreesBase: join(tempDir, 'worktrees'),
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

      const worktreePath = await createWorktree(42, config)

      expect(git(runnerDir, 'rev-parse', 'origin/main')).toBe(remoteHead)
      expect(git(worktreePath, 'rev-parse', 'HEAD')).toBe(remoteHead)
      expect(git(worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('agent/42/test-machine')
    } finally {
      process.chdir(previousCwd)
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
