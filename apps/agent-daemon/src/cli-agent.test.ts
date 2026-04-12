import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { AgentConfig } from '@agent/shared'
import {
  buildAgentCommand,
  buildIsolatedCodexConfig,
  createIsolatedCodexHome,
  runConfiguredAgent,
  resolveAgentBinary,
  resolveCodexAuthJson,
} from './cli-agent'

const baseConfig: AgentConfig = {
  machineId: 'test-machine',
  repo: 'owner/repo',
  pat: 'ghp_test',
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
  worktreesBase: '/tmp/worktrees',
  project: {
    profile: 'generic',
  },
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

  test('runs Codex with isolated base_url config while deprecated OPENAI base-url env vars stay unset', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cli-agent-codex-env-test-'))
    const scriptPath = join(tempDir, 'fake-codex.sh')
    const envCapturePath = join(tempDir, 'captured-env.txt')
    const configCapturePath = join(tempDir, 'captured-config.toml')
    const bootstrapCapturePath = join(tempDir, 'captured-shell-env.sh')
    const argvCapturePath = join(tempDir, 'captured-argv.txt')
    const worktreePath = join(tempDir, 'worktree')

    try {
      writeFileSync(
        scriptPath,
        `#!/bin/sh
response_file=''
argv_file=${JSON.stringify(argvCapturePath)}
for arg in "$@"; do
  printf '%s\n' "$arg" >> "$argv_file"
done
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then
    shift
    response_file="$1"
  fi
  shift
done
cat >/dev/null
cp "$CODEX_HOME/config.toml" ${JSON.stringify(configCapturePath)}
cp "$HOME/.agent-loop-shell-env" ${JSON.stringify(bootstrapCapturePath)}
{
  printf 'OPENAI_BASE_URL=%s\n' "\${OPENAI_BASE_URL-__UNSET__}"
  printf 'OPENAI_API_BASE=%s\n' "\${OPENAI_API_BASE-__UNSET__}"
  printf 'OPENAI_API_URL=%s\n' "\${OPENAI_API_URL-__UNSET__}"
  printf 'OPENAI_BASE=%s\n' "\${OPENAI_BASE-__UNSET__}"
  printf 'PATH=%s\n' "\${PATH-__UNSET__}"
  printf 'HTTPS_PROXY=%s\n' "\${HTTPS_PROXY-__UNSET__}"
  printf 'BUN_INSTALL=%s\n' "\${BUN_INSTALL-__UNSET__}"
  printf 'NVM_DIR=%s\n' "\${NVM_DIR-__UNSET__}"
} > ${JSON.stringify(envCapturePath)}
printf 'fake codex ok\n' > "$response_file"
`,
        'utf-8',
      )
      chmodSync(scriptPath, 0o755)
      mkdirSync(worktreePath, { recursive: true })

      const originalOpenaiBaseUrl = process.env.OPENAI_BASE_URL
      const originalOpenaiApiBase = process.env.OPENAI_API_BASE
      const originalOpenaiApiUrl = process.env.OPENAI_API_URL
      const originalOpenaiBase = process.env.OPENAI_BASE
      const originalHttpsProxy = process.env.HTTPS_PROXY
      const originalBunInstall = process.env.BUN_INSTALL
      const originalNvmDir = process.env.NVM_DIR

      process.env.OPENAI_BASE_URL = 'https://runtime-openai-base-url.example/v1'
      process.env.OPENAI_API_BASE = 'https://runtime-openai-api-base.example/v1'
      process.env.OPENAI_API_URL = 'https://runtime-openai-api-url.example/v1'
      process.env.OPENAI_BASE = 'https://runtime-openai-base.example/v1'
      process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
      process.env.BUN_INSTALL = '/opt/bun'
      process.env.NVM_DIR = '/opt/nvm'

      try {
        const result = await runConfiguredAgent({
          prompt: 'noop',
          worktreePath,
          timeoutMs: 5_000,
          config: {
            ...baseConfig,
            agent: {
              ...baseConfig.agent,
              primary: 'codex',
              fallback: null,
              codexPath: scriptPath,
              codexBaseUrl: 'http://127.0.0.1:18777/v1',
            },
          },
        })

        expect(result.ok).toBe(true)
        expect(result.exitCode).toBe(0)
        expect(result.responseText).toBe('fake codex ok')

        expect(readFileSync(configCapturePath, 'utf-8')).toBe(
          buildIsolatedCodexConfig('http://127.0.0.1:18777/v1'),
        )
        const argv = readFileSync(argvCapturePath, 'utf-8').trim().split('\n')
        expect(argv[0]).toBe('exec')
        expect(argv[1]).toBe('--color')
        expect(argv[2]).toBe('never')
        expect(argv[3]).toBe('--output-last-message')
        expect(argv[4]).toEndWith('/last-message.txt')
        expect(argv[5]).toBe('-c')
        expect(argv[6]).toBe('model_reasoning_effort="medium"')
        expect(argv[7]).toBe('--dangerously-bypass-approvals-and-sandbox')
        expect(argv[8]).toBe('-')
        expect(readFileSync(envCapturePath, 'utf-8')).toContain('OPENAI_BASE_URL=__UNSET__')
        expect(readFileSync(envCapturePath, 'utf-8')).toContain('OPENAI_API_BASE=__UNSET__')
        expect(readFileSync(envCapturePath, 'utf-8')).toContain('OPENAI_API_URL=__UNSET__')
        expect(readFileSync(envCapturePath, 'utf-8')).toContain('OPENAI_BASE=__UNSET__')
        expect(readFileSync(envCapturePath, 'utf-8')).toContain('PATH=')
        expect(readFileSync(envCapturePath, 'utf-8')).toContain('HTTPS_PROXY=http://127.0.0.1:7890')
        expect(readFileSync(envCapturePath, 'utf-8')).toContain('BUN_INSTALL=/opt/bun')
        expect(readFileSync(envCapturePath, 'utf-8')).toContain('NVM_DIR=/opt/nvm')
        expect(readFileSync(bootstrapCapturePath, 'utf-8')).toContain(
          "export HTTPS_PROXY='http://127.0.0.1:7890'",
        )
        expect(readFileSync(bootstrapCapturePath, 'utf-8')).toContain(
          "export BUN_INSTALL='/opt/bun'",
        )
        expect(readFileSync(bootstrapCapturePath, 'utf-8')).toContain(
          "export NVM_DIR='/opt/nvm'",
        )
      } finally {
        if (originalOpenaiBaseUrl === undefined) {
          delete process.env.OPENAI_BASE_URL
        } else {
          process.env.OPENAI_BASE_URL = originalOpenaiBaseUrl
        }
        if (originalOpenaiApiBase === undefined) {
          delete process.env.OPENAI_API_BASE
        } else {
          process.env.OPENAI_API_BASE = originalOpenaiApiBase
        }
        if (originalOpenaiApiUrl === undefined) {
          delete process.env.OPENAI_API_URL
        } else {
          process.env.OPENAI_API_URL = originalOpenaiApiUrl
        }
        if (originalOpenaiBase === undefined) {
          delete process.env.OPENAI_BASE
        } else {
          process.env.OPENAI_BASE = originalOpenaiBase
        }
        if (originalHttpsProxy === undefined) {
          delete process.env.HTTPS_PROXY
        } else {
          process.env.HTTPS_PROXY = originalHttpsProxy
        }
        if (originalBunInstall === undefined) {
          delete process.env.BUN_INSTALL
        } else {
          process.env.BUN_INSTALL = originalBunInstall
        }
        if (originalNvmDir === undefined) {
          delete process.env.NVM_DIR
        } else {
          process.env.NVM_DIR = originalNvmDir
        }
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('marks hung agent runs as idle_timeout when no output or git progress occurs', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cli-agent-hung-test-'))
    const scriptPath = join(tempDir, 'fake-claude.sh')
    const worktreePath = join(tempDir, 'worktree')

    try {
      writeFileSync(
        scriptPath,
        '#!/bin/sh\ncat >/dev/null\nwhile :; do :; done\n',
        'utf-8',
      )
      chmodSync(scriptPath, 0o755)
      mkdirSync(worktreePath, { recursive: true })

      const result = await runConfiguredAgent({
        prompt: 'noop',
        worktreePath,
        timeoutMs: 5_000,
        config: {
          ...baseConfig,
          agent: {
            ...baseConfig.agent,
            primary: 'claude',
            fallback: null,
            claudePath: scriptPath,
          },
        },
        monitor: {
          heartbeatIntervalMs: 50,
          idleTimeoutMs: 200,
        },
      })

      expect(result.ok).toBe(false)
      expect(result.exitCode).not.toBe(0)
      expect(result.failureKind).toBe('idle_timeout')
      expect(result.stderr).toContain('Idle timeout')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('aborts agent runs when the monitor reports the remote issue is already closed', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cli-agent-abort-test-'))
    const scriptPath = join(tempDir, 'fake-claude.sh')
    const worktreePath = join(tempDir, 'worktree')

    try {
      writeFileSync(
        scriptPath,
        '#!/bin/sh\ncat >/dev/null\nwhile :; do :; done\n',
        'utf-8',
      )
      chmodSync(scriptPath, 0o755)
      mkdirSync(worktreePath, { recursive: true })

      const result = await runConfiguredAgent({
        prompt: 'noop',
        worktreePath,
        timeoutMs: 5_000,
        config: {
          ...baseConfig,
          agent: {
            ...baseConfig.agent,
            primary: 'claude',
            fallback: 'codex',
            claudePath: scriptPath,
            codexPath: '/path/that/should/not/run',
          },
        },
        monitor: {
          heartbeatIntervalMs: 50,
          idleTimeoutMs: 2_000,
          shouldAbort: () => true,
        },
      })

      expect(result.ok).toBe(false)
      expect(result.failureKind).toBe('remote_closed')
      expect(result.stderr).toContain('remote issue is already done')
      expect(result.usedAgent).toBe('claude')
      expect(result.usedFallback).toBe(false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
