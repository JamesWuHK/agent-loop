import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  runBoundedGhCommand,
  type AgentConfig,
  type AgentLoopAutoUpgradeOutcome,
  type AgentLoopAutoUpgradeRuntimeState,
  type GitHubApiOutcome,
  type AgentLoopUpgradeStatusKind,
  type IssueComment,
} from '@agent/shared'
import { recordGitHubApiRequest } from './metrics'

const MANAGED_DAEMON_PRESENCE_ISSUE_TITLE = 'Agent Loop Presence'
const MANAGED_DAEMON_PRESENCE_ISSUE_MARKER = '<!-- agent-loop:presence-registry -->'
const MANAGED_DAEMON_PRESENCE_COMMENT_PREFIX = '<!-- agent-loop:presence '
const MANAGED_DAEMON_UPGRADE_ANNOUNCEMENT_COMMENT_PREFIX = '<!-- agent-loop:upgrade-announcement '
const MANAGED_DAEMON_UPGRADE_FAILURE_ALERT_COMMENT_PREFIX = '<!-- agent-loop:upgrade-failure-alert '
const MANAGED_DAEMON_UPGRADE_SUCCESS_COMMENT_PREFIX = '<!-- agent-loop:upgrade-success '
const GITHUB_REST_TIMEOUT_MS = 180_000

export type ManagedDaemonPresenceStatus = 'idle' | 'busy' | 'stopped'

export interface ManagedDaemonPresence {
  repo: string
  machineId: string
  daemonInstanceId: string
  status: ManagedDaemonPresenceStatus
  startedAt: string
  lastHeartbeatAt: string
  expiresAt: string
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
}

export interface ManagedDaemonPresenceComment extends IssueComment {
  presence: ManagedDaemonPresence
}

export interface ManagedDaemonPresenceRuntimeState {
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
}

export interface ManagedDaemonUpgradeAnnouncement {
  repo: string
  channel: string | null
  latestVersion: string | null
  latestRevision: string | null
  latestCommitAt: string | null
  announcedAt: string
  announcedByMachineId: string
  announcedByDaemonInstanceId: string
}

export interface ManagedDaemonUpgradeAnnouncementComment extends IssueComment {
  announcement: ManagedDaemonUpgradeAnnouncement
}

export interface ManagedDaemonUpgradeFailureAlert {
  repo: string
  machineId: string
  daemonInstanceId: string
  channel: string | null
  targetVersion: string | null
  targetRevision: string | null
  consecutiveFailureCount: number
  pausedUntil: string | null
  lastAttemptAt: string | null
  lastError: string | null
  alertedAt: string
}

export interface ManagedDaemonUpgradeFailureAlertComment extends IssueComment {
  alert: ManagedDaemonUpgradeFailureAlert
}

export interface ManagedDaemonUpgradeSuccess {
  repo: string
  machineId: string
  daemonInstanceId: string
  channel: string | null
  targetVersion: string | null
  targetRevision: string | null
  succeededAt: string
  acknowledgedAt: string
}

export interface ManagedDaemonUpgradeSuccessComment extends IssueComment {
  success: ManagedDaemonUpgradeSuccess
}

export interface PresenceApiAdapter {
  ensurePresenceIssue(config: AgentConfig): Promise<number>
  listIssueComments(issueNumber: number, config: AgentConfig): Promise<IssueComment[]>
  commentOnIssue(issueNumber: number, body: string, config: AgentConfig): Promise<IssueComment>
  updateIssueComment(commentId: number, body: string, config: AgentConfig): Promise<IssueComment>
}

interface RawIssueListItem {
  number?: unknown
  title?: unknown
  body?: unknown
  pull_request?: unknown
}

interface RawIssueRecord {
  number?: unknown
}

interface RawIssueCommentRecord {
  id?: unknown
  body?: unknown
  created_at?: unknown
  updated_at?: unknown
}

function buildManagedDaemonPresenceRegistryBody(repo: string): string {
  return `${MANAGED_DAEMON_PRESENCE_ISSUE_MARKER}
## Agent Loop Presence Registry

This issue stores one managed presence heartbeat comment per machine for \`${repo}\`.

- Comments are updated automatically by agent-loop daemons
- Dashboard readers may treat expired heartbeats as offline
- Do not delete active machine comments while daemons are running`
}

function withTempJsonFile<T>(
  prefix: string,
  payload: Record<string, unknown>,
  run: (path: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`))
  const path = join(dir, 'payload.json')
  writeFileSync(path, JSON.stringify(payload), 'utf-8')

  return run(path).finally(() => {
    rmSync(dir, { recursive: true, force: true })
  })
}

async function runGhCommand(
  args: string[],
  config: AgentConfig,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const { stdout, stderr, exitCode, timedOut } = await runBoundedGhCommand(args, config)
  return { stdout, stderr, exitCode, timedOut }
}

async function runGitHubRestRequest(
  path: string,
  config: AgentConfig,
  options: {
    method?: 'GET' | 'POST' | 'PATCH'
    body?: Record<string, unknown>
  } = {},
): Promise<string> {
  const normalizedPath = path.replace(/^\/+/, '')
  const method = options.method ?? 'GET'
  const startedAt = Date.now()

  if (!config.pat) {
    const args = ['api', normalizedPath]
    if (method !== 'GET') {
      args.push('-X', method)
    }
    if (options.body) {
      return withTempJsonFile(
        'agent-loop-presence-rest-fallback',
        options.body,
        async (payloadPath) => {
          const response = await runGhCommand([...args, '--input', payloadPath], config)
          recordGitHubApiRequest(
            'rest',
            'gh_cli',
            classifyGitHubApiOutcome(response.stderr, response.exitCode, response.timedOut),
            Date.now() - startedAt,
          )
          if (response.exitCode !== 0) {
            throw new Error(`gh api ${normalizedPath} failed (exit ${response.exitCode}): ${response.stderr}`)
          }
          return response.stdout
        },
      )
    }

    const response = await runGhCommand(args, config)
    recordGitHubApiRequest(
      'rest',
      'gh_cli',
      classifyGitHubApiOutcome(response.stderr, response.exitCode, response.timedOut),
      Date.now() - startedAt,
    )
    if (response.exitCode !== 0) {
      throw new Error(`gh api ${normalizedPath} failed (exit ${response.exitCode}): ${response.stderr}`)
    }
    return response.stdout
  }

  try {
    const response = await fetchWithTimeout(`https://api.github.com/${normalizedPath}`, {
      method,
      headers: {
        Authorization: `token ${config.pat}`,
        Accept: 'application/vnd.github+json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    })
    const text = await response.text()
    recordGitHubApiRequest(
      'rest',
      'direct',
      classifyGitHubApiOutcome(parseGitHubRestErrorMessage(text), response.ok ? 0 : 1, false),
      Date.now() - startedAt,
    )
    if (!response.ok) {
      throw new Error(`GitHub REST ${method} ${normalizedPath} failed (HTTP ${response.status}): ${parseGitHubRestErrorMessage(text)}`)
    }
    return text
  } catch (error) {
    if (error instanceof Error && error.message.includes('timed out')) {
      recordGitHubApiRequest('rest', 'direct', 'timeout', Date.now() - startedAt)
    }
    throw error
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = GITHUB_REST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`GitHub REST request timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

function parseGitHubRestErrorMessage(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) {
    return 'empty response body'
  }

  try {
    const parsed = JSON.parse(trimmed) as { message?: unknown }
    if (typeof parsed.message === 'string' && parsed.message.trim().length > 0) {
      return parsed.message
    }
  } catch {
    // fall back to raw response text
  }

  return trimmed
}

function classifyGitHubApiOutcome(
  message: string,
  exitCode: number,
  timedOut: boolean,
): GitHubApiOutcome {
  if (timedOut || message.toLowerCase().includes('timed out')) {
    return 'timeout'
  }
  if (exitCode === 0) {
    return 'success'
  }

  const normalized = message.toLowerCase()
  if (
    normalized.includes('api rate limit')
    || normalized.includes('secondary rate limit')
    || normalized.includes('rate limit exceeded')
  ) {
    return 'rate_limited'
  }

  return 'error'
}

function mapIssueCommentRecord(
  comment: RawIssueCommentRecord,
  fallback: {
    commentId?: number
    body?: string
  } = {},
): IssueComment {
  return {
    commentId: typeof comment.id === 'number' ? comment.id : (fallback.commentId ?? 0),
    body: typeof comment.body === 'string' ? comment.body : (fallback.body ?? ''),
    createdAt: typeof comment.created_at === 'string' ? comment.created_at : '',
    updatedAt: typeof comment.updated_at === 'string' ? comment.updated_at : '',
  }
}

function isPresenceRegistryIssue(issue: RawIssueListItem): boolean {
  if (issue.pull_request) return false
  return issue.title === MANAGED_DAEMON_PRESENCE_ISSUE_TITLE
    || (typeof issue.body === 'string' && issue.body.includes(MANAGED_DAEMON_PRESENCE_ISSUE_MARKER))
}

export function extractManagedDaemonPresenceIssueNumber(
  issues: RawIssueListItem[],
): number | null {
  const match = issues.find(isPresenceRegistryIssue)
  return typeof match?.number === 'number' ? match.number : null
}

export function buildManagedDaemonPresenceComment(presence: ManagedDaemonPresence): string {
  const autoUpgrade = presence.autoUpgrade
  const autoUpgradeCounts = autoUpgrade
    ? `attempt ${autoUpgrade.attemptCount} / success ${autoUpgrade.successCount} / failed ${autoUpgrade.failureCount} / no-change ${autoUpgrade.noChangeCount}`
    : 'unavailable'
  const autoUpgradeTarget = autoUpgrade && (autoUpgrade.lastTargetVersion || autoUpgrade.lastTargetRevision)
    ? `v${autoUpgrade.lastTargetVersion ?? 'unknown'} (${autoUpgrade.lastTargetRevision ?? 'unknown'})`
    : 'unknown'

  return `${MANAGED_DAEMON_PRESENCE_COMMENT_PREFIX}${JSON.stringify(presence)} -->
## Managed daemon presence

- Repo: ${presence.repo}
- Machine: ${presence.machineId}
- Daemon: ${presence.daemonInstanceId}
- Status: ${presence.status}
- Heartbeat: ${presence.lastHeartbeatAt}
- Expires: ${presence.expiresAt}
- Health port: ${presence.healthPort}
- Metrics port: ${presence.metricsPort}
- Worktrees: ${presence.activeWorktreeCount}
- Leases: ${presence.activeLeaseCount}
- Effective tasks: ${presence.effectiveActiveTasks}
- Agent Loop: v${presence.agentLoopVersion} (${presence.agentLoopRevision ?? 'unknown'})
- Upgrade status: ${presence.upgradeStatus}
- Auto-apply enabled: ${presence.upgradeAutoApplyEnabled ? 'yes' : 'no'}
- Safe to upgrade now: ${presence.safeToUpgradeNow ? 'yes' : 'no'}
- Latest known version: ${presence.latestVersion ?? 'unknown'}
- Latest known revision: ${presence.latestRevision ?? 'unknown'}
- Upgrade message: ${presence.upgradeMessage ?? 'none'}
- Auto-upgrade outcome: ${autoUpgrade?.lastOutcome ?? 'unknown'}
- Auto-upgrade counts: ${autoUpgradeCounts}
- Auto-upgrade failure streak: ${autoUpgrade?.consecutiveFailureCount ?? 0}
- Auto-upgrade last attempt: ${autoUpgrade?.lastAttemptAt ?? 'never'}
- Auto-upgrade last success: ${autoUpgrade?.lastSuccessAt ?? 'never'}
- Auto-upgrade paused until: ${autoUpgrade?.pausedUntil ?? 'none'}
- Auto-upgrade target: ${autoUpgradeTarget}
- Auto-upgrade last error: ${autoUpgrade?.lastError ?? 'none'}`
}

export function buildManagedDaemonUpgradeAnnouncementComment(
  announcement: ManagedDaemonUpgradeAnnouncement,
): string {
  return `${MANAGED_DAEMON_UPGRADE_ANNOUNCEMENT_COMMENT_PREFIX}${JSON.stringify(announcement)} -->
## Agent Loop upgrade announcement

A managed daemon detected a newer agent-loop build and is broadcasting it to other machines.

- Repo: ${announcement.repo}
- Channel: ${announcement.channel ?? 'default'}
- Latest version: ${announcement.latestVersion ?? 'unknown'}
- Latest revision: ${announcement.latestRevision ?? 'unknown'}
- Latest commit at: ${announcement.latestCommitAt ?? 'unknown'}
- Announced at: ${announcement.announcedAt}
- Announced by: ${announcement.announcedByMachineId} (${announcement.announcedByDaemonInstanceId})`
}

export function buildManagedDaemonUpgradeFailureAlertComment(
  alert: ManagedDaemonUpgradeFailureAlert,
): string {
  return `${MANAGED_DAEMON_UPGRADE_FAILURE_ALERT_COMMENT_PREFIX}${JSON.stringify(alert)} -->
## Agent Loop auto-upgrade failure alert

A managed daemon is backing off repeated self-upgrade retries after consecutive failures.

- Repo: ${alert.repo}
- Machine: ${alert.machineId}
- Daemon: ${alert.daemonInstanceId}
- Channel: ${alert.channel ?? 'default'}
- Target version: ${alert.targetVersion ?? 'unknown'}
- Target revision: ${alert.targetRevision ?? 'unknown'}
- Consecutive failures: ${alert.consecutiveFailureCount}
- Paused until: ${alert.pausedUntil ?? 'none'}
- Last attempt: ${alert.lastAttemptAt ?? 'never'}
- Last error: ${alert.lastError ?? 'none'}
- Alerted at: ${alert.alertedAt}`
}

export function buildManagedDaemonUpgradeSuccessComment(
  success: ManagedDaemonUpgradeSuccess,
): string {
  return `${MANAGED_DAEMON_UPGRADE_SUCCESS_COMMENT_PREFIX}${JSON.stringify(success)} -->
## Agent Loop auto-upgrade success

A managed daemon successfully restarted into the upgraded build and is back online.

- Repo: ${success.repo}
- Machine: ${success.machineId}
- Daemon: ${success.daemonInstanceId}
- Channel: ${success.channel ?? 'default'}
- Target version: ${success.targetVersion ?? 'unknown'}
- Target revision: ${success.targetRevision ?? 'unknown'}
- Succeeded at: ${success.succeededAt}
- Acknowledged at: ${success.acknowledgedAt}`
}

export function extractManagedDaemonPresenceComment(body: string): ManagedDaemonPresence | null {
  const match = body.match(/<!-- agent-loop:presence (\{.*\}) -->/)
  if (!match?.[1]) return null

  try {
    const parsed = JSON.parse(match[1]) as Partial<ManagedDaemonPresence>
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.repo !== 'string') return null
    if (typeof parsed.machineId !== 'string' || typeof parsed.daemonInstanceId !== 'string') return null
    if (parsed.status !== 'idle' && parsed.status !== 'busy' && parsed.status !== 'stopped') return null
    if (typeof parsed.startedAt !== 'string' || typeof parsed.lastHeartbeatAt !== 'string' || typeof parsed.expiresAt !== 'string') return null
    if (!Number.isFinite(parsed.healthPort) || !Number.isFinite(parsed.metricsPort)) return null
    if (!Number.isFinite(parsed.activeLeaseCount) || !Number.isFinite(parsed.activeWorktreeCount) || !Number.isFinite(parsed.effectiveActiveTasks)) return null

    const healthPort = parsed.healthPort as number
    const metricsPort = parsed.metricsPort as number
    const activeLeaseCount = parsed.activeLeaseCount as number
    const activeWorktreeCount = parsed.activeWorktreeCount as number
    const effectiveActiveTasks = parsed.effectiveActiveTasks as number
    const agentLoopVersion = typeof parsed.agentLoopVersion === 'string' && parsed.agentLoopVersion.trim().length > 0
      ? parsed.agentLoopVersion
      : 'unknown'
    const agentLoopRevision = typeof parsed.agentLoopRevision === 'string' && parsed.agentLoopRevision.trim().length > 0
      ? parsed.agentLoopRevision
      : null
    const upgradeStatus = parsed.upgradeStatus === 'disabled'
      || parsed.upgradeStatus === 'unknown'
      || parsed.upgradeStatus === 'up-to-date'
      || parsed.upgradeStatus === 'upgrade-available'
      || parsed.upgradeStatus === 'ahead-of-channel'
      || parsed.upgradeStatus === 'error'
      ? parsed.upgradeStatus
      : 'unknown'
    const upgradeAutoApplyEnabled = parsed.upgradeAutoApplyEnabled !== false
    const safeToUpgradeNow = parsed.safeToUpgradeNow === true
    const latestVersion = typeof parsed.latestVersion === 'string' && parsed.latestVersion.trim().length > 0
      ? parsed.latestVersion
      : null
    const latestRevision = typeof parsed.latestRevision === 'string' && parsed.latestRevision.trim().length > 0
      ? parsed.latestRevision
      : null
    const upgradeCheckedAt = typeof parsed.upgradeCheckedAt === 'string' && parsed.upgradeCheckedAt.trim().length > 0
      ? parsed.upgradeCheckedAt
      : null
    const upgradeMessage = typeof parsed.upgradeMessage === 'string' && parsed.upgradeMessage.trim().length > 0
      ? parsed.upgradeMessage
      : null
    const autoUpgrade = normalizeManagedAutoUpgradeRuntimeState(parsed.autoUpgrade)

    return {
      repo: parsed.repo,
      machineId: parsed.machineId,
      daemonInstanceId: parsed.daemonInstanceId,
      status: parsed.status,
      startedAt: parsed.startedAt,
      lastHeartbeatAt: parsed.lastHeartbeatAt,
      expiresAt: parsed.expiresAt,
      healthPort,
      metricsPort,
      activeLeaseCount,
      activeWorktreeCount,
      effectiveActiveTasks,
      agentLoopVersion,
      agentLoopRevision,
      upgradeStatus,
      upgradeAutoApplyEnabled,
      safeToUpgradeNow,
      latestVersion,
      latestRevision,
      upgradeCheckedAt,
      upgradeMessage,
      autoUpgrade,
    }
  } catch {
    return null
  }
}

function normalizeManagedAutoUpgradeRuntimeState(value: unknown): AgentLoopAutoUpgradeRuntimeState | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const parsed = value as Record<string, unknown>

  return {
    attemptCount: normalizeNonNegativeInteger(parsed.attemptCount),
    successCount: normalizeNonNegativeInteger(parsed.successCount),
    failureCount: normalizeNonNegativeInteger(parsed.failureCount),
    noChangeCount: normalizeNonNegativeInteger(parsed.noChangeCount),
    consecutiveFailureCount: normalizeNonNegativeInteger(parsed.consecutiveFailureCount),
    lastAttemptAt: normalizeOptionalString(parsed.lastAttemptAt),
    lastSuccessAt: normalizeOptionalString(parsed.lastSuccessAt),
    lastOutcome: normalizeAutoUpgradeOutcome(parsed.lastOutcome),
    lastTargetVersion: normalizeOptionalString(parsed.lastTargetVersion),
    lastTargetRevision: normalizeOptionalString(parsed.lastTargetRevision),
    lastError: normalizeOptionalString(parsed.lastError),
    pausedUntil: normalizeOptionalString(parsed.pausedUntil),
  }
}

function normalizeAutoUpgradeOutcome(value: unknown): AgentLoopAutoUpgradeOutcome | null {
  return value === 'attempting'
    || value === 'succeeded'
    || value === 'failed'
    || value === 'no_change'
    ? value
    : null
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null
}

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0
}

export function extractManagedDaemonUpgradeAnnouncementComment(
  body: string,
): ManagedDaemonUpgradeAnnouncement | null {
  const match = body.match(/<!-- agent-loop:upgrade-announcement (\{.*\}) -->/)
  if (!match?.[1]) return null

  try {
    const parsed = JSON.parse(match[1]) as Partial<ManagedDaemonUpgradeAnnouncement>
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.repo !== 'string' || typeof parsed.announcedAt !== 'string') return null
    if (typeof parsed.announcedByMachineId !== 'string' || typeof parsed.announcedByDaemonInstanceId !== 'string') return null

    return {
      repo: parsed.repo,
      channel: typeof parsed.channel === 'string' && parsed.channel.trim().length > 0 ? parsed.channel : null,
      latestVersion: typeof parsed.latestVersion === 'string' && parsed.latestVersion.trim().length > 0 ? parsed.latestVersion : null,
      latestRevision: typeof parsed.latestRevision === 'string' && parsed.latestRevision.trim().length > 0 ? parsed.latestRevision : null,
      latestCommitAt: typeof parsed.latestCommitAt === 'string' && parsed.latestCommitAt.trim().length > 0 ? parsed.latestCommitAt : null,
      announcedAt: parsed.announcedAt,
      announcedByMachineId: parsed.announcedByMachineId,
      announcedByDaemonInstanceId: parsed.announcedByDaemonInstanceId,
    }
  } catch {
    return null
  }
}

export function extractManagedDaemonUpgradeFailureAlertComment(
  body: string,
): ManagedDaemonUpgradeFailureAlert | null {
  const match = body.match(/<!-- agent-loop:upgrade-failure-alert (\{.*\}) -->/)
  if (!match?.[1]) return null

  try {
    const parsed = JSON.parse(match[1]) as Partial<ManagedDaemonUpgradeFailureAlert>
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.repo !== 'string' || typeof parsed.machineId !== 'string' || typeof parsed.daemonInstanceId !== 'string') return null
    if (typeof parsed.alertedAt !== 'string') return null

    return {
      repo: parsed.repo,
      machineId: parsed.machineId,
      daemonInstanceId: parsed.daemonInstanceId,
      channel: typeof parsed.channel === 'string' && parsed.channel.trim().length > 0 ? parsed.channel : null,
      targetVersion: typeof parsed.targetVersion === 'string' && parsed.targetVersion.trim().length > 0 ? parsed.targetVersion : null,
      targetRevision: typeof parsed.targetRevision === 'string' && parsed.targetRevision.trim().length > 0 ? parsed.targetRevision : null,
      consecutiveFailureCount: normalizeNonNegativeInteger(parsed.consecutiveFailureCount),
      pausedUntil: typeof parsed.pausedUntil === 'string' && parsed.pausedUntil.trim().length > 0 ? parsed.pausedUntil : null,
      lastAttemptAt: typeof parsed.lastAttemptAt === 'string' && parsed.lastAttemptAt.trim().length > 0 ? parsed.lastAttemptAt : null,
      lastError: typeof parsed.lastError === 'string' && parsed.lastError.trim().length > 0 ? parsed.lastError : null,
      alertedAt: parsed.alertedAt,
    }
  } catch {
    return null
  }
}

export function extractManagedDaemonUpgradeSuccessComment(
  body: string,
): ManagedDaemonUpgradeSuccess | null {
  const match = body.match(/<!-- agent-loop:upgrade-success (\{.*\}) -->/)
  if (!match?.[1]) return null

  try {
    const parsed = JSON.parse(match[1]) as Partial<ManagedDaemonUpgradeSuccess>
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.repo !== 'string' || typeof parsed.machineId !== 'string' || typeof parsed.daemonInstanceId !== 'string') return null
    if (typeof parsed.succeededAt !== 'string' || typeof parsed.acknowledgedAt !== 'string') return null

    return {
      repo: parsed.repo,
      machineId: parsed.machineId,
      daemonInstanceId: parsed.daemonInstanceId,
      channel: typeof parsed.channel === 'string' && parsed.channel.trim().length > 0 ? parsed.channel : null,
      targetVersion: typeof parsed.targetVersion === 'string' && parsed.targetVersion.trim().length > 0 ? parsed.targetVersion : null,
      targetRevision: typeof parsed.targetRevision === 'string' && parsed.targetRevision.trim().length > 0 ? parsed.targetRevision : null,
      succeededAt: parsed.succeededAt,
      acknowledgedAt: parsed.acknowledgedAt,
    }
  } catch {
    return null
  }
}

export function parseManagedDaemonPresenceComments(
  comments: IssueComment[],
): ManagedDaemonPresenceComment[] {
  return comments
    .map((comment) => {
      const presence = extractManagedDaemonPresenceComment(comment.body)
      if (!presence) return null
      return {
        ...comment,
        presence,
      } satisfies ManagedDaemonPresenceComment
    })
    .filter((comment): comment is ManagedDaemonPresenceComment => comment !== null)
}

export function parseManagedDaemonUpgradeAnnouncementComments(
  comments: IssueComment[],
): ManagedDaemonUpgradeAnnouncementComment[] {
  return comments
    .map((comment) => {
      const announcement = extractManagedDaemonUpgradeAnnouncementComment(comment.body)
      if (!announcement) return null

      return {
        ...comment,
        announcement,
      } satisfies ManagedDaemonUpgradeAnnouncementComment
    })
    .filter((comment): comment is ManagedDaemonUpgradeAnnouncementComment => comment !== null)
}

export function parseManagedDaemonUpgradeFailureAlertComments(
  comments: IssueComment[],
): ManagedDaemonUpgradeFailureAlertComment[] {
  return comments
    .map((comment) => {
      const alert = extractManagedDaemonUpgradeFailureAlertComment(comment.body)
      if (!alert) return null

      return {
        ...comment,
        alert,
      } satisfies ManagedDaemonUpgradeFailureAlertComment
    })
    .filter((comment): comment is ManagedDaemonUpgradeFailureAlertComment => comment !== null)
}

export function parseManagedDaemonUpgradeSuccessComments(
  comments: IssueComment[],
): ManagedDaemonUpgradeSuccessComment[] {
  return comments
    .map((comment) => {
      const success = extractManagedDaemonUpgradeSuccessComment(comment.body)
      if (!success) return null

      return {
        ...comment,
        success,
      } satisfies ManagedDaemonUpgradeSuccessComment
    })
    .filter((comment): comment is ManagedDaemonUpgradeSuccessComment => comment !== null)
}

export function getLatestManagedDaemonUpgradeAnnouncement(
  comments: IssueComment[],
  repo: string,
): ManagedDaemonUpgradeAnnouncementComment | null {
  return parseManagedDaemonUpgradeAnnouncementComments(comments)
    .filter((comment) => comment.announcement.repo === repo)
    .sort((left, right) => {
      const announcedDiff = Date.parse(right.announcement.announcedAt) - Date.parse(left.announcement.announcedAt)
      if (announcedDiff !== 0) return announcedDiff
      return right.commentId - left.commentId
    })[0] ?? null
}

export function getLatestManagedDaemonUpgradeFailureAlert(
  comments: IssueComment[],
  repo: string,
  machineId: string,
): ManagedDaemonUpgradeFailureAlertComment | null {
  return parseManagedDaemonUpgradeFailureAlertComments(comments)
    .filter((comment) => comment.alert.repo === repo && comment.alert.machineId === machineId)
    .sort((left, right) => {
      const alertedDiff = Date.parse(right.alert.alertedAt) - Date.parse(left.alert.alertedAt)
      if (alertedDiff !== 0) return alertedDiff
      return right.commentId - left.commentId
    })[0] ?? null
}

export function getLatestManagedDaemonUpgradeSuccess(
  comments: IssueComment[],
  repo: string,
  machineId: string,
): ManagedDaemonUpgradeSuccessComment | null {
  return parseManagedDaemonUpgradeSuccessComments(comments)
    .filter((comment) => comment.success.repo === repo && comment.success.machineId === machineId)
    .sort((left, right) => {
      const ackDiff = Date.parse(right.success.acknowledgedAt) - Date.parse(left.success.acknowledgedAt)
      if (ackDiff !== 0) return ackDiff
      return right.commentId - left.commentId
    })[0] ?? null
}

export function listActiveManagedDaemonUpgradeFailureAlertComments(
  comments: IssueComment[],
  repo: string,
  now = Date.now(),
): ManagedDaemonUpgradeFailureAlertComment[] {
  const deduped = new Map<string, ManagedDaemonUpgradeFailureAlertComment>()
  const matches = parseManagedDaemonUpgradeFailureAlertComments(comments)
    .filter((comment) => comment.alert.repo === repo)
    .filter((comment) => {
      const pausedUntil = Date.parse(comment.alert.pausedUntil ?? '')
      return Number.isFinite(pausedUntil) && pausedUntil > now
    })
    .sort((left, right) => {
      const alertedDiff = Date.parse(right.alert.alertedAt) - Date.parse(left.alert.alertedAt)
      if (alertedDiff !== 0) return alertedDiff
      return right.commentId - left.commentId
    })

  for (const comment of matches) {
    if (!deduped.has(comment.alert.machineId)) {
      deduped.set(comment.alert.machineId, comment)
    }
  }

  return [...deduped.values()]
}

export function listRecentManagedDaemonUpgradeAnnouncementComments(
  comments: IssueComment[],
  repo: string,
  now = Date.now(),
  lookbackMs = 60 * 60 * 1000,
): ManagedDaemonUpgradeAnnouncementComment[] {
  const earliest = now - Math.max(0, Math.floor(lookbackMs))
  return parseManagedDaemonUpgradeAnnouncementComments(comments)
    .filter((comment) => comment.announcement.repo === repo)
    .filter((comment) => {
      const announcedAt = Date.parse(comment.announcement.announcedAt)
      return Number.isFinite(announcedAt) && announcedAt >= earliest && announcedAt <= now
    })
    .sort((left, right) => {
      const announcedDiff = Date.parse(right.announcement.announcedAt) - Date.parse(left.announcement.announcedAt)
      if (announcedDiff !== 0) return announcedDiff
      return right.commentId - left.commentId
    })
}

export function listRecentManagedDaemonUpgradeFailureAlertComments(
  comments: IssueComment[],
  repo: string,
  now = Date.now(),
  lookbackMs = 60 * 60 * 1000,
): ManagedDaemonUpgradeFailureAlertComment[] {
  const earliest = now - Math.max(0, Math.floor(lookbackMs))
  return parseManagedDaemonUpgradeFailureAlertComments(comments)
    .filter((comment) => comment.alert.repo === repo)
    .filter((comment) => {
      const alertedAt = Date.parse(comment.alert.alertedAt)
      return Number.isFinite(alertedAt) && alertedAt >= earliest && alertedAt <= now
    })
    .sort((left, right) => {
      const alertedDiff = Date.parse(right.alert.alertedAt) - Date.parse(left.alert.alertedAt)
      if (alertedDiff !== 0) return alertedDiff
      return right.commentId - left.commentId
    })
}

export function listRecentManagedDaemonUpgradeSuccessComments(
  comments: IssueComment[],
  repo: string,
  now = Date.now(),
  lookbackMs = 30 * 60 * 1000,
): ManagedDaemonUpgradeSuccessComment[] {
  const deduped = new Map<string, ManagedDaemonUpgradeSuccessComment>()
  const earliest = now - Math.max(0, Math.floor(lookbackMs))
  const matches = parseManagedDaemonUpgradeSuccessComments(comments)
    .filter((comment) => comment.success.repo === repo)
    .filter((comment) => {
      const acknowledgedAt = Date.parse(comment.success.acknowledgedAt)
      return Number.isFinite(acknowledgedAt) && acknowledgedAt >= earliest && acknowledgedAt <= now
    })
    .sort((left, right) => {
      const ackDiff = Date.parse(right.success.acknowledgedAt) - Date.parse(left.success.acknowledgedAt)
      if (ackDiff !== 0) return ackDiff
      return right.commentId - left.commentId
    })

  for (const comment of matches) {
    if (!deduped.has(comment.success.machineId)) {
      deduped.set(comment.success.machineId, comment)
    }
  }

  return [...deduped.values()]
}

export function isManagedDaemonPresenceExpired(
  presence: ManagedDaemonPresence,
  now = Date.now(),
): boolean {
  const expiresAt = Date.parse(presence.expiresAt)
  if (!Number.isFinite(expiresAt)) return true
  return expiresAt <= now
}

export function listActiveManagedDaemonPresenceComments(
  comments: IssueComment[],
  repo: string,
  now = Date.now(),
): ManagedDaemonPresenceComment[] {
  const deduped = new Map<string, ManagedDaemonPresenceComment>()
  const matches = parseManagedDaemonPresenceComments(comments)
    .filter((comment) => comment.presence.repo === repo)
    .filter((comment) => comment.presence.status !== 'stopped')
    .filter((comment) => !isManagedDaemonPresenceExpired(comment.presence, now))
    .sort((left, right) => {
      const updatedDelta = Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      if (Number.isFinite(updatedDelta) && updatedDelta !== 0) return updatedDelta
      return right.commentId - left.commentId
    })

  for (const comment of matches) {
    if (!deduped.has(comment.presence.machineId)) {
      deduped.set(comment.presence.machineId, comment)
    }
  }

  return [...deduped.values()]
}

export function getLatestManagedDaemonPresenceComment(
  comments: IssueComment[],
  repo: string,
  machineId: string,
): ManagedDaemonPresenceComment | null {
  return parseManagedDaemonPresenceComments(comments)
    .filter((comment) => comment.presence.repo === repo && comment.presence.machineId === machineId)
    .sort((left, right) => {
      const updatedDelta = Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      if (Number.isFinite(updatedDelta) && updatedDelta !== 0) return updatedDelta
      return right.commentId - left.commentId
    })[0] ?? null
}

export async function findManagedDaemonPresenceIssue(
  config: AgentConfig,
): Promise<number | null> {
  for (let page = 1; ; page += 1) {
    const stdout = await runGitHubRestRequest(
      `repos/${config.repo}/issues?state=open&per_page=100&page=${page}`,
      config,
    )
    const issues = JSON.parse(stdout) as RawIssueListItem[]
    const match = extractManagedDaemonPresenceIssueNumber(issues)
    if (match !== null) return match

    if (issues.length < 100) {
      return null
    }
  }
}

async function createManagedDaemonPresenceIssue(
  config: AgentConfig,
): Promise<number> {
  const stdout = await runGitHubRestRequest(
    `repos/${config.repo}/issues`,
    config,
    {
      method: 'POST',
      body: {
      title: MANAGED_DAEMON_PRESENCE_ISSUE_TITLE,
      body: buildManagedDaemonPresenceRegistryBody(config.repo),
    },
    },
  )
  const issue = JSON.parse(stdout) as RawIssueRecord
  if (typeof issue.number !== 'number') {
    throw new Error('Presence issue create response did not include an issue number')
  }

  return issue.number
}

export async function ensureManagedDaemonPresenceIssue(
  config: AgentConfig,
): Promise<number> {
  const existing = await findManagedDaemonPresenceIssue(config)
  if (existing !== null) return existing
  return createManagedDaemonPresenceIssue(config)
}

export async function updateIssueComment(
  commentId: number,
  body: string,
  config: AgentConfig,
): Promise<IssueComment> {
  const stdout = await runGitHubRestRequest(
    `repos/${config.repo}/issues/comments/${commentId}`,
    config,
    {
      method: 'PATCH',
      body: { body },
    },
  )

  const comment = JSON.parse(stdout) as RawIssueCommentRecord
  return mapIssueCommentRecord(comment, { commentId, body })
}

export async function listIssueComments(
  issueNumber: number,
  config: AgentConfig,
): Promise<IssueComment[]> {
  if (!config.pat) {
    const response = await runGhCommand([
      'api',
      `repos/${config.repo}/issues/${issueNumber}/comments`,
      '--paginate',
    ], config)
    if (response.exitCode !== 0) {
      throw new Error(`gh api repos/${config.repo}/issues/${issueNumber}/comments failed (exit ${response.exitCode}): ${response.stderr}`)
    }
    const comments = JSON.parse(response.stdout) as RawIssueCommentRecord[]
    return comments.map((comment) => mapIssueCommentRecord(comment))
  }

  const comments: IssueComment[] = []
  for (let page = 1; ; page += 1) {
    const stdout = await runGitHubRestRequest(
      `repos/${config.repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      config,
    )
    const batch = JSON.parse(stdout) as RawIssueCommentRecord[]
    comments.push(...batch.map((comment) => mapIssueCommentRecord(comment)))
    if (batch.length < 100) {
      return comments
    }
  }
}

export async function commentOnIssue(
  issueNumber: number,
  body: string,
  config: AgentConfig,
): Promise<IssueComment> {
  const stdout = await runGitHubRestRequest(
    `repos/${config.repo}/issues/${issueNumber}/comments`,
    config,
    {
      method: 'POST',
      body: { body },
    },
  )
  const comment = JSON.parse(stdout) as RawIssueCommentRecord
  return mapIssueCommentRecord(comment, { body })
}

const defaultPresenceApi: PresenceApiAdapter = {
  ensurePresenceIssue: ensureManagedDaemonPresenceIssue,
  listIssueComments,
  commentOnIssue,
  updateIssueComment,
}

export async function listActiveManagedDaemonPresence(
  config: AgentConfig,
  now = Date.now(),
  api: PresenceApiAdapter = defaultPresenceApi,
): Promise<ManagedDaemonPresenceComment[]> {
  const issueNumber = await findManagedDaemonPresenceIssue(config)
  if (issueNumber === null) return []
  const comments = await api.listIssueComments(issueNumber, config)
  return listActiveManagedDaemonPresenceComments(comments, config.repo, now)
}

export async function listActiveManagedDaemonUpgradeFailureAlerts(
  config: AgentConfig,
  now = Date.now(),
  api: PresenceApiAdapter = defaultPresenceApi,
): Promise<ManagedDaemonUpgradeFailureAlertComment[]> {
  const issueNumber = await findManagedDaemonPresenceIssue(config)
  if (issueNumber === null) return []
  const comments = await api.listIssueComments(issueNumber, config)
  return listActiveManagedDaemonUpgradeFailureAlertComments(comments, config.repo, now)
}

export async function listRecentManagedDaemonUpgradeAnnouncements(
  config: AgentConfig,
  now = Date.now(),
  lookbackMs = 60 * 60 * 1000,
  api: PresenceApiAdapter = defaultPresenceApi,
): Promise<ManagedDaemonUpgradeAnnouncementComment[]> {
  const issueNumber = await findManagedDaemonPresenceIssue(config)
  if (issueNumber === null) return []
  const comments = await api.listIssueComments(issueNumber, config)
  return listRecentManagedDaemonUpgradeAnnouncementComments(comments, config.repo, now, lookbackMs)
}

export async function listRecentManagedDaemonUpgradeFailureAlerts(
  config: AgentConfig,
  now = Date.now(),
  lookbackMs = 60 * 60 * 1000,
  api: PresenceApiAdapter = defaultPresenceApi,
): Promise<ManagedDaemonUpgradeFailureAlertComment[]> {
  const issueNumber = await findManagedDaemonPresenceIssue(config)
  if (issueNumber === null) return []
  const comments = await api.listIssueComments(issueNumber, config)
  return listRecentManagedDaemonUpgradeFailureAlertComments(comments, config.repo, now, lookbackMs)
}

export async function listRecentManagedDaemonUpgradeSuccesses(
  config: AgentConfig,
  now = Date.now(),
  lookbackMs = 30 * 60 * 1000,
  api: PresenceApiAdapter = defaultPresenceApi,
): Promise<ManagedDaemonUpgradeSuccessComment[]> {
  const issueNumber = await findManagedDaemonPresenceIssue(config)
  if (issueNumber === null) return []
  const comments = await api.listIssueComments(issueNumber, config)
  return listRecentManagedDaemonUpgradeSuccessComments(comments, config.repo, now, lookbackMs)
}

export class ManagedDaemonPresencePublisher {
  private readonly startedAt = new Date().toISOString()
  private readonly heartbeatIntervalMs: number
  private readonly ttlMs: number
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private issueNumber: number | null = null
  private commentId: number | null = null

  constructor(private readonly input: {
    config: AgentConfig
    daemonInstanceId: string
    healthPort: number
    metricsPort: number
    readRuntimeState: () => ManagedDaemonPresenceRuntimeState
    api?: PresenceApiAdapter
    logger?: Pick<Console, 'warn'>
  }) {
    this.heartbeatIntervalMs = input.config.recovery.heartbeatIntervalMs
    this.ttlMs = Math.max(
      input.config.recovery.leaseTtlMs,
      input.config.recovery.heartbeatIntervalMs * 2,
    )
  }

  async start(): Promise<void> {
    if (this.heartbeatTimer !== null) return
    await this.flushHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      void this.flushHeartbeat().catch((error) => {
        this.input.logger?.warn?.(`[presence] heartbeat update failed: ${formatPresenceError(error)}`)
      })
    }, this.heartbeatIntervalMs)
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    await this.flushHeartbeat('stopped')
  }

  async flushHeartbeat(statusOverride?: ManagedDaemonPresenceStatus): Promise<void> {
    const api = this.input.api ?? defaultPresenceApi
    const issueNumber = this.issueNumber ?? await api.ensurePresenceIssue(this.input.config)
    this.issueNumber = issueNumber

    if (this.commentId === null) {
      const existing = getLatestManagedDaemonPresenceComment(
        await api.listIssueComments(issueNumber, this.input.config),
        this.input.config.repo,
        this.input.config.machineId,
      )
      this.commentId = existing?.commentId ?? null
    }

    const body = buildManagedDaemonPresenceComment(this.buildPresence(statusOverride))
    if (this.commentId === null) {
      const created = await api.commentOnIssue(issueNumber, body, this.input.config)
      this.commentId = created.commentId
      return
    }

    try {
      await api.updateIssueComment(this.commentId, body, this.input.config)
    } catch {
      const created = await api.commentOnIssue(issueNumber, body, this.input.config)
      this.commentId = created.commentId
    }
  }

  private buildPresence(statusOverride?: ManagedDaemonPresenceStatus): ManagedDaemonPresence {
    const now = Date.now()
    const runtime = this.input.readRuntimeState()
    const lastHeartbeatAt = new Date(now).toISOString()
    const expiresAt = new Date(statusOverride === 'stopped' ? now : now + this.ttlMs).toISOString()

    return {
      repo: this.input.config.repo,
      machineId: this.input.config.machineId,
      daemonInstanceId: this.input.daemonInstanceId,
      status: statusOverride ?? this.resolveStatus(runtime),
      startedAt: this.startedAt,
      lastHeartbeatAt,
      expiresAt,
      healthPort: this.input.healthPort,
      metricsPort: this.input.metricsPort,
      activeLeaseCount: runtime.activeLeaseCount,
      activeWorktreeCount: runtime.activeWorktreeCount,
      effectiveActiveTasks: runtime.effectiveActiveTasks,
      agentLoopVersion: runtime.agentLoopVersion,
      agentLoopRevision: runtime.agentLoopRevision,
      upgradeStatus: runtime.upgradeStatus,
      upgradeAutoApplyEnabled: runtime.upgradeAutoApplyEnabled,
      safeToUpgradeNow: runtime.safeToUpgradeNow,
      latestVersion: runtime.latestVersion,
      latestRevision: runtime.latestRevision,
      upgradeCheckedAt: runtime.upgradeCheckedAt,
      upgradeMessage: runtime.upgradeMessage,
      autoUpgrade: runtime.autoUpgrade,
    }
  }

  private resolveStatus(runtime: ManagedDaemonPresenceRuntimeState): ManagedDaemonPresenceStatus {
    if (runtime.effectiveActiveTasks > 0 || runtime.activeLeaseCount > 0 || runtime.activeWorktreeCount > 0) {
      return 'busy'
    }
    return 'idle'
  }
}

function formatPresenceError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
