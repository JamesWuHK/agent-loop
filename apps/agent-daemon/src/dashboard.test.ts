import { describe, expect, test } from 'bun:test'
import {
  buildDashboardIssueOpsSummary,
  buildDashboardMachineCards,
  buildDashboardUpgradeEvents,
  buildDashboardUpgradeRollout,
  buildDashboardSummary,
  buildDashboardUpgradeFailureAlertMessages,
  buildDashboardUpgradeSuccessNoteMessages,
  type DashboardIssueView,
  type DashboardLeaseView,
  type DashboardLocalMachineSnapshot,
  type DashboardPresenceView,
  type DashboardPullRequestView,
  renderDashboardAppScript,
  renderDashboardHtml,
} from './dashboard'
import type {
  ManagedDaemonUpgradeAnnouncementComment,
  ManagedDaemonUpgradeFailureAlertComment,
  ManagedDaemonUpgradeSuccessComment,
} from './presence'

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
      consecutiveFailureCount: 0,
      lastAttemptAt: '2026-04-05T09:09:10.000Z',
      lastSuccessAt: '2026-04-05T09:09:12.000Z',
      lastOutcome: 'succeeded',
      lastTargetVersion: '0.1.0',
      lastTargetRevision: 'abcdef1234567890',
      lastError: null,
      pausedUntil: null,
    },
    source: 'github',
    ...overrides,
  }
}

describe('dashboard machine aggregation', () => {
  test('derives dashboard issue ops summary counts from issue quality data', () => {
    const summary = buildDashboardIssueOpsSummary([
      {
        state: 'ready',
        readyGateBlocked: true,
        qualityScore: 40,
        warningCount: 0,
      },
      {
        state: 'ready',
        readyGateBlocked: false,
        qualityScore: 75,
        warningCount: 1,
      },
    ])

    expect(summary).toEqual({
      invalidReadyIssueCount: 1,
      lowScoreIssueCount: 2,
      warningIssueCount: 1,
    })
  })

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
        readyGateBlocked: false,
        qualityScore: 100,
        warningCount: 0,
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
        readyGateBlocked: false,
        qualityScore: 90,
        warningCount: 0,
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
        readyGateBlocked: true,
        qualityScore: 40,
        warningCount: 1,
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
      invalidReadyIssueCount: 0,
      lowScoreIssueCount: 1,
      warningIssueCount: 1,
      openPrCount: 1,
      upgradePendingMachineCount: 0,
      upgradeCurrentMachineCount: 0,
      upgradeReadyMachineCount: 0,
      upgradeBlockedMachineCount: 0,
      upgradeManualMachineCount: 0,
      upgradeAheadMachineCount: 0,
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
          latestRevision: 'fedcba9876543210',
          autoUpgrade: {
            attemptCount: 2,
            successCount: 0,
            failureCount: 1,
            noChangeCount: 1,
            consecutiveFailureCount: 1,
            lastAttemptAt: '2026-04-05T09:10:20.000Z',
            lastSuccessAt: null,
            lastOutcome: 'failed',
            lastTargetVersion: '0.1.2',
            lastTargetRevision: 'fedcba9876543210',
            lastError: 'git pull failed',
            pausedUntil: '2026-04-05T09:25:20.000Z',
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
      invalidReadyIssueCount: 0,
      lowScoreIssueCount: 0,
      warningIssueCount: 0,
      openPrCount: 0,
      upgradePendingMachineCount: 3,
      upgradeCurrentMachineCount: 0,
      upgradeReadyMachineCount: 1,
      upgradeBlockedMachineCount: 1,
      upgradeManualMachineCount: 1,
      upgradeAheadMachineCount: 0,
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
      'automatic agent-loop upgrades paused on machine-busy until 2026-04-05T09:25:20.000Z after 1 consecutive failure(s): git pull failed',
    )
    expect(machines.find((machine) => machine.machineId === 'machine-manual')?.warnings).toContain(
      'agent-loop upgrade available on machine-manual, but auto-apply is disabled on this machine; manual restart is required',
    )
    expect(machines.find((machine) => machine.machineId === 'machine-error')?.warnings).toContain(
      'agent-loop upgrade check is failing on machine-error: agent-loop upgrade repo could not be resolved; inspect this daemon before relying on auto-upgrade',
    )
  })

  test('counts machines already upgraded or ahead of the tracked channel', () => {
    const machines = buildDashboardMachineCards(
      [],
      [],
      [
        buildPresence({
          machineId: 'machine-current',
          daemonInstanceId: 'daemon-current',
          upgradeStatus: 'up-to-date',
          latestVersion: '0.1.2',
          latestRevision: '2222222222222222222222222222222222222222',
        }),
        buildPresence({
          machineId: 'machine-ahead',
          daemonInstanceId: 'daemon-ahead',
          upgradeStatus: 'ahead-of-channel',
          latestVersion: '0.1.2',
          latestRevision: '2222222222222222222222222222222222222222',
        }),
      ],
    )

    expect(buildDashboardSummary(machines, [], [])).toEqual({
      machineCount: 2,
      localRuntimeCount: 0,
      managedPresenceCount: 2,
      activeLeaseCount: 0,
      readyIssueCount: 0,
      workingIssueCount: 0,
      failedIssueCount: 0,
      invalidReadyIssueCount: 0,
      lowScoreIssueCount: 0,
      warningIssueCount: 0,
      openPrCount: 0,
      upgradePendingMachineCount: 0,
      upgradeCurrentMachineCount: 1,
      upgradeReadyMachineCount: 0,
      upgradeBlockedMachineCount: 0,
      upgradeManualMachineCount: 0,
      upgradeAheadMachineCount: 1,
      upgradeErrorMachineCount: 0,
      upgradeFailedMachineCount: 0,
    })

    expect(machines.find((machine) => machine.machineId === 'machine-ahead')?.warnings).toContain(
      'agent-loop build on machine-ahead is ahead of the tracked channel; verify this machine is pinned intentionally',
    )
  })

  test('formats active GitHub upgrade failure alerts confirmed by current presence state', () => {
    const alerts: ManagedDaemonUpgradeFailureAlertComment[] = [
      {
        commentId: 501,
        body: 'ignored',
        createdAt: '2026-04-05T09:10:21.000Z',
        updatedAt: '2026-04-05T09:10:21.000Z',
        alert: {
          repo: 'JamesWuHK/digital-employee',
          machineId: 'machine-busy',
          daemonInstanceId: 'daemon-busy',
          channel: 'master',
          targetVersion: '0.1.2',
          targetRevision: 'fedcba9876543210',
          consecutiveFailureCount: 2,
          pausedUntil: '2026-04-05T09:25:20.000Z',
          lastAttemptAt: '2026-04-05T09:10:20.000Z',
          lastError: 'git pull failed',
          alertedAt: '2026-04-05T09:10:21.000Z',
        },
      },
    ]

    const messages = buildDashboardUpgradeFailureAlertMessages(
      alerts,
      [
        buildPresence({
          machineId: 'machine-busy',
          daemonInstanceId: 'daemon-busy',
          latestVersion: '0.1.2',
          latestRevision: 'fedcba9876543210',
          autoUpgrade: {
            attemptCount: 2,
            successCount: 0,
            failureCount: 2,
            noChangeCount: 0,
            consecutiveFailureCount: 2,
            lastAttemptAt: '2026-04-05T09:10:20.000Z',
            lastSuccessAt: null,
            lastOutcome: 'failed',
            lastTargetVersion: '0.1.2',
            lastTargetRevision: 'fedcba9876543210',
            lastError: 'git pull failed',
            pausedUntil: '2026-04-05T09:25:20.000Z',
          },
        }),
      ],
      Date.parse('2026-04-05T09:11:00.000Z'),
    )

    expect(messages).toEqual([
      'GitHub 升级告警：machine-busy 自动升级连续失败 2 次，暂停到 2026-04-05T09:25:20.000Z，最近错误：git pull failed',
    ])
  })

  test('formats recent GitHub upgrade success notes confirmed by current presence state', () => {
    const successes: ManagedDaemonUpgradeSuccessComment[] = [
      {
        commentId: 601,
        body: 'ignored',
        createdAt: '2026-04-05T09:12:21.000Z',
        updatedAt: '2026-04-05T09:12:21.000Z',
        success: {
          repo: 'JamesWuHK/digital-employee',
          machineId: 'machine-ready',
          daemonInstanceId: 'daemon-ready-upgraded',
          channel: 'master',
          targetVersion: '0.1.2',
          targetRevision: 'fedcba9876543210',
          succeededAt: '2026-04-05T09:12:20.000Z',
          acknowledgedAt: '2026-04-05T09:12:21.000Z',
        },
      },
    ]

    const messages = buildDashboardUpgradeSuccessNoteMessages(
      successes,
      [
        buildPresence({
          machineId: 'machine-ready',
          daemonInstanceId: 'daemon-ready-upgraded',
          upgradeStatus: 'up-to-date',
          latestVersion: '0.1.2',
          latestRevision: 'fedcba9876543210',
          autoUpgrade: {
            attemptCount: 2,
            successCount: 1,
            failureCount: 1,
            noChangeCount: 0,
            consecutiveFailureCount: 0,
            lastAttemptAt: '2026-04-05T09:12:10.000Z',
            lastSuccessAt: '2026-04-05T09:12:20.000Z',
            lastOutcome: 'succeeded',
            lastTargetVersion: '0.1.2',
            lastTargetRevision: 'fedcba9876543210',
            lastError: null,
            pausedUntil: null,
          },
        }),
      ],
      Date.parse('2026-04-05T09:13:00.000Z'),
    )

    expect(messages).toEqual([
      'GitHub 升级完成：machine-ready 已切换到 v0.1.2@fedcba9876543210 并恢复在线',
    ])
  })

  test('builds a recent upgrade event timeline sorted by newest first', () => {
    const announcements: ManagedDaemonUpgradeAnnouncementComment[] = [
      {
        commentId: 701,
        body: 'ignored',
        createdAt: '2026-04-05T09:10:21.000Z',
        updatedAt: '2026-04-05T09:10:21.000Z',
        announcement: {
          repo: 'JamesWuHK/digital-employee',
          channel: 'master',
          latestVersion: '0.1.2',
          latestRevision: 'fedcba9876543210',
          latestCommitAt: '2026-04-05T09:10:20.000Z',
          announcedAt: '2026-04-05T09:10:21.000Z',
          announcedByMachineId: 'machine-discoverer',
          announcedByDaemonInstanceId: 'daemon-discoverer',
        },
      },
    ]
    const failures: ManagedDaemonUpgradeFailureAlertComment[] = [
      {
        commentId: 702,
        body: 'ignored',
        createdAt: '2026-04-05T09:11:21.000Z',
        updatedAt: '2026-04-05T09:11:21.000Z',
        alert: {
          repo: 'JamesWuHK/digital-employee',
          machineId: 'machine-busy',
          daemonInstanceId: 'daemon-busy',
          channel: 'master',
          targetVersion: '0.1.2',
          targetRevision: 'fedcba9876543210',
          consecutiveFailureCount: 2,
          pausedUntil: '2026-04-05T09:25:20.000Z',
          lastAttemptAt: '2026-04-05T09:11:20.000Z',
          lastError: 'git pull failed',
          alertedAt: '2026-04-05T09:11:21.000Z',
        },
      },
    ]
    const successes: ManagedDaemonUpgradeSuccessComment[] = [
      {
        commentId: 703,
        body: 'ignored',
        createdAt: '2026-04-05T09:12:21.000Z',
        updatedAt: '2026-04-05T09:12:21.000Z',
        success: {
          repo: 'JamesWuHK/digital-employee',
          machineId: 'machine-ready',
          daemonInstanceId: 'daemon-ready',
          channel: 'master',
          targetVersion: '0.1.2',
          targetRevision: 'fedcba9876543210',
          succeededAt: '2026-04-05T09:12:20.000Z',
          acknowledgedAt: '2026-04-05T09:12:21.000Z',
        },
      },
    ]

    const events = buildDashboardUpgradeEvents(announcements, failures, successes)

    expect(events).toHaveLength(3)
    expect(events.map((event) => event.kind)).toEqual(['success', 'failure', 'announcement'])
    expect(events[0]).toMatchObject({
      kind: 'success',
      title: 'machine-ready 已升级并恢复在线',
      tone: 'accent',
    })
    expect(events[1]).toMatchObject({
      kind: 'failure',
      title: 'machine-busy 自动升级失败并进入退避',
      tone: 'error',
    })
    expect(events[2]).toMatchObject({
      kind: 'announcement',
      title: 'machine-discoverer 广播了 agent-loop 升级',
      tone: 'gold',
    })
  })

  test('builds the current rollout progress view from the latest announcement and machine state', () => {
    const machines = buildDashboardMachineCards(
      [],
      [],
      [
        buildPresence({
          machineId: 'machine-current',
          daemonInstanceId: 'daemon-current',
          upgradeStatus: 'up-to-date',
          latestVersion: '0.1.2',
          latestRevision: 'fedcba9876543210',
        }),
        buildPresence({
          machineId: 'machine-ready',
          daemonInstanceId: 'daemon-ready',
          upgradeStatus: 'upgrade-available',
          safeToUpgradeNow: true,
          latestVersion: '0.1.2',
          latestRevision: 'fedcba9876543210',
        }),
        buildPresence({
          machineId: 'machine-busy',
          daemonInstanceId: 'daemon-busy',
          upgradeStatus: 'upgrade-available',
          safeToUpgradeNow: false,
          latestVersion: '0.1.2',
          latestRevision: 'fedcba9876543210',
          autoUpgrade: {
            attemptCount: 2,
            successCount: 0,
            failureCount: 2,
            noChangeCount: 0,
            consecutiveFailureCount: 2,
            lastAttemptAt: '2026-04-05T09:11:20.000Z',
            lastSuccessAt: null,
            lastOutcome: 'failed',
            lastTargetVersion: '0.1.2',
            lastTargetRevision: 'fedcba9876543210',
            lastError: 'git pull failed',
            pausedUntil: '2026-04-05T09:25:20.000Z',
          },
        }),
        buildPresence({
          machineId: 'machine-manual',
          daemonInstanceId: 'daemon-manual',
          upgradeStatus: 'upgrade-available',
          upgradeAutoApplyEnabled: false,
          latestVersion: '0.1.2',
          latestRevision: 'fedcba9876543210',
        }),
        buildPresence({
          machineId: 'machine-ahead',
          daemonInstanceId: 'daemon-ahead',
          upgradeStatus: 'ahead-of-channel',
          latestVersion: '0.1.2',
          latestRevision: 'fedcba9876543210',
        }),
        buildPresence({
          machineId: 'machine-error',
          daemonInstanceId: 'daemon-error',
          upgradeStatus: 'error',
          latestVersion: null,
          latestRevision: null,
        }),
      ],
    )

    const rollout = buildDashboardUpgradeRollout({
      commentId: 800,
      body: 'ignored',
      createdAt: '2026-04-05T09:10:21.000Z',
      updatedAt: '2026-04-05T09:10:21.000Z',
      announcement: {
        repo: 'JamesWuHK/digital-employee',
        channel: 'master',
        latestVersion: '0.1.2',
        latestRevision: 'fedcba9876543210',
        latestCommitAt: '2026-04-05T09:10:20.000Z',
        announcedAt: '2026-04-05T09:10:21.000Z',
        announcedByMachineId: 'machine-discoverer',
        announcedByDaemonInstanceId: 'daemon-discoverer',
      },
    }, machines)

    expect(rollout).toEqual({
      channel: 'master',
      targetVersion: '0.1.2',
      targetRevision: 'fedcba9876543210',
      announcedAt: '2026-04-05T09:10:21.000Z',
      announcedByMachineId: 'machine-discoverer',
      announcedByDaemonInstanceId: 'daemon-discoverer',
      totalMachineCount: 6,
      completedMachineCount: 1,
      aheadMachineCount: 1,
      pendingMachineCount: 3,
      readyMachineCount: 1,
      blockedMachineCount: 1,
      manualMachineCount: 1,
      failedMachineCount: 1,
      errorMachineCount: 1,
      progressPercent: 33,
    })
  })
})

describe('dashboard localization', () => {
  test('serves Chinese copy for the dashboard shell and client script', () => {
    const html = renderDashboardHtml()
    const script = renderDashboardAppScript()

    expect(html).toContain('<title>Agent Loop 监控台</title>')
    expect(html).toContain('分布式开发监控台')
    expect(html).toContain('立即刷新')
    expect(html).toContain('当前升级波次进度')
    expect(html).toContain('升级事件')
    expect(html).toContain('升级事件')
    expect(html).toContain('最近这波 rollout 发生了什么')
    expect(html).toContain('机器状态')
    expect(html).toContain('问题队列')
    expect(html).toContain('日志')

    expect(script).toContain('仪表盘快照加载失败')
    expect(script).toContain('未发现本仓库的本地受管 daemon 运行时。')
    expect(script).toContain('最近未发现共享升级广播')
    expect(script).toContain('已完成')
    expect(script).toContain('升级被阻塞')
    expect(script).toContain('最近没有记录到升级事件。')
    expect(script).toContain('升级广播')
    expect(script).toContain('升级成功')
    expect(script).toContain('升级失败')
    expect(script).toContain('机器数')
    expect(script).toContain('待升级机器')
    expect(script).toContain('已升级最新')
    expect(script).toContain('可立刻升级')
    expect(script).toContain('超前 Channel')
    expect(script).toContain('升级执行失败')
    expect(script).toContain('手动升级机器')
    expect(script).toContain('已是最新')
    expect(script).toContain('可升级')
    expect(script).toContain('本地运行时')
    expect(script).toContain('可认领')
    expect(script).toContain('阻塞原因')
    expect(script).toContain('无本地运行时')
  })
})
