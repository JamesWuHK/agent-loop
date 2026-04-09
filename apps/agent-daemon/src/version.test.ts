import { afterEach, describe, expect, test } from 'bun:test'
import type { AgentConfig, AgentLoopBuildMetadata } from '@agent/shared'
import {
  abbreviateRevision,
  checkForAgentLoopUpgrade,
  compareAgentLoopVersions,
  createInitialAgentLoopUpgradeMetadata,
} from './version'

const TEST_CONFIG: AgentConfig = {
  machineId: 'machine-a',
  repo: 'JamesWuHK/digital-employee',
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
  worktreesBase: '/tmp/agent-loop-test',
  project: {
    profile: 'generic',
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
  upgrade: {
    enabled: true,
    repo: 'JamesWuHK/agent-loop',
    channel: 'master',
    checkIntervalMs: 60_000,
    reminderIntervalMs: 3_600_000,
  },
}

const LOCAL_BUILD: AgentLoopBuildMetadata = {
  repo: 'JamesWuHK/agent-loop',
  version: '0.1.0',
  revision: '1111111111111111111111111111111111111111',
}

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('compareAgentLoopVersions', () => {
  test('compares semantic version segments numerically', () => {
    expect(compareAgentLoopVersions('0.1.9', '0.1.10')).toBe(-1)
    expect(compareAgentLoopVersions('0.2.0', '0.1.99')).toBe(1)
    expect(compareAgentLoopVersions('0.1.0', '0.1.0')).toBe(0)
  })
})

describe('abbreviateRevision', () => {
  test('shortens git revisions for display', () => {
    expect(abbreviateRevision('abcdef1234567890')).toBe('abcdef1')
    expect(abbreviateRevision(null)).toBe('unknown')
  })
})

describe('createInitialAgentLoopUpgradeMetadata', () => {
  test('marks disabled upgrade checks explicitly', () => {
    const metadata = createInitialAgentLoopUpgradeMetadata({
      ...TEST_CONFIG,
      upgrade: {
        ...TEST_CONFIG.upgrade!,
        enabled: false,
      },
    }, LOCAL_BUILD, true)

    expect(metadata.status).toBe('disabled')
    expect(metadata.safeToUpgradeNow).toBe(true)
  })
})

describe('checkForAgentLoopUpgrade', () => {
  test('flags same-version newer revisions as upgrade-available', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/branches/master')) {
        return new Response(JSON.stringify({
          name: 'master',
          commit: {
            sha: '2222222222222222222222222222222222222222',
            commit: {
              committer: {
                date: '2026-04-09T04:00:00Z',
              },
            },
          },
        }), { status: 200 })
      }

      if (url.includes('/contents/package.json')) {
        return new Response(JSON.stringify({
          encoding: 'base64',
          content: Buffer.from(JSON.stringify({ version: '0.1.0' })).toString('base64'),
        }), { status: 200 })
      }

      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const metadata = await checkForAgentLoopUpgrade(TEST_CONFIG, LOCAL_BUILD, false)

    expect(metadata.status).toBe('upgrade-available')
    expect(metadata.latestVersion).toBe('0.1.0')
    expect(metadata.latestRevision).toBe('2222222222222222222222222222222222222222')
    expect(metadata.safeToUpgradeNow).toBe(false)
  })

  test('reports up-to-date when version and revision match', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      name: 'master',
      commit: {
        sha: LOCAL_BUILD.revision,
        commit: {
          committer: {
            date: '2026-04-09T04:00:00Z',
          },
        },
      },
      encoding: 'base64',
      content: Buffer.from(JSON.stringify({ version: LOCAL_BUILD.version })).toString('base64'),
    }), { status: 200 })) as unknown as typeof fetch

    const metadata = await checkForAgentLoopUpgrade(TEST_CONFIG, LOCAL_BUILD, true)

    expect(metadata.status).toBe('up-to-date')
    expect(metadata.safeToUpgradeNow).toBe(true)
  })
})
