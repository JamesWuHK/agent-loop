import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentConfig } from '@agent/shared'
import {
  AgentDaemon,
  buildDaemonRuntimeStatus,
  getEffectiveActiveTaskCount,
  buildPrMergeRetryComment,
  getStandaloneIssueTransitionForReviewLabels,
  isRetryableDaemonLoopError,
  isMergeabilityFailure,
  rebaseManagedBranchOntoDefault,
  shouldApplyStandaloneIssueTransition,
  shouldResetLinkedPrToRetryOnIssueResume,
  shouldRequeueFailedIssue,
  shouldResumeManagedIssue,
} from './daemon'
import { ISSUE_LABELS, PR_REVIEW_LABELS } from '@agent/shared'

describe('daemon merge recovery helpers', () => {
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
    })
  })

  test('counts in-flight issue work before a worktree is registered', () => {
    expect(getEffectiveActiveTaskCount({
      activeWorktreeCount: 0,
      hasInFlightProcess: true,
      activePrReviewCount: 0,
      hasInFlightPrReview: false,
    })).toBe(1)
  })

  test('does not double-count work that already has an active slot', () => {
    expect(getEffectiveActiveTaskCount({
      activeWorktreeCount: 1,
      hasInFlightProcess: true,
      activePrReviewCount: 1,
      hasInFlightPrReview: true,
    })).toBe(2)
  })

  test('builds runtime status snapshots for health and metrics surfaces', () => {
    expect(buildDaemonRuntimeStatus({
      activeWorktreeCount: 1,
      activePrReviewCount: 2,
      hasInFlightProcess: true,
      hasInFlightPrReview: true,
      startupRecoveryPending: true,
      failedIssueResumeAttemptCount: 3,
      failedIssueResumeCooldownCount: 2,
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
    })).toEqual({
      activePrReviews: 2,
      inFlightIssueProcess: true,
      inFlightPrReview: true,
      startupRecoveryPending: true,
      effectiveActiveTasks: 3,
      failedIssueResumeAttemptsTracked: 3,
      failedIssueResumeCooldownsTracked: 2,
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
    })
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

  test('resets linked PR labels back to retry when issue recovery resumes', () => {
    expect(shouldResetLinkedPrToRetryOnIssueResume([PR_REVIEW_LABELS.HUMAN_NEEDED])).toBe(true)
    expect(shouldResetLinkedPrToRetryOnIssueResume([PR_REVIEW_LABELS.FAILED])).toBe(true)
    expect(shouldResetLinkedPrToRetryOnIssueResume([PR_REVIEW_LABELS.FAILED, PR_REVIEW_LABELS.HUMAN_NEEDED])).toBe(true)
    expect(shouldResetLinkedPrToRetryOnIssueResume([PR_REVIEW_LABELS.RETRY])).toBe(false)
    expect(shouldResetLinkedPrToRetryOnIssueResume([PR_REVIEW_LABELS.APPROVED])).toBe(false)
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
