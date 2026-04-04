import { describe, expect, test } from 'bun:test'
import type { DaemonStatus } from '@agent/shared'
import {
  formatDoctorReport,
  formatStatusReport,
  parsePrometheusSamples,
  summarizeDaemonMetrics,
} from './status'

const baseHealth: DaemonStatus & {
  status: 'running'
  mode: 'agent-loop-daemon'
  version: '0.1.0'
} = {
  status: 'running',
  mode: 'agent-loop-daemon',
  version: '0.1.0',
  running: true,
  machineId: 'codex-dev',
  repo: 'JamesWuHK/digital-employee',
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
  project: {
    profile: 'desktop-vite',
    defaultBranch: 'main',
    maxConcurrency: 3,
  },
  agent: {
    primary: 'codex',
    fallback: 'claude',
  },
  endpoints: {
    health: {
      host: '127.0.0.1',
      port: 9310,
      path: '/health',
    },
    metrics: {
      host: '127.0.0.1',
      port: 9090,
      path: '/metrics',
    },
  },
  runtime: {
    activePrReviews: 1,
    inFlightIssueProcess: true,
    inFlightPrReview: false,
    startupRecoveryPending: true,
    effectiveActiveTasks: 2,
    failedIssueResumeAttemptsTracked: 1,
    failedIssueResumeCooldownsTracked: 1,
  },
  activeWorktrees: [
    {
      path: '/tmp/issue-77-codex-dev',
      issueNumber: 77,
      machineId: 'codex-dev',
      branch: 'agent/77/codex-dev',
      state: 'active',
      createdAt: '2026-04-05T08:00:00.000Z',
    },
  ],
  lastPollAt: '2026-04-05T08:10:00.000Z',
  lastClaimedAt: '2026-04-05T08:09:00.000Z',
  uptimeMs: 125_000,
  pid: 12345,
}

const metricsText = `
# HELP agent_loop_polls_total Total number of poll cycles executed
agent_loop_polls_total{result="success"} 12
agent_loop_polls_total{result="skipped_concurrency"} 3
agent_loop_polls_total{result="no_issues"} 4
agent_loop_polls_total{result="error"} 1
agent_loop_pr_reviews_total{stage="initial",outcome="approved"} 2
agent_loop_pr_reviews_total{stage="post_fix",outcome="rejected"} 1
agent_loop_pr_reviews_total{stage="merge_refresh",outcome="execution_failed"} 1
agent_loop_review_auto_fixes_total{outcome="committed"} 2
agent_loop_review_auto_fixes_total{outcome="push_failed"} 1
agent_loop_pr_merge_recovery_total{outcome="merged_initial"} 1
agent_loop_pr_merge_recovery_total{outcome="refresh_push_failed"} 1
agent_loop_rate_limit_hits_total 0
`

describe('status helpers', () => {
  test('parses Prometheus samples with labels', () => {
    expect(parsePrometheusSamples(metricsText)).toContainEqual({
      name: 'agent_loop_pr_reviews_total',
      labels: {
        stage: 'initial',
        outcome: 'approved',
      },
      value: 2,
    })
  })

  test('summarizes daemon metrics into review/autofix/merge buckets', () => {
    expect(summarizeDaemonMetrics(metricsText)).toEqual({
      polls: {
        success: 12,
        skipped_concurrency: 3,
        no_issues: 4,
        error: 1,
      },
      prReviews: {
        initial: {
          approved: 2,
        },
        post_fix: {
          rejected: 1,
        },
        merge_refresh: {
          execution_failed: 1,
        },
      },
      autoFixes: {
        committed: 2,
        push_failed: 1,
      },
      mergeRecovery: {
        merged_initial: 1,
        refresh_push_failed: 1,
      },
      rateLimitHits: 0,
    })
  })

  test('formats a concise status report with concurrency caps and warnings', () => {
    const report = formatStatusReport({
      ok: true,
      healthUrl: 'http://127.0.0.1:9310/health',
      metricsUrl: 'http://127.0.0.1:9090/metrics',
      error: null,
      health: baseHealth,
      metrics: summarizeDaemonMetrics(metricsText),
      metricsError: null,
      warnings: [
        'startup recovery is still pending; the daemon is waiting to finish its GitHub/network reconcile',
      ],
    })

    expect(report).toContain('repo: JamesWuHK/digital-employee')
    expect(report).toContain('concurrency: effective 2 (requested 5; repo cap 4; profile cap 2; project cap 3)')
    expect(report).toContain('outcomes: polls success=12, skipped_concurrency=3, no_issues=4, error=1')
    expect(report).toContain('warnings: startup recovery is still pending')
  })

  test('formats a doctor report with worktrees and metrics warnings', () => {
    const report = formatDoctorReport({
      ok: true,
      healthUrl: 'http://127.0.0.1:9310/health',
      metricsUrl: 'http://127.0.0.1:9090/metrics',
      error: null,
      health: baseHealth,
      metrics: summarizeDaemonMetrics(metricsText),
      metricsError: null,
      warnings: [
        'startup recovery is still pending; the daemon is waiting to finish its GitHub/network reconcile',
        'review auto-fix push failures observed: 1',
      ],
    })

    expect(report).toContain('Daemon Doctor')
    expect(report).toContain('project max concurrency: 3')
    expect(report).toContain('Active Worktrees')
    expect(report).toContain('#77 agent/77/codex-dev /tmp/issue-77-codex-dev')
    expect(report).toContain('merge-recovery: merged_initial=1')
    expect(report).toContain('- review auto-fix push failures observed: 1')
  })
})
