import { describe, expect, test } from 'bun:test'
import type { AgentConfig } from '@agent/shared'
import { buildConfig } from './config'

const baseFileConfig: Partial<AgentConfig> = {
  machineId: 'machine-from-home',
  repo: 'JamesWuHK/digital-employee',
  pat: 'ghp-test',
  pollIntervalMs: 60_000,
  concurrency: 1,
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
    expect(config.agent.primary).toBe('codex')
    expect(config.agent.fallback).toBe('claude')
    expect(config.agent.claudePath).toBe('claude-home')
    expect(config.agent.codexPath).toBe('codex-home')
    expect(config.git.defaultBranch).toBe('main')
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
    expect(config.agent.primary).toBe('claude')
    expect(config.git.defaultBranch).toBe('master')
  })
})
