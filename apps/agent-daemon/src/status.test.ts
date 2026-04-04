import { describe, expect, test } from 'bun:test'
import type { DaemonStatus } from '@agent/shared'
import {
  collectDaemonObservability,
  collectGitHubLeaseAudit,
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
  daemonInstanceId: 'daemon-codex-dev-1',
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
  recovery: {
    heartbeatIntervalMs: 30_000,
    leaseTtlMs: 60_000,
    workerIdleTimeoutMs: 300_000,
    leaseAdoptionBackoffMs: 5_000,
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
    activeLeaseCount: 2,
    oldestLeaseHeartbeatAgeSeconds: 75,
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
        heartbeatAgeSeconds: 75,
        progressAgeSeconds: 42,
        expiresInSeconds: 0,
        adoptable: true,
      },
      {
        scope: 'pr-review',
        targetNumber: 108,
        commentId: 18,
        issueNumber: 89,
        prNumber: 108,
        machineId: 'codex-dev',
        daemonInstanceId: 'daemon-codex-dev-1',
        branch: 'agent/89/codex-dev',
        worktreeId: 'pr-review-108',
        phase: 'pr-review',
        attempt: 1,
        status: 'active',
        lastProgressKind: 'phase',
        heartbeatAgeSeconds: 15,
        progressAgeSeconds: 5,
        expiresInSeconds: 45,
        adoptable: false,
      },
    ],
    stalledWorkerCount: 1,
    stalledWorkerDetails: [
      {
        scope: 'issue-process',
        targetNumber: 77,
        since: '2026-04-05T08:07:15.000Z',
        durationSeconds: 75,
        reason: 'worker idle timeout',
      },
    ],
    lastRecoveryActionAt: '2026-04-05T08:08:30.000Z',
    lastRecoveryActionKind: 'issue-process-idle-timeout',
    recentRecoveryActions: [
      {
        at: '2026-04-05T08:08:30.000Z',
        kind: 'issue-process-idle-timeout',
        outcome: 'recoverable',
        scope: 'issue-process',
        targetNumber: 77,
        reason: 'worker idle timeout',
      },
      {
        at: '2026-04-05T08:06:00.000Z',
        kind: 'issue-process-idle-timeout',
        outcome: 'recoverable',
        scope: 'issue-process',
        targetNumber: 77,
        reason: 'worker idle timeout',
      },
    ],
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
agent_loop_recovery_actions_total{kind="issue-process-idle-timeout",outcome="recoverable"} 2
agent_loop_worker_idle_timeouts_total{scope="issue-process"} 2
agent_loop_active_leases 2
agent_loop_lease_heartbeat_age_seconds 75
agent_loop_stalled_workers 1
agent_loop_lease_conflicts_total{scope="issue-process"} 1
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
      recoveryActions: {
        'issue-process-idle-timeout': {
          recoverable: 2,
        },
      },
      workerIdleTimeouts: {
        'issue-process': 2,
      },
      activeLeases: 2,
      leaseHeartbeatAgeSeconds: 75,
      stalledWorkers: 1,
      leaseConflicts: 1,
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
      githubAudit: null,
      warnings: [
        'startup recovery is still pending; the daemon is waiting to finish its GitHub/network reconcile',
      ],
    })

    expect(report).toContain('repo: JamesWuHK/digital-employee')
    expect(report).toContain('daemon: codex-dev / daemon-codex-dev-1')
    expect(report).toContain('concurrency: effective 2 (requested 5; repo cap 4; profile cap 2; project cap 3)')
    expect(report).toContain('leases: active 2 | oldest heartbeat 75s | stalled 1 | last recovery issue-process-idle-timeout @ 2026-04-05T08:08:30.000Z')
    expect(report).toContain('lease detail: issue-process#77 implementation hb=75s progress=42s adoptable=yes')
    expect(report).toContain('recent recovery: issue-process-idle-timeout/recoverable issue-process#77')
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
      githubAudit: {
        ok: true,
        error: null,
        checks: [
          {
            scope: 'issue-process',
            targetNumber: 77,
            state: 'open',
            labels: ['agent:stale'],
            warning: 'issue-process#77 has an active lease but issue state is stale (expected working)',
          },
        ],
        warnings: [
          'issue-process#77 has an active lease but issue state is stale (expected working)',
        ],
      },
      warnings: [
        'startup recovery is still pending; the daemon is waiting to finish its GitHub/network reconcile',
        'review auto-fix push failures observed: 1',
      ],
    })

    expect(report).toContain('Daemon Doctor')
    expect(report).toContain('project max concurrency: 3')
    expect(report).toContain('daemon instance: daemon-codex-dev-1')
    expect(report).toContain('Active Worktrees')
    expect(report).toContain('#77 agent/77/codex-dev /tmp/issue-77-codex-dev')
    expect(report).toContain('Active Leases')
    expect(report).toContain('issue-process#77 comment=11')
    expect(report).toContain('pr-review#108 comment=18')
    expect(report).toContain('Stalled Workers')
    expect(report).toContain('issue-process#77 stuck 75s')
    expect(report).toContain('Recent Recovery Actions')
    expect(report).toContain('issue-process-idle-timeout/recoverable | target=issue-process#77')
    expect(report).toContain('GitHub Audit')
    expect(report).toContain('issue-process#77 | state=open | labels=agent:stale | warning=issue-process#77 has an active lease but issue state is stale (expected working)')
    expect(report).toContain('merge-recovery: merged_initial=1')
    expect(report).toContain('worker-idle-timeouts: issue-process=2')
    expect(report).toContain('- review auto-fix push failures observed: 1')
  })

  test('doctor warnings call out adoptable leases and repeated recoveries for the same target', async () => {
    const metricsServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(metricsText, {
        headers: { 'content-type': 'text/plain' },
      }),
    })

    const healthPayload = {
      ...baseHealth,
      endpoints: {
        ...baseHealth.endpoints,
        metrics: {
          host: '127.0.0.1',
          port: metricsServer.port,
          path: '/metrics',
        },
      },
    }

    const healthServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json(healthPayload),
    })

    try {
      const snapshot = await collectDaemonObservability({
        healthHost: '127.0.0.1',
        healthPort: healthServer.port,
      })
      const report = formatDoctorReport(snapshot)

      expect(snapshot.warnings).toContain('adoptable leases detected: issue-process#77')
      expect(snapshot.warnings).toContain('same target recovered multiple times recently: issue-process#77=2')
      expect(report).toContain('- adoptable leases detected: issue-process#77')
      expect(report).toContain('- same target recovered multiple times recently: issue-process#77=2')
    } finally {
      healthServer.stop(true)
      metricsServer.stop(true)
    }
  })

  test('collects GitHub audit warnings for lease-label mismatches', async () => {
    const audit = await collectGitHubLeaseAudit({
      repo: 'JamesWuHK/digital-employee',
      runtime: {
        ...baseHealth.runtime,
        activeLeaseDetails: [
          baseHealth.runtime.activeLeaseDetails[0]!,
          {
            ...baseHealth.runtime.activeLeaseDetails[1]!,
            scope: 'pr-merge',
          },
        ],
      },
    }, async (args) => {
      if (args[0] === 'issue') {
        return {
          ok: true,
          data: {
            number: 77,
            state: 'OPEN',
            labels: [{ name: 'agent:stale' }],
          },
          error: null,
        }
      }

      return {
        ok: true,
        data: {
          number: 108,
          state: 'OPEN',
          labels: [{ name: 'agent:review-retry' }],
        },
        error: null,
      }
    })

    expect(audit.ok).toBe(true)
    expect(audit.warnings).toContain('issue-process#77 has an active lease but issue state is stale (expected working)')
    expect(audit.warnings).toContain('pr-merge#108 has an active merge lease but the PR is missing agent:review-approved')
  })

  test('collects local observability without being hijacked by proxy env vars', async () => {
    const previousHttpProxy = process.env.http_proxy
    const previousHttpsProxy = process.env.https_proxy
    const previousAllProxy = process.env.all_proxy

    process.env.http_proxy = 'http://127.0.0.1:1'
    process.env.https_proxy = 'http://127.0.0.1:1'
    process.env.all_proxy = 'socks5://127.0.0.1:1'

    const metricsServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(metricsText, {
        headers: { 'content-type': 'text/plain' },
      }),
    })

    const healthPayload = {
      ...baseHealth,
      endpoints: {
        ...baseHealth.endpoints,
        metrics: {
          host: '127.0.0.1',
          port: metricsServer.port,
          path: '/metrics',
        },
      },
    }

    const healthServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json(healthPayload),
    })

    try {
      const snapshot = await collectDaemonObservability({
        healthHost: '127.0.0.1',
        healthPort: healthServer.port,
      })

      expect(snapshot.ok).toBe(true)
      expect(snapshot.health?.repo).toBe('JamesWuHK/digital-employee')
      expect(snapshot.metrics?.leaseConflicts).toBe(1)
      expect(snapshot.metrics?.workerIdleTimeouts['issue-process']).toBe(2)
    } finally {
      healthServer.stop(true)
      metricsServer.stop(true)

      if (previousHttpProxy === undefined) delete process.env.http_proxy
      else process.env.http_proxy = previousHttpProxy

      if (previousHttpsProxy === undefined) delete process.env.https_proxy
      else process.env.https_proxy = previousHttpsProxy

      if (previousAllProxy === undefined) delete process.env.all_proxy
      else process.env.all_proxy = previousAllProxy
    }
  })
})
