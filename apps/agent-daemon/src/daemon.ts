import { $ } from 'bun'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  ActiveLeaseRuntimeDetail,
  AgentConfig,
  AgentIssue,
  BlockedIssueResumeRuntimeDetail,
  DaemonStatus,
  IssueComment,
  ManagedLease,
  ManagedLeaseComment,
  ManagedLeaseScope,
  ManagedPullRequest,
  RecoveryActionRuntimeDetail,
  StalledWorkerRuntimeDetail,
  WorktreeInfo,
} from '@agent/shared'
import { ISSUE_LABELS, PR_REVIEW_LABELS, canDaemonAdoptManagedLease, getActiveManagedLease, getLatestManagedLease, listOpenAgentIssues, listOpenAgentPullRequests, transitionIssueState, commentOnIssue, commentOnPr, setManagedPrReviewLabels, mergePullRequest, checkPrExists, listIssueComments, resolveActiveClaimMachine, getAgentIssueByNumber } from '@agent/shared'
import { pollAndClaim } from './claimer'
import { createWorktree, removeWorktree, cleanupOrphanedWorktrees, hasWorktreeForIssue } from './worktree-manager'
import { runSubtaskExecutor, runReviewAutoFix, runIssueRecovery } from './subtask-executor'
import { createOrFindPr, pushBranch } from './pr-reporter'
import { createDetachedPrWorktree, extractIssueNumberFromPrTitle, reviewPr, buildPrReviewComment, buildReviewFeedback, extractAutomatedReviewReasons, canResumeAutomatedPrReview, getNextAutomatedPrReviewAttempt, getReusableAutomatedPrReviewFeedback, classifyPrReviewOutcome, type PrReviewResult } from './pr-reviewer'
import { acquireManagedLease, type ManagedLeaseHandle } from './lease'
import type { TaskExecutionMonitor } from './cli-agent'
import {
  recordPoll,
  recordPollDuration,
  recordIssueProcessed,
  recordIssueProcessingDuration,
  recordPrReviewOutcome,
  recordReviewAutoFixOutcome,
  recordPrMergeRecoveryOutcome,
  recordPrCreated,
  setActiveWorktrees,
  setActivePrReviews,
  setConcurrencyLimit,
  setConcurrencyPolicy,
  setDaemonUptime,
  setEffectiveActiveTasks,
  setNextPollDelaySeconds,
  setInFlightIssueProcesses,
  setInFlightPrReviews,
  setActiveLeases,
  setLeaseHeartbeatAgeSeconds,
  setProjectInfo,
  recordLeaseConflict,
  recordRecoveryAction,
  recordTransientLoopError,
  recordWorkerIdleTimeout,
  setStalledWorkers,
  setBlockedIssueResumes,
  setBlockedIssueResumeAgeSeconds,
  setBlockedIssueResumeEscalations,
  setBlockedIssueResumeEscalationAgeSeconds,
  setLastTransientLoopErrorAgeSeconds,
  setStartupRecoveryPending,
  startMetricsServer,
  METRICS_PORT_DEFAULT,
  METRICS_PATH,
  type MetricsServer,
} from './metrics'

export interface HealthServerConfig {
  host: string
  port: number
}

export const HEALTH_PATH = '/health'
export const DEFAULT_HEALTH_SERVER_PORT = 9310
export const DEFAULT_HEALTH_SERVER_HOST = '127.0.0.1'
const LOCAL_METRICS_HOST = '127.0.0.1'
const RETRYABLE_DAEMON_ERROR_PATTERNS = [
  'timeout',
  'timed out',
  'temporary failure',
  'connection refused',
  'connection reset',
  'network is unreachable',
  'could not resolve host',
  'failed to connect',
  'tls handshake timeout',
  'i/o timeout',
  'context deadline exceeded',
  'econn',
  'enotfound',
  'socket hang up',
  'no route to host',
] as const
const BLOCKED_ISSUE_RESUME_ESCALATION_COOLDOWN_SECONDS = 30 * 60
const BLOCKED_ISSUE_RESUME_ESCALATION_COMMENT_PREFIX = '<!-- agent-loop:issue-resume-blocked '
export const BLOCKED_ISSUE_RESUME_WARNING_AGE_SECONDS = 5 * 60

interface ResumableIssueCandidate {
  issue: AgentIssue
  priorLease: ManagedLeaseComment | null
  requiresRemoteAdoption: boolean
}

interface ResumableIssuePrHandoff {
  kind: 'pr-review' | 'pr-merge'
}

interface ActiveLeaseRuntimeReader {
  scope: ManagedLeaseScope
  targetNumber: number
  commentId: number
  readSnapshot: () => ManagedLease
  readHeartbeatAgeSeconds: () => number
}

interface StalledWorkerState {
  scope: ManagedLeaseScope
  targetNumber: number
  since: string
  reason: string
}

interface BlockedIssueResumeState {
  issueNumber: number
  prNumber: number | null
  since: string
  reason: string
  escalationCount: number
  lastEscalatedAt: string | null
}

export interface BlockedIssueResumeEscalationComment {
  issueNumber: number
  prNumber: number | null
  blockedSince: string
  escalatedAt: string
  thresholdSeconds: number
  reason: string
  machineId: string
  daemonInstanceId: string
}

export interface BlockedIssueResumeEscalationRecord extends IssueComment {
  escalation: BlockedIssueResumeEscalationComment
}

export class AgentDaemon {
  private static readonly MAX_AUTOMATED_PR_REVIEW_ATTEMPTS = 3
  private running = false
  private shutdownRequested = false
  private readonly daemonInstanceId = `${process.pid}-${crypto.randomUUID()}`
  private activeWorktrees = new Map<number, WorktreeInfo>()
  private activeLeaseReaders = new Map<string, ActiveLeaseRuntimeReader>()
  private stalledWorkers = new Map<string, StalledWorkerState>()
  private blockedIssueResumes = new Map<number, BlockedIssueResumeState>()
  private recoveryActionHistory: RecoveryActionRuntimeDetail[] = []
  private lastRecoveryActionAt: string | null = null
  private lastRecoveryActionKind: string | null = null
  private transientLoopErrorCount = 0
  private startupRecoveryDeferredCount = 0
  private lastTransientLoopErrorAt: string | null = null
  private lastTransientLoopErrorKind: 'startup-recovery' | 'poll-cycle' | null = null
  private lastTransientLoopErrorMessage: string | null = null
  private startedAt = Date.now()
  private lastPollAt: string | null = null
  private lastClaimedAt: string | null = null
  private pollTimeoutId: ReturnType<typeof setTimeout> | null = null
  private nextPollAt: string | null = null
  private nextPollReason: string | null = null
  private nextPollDelayMs: number | null = null
  private healthServer: ReturnType<typeof Bun.serve> | null = null
  private healthServerConfig: HealthServerConfig = {
    host: DEFAULT_HEALTH_SERVER_HOST,
    port: DEFAULT_HEALTH_SERVER_PORT,
  }
  private metricsServer: MetricsServer | null = null
  private metricsPort: number
  private _inFlightProcess: Promise<void> | null = null
  private _inFlightPrReview: Promise<void> | null = null
  private activePrReviews = new Set<number>()
  private static readonly MAX_REVIEW_FIX_RETRIES = 1
  private static readonly MAX_FAILED_ISSUE_RESUMES = 2
  private static readonly FAILED_ISSUE_RESUME_COOLDOWN_MS = 5 * 60 * 1000
  private failedIssueResumeAttempts = new Map<number, number>()
  private failedIssueResumeCooldownUntil = new Map<number, number>()
  private startupRecoveryPending = true

  constructor(
    private config: AgentConfig,
    private logger = console,
    healthServerConfig?: Partial<HealthServerConfig>,
    metricsPort?: number,
  ) {
    if (healthServerConfig) {
      this.healthServerConfig = { ...this.healthServerConfig, ...healthServerConfig }
    }
    this.metricsPort = metricsPort ?? 9090
  }

  private buildLeaseKey(scope: ManagedLeaseScope, targetNumber: number): string {
    return `${scope}:${targetNumber}`
  }

  private buildManagedLeaseMonitor(
    scope: ManagedLeaseScope,
    targetNumber: number,
    handle: ManagedLeaseHandle,
  ): TaskExecutionMonitor {
    return {
      setPhase: (phase) => {
        handle.setPhase(phase)
        this.clearStalledWorker(scope, targetNumber)
      },
      agentMonitor: {
        heartbeatIntervalMs: this.config.recovery.heartbeatIntervalMs,
        idleTimeoutMs: this.config.recovery.workerIdleTimeoutMs,
        onActivity: (kind) => {
          handle.recordActivity(kind)
          this.clearStalledWorker(scope, targetNumber)
        },
      },
    }
  }

  private registerActiveLease(
    scope: ManagedLeaseScope,
    targetNumber: number,
    handle: ManagedLeaseHandle,
  ): void {
    this.activeLeaseReaders.set(this.buildLeaseKey(scope, targetNumber), {
      scope,
      targetNumber,
      commentId: handle.getCommentId(),
      readSnapshot: () => handle.getSnapshot(),
      readHeartbeatAgeSeconds: () => handle.heartbeatAgeSeconds(),
    })
    this.clearStalledWorker(scope, targetNumber)
    this.syncRuntimeMetrics()
  }

  private unregisterActiveLease(scope: ManagedLeaseScope, targetNumber: number): void {
    this.activeLeaseReaders.delete(this.buildLeaseKey(scope, targetNumber))
    this.syncRuntimeMetrics()
  }

  private clearStalledWorker(scope: ManagedLeaseScope, targetNumber: number): void {
    const deleted = this.stalledWorkers.delete(this.buildLeaseKey(scope, targetNumber))
    if (deleted) {
      this.syncRuntimeMetrics()
    }
  }

  private markStalledWorker(
    scope: ManagedLeaseScope,
    targetNumber: number,
    reason: string,
    recoveryKind: string,
  ): void {
    const now = new Date().toISOString()
    this.stalledWorkers.set(this.buildLeaseKey(scope, targetNumber), {
      scope,
      targetNumber,
      since: now,
      reason,
    })
    this.lastRecoveryActionAt = now
    this.lastRecoveryActionKind = recoveryKind
    this.syncRuntimeMetrics()
  }

  private noteBlockedIssueResume(
    issueNumber: number,
    prNumber: number | null,
    reason: string,
  ): void {
    const existing = this.blockedIssueResumes.get(issueNumber)
    if (existing && existing.prNumber === prNumber && existing.reason === reason) {
      return
    }

    const since = new Date().toISOString()
    this.blockedIssueResumes.set(issueNumber, {
      issueNumber,
      prNumber,
      since,
      reason,
      escalationCount: 0,
      lastEscalatedAt: null,
    })
    this.noteRecoveryAction('issue-resume-blocked', 'blocked', {
      scope: 'issue-process',
      targetNumber: issueNumber,
      reason,
    })
  }

  private clearBlockedIssueResume(issueNumber: number): void {
    if (this.blockedIssueResumes.delete(issueNumber)) {
      this.syncRuntimeMetrics()
    }
  }

  private reconcileBlockedIssueResumes(issueNumbers: Set<number>): void {
    let changed = false
    for (const issueNumber of this.blockedIssueResumes.keys()) {
      if (issueNumbers.has(issueNumber)) continue
      this.blockedIssueResumes.delete(issueNumber)
      changed = true
    }

    if (changed) {
      this.syncRuntimeMetrics()
    }
  }

  private noteRecoveryAction(
    kind: string,
    outcome: 'recoverable' | 'completed' | 'blocked' | 'failed',
    details: {
      scope?: ManagedLeaseScope
      targetNumber?: number
      reason?: string
    } = {},
  ): void {
    const at = new Date().toISOString()
    this.lastRecoveryActionAt = at
    this.lastRecoveryActionKind = kind
    this.recoveryActionHistory.unshift({
      at,
      kind,
      outcome,
      scope: details.scope ?? null,
      targetNumber: details.targetNumber ?? null,
      reason: details.reason ?? null,
    })
    if (this.recoveryActionHistory.length > 10) {
      this.recoveryActionHistory.length = 10
    }
    recordRecoveryAction(kind, outcome)
    this.syncRuntimeMetrics()
  }

  private noteTransientLoopError(
    kind: 'startup-recovery' | 'poll-cycle',
    error: unknown,
  ): void {
    this.transientLoopErrorCount += 1
    if (kind === 'startup-recovery') {
      this.startupRecoveryDeferredCount += 1
    }
    this.lastTransientLoopErrorAt = new Date().toISOString()
    this.lastTransientLoopErrorKind = kind
    this.lastTransientLoopErrorMessage = formatDaemonError(error)
    recordTransientLoopError(kind)
    this.syncRuntimeMetrics()
  }

  private refreshObservability(): void {
    this.nextPollDelayMs = this.readNextPollDelayMs()
    this.syncRuntimeMetrics()
    setDaemonUptime((Date.now() - this.startedAt) / 1000)
  }

  private getTransientRetryDelayMs(): number {
    return Math.max(
      1_000,
      Math.min(this.config.pollIntervalMs, this.config.recovery.leaseAdoptionBackoffMs),
    )
  }

  private async sleepWithLeaseBackoff(): Promise<void> {
    const jitterMs = Math.min(250, Math.max(50, Math.floor(this.config.recovery.leaseAdoptionBackoffMs / 10)))
    const delayMs = this.config.recovery.leaseAdoptionBackoffMs + Math.floor(Math.random() * jitterMs)
    await Bun.sleep(delayMs)
  }

  private async completeManagedLease(
    scope: ManagedLeaseScope,
    targetNumber: number,
    handle: ManagedLeaseHandle,
    status: 'completed' | 'recoverable' | 'released',
    recoveryReason?: string,
    recoveryKind?: string,
  ): Promise<void> {
    try {
      await handle.complete(status, recoveryReason)
    } finally {
      this.unregisterActiveLease(scope, targetNumber)
      if (status === 'recoverable') {
        if (recoveryKind) {
          if (recoveryKind.includes('idle-timeout')) {
            this.markStalledWorker(scope, targetNumber, recoveryReason ?? 'recoverable worker interruption', recoveryKind)
          } else {
            this.clearStalledWorker(scope, targetNumber)
          }
          this.noteRecoveryAction(recoveryKind, 'recoverable', {
            scope,
            targetNumber,
            reason: recoveryReason,
          })
        }
      } else {
        this.clearStalledWorker(scope, targetNumber)
        if (recoveryKind) {
          this.noteRecoveryAction(recoveryKind, 'completed', {
            scope,
            targetNumber,
            reason: recoveryReason,
          })
        }
      }
    }
  }

  private async acquireLeaseForScope(options: {
    targetNumber: number
    scope: ManagedLeaseScope
    branch?: string
    worktreeId?: string
    phase: string
    issueNumber?: number
    prNumber?: number
  }): Promise<{ handle: ManagedLeaseHandle; adopted: boolean; priorLease: ManagedLeaseComment | null } | null> {
    const acquired = await acquireManagedLease({
      targetNumber: options.targetNumber,
      scope: options.scope,
      daemonInstanceId: this.daemonInstanceId,
      machineId: this.config.machineId,
      config: this.config,
      logger: this.logger,
      branch: options.branch,
      worktreeId: options.worktreeId,
      phase: options.phase,
      issueNumber: options.issueNumber,
      prNumber: options.prNumber,
    })

    if (acquired.status === 'blocked') {
      this.logger.log(
        `[lease] skipping ${options.scope} ${options.targetNumber}; active lease is held by ${acquired.activeLease?.lease.daemonInstanceId ?? 'unknown daemon'}`,
      )
      recordLeaseConflict(options.scope)
      this.noteRecoveryAction(`${options.scope}-lease-conflict`, 'blocked', {
        scope: options.scope,
        targetNumber: options.targetNumber,
        reason: acquired.activeLease
          ? `held by ${acquired.activeLease.lease.daemonInstanceId}`
          : 'active lease exists',
      })
      await this.sleepWithLeaseBackoff()
      return null
    }

    this.registerActiveLease(options.scope, options.targetNumber, acquired.handle)
    return acquired
  }

  private isRecoverableAgentFailureKind(
    failureKind: string | undefined,
  ): boolean {
    return failureKind === 'idle_timeout'
  }

  private async markIssueRecoverable(issueNumber: number, reason: string): Promise<void> {
    await transitionIssueState(
      issueNumber,
      ISSUE_LABELS.WORKING,
      ISSUE_LABELS.WORKING,
      {
        event: 'claimed',
        machine: this.config.machineId,
        ts: new Date().toISOString(),
        reason: `recoverable:${reason}`,
      },
      this.config,
    )
  }

  async start(): Promise<void> {
    this.logger.log(`[daemon] starting agent-loop v0.1.0`)
    this.logger.log(`[daemon] machineId: ${this.config.machineId}`)
    this.logger.log(`[daemon] repo: ${this.config.repo}`)
    this.logger.log(
      `[daemon] concurrency: effective=${this.config.concurrency} requested=${this.config.requestedConcurrency} repoCap=${this.config.concurrencyPolicy.repoCap ?? 'none'} profileCap=${this.config.concurrencyPolicy.profileCap ?? 'none'} projectCap=${this.config.concurrencyPolicy.projectCap ?? 'none'}`,
    )
    this.logger.log(`[daemon] poll interval: ${this.config.pollIntervalMs}ms`)

    // Set initial metrics
    setConcurrencyLimit(this.config.concurrency)
    setConcurrencyPolicy(this.config.concurrencyPolicy)
    setActiveWorktrees(0)
    setProjectInfo({
      repo: this.config.repo,
      profile: this.config.project.profile,
      primaryAgent: this.config.agent.primary,
      fallbackAgent: this.config.agent.fallback,
      defaultBranch: this.config.git.defaultBranch,
      machineId: this.config.machineId,
    })
    this.syncRuntimeMetrics()

    // Start metrics server
    this.metricsServer = await startMetricsServer(this.metricsPort, this.logger, () => {
      this.refreshObservability()
    })

    // Start HTTP health check server
    this.startHealthServer()

    this.running = true
    this.syncRuntimeMetrics()

    // Run first recovery + poll immediately; subsequent polls are self-scheduled
    await this.runPollCycleSafely()
  }

  /**
   * Recover zombie issues: if an issue is working/claimed but the local worktree
   * is gone (crash, manual cleanup, etc.), mark it stale so it can be retried.
   * Local worktree presence is the source of truth for machine ownership.
   */
  private async reconcileIssueStates(): Promise<void> {
    const issues = await listOpenAgentIssues(this.config)

    for (const issue of issues) {
      // Only act on working/claimed issues from this machine
      if (issue.state !== 'working' && issue.state !== 'claimed') continue
      const activeClaimMachine = await this.getActiveClaimMachine(issue.number)
      if (activeClaimMachine && activeClaimMachine !== this.config.machineId) {
        this.logger.log(`[daemon] skipping zombie reconcile for #${issue.number}; active machine is ${activeClaimMachine}`)
        continue
      }

      if (!hasWorktreeForIssue(issue.number, this.config)) {
        this.logger.log(`[daemon] zombie issue #${issue.number} (${issue.state}) has no local worktree, marking stale`)
        await transitionIssueState(
          issue.number,
          ISSUE_LABELS.STALE,
          issue.state === 'working' ? ISSUE_LABELS.WORKING : ISSUE_LABELS.CLAIMED,
          {
            event: 'stale',
            machine: this.config.machineId,
            ts: new Date().toISOString(),
            reason: 'startup-reconcile-missing-worktree',
          },
          this.config,
        )
      }
    }
  }

  private async reconcileStandalonePrIssueStates(): Promise<void> {
    const [issues, prs] = await Promise.all([
      listOpenAgentIssues(this.config),
      listOpenAgentPullRequests(this.config),
    ])
    const issueMap = new Map(issues.map((issue) => [issue.number, issue]))

    for (const pr of prs) {
      const issueNumber = extractIssueNumberFromPrTitle(pr.title)
      if (issueNumber === null) continue

      const issue = issueMap.get(issueNumber) ?? await getAgentIssueByNumber(issueNumber, this.config)
      const transition = getStandaloneIssueTransitionForReviewLabels(pr.labels, issue)
      if (!transition) continue

      await this.transitionStandaloneIssue(
        issueNumber,
        transition.nextLabel,
        `Recovered PR #${pr.number} ${transition.reasonSuffix}`,
        pr.number,
      )
    }
  }

  private startHealthServer(): void {
    const { host, port } = this.healthServerConfig

    this.healthServer = Bun.serve({
      hostname: host,
      port,
      fetch: (request) => {
        const url = new URL(request.url)

        if (request.method === 'GET' && url.pathname === HEALTH_PATH) {
          this.refreshObservability()
          return Response.json({
            status: this.running ? 'running' : 'stopped',
            mode: 'agent-loop-daemon',
            version: '0.1.0',
            ...this.getStatus(),
          })
        }

        return new Response('Not Found', { status: 404 })
      },
    })

    this.logger.log(`[daemon] health server listening on http://${host}:${port} (pid: ${process.pid})`)
  }

  async stop(): Promise<void> {
    this.logger.log(`[daemon] shutting down...`)
    this.shutdownRequested = true

    if (this.pollTimeoutId !== null) {
      clearTimeout(this.pollTimeoutId)
      this.pollTimeoutId = null
    }
    this.nextPollAt = null
    this.nextPollReason = null
    this.nextPollDelayMs = null

    // Stop health server
    if (this.healthServer) {
      this.healthServer.stop(true)
      this.healthServer = null
    }

    // Stop metrics server
    if (this.metricsServer) {
      this.metricsServer.stop()
      this.metricsServer = null
    }

    // Mark all active worktrees as stale
    for (const [issueNumber] of this.activeWorktrees) {
      try {
        await transitionIssueState(
          issueNumber,
          ISSUE_LABELS.STALE,
          ISSUE_LABELS.WORKING,
          {
            event: 'stale',
            machine: this.config.machineId,
            ts: new Date().toISOString(),
            reason: 'daemon-shutdown',
          },
          this.config,
        )
        this.logger.log(`[daemon] marked issue #${issueNumber} as stale`)
      } catch (err) {
        this.logger.error(`[daemon] failed to mark #${issueNumber} as stale:`, err)
      }
    }

    this.running = false
    this.syncRuntimeMetrics()
    this.logger.log(`[daemon] stopped. Worktrees preserved for debugging.`)
  }

  getStatus(): DaemonStatus {
    const runtime = this.buildRuntimeStatus()
    return {
      running: this.running,
      machineId: this.config.machineId,
      daemonInstanceId: this.daemonInstanceId,
      repo: this.config.repo,
      pollIntervalMs: this.config.pollIntervalMs,
      concurrency: this.config.concurrency,
      requestedConcurrency: this.config.requestedConcurrency,
      concurrencyPolicy: this.config.concurrencyPolicy,
      recovery: this.config.recovery,
      project: {
        profile: this.config.project.profile,
        defaultBranch: this.config.git.defaultBranch,
        maxConcurrency: this.config.project.maxConcurrency ?? null,
      },
      agent: {
        primary: this.config.agent.primary,
        fallback: this.config.agent.fallback,
      },
      endpoints: {
        health: {
          host: this.healthServerConfig.host,
          port: this.healthServerConfig.port,
          path: HEALTH_PATH,
        },
        metrics: {
          host: LOCAL_METRICS_HOST,
          port: this.metricsPort,
          path: METRICS_PATH,
        },
      },
      runtime,
      activeWorktrees: Array.from(this.activeWorktrees.values()),
      lastPollAt: this.lastPollAt,
      lastClaimedAt: this.lastClaimedAt,
      uptimeMs: Date.now() - this.startedAt,
      pid: process.pid,
      nextPollAt: this.nextPollAt,
      nextPollReason: this.nextPollReason,
      nextPollDelayMs: this.readNextPollDelayMs(),
    }
  }

  /** Wait for any in-flight issue processing to complete (used by --once mode). */
  async waitForInFlightProcess(): Promise<void> {
    if (this._inFlightProcess) {
      await this._inFlightProcess
      this._inFlightProcess = null
      this.syncRuntimeMetrics()
    }
    if (this._inFlightPrReview) {
      await this._inFlightPrReview
      this._inFlightPrReview = null
      this.syncRuntimeMetrics()
    }
  }

  private scheduleNextPoll(options: {
    delayMs?: number
    reason?: string
  } = {}): void {
    if (this.shutdownRequested) return

    if (this.pollTimeoutId !== null) {
      clearTimeout(this.pollTimeoutId)
    }

    const delayMs = Math.max(0, options.delayMs ?? this.config.pollIntervalMs)
    this.nextPollAt = new Date(Date.now() + delayMs).toISOString()
    this.nextPollReason = options.reason ?? 'normal'
    this.nextPollDelayMs = delayMs
    this.syncRuntimeMetrics()

    this.pollTimeoutId = setTimeout(
      () => {
        this.pollTimeoutId = null
        this.nextPollAt = null
        this.nextPollReason = null
        this.nextPollDelayMs = null
        this.syncRuntimeMetrics()
        this.runPollCycleSafely().catch(err => this.logger.error('[daemon] poll wrapper error:', err))
      },
      delayMs,
    )
  }

  private async runPollCycleSafely(): Promise<void> {
    const startedAt = Date.now()

    try {
      const startupResult = await this.runStartupMaintenanceIfNeeded()
      if (startupResult !== 'ready') {
        recordPoll('error')
        recordPollDuration(Date.now() - startedAt)
        if (!this.shutdownRequested && this.running) {
          this.scheduleNextPoll({
            delayMs: startupResult === 'deferred-transient'
              ? this.getTransientRetryDelayMs()
              : this.config.pollIntervalMs,
            reason: startupResult,
          })
        }
        return
      }
      await this.pollCycle()
    } catch (err) {
      const formatted = formatDaemonError(err)
      if (isRetryableDaemonLoopError(err)) {
        this.noteTransientLoopError('poll-cycle', err)
        this.logger.warn(`[daemon] transient loop error; will retry early: ${formatted}`)
      } else {
        this.logger.error(`[daemon] poll cycle failed; will retry on next poll: ${formatted}`)
      }
      recordPoll('error')
      recordPollDuration(Date.now() - startedAt)
      if (!this.shutdownRequested && this.running) {
        this.scheduleNextPoll({
          delayMs: isRetryableDaemonLoopError(err)
            ? this.getTransientRetryDelayMs()
            : this.config.pollIntervalMs,
          reason: isRetryableDaemonLoopError(err)
            ? 'transient-poll-error'
            : 'poll-error',
        })
      }
    }
  }

  private readNextPollDelayMs(now = Date.now()): number | null {
    if (!this.nextPollAt) return null
    const nextPollAt = Date.parse(this.nextPollAt)
    if (!Number.isFinite(nextPollAt)) return null
    return Math.max(0, nextPollAt - now)
  }

  private async runStartupMaintenanceIfNeeded(): Promise<'ready' | 'deferred-transient' | 'deferred-error'> {
    if (!this.startupRecoveryPending) return 'ready'

    try {
      await cleanupOrphanedWorktrees(this.config)
      await this.reconcileIssueStates()
      await this.reconcileStandalonePrIssueStates()
      this.startupRecoveryPending = false
      this.syncRuntimeMetrics()
      this.logger.log('[daemon] startup recovery complete')
      return 'ready'
    } catch (err) {
      this.startupRecoveryPending = true
      this.syncRuntimeMetrics()
      const formatted = formatDaemonError(err)
      if (isRetryableDaemonLoopError(err)) {
        this.noteTransientLoopError('startup-recovery', err)
        this.logger.warn(`[daemon] startup recovery deferred until connectivity recovers: ${formatted}`)
        return 'deferred-transient'
      }

      this.logger.error(`[daemon] startup recovery failed; will retry on next poll: ${formatted}`)
      return 'deferred-error'
    }
  }

  private async pollCycle(): Promise<void> {
    if (this.shutdownRequested || !this.running) return

    const pollStartTime = Date.now()
    this.lastPollAt = new Date().toISOString()
    this.refreshObservability()
    this.logger.log(`[daemon] poll cycle at ${this.lastPollAt}`)

    // Check concurrency limit
    const activeTaskCount = getEffectiveActiveTaskCount({
      activeWorktreeCount: this.activeWorktrees.size,
      hasInFlightProcess: this._inFlightProcess !== null,
      activePrReviewCount: this.activePrReviews.size,
      hasInFlightPrReview: this._inFlightPrReview !== null,
    })
    if (activeTaskCount >= this.config.concurrency) {
      this.logger.log(`[daemon] at concurrency limit (${activeTaskCount}/${this.config.concurrency}), skipping`)
      recordPoll('skipped_concurrency')
      recordPollDuration(Date.now() - pollStartTime)
      this.scheduleNextPoll()
      return
    }

    if (await this.maybeStartStandaloneApprovedPrMerge()) {
      recordPoll('success')
      recordPollDuration(Date.now() - pollStartTime)
      this.scheduleNextPoll()
      return
    }

    if (await this.maybeStartResumableIssue()) {
      recordPoll('success')
      recordPollDuration(Date.now() - pollStartTime)
      this.scheduleNextPoll()
      return
    }

    if (await this.maybeStartStandalonePrReview()) {
      recordPoll('success')
      recordPollDuration(Date.now() - pollStartTime)
      this.scheduleNextPoll()
      return
    }

    if (await this.maybeRequeueFailedIssue()) {
      recordPoll('success')
      recordPollDuration(Date.now() - pollStartTime)
      this.scheduleNextPoll()
      return
    }

    // Claim an issue
    const claimedIssue = await pollAndClaim(this.config, this.logger)

    if (claimedIssue === null) {
      recordPoll('no_issues')
      recordPollDuration(Date.now() - pollStartTime)
      this.scheduleNextPoll()
      return
    }

    recordPoll('success')
    recordPollDuration(Date.now() - pollStartTime)
    this.lastClaimedAt = new Date().toISOString()

    // Process in background (don't block the poll loop)
    const processPromise = this.processIssue(claimedIssue)
      .catch((err) => {
        this.logger.error(`[daemon] processIssue #${claimedIssue.number} threw:`, err)
      })
      .finally(() => {
        if (this._inFlightProcess === processPromise) {
          this._inFlightProcess = null
          this.syncRuntimeMetrics()
        }
      })

    this._inFlightProcess = processPromise
    this.syncRuntimeMetrics()

    this.scheduleNextPoll()
  }

  private async maybeStartStandalonePrReview(): Promise<boolean> {
    if (this._inFlightPrReview) return false

    const pendingPr = await this.findPendingStandalonePrReview()
    if (!pendingPr) return false

    this.activePrReviews.add(pendingPr.number)
    this.syncRuntimeMetrics()
    const reviewPromise = this.processStandalonePrReview(pendingPr)
      .catch((err) => {
        this.logger.error(`[pr-review-subagent] PR #${pendingPr.number} threw:`, err)
      })
      .finally(() => {
        this.activePrReviews.delete(pendingPr.number)
        if (this._inFlightPrReview === reviewPromise) {
          this._inFlightPrReview = null
        }
        this.syncRuntimeMetrics()
      })

    this._inFlightPrReview = reviewPromise
    this.syncRuntimeMetrics()
    return true
  }

  private async maybeStartStandaloneApprovedPrMerge(): Promise<boolean> {
    if (this._inFlightPrReview) return false

    const pendingPr = await this.findPendingStandaloneApprovedPrMerge()
    if (!pendingPr) return false

    this.activePrReviews.add(pendingPr.number)
    this.syncRuntimeMetrics()
    const mergePromise = this.processStandaloneApprovedPrMerge(pendingPr)
      .catch((err) => {
        this.logger.error(`[pr-merge-subagent] PR #${pendingPr.number} threw:`, err)
      })
      .finally(() => {
        this.activePrReviews.delete(pendingPr.number)
        if (this._inFlightPrReview === mergePromise) {
          this._inFlightPrReview = null
        }
        this.syncRuntimeMetrics()
      })

    this._inFlightPrReview = mergePromise
    this.syncRuntimeMetrics()
    return true
  }

  private async maybeStartResumableIssue(): Promise<boolean> {
    if (this._inFlightProcess) return false

    const resumableIssue = await this.findResumableIssue()
    if (!resumableIssue) return false
    if (await this.shouldPreferLinkedPrHandoff(resumableIssue)) return false

    const processPromise = this.processResumableIssue(resumableIssue)
      .catch((err) => {
        this.logger.error(`[daemon] processResumableIssue #${resumableIssue.issue.number} threw:`, err)
      })
      .finally(() => {
        if (this._inFlightProcess === processPromise) {
          this._inFlightProcess = null
          this.syncRuntimeMetrics()
        }
      })

    this._inFlightProcess = processPromise
    this.syncRuntimeMetrics()
    return true
  }

  private async shouldPreferLinkedPrHandoff(
    candidate: ResumableIssueCandidate,
  ): Promise<boolean> {
    const branch = candidate.priorLease?.lease.branch ?? `agent/${candidate.issue.number}/${this.config.machineId}`
    const linkedPr = await this.findLinkedOpenPrForIssue(candidate.issue.number, branch)
    if (!linkedPr) return false

    const labels = new Set(linkedPr.labels)
    const canResumeHumanNeededReview = labels.has(PR_REVIEW_LABELS.HUMAN_NEEDED)
      ? canResumeAutomatedPrReview(
          await listIssueComments(linkedPr.number, this.config),
          AgentDaemon.MAX_AUTOMATED_PR_REVIEW_ATTEMPTS,
        )
      : false
    const hasSyncedBranchState = candidate.requiresRemoteAdoption
      || await isWorktreeSyncedWithRemoteBranch(
        resolve(this.config.worktreesBase, `issue-${candidate.issue.number}-${this.config.machineId}`),
        branch,
      )
    const handoff = getResumableIssueLinkedPrHandoff(
      linkedPr,
      canResumeHumanNeededReview,
      hasSyncedBranchState,
    )
    if (!handoff) return false

    this.logger.log(
      `[daemon] deferring resumable issue #${candidate.issue.number} to standalone ${handoff.kind} on PR #${linkedPr.number} because the branch is already synced with the remote PR head`,
    )
    return true
  }

  private async maybeRequeueFailedIssue(): Promise<boolean> {
    const issue = await this.findFailedIssueToRequeue()
    if (!issue) return false

    await transitionIssueState(
      issue.number,
      ISSUE_LABELS.READY,
      ISSUE_LABELS.FAILED,
      {
        event: 'failed-requeue',
        machine: this.config.machineId,
        ts: new Date().toISOString(),
        reason: 'auto-requeue-no-recovery-state',
      },
      this.config,
    )

    this.logger.log(`[daemon] re-queued failed issue #${issue.number} into ${ISSUE_LABELS.READY} because no local worktree or open PR remained`)
    return true
  }

  private async findFailedIssueToRequeue(): Promise<AgentIssue | null> {
    const [issues, prs] = await Promise.all([
      listOpenAgentIssues(this.config),
      listOpenAgentPullRequests(this.config),
    ])
    const now = Date.now()
    const openPrIssueNumbers = new Set(
      prs
        .map((pr) => extractIssueNumberFromPrTitle(pr.title))
        .filter((issueNumber): issueNumber is number => issueNumber !== null),
    )

    for (const issue of issues) {
      const eligible = shouldRequeueFailedIssue(
        issue,
        hasWorktreeForIssue(issue.number, this.config),
        openPrIssueNumbers.has(issue.number),
        now,
        AgentDaemon.FAILED_ISSUE_RESUME_COOLDOWN_MS,
      )
      if (!eligible) continue

      const activeClaimMachine = await this.getActiveClaimMachine(issue.number)
      if (activeClaimMachine && activeClaimMachine !== this.config.machineId) {
        this.logger.log(`[daemon] skipping failed requeue for #${issue.number}; active machine is ${activeClaimMachine}`)
        continue
      }

      return issue
    }

    return null
  }

  private async canStartManagedScope(
    targetNumber: number,
    scope: ManagedLeaseScope,
  ): Promise<boolean> {
    const comments = await listIssueComments(targetNumber, this.config)
    const activeLease = getActiveManagedLease(comments, scope)
    return canDaemonAdoptManagedLease(activeLease, this.daemonInstanceId)
  }

  private async findResumableIssue(): Promise<ResumableIssueCandidate | null> {
    const issues = await listOpenAgentIssues(this.config)
    const prs = await listOpenAgentPullRequests(this.config)
    const now = Date.now()
    const blockedIssueNumbers = new Set<number>()
    let candidate: ResumableIssueCandidate | null = null

    for (const issue of issues) {
      const attempts = this.failedIssueResumeAttempts.get(issue.number) ?? 0
      const cooldownUntil = this.failedIssueResumeCooldownUntil.get(issue.number) ?? 0
      const hasLocalWorktree = hasWorktreeForIssue(issue.number, this.config)
      const comments = await listIssueComments(issue.number, this.config)
      const activeLease = getActiveManagedLease(comments, 'issue-process', now)
      const latestLease = getLatestManagedLease(comments, 'issue-process')
      const branch = latestLease?.lease.branch ?? `agent/${issue.number}/${this.config.machineId}`
      const linkedPr = findLinkedManagedPr(prs, issue.number, branch)
      const linkedPrCanResumeHumanNeededReview = linkedPr && new Set(linkedPr.labels).has(PR_REVIEW_LABELS.HUMAN_NEEDED)
        ? canResumeAutomatedPrReview(
            await listIssueComments(linkedPr.number, this.config),
            AgentDaemon.MAX_AUTOMATED_PR_REVIEW_ATTEMPTS,
          )
        : false
      const canAdoptLease = canDaemonAdoptManagedLease(activeLease, this.daemonInstanceId, now)
      const canResumeFromLease = (
        latestLease?.lease.scope === 'issue-process'
        && Boolean(latestLease.lease.branch)
        && canAdoptLease
        && (latestLease.lease.status === 'recoverable' || activeLease === null)
      )
      const resumable = shouldResumeManagedIssue(
        issue,
        hasLocalWorktree || canResumeFromLease,
        attempts,
        cooldownUntil,
        now,
        AgentDaemon.MAX_FAILED_ISSUE_RESUMES,
      )
      if (!resumable) {
        this.clearBlockedIssueResume(issue.number)
        continue
      }
      const blockedResume = issue.state === 'failed'
        ? getFailedIssueResumeBlock(linkedPr, linkedPrCanResumeHumanNeededReview)
        : null
      if (blockedResume) {
        blockedIssueNumbers.add(issue.number)
        this.noteBlockedIssueResume(issue.number, blockedResume.prNumber, blockedResume.reason)
        await this.maybeEscalateBlockedIssueResume(issue.number, blockedResume.prNumber, blockedResume.reason, comments)
        continue
      }
      this.clearBlockedIssueResume(issue.number)
      if (!canAdoptLease) continue

      if (!candidate) {
        candidate = {
          issue,
          priorLease: latestLease,
          requiresRemoteAdoption: !hasLocalWorktree,
        }
      }
    }

    this.reconcileBlockedIssueResumes(blockedIssueNumbers)
    return candidate
  }

  private async getActiveClaimMachine(issueNumber: number): Promise<string | null> {
    const comments = await listIssueComments(issueNumber, this.config)
    return resolveActiveClaimMachine(comments)
  }

  private async ensureResumableIssueWorktree(
    issueNumber: number,
    priorLease: ManagedLeaseComment | null,
  ): Promise<{ worktreePath: string; branch: string; worktreeId: string }> {
    const worktreeId = `issue-${issueNumber}-${this.config.machineId}`
    const worktreePath = resolve(this.config.worktreesBase, worktreeId)
    const branch = priorLease?.lease.branch ?? `agent/${issueNumber}/${this.config.machineId}`

    if (hasWorktreeForIssue(issueNumber, this.config)) {
      return {
        worktreePath,
        branch,
        worktreeId,
      }
    }

    if (!priorLease?.lease.branch) {
      throw new Error(`cannot resume issue #${issueNumber} without a local worktree or recoverable lease branch`)
    }

    await createWorktreeFromRemoteBranch(worktreePath, priorLease.lease.branch, this.config, this.logger)
    return {
      worktreePath,
      branch: priorLease.lease.branch,
      worktreeId,
    }
  }

  private async findPendingStandaloneApprovedPrMerge(): Promise<ManagedPullRequest | null> {
    const prs = await listOpenAgentPullRequests(this.config)
    for (const pr of prs) {
      if (pr.isDraft) continue
      if (this.activePrReviews.has(pr.number)) continue
      if (!shouldMergeManagedPr(pr)) continue
      if (!(await this.canStartManagedScope(pr.number, 'pr-merge'))) continue
      return pr
    }
    return null
  }

  private async findLinkedOpenPrForIssue(
    issueNumber: number,
    branch: string,
  ): Promise<ManagedPullRequest | null> {
    const prs = await listOpenAgentPullRequests(this.config)
    return findLinkedManagedPr(prs, issueNumber, branch)
  }

  private async findPendingStandalonePrReview(): Promise<ManagedPullRequest | null> {
    const prs = await listOpenAgentPullRequests(this.config)
    for (const pr of prs) {
      if (pr.isDraft) continue
      if (this.activePrReviews.has(pr.number)) continue
      if (!(await this.canStartManagedScope(pr.number, 'pr-review'))) continue

      if (shouldReviewManagedPr(pr)) {
        return pr
      }

      if (!new Set(pr.labels).has(PR_REVIEW_LABELS.HUMAN_NEEDED)) continue

      const comments = await listIssueComments(pr.number, this.config)
      if (canResumeAutomatedPrReview(comments, AgentDaemon.MAX_AUTOMATED_PR_REVIEW_ATTEMPTS)) {
        return pr
      }
    }

    return null
  }

  private async processStandalonePrReview(pr: ManagedPullRequest): Promise<void> {
    this.logger.log(`[pr-review-subagent] reviewing existing PR #${pr.number}: "${pr.title}"`)
    const priorComments = await listIssueComments(pr.number, this.config)
    const nextAttempt = getNextAutomatedPrReviewAttempt(priorComments)
    const reviewLabels = new Set(pr.labels)
    const issueNumber = extractIssueNumberFromPrTitle(pr.title)
    const resumableHumanNeededReview = reviewLabels.has(PR_REVIEW_LABELS.HUMAN_NEEDED)
      && canResumeAutomatedPrReview(priorComments, AgentDaemon.MAX_AUTOMATED_PR_REVIEW_ATTEMPTS)
    const lease = await this.acquireLeaseForScope({
      targetNumber: pr.number,
      scope: 'pr-review',
      branch: pr.headRefName,
      worktreeId: `pr-review-${pr.number}`,
      phase: 'pr-review',
      prNumber: pr.number,
      issueNumber: issueNumber ?? undefined,
    })
    if (!lease) return

    const detached = await createDetachedPrWorktree(pr.number, this.config, this.logger)
    let leaseStatus: 'completed' | 'recoverable' | 'released' = 'completed'
    let leaseReason: string | undefined
    let leaseRecoveryKind: string | undefined
    try {
      const monitor = this.buildManagedLeaseMonitor('pr-review', pr.number, lease.handle)
      const currentHeadRefOid = await readGitHeadRefOid(detached.worktreePath)
      const reusableFeedback = resumableHumanNeededReview
        ? getReusableAutomatedPrReviewFeedback(
            priorComments,
            currentHeadRefOid,
            AgentDaemon.MAX_AUTOMATED_PR_REVIEW_ATTEMPTS,
          )
        : null

      let reviewForFix: PrReviewResult
      let attemptAfterFix: number

      if (reusableFeedback) {
        if (issueNumber !== null) {
          await this.transitionStandaloneIssue(
            issueNumber,
            ISSUE_LABELS.WORKING,
            `Resuming automated PR review for PR #${pr.number} on unchanged head ${currentHeadRefOid.slice(0, 7)}`,
            pr.number,
          )
        }
        await setManagedPrReviewLabels(pr.number, 'retry', this.config)
        reviewForFix = {
          approved: reusableFeedback.feedback.approved,
          canMerge: reusableFeedback.feedback.canMerge,
          reason: reusableFeedback.feedback.reason,
          findings: reusableFeedback.feedback.findings,
        }
        attemptAfterFix = nextAttempt
        this.logger.log(
          `[pr-review-subagent] reusing structured review feedback from attempt ${reusableFeedback.attempt} for PR #${pr.number} on unchanged head ${currentHeadRefOid.slice(0, 7)}`,
        )
      } else {
        const firstReview = await reviewPr(
          pr.number,
          pr.url,
          detached.worktreePath,
          this.config,
          this.logger,
          monitor,
        )
        recordPrReviewOutcome('initial', classifyPrReviewOutcome(firstReview))
        if (this.isRecoverableAgentFailureKind(firstReview.failureKind)) {
          recordWorkerIdleTimeout('pr-review')
          leaseStatus = 'recoverable'
          leaseReason = firstReview.reason
          leaseRecoveryKind = 'pr-review-idle-timeout'
          return
        }

        if (firstReview.approved && firstReview.canMerge) {
          await commentOnPr(
            pr.number,
            buildPrReviewComment(pr.number, firstReview, nextAttempt, 'approved', currentHeadRefOid),
            this.config,
          )
          await setManagedPrReviewLabels(pr.number, 'approved', this.config)
          this.logger.log(`[pr-review-subagent] approved PR #${pr.number}`)
          return
        }

        if (firstReview.reviewFailed) {
          await commentOnPr(
            pr.number,
            buildPrReviewComment(pr.number, firstReview, nextAttempt, 'human-needed', currentHeadRefOid),
            this.config,
          )
          await setManagedPrReviewLabels(pr.number, 'human-needed', this.config)
          if (issueNumber !== null) {
            await this.transitionStandaloneIssue(issueNumber, ISSUE_LABELS.FAILED, firstReview.reason)
          }
          this.logger.warn(`[pr-review-subagent] PR #${pr.number} produced an invalid review payload; stopping before auto-fix`)
          return
        }

        if (issueNumber === null) {
          await commentOnPr(
            pr.number,
            buildPrReviewComment(pr.number, firstReview, nextAttempt, 'human-needed', currentHeadRefOid),
            this.config,
          )
          await setManagedPrReviewLabels(pr.number, 'human-needed', this.config)
          this.logger.warn(`[pr-review-subagent] PR #${pr.number} rejected without auto-fix: could not infer issue number`)
          return
        }

        await commentOnPr(
          pr.number,
          buildPrReviewComment(pr.number, firstReview, nextAttempt, 'retrying', currentHeadRefOid),
          this.config,
        )
        await setManagedPrReviewLabels(pr.number, 'retry', this.config)
        reviewForFix = firstReview
        attemptAfterFix = nextAttempt + 1
      }

      if (issueNumber === null) {
        this.logger.warn(`[pr-review-subagent] PR #${pr.number} rejected without auto-fix: could not infer issue number`)
        return
      }

      const fixResult = await runReviewAutoFix(
        detached.worktreePath,
        issueNumber,
        pr.number,
        pr.url,
        buildReviewFeedback(reviewForFix),
        this.config,
        this.logger,
        monitor,
      )
      recordReviewAutoFixOutcome(fixResult.outcome)

      if (!fixResult.success) {
        if (this.isRecoverableAgentFailureKind(fixResult.failureKind)) {
          recordWorkerIdleTimeout('pr-review')
          leaseStatus = 'recoverable'
          leaseReason = fixResult.error ?? 'review auto-fix hit idle timeout'
          leaseRecoveryKind = 'pr-review-idle-timeout'
          return
        }

        const failedReview: PrReviewResult = {
          approved: false,
          canMerge: false,
          reason: `Auto-fix failed: ${fixResult.error ?? 'unknown error'}`,
          reviewFailed: true,
        }
        await commentOnPr(
          pr.number,
          buildPrReviewComment(pr.number, failedReview, attemptAfterFix, 'human-needed'),
          this.config,
        )
        await setManagedPrReviewLabels(pr.number, 'human-needed', this.config)
        await this.transitionStandaloneIssue(issueNumber, ISSUE_LABELS.FAILED, `Standalone PR auto-fix failed: ${failedReview.reason}`)
        this.logger.warn(`[pr-review-subagent] PR #${pr.number} needs human intervention after failed auto-fix`)
        return
      }

      try {
        await pushBranch(detached.worktreePath, pr.headRefName, this.logger)
      } catch (err) {
        recordReviewAutoFixOutcome('push_failed')
        const failedReview = buildAutoFixPushFailedReview(err)
        await commentOnPr(
          pr.number,
          buildPrReviewComment(pr.number, failedReview, attemptAfterFix, 'human-needed'),
          this.config,
        )
        await setManagedPrReviewLabels(pr.number, 'human-needed', this.config)
        await this.transitionStandaloneIssue(issueNumber, ISSUE_LABELS.FAILED, `Standalone PR auto-fix push failed: ${failedReview.reason}`)
        this.logger.warn(`[pr-review-subagent] PR #${pr.number} needs human intervention after auto-fix push failure`)
        return
      }

      this.logger.log(`[pr-review-subagent] pushed auto-fix commit to ${pr.headRefName}`)
      const updatedHeadRefOid = await readGitHeadRefOid(detached.worktreePath)
      const secondReview = await reviewPr(
        pr.number,
        pr.url,
        detached.worktreePath,
        this.config,
        this.logger,
        monitor,
      )
      recordPrReviewOutcome('post_fix', classifyPrReviewOutcome(secondReview))
      if (this.isRecoverableAgentFailureKind(secondReview.failureKind)) {
        recordWorkerIdleTimeout('pr-review')
        leaseStatus = 'recoverable'
        leaseReason = secondReview.reason
        leaseRecoveryKind = 'pr-review-idle-timeout'
        return
      }

      if (secondReview.approved && secondReview.canMerge) {
        await commentOnPr(
          pr.number,
          buildPrReviewComment(pr.number, secondReview, attemptAfterFix, 'approved', updatedHeadRefOid),
          this.config,
        )
        await setManagedPrReviewLabels(pr.number, 'approved', this.config)
        this.logger.log(`[pr-review-subagent] approved PR #${pr.number} after auto-fix`)
        return
      }

      await commentOnPr(
        pr.number,
        buildPrReviewComment(pr.number, secondReview, attemptAfterFix, 'human-needed', updatedHeadRefOid),
        this.config,
      )
      await setManagedPrReviewLabels(pr.number, 'human-needed', this.config)
      await this.transitionStandaloneIssue(issueNumber, ISSUE_LABELS.FAILED, secondReview.reason)
      this.logger.warn(`[pr-review-subagent] PR #${pr.number} still blocked after auto-fix`)
    } catch (err) {
      if (isRetryableDaemonLoopError(err)) {
        leaseStatus = 'recoverable'
        leaseReason = formatDaemonError(err)
        leaseRecoveryKind = 'pr-review-retryable-error'
        return
      }
      throw err
    } finally {
      await detached.cleanup()
      await this.completeManagedLease('pr-review', pr.number, lease.handle, leaseStatus, leaseReason, leaseRecoveryKind)
    }
  }

  private async processStandaloneApprovedPrMerge(pr: ManagedPullRequest): Promise<void> {
    this.logger.log(`[pr-merge-subagent] attempting merge for approved PR #${pr.number}: "${pr.title}"`)
    const lease = await this.acquireLeaseForScope({
      targetNumber: pr.number,
      scope: 'pr-merge',
      branch: pr.headRefName,
      worktreeId: `pr-merge-${pr.number}`,
      phase: 'pr-merge',
      prNumber: pr.number,
      issueNumber: extractIssueNumberFromPrTitle(pr.title) ?? undefined,
    })
    if (!lease) return

    const detached = await createDetachedPrWorktree(pr.number, this.config, this.logger)
    let leaseStatus: 'completed' | 'recoverable' | 'released' = 'completed'
    let leaseReason: string | undefined
    let leaseRecoveryKind: string | undefined
    try {
      const mergeResult = await this.attemptApprovedPrMergeWithRecovery(
        pr.number,
        pr.url,
        pr.headRefName,
        detached.worktreePath,
        this.buildManagedLeaseMonitor('pr-merge', pr.number, lease.handle),
      )
      if (mergeResult.recoverable) {
        if (mergeResult.review?.failureKind === 'idle_timeout') {
          recordWorkerIdleTimeout('pr-merge')
          leaseRecoveryKind = 'pr-merge-idle-timeout'
        } else {
          leaseRecoveryKind = 'pr-merge-retryable-error'
        }
        leaseStatus = 'recoverable'
        leaseReason = mergeResult.message
        return
      }

      if (mergeResult.merged) {
        const issueNumber = extractIssueNumberFromPrTitle(pr.title)
        if (issueNumber !== null) {
          await this.transitionStandaloneIssue(
            issueNumber,
            ISSUE_LABELS.DONE,
            mergeResult.sha
              ? `Merged PR with commit ${mergeResult.sha}`
              : mergeResult.message,
            pr.number,
          )
        }
        this.logger.log(`[pr-merge-subagent] merged approved PR #${pr.number}`)
        return
      }

      const issueNumber = extractIssueNumberFromPrTitle(pr.title)
      if (issueNumber !== null) {
        await this.transitionStandaloneIssue(
          issueNumber,
          ISSUE_LABELS.FAILED,
          `Standalone approved PR could not be merged: ${mergeResult.message}`,
          pr.number,
        )
      }
      this.logger.warn(`[pr-merge-subagent] PR #${pr.number} could not be auto-merged: ${mergeResult.message}`)
    } catch (err) {
      if (isRetryableDaemonLoopError(err)) {
        leaseStatus = 'recoverable'
        leaseReason = formatDaemonError(err)
        leaseRecoveryKind = 'pr-merge-retryable-error'
        return
      }
      throw err
    } finally {
      await detached.cleanup()
      await this.completeManagedLease('pr-merge', pr.number, lease.handle, leaseStatus, leaseReason, leaseRecoveryKind)
    }
  }

  private async transitionStandaloneIssue(
    issueNumber: number,
    nextLabel: typeof ISSUE_LABELS.DONE | typeof ISSUE_LABELS.FAILED | typeof ISSUE_LABELS.WORKING,
    reason: string,
    prNumber?: number,
  ): Promise<void> {
    const issue = await getAgentIssueByNumber(issueNumber, this.config)
    if (!issue || !shouldApplyStandaloneIssueTransition(issue, nextLabel)) {
      this.logger.log(
        `[daemon] skipping standalone issue transition for #${issueNumber}: current=${issue?.state ?? 'missing'} target=${nextLabel}`,
      )
      return
    }

    const currentLabel =
      issue.state === 'working' ? ISSUE_LABELS.WORKING
        : issue.state === 'claimed' ? ISSUE_LABELS.CLAIMED
          : issue.state === 'stale' ? ISSUE_LABELS.STALE
            : issue.state === 'failed' ? ISSUE_LABELS.FAILED
              : issue.state === 'done' ? ISSUE_LABELS.DONE
              : issue.state === 'ready' ? ISSUE_LABELS.READY
                : null

    await transitionIssueState(
      issueNumber,
      nextLabel,
      currentLabel,
      {
        event: nextLabel === ISSUE_LABELS.DONE
          ? 'done'
          : nextLabel === ISSUE_LABELS.WORKING
            ? 'claimed'
            : 'failed',
        machine: this.config.machineId,
        ts: new Date().toISOString(),
        prNumber,
        reason,
      },
      this.config,
    )
  }

  private async processResumableIssue(candidate: ResumableIssueCandidate): Promise<void> {
    const { issue, priorLease } = candidate
    const issueNumber = issue.number
    const processingStartTime = Date.now()
    this.logger.log(`[daemon] resuming ${issue.state} issue #${issueNumber}: "${issue.title}"`)

    let leaseHandle: ManagedLeaseHandle | null = null
    let branch = priorLease?.lease.branch ?? `agent/${issueNumber}/${this.config.machineId}`
    let worktreePath = resolve(this.config.worktreesBase, `issue-${issueNumber}-${this.config.machineId}`)
    let worktreeId = `issue-${issueNumber}-${this.config.machineId}`

    try {
      const ensured = await this.ensureResumableIssueWorktree(issueNumber, priorLease)
      branch = ensured.branch
      worktreePath = ensured.worktreePath
      worktreeId = ensured.worktreeId

      if (issue.state === 'failed') {
        await transitionIssueState(
          issueNumber,
          ISSUE_LABELS.WORKING,
          ISSUE_LABELS.FAILED,
          {
            event: 'claimed',
            machine: this.config.machineId,
            ts: new Date().toISOString(),
            reason: candidate.requiresRemoteAdoption ? 'resume-expired-lease' : 'resume-existing-worktree',
          },
          this.config,
        )
      } else {
        await transitionIssueState(
          issueNumber,
          ISSUE_LABELS.WORKING,
          ISSUE_LABELS.WORKING,
          {
            event: 'claimed',
            machine: this.config.machineId,
            ts: new Date().toISOString(),
            reason: candidate.requiresRemoteAdoption ? 'resume-expired-lease' : 'resume-existing-worktree',
          },
          this.config,
        )
      }

      const acquiredLease = await this.acquireLeaseForScope({
        targetNumber: issueNumber,
        scope: 'issue-process',
        branch,
        worktreeId,
        phase: 'issue-recovery',
        issueNumber,
      })
      if (!acquiredLease) {
        recordIssueProcessingDuration(Date.now() - processingStartTime)
        return
      }
      leaseHandle = acquiredLease.handle

      const wt: WorktreeInfo = {
        path: worktreePath,
        issueNumber,
        machineId: this.config.machineId,
        branch,
        state: 'active',
        createdAt: new Date().toISOString(),
      }
      this.activeWorktrees.set(issueNumber, wt)
      this.syncRuntimeMetrics()

      await restoreManagedWorktreeState(worktreePath, this.logger)
      const monitor = this.buildManagedLeaseMonitor('issue-process', issueNumber, leaseHandle)

      const prCheck = await checkPrExists(branch, this.config)
      const linkedOpenPr = prCheck.prNumber !== null && prCheck.prState === 'open'
        ? (await listOpenAgentPullRequests(this.config)).find((pr) => pr.number === prCheck.prNumber) ?? null
        : null
      if (linkedOpenPr && shouldResetLinkedPrToRetryOnIssueResume(linkedOpenPr.labels)) {
        await setManagedPrReviewLabels(linkedOpenPr.number, 'retry', this.config)
        this.logger.log(
          `[daemon] marked linked PR #${linkedOpenPr.number} as retry because issue #${issueNumber} resumed local recovery`,
        )
      }
      const recentBlockingReasons = prCheck.prNumber !== null
        ? extractAutomatedReviewReasons(await listIssueComments(prCheck.prNumber, this.config))
        : []
      const recoveryResult = await runIssueRecovery(
        worktreePath,
        issueNumber,
        issue.title,
        issue.body,
        this.config,
        this.logger,
        prCheck.prNumber !== null && prCheck.prUrl
          ? { number: prCheck.prNumber, url: prCheck.prUrl, branch }
          : null,
        recentBlockingReasons,
        monitor,
      )

      if (!recoveryResult.success) {
        if (this.isRecoverableAgentFailureKind(recoveryResult.failureKind)) {
          recordWorkerIdleTimeout('issue-process')
          await this.markIssueRecoverable(issueNumber, recoveryResult.error ?? 'issue recovery hit idle timeout')
          await this.completeManagedLease(
            'issue-process',
            issueNumber,
            leaseHandle,
            'recoverable',
            recoveryResult.error,
            'issue-process-idle-timeout',
          )
          this.activeWorktrees.delete(issueNumber)
          this.syncRuntimeMetrics()
          recordIssueProcessingDuration(Date.now() - processingStartTime)
          return
        }

        await this.markIssueFailed(issueNumber, recoveryResult.error)
        this.registerFailedIssueResume(issueNumber)
        await this.completeManagedLease('issue-process', issueNumber, leaseHandle, 'completed')
        this.logger.error(`[daemon] resumed issue #${issueNumber} failed again: ${recoveryResult.error}`)
        recordIssueProcessingDuration(Date.now() - processingStartTime)
        return
      }

      const finalized = await this.finalizeIssueFromBranch(issue, worktreePath, branch)
      if (finalized.status === 'completed') {
        this.failedIssueResumeAttempts.delete(issueNumber)
        this.failedIssueResumeCooldownUntil.delete(issueNumber)
        await this.completeManagedLease('issue-process', issueNumber, leaseHandle, 'completed')
        this.syncRuntimeMetrics()
      } else if (finalized.status === 'recoverable') {
        await this.markIssueRecoverable(issueNumber, finalized.reason ?? 'recoverable resume handoff')
        await this.completeManagedLease(
          'issue-process',
          issueNumber,
          leaseHandle,
          'recoverable',
          finalized.reason,
          'issue-process-recoverable',
        )
        this.activeWorktrees.delete(issueNumber)
        this.syncRuntimeMetrics()
      } else {
        if (shouldClearFailedIssueResumeTrackingAfterFinalize(finalized.status)) {
          this.failedIssueResumeAttempts.delete(issueNumber)
          this.failedIssueResumeCooldownUntil.delete(issueNumber)
        }
        await this.completeManagedLease('issue-process', issueNumber, leaseHandle, 'completed')
        this.syncRuntimeMetrics()
      }
      recordIssueProcessingDuration(Date.now() - processingStartTime)
    } catch (err) {
      this.logger.error(`[daemon] failed to resume issue #${issueNumber}:`, err)
      if (leaseHandle && isRetryableDaemonLoopError(err)) {
        await this.markIssueRecoverable(issueNumber, formatDaemonError(err))
        await this.completeManagedLease(
          'issue-process',
          issueNumber,
          leaseHandle,
          'recoverable',
          formatDaemonError(err),
          'issue-process-retryable-error',
        )
      } else {
        this.registerFailedIssueResume(issueNumber)

        try {
          await this.markIssueFailed(issueNumber, String(err))
        } catch {
          // ignore
        }
        if (leaseHandle) {
          await this.completeManagedLease('issue-process', issueNumber, leaseHandle, 'completed')
        }
      }

      this.activeWorktrees.delete(issueNumber)
      this.syncRuntimeMetrics()
      recordIssueProcessingDuration(Date.now() - processingStartTime)
    }
  }

  private async attemptApprovedPrMergeWithRecovery(
    prNumber: number,
    prUrl: string,
    branch: string,
    worktreePath: string,
    monitor?: TaskExecutionMonitor,
  ): Promise<{ merged: boolean; message: string; sha?: string; review?: PrReviewResult; recoverable?: boolean }> {
    const mergeResult = await mergePullRequest(prNumber, this.config)
    if (mergeResult.merged) {
      recordPrMergeRecoveryOutcome('merged_initial')
      return mergeResult
    }

    if (!isMergeabilityFailure(mergeResult.message)) {
      recordPrMergeRecoveryOutcome('blocked_non_mergeable')
      await commentOnPr(prNumber, buildPrMergeBlockedComment(prNumber, mergeResult.message), this.config)
      await setManagedPrReviewLabels(prNumber, 'human-needed', this.config)
      return mergeResult
    }

    await commentOnPr(
      prNumber,
      buildPrMergeRetryComment(prNumber, branch, this.config.git.defaultBranch, mergeResult.message),
      this.config,
    )

    const refreshResult = await rebaseManagedBranchOntoDefault(
      worktreePath,
      branch,
      this.config.git.defaultBranch,
      this.logger,
    )
    if (!refreshResult.success) {
      recordPrMergeRecoveryOutcome('refresh_failed')
      const blockedResult = {
        merged: false,
        message: `Branch refresh failed: ${refreshResult.message}`,
      }
      await commentOnPr(prNumber, buildPrMergeBlockedComment(prNumber, blockedResult.message), this.config)
      await setManagedPrReviewLabels(prNumber, 'human-needed', this.config)
      return blockedResult
    }

    try {
      await pushBranch(worktreePath, branch, this.logger)
    } catch (err) {
      recordPrMergeRecoveryOutcome('refresh_push_failed')
      const blockedResult = {
        merged: false,
        message: `Branch refresh push failed: ${formatDaemonError(err)}`,
      }
      await commentOnPr(prNumber, buildPrMergeBlockedComment(prNumber, blockedResult.message), this.config)
      await setManagedPrReviewLabels(prNumber, 'human-needed', this.config)
      return blockedResult
    }

    const review = await this.runDetachedPrReview(prNumber, prUrl, monitor)
    recordPrReviewOutcome('merge_refresh', classifyPrReviewOutcome(review))

    if (this.isRecoverableAgentFailureKind(review.failureKind)) {
      return {
        merged: false,
        message: review.reason,
        review,
        recoverable: true,
      }
    }

    if (!(review.approved && review.canMerge)) {
      recordPrMergeRecoveryOutcome('refresh_review_blocked')
      await commentOnPr(prNumber, buildPrReviewComment(prNumber, review, 2, 'human-needed'), this.config)
      await setManagedPrReviewLabels(prNumber, 'human-needed', this.config)
      return {
        merged: false,
        message: review.reason,
        review,
      }
    }

    await commentOnPr(prNumber, buildPrReviewComment(prNumber, review, 2, 'approved'), this.config)
    await setManagedPrReviewLabels(prNumber, 'approved', this.config)

    const retriedMergeResult = await mergePullRequest(prNumber, this.config)
    if (retriedMergeResult.merged) {
      recordPrMergeRecoveryOutcome('merged_after_refresh')
      return {
        ...retriedMergeResult,
        review,
      }
    }

    recordPrMergeRecoveryOutcome('retry_merge_failed')
    await commentOnPr(prNumber, buildPrMergeBlockedComment(prNumber, retriedMergeResult.message), this.config)
    await setManagedPrReviewLabels(prNumber, 'human-needed', this.config)
    return {
      ...retriedMergeResult,
      review,
    }
  }

  private registerFailedIssueResume(issueNumber: number): void {
    const attempts = (this.failedIssueResumeAttempts.get(issueNumber) ?? 0) + 1
    this.failedIssueResumeAttempts.set(issueNumber, attempts)
    this.failedIssueResumeCooldownUntil.set(
      issueNumber,
      Date.now() + AgentDaemon.FAILED_ISSUE_RESUME_COOLDOWN_MS,
    )
    this.syncRuntimeMetrics()
  }

  private async reviewAndPossiblyAutoFix(
    issue: AgentIssue,
    worktreePath: string,
    branch: string,
    prNumber: number,
    prUrl: string,
    monitor?: TaskExecutionMonitor,
  ): Promise<{ approved: boolean; review: PrReviewResult; recoverable?: boolean }> {
    const priorComments = await listIssueComments(prNumber, this.config)
    const nextAttempt = getNextAutomatedPrReviewAttempt(priorComments)
    const currentHeadRefOid = await readGitHeadRefOid(worktreePath)
    const reusableFeedback = getReusableAutomatedPrReviewFeedback(
      priorComments,
      currentHeadRefOid,
      AgentDaemon.MAX_AUTOMATED_PR_REVIEW_ATTEMPTS,
    )

    let reviewForFix: PrReviewResult
    let attemptAfterFix: number

    if (reusableFeedback) {
      await setManagedPrReviewLabels(prNumber, 'retry', this.config)
      reviewForFix = {
        approved: reusableFeedback.feedback.approved,
        canMerge: reusableFeedback.feedback.canMerge,
        reason: reusableFeedback.feedback.reason,
        findings: reusableFeedback.feedback.findings,
      }
      attemptAfterFix = nextAttempt
      this.logger.log(
        `[pr-review-subagent] reusing structured review feedback from attempt ${reusableFeedback.attempt} for PR #${prNumber} on unchanged head ${currentHeadRefOid.slice(0, 7)}`,
      )
    } else {
      const firstReview = await this.runDetachedPrReview(prNumber, prUrl, monitor)
      recordPrReviewOutcome('initial', classifyPrReviewOutcome(firstReview))

      if (this.isRecoverableAgentFailureKind(firstReview.failureKind)) {
        return { approved: false, review: firstReview, recoverable: true }
      }

      await commentOnPr(
        prNumber,
        buildPrReviewComment(
          prNumber,
          firstReview,
          nextAttempt,
          firstReview.approved && firstReview.canMerge
            ? 'approved'
            : firstReview.reviewFailed
              ? 'human-needed'
              : 'retrying',
          currentHeadRefOid,
        ),
        this.config,
      )

      if (firstReview.approved && firstReview.canMerge) {
        await setManagedPrReviewLabels(prNumber, 'approved', this.config)
        return { approved: true, review: firstReview }
      }

      if (firstReview.reviewFailed) {
        await setManagedPrReviewLabels(prNumber, 'human-needed', this.config)
        return { approved: false, review: firstReview }
      }

      await setManagedPrReviewLabels(prNumber, 'retry', this.config)
      reviewForFix = firstReview
      attemptAfterFix = nextAttempt + 1
    }

    const fixResult = await runReviewAutoFix(
      worktreePath,
      issue.number,
      prNumber,
      prUrl,
      buildReviewFeedback(reviewForFix),
      this.config,
      this.logger,
      monitor,
    )
    recordReviewAutoFixOutcome(fixResult.outcome)

    if (!fixResult.success) {
      if (this.isRecoverableAgentFailureKind(fixResult.failureKind)) {
        return {
          approved: false,
          review: {
            approved: false,
            canMerge: false,
            reason: `Auto-fix failed: ${fixResult.error ?? 'unknown error'}`,
            reviewFailed: true,
            failureKind: fixResult.failureKind,
          },
          recoverable: true,
        }
      }

      const failedReview: PrReviewResult = {
        approved: false,
        canMerge: false,
        reason: `Auto-fix failed: ${fixResult.error ?? 'unknown error'}`,
        reviewFailed: true,
      }
      await commentOnPr(
        prNumber,
        buildPrReviewComment(prNumber, failedReview, attemptAfterFix, 'human-needed'),
        this.config,
      )
      await setManagedPrReviewLabels(prNumber, 'human-needed', this.config)
      return { approved: false, review: failedReview }
    }

    try {
      await pushBranch(worktreePath, branch, this.logger)
    } catch (err) {
      recordReviewAutoFixOutcome('push_failed')
      const failedReview = buildAutoFixPushFailedReview(err)
      await commentOnPr(
        prNumber,
        buildPrReviewComment(prNumber, failedReview, attemptAfterFix, 'human-needed'),
        this.config,
      )
      await setManagedPrReviewLabels(prNumber, 'human-needed', this.config)
      return { approved: false, review: failedReview }
    }

    const updatedHeadRefOid = await readGitHeadRefOid(worktreePath)
    const secondReview = await this.runDetachedPrReview(prNumber, prUrl, monitor)
    recordPrReviewOutcome('post_fix', classifyPrReviewOutcome(secondReview))

    if (this.isRecoverableAgentFailureKind(secondReview.failureKind)) {
      return { approved: false, review: secondReview, recoverable: true }
    }

    if (secondReview.approved && secondReview.canMerge) {
      await commentOnPr(
        prNumber,
        buildPrReviewComment(prNumber, secondReview, attemptAfterFix, 'approved', updatedHeadRefOid),
        this.config,
      )
      await setManagedPrReviewLabels(prNumber, 'approved', this.config)
      return { approved: true, review: secondReview }
    }

    await commentOnPr(
      prNumber,
      buildPrReviewComment(prNumber, secondReview, attemptAfterFix, 'human-needed', updatedHeadRefOid),
      this.config,
    )
    await setManagedPrReviewLabels(prNumber, 'human-needed', this.config)
    return { approved: false, review: secondReview }
  }

  private async runDetachedPrReview(
    prNumber: number,
    prUrl: string,
    monitor?: TaskExecutionMonitor,
  ): Promise<PrReviewResult> {
    const detached = await createDetachedPrWorktree(prNumber, this.config, this.logger)
    try {
      return await reviewPr(prNumber, prUrl, detached.worktreePath, this.config, this.logger, monitor)
    } finally {
      await detached.cleanup()
    }
  }

  private async finalizeIssueFromBranch(
    issue: AgentIssue,
    worktreePath: string,
    branch: string,
  ): Promise<{ status: 'completed' | 'failed' | 'recoverable'; reason?: string }> {
    const pr = await createOrFindPr(worktreePath, branch, issue.number, issue.title, this.config, this.logger)
    const reviewLease = await this.acquireLeaseForScope({
      targetNumber: pr.prNumber,
      scope: 'pr-review',
      branch,
      worktreeId: this.buildLeaseKey('issue-process', issue.number),
      phase: 'reviewing-pr',
      issueNumber: issue.number,
      prNumber: pr.prNumber,
    })
    if (!reviewLease) {
      return {
        status: 'recoverable',
        reason: `pr-review lease conflict on PR #${pr.prNumber}`,
      }
    }

    const reviewOutcome = await this.reviewAndPossiblyAutoFix(
      issue,
      worktreePath,
      branch,
      pr.prNumber,
      pr.prUrl,
      this.buildManagedLeaseMonitor('pr-review', pr.prNumber, reviewLease.handle),
    )
    if (reviewOutcome.recoverable) {
      if (reviewOutcome.review.failureKind === 'idle_timeout') {
        recordWorkerIdleTimeout('pr-review')
      }
      await this.completeManagedLease(
        'pr-review',
        pr.prNumber,
        reviewLease.handle,
        'recoverable',
        reviewOutcome.review.reason,
        'pr-review-idle-timeout',
      )
      return {
        status: 'recoverable',
        reason: reviewOutcome.review.reason,
      }
    }
    await this.completeManagedLease('pr-review', pr.prNumber, reviewLease.handle, 'completed')

    if (reviewOutcome.approved) {
      const mergeLease = await this.acquireLeaseForScope({
        targetNumber: pr.prNumber,
        scope: 'pr-merge',
        branch,
        worktreeId: this.buildLeaseKey('issue-process', issue.number),
        phase: 'merging-pr',
        issueNumber: issue.number,
        prNumber: pr.prNumber,
      })
      if (!mergeLease) {
        return {
          status: 'recoverable',
          reason: `pr-merge lease conflict on PR #${pr.prNumber}`,
        }
      }

      const mergeResult = await this.attemptApprovedPrMergeWithRecovery(
        pr.prNumber,
        pr.prUrl,
        branch,
        worktreePath,
        this.buildManagedLeaseMonitor('pr-merge', pr.prNumber, mergeLease.handle),
      )
      if (mergeResult.recoverable) {
        if (mergeResult.review?.failureKind === 'idle_timeout') {
          recordWorkerIdleTimeout('pr-merge')
        }
        await this.completeManagedLease(
          'pr-merge',
          pr.prNumber,
          mergeLease.handle,
          'recoverable',
          mergeResult.message,
          'pr-merge-idle-timeout',
        )
        return {
          status: 'recoverable',
          reason: mergeResult.message,
        }
      }
      await this.completeManagedLease('pr-merge', pr.prNumber, mergeLease.handle, 'completed')

      if (!mergeResult.merged) {
        await transitionIssueState(
          issue.number,
          ISSUE_LABELS.FAILED,
          ISSUE_LABELS.WORKING,
          {
            event: 'failed',
            machine: this.config.machineId,
            ts: new Date().toISOString(),
            prNumber: pr.prNumber,
            reason: `Merge failed after approval: ${mergeResult.message}`,
            prReview: reviewOutcome.review,
          },
          this.config,
        )

        this.logger.error(`[daemon] issue #${issue.number} review approved but merge failed: PR #${pr.prNumber} (${mergeResult.message})`)
        recordIssueProcessed('failed')
        this.activeWorktrees.delete(issue.number)
        this.syncRuntimeMetrics()
        return {
          status: 'failed',
          reason: mergeResult.message,
        }
      }

      await transitionIssueState(
        issue.number,
        ISSUE_LABELS.DONE,
        ISSUE_LABELS.WORKING,
        {
          event: 'done',
          machine: this.config.machineId,
          ts: new Date().toISOString(),
          prNumber: pr.prNumber,
          reason: mergeResult.sha
            ? `Merged PR with commit ${mergeResult.sha}`
            : mergeResult.message,
          prReview: reviewOutcome.review,
        },
        this.config,
      )

      this.logger.log(`[daemon] issue #${issue.number} done! PR: #${pr.prNumber}`)
      recordIssueProcessed('done')
      recordPrCreated()

      await removeWorktree(worktreePath, branch)
      this.activeWorktrees.delete(issue.number)
      this.syncRuntimeMetrics()
      return { status: 'completed' }
    }

    await transitionIssueState(
      issue.number,
      ISSUE_LABELS.FAILED,
      ISSUE_LABELS.WORKING,
      {
        event: 'failed',
        machine: this.config.machineId,
        ts: new Date().toISOString(),
        prNumber: pr.prNumber,
        reason: reviewOutcome.review.reason,
        prReview: reviewOutcome.review,
      },
      this.config,
    )

    this.logger.error(`[daemon] issue #${issue.number} failed review and needs human intervention: PR #${pr.prNumber}`)
    recordIssueProcessed('failed')
    this.activeWorktrees.delete(issue.number)
    this.syncRuntimeMetrics()
    return {
      status: 'failed',
      reason: reviewOutcome.review.reason,
    }
  }

  private async markIssueFailed(issueNumber: number, reason?: string): Promise<void> {
    await transitionIssueState(
      issueNumber,
      ISSUE_LABELS.FAILED,
      ISSUE_LABELS.WORKING,
      {
        event: 'failed',
        machine: this.config.machineId,
        ts: new Date().toISOString(),
        reason,
      },
      this.config,
    )

    recordIssueProcessed('failed')
    this.activeWorktrees.delete(issueNumber)
    this.syncRuntimeMetrics()
  }

  private async processIssue(issue: AgentIssue): Promise<void> {
    const issueNumber = issue.number
    const processingStartTime = Date.now()
    this.logger.log(`[daemon] processing issue #${issueNumber}: "${issue.title}"`)

    const branch = `agent/${issueNumber}/${this.config.machineId}`
    const worktreeId = `issue-${issueNumber}-${this.config.machineId}`
    let leaseHandle: ManagedLeaseHandle | null = null

    try {
      // Update to working state
      await transitionIssueState(
        issueNumber,
        ISSUE_LABELS.WORKING,
        ISSUE_LABELS.CLAIMED,
        {
          event: 'claimed',
          machine: this.config.machineId,
          ts: new Date().toISOString(),
        },
        this.config,
      )

      // Create worktree
      const worktreePath = await createWorktree(issueNumber, this.config)
      const acquiredLease = await this.acquireLeaseForScope({
        targetNumber: issueNumber,
        scope: 'issue-process',
        branch,
        worktreeId,
        phase: 'planning',
        issueNumber,
      })
      if (!acquiredLease) {
        recordIssueProcessingDuration(Date.now() - processingStartTime)
        return
      }
      leaseHandle = acquiredLease.handle

      const wt: WorktreeInfo = {
        path: worktreePath,
        issueNumber,
        machineId: this.config.machineId,
        branch,
        state: 'active',
        createdAt: new Date().toISOString(),
      }
      this.activeWorktrees.set(issueNumber, wt)
      this.syncRuntimeMetrics()

      // Run planning agent + subtask loop
      const monitor = this.buildManagedLeaseMonitor('issue-process', issueNumber, leaseHandle)
      const result = await runSubtaskExecutor(
        worktreePath,
        issueNumber,
        issue.title,
        issue.body,
        this.config,
        this.logger,
        monitor,
      )

      if (result.success) {
        const finalized = await this.finalizeIssueFromBranch(issue, worktreePath, branch)
        if (finalized.status === 'recoverable') {
          await this.markIssueRecoverable(issueNumber, finalized.reason ?? 'recoverable issue handoff')
          await this.completeManagedLease(
            'issue-process',
            issueNumber,
            leaseHandle,
            'recoverable',
            finalized.reason,
            'issue-process-recoverable',
          )
          this.activeWorktrees.delete(issueNumber)
          this.syncRuntimeMetrics()
        } else {
          await this.completeManagedLease('issue-process', issueNumber, leaseHandle, 'completed')
        }
      } else {
        if (this.isRecoverableAgentFailureKind(result.failureKind)) {
          recordWorkerIdleTimeout('issue-process')
          await this.markIssueRecoverable(issueNumber, result.error ?? 'subtask executor hit idle timeout')
          await this.completeManagedLease(
            'issue-process',
            issueNumber,
            leaseHandle,
            'recoverable',
            result.error,
            'issue-process-idle-timeout',
          )
          this.activeWorktrees.delete(issueNumber)
          this.syncRuntimeMetrics()
          recordIssueProcessingDuration(Date.now() - processingStartTime)
          return
        }

        await transitionIssueState(
          issueNumber,
          ISSUE_LABELS.FAILED,
          ISSUE_LABELS.WORKING,
          {
            event: 'failed',
            machine: this.config.machineId,
            ts: new Date().toISOString(),
            exitCode: result.exitCode,
            reason: result.error,
          },
          this.config,
        )

        const doneCount = result.subtasks.filter(s => s.status === 'done').length
        this.logger.error(`[daemon] issue #${issueNumber} failed (${doneCount}/${result.subtasks.length} subtasks done): ${result.error}`)
        recordIssueProcessed('failed')
        await this.completeManagedLease('issue-process', issueNumber, leaseHandle, 'completed')
        this.activeWorktrees.delete(issueNumber)
        this.syncRuntimeMetrics()
      }

      recordIssueProcessingDuration(Date.now() - processingStartTime)
    } catch (err) {
      this.logger.error(`[daemon] failed to process issue #${issueNumber}:`, err)
      if (leaseHandle && isRetryableDaemonLoopError(err)) {
        await this.markIssueRecoverable(issueNumber, formatDaemonError(err))
        await this.completeManagedLease(
          'issue-process',
          issueNumber,
          leaseHandle,
          'recoverable',
          formatDaemonError(err),
          'issue-process-retryable-error',
        )
      } else {
        recordIssueProcessed('error')
        this.syncRuntimeMetrics()

        try {
          await transitionIssueState(
            issueNumber,
            ISSUE_LABELS.FAILED,
            null,
            {
              event: 'failed',
              machine: this.config.machineId,
              ts: new Date().toISOString(),
              reason: String(err),
            },
            this.config,
          )
        } catch {
          // ignore
        }
        if (leaseHandle) {
          await this.completeManagedLease('issue-process', issueNumber, leaseHandle, 'completed')
        }
      }

      this.activeWorktrees.delete(issueNumber)
      this.syncRuntimeMetrics()
      recordIssueProcessingDuration(Date.now() - processingStartTime)
    }
  }

  private buildRuntimeStatus(): DaemonStatus['runtime'] {
    return buildDaemonRuntimeStatus({
      activeWorktreeCount: this.activeWorktrees.size,
      activePrReviewCount: this.activePrReviews.size,
      hasInFlightProcess: this._inFlightProcess !== null,
      hasInFlightPrReview: this._inFlightPrReview !== null,
      startupRecoveryPending: this.startupRecoveryPending,
      transientLoopErrorCount: this.transientLoopErrorCount,
      startupRecoveryDeferredCount: this.startupRecoveryDeferredCount,
      lastTransientLoopErrorAt: this.lastTransientLoopErrorAt,
      lastTransientLoopErrorKind: this.lastTransientLoopErrorKind,
      lastTransientLoopErrorMessage: this.lastTransientLoopErrorMessage,
      lastTransientLoopErrorAgeSeconds: this.getLastTransientLoopErrorAgeSeconds(),
      failedIssueResumeAttemptCount: this.failedIssueResumeAttempts.size,
      failedIssueResumeCooldownCount: this.failedIssueResumeCooldownUntil.size,
      oldestBlockedIssueResumeAgeSeconds: this.getOldestBlockedIssueResumeAgeSeconds(),
      activeLeaseCount: this.activeLeaseReaders.size,
      oldestLeaseHeartbeatAgeSeconds: this.getOldestLeaseHeartbeatAgeSeconds(),
      activeLeaseDetails: this.getActiveLeaseDetails(),
      stalledWorkerCount: this.stalledWorkers.size,
      stalledWorkerDetails: this.getStalledWorkerDetails(),
      blockedIssueResumeCount: this.blockedIssueResumes.size,
      blockedIssueResumeEscalationCount: this.getBlockedIssueResumeEscalationCount(),
      blockedIssueResumeDetails: this.getBlockedIssueResumeDetails(),
      lastRecoveryActionAt: this.lastRecoveryActionAt,
      lastRecoveryActionKind: this.lastRecoveryActionKind,
      recentRecoveryActions: [...this.recoveryActionHistory],
      oldestBlockedIssueResumeEscalationAgeSeconds: this.getOldestBlockedIssueResumeEscalationAgeSeconds(),
    })
  }

  private syncRuntimeMetrics(): void {
    const runtime = this.buildRuntimeStatus()
    setActiveWorktrees(this.activeWorktrees.size)
    setActivePrReviews(runtime.activePrReviews)
    setInFlightIssueProcesses(runtime.inFlightIssueProcess)
    setInFlightPrReviews(runtime.inFlightPrReview)
    setStartupRecoveryPending(runtime.startupRecoveryPending)
    setEffectiveActiveTasks(runtime.effectiveActiveTasks)
    setNextPollDelaySeconds((this.readNextPollDelayMs() ?? 0) / 1000)
    setLastTransientLoopErrorAgeSeconds(runtime.lastTransientLoopErrorAgeSeconds ?? 0)
    setActiveLeases(runtime.activeLeaseCount)
    setLeaseHeartbeatAgeSeconds(runtime.oldestLeaseHeartbeatAgeSeconds)
    setStalledWorkers(runtime.stalledWorkerCount)
    setBlockedIssueResumes(runtime.blockedIssueResumeCount)
    setBlockedIssueResumeAgeSeconds(runtime.oldestBlockedIssueResumeAgeSeconds)
    setBlockedIssueResumeEscalations(runtime.blockedIssueResumeEscalationCount)
    setBlockedIssueResumeEscalationAgeSeconds(runtime.oldestBlockedIssueResumeEscalationAgeSeconds)
  }

  private getOldestLeaseHeartbeatAgeSeconds(): number {
    const ages = [...this.activeLeaseReaders.values()]
      .map((reader) => reader.readHeartbeatAgeSeconds())
      .filter((age) => Number.isFinite(age))

    if (ages.length === 0) return 0
    return Math.max(...ages)
  }

  private getLastTransientLoopErrorAgeSeconds(now = Date.now()): number | null {
    if (!this.lastTransientLoopErrorAt) return null
    return getIsoAgeSeconds(this.lastTransientLoopErrorAt, now)
  }

  private getOldestBlockedIssueResumeAgeSeconds(now = Date.now()): number {
    const ages = [...this.blockedIssueResumes.values()]
      .map((blocked) => getIsoAgeSeconds(blocked.since, now))
      .filter((age) => Number.isFinite(age))

    if (ages.length === 0) return 0
    return Math.max(...ages)
  }

  private getBlockedIssueResumeEscalationCount(): number {
    return [...this.blockedIssueResumes.values()]
      .filter((blocked) => blocked.escalationCount > 0)
      .length
  }

  private getOldestBlockedIssueResumeEscalationAgeSeconds(now = Date.now()): number {
    const ages = [...this.blockedIssueResumes.values()]
      .map((blocked) => blocked.lastEscalatedAt ? getIsoAgeSeconds(blocked.lastEscalatedAt, now) : null)
      .filter((age): age is number => age !== null && Number.isFinite(age))

    if (ages.length === 0) return 0
    return Math.max(...ages)
  }

  private getActiveLeaseDetails(now = Date.now()): ActiveLeaseRuntimeDetail[] {
    return [...this.activeLeaseReaders.values()]
      .map((reader) => {
        const lease = reader.readSnapshot()
        const heartbeatAgeSeconds = reader.readHeartbeatAgeSeconds()
        const progressAgeSeconds = getIsoAgeSeconds(lease.lastProgressAt, now)
        const expiresAt = Date.parse(lease.expiresAt)
        const expiresInSeconds = Number.isFinite(expiresAt)
          ? Math.max(0, Math.ceil((expiresAt - now) / 1000))
          : 0

        return {
          scope: reader.scope,
          targetNumber: reader.targetNumber,
          commentId: reader.commentId,
          issueNumber: lease.issueNumber ?? null,
          prNumber: lease.prNumber ?? null,
          machineId: lease.machineId,
          daemonInstanceId: lease.daemonInstanceId,
          branch: lease.branch ?? null,
          worktreeId: lease.worktreeId ?? null,
          phase: lease.phase,
          attempt: lease.attempt,
          status: lease.status,
          lastProgressKind: lease.lastProgressKind ?? null,
          heartbeatAgeSeconds,
          progressAgeSeconds,
          expiresInSeconds,
          adoptable: Number.isFinite(expiresAt) ? expiresAt <= now : false,
        } satisfies ActiveLeaseRuntimeDetail
      })
      .sort((left, right) => left.scope.localeCompare(right.scope) || left.targetNumber - right.targetNumber)
  }

  private getStalledWorkerDetails(now = Date.now()): StalledWorkerRuntimeDetail[] {
    return [...this.stalledWorkers.values()]
      .map((worker) => ({
        ...worker,
        durationSeconds: getIsoAgeSeconds(worker.since, now),
      }))
      .sort((left, right) => left.scope.localeCompare(right.scope) || left.targetNumber - right.targetNumber)
  }

  private getBlockedIssueResumeDetails(now = Date.now()): BlockedIssueResumeRuntimeDetail[] {
    return [...this.blockedIssueResumes.values()]
      .map((blocked) => ({
        ...blocked,
        durationSeconds: getIsoAgeSeconds(blocked.since, now),
        lastEscalationAgeSeconds: blocked.lastEscalatedAt
          ? getIsoAgeSeconds(blocked.lastEscalatedAt, now)
          : null,
      }))
      .sort((left, right) => left.issueNumber - right.issueNumber)
  }

  private syncBlockedIssueResumeEscalationState(
    issueNumber: number,
    prNumber: number | null,
    issueComments: IssueComment[],
  ): void {
    const existing = this.blockedIssueResumes.get(issueNumber)
    if (!existing) return

    const summary = summarizeBlockedIssueResumeEscalations(issueComments, issueNumber, prNumber)
    if (
      existing.escalationCount === summary.escalationCount
      && existing.lastEscalatedAt === summary.lastEscalatedAt
    ) {
      return
    }

    this.blockedIssueResumes.set(issueNumber, {
      ...existing,
      escalationCount: summary.escalationCount,
      lastEscalatedAt: summary.lastEscalatedAt,
    })
    this.syncRuntimeMetrics()
  }

  private async maybeEscalateBlockedIssueResume(
    issueNumber: number,
    prNumber: number | null,
    reason: string,
    issueComments: IssueComment[],
  ): Promise<void> {
    this.syncBlockedIssueResumeEscalationState(issueNumber, prNumber, issueComments)

    const existing = this.blockedIssueResumes.get(issueNumber)
    if (!existing) return

    if (!shouldEscalateBlockedIssueResume({
      blockedSince: existing.since,
      lastEscalatedAt: existing.lastEscalatedAt,
    })) {
      return
    }

    const now = new Date().toISOString()

    try {
      await commentOnIssue(issueNumber, buildBlockedIssueResumeEscalationComment({
        issueNumber,
        prNumber,
        blockedSince: existing.since,
        escalatedAt: now,
        thresholdSeconds: BLOCKED_ISSUE_RESUME_WARNING_AGE_SECONDS,
        reason,
        machineId: this.config.machineId,
        daemonInstanceId: this.daemonInstanceId,
      }), this.config)
      this.blockedIssueResumes.set(issueNumber, {
        ...existing,
        escalationCount: existing.escalationCount + 1,
        lastEscalatedAt: now,
      })
      this.noteRecoveryAction('issue-resume-blocked-escalated', 'completed', {
        scope: 'issue-process',
        targetNumber: issueNumber,
        reason,
      })
      this.logger.warn(
        `[daemon] issue #${issueNumber} remains blocked from auto-resume; posted GitHub escalation comment`
        + `${prNumber === null ? '' : ` (linked PR #${prNumber})`}`,
      )
    } catch (error) {
      this.noteRecoveryAction('issue-resume-blocked-escalated', 'failed', {
        scope: 'issue-process',
        targetNumber: issueNumber,
        reason: `${reason}; escalation comment failed: ${formatDaemonError(error)}`,
      })
      this.logger.warn(
        `[daemon] failed to publish blocked resume escalation for issue #${issueNumber}: ${formatDaemonError(error)}`,
      )
    }
  }
}

function shouldReviewManagedPr(pr: Pick<ManagedPullRequest, 'labels'>): boolean {
  const labels = new Set(pr.labels)
  if (labels.has(PR_REVIEW_LABELS.APPROVED)) return false
  if (labels.has(PR_REVIEW_LABELS.HUMAN_NEEDED)) return false
  return true
}

export function getResumableIssueLinkedPrHandoff(
  pr: Pick<ManagedPullRequest, 'labels'>,
  canResumeHumanNeededReview: boolean,
  hasSyncedBranchState: boolean,
): ResumableIssuePrHandoff | null {
  if (!hasSyncedBranchState) return null
  if (shouldMergeManagedPr(pr)) {
    return { kind: 'pr-merge' }
  }
  if (shouldReviewManagedPr(pr)) {
    return { kind: 'pr-review' }
  }

  const labels = new Set(pr.labels)
  if (labels.has(PR_REVIEW_LABELS.HUMAN_NEEDED) && canResumeHumanNeededReview) {
    return { kind: 'pr-review' }
  }

  return null
}

export function shouldResumeFailedIssueWithLinkedPr(
  pr: Pick<ManagedPullRequest, 'number' | 'labels'> | null,
  canResumeHumanNeededReview: boolean,
): boolean {
  return getFailedIssueResumeBlock(pr, canResumeHumanNeededReview) === null
}

export function getFailedIssueResumeBlock(
  pr: Pick<ManagedPullRequest, 'number' | 'labels'> | null,
  canResumeHumanNeededReview: boolean,
): { prNumber: number | null; reason: string } | null {
  if (!pr) return null
  if (shouldMergeManagedPr(pr)) return null
  if (shouldReviewManagedPr(pr)) return null

  const labels = new Set(pr.labels)
  if (labels.has(PR_REVIEW_LABELS.HUMAN_NEEDED)) {
    if (canResumeHumanNeededReview) return null
    return {
      prNumber: pr.number,
      reason: `linked PR #${pr.number} is in terminal ${PR_REVIEW_LABELS.HUMAN_NEEDED}; automated review has no remaining structured retry path`,
    }
  }

  return {
    prNumber: pr.number,
    reason: `linked PR #${pr.number} is not in a resumable automated state (${pr.labels.join(', ') || 'no agent labels'})`,
  }
}

export function shouldClearFailedIssueResumeTrackingAfterFinalize(
  status: 'completed' | 'failed' | 'recoverable',
): boolean {
  return status === 'failed'
}

export function buildBlockedIssueResumeEscalationComment(
  payload: BlockedIssueResumeEscalationComment,
): string {
  const linkedPr = payload.prNumber === null ? 'none' : `#${payload.prNumber}`
  return `${BLOCKED_ISSUE_RESUME_ESCALATION_COMMENT_PREFIX}${JSON.stringify(payload)} -->
## agent-loop blocked resume escalation

This issue is still blocked from automated resume and needs repo-side attention.

- Issue: #${payload.issueNumber}
- Linked PR: ${linkedPr}
- Blocked since: ${payload.blockedSince}
- Escalated at: ${payload.escalatedAt}
- Threshold: ${payload.thresholdSeconds}s
- Machine: ${payload.machineId}
- Daemon: ${payload.daemonInstanceId}

Reason:
- ${payload.reason}

Next step: clear or replace the linked PR state before expecting automatic issue resume.`
}

export function extractBlockedIssueResumeEscalationComment(
  body: string,
): BlockedIssueResumeEscalationComment | null {
  const match = body.match(/<!-- agent-loop:issue-resume-blocked (\{.*\}) -->/)
  if (!match?.[1]) return null

  try {
    const parsed = JSON.parse(match[1]) as Partial<BlockedIssueResumeEscalationComment>
    if (!parsed || typeof parsed !== 'object') return null
    if (!Number.isInteger(parsed.issueNumber) || typeof parsed.reason !== 'string') return null
    if (parsed.prNumber !== null && parsed.prNumber !== undefined && !Number.isInteger(parsed.prNumber)) return null
    if (typeof parsed.blockedSince !== 'string' || typeof parsed.escalatedAt !== 'string') return null
    if (typeof parsed.machineId !== 'string' || typeof parsed.daemonInstanceId !== 'string') return null
    if (!Number.isInteger(parsed.thresholdSeconds)) return null
    const issueNumber = parsed.issueNumber as number
    const thresholdSeconds = parsed.thresholdSeconds as number
    return {
      issueNumber,
      prNumber: parsed.prNumber ?? null,
      blockedSince: parsed.blockedSince,
      escalatedAt: parsed.escalatedAt,
      thresholdSeconds,
      reason: parsed.reason,
      machineId: parsed.machineId,
      daemonInstanceId: parsed.daemonInstanceId,
    }
  } catch {
    return null
  }
}

export function listBlockedIssueResumeEscalationComments(
  comments: IssueComment[],
  issueNumber: number,
  prNumber: number | null,
): BlockedIssueResumeEscalationRecord[] {
  return comments
    .map((comment) => {
      const escalation = extractBlockedIssueResumeEscalationComment(comment.body)
      if (!escalation) return null
      if (escalation.issueNumber !== issueNumber) return null
      if ((escalation.prNumber ?? null) !== prNumber) return null
      return {
        ...comment,
        escalation,
      } satisfies BlockedIssueResumeEscalationRecord
    })
    .filter((comment): comment is BlockedIssueResumeEscalationRecord => comment !== null)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
}

export function summarizeBlockedIssueResumeEscalations(
  comments: IssueComment[],
  issueNumber: number,
  prNumber: number | null,
): { escalationCount: number; lastEscalatedAt: string | null } {
  const matches = listBlockedIssueResumeEscalationComments(comments, issueNumber, prNumber)
  return {
    escalationCount: matches.length,
    lastEscalatedAt: matches[0]?.updatedAt ?? matches[0]?.createdAt ?? matches[0]?.escalation.escalatedAt ?? null,
  }
}

export function shouldEscalateBlockedIssueResume(input: {
  blockedSince: string
  lastEscalatedAt: string | null
  now?: number
  thresholdSeconds?: number
  cooldownSeconds?: number
}): boolean {
  const now = input.now ?? Date.now()
  const thresholdSeconds = input.thresholdSeconds ?? BLOCKED_ISSUE_RESUME_WARNING_AGE_SECONDS
  const cooldownSeconds = input.cooldownSeconds ?? BLOCKED_ISSUE_RESUME_ESCALATION_COOLDOWN_SECONDS

  if (getIsoAgeSeconds(input.blockedSince, now) < thresholdSeconds) return false
  if (input.lastEscalatedAt && getIsoAgeSeconds(input.lastEscalatedAt, now) < cooldownSeconds) return false
  return true
}

export function getEffectiveActiveTaskCount(input: {
  activeWorktreeCount: number
  hasInFlightProcess: boolean
  activePrReviewCount: number
  hasInFlightPrReview: boolean
}): number {
  const issueTaskCount = Math.max(input.activeWorktreeCount, input.hasInFlightProcess ? 1 : 0)
  const prTaskCount = Math.max(input.activePrReviewCount, input.hasInFlightPrReview ? 1 : 0)

  return issueTaskCount + prTaskCount
}

export function buildDaemonRuntimeStatus(input: {
  activeWorktreeCount: number
  activePrReviewCount: number
  hasInFlightProcess: boolean
  hasInFlightPrReview: boolean
  startupRecoveryPending: boolean
  transientLoopErrorCount: number
  startupRecoveryDeferredCount: number
  lastTransientLoopErrorAt: string | null
  lastTransientLoopErrorKind: string | null
  lastTransientLoopErrorMessage: string | null
  lastTransientLoopErrorAgeSeconds: number | null
  failedIssueResumeAttemptCount: number
  failedIssueResumeCooldownCount: number
  oldestBlockedIssueResumeAgeSeconds: number
  activeLeaseCount: number
  oldestLeaseHeartbeatAgeSeconds: number
  activeLeaseDetails: ActiveLeaseRuntimeDetail[]
  stalledWorkerCount: number
  stalledWorkerDetails: StalledWorkerRuntimeDetail[]
  blockedIssueResumeCount: number
  blockedIssueResumeEscalationCount: number
  blockedIssueResumeDetails: BlockedIssueResumeRuntimeDetail[]
  lastRecoveryActionAt: string | null
  lastRecoveryActionKind: string | null
  recentRecoveryActions: RecoveryActionRuntimeDetail[]
  oldestBlockedIssueResumeEscalationAgeSeconds: number
}): DaemonStatus['runtime'] {
  return {
    activePrReviews: input.activePrReviewCount,
    inFlightIssueProcess: input.hasInFlightProcess,
    inFlightPrReview: input.hasInFlightPrReview,
    startupRecoveryPending: input.startupRecoveryPending,
    transientLoopErrorCount: input.transientLoopErrorCount,
    startupRecoveryDeferredCount: input.startupRecoveryDeferredCount,
    lastTransientLoopErrorAt: input.lastTransientLoopErrorAt,
    lastTransientLoopErrorKind: input.lastTransientLoopErrorKind,
    lastTransientLoopErrorMessage: input.lastTransientLoopErrorMessage,
    lastTransientLoopErrorAgeSeconds: input.lastTransientLoopErrorAgeSeconds,
    effectiveActiveTasks: getEffectiveActiveTaskCount({
      activeWorktreeCount: input.activeWorktreeCount,
      hasInFlightProcess: input.hasInFlightProcess,
      activePrReviewCount: input.activePrReviewCount,
      hasInFlightPrReview: input.hasInFlightPrReview,
    }),
    failedIssueResumeAttemptsTracked: input.failedIssueResumeAttemptCount,
    failedIssueResumeCooldownsTracked: input.failedIssueResumeCooldownCount,
    oldestBlockedIssueResumeAgeSeconds: input.oldestBlockedIssueResumeAgeSeconds,
    activeLeaseCount: input.activeLeaseCount,
    oldestLeaseHeartbeatAgeSeconds: input.oldestLeaseHeartbeatAgeSeconds,
    activeLeaseDetails: input.activeLeaseDetails,
    stalledWorkerCount: input.stalledWorkerCount,
    stalledWorkerDetails: input.stalledWorkerDetails,
    blockedIssueResumeCount: input.blockedIssueResumeCount,
    blockedIssueResumeEscalationCount: input.blockedIssueResumeEscalationCount,
    blockedIssueResumeDetails: input.blockedIssueResumeDetails,
    lastRecoveryActionAt: input.lastRecoveryActionAt,
    lastRecoveryActionKind: input.lastRecoveryActionKind,
    recentRecoveryActions: input.recentRecoveryActions,
    oldestBlockedIssueResumeEscalationAgeSeconds: input.oldestBlockedIssueResumeEscalationAgeSeconds,
  }
}

function getIsoAgeSeconds(iso: string, now = Date.now()): number {
  const parsed = Date.parse(iso)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, Math.floor((now - parsed) / 1000))
}

async function readGitHeadRefOid(worktreePath: string): Promise<string> {
  const proc = Bun.spawn(['git', '-C', worktreePath, 'rev-parse', 'HEAD'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`git rev-parse HEAD failed in ${worktreePath}: ${(stderr || stdout).trim() || `exit ${exitCode}`}`)
  }

  return stdout.trim()
}

async function isWorktreeSyncedWithRemoteBranch(
  worktreePath: string,
  branch: string,
): Promise<boolean> {
  const statusResult = await runGitInWorktree(worktreePath, ['status', '--short'])
  if (statusResult.exitCode !== 0 || statusResult.stdout.trim()) return false

  const fetchResult = await runGitInWorktree(worktreePath, ['fetch', 'origin', branch])
  if (fetchResult.exitCode !== 0) return false

  const [headResult, remoteHeadResult] = await Promise.all([
    runGitInWorktree(worktreePath, ['rev-parse', 'HEAD']),
    runGitInWorktree(worktreePath, ['rev-parse', `origin/${branch}`]),
  ])
  if (headResult.exitCode !== 0 || remoteHeadResult.exitCode !== 0) return false

  return headResult.stdout.trim() === remoteHeadResult.stdout.trim()
}


export function isRetryableDaemonLoopError(error: unknown): boolean {
  const message = formatDaemonError(error).toLowerCase()
  return RETRYABLE_DAEMON_ERROR_PATTERNS.some((pattern) => message.includes(pattern))
}

export function shouldResumeManagedIssue(
  issue: Pick<AgentIssue, 'state'>,
  hasLocalWorktree: boolean,
  attempts: number,
  cooldownUntil: number,
  now: number,
  maxFailedIssueResumes: number,
): boolean {
  if (!hasLocalWorktree) return false

  if (issue.state === 'working' || issue.state === 'stale') {
    return true
  }

  if (issue.state !== 'failed') return false
  if (attempts >= maxFailedIssueResumes) return false
  if (cooldownUntil > now) return false

  return true
}

export function shouldRequeueFailedIssue(
  issue: Pick<AgentIssue, 'state' | 'updatedAt' | 'hasExecutableContract'>,
  hasLocalWorktree: boolean,
  hasOpenPr: boolean,
  now: number,
  cooldownMs: number,
): boolean {
  if (issue.state !== 'failed') return false
  if (hasLocalWorktree) return false
  if (hasOpenPr) return false
  if (!issue.hasExecutableContract) return false

  const updatedAtMs = Date.parse(issue.updatedAt)
  if (!Number.isFinite(updatedAtMs)) return true

  return updatedAtMs + cooldownMs <= now
}

export function shouldApplyStandaloneIssueTransition(
  issue: Pick<AgentIssue, 'state'> | null,
  nextLabel: typeof ISSUE_LABELS.DONE | typeof ISSUE_LABELS.FAILED | typeof ISSUE_LABELS.WORKING,
): boolean {
  if (!issue) return false
  if (issue.state === 'done') {
    return nextLabel === ISSUE_LABELS.DONE
  }

  return true
}

export function shouldResetLinkedPrToRetryOnIssueResume(prLabels: string[]): boolean {
  const labels = new Set(prLabels)
  return labels.has(PR_REVIEW_LABELS.HUMAN_NEEDED) || labels.has(PR_REVIEW_LABELS.FAILED)
}

export function getStandaloneIssueTransitionForReviewLabels(
  prLabels: string[],
  issue: Pick<AgentIssue, 'state'> | null,
): {
  nextLabel: typeof ISSUE_LABELS.FAILED | typeof ISSUE_LABELS.WORKING
  reasonSuffix: string
} | null {
  if (!issue || issue.state === 'done') return null

  const labels = new Set(prLabels)
  const desired = labels.has(PR_REVIEW_LABELS.HUMAN_NEEDED)
    ? {
        nextLabel: ISSUE_LABELS.FAILED,
        reasonSuffix: 'is in human-needed state on startup',
      }
    : labels.has(PR_REVIEW_LABELS.RETRY)
      ? {
          nextLabel: ISSUE_LABELS.WORKING,
          reasonSuffix: 'is retrying review on startup',
        }
      : labels.has(PR_REVIEW_LABELS.APPROVED)
        ? {
            nextLabel: ISSUE_LABELS.WORKING,
            reasonSuffix: 'is approved and awaiting merge on startup',
          }
        : labels.has(PR_REVIEW_LABELS.FAILED)
          ? {
              nextLabel: ISSUE_LABELS.FAILED,
              reasonSuffix: 'has a failed automated review on startup',
            }
          : null

  if (!desired) return null

  const issueAlreadyMatchesDesired =
    (desired.nextLabel === ISSUE_LABELS.WORKING && issue.state === 'working')
    || (desired.nextLabel === ISSUE_LABELS.FAILED && issue.state === 'failed')
  if (issueAlreadyMatchesDesired) {
    return null
  }

  return desired
}

function shouldMergeManagedPr(pr: Pick<ManagedPullRequest, 'labels'>): boolean {
  return new Set(pr.labels).has(PR_REVIEW_LABELS.APPROVED)
}

function findLinkedManagedPr(
  prs: ManagedPullRequest[],
  issueNumber: number,
  branch: string,
): ManagedPullRequest | null {
  return prs.find((pr) => pr.headRefName === branch)
    ?? prs.find((pr) => extractIssueNumberFromPrTitle(pr.title) === issueNumber)
    ?? null
}

function formatDaemonError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function buildAutoFixPushFailedReview(error: unknown): PrReviewResult {
  return {
    approved: false,
    canMerge: false,
    reason: `Auto-fix push failed: ${formatDaemonError(error)}`,
    reviewFailed: true,
  }
}

export function isMergeabilityFailure(message: string): boolean {
  const normalized = message.toLowerCase()
  return normalized.includes('not mergeable') || normalized.includes('merge conflict')
}

function buildPrMergeBlockedComment(prNumber: number, reason: string): string {
  return `<!-- agent-loop:pr-merge {"pr":${prNumber},"merged":false} -->
## Automated merge blocked — human intervention required

- Merge ready: yes
- Merge result: not merged
- Reason: ${reason}

Next step: stopping automation and leaving the PR open for a human.`
}

export function buildPrMergeRetryComment(
  prNumber: number,
  branch: string,
  baseBranch: string,
  reason: string,
): string {
  return `<!-- agent-loop:pr-merge {"pr":${prNumber},"merged":false,"action":"refresh-branch"} -->
## Automated merge blocked — refreshing branch and rerunning review

- Merge ready: yes
- Merge result: not merged
- Reason: ${reason}
- Recovery: first rebasing \`${branch}\` onto \`origin/${baseBranch}\`; if replaying branch history conflicts, rebuild the approved branch snapshot on top of \`origin/${baseBranch}\`, then rerun review and merge.

Next step: daemon will update the approved branch and retry the merge.`
}

async function createWorktreeFromRemoteBranch(
  worktreePath: string,
  branch: string,
  config: AgentConfig,
  logger = console,
): Promise<void> {
  if (existsSync(worktreePath)) return

  if (!existsSync(config.worktreesBase)) {
    mkdirSync(config.worktreesBase, { recursive: true })
  }

  const fetchResult = await runGitInRepo(['fetch', 'origin', branch])
  if (fetchResult.exitCode !== 0) {
    throw new Error(fetchResult.stderr || fetchResult.stdout || `git fetch origin ${branch} failed`)
  }

  const addResult = await runGitInRepo(['worktree', 'add', worktreePath, '-B', branch, `origin/${branch}`])
  if (addResult.exitCode !== 0) {
    throw new Error(addResult.stderr || addResult.stdout || `git worktree add ${worktreePath} -B ${branch} origin/${branch} failed`)
  }

  await runGitInWorktree(worktreePath, ['config', 'user.name', config.git.authorName])
  await runGitInWorktree(worktreePath, ['config', 'user.email', config.git.authorEmail])
  logger.log(`[worktree] adopted remote branch ${branch} into ${worktreePath}`)
}

async function restoreManagedWorktreeState(
  worktreePath: string,
  logger = console,
): Promise<void> {
  const cleanupCommands: Array<{ label: string; args: string[] }> = [
    { label: 'rebase', args: ['rebase', '--abort'] },
    { label: 'merge', args: ['merge', '--abort'] },
    { label: 'cherry-pick', args: ['cherry-pick', '--abort'] },
  ]

  for (const command of cleanupCommands) {
    const proc = Bun.spawn(['git', '-C', worktreePath, ...command.args], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited

    if (exitCode === 0) {
      logger.log(`[worktree] aborted in-progress ${command.label} in ${worktreePath}`)
      continue
    }

    const output = `${stdout}\n${stderr}`.toLowerCase()
    const benign =
      output.includes('no rebase in progress')
      || output.includes('no merge to abort')
      || output.includes('no cherry-pick or revert in progress')
      || output.includes('no cherry-pick in progress')
    if (!benign) {
      logger.warn(`[worktree] could not abort ${command.label} in ${worktreePath}: ${(stderr || stdout).trim()}`)
    }
  }
}

export async function rebaseManagedBranchOntoDefault(
  worktreePath: string,
  branch: string,
  defaultBranch: string,
  logger = console,
): Promise<{ success: true } | { success: false; message: string }> {
  await restoreManagedWorktreeState(worktreePath, logger)

  const fetchResult = await runGitInWorktree(worktreePath, ['fetch', 'origin', branch, defaultBranch])
  if (fetchResult.exitCode !== 0) {
    await restoreManagedWorktreeState(worktreePath, logger)
    return {
      success: false,
      message: fetchResult.stderr || fetchResult.stdout || `git fetch origin ${branch} ${defaultBranch} failed`,
    }
  }

  const checkoutResult = await runGitInWorktree(worktreePath, ['checkout', '-B', branch, `origin/${branch}`])
  if (checkoutResult.exitCode !== 0) {
    await restoreManagedWorktreeState(worktreePath, logger)
    return {
      success: false,
      message: checkoutResult.stderr || checkoutResult.stdout || `git checkout -B ${branch} origin/${branch} failed`,
    }
  }

  const approvedHead = (await runGitInWorktree(worktreePath, ['rev-parse', 'HEAD'])).stdout.trim()
  const rebaseResult = await runGitInWorktree(worktreePath, ['rebase', `origin/${defaultBranch}`])
  if (rebaseResult.exitCode === 0) {
    logger.log(`[worktree] rebased ${branch} onto origin/${defaultBranch} in ${worktreePath}`)
    return { success: true }
  }

  await restoreManagedWorktreeState(worktreePath, logger)
  logger.warn(
    `[worktree] rebase of ${branch} onto origin/${defaultBranch} failed; rebuilding branch snapshot instead`,
  )

  const rebuildResult = await rebuildManagedBranchFromSnapshot(
    worktreePath,
    branch,
    defaultBranch,
    approvedHead,
    logger,
  )
  if (!rebuildResult.success) {
    return rebuildResult
  }

  logger.log(`[worktree] rebuilt ${branch} on top of origin/${defaultBranch} in ${worktreePath}`)
  return { success: true }
}

async function runGitInWorktree(
  worktreePath: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['git', '-C', worktreePath, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  return { exitCode, stdout, stderr }
}

async function runGitInRepo(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['git', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  return { exitCode, stdout, stderr }
}

async function rebuildManagedBranchFromSnapshot(
  worktreePath: string,
  branch: string,
  defaultBranch: string,
  snapshotRef: string,
  logger = console,
): Promise<{ success: true } | { success: false; message: string }> {
  const resetToBase = await runGitInWorktree(worktreePath, ['checkout', '-B', branch, `origin/${defaultBranch}`])
  if (resetToBase.exitCode !== 0) {
    await restoreManagedWorktreeState(worktreePath, logger)
    return {
      success: false,
      message: resetToBase.stderr || resetToBase.stdout || `git checkout -B ${branch} origin/${defaultBranch} failed`,
    }
  }

  const mergeBaseResult = await runGitInWorktree(worktreePath, [
    'merge-base',
    `origin/${defaultBranch}`,
    snapshotRef,
  ])
  if (mergeBaseResult.exitCode !== 0) {
    await restoreManagedWorktreeState(worktreePath, logger)
    return {
      success: false,
      message: mergeBaseResult.stderr
        || mergeBaseResult.stdout
        || `git merge-base origin/${defaultBranch} ${snapshotRef} failed`,
    }
  }

  const mergeBase = mergeBaseResult.stdout.trim()
  const changedPathsResult = await runGitInWorktree(worktreePath, [
    'diff',
    '--name-only',
    '-z',
    mergeBase,
    snapshotRef,
  ])
  if (changedPathsResult.exitCode !== 0) {
    await restoreManagedWorktreeState(worktreePath, logger)
    return {
      success: false,
      message: changedPathsResult.stderr || changedPathsResult.stdout || `git diff --name-only ${mergeBase} ${snapshotRef} failed`,
    }
  }

  const changedPaths = changedPathsResult.stdout
    .split('\0')
    .map((path) => path.trim())
    .filter(Boolean)

  if (changedPaths.length > 0) {
    const restoreSnapshot = await runGitInWorktree(worktreePath, [
      'restore',
      '--source',
      snapshotRef,
      '--staged',
      '--worktree',
      '--',
      ...changedPaths,
    ])
    if (restoreSnapshot.exitCode !== 0) {
      await restoreManagedWorktreeState(worktreePath, logger)
      return {
        success: false,
        message: restoreSnapshot.stderr
          || restoreSnapshot.stdout
          || `git restore --source ${snapshotRef} failed while rebuilding branch snapshot`,
      }
    }
  }

  const statusResult = await runGitInWorktree(worktreePath, ['status', '--short'])
  if (statusResult.exitCode !== 0) {
    await restoreManagedWorktreeState(worktreePath, logger)
    return {
      success: false,
      message: statusResult.stderr || statusResult.stdout || 'git status --short failed after rebuilding branch snapshot',
    }
  }

  if (!statusResult.stdout.trim()) {
    logger.log(`[worktree] branch snapshot already matches origin/${defaultBranch}; no rebuild commit needed`)
    return { success: true }
  }

  const commitResult = await runGitInWorktreeWithConfig(
    worktreePath,
    ['commit', '-m', `chore(agent-loop): rebuild ${branch} atop ${defaultBranch}`],
    {
      'user.name': 'agent-loop',
      'user.email': 'agent-loop@local',
    },
  )
  if (commitResult.exitCode !== 0) {
    await restoreManagedWorktreeState(worktreePath, logger)
    return {
      success: false,
      message: commitResult.stderr || commitResult.stdout || 'git commit failed after rebuilding branch snapshot',
    }
  }

  return { success: true }
}

async function runGitInWorktreeWithConfig(
  worktreePath: string,
  args: string[],
  config: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const configArgs = Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${value}`])
  return runGitInWorktree(worktreePath, [...configArgs, ...args])
}
