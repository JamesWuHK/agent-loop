import type { ConcurrencyPolicy, DaemonStatus } from '@agent/shared'
import {
  DEFAULT_HEALTH_SERVER_HOST,
  DEFAULT_HEALTH_SERVER_PORT,
  HEALTH_PATH,
} from './daemon'
import {
  METRICS_PATH,
  METRICS_PORT_DEFAULT,
} from './metrics'

const REVIEW_OUTCOME_ORDER = ['approved', 'rejected', 'invalid_output', 'execution_failed'] as const
const REVIEW_STAGE_ORDER = ['initial', 'post_fix', 'merge_refresh'] as const
const AUTO_FIX_OUTCOME_ORDER = ['committed', 'salvaged', 'agent_failed', 'no_commit', 'push_failed'] as const
const MERGE_RECOVERY_OUTCOME_ORDER = [
  'merged_initial',
  'blocked_non_mergeable',
  'refresh_failed',
  'refresh_push_failed',
  'refresh_review_blocked',
  'merged_after_refresh',
  'retry_merge_failed',
] as const
const POLL_OUTCOME_ORDER = ['success', 'skipped_concurrency', 'no_issues', 'error'] as const

export interface DaemonHealthPayload extends DaemonStatus {
  status: 'running' | 'stopped'
  mode: string
  version: string
}

export interface DaemonMetricSummary {
  polls: Record<string, number>
  prReviews: Record<string, Record<string, number>>
  autoFixes: Record<string, number>
  mergeRecovery: Record<string, number>
  recoveryActions: Record<string, Record<string, number>>
  workerIdleTimeouts: Record<string, number>
  activeLeases: number | null
  leaseHeartbeatAgeSeconds: number | null
  stalledWorkers: number | null
  leaseConflicts: number
  rateLimitHits: number
}

export interface DaemonObservabilitySnapshot {
  ok: boolean
  healthUrl: string
  metricsUrl: string | null
  error: string | null
  health: DaemonHealthPayload | null
  metrics: DaemonMetricSummary | null
  metricsError: string | null
  warnings: string[]
}

export interface StatusCommandOptions {
  healthHost?: string
  healthPort?: number
  metricsPort?: number
}

interface MetricSample {
  name: string
  labels: Record<string, string>
  value: number
}

interface LocalEndpointResponse {
  statusCode: number
  statusText: string
  body: string
}

export async function collectDaemonObservability(
  options: StatusCommandOptions = {},
): Promise<DaemonObservabilitySnapshot> {
  const healthHost = options.healthHost ?? DEFAULT_HEALTH_SERVER_HOST
  const healthPort = options.healthPort ?? DEFAULT_HEALTH_SERVER_PORT
  const healthUrl = buildEndpointUrl(healthHost, healthPort, HEALTH_PATH)

  let health: DaemonHealthPayload
  try {
    const response = await requestLocalEndpoint(healthUrl)
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return {
        ok: false,
        healthUrl,
        metricsUrl: null,
        error: `GET ${healthUrl} returned ${response.statusCode} ${response.statusText}`.trim(),
        health: null,
        metrics: null,
        metricsError: null,
        warnings: [`daemon health endpoint is not reachable at ${healthUrl}`],
      }
    }
    health = JSON.parse(response.body) as DaemonHealthPayload
  } catch (error) {
    return {
      ok: false,
      healthUrl,
      metricsUrl: null,
      error: `GET ${healthUrl} failed: ${formatError(error)}`,
      health: null,
      metrics: null,
      metricsError: null,
      warnings: [`daemon health endpoint is not reachable at ${healthUrl}`],
    }
  }

  const metricsHost = health.endpoints?.metrics.host ?? DEFAULT_HEALTH_SERVER_HOST
  const metricsPort = options.metricsPort ?? health.endpoints?.metrics.port ?? METRICS_PORT_DEFAULT
  const metricsPath = health.endpoints?.metrics.path ?? METRICS_PATH
  const metricsUrl = buildEndpointUrl(metricsHost, metricsPort, metricsPath)

  let metrics: DaemonMetricSummary | null = null
  let metricsError: string | null = null
  try {
    const response = await requestLocalEndpoint(metricsUrl)
    if (response.statusCode < 200 || response.statusCode >= 300) {
      metricsError = `GET ${metricsUrl} returned ${response.statusCode} ${response.statusText}`.trim()
    } else {
      metrics = summarizeDaemonMetrics(response.body)
    }
  } catch (error) {
    metricsError = `GET ${metricsUrl} failed: ${formatError(error)}`
  }

  const snapshot: DaemonObservabilitySnapshot = {
    ok: true,
    healthUrl,
    metricsUrl,
    error: null,
    health,
    metrics,
    metricsError,
    warnings: [],
  }
  snapshot.warnings = buildDoctorWarnings(snapshot)
  return snapshot
}

export function formatStatusReport(snapshot: DaemonObservabilitySnapshot): string {
  if (!snapshot.ok || !snapshot.health) {
    return [
      'daemon: unreachable',
      `health: ${snapshot.healthUrl}`,
      `error: ${snapshot.error ?? 'unknown error'}`,
      'hint: start the daemon or pass the correct --health-host/--health-port.',
    ].join('\n')
  }

  const { health } = snapshot
  const lines = [
    `daemon: ${health.status} v${health.version} (${health.mode})`,
    `repo: ${health.repo}`,
    `project: ${health.project.profile} | agents: ${health.agent.primary} -> ${health.agent.fallback ?? 'none'}`,
    `daemon: ${health.machineId} / ${health.daemonInstanceId}`,
    `concurrency: ${formatConcurrencyPolicy(health.concurrencyPolicy)}`,
    `runtime: active ${health.runtime.effectiveActiveTasks}/${health.concurrency} | worktrees ${health.activeWorktrees.length} | pr reviews ${health.runtime.activePrReviews} | issue loop ${formatBoolean(health.runtime.inFlightIssueProcess)} | review loop ${formatBoolean(health.runtime.inFlightPrReview)}`,
    `recovery: heartbeat ${health.recovery.heartbeatIntervalMs}ms | ttl ${health.recovery.leaseTtlMs}ms | idle ${health.recovery.workerIdleTimeoutMs}ms | adopt backoff ${health.recovery.leaseAdoptionBackoffMs}ms`,
    `leases: active ${health.runtime.activeLeaseCount} | oldest heartbeat ${formatNullableSeconds(health.runtime.oldestLeaseHeartbeatAgeSeconds)} | stalled ${health.runtime.stalledWorkerCount} | last recovery ${formatLastRecovery(health.runtime.lastRecoveryActionKind, health.runtime.lastRecoveryActionAt)}`,
    `state: startup pending ${formatBoolean(health.runtime.startupRecoveryPending)} | failed resumes ${health.runtime.failedIssueResumeAttemptsTracked} | cooldowns ${health.runtime.failedIssueResumeCooldownsTracked}`,
    `poll: last ${health.lastPollAt ?? 'never'} | last claim ${health.lastClaimedAt ?? 'never'}`,
  ]

  if (snapshot.metrics) {
    const reviewTotals = summarizeReviewOutcomes(snapshot.metrics.prReviews)
    lines.push(
      `outcomes: polls ${formatOrderedMap(snapshot.metrics.polls, POLL_OUTCOME_ORDER)} | reviews ${formatOrderedMap(reviewTotals, REVIEW_OUTCOME_ORDER)} | auto-fix ${formatOrderedMap(snapshot.metrics.autoFixes, AUTO_FIX_OUTCOME_ORDER)} | merge ${formatOrderedMap(snapshot.metrics.mergeRecovery, MERGE_RECOVERY_OUTCOME_ORDER)}`,
    )
  } else if (snapshot.metricsError) {
    lines.push(`metrics: unavailable (${snapshot.metricsError})`)
  }

  lines.push(
    `endpoints: health ${snapshot.healthUrl} | metrics ${snapshot.metricsUrl ?? 'unknown'}`,
  )

  if (snapshot.warnings.length > 0) {
    lines.push(`warnings: ${snapshot.warnings.join(' | ')}`)
  }

  return lines.join('\n')
}

export function formatDoctorReport(snapshot: DaemonObservabilitySnapshot): string {
  if (!snapshot.ok || !snapshot.health) {
    return [
      'Daemon Doctor',
      '',
      `health: unreachable (${snapshot.healthUrl})`,
      `error: ${snapshot.error ?? 'unknown error'}`,
      '',
      'Next checks',
      '- confirm the daemon process is running',
      '- confirm the health port matches the running daemon',
      '- if the daemon uses a custom port, rerun with --health-port',
    ].join('\n')
  }

  const { health } = snapshot
  const worktreeLines = health.activeWorktrees.length === 0
    ? ['none']
    : health.activeWorktrees.map((worktree) => `#${worktree.issueNumber} ${worktree.branch} ${worktree.path}`)
  const outcomeLines = snapshot.metrics
    ? [
        `polls: ${formatOrderedMap(snapshot.metrics.polls, POLL_OUTCOME_ORDER)}`,
        ...REVIEW_STAGE_ORDER.map((stage) => `reviews.${stage}: ${formatOrderedMap(snapshot.metrics?.prReviews[stage] ?? {}, REVIEW_OUTCOME_ORDER)}`),
        `auto-fix: ${formatOrderedMap(snapshot.metrics.autoFixes, AUTO_FIX_OUTCOME_ORDER)}`,
        `merge-recovery: ${formatOrderedMap(snapshot.metrics.mergeRecovery, MERGE_RECOVERY_OUTCOME_ORDER)}`,
        `lease-conflicts: ${snapshot.metrics.leaseConflicts}`,
        `worker-idle-timeouts: ${formatInlineKeyValue(snapshot.metrics.workerIdleTimeouts) || 'none'}`,
        `recovery-actions: ${formatRecoveryActionSummary(snapshot.metrics.recoveryActions)}`,
        `rate-limit-hits: ${snapshot.metrics.rateLimitHits}`,
      ]
    : [`metrics unavailable: ${snapshot.metricsError ?? 'unknown error'}`]

  return [
    'Daemon Doctor',
    '',
    'Connectivity',
    `health: ok (${snapshot.healthUrl})`,
    `metrics: ${snapshot.metrics ? `ok (${snapshot.metricsUrl})` : `unavailable (${snapshot.metricsError ?? 'unknown error'})`}`,
    '',
    'Config',
    `repo: ${health.repo}`,
    `profile: ${health.project.profile}`,
    `default branch: ${health.project.defaultBranch}`,
    `project max concurrency: ${health.project.maxConcurrency ?? 'none'}`,
    `agents: ${health.agent.primary} -> ${health.agent.fallback ?? 'none'}`,
    `daemon instance: ${health.daemonInstanceId}`,
    `concurrency: ${formatConcurrencyPolicy(health.concurrencyPolicy)}`,
    `recovery heartbeat: ${health.recovery.heartbeatIntervalMs}ms`,
    `lease ttl: ${health.recovery.leaseTtlMs}ms`,
    `worker idle timeout: ${health.recovery.workerIdleTimeoutMs}ms`,
    `lease adoption backoff: ${health.recovery.leaseAdoptionBackoffMs}ms`,
    '',
    'Runtime',
    `pid: ${health.pid}`,
    `uptime: ${formatDuration(health.uptimeMs)}`,
    `last poll: ${health.lastPollAt ?? 'never'}`,
    `last claimed: ${health.lastClaimedAt ?? 'never'}`,
    `startup recovery pending: ${formatBoolean(health.runtime.startupRecoveryPending)}`,
    `active worktrees: ${health.activeWorktrees.length}`,
    `active pr reviews: ${health.runtime.activePrReviews}`,
    `in-flight issue loop: ${formatBoolean(health.runtime.inFlightIssueProcess)}`,
    `in-flight review loop: ${formatBoolean(health.runtime.inFlightPrReview)}`,
    `effective active tasks: ${health.runtime.effectiveActiveTasks}/${health.concurrency}`,
    `active leases: ${health.runtime.activeLeaseCount}`,
    `oldest lease heartbeat age: ${formatNullableSeconds(health.runtime.oldestLeaseHeartbeatAgeSeconds)}`,
    `stalled workers: ${health.runtime.stalledWorkerCount}`,
    `last recovery action: ${formatLastRecovery(health.runtime.lastRecoveryActionKind, health.runtime.lastRecoveryActionAt)}`,
    `failed issue resume attempts tracked: ${health.runtime.failedIssueResumeAttemptsTracked}`,
    `failed issue resume cooldowns tracked: ${health.runtime.failedIssueResumeCooldownsTracked}`,
    '',
    'Outcomes',
    ...outcomeLines,
    '',
    'Active Worktrees',
    ...worktreeLines,
    '',
    'Warnings',
    ...(snapshot.warnings.length > 0 ? snapshot.warnings.map((warning) => `- ${warning}`) : ['none']),
  ].join('\n')
}

export function summarizeDaemonMetrics(metricsText: string): DaemonMetricSummary {
  const summary: DaemonMetricSummary = {
    polls: {},
    prReviews: {},
    autoFixes: {},
    mergeRecovery: {},
    recoveryActions: {},
    workerIdleTimeouts: {},
    activeLeases: null,
    leaseHeartbeatAgeSeconds: null,
    stalledWorkers: null,
    leaseConflicts: 0,
    rateLimitHits: 0,
  }

  for (const sample of parsePrometheusSamples(metricsText)) {
    switch (sample.name) {
      case 'agent_loop_polls_total':
        if (sample.labels.result) summary.polls[sample.labels.result] = sample.value
        break
      case 'agent_loop_pr_reviews_total':
        if (!sample.labels.stage || !sample.labels.outcome) break
        summary.prReviews[sample.labels.stage] ??= {}
        summary.prReviews[sample.labels.stage]![sample.labels.outcome] = sample.value
        break
      case 'agent_loop_review_auto_fixes_total':
        if (sample.labels.outcome) summary.autoFixes[sample.labels.outcome] = sample.value
        break
      case 'agent_loop_pr_merge_recovery_total':
        if (sample.labels.outcome) summary.mergeRecovery[sample.labels.outcome] = sample.value
        break
      case 'agent_loop_recovery_actions_total':
        if (!sample.labels.kind || !sample.labels.outcome) break
        summary.recoveryActions[sample.labels.kind] ??= {}
        summary.recoveryActions[sample.labels.kind]![sample.labels.outcome] = sample.value
        break
      case 'agent_loop_worker_idle_timeouts_total':
        if (sample.labels.scope) summary.workerIdleTimeouts[sample.labels.scope] = sample.value
        break
      case 'agent_loop_active_leases':
        summary.activeLeases = sample.value
        break
      case 'agent_loop_lease_heartbeat_age_seconds':
        summary.leaseHeartbeatAgeSeconds = sample.value
        break
      case 'agent_loop_stalled_workers':
        summary.stalledWorkers = sample.value
        break
      case 'agent_loop_lease_conflicts_total':
        summary.leaseConflicts += sample.value
        break
      case 'agent_loop_rate_limit_hits_total':
        summary.rateLimitHits = sample.value
        break
    }
  }

  return summary
}

export function parsePrometheusSamples(metricsText: string): MetricSample[] {
  const samples: MetricSample[] = []

  for (const line of metricsText.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const match = trimmed.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/)
    if (!match) continue

    const name = match[1]
    if (!name) continue
    const value = Number(match[4])
    if (!Number.isFinite(value)) continue

    samples.push({
      name,
      labels: parsePrometheusLabels(match[3] ?? ''),
      value,
    })
  }

  return samples
}

function parsePrometheusLabels(labelBlock: string): Record<string, string> {
  const labels: Record<string, string> = {}
  const labelPattern = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"])*)"/g

  let match: RegExpExecArray | null
  while ((match = labelPattern.exec(labelBlock)) !== null) {
    const key = match[1]
    const value = match[2]
    if (!key || value === undefined) continue

    labels[key] = value
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .replace(/\\n/g, '\n')
  }

  return labels
}

function buildDoctorWarnings(snapshot: DaemonObservabilitySnapshot): string[] {
  if (!snapshot.health) {
    return snapshot.warnings
  }

  const warnings: string[] = []
  if (snapshot.health.runtime.startupRecoveryPending) {
    warnings.push('startup recovery is still pending; the daemon is waiting to finish its GitHub/network reconcile')
  }
  if (snapshot.metricsError) {
    warnings.push(`metrics endpoint is unavailable: ${snapshot.metricsError}`)
  }
  if (snapshot.health.runtime.effectiveActiveTasks > snapshot.health.concurrency) {
    warnings.push('effective active tasks exceed the configured concurrency limit')
  }
  if (snapshot.health.runtime.failedIssueResumeCooldownsTracked > 0) {
    warnings.push('one or more failed issues are currently cooling down before resume/requeue')
  }
  if (snapshot.health.runtime.activeLeaseCount > 0 && snapshot.health.runtime.oldestLeaseHeartbeatAgeSeconds > snapshot.health.recovery.leaseTtlMs / 1000) {
    warnings.push('one or more active leases have heartbeat ages older than the configured lease TTL')
  }
  if (snapshot.health.runtime.stalledWorkerCount > 0) {
    warnings.push(`stalled workers currently tracked: ${snapshot.health.runtime.stalledWorkerCount}`)
  }
  if (snapshot.health.runtime.lastRecoveryActionKind && snapshot.health.runtime.lastRecoveryActionAt) {
    warnings.push(`latest recovery action: ${snapshot.health.runtime.lastRecoveryActionKind} at ${snapshot.health.runtime.lastRecoveryActionAt}`)
  }
  if ((snapshot.metrics?.polls.error ?? 0) > 0) {
    warnings.push(`poll loop has recorded ${snapshot.metrics?.polls.error} error result(s)`)
  }
  if ((snapshot.metrics?.leaseConflicts ?? 0) > 0) {
    warnings.push(`managed lease conflicts observed: ${snapshot.metrics?.leaseConflicts}`)
  }
  if (Object.values(snapshot.metrics?.workerIdleTimeouts ?? {}).reduce((sum, value) => sum + value, 0) > 0) {
    warnings.push(`worker idle timeouts observed: ${formatInlineKeyValue(snapshot.metrics?.workerIdleTimeouts ?? {})}`)
  }
  const repeatedRecoveries = Object.entries(snapshot.metrics?.recoveryActions ?? {})
    .map(([kind, outcomes]) => [kind, Object.values(outcomes).reduce((sum, value) => sum + value, 0)] as const)
    .filter(([, count]) => count >= 2)
  if (repeatedRecoveries.length > 0) {
    warnings.push(`repeated recovery actions observed: ${repeatedRecoveries.map(([kind, count]) => `${kind}=${count}`).join(', ')}`)
  }
  if ((snapshot.metrics?.autoFixes.push_failed ?? 0) > 0) {
    warnings.push(`review auto-fix push failures observed: ${snapshot.metrics?.autoFixes.push_failed}`)
  }
  if (((snapshot.metrics?.mergeRecovery.refresh_push_failed ?? 0) + (snapshot.metrics?.mergeRecovery.retry_merge_failed ?? 0)) > 0) {
    warnings.push('merge recovery has recent push/merge retry failures; inspect the latest PR recovery comments')
  }

  return warnings
}

function summarizeReviewOutcomes(
  prReviews: Record<string, Record<string, number>>,
): Record<string, number> {
  const totals: Record<string, number> = {}

  for (const outcomeMap of Object.values(prReviews)) {
    for (const [outcome, value] of Object.entries(outcomeMap)) {
      totals[outcome] = (totals[outcome] ?? 0) + value
    }
  }

  return totals
}

function buildEndpointUrl(host: string, port: number, path: string): string {
  return `http://${host}:${port}${path}`
}

function formatConcurrencyPolicy(policy: ConcurrencyPolicy): string {
  return `effective ${policy.effective} (requested ${policy.requested}; repo cap ${policy.repoCap ?? 'none'}; profile cap ${policy.profileCap ?? 'none'}; project cap ${policy.projectCap ?? 'none'})`
}

function formatOrderedMap(
  values: Record<string, number>,
  order: readonly string[],
): string {
  return order.map((key) => `${key}=${values[key] ?? 0}`).join(', ')
}

function formatBoolean(value: boolean): string {
  return value ? 'yes' : 'no'
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function formatNullableSeconds(seconds: number | null): string {
  if (seconds === null) return 'n/a'
  return `${seconds}s`
}

function formatLastRecovery(kind: string | null, at: string | null): string {
  if (!kind || !at) return 'none'
  return `${kind} @ ${at}`
}

function formatInlineKeyValue(values: Record<string, number>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ')
}

function formatRecoveryActionSummary(values: Record<string, Record<string, number>>): string {
  const parts = Object.entries(values).flatMap(([kind, outcomes]) => {
    return Object.entries(outcomes).map(([outcome, count]) => `${kind}/${outcome}=${count}`)
  })

  return parts.join(', ') || 'none'
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function requestLocalEndpoint(url: string): Promise<LocalEndpointResponse> {
  const proc = Bun.spawn([
    'curl',
    '--noproxy',
    '*',
    '--silent',
    '--show-error',
    '--output',
    '-',
    '--write-out',
    '\n__AGENT_LOOP_STATUS__%{http_code}',
    url,
  ], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `curl exited ${exitCode}`)
  }

  const marker = '\n__AGENT_LOOP_STATUS__'
  const markerIndex = stdout.lastIndexOf(marker)
  if (markerIndex === -1) {
    throw new Error('curl response did not include HTTP status marker')
  }

  const body = stdout.slice(0, markerIndex)
  const statusCode = Number.parseInt(stdout.slice(markerIndex + marker.length).trim(), 10)

  return {
    statusCode: Number.isFinite(statusCode) ? statusCode : 0,
    statusText: '',
    body,
  }
}
