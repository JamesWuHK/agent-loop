import {
  canDaemonAdoptManagedLease,
  createManagedLeaseComment,
  extractManagedLeaseComment,
  getActiveManagedLease,
  getLatestManagedLease,
  listIssueComments,
  updateManagedLeaseComment,
  type AgentConfig,
  type ManagedLease,
  type ManagedLeaseComment,
  type ManagedLeaseProgressKind,
  type ManagedLeaseScope,
} from '@agent/shared'

export interface LeaseApiAdapter {
  listIssueComments: typeof listIssueComments
  createManagedLeaseComment: typeof createManagedLeaseComment
  updateManagedLeaseComment: typeof updateManagedLeaseComment
}

const defaultLeaseApiAdapter: LeaseApiAdapter = {
  listIssueComments,
  createManagedLeaseComment,
  updateManagedLeaseComment,
}

export interface LeaseAcquireOptions {
  targetNumber: number
  scope: ManagedLeaseScope
  daemonInstanceId: string
  machineId: string
  config: AgentConfig
  logger?: typeof console
  branch?: string
  worktreeId?: string
  phase: string
  issueNumber?: number
  prNumber?: number
  api?: LeaseApiAdapter
}

export type LeaseAcquireResult =
  | { status: 'acquired'; handle: ManagedLeaseHandle; adopted: boolean; priorLease: ManagedLeaseComment | null }
  | { status: 'blocked'; activeLease: ManagedLeaseComment | null }

export class ManagedLeaseHandle {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(
    private readonly targetNumber: number,
    private readonly commentId: number,
    private readonly config: AgentConfig,
    private readonly logger: typeof console,
    private lease: ManagedLease,
    private readonly api: LeaseApiAdapter = defaultLeaseApiAdapter,
  ) {}

  start(): void {
    if (this.heartbeatTimer !== null) return

    this.heartbeatTimer = setInterval(() => {
      void this.flushHeartbeat().catch((error) => {
        this.logger.warn(
          `[lease] heartbeat update failed for ${this.lease.scope} ${this.targetNumber}: ${formatLeaseError(error)}`,
        )
      })
    }, this.config.recovery.heartbeatIntervalMs)
  }

  getSnapshot(): ManagedLease {
    return { ...this.lease }
  }

  getCommentId(): number {
    return this.commentId
  }

  heartbeatAgeSeconds(now = Date.now()): number {
    const lastHeartbeatAt = Date.parse(this.lease.lastHeartbeatAt)
    if (!Number.isFinite(lastHeartbeatAt)) return 0
    return Math.max(0, Math.floor((now - lastHeartbeatAt) / 1000))
  }

  setPhase(phase: string): void {
    this.lease.phase = phase
    this.recordActivity('phase')
  }

  recordActivity(kind: ManagedLeaseProgressKind): void {
    const now = new Date().toISOString()
    this.lease.lastProgressAt = now
    this.lease.lastProgressKind = kind
  }

  async flushHeartbeat(): Promise<void> {
    if (this.closed) return

    const now = new Date().toISOString()
    this.lease.lastHeartbeatAt = now
    this.lease.expiresAt = new Date(Date.now() + this.config.recovery.leaseTtlMs).toISOString()
    const updated = await this.api.updateManagedLeaseComment(this.commentId, this.lease, this.config)
    this.lease = {
      ...this.lease,
      ...(extractManagedLeaseComment(updated.body) ?? this.lease),
    }
  }

  async complete(
    status: 'completed' | 'recoverable' | 'released',
    recoveryReason?: string,
  ): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    const now = new Date().toISOString()
    this.lease = {
      ...this.lease,
      status,
      recoveryReason,
      lastHeartbeatAt: now,
      expiresAt: now,
    }
    await this.api.updateManagedLeaseComment(this.commentId, this.lease, this.config)
  }
}

export async function acquireManagedLease(
  options: LeaseAcquireOptions,
): Promise<LeaseAcquireResult> {
  const api = options.api ?? defaultLeaseApiAdapter
  const logger = options.logger ?? console
  const comments = await api.listIssueComments(options.targetNumber, options.config)
  const activeLease = getActiveManagedLease(comments, options.scope)
  if (!canDaemonAdoptManagedLease(activeLease, options.daemonInstanceId)) {
    return {
      status: 'blocked',
      activeLease,
    }
  }

  if (activeLease?.lease.daemonInstanceId === options.daemonInstanceId) {
    const adoptedHandle = new ManagedLeaseHandle(
      options.targetNumber,
      activeLease.commentId,
      options.config,
      logger,
      {
        ...activeLease.lease,
        phase: options.phase,
        branch: options.branch ?? activeLease.lease.branch,
        worktreeId: options.worktreeId ?? activeLease.lease.worktreeId,
        issueNumber: options.issueNumber ?? activeLease.lease.issueNumber,
        prNumber: options.prNumber ?? activeLease.lease.prNumber,
      },
      api,
    )
    adoptedHandle.start()
    return {
      status: 'acquired',
      handle: adoptedHandle,
      adopted: true,
      priorLease: activeLease,
    }
  }

  const latestLease = getLatestManagedLease(comments, options.scope)
  const startedAt = new Date().toISOString()
  const lease: ManagedLease = {
    leaseId: crypto.randomUUID(),
    scope: options.scope,
    issueNumber: options.issueNumber,
    prNumber: options.prNumber,
    machineId: options.machineId,
    daemonInstanceId: options.daemonInstanceId,
    branch: options.branch,
    worktreeId: options.worktreeId,
    phase: options.phase,
    startedAt,
    lastHeartbeatAt: startedAt,
    expiresAt: new Date(Date.now() + options.config.recovery.leaseTtlMs).toISOString(),
    attempt: (latestLease?.lease.attempt ?? 0) + 1,
    lastProgressAt: startedAt,
    lastProgressKind: 'phase',
    status: 'active',
  }

  const createdComment = await api.createManagedLeaseComment(options.targetNumber, lease, options.config)
  const latestComments = await api.listIssueComments(options.targetNumber, options.config)
  const canonicalLease = getActiveManagedLease(latestComments, options.scope)
  if (canonicalLease && canonicalLease.commentId !== createdComment.commentId) {
    await api.updateManagedLeaseComment(
      createdComment.commentId,
      {
        ...lease,
        status: 'released',
        recoveryReason: `lease-conflict-with-comment-${canonicalLease.commentId}`,
        lastHeartbeatAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
      },
      options.config,
    )

    return {
      status: 'blocked',
      activeLease: canonicalLease,
    }
  }

  const handle = new ManagedLeaseHandle(
    options.targetNumber,
    createdComment.commentId,
    options.config,
    logger,
    lease,
    api,
  )
  handle.start()

  return {
    status: 'acquired',
    handle,
    adopted: latestLease !== null,
    priorLease: latestLease,
  }
}

export async function getLeaseCommentsForScope(
  targetNumber: number,
  scope: ManagedLeaseScope,
  config: AgentConfig,
  api: LeaseApiAdapter = defaultLeaseApiAdapter,
): Promise<ManagedLeaseComment[]> {
  const comments = await api.listIssueComments(targetNumber, config)
  return comments
    .map((comment) => {
      const lease = extractManagedLeaseComment(comment.body)
      if (!lease || lease.scope !== scope) return null
      return {
        ...comment,
        lease,
      } satisfies ManagedLeaseComment
    })
    .filter((comment): comment is ManagedLeaseComment => comment !== null)
}

function formatLeaseError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
