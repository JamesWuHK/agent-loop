import { existsSync, readFileSync } from 'node:fs'
import {
  type AgentLoopAutoUpgradeRuntimeState,
  type AgentLoopUpgradeStatusKind,
  PR_REVIEW_LABELS,
  getActiveManagedLease,
  listIssueComments,
  listOpenAgentIssues,
  listOpenAgentPullRequests,
  type AgentConfig,
  type AgentIssue,
  type ManagedLeaseComment,
  type ManagedLeaseScope,
  type ManagedPullRequest,
} from '@agent/shared'
import {
  collectDaemonObservability,
  type DaemonObservabilitySnapshot,
} from './status'
import {
  canResumeHumanNeededPrReview,
  extractLatestAutomatedPrReviewBlockerSummary,
} from './pr-reviewer'
import {
  listBackgroundRuntimeRecords,
  type BackgroundRuntimeSnapshot,
} from './background'
import {
  listActiveManagedDaemonPresence,
  listActiveManagedDaemonUpgradeFailureAlerts,
  type ManagedDaemonPresenceComment,
  type ManagedDaemonUpgradeFailureAlertComment,
} from './presence'

export const DEFAULT_DASHBOARD_HOST = '127.0.0.1'
export const DEFAULT_DASHBOARD_PORT = 9388
export const DEFAULT_DASHBOARD_REFRESH_INTERVAL_MS = 10_000
const DEFAULT_LOG_TAIL_LINES = 200

type DashboardMachineSource = 'local' | 'github' | 'mixed'
type DashboardLeaseSource = 'local' | 'github'

export interface DashboardSummary {
  machineCount: number
  localRuntimeCount: number
  managedPresenceCount: number
  activeLeaseCount: number
  readyIssueCount: number
  workingIssueCount: number
  failedIssueCount: number
  openPrCount: number
  upgradePendingMachineCount: number
  upgradeReadyMachineCount: number
  upgradeBlockedMachineCount: number
  upgradeManualMachineCount: number
  upgradeErrorMachineCount: number
  upgradeFailedMachineCount: number
}

export interface DashboardLeaseView {
  scope: ManagedLeaseScope
  targetNumber: number
  issueNumber: number | null
  prNumber: number | null
  machineId: string
  daemonInstanceId: string
  phase: string
  status: string
  attempt: number
  branch: string | null
  worktreeId: string | null
  heartbeatAgeSeconds: number | null
  progressAgeSeconds: number | null
  expiresInSeconds: number | null
  adoptable: boolean | null
  commentId: number | null
  source: DashboardLeaseSource
}

export interface DashboardLocalRuntimeView {
  runtimeKey: string
  supervisor: BackgroundRuntimeSnapshot['record']['supervisor']
  alive: boolean
  pid: number
  cwd: string
  recordPath: string
  logPath: string
  startedAt: string
  healthPort: number
  metricsPort: number
}

export interface DashboardRuntimeObservabilityView {
  runtimeKey: string
  ok: boolean
  daemonInstanceId: string | null
  status: 'running' | 'unreachable'
  pid: number | null
  uptimeMs: number | null
  concurrency: number | null
  effectiveActiveTasks: number | null
  activeWorktreeCount: number
  activeLeaseCount: number
  stalledWorkerCount: number
  blockedIssueResumeCount: number
  lastPollAt: string | null
  nextPollAt: string | null
  nextPollReason: string | null
  healthUrl: string
  metricsUrl: string | null
  warnings: string[]
}

export interface DashboardPresenceView {
  repo: string
  machineId: string
  daemonInstanceId: string
  status: 'idle' | 'busy' | 'stopped'
  startedAt: string
  lastHeartbeatAt: string
  expiresAt: string
  heartbeatAgeSeconds: number | null
  expiresInSeconds: number | null
  healthPort: number
  metricsPort: number
  activeLeaseCount: number
  activeWorktreeCount: number
  effectiveActiveTasks: number
  agentLoopVersion: string
  agentLoopRevision: string | null
  upgradeStatus: AgentLoopUpgradeStatusKind
  upgradeAutoApplyEnabled: boolean
  safeToUpgradeNow: boolean
  latestVersion: string | null
  latestRevision: string | null
  upgradeCheckedAt: string | null
  upgradeMessage: string | null
  autoUpgrade: AgentLoopAutoUpgradeRuntimeState | null
  source: 'github'
}

export interface DashboardMachineCard {
  machineId: string
  daemonInstanceIds: string[]
  source: DashboardMachineSource
  localRuntimes: DashboardLocalRuntimeView[]
  observability: DashboardRuntimeObservabilityView[]
  activeLeases: DashboardLeaseView[]
  presence: DashboardPresenceView | null
  warnings: string[]
}

export interface DashboardIssueView {
  number: number
  title: string
  url: string
  state: AgentIssue['state']
  labels: string[]
  assignee: string | null
  isClaimable: boolean
  updatedAt: string
  dependencyIssueNumbers: number[]
  claimBlockedBy: number[]
  hasExecutableContract: boolean
  contractValidationErrors: string[]
  linkedPrNumbers: number[]
  activeLease: DashboardLeaseView | null
}

export interface DashboardPullRequestView {
  number: number
  title: string
  url: string
  headRefName: string
  labels: string[]
  isDraft: boolean
  linkedIssueNumber: number | null
  blockerAttempt: number | null
  blockerReason: string | null
  blockerFindingSummary: string | null
  blockerUpdatedAt: string | null
  blockerResumable: boolean
  reviewLease: DashboardLeaseView | null
  mergeLease: DashboardLeaseView | null
}

export interface DashboardSnapshot {
  generatedAt: string
  repo: string
  summary: DashboardSummary
  machines: DashboardMachineCard[]
  issues: DashboardIssueView[]
  prs: DashboardPullRequestView[]
  notes: string[]
  errors: string[]
}

export interface DashboardSnapshotOptions {
  config: AgentConfig
  repo?: string
  healthHost?: string
}

export interface DashboardLogResult {
  found: boolean
  machineId: string | null
  runtimeKey: string
  path: string | null
  content: string
  truncated: boolean
  lineCount: number
  message: string
}

export interface DashboardServerOptions {
  config: AgentConfig
  host?: string
  port?: number
  healthHost?: string
}

export interface DashboardLocalMachineSnapshot {
  machineId: string
  daemonInstanceId: string | null
  runtime: DashboardLocalRuntimeView
  observability: DashboardRuntimeObservabilityView
  activeLeases: DashboardLeaseView[]
  warnings: string[]
}

interface DashboardGitHubCollection {
  issues: DashboardIssueView[]
  prs: DashboardPullRequestView[]
  remoteLeases: DashboardLeaseView[]
}

export async function collectDashboardSnapshot(
  options: DashboardSnapshotOptions,
): Promise<DashboardSnapshot> {
  const repo = options.repo ?? options.config.repo
  const generatedAt = new Date().toISOString()
  const errors: string[] = []
  const notes = [
    '远程机器会从 GitHub 上的活跃受管租约或共享 presence 心跳中显示出来。',
    'MVP 阶段不提供远程日志；日志面板目前只追踪本地受管 daemon 日志。',
  ]

  const localSnapshots = await collectLocalMachineSnapshots({
    repo,
    healthHost: options.healthHost,
  })
  const localLeaseIndex = new Map<string, DashboardLeaseView>()
  for (const snapshot of localSnapshots) {
    for (const lease of snapshot.activeLeases) {
      localLeaseIndex.set(buildLeaseKey(lease), lease)
    }
  }

  let issues: DashboardIssueView[] = []
  let prs: DashboardPullRequestView[] = []
  let remoteLeases: DashboardLeaseView[] = []
  let remotePresences: DashboardPresenceView[] = []

  try {
    const githubCollection = await collectGitHubDashboardData({
      config: {
        ...options.config,
        repo,
      },
      localLeaseIndex,
    })
    issues = githubCollection.issues
    prs = githubCollection.prs
    remoteLeases = githubCollection.remoteLeases
  } catch (error) {
    errors.push(`GitHub 快照不可用：${formatError(error)}`)
  }

  try {
    const presences = await listActiveManagedDaemonPresence({
      ...options.config,
      repo,
    })
    remotePresences = presences.map((presence) => buildDashboardPresenceView(presence))
  } catch (error) {
    errors.push(`GitHub presence 不可用：${formatError(error)}`)
  }

  try {
    const alerts = await listActiveManagedDaemonUpgradeFailureAlerts({
      ...options.config,
      repo,
    })
    errors.push(...buildDashboardUpgradeFailureAlertMessages(
      alerts,
      remotePresences,
      Date.parse(generatedAt),
    ))
  } catch (error) {
    errors.push(`GitHub 升级告警不可用：${formatError(error)}`)
  }

  const machines = buildDashboardMachineCards(localSnapshots, remoteLeases, remotePresences)

  return {
    generatedAt,
    repo,
    summary: buildDashboardSummary(machines, issues, prs),
    machines,
    issues,
    prs,
    notes,
    errors,
  }
}

export function buildDashboardMachineCards(
  localSnapshots: DashboardLocalMachineSnapshot[],
  remoteLeases: DashboardLeaseView[],
  remotePresences: DashboardPresenceView[] = [],
): DashboardMachineCard[] {
  const machines = new Map<string, DashboardMachineCard>()

  for (const snapshot of localSnapshots) {
    const machine = getOrCreateMachineCard(machines, snapshot.machineId)
    machine.localRuntimes.push(snapshot.runtime)
    machine.observability.push(snapshot.observability)
    mergeDashboardWarnings(machine, [
      ...snapshot.warnings,
      ...snapshot.observability.warnings,
    ])

    if (snapshot.daemonInstanceId) {
      mergeDaemonInstance(machine, snapshot.daemonInstanceId)
    }

    for (const lease of snapshot.activeLeases) {
      mergeDashboardLease(machine, lease)
    }
  }

  for (const lease of remoteLeases) {
    const machine = getOrCreateMachineCard(machines, lease.machineId)
    mergeDaemonInstance(machine, lease.daemonInstanceId)
    mergeDashboardLease(machine, lease)
  }

  for (const presence of remotePresences) {
    const machine = getOrCreateMachineCard(machines, presence.machineId)
    mergeDaemonInstance(machine, presence.daemonInstanceId)
    mergeDashboardPresence(machine, presence)
  }

  for (const machine of machines.values()) {
    machine.localRuntimes.sort((left, right) => {
      if (left.alive !== right.alive) return left.alive ? -1 : 1
      return Date.parse(right.startedAt) - Date.parse(left.startedAt)
    })
    machine.observability.sort((left, right) => {
      if (left.ok !== right.ok) return left.ok ? -1 : 1
      return (right.uptimeMs ?? 0) - (left.uptimeMs ?? 0)
    })
    machine.activeLeases.sort(compareLeases)

    machine.source = machine.localRuntimes.length > 0 && (machine.activeLeases.length > 0 || machine.presence !== null)
      ? 'mixed'
      : machine.localRuntimes.length > 0
        ? 'local'
        : 'github'

    mergeDashboardWarnings(machine, buildPresenceUpgradeWarnings(machine))

    if (machine.localRuntimes.length > 1) {
      mergeDashboardWarnings(machine, [
        `multiple local runtimes detected (${machine.localRuntimes.length})`,
      ])
    }
  }

  return [...machines.values()].sort((left, right) => {
    const leftLocal = left.localRuntimes.length > 0 ? 1 : 0
    const rightLocal = right.localRuntimes.length > 0 ? 1 : 0
    if (leftLocal !== rightLocal) return rightLocal - leftLocal
    if (left.activeLeases.length !== right.activeLeases.length) {
      return right.activeLeases.length - left.activeLeases.length
    }
    return left.machineId.localeCompare(right.machineId)
  })
}

export function buildDashboardSummary(
  machines: DashboardMachineCard[],
  issues: DashboardIssueView[],
  prs: DashboardPullRequestView[],
): DashboardSummary {
  const activeLeaseKeys = new Set<string>()
  let localRuntimeCount = 0
  let managedPresenceCount = 0
  let upgradePendingMachineCount = 0
  let upgradeReadyMachineCount = 0
  let upgradeBlockedMachineCount = 0
  let upgradeManualMachineCount = 0
  let upgradeErrorMachineCount = 0
  let upgradeFailedMachineCount = 0

  for (const machine of machines) {
    localRuntimeCount += machine.localRuntimes.length
    for (const lease of machine.activeLeases) {
      activeLeaseKeys.add(buildLeaseKey(lease))
    }

    if (machine.presence) {
      managedPresenceCount += 1
      if (machine.presence.upgradeStatus === 'upgrade-available') {
        upgradePendingMachineCount += 1
        if (!machine.presence.upgradeAutoApplyEnabled) {
          upgradeManualMachineCount += 1
        } else if (machine.presence.safeToUpgradeNow) {
          upgradeReadyMachineCount += 1
        } else {
          upgradeBlockedMachineCount += 1
        }
      }
      if (machine.presence.upgradeStatus === 'error') {
        upgradeErrorMachineCount += 1
      }
      if (machine.presence.autoUpgrade?.lastOutcome === 'failed') {
        upgradeFailedMachineCount += 1
      }
    }
  }

  return {
    machineCount: machines.length,
    localRuntimeCount,
    managedPresenceCount,
    activeLeaseCount: activeLeaseKeys.size,
    readyIssueCount: issues.filter((issue) => issue.state === 'ready').length,
    workingIssueCount: issues.filter((issue) => issue.state === 'working').length,
    failedIssueCount: issues.filter((issue) => issue.state === 'failed').length,
    openPrCount: prs.length,
    upgradePendingMachineCount,
    upgradeReadyMachineCount,
    upgradeBlockedMachineCount,
    upgradeManualMachineCount,
    upgradeErrorMachineCount,
    upgradeFailedMachineCount,
  }
}

export function buildDashboardUpgradeFailureAlertMessages(
  alerts: ManagedDaemonUpgradeFailureAlertComment[],
  presences: DashboardPresenceView[],
  now = Date.now(),
): string[] {
  const presenceByMachine = new Map<string, DashboardPresenceView>()
  for (const presence of presences) {
    const current = presenceByMachine.get(presence.machineId)
    if (!current || (presence.heartbeatAgeSeconds ?? Number.POSITIVE_INFINITY) <= (current.heartbeatAgeSeconds ?? Number.POSITIVE_INFINITY)) {
      presenceByMachine.set(presence.machineId, presence)
    }
  }

  const messages: string[] = []
  for (const comment of alerts) {
    const pausedUntilMs = Date.parse(comment.alert.pausedUntil ?? '')
    if (!Number.isFinite(pausedUntilMs) || pausedUntilMs <= now) {
      continue
    }

    const presence = presenceByMachine.get(comment.alert.machineId)
    const confirmedActive = !presence || (
      presence.autoUpgrade?.lastOutcome === 'failed'
      && presence.autoUpgrade?.pausedUntil === comment.alert.pausedUntil
      && presence.autoUpgrade?.lastTargetVersion === comment.alert.targetVersion
      && presence.autoUpgrade?.lastTargetRevision === comment.alert.targetRevision
    )
    if (!confirmedActive) {
      continue
    }

    messages.push(
      `GitHub 升级告警：${comment.alert.machineId} 自动升级连续失败 ${comment.alert.consecutiveFailureCount} 次，暂停到 ${comment.alert.pausedUntil}${comment.alert.lastError ? `，最近错误：${comment.alert.lastError}` : ''}`,
    )
  }

  return [...new Set(messages)]
}

export function readDashboardLog(
  repo: string,
  runtimeKey: string,
  maxLines = DEFAULT_LOG_TAIL_LINES,
): DashboardLogResult {
  const runtime = listBackgroundRuntimeRecords().find((candidate) => {
    return candidate.record.repo === repo
      && buildRuntimeKey(candidate.record.machineId, candidate.record.healthPort) === runtimeKey
  })

  if (!runtime) {
    return {
      found: false,
      machineId: null,
      runtimeKey,
      path: null,
      content: '',
      truncated: false,
      lineCount: 0,
      message: `仓库 ${repo} 中未找到匹配 ${runtimeKey} 的本地运行时`,
    }
  }

  const path = runtime.record.logPath
  if (!existsSync(path)) {
    return {
      found: false,
      machineId: runtime.record.machineId,
      runtimeKey,
      path,
      content: '',
      truncated: false,
      lineCount: 0,
      message: `未找到本地日志文件：${path}`,
    }
  }

  const tailed = tailLogContent(readFileSync(path, 'utf-8'), maxLines)
  return {
    found: true,
    machineId: runtime.record.machineId,
    runtimeKey,
    path,
    content: tailed.content,
    truncated: tailed.truncated,
    lineCount: tailed.lineCount,
    message: tailed.truncated
      ? `显示 ${path} 的最后 ${tailed.lineCount} 行`
      : `显示 ${path} 的日志内容`,
  }
}

export function startDashboardServer(options: DashboardServerOptions): Bun.Server<unknown> {
  const host = options.host ?? DEFAULT_DASHBOARD_HOST
  const port = options.port ?? DEFAULT_DASHBOARD_PORT
  const repo = options.config.repo
  const healthHost = options.healthHost

  return Bun.serve({
    hostname: host,
    port,
    async fetch(request) {
      const url = new URL(request.url)

      if (url.pathname === '/') {
        return new Response(renderDashboardHtml(), {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          },
        })
      }

      if (url.pathname === '/styles.css') {
        return new Response(renderDashboardCss(), {
          headers: {
            'content-type': 'text/css; charset=utf-8',
            'cache-control': 'no-store',
          },
        })
      }

      if (url.pathname === '/app.js') {
        return new Response(renderDashboardAppScript(), {
          headers: {
            'content-type': 'application/javascript; charset=utf-8',
            'cache-control': 'no-store',
          },
        })
      }

      if (url.pathname === '/api/snapshot') {
        try {
          const snapshot = await collectDashboardSnapshot({
            config: options.config,
            repo,
            healthHost,
          })
          return jsonResponse(snapshot)
        } catch (error) {
          return jsonResponse({
            error: formatError(error),
          }, 500)
        }
      }

      if (url.pathname === '/api/log') {
        const runtimeKey = url.searchParams.get('runtimeKey')?.trim() ?? ''
        if (runtimeKey.length === 0) {
          return jsonResponse({
            error: '必须提供 runtimeKey 查询参数',
          }, 400)
        }

        const maxLines = parsePositiveInteger(url.searchParams.get('maxLines')) ?? DEFAULT_LOG_TAIL_LINES
        return jsonResponse(readDashboardLog(repo, runtimeKey, maxLines))
      }

      return new Response('Not Found', { status: 404 })
    },
  })
}

async function collectLocalMachineSnapshots(input: {
  repo: string
  healthHost?: string
}): Promise<DashboardLocalMachineSnapshot[]> {
  const runtimes = listBackgroundRuntimeRecords()
    .filter((runtime) => runtime.record.repo === input.repo)

  return Promise.all(runtimes.map(async (runtime) => {
    const runtimeKey = buildRuntimeKey(runtime.record.machineId, runtime.record.healthPort)
    const observability = await collectDaemonObservability({
      healthHost: input.healthHost,
      healthPort: runtime.record.healthPort,
      metricsPort: runtime.record.metricsPort,
      fallbackRepo: input.repo,
      fallbackRuntime: runtime,
    })
    const health = observability.health
    const activeLeases = health?.runtime.activeLeaseDetails.map((lease) => ({
      scope: lease.scope,
      targetNumber: lease.targetNumber,
      issueNumber: lease.issueNumber,
      prNumber: lease.prNumber,
      machineId: lease.machineId,
      daemonInstanceId: lease.daemonInstanceId,
      phase: lease.phase,
      status: lease.status,
      attempt: lease.attempt,
      branch: lease.branch,
      worktreeId: lease.worktreeId,
      heartbeatAgeSeconds: lease.heartbeatAgeSeconds,
      progressAgeSeconds: lease.progressAgeSeconds,
      expiresInSeconds: lease.expiresInSeconds,
      adoptable: lease.adoptable,
      commentId: lease.commentId,
      source: 'local' as const,
    })) ?? []

    return {
      machineId: runtime.record.machineId,
      daemonInstanceId: health?.daemonInstanceId ?? null,
      runtime: {
        runtimeKey,
        supervisor: runtime.record.supervisor,
        alive: runtime.alive,
        pid: runtime.record.pid,
        cwd: runtime.record.cwd,
        recordPath: runtime.recordPath,
        logPath: runtime.record.logPath,
        startedAt: runtime.record.startedAt,
        healthPort: runtime.record.healthPort,
        metricsPort: runtime.record.metricsPort,
      },
      observability: buildDashboardRuntimeObservability(runtimeKey, observability),
      activeLeases,
      warnings: observability.warnings,
    } satisfies DashboardLocalMachineSnapshot
  }))
}

async function collectGitHubDashboardData(input: {
  config: AgentConfig
  localLeaseIndex: Map<string, DashboardLeaseView>
}): Promise<DashboardGitHubCollection> {
  const now = Date.now()
  const [issues, prs] = await Promise.all([
    listOpenAgentIssues(input.config),
    listOpenAgentPullRequests(input.config),
  ])

  const linkedPrsByIssue = new Map<number, ManagedPullRequest[]>()
  const issueBodiesByNumber = new Map(issues.map((issue) => [issue.number, issue.body]))
  for (const pr of prs) {
    const issueNumber = parseIssueNumberFromManagedBranch(pr.headRefName)
    if (issueNumber === null) continue
    linkedPrsByIssue.set(issueNumber, [...(linkedPrsByIssue.get(issueNumber) ?? []), pr])
  }

  const issueLeaseMap = new Map<number, DashboardLeaseView>()
  const reviewLeaseMap = new Map<number, DashboardLeaseView>()
  const mergeLeaseMap = new Map<number, DashboardLeaseView>()
  const remoteLeases: DashboardLeaseView[] = []

  const issueLeaseCandidates = issues.filter((issue) => issue.state === 'working' || issue.state === 'failed')
  const issueComments = await Promise.all(issueLeaseCandidates.map(async (issue) => ({
    issue,
    comments: await listIssueComments(issue.number, input.config),
  })))

  for (const entry of issueComments) {
    const lease = getActiveManagedLease(entry.comments, 'issue-process')
    if (!lease) continue
    const view = buildLeaseViewFromComment(lease, entry.issue.number, now)
    remoteLeases.push(view)
    issueLeaseMap.set(entry.issue.number, view)
  }

  const prComments = await Promise.all(prs.map(async (pr) => ({
    pr,
    comments: await listIssueComments(pr.number, input.config),
  })))

  for (const entry of prComments) {
    const reviewLease = getActiveManagedLease(entry.comments, 'pr-review')
    if (reviewLease) {
      const view = buildLeaseViewFromComment(reviewLease, entry.pr.number, now)
      remoteLeases.push(view)
      reviewLeaseMap.set(entry.pr.number, view)
    }

    const mergeLease = getActiveManagedLease(entry.comments, 'pr-merge')
    if (mergeLease) {
      const view = buildLeaseViewFromComment(mergeLease, entry.pr.number, now)
      remoteLeases.push(view)
      mergeLeaseMap.set(entry.pr.number, view)
    }
  }

  const issueViews = issues
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      url: buildGitHubIssueUrl(input.config.repo, issue.number),
      state: issue.state,
      labels: issue.labels,
      assignee: issue.assignee,
      isClaimable: issue.isClaimable,
      updatedAt: issue.updatedAt,
      dependencyIssueNumbers: issue.dependencyIssueNumbers,
      claimBlockedBy: issue.claimBlockedBy,
      hasExecutableContract: issue.hasExecutableContract,
      contractValidationErrors: issue.contractValidationErrors,
      linkedPrNumbers: (linkedPrsByIssue.get(issue.number) ?? []).map((pr) => pr.number).sort((left, right) => left - right),
      activeLease: preferLocalLease(
        input.localLeaseIndex,
        issueLeaseMap.get(issue.number) ?? null,
      ),
    }) satisfies DashboardIssueView)
    .sort(compareIssues)

  const prViews = prs
    .map((pr) => {
      const linkedIssueNumber = parseIssueNumberFromManagedBranch(pr.headRefName)
      const prCommentList = prComments.find((entry) => entry.pr.number === pr.number)?.comments ?? []
      const blocker = buildDashboardPrBlocker(
        pr,
        prCommentList,
        linkedIssueNumber === null ? null : (issueBodiesByNumber.get(linkedIssueNumber) ?? null),
      )

      return ({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        headRefName: pr.headRefName,
        labels: pr.labels,
        isDraft: pr.isDraft,
        linkedIssueNumber,
        blockerAttempt: blocker?.attempt ?? null,
        blockerReason: blocker?.reason ?? null,
        blockerFindingSummary: blocker?.findingSummary ?? null,
        blockerUpdatedAt: blocker?.updatedAt ?? null,
        blockerResumable: blocker?.resumable ?? false,
        reviewLease: preferLocalLease(
          input.localLeaseIndex,
          reviewLeaseMap.get(pr.number) ?? null,
        ),
        mergeLease: preferLocalLease(
          input.localLeaseIndex,
          mergeLeaseMap.get(pr.number) ?? null,
        ),
      }) satisfies DashboardPullRequestView
    })
    .sort(comparePullRequests)

  return {
    issues: issueViews,
    prs: prViews,
    remoteLeases,
  }
}

function buildDashboardPrBlocker(
  pr: Pick<ManagedPullRequest, 'number' | 'headRefName' | 'headRefOid' | 'labels'>,
  comments: Awaited<ReturnType<typeof listIssueComments>>,
  linkedIssueBody: string | null,
): {
  attempt: number | null
  reason: string
  findingSummary: string | null
  updatedAt: string | null
  resumable: boolean
} | null {
  const labelSet = new Set(pr.labels)
  if (!labelSet.has(PR_REVIEW_LABELS.HUMAN_NEEDED) && !labelSet.has(PR_REVIEW_LABELS.FAILED)) {
    return null
  }

  const latest = extractLatestAutomatedPrReviewBlockerSummary(comments)
  if (!latest) return null

  return {
    attempt: latest.attempt,
    reason: latest.reason,
    findingSummary: latest.findingSummary,
    updatedAt: latest.commentUpdatedAt,
    resumable: labelSet.has(PR_REVIEW_LABELS.HUMAN_NEEDED)
      ? canResumeHumanNeededPrReview(
          comments,
          3,
          pr.headRefOid,
          linkedIssueBody,
        )
      : false,
  }
}

function buildDashboardRuntimeObservability(
  runtimeKey: string,
  snapshot: DaemonObservabilitySnapshot,
): DashboardRuntimeObservabilityView {
  return {
    runtimeKey,
    ok: snapshot.ok,
    daemonInstanceId: snapshot.health?.daemonInstanceId ?? null,
    status: snapshot.ok && snapshot.health ? 'running' : 'unreachable',
    pid: snapshot.health?.pid ?? snapshot.localRuntime?.pid ?? null,
    uptimeMs: snapshot.health?.uptimeMs ?? null,
    concurrency: snapshot.health?.concurrency ?? null,
    effectiveActiveTasks: snapshot.health?.runtime.effectiveActiveTasks ?? null,
    activeWorktreeCount: snapshot.health?.activeWorktrees.length ?? 0,
    activeLeaseCount: snapshot.health?.runtime.activeLeaseCount ?? 0,
    stalledWorkerCount: snapshot.health?.runtime.stalledWorkerCount ?? 0,
    blockedIssueResumeCount: snapshot.health?.runtime.blockedIssueResumeCount ?? 0,
    lastPollAt: snapshot.health?.lastPollAt ?? null,
    nextPollAt: snapshot.health?.nextPollAt ?? null,
    nextPollReason: snapshot.health?.nextPollReason ?? null,
    healthUrl: snapshot.healthUrl,
    metricsUrl: snapshot.metricsUrl,
    warnings: snapshot.warnings,
  }
}

function buildLeaseViewFromComment(
  comment: ManagedLeaseComment,
  targetNumber: number,
  now: number,
): DashboardLeaseView {
  const expiresInSeconds = parseRemainingSeconds(comment.lease.expiresAt, now)
  return {
    scope: comment.lease.scope,
    targetNumber,
    issueNumber: comment.lease.issueNumber ?? null,
    prNumber: comment.lease.prNumber ?? null,
    machineId: comment.lease.machineId,
    daemonInstanceId: comment.lease.daemonInstanceId,
    phase: comment.lease.phase,
    status: comment.lease.status,
    attempt: comment.lease.attempt,
    branch: comment.lease.branch ?? null,
    worktreeId: comment.lease.worktreeId ?? null,
    heartbeatAgeSeconds: parseAgeSeconds(comment.lease.lastHeartbeatAt, now),
    progressAgeSeconds: parseAgeSeconds(comment.lease.lastProgressAt, now),
    expiresInSeconds,
    adoptable: expiresInSeconds === 0,
    commentId: comment.commentId,
    source: 'github',
  }
}

function getOrCreateMachineCard(
  machines: Map<string, DashboardMachineCard>,
  machineId: string,
): DashboardMachineCard {
  const existing = machines.get(machineId)
  if (existing) return existing

  const created: DashboardMachineCard = {
    machineId,
    daemonInstanceIds: [],
    source: 'github',
    localRuntimes: [],
    observability: [],
    activeLeases: [],
    presence: null,
    warnings: [],
  }
  machines.set(machineId, created)
  return created
}

function mergeDaemonInstance(machine: DashboardMachineCard, daemonInstanceId: string): void {
  if (!machine.daemonInstanceIds.includes(daemonInstanceId)) {
    machine.daemonInstanceIds.push(daemonInstanceId)
    machine.daemonInstanceIds.sort((left, right) => left.localeCompare(right))
  }
}

function mergeDashboardWarnings(machine: DashboardMachineCard, warnings: string[]): void {
  for (const warning of warnings) {
    if (!warning || machine.warnings.includes(warning)) continue
    machine.warnings.push(warning)
  }
}

function mergeDashboardLease(machine: DashboardMachineCard, lease: DashboardLeaseView): void {
  const key = buildLeaseKey(lease)
  const existingIndex = machine.activeLeases.findIndex((candidate) => buildLeaseKey(candidate) === key)
  if (existingIndex === -1) {
    machine.activeLeases.push(lease)
    return
  }

  const existing = machine.activeLeases[existingIndex]
  if (existing && existing.source === 'github' && lease.source === 'local') {
    machine.activeLeases[existingIndex] = lease
  }
}

function mergeDashboardPresence(machine: DashboardMachineCard, presence: DashboardPresenceView): void {
  if (!machine.presence) {
    machine.presence = presence
    return
  }

  const currentHeartbeat = machine.presence.heartbeatAgeSeconds ?? Number.POSITIVE_INFINITY
  const candidateHeartbeat = presence.heartbeatAgeSeconds ?? Number.POSITIVE_INFINITY
  if (candidateHeartbeat <= currentHeartbeat) {
    machine.presence = presence
  }
}

function buildPresenceUpgradeWarnings(machine: DashboardMachineCard): string[] {
  if (!machine.presence) {
    return []
  }

  const presence = machine.presence
  const warnings: string[] = []
  const pauseActive = presence.autoUpgrade?.pausedUntil
    && presence.autoUpgrade.lastTargetVersion === (presence.latestVersion ?? null)
    && presence.autoUpgrade.lastTargetRevision === (presence.latestRevision ?? null)

  if (presence.autoUpgrade?.lastOutcome === 'failed') {
    warnings.push(
      pauseActive
        ? `automatic agent-loop upgrades paused on ${presence.machineId} until ${presence.autoUpgrade.pausedUntil} after ${presence.autoUpgrade.consecutiveFailureCount} consecutive failure(s)${presence.autoUpgrade.lastError ? `: ${presence.autoUpgrade.lastError}` : ''}`
        : `automatic agent-loop upgrade last failed on ${presence.machineId}${presence.autoUpgrade.lastError ? `: ${presence.autoUpgrade.lastError}` : ''}`,
    )
  }

  if (presence.upgradeStatus === 'upgrade-available') {
    warnings.push(
      !presence.upgradeAutoApplyEnabled
        ? `agent-loop upgrade available on ${presence.machineId}, but auto-apply is disabled on this machine; manual restart is required`
        : presence.safeToUpgradeNow
          ? `agent-loop upgrade available on ${presence.machineId}; this machine is idle enough to upgrade now`
          : `agent-loop upgrade available on ${presence.machineId}; wait for the machine to go idle before restarting`,
    )
  }
  if (presence.upgradeStatus === 'error') {
    warnings.push(
      `agent-loop upgrade check is failing on ${presence.machineId}${presence.upgradeMessage ? `: ${presence.upgradeMessage}` : ''}; inspect this daemon before relying on auto-upgrade`,
    )
  }
  if (presence.upgradeStatus === 'ahead-of-channel') {
    warnings.push(
      `agent-loop build on ${presence.machineId} is ahead of the tracked channel; verify this machine is pinned intentionally`,
    )
  }

  return warnings
}

function preferLocalLease(
  localLeaseIndex: Map<string, DashboardLeaseView>,
  candidate: DashboardLeaseView | null,
): DashboardLeaseView | null {
  if (!candidate) return null
  return localLeaseIndex.get(buildLeaseKey(candidate)) ?? candidate
}

function buildLeaseKey(lease: Pick<DashboardLeaseView, 'scope' | 'targetNumber' | 'daemonInstanceId'>): string {
  return `${lease.scope}:${lease.targetNumber}:${lease.daemonInstanceId}`
}

function buildRuntimeKey(machineId: string, healthPort: number): string {
  return `${machineId}:${healthPort}`
}

function buildGitHubIssueUrl(repo: string, issueNumber: number): string {
  return `https://github.com/${repo}/issues/${issueNumber}`
}

function parseAgeSeconds(value: string, now: number): number | null {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  return Math.max(0, Math.floor((now - parsed) / 1000))
}

function parseRemainingSeconds(value: string, now: number): number | null {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  return Math.max(0, Math.floor((parsed - now) / 1000))
}

function parseIssueNumberFromManagedBranch(headRefName: string): number | null {
  const match = headRefName.match(/^agent\/(\d+)(?:\/|$)/)
  if (!match) return null
  const parsed = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(parsed) ? parsed : null
}

function compareLeases(left: DashboardLeaseView, right: DashboardLeaseView): number {
  if (left.scope !== right.scope) return left.scope.localeCompare(right.scope)
  return left.targetNumber - right.targetNumber
}

function compareIssues(left: DashboardIssueView, right: DashboardIssueView): number {
  const order = new Map<DashboardIssueView['state'], number>([
    ['working', 0],
    ['ready', 1],
    ['claimed', 2],
    ['failed', 3],
    ['stale', 4],
    ['done', 5],
    ['unknown', 6],
  ])
  const leftOrder = order.get(left.state) ?? 99
  const rightOrder = order.get(right.state) ?? 99
  if (leftOrder !== rightOrder) return leftOrder - rightOrder
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
}

function comparePullRequests(left: DashboardPullRequestView, right: DashboardPullRequestView): number {
  const leftActive = (left.reviewLease ? 1 : 0) + (left.mergeLease ? 1 : 0)
  const rightActive = (right.reviewLease ? 1 : 0) + (right.mergeLease ? 1 : 0)
  if (leftActive !== rightActive) return rightActive - leftActive
  return left.number - right.number
}

function parsePositiveInteger(value: string | null): number | null {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed
}

function tailLogContent(content: string, maxLines: number): {
  content: string
  truncated: boolean
  lineCount: number
} {
  const lines = content.split('\n')
  const normalized = lines.at(-1) === '' ? lines.slice(0, -1) : lines
  if (normalized.length <= maxLines) {
    return {
      content: normalized.join('\n'),
      truncated: false,
      lineCount: normalized.length,
    }
  }

  const tail = normalized.slice(-maxLines)
  return {
    content: tail.join('\n'),
    truncated: true,
    lineCount: tail.length,
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function buildDashboardPresenceView(comment: ManagedDaemonPresenceComment): DashboardPresenceView {
  const now = Date.now()
  const heartbeatAgeSeconds = parseAgeSeconds(comment.presence.lastHeartbeatAt, now)
  const expiresInSeconds = parseRemainingSeconds(comment.presence.expiresAt, now)

  return {
    repo: comment.presence.repo,
    machineId: comment.presence.machineId,
    daemonInstanceId: comment.presence.daemonInstanceId,
    status: comment.presence.status,
    startedAt: comment.presence.startedAt,
    lastHeartbeatAt: comment.presence.lastHeartbeatAt,
    expiresAt: comment.presence.expiresAt,
    heartbeatAgeSeconds,
    expiresInSeconds,
    healthPort: comment.presence.healthPort,
    metricsPort: comment.presence.metricsPort,
    activeLeaseCount: comment.presence.activeLeaseCount,
    activeWorktreeCount: comment.presence.activeWorktreeCount,
    effectiveActiveTasks: comment.presence.effectiveActiveTasks,
    agentLoopVersion: comment.presence.agentLoopVersion,
    agentLoopRevision: comment.presence.agentLoopRevision,
    upgradeStatus: comment.presence.upgradeStatus,
    upgradeAutoApplyEnabled: comment.presence.upgradeAutoApplyEnabled !== false,
    safeToUpgradeNow: comment.presence.safeToUpgradeNow,
    latestVersion: comment.presence.latestVersion,
    latestRevision: comment.presence.latestRevision,
    upgradeCheckedAt: comment.presence.upgradeCheckedAt,
    upgradeMessage: comment.presence.upgradeMessage ?? null,
    autoUpgrade: comment.presence.autoUpgrade ?? null,
    source: 'github',
  }
}

export function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Agent Loop 监控台</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="shell">
      <header class="hero">
        <div>
          <p class="eyebrow">agent-loop 本地监控</p>
          <h1>分布式开发监控台</h1>
          <p class="subtitle">展示当前仓库的本地运行时细节、基于 GitHub 推导的机器活动，以及实时日志尾部。</p>
        </div>
        <div class="hero-actions">
          <button id="refresh-button" class="primary-button" type="button">立即刷新</button>
          <div class="timestamp" id="updated-at">等待首次快照...</div>
        </div>
      </header>

      <section id="alerts" class="alerts"></section>
      <section id="summary" class="summary-grid"></section>
      <section class="panel">
        <div class="section-header">
          <div>
            <p class="section-eyebrow">机器状态</p>
            <h2>当前有哪些机器在工作</h2>
          </div>
          <p class="section-note">远程机器依据 GitHub 上的受管租约和 presence 心跳展示。空闲远程机器也会显示，但只提供共享心跳，不提供远程健康接口。</p>
        </div>
        <div id="machines" class="machine-grid"></div>
      </section>

      <section class="two-column">
        <div class="panel">
          <div class="section-header compact">
            <div>
              <p class="section-eyebrow">问题队列</p>
              <h2>开放的 Agent Issue</h2>
            </div>
          </div>
          <div class="table-shell">
            <table>
              <thead>
                <tr>
                  <th>Issue</th>
                  <th>状态</th>
                  <th>可认领</th>
                  <th>租约</th>
                  <th>更新时间</th>
                </tr>
              </thead>
              <tbody id="issues-body"></tbody>
            </table>
          </div>
        </div>

        <div class="panel">
          <div class="section-header compact">
            <div>
              <p class="section-eyebrow">拉取请求</p>
              <h2>受管 PR 活动</h2>
            </div>
          </div>
          <div class="table-shell">
            <table>
              <thead>
                <tr>
                  <th>PR</th>
                  <th>分支</th>
                  <th>Review 租约</th>
                  <th>Merge 租约</th>
                </tr>
              </thead>
              <tbody id="prs-body"></tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="section-header">
          <div>
            <p class="section-eyebrow">日志</p>
            <h2>本地 daemon 运行日志</h2>
          </div>
          <div class="log-controls">
            <label for="runtime-select">运行时</label>
            <select id="runtime-select"></select>
            <button id="reload-log" class="secondary-button" type="button">重新加载日志</button>
          </div>
        </div>
        <p class="section-note">日志面板只能读取本机受管 daemon 文件。远程机器日志需要单独的聚合通道。</p>
        <pre id="log-output" class="log-output">等待选择本地运行时...</pre>
      </section>
    </main>
    <script type="module" src="/app.js"></script>
  </body>
</html>`
}

export function renderDashboardCss(): string {
  return `:root {
  color-scheme: light;
  --bg-top: #f6efe3;
  --bg-bottom: #edf5ef;
  --panel: rgba(255, 252, 247, 0.88);
  --panel-border: rgba(60, 86, 76, 0.12);
  --text: #1f322b;
  --muted: #587166;
  --accent: #2f8f71;
  --accent-soft: rgba(47, 143, 113, 0.12);
  --gold: #d79a46;
  --gold-soft: rgba(215, 154, 70, 0.16);
  --danger: #b34d3d;
  --danger-soft: rgba(179, 77, 61, 0.12);
  --shadow: 0 28px 60px rgba(48, 66, 59, 0.12);
  --radius-xl: 28px;
  --radius-lg: 20px;
  --radius-md: 14px;
  --radius-pill: 999px;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: "Avenir Next", "PingFang SC", "Noto Sans SC", sans-serif;
  color: var(--text);
  background:
    radial-gradient(circle at top left, rgba(223, 162, 83, 0.16), transparent 30%),
    radial-gradient(circle at top right, rgba(47, 143, 113, 0.18), transparent 28%),
    linear-gradient(180deg, var(--bg-top), var(--bg-bottom));
  min-height: 100vh;
}

.shell {
  width: min(1440px, calc(100vw - 32px));
  margin: 0 auto;
  padding: 28px 0 40px;
}

.hero,
.panel {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow);
  backdrop-filter: blur(18px);
}

.hero {
  padding: 28px;
  display: flex;
  gap: 20px;
  justify-content: space-between;
  align-items: flex-start;
}

.hero h1,
.panel h2 {
  margin: 0;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.hero h1 {
  font-size: clamp(1.9rem, 4vw, 3rem);
}

.eyebrow,
.section-eyebrow {
  margin: 0 0 8px;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.16em;
  font-size: 0.72rem;
  font-weight: 700;
}

.subtitle,
.section-note,
.timestamp {
  color: var(--muted);
}

.subtitle {
  max-width: 720px;
  margin: 12px 0 0;
  line-height: 1.5;
}

.hero-actions {
  display: grid;
  justify-items: end;
  gap: 12px;
}

.primary-button,
.secondary-button,
select {
  border-radius: var(--radius-pill);
  border: 1px solid transparent;
  transition: transform 180ms ease, border-color 180ms ease, background 180ms ease;
  font: inherit;
}

.primary-button,
.secondary-button {
  cursor: pointer;
  padding: 11px 18px;
}

.primary-button {
  background: var(--accent);
  color: #fff;
}

.secondary-button {
  background: rgba(255, 255, 255, 0.78);
  color: var(--text);
  border-color: rgba(60, 86, 76, 0.14);
}

.primary-button:hover,
.secondary-button:hover,
select:hover {
  transform: translateY(-1px);
}

.summary-grid {
  margin-top: 18px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 14px;
}

.stat-card {
  background: rgba(255, 255, 255, 0.72);
  border: 1px solid rgba(60, 86, 76, 0.12);
  border-radius: var(--radius-lg);
  padding: 18px;
  min-height: 118px;
  box-shadow: 0 18px 34px rgba(48, 66, 59, 0.08);
}

.stat-card strong {
  display: block;
  font-size: 2rem;
  margin-top: 10px;
}

.stat-card.accent {
  background: linear-gradient(180deg, rgba(47, 143, 113, 0.18), rgba(255, 255, 255, 0.74));
}

.stat-card.gold {
  background: linear-gradient(180deg, rgba(215, 154, 70, 0.18), rgba(255, 255, 255, 0.74));
}

.panel {
  margin-top: 18px;
  padding: 22px;
}

.section-header {
  display: flex;
  gap: 16px;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 18px;
}

.section-header.compact {
  margin-bottom: 12px;
}

.section-note {
  margin: 0;
  max-width: 420px;
  line-height: 1.45;
  font-size: 0.95rem;
}

.alerts {
  display: grid;
  gap: 10px;
  margin-top: 18px;
}

.alert {
  border-radius: var(--radius-lg);
  padding: 14px 16px;
  border: 1px solid rgba(60, 86, 76, 0.12);
  background: rgba(255, 255, 255, 0.72);
}

.alert.error {
  border-color: rgba(179, 77, 61, 0.22);
  background: var(--danger-soft);
}

.alert.note {
  border-color: rgba(47, 143, 113, 0.16);
  background: rgba(47, 143, 113, 0.08);
}

.machine-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 14px;
}

.machine-card {
  background: rgba(255, 255, 255, 0.78);
  border: 1px solid rgba(60, 86, 76, 0.12);
  border-radius: var(--radius-lg);
  padding: 18px;
  display: grid;
  gap: 14px;
}

.machine-top {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.machine-title {
  margin: 0;
  font-size: 1.2rem;
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--radius-pill);
  padding: 6px 10px;
  font-size: 0.82rem;
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid rgba(60, 86, 76, 0.12);
  color: var(--text);
}

.chip.accent {
  background: var(--accent-soft);
  border-color: rgba(47, 143, 113, 0.18);
}

.chip.gold {
  background: var(--gold-soft);
  border-color: rgba(215, 154, 70, 0.18);
}

.chip.error {
  background: var(--danger-soft);
  border-color: rgba(179, 77, 61, 0.18);
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.metric-tile {
  border-radius: var(--radius-md);
  background: rgba(246, 239, 227, 0.66);
  padding: 12px;
}

.metric-tile .label {
  display: block;
  color: var(--muted);
  font-size: 0.8rem;
}

.metric-tile .value {
  display: block;
  margin-top: 6px;
  font-weight: 700;
}

.runtime-list,
.warning-list,
.lease-list {
  display: grid;
  gap: 10px;
}

.runtime-item,
.warning-item,
.lease-item {
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid rgba(60, 86, 76, 0.1);
  padding: 12px 13px;
}

.warning-item {
  background: rgba(255, 248, 244, 0.96);
  border-color: rgba(179, 77, 61, 0.12);
}

.lease-item {
  background: rgba(242, 249, 245, 0.96);
}

.muted {
  color: var(--muted);
}

.two-column {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
}

.table-shell {
  overflow: auto;
  border-radius: var(--radius-lg);
  border: 1px solid rgba(60, 86, 76, 0.1);
}

table {
  width: 100%;
  border-collapse: collapse;
  background: rgba(255, 255, 255, 0.84);
}

th,
td {
  text-align: left;
  padding: 14px 12px;
  border-bottom: 1px solid rgba(60, 86, 76, 0.08);
  vertical-align: top;
}

th {
  color: var(--muted);
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

tbody tr:last-child td {
  border-bottom: none;
}

a {
  color: var(--accent);
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}

.table-title {
  font-weight: 700;
  display: block;
  margin-bottom: 6px;
}

.table-note {
  border-radius: 14px;
  padding: 10px 12px;
  border: 1px solid rgba(60, 86, 76, 0.1);
  background: rgba(247, 239, 226, 0.75);
  line-height: 1.45;
}

.table-note-error {
  border-color: rgba(179, 77, 61, 0.16);
  background: rgba(255, 244, 240, 0.92);
}

.log-controls {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}

select {
  padding: 10px 14px;
  background: rgba(255, 255, 255, 0.92);
  border-color: rgba(60, 86, 76, 0.12);
}

.log-output {
  margin: 14px 0 0;
  border-radius: var(--radius-lg);
  background: #19322b;
  color: #e9fff8;
  padding: 18px;
  min-height: 280px;
  max-height: 560px;
  overflow: auto;
  line-height: 1.45;
  font-size: 0.85rem;
}

.empty-state {
  border-radius: var(--radius-lg);
  padding: 18px;
  text-align: center;
  color: var(--muted);
  background: rgba(255, 255, 255, 0.74);
  border: 1px dashed rgba(60, 86, 76, 0.14);
}

@media (max-width: 1080px) {
  .two-column {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 760px) {
  .shell {
    width: min(100vw - 20px, 100%);
    padding-top: 14px;
  }

  .hero,
  .section-header {
    flex-direction: column;
  }

  .hero-actions {
    justify-items: start;
  }

  .metric-grid {
    grid-template-columns: 1fr;
  }
}`
}

export function renderDashboardAppScript(): string {
  return `const refreshIntervalMs = ${DEFAULT_DASHBOARD_REFRESH_INTERVAL_MS};
const state = {
  snapshot: null,
  selectedRuntimeKey: '',
  refreshTimer: null,
};

const alertsEl = document.getElementById('alerts');
const summaryEl = document.getElementById('summary');
const machinesEl = document.getElementById('machines');
const issuesBodyEl = document.getElementById('issues-body');
const prsBodyEl = document.getElementById('prs-body');
const updatedAtEl = document.getElementById('updated-at');
const runtimeSelectEl = document.getElementById('runtime-select');
const logOutputEl = document.getElementById('log-output');
const refreshButtonEl = document.getElementById('refresh-button');
const reloadLogButtonEl = document.getElementById('reload-log');

refreshButtonEl.addEventListener('click', () => {
  void refreshSnapshot();
});

reloadLogButtonEl.addEventListener('click', () => {
  void refreshLog();
});

runtimeSelectEl.addEventListener('change', () => {
  state.selectedRuntimeKey = runtimeSelectEl.value;
  void refreshLog();
});

void refreshSnapshot();
state.refreshTimer = window.setInterval(() => {
  void refreshSnapshot();
}, refreshIntervalMs);

async function refreshSnapshot() {
  try {
    const response = await fetch('/api/snapshot', { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || '快照请求失败');
    }

    state.snapshot = payload;
    renderSnapshot(payload);

    const runtimeOptions = collectLocalRuntimeOptions(payload);
    if (runtimeOptions.length > 0 && !runtimeOptions.some((option) => option.runtimeKey === state.selectedRuntimeKey)) {
      state.selectedRuntimeKey = runtimeOptions[0].runtimeKey;
    }
    renderRuntimeOptions(runtimeOptions);
    await refreshLog();
  } catch (error) {
    alertsEl.innerHTML = renderAlert('error', '仪表盘快照加载失败', escapeHtml(formatError(error)));
  }
}

async function refreshLog() {
  if (!state.selectedRuntimeKey) {
    logOutputEl.textContent = '未发现本仓库的本地受管 daemon 运行时。';
    return;
  }

  try {
    const response = await fetch('/api/log?runtimeKey=' + encodeURIComponent(state.selectedRuntimeKey), { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || '日志请求失败');
    }

    logOutputEl.textContent = payload.found
      ? payload.message + '\\n\\n' + (payload.content || '（日志文件为空）')
      : payload.message;
  } catch (error) {
    logOutputEl.textContent = '日志加载失败：' + formatError(error);
  }
}

function renderSnapshot(snapshot) {
  updatedAtEl.textContent = '仓库 ' + snapshot.repo + ' | 更新于 ' + formatTimestamp(snapshot.generatedAt) + ' | 自动刷新 ' + Math.round(refreshIntervalMs / 1000) + ' 秒';
  renderAlerts(snapshot);
  renderSummary(snapshot);
  renderMachines(snapshot.machines);
  renderIssues(snapshot.issues);
  renderPullRequests(snapshot.prs);
}

function renderAlerts(snapshot) {
  const blocks = [];
  if (Array.isArray(snapshot.errors)) {
    snapshot.errors.forEach((error) => {
      blocks.push(renderAlert('error', '错误', escapeHtml(error)));
    });
  }
  if (Array.isArray(snapshot.notes)) {
    snapshot.notes.forEach((note) => {
      blocks.push(renderAlert('note', '提示', escapeHtml(note)));
    });
  }
  alertsEl.innerHTML = blocks.join('');
}

function renderSummary(snapshot) {
  const stats = [
    { label: '机器数', value: snapshot.summary.machineCount, tone: 'accent' },
    { label: '本地运行时', value: snapshot.summary.localRuntimeCount, tone: '' },
    { label: '受管心跳', value: snapshot.summary.managedPresenceCount, tone: snapshot.summary.managedPresenceCount > 0 ? 'accent' : '' },
    { label: '活跃租约', value: snapshot.summary.activeLeaseCount, tone: 'gold' },
    { label: '待升级机器', value: snapshot.summary.upgradePendingMachineCount, tone: snapshot.summary.upgradePendingMachineCount > 0 ? 'gold' : '' },
    { label: '可立刻升级', value: snapshot.summary.upgradeReadyMachineCount, tone: snapshot.summary.upgradeReadyMachineCount > 0 ? 'accent' : '' },
    { label: '升级被阻塞', value: snapshot.summary.upgradeBlockedMachineCount, tone: snapshot.summary.upgradeBlockedMachineCount > 0 ? 'gold' : '' },
    { label: '手动升级机器', value: snapshot.summary.upgradeManualMachineCount, tone: snapshot.summary.upgradeManualMachineCount > 0 ? 'gold' : '' },
    { label: '升级检查错误', value: snapshot.summary.upgradeErrorMachineCount, tone: snapshot.summary.upgradeErrorMachineCount > 0 ? 'error' : '' },
    { label: '升级执行失败', value: snapshot.summary.upgradeFailedMachineCount, tone: snapshot.summary.upgradeFailedMachineCount > 0 ? 'error' : '' },
    { label: '就绪 Issue', value: snapshot.summary.readyIssueCount, tone: '' },
    { label: '处理中 Issue', value: snapshot.summary.workingIssueCount, tone: 'accent' },
    { label: '失败 Issue', value: snapshot.summary.failedIssueCount, tone: snapshot.summary.failedIssueCount > 0 ? 'gold' : '' },
    { label: '开放 PR', value: snapshot.summary.openPrCount, tone: '' },
  ];

  summaryEl.innerHTML = stats.map((stat) => {
    return '<article class="stat-card ' + stat.tone + '"><span class="muted">' + escapeHtml(stat.label) + '</span><strong>' + escapeHtml(String(stat.value)) + '</strong></article>';
  }).join('');
}

function renderMachines(machines) {
  if (!Array.isArray(machines) || machines.length === 0) {
    machinesEl.innerHTML = '<div class="empty-state">当前仓库未发现本地运行时或远程受管租约。</div>';
    return;
  }

  machinesEl.innerHTML = machines.map((machine) => {
    const runtimeList = machine.localRuntimes.length > 0
      ? '<div class="runtime-list">' + machine.localRuntimes.map(renderRuntimeItem).join('') + '</div>'
      : '<div class="empty-state">这台机器上未发现本地运行时。</div>';
    const observability = machine.observability.length > 0
      ? '<div class="metric-grid">' + machine.observability.map(renderObservabilityTile).join('') + '</div>'
      : '<div class="empty-state">未发现本地 daemon 端点。</div>';
    const leaseList = machine.activeLeases.length > 0
      ? '<div class="lease-list">' + machine.activeLeases.map(renderLeaseItem).join('') + '</div>'
      : '<div class="empty-state">未检测到活跃受管租约。</div>';
    const presence = machine.presence ? renderPresenceItem(machine.presence) : '';
    const warnings = machine.warnings.length > 0
      ? '<div class="warning-list">' + machine.warnings.map((warning) => '<div class="warning-item">' + escapeHtml(warning) + '</div>').join('') + '</div>'
      : '';

    return [
      '<article class="machine-card">',
      '<div class="machine-top">',
      '<div>',
      '<h3 class="machine-title">' + escapeHtml(machine.machineId) + '</h3>',
      '<div class="chip-row">',
      renderChip(localizeMachineSource(machine.source), machine.source === 'mixed' ? 'accent' : machine.source === 'local' ? 'gold' : ''),
      machine.presence ? renderChip(localizePresenceStatus(machine.presence.status), machine.presence.status === 'busy' ? 'accent' : 'gold') : '',
      machine.daemonInstanceIds.map((daemonId) => renderChip(shortDaemonId(daemonId), '')).join(''),
      '</div>',
      '</div>',
      '<div class="chip-row">',
      renderChip('租约 ' + machine.activeLeases.length, machine.activeLeases.length > 0 ? 'accent' : ''),
      renderChip('本地 ' + machine.localRuntimes.length, machine.localRuntimes.length > 0 ? 'gold' : ''),
      '</div>',
      '</div>',
      observability,
      runtimeList,
      leaseList,
      presence,
      warnings,
      '</article>',
    ].join('');
  }).join('');
}

function renderIssues(issues) {
  if (!Array.isArray(issues) || issues.length === 0) {
    issuesBodyEl.innerHTML = '<tr><td colspan="5"><div class="empty-state">当前仓库没有返回开放的 Agent Issue。</div></td></tr>';
    return;
  }

  issuesBodyEl.innerHTML = issues.map((issue) => {
    const claimability = issue.isClaimable
      ? renderChip('可认领', 'accent')
      : renderChip('阻塞', issue.state === 'failed' ? 'error' : 'gold');
    const deps = issue.claimBlockedBy.length > 0
      ? '被 #' + issue.claimBlockedBy.join(', #') + ' 阻塞'
      : issue.dependencyIssueNumbers.length > 0
        ? '依赖 #' + issue.dependencyIssueNumbers.join(', #')
        : '无依赖';
    const contract = issue.hasExecutableContract
      ? '合约通过'
      : '合约无效：' + issue.contractValidationErrors.join('; ');
    const lease = issue.activeLease ? renderInlineLease(issue.activeLease) : '<span class="muted">无</span>';
    const linkedPrs = issue.linkedPrNumbers.length > 0
      ? '<div class="chip-row">' + issue.linkedPrNumbers.map((number) => renderChip('PR #' + number, '')).join('') + '</div>'
      : '';

    return [
      '<tr>',
      '<td>',
      '<a class="table-title" target="_blank" rel="noreferrer" href="' + escapeAttribute(issue.url) + '">#' + issue.number + ' ' + escapeHtml(issue.title) + '</a>',
      '<div class="chip-row">' + issue.labels.map((label) => renderChip(label, '')).join('') + '</div>',
      linkedPrs,
      '</td>',
      '<td>' + renderChip(localizeIssueState(issue.state), issue.state === 'working' ? 'accent' : issue.state === 'failed' ? 'error' : issue.state === 'ready' ? 'gold' : '') + '</td>',
      '<td>' + claimability + '<div class="muted" style="margin-top:8px">' + escapeHtml(deps) + '</div><div class="muted" style="margin-top:6px">' + escapeHtml(contract) + '</div></td>',
      '<td>' + lease + '</td>',
      '<td><div>' + escapeHtml(formatTimestamp(issue.updatedAt)) + '</div><div class="muted" style="margin-top:6px">' + escapeHtml(formatRelative(issue.updatedAt)) + '</div></td>',
      '</tr>',
    ].join('');
  }).join('');
}

function renderPullRequests(prs) {
  if (!Array.isArray(prs) || prs.length === 0) {
    prsBodyEl.innerHTML = '<tr><td colspan="4"><div class="empty-state">当前仓库没有返回开放的受管 PR。</div></td></tr>';
    return;
  }

  prsBodyEl.innerHTML = prs.map((pr) => {
    const linkedIssue = pr.linkedIssueNumber === null ? '<span class="muted">未关联 Issue</span>' : renderChip('Issue #' + pr.linkedIssueNumber, 'gold');
    const draft = pr.isDraft ? renderChip('草稿', 'gold') : '';
    const reviewLease = pr.reviewLease ? renderInlineLease(pr.reviewLease) : '<span class="muted">无</span>';
    const mergeLease = pr.mergeLease ? renderInlineLease(pr.mergeLease) : '<span class="muted">无</span>';
    const blocker = pr.blockerReason
      ? '<div class="table-note table-note-error" style="margin-top:8px"><strong>阻塞原因</strong> · attempt ' + escapeHtml(String(pr.blockerAttempt ?? '?')) + (pr.blockerUpdatedAt ? ' · ' + escapeHtml(formatTimestamp(pr.blockerUpdatedAt)) : '') + (pr.blockerResumable ? ' · 可自动续跑' : '') + '<br>' + escapeHtml(pr.blockerReason) + (pr.blockerFindingSummary ? '<br><span class="muted">Top finding: ' + escapeHtml(pr.blockerFindingSummary) + '</span>' : '') + '</div>'
      : '';

    return [
      '<tr>',
      '<td>',
      '<a class="table-title" target="_blank" rel="noreferrer" href="' + escapeAttribute(pr.url) + '">PR #' + pr.number + ' ' + escapeHtml(pr.title) + '</a>',
      '<div class="chip-row">',
      linkedIssue,
      draft,
      pr.labels.map((label) => renderChip(label, label.indexOf('approved') !== -1 ? 'accent' : label.indexOf('human-needed') !== -1 ? 'error' : '')).join(''),
      '</div>',
      blocker,
      '</td>',
      '<td><div>' + escapeHtml(pr.headRefName) + '</div></td>',
      '<td>' + reviewLease + '</td>',
      '<td>' + mergeLease + '</td>',
      '</tr>',
    ].join('');
  }).join('');
}

function renderRuntimeOptions(options) {
  runtimeSelectEl.innerHTML = options.length === 0
    ? '<option value="">无本地运行时</option>'
    : options.map((option) => {
      const selected = option.runtimeKey === state.selectedRuntimeKey ? ' selected' : '';
      return '<option value="' + escapeAttribute(option.runtimeKey) + '"' + selected + '>' + escapeHtml(option.label) + '</option>';
    }).join('');
  runtimeSelectEl.disabled = options.length === 0;
  reloadLogButtonEl.disabled = options.length === 0;
}

function collectLocalRuntimeOptions(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.machines)) return [];
  return snapshot.machines.flatMap((machine) => {
    return machine.localRuntimes.map((runtime) => ({
      runtimeKey: runtime.runtimeKey,
      label: machine.machineId + ' @ ' + runtime.healthPort + '（' + runtime.supervisor + '）',
    }));
  });
}

function renderRuntimeItem(runtime) {
  return [
    '<div class="runtime-item">',
    '<div class="chip-row">',
    renderChip(runtime.alive ? '在线' : '失联', runtime.alive ? 'accent' : 'error'),
    renderChip(runtime.supervisor, ''),
    renderChip('健康端口 ' + runtime.healthPort, ''),
    renderChip('指标端口 ' + runtime.metricsPort, ''),
    '</div>',
    '<div style="margin-top:8px"><strong>PID ' + escapeHtml(String(runtime.pid)) + '</strong> <span class="muted">启动于 ' + escapeHtml(formatTimestamp(runtime.startedAt)) + '</span></div>',
    '<div class="muted" style="margin-top:6px">' + escapeHtml(runtime.cwd) + '</div>',
    '</div>',
  ].join('');
}

function renderObservabilityTile(observability) {
  const status = observability.ok ? '运行中' : '不可达';
  const tone = observability.ok ? 'accent' : 'error';
  const nextPoll = observability.nextPollAt
    ? formatRelative(observability.nextPollAt)
    : '未计划';

  return [
    '<div class="metric-tile">',
    '<div class="chip-row">',
    renderChip(status, tone),
    observability.daemonInstanceId ? renderChip(shortDaemonId(observability.daemonInstanceId), '') : '',
    '</div>',
    '<span class="label">工作树 / 租约</span>',
    '<span class="value">' + escapeHtml(String(observability.activeWorktreeCount)) + ' / ' + escapeHtml(String(observability.activeLeaseCount)) + '</span>',
    '<span class="label" style="margin-top:8px">下次轮询</span>',
    '<span class="value">' + escapeHtml(nextPoll) + '</span>',
    '<span class="label" style="margin-top:8px">阻塞恢复 / 卡住 worker</span>',
    '<span class="value">' + escapeHtml(String(observability.blockedIssueResumeCount)) + ' / ' + escapeHtml(String(observability.stalledWorkerCount)) + '</span>',
    '</div>',
  ].join('');
}

function renderLeaseItem(lease) {
  return '<div class="lease-item">' + renderInlineLease(lease) + '</div>';
}

function renderPresenceItem(presence) {
  const timing = [
    presence.heartbeatAgeSeconds === null ? null : '心跳 ' + presence.heartbeatAgeSeconds + ' 秒',
    presence.expiresInSeconds === null ? null : 'TTL ' + presence.expiresInSeconds + ' 秒',
  ].filter(Boolean).join(' | ');
  const autoUpgrade = presence.autoUpgrade;
  const pauseActive = autoUpgrade && autoUpgrade.pausedUntil
    && autoUpgrade.lastTargetVersion === (presence.latestVersion || null)
    && autoUpgrade.lastTargetRevision === (presence.latestRevision || null);
  const upgradeHint = presence.upgradeStatus === 'upgrade-available'
    ? (!presence.upgradeAutoApplyEnabled
      ? '自动升级已关闭'
      : (presence.safeToUpgradeNow ? '可安全升级' : '待空闲后升级'))
    : null;
  const autoUpgradeOutcome = autoUpgrade && autoUpgrade.lastOutcome
    ? localizeAutoUpgradeOutcome(autoUpgrade.lastOutcome)
    : null;
  const autoUpgradeOutcomeTone = autoUpgrade && autoUpgrade.lastOutcome === 'failed'
    ? 'error'
    : autoUpgrade && autoUpgrade.lastOutcome === 'succeeded'
      ? 'accent'
      : autoUpgrade && autoUpgrade.lastOutcome === 'attempting'
        ? 'gold'
        : '';
  const autoUpgradeSummary = autoUpgrade
    ? '自动升级 ' + (autoUpgradeOutcome || '未知') + ' | 尝试 ' + autoUpgrade.attemptCount + ' | 成功 ' + autoUpgrade.successCount + ' | 失败 ' + autoUpgrade.failureCount + ' | 无变化 ' + autoUpgrade.noChangeCount + ' | 连续失败 ' + autoUpgrade.consecutiveFailureCount
    : null;
  const autoUpgradeMeta = autoUpgrade && (autoUpgrade.lastAttemptAt || autoUpgrade.lastSuccessAt || autoUpgrade.lastTargetVersion || autoUpgrade.lastTargetRevision || pauseActive)
    ? [
      autoUpgrade.lastAttemptAt ? '上次尝试 ' + formatTimestamp(autoUpgrade.lastAttemptAt) : null,
      autoUpgrade.lastSuccessAt ? '上次成功 ' + formatTimestamp(autoUpgrade.lastSuccessAt) : null,
      pauseActive ? '暂停到 ' + formatTimestamp(autoUpgrade.pausedUntil) : null,
      (autoUpgrade.lastTargetVersion || autoUpgrade.lastTargetRevision)
        ? '目标 v' + (autoUpgrade.lastTargetVersion || 'unknown') + '@' + shortDaemonId(autoUpgrade.lastTargetRevision || 'unknown')
        : null,
    ].filter(Boolean).join(' | ')
    : null;

  return [
    '<div class="lease-item">',
    '<div><strong>共享在线心跳</strong> <span class="muted">GitHub presence</span></div>',
    '<div class="chip-row" style="margin-top:8px">',
    renderChip(localizePresenceStatus(presence.status), presence.status === 'busy' ? 'accent' : 'gold'),
    renderChip(shortDaemonId(presence.daemonInstanceId), ''),
    renderChip('v' + presence.agentLoopVersion, ''),
    renderChip(presence.upgradeStatus, presence.upgradeStatus === 'upgrade-available' ? 'danger' : ''),
    autoUpgradeOutcome ? renderChip('自动升级' + autoUpgradeOutcome, autoUpgradeOutcomeTone) : '',
    renderChip(presence.upgradeAutoApplyEnabled ? '自动升级开' : '自动升级关', presence.upgradeAutoApplyEnabled ? 'accent' : 'gold'),
    renderChip('工作树 ' + presence.activeWorktreeCount, ''),
    renderChip('租约 ' + presence.activeLeaseCount, ''),
    '</div>',
    '<div class="muted" style="margin-top:8px">启动于 ' + escapeHtml(formatTimestamp(presence.startedAt)) + '</div>',
    '<div class="muted" style="margin-top:6px">revision ' + escapeHtml(shortDaemonId(presence.agentLoopRevision || 'unknown')) + (presence.latestVersion ? ' | latest v' + escapeHtml(String(presence.latestVersion)) : '') + '</div>',
    upgradeHint ? '<div class="muted" style="margin-top:6px">' + escapeHtml(upgradeHint) + '</div>' : '',
    autoUpgradeSummary ? '<div class="muted" style="margin-top:6px">' + escapeHtml(autoUpgradeSummary) + '</div>' : '',
    autoUpgradeMeta ? '<div class="muted" style="margin-top:6px">' + escapeHtml(autoUpgradeMeta) + '</div>' : '',
    presence.upgradeMessage ? '<div class="muted" style="margin-top:6px">' + escapeHtml(presence.upgradeMessage) + '</div>' : '',
    autoUpgrade && autoUpgrade.lastError ? '<div class="muted" style="margin-top:6px">错误：' + escapeHtml(autoUpgrade.lastError) + '</div>' : '',
    timing ? '<div class="muted" style="margin-top:6px">' + escapeHtml(timing) + '</div>' : '',
    '</div>',
  ].join('');
}

function renderInlineLease(lease) {
  const target = lease.scope === 'issue-process'
    ? 'Issue #' + lease.targetNumber
    : 'PR #' + lease.targetNumber;
  const timing = [
    lease.heartbeatAgeSeconds === null ? null : '心跳 ' + lease.heartbeatAgeSeconds + ' 秒',
    lease.progressAgeSeconds === null ? null : '进度 ' + lease.progressAgeSeconds + ' 秒',
    lease.expiresInSeconds === null ? null : 'TTL ' + lease.expiresInSeconds + ' 秒',
  ].filter(Boolean).join(' | ');

  return [
    '<div><strong>' + escapeHtml(target) + '</strong> <span class="muted">' + escapeHtml(localizeLeaseScope(lease.scope)) + '</span></div>',
    '<div class="chip-row" style="margin-top:8px">',
    renderChip(lease.phase, 'accent'),
    renderChip(localizeLeaseSource(lease.source), lease.source === 'local' ? 'gold' : ''),
    renderChip('机器 ' + lease.machineId, ''),
    renderChip('尝试 ' + lease.attempt, ''),
    '</div>',
    timing ? '<div class="muted" style="margin-top:8px">' + escapeHtml(timing) + '</div>' : '',
  ].join('');
}

function localizeMachineSource(source) {
  switch (source) {
    case 'local':
      return '本地';
    case 'github':
      return 'GitHub';
    case 'mixed':
      return '混合';
    default:
      return source || '未知';
  }
}

function localizeIssueState(state) {
  switch (state) {
    case 'ready':
      return '就绪';
    case 'working':
      return '处理中';
    case 'claimed':
      return '已认领';
    case 'failed':
      return '失败';
    case 'stale':
      return '陈旧';
    case 'done':
      return '完成';
    case 'unknown':
      return '未知';
    default:
      return state || '未知';
  }
}

function localizeLeaseSource(source) {
  switch (source) {
    case 'local':
      return '本地';
    case 'github':
      return 'GitHub';
    default:
      return source || '未知';
  }
}

function localizePresenceStatus(status) {
  switch (status) {
    case 'idle':
      return '空闲在线'
    case 'busy':
      return '忙碌在线'
    case 'stopped':
      return '已停止'
    default:
      return status || '未知'
  }
}

function localizeAutoUpgradeOutcome(outcome) {
  switch (outcome) {
    case 'attempting':
      return '进行中'
    case 'succeeded':
      return '成功'
    case 'failed':
      return '失败'
    case 'no_change':
      return '无变化'
    default:
      return outcome || '未知'
  }
}

function localizeLeaseScope(scope) {
  switch (scope) {
    case 'issue-process':
      return 'Issue 处理';
    case 'pr-review':
      return 'PR Review';
    case 'pr-merge':
      return 'PR Merge';
    default:
      return scope || '未知';
  }
}

function renderChip(label, tone) {
  const normalizedTone = tone ? ' ' + tone : '';
  return '<span class="chip' + normalizedTone + '">' + escapeHtml(label) + '</span>';
}

function renderAlert(kind, title, body) {
  return '<div class="alert ' + kind + '"><strong>' + escapeHtml(title) + '</strong><div style="margin-top:6px">' + body + '</div></div>';
}

function shortDaemonId(daemonId) {
  if (!daemonId) return '';
  if (daemonId.length <= 18) return daemonId;
  return daemonId.slice(0, 18) + '...';
}

function formatTimestamp(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value || '未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(parsed));
}

function formatRelative(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return '未知';
  const diffSeconds = Math.floor((Date.now() - parsed) / 1000);
  const future = diffSeconds < 0;
  const seconds = Math.abs(diffSeconds);
  if (seconds < 60) return seconds + ' 秒' + (future ? '后' : '前');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + ' 分钟' + (future ? '后' : '前');
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours + ' 小时' + (future ? '后' : '前');
  const days = Math.floor(hours / 24);
  return days + ' 天' + (future ? '后' : '前');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}`
}
