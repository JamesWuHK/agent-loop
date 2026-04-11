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
  classifyStandalonePrReviewFollowup,
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
  classifyApprovedPrMergeChecksGate,
  classifyLinkedIssueApprovedMergeOutcome,
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
  runRemoteUpgradeAnnouncementSafely,
} from './daemon'
import { ISSUE_LABELS, PR_REVIEW_LABELS } from '@agent/shared'
import {
  buildManagedDaemonUpgradeAnnouncementComment,
  buildManagedDaemonUpgradeFailureAlertComment,
  buildManagedDaemonUpgradeSuccessComment,
} from './presence'
import { getMetrics, registry } from './metrics'
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
    idlePollIntervalMs: 300_000,
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

async function withRuntimeSupervisor<T>(
  supervisor: 'direct' | 'detached' | 'launchd',
  run: () => Promise<T> | T,
): Promise<T> {
  const previous = process.env.AGENT_LOOP_RUNTIME_MANAGER
  if (supervisor === 'direct') {
    delete process.env.AGENT_LOOP_RUNTIME_MANAGER
  } else {
    process.env.AGENT_LOOP_RUNTIME_MANAGER = supervisor
  }

  try {
    return await run()
  } finally {
    if (previous === undefined) {
      delete process.env.AGENT_LOOP_RUNTIME_MANAGER
    } else {
      process.env.AGENT_LOOP_RUNTIME_MANAGER = previous
    }
  }
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

describe('issue ops observability', () => {
  test('updates issue contract quality gauges from managed issue bodies', async () => {
    registry.resetMetrics()

    const daemon = createTestDaemon()

    ;(daemon as any).updateIssueOpsMetricsFromIssues([
      {
        number: 50,
        title: '[AL-11] audit',
        body: '## 用户故事\n只有用户故事',
        state: 'ready',
      },
      {
        number: 53,
        title: '[AL-13] repair',
        body: [
          '## 用户故事',
          '作为维护者，我希望 repair flow 能保留具体边界。',
          '',
          '## Context',
          '### Dependencies',
          '```json',
          '{"dependsOn":[50]}',
          '```',
          '### Constraints',
          '- 只修 contract',
          '### AllowedFiles',
          '- frontend files',
          '- backend code',
          '### ForbiddenFiles',
          '- apps/agent-daemon/src/dashboard.ts',
          '### MustPreserve',
          '- narrow scope',
          '### OutOfScope',
          '- 远端写回',
          '### RequiredSemantics',
          '- repair 输出 canonical markdown',
          '### ReviewHints',
          '- 检查 broad allowed files',
          '### Validation',
          '- `bun test apps/agent-daemon/src/issue-repair.test.ts`',
          '- manual smoke test',
          '',
          '## RED 测试',
          '```ts',
          'expect(true).toBe(false)',
          '```',
          '',
          '## 实现步骤',
          '1. 先补 repair',
          '',
          '## 验收',
          '- [ ] warnings 可见',
        ].join('\n'),
        state: 'ready',
      },
    ])

    const metrics = await getMetrics()
    expect(metrics).toContain('agent_loop_issue_contract_invalid_ready 1')
    expect(metrics).toContain('agent_loop_issue_contract_warning_issues 1')
    expect(metrics).toContain('agent_loop_issue_contract_low_score_issues 2')
  })
})

describe('terminal PR safeguards', () => {
  test('skips standalone PR automation when the branch record is already closed or merged', async () => {
    const daemon = createTestDaemon()
    const pr = {
      number: 386,
      title: '[AL-24] stale closed PR',
      url: 'https://github.com/JamesWuHK/agent-loop/pull/386',
      headRefName: 'agent/83/codex-dev',
      headRefOid: 'abc123',
      isDraft: false,
      labels: [PR_REVIEW_LABELS.RETRY],
    }

    for (const prState of ['closed', 'merged'] as const) {
      ;(daemon as any).resolveBranchPullRequestRecord = async () => ({
        number: 386,
        prUrl: pr.url,
        prState,
        headRefName: pr.headRefName,
        baseRefName: 'main',
        body: null,
      })

      await expect((daemon as any).getAutomationEligibleStandalonePr(pr, 'review')).resolves.toBeNull()
      await expect((daemon as any).getAutomationEligibleStandalonePr(pr, 'merge')).resolves.toBeNull()
    }
  })
})

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

  test('tries targeted wake requests before falling back to untargeted discovery', async () => {
    const daemon = createTestDaemon()
    let targetedWakeAttempts = 0
    let untargetedResumeAttempts = 0
    let untargetedClaimAttempts = 0
    let scheduleCount = 0

    ;(daemon as any).running = true
    ;(daemon as any).pendingWakeRequests = [{
      kind: 'issue',
      issueNumber: 374,
      reason: 'issues.labeled:agent:ready',
      sourceEvent: 'issues.labeled',
      dedupeKey: 'issues:labeled:374:agent:ready',
      requestedAt: '2026-04-11T09:12:00.000Z',
    }]
    ;(daemon as any).refreshObservability = () => undefined
    ;(daemon as any).maybeStartTargetedIssueWake = async (issueNumber: number) => {
      targetedWakeAttempts += issueNumber === 374 ? 1 : 0
      return false
    }
    ;(daemon as any).maybeStartResumableIssue = async () => {
      untargetedResumeAttempts += 1
      return false
    }
    ;(daemon as any).maybeStartStandaloneApprovedPrMerge = async () => false
    ;(daemon as any).maybeRequeueFailedIssue = async () => false
    ;(daemon as any).maybeStartClaimedIssue = async () => {
      untargetedClaimAttempts += 1
      return false
    }
    ;(daemon as any).maybeStartStandalonePrReview = async () => false
    ;(daemon as any).maybeAutoApplyAgentLoopUpgrade = async () => false
    ;(daemon as any).scheduleNextPoll = () => {
      scheduleCount += 1
    }

    await (daemon as any).pollCycle()

    expect(targetedWakeAttempts).toBe(1)
    expect(untargetedResumeAttempts).toBe(0)
    expect(untargetedClaimAttempts).toBe(0)
    expect(scheduleCount).toBe(1)
  })

  test('wake-now requests still allow untargeted discovery fallback', async () => {
    const daemon = createTestDaemon()
    let untargetedResumeAttempts = 0
    let scheduleCount = 0

    ;(daemon as any).running = true
    ;(daemon as any).pendingWakeRequests = [{
      kind: 'now',
      reason: 'workflow_dispatch',
      sourceEvent: 'workflow_dispatch',
      dedupeKey: 'workflow_dispatch:now',
      requestedAt: '2026-04-11T09:13:00.000Z',
    }]
    ;(daemon as any).refreshObservability = () => undefined
    ;(daemon as any).maybeStartResumableIssue = async () => {
      untargetedResumeAttempts += 1
      return false
    }
    ;(daemon as any).maybeStartStandaloneApprovedPrMerge = async () => false
    ;(daemon as any).maybeRequeueFailedIssue = async () => false
    ;(daemon as any).maybeStartClaimedIssue = async () => false
    ;(daemon as any).maybeStartStandalonePrReview = async () => false
    ;(daemon as any).maybeAutoApplyAgentLoopUpgrade = async () => false
    ;(daemon as any).scheduleNextPoll = () => {
      scheduleCount += 1
    }

    await (daemon as any).pollCycle()

    expect(untargetedResumeAttempts).toBe(1)
    expect(scheduleCount).toBe(1)
  })

  test('uses the slower idle backstop poll after wake traffic when no work is found', async () => {
    const daemon = createTestDaemon({
      pollIntervalMs: 60_000,
      idlePollIntervalMs: 300_000,
    })
    let scheduledOptions: { delayMs?: number, reason?: string } | undefined

    ;(daemon as any).running = true
    ;(daemon as any).wakeBackstopPollingEnabled = true
    ;(daemon as any).refreshObservability = () => undefined
    ;(daemon as any).maybeStartResumableIssue = async () => false
    ;(daemon as any).maybeStartStandaloneApprovedPrMerge = async () => false
    ;(daemon as any).maybeRequeueFailedIssue = async () => false
    ;(daemon as any).maybeStartClaimedIssue = async () => false
    ;(daemon as any).maybeStartStandalonePrReview = async () => false
    ;(daemon as any).maybeAutoApplyAgentLoopUpgrade = async () => false
    ;(daemon as any).scheduleNextPoll = (options?: { delayMs?: number, reason?: string }) => {
      scheduledOptions = options
    }

    await (daemon as any).pollCycle()

    expect(scheduledOptions).toBeDefined()
    expect(scheduledOptions).toEqual({
      delayMs: 300_000,
      reason: 'idle-backstop',
    })
  })

  test('keeps the active poll interval before any wake traffic has been observed', async () => {
    const daemon = createTestDaemon({
      pollIntervalMs: 60_000,
      idlePollIntervalMs: 300_000,
    })
    let scheduledOptions: { delayMs?: number, reason?: string } | undefined

    ;(daemon as any).running = true
    ;(daemon as any).refreshObservability = () => undefined
    ;(daemon as any).maybeStartResumableIssue = async () => false
    ;(daemon as any).maybeStartStandaloneApprovedPrMerge = async () => false
    ;(daemon as any).maybeRequeueFailedIssue = async () => false
    ;(daemon as any).maybeStartClaimedIssue = async () => false
    ;(daemon as any).maybeStartStandalonePrReview = async () => false
    ;(daemon as any).maybeAutoApplyAgentLoopUpgrade = async () => false
    ;(daemon as any).scheduleNextPoll = (options?: { delayMs?: number, reason?: string }) => {
      scheduledOptions = options
    }

    await (daemon as any).pollCycle()

    expect(scheduledOptions).toBeDefined()
    expect(scheduledOptions).toEqual({
      delayMs: 60_000,
      reason: 'normal',
    })
  })

  test('publishes wake queue metrics when requests are queued and consumed', async () => {
    registry.resetMetrics()

    try {
      const homeDir = mkdtempSync(join(tmpdir(), 'agent-loop-daemon-wake-metrics-'))
      const queuePath = buildWakeQueuePath({
        homeDir,
        repo: 'JamesWuHK/agent-loop',
        machineId: 'codex-dev',
      })

      appendWakeRequest(queuePath, {
        kind: 'issue',
        issueNumber: 374,
        reason: 'issues.labeled:agent:ready',
        sourceEvent: 'issues.labeled',
        dedupeKey: 'issues:labeled:374:agent:ready',
        requestedAt: '2026-04-11T09:12:00.000Z',
      })

      const daemon = createTestDaemon({
        repo: 'JamesWuHK/agent-loop',
        machineId: 'codex-dev',
        worktreesBase: join(homeDir, 'worktrees'),
      })

      await daemon.drainWakeQueueOnce({
        scheduleImmediate: false,
      })

      let metrics = await getMetrics()
      expect(metrics).toContain('agent_loop_wake_requests_total{kind="issue",outcome="queued"} 1')
      expect(metrics).toContain('agent_loop_pending_wake_requests 1')

      ;(daemon as any).maybeStartTargetedIssueWake = async () => true
      await (daemon as any).maybeStartQueuedWakeRequest()

      metrics = await getMetrics()
      expect(metrics).toContain('agent_loop_wake_requests_total{kind="issue",outcome="started_work"} 1')
      expect(metrics).toContain('agent_loop_pending_wake_requests 0')
      expect(metrics).toContain('agent_loop_wake_request_age_seconds_count{kind="issue",outcome="started_work"} 1')
    } finally {
      registry.resetMetrics()
    }
  })
})

describe('agent-loop upgrade coordination', () => {
  test('downgrades startup remote upgrade announcement failures into warnings', async () => {
    const warnings: string[] = []

    await runRemoteUpgradeAnnouncementSafely(
      async () => {
        throw new Error('The socket connection was closed unexpectedly.')
      },
      {
        warn(message: string) {
          warnings.push(message)
        },
      },
    )

    expect(warnings).toEqual([
      expect.stringContaining('failed to process remote upgrade announcement'),
    ])
  })

  test('keeps successful remote upgrade announcement checks silent', async () => {
    let called = false
    const warnings: string[] = []

    await runRemoteUpgradeAnnouncementSafely(
      async () => {
        called = true
      },
      {
        warn(message: string) {
          warnings.push(message)
        },
      },
    )

    expect(called).toBe(true)
    expect(warnings).toEqual([])
  })

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

  test('preserves active issue state markers across intentional upgrade restarts', async () => {
    const daemon = createTestDaemon()

    ;(daemon as any).running = true
    ;(daemon as any).activeWorktrees.set(321, {
      path: '/tmp/worktrees/issue-321-codex-dev',
      issueNumber: 321,
      machineId: 'codex-dev',
      branch: 'agent/321/codex-dev',
      state: 'active',
      createdAt: '2026-04-11T11:30:00.000Z',
    })

    await daemon.stop({
      preserveActiveIssueStates: true,
      reason: 'agent-loop-auto-upgrade',
    })

    expect((daemon as any).running).toBe(false)
    expect((daemon as any).shutdownRequested).toBe(true)
    expect((daemon as any).activeWorktrees.has(321)).toBe(true)
  })

  test('attempts automatic self-upgrade after an idle no-issues poll when enabled', async () => {
    await withRuntimeSupervisor('detached', async () => {
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

  test('keeps direct-mode upgrades in reminder-only mode', async () => {
    await withRuntimeSupervisor('direct', async () => {
      const daemon = createTestDaemon({
        upgrade: {
          enabled: true,
          repo: 'JamesWuHK/agent-loop',
          channel: 'master',
          checkIntervalMs: 60_000,
          reminderIntervalMs: 3_600_000,
          autoApply: true,
        },
      }) as any

      let autoUpgradeAttempts = 0

      daemon.running = true
      daemon.startupRecoveryPending = false
      daemon.maybeRefreshAgentLoopUpgradeStatus = async () => {}
      daemon.performAutomaticAgentLoopUpgrade = async () => {
        autoUpgradeAttempts += 1
        return true
      }
      daemon.agentLoopUpgrade = {
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

      expect(await daemon.maybeAutoApplyAgentLoopUpgrade()).toBe(false)
      expect(autoUpgradeAttempts).toBe(0)
      expect(daemon.autoUpgradeState.attemptCount).toBe(0)
      expect(daemon.readPresenceRuntimeState().upgradeAutoApplyEnabled).toBe(false)
    })
  })

  test('pauses repeated automatic self-upgrade retries for the same target after a failure', async () => {
    await withRuntimeSupervisor('detached', async () => {
      const daemon = createTestDaemon({
        upgrade: {
          enabled: true,
          repo: 'JamesWuHK/agent-loop',
          channel: 'master',
          checkIntervalMs: 60_000,
          reminderIntervalMs: 3_600_000,
          autoApply: true,
        },
      }) as any

      let autoUpgradeAttempts = 0

      daemon.running = true
      daemon.startupRecoveryPending = false
      daemon.maybeRefreshAgentLoopUpgradeStatus = async () => {}
      daemon.performAutomaticAgentLoopUpgrade = async () => {
        autoUpgradeAttempts += 1
        return true
      }
      daemon.agentLoopUpgrade = {
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
      daemon.autoUpgradeState = {
        attemptCount: 1,
        successCount: 0,
        failureCount: 1,
        noChangeCount: 0,
        consecutiveFailureCount: 1,
        lastAttemptAt: '2026-04-11T11:30:00.000Z',
        lastSuccessAt: null,
        lastOutcome: 'failed',
        lastTargetVersion: '0.1.2',
        lastTargetRevision: '2222222222222222222222222222222222222222',
        lastError: 'git pull failed',
        pausedUntil: '2099-04-11T12:00:00.000Z',
      }

      await daemon.maybeAutoApplyAgentLoopUpgrade()

      expect(autoUpgradeAttempts).toBe(0)

      daemon.agentLoopUpgrade = {
        ...daemon.agentLoopUpgrade,
        latestVersion: '0.1.3',
        latestRevision: '3333333333333333333333333333333333333333',
        message: 'channel master is newer: local v0.1.0, latest v0.1.3',
      }

      await daemon.maybeAutoApplyAgentLoopUpgrade()

      expect(autoUpgradeAttempts).toBe(1)
    })
  })

  test('logs a fresh upgrade notice when the announced target changes inside the reminder cooldown', () => {
    return withRuntimeSupervisor('detached', () => {
      const warnings: string[] = []
      const daemon = createTestDaemon({
        upgrade: {
          enabled: true,
          repo: 'JamesWuHK/agent-loop',
          channel: 'master',
          checkIntervalMs: 60_000,
          reminderIntervalMs: 3_600_000,
          autoApply: true,
        },
      }) as any

      daemon.logger = {
        log() {},
        warn(message: string) {
          warnings.push(message)
        },
        error() {},
      }
      daemon.lastUpgradeReminderAt = Date.now()
      daemon.lastUpgradeReminderTargetKey = 'master:0.1.1:1111111111111111111111111111111111111111'

      daemon.maybeLogAgentLoopUpgradeNotice({
        enabled: true,
        repo: 'JamesWuHK/agent-loop',
        channel: 'master',
        checkedAt: '2026-04-11T12:00:00.000Z',
        status: 'upgrade-available',
        latestVersion: '0.1.2',
        latestRevision: '2222222222222222222222222222222222222222',
        latestCommitAt: '2026-04-11T11:59:50.000Z',
        safeToUpgradeNow: false,
        message: 'channel master is newer: local v0.1.0, latest v0.1.2',
      })

      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('auto-apply is enabled; this daemon will restart into the latest build once it goes idle')
    })
  })

  test('logs a manual-restart notice for direct-mode upgrade reminders', () => {
    return withRuntimeSupervisor('direct', () => {
      const warnings: string[] = []
      const daemon = createTestDaemon({
        upgrade: {
          enabled: true,
          repo: 'JamesWuHK/agent-loop',
          channel: 'master',
          checkIntervalMs: 60_000,
          reminderIntervalMs: 3_600_000,
          autoApply: true,
        },
      }) as any

      daemon.logger = {
        log() {},
        warn(message: string) {
          warnings.push(message)
        },
        error() {},
      }

      daemon.maybeLogAgentLoopUpgradeNotice({
        enabled: true,
        repo: 'JamesWuHK/agent-loop',
        channel: 'master',
        checkedAt: '2026-04-11T12:00:00.000Z',
        status: 'upgrade-available',
        latestVersion: '0.1.2',
        latestRevision: '2222222222222222222222222222222222222222',
        latestCommitAt: '2026-04-11T11:59:50.000Z',
        safeToUpgradeNow: true,
        message: 'channel master is newer: local v0.1.0, latest v0.1.2',
      })

      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('direct mode; manual restart is required')
    })
  })

  test('publishes a deduplicated GitHub alert comment after repeated auto-upgrade failures', async () => {
    const daemon = createTestDaemon({
      upgrade: {
        enabled: true,
        repo: 'JamesWuHK/agent-loop',
        channel: 'master',
        checkIntervalMs: 60_000,
        reminderIntervalMs: 3_600_000,
        autoApply: true,
      },
    }) as any

    const postedBodies: string[] = []

    daemon.ensurePresenceIssueNumber = async () => 500
    daemon.commentOnPresenceRegistryIssue = async (_issueNumber: number, body: string) => {
      postedBodies.push(body)
    }
    daemon.listPresenceRegistryComments = async () => [{
      commentId: 18,
      body: buildManagedDaemonUpgradeFailureAlertComment({
        repo: 'JamesWuHK/digital-employee',
        machineId: 'codex-dev',
        daemonInstanceId: 'daemon-codex-dev-1',
        channel: 'master',
        targetVersion: '0.1.2',
        targetRevision: '2222222222222222222222222222222222222222',
        consecutiveFailureCount: 2,
        pausedUntil: '2026-04-11T12:15:00.000Z',
        lastAttemptAt: '2026-04-11T12:00:00.000Z',
        lastError: 'git pull failed',
        alertedAt: '2026-04-11T12:00:10.000Z',
      }),
      createdAt: '2026-04-11T12:00:10.000Z',
      updatedAt: '2026-04-11T12:00:10.000Z',
    }]

    daemon.autoUpgradeState = {
      attemptCount: 2,
      successCount: 0,
      failureCount: 2,
      noChangeCount: 0,
      consecutiveFailureCount: 2,
      lastAttemptAt: '2026-04-11T12:00:00.000Z',
      lastSuccessAt: null,
      lastOutcome: 'failed',
      lastTargetVersion: '0.1.2',
      lastTargetRevision: '2222222222222222222222222222222222222222',
      lastError: 'git pull failed',
      pausedUntil: '2026-04-11T12:15:00.000Z',
    }

    await daemon.maybePublishAutoUpgradeFailureAlert({
      channel: 'master',
      latestVersion: '0.1.2',
      latestRevision: '2222222222222222222222222222222222222222',
    })

    expect(postedBodies).toHaveLength(0)

    daemon.autoUpgradeState = {
      ...daemon.autoUpgradeState,
      failureCount: 3,
      consecutiveFailureCount: 3,
      lastAttemptAt: '2026-04-11T12:15:10.000Z',
      pausedUntil: '2026-04-11T12:45:10.000Z',
    }

    await daemon.maybePublishAutoUpgradeFailureAlert({
      channel: 'master',
      latestVersion: '0.1.2',
      latestRevision: '2222222222222222222222222222222222222222',
    })

    expect(postedBodies).toHaveLength(1)
    expect(postedBodies[0]).toContain('"consecutiveFailureCount":3')
    expect(postedBodies[0]).toContain('"pausedUntil":"2026-04-11T12:45:10.000Z"')
  })

  test('publishes a deduplicated GitHub success acknowledgement after an auto-upgrade restart', async () => {
    const daemon = createTestDaemon({
      upgrade: {
        enabled: true,
        repo: 'JamesWuHK/agent-loop',
        channel: 'master',
        checkIntervalMs: 60_000,
        reminderIntervalMs: 3_600_000,
        autoApply: true,
      },
    }) as any

    const postedBodies: string[] = []
    const currentVersion = daemon.agentLoopBuild.version
    const currentRevision = daemon.agentLoopBuild.revision

    daemon.ensurePresenceIssueNumber = async () => 500
    daemon.commentOnPresenceRegistryIssue = async (_issueNumber: number, body: string) => {
      postedBodies.push(body)
    }
    daemon.listPresenceRegistryComments = async () => [{
      commentId: 28,
      body: buildManagedDaemonUpgradeSuccessComment({
        repo: 'JamesWuHK/digital-employee',
        machineId: 'codex-dev',
        daemonInstanceId: 'daemon-codex-dev-older',
        channel: 'master',
        targetVersion: currentVersion,
        targetRevision: currentRevision,
        succeededAt: '2026-04-11T12:00:20.000Z',
        acknowledgedAt: '2026-04-11T12:00:30.000Z',
      }),
      createdAt: '2026-04-11T12:00:30.000Z',
      updatedAt: '2026-04-11T12:00:30.000Z',
    }]

    daemon.autoUpgradeState = {
      attemptCount: 2,
      successCount: 1,
      failureCount: 1,
      noChangeCount: 0,
      consecutiveFailureCount: 0,
      lastAttemptAt: '2026-04-11T12:00:10.000Z',
      lastSuccessAt: '2026-04-11T12:00:20.000Z',
      lastOutcome: 'succeeded',
      lastTargetVersion: currentVersion,
      lastTargetRevision: currentRevision,
      lastError: null,
      pausedUntil: null,
    }

    await daemon.maybePublishAutoUpgradeSuccessAcknowledgement()

    expect(postedBodies).toHaveLength(0)

    daemon.autoUpgradeState = {
      ...daemon.autoUpgradeState,
      lastSuccessAt: '2026-04-11T12:30:20.000Z',
    }

    await daemon.maybePublishAutoUpgradeSuccessAcknowledgement()

    expect(postedBodies).toHaveLength(1)
    expect(postedBodies[0]).toContain(`"targetVersion":"${currentVersion}"`)
    expect(postedBodies[0]).toContain(`"targetRevision":"${currentRevision}"`)
    expect(postedBodies[0]).toContain('"succeededAt":"2026-04-11T12:30:20.000Z"')
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
      idlePollIntervalMs: 300_000,
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
      idlePollIntervalMs: 300_000,
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
      autoUpgrade: {
        attemptCount: 1,
        successCount: 1,
        failureCount: 0,
        noChangeCount: 0,
        consecutiveFailureCount: 0,
        lastAttemptAt: '2026-04-05T08:11:05.000Z',
        lastSuccessAt: '2026-04-05T08:11:05.000Z',
        lastOutcome: 'succeeded',
        lastTargetVersion: '0.1.1',
        lastTargetRevision: '2222222222222222222222222222222222222222',
        lastError: null,
        pausedUntil: null,
      },
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
      autoUpgrade: {
        attemptCount: 1,
        successCount: 1,
        failureCount: 0,
        noChangeCount: 0,
        consecutiveFailureCount: 0,
        lastAttemptAt: '2026-04-05T08:11:05.000Z',
        lastSuccessAt: '2026-04-05T08:11:05.000Z',
        lastOutcome: 'succeeded',
        lastTargetVersion: '0.1.1',
        lastTargetRevision: '2222222222222222222222222222222222222222',
        lastError: null,
        pausedUntil: null,
      },
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

  test('pauses working-issue resume while a lineage-block cooldown is active', () => {
    const now = Date.now()

    expect(shouldResumeManagedIssue(
      { state: 'working' },
      true,
      1,
      now + 60_000,
      now,
      2,
    )).toBe(false)

    expect(shouldResumeManagedIssue(
      { state: 'working' },
      true,
      1,
      now - 1,
      now,
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
    expect(shouldClearFailedIssueResumeTrackingAfterFinalize('blocked')).toBe(false)
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

  test('stops at human-needed when a blocked refresh rerun is still rejected', () => {
    expect(classifyStandalonePrReviewFollowup(
      {
        approved: false,
        canMerge: false,
        reason: 'First blocker',
        findings: [{
          severity: 'high',
          file: 'apps/agent-daemon/src/daemon.ts',
          summary: 'still blocked after base refresh',
          mustFix: ['stop after the rerun review and leave the PR in human-needed'],
          mustNotDo: ['do not launch review auto-fix for the blocked refresh rerun'],
          validation: ['bun test apps/agent-daemon/src/daemon.test.ts'],
          scopeRationale: 'blocked refresh reruns should release the ready queue instead of consuming another auto-fix attempt',
        }],
      },
      {
        issueNumber: 40,
        rerunAfterBlockedRefresh: true,
      },
    )).toEqual({
      nextReviewLabel: 'human-needed',
      shouldRunAutoFix: false,
      shouldMarkIssueFailed: true,
    })
  })

  test('still allows one auto-fix retry for a normal standalone rejection', () => {
    expect(classifyStandalonePrReviewFollowup(
      {
        approved: false,
        canMerge: false,
        reason: 'First blocker',
        findings: [{
          severity: 'high',
          file: 'apps/agent-daemon/src/daemon.ts',
          summary: 'ordinary standalone rejection',
          mustFix: ['keep the existing auto-fix retry path'],
          mustNotDo: ['do not treat every rejection as terminal human-needed'],
          validation: ['bun test apps/agent-daemon/src/daemon.test.ts'],
          scopeRationale: 'only blocked refresh reruns should skip auto-fix',
        }],
      },
      {
        issueNumber: 40,
        rerunAfterBlockedRefresh: false,
      },
    )).toEqual({
      nextReviewLabel: 'retry',
      shouldRunAutoFix: true,
      shouldMarkIssueFailed: false,
    })
  })

  test('keeps approved blocked refresh reruns on the approved path', () => {
    expect(classifyStandalonePrReviewFollowup(
      {
        approved: true,
        canMerge: true,
        reason: 'Ready to merge',
      },
      {
        issueNumber: 40,
        rerunAfterBlockedRefresh: true,
      },
    )).toEqual({
      nextReviewLabel: 'approved',
      shouldRunAutoFix: false,
      shouldMarkIssueFailed: false,
    })
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

  describe('approved PR merge checks gate', () => {
    test('defers pending checks without forcing the linked issue into failed', () => {
      expect(classifyApprovedPrMergeChecksGate({
        state: 'pending',
        summary: 'build-and-test is pending',
      })).toEqual({
        outcome: 'defer',
        recoverable: true,
        reason: 'PR checks not ready for merge: build-and-test is pending',
      })
    })

    test('routes failing checks to human-needed', () => {
      expect(classifyApprovedPrMergeChecksGate({
        state: 'fail',
        summary: 'build-and-test is fail',
      })).toEqual({
        outcome: 'human-needed',
        recoverable: false,
        reason: 'PR checks failed: build-and-test is fail',
      })
    })

    test('skips merge calls when checks fail and keeps the linked issue recoverable', async () => {
      const daemon = createTestDaemon()
      const comments: string[] = []
      const reviewStates: string[] = []
      let mergeCalls = 0

      ;(daemon as any).getPullRequestChecksStatus = async () => ({
        state: 'fail',
        summary: 'build-and-test is fail',
      })
      ;(daemon as any).commentOnManagedPr = async (_prNumber: number, body: string) => {
        comments.push(body)
      }
      ;(daemon as any).setManagedPrReviewState = async (_prNumber: number, state: string) => {
        reviewStates.push(state)
      }
      ;(daemon as any).mergeManagedPullRequest = async () => {
        mergeCalls += 1
        return { merged: true, message: 'unexpected merge' }
      }

      const mergeResult = await (daemon as any).attemptApprovedPrMergeWithRecovery(
        110,
        'https://github.com/JamesWuHK/agent-loop/pull/110',
        'agent/61/codex-dev',
        '/tmp/worktrees/issue-61-codex-dev',
      )

      expect(mergeCalls).toBe(0)
      expect(reviewStates).toEqual(['human-needed'])
      expect(comments).toHaveLength(1)
      expect(comments[0]).toContain('PR checks failed: build-and-test is fail')
      expect(mergeResult).toMatchObject({
        merged: false,
        message: 'PR checks failed: build-and-test is fail',
        checksBlocked: true,
      })
      expect(classifyLinkedIssueApprovedMergeOutcome(mergeResult)).toEqual({
        status: 'recoverable',
        reason: 'PR checks failed: build-and-test is fail',
      })
    })

    test('treats check lookup errors as recoverable deferrals', () => {
      expect(classifyApprovedPrMergeChecksGate({
        state: 'error',
        summary: 'gh pr checks exited with code 4',
      })).toEqual({
        outcome: 'defer',
        recoverable: true,
        reason: 'Merge gate could not confirm PR checks: gh pr checks exited with code 4',
      })
    })

    test('keeps true merge failures on the failed linked-issue path', () => {
      expect(classifyLinkedIssueApprovedMergeOutcome({
        merged: false,
        message: 'Pull Request is not mergeable',
      })).toEqual({
        status: 'failed',
        reason: 'Pull Request is not mergeable',
      })
    })
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
