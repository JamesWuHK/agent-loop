import { $ } from 'bun'
import { resolve } from 'node:path'
import type { AgentConfig, AgentIssue, DaemonStatus, ManagedPullRequest, WorktreeInfo } from '@agent/shared'
import { ISSUE_LABELS, PR_REVIEW_LABELS, listOpenAgentIssues, listOpenAgentPullRequests, transitionIssueState, commentOnPr, setManagedPrReviewLabels, mergePullRequest, checkPrExists, listIssueComments, resolveActiveClaimMachine } from '@agent/shared'
import { pollAndClaim } from './claimer'
import { createWorktree, removeWorktree, cleanupOrphanedWorktrees, hasWorktreeForIssue } from './worktree-manager'
import { runSubtaskExecutor, runReviewAutoFix, runIssueRecovery } from './subtask-executor'
import { createOrFindPr, pushBranch } from './pr-reporter'
import { createDetachedPrWorktree, extractIssueNumberFromPrTitle, reviewPr, buildPrReviewComment, buildReviewFeedback, extractAutomatedReviewReasons, type PrReviewResult } from './pr-reviewer'
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
  private _inFlightPrReview: Promise<void> | null = null
  private activePrReviews = new Set<number>()
  private static readonly MAX_REVIEW_FIX_RETRIES = 1
  private static readonly MAX_FAILED_ISSUE_RESUMES = 2
  private static readonly FAILED_ISSUE_RESUME_COOLDOWN_MS = 5 * 60 * 1000
  private failedIssueResumeAttempts = new Map<number, number>()
  private failedIssueResumeCooldownUntil = new Map<number, number>()

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
    await this.reconcileStandalonePrIssueStates()

    // Start HTTP health check server
    this.startHealthServer()

    this.running = true
    // Run first poll immediately; subsequent polls scheduled by pollCycle
    await this.pollCycle()
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

      const issue = issueMap.get(issueNumber)
      if (!issue) continue

      const labels = new Set(pr.labels)

      if (labels.has(PR_REVIEW_LABELS.HUMAN_NEEDED) && issue.state !== 'failed') {
        await this.transitionStandaloneIssue(
          issueNumber,
          ISSUE_LABELS.FAILED,
          `Recovered PR #${pr.number} is in human-needed state on startup`,
          pr.number,
        )
        continue
      }

      if (labels.has(PR_REVIEW_LABELS.RETRY) && issue.state === 'stale') {
        await this.transitionStandaloneIssue(
          issueNumber,
          ISSUE_LABELS.WORKING,
          `Recovered PR #${pr.number} is retrying review on startup`,
          pr.number,
        )
        continue
      }

      if (labels.has(PR_REVIEW_LABELS.APPROVED) && issue.state === 'stale') {
        await this.transitionStandaloneIssue(
          issueNumber,
          ISSUE_LABELS.WORKING,
          `Recovered PR #${pr.number} is approved and awaiting merge on startup`,
          pr.number,
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
    if (this._inFlightPrReview) {
      await this._inFlightPrReview
      this._inFlightPrReview = null
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
        }
      })

    this._inFlightProcess = processPromise

    this.scheduleNextPoll()
  }

  private async maybeStartStandalonePrReview(): Promise<boolean> {
    if (this._inFlightPrReview) return false

    const pendingPr = await this.findPendingStandalonePrReview()
    if (!pendingPr) return false

    this.activePrReviews.add(pendingPr.number)
    const reviewPromise = this.processStandalonePrReview(pendingPr)
      .catch((err) => {
        this.logger.error(`[pr-review-subagent] PR #${pendingPr.number} threw:`, err)
      })
      .finally(() => {
        this.activePrReviews.delete(pendingPr.number)
        if (this._inFlightPrReview === reviewPromise) {
          this._inFlightPrReview = null
        }
      })

    this._inFlightPrReview = reviewPromise
    return true
  }

  private async maybeStartStandaloneApprovedPrMerge(): Promise<boolean> {
    if (this._inFlightPrReview) return false

    const pendingPr = await this.findPendingStandaloneApprovedPrMerge()
    if (!pendingPr) return false

    this.activePrReviews.add(pendingPr.number)
    const mergePromise = this.processStandaloneApprovedPrMerge(pendingPr)
      .catch((err) => {
        this.logger.error(`[pr-merge-subagent] PR #${pendingPr.number} threw:`, err)
      })
      .finally(() => {
        this.activePrReviews.delete(pendingPr.number)
        if (this._inFlightPrReview === mergePromise) {
          this._inFlightPrReview = null
        }
      })

    this._inFlightPrReview = mergePromise
    return true
  }

  private async maybeStartResumableIssue(): Promise<boolean> {
    if (this._inFlightProcess) return false

    const resumableIssue = await this.findResumableIssue()
    if (!resumableIssue) return false

    const processPromise = this.processResumableIssue(resumableIssue)
      .catch((err) => {
        this.logger.error(`[daemon] processResumableIssue #${resumableIssue.number} threw:`, err)
      })
      .finally(() => {
        if (this._inFlightProcess === processPromise) {
          this._inFlightProcess = null
        }
      })

    this._inFlightProcess = processPromise
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

  private async findResumableIssue(): Promise<AgentIssue | null> {
    const issues = await listOpenAgentIssues(this.config)
    const now = Date.now()

    for (const issue of issues) {
      const attempts = this.failedIssueResumeAttempts.get(issue.number) ?? 0
      const cooldownUntil = this.failedIssueResumeCooldownUntil.get(issue.number) ?? 0
      const resumable = shouldResumeManagedIssue(
        issue,
        hasWorktreeForIssue(issue.number, this.config),
        attempts,
        cooldownUntil,
        now,
        AgentDaemon.MAX_FAILED_ISSUE_RESUMES,
      )
      if (!resumable) continue

      const activeClaimMachine = await this.getActiveClaimMachine(issue.number)
      if (activeClaimMachine && activeClaimMachine !== this.config.machineId) {
        this.logger.log(`[daemon] skipping local resume for #${issue.number}; active machine is ${activeClaimMachine}`)
        continue
      }

      return issue
    }

    return null
  }

  private async getActiveClaimMachine(issueNumber: number): Promise<string | null> {
    const comments = await listIssueComments(issueNumber, this.config)
    return resolveActiveClaimMachine(comments)
  }

  private async findPendingStandaloneApprovedPrMerge(): Promise<ManagedPullRequest | null> {
    const prs = await listOpenAgentPullRequests(this.config)
    return prs.find((pr) => {
      if (pr.isDraft) return false
      if (this.activePrReviews.has(pr.number)) return false
      return shouldMergeManagedPr(pr)
    }) ?? null
  }

  private async findPendingStandalonePrReview(): Promise<ManagedPullRequest | null> {
    const prs = await listOpenAgentPullRequests(this.config)
    return prs.find((pr) => {
      if (pr.isDraft) return false
      if (this.activePrReviews.has(pr.number)) return false
      return shouldReviewManagedPr(pr)
    }) ?? null
  }

  private async processStandalonePrReview(pr: ManagedPullRequest): Promise<void> {
    this.logger.log(`[pr-review-subagent] reviewing existing PR #${pr.number}: "${pr.title}"`)

    const detached = await createDetachedPrWorktree(pr.number, this.config, this.logger)
    try {
      const firstReview = await reviewPr(
        pr.number,
        pr.url,
        detached.worktreePath,
        this.config,
        this.logger,
      )

      if (firstReview.approved && firstReview.canMerge) {
        await commentOnPr(pr.number, buildPrReviewComment(pr.number, firstReview, 1, 'approved'), this.config)
        await setManagedPrReviewLabels(pr.number, 'approved', this.config)
        this.logger.log(`[pr-review-subagent] approved PR #${pr.number}`)
        return
      }

      const issueNumber = extractIssueNumberFromPrTitle(pr.title)

      if (firstReview.reviewFailed) {
        await commentOnPr(pr.number, buildPrReviewComment(pr.number, firstReview, 1, 'human-needed'), this.config)
        await setManagedPrReviewLabels(pr.number, 'human-needed', this.config)
        if (issueNumber !== null) {
          await this.transitionStandaloneIssue(issueNumber, ISSUE_LABELS.FAILED, firstReview.reason)
        }
        this.logger.warn(`[pr-review-subagent] PR #${pr.number} produced an invalid review payload; stopping before auto-fix`)
        return
      }

      if (issueNumber === null) {
        await commentOnPr(pr.number, buildPrReviewComment(pr.number, firstReview, 1, 'human-needed'), this.config)
        await setManagedPrReviewLabels(pr.number, 'human-needed', this.config)
        this.logger.warn(`[pr-review-subagent] PR #${pr.number} rejected without auto-fix: could not infer issue number`)
        return
      }

      await commentOnPr(pr.number, buildPrReviewComment(pr.number, firstReview, 1, 'retrying'), this.config)
      await setManagedPrReviewLabels(pr.number, 'retry', this.config)
      const fixResult = await runReviewAutoFix(
        detached.worktreePath,
        issueNumber,
        pr.number,
        pr.url,
        buildReviewFeedback(firstReview),
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
        await commentOnPr(pr.number, buildPrReviewComment(pr.number, failedReview, 2, 'human-needed'), this.config)
        await setManagedPrReviewLabels(pr.number, 'human-needed', this.config)
        await this.transitionStandaloneIssue(issueNumber, ISSUE_LABELS.FAILED, `Standalone PR auto-fix failed: ${failedReview.reason}`)
        this.logger.warn(`[pr-review-subagent] PR #${pr.number} needs human intervention after failed auto-fix`)
        return
      }

      await pushBranch(detached.worktreePath, pr.headRefName, this.logger)
      this.logger.log(`[pr-review-subagent] pushed auto-fix commit to ${pr.headRefName}`)
      const secondReview = await reviewPr(
        pr.number,
        pr.url,
        detached.worktreePath,
        this.config,
        this.logger,
      )

      if (secondReview.approved && secondReview.canMerge) {
        await commentOnPr(pr.number, buildPrReviewComment(pr.number, secondReview, 2, 'approved'), this.config)
        await setManagedPrReviewLabels(pr.number, 'approved', this.config)
        this.logger.log(`[pr-review-subagent] approved PR #${pr.number} after auto-fix`)
        return
      }

      await commentOnPr(pr.number, buildPrReviewComment(pr.number, secondReview, 2, 'human-needed'), this.config)
      await setManagedPrReviewLabels(pr.number, 'human-needed', this.config)
      await this.transitionStandaloneIssue(issueNumber, ISSUE_LABELS.FAILED, secondReview.reason)
      this.logger.warn(`[pr-review-subagent] PR #${pr.number} still blocked after auto-fix`)
    } finally {
      await detached.cleanup()
    }
  }

  private async processStandaloneApprovedPrMerge(pr: ManagedPullRequest): Promise<void> {
    this.logger.log(`[pr-merge-subagent] attempting merge for approved PR #${pr.number}: "${pr.title}"`)

    const detached = await createDetachedPrWorktree(pr.number, this.config, this.logger)
    try {
      const mergeResult = await this.attemptApprovedPrMergeWithRecovery(
        pr.number,
        pr.url,
        pr.headRefName,
        detached.worktreePath,
      )
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
    } finally {
      await detached.cleanup()
    }
  }

  private async transitionStandaloneIssue(
    issueNumber: number,
    nextLabel: typeof ISSUE_LABELS.DONE | typeof ISSUE_LABELS.FAILED | typeof ISSUE_LABELS.WORKING,
    reason: string,
    prNumber?: number,
  ): Promise<void> {
    const issues = await listOpenAgentIssues(this.config)
    const issue = issues.find((candidate) => candidate.number === issueNumber)
    if (!issue) return

    const currentLabel =
      issue.state === 'working' ? ISSUE_LABELS.WORKING
        : issue.state === 'claimed' ? ISSUE_LABELS.CLAIMED
          : issue.state === 'stale' ? ISSUE_LABELS.STALE
            : issue.state === 'failed' ? ISSUE_LABELS.FAILED
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

  private async processResumableIssue(issue: AgentIssue): Promise<void> {
    const issueNumber = issue.number
    const processingStartTime = Date.now()
    const branch = `agent/${issueNumber}/${this.config.machineId}`
    const worktreePath = resolve(this.config.worktreesBase, `issue-${issueNumber}-${this.config.machineId}`)

    this.logger.log(`[daemon] resuming ${issue.state} issue #${issueNumber}: "${issue.title}"`)

    try {
      if (issue.state === 'failed') {
        await transitionIssueState(
          issueNumber,
          ISSUE_LABELS.WORKING,
          ISSUE_LABELS.FAILED,
          {
            event: 'claimed',
            machine: this.config.machineId,
            ts: new Date().toISOString(),
            reason: 'resume-existing-worktree',
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
            reason: 'resume-existing-worktree',
          },
          this.config,
        )
      }

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

      await restoreManagedWorktreeState(worktreePath, this.logger)

      const prCheck = await checkPrExists(branch, this.config)
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
      )

      if (!recoveryResult.success) {
        await this.markIssueFailed(issueNumber, recoveryResult.error)
        this.registerFailedIssueResume(issueNumber)
        this.logger.error(`[daemon] resumed issue #${issueNumber} failed again: ${recoveryResult.error}`)
        recordIssueProcessingDuration(Date.now() - processingStartTime)
        return
      }

      const finalized = await this.finalizeIssueFromBranch(issue, worktreePath, branch)
      if (finalized) {
        this.failedIssueResumeAttempts.delete(issueNumber)
        this.failedIssueResumeCooldownUntil.delete(issueNumber)
      } else {
        this.registerFailedIssueResume(issueNumber)
      }
      recordIssueProcessingDuration(Date.now() - processingStartTime)
    } catch (err) {
      this.logger.error(`[daemon] failed to resume issue #${issueNumber}:`, err)
      this.registerFailedIssueResume(issueNumber)

      try {
        await this.markIssueFailed(issueNumber, String(err))
      } catch {
        // ignore
      }

      this.activeWorktrees.delete(issueNumber)
      setActiveWorktrees(this.activeWorktrees.size)
      recordIssueProcessingDuration(Date.now() - processingStartTime)
    }
  }

  private async attemptApprovedPrMergeWithRecovery(
    prNumber: number,
    prUrl: string,
    branch: string,
    worktreePath: string,
  ): Promise<{ merged: boolean; message: string; sha?: string; review?: PrReviewResult }> {
    const mergeResult = await mergePullRequest(prNumber, this.config)
    if (mergeResult.merged) {
      return mergeResult
    }

    if (!isMergeabilityFailure(mergeResult.message)) {
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
      const blockedResult = {
        merged: false,
        message: `Branch refresh failed: ${refreshResult.message}`,
      }
      await commentOnPr(prNumber, buildPrMergeBlockedComment(prNumber, blockedResult.message), this.config)
      await setManagedPrReviewLabels(prNumber, 'human-needed', this.config)
      return blockedResult
    }

    await pushBranch(worktreePath, branch, this.logger)
    const review = await this.runDetachedPrReview(prNumber, prUrl)

    if (!(review.approved && review.canMerge)) {
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
      return {
        ...retriedMergeResult,
        review,
      }
    }

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
  }

  private async reviewAndPossiblyAutoFix(
    issue: AgentIssue,
    worktreePath: string,
    branch: string,
    prNumber: number,
    prUrl: string,
  ): Promise<{ approved: boolean; review: PrReviewResult }> {
    const firstReview = await this.runDetachedPrReview(prNumber, prUrl)
    await commentOnPr(
      prNumber,
      buildPrReviewComment(
        prNumber,
        firstReview,
        1,
        firstReview.approved && firstReview.canMerge
          ? 'approved'
          : firstReview.reviewFailed
            ? 'human-needed'
            : 'retrying',
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

    const fixResult = await runReviewAutoFix(
      worktreePath,
      issue.number,
      prNumber,
      prUrl,
      buildReviewFeedback(firstReview),
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
    const secondReview = await this.runDetachedPrReview(prNumber, prUrl)

    if (secondReview.approved && secondReview.canMerge) {
      await commentOnPr(prNumber, buildPrReviewComment(prNumber, secondReview, 2, 'approved'), this.config)
      await setManagedPrReviewLabels(prNumber, 'approved', this.config)
      return { approved: true, review: secondReview }
    }

    await commentOnPr(prNumber, buildPrReviewComment(prNumber, secondReview, 2, 'human-needed'), this.config)
    await setManagedPrReviewLabels(prNumber, 'human-needed', this.config)
    return { approved: false, review: secondReview }
  }

  private async runDetachedPrReview(prNumber: number, prUrl: string): Promise<PrReviewResult> {
    const detached = await createDetachedPrWorktree(prNumber, this.config, this.logger)
    try {
      return await reviewPr(prNumber, prUrl, detached.worktreePath, this.config, this.logger)
    } finally {
      await detached.cleanup()
    }
  }

  private async finalizeIssueFromBranch(
    issue: AgentIssue,
    worktreePath: string,
    branch: string,
  ): Promise<boolean> {
    const pr = await createOrFindPr(worktreePath, branch, issue.number, issue.title, this.config, this.logger)
    const reviewOutcome = await this.reviewAndPossiblyAutoFix(
      issue,
      worktreePath,
      branch,
      pr.prNumber,
      pr.prUrl,
    )

    if (reviewOutcome.approved) {
      const mergeResult = await this.attemptApprovedPrMergeWithRecovery(
        pr.prNumber,
        pr.prUrl,
        branch,
        worktreePath,
      )

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
        setActiveWorktrees(this.activeWorktrees.size)
        return false
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
      setActiveWorktrees(this.activeWorktrees.size)
      return true
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
    setActiveWorktrees(this.activeWorktrees.size)
    return false
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
    setActiveWorktrees(this.activeWorktrees.size)
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
        await this.finalizeIssueFromBranch(issue, worktreePath, branch)
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

function shouldReviewManagedPr(pr: ManagedPullRequest): boolean {
  const labels = new Set(pr.labels)
  if (labels.has(PR_REVIEW_LABELS.APPROVED)) return false
  if (labels.has(PR_REVIEW_LABELS.HUMAN_NEEDED)) return false
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

export function shouldResumeManagedIssue(
  issue: Pick<AgentIssue, 'state'>,
  hasLocalWorktree: boolean,
  attempts: number,
  cooldownUntil: number,
  now: number,
  maxFailedIssueResumes: number,
): boolean {
  if (!hasLocalWorktree) return false

  if (issue.state === 'working') {
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

function shouldMergeManagedPr(pr: ManagedPullRequest): boolean {
  return new Set(pr.labels).has(PR_REVIEW_LABELS.APPROVED)
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
