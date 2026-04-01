import type { AgentConfig, AgentIssue, DaemonStatus, WorktreeInfo } from '@agent/shared'
import { ISSUE_LABELS, listOpenAgentIssues, transitionIssueState, commentOnPr, setManagedPrReviewLabels } from '@agent/shared'
import { pollAndClaim } from './claimer'
import { createWorktree, removeWorktree, cleanupOrphanedWorktrees, hasWorktreeForIssue } from './worktree-manager'
import { runSubtaskExecutor, runReviewAutoFix } from './subtask-executor'
import { createOrFindPr, pushBranch } from './pr-reporter'
import { reviewPr, buildPrReviewComment, type PrReviewResult } from './pr-reviewer'
import {
  recordPoll,
  recordPollDuration,
  recordIssueProcessed,
  recordIssueProcessingDuration,
  recordPrCreated,
  setActiveWorktrees,
  setConcurrencyLimit,
  setDaemonUptime,
  startMetricsServer,
  METRICS_PORT_DEFAULT,
  type MetricsServer,
} from './metrics'

export interface HealthServerConfig {
  host: string
  port: number
}

const DEFAULT_HEALTH_SERVER_PORT = 9310
const DEFAULT_HEALTH_SERVER_HOST = '127.0.0.1'

export class AgentDaemon {
  private running = false
  private shutdownRequested = false
  private activeWorktrees = new Map<number, WorktreeInfo>()
  private startedAt = Date.now()
  private lastPollAt: string | null = null
  private lastClaimedAt: string | null = null
  private pollTimeoutId: ReturnType<typeof setTimeout> | null = null
  private healthServer: ReturnType<typeof Bun.serve> | null = null
  private healthServerConfig: HealthServerConfig = {
    host: DEFAULT_HEALTH_SERVER_HOST,
    port: DEFAULT_HEALTH_SERVER_PORT,
  }
  private metricsServer: MetricsServer | null = null
  private metricsPort: number
  private _inFlightProcess: Promise<void> | null = null
  private static readonly MAX_REVIEW_FIX_RETRIES = 1

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

  async start(): Promise<void> {
    this.logger.log(`[daemon] starting agent-loop v0.1.0`)
    this.logger.log(`[daemon] machineId: ${this.config.machineId}`)
    this.logger.log(`[daemon] repo: ${this.config.repo}`)
    this.logger.log(`[daemon] concurrency: ${this.config.concurrency}`)
    this.logger.log(`[daemon] poll interval: ${this.config.pollIntervalMs}ms`)

    // Set initial metrics
    setConcurrencyLimit(this.config.concurrency)
    setActiveWorktrees(0)

    // Start metrics server
    this.metricsServer = await startMetricsServer(this.metricsPort, this.logger)

    // Clean up orphaned worktrees from previous runs
    await cleanupOrphanedWorktrees(this.config)

    // Recover zombie issues: working/claimed issues that lost their local worktree
    await this.reconcileIssueStates()

    // Start HTTP health check server
    this.startHealthServer()

    this.running = true
    // Run first poll immediately; subsequent polls scheduled by pollCycle
    await this.pollCycle()
  }

  /**
   * Recover zombie issues: if an issue is working/claimed but the local worktree
   * is gone (crash, manual cleanup, etc.), mark it stale so it can be retried.
   * Only reconciles issues owned by this machineId.
   */
  private async reconcileIssueStates(): Promise<void> {
    const issues = await listOpenAgentIssues(this.config)

    for (const issue of issues) {
      // Only act on working/claimed issues from this machine
      if (issue.state !== 'working' && issue.state !== 'claimed') continue
      if (issue.assignee !== this.config.machineId && issue.assignee !== null) continue

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

  private startHealthServer(): void {
    const { host, port } = this.healthServerConfig

    this.healthServer = Bun.serve({
      hostname: host,
      port,
      fetch: (request) => {
        const url = new URL(request.url)

        if (request.method === 'GET' && url.pathname === '/health') {
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
    }

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
    this.logger.log(`[daemon] stopped. Worktrees preserved for debugging.`)
  }

  getStatus(): DaemonStatus {
    return {
      running: this.running,
      machineId: this.config.machineId,
      repo: this.config.repo,
      pollIntervalMs: this.config.pollIntervalMs,
      concurrency: this.config.concurrency,
      activeWorktrees: Array.from(this.activeWorktrees.values()),
      lastPollAt: this.lastPollAt,
      lastClaimedAt: this.lastClaimedAt,
      uptimeMs: Date.now() - this.startedAt,
      pid: process.pid,
    }
  }

  /** Wait for any in-flight issue processing to complete (used by --once mode). */
  async waitForInFlightProcess(): Promise<void> {
    if (this._inFlightProcess) {
      await this._inFlightProcess
      this._inFlightProcess = null
    }
  }

  private scheduleNextPoll(): void {
    if (this.shutdownRequested) return

    this.pollTimeoutId = setTimeout(
      () => { this.pollCycle().catch(err => this.logger.error('[daemon] poll error:', err)) },
      this.config.pollIntervalMs,
    )
  }

  private async pollCycle(): Promise<void> {
    if (this.shutdownRequested || !this.running) return

    const pollStartTime = Date.now()
    this.lastPollAt = new Date().toISOString()
    this.logger.log(`[daemon] poll cycle at ${this.lastPollAt}`)

    // Update uptime metric
    setDaemonUptime((Date.now() - this.startedAt) / 1000)

    // Check concurrency limit
    if (this.activeWorktrees.size >= this.config.concurrency) {
      this.logger.log(`[daemon] at concurrency limit (${this.activeWorktrees.size}/${this.config.concurrency}), skipping`)
      recordPoll('skipped_concurrency')
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
    this._inFlightProcess = this.processIssue(claimedIssue).catch((err) => {
      this.logger.error(`[daemon] processIssue #${claimedIssue.number} threw:`, err)
    })

    this.scheduleNextPoll()
  }

  private async reviewAndPossiblyAutoFix(
    issue: AgentIssue,
    worktreePath: string,
    branch: string,
    prNumber: number,
    prUrl: string,
  ): Promise<{ approved: boolean; review: PrReviewResult }> {
    const firstReview = await reviewPr(prNumber, prUrl, this.config, this.logger)
    await commentOnPr(prNumber, buildPrReviewComment(prNumber, firstReview, 1, firstReview.approved && firstReview.canMerge ? 'approved' : 'retrying'), this.config)

    if (firstReview.approved && firstReview.canMerge) {
      await setManagedPrReviewLabels(prNumber, 'approved', this.config)
      return { approved: true, review: firstReview }
    }

    await setManagedPrReviewLabels(prNumber, 'retry', this.config)

    const fixResult = await runReviewAutoFix(
      worktreePath,
      issue.number,
      prNumber,
      prUrl,
      firstReview.reason,
      this.config,
      this.logger,
    )

    if (!fixResult.success) {
      const failedReview: PrReviewResult = {
        approved: false,
        canMerge: false,
        reason: `Auto-fix failed: ${fixResult.error ?? 'unknown error'}`,
        reviewFailed: true,
      }
      await commentOnPr(prNumber, buildPrReviewComment(prNumber, failedReview, 2, 'human-needed'), this.config)
      await setManagedPrReviewLabels(prNumber, 'human-needed', this.config)
      return { approved: false, review: failedReview }
    }

    await pushBranch(worktreePath, branch, this.logger)
    const secondReview = await reviewPr(prNumber, prUrl, this.config, this.logger)

    if (secondReview.approved && secondReview.canMerge) {
      await commentOnPr(prNumber, buildPrReviewComment(prNumber, secondReview, 2, 'approved'), this.config)
      await setManagedPrReviewLabels(prNumber, 'approved', this.config)
      return { approved: true, review: secondReview }
    }

    await commentOnPr(prNumber, buildPrReviewComment(prNumber, secondReview, 2, 'human-needed'), this.config)
    await setManagedPrReviewLabels(prNumber, 'human-needed', this.config)
    return { approved: false, review: secondReview }
  }

  private async processIssue(issue: AgentIssue): Promise<void> {
    const issueNumber = issue.number
    const processingStartTime = Date.now()
    this.logger.log(`[daemon] processing issue #${issueNumber}: "${issue.title}"`)

    const branch = `agent/${issueNumber}/${this.config.machineId}`

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
      const worktreeStartTime = Date.now()
      const worktreePath = await createWorktree(issueNumber, this.config)

      const wt: WorktreeInfo = {
        path: worktreePath,
        issueNumber,
        machineId: this.config.machineId,
        branch,
        state: 'active',
        createdAt: new Date().toISOString(),
      }
      this.activeWorktrees.set(issueNumber, wt)
      setActiveWorktrees(this.activeWorktrees.size)

      // Run planning agent + subtask loop
      const result = await runSubtaskExecutor(
        worktreePath,
        issueNumber,
        issue.title,
        issue.body,
        this.config,
        this.logger,
      )

      if (result.success) {
        const pr = await createOrFindPr(worktreePath, branch, issueNumber, issue.title, this.config, this.logger)
        const reviewOutcome = await this.reviewAndPossiblyAutoFix(
          issue,
          worktreePath,
          branch,
          pr.prNumber,
          pr.prUrl,
        )

        if (reviewOutcome.approved) {
          await transitionIssueState(
            issueNumber,
            ISSUE_LABELS.DONE,
            ISSUE_LABELS.WORKING,
            {
              event: 'done',
              machine: this.config.machineId,
              ts: new Date().toISOString(),
              prNumber: pr.prNumber,
              prReview: reviewOutcome.review,
            },
            this.config,
          )

          const doneCount = result.subtasks.filter(s => s.status === 'done').length
          this.logger.log(`[daemon] issue #${issueNumber} done! ${doneCount}/${result.subtasks.length} subtasks, PR: #${pr.prNumber}`)
          recordIssueProcessed('done')
          recordPrCreated()

          await removeWorktree(worktreePath, branch)
          this.activeWorktrees.delete(issueNumber)
          setActiveWorktrees(this.activeWorktrees.size)
        } else {
          await transitionIssueState(
            issueNumber,
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

          this.logger.error(`[daemon] issue #${issueNumber} failed review and needs human intervention: PR #${pr.prNumber}`)
          recordIssueProcessed('failed')
          this.activeWorktrees.delete(issueNumber)
          setActiveWorktrees(this.activeWorktrees.size)
        }
      } else {
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
        this.activeWorktrees.delete(issueNumber)
        setActiveWorktrees(this.activeWorktrees.size)
      }

      recordIssueProcessingDuration(Date.now() - processingStartTime)
    } catch (err) {
      this.logger.error(`[daemon] failed to process issue #${issueNumber}:`, err)
      recordIssueProcessed('error')
      setActiveWorktrees(this.activeWorktrees.size)

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

      this.activeWorktrees.delete(issueNumber)
      setActiveWorktrees(this.activeWorktrees.size)
      recordIssueProcessingDuration(Date.now() - processingStartTime)
    }
  }
}
