import {
  PR_REVIEW_LABELS,
  getActiveManagedLease,
  type ConcurrencyPolicy,
  type DaemonStatus,
  type IssueComment,
  type ManagedLeaseScope,
} from '@agent/shared'
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
  githubAudit: GitHubLeaseAudit | null
  warnings: string[]
}

export interface StatusCommandOptions {
  healthHost?: string
  healthPort?: number
  metricsPort?: number
  includeGitHubAudit?: boolean
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

export interface GitHubLeaseAuditCheck {
  scope: ManagedLeaseScope
  targetNumber: number
  state: string
  labels: string[]
  warning: string | null
  source?: 'local' | 'remote'
  commentId?: number | null
  daemonInstanceId?: string | null
  machineId?: string | null
  phase?: string | null
  heartbeatAgeSeconds?: number | null
  expiresInSeconds?: number | null
  adoptable?: boolean | null
}

export interface GitHubLeaseAudit {
  ok: boolean
  error: string | null
  checks: GitHubLeaseAuditCheck[]
  warnings: string[]
}

interface GhJsonResult {
  ok: boolean
  data: unknown | null
  error: string | null
}

type GhJsonRunner = (args: string[]) => Promise<GhJsonResult>

interface LeaseAuditSubject {
  scope: ManagedLeaseScope
  targetNumber: number
  issueNumber: number | null
  prNumber: number | null
  source?: 'local' | 'remote'
  commentId?: number | null
  daemonInstanceId?: string | null
  machineId?: string | null
  phase?: string | null
  heartbeatAgeSeconds?: number | null
  expiresInSeconds?: number | null
  adoptable?: boolean | null
}

interface GitHubListLabel {
  name?: unknown
}

interface GitHubIssueListItem {
  number?: unknown
  state?: unknown
  labels?: GitHubListLabel[]
}

interface GitHubPrListItem extends GitHubIssueListItem {
  headRefName?: unknown
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
        githubAudit: null,
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
      githubAudit: null,
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
    githubAudit: null,
    warnings: [],
  }
  if (options.includeGitHubAudit) {
    snapshot.githubAudit = await collectGitHubLeaseAudit(health)
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

  if (health.runtime.activeLeaseDetails.length > 0) {
    lines.push(`lease detail: ${formatActiveLeaseInlineSummary(health.runtime.activeLeaseDetails)}`)
  }
  if (health.runtime.recentRecoveryActions.length > 0) {
    lines.push(`recent recovery: ${formatRecoveryActionInlineSummary(health.runtime.recentRecoveryActions)}`)
  }

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
  const activeLeaseLines = health.runtime.activeLeaseDetails.length === 0
    ? ['none']
    : health.runtime.activeLeaseDetails.map((lease) => formatActiveLeaseDoctorLine(lease))
  const stalledWorkerLines = health.runtime.stalledWorkerDetails.length === 0
    ? ['none']
    : health.runtime.stalledWorkerDetails.map((worker) => formatStalledWorkerLine(worker))
  const recoveryHistoryLines = health.runtime.recentRecoveryActions.length === 0
    ? ['none']
    : health.runtime.recentRecoveryActions.map((action) => formatRecoveryActionDoctorLine(action))
  const gitHubAuditLines = snapshot.githubAudit === null
    ? ['not requested']
    : !snapshot.githubAudit.ok
      ? [`unavailable: ${snapshot.githubAudit.error ?? 'unknown error'}`]
      : snapshot.githubAudit.checks.length === 0
        ? ['none']
        : snapshot.githubAudit.checks.map((check) => formatGitHubAuditLine(check))
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
    'Active Leases',
    ...activeLeaseLines,
    '',
    'Stalled Workers',
    ...stalledWorkerLines,
    '',
    'Recent Recovery Actions',
    ...recoveryHistoryLines,
    '',
    'GitHub Audit',
    ...gitHubAuditLines,
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
  const adoptableLeases = snapshot.health.runtime.activeLeaseDetails.filter((lease) => lease.adoptable)
  if (adoptableLeases.length > 0) {
    warnings.push(`adoptable leases detected: ${adoptableLeases.map((lease) => formatLeaseIdentity(lease.scope, lease.targetNumber)).join(', ')}`)
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
  const repeatedRecoveriesByTarget = summarizeRepeatedRecoveriesByTarget(snapshot.health.runtime.recentRecoveryActions)
  if (repeatedRecoveriesByTarget.length > 0) {
    warnings.push(`same target recovered multiple times recently: ${repeatedRecoveriesByTarget.join(', ')}`)
  }
  if ((snapshot.metrics?.autoFixes.push_failed ?? 0) > 0) {
    warnings.push(`review auto-fix push failures observed: ${snapshot.metrics?.autoFixes.push_failed}`)
  }
  if (((snapshot.metrics?.mergeRecovery.refresh_push_failed ?? 0) + (snapshot.metrics?.mergeRecovery.retry_merge_failed ?? 0)) > 0) {
    warnings.push('merge recovery has recent push/merge retry failures; inspect the latest PR recovery comments')
  }
  if (snapshot.githubAudit?.warnings.length) {
    warnings.push(...snapshot.githubAudit.warnings)
  }

  return warnings
}

export async function collectGitHubLeaseAudit(
  health: Pick<DaemonHealthPayload, 'repo' | 'runtime' | 'daemonInstanceId'>,
  runner: GhJsonRunner = runGhJsonCommand,
): Promise<GitHubLeaseAudit> {
  const localChecks = await Promise.all(health.runtime.activeLeaseDetails.map(async (lease) => {
    const result = lease.scope === 'issue-process'
      ? await runner([
          'issue',
          'view',
          String(lease.issueNumber ?? lease.targetNumber),
          '--repo',
          health.repo,
          '--json',
          'number,state,labels',
        ])
      : await runner([
          'pr',
          'view',
          String(lease.prNumber ?? lease.targetNumber),
          '--repo',
          health.repo,
          '--json',
          'number,state,labels',
        ])

    return buildGitHubLeaseAuditCheck({
      scope: lease.scope,
      targetNumber: lease.targetNumber,
      issueNumber: lease.issueNumber,
      prNumber: lease.prNumber,
      source: 'local',
      commentId: lease.commentId,
      daemonInstanceId: lease.daemonInstanceId,
      machineId: lease.machineId,
      phase: lease.phase,
      heartbeatAgeSeconds: lease.heartbeatAgeSeconds,
      expiresInSeconds: lease.expiresInSeconds,
      adoptable: lease.adoptable,
    }, result)
  }))

  const remote = await collectRemoteGitHubLeaseChecks(
    health,
    new Set(localChecks.map((check) => buildLeaseAuditKey(check.scope, check.targetNumber))),
    runner,
  )
  const checks = [...localChecks, ...remote.checks]
  const unavailable = checks.find((check) => check.warning?.startsWith('GitHub audit unavailable:')) ?? null
  const error = unavailable?.warning?.replace(/^GitHub audit unavailable:\s*/, '')
    ?? remote.error

  return {
    ok: error === null,
    error,
    checks,
    warnings: [
      ...checks.flatMap((check) => check.warning ? [check.warning] : []),
      ...(remote.error ? [`GitHub audit unavailable: ${remote.error}`] : []),
    ],
  }
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

function formatActiveLeaseInlineSummary(details: DaemonHealthPayload['runtime']['activeLeaseDetails']): string {
  const rendered = details.slice(0, 3).map((lease) => {
    const activity = `${formatLeaseIdentity(lease.scope, lease.targetNumber)} ${lease.phase}`
    const heartbeat = `hb=${formatNullableSeconds(lease.heartbeatAgeSeconds)}`
    const progress = `progress=${formatNullableSeconds(lease.progressAgeSeconds)}`
    const adoption = lease.adoptable ? 'adoptable=yes' : 'adoptable=no'
    return `${activity} ${heartbeat} ${progress} ${adoption}`
  })

  if (details.length > 3) {
    rendered.push(`+${details.length - 3} more`)
  }

  return rendered.join(' | ')
}

function formatRecoveryActionInlineSummary(actions: DaemonHealthPayload['runtime']['recentRecoveryActions']): string {
  const rendered = actions.slice(0, 3).map((action) => {
    const target = action.scope && action.targetNumber !== null
      ? ` ${formatLeaseIdentity(action.scope, action.targetNumber)}`
      : ''
    return `${action.kind}/${action.outcome}${target}`
  })

  if (actions.length > 3) {
    rendered.push(`+${actions.length - 3} more`)
  }

  return rendered.join(' | ')
}

function formatActiveLeaseDoctorLine(lease: DaemonHealthPayload['runtime']['activeLeaseDetails'][number]): string {
  return [
    `${formatLeaseIdentity(lease.scope, lease.targetNumber)} comment=${lease.commentId}`,
    `phase=${lease.phase}`,
    `attempt=${lease.attempt}`,
    `status=${lease.status}`,
    `hb=${formatNullableSeconds(lease.heartbeatAgeSeconds)}`,
    `progress=${formatNullableSeconds(lease.progressAgeSeconds)}`,
    `expires=${formatNullableSeconds(lease.expiresInSeconds)}`,
    `adoptable=${lease.adoptable ? 'yes' : 'no'}`,
    `daemon=${lease.daemonInstanceId}`,
    `branch=${lease.branch ?? 'n/a'}`,
  ].join(' | ')
}

function formatStalledWorkerLine(worker: DaemonHealthPayload['runtime']['stalledWorkerDetails'][number]): string {
  return `${formatLeaseIdentity(worker.scope, worker.targetNumber)} stuck ${formatNullableSeconds(worker.durationSeconds)} | since ${worker.since} | ${worker.reason}`
}

function formatRecoveryActionDoctorLine(action: DaemonHealthPayload['runtime']['recentRecoveryActions'][number]): string {
  const target = action.scope && action.targetNumber !== null
    ? formatLeaseIdentity(action.scope, action.targetNumber)
    : 'n/a'
  return `${action.at} | ${action.kind}/${action.outcome} | target=${target} | reason=${action.reason ?? 'n/a'}`
}

function formatGitHubAuditLine(check: GitHubLeaseAuditCheck): string {
  const status = check.warning ? `warning=${check.warning}` : 'ok'
  const labels = check.labels.length > 0 ? check.labels.join(',') : 'none'
  const extras = [
    check.source ? `source=${check.source}` : null,
    check.commentId !== null && check.commentId !== undefined ? `comment=${check.commentId}` : null,
    check.daemonInstanceId ? `daemon=${check.daemonInstanceId}` : null,
    check.machineId ? `machine=${check.machineId}` : null,
    check.phase ? `phase=${check.phase}` : null,
    check.heartbeatAgeSeconds !== null && check.heartbeatAgeSeconds !== undefined
      ? `hb=${formatNullableSeconds(check.heartbeatAgeSeconds)}`
      : null,
    check.expiresInSeconds !== null && check.expiresInSeconds !== undefined
      ? `expires=${formatNullableSeconds(check.expiresInSeconds)}`
      : null,
    check.adoptable !== null && check.adoptable !== undefined ? `adoptable=${check.adoptable ? 'yes' : 'no'}` : null,
  ].filter((value): value is string => value !== null)

  return `${formatLeaseIdentity(check.scope, check.targetNumber)} | state=${check.state} | labels=${labels} | ${status}${extras.length > 0 ? ` | ${extras.join(' | ')}` : ''}`
}

function summarizeRepeatedRecoveriesByTarget(
  actions: DaemonHealthPayload['runtime']['recentRecoveryActions'],
): string[] {
  const counts = new Map<string, number>()

  for (const action of actions) {
    if (action.outcome !== 'recoverable' || !action.scope || action.targetNumber === null) continue
    const key = formatLeaseIdentity(action.scope, action.targetNumber)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([key, count]) => `${key}=${count}`)
}

function formatLeaseIdentity(scope: string, targetNumber: number): string {
  return `${scope}#${targetNumber}`
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function inferIssueStateFromLabels(labels: string[]): string {
  const labelSet = new Set(labels)

  if (labelSet.has('agent:done')) return 'done'
  if (labelSet.has('agent:failed')) return 'failed'
  if (labelSet.has('agent:working')) return 'working'
  if (labelSet.has('agent:claimed')) return 'claimed'
  if (labelSet.has('agent:stale')) return 'stale'
  if (labelSet.has('agent:ready')) return 'ready'
  return 'unknown'
}

function buildGitHubLeaseAuditCheck(
  lease: LeaseAuditSubject,
  result: GhJsonResult,
): GitHubLeaseAuditCheck {
  if (!result.ok) {
    return {
      scope: lease.scope,
      targetNumber: lease.targetNumber,
      state: 'unknown',
      labels: [],
      warning: `GitHub audit unavailable: ${result.error ?? 'unknown gh error'}`,
      source: lease.source,
      commentId: lease.commentId,
      daemonInstanceId: lease.daemonInstanceId,
      machineId: lease.machineId,
      phase: lease.phase,
      heartbeatAgeSeconds: lease.heartbeatAgeSeconds,
      expiresInSeconds: lease.expiresInSeconds,
      adoptable: lease.adoptable,
    }
  }

  const { state, labels } = extractGitHubAuditState(result.data)

  return {
    scope: lease.scope,
    targetNumber: lease.targetNumber,
    state,
    labels,
    warning: evaluateGitHubLeaseAuditWarning(lease, state, labels),
    source: lease.source,
    commentId: lease.commentId,
    daemonInstanceId: lease.daemonInstanceId,
    machineId: lease.machineId,
    phase: lease.phase,
    heartbeatAgeSeconds: lease.heartbeatAgeSeconds,
    expiresInSeconds: lease.expiresInSeconds,
    adoptable: lease.adoptable,
  }
}

function evaluateGitHubLeaseAuditWarning(
  lease: Pick<LeaseAuditSubject, 'scope' | 'targetNumber'>,
  remoteState: string,
  labels: string[],
): string | null {
  const labelSet = new Set(labels)

  if (lease.scope === 'issue-process') {
    const issueState = inferIssueStateFromLabels(labels)
    if (remoteState === 'closed') {
      return `${formatLeaseIdentity(lease.scope, lease.targetNumber)} has an active lease but the issue is closed`
    }
    if (issueState !== 'working') {
      return `${formatLeaseIdentity(lease.scope, lease.targetNumber)} has an active lease but issue state is ${issueState} (expected working)`
    }
    return null
  }

  if (remoteState !== 'open') {
    return `${formatLeaseIdentity(lease.scope, lease.targetNumber)} has an active lease but the PR state is ${remoteState}`
  }

  if (lease.scope === 'pr-review' && labelSet.has(PR_REVIEW_LABELS.HUMAN_NEEDED)) {
    return `${formatLeaseIdentity(lease.scope, lease.targetNumber)} has an active review lease but the PR is labeled ${PR_REVIEW_LABELS.HUMAN_NEEDED}`
  }

  if (lease.scope === 'pr-merge' && !labelSet.has(PR_REVIEW_LABELS.APPROVED)) {
    return `${formatLeaseIdentity(lease.scope, lease.targetNumber)} has an active merge lease but the PR is missing ${PR_REVIEW_LABELS.APPROVED}`
  }

  return null
}

async function collectRemoteGitHubLeaseChecks(
  health: Pick<DaemonHealthPayload, 'repo' | 'runtime' | 'daemonInstanceId'>,
  knownKeys: Set<string>,
  runner: GhJsonRunner,
): Promise<{ checks: GitHubLeaseAuditCheck[]; error: string | null }> {
  const [issueListResult, prListResult] = await Promise.all([
    runner([
      'issue',
      'list',
      '--repo',
      health.repo,
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,state,labels',
    ]),
    runner([
      'pr',
      'list',
      '--repo',
      health.repo,
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,state,labels,headRefName',
    ]),
  ])

  if (!issueListResult.ok) {
    return {
      checks: [],
      error: issueListResult.error ?? 'failed to list open issues',
    }
  }
  if (!prListResult.ok) {
    return {
      checks: [],
      error: prListResult.error ?? 'failed to list open PRs',
    }
  }

  const checks: GitHubLeaseAuditCheck[] = []
  const openIssues = normalizeGitHubIssueList(issueListResult.data)
    .filter((issue) => issue.labels.some((label) => label.startsWith('agent:')))
  const openPrs = normalizeGitHubPrList(prListResult.data)
    .filter((pr) => pr.headRefName.startsWith('agent/'))

  for (const issue of openIssues) {
    const key = buildLeaseAuditKey('issue-process', issue.number)
    if (knownKeys.has(key)) continue

    const commentResult = await fetchActiveRemoteManagedLease({
      repo: health.repo,
      targetNumber: issue.number,
      scope: 'issue-process',
      runner,
    })
    if (commentResult.error) {
      return {
        checks,
        error: `issue-process#${issue.number}: ${commentResult.error}`,
      }
    }
    if (!commentResult.comment) continue

    checks.push(buildGitHubLeaseAuditCheckFromState(
      buildLeaseAuditSubjectFromComment(commentResult.comment, issue.number, 'remote', health.daemonInstanceId),
      issue.state,
      issue.labels,
    ))
  }

  for (const pr of openPrs) {
    const commentResult = await fetchRemoteManagedLeaseComments(pr.number, runner, health.repo)
    if (commentResult.error) {
      return {
        checks,
        error: `PR #${pr.number}: ${commentResult.error}`,
      }
    }
    if (!commentResult.comments) continue

    for (const scope of ['pr-review', 'pr-merge'] as const) {
      const key = buildLeaseAuditKey(scope, pr.number)
      if (knownKeys.has(key)) continue

      const comment = getActiveManagedLease(commentResult.comments, scope)
      if (!comment) continue

      checks.push(buildGitHubLeaseAuditCheckFromState(
        buildLeaseAuditSubjectFromComment(comment, pr.number, 'remote', health.daemonInstanceId),
        pr.state,
        pr.labels,
      ))
    }
  }

  return {
    checks,
    error: null,
  }
}

async function fetchActiveRemoteManagedLease(options: {
  repo: string
  targetNumber: number
  scope: ManagedLeaseScope
  runner: GhJsonRunner
}): Promise<{ comment: ReturnType<typeof getActiveManagedLease>; error: string | null }> {
  const commentResult = await fetchRemoteManagedLeaseComments(options.targetNumber, options.runner, options.repo)
  if (commentResult.error) {
    return {
      comment: null,
      error: commentResult.error,
    }
  }

  return {
    comment: commentResult.comments ? getActiveManagedLease(commentResult.comments, options.scope) : null,
    error: null,
  }
}

async function fetchRemoteManagedLeaseComments(
  targetNumber: number,
  runner: GhJsonRunner,
  repo: string,
): Promise<{ comments: IssueComment[] | null; error: string | null }> {
  const result = await runner([
    'api',
    `repos/${repo}/issues/${targetNumber}/comments`,
    '--paginate',
  ])
  if (!result.ok) {
    return {
      comments: null,
      error: result.error ?? 'failed to list issue comments',
    }
  }

  return {
    comments: mapIssueComments(result.data),
    error: null,
  }
}

function buildGitHubLeaseAuditCheckFromState(
  lease: LeaseAuditSubject,
  state: string,
  labels: string[],
): GitHubLeaseAuditCheck {
  return {
    scope: lease.scope,
    targetNumber: lease.targetNumber,
    state,
    labels,
    warning: evaluateGitHubLeaseAuditWarning(lease, state, labels),
    source: lease.source,
    commentId: lease.commentId,
    daemonInstanceId: lease.daemonInstanceId,
    machineId: lease.machineId,
    phase: lease.phase,
    heartbeatAgeSeconds: lease.heartbeatAgeSeconds,
    expiresInSeconds: lease.expiresInSeconds,
    adoptable: lease.adoptable,
  }
}

function buildLeaseAuditSubjectFromComment(
  comment: NonNullable<Awaited<ReturnType<typeof fetchActiveRemoteManagedLease>>['comment']>,
  targetNumber: number,
  source: 'remote',
  daemonInstanceId: string,
): LeaseAuditSubject {
  const expiresInSeconds = parseRemainingSeconds(comment.lease.expiresAt)
  return {
    scope: comment.lease.scope,
    targetNumber,
    issueNumber: comment.lease.issueNumber ?? null,
    prNumber: comment.lease.prNumber ?? null,
    source,
    commentId: comment.commentId,
    daemonInstanceId: comment.lease.daemonInstanceId,
    machineId: comment.lease.machineId,
    phase: comment.lease.phase,
    heartbeatAgeSeconds: parseAgeSeconds(comment.lease.lastHeartbeatAt),
    expiresInSeconds,
    adoptable: comment.lease.daemonInstanceId === daemonInstanceId || expiresInSeconds === 0,
  }
}

function buildLeaseAuditKey(scope: ManagedLeaseScope, targetNumber: number): string {
  return `${scope}:${targetNumber}`
}

function extractGitHubAuditState(data: unknown): { state: string; labels: string[] } {
  const payload = (data ?? {}) as {
    state?: unknown
    labels?: Array<{ name?: unknown }>
  }

  return {
    state: typeof payload.state === 'string' ? payload.state.toLowerCase() : 'unknown',
    labels: normalizeGitHubLabels(payload.labels),
  }
}

function normalizeGitHubIssueList(data: unknown): Array<{ number: number; state: string; labels: string[] }> {
  if (!Array.isArray(data)) return []

  return data
    .map((item) => {
      const issue = item as GitHubIssueListItem
      if (typeof issue.number !== 'number') return null
      return {
        number: issue.number,
        state: typeof issue.state === 'string' ? issue.state.toLowerCase() : 'unknown',
        labels: normalizeGitHubLabels(issue.labels),
      }
    })
    .filter((item): item is { number: number; state: string; labels: string[] } => item !== null)
}

function normalizeGitHubPrList(
  data: unknown,
): Array<{ number: number; state: string; labels: string[]; headRefName: string }> {
  if (!Array.isArray(data)) return []

  return data
    .map((item) => {
      const pr = item as GitHubPrListItem
      if (typeof pr.number !== 'number' || typeof pr.headRefName !== 'string') return null
      return {
        number: pr.number,
        state: typeof pr.state === 'string' ? pr.state.toLowerCase() : 'unknown',
        labels: normalizeGitHubLabels(pr.labels),
        headRefName: pr.headRefName,
      }
    })
    .filter((item): item is { number: number; state: string; labels: string[]; headRefName: string } => item !== null)
}

function normalizeGitHubLabels(labels: Array<{ name?: unknown }> | undefined): string[] {
  return Array.isArray(labels)
    ? labels
      .map((label) => typeof label?.name === 'string' ? label.name : null)
      .filter((label): label is string => label !== null)
    : []
}

function mapIssueComments(data: unknown): IssueComment[] {
  if (!Array.isArray(data)) return []

  return data.map((comment) => {
    const payload = comment as {
      id?: unknown
      body?: unknown
      created_at?: unknown
      updated_at?: unknown
    }
    return {
      commentId: typeof payload.id === 'number' ? payload.id : 0,
      body: typeof payload.body === 'string' ? payload.body : '',
      createdAt: typeof payload.created_at === 'string' ? payload.created_at : '',
      updatedAt: typeof payload.updated_at === 'string'
        ? payload.updated_at
        : typeof payload.created_at === 'string'
          ? payload.created_at
          : '',
    }
  })
}

function parseAgeSeconds(value: string): number {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, Math.floor((Date.now() - parsed) / 1000))
}

function parseRemainingSeconds(value: string): number {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, Math.floor((parsed - Date.now()) / 1000))
}

async function runGhJsonCommand(args: string[]): Promise<GhJsonResult> {
  const proc = Bun.spawn(['gh', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    return {
      ok: false,
      data: null,
      error: stderr.trim() || stdout.trim() || `gh ${args.join(' ')} exited ${exitCode}`,
    }
  }

  try {
    return {
      ok: true,
      data: JSON.parse(stdout),
      error: null,
    }
  } catch (error) {
    return {
      ok: false,
      data: null,
      error: `failed to parse gh json: ${formatError(error)}`,
    }
  }
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
