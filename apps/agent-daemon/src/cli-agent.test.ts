import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { AgentConfig } from '@agent/shared'
import {
  buildAgentCommand,
  buildIsolatedCodexConfig,
  createIsolatedCodexHome,
  resolveAgentBinary,
  resolveCodexAuthJson,
} from './cli-agent'

const baseConfig: AgentConfig = {
  machineId: 'test-machine',
  repo: 'owner/repo',
  pat: 'ghp_test',
  pollIntervalMs: 60_000,
  concurrency: 1,
  worktreesBase: '/tmp/worktrees',
  agent: {
    primary: 'codex',
    fallback: 'claude',
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

describe('cli-agent', () => {
  test('resolves configured binary paths', () => {
    expect(resolveAgentBinary('claude', baseConfig)).toBe('claude')
    expect(resolveAgentBinary('codex', baseConfig)).toBe('codex')
  })

  test('builds Claude command with Claude-specific flags', () => {
    expect(buildAgentCommand('claude', 'claude', '/tmp/ignored.txt', true)).toEqual([
      'claude',
      '--print',
      '--permission-mode',
      'bypassPermissions',
    ])
  })

  test('builds Codex command with non-interactive exec flags', () => {
    expect(buildAgentCommand('codex', 'codex', '/tmp/last-message.txt', true)).toEqual([
      'codex',
      'exec',
      '--color',
      'never',
      '--output-last-message',
      '/tmp/last-message.txt',
      '-c',
      'model_reasoning_effort="medium"',
      '--dangerously-bypass-approvals-and-sandbox',
      '-',
    ])
  })

  test('builds read-only Codex command for review-style runs', () => {
    expect(buildAgentCommand('codex', 'codex', '/tmp/review-message.txt', false)).toEqual([
      'codex',
      'exec',
      '--color',
      'never',
      '--output-last-message',
      '/tmp/review-message.txt',
      '-c',
      'model_reasoning_effort="medium"',
      '--sandbox',
      'read-only',
      '-',
    ])
  })

  test('prefers environment auth for isolated Codex runtime', () => {
    expect(resolveCodexAuthJson(
      { OPENAI_API_KEY: 'sk-proxy' },
      '{\n  "OPENAI_API_KEY": "sk-stale"\n}\n',
    )).toBe('{\n  "OPENAI_API_KEY": "sk-proxy"\n}\n')
  })

  test('falls back to existing auth json when no env auth is present', () => {
    expect(resolveCodexAuthJson(
      {},
      '{\n  "OPENAI_API_KEY": "sk-stale"\n}\n',
    )).toBe('{\n  "OPENAI_API_KEY": "sk-stale"\n}\n')
  })

  test('creates isolated Codex home with minimal config and auth', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cli-agent-test-'))

    try {
      const { homeDir, codexHomeDir } = createIsolatedCodexHome(
        tempDir,
        {
          OPENAI_API_KEY: 'sk-local-proxy',
          OPENAI_BASE_URL: 'http://127.0.0.1:18777/v1',
          PATH: '/opt/homebrew/bin:/usr/bin',
          HTTPS_PROXY: 'http://127.0.0.1:7890',
        },
        null,
      )

      expect(homeDir).toBe(join(tempDir, 'home'))
      expect(codexHomeDir).toBe(join(tempDir, 'home', '.codex'))
      expect(existsSync(join(codexHomeDir, 'config.toml'))).toBe(true)
      expect(existsSync(join(codexHomeDir, 'auth.json'))).toBe(true)
      expect(existsSync(join(homeDir, '.agent-loop-shell-env'))).toBe(true)
      expect(existsSync(join(homeDir, '.zshenv'))).toBe(true)
      expect(existsSync(join(homeDir, '.bash_profile'))).toBe(true)
      expect(readFileSync(join(codexHomeDir, 'config.toml'), 'utf-8')).toBe(
        buildIsolatedCodexConfig('http://127.0.0.1:18777/v1'),
      )
      expect(readFileSync(join(codexHomeDir, 'auth.json'), 'utf-8')).toBe(
        '{\n  "OPENAI_API_KEY": "sk-local-proxy"\n}\n',
      )
      expect(readFileSync(join(homeDir, '.agent-loop-shell-env'), 'utf-8')).toContain(
        "export PATH='/opt/homebrew/bin:/usr/bin'",
      )
      expect(readFileSync(join(homeDir, '.agent-loop-shell-env'), 'utf-8')).toContain(
        "export HTTPS_PROXY='http://127.0.0.1:7890'",
      )
      expect(readFileSync(join(homeDir, '.zshenv'), 'utf-8')).toBe(
        `. "${join(homeDir, '.agent-loop-shell-env')}"\n`,
      )
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
