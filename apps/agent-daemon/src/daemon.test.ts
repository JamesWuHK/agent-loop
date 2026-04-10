import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentConfig, ManagedLeaseComment } from '@agent/shared'
import {
  AgentDaemon,
  WAKE_PATH,
  buildIssueWorkingTransitionEvent,
  buildBlockedIssueResumeEscalationComment,
  buildIssueResumeResolutionComment,
  buildDaemonRuntimeStatus,
  buildIssuePreflightFailureComment,
  buildPrReviewRefreshFailureComment,
  canResumeBlockedIssueFromResolution,
  canRetryPrReviewRefresh,
  canResumeIssueFromLease,
  getEffectiveActiveTaskCount,
  buildPrMergeRetryComment,
  createWorktreeFromRemoteBranch,
  extractAutomatedIssuePreflightReasons,
  extractBlockedIssueResumeEscalationComment,
  extractIssueResumeResolutionComment,
  getResumableIssueLinkedPrHandoff,
  getFailedIssueResumeBlock,
  isMissingRemoteBranchRecoveryReason,
  listBlockedIssueResumeEscalationComments,
  shouldReserveIssueCapacityForStandalonePrTask,
  shouldDeferStandalonePrTaskForActiveIssueProcess,
  shouldDeferStandalonePrTaskForActiveIssueLease,
  shouldDeferResumableIssueForActiveLinkedPrTask,
  shouldDeferResumableIssueForActiveLinkedPrLease,
  shouldClearFailedIssueResumeTrackingAfterFinalize,
  shouldEscalateBlockedIssueResume,
  shouldRefreshBlockedHumanNeededPr,
  shouldResumeFailedIssueWithLinkedPr,
  getStandaloneIssueTransitionForReviewLabels,
  isRetryableDaemonLoopError,
  isMergeabilityFailure,
  refreshResumableIssueBranchOntoDefault,
  rebaseManagedBranchOntoDefault,
  shouldApplyStandaloneIssueTransition,
  shouldResetLinkedPrToRetryOnIssueResume,
  shouldCompleteIssueRecoveryOnRemoteClose,
  shouldRequeueFailedIssue,
  shouldResumeManagedIssue,
} from './daemon'
import { ISSUE_LABELS, PR_REVIEW_LABELS } from '@agent/shared'
import { buildManagedDaemonUpgradeAnnouncementComment } from './presence'
import { appendWakeRequest, buildWakeQueuePath } from './wake-queue'

function createTestDaemon(
  configOverrides: Partial<AgentConfig> = {},
  healthServerConfig?: {
    host?: string
    port?: number
  },
): AgentDaemon {
  const config: AgentConfig = {
    machineId: 'codex-dev',
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
    worktreesBase: '/tmp/worktrees',
    project: {
      profile: 'desktop-vite',
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
    ...configOverrides,
  }

  return new AgentDaemon(config, console, healthServerConfig)
}

async function createResumableIssueWorktreeFixture(issueNumber = 329, machineId = 'codex-20260403') {
  const tempDir = mkdtempSync(join(tmpdir(), 'daemon-resumable-issue-worktree-'))
  const repoDir = join(tempDir, 'repo')
  const worktreesBase = join(tempDir, 'worktrees')
  const worktreePath = join(worktreesBase, `issue-${issueNumber}-${machineId}`)
  const branch = `agent/${issueNumber}/${machineId}`

  mkdirSync(repoDir, { recursive: true })
  mkdirSync(worktreesBase, { recursive: true })

  await Bun.$`git -C ${repoDir} init -b main`.quiet()
  await Bun.$`git -C ${repoDir} config user.name test`.quiet()
  await Bun.$`git -C ${repoDir} config user.email test@example.com`.quiet()

  writeFileSync(join(repoDir, 'README.md'), 'base\n', 'utf-8')
  await Bun.$`git -C ${repoDir} add README.md`.quiet()
  await Bun.$`git -C ${repoDir} commit -m "base"`.quiet()
  await Bun.$`git -C ${repoDir} worktree add ${worktreePath} -b ${branch}`.quiet()

  return {
    tempDir,
    repoDir,
    worktreesBase,
    worktreePath,
    branch,
  }
}

function createHistoricalLeaseComment(issueNumber: number, branch: string, worktreeId: string): ManagedLeaseComment {
  return {
    commentId: 1,
    body: '',
    createdAt: '2026-04-08T17:37:08.000Z',
    updatedAt: '2026-04-08T17:37:08.000Z',
    lease: {
      leaseId: 'lease-1',
      scope: 'issue-process',
      issueNumber,
      machineId: 'codex-dev',
      daemonInstanceId: 'daemon-old',
      branch,
      worktreeId,
      phase: 'issue-recovery',
      startedAt: '2026-04-08T17:37:07.000Z',
      lastHeartbeatAt: '2026-04-08T17:37:07.000Z',
      expiresAt: '2026-04-08T17:38:07.000Z',
      attempt: 10,
      lastProgressAt: '2026-04-08T17:37:07.000Z',
      status: 'completed',
    },
  }
}

describe('issue preflight comments', () => {
  test('extracts the latest automated preflight blocker from issue comments', () => {
    const older = buildIssuePreflightFailureComment(
      104,
      'Issue preflight failed before PR creation: validation failed: bun test',
      ['validation failed: bun test'],
    )
    const newer = buildIssuePreflightFailureComment(
      104,
      'Issue preflight failed before PR creation: changed forbidden files: apps/desktop/src/App.tsx',
      ['changed forbidden files: apps/desktop/src/App.tsx'],
    )

    expect(extractAutomatedIssuePreflightReasons([
      { body: older },
      { body: 'plain comment' },
      { body: newer },
    ])).toEqual([
      'Issue preflight failed before PR creation: changed forbidden files: apps/desktop/src/App.tsx',
    ])
  })
})

describe('wake queue integration', () => {
  test('drains queued wake requests and forces the next reconcile immediately', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'agent-loop-daemon-wake-'))
    const queuePath = buildWakeQueuePath({
      homeDir,
      repo: 'JamesWuHK/agent-loop',
      machineId: 'codex-dev',
    })

    appendWakeRequest(queuePath, {
      kind: 'now',
      reason: 'workflow_dispatch',
      sourceEvent: 'workflow_dispatch',
      dedupeKey: 'wake-now',
      requestedAt: '2026-04-11T09:10:00.000Z',
    })

    const daemon = createTestDaemon({
      repo: 'JamesWuHK/agent-loop',
      machineId: 'codex-dev',
      worktreesBase: join(homeDir, 'worktrees'),
    })

    await daemon.drainWakeQueueOnce()

    const status = daemon.getStatus()
    expect(status.nextPollReason).toBe('wake-request')
    expect(status.nextPollDelayMs).toBe(0)
    expect(existsSync(queuePath)).toBe(false)
  })

  test('loopback wake endpoint forces the next reconcile immediately', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'agent-loop-daemon-wake-endpoint-'))
    const daemon = createTestDaemon({
      repo: 'JamesWuHK/agent-loop',
      machineId: 'codex-dev',
      worktreesBase: join(homeDir, 'worktrees'),
    }, {
      port: 0,
    })
    const daemonInternal = daemon as unknown as {
      running: boolean
      pollTimeoutId: ReturnType<typeof setTimeout> | null
      healthServer: { port: number } | null
      startHealthServer: () => void
      scheduleNextPoll: (options?: {
        delayMs?: number
        reason?: string
      }) => void
    }

    daemonInternal.running = true
    daemonInternal.pollTimeoutId = setTimeout(() => undefined, 60_000)
    daemonInternal.scheduleNextPoll = () => undefined
    daemonInternal.startHealthServer()

    const response = await fetch(`http://127.0.0.1:${daemonInternal.healthServer!.port}${WAKE_PATH}`, {
      method: 'POST',
    })

    expect(response.status).toBe(202)
    expect(daemon.getStatus().nextPollReason).toBe('wake-request')
    expect(daemon.getStatus().nextPollDelayMs).toBe(0)

    await daemon.stop()
  })
})

describe('agent-loop upgrade coordination', () => {
  test('refreshes upgrade status and wakes the scheduler when a newer remote upgrade announcement appears', async () => {
    const daemon = createTestDaemon({
      upgrade: {
        enabled: true,
        repo: 'JamesWuHK/agent-loop',
        channel: 'master',
        checkIntervalMs: 60_000,
        reminderIntervalMs: 3_600_000,
        autoApply: false,
      },
    })

    let refreshes = 0
    let immediateReason: string | null = null

    ;(daemon as any).ensurePresenceIssueNumber = async () => 500
    ;(daemon as any).listPresenceRegistryComments = async () => [{
      commentId: 11,
      body: buildManagedDaemonUpgradeAnnouncementComment({
        repo: 'JamesWuHK/digital-employee',
        channel: 'master',
        latestVersion: '0.1.2',
        latestRevision: '2222222222222222222222222222222222222222',
        latestCommitAt: '2026-04-11T09:10:00.000Z',
        announcedAt: '2026-04-11T09:10:10.000Z',
        announcedByMachineId: 'machine-b',
        announcedByDaemonInstanceId: 'daemon-b',
      }),
      createdAt: '2026-04-11T09:10:10.000Z',
      updatedAt: '2026-04-11T09:10:10.000Z',
    }]
    ;(daemon as any).maybeRefreshAgentLoopUpgradeStatus = async (force: boolean) => {
      refreshes += force ? 1 : 0
    }
    ;(daemon as any).requestImmediateReconcile = (reason: string) => {
      immediateReason = reason
    }

    await (daemon as any).maybeProcessRemoteUpgradeAnnouncement()
    await (daemon as any).maybeProcessRemoteUpgradeAnnouncement()

    expect(refreshes).toBe(1)
    expect(immediateReason as string | null).toBe('agent-loop-upgrade')
  })

  test('attempts automatic self-upgrade after an idle no-issues poll when enabled', async () => {
    const daemon = createTestDaemon({
      upgrade: {
        enabled: true,
        repo: 'JamesWuHK/agent-loop',
        channel: 'master',
        checkIntervalMs: 60_000,
        reminderIntervalMs: 3_600_000,
        autoApply: true,
      },
    })

    let scheduledPolls = 0
    let autoUpgradeAttempts = 0

    ;(daemon as any).running = true
    ;(daemon as any).startupRecoveryPending = false
    ;(daemon as any).maybeStartResumableIssue = async () => false
    ;(daemon as any).maybeStartStandaloneApprovedPrMerge = async () => false
    ;(daemon as any).maybeRequeueFailedIssue = async () => false
    ;(daemon as any).maybeStartClaimedIssue = async () => false
    ;(daemon as any).maybeStartStandalonePrReview = async () => false
    ;(daemon as any).maybeRefreshAgentLoopUpgradeStatus = async () => {}
    ;(daemon as any).performAutomaticAgentLoopUpgrade = async () => {
      autoUpgradeAttempts += 1
      return true
    }
    ;(daemon as any).scheduleNextPoll = () => {
      scheduledPolls += 1
    }
    ;(daemon as any).agentLoopUpgrade = {
      enabled: true,
      repo: 'JamesWuHK/agent-loop',
      channel: 'master',
      checkedAt: '2026-04-11T11:00:00.000Z',
      status: 'upgrade-available',
      latestVersion: '0.1.2',
      latestRevision: '2222222222222222222222222222222222222222',
      latestCommitAt: '2026-04-11T10:59:30.000Z',
      safeToUpgradeNow: true,
      message: 'channel master is newer: local v0.1.0, latest v0.1.2',
    }

    await (daemon as any).pollCycle()

    expect(autoUpgradeAttempts).toBe(1)
    expect(scheduledPolls).toBe(0)
  })
})

describe('daemon merge recovery helpers', () => {
  test('skips deferred resumable issue handoffs and keeps scanning for another local resume candidate', async () => {
    const daemon = createTestDaemon({ concurrency: 2 }) as any
    const seen: number[] = []
    const started: number[] = []
    const candidate330 = {
      issue: { number: 330 },
      priorLease: null,
      requiresRemoteAdoption: false,
    }
    const candidate348 = {
      issue: { number: 348 },
      priorLease: null,
      requiresRemoteAdoption: false,
    }

    daemon.findResumableIssue = async (skipIssueNumbers: ReadonlySet<number> = new Set<number>()) => {
      if (!skipIssueNumbers.has(330)) return candidate330
      if (!skipIssueNumbers.has(348)) return candidate348
      return null
    }
    daemon.shouldPreferLinkedPrHandoff = async (candidate: { issue: { number: number } }) => {
      seen.push(candidate.issue.number)
      return candidate.issue.number === 330
    }
    daemon.processResumableIssue = async (candidate: { issue: { number: number } }) => {
      started.push(candidate.issue.number)
    }

    await expect(daemon.maybeStartResumableIssue()).resolves.toBe(true)
    await Promise.resolve()

    expect(seen).toEqual([330, 348])
    expect(started).toEqual([348])
  })

  test('skips duplicate claimed comments when a freshly claimed issue enters working', () => {
    expect(buildIssueWorkingTransitionEvent('fresh-claim', 'codex-dev')).toBeNull()
  })

  test('emits structured claimed events for resume and recoverable working transitions', () => {
    const resumed = buildIssueWorkingTransitionEvent('resume', 'codex-dev', 'resume-existing-worktree')
    const recoverable = buildIssueWorkingTransitionEvent('recoverable', 'codex-dev', 'idle timeout')

    expect(resumed).toMatchObject({
      event: 'claimed',
      machine: 'codex-dev',
      reason: 'resume-existing-worktree',
    })
    expect(typeof resumed?.ts).toBe('string')

    expect(recoverable).toMatchObject({
      event: 'claimed',
      machine: 'codex-dev',
      reason: 'recoverable:idle timeout',
    })
    expect(typeof recoverable?.ts).toBe('string')
  })

  test('defers standalone PR tasks while the linked issue process is active locally', () => {
    expect(shouldDeferStandalonePrTaskForActiveIssueProcess(
      { title: 'Fix #129: [US9-2] RightPanel 执行日志 Tab 壳层' },
      new Set([129]),
    )).toBe(true)

    expect(shouldDeferStandalonePrTaskForActiveIssueProcess(
      { title: 'Fix #129: [US9-2] RightPanel 执行日志 Tab 壳层' },
      new Set([113]),
    )).toBe(false)

    expect(shouldDeferStandalonePrTaskForActiveIssueProcess(
      { title: 'chore: update docs' },
      new Set([129]),
    )).toBe(false)
  })

  test('defers resumable issue recovery while a linked standalone PR task is active locally', () => {
    expect(shouldDeferResumableIssueForActiveLinkedPrTask(250, new Set([250]))).toBe(true)
    expect(shouldDeferResumableIssueForActiveLinkedPrTask(250, new Set([249]))).toBe(false)
    expect(shouldDeferResumableIssueForActiveLinkedPrTask(null, new Set([250]))).toBe(false)
  })

  test('reserves the last free slot for issue work when no issue task is active', () => {
    expect(shouldReserveIssueCapacityForStandalonePrTask({
      concurrency: 2,
      activeTaskCount: 1,
      activeIssueTaskCount: 0,
    })).toBe(true)

    expect(shouldReserveIssueCapacityForStandalonePrTask({
      concurrency: 3,
      activeTaskCount: 2,
      activeIssueTaskCount: 0,
    })).toBe(true)
  })

  test('does not reserve issue capacity when concurrency is single-slot or an issue is already active', () => {
    expect(shouldReserveIssueCapacityForStandalonePrTask({
      concurrency: 1,
      activeTaskCount: 0,
      activeIssueTaskCount: 0,
    })).toBe(false)

    expect(shouldReserveIssueCapacityForStandalonePrTask({
      concurrency: 2,
      activeTaskCount: 1,
      activeIssueTaskCount: 1,
    })).toBe(false)

    expect(shouldReserveIssueCapacityForStandalonePrTask({
      concurrency: 3,
      activeTaskCount: 1,
      activeIssueTaskCount: 0,
    })).toBe(false)
  })

  test('defers standalone PR tasks while a linked issue lease is active on GitHub', () => {
    const activeIssueLease = {
      commentId: 1,
      body: '',
      createdAt: '2026-04-06T13:00:00.000Z',
      updatedAt: '2026-04-06T13:00:30.000Z',
      lease: {
        leaseId: 'lease-issue',
        scope: 'issue-process',
        issueNumber: 129,
        machineId: 'machine-a',
        daemonInstanceId: 'daemon-a',
        branch: 'agent/129/machine-a',
        worktreeId: 'issue-129-machine-a',
        phase: 'issue-recovery',
        startedAt: '2026-04-06T13:00:00.000Z',
        lastHeartbeatAt: '2026-04-06T13:00:30.000Z',
        expiresAt: '2026-04-06T13:01:30.000Z',
        attempt: 1,
        lastProgressAt: '2026-04-06T13:00:25.000Z',
        lastProgressKind: 'stdout',
        status: 'active',
      },
    } as ManagedLeaseComment

    expect(shouldDeferStandalonePrTaskForActiveIssueLease(activeIssueLease)).toBe(true)
    expect(shouldDeferStandalonePrTaskForActiveIssueLease(null)).toBe(false)
  })

  test('defers resumable issue recovery while linked PR review or merge leases are active on GitHub', () => {
    const activePrReviewLease = {
      commentId: 2,
      body: '',
      createdAt: '2026-04-06T13:00:00.000Z',
      updatedAt: '2026-04-06T13:00:30.000Z',
      lease: {
        leaseId: 'lease-pr-review',
        scope: 'pr-review',
        issueNumber: 129,
        prNumber: 250,
        machineId: 'machine-b',
        daemonInstanceId: 'daemon-b',
        branch: 'agent/129/machine-b',
        worktreeId: 'pr-review-250',
        phase: 'pr-review',
        startedAt: '2026-04-06T13:00:00.000Z',
        lastHeartbeatAt: '2026-04-06T13:00:30.000Z',
        expiresAt: '2026-04-06T13:01:30.000Z',
        attempt: 1,
        lastProgressAt: '2026-04-06T13:00:25.000Z',
        lastProgressKind: 'phase',
        status: 'active',
      },
    } as ManagedLeaseComment

    expect(shouldDeferResumableIssueForActiveLinkedPrLease(activePrReviewLease, null)).toBe(true)
    expect(shouldDeferResumableIssueForActiveLinkedPrLease(null, activePrReviewLease)).toBe(true)
    expect(shouldDeferResumableIssueForActiveLinkedPrLease(null, null)).toBe(false)
  })

  test('includes effective concurrency policy and local endpoints in status snapshots', () => {
    const config: AgentConfig = {
      machineId: 'codex-dev',
      repo: 'JamesWuHK/digital-employee',
      pat: 'test-token',
      pollIntervalMs: 60_000,
      concurrency: 2,
      requestedConcurrency: 5,
      concurrencyPolicy: {
        requested: 5,
        effective: 2,
        repoCap: 4,
        profileCap: 2,
        projectCap: 3,
      },
      scheduling: {
        concurrencyByRepo: {
          'JamesWuHK/digital-employee': 4,
        },
        concurrencyByProfile: {
          'desktop-vite': 2,
        },
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
        profile: 'desktop-vite',
        maxConcurrency: 3,
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

    const daemon = new AgentDaemon(
      config,
      console,
      { host: '127.0.0.1', port: 9311 },
      9091,
    )

    expect(daemon.getStatus()).toMatchObject({
      repo: 'JamesWuHK/digital-employee',
      concurrency: 2,
      requestedConcurrency: 5,
      concurrencyPolicy: {
        requested: 5,
        effective: 2,
        repoCap: 4,
        profileCap: 2,
        projectCap: 3,
      },
      project: {
        profile: 'desktop-vite',
        defaultBranch: 'main',
        maxConcurrency: 3,
      },
      endpoints: {
        health: {
          host: '127.0.0.1',
          port: 9311,
          path: '/health',
        },
        metrics: {
          host: '127.0.0.1',
          port: 9091,
          path: '/metrics',
        },
      },
      runtime: {
        supervisor: 'direct',
        workingDirectory: process.cwd(),
        runtimeRecordPath: null,
        logPath: null,
      },
    })
  })

  test('counts in-flight issue work before a worktree is registered', () => {
    expect(getEffectiveActiveTaskCount({
      activeWorktreeCount: 0,
      inFlightIssueProcessCount: 1,
      activePrReviewCount: 0,
      inFlightPrReviewCount: 0,
    })).toBe(1)
  })

  test('does not double-count work that already has an active slot', () => {
    expect(getEffectiveActiveTaskCount({
      activeWorktreeCount: 1,
      inFlightIssueProcessCount: 1,
      activePrReviewCount: 1,
      inFlightPrReviewCount: 1,
    })).toBe(2)
  })

  test('builds runtime status snapshots for health and metrics surfaces', () => {
    expect(buildDaemonRuntimeStatus({
      supervisor: 'launchd',
      workingDirectory: '/Users/wujames/codeRepo/digital-employee-main',
      runtimeRecordPath: '/Users/wujames/.agent-loop/runtime/runtime.json',
      logPath: '/Users/wujames/.agent-loop/runtime/runtime.log',
      activeWorktreeCount: 1,
      activePrReviewCount: 2,
      inFlightIssueProcessCount: 1,
      inFlightPrReviewCount: 2,
      startupRecoveryPending: true,
      transientLoopErrorCount: 2,
      startupRecoveryDeferredCount: 1,
      lastTransientLoopErrorAt: '2026-04-05T08:10:50.000Z',
      lastTransientLoopErrorKind: 'startup-recovery',
      lastTransientLoopErrorMessage: 'Could not resolve host: api.github.com',
      lastTransientLoopErrorAgeSeconds: 10,
      failedIssueResumeAttemptCount: 3,
      failedIssueResumeCooldownCount: 2,
      oldestBlockedIssueResumeAgeSeconds: 12,
      activeLeaseCount: 2,
      oldestLeaseHeartbeatAgeSeconds: 47,
      activeLeaseDetails: [
        {
          scope: 'issue-process',
          targetNumber: 77,
          commentId: 11,
          issueNumber: 77,
          prNumber: null,
          machineId: 'codex-dev',
          daemonInstanceId: 'daemon-codex-dev-1',
          branch: 'agent/77/codex-dev',
          worktreeId: 'issue-77-codex-dev',
          phase: 'implementation',
          attempt: 2,
          status: 'active',
          lastProgressKind: 'stdout',
          heartbeatAgeSeconds: 47,
          progressAgeSeconds: 19,
          expiresInSeconds: 13,
          adoptable: false,
        },
      ],
      stalledWorkerCount: 1,
      stalledWorkerDetails: [
        {
          scope: 'issue-process',
          targetNumber: 77,
          since: '2026-04-05T08:10:30.000Z',
          durationSeconds: 30,
          reason: 'idle timeout',
        },
      ],
      blockedIssueResumeCount: 1,
      blockedIssueResumeEscalationCount: 1,
      blockedIssueResumeDetails: [
        {
          issueNumber: 91,
          prNumber: 110,
          since: '2026-04-05T08:09:45.000Z',
          durationSeconds: 12,
          reason: 'linked PR #110 is in terminal agent:human-needed; automated review has no remaining structured retry path',
          escalationCount: 1,
          lastEscalatedAt: '2026-04-05T08:10:45.000Z',
          lastEscalationAgeSeconds: 6,
        },
      ],
      lastRecoveryActionAt: '2026-04-05T08:11:00.000Z',
      lastRecoveryActionKind: 'issue-process-idle-timeout',
      recentRecoveryActions: [
        {
          at: '2026-04-05T08:11:00.000Z',
          kind: 'issue-process-idle-timeout',
          outcome: 'recoverable',
          scope: 'issue-process',
          targetNumber: 77,
          reason: 'idle timeout',
        },
      ],
      oldestBlockedIssueResumeEscalationAgeSeconds: 6,
    })).toEqual({
      supervisor: 'launchd',
      workingDirectory: '/Users/wujames/codeRepo/digital-employee-main',
      runtimeRecordPath: '/Users/wujames/.agent-loop/runtime/runtime.json',
      logPath: '/Users/wujames/.agent-loop/runtime/runtime.log',
      activePrReviews: 2,
      inFlightIssueProcess: true,
      inFlightPrReview: true,
      startupRecoveryPending: true,
      transientLoopErrorCount: 2,
      startupRecoveryDeferredCount: 1,
      lastTransientLoopErrorAt: '2026-04-05T08:10:50.000Z',
      lastTransientLoopErrorKind: 'startup-recovery',
      lastTransientLoopErrorMessage: 'Could not resolve host: api.github.com',
      lastTransientLoopErrorAgeSeconds: 10,
      effectiveActiveTasks: 3,
      failedIssueResumeAttemptsTracked: 3,
      failedIssueResumeCooldownsTracked: 2,
      oldestBlockedIssueResumeAgeSeconds: 12,
      activeLeaseCount: 2,
      oldestLeaseHeartbeatAgeSeconds: 47,
      activeLeaseDetails: [
        {
          scope: 'issue-process',
          targetNumber: 77,
          commentId: 11,
          issueNumber: 77,
          prNumber: null,
          machineId: 'codex-dev',
          daemonInstanceId: 'daemon-codex-dev-1',
          branch: 'agent/77/codex-dev',
          worktreeId: 'issue-77-codex-dev',
          phase: 'implementation',
          attempt: 2,
          status: 'active',
          lastProgressKind: 'stdout',
          heartbeatAgeSeconds: 47,
          progressAgeSeconds: 19,
          expiresInSeconds: 13,
          adoptable: false,
        },
      ],
      stalledWorkerCount: 1,
      stalledWorkerDetails: [
        {
          scope: 'issue-process',
          targetNumber: 77,
          since: '2026-04-05T08:10:30.000Z',
          durationSeconds: 30,
          reason: 'idle timeout',
        },
      ],
      blockedIssueResumeCount: 1,
      blockedIssueResumeEscalationCount: 1,
      blockedIssueResumeDetails: [
        {
          issueNumber: 91,
          prNumber: 110,
          since: '2026-04-05T08:09:45.000Z',
          durationSeconds: 12,
          reason: 'linked PR #110 is in terminal agent:human-needed; automated review has no remaining structured retry path',
          escalationCount: 1,
          lastEscalatedAt: '2026-04-05T08:10:45.000Z',
          lastEscalationAgeSeconds: 6,
        },
      ],
      lastRecoveryActionAt: '2026-04-05T08:11:00.000Z',
      lastRecoveryActionKind: 'issue-process-idle-timeout',
      recentRecoveryActions: [
        {
          at: '2026-04-05T08:11:00.000Z',
          kind: 'issue-process-idle-timeout',
          outcome: 'recoverable',
          scope: 'issue-process',
          targetNumber: 77,
          reason: 'idle timeout',
        },
      ],
      oldestBlockedIssueResumeEscalationAgeSeconds: 6,
    })
  })

  test('round-trips blocked issue resume escalation comments', () => {
    const comment = buildBlockedIssueResumeEscalationComment({
      issueNumber: 91,
      prNumber: 110,
      blockedSince: '2026-04-05T08:00:00.000Z',
      escalatedAt: '2026-04-05T08:10:00.000Z',
      thresholdSeconds: 300,
      reason: 'linked PR #110 is in terminal agent:human-needed; automated review has no remaining structured retry path',
      machineId: 'codex-dev',
      daemonInstanceId: 'daemon-codex-dev-1',
    })

    expect(extractBlockedIssueResumeEscalationComment(comment)).toEqual({
      issueNumber: 91,
      prNumber: 110,
      blockedSince: '2026-04-05T08:00:00.000Z',
      escalatedAt: '2026-04-05T08:10:00.000Z',
      thresholdSeconds: 300,
      reason: 'linked PR #110 is in terminal agent:human-needed; automated review has no remaining structured retry path',
      machineId: 'codex-dev',
      daemonInstanceId: 'daemon-codex-dev-1',
    })
  })

  test('round-trips blocked issue resume resolution comments', () => {
    const comment = buildIssueResumeResolutionComment({
      issueNumber: 91,
      prNumber: 110,
      resolvedAt: '2026-04-11T08:25:00.000Z',
      resolution: 'human-follow-up-complete',
    })

    expect(extractIssueResumeResolutionComment(comment)).toEqual({
      issueNumber: 91,
      prNumber: 110,
      resolvedAt: '2026-04-11T08:25:00.000Z',
      resolution: 'human-follow-up-complete',
    })
  })

  test('unblocks only when a newer matching resolution comment exists', () => {
    const blockedComment = {
      commentId: 1,
      createdAt: '2026-04-11T08:10:00.000Z',
      updatedAt: '2026-04-11T08:10:00.000Z',
      body: buildBlockedIssueResumeEscalationComment({
        issueNumber: 91,
        prNumber: 110,
        blockedSince: '2026-04-11T08:00:00.000Z',
        escalatedAt: '2026-04-11T08:10:00.000Z',
        thresholdSeconds: 300,
        reason: 'linked PR #110 is in terminal agent:human-needed; automated review has no remaining structured retry path',
        machineId: 'codex-dev',
        daemonInstanceId: 'daemon-1',
      }),
    }

    const resolutionComment = {
      commentId: 2,
      createdAt: '2026-04-11T08:25:00.000Z',
      updatedAt: '2026-04-11T08:25:00.000Z',
      body: buildIssueResumeResolutionComment({
        issueNumber: 91,
        prNumber: 110,
        resolvedAt: '2026-04-11T08:25:00.000Z',
        resolution: 'human-follow-up-complete',
      }),
    }

    expect(canResumeBlockedIssueFromResolution(
      [blockedComment, resolutionComment],
      91,
      110,
    )).toBe(true)

    expect(canResumeBlockedIssueFromResolution(
      [
        blockedComment,
        {
          ...resolutionComment,
          commentId: 3,
          updatedAt: '2026-04-11T08:05:00.000Z',
          body: buildIssueResumeResolutionComment({
            issueNumber: 91,
            prNumber: 110,
            resolvedAt: '2026-04-11T08:05:00.000Z',
            resolution: 'too-early',
          }),
        },
      ],
      91,
      110,
    )).toBe(false)

    expect(canResumeBlockedIssueFromResolution(
      [
        blockedComment,
        {
          ...resolutionComment,
          commentId: 4,
          body: buildIssueResumeResolutionComment({
            issueNumber: 91,
            prNumber: 111,
            resolvedAt: '2026-04-11T08:25:00.000Z',
            resolution: 'wrong-pr',
          }),
        },
      ],
      91,
      110,
    )).toBe(false)
  })

  test('finds blocked issue resume escalations for the same issue and linked PR', () => {
    const body = buildBlockedIssueResumeEscalationComment({
      issueNumber: 91,
      prNumber: 110,
      blockedSince: '2026-04-05T08:00:00.000Z',
      escalatedAt: '2026-04-05T08:10:00.000Z',
      thresholdSeconds: 300,
      reason: 'blocked',
      machineId: 'codex-dev',
      daemonInstanceId: 'daemon-codex-dev-1',
    })

    const matches = listBlockedIssueResumeEscalationComments([
      {
        commentId: 1,
        body,
        createdAt: '2026-04-05T08:10:00.000Z',
        updatedAt: '2026-04-05T08:10:00.000Z',
      },
      {
        commentId: 2,
        body: body.replace('"prNumber":110', '"prNumber":111'),
        createdAt: '2026-04-05T08:11:00.000Z',
        updatedAt: '2026-04-05T08:11:00.000Z',
      },
    ], 91, 110)

    expect(matches).toHaveLength(1)
    expect(matches[0]?.commentId).toBe(1)
  })

  test('only escalates blocked issue resumes after threshold and outside cooldown', () => {
    const now = Date.parse('2026-04-05T08:10:00.000Z')

    expect(shouldEscalateBlockedIssueResume({
      blockedSince: '2026-04-05T08:09:10.000Z',
      lastEscalatedAt: null,
      now,
    })).toBe(false)

    expect(shouldEscalateBlockedIssueResume({
      blockedSince: '2026-04-05T08:00:00.000Z',
      lastEscalatedAt: '2026-04-05T08:05:00.000Z',
      now,
    })).toBe(false)

    expect(shouldEscalateBlockedIssueResume({
      blockedSince: '2026-04-05T08:00:00.000Z',
      lastEscalatedAt: '2026-04-05T07:30:00.000Z',
      now,
    })).toBe(true)
  })

  test('tracks transient loop errors in daemon runtime status', () => {
    const config: AgentConfig = {
      machineId: 'codex-dev',
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
      worktreesBase: '/tmp/worktrees',
      project: {
        profile: 'desktop-vite',
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

    const daemon = new AgentDaemon(config, console)
    ;(daemon as any).noteTransientLoopError('startup-recovery', new Error('Could not resolve host: api.github.com'))

    expect(daemon.getStatus().runtime).toMatchObject({
      transientLoopErrorCount: 1,
      startupRecoveryDeferredCount: 1,
      lastTransientLoopErrorKind: 'startup-recovery',
      lastTransientLoopErrorMessage: 'Could not resolve host: api.github.com',
    })
    expect(daemon.getStatus().runtime.lastTransientLoopErrorAgeSeconds).toBeTypeOf('number')
  })

  test('treats transient network-style daemon errors as retryable', () => {
    expect(isRetryableDaemonLoopError(new Error('gh api failed: dial tcp: i/o timeout'))).toBe(true)
    expect(isRetryableDaemonLoopError(new Error('Could not resolve host: api.github.com'))).toBe(true)
    expect(isRetryableDaemonLoopError(new Error('Connection refused'))).toBe(true)
    expect(isRetryableDaemonLoopError(new Error('malformed issue contract'))).toBe(false)
  })

  test('resumes working issues with a local worktree after daemon restart', () => {
    expect(shouldResumeManagedIssue(
      { state: 'working' },
      true,
      0,
      0,
      Date.now(),
      2,
    )).toBe(true)
  })

  test('resumes stale issues with a preserved local worktree after daemon restart', () => {
    expect(shouldResumeManagedIssue(
      { state: 'stale' },
      true,
      0,
      0,
      Date.now(),
      2,
    )).toBe(true)
  })

  test('does not resume failed issues from leases that already recorded a missing remote recovery branch', () => {
    const latestLease: ManagedLeaseComment = {
      commentId: 11,
      body: '',
      createdAt: '2026-04-06T08:00:00.000Z',
      updatedAt: '2026-04-06T08:01:00.000Z',
      lease: {
        leaseId: 'lease-111',
        scope: 'issue-process',
        issueNumber: 111,
        machineId: 'codex-remote',
        daemonInstanceId: 'daemon-remote',
        branch: 'agent/111/codex-remote',
        worktreeId: 'issue-111-codex-remote',
        phase: 'issue-recovery',
        startedAt: '2026-04-06T08:00:00.000Z',
        lastHeartbeatAt: '2026-04-06T08:01:00.000Z',
        expiresAt: '2026-04-06T08:02:00.000Z',
        attempt: 2,
        lastProgressAt: '2026-04-06T08:00:30.000Z',
        status: 'recoverable' as const,
        recoveryReason: 'missing-remote-branch:agent/111/codex-remote fatal: couldn\'t find remote ref agent/111/codex-remote',
      },
    }

    expect(isMissingRemoteBranchRecoveryReason(latestLease.lease.recoveryReason)).toBe(true)
    expect(canResumeIssueFromLease(latestLease, null, true)).toBe(false)

    expect(canResumeIssueFromLease({
      ...latestLease,
      lease: {
        ...latestLease.lease,
        recoveryReason: undefined,
      },
    }, null, true)).toBe(true)
  })

  test('respects failed-issue retry cooldowns while still requiring a local worktree', () => {
    const now = Date.now()

    expect(shouldResumeManagedIssue(
      { state: 'failed' },
      true,
      0,
      now - 1,
      now,
      2,
    )).toBe(true)

    expect(shouldResumeManagedIssue(
      { state: 'failed' },
      true,
      2,
      now - 1,
      now,
      2,
    )).toBe(false)

    expect(shouldResumeManagedIssue(
      { state: 'failed' },
      true,
      0,
      now + 60_000,
      now,
      2,
    )).toBe(false)
  })

  test('requeues failed issues without local recovery state after cooldown', () => {
    const now = Date.now()

    expect(shouldRequeueFailedIssue(
      {
        state: 'failed',
        updatedAt: new Date(now - 6 * 60_000).toISOString(),
        hasExecutableContract: true,
      },
      false,
      false,
      now,
      5 * 60_000,
    )).toBe(true)

    expect(shouldRequeueFailedIssue(
      {
        state: 'failed',
        updatedAt: new Date(now - 60_000).toISOString(),
        hasExecutableContract: true,
      },
      false,
      false,
      now,
      5 * 60_000,
    )).toBe(false)

    expect(shouldRequeueFailedIssue(
      {
        state: 'failed',
        updatedAt: new Date(now - 6 * 60_000).toISOString(),
        hasExecutableContract: true,
      },
      true,
      false,
      now,
      5 * 60_000,
    )).toBe(false)

    expect(shouldRequeueFailedIssue(
      {
        state: 'failed',
        updatedAt: new Date(now - 6 * 60_000).toISOString(),
        hasExecutableContract: true,
      },
      false,
      true,
      now,
      5 * 60_000,
    )).toBe(false)

    expect(shouldRequeueFailedIssue(
      {
        state: 'failed',
        updatedAt: new Date(now - 6 * 60_000).toISOString(),
        hasExecutableContract: false,
      },
      false,
      false,
      now,
      5 * 60_000,
    )).toBe(false)
  })

  test('clears resumable failure cooldown tracking only for terminal finalize failures', () => {
    expect(shouldClearFailedIssueResumeTrackingAfterFinalize('failed')).toBe(true)
    expect(shouldClearFailedIssueResumeTrackingAfterFinalize('completed')).toBe(false)
    expect(shouldClearFailedIssueResumeTrackingAfterFinalize('recoverable')).toBe(false)
  })

  test('resets linked PR labels back to retry when issue recovery resumes', () => {
    expect(shouldResetLinkedPrToRetryOnIssueResume([PR_REVIEW_LABELS.HUMAN_NEEDED])).toBe(true)
    expect(shouldResetLinkedPrToRetryOnIssueResume([PR_REVIEW_LABELS.FAILED])).toBe(true)
    expect(shouldResetLinkedPrToRetryOnIssueResume([PR_REVIEW_LABELS.FAILED, PR_REVIEW_LABELS.HUMAN_NEEDED])).toBe(true)
    expect(shouldResetLinkedPrToRetryOnIssueResume([PR_REVIEW_LABELS.RETRY])).toBe(false)
    expect(shouldResetLinkedPrToRetryOnIssueResume([PR_REVIEW_LABELS.APPROVED])).toBe(false)
  })

  test('prefers standalone PR handoff for resumable issues when the branch is already synced', () => {
    expect(getResumableIssueLinkedPrHandoff({
      labels: [PR_REVIEW_LABELS.FAILED, PR_REVIEW_LABELS.RETRY],
    }, false, true)).toEqual({
      kind: 'pr-review',
    })

    expect(getResumableIssueLinkedPrHandoff({
      labels: [PR_REVIEW_LABELS.HUMAN_NEEDED],
    }, true, true)).toEqual({
      kind: 'pr-review',
    })

    expect(getResumableIssueLinkedPrHandoff({
      labels: [PR_REVIEW_LABELS.APPROVED],
    }, false, true)).toEqual({
      kind: 'pr-merge',
    })
  })

  test('keeps resumable issues on issue recovery when the branch is not synced to the PR head', () => {
    expect(getResumableIssueLinkedPrHandoff({
      labels: [PR_REVIEW_LABELS.RETRY],
    }, false, false)).toBeNull()
  })

  test('does not resume failed issues behind terminal human-needed PRs', () => {
    expect(shouldResumeFailedIssueWithLinkedPr({
      number: 110,
      labels: [PR_REVIEW_LABELS.HUMAN_NEEDED, PR_REVIEW_LABELS.FAILED],
    }, false)).toBe(false)

    expect(shouldResumeFailedIssueWithLinkedPr({
      number: 110,
      labels: [PR_REVIEW_LABELS.HUMAN_NEEDED],
    }, true)).toBe(true)

    expect(shouldResumeFailedIssueWithLinkedPr({
      number: 110,
      labels: [PR_REVIEW_LABELS.FAILED, PR_REVIEW_LABELS.RETRY],
    }, false)).toBe(true)

    expect(shouldResumeFailedIssueWithLinkedPr({
      number: 110,
      labels: [PR_REVIEW_LABELS.APPROVED],
    }, false)).toBe(true)

    expect(shouldResumeFailedIssueWithLinkedPr(null, false)).toBe(true)
  })

  test('describes blocked failed-issue resumes for terminal human-needed PRs', () => {
    expect(getFailedIssueResumeBlock({
      number: 110,
      labels: [PR_REVIEW_LABELS.HUMAN_NEEDED, PR_REVIEW_LABELS.FAILED],
    }, false)).toEqual({
      prNumber: 110,
      reason: 'linked PR #110 is in terminal agent:human-needed; automated review has no remaining structured retry path',
    })

    expect(getFailedIssueResumeBlock({
      number: 110,
      labels: [PR_REVIEW_LABELS.HUMAN_NEEDED],
    }, true)).toBeNull()
  })

  test('allows blocked human-needed PRs to auto-refresh when only the base branch moved', () => {
    expect(shouldRefreshBlockedHumanNeededPr(
      {
        labels: [PR_REVIEW_LABELS.HUMAN_NEEDED, PR_REVIEW_LABELS.FAILED],
      },
      { state: 'failed' },
      false,
      true,
      true,
    )).toBe(true)

    expect(shouldRefreshBlockedHumanNeededPr(
      {
        labels: [PR_REVIEW_LABELS.HUMAN_NEEDED, PR_REVIEW_LABELS.FAILED],
      },
      { state: 'failed' },
      true,
      true,
      true,
    )).toBe(false)

    expect(shouldRefreshBlockedHumanNeededPr(
      {
        labels: [PR_REVIEW_LABELS.HUMAN_NEEDED, PR_REVIEW_LABELS.FAILED],
      },
      { state: 'failed' },
      false,
      false,
      true,
    )).toBe(false)

    expect(shouldRefreshBlockedHumanNeededPr(
      {
        labels: [PR_REVIEW_LABELS.HUMAN_NEEDED, PR_REVIEW_LABELS.FAILED],
      },
      { state: 'done' },
      false,
      true,
      true,
    )).toBe(false)
  })

  test('suppresses repeated PR refresh retries when head and base are unchanged since the last failure', () => {
    const refreshFailure = buildPrReviewRefreshFailureComment(
      110,
      'agent/110/codex-20260403',
      'main',
      'abc123',
      'def456',
      'Branch refresh failed before rerunning review: conflict',
    )

    expect(canRetryPrReviewRefresh(
      [{ body: refreshFailure }],
      'abc123',
      'def456',
    )).toBe(false)

    expect(canRetryPrReviewRefresh(
      [{ body: refreshFailure }],
      'abc123',
      'def789',
    )).toBe(true)

    expect(canRetryPrReviewRefresh(
      [{ body: refreshFailure }],
      'zzz999',
      'def456',
    )).toBe(true)
  })

  test('still allows merged standalone PRs to stamp agent:done on closed issues', () => {
    expect(shouldApplyStandaloneIssueTransition(
      { state: 'done' },
      ISSUE_LABELS.DONE,
    )).toBe(true)

    expect(shouldApplyStandaloneIssueTransition(
      { state: 'done' },
      ISSUE_LABELS.FAILED,
    )).toBe(false)

    expect(shouldApplyStandaloneIssueTransition(
      { state: 'done' },
      ISSUE_LABELS.WORKING,
    )).toBe(false)
  })

  test('allows standalone PR review to move stale issues back to agent:working', () => {
    expect(shouldApplyStandaloneIssueTransition(
      { state: 'stale' },
      ISSUE_LABELS.WORKING,
    )).toBe(true)
  })

  test('treats remote_closed issue recovery aborts as completed only when the issue is already done', () => {
    expect(shouldCompleteIssueRecoveryOnRemoteClose('remote_closed', { state: 'done' })).toBe(true)
    expect(shouldCompleteIssueRecoveryOnRemoteClose('remote_closed', { state: 'working' })).toBe(false)
    expect(shouldCompleteIssueRecoveryOnRemoteClose('idle_timeout', { state: 'done' })).toBe(false)
    expect(shouldCompleteIssueRecoveryOnRemoteClose('remote_closed', null)).toBe(false)
  })

  test('reconciles human-needed PR labels back to agent:failed on startup', () => {
    expect(getStandaloneIssueTransitionForReviewLabels(
      [PR_REVIEW_LABELS.FAILED, PR_REVIEW_LABELS.HUMAN_NEEDED],
      { state: 'working' },
    )).toEqual({
      nextLabel: ISSUE_LABELS.FAILED,
      reasonSuffix: 'is in human-needed state on startup',
    })
  })

  test('reconciles retry and approved PR labels back to agent:working on startup', () => {
    expect(getStandaloneIssueTransitionForReviewLabels(
      [PR_REVIEW_LABELS.FAILED, PR_REVIEW_LABELS.RETRY],
      { state: 'failed' },
    )).toEqual({
      nextLabel: ISSUE_LABELS.WORKING,
      reasonSuffix: 'is retrying review on startup',
    })

    expect(getStandaloneIssueTransitionForReviewLabels(
      [PR_REVIEW_LABELS.APPROVED],
      { state: 'failed' },
    )).toEqual({
      nextLabel: ISSUE_LABELS.WORKING,
      reasonSuffix: 'is approved and awaiting merge on startup',
    })
  })

  test('does not emit redundant startup issue transitions when PR and issue already agree', () => {
    expect(getStandaloneIssueTransitionForReviewLabels(
      [PR_REVIEW_LABELS.APPROVED],
      { state: 'working' },
    )).toBeNull()

    expect(getStandaloneIssueTransitionForReviewLabels(
      [PR_REVIEW_LABELS.FAILED, PR_REVIEW_LABELS.HUMAN_NEEDED],
      { state: 'failed' },
    )).toBeNull()

    expect(getStandaloneIssueTransitionForReviewLabels(
      [PR_REVIEW_LABELS.APPROVED],
      { state: 'done' },
    )).toBeNull()
  })

  test('detects mergeability failures from GitHub merge API messages', () => {
    expect(isMergeabilityFailure('Pull Request is not mergeable')).toBe(true)
    expect(isMergeabilityFailure('Merge conflict between base and head')).toBe(true)
    expect(isMergeabilityFailure('Required status check "test" is failing')).toBe(false)
  })

  test('builds a merge retry comment with recovery details', () => {
    expect(buildPrMergeRetryComment(
      61,
      'agent/46/codex-20260403',
      'main',
      'Pull Request is not mergeable',
    )).toContain('rebuild the approved branch snapshot on top of `origin/main`')
  })

  test('falls back to rebuilding the approved branch snapshot when rebase conflicts', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'daemon-merge-recovery-'))
    const remoteDir = join(tempDir, 'remote.git')
    const repoDir = join(tempDir, 'repo')

    try {
      mkdirSync(remoteDir, { recursive: true })
      mkdirSync(repoDir, { recursive: true })

      await Bun.$`git -C ${remoteDir} init --bare`.quiet()
      await Bun.$`git -C ${repoDir} init -b main`.quiet()
      await Bun.$`git -C ${repoDir} config user.name test`.quiet()
      await Bun.$`git -C ${repoDir} config user.email test@example.com`.quiet()
      await Bun.$`git -C ${repoDir} remote add origin ${remoteDir}`.quiet()

      writeFileSync(join(repoDir, 'shared.txt'), 'base\n', 'utf-8')
      await Bun.$`git -C ${repoDir} add shared.txt`.quiet()
      await Bun.$`git -C ${repoDir} commit -m "base"`.quiet()
      await Bun.$`git -C ${repoDir} push -u origin main`.quiet()

      await Bun.$`git -C ${repoDir} checkout -b agent/46/codex-20260403`.quiet()
      writeFileSync(join(repoDir, 'shared.txt'), 'feature-final\n', 'utf-8')
      writeFileSync(join(repoDir, 'feature.txt'), 'feature-only\n', 'utf-8')
      await Bun.$`git -C ${repoDir} add shared.txt feature.txt`.quiet()
      await Bun.$`git -C ${repoDir} commit -m "feature change"`.quiet()
      await Bun.$`git -C ${repoDir} push -u origin agent/46/codex-20260403`.quiet()

      await Bun.$`git -C ${repoDir} checkout main`.quiet()
      writeFileSync(join(repoDir, 'shared.txt'), 'main-conflict\n', 'utf-8')
      writeFileSync(join(repoDir, 'base-only.txt'), 'keep-me\n', 'utf-8')
      await Bun.$`git -C ${repoDir} add shared.txt base-only.txt`.quiet()
      await Bun.$`git -C ${repoDir} commit -m "main conflict"`.quiet()
      await Bun.$`git -C ${repoDir} push`.quiet()

      const result = await rebaseManagedBranchOntoDefault(
        repoDir,
        'agent/46/codex-20260403',
        'main',
        console,
      )

      expect(result).toEqual({ success: true })
      expect((await Bun.$`git -C ${repoDir} rev-parse --abbrev-ref HEAD`.quiet().text()).trim()).toBe(
        'agent/46/codex-20260403',
      )
      expect((await Bun.$`git -C ${repoDir} status --short`.quiet().text()).trim()).toBe('')
      expect((await Bun.$`cat ${join(repoDir, 'shared.txt')}`.text()).trim()).toBe('feature-final')
      expect((await Bun.$`cat ${join(repoDir, 'feature.txt')}`.text()).trim()).toBe('feature-only')
      expect((await Bun.$`cat ${join(repoDir, 'base-only.txt')}`.text()).trim()).toBe('keep-me')
      expect(Number.parseInt((await Bun.$`git -C ${repoDir} rev-list --count HEAD..origin/main`.quiet().text()).trim(), 10)).toBe(0)
      expect(Number.parseInt((await Bun.$`git -C ${repoDir} rev-list --count origin/main..HEAD`.quiet().text()).trim(), 10)).toBeGreaterThan(0)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('refreshes resumed issue branches onto the latest default branch before recovery continues', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'daemon-issue-recovery-refresh-'))
    const remoteDir = join(tempDir, 'remote.git')
    const repoDir = join(tempDir, 'repo')

    try {
      mkdirSync(remoteDir, { recursive: true })
      mkdirSync(repoDir, { recursive: true })

      await Bun.$`git -C ${remoteDir} init --bare`.quiet()
      await Bun.$`git -C ${repoDir} init -b main`.quiet()
      await Bun.$`git -C ${repoDir} config user.name test`.quiet()
      await Bun.$`git -C ${repoDir} config user.email test@example.com`.quiet()
      await Bun.$`git -C ${repoDir} remote add origin ${remoteDir}`.quiet()

      writeFileSync(join(repoDir, 'base.txt'), 'base\n', 'utf-8')
      await Bun.$`git -C ${repoDir} add base.txt`.quiet()
      await Bun.$`git -C ${repoDir} commit -m "base"`.quiet()
      await Bun.$`git -C ${repoDir} push -u origin main`.quiet()

      await Bun.$`git -C ${repoDir} checkout -b agent/129/codex-20260403`.quiet()
      writeFileSync(join(repoDir, 'feature.txt'), 'issue-only\n', 'utf-8')
      await Bun.$`git -C ${repoDir} add feature.txt`.quiet()
      await Bun.$`git -C ${repoDir} commit -m "issue work"`.quiet()
      await Bun.$`git -C ${repoDir} push -u origin agent/129/codex-20260403`.quiet()

      await Bun.$`git -C ${repoDir} checkout main`.quiet()
      writeFileSync(join(repoDir, 'base.txt'), 'base\nmain-update\n', 'utf-8')
      await Bun.$`git -C ${repoDir} add base.txt`.quiet()
      await Bun.$`git -C ${repoDir} commit -m "main update"`.quiet()
      await Bun.$`git -C ${repoDir} push`.quiet()

      await Bun.$`git -C ${repoDir} checkout agent/129/codex-20260403`.quiet()

      const result = await refreshResumableIssueBranchOntoDefault(
        repoDir,
        'agent/129/codex-20260403',
        'main',
        console,
      )

      expect(result).toEqual({ success: true, refreshed: true })
      expect((await Bun.$`git -C ${repoDir} status --short`.quiet().text()).trim()).toBe('')
      expect((await Bun.$`cat ${join(repoDir, 'feature.txt')}`.text()).trim()).toBe('issue-only')
      expect((await Bun.$`cat ${join(repoDir, 'base.txt')}`.text()).trim()).toBe('base\nmain-update')
      expect(
        Number.parseInt((await Bun.$`git -C ${repoDir} rev-list --count HEAD..origin/main`.quiet().text()).trim(), 10),
      ).toBe(0)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('refreshes resumed local-only issue branches onto the latest default branch', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'daemon-local-only-issue-recovery-refresh-'))
    const remoteDir = join(tempDir, 'remote.git')
    const repoDir = join(tempDir, 'repo')

    try {
      mkdirSync(remoteDir, { recursive: true })
      mkdirSync(repoDir, { recursive: true })

      await Bun.$`git -C ${remoteDir} init --bare`.quiet()
      await Bun.$`git -C ${repoDir} init -b main`.quiet()
      await Bun.$`git -C ${repoDir} config user.name test`.quiet()
      await Bun.$`git -C ${repoDir} config user.email test@example.com`.quiet()
      await Bun.$`git -C ${repoDir} remote add origin ${remoteDir}`.quiet()

      writeFileSync(join(repoDir, 'base.txt'), 'base\n', 'utf-8')
      await Bun.$`git -C ${repoDir} add base.txt`.quiet()
      await Bun.$`git -C ${repoDir} commit -m "base"`.quiet()
      await Bun.$`git -C ${repoDir} push -u origin main`.quiet()

      await Bun.$`git -C ${repoDir} checkout -b agent/130/e6f5b0a1-a129-492d-b208-8e1da8e49ef4`.quiet()
      writeFileSync(join(repoDir, 'feature.txt'), 'local-only\n', 'utf-8')
      await Bun.$`git -C ${repoDir} add feature.txt`.quiet()
      await Bun.$`git -C ${repoDir} commit -m "issue work"`.quiet()

      await Bun.$`git -C ${repoDir} checkout main`.quiet()
      writeFileSync(join(repoDir, 'base.txt'), 'base\nmain-update\n', 'utf-8')
      await Bun.$`git -C ${repoDir} add base.txt`.quiet()
      await Bun.$`git -C ${repoDir} commit -m "main update"`.quiet()
      await Bun.$`git -C ${repoDir} push`.quiet()

      await Bun.$`git -C ${repoDir} checkout agent/130/e6f5b0a1-a129-492d-b208-8e1da8e49ef4`.quiet()

      const result = await refreshResumableIssueBranchOntoDefault(
        repoDir,
        'agent/130/e6f5b0a1-a129-492d-b208-8e1da8e49ef4',
        'main',
        console,
      )

      expect(result).toEqual({ success: true, refreshed: true })
      expect((await Bun.$`git -C ${repoDir} status --short`.quiet().text()).trim()).toBe('')
      expect((await Bun.$`git -C ${repoDir} rev-parse --abbrev-ref HEAD`.quiet().text()).trim()).toBe(
        'agent/130/e6f5b0a1-a129-492d-b208-8e1da8e49ef4',
      )
      expect((await Bun.$`cat ${join(repoDir, 'feature.txt')}`.text()).trim()).toBe('local-only')
      expect((await Bun.$`cat ${join(repoDir, 'base.txt')}`.text()).trim()).toBe('base\nmain-update')
      expect(
        Number.parseInt((await Bun.$`git -C ${repoDir} rev-list --count HEAD..origin/main`.quiet().text()).trim(), 10),
      ).toBe(0)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('treats missing remote recovery branches as recoverable adoption failures', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'daemon-missing-remote-branch-'))
    const remoteDir = join(tempDir, 'remote.git')
    const repoDir = join(tempDir, 'repo')
    const previousCwd = process.cwd()

    try {
      mkdirSync(remoteDir, { recursive: true })
      mkdirSync(repoDir, { recursive: true })

      await Bun.$`git -C ${remoteDir} init --bare`.quiet()
      await Bun.$`git -C ${repoDir} init -b main`.quiet()
      await Bun.$`git -C ${repoDir} config user.name test`.quiet()
      await Bun.$`git -C ${repoDir} config user.email test@example.com`.quiet()
      await Bun.$`git -C ${repoDir} remote add origin ${remoteDir}`.quiet()

      writeFileSync(join(repoDir, 'shared.txt'), 'base\n', 'utf-8')
      await Bun.$`git -C ${repoDir} add shared.txt`.quiet()
      await Bun.$`git -C ${repoDir} commit -m "base"`.quiet()
      await Bun.$`git -C ${repoDir} push -u origin main`.quiet()

      process.chdir(repoDir)
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

      const worktreePath = join(tempDir, 'worktrees', 'issue-111-test-machine')
      const result = await createWorktreeFromRemoteBranch(
        worktreePath,
        'agent/111/codex-remote',
        config,
        console,
      )

      expect(result.status).toBe('missing-remote-branch')
      if (result.status === 'missing-remote-branch') {
        expect(isMissingRemoteBranchRecoveryReason(result.reason)).toBe(true)
        expect(result.reason).toContain('agent/111/codex-remote')
      }
      expect(existsSync(worktreePath)).toBe(false)
    } finally {
      process.chdir(previousCwd)
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('uses the local worktree branch when acquiring a recovery lease after machine-id changes', async () => {
    const fixture = await createResumableIssueWorktreeFixture()
    const previousCwd = process.cwd()

    try {
      process.chdir(fixture.repoDir)

      const daemon = createTestDaemon({
        machineId: 'codex-20260403',
        worktreesBase: fixture.worktreesBase,
      })
      const priorLease = createHistoricalLeaseComment(329, 'agent/329/codex-dev', 'issue-329-codex-dev')

      let leasedBranch: string | null = null
      ;(daemon as any).acquireLeaseForScope = async (input: { branch: string }) => {
        leasedBranch = input.branch
        return null
      }

      await (daemon as any).processResumableIssue({
        issue: {
          number: 329,
          state: 'failed',
          title: 'Issue 329',
        },
        priorLease,
        requiresRemoteAdoption: false,
      })

      expect(leasedBranch).not.toBeNull()
      if (leasedBranch === null) {
        throw new Error('expected recovery lease acquisition to record a branch')
      }
      if (leasedBranch !== fixture.branch) {
        throw new Error(`expected leased branch ${fixture.branch}, received ${leasedBranch}`)
      }
    } finally {
      process.chdir(previousCwd)
      rmSync(fixture.tempDir, { recursive: true, force: true })
    }
  })

  test('keeps using the actual local worktree branch when resuming an existing recovery worktree', async () => {
    const fixture = await createResumableIssueWorktreeFixture()
    const previousCwd = process.cwd()

    try {
      process.chdir(fixture.repoDir)

      const daemon = createTestDaemon({
        machineId: 'codex-20260403',
        worktreesBase: fixture.worktreesBase,
      })
      const priorLease = createHistoricalLeaseComment(329, 'agent/329/codex-dev', 'issue-329-codex-dev')

      const ensured = await (daemon as any).ensureResumableIssueWorktree(329, priorLease)

      expect(ensured).toMatchObject({
        status: 'ready',
        worktreePath: fixture.worktreePath,
        branch: fixture.branch,
        worktreeId: 'issue-329-codex-20260403',
      })
    } finally {
      process.chdir(previousCwd)
      rmSync(fixture.tempDir, { recursive: true, force: true })
    }
  })
})
