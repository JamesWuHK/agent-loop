/**
 * Prometheus metrics for agent-loop daemon.
 *
 * Metrics exposed:
 * - agent_loop_polls_total: Counter of poll cycles (labels: result)
 * - agent_loop_claims_total: Counter of claim attempts (labels: outcome)
 * - agent_loop_issues_processed_total: Counter of processed issues (labels: outcome)
 * - agent_loop_agent_executions_total: Counter of agent executions (labels: success)
 * - agent_loop_prs_created_total: Counter of PRs created
 * - agent_loop_active_worktrees: Gauge of active worktrees
 * - agent_loop_concurrency_limit: Gauge of configured concurrency limit
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
 * Configured concurrency limit.
 */
export const concurrencyLimit = new Gauge({
  name: 'agent_loop_concurrency_limit',
  help: 'Configured concurrency limit',
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
 * Record a PR creation.
 */
export function recordPrCreated(): void {
  prsCreatedTotal.inc()
}

/**
 * Update active worktrees gauge.
 */
export function setActiveWorktrees(count: number): void {
  activeWorktrees.set(count)
}

/**
 * Update concurrency limit gauge.
 */
export function setConcurrencyLimit(limit: number): void {
  concurrencyLimit.set(limit)
}

/**
 * Update daemon uptime gauge.
 */
export function setDaemonUptime(seconds: number): void {
  daemonUptimeSeconds.set(seconds)
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
  stop: () => void
}

/**
 * Start an HTTP server to expose Prometheus metrics.
 * Returns a server handle with a stop() method.
 */
export async function startMetricsServer(
  port: number = METRICS_PORT_DEFAULT,
  logger: typeof console = console,
): Promise<MetricsServer> {
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === METRICS_PATH) {
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
    stop: () => {
      server.stop()
      logger.log('[metrics] server stopped')
    },
  }
}
