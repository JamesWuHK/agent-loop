import { describe, expect, test } from 'bun:test'
import {
  buildDashboardMachineCards,
  buildDashboardSummary,
  type DashboardIssueView,
  type DashboardLeaseView,
  type DashboardLocalMachineSnapshot,
  type DashboardPresenceView,
  type DashboardPullRequestView,
  renderDashboardAppScript,
  renderDashboardHtml,
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
    agentLoopVersion: '0.1.0',
    agentLoopRevision: 'abcdef1234567890',
    upgradeStatus: 'up-to-date',
    upgradeAutoApplyEnabled: true,
    safeToUpgradeNow: true,
    latestVersion: '0.1.0',
    latestRevision: 'abcdef1234567890',
    upgradeCheckedAt: '2026-04-05T09:10:00.000Z',
    upgradeMessage: 'local and latest versions match',
    autoUpgrade: {
      attemptCount: 1,
      successCount: 1,
      failureCount: 0,
      noChangeCount: 0,
      lastAttemptAt: '2026-04-05T09:09:10.000Z',
      lastSuccessAt: '2026-04-05T09:09:12.000Z',
      lastOutcome: 'succeeded',
      lastTargetVersion: '0.1.0',
      lastTargetRevision: 'abcdef1234567890',
      lastError: null,
    },
    source: 'github',
    ...overrides,
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
        blockerAttempt: null,
        blockerReason: null,
        blockerFindingSummary: null,
        blockerUpdatedAt: null,
        blockerResumable: false,
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
      managedPresenceCount: 0,
      activeLeaseCount: 2,
      readyIssueCount: 1,
      workingIssueCount: 1,
      failedIssueCount: 1,
      openPrCount: 1,
      upgradePendingMachineCount: 0,
      upgradeReadyMachineCount: 0,
      upgradeBlockedMachineCount: 0,
      upgradeManualMachineCount: 0,
      upgradeErrorMachineCount: 0,
      upgradeFailedMachineCount: 0,
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

  test('summarizes upgrade rollout state from managed machine presence', () => {
    const machines = buildDashboardMachineCards(
      [buildLocalSnapshot()],
      [],
      [
        buildPresence({
          machineId: 'machine-ready',
          daemonInstanceId: 'daemon-ready',
          upgradeStatus: 'upgrade-available',
          safeToUpgradeNow: true,
          latestVersion: '0.1.2',
        }),
        buildPresence({
          machineId: 'machine-busy',
          daemonInstanceId: 'daemon-busy',
          status: 'busy',
          effectiveActiveTasks: 2,
          activeLeaseCount: 1,
          activeWorktreeCount: 1,
          upgradeStatus: 'upgrade-available',
          safeToUpgradeNow: false,
          latestVersion: '0.1.2',
          autoUpgrade: {
            attemptCount: 2,
            successCount: 0,
            failureCount: 1,
            noChangeCount: 1,
            lastAttemptAt: '2026-04-05T09:10:20.000Z',
            lastSuccessAt: null,
            lastOutcome: 'failed',
            lastTargetVersion: '0.1.2',
            lastTargetRevision: 'fedcba9876543210',
            lastError: 'git pull failed',
          },
        }),
        buildPresence({
          machineId: 'machine-manual',
          daemonInstanceId: 'daemon-manual',
          upgradeStatus: 'upgrade-available',
          upgradeAutoApplyEnabled: false,
          safeToUpgradeNow: true,
          latestVersion: '0.1.2',
          upgradeMessage: 'auto-apply disabled on this machine',
        }),
        buildPresence({
          machineId: 'machine-error',
          daemonInstanceId: 'daemon-error',
          upgradeStatus: 'error',
          safeToUpgradeNow: false,
          latestVersion: null,
          upgradeMessage: 'agent-loop upgrade repo could not be resolved',
        }),
      ],
    )

    expect(buildDashboardSummary(machines, [], [])).toEqual({
      machineCount: 5,
      localRuntimeCount: 1,
      managedPresenceCount: 4,
      activeLeaseCount: 1,
      readyIssueCount: 0,
      workingIssueCount: 0,
      failedIssueCount: 0,
      openPrCount: 0,
      upgradePendingMachineCount: 3,
      upgradeReadyMachineCount: 1,
      upgradeBlockedMachineCount: 1,
      upgradeManualMachineCount: 1,
      upgradeErrorMachineCount: 1,
      upgradeFailedMachineCount: 1,
    })

    expect(machines.find((machine) => machine.machineId === 'machine-ready')?.warnings).toContain(
      'agent-loop upgrade available on machine-ready; this machine is idle enough to upgrade now',
    )
    expect(machines.find((machine) => machine.machineId === 'machine-busy')?.warnings).toContain(
      'agent-loop upgrade available on machine-busy; wait for the machine to go idle before restarting',
    )
    expect(machines.find((machine) => machine.machineId === 'machine-busy')?.warnings).toContain(
      'automatic agent-loop upgrade last failed on machine-busy: git pull failed',
    )
    expect(machines.find((machine) => machine.machineId === 'machine-manual')?.warnings).toContain(
      'agent-loop upgrade available on machine-manual, but auto-apply is disabled on this machine; manual restart is required',
    )
    expect(machines.find((machine) => machine.machineId === 'machine-error')?.warnings).toContain(
      'agent-loop upgrade check is failing on machine-error: agent-loop upgrade repo could not be resolved; inspect this daemon before relying on auto-upgrade',
    )
  })
})

describe('dashboard localization', () => {
  test('serves Chinese copy for the dashboard shell and client script', () => {
    const html = renderDashboardHtml()
    const script = renderDashboardAppScript()

    expect(html).toContain('<title>Agent Loop 监控台</title>')
    expect(html).toContain('分布式开发监控台')
    expect(html).toContain('立即刷新')
    expect(html).toContain('机器状态')
    expect(html).toContain('问题队列')
    expect(html).toContain('日志')

    expect(script).toContain('仪表盘快照加载失败')
    expect(script).toContain('未发现本仓库的本地受管 daemon 运行时。')
    expect(script).toContain('机器数')
    expect(script).toContain('待升级机器')
    expect(script).toContain('可立刻升级')
    expect(script).toContain('升级执行失败')
    expect(script).toContain('手动升级机器')
    expect(script).toContain('本地运行时')
    expect(script).toContain('可认领')
    expect(script).toContain('阻塞原因')
    expect(script).toContain('无本地运行时')
  })
})
