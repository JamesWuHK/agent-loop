import type { AgentConfig, BranchPullRequestRecord, PrCheckResult, PrLineageMetadata } from '@agent/shared'
import { checkPrExists, closePullRequest, commentOnPr, createPr, listBranchPullRequests } from '@agent/shared'
import {
  buildPrLineageMetadata,
  buildSupersededPrComment,
  choosePrLifecycleAction,
  renderPrLineageMetadataComment,
} from './pr-lineage'

interface GitCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

interface PushBranchDependencies {
  runGit: (
    worktreePath: string,
    args: string[],
  ) => Promise<GitCommandResult>
  beforePushAttempt?: (input: {
    worktreePath: string
    branch: string
    attempt: number
    pushArgs: string[]
  }) => Promise<void> | void
}

const MAX_PUSH_ATTEMPTS = 3

interface ManagedBranchPushPlan {
  pushArgs: string[] | null
  detachedHead: boolean
}

interface CreateOrFindPrDependencies {
  createPr?: typeof createPr
  pushBranch?: typeof pushBranch
  resolvePrLineageContext?: typeof resolvePrLineageContext
  listBranchPullRequests?: typeof listBranchPullRequests
  commentOnPr?: typeof commentOnPr
  closePullRequest?: typeof closePullRequest
  prepareReplacementBranch?: typeof prepareReplacementBranch
}

export type CreateOrFindPrResult =
  | {
      kind: 'reused' | 'created'
      prNumber: number
      prUrl: string
      branch: string
    }
  | {
      kind: 'terminal'
      prNumber: number
      prUrl: string
      prState: 'closed' | 'merged'
      replacementNeeded: true
      branch: string
    }

export function hasReusableOpenPr(
  prCheck: Pick<PrCheckResult, 'prNumber' | 'prState'>,
): prCheck is Pick<PrCheckResult, 'prState'> & { prNumber: number; prState: 'open' } {
  return prCheck.prNumber !== null && prCheck.prState === 'open'
}

export async function pushBranch(
  worktreePath: string,
  branch: string,
  logger = console,
  dependencies: PushBranchDependencies = { runGit },
): Promise<void> {
  let lastError = `Failed to push ${branch}`

  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
    const { pushArgs, detachedHead } = await syncBranchWithRemote(worktreePath, branch, logger, dependencies.runGit)
    if (pushArgs === null) {
      logger.log(detachedHead
        ? `[pr] remote branch ${branch} is already ahead of detached HEAD; no push needed`
        : `[pr] branch ${branch} is already in sync with origin`)
      return
    }

    await dependencies.beforePushAttempt?.({ worktreePath, branch, attempt, pushArgs })

    const push = await dependencies.runGit(worktreePath, pushArgs)
    if (push.exitCode === 0) {
      logger.log(`[pr] pushed branch ${branch}`)
      return
    }

    lastError = push.stderr || push.stdout || `Failed to push ${branch}`
    if (attempt >= MAX_PUSH_ATTEMPTS || !isRetryableManagedBranchPushFailure(lastError)) {
      throw new Error(lastError)
    }

    logger.warn(
      `[pr] push of ${branch} hit a managed-branch race on attempt ${attempt}; refetching and retrying`,
    )
  }

  throw new Error(lastError)
}

async function syncBranchWithRemote(
  worktreePath: string,
  branch: string,
  logger = console,
  gitRunner: PushBranchDependencies['runGit'] = runGit,
): Promise<ManagedBranchPushPlan> {
  const detachedHead = await isDetachedHead(worktreePath, gitRunner)
  const pushRef = detachedHead ? `HEAD:refs/heads/${branch}` : branch

  await gitRunner(worktreePath, ['fetch', 'origin', branch])

  const remoteExists = await gitRunner(worktreePath, ['rev-parse', '--verify', `origin/${branch}`])
  if (remoteExists.exitCode !== 0) {
    return { pushArgs: ['push', '-u', 'origin', pushRef], detachedHead }
  }

  const counts = await gitRunner(worktreePath, ['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`])
  if (counts.exitCode !== 0) {
    throw new Error(counts.stderr || counts.stdout || `Failed to compare ${branch} with origin/${branch}`)
  }

  const [behindText, aheadText] = counts.stdout.trim().split(/\s+/)
  const behind = Number.parseInt(behindText ?? '0', 10)
  const ahead = Number.parseInt(aheadText ?? '0', 10)

  if (behind === 0 && ahead === 0) {
    return { pushArgs: ['push', '-u', 'origin', pushRef], detachedHead }
  }

  if (behind > 0 && ahead === 0) {
    if (detachedHead) {
      return { pushArgs: null, detachedHead }
    }

    logger.log(`[pr] fast-forwarding ${branch} to origin/${branch} before push`)
    const ff = await gitRunner(worktreePath, ['merge', '--ff-only', `origin/${branch}`])
    if (ff.exitCode !== 0) {
      throw new Error(ff.stderr || ff.stdout || `Failed to fast-forward ${branch} to origin/${branch}`)
    }
    return { pushArgs: ['push', '-u', 'origin', pushRef], detachedHead }
  }

  if (behind > 0 && ahead > 0) {
    logger.warn(`[pr] ${branch} diverged from origin/${branch}; using --force-with-lease for managed branch`)
    return { pushArgs: ['push', '--force-with-lease', '-u', 'origin', pushRef], detachedHead }
  }

  return { pushArgs: ['push', '-u', 'origin', pushRef], detachedHead }
}

async function isDetachedHead(
  worktreePath: string,
  gitRunner: PushBranchDependencies['runGit'] = runGit,
): Promise<boolean> {
  const currentBranch = await gitRunner(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  return currentBranch.exitCode !== 0
}

export function isRetryableManagedBranchPushFailure(output: string): boolean {
  const normalized = output.toLowerCase()
  return normalized.includes('non-fast-forward')
    || normalized.includes('fetch first')
    || normalized.includes('stale info')
    || (normalized.includes('[rejected]') && normalized.includes('failed to push some refs'))
}

async function runGit(
  worktreePath: string,
  args: string[],
): Promise<GitCommandResult> {
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

const PR_BODY_TEMPLATE = (issueNumber: number, machineId: string) => `
## Summary

Fixes #${issueNumber}

${renderPrLineageMetadataCommentPlaceholder}

## Metadata

\`\`\`json
{
  "issue": ${issueNumber},
  "machine": "${machineId}",
  "generated_by": "agent-loop"
}
\`\`\`

## Test Plan

- [ ] tested locally
- [ ] CI passes
`.trim()

const renderPrLineageMetadataCommentPlaceholder = '__AGENT_LOOP_PR_LINEAGE_METADATA__'

function buildPrBody(
  issueNumber: number,
  machineId: string,
  lineageMetadata: PrLineageMetadata,
): string {
  return PR_BODY_TEMPLATE(issueNumber, machineId)
    .replace(renderPrLineageMetadataCommentPlaceholder, renderPrLineageMetadataComment(lineageMetadata))
}

async function resolvePrLineageMetadata(
  branch: string,
  issueNumber: number,
  context: ResolvedPrLineageContext,
  attempt: number,
): Promise<PrLineageMetadata> {
  return buildPrLineageMetadata({
    issueNumber,
    headBranch: branch,
    baseBranch: context.baseBranch,
    baseSha: context.baseSha,
    attempt,
  })
}

interface ResolvedPrLineageContext {
  baseBranch: string
  baseSha: string
}

async function resolvePrLineageContext(
  worktreePath: string,
  config: AgentConfig,
  gitRunner: PushBranchDependencies['runGit'] = runGit,
): Promise<ResolvedPrLineageContext> {
  const fetchBase = await gitRunner(worktreePath, ['fetch', 'origin', config.git.defaultBranch])
  if (fetchBase.exitCode !== 0) {
    throw new Error(fetchBase.stderr || fetchBase.stdout || `Failed to fetch origin/${config.git.defaultBranch}`)
  }

  const baseSha = await gitRunner(worktreePath, ['rev-parse', `origin/${config.git.defaultBranch}`])
  if (baseSha.exitCode !== 0) {
    throw new Error(baseSha.stderr || baseSha.stdout || `Failed to resolve origin/${config.git.defaultBranch}`)
  }

  return {
    baseBranch: config.git.defaultBranch,
    baseSha: baseSha.stdout.trim(),
  }
}

async function prepareReplacementBranch(
  worktreePath: string,
  replacementBranch: string,
  gitRunner: PushBranchDependencies['runGit'] = runGit,
): Promise<void> {
  const currentBranch = await gitRunner(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (currentBranch.exitCode === 0 && currentBranch.stdout.trim() === replacementBranch) {
    return
  }

  const checkout = await gitRunner(worktreePath, ['checkout', '-B', replacementBranch])
  if (checkout.exitCode !== 0) {
    throw new Error(checkout.stderr || checkout.stdout || `Failed to switch worktree to ${replacementBranch}`)
  }
}

async function markSupersededPullRequest(
  pullRequest: BranchPullRequestRecord,
  replacement: {
    prNumber: number
    branch: string
    attempt: number
  },
  reason: 'lineage-mismatch' | 'terminal-closed',
  config: AgentConfig,
  dependencies: Pick<CreateOrFindPrDependencies, 'commentOnPr' | 'closePullRequest'> = {},
): Promise<void> {
  const comment = dependencies.commentOnPr ?? commentOnPr
  const close = dependencies.closePullRequest ?? closePullRequest

  await comment(pullRequest.number, buildSupersededPrComment({
    previousPrNumber: pullRequest.number,
    replacementPrNumber: replacement.prNumber,
    replacementBranch: replacement.branch,
    replacementAttempt: replacement.attempt,
    reason,
  }), config)

  if (pullRequest.prState === 'open') {
    await close(pullRequest.number, config)
  }
}

/**
 * Create a PR for the given branch (idempotent).
 * Checks if PR already exists before creating.
 */
export async function createOrFindPr(
  worktreePath: string,
  branch: string,
  issueNumber: number,
  issueTitle: string,
  config: AgentConfig,
  logger = console,
  dependencies: CreateOrFindPrDependencies = {},
): Promise<CreateOrFindPrResult> {
  const createPullRequest = dependencies.createPr ?? createPr
  const pushManagedBranch = dependencies.pushBranch ?? pushBranch
  const resolveLineageContext = dependencies.resolvePrLineageContext ?? resolvePrLineageContext
  const listBranchPrs = dependencies.listBranchPullRequests ?? listBranchPullRequests
  const switchToReplacementBranch = dependencies.prepareReplacementBranch ?? prepareReplacementBranch

  const lineageContext = await resolveLineageContext(worktreePath, config)
  let currentBranch = branch
  const supersedeTargets: Array<{
    pullRequest: BranchPullRequestRecord
    reason: 'lineage-mismatch' | 'terminal-closed'
    replacementAttempt: number
  }> = []

  for (let guard = 0; guard < 5; guard += 1) {
    const candidates = await listBranchPrs(currentBranch, config)
    const lifecycle = choosePrLifecycleAction({
      issueNumber,
      headBranch: currentBranch,
      baseBranch: lineageContext.baseBranch,
      baseSha: lineageContext.baseSha,
    }, candidates)

    if (lifecycle.kind === 'terminal-merged') {
      logger.warn(`[pr] PR #${lifecycle.prNumber} is merged; replacement PR is not created automatically`)
      return {
        kind: 'terminal',
        prNumber: lifecycle.prNumber,
        prUrl: lifecycle.prUrl,
        prState: 'merged',
        replacementNeeded: true,
        branch: currentBranch,
      }
    }

    if (lifecycle.kind === 'reuse-open-lineage') {
      await pushManagedBranch(worktreePath, currentBranch, logger)
      for (const target of supersedeTargets) {
        await markSupersededPullRequest(target.pullRequest, {
          prNumber: lifecycle.prNumber,
          branch: currentBranch,
          attempt: target.replacementAttempt,
        }, target.reason, config, dependencies)
      }
      logger.log(`[pr] PR already exists: #${lifecycle.prNumber} (${lifecycle.prUrl})`)
      return { kind: 'reused', prNumber: lifecycle.prNumber, prUrl: lifecycle.prUrl, branch: currentBranch }
    }

    if (lifecycle.kind === 'create-new-pr') {
      await pushManagedBranch(worktreePath, currentBranch, logger)
      const lineageMetadata = await resolvePrLineageMetadata(
        currentBranch,
        issueNumber,
        lineageContext,
        lifecycle.attempt,
      )
      const body = buildPrBody(issueNumber, config.machineId, lineageMetadata)
      const pr = await createPullRequest(currentBranch, issueNumber, issueTitle, body, config)

      for (const target of supersedeTargets) {
        await markSupersededPullRequest(target.pullRequest, {
          prNumber: pr.number,
          branch: currentBranch,
          attempt: target.replacementAttempt,
        }, target.reason, config, dependencies)
      }

      logger.log(`[pr] created PR #${pr.number}: ${pr.url}`)
      return { kind: 'created', prNumber: pr.number, prUrl: pr.url, branch: currentBranch }
    }

    const supersededPullRequest = candidates.find((candidate) => candidate.number === lifecycle.supersedesPrNumber)
    if (!supersededPullRequest) {
      throw new Error(`Replacement target PR #${lifecycle.supersedesPrNumber} was not found for ${currentBranch}`)
    }

    supersedeTargets.push({
      pullRequest: supersededPullRequest,
      reason: lifecycle.reason,
      replacementAttempt: lifecycle.replacementAttempt,
    })

    logger.warn(
      `[pr] ${currentBranch} requires replacement after ${lifecycle.reason} on PR #${lifecycle.supersedesPrNumber}; switching to ${lifecycle.replacementBranch}`,
    )
    await switchToReplacementBranch(worktreePath, lifecycle.replacementBranch)
    currentBranch = lifecycle.replacementBranch
  }

  throw new Error(`Failed to resolve an active PR lineage for issue #${issueNumber}`)
}
