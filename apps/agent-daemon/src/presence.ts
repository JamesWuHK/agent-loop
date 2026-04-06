import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildGhEnv,
  commentOnIssue,
  listIssueComments,
  type AgentConfig,
  type IssueComment,
} from '@agent/shared'

const MANAGED_DAEMON_PRESENCE_ISSUE_TITLE = 'Agent Loop Presence'
const MANAGED_DAEMON_PRESENCE_ISSUE_MARKER = '<!-- agent-loop:presence-registry -->'
const MANAGED_DAEMON_PRESENCE_COMMENT_PREFIX = '<!-- agent-loop:presence '

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
}

export interface ManagedDaemonPresenceComment extends IssueComment {
  presence: ManagedDaemonPresence
}

export interface ManagedDaemonPresenceRuntimeState {
  activeLeaseCount: number
  activeWorktreeCount: number
  effectiveActiveTasks: number
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
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(['gh', ...args], {
    env: buildGhEnv(config),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited

  return { stdout, stderr, exitCode }
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
- Effective tasks: ${presence.effectiveActiveTasks}`
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
    const response = await runGhCommand([
      'api',
      `repos/${config.repo}/issues?state=open&per_page=100&page=${page}`,
    ], config)

    if (response.exitCode !== 0) {
      throw new Error(`gh api repos/${config.repo}/issues failed (exit ${response.exitCode}): ${response.stderr}`)
    }

    const issues = JSON.parse(response.stdout) as RawIssueListItem[]
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
  const response = await withTempJsonFile(
    'agent-loop-presence-issue',
    {
      title: MANAGED_DAEMON_PRESENCE_ISSUE_TITLE,
      body: buildManagedDaemonPresenceRegistryBody(config.repo),
    },
    async (path) => runGhCommand([
      'api',
      `repos/${config.repo}/issues`,
      '-X',
      'POST',
      '--input',
      path,
    ], config),
  )

  if (response.exitCode !== 0) {
    throw new Error(`gh api repos/${config.repo}/issues failed (exit ${response.exitCode}): ${response.stderr}`)
  }

  const issue = JSON.parse(response.stdout) as RawIssueRecord
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
  const response = await withTempJsonFile(
    'agent-loop-issue-comment-update',
    { body },
    async (path) => runGhCommand([
      'api',
      `repos/${config.repo}/issues/comments/${commentId}`,
      '-X',
      'PATCH',
      '--input',
      path,
    ], config),
  )

  if (response.exitCode !== 0) {
    throw new Error(`gh api issues/comments/${commentId} failed (exit ${response.exitCode}): ${response.stderr}`)
  }

  const comment = JSON.parse(response.stdout) as {
    id?: unknown
    body?: unknown
    created_at?: unknown
    updated_at?: unknown
  }

  return {
    commentId: typeof comment.id === 'number' ? comment.id : commentId,
    body: typeof comment.body === 'string' ? comment.body : body,
    createdAt: typeof comment.created_at === 'string' ? comment.created_at : '',
    updatedAt: typeof comment.updated_at === 'string' ? comment.updated_at : '',
  }
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
