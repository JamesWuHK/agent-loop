import { describe, expect, test } from 'bun:test'
import { buildManagedLeaseComment, type DaemonStatus, type ManagedLease } from '@agent/shared'
import { buildPrReviewComment } from './pr-reviewer'
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
    supervisor: 'launchd',
    workingDirectory: '/Users/wujames/codeRepo/digital-employee-main',
    runtimeRecordPath: '/Users/wujames/.agent-loop/runtime/jameswuhk-digital-employee__codex-dev__9310.json',
    logPath: '/Users/wujames/.agent-loop/runtime/jameswuhk-digital-employee__codex-dev__9310.log',
    activePrReviews: 1,
    inFlightIssueProcess: true,
    inFlightPrReview: false,
    startupRecoveryPending: true,
    transientLoopErrorCount: 2,
    startupRecoveryDeferredCount: 1,
    lastTransientLoopErrorAt: '2026-04-05T08:09:30.000Z',
    lastTransientLoopErrorKind: 'startup-recovery',
    lastTransientLoopErrorMessage: 'Could not resolve host: api.github.com',
    lastTransientLoopErrorAgeSeconds: 15,
    effectiveActiveTasks: 2,
    failedIssueResumeAttemptsTracked: 1,
    failedIssueResumeCooldownsTracked: 1,
    oldestBlockedIssueResumeAgeSeconds: 45,
    oldestBlockedIssueResumeEscalationAgeSeconds: 15,
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
    blockedIssueResumeCount: 1,
    blockedIssueResumeEscalationCount: 1,
    blockedIssueResumeDetails: [
      {
        issueNumber: 91,
        prNumber: 110,
        since: '2026-04-05T08:07:45.000Z',
        durationSeconds: 45,
        reason: 'linked PR #110 is in terminal agent:human-needed; automated review has no remaining structured retry path',
        escalationCount: 1,
        lastEscalatedAt: '2026-04-05T08:08:15.000Z',
        lastEscalationAgeSeconds: 15,
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
  nextPollAt: '2026-04-05T08:10:05.000Z',
  nextPollReason: 'deferred-transient',
  nextPollDelayMs: 5_000,
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
agent_loop_transient_loop_errors_total{kind="startup-recovery"} 1
agent_loop_transient_loop_errors_total{kind="poll-cycle"} 1
agent_loop_last_transient_loop_error_age_seconds 15
agent_loop_next_poll_delay_seconds 5
agent_loop_worker_idle_timeouts_total{scope="issue-process"} 2
agent_loop_active_leases 2
agent_loop_lease_heartbeat_age_seconds 75
agent_loop_stalled_workers 1
agent_loop_blocked_issue_resumes 1
agent_loop_blocked_issue_resume_age_seconds 45
agent_loop_blocked_issue_resume_escalations 1
agent_loop_blocked_issue_resume_escalation_age_seconds 15
agent_loop_lease_conflicts_total{scope="issue-process"} 1
agent_loop_rate_limit_hits_total 0
`

const baseLaunchdDiagnostic = {
  serviceTarget: 'gui/501/com.agentloop.jameswuhk-digital-employee.codex-dev.9310',
  plistPath: '/Users/wujames/Library/LaunchAgents/com.agentloop.jameswuhk-digital-employee.codex-dev.9310.plist',
  installed: true,
  loaded: true,
  runtime: {
    serviceTarget: 'gui/501/com.agentloop.jameswuhk-digital-employee.codex-dev.9310',
    activeCount: 1,
    state: 'running',
    pid: 12345,
    runs: 2,
    lastTerminatingSignal: 'Terminated: 15',
  },
} as const

const baseLocalRuntime = {
  supervisor: 'launchd',
  alive: true,
  pid: 12345,
  cwd: '/Users/wujames/codeRepo/digital-employee-main',
  recordPath: '/Users/wujames/.agent-loop/runtime/jameswuhk-digital-employee__codex-dev__9310.json',
  logPath: '/Users/wujames/.agent-loop/runtime/jameswuhk-digital-employee__codex-dev__9310.log',
  startedAt: '2026-04-05T08:08:00.000Z',
  repo: 'JamesWuHK/digital-employee',
  machineId: 'codex-dev',
  healthPort: 9310,
  metricsPort: 9090,
  launchd: baseLaunchdDiagnostic,
} as const

function buildRemoteLease(overrides: Partial<ManagedLease> = {}): ManagedLease {
  return {
    leaseId: 'lease-remote-1',
    scope: 'issue-process',
    issueNumber: 91,
    machineId: 'machine-b',
    daemonInstanceId: 'daemon-remote-1',
    branch: 'agent/91/machine-b',
    worktreeId: 'issue-91-machine-b',
    phase: 'implementation',
    startedAt: '2099-04-05T08:00:00.000Z',
    lastHeartbeatAt: '2099-04-05T08:00:30.000Z',
    expiresAt: '2099-04-05T08:01:00.000Z',
    attempt: 2,
    lastProgressAt: '2099-04-05T08:00:40.000Z',
    lastProgressKind: 'stdout',
    status: 'active',
    ...overrides,
  }
}

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
      transientLoopErrors: {
        'startup-recovery': 1,
        'poll-cycle': 1,
      },
      workerIdleTimeouts: {
        'issue-process': 2,
      },
      lastTransientLoopErrorAgeSeconds: 15,
      nextPollDelaySeconds: 5,
      activeLeases: 2,
      leaseHeartbeatAgeSeconds: 75,
      stalledWorkers: 1,
      blockedIssueResumes: 1,
      blockedIssueResumeAgeSeconds: 45,
      blockedIssueResumeEscalations: 1,
      blockedIssueResumeEscalationAgeSeconds: 15,
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
      diagnosticRepo: baseHealth.repo,
      localRuntime: baseLocalRuntime,
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
    expect(report).toContain('process: launchd | pid 12345 | cwd /Users/wujames/codeRepo/digital-employee-main')
    expect(report).toContain('concurrency: effective 2 (requested 5; repo cap 4; profile cap 2; project cap 3)')
    expect(report).toContain('connectivity: transient 2 | startup deferred 1 | last transient startup-recovery 15s ago')
    expect(report).toContain('leases: active 2 | oldest heartbeat 75s | stalled 1 | last recovery issue-process-idle-timeout @ 2026-04-05T08:08:30.000Z')
    expect(report).toContain('lease detail: issue-process#77 implementation hb=75s progress=42s adoptable=yes')
    expect(report).toContain('state: startup pending yes | failed resumes 1 | cooldowns 1 | blocked resumes 1 | oldest blocked 45s | escalated 1 | oldest escalation 15s')
    expect(report).toContain('poll: last 2026-04-05T08:10:00.000Z | last claim 2026-04-05T08:09:00.000Z | next 5s (deferred-transient) @ 2026-04-05T08:10:05.000Z')
    expect(report).toContain('recent recovery: issue-process-idle-timeout/recoverable issue-process#77')
    expect(report).toContain('blocked resumes: issue#91<-pr#110 45s esc=1/15s')
    expect(report).toContain('launchd: loaded yes | state running | runs 2 | last signal Terminated: 15')
    expect(report).toContain('runtime files: record /Users/wujames/.agent-loop/runtime/jameswuhk-digital-employee__codex-dev__9310.json | log /Users/wujames/.agent-loop/runtime/jameswuhk-digital-employee__codex-dev__9310.log')
    expect(report).toContain('outcomes: polls success=12, skipped_concurrency=3, no_issues=4, error=1')
    expect(report).toContain('warnings: startup recovery is still pending')
  })

  test('formats a doctor report with worktrees and metrics warnings', () => {
    const report = formatDoctorReport({
      ok: true,
      healthUrl: 'http://127.0.0.1:9310/health',
      metricsUrl: 'http://127.0.0.1:9090/metrics',
      error: null,
      diagnosticRepo: baseHealth.repo,
      localRuntime: baseLocalRuntime,
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
    expect(report).toContain('supervisor: launchd')
    expect(report).toContain('working directory: /Users/wujames/codeRepo/digital-employee-main')
    expect(report).toContain('runtime record: /Users/wujames/.agent-loop/runtime/jameswuhk-digital-employee__codex-dev__9310.json')
    expect(report).toContain('log file: /Users/wujames/.agent-loop/runtime/jameswuhk-digital-employee__codex-dev__9310.log')
    expect(report).toContain('launchd loaded: yes')
    expect(report).toContain('launchd runs: 2')
    expect(report).toContain('launchd last terminating signal: Terminated: 15')
    expect(report).toContain('Active Worktrees')
    expect(report).toContain('#77 agent/77/codex-dev /tmp/issue-77-codex-dev')
    expect(report).toContain('Active Leases')
    expect(report).toContain('issue-process#77 comment=11')
    expect(report).toContain('pr-review#108 comment=18')
    expect(report).toContain('Stalled Workers')
    expect(report).toContain('issue-process#77 stuck 75s')
    expect(report).toContain('Blocked Issue Resumes')
    expect(report).toContain('issue#91<-pr#110 | blocked 45s')
    expect(report).toContain('Recent Recovery Actions')
    expect(report).toContain('issue-process-idle-timeout/recoverable | target=issue-process#77')
    expect(report).toContain('GitHub Audit')
    expect(report).toContain('issue-process#77 | state=open | labels=agent:stale | warning=issue-process#77 has an active lease but issue state is stale (expected working)')
    expect(report).toContain('merge-recovery: merged_initial=1')
    expect(report).toContain('worker-idle-timeouts: issue-process=2')
    expect(report).toContain('blocked-issue-resumes: 1')
    expect(report).toContain('blocked-issue-resume-age-seconds: 45')
    expect(report).toContain('oldest blocked issue resume age: 45s')
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

      expect(snapshot.warnings).toContain('failed issue resumes blocked by linked PR state: issue#91<-pr#110')
      expect(snapshot.warnings).toContain('next poll scheduled in 5s because deferred-transient')
      expect(snapshot.warnings).toContain('startup recovery has been deferred 1 time(s) by transient GitHub/network errors')
      expect(snapshot.warnings).toContain('recent transient loop error: startup-recovery 15s ago | Could not resolve host: api.github.com')
      expect(snapshot.warnings).toContain('adoptable leases detected: issue-process#77')
      expect(snapshot.warnings).toContain('same target recovered multiple times recently: issue-process#77=2')
      expect(report).toContain('- failed issue resumes blocked by linked PR state: issue#91<-pr#110')
      expect(report).toContain('- next poll scheduled in 5s because deferred-transient')
      expect(report).toContain('- startup recovery has been deferred 1 time(s) by transient GitHub/network errors')
      expect(report).toContain('- recent transient loop error: startup-recovery 15s ago | Could not resolve host: api.github.com')
      expect(report).toContain('- adoptable leases detected: issue-process#77')
      expect(report).toContain('- same target recovered multiple times recently: issue-process#77=2')
    } finally {
      healthServer.stop(true)
      metricsServer.stop(true)
    }
  })

  test('doctor warnings escalate long-lived and repeatedly blocked issue resumes', async () => {
    const metricsServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(metricsText, {
        headers: { 'content-type': 'text/plain' },
      }),
    })

    const healthPayload = {
      ...baseHealth,
      runtime: {
        ...baseHealth.runtime,
        oldestBlockedIssueResumeAgeSeconds: 601,
        oldestBlockedIssueResumeEscalationAgeSeconds: 0,
        blockedIssueResumeEscalationCount: 0,
        blockedIssueResumeDetails: [
          {
            issueNumber: 91,
            prNumber: 110,
            since: '2026-04-05T08:00:00.000Z',
            durationSeconds: 601,
            reason: 'linked PR #110 is in terminal agent:human-needed; automated review has no remaining structured retry path',
            escalationCount: 0,
            lastEscalatedAt: null,
            lastEscalationAgeSeconds: null,
          },
        ],
        recentRecoveryActions: [
          {
            at: '2026-04-05T08:10:00.000Z',
            kind: 'issue-resume-blocked',
            outcome: 'blocked',
            scope: 'issue-process',
            targetNumber: 91,
            reason: 'linked PR #110 is in terminal agent:human-needed; automated review has no remaining structured retry path',
          },
          {
            at: '2026-04-05T08:05:00.000Z',
            kind: 'issue-resume-blocked',
            outcome: 'blocked',
            scope: 'issue-process',
            targetNumber: 91,
            reason: 'linked PR #110 is in terminal agent:human-needed; automated review has no remaining structured retry path',
          },
        ],
      },
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

      expect(snapshot.warnings).toContain('blocked issue resumes older than 300s: issue#91<-pr#110=601s')
      expect(snapshot.warnings).toContain('same failed issue blocked multiple times recently: issue-process#91=2')
      expect(snapshot.warnings).toContain('long blocked issue resumes without GitHub escalation: issue#91<-pr#110')
      expect(report).toContain('- blocked issue resumes older than 300s: issue#91<-pr#110=601s')
      expect(report).toContain('- same failed issue blocked multiple times recently: issue-process#91=2')
      expect(report).toContain('- long blocked issue resumes without GitHub escalation: issue#91<-pr#110')
    } finally {
      healthServer.stop(true)
      metricsServer.stop(true)
    }
  })

  test('collects GitHub audit warnings for lease-label mismatches', async () => {
    const audit = await collectGitHubLeaseAudit({
      daemonInstanceId: baseHealth.daemonInstanceId,
      repo: 'JamesWuHK/digital-employee',
      runtime: {
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

  test('discovers remote active leases even when the local daemon currently holds none', async () => {
    const audit = await collectGitHubLeaseAudit({
      daemonInstanceId: baseHealth.daemonInstanceId,
      repo: 'JamesWuHK/digital-employee',
      runtime: {
        activeLeaseDetails: [],
      },
    }, async (args) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        return {
          ok: true,
          data: [
            {
              number: 91,
              state: 'OPEN',
              labels: [{ name: 'agent:working' }],
            },
          ],
          error: null,
        }
      }

      if (args[0] === 'pr' && args[1] === 'list') {
        return {
          ok: true,
          data: [
            {
              number: 120,
              state: 'OPEN',
              headRefName: 'agent/91/codex-dev',
              labels: [{ name: 'agent:review-approved' }],
            },
          ],
          error: null,
        }
      }

      if (args[0] === 'api' && args[1] === 'repos/JamesWuHK/digital-employee/issues/91/comments') {
        return {
          ok: true,
          data: [
            {
              id: 201,
              body: buildManagedLeaseComment(buildRemoteLease()),
              created_at: '2099-04-05T08:00:00.000Z',
              updated_at: '2099-04-05T08:00:30.000Z',
            },
          ],
          error: null,
        }
      }

      if (args[0] === 'api' && args[1] === 'repos/JamesWuHK/digital-employee/issues/120/comments') {
        return {
          ok: true,
          data: [
            {
              id: 202,
              body: buildManagedLeaseComment(buildRemoteLease({
                leaseId: 'lease-remote-pr',
                scope: 'pr-merge',
                issueNumber: 91,
                prNumber: 120,
                branch: 'agent/91/codex-dev',
                worktreeId: 'issue-91-codex-dev',
                phase: 'merge-refresh',
              })),
              created_at: '2099-04-05T08:01:00.000Z',
              updated_at: '2099-04-05T08:01:15.000Z',
            },
          ],
          error: null,
        }
      }

      return {
        ok: false,
        data: null,
        error: `unexpected gh invocation: ${args.join(' ')}`,
      }
    })

    expect(audit.ok).toBe(true)
    expect(audit.checks).toHaveLength(2)
    expect(audit.checks).toContainEqual(expect.objectContaining({
      scope: 'issue-process',
      targetNumber: 91,
      state: 'open',
      labels: ['agent:working'],
      warning: null,
      source: 'remote',
      commentId: 201,
      daemonInstanceId: 'daemon-remote-1',
      machineId: 'machine-b',
      phase: 'implementation',
    }))
    expect(audit.checks).toContainEqual(expect.objectContaining({
      scope: 'pr-merge',
      targetNumber: 120,
      state: 'open',
      labels: ['agent:review-approved'],
      warning: null,
      source: 'remote',
      commentId: 202,
      daemonInstanceId: 'daemon-remote-1',
      phase: 'merge-refresh',
    }))

    const report = formatDoctorReport({
      ok: true,
      healthUrl: 'http://127.0.0.1:9310/health',
      metricsUrl: 'http://127.0.0.1:9090/metrics',
      error: null,
      diagnosticRepo: baseHealth.repo,
      localRuntime: baseLocalRuntime,
      health: {
        ...baseHealth,
        runtime: {
          ...baseHealth.runtime,
          activeLeaseCount: 0,
          oldestLeaseHeartbeatAgeSeconds: 0,
          activeLeaseDetails: [],
        },
      },
      metrics: summarizeDaemonMetrics(metricsText),
      metricsError: null,
      githubAudit: audit,
      warnings: [],
    })

    expect(report).toContain('issue-process#91 | state=open | labels=agent:working | ok | source=remote | comment=201 | daemon=daemon-remote-1')
    expect(report).toContain('pr-merge#120 | state=open | labels=agent:review-approved | ok | source=remote | comment=202 | daemon=daemon-remote-1')
  })

  test('detects failed issues blocked by terminal human-needed linked PRs from GitHub state alone', async () => {
    const blockedComment = buildPrReviewComment(110, {
      approved: false,
      canMerge: false,
      reason: 'Selection state still breaks the issue contract.',
      findings: [
        {
          severity: 'high',
          file: 'apps/desktop/src/pages/MainPage.tsx',
          summary: 'selection mode regressed the required session list behavior',
          mustFix: ['restore the issue-scoped session list semantics'],
          mustNotDo: ['do not expand scope beyond issue #91'],
          validation: ['bun --cwd apps/desktop test src/pages/MainPage.test.tsx'],
          scopeRationale: 'issue #91 only covers existing session summary and switching',
        },
      ],
    }, 3, 'human-needed')

    const audit = await collectGitHubLeaseAudit({
      daemonInstanceId: baseHealth.daemonInstanceId,
      repo: 'JamesWuHK/digital-employee',
      runtime: {
        activeLeaseDetails: [],
      },
    }, async (args) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        return {
          ok: true,
          data: [
            {
              number: 91,
              state: 'OPEN',
              labels: [{ name: 'agent:failed' }],
            },
          ],
          error: null,
        }
      }

      if (args[0] === 'pr' && args[1] === 'list') {
        return {
          ok: true,
          data: [
            {
              number: 110,
              state: 'OPEN',
              headRefName: 'agent/91/codex-dev',
              labels: [{ name: 'agent:review-failed' }, { name: 'agent:human-needed' }],
            },
          ],
          error: null,
        }
      }

      if (args[0] === 'api' && args[1] === 'repos/JamesWuHK/digital-employee/issues/91/comments') {
        return {
          ok: true,
          data: [],
          error: null,
        }
      }

      if (args[0] === 'api' && args[1] === 'repos/JamesWuHK/digital-employee/issues/110/comments') {
        return {
          ok: true,
          data: [
            {
              id: 301,
              body: blockedComment,
              created_at: '2000-04-05T08:02:00.000Z',
              updated_at: '2000-04-05T08:02:30.000Z',
            },
          ],
          error: null,
        }
      }

      return {
        ok: false,
        data: null,
        error: `unexpected gh invocation: ${args.join(' ')}`,
      }
    })

    expect(audit.ok).toBe(true)
    expect(audit.warnings).toContain('issue-process#91 is blocked by linked PR #110: linked PR #110 is in terminal agent:human-needed; automated review has no remaining structured retry path')
    expect(audit.warnings).toContain('issue-process#91 has been blocked on GitHub for over 300s')
    expect(audit.checks).toContainEqual(expect.objectContaining({
      scope: 'issue-process',
      targetNumber: 91,
      state: 'open',
      labels: ['agent:failed'],
      source: 'remote',
      warning: 'issue-process#91 is blocked by linked PR #110: linked PR #110 is in terminal agent:human-needed; automated review has no remaining structured retry path',
    }))
    const blockedCheck = audit.checks.find((check) => check.scope === 'issue-process' && check.targetNumber === 91)
    expect(blockedCheck?.blockedAgeSeconds).toBeGreaterThan(300)
  })

  test('collects remote GitHub lease diagnostics even when the local health endpoint is unreachable', async () => {
    const snapshot = await collectDaemonObservability({
      healthHost: '127.0.0.1',
      healthPort: 1,
      includeGitHubAudit: true,
      fallbackRepo: 'JamesWuHK/digital-employee',
      fallbackRuntime: {
        recordPath: '/Users/wujames/.agent-loop/runtime/jameswuhk-digital-employee__codex-dev__9311.json',
        alive: true,
        record: {
          repo: 'JamesWuHK/digital-employee',
          machineId: 'codex-dev',
          healthPort: 9311,
          supervisor: 'launchd',
          pid: 90610,
          metricsPort: 9091,
          cwd: '/Users/wujames/codeRepo/digital-employee-main',
          startedAt: '2026-04-05T08:00:00.000Z',
          command: ['bun', '/Users/wujames/codeRepo/agent-loop/apps/agent-daemon/src/index.ts'],
          logPath: '/Users/wujames/.agent-loop/runtime/jameswuhk-digital-employee__codex-dev__9311.log',
        },
      },
      launchdInspector: (runtime) => ({
        serviceTarget: `gui/501/com.agentloop.jameswuhk-digital-employee.${runtime.machineId}.${runtime.healthPort}`,
        plistPath: `/Users/wujames/Library/LaunchAgents/com.agentloop.jameswuhk-digital-employee.${runtime.machineId}.${runtime.healthPort}.plist`,
        installed: true,
        loaded: true,
        runtime: {
          serviceTarget: `gui/501/com.agentloop.jameswuhk-digital-employee.${runtime.machineId}.${runtime.healthPort}`,
          activeCount: 1,
          state: 'running',
          pid: 90610,
          runs: 4,
          lastTerminatingSignal: 'Terminated: 15',
        },
      }),
      ghRunner: async (args) => {
        if (args[0] === 'issue' && args[1] === 'list') {
          return {
            ok: true,
            data: [
              {
                number: 91,
                state: 'OPEN',
                labels: [{ name: 'agent:working' }],
              },
            ],
            error: null,
          }
        }

        if (args[0] === 'pr' && args[1] === 'list') {
          return {
            ok: true,
            data: [],
            error: null,
          }
        }

        if (args[0] === 'api' && args[1] === 'repos/JamesWuHK/digital-employee/issues/91/comments') {
          return {
            ok: true,
            data: [
              {
                id: 201,
                body: buildManagedLeaseComment(buildRemoteLease()),
                created_at: '2099-04-05T08:00:00.000Z',
                updated_at: '2099-04-05T08:00:30.000Z',
              },
            ],
            error: null,
          }
        }

        return {
          ok: false,
          data: null,
          error: `unexpected gh invocation: ${args.join(' ')}`,
        }
      },
    })

    expect(snapshot.ok).toBe(false)
    expect(snapshot.health).toBeNull()
    expect(snapshot.diagnosticRepo).toBe('JamesWuHK/digital-employee')
    expect(snapshot.localRuntime).toMatchObject({
      supervisor: 'launchd',
      alive: true,
      pid: 90610,
      launchd: {
        loaded: true,
        runtime: {
          runs: 4,
        },
      },
    })
    expect(snapshot.githubAudit?.checks).toContainEqual(expect.objectContaining({
      scope: 'issue-process',
      targetNumber: 91,
      source: 'remote',
      commentId: 201,
    }))
    expect(snapshot.warnings).toContain('daemon health endpoint is not reachable at http://127.0.0.1:1/health')

    const report = formatDoctorReport(snapshot)
    expect(report).toContain('health: unreachable (http://127.0.0.1:1/health)')
    expect(report).toContain('repo: JamesWuHK/digital-employee')
    expect(report).toContain('Local Runtime')
    expect(report).toContain('supervisor: launchd')
    expect(report).toContain('cwd: /Users/wujames/codeRepo/digital-employee-main')
    expect(report).toContain('launchd runs: 4')
    expect(report).toContain('- confirm pid 90610 is serving the configured health port 9311')
    expect(snapshot.warnings).toContain('launchd has restarted this daemon 4 times; inspect recent exits if this keeps increasing')
    expect(report).toContain('- launchd has restarted this daemon 4 times; inspect recent exits if this keeps increasing')
    expect(report).toContain('GitHub Audit')
    expect(report).toContain('issue-process#91 | state=open | labels=agent:working | ok | source=remote | comment=201')
  })

  test('offline status and doctor suggest reconcile commands for stopped launchd services', () => {
    const snapshot = {
      ok: false,
      healthUrl: 'http://127.0.0.1:9311/health',
      metricsUrl: null,
      error: 'GET http://127.0.0.1:9311/health failed: curl: (7) Failed to connect',
      diagnosticRepo: 'JamesWuHK/digital-employee',
      localRuntime: {
        ...baseLocalRuntime,
        alive: false,
        healthPort: 9311,
        recordPath: '/Users/wujames/.agent-loop/runtime/jameswuhk-digital-employee__codex-dev__9311.json',
        logPath: '/Users/wujames/.agent-loop/runtime/jameswuhk-digital-employee__codex-dev__9311.log',
        launchd: {
          ...baseLaunchdDiagnostic,
          loaded: false,
          runtime: null,
        },
      },
      health: null,
      metrics: null,
      metricsError: null,
      githubAudit: null,
      warnings: [
        'daemon health endpoint is not reachable at http://127.0.0.1:9311/health',
        'local runtime record exists but pid 12345 is not alive (launchd)',
        `launchd service is installed but not currently loaded (${baseLaunchdDiagnostic.serviceTarget})`,
      ],
    } satisfies Awaited<ReturnType<typeof collectDaemonObservability>>

    const statusReport = formatStatusReport(snapshot)
    expect(statusReport).toContain('local runtime: launchd | stale | pid 12345')
    expect(statusReport).toContain('launchd: loaded no | state unknown | runs 0 | last signal none')
    expect(statusReport).toContain('hint: launchd service is installed but stopped; rerun the daemon CLI with `--start --repo JamesWuHK/digital-employee --machine-id codex-dev --health-port 9311` or `--restart --repo JamesWuHK/digital-employee --machine-id codex-dev --health-port 9311` to bring it back.')

    const doctorReport = formatDoctorReport(snapshot)
    expect(doctorReport).toContain('- rerun the daemon CLI with `--start --repo JamesWuHK/digital-employee --machine-id codex-dev --health-port 9311` to reload the launchd service')
    expect(doctorReport).toContain('- if you want a forced restart instead, rerun with `--restart --repo JamesWuHK/digital-employee --machine-id codex-dev --health-port 9311`')
    expect(doctorReport).toContain('- inspect the daemon log file at /Users/wujames/.agent-loop/runtime/jameswuhk-digital-employee__codex-dev__9311.log')
  })

  test('offline doctor surfaces blocked failed issue resumes from GitHub state', async () => {
    const blockedComment = buildPrReviewComment(110, {
      approved: false,
      canMerge: false,
      reason: 'Selection state still breaks the issue contract.',
      findings: [
        {
          severity: 'high',
          file: 'apps/desktop/src/pages/MainPage.tsx',
          summary: 'selection mode regressed the required session list behavior',
          mustFix: ['restore the issue-scoped session list semantics'],
          mustNotDo: ['do not expand scope beyond issue #91'],
          validation: ['bun --cwd apps/desktop test src/pages/MainPage.test.tsx'],
          scopeRationale: 'issue #91 only covers existing session summary and switching',
        },
      ],
    }, 3, 'human-needed')

    const snapshot = await collectDaemonObservability({
      healthHost: '127.0.0.1',
      healthPort: 1,
      includeGitHubAudit: true,
      fallbackRepo: 'JamesWuHK/digital-employee',
      ghRunner: async (args) => {
        if (args[0] === 'issue' && args[1] === 'list') {
          return {
            ok: true,
            data: [
              {
                number: 91,
                state: 'OPEN',
                labels: [{ name: 'agent:failed' }],
              },
            ],
            error: null,
          }
        }

        if (args[0] === 'pr' && args[1] === 'list') {
          return {
            ok: true,
            data: [
              {
                number: 110,
                state: 'OPEN',
                headRefName: 'agent/91/codex-dev',
                labels: [{ name: 'agent:review-failed' }, { name: 'agent:human-needed' }],
              },
            ],
            error: null,
          }
        }

        if (args[0] === 'api' && args[1] === 'repos/JamesWuHK/digital-employee/issues/91/comments') {
          return {
            ok: true,
            data: [],
            error: null,
          }
        }

        if (args[0] === 'api' && args[1] === 'repos/JamesWuHK/digital-employee/issues/110/comments') {
          return {
            ok: true,
            data: [
              {
                id: 301,
                body: blockedComment,
                created_at: '2000-04-05T08:02:00.000Z',
                updated_at: '2000-04-05T08:02:30.000Z',
              },
            ],
            error: null,
          }
        }

        return {
          ok: false,
          data: null,
          error: `unexpected gh invocation: ${args.join(' ')}`,
        }
      },
    })

    expect(snapshot.ok).toBe(false)
    expect(snapshot.githubAudit?.warnings).toContain('issue-process#91 is blocked by linked PR #110: linked PR #110 is in terminal agent:human-needed; automated review has no remaining structured retry path')
    expect(snapshot.githubAudit?.warnings).toContain('issue-process#91 has been blocked on GitHub for over 300s')
    expect(snapshot.warnings).toContain('daemon health endpoint is not reachable at http://127.0.0.1:1/health')
    expect(snapshot.warnings).toContain('issue-process#91 is blocked by linked PR #110: linked PR #110 is in terminal agent:human-needed; automated review has no remaining structured retry path')
    expect(snapshot.warnings).toContain('issue-process#91 has been blocked on GitHub for over 300s')

    const report = formatDoctorReport(snapshot)
    expect(report).toContain('issue-process#91 | state=open | labels=agent:failed | warning=issue-process#91 is blocked by linked PR #110: linked PR #110 is in terminal agent:human-needed; automated review has no remaining structured retry path | blocked_age=')
    expect(report).toContain('- issue-process#91 is blocked by linked PR #110: linked PR #110 is in terminal agent:human-needed; automated review has no remaining structured retry path')
    expect(report).toContain('- issue-process#91 has been blocked on GitHub for over 300s')
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
