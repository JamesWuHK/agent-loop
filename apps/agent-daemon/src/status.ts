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
  BLOCKED_ISSUE_RESUME_WARNING_AGE_SECONDS,
  HEALTH_PATH,
  evaluateBlockedIssueResumeResolution,
  getFailedIssueResumeBlock,
} from './daemon'
import {
  METRICS_PATH,
  METRICS_PORT_DEFAULT,
} from './metrics'
import {
  canResumeHumanNeededPrReview,
  extractLatestAutomatedPrReviewBlockerSummary,
} from './pr-reviewer'
import type { BackgroundRuntimeSnapshot } from './background'
import {
  buildLaunchdServicePaths,
  inspectLaunchdService,
  type LaunchdServiceRuntimeDetail,
} from './launchd'

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
const WAKE_KIND_ORDER = ['now', 'issue', 'pr'] as const
const WAKE_OUTCOME_ORDER = ['queued', 'started_work', 'no_match', 'allow_fallback'] as const
const GITHUB_API_REQUEST_KEY_ORDER = ['graphql/direct', 'graphql/gh_cli', 'rest/direct', 'rest/gh_cli'] as const
const GITHUB_API_OUTCOME_ORDER = ['success', 'error', 'timeout', 'rate_limited'] as const
const GITHUB_AUDIT_MAX_AUTOMATED_PR_REVIEW_ATTEMPTS = 3
const RECENT_TRANSIENT_LOOP_ERROR_WARNING_AGE_SECONDS = 5 * 60
export interface DaemonHealthPayload extends DaemonStatus {
  status: 'running' | 'stopped'
  mode: string
  version: string
}

export interface DaemonMetricSummary {
  polls: Record<string, number>
  githubApiRequests: Record<string, Record<string, number>>
  wakeRequests: Record<string, Record<string, number>>
  prReviews: Record<string, Record<string, number>>
  autoFixes: Record<string, number>
  mergeRecovery: Record<string, number>
  recoveryActions: Record<string, Record<string, number>>
  transientLoopErrors: Record<string, number>
  workerIdleTimeouts: Record<string, number>
  lastTransientLoopErrorAgeSeconds: number | null
  nextPollDelaySeconds: number | null
  pendingWakeRequests: number | null
  activeLeases: number | null
  leaseHeartbeatAgeSeconds: number | null
  stalledWorkers: number | null
  blockedIssueResumes: number | null
  blockedIssueResumeAgeSeconds: number | null
  blockedIssueResumeEscalations: number | null
  blockedIssueResumeEscalationAgeSeconds: number | null
  autoUpgradeAttempts: number | null
  autoUpgradeSuccesses: number | null
  autoUpgradeFailures: number | null
  autoUpgradeNoChanges: number | null
  autoUpgradeLastAttemptAgeSeconds: number | null
  autoUpgradeLastSuccessAgeSeconds: number | null
  leaseConflicts: number
  rateLimitHits: number
}

export interface DaemonObservabilitySnapshot {
  ok: boolean
  healthUrl: string
  metricsUrl: string | null
  error: string | null
  diagnosticRepo: string | null
  localRuntime: LocalRuntimeDiagnostic | null
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
  fallbackRepo?: string
  fallbackDaemonInstanceId?: string
  fallbackRuntime?: BackgroundRuntimeSnapshot
  ghRunner?: GhJsonRunner
  launchdInspector?: LaunchdInspector
}

export interface LocalRuntimeDiagnostic {
  supervisor: 'detached' | 'launchd'
  alive: boolean
  pid: number
  cwd: string
  recordPath: string
  logPath: string
  startedAt: string
  repo: string
  machineId: string
  healthPort: number
  metricsPort: number
  launchd: LocalLaunchdDiagnostic | null
}

export interface LocalLaunchdDiagnostic {
  serviceTarget: string
  plistPath: string
  installed: boolean
  loaded: boolean
  runtime: LaunchdServiceRuntimeDetail | null
}

type LaunchdInspector = (runtime: LocalRuntimeDiagnostic) => LocalLaunchdDiagnostic | null

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
  blockedAgeSeconds?: number | null
  source?: 'local' | 'remote'
  commentId?: number | null
  daemonInstanceId?: string | null
  machineId?: string | null
  phase?: string | null
  heartbeatAgeSeconds?: number | null
  expiresInSeconds?: number | null
  adoptable?: boolean | null
}

export interface GitHubPrBlockerSummary {
  prNumber: number
  issueNumber: number | null
  labels: string[]
  headRefName: string
  attempt: number | null
  reason: string
  findingSummary: string | null
  updatedAt: string | null
  resumable: boolean
}

export interface GitHubLeaseAudit {
  ok: boolean
  error: string | null
  checks: GitHubLeaseAuditCheck[]
  prBlockers: GitHubPrBlockerSummary[]
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
  updatedAt?: unknown
  body?: unknown
  labels?: GitHubListLabel[]
}

interface GitHubPrListItem extends GitHubIssueListItem {
  headRefName?: unknown
  headRefOid?: unknown
}

interface GitHubAuditInput {
  repo: string
  daemonInstanceId: string
  runtime: {
    activeLeaseDetails: DaemonHealthPayload['runtime']['activeLeaseDetails']
  }
}

export async function collectDaemonObservability(
  options: StatusCommandOptions = {},
): Promise<DaemonObservabilitySnapshot> {
  const healthHost = options.healthHost ?? DEFAULT_HEALTH_SERVER_HOST
  const healthPort = options.healthPort ?? DEFAULT_HEALTH_SERVER_PORT
  const healthUrl = buildEndpointUrl(healthHost, healthPort, HEALTH_PATH)
  const localRuntime = options.fallbackRuntime
    ? enrichLocalRuntimeDiagnostic(
        toLocalRuntimeDiagnostic(options.fallbackRuntime),
        options.launchdInspector ?? inspectLocalLaunchdRuntime,
      )
    : null

  let health: DaemonHealthPayload
  try {
    const response = await requestLocalEndpoint(healthUrl)
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return buildUnreachableSnapshot(
        healthUrl,
        `GET ${healthUrl} returned ${response.statusCode} ${response.statusText}`.trim(),
        options,
      )
    }
    health = JSON.parse(response.body) as DaemonHealthPayload
  } catch (error) {
    return buildUnreachableSnapshot(
      healthUrl,
      `GET ${healthUrl} failed: ${formatError(error)}`,
      options,
    )
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
    diagnosticRepo: health.repo,
    localRuntime,
    health,
    metrics,
    metricsError,
    githubAudit: null,
    warnings: [],
  }
  if (options.includeGitHubAudit) {
    snapshot.githubAudit = await collectGitHubLeaseAudit(health, options.ghRunner)
  }
  snapshot.warnings = buildDoctorWarnings(snapshot)
  return snapshot
}

async function buildUnreachableSnapshot(
  healthUrl: string,
  error: string,
  options: StatusCommandOptions,
): Promise<DaemonObservabilitySnapshot> {
  let githubAudit: GitHubLeaseAudit | null = null
  if (options.includeGitHubAudit && options.fallbackRepo) {
    githubAudit = await collectGitHubLeaseAudit({
      repo: options.fallbackRepo,
      daemonInstanceId: options.fallbackDaemonInstanceId ?? '',
      runtime: {
        activeLeaseDetails: [],
      },
    }, options.ghRunner)
  }

  const snapshot: DaemonObservabilitySnapshot = {
    ok: false,
    healthUrl,
    metricsUrl: null,
    error,
    diagnosticRepo: options.fallbackRepo ?? null,
    localRuntime: options.fallbackRuntime
      ? enrichLocalRuntimeDiagnostic(
          toLocalRuntimeDiagnostic(options.fallbackRuntime),
          options.launchdInspector ?? inspectLocalLaunchdRuntime,
        )
      : null,
    health: null,
    metrics: null,
    metricsError: null,
    githubAudit,
    warnings: [
      `daemon health endpoint is not reachable at ${healthUrl}`,
      ...(githubAudit?.warnings ?? []),
    ],
  }

  snapshot.warnings = buildDoctorWarnings(snapshot)
  return snapshot
}

function toLocalRuntimeDiagnostic(snapshot: BackgroundRuntimeSnapshot): LocalRuntimeDiagnostic {
  return {
    supervisor: snapshot.record.supervisor,
    alive: snapshot.alive,
    pid: snapshot.record.pid,
    cwd: snapshot.record.cwd,
    recordPath: snapshot.recordPath,
    logPath: snapshot.record.logPath,
    startedAt: snapshot.record.startedAt,
    repo: snapshot.record.repo,
    machineId: snapshot.record.machineId,
    healthPort: snapshot.record.healthPort,
    metricsPort: snapshot.record.metricsPort,
    launchd: null,
  }
}

function enrichLocalRuntimeDiagnostic(
  runtime: LocalRuntimeDiagnostic,
  launchdInspector: LaunchdInspector,
): LocalRuntimeDiagnostic {
  if (runtime.supervisor !== 'launchd') {
    return runtime
  }

  return {
    ...runtime,
    launchd: launchdInspector(runtime),
  }
}

function inspectLocalLaunchdRuntime(runtime: LocalRuntimeDiagnostic): LocalLaunchdDiagnostic | null {
  try {
    const paths = buildLaunchdServicePaths({
      repo: runtime.repo,
      machineId: runtime.machineId,
      healthPort: runtime.healthPort,
    })
    const status = inspectLaunchdService(paths)

    return {
      serviceTarget: status.serviceTarget,
      plistPath: status.plistPath,
      installed: status.installed,
      loaded: status.loaded,
      runtime: status.runtime,
    }
  } catch {
    return null
  }
}

export function formatStatusReport(snapshot: DaemonObservabilitySnapshot): string {
  const warnings = snapshot.health ? buildDoctorWarnings(snapshot) : snapshot.warnings

  if (!snapshot.ok || !snapshot.health) {
    return [
      'daemon: unreachable',
      ...(snapshot.diagnosticRepo ? [`repo: ${snapshot.diagnosticRepo}`] : []),
      ...(snapshot.localRuntime ? [`local runtime: ${formatLocalRuntimeSummary(snapshot.localRuntime)}`] : []),
      ...(snapshot.localRuntime?.launchd ? [`launchd: ${formatLaunchdInlineSummary(snapshot.localRuntime.launchd)}`] : []),
      ...(snapshot.localRuntime ? [`runtime files: record ${snapshot.localRuntime.recordPath} | log ${snapshot.localRuntime.logPath}`] : []),
      `health: ${snapshot.healthUrl}`,
      `error: ${snapshot.error ?? 'unknown error'}`,
      ...(snapshot.githubAudit?.prBlockers.length
        ? [`pr blockers: ${formatGitHubPrBlockersInlineSummary(snapshot.githubAudit.prBlockers)}`]
        : []),
      `hint: ${buildOfflineStatusHint(snapshot)}`,
    ].join('\n')
  }

  const { health } = snapshot
  const blockedIssueResumeCount = health.runtime.blockedIssueResumeCount ?? 0
  const blockedIssueResumeEscalationCount = health.runtime.blockedIssueResumeEscalationCount ?? 0
  const blockedIssueResumeDetails = health.runtime.blockedIssueResumeDetails ?? []
  const oldestBlockedIssueResumeAgeSeconds = health.runtime.oldestBlockedIssueResumeAgeSeconds ?? 0
  const oldestBlockedIssueResumeEscalationAgeSeconds = health.runtime.oldestBlockedIssueResumeEscalationAgeSeconds ?? 0
  const transientLoopErrorCount = health.runtime.transientLoopErrorCount ?? 0
  const startupRecoveryDeferredCount = health.runtime.startupRecoveryDeferredCount ?? 0
  const lines = [
    `daemon: ${health.status} v${health.version} (${health.mode})`,
    `agent-loop: repo ${health.agentLoop?.repo ?? 'unknown'} | revision ${formatRevision(health.agentLoop?.revision ?? null)} | upgrade ${formatUpgradeSummary(health.upgrade)}`,
    `repo: ${health.repo}`,
    `project: ${health.project.profile} | agents: ${health.agent.primary} -> ${health.agent.fallback ?? 'none'}`,
    `daemon: ${health.machineId} / ${health.daemonInstanceId}`,
    `process: ${formatRuntimeManagerSummary(health.runtime.supervisor, health.pid, health.runtime.workingDirectory)}`,
    `concurrency: ${formatConcurrencyPolicy(health.concurrencyPolicy)}`,
    `poll intervals: active ${health.pollIntervalMs}ms | idle ${health.idlePollIntervalMs ?? health.pollIntervalMs}ms`,
    `runtime: active ${health.runtime.effectiveActiveTasks}/${health.concurrency} | worktrees ${health.activeWorktrees.length} | pr reviews ${health.runtime.activePrReviews} | issue loop ${formatBoolean(health.runtime.inFlightIssueProcess)} | review loop ${formatBoolean(health.runtime.inFlightPrReview)}`,
    `recovery: heartbeat ${health.recovery.heartbeatIntervalMs}ms | ttl ${health.recovery.leaseTtlMs}ms | idle ${health.recovery.workerIdleTimeoutMs}ms | adopt backoff ${health.recovery.leaseAdoptionBackoffMs}ms`,
    `connectivity: transient ${transientLoopErrorCount} | startup deferred ${startupRecoveryDeferredCount} | last transient ${formatTransientLoopError(health.runtime.lastTransientLoopErrorKind, health.runtime.lastTransientLoopErrorAgeSeconds)}`,
    `leases: active ${health.runtime.activeLeaseCount} | oldest heartbeat ${formatNullableSeconds(health.runtime.oldestLeaseHeartbeatAgeSeconds)} | stalled ${health.runtime.stalledWorkerCount} | last recovery ${formatLastRecovery(health.runtime.lastRecoveryActionKind, health.runtime.lastRecoveryActionAt)}`,
    `state: startup pending ${formatBoolean(health.runtime.startupRecoveryPending)} | failed resumes ${health.runtime.failedIssueResumeAttemptsTracked} | cooldowns ${health.runtime.failedIssueResumeCooldownsTracked} | blocked resumes ${blockedIssueResumeCount} | oldest blocked ${formatNullableSeconds(oldestBlockedIssueResumeAgeSeconds)} | escalated ${blockedIssueResumeEscalationCount} | oldest escalation ${formatNullableSeconds(oldestBlockedIssueResumeEscalationAgeSeconds)}`,
    `auto-upgrade: ${formatAutoUpgradeRuntimeSummary(health.runtime.autoUpgrade ?? null)}`,
    `poll: last ${health.lastPollAt ?? 'never'} | last claim ${health.lastClaimedAt ?? 'never'} | next ${formatNextPollSummary(health.nextPollAt, health.nextPollReason, health.nextPollDelayMs)}`,
  ]

  if (health.runtime.activeLeaseDetails.length > 0) {
    lines.push(`lease detail: ${formatActiveLeaseInlineSummary(health.runtime.activeLeaseDetails)}`)
  }
  if (health.runtime.recentRecoveryActions.length > 0) {
    lines.push(`recent recovery: ${formatRecoveryActionInlineSummary(health.runtime.recentRecoveryActions)}`)
  }
  if (blockedIssueResumeDetails.length > 0) {
    lines.push(`blocked resumes: ${formatBlockedIssueResumeInlineSummary(blockedIssueResumeDetails)}`)
  }
  if (snapshot.localRuntime?.launchd) {
    lines.push(`launchd: ${formatLaunchdInlineSummary(snapshot.localRuntime.launchd)}`)
  }
  if (health.runtime.runtimeRecordPath || health.runtime.logPath) {
    lines.push(
      `runtime files: record ${health.runtime.runtimeRecordPath ?? 'none'} | log ${health.runtime.logPath ?? 'none'}`,
    )
  }

  if (snapshot.metrics) {
    const reviewTotals = summarizeReviewOutcomes(snapshot.metrics.prReviews)
    lines.push(
      `outcomes: polls ${formatOrderedMap(snapshot.metrics.polls, POLL_OUTCOME_ORDER)} | wake ${formatOrderedMap(summarizeWakeOutcomes(snapshot.metrics.wakeRequests), WAKE_OUTCOME_ORDER)} | reviews ${formatOrderedMap(reviewTotals, REVIEW_OUTCOME_ORDER)} | auto-fix ${formatOrderedMap(snapshot.metrics.autoFixes, AUTO_FIX_OUTCOME_ORDER)} | merge ${formatOrderedMap(snapshot.metrics.mergeRecovery, MERGE_RECOVERY_OUTCOME_ORDER)}`,
    )
    lines.push(`github api: ${formatGitHubApiRequestSummary(snapshot.metrics.githubApiRequests)}`)
    lines.push(`auto-upgrade metrics: ${formatAutoUpgradeMetricSummary(snapshot.metrics)}`)
    lines.push(
      `wake: pending ${snapshot.metrics.pendingWakeRequests ?? 0} | ${formatWakeRequestSummary(snapshot.metrics.wakeRequests)}`,
    )
  } else if (snapshot.metricsError) {
    lines.push(`metrics: unavailable (${snapshot.metricsError})`)
  }

  lines.push(
    `endpoints: health ${snapshot.healthUrl} | metrics ${snapshot.metricsUrl ?? 'unknown'}`,
  )
  if (snapshot.githubAudit?.prBlockers.length) {
    lines.push(`pr blockers: ${formatGitHubPrBlockersInlineSummary(snapshot.githubAudit.prBlockers)}`)
  }

  if (warnings.length > 0) {
    lines.push(`warnings: ${warnings.join(' | ')}`)
  }

  return lines.join('\n')
}

export function formatDoctorReport(snapshot: DaemonObservabilitySnapshot): string {
  const warnings = snapshot.health ? buildDoctorWarnings(snapshot) : snapshot.warnings

  if (!snapshot.ok || !snapshot.health) {
    const gitHubAuditLines = snapshot.githubAudit === null
      ? ['not available']
      : !snapshot.githubAudit.ok
        ? [`unavailable: ${snapshot.githubAudit.error ?? 'unknown error'}`]
        : snapshot.githubAudit.checks.length === 0
          ? ['none']
          : snapshot.githubAudit.checks.map((check) => formatGitHubAuditLine(check))
    const prBlockerLines = snapshot.githubAudit === null
      ? ['not available']
      : snapshot.githubAudit.prBlockers.length === 0
        ? ['none']
        : snapshot.githubAudit.prBlockers.map((blocker) => formatGitHubPrBlockerLine(blocker))

    return [
      'Daemon Doctor',
      '',
      `health: unreachable (${snapshot.healthUrl})`,
      `error: ${snapshot.error ?? 'unknown error'}`,
      ...(snapshot.diagnosticRepo ? ['', 'Config', `repo: ${snapshot.diagnosticRepo}`] : []),
      ...(snapshot.localRuntime
        ? [
            '',
            'Local Runtime',
            `supervisor: ${snapshot.localRuntime.supervisor}`,
            `state: ${snapshot.localRuntime.alive ? 'alive' : 'stale'}`,
            `pid: ${snapshot.localRuntime.pid}`,
            `cwd: ${snapshot.localRuntime.cwd}`,
            `started: ${snapshot.localRuntime.startedAt}`,
            `runtime record: ${snapshot.localRuntime.recordPath}`,
            `log file: ${snapshot.localRuntime.logPath}`,
            ...(snapshot.localRuntime.launchd ? formatLaunchdDoctorLines(snapshot.localRuntime.launchd) : []),
          ]
        : []),
      '',
      'PR Review Blockers',
      ...prBlockerLines,
      '',
      'GitHub Audit',
      ...gitHubAuditLines,
      '',
      'Warnings',
      ...(warnings.length > 0 ? warnings.map((warning) => `- ${warning}`) : ['none']),
      '',
      'Next checks',
      ...buildOfflineDoctorNextChecks(snapshot),
    ].join('\n')
  }

  const { health } = snapshot
  const blockedIssueResumeCount = health.runtime.blockedIssueResumeCount ?? 0
  const blockedIssueResumeEscalationCount = health.runtime.blockedIssueResumeEscalationCount ?? 0
  const blockedIssueResumeDetails = health.runtime.blockedIssueResumeDetails ?? []
  const oldestBlockedIssueResumeAgeSeconds = health.runtime.oldestBlockedIssueResumeAgeSeconds ?? 0
  const oldestBlockedIssueResumeEscalationAgeSeconds = health.runtime.oldestBlockedIssueResumeEscalationAgeSeconds ?? 0
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
  const prBlockerLines = snapshot.githubAudit === null
    ? ['not requested']
    : snapshot.githubAudit.prBlockers.length === 0
      ? ['none']
      : snapshot.githubAudit.prBlockers.map((blocker) => formatGitHubPrBlockerLine(blocker))
  const outcomeLines = snapshot.metrics
    ? [
        `polls: ${formatOrderedMap(snapshot.metrics.polls, POLL_OUTCOME_ORDER)}`,
        `github-api-requests: ${formatGitHubApiRequestSummary(snapshot.metrics.githubApiRequests)}`,
        ...REVIEW_STAGE_ORDER.map((stage) => `reviews.${stage}: ${formatOrderedMap(snapshot.metrics?.prReviews[stage] ?? {}, REVIEW_OUTCOME_ORDER)}`),
        `auto-fix: ${formatOrderedMap(snapshot.metrics.autoFixes, AUTO_FIX_OUTCOME_ORDER)}`,
        `merge-recovery: ${formatOrderedMap(snapshot.metrics.mergeRecovery, MERGE_RECOVERY_OUTCOME_ORDER)}`,
        `transient-loop-errors: ${formatInlineKeyValue(snapshot.metrics.transientLoopErrors) || 'none'}`,
        `last-transient-loop-error-age-seconds: ${snapshot.metrics.lastTransientLoopErrorAgeSeconds ?? 0}`,
        `next-poll-delay-seconds: ${snapshot.metrics.nextPollDelaySeconds ?? 0}`,
        `pending-wake-requests: ${snapshot.metrics.pendingWakeRequests ?? 0}`,
        `wake-requests: ${formatWakeRequestSummary(snapshot.metrics.wakeRequests)}`,
        `lease-conflicts: ${snapshot.metrics.leaseConflicts}`,
        `worker-idle-timeouts: ${formatInlineKeyValue(snapshot.metrics.workerIdleTimeouts) || 'none'}`,
        `blocked-issue-resumes: ${snapshot.metrics.blockedIssueResumes ?? 0}`,
        `blocked-issue-resume-age-seconds: ${snapshot.metrics.blockedIssueResumeAgeSeconds ?? 0}`,
        `blocked-issue-resume-escalations: ${snapshot.metrics.blockedIssueResumeEscalations ?? 0}`,
        `blocked-issue-resume-escalation-age-seconds: ${snapshot.metrics.blockedIssueResumeEscalationAgeSeconds ?? 0}`,
        `auto-upgrade-attempts: ${snapshot.metrics.autoUpgradeAttempts ?? 0}`,
        `auto-upgrade-successes: ${snapshot.metrics.autoUpgradeSuccesses ?? 0}`,
        `auto-upgrade-failures: ${snapshot.metrics.autoUpgradeFailures ?? 0}`,
        `auto-upgrade-no-changes: ${snapshot.metrics.autoUpgradeNoChanges ?? 0}`,
        `auto-upgrade-last-attempt-age-seconds: ${snapshot.metrics.autoUpgradeLastAttemptAgeSeconds ?? 0}`,
        `auto-upgrade-last-success-age-seconds: ${snapshot.metrics.autoUpgradeLastSuccessAgeSeconds ?? 0}`,
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
    `poll interval: active ${health.pollIntervalMs}ms | idle ${health.idlePollIntervalMs ?? health.pollIntervalMs}ms`,
    `recovery heartbeat: ${health.recovery.heartbeatIntervalMs}ms`,
    `lease ttl: ${health.recovery.leaseTtlMs}ms`,
    `worker idle timeout: ${health.recovery.workerIdleTimeoutMs}ms`,
    `lease adoption backoff: ${health.recovery.leaseAdoptionBackoffMs}ms`,
    '',
    'Runtime',
    `supervisor: ${health.runtime.supervisor}`,
    `pid: ${health.pid}`,
    `uptime: ${formatDuration(health.uptimeMs)}`,
    `working directory: ${health.runtime.workingDirectory}`,
    `runtime record: ${health.runtime.runtimeRecordPath ?? 'none'}`,
    `log file: ${health.runtime.logPath ?? 'none'}`,
    ...(snapshot.localRuntime?.launchd ? formatLaunchdDoctorLines(snapshot.localRuntime.launchd) : []),
    `last poll: ${health.lastPollAt ?? 'never'}`,
    `last claimed: ${health.lastClaimedAt ?? 'never'}`,
    `next poll: ${formatNextPollSummary(health.nextPollAt, health.nextPollReason, health.nextPollDelayMs)}`,
    `startup recovery pending: ${formatBoolean(health.runtime.startupRecoveryPending)}`,
    `transient loop errors: ${health.runtime.transientLoopErrorCount ?? 0}`,
    `startup recovery deferred count: ${health.runtime.startupRecoveryDeferredCount ?? 0}`,
    `last transient loop error: ${formatTransientLoopErrorWithMessage(health.runtime.lastTransientLoopErrorKind, health.runtime.lastTransientLoopErrorAgeSeconds, health.runtime.lastTransientLoopErrorMessage)}`,
    `active worktrees: ${health.activeWorktrees.length}`,
    `active pr reviews: ${health.runtime.activePrReviews}`,
    `in-flight issue loop: ${formatBoolean(health.runtime.inFlightIssueProcess)}`,
    `in-flight review loop: ${formatBoolean(health.runtime.inFlightPrReview)}`,
    `effective active tasks: ${health.runtime.effectiveActiveTasks}/${health.concurrency}`,
    `active leases: ${health.runtime.activeLeaseCount}`,
    `oldest lease heartbeat age: ${formatNullableSeconds(health.runtime.oldestLeaseHeartbeatAgeSeconds)}`,
    `stalled workers: ${health.runtime.stalledWorkerCount}`,
    `blocked issue resumes: ${blockedIssueResumeCount}`,
    `oldest blocked issue resume age: ${formatNullableSeconds(oldestBlockedIssueResumeAgeSeconds)}`,
    `blocked issue resume escalations: ${blockedIssueResumeEscalationCount}`,
    `oldest blocked issue resume escalation age: ${formatNullableSeconds(oldestBlockedIssueResumeEscalationAgeSeconds)}`,
    `last recovery action: ${formatLastRecovery(health.runtime.lastRecoveryActionKind, health.runtime.lastRecoveryActionAt)}`,
    `failed issue resume attempts tracked: ${health.runtime.failedIssueResumeAttemptsTracked}`,
    `failed issue resume cooldowns tracked: ${health.runtime.failedIssueResumeCooldownsTracked}`,
    `auto-upgrade runtime: ${formatAutoUpgradeRuntimeSummary(health.runtime.autoUpgrade ?? null)}`,
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
    'Blocked Issue Resumes',
    ...(blockedIssueResumeDetails.length === 0
      ? ['none']
      : blockedIssueResumeDetails.map((blocked) => formatBlockedIssueResumeDoctorLine(blocked))),
    '',
    'Recent Recovery Actions',
    ...recoveryHistoryLines,
    '',
    'PR Review Blockers',
    ...prBlockerLines,
    '',
    'GitHub Audit',
    ...gitHubAuditLines,
    '',
    'Warnings',
    ...(warnings.length > 0 ? warnings.map((warning) => `- ${warning}`) : ['none']),
  ].join('\n')
}

function formatRuntimeManagerSummary(
  supervisor: DaemonHealthPayload['runtime']['supervisor'],
  pid: number,
  cwd: string,
): string {
  return `${supervisor} | pid ${pid} | cwd ${cwd}`
}

function formatLocalRuntimeSummary(runtime: LocalRuntimeDiagnostic): string {
  return `${runtime.supervisor} | ${runtime.alive ? 'alive' : 'stale'} | pid ${runtime.pid} | cwd ${runtime.cwd} | started ${runtime.startedAt}`
}

function formatLaunchdInlineSummary(launchd: LocalLaunchdDiagnostic): string {
  const runtime = launchd.runtime
  return [
    `loaded ${launchd.loaded ? 'yes' : 'no'}`,
    `state ${runtime?.state ?? 'unknown'}`,
    `runs ${runtime?.runs ?? 0}`,
    `last signal ${runtime?.lastTerminatingSignal ?? 'none'}`,
  ].join(' | ')
}

function formatLaunchdDoctorLines(launchd: LocalLaunchdDiagnostic): string[] {
  return [
    `launchd service: ${launchd.serviceTarget}`,
    `launchd plist: ${launchd.plistPath}`,
    `launchd installed: ${launchd.installed ? 'yes' : 'no'}`,
    `launchd loaded: ${launchd.loaded ? 'yes' : 'no'}`,
    `launchd state: ${launchd.runtime?.state ?? 'unknown'}`,
    `launchd active count: ${launchd.runtime?.activeCount ?? 0}`,
    `launchd runs: ${launchd.runtime?.runs ?? 0}`,
    `launchd pid: ${launchd.runtime?.pid ?? 'unknown'}`,
    `launchd last terminating signal: ${launchd.runtime?.lastTerminatingSignal ?? 'none'}`,
  ]
}

function buildOfflineStatusHint(snapshot: DaemonObservabilitySnapshot): string {
  const startArgs = buildDaemonControlArgs(snapshot, '--start')
  const restartArgs = buildDaemonControlArgs(snapshot, '--restart')

  if (snapshot.localRuntime?.launchd?.installed && !snapshot.localRuntime.launchd.loaded) {
    return `launchd service is installed but stopped; rerun the daemon CLI with \`${startArgs}\` or \`${restartArgs}\` to bring it back.`
  }

  if (snapshot.localRuntime && !snapshot.localRuntime.alive) {
    return `local ${snapshot.localRuntime.supervisor} runtime looks stale; rerun the daemon CLI with \`${startArgs}\` to recover it.`
  }

  if (snapshot.localRuntime?.alive) {
    return `the local runtime record is still alive, so confirm pid ${snapshot.localRuntime.pid} is serving the configured health port ${snapshot.localRuntime.healthPort}.`
  }

  return 'start the daemon or pass the correct --health-host/--health-port.'
}

function buildOfflineDoctorNextChecks(snapshot: DaemonObservabilitySnapshot): string[] {
  const startArgs = buildDaemonControlArgs(snapshot, '--start')
  const restartArgs = buildDaemonControlArgs(snapshot, '--restart')

  if (snapshot.localRuntime?.launchd?.installed && !snapshot.localRuntime.launchd.loaded) {
    return [
      `- rerun the daemon CLI with \`${startArgs}\` to reload the launchd service`,
      `- if you want a forced restart instead, rerun with \`${restartArgs}\``,
      `- inspect the daemon log file at ${snapshot.localRuntime.logPath}`,
    ]
  }

  if (snapshot.localRuntime && !snapshot.localRuntime.alive) {
    return [
      `- rerun the daemon CLI with \`${startArgs}\` to recover the stale ${snapshot.localRuntime.supervisor} runtime`,
      `- inspect the daemon log file at ${snapshot.localRuntime.logPath}`,
    ]
  }

  if (snapshot.localRuntime?.alive) {
    return [
      `- confirm pid ${snapshot.localRuntime.pid} is serving the configured health port ${snapshot.localRuntime.healthPort}`,
      '- if the daemon uses a custom port, rerun with --health-port',
    ]
  }

  return [
    '- confirm the daemon process is running',
    '- confirm the health port matches the running daemon',
    '- if the daemon uses a custom port, rerun with --health-port',
  ]
}

function buildDaemonControlArgs(
  snapshot: DaemonObservabilitySnapshot,
  flag: '--start' | '--restart',
): string {
  const repo = snapshot.localRuntime?.repo ?? snapshot.diagnosticRepo ?? null
  const machineId = snapshot.localRuntime?.machineId ?? null
  const healthPort = snapshot.localRuntime?.healthPort ?? parsePortFromUrl(snapshot.healthUrl)
  const parts: string[] = [flag]

  if (repo) {
    parts.push('--repo', repo)
  }
  if (machineId) {
    parts.push('--machine-id', machineId)
  }
  if (healthPort !== null) {
    parts.push('--health-port', String(healthPort))
  }

  return parts.join(' ')
}

function parsePortFromUrl(url: string): number | null {
  try {
    const parsed = new URL(url)
    const port = Number(parsed.port)
    return Number.isFinite(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

export function summarizeDaemonMetrics(metricsText: string): DaemonMetricSummary {
  const summary: DaemonMetricSummary = {
    polls: {},
    githubApiRequests: {},
    wakeRequests: {},
    prReviews: {},
    autoFixes: {},
    mergeRecovery: {},
    recoveryActions: {},
    transientLoopErrors: {},
    workerIdleTimeouts: {},
    lastTransientLoopErrorAgeSeconds: null,
    nextPollDelaySeconds: null,
    pendingWakeRequests: null,
    activeLeases: null,
    leaseHeartbeatAgeSeconds: null,
    stalledWorkers: null,
    blockedIssueResumes: null,
    blockedIssueResumeAgeSeconds: null,
    blockedIssueResumeEscalations: null,
    blockedIssueResumeEscalationAgeSeconds: null,
    autoUpgradeAttempts: null,
    autoUpgradeSuccesses: null,
    autoUpgradeFailures: null,
    autoUpgradeNoChanges: null,
    autoUpgradeLastAttemptAgeSeconds: null,
    autoUpgradeLastSuccessAgeSeconds: null,
    leaseConflicts: 0,
    rateLimitHits: 0,
  }

  for (const sample of parsePrometheusSamples(metricsText)) {
    switch (sample.name) {
      case 'agent_loop_polls_total':
        if (sample.labels.result) summary.polls[sample.labels.result] = sample.value
        break
      case 'agent_loop_github_api_requests_total':
        if (!sample.labels.transport || !sample.labels.mode || !sample.labels.outcome) break
        summary.githubApiRequests[formatGitHubApiRequestKey(sample.labels.transport, sample.labels.mode)] ??= {}
        summary.githubApiRequests[formatGitHubApiRequestKey(sample.labels.transport, sample.labels.mode)]![sample.labels.outcome] = sample.value
        break
      case 'agent_loop_wake_requests_total':
        if (!sample.labels.kind || !sample.labels.outcome) break
        summary.wakeRequests[sample.labels.kind] ??= {}
        summary.wakeRequests[sample.labels.kind]![sample.labels.outcome] = sample.value
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
      case 'agent_loop_transient_loop_errors_total':
        if (sample.labels.kind) summary.transientLoopErrors[sample.labels.kind] = sample.value
        break
      case 'agent_loop_worker_idle_timeouts_total':
        if (sample.labels.scope) summary.workerIdleTimeouts[sample.labels.scope] = sample.value
        break
      case 'agent_loop_last_transient_loop_error_age_seconds':
        summary.lastTransientLoopErrorAgeSeconds = sample.value
        break
      case 'agent_loop_next_poll_delay_seconds':
        summary.nextPollDelaySeconds = sample.value
        break
      case 'agent_loop_pending_wake_requests':
        summary.pendingWakeRequests = sample.value
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
      case 'agent_loop_blocked_issue_resumes':
        summary.blockedIssueResumes = sample.value
        break
      case 'agent_loop_blocked_issue_resume_age_seconds':
        summary.blockedIssueResumeAgeSeconds = sample.value
        break
      case 'agent_loop_blocked_issue_resume_escalations':
        summary.blockedIssueResumeEscalations = sample.value
        break
      case 'agent_loop_blocked_issue_resume_escalation_age_seconds':
        summary.blockedIssueResumeEscalationAgeSeconds = sample.value
        break
      case 'agent_loop_auto_upgrade_attempts':
        summary.autoUpgradeAttempts = sample.value
        break
      case 'agent_loop_auto_upgrade_successes':
        summary.autoUpgradeSuccesses = sample.value
        break
      case 'agent_loop_auto_upgrade_failures':
        summary.autoUpgradeFailures = sample.value
        break
      case 'agent_loop_auto_upgrade_no_changes':
        summary.autoUpgradeNoChanges = sample.value
        break
      case 'agent_loop_auto_upgrade_last_attempt_age_seconds':
        summary.autoUpgradeLastAttemptAgeSeconds = sample.value
        break
      case 'agent_loop_auto_upgrade_last_success_age_seconds':
        summary.autoUpgradeLastSuccessAgeSeconds = sample.value
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
    const warnings = [...snapshot.warnings]
    if (snapshot.localRuntime && !snapshot.localRuntime.alive) {
      warnings.push(`local runtime record exists but pid ${snapshot.localRuntime.pid} is not alive (${snapshot.localRuntime.supervisor})`)
    }
    if (snapshot.localRuntime?.launchd && !snapshot.localRuntime.launchd.loaded) {
      warnings.push(`launchd service is installed but not currently loaded (${snapshot.localRuntime.launchd.serviceTarget})`)
    }
    if ((snapshot.localRuntime?.launchd?.runtime?.runs ?? 0) >= 3) {
      warnings.push(`launchd has restarted this daemon ${snapshot.localRuntime?.launchd?.runtime?.runs} times; inspect recent exits if this keeps increasing`)
    }
    return [...new Set(warnings)]
  }

  const warnings: string[] = []
  const blockedIssueResumeCount = snapshot.health.runtime.blockedIssueResumeCount ?? 0
  const blockedIssueResumeDetails = snapshot.health.runtime.blockedIssueResumeDetails ?? []
  const oldestBlockedIssueResumeAgeSeconds = snapshot.health.runtime.oldestBlockedIssueResumeAgeSeconds ?? 0
  if (snapshot.health.runtime.startupRecoveryPending) {
    warnings.push('startup recovery is still pending; the daemon is waiting to finish its GitHub/network reconcile')
  }
  if (snapshot.health.nextPollReason && snapshot.health.nextPollReason !== 'normal' && snapshot.health.nextPollDelayMs !== null) {
    warnings.push(`next poll scheduled in ${formatNullableSeconds(Math.ceil(snapshot.health.nextPollDelayMs / 1000))} because ${snapshot.health.nextPollReason}`)
  }
  if ((snapshot.health.runtime.startupRecoveryDeferredCount ?? 0) > 0) {
    warnings.push(`startup recovery has been deferred ${snapshot.health.runtime.startupRecoveryDeferredCount} time(s) by transient GitHub/network errors`)
  }
  if (snapshot.health.upgrade?.status === 'upgrade-available') {
    warnings.push(
      snapshot.health.upgrade.safeToUpgradeNow
        ? 'agent-loop upgrade available and this daemon is currently idle enough to restart safely'
        : 'agent-loop upgrade available; defer restart until the daemon is idle to avoid interrupting active work',
    )
  }
  if (snapshot.health.upgrade?.status === 'error' && snapshot.health.upgrade.message) {
    warnings.push(`agent-loop upgrade check failed: ${snapshot.health.upgrade.message}`)
  }
  if (snapshot.health.runtime.autoUpgrade?.lastOutcome === 'failed') {
    warnings.push(
      `last automatic agent-loop upgrade failed${snapshot.health.runtime.autoUpgrade.lastError ? `: ${snapshot.health.runtime.autoUpgrade.lastError}` : ''}`,
    )
  }
  if (snapshot.health.runtime.supervisor === 'direct') {
    warnings.push('daemon is running in direct mode; closing the current terminal/session will stop it')
  }
  if (snapshot.localRuntime?.launchd && !snapshot.localRuntime.launchd.loaded) {
    warnings.push(`launchd service is installed but not currently loaded (${snapshot.localRuntime.launchd.serviceTarget})`)
  }
  if ((snapshot.localRuntime?.launchd?.runtime?.runs ?? 0) >= 3) {
    warnings.push(`launchd has restarted this daemon ${snapshot.localRuntime?.launchd?.runtime?.runs} times; inspect recent exits if this keeps increasing`)
  }
  if ((snapshot.health.runtime.lastTransientLoopErrorAgeSeconds ?? null) !== null && (snapshot.health.runtime.lastTransientLoopErrorAgeSeconds ?? 0) <= RECENT_TRANSIENT_LOOP_ERROR_WARNING_AGE_SECONDS) {
    warnings.push(`recent transient loop error: ${formatTransientLoopErrorWithMessage(snapshot.health.runtime.lastTransientLoopErrorKind, snapshot.health.runtime.lastTransientLoopErrorAgeSeconds, snapshot.health.runtime.lastTransientLoopErrorMessage)}`)
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
  if (blockedIssueResumeCount > 0) {
    const blockedTargets = blockedIssueResumeDetails.map((blocked) => formatBlockedIssueResumeIdentity(blocked))
    warnings.push(
      blockedTargets.length > 0
        ? `failed issue resumes blocked by linked PR state: ${blockedTargets.join(', ')}`
        : 'one or more failed issue resumes are blocked by linked PR state',
    )
  }
  if (oldestBlockedIssueResumeAgeSeconds >= BLOCKED_ISSUE_RESUME_WARNING_AGE_SECONDS) {
    const longBlocked = blockedIssueResumeDetails
      .filter((blocked) => blocked.durationSeconds >= BLOCKED_ISSUE_RESUME_WARNING_AGE_SECONDS)
      .map((blocked) => `${formatBlockedIssueResumeIdentity(blocked)}=${formatNullableSeconds(blocked.durationSeconds)}`)
    warnings.push(
      longBlocked.length > 0
        ? `blocked issue resumes older than ${formatNullableSeconds(BLOCKED_ISSUE_RESUME_WARNING_AGE_SECONDS)}: ${longBlocked.join(', ')}`
        : `one or more blocked issue resumes are older than ${formatNullableSeconds(BLOCKED_ISSUE_RESUME_WARNING_AGE_SECONDS)}`,
    )
  }
  const longBlockedWithoutEscalation = blockedIssueResumeDetails
    .filter((blocked) => blocked.durationSeconds >= BLOCKED_ISSUE_RESUME_WARNING_AGE_SECONDS && (blocked.escalationCount ?? 0) === 0)
    .map((blocked) => formatBlockedIssueResumeIdentity(blocked))
  if (longBlockedWithoutEscalation.length > 0) {
    warnings.push(`long blocked issue resumes without GitHub escalation: ${longBlockedWithoutEscalation.join(', ')}`)
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
  if (countGitHubApiOutcomes(snapshot.metrics?.githubApiRequests ?? {}, 'rate_limited') > 0) {
    warnings.push(`github api rate limits observed: ${formatGitHubApiRequestSummary(filterGitHubApiOutcome(snapshot.metrics?.githubApiRequests ?? {}, 'rate_limited'))}`)
  }
  if (Object.values(snapshot.metrics?.workerIdleTimeouts ?? {}).reduce((sum, value) => sum + value, 0) > 0) {
    warnings.push(`worker idle timeouts observed: ${formatInlineKeyValue(snapshot.metrics?.workerIdleTimeouts ?? {})}`)
  }
  const repeatedRecoveriesByTarget = summarizeRepeatedRecoveriesByTarget(snapshot.health.runtime.recentRecoveryActions)
  if (repeatedRecoveriesByTarget.length > 0) {
    warnings.push(`same target recovered multiple times recently: ${repeatedRecoveriesByTarget.join(', ')}`)
  }
  const repeatedBlockedIssueResumes = summarizeRepeatedBlockedIssueResumes(snapshot.health.runtime.recentRecoveryActions)
  if (repeatedBlockedIssueResumes.length > 0) {
    warnings.push(`same failed issue blocked multiple times recently: ${repeatedBlockedIssueResumes.join(', ')}`)
  }
  if ((snapshot.metrics?.autoFixes.push_failed ?? 0) > 0) {
    warnings.push(`review auto-fix push failures observed: ${snapshot.metrics?.autoFixes.push_failed}`)
  }
  if ((snapshot.metrics?.autoUpgradeFailures ?? 0) > 0) {
    warnings.push(`automatic agent-loop upgrade failures observed: ${snapshot.metrics?.autoUpgradeFailures}`)
  }
  if (((snapshot.metrics?.mergeRecovery.refresh_push_failed ?? 0) + (snapshot.metrics?.mergeRecovery.retry_merge_failed ?? 0)) > 0) {
    warnings.push('merge recovery has recent push/merge retry failures; inspect the latest PR recovery comments')
  }
  if ((snapshot.githubAudit?.prBlockers.length ?? 0) > 0) {
    warnings.push(`open PR review blockers: ${snapshot.githubAudit?.prBlockers.map((blocker) => `pr#${blocker.prNumber}`).join(', ')}`)
  }
  if (snapshot.githubAudit?.warnings.length) {
    warnings.push(...snapshot.githubAudit.warnings)
  }

  return [...new Set(warnings)]
}

export async function collectGitHubLeaseAudit(
  health: GitHubAuditInput,
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
    prBlockers: remote.prBlockers,
    warnings: [
      ...checks.flatMap((check) => check.warning ? [check.warning] : []),
      ...checks.flatMap((check) => {
        if (check.blockedAgeSeconds === null || check.blockedAgeSeconds === undefined) return []
        if (check.blockedAgeSeconds < BLOCKED_ISSUE_RESUME_WARNING_AGE_SECONDS) return []
        return [
          `${formatLeaseIdentity(check.scope, check.targetNumber)} has been blocked on GitHub for over ${formatNullableSeconds(BLOCKED_ISSUE_RESUME_WARNING_AGE_SECONDS)}`,
        ]
      }),
      ...(remote.prBlockers.length > 0
        ? [`open PR review blockers: ${remote.prBlockers.map((blocker) => `pr#${blocker.prNumber}`).join(', ')}`]
        : []),
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

function summarizeWakeOutcomes(
  wakeRequests: Record<string, Record<string, number>>,
): Record<string, number> {
  const totals: Record<string, number> = {}

  for (const outcomeMap of Object.values(wakeRequests)) {
    for (const [outcome, value] of Object.entries(outcomeMap)) {
      totals[outcome] = (totals[outcome] ?? 0) + value
    }
  }

  return totals
}

function formatGitHubApiRequestKey(transport: string, mode: string): string {
  return `${transport}/${mode}`
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

function formatTransientLoopError(kind: string | null, ageSeconds: number | null): string {
  if (!kind || ageSeconds === null) return 'none'
  return `${kind} ${formatNullableSeconds(ageSeconds)} ago`
}

function formatTransientLoopErrorWithMessage(
  kind: string | null,
  ageSeconds: number | null,
  message: string | null,
): string {
  if (!kind || ageSeconds === null) return 'none'
  return `${kind} ${formatNullableSeconds(ageSeconds)} ago${message ? ` | ${message}` : ''}`
}

function formatNextPollSummary(
  nextPollAt: string | null,
  nextPollReason: string | null,
  nextPollDelayMs: number | null,
): string {
  if (!nextPollAt || !nextPollReason || nextPollDelayMs === null) return 'unscheduled'
  return `${Math.max(0, Math.ceil(nextPollDelayMs / 1000))}s (${nextPollReason}) @ ${nextPollAt}`
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

function formatWakeRequestSummary(values: Record<string, Record<string, number>>): string {
  const parts = WAKE_KIND_ORDER
    .filter((kind) => values[kind] !== undefined)
    .map((kind) => `${kind}[${formatOrderedMap(values[kind] ?? {}, WAKE_OUTCOME_ORDER)}]`)

  return parts.join(', ') || 'none'
}

function formatGitHubApiRequestSummary(values: Record<string, Record<string, number>>): string {
  const parts = GITHUB_API_REQUEST_KEY_ORDER
    .filter((key) => values[key] !== undefined)
    .map((key) => `${key}[${formatOrderedMap(values[key] ?? {}, GITHUB_API_OUTCOME_ORDER)}]`)

  return parts.join(', ') || 'none'
}

function countGitHubApiOutcomes(
  values: Record<string, Record<string, number>>,
  outcome: string,
): number {
  return Object.values(values).reduce((sum, counts) => sum + (counts[outcome] ?? 0), 0)
}

function filterGitHubApiOutcome(
  values: Record<string, Record<string, number>>,
  outcome: string,
): Record<string, Record<string, number>> {
  const filtered: Record<string, Record<string, number>> = {}

  for (const [key, counts] of Object.entries(values)) {
    if ((counts[outcome] ?? 0) <= 0) continue
    filtered[key] = { [outcome]: counts[outcome] ?? 0 }
  }

  return filtered
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

function formatBlockedIssueResumeInlineSummary(
  details: DaemonHealthPayload['runtime']['blockedIssueResumeDetails'],
): string {
  const rendered = details.slice(0, 3).map((blocked) => {
    const linkedPr = blocked.prNumber === null ? 'no-pr' : `pr#${blocked.prNumber}`
    const escalationCount = blocked.escalationCount ?? 0
    const escalation = escalationCount > 0
      ? ` esc=${escalationCount}/${formatNullableSeconds(blocked.lastEscalationAgeSeconds ?? null)}`
      : ''
    return `issue#${blocked.issueNumber}<-${linkedPr} ${formatNullableSeconds(blocked.durationSeconds)}${escalation}`
  })

  if (details.length > 3) {
    rendered.push(`+${details.length - 3} more`)
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

function formatBlockedIssueResumeDoctorLine(
  blocked: DaemonHealthPayload['runtime']['blockedIssueResumeDetails'][number],
): string {
  return `${formatBlockedIssueResumeIdentity(blocked)} | blocked ${formatNullableSeconds(blocked.durationSeconds)} | since ${blocked.since} | escalations=${blocked.escalationCount ?? 0} | last_escalation=${blocked.lastEscalatedAt ?? 'never'} | escalation_age=${formatNullableSeconds(blocked.lastEscalationAgeSeconds ?? null)} | ${blocked.reason}`
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
    check.blockedAgeSeconds !== null && check.blockedAgeSeconds !== undefined
      ? `blocked_age=${formatNullableSeconds(check.blockedAgeSeconds)}`
      : null,
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

function summarizeRepeatedBlockedIssueResumes(
  actions: DaemonHealthPayload['runtime']['recentRecoveryActions'],
): string[] {
  const counts = new Map<string, number>()

  for (const action of actions) {
    if (action.kind !== 'issue-resume-blocked' || action.outcome !== 'blocked' || action.targetNumber === null) continue
    const key = formatLeaseIdentity('issue-process', action.targetNumber)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([key, count]) => `${key}=${count}`)
}

function formatLeaseIdentity(scope: string, targetNumber: number): string {
  return `${scope}#${targetNumber}`
}

function formatBlockedIssueResumeIdentity(
  blocked: Pick<DaemonHealthPayload['runtime']['blockedIssueResumeDetails'][number], 'issueNumber' | 'prNumber'>,
): string {
  return blocked.prNumber === null
    ? `issue#${blocked.issueNumber}`
    : `issue#${blocked.issueNumber}<-pr#${blocked.prNumber}`
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatRevision(revision: string | null): string {
  return revision ? revision.slice(0, 7) : 'unknown'
}

function formatUpgradeSummary(upgrade: DaemonHealthPayload['upgrade'] | undefined): string {
  if (!upgrade) {
    return 'unavailable'
  }

  return `${upgrade.status} | latest v${upgrade.latestVersion ?? 'unknown'}@${formatRevision(upgrade.latestRevision)} | checked ${upgrade.checkedAt ?? 'never'} | safe now ${formatBoolean(upgrade.safeToUpgradeNow)}`
}

function formatAutoUpgradeRuntimeSummary(autoUpgrade: DaemonHealthPayload['runtime']['autoUpgrade'] | null | undefined): string {
  if (!autoUpgrade) {
    return 'unavailable'
  }

  const target = autoUpgrade.lastTargetVersion || autoUpgrade.lastTargetRevision
    ? `target v${autoUpgrade.lastTargetVersion ?? 'unknown'}@${formatRevision(autoUpgrade.lastTargetRevision ?? null)}`
    : 'target unknown'
  const lastError = autoUpgrade.lastError ? ` | error ${autoUpgrade.lastError}` : ''

  return [
    `attempts ${autoUpgrade.attemptCount}`,
    `success ${autoUpgrade.successCount}`,
    `failed ${autoUpgrade.failureCount}`,
    `no-change ${autoUpgrade.noChangeCount}`,
    `last outcome ${autoUpgrade.lastOutcome ?? 'never'}`,
    `last attempt ${autoUpgrade.lastAttemptAt ?? 'never'}`,
    `last success ${autoUpgrade.lastSuccessAt ?? 'never'}`,
    target,
  ].join(' | ') + lastError
}

function formatAutoUpgradeMetricSummary(metrics: DaemonMetricSummary): string {
  return [
    `attempts ${metrics.autoUpgradeAttempts ?? 0}`,
    `success ${metrics.autoUpgradeSuccesses ?? 0}`,
    `failed ${metrics.autoUpgradeFailures ?? 0}`,
    `no-change ${metrics.autoUpgradeNoChanges ?? 0}`,
    `last attempt age ${formatNullableSeconds(metrics.autoUpgradeLastAttemptAgeSeconds ?? 0)}`,
    `last success age ${formatNullableSeconds(metrics.autoUpgradeLastSuccessAgeSeconds ?? 0)}`,
  ].join(' | ')
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
  health: GitHubAuditInput,
  knownKeys: Set<string>,
  runner: GhJsonRunner,
): Promise<{ checks: GitHubLeaseAuditCheck[]; prBlockers: GitHubPrBlockerSummary[]; error: string | null }> {
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
      'number,state,labels,updatedAt,body',
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
      'number,state,labels,headRefName,headRefOid',
    ]),
  ])

  if (!issueListResult.ok) {
    return {
      checks: [],
      prBlockers: [],
      error: issueListResult.error ?? 'failed to list open issues',
    }
  }
  if (!prListResult.ok) {
    return {
      checks: [],
      prBlockers: [],
      error: prListResult.error ?? 'failed to list open PRs',
    }
  }

  const checks: GitHubLeaseAuditCheck[] = []
  const prBlockers: GitHubPrBlockerSummary[] = []
  const issueCommentsByNumber = new Map<number, IssueComment[]>()
  const prCommentsByNumber = new Map<number, IssueComment[]>()
  const openIssues = normalizeGitHubIssueList(issueListResult.data)
    .filter((issue) => issue.labels.some((label) => label.startsWith('agent:')))
  const openPrs = normalizeGitHubPrList(prListResult.data)
    .filter((pr) => pr.headRefName.startsWith('agent/'))
  const issueBodiesByNumber = new Map(openIssues.map((issue) => [issue.number, issue.body]))

  for (const issue of openIssues) {
    const issueCommentResult = await fetchRemoteManagedLeaseComments(issue.number, runner, health.repo)
    if (issueCommentResult.error) {
      return {
        checks,
        prBlockers,
        error: `issue-process#${issue.number}: ${issueCommentResult.error}`,
      }
    }
    issueCommentsByNumber.set(issue.number, issueCommentResult.comments ?? [])

    const key = buildLeaseAuditKey('issue-process', issue.number)
    if (knownKeys.has(key)) continue

    const comment = getActiveManagedLease(issueCommentResult.comments ?? [], 'issue-process')
    if (!comment) continue

    checks.push(buildGitHubLeaseAuditCheckFromState(
      buildLeaseAuditSubjectFromComment(comment, issue.number, 'remote', health.daemonInstanceId),
      issue.state,
      issue.labels,
    ))
  }

  for (const pr of openPrs) {
    const commentResult = await fetchRemoteManagedLeaseComments(pr.number, runner, health.repo)
    if (commentResult.error) {
      return {
        checks,
        prBlockers,
        error: `PR #${pr.number}: ${commentResult.error}`,
      }
    }
    if (!commentResult.comments) continue

    prCommentsByNumber.set(pr.number, commentResult.comments)
    const blocker = buildGitHubPrBlockerSummary(
      pr,
      commentResult.comments,
      (() => {
        const issueNumber = parseIssueNumberFromManagedBranch(pr.headRefName)
        return issueNumber === null ? null : (issueBodiesByNumber.get(issueNumber) ?? null)
      })(),
    )
    if (blocker) {
      prBlockers.push(blocker)
    }
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

  checks.push(...collectRemoteBlockedIssueResumeChecks(openIssues, openPrs, issueCommentsByNumber, prCommentsByNumber))

  return {
    checks,
    prBlockers: prBlockers.sort((left, right) => {
      const leftUpdated = left.updatedAt ? Date.parse(left.updatedAt) : 0
      const rightUpdated = right.updatedAt ? Date.parse(right.updatedAt) : 0
      if (leftUpdated !== rightUpdated) return rightUpdated - leftUpdated
      return left.prNumber - right.prNumber
    }),
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

function normalizeGitHubIssueList(data: unknown): Array<{ number: number; state: string; labels: string[]; updatedAt: string; body: string }> {
  if (!Array.isArray(data)) return []

  return data
    .map((item) => {
      const issue = item as GitHubIssueListItem
      if (typeof issue.number !== 'number') return null
      return {
        number: issue.number,
        state: typeof issue.state === 'string' ? issue.state.toLowerCase() : 'unknown',
        labels: normalizeGitHubLabels(issue.labels),
        updatedAt: typeof issue.updatedAt === 'string' ? issue.updatedAt : '',
        body: typeof issue.body === 'string' ? issue.body : '',
      }
    })
    .filter((item): item is { number: number; state: string; labels: string[]; updatedAt: string; body: string } => item !== null)
}

function normalizeGitHubPrList(
  data: unknown,
): Array<{ number: number; state: string; labels: string[]; headRefName: string; headRefOid: string | null }> {
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
        headRefOid: typeof pr.headRefOid === 'string' && pr.headRefOid.length > 0
          ? pr.headRefOid
          : null,
      }
    })
    .filter((item): item is { number: number; state: string; labels: string[]; headRefName: string; headRefOid: string | null } => item !== null)
}

function normalizeGitHubLabels(labels: Array<{ name?: unknown }> | undefined): string[] {
  return Array.isArray(labels)
    ? labels
      .map((label) => typeof label?.name === 'string' ? label.name : null)
      .filter((label): label is string => label !== null)
    : []
}

function collectRemoteBlockedIssueResumeChecks(
  issues: Array<{ number: number; state: string; labels: string[]; updatedAt: string; body: string }>,
  prs: Array<{ number: number; state: string; labels: string[]; headRefName: string; headRefOid: string | null }>,
  issueCommentsByNumber: Map<number, IssueComment[]>,
  prCommentsByNumber: Map<number, IssueComment[]>,
): GitHubLeaseAuditCheck[] {
  const checks: GitHubLeaseAuditCheck[] = []
  const prsByIssueNumber = new Map<number, Array<{ number: number; state: string; labels: string[]; headRefName: string; headRefOid: string | null }>>()

  for (const pr of prs) {
    const issueNumber = parseIssueNumberFromManagedBranch(pr.headRefName)
    if (issueNumber === null) continue
    prsByIssueNumber.set(issueNumber, [...(prsByIssueNumber.get(issueNumber) ?? []), pr])
  }

  for (const issue of issues) {
    if (inferIssueStateFromLabels(issue.labels) !== 'failed') continue
    const linkedPrs = prsByIssueNumber.get(issue.number) ?? []
    if (linkedPrs.length === 0) continue

    let firstBlocked: { prNumber: number; reason: string; blockedAgeSeconds: number | null } | null = null
    let firstResolutionSignal: { prNumber: number; resolvedAt: string; resolution: string } | null = null
    let hasResumableLinkedPr = false
    const issueComments = issueCommentsByNumber.get(issue.number) ?? []

    for (const pr of linkedPrs) {
      const prComments = prCommentsByNumber.get(pr.number) ?? []
      const canResumeHumanNeededReview = new Set(pr.labels).has(PR_REVIEW_LABELS.HUMAN_NEEDED)
        ? canResumeHumanNeededPrReview(
            prComments,
            GITHUB_AUDIT_MAX_AUTOMATED_PR_REVIEW_ATTEMPTS,
            pr.headRefOid,
            issue.body,
          )
        : false
      const blocked = getFailedIssueResumeBlock({
        number: pr.number,
        labels: pr.labels,
      }, canResumeHumanNeededReview)

      if (blocked === null) {
        hasResumableLinkedPr = true
        break
      }

      const resolution = evaluateBlockedIssueResumeResolution(issueComments, issue.number, pr.number)
      if (resolution.canResume && resolution.latestResolution) {
        if (
          firstResolutionSignal === null
          || Date.parse(resolution.latestResolution.resolutionComment.resolvedAt) > Date.parse(firstResolutionSignal.resolvedAt)
        ) {
          firstResolutionSignal = {
            prNumber: pr.number,
            resolvedAt: resolution.latestResolution.resolutionComment.resolvedAt,
            resolution: resolution.latestResolution.resolutionComment.resolution,
          }
        }
        continue
      }

      const blockedAgeSeconds = getLatestAutomatedPrReviewCommentAgeSeconds(prComments)
      if (
        firstBlocked === null
        || (blockedAgeSeconds !== null && (firstBlocked.blockedAgeSeconds === null || blockedAgeSeconds > firstBlocked.blockedAgeSeconds))
      ) {
        firstBlocked = {
          prNumber: pr.number,
          reason: blocked.reason,
          blockedAgeSeconds,
        }
      }
    }

    if (hasResumableLinkedPr) continue

    if (firstBlocked === null && firstResolutionSignal !== null) {
      checks.push({
        scope: 'issue-process',
        targetNumber: issue.number,
        state: issue.state,
        labels: issue.labels,
        warning: `issue-process#${issue.number} received a valid resolution signal for linked PR #${firstResolutionSignal.prNumber} at ${firstResolutionSignal.resolvedAt}: ${firstResolutionSignal.resolution}`,
        source: 'remote',
      })
      continue
    }

    if (firstBlocked === null) continue

    checks.push({
      scope: 'issue-process',
      targetNumber: issue.number,
      state: issue.state,
      labels: issue.labels,
      warning: `issue-process#${issue.number} is blocked by linked PR #${firstBlocked.prNumber}: ${firstBlocked.reason}`,
      blockedAgeSeconds: firstBlocked.blockedAgeSeconds,
      source: 'remote',
    })
  }

  return checks
}

function buildGitHubPrBlockerSummary(
  pr: { number: number; labels: string[]; headRefName: string; headRefOid: string | null },
  comments: IssueComment[],
  linkedIssueBody: string | null,
): GitHubPrBlockerSummary | null {
  const labelSet = new Set(pr.labels)
  if (!labelSet.has(PR_REVIEW_LABELS.HUMAN_NEEDED) && !labelSet.has(PR_REVIEW_LABELS.FAILED)) {
    return null
  }

  const latest = extractLatestAutomatedPrReviewBlockerSummary(comments)
  if (!latest) return null

  return {
    prNumber: pr.number,
    issueNumber: parseIssueNumberFromManagedBranch(pr.headRefName),
    labels: pr.labels,
    headRefName: pr.headRefName,
    attempt: latest.attempt,
    reason: latest.reason,
    findingSummary: latest.findingSummary,
    updatedAt: latest.commentUpdatedAt,
    resumable: labelSet.has(PR_REVIEW_LABELS.HUMAN_NEEDED)
      ? canResumeHumanNeededPrReview(
          comments,
          GITHUB_AUDIT_MAX_AUTOMATED_PR_REVIEW_ATTEMPTS,
          pr.headRefOid,
          linkedIssueBody,
        )
      : false,
  }
}

function getLatestAutomatedPrReviewCommentAgeSeconds(comments: IssueComment[]): number | null {
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index]
    if (!comment || !comment.body.includes('<!-- agent-loop:pr-review ')) continue
    return parseAgeSeconds(comment.updatedAt || comment.createdAt)
  }

  return null
}

function formatGitHubPrBlockersInlineSummary(blockers: GitHubPrBlockerSummary[]): string {
  const rendered = blockers.slice(0, 2).map((blocker) => {
    const attempt = blocker.attempt === null ? 'attempt ?' : `attempt ${blocker.attempt}`
    const updated = blocker.updatedAt ? ` @ ${blocker.updatedAt}` : ''
    const resumable = blocker.resumable ? ' | auto-resume yes' : ''
    return `pr#${blocker.prNumber}${blocker.issueNumber === null ? '' : `<-issue#${blocker.issueNumber}`} ${attempt}${updated}: ${truncateSingleLine(blocker.reason, 120)}${resumable}`
  })

  if (blockers.length > 2) {
    rendered.push(`+${blockers.length - 2} more`)
  }

  return rendered.join(' | ')
}

function formatGitHubPrBlockerLine(blocker: GitHubPrBlockerSummary): string {
  return [
    `pr#${blocker.prNumber}${blocker.issueNumber === null ? '' : ` <- issue#${blocker.issueNumber}`}`,
    `labels=${blocker.labels.join(',') || 'none'}`,
    `attempt=${blocker.attempt ?? 'unknown'}`,
    `updated=${blocker.updatedAt ?? 'unknown'}`,
    `auto_resume=${blocker.resumable ? 'yes' : 'no'}`,
    `reason=${blocker.reason}`,
    blocker.findingSummary ? `top_finding=${blocker.findingSummary}` : null,
  ].filter((value): value is string => value !== null).join(' | ')
}

function truncateSingleLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
}

function parseIssueNumberFromManagedBranch(headRefName: string): number | null {
  const match = headRefName.match(/^agent\/(\d+)(?:\/|$)/)
  if (!match) return null
  const parsed = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(parsed) ? parsed : null
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
