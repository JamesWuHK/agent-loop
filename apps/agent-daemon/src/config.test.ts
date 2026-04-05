import { describe, expect, test } from 'bun:test'
import type { AgentConfig } from '@agent/shared'
import { buildConfig, ConfigError } from './config'

const baseFileConfig: Partial<AgentConfig> = {
  machineId: 'machine-from-home',
  repo: 'JamesWuHK/digital-employee',
  pat: 'ghp-test',
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
  },
  project: {
    profile: 'generic',
    promptGuidance: {
      implementation: ['reuse the existing repo test commands'],
    },
  },
  agent: {
    primary: 'claude',
    fallback: 'codex',
    claudePath: 'claude-home',
    codexPath: 'codex-home',
    timeoutMs: 90_000,
  },
  git: {
    defaultBranch: 'master',
    authorName: 'agent-loop',
    authorEmail: 'agent-loop@local',
  },
}

describe('buildConfig', () => {
  test('lets repo-local project config override project defaults and merge prompt guidance', () => {
    const config = buildConfig(
      {},
      {
        fileConfig: baseFileConfig,
        repoConfig: {
          project: {
            profile: 'desktop-vite',
            promptGuidance: {
              implementation: ['run desktop tests via bun --cwd apps/desktop test'],
              reviewFix: ['stay within issue AllowedFiles boundaries'],
            },
          },
          agent: {
            primary: 'codex',
            fallback: 'claude',
          },
          git: {
            defaultBranch: 'main',
          },
        },
        env: {},
        homeDir: '/tmp/agent-loop-home',
      },
    )

    expect(config.project.profile).toBe('desktop-vite')
    expect(config.project.promptGuidance?.implementation).toEqual([
      'reuse the existing repo test commands',
      'run desktop tests via bun --cwd apps/desktop test',
    ])
    expect(config.project.promptGuidance?.reviewFix).toEqual([
      'stay within issue AllowedFiles boundaries',
    ])
    expect(config.project.maxConcurrency).toBeUndefined()
    expect(config.agent.primary).toBe('codex')
    expect(config.agent.fallback).toBe('claude')
    expect(config.agent.claudePath).toBe('claude-home')
    expect(config.agent.codexPath).toBe('codex-home')
    expect(config.git.defaultBranch).toBe('main')
    expect(config.requestedConcurrency).toBe(1)
    expect(config.concurrency).toBe(1)
    expect(config.concurrencyPolicy).toEqual({
      requested: 1,
      effective: 1,
      repoCap: null,
      profileCap: null,
      projectCap: null,
    })
    expect(config.recovery).toEqual({
      heartbeatIntervalMs: 30_000,
      leaseTtlMs: 60_000,
      workerIdleTimeoutMs: 300_000,
      leaseAdoptionBackoffMs: 5_000,
    })
    expect(config.worktreesBase).toBe('/tmp/agent-loop-home/.agent-worktrees/JamesWuHK-digital-employee')
  })

  test('keeps home config defaults when no repo-local overrides are present', () => {
    const config = buildConfig(
      {},
      {
        fileConfig: baseFileConfig,
        repoConfig: {},
        env: {},
        homeDir: '/tmp/agent-loop-home',
      },
    )

    expect(config.project.profile).toBe('generic')
    expect(config.project.promptGuidance?.implementation).toEqual([
      'reuse the existing repo test commands',
    ])
    expect(config.project.maxConcurrency).toBeUndefined()
    expect(config.agent.primary).toBe('claude')
    expect(config.git.defaultBranch).toBe('master')
    expect(config.requestedConcurrency).toBe(1)
    expect(config.concurrency).toBe(1)
    expect(config.recovery.leaseTtlMs).toBe(60_000)
  })

  test('applies repo, profile, and project concurrency caps to the effective daemon limit', () => {
    const config = buildConfig(
      {
        concurrency: 5,
      },
      {
        fileConfig: {
          ...baseFileConfig,
          scheduling: {
            concurrencyByRepo: {
              'JamesWuHK/digital-employee': 4,
            },
            concurrencyByProfile: {
              'desktop-vite': 2,
            },
          },
        },
        repoConfig: {
          project: {
            profile: 'desktop-vite',
            maxConcurrency: 3,
          },
        },
        env: {},
        homeDir: '/tmp/agent-loop-home',
      },
    )

    expect(config.requestedConcurrency).toBe(5)
    expect(config.concurrency).toBe(2)
    expect(config.project.maxConcurrency).toBe(3)
    expect(config.concurrencyPolicy).toEqual({
      requested: 5,
      effective: 2,
      repoCap: 4,
      profileCap: 2,
      projectCap: 3,
    })
    expect(config.recovery.heartbeatIntervalMs).toBe(30_000)
  })

  test('ignores invalid cap values instead of reducing concurrency to zero', () => {
    const config = buildConfig(
      {
        concurrency: 4,
      },
      {
        fileConfig: {
          ...baseFileConfig,
          scheduling: {
            concurrencyByRepo: {
              'JamesWuHK/digital-employee': 0,
            },
            concurrencyByProfile: {
              generic: -2,
            },
          },
        },
        repoConfig: {
          project: {
            maxConcurrency: 0,
          },
        },
        env: {},
        homeDir: '/tmp/agent-loop-home',
      },
    )

    expect(config.concurrency).toBe(4)
    expect(config.concurrencyPolicy).toEqual({
      requested: 4,
      effective: 4,
      repoCap: null,
      profileCap: null,
      projectCap: null,
    })
  })

  test('derives recovery defaults and lets machine config override them', () => {
    const config = buildConfig(
      {},
      {
        fileConfig: {
          ...baseFileConfig,
          recovery: {
            heartbeatIntervalMs: 10_000,
            leaseTtlMs: 45_000,
            workerIdleTimeoutMs: 90_000,
            leaseAdoptionBackoffMs: 12_000,
          },
        },
        repoConfig: {},
        env: {},
        homeDir: '/tmp/agent-loop-home',
      },
    )

    expect(config.recovery).toEqual({
      heartbeatIntervalMs: 10_000,
      leaseTtlMs: 45_000,
      workerIdleTimeoutMs: 90_000,
      leaseAdoptionBackoffMs: 12_000,
    })
  })

  test('falls back to gh auth token when no PAT is configured elsewhere', () => {
    const config = buildConfig(
      {},
      {
        fileConfig: {
          ...baseFileConfig,
          pat: undefined,
        },
        repoConfig: {},
        env: {},
        homeDir: '/tmp/agent-loop-home',
        ghAuthToken: 'gho-from-gh-cli',
      },
    )

    expect(config.pat).toBe('gho-from-gh-cli')
  })

  test('raises a config error when no PAT or gh auth token is available', () => {
    expect(() => buildConfig(
      {},
      {
        fileConfig: {
          ...baseFileConfig,
          pat: undefined,
        },
        repoConfig: {},
        env: {},
        homeDir: '/tmp/agent-loop-home',
        ghAuthToken: null,
      },
    )).toThrow(new ConfigError(
      'No GitHub PAT found. Set GITHUB_TOKEN/GH_TOKEN, configure pat in ~/.agent-loop/config.json, or log in with gh auth login',
    ))
  })
})
