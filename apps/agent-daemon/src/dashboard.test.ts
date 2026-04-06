import { describe, expect, test } from 'bun:test'
import type { AgentConfig } from '@agent/shared'
import {
  buildDashboardMachineCards,
  buildDashboardSummary,
  type DashboardIssueView,
  type DashboardLeaseView,
  type DashboardLocalMachineSnapshot,
  type DashboardPresenceView,
  type DashboardPullRequestView,
  startDashboardServer,
} from './dashboard'

function buildLease(overrides: Partial<DashboardLeaseView> = {}): DashboardLeaseView {
  return {
    scope: 'issue-process',
    targetNumber: 92,
    issueNumber: 92,
    prNumber: null,
    machineId: 'codex-20260403',
    daemonInstanceId: 'daemon-local-1',
    phase: 'implementation',
    status: 'active',
    attempt: 1,
    branch: 'agent/92/codex-20260403',
    worktreeId: 'issue-92-codex-20260403',
    heartbeatAgeSeconds: 8,
    progressAgeSeconds: 4,
    expiresInSeconds: 22,
    adoptable: false,
    commentId: 41,
    source: 'local',
    ...overrides,
  }
}

function buildLocalSnapshot(overrides: Partial<DashboardLocalMachineSnapshot> = {}): DashboardLocalMachineSnapshot {
  return {
    machineId: 'codex-20260403',
    daemonInstanceId: 'daemon-local-1',
    runtime: {
      runtimeKey: 'codex-20260403:9312',
      supervisor: 'launchd',
      alive: true,
      pid: 900,
      cwd: '/Users/wujames/codeRepo/数字员工',
      recordPath: '/tmp/runtime.json',
      logPath: '/tmp/runtime.log',
      startedAt: '2026-04-05T09:00:00.000Z',
      healthPort: 9312,
      metricsPort: 9092,
    },
    observability: {
      runtimeKey: 'codex-20260403:9312',
      ok: true,
      daemonInstanceId: 'daemon-local-1',
      status: 'running',
      pid: 900,
      uptimeMs: 120_000,
      concurrency: 2,
      effectiveActiveTasks: 1,
      activeWorktreeCount: 1,
      activeLeaseCount: 1,
      stalledWorkerCount: 0,
      blockedIssueResumeCount: 0,
      lastPollAt: '2026-04-05T09:10:00.000Z',
      nextPollAt: '2026-04-05T09:10:10.000Z',
      nextPollReason: 'normal',
      healthUrl: 'http://127.0.0.1:9312/health',
      metricsUrl: 'http://127.0.0.1:9092/metrics',
      warnings: ['local warning'],
    },
    activeLeases: [buildLease()],
    warnings: ['local warning'],
    ...overrides,
  }
}

function buildPresence(overrides: Partial<DashboardPresenceView> = {}): DashboardPresenceView {
  return {
    repo: 'JamesWuHK/digital-employee',
    machineId: 'machine-b',
    daemonInstanceId: 'daemon-remote-1',
    status: 'idle',
    startedAt: '2026-04-05T09:00:00.000Z',
    lastHeartbeatAt: '2026-04-05T09:10:00.000Z',
    expiresAt: '2026-04-05T09:11:00.000Z',
    heartbeatAgeSeconds: 5,
    expiresInSeconds: 55,
    healthPort: 9313,
    metricsPort: 9093,
    activeLeaseCount: 0,
    activeWorktreeCount: 0,
    effectiveActiveTasks: 0,
    source: 'github',
    ...overrides,
  }
}

function buildAgentConfig(): AgentConfig {
  return {
    machineId: 'codex-20260403',
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
    worktreesBase: '/tmp/agent-worktrees',
    project: {
      profile: 'generic',
      promptGuidance: {},
      maxConcurrency: undefined,
    },
    agent: {
      primary: 'codex',
      fallback: 'claude',
      claudePath: 'claude',
      codexPath: 'codex',
      timeoutMs: 30 * 60 * 1000,
    },
    git: {
      defaultBranch: 'main',
      authorName: 'agent-loop',
      authorEmail: 'agent-loop@local',
    },
  }
}

describe('dashboard machine aggregation', () => {
  test('merges local and GitHub machine state and prefers local lease detail', () => {
    const localSnapshots = [buildLocalSnapshot()]
    const remoteLeases = [
      buildLease({
        source: 'github',
        heartbeatAgeSeconds: 30,
        progressAgeSeconds: 15,
      }),
      buildLease({
        scope: 'pr-review',
        targetNumber: 226,
        issueNumber: 92,
        prNumber: 226,
        phase: 'review-auto-fix',
        branch: 'agent/92/codex-20260403',
        worktreeId: 'pr-review-226',
        commentId: 51,
        source: 'github',
      }),
      buildLease({
        targetNumber: 93,
        issueNumber: 93,
        machineId: 'machine-b',
        daemonInstanceId: 'daemon-remote-1',
        branch: 'agent/93/machine-b',
        worktreeId: 'issue-93-machine-b',
        source: 'github',
      }),
    ]

    const machines = buildDashboardMachineCards(localSnapshots, remoteLeases)

    expect(machines).toHaveLength(2)

    const localMachine = machines.find((machine) => machine.machineId === 'codex-20260403')
    expect(localMachine).toBeDefined()
    expect(localMachine?.source).toBe('mixed')
    expect(localMachine?.localRuntimes).toHaveLength(1)
    expect(localMachine?.daemonInstanceIds).toEqual(['daemon-local-1'])
    expect(localMachine?.warnings).toEqual(['local warning'])
    expect(localMachine?.activeLeases).toHaveLength(2)
    expect(localMachine?.activeLeases.find((lease) => lease.scope === 'issue-process')?.source).toBe('local')
    expect(localMachine?.activeLeases.find((lease) => lease.scope === 'issue-process')?.heartbeatAgeSeconds).toBe(8)

    const remoteMachine = machines.find((machine) => machine.machineId === 'machine-b')
    expect(remoteMachine?.source).toBe('github')
    expect(remoteMachine?.localRuntimes).toHaveLength(0)
    expect(remoteMachine?.activeLeases).toHaveLength(1)
  })

  test('builds dashboard summary without double-counting identical leases', () => {
    const machines = buildDashboardMachineCards(
      [buildLocalSnapshot()],
      [
        buildLease({ source: 'github' }),
        buildLease({
          scope: 'pr-review',
          targetNumber: 226,
          issueNumber: 92,
          prNumber: 226,
          source: 'github',
        }),
      ],
    )

    const issues: DashboardIssueView[] = [
      {
        number: 92,
        title: 'Working issue',
        url: 'https://github.com/JamesWuHK/digital-employee/issues/92',
        state: 'working',
        labels: ['agent:working'],
        assignee: 'bot',
        isClaimable: false,
        updatedAt: '2026-04-05T09:10:00.000Z',
        dependencyIssueNumbers: [],
        claimBlockedBy: [],
        hasExecutableContract: true,
        contractValidationErrors: [],
        linkedPrNumbers: [226],
        activeLease: buildLease(),
      },
      {
        number: 93,
        title: 'Ready issue',
        url: 'https://github.com/JamesWuHK/digital-employee/issues/93',
        state: 'ready',
        labels: ['agent:ready'],
        assignee: null,
        isClaimable: true,
        updatedAt: '2026-04-05T09:09:00.000Z',
        dependencyIssueNumbers: [92],
        claimBlockedBy: [],
        hasExecutableContract: true,
        contractValidationErrors: [],
        linkedPrNumbers: [],
        activeLease: null,
      },
      {
        number: 94,
        title: 'Failed issue',
        url: 'https://github.com/JamesWuHK/digital-employee/issues/94',
        state: 'failed',
        labels: ['agent:failed'],
        assignee: null,
        isClaimable: false,
        updatedAt: '2026-04-05T09:08:00.000Z',
        dependencyIssueNumbers: [],
        claimBlockedBy: [92],
        hasExecutableContract: false,
        contractValidationErrors: ['missing RED test'],
        linkedPrNumbers: [227],
        activeLease: null,
      },
    ]

    const prs: DashboardPullRequestView[] = [
      {
        number: 226,
        title: 'Fix issue 92',
        url: 'https://github.com/JamesWuHK/digital-employee/pull/226',
        headRefName: 'agent/92/codex-20260403',
        labels: ['agent:review-approved'],
        isDraft: false,
        linkedIssueNumber: 92,
        reviewLease: buildLease({
          scope: 'pr-review',
          targetNumber: 226,
          issueNumber: 92,
          prNumber: 226,
          source: 'github',
        }),
        mergeLease: null,
      },
    ]

    expect(buildDashboardSummary(machines, issues, prs)).toEqual({
      machineCount: 1,
      localRuntimeCount: 1,
      activeLeaseCount: 2,
      readyIssueCount: 1,
      workingIssueCount: 1,
      failedIssueCount: 1,
      openPrCount: 1,
    })
  })

  test('includes idle remote machines discovered from GitHub presence heartbeats', () => {
    const machines = buildDashboardMachineCards(
      [buildLocalSnapshot()],
      [],
      [buildPresence()],
    )

    expect(machines).toHaveLength(2)

    const remoteMachine = machines.find((machine) => machine.machineId === 'machine-b')
    expect(remoteMachine).toBeDefined()
    expect(remoteMachine?.source).toBe('github')
    expect(remoteMachine?.localRuntimes).toHaveLength(0)
    expect(remoteMachine?.activeLeases).toHaveLength(0)
    expect(remoteMachine?.presence?.status).toBe('idle')
    expect(remoteMachine?.daemonInstanceIds).toEqual(['daemon-remote-1'])
  })
})

describe('dashboard localization', () => {
  test('serves Chinese copy for the dashboard shell and client script', async () => {
    const server = startDashboardServer({
      config: buildAgentConfig(),
      host: '127.0.0.1',
      port: 0,
    })

    try {
      const baseUrl = `http://127.0.0.1:${server.port}`
      const [html, script] = await Promise.all([
        fetch(baseUrl + '/').then((response) => response.text()),
        fetch(baseUrl + '/app.js').then((response) => response.text()),
      ])

      expect(html).toContain('<title>Agent Loop 监控台</title>')
      expect(html).toContain('分布式开发监控台')
      expect(html).toContain('立即刷新')
      expect(html).toContain('机器状态')
      expect(html).toContain('问题队列')
      expect(html).toContain('日志')

      expect(script).toContain('仪表盘快照加载失败')
      expect(script).toContain('未发现本仓库的本地受管 daemon 运行时。')
      expect(script).toContain('机器数')
      expect(script).toContain('本地运行时')
      expect(script).toContain('可认领')
      expect(script).toContain('无本地运行时')
    } finally {
      server.stop(true)
    }
  })
})
