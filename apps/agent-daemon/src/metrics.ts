/**
 * Prometheus metrics for agent-loop daemon.
 *
 * Metrics exposed:
 * - agent_loop_polls_total: Counter of poll cycles (labels: result)
 * - agent_loop_claims_total: Counter of claim attempts (labels: outcome)
 * - agent_loop_issues_processed_total: Counter of processed issues (labels: outcome)
 * - agent_loop_agent_executions_total: Counter of agent executions (labels: success)
 * - agent_loop_pr_reviews_total: Counter of automated PR review results (labels: stage, outcome)
 * - agent_loop_review_auto_fixes_total: Counter of automated review auto-fix attempts (labels: outcome)
 * - agent_loop_pr_merge_recovery_total: Counter of merge recovery results (labels: outcome)
 * - agent_loop_prs_created_total: Counter of PRs created
 * - agent_loop_active_worktrees: Gauge of active worktrees
 * - agent_loop_active_pr_reviews: Gauge of active PR review workers
 * - agent_loop_inflight_issue_processes: Gauge of in-flight issue processors
 * - agent_loop_inflight_pr_reviews: Gauge of in-flight PR review/merge workers
 * - agent_loop_startup_recovery_pending: Gauge showing whether startup recovery is still pending
 * - agent_loop_effective_active_tasks: Gauge of effective active task count used by concurrency control
 * - agent_loop_project_info: Gauge carrying project/runtime configuration labels
 * - agent_loop_concurrency_limit: Gauge of configured concurrency limit
 * - agent_loop_concurrency_policy: Gauge carrying requested/effective/cap concurrency values
 * - agent_loop_active_leases: Gauge of active managed leases
 * - agent_loop_lease_heartbeat_age_seconds: Gauge of oldest held lease heartbeat age
 * - agent_loop_stalled_workers: Gauge of stalled workers tracked by the daemon
 * - agent_loop_blocked_issue_resumes: Gauge of failed issue resumes currently blocked by linked PR state
 * - agent_loop_blocked_issue_resume_age_seconds: Gauge of the oldest blocked failed-issue resume age
 * - agent_loop_poll_duration_seconds: Histogram of poll cycle durations
 * - agent_loop_issue_processing_duration_seconds: Histogram of issue processing durations
 * - agent_loop_agent_execution_duration_seconds: Histogram of agent execution durations
 */

import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client'
import type { ConcurrencyPolicy } from '@agent/shared'

export const METRICS_PORT_DEFAULT = 9090
export const METRICS_PATH = '/metrics'

// Create a custom registry
export const registry = new Registry()

// Collect default Node.js metrics (memory, CPU, event loop, etc.)
collectDefaultMetrics({ register: registry })

// ─── Counters ─────────────────────────────────────────────────────────────────

/**
 * Total number of poll cycles executed.
 * Labels:
 *   - result: "success" | "skipped_concurrency" | "no_issues" | "error"
 */
export const pollsTotal = new Counter({
  name: 'agent_loop_polls_total',
  help: 'Total number of poll cycles executed',
  labelNames: ['result'] as const,
  registers: [registry],
})

/**
 * Total number of issue claim attempts.
 * Labels:
 *   - outcome: "claimed" | "already_claimed" | "rate_limited" | "error"
 */
export const claimsTotal = new Counter({
  name: 'agent_loop_claims_total',
  help: 'Total number of issue claim attempts',
  labelNames: ['outcome'] as const,
  registers: [registry],
})

/**
 * Total number of issues processed (after claiming).
 * Labels:
 *   - outcome: "done" | "failed" | "error"
 */
export const issuesProcessedTotal = new Counter({
  name: 'agent_loop_issues_processed_total',
  help: 'Total number of issues processed after claiming',
  labelNames: ['outcome'] as const,
  registers: [registry],
})

/**
 * Total number of agent executions.
 * Labels:
 *   - success: "true" | "false"
 *   - agent_type: "claude" | "codex" | "fallback"
 */
export const agentExecutionsTotal = new Counter({
  name: 'agent_loop_agent_executions_total',
  help: 'Total number of agent executions',
  labelNames: ['success', 'agent_type'] as const,
  registers: [registry],
})

export type PrReviewStage = 'initial' | 'post_fix' | 'merge_refresh'
export type PrReviewOutcome = 'approved' | 'rejected' | 'invalid_output' | 'execution_failed'

/**
 * Total number of automated PR reviews performed by the daemon.
 * Labels:
 *   - stage: "initial" | "post_fix" | "merge_refresh"
 *   - outcome: "approved" | "rejected" | "invalid_output" | "execution_failed"
 */
export const prReviewsTotal = new Counter({
  name: 'agent_loop_pr_reviews_total',
  help: 'Total number of automated PR review outcomes',
  labelNames: ['stage', 'outcome'] as const,
  registers: [registry],
})

export type ReviewAutoFixOutcome =
  | 'committed'
  | 'salvaged'
  | 'agent_failed'
  | 'no_commit'
  | 'push_failed'

/**
 * Total number of automated review auto-fix attempts.
 * Labels:
 *   - outcome: "committed" | "salvaged" | "agent_failed" | "no_commit" | "push_failed"
 */
export const reviewAutoFixesTotal = new Counter({
  name: 'agent_loop_review_auto_fixes_total',
  help: 'Total number of review auto-fix outcomes',
  labelNames: ['outcome'] as const,
  registers: [registry],
})

export type PrMergeRecoveryOutcome =
  | 'merged_initial'
  | 'blocked_non_mergeable'
  | 'refresh_failed'
  | 'refresh_push_failed'
  | 'refresh_review_blocked'
  | 'merged_after_refresh'
  | 'retry_merge_failed'

/**
 * Total number of merge recovery outcomes for already-approved PRs.
 * Labels:
 *   - outcome: merge recovery terminal outcome
 */
export const prMergeRecoveryTotal = new Counter({
  name: 'agent_loop_pr_merge_recovery_total',
  help: 'Total number of merge recovery outcomes for approved PRs',
  labelNames: ['outcome'] as const,
  registers: [registry],
})

/**
 * Total number of PRs created.
 */
export const prsCreatedTotal = new Counter({
  name: 'agent_loop_prs_created_total',
  help: 'Total number of pull requests created',
  registers: [registry],
})

/**
 * Total number of rate limit hits from GitHub API.
 */
export const rateLimitHitsTotal = new Counter({
  name: 'agent_loop_rate_limit_hits_total',
  help: 'Total number of GitHub API rate limit hits',
  registers: [registry],
})

/**
 * Total number of managed lease conflicts encountered.
 * Labels:
 *   - scope: "issue-process" | "pr-review" | "pr-merge"
 */
export const leaseConflictsTotal = new Counter({
  name: 'agent_loop_lease_conflicts_total',
  help: 'Total number of lease conflicts encountered while adopting or starting work',
  labelNames: ['scope'] as const,
  registers: [registry],
})

/**
 * Total number of recovery actions taken by the daemon.
 * Labels:
 *   - kind: recovery action kind
 *   - outcome: "recoverable" | "completed" | "blocked" | "failed"
 */
export const recoveryActionsTotal = new Counter({
  name: 'agent_loop_recovery_actions_total',
  help: 'Total number of daemon recovery actions, labeled by kind and outcome',
  labelNames: ['kind', 'outcome'] as const,
  registers: [registry],
})

/**
 * Total number of worker idle timeouts.
 * Labels:
 *   - scope: "issue-process" | "pr-review" | "pr-merge"
 */
export const workerIdleTimeoutsTotal = new Counter({
  name: 'agent_loop_worker_idle_timeouts_total',
  help: 'Total number of worker idle timeouts by managed lease scope',
  labelNames: ['scope'] as const,
  registers: [registry],
})

// ─── Gauges ───────────────────────────────────────────────────────────────────

/**
 * Current number of active worktrees.
 */
export const activeWorktrees = new Gauge({
  name: 'agent_loop_active_worktrees',
  help: 'Current number of active worktrees',
  registers: [registry],
})

/**
 * Current number of active standalone PR review workers.
 */
export const activePrReviews = new Gauge({
  name: 'agent_loop_active_pr_reviews',
  help: 'Current number of active PR review workers',
  registers: [registry],
})

/**
 * Whether an issue processing loop is currently in flight.
 */
export const inFlightIssueProcesses = new Gauge({
  name: 'agent_loop_inflight_issue_processes',
  help: 'Whether an issue processing loop is currently in flight',
  registers: [registry],
})

/**
 * Whether a PR review/merge loop is currently in flight.
 */
export const inFlightPrReviews = new Gauge({
  name: 'agent_loop_inflight_pr_reviews',
  help: 'Whether a PR review or merge loop is currently in flight',
  registers: [registry],
})

/**
 * Whether startup recovery/reconcile is still pending.
 */
export const startupRecoveryPending = new Gauge({
  name: 'agent_loop_startup_recovery_pending',
  help: 'Whether startup recovery is still pending because initial GitHub-dependent reconcile has not completed successfully',
  registers: [registry],
})

/**
 * Effective active task count used by concurrency control.
 */
export const effectiveActiveTasks = new Gauge({
  name: 'agent_loop_effective_active_tasks',
  help: 'Effective active task count used by daemon concurrency control',
  registers: [registry],
})

/**
 * Static project/runtime metadata for the running daemon.
 */
export const projectInfo = new Gauge({
  name: 'agent_loop_project_info',
  help: 'Project/runtime configuration labels for the running daemon',
  labelNames: ['repo', 'profile', 'primary_agent', 'fallback_agent', 'default_branch', 'machine_id'] as const,
  registers: [registry],
})

/**
 * Configured concurrency limit.
 */
export const concurrencyLimit = new Gauge({
  name: 'agent_loop_concurrency_limit',
  help: 'Configured concurrency limit',
  registers: [registry],
})

/**
 * Requested/effective/cap concurrency values for the running daemon.
 */
export const concurrencyPolicyGauge = new Gauge({
  name: 'agent_loop_concurrency_policy',
  help: 'Requested, effective, and cap concurrency values for the running daemon',
  labelNames: ['kind'] as const,
  registers: [registry],
})

/**
 * Daemon uptime in seconds.
 */
export const daemonUptimeSeconds = new Gauge({
  name: 'agent_loop_uptime_seconds',
  help: 'Daemon uptime in seconds',
  registers: [registry],
})

/**
 * Current number of active managed leases held by the daemon.
 */
export const activeLeases = new Gauge({
  name: 'agent_loop_active_leases',
  help: 'Current number of active managed leases held by the daemon',
  registers: [registry],
})

/**
 * Age in seconds of the oldest held lease heartbeat.
 */
export const leaseHeartbeatAgeSeconds = new Gauge({
  name: 'agent_loop_lease_heartbeat_age_seconds',
  help: 'Age in seconds of the oldest managed lease heartbeat held by the daemon',
  registers: [registry],
})

/**
 * Current number of stalled workers tracked by the daemon.
 */
export const stalledWorkers = new Gauge({
  name: 'agent_loop_stalled_workers',
  help: 'Current number of workers marked stalled by idle timeout or recoverable failure',
  registers: [registry],
})

/**
 * Current number of failed issue resumes blocked by linked PR state.
 */
export const blockedIssueResumes = new Gauge({
  name: 'agent_loop_blocked_issue_resumes',
  help: 'Current number of failed issues that will not be auto-resumed because their linked PR is terminal or otherwise not resumable',
  registers: [registry],
})

/**
 * Age in seconds of the oldest blocked failed issue resume.
 */
export const blockedIssueResumeAgeSeconds = new Gauge({
  name: 'agent_loop_blocked_issue_resume_age_seconds',
  help: 'Age in seconds of the oldest failed issue resume blocked by linked PR state',
  registers: [registry],
})

// ─── Histograms ────────────────────────────────────────────────────────────────

/**
 * Duration of poll cycles in seconds.
 */
export const pollDurationSeconds = new Histogram({
  name: 'agent_loop_poll_duration_seconds',
  help: 'Duration of poll cycles in seconds',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
})

/**
 * Duration of issue processing in seconds.
 */
export const issueProcessingDurationSeconds = new Histogram({
  name: 'agent_loop_issue_processing_duration_seconds',
  help: 'Duration of issue processing in seconds',
  buckets: [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600],
  registers: [registry],
})

/**
 * Duration of agent execution in seconds.
 */
export const agentExecutionDurationSeconds = new Histogram({
  name: 'agent_loop_agent_execution_duration_seconds',
  help: 'Duration of agent execution in seconds',
  buckets: [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600],
  registers: [registry],
})

/**
 * Duration of worktree creation in seconds.
 */
export const worktreeCreationDurationSeconds = new Histogram({
  name: 'agent_loop_worktree_creation_duration_seconds',
  help: 'Duration of worktree creation in seconds',
  buckets: [0.1, 0.5, 1, 2, 5, 10],
  registers: [registry],
})

// ─── Helper Functions ──────────────────────────────────────────────────────────

/**
 * Get all metrics as a string in Prometheus exposition format.
 */
export async function getMetrics(): Promise<string> {
  return registry.metrics()
}

/**
 * Get content type for Prometheus metrics endpoint.
 */
export function getContentType(): string {
  return registry.contentType
}

/**
 * Record a poll cycle result.
 */
export function recordPoll(result: 'success' | 'skipped_concurrency' | 'no_issues' | 'error'): void {
  pollsTotal.inc({ result })
}

/**
 * Record a claim attempt result.
 */
export function recordClaim(outcome: 'claimed' | 'already_claimed' | 'rate_limited' | 'error'): void {
  claimsTotal.inc({ outcome })
  if (outcome === 'rate_limited') {
    rateLimitHitsTotal.inc()
  }
}

/**
 * Record an issue processing result.
 */
export function recordIssueProcessed(outcome: 'done' | 'failed' | 'error'): void {
  issuesProcessedTotal.inc({ outcome })
}

/**
 * Record an agent execution result.
 */
export function recordAgentExecution(
  success: boolean,
  agentType: 'claude' | 'codex' | 'fallback',
  durationMs: number,
): void {
  agentExecutionsTotal.inc({ success: String(success), agent_type: agentType })
  agentExecutionDurationSeconds.observe(durationMs / 1000)
}

/**
 * Record an automated PR review result.
 */
export function recordPrReviewOutcome(
  stage: PrReviewStage,
  outcome: PrReviewOutcome,
): void {
  prReviewsTotal.inc({ stage, outcome })
}

/**
 * Record an automated review auto-fix result.
 */
export function recordReviewAutoFixOutcome(
  outcome: ReviewAutoFixOutcome,
): void {
  reviewAutoFixesTotal.inc({ outcome })
}

/**
 * Record an automated merge recovery result.
 */
export function recordPrMergeRecoveryOutcome(
  outcome: PrMergeRecoveryOutcome,
): void {
  prMergeRecoveryTotal.inc({ outcome })
}

/**
 * Record a PR creation.
 */
export function recordPrCreated(): void {
  prsCreatedTotal.inc()
}

/**
 * Record a lease conflict outcome for a managed lease scope.
 */
export function recordLeaseConflict(
  scope: 'issue-process' | 'pr-review' | 'pr-merge',
): void {
  leaseConflictsTotal.inc({ scope })
}

/**
 * Record a recovery action.
 */
export function recordRecoveryAction(
  kind: string,
  outcome: 'recoverable' | 'completed' | 'blocked' | 'failed',
): void {
  recoveryActionsTotal.inc({ kind, outcome })
}

/**
 * Record a worker idle timeout for a managed lease scope.
 */
export function recordWorkerIdleTimeout(
  scope: 'issue-process' | 'pr-review' | 'pr-merge',
): void {
  workerIdleTimeoutsTotal.inc({ scope })
}

/**
 * Update active worktrees gauge.
 */
export function setActiveWorktrees(count: number): void {
  activeWorktrees.set(count)
}

/**
 * Update active PR review workers gauge.
 */
export function setActivePrReviews(count: number): void {
  activePrReviews.set(count)
}

/**
 * Update whether an issue processing loop is in flight.
 */
export function setInFlightIssueProcesses(active: boolean): void {
  inFlightIssueProcesses.set(active ? 1 : 0)
}

/**
 * Update whether a PR review/merge loop is in flight.
 */
export function setInFlightPrReviews(active: boolean): void {
  inFlightPrReviews.set(active ? 1 : 0)
}

/**
 * Update whether startup recovery is still pending.
 */
export function setStartupRecoveryPending(active: boolean): void {
  startupRecoveryPending.set(active ? 1 : 0)
}

/**
 * Update effective active task count gauge.
 */
export function setEffectiveActiveTasks(count: number): void {
  effectiveActiveTasks.set(count)
}

/**
 * Update static project/runtime info gauge.
 */
export function setProjectInfo(input: {
  repo: string
  profile: string
  primaryAgent: string
  fallbackAgent: string | null
  defaultBranch: string
  machineId: string
}): void {
  projectInfo.reset()
  projectInfo.labels({
    repo: input.repo,
    profile: input.profile,
    primary_agent: input.primaryAgent,
    fallback_agent: input.fallbackAgent ?? 'none',
    default_branch: input.defaultBranch,
    machine_id: input.machineId,
  }).set(1)
}

/**
 * Update concurrency limit gauge.
 */
export function setConcurrencyLimit(limit: number): void {
  concurrencyLimit.set(limit)
}

/**
 * Update requested/effective/cap concurrency gauges.
 */
export function setConcurrencyPolicy(policy: ConcurrencyPolicy): void {
  concurrencyPolicyGauge.reset()
  concurrencyPolicyGauge.labels({ kind: 'requested' }).set(policy.requested)
  concurrencyPolicyGauge.labels({ kind: 'effective' }).set(policy.effective)

  const optionalCaps = [
    ['repo_cap', policy.repoCap],
    ['profile_cap', policy.profileCap],
    ['project_cap', policy.projectCap],
  ] as const

  for (const [kind, value] of optionalCaps) {
    if (value !== null) {
      concurrencyPolicyGauge.labels({ kind }).set(value)
    }
  }
}

/**
 * Update daemon uptime gauge.
 */
export function setDaemonUptime(seconds: number): void {
  daemonUptimeSeconds.set(seconds)
}

/**
 * Update active managed lease gauge.
 */
export function setActiveLeases(count: number): void {
  activeLeases.set(count)
}

/**
 * Update oldest lease heartbeat age gauge.
 */
export function setLeaseHeartbeatAgeSeconds(ageSeconds: number): void {
  leaseHeartbeatAgeSeconds.set(ageSeconds)
}

/**
 * Update stalled worker gauge.
 */
export function setStalledWorkers(count: number): void {
  stalledWorkers.set(count)
}

/**
 * Update blocked failed issue resume gauge.
 */
export function setBlockedIssueResumes(count: number): void {
  blockedIssueResumes.set(count)
}

/**
 * Update oldest blocked failed issue resume age gauge.
 */
export function setBlockedIssueResumeAgeSeconds(ageSeconds: number): void {
  blockedIssueResumeAgeSeconds.set(ageSeconds)
}

/**
 * Record poll duration.
 */
export function recordPollDuration(durationMs: number): void {
  pollDurationSeconds.observe(durationMs / 1000)
}

/**
 * Record issue processing duration.
 */
export function recordIssueProcessingDuration(durationMs: number): void {
  issueProcessingDurationSeconds.observe(durationMs / 1000)
}

/**
 * Record worktree creation duration.
 */
export function recordWorktreeCreationDuration(durationMs: number): void {
  worktreeCreationDurationSeconds.observe(durationMs / 1000)
}

// ─── HTTP Server ───────────────────────────────────────────────────────────────

export interface MetricsServer {
  port: number
  stop: () => void
}

/**
 * Start an HTTP server to expose Prometheus metrics.
 * Returns a server handle with a stop() method.
 */
export async function startMetricsServer(
  port: number = METRICS_PORT_DEFAULT,
  logger: typeof console = console,
  onBeforeCollect?: () => void | Promise<void>,
): Promise<MetricsServer> {
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === METRICS_PATH) {
        if (onBeforeCollect) {
          await onBeforeCollect()
        }
        const metrics = await getMetrics()
        return new Response(metrics, {
          headers: {
            'Content-Type': getContentType(),
          },
        })
      }

      if (url.pathname === '/health') {
        return new Response('OK', {
          headers: {
            'Content-Type': 'text/plain',
          },
        })
      }

      return new Response('Not Found', { status: 404 })
    },
  })

  logger.log(`[metrics] server listening on http://${server.hostname}:${server.port}${METRICS_PATH}`)

  return {
    port: server.port ?? port,
    stop: () => {
      server.stop()
      logger.log('[metrics] server stopped')
    },
  }
}
