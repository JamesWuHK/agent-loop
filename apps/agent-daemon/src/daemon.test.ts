import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentConfig } from '@agent/shared'
import {
  AgentDaemon,
  buildIssueWorkingTransitionEvent,
  buildBlockedIssueResumeEscalationComment,
  buildDaemonRuntimeStatus,
  buildIssuePreflightFailureComment,
  buildPrReviewRefreshFailureComment,
  canRetryPrReviewRefresh,
  getEffectiveActiveTaskCount,
  buildPrMergeRetryComment,
  extractAutomatedIssuePreflightReasons,
  extractBlockedIssueResumeEscalationComment,
  getResumableIssueLinkedPrHandoff,
  getFailedIssueResumeBlock,
  listBlockedIssueResumeEscalationComments,
  shouldClearFailedIssueResumeTrackingAfterFinalize,
  shouldEscalateBlockedIssueResume,
  shouldRefreshBlockedHumanNeededPr,
  shouldResumeFailedIssueWithLinkedPr,
  getStandaloneIssueTransitionForReviewLabels,
  isRetryableDaemonLoopError,
  isMergeabilityFailure,
  rebaseManagedBranchOntoDefault,
  shouldApplyStandaloneIssueTransition,
  shouldResetLinkedPrToRetryOnIssueResume,
  shouldCompleteIssueRecoveryOnRemoteClose,
  shouldRequeueFailedIssue,
  shouldResumeManagedIssue,
} from './daemon'
import { ISSUE_LABELS, PR_REVIEW_LABELS } from '@agent/shared'

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

describe('daemon merge recovery helpers', () => {
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
})
