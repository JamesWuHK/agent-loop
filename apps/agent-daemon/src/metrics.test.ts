import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  recordPoll,
  recordClaim,
  recordIssueProcessed,
  recordAgentExecution,
  recordPrReviewOutcome,
  recordReviewAutoFixOutcome,
  recordPrMergeRecoveryOutcome,
  recordLeaseConflict,
  recordRecoveryAction,
  recordTransientLoopError,
  recordGitHubApiRequest,
  recordWorkerIdleTimeout,
  recordQueuedWakeRequest,
  recordHandledWakeRequest,
  recordPrCreated,
  setActiveWorktrees,
  setActivePrReviews,
  setActiveLeases,
  setBlockedIssueResumes,
  setBlockedIssueResumeAgeSeconds,
  setBlockedIssueResumeEscalations,
  setBlockedIssueResumeEscalationAgeSeconds,
  setLastTransientLoopErrorAgeSeconds,
  setNextPollDelaySeconds,
  setPendingWakeRequests,
  setAutoUpgradeSnapshot,
  setInFlightIssueProcesses,
  setInFlightPrReviews,
  setLeaseHeartbeatAgeSeconds,
  setStartupRecoveryPending,
  setStalledWorkers,
  setEffectiveActiveTasks,
  setProjectInfo,
  setConcurrencyLimit,
  setConcurrencyPolicy,
  setDaemonUptime,
  recordPollDuration,
  recordIssueProcessingDuration,
  getMetrics,
  getContentType,
  registry,
  startMetricsServer,
} from './metrics'

describe('metrics', () => {
  beforeEach(() => {
    // Reset all metrics before each test
    registry.resetMetrics()
  })

  afterEach(() => {
    registry.resetMetrics()
  })

  describe('recordPoll', () => {
    test('increments polls_total counter with correct label', async () => {
      recordPoll('success')
      recordPoll('no_issues')
      recordPoll('skipped_concurrency')
      recordPoll('error')

      const metrics = await getMetrics()
      expect(metrics).toContain('agent_loop_polls_total')
      expect(metrics).toContain('result="success"')
      expect(metrics).toContain('result="no_issues"')
      expect(metrics).toContain('result="skipped_concurrency"')
      expect(metrics).toContain('result="error"')
    })
  })

  describe('recordClaim', () => {
    test('increments claims_total counter with correct labels', async () => {
      recordClaim('claimed')
      recordClaim('already_claimed')
      recordClaim('rate_limited')
      recordClaim('error')

      const metrics = await getMetrics()
      expect(metrics).toContain('agent_loop_claims_total')
      expect(metrics).toContain('outcome="claimed"')
      expect(metrics).toContain('outcome="already_claimed"')
      expect(metrics).toContain('outcome="rate_limited"')
      expect(metrics).toContain('outcome="error"')
    })

    test('increments rate_limit_hits_total when rate limited', async () => {
      recordClaim('rate_limited')

      const metrics = await getMetrics()
      expect(metrics).toContain('agent_loop_rate_limit_hits_total')
    })
  })

  describe('recordIssueProcessed', () => {
    test('increments issues_processed_total counter with correct labels', async () => {
      recordIssueProcessed('done')
      recordIssueProcessed('failed')
      recordIssueProcessed('error')

      const metrics = await getMetrics()
      expect(metrics).toContain('agent_loop_issues_processed_total')
      expect(metrics).toContain('outcome="done"')
      expect(metrics).toContain('outcome="failed"')
      expect(metrics).toContain('outcome="error"')
    })
  })

  describe('recordAgentExecution', () => {
    test('increments agent_executions_total counter with correct labels', async () => {
      recordAgentExecution(true, 'claude', 5000)
      recordAgentExecution(false, 'codex', 3000)
      recordAgentExecution(true, 'fallback', 10000)

      const metrics = await getMetrics()
      expect(metrics).toContain('agent_loop_agent_executions_total')
      expect(metrics).toContain('success="true"')
      expect(metrics).toContain('success="false"')
      expect(metrics).toContain('agent_type="claude"')
      expect(metrics).toContain('agent_type="codex"')
      expect(metrics).toContain('agent_type="fallback"')
    })

    test('records execution duration in histogram', async () => {
      recordAgentExecution(true, 'claude', 5000)

      const metrics = await getMetrics()
      expect(metrics).toContain('agent_loop_agent_execution_duration_seconds')
    })
  })

  describe('review and merge metrics', () => {
    test('increments pr_reviews_total counter with stage and outcome labels', async () => {
      recordPrReviewOutcome('initial', 'approved')
      recordPrReviewOutcome('post_fix', 'rejected')
      recordPrReviewOutcome('merge_refresh', 'invalid_output')

      const metrics = await getMetrics()
      expect(metrics).toContain('agent_loop_pr_reviews_total')
      expect(metrics).toContain('stage="initial"')
      expect(metrics).toContain('stage="post_fix"')
      expect(metrics).toContain('stage="merge_refresh"')
      expect(metrics).toContain('outcome="approved"')
      expect(metrics).toContain('outcome="rejected"')
      expect(metrics).toContain('outcome="invalid_output"')
    })

    test('increments review_auto_fixes_total counter with outcome labels', async () => {
      recordReviewAutoFixOutcome('committed')
      recordReviewAutoFixOutcome('salvaged')
      recordReviewAutoFixOutcome('push_failed')

      const metrics = await getMetrics()
      expect(metrics).toContain('agent_loop_review_auto_fixes_total')
      expect(metrics).toContain('outcome="committed"')
      expect(metrics).toContain('outcome="salvaged"')
      expect(metrics).toContain('outcome="push_failed"')
    })

    test('increments pr_merge_recovery_total counter with outcome labels', async () => {
      recordPrMergeRecoveryOutcome('merged_initial')
      recordPrMergeRecoveryOutcome('refresh_push_failed')
      recordPrMergeRecoveryOutcome('merged_after_refresh')

      const metrics = await getMetrics()
      expect(metrics).toContain('agent_loop_pr_merge_recovery_total')
      expect(metrics).toContain('outcome="merged_initial"')
      expect(metrics).toContain('outcome="refresh_push_failed"')
      expect(metrics).toContain('outcome="merged_after_refresh"')
    })

    test('tracks lease conflicts, recovery actions, and worker idle timeouts', async () => {
      recordLeaseConflict('issue-process')
      recordRecoveryAction('issue-process-idle-timeout', 'recoverable')
      recordTransientLoopError('startup-recovery')
      recordWorkerIdleTimeout('pr-review')

      const metrics = await getMetrics()
      expect(metrics).toContain('agent_loop_lease_conflicts_total')
      expect(metrics).toContain('scope="issue-process"')
      expect(metrics).toContain('agent_loop_recovery_actions_total')
      expect(metrics).toContain('kind="issue-process-idle-timeout"')
      expect(metrics).toContain('outcome="recoverable"')
      expect(metrics).toContain('agent_loop_transient_loop_errors_total')
      expect(metrics).toContain('kind="startup-recovery"')
      expect(metrics).toContain('agent_loop_worker_idle_timeouts_total')
      expect(metrics).toContain('scope="pr-review"')
    })

    test('tracks github api request outcomes and durations', async () => {
      recordGitHubApiRequest('graphql', 'direct', 'success', 250)
      recordGitHubApiRequest('rest', 'gh_cli', 'rate_limited', 500)

      const metrics = await getMetrics()
      expect(metrics).toContain('agent_loop_github_api_requests_total')
      expect(metrics).toContain('transport="graphql"')
      expect(metrics).toContain('transport="rest"')
      expect(metrics).toContain('mode="direct"')
      expect(metrics).toContain('mode="gh_cli"')
      expect(metrics).toContain('outcome="success"')
      expect(metrics).toContain('outcome="rate_limited"')
      expect(metrics).toContain('agent_loop_github_api_request_duration_seconds')
    })

    test('tracks persisted auto-upgrade counts and ages', async () => {
      setAutoUpgradeSnapshot({
        attemptCount: 3,
        successCount: 1,
        failureCount: 1,
        noChangeCount: 1,
        lastAttemptAt: '2026-04-11T12:10:00.000Z',
        lastSuccessAt: '2026-04-11T12:00:00.000Z',
        lastOutcome: 'failed',
        lastTargetVersion: '0.1.2',
        lastTargetRevision: '2222222222222222222222222222222222222222',
        lastError: 'git pull failed',
      }, Date.parse('2026-04-11T12:15:00.000Z'))

      const metrics = await getMetrics()
      expect(metrics).toContain('agent_loop_auto_upgrade_attempts 3')
      expect(metrics).toContain('agent_loop_auto_upgrade_successes 1')
      expect(metrics).toContain('agent_loop_auto_upgrade_failures 1')
      expect(metrics).toContain('agent_loop_auto_upgrade_no_changes 1')
      expect(metrics).toContain('agent_loop_auto_upgrade_last_attempt_age_seconds 300')
      expect(metrics).toContain('agent_loop_auto_upgrade_last_success_age_seconds 900')
    })

    test('tracks wake queue and handling outcomes', async () => {
      recordQueuedWakeRequest('issue')
      recordHandledWakeRequest('issue', 'started_work', '2026-04-11T09:10:00.000Z', Date.parse('2026-04-11T09:10:05.000Z'))
      recordHandledWakeRequest('now', 'allow_fallback', '2026-04-11T09:11:00.000Z', Date.parse('2026-04-11T09:11:01.000Z'))

      const metrics = await getMetrics()
      expect(metrics).toContain('agent_loop_wake_requests_total')
      expect(metrics).toContain('kind="issue"')
      expect(metrics).toContain('kind="now"')
      expect(metrics).toContain('outcome="queued"')
      expect(metrics).toContain('outcome="started_work"')
      expect(metrics).toContain('outcome="allow_fallback"')
      expect(metrics).toContain('agent_loop_wake_request_age_seconds')
    })
  })

  describe('recordPrCreated', () => {
    test('increments prs_created_total counter', async () => {
      recordPrCreated()
      recordPrCreated()

      const metrics = await getMetrics()
      expect(metrics).toContain('agent_loop_prs_created_total')
    })
  })

  describe('gauges', () => {
    test('setActiveWorktrees sets the active worktrees gauge', async () => {
      setActiveWorktrees(5)
      setActiveWorktrees(3)

      const metrics = await getMetrics()
      expect(metrics).toContain('agent_loop_active_worktrees')
    })

    test('tracks active PR reviews and in-flight task gauges', async () => {
      setActivePrReviews(2)
      setActiveLeases(3)
      setBlockedIssueResumes(1)
      setBlockedIssueResumeAgeSeconds(45)
      setBlockedIssueResumeEscalations(1)
      setBlockedIssueResumeEscalationAgeSeconds(15)
      setLastTransientLoopErrorAgeSeconds(12)
      setNextPollDelaySeconds(5)
      setPendingWakeRequests(2)
      setInFlightIssueProcesses(true)
      setInFlightPrReviews(false)
      setStartupRecoveryPending(true)
      setLeaseHeartbeatAgeSeconds(42)
      setStalledWorkers(1)
      setEffectiveActiveTasks(3)

      const metrics = await getMetrics()
      expect(metrics).toContain('agent_loop_active_pr_reviews')
      expect(metrics).toContain('agent_loop_active_leases')
      expect(metrics).toContain('agent_loop_blocked_issue_resumes')
      expect(metrics).toContain('agent_loop_blocked_issue_resume_age_seconds')
      expect(metrics).toContain('agent_loop_blocked_issue_resume_escalations')
      expect(metrics).toContain('agent_loop_blocked_issue_resume_escalation_age_seconds')
      expect(metrics).toContain('agent_loop_last_transient_loop_error_age_seconds')
      expect(metrics).toContain('agent_loop_next_poll_delay_seconds')
      expect(metrics).toContain('agent_loop_pending_wake_requests')
      expect(metrics).toContain('agent_loop_inflight_issue_processes')
      expect(metrics).toContain('agent_loop_inflight_pr_reviews')
      expect(metrics).toContain('agent_loop_startup_recovery_pending')
      expect(metrics).toContain('agent_loop_lease_heartbeat_age_seconds')
      expect(metrics).toContain('agent_loop_stalled_workers')
      expect(metrics).toContain('agent_loop_effective_active_tasks')
    })

    test('setConcurrencyLimit sets the concurrency limit gauge', async () => {
      setConcurrencyLimit(4)

      const metrics = await getMetrics()
      expect(metrics).toContain('agent_loop_concurrency_limit')
    })

    test('setConcurrencyPolicy publishes requested, effective, and cap values', async () => {
      setConcurrencyPolicy({
        requested: 5,
        effective: 2,
        repoCap: 4,
        profileCap: 2,
        projectCap: 3,
      })

      const metrics = await getMetrics()
      expect(metrics).toContain('agent_loop_concurrency_policy')
      expect(metrics).toContain('kind="requested"')
      expect(metrics).toContain('kind="effective"')
      expect(metrics).toContain('kind="repo_cap"')
      expect(metrics).toContain('kind="profile_cap"')
      expect(metrics).toContain('kind="project_cap"')
    })

    test('setDaemonUptime sets the uptime gauge', async () => {
      setDaemonUptime(3600)

      const metrics = await getMetrics()
      expect(metrics).toContain('agent_loop_uptime_seconds')
    })

    test('publishes project info labels for project profile and agent selection', async () => {
      setProjectInfo({
        repo: 'JamesWuHK/digital-employee',
        profile: 'desktop-vite',
        primaryAgent: 'codex',
        fallbackAgent: 'claude',
        defaultBranch: 'main',
        machineId: 'codex-verify',
      })

      const metrics = await getMetrics()
      expect(metrics).toContain('agent_loop_project_info')
      expect(metrics).toContain('repo="JamesWuHK/digital-employee"')
      expect(metrics).toContain('profile="desktop-vite"')
      expect(metrics).toContain('primary_agent="codex"')
      expect(metrics).toContain('fallback_agent="claude"')
      expect(metrics).toContain('default_branch="main"')
      expect(metrics).toContain('machine_id="codex-verify"')
    })
  })

  describe('histograms', () => {
    test('recordPollDuration records poll duration', async () => {
      recordPollDuration(1500)

      const metrics = await getMetrics()
      expect(metrics).toContain('agent_loop_poll_duration_seconds')
    })

    test('recordIssueProcessingDuration records processing duration', async () => {
      recordIssueProcessingDuration(60000)

      const metrics = await getMetrics()
      expect(metrics).toContain('agent_loop_issue_processing_duration_seconds')
    })
  })

  describe('getMetrics', () => {
    test('returns metrics in Prometheus exposition format', async () => {
      recordPoll('success')
      const metrics = await getMetrics()

      expect(typeof metrics).toBe('string')
      expect(metrics.length).toBeGreaterThan(0)
      // Prometheus format should contain HELP and TYPE comments
      expect(metrics).toContain('# HELP')
      expect(metrics).toContain('# TYPE')
    })
  })

  describe('getContentType', () => {
    test('returns correct content type for Prometheus', () => {
      const contentType = getContentType()
      expect(contentType).toContain('text/plain')
    })
  })

  describe('startMetricsServer', () => {
    test('refreshes gauges before serving metrics', async () => {
      let refreshed = false
      const server = await startMetricsServer(0, console, () => {
        refreshed = true
        setBlockedIssueResumeAgeSeconds(21)
      })

      try {
        const body = await Bun.$`curl --noproxy '*' -s http://127.0.0.1:${server.port}/metrics`.quiet().text()

        expect(refreshed).toBe(true)
        expect(body).toContain('agent_loop_blocked_issue_resume_age_seconds 21')
      } finally {
        server.stop()
      }
    })
  })

  describe('default Node.js metrics', () => {
    test('includes default Node.js metrics', async () => {
      const metrics = await getMetrics()
      // prom-client includes default metrics like process_resident_memory_bytes
      expect(metrics).toContain('process_resident_memory_bytes')
    })
  })
})
