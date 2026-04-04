import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  recordPoll,
  recordClaim,
  recordIssueProcessed,
  recordAgentExecution,
  recordPrReviewOutcome,
  recordReviewAutoFixOutcome,
  recordPrMergeRecoveryOutcome,
  recordPrCreated,
  setActiveWorktrees,
  setActivePrReviews,
  setInFlightIssueProcesses,
  setInFlightPrReviews,
  setStartupRecoveryPending,
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
      setInFlightIssueProcesses(true)
      setInFlightPrReviews(false)
      setStartupRecoveryPending(true)
      setEffectiveActiveTasks(3)

      const metrics = await getMetrics()
      expect(metrics).toContain('agent_loop_active_pr_reviews')
      expect(metrics).toContain('agent_loop_inflight_issue_processes')
      expect(metrics).toContain('agent_loop_inflight_pr_reviews')
      expect(metrics).toContain('agent_loop_startup_recovery_pending')
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

  describe('default Node.js metrics', () => {
    test('includes default Node.js metrics', async () => {
      const metrics = await getMetrics()
      // prom-client includes default metrics like process_resident_memory_bytes
      expect(metrics).toContain('process_resident_memory_bytes')
    })
  })
})
