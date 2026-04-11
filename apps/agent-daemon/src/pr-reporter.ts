import type { AgentConfig, PrCheckResult } from '@agent/shared'
import { checkPrExists, createPr } from '@agent/shared'

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
  checkPrExists?: typeof checkPrExists
  createPr?: typeof createPr
  pushBranch?: typeof pushBranch
}

export type CreateOrFindPrResult =
  | {
      kind: 'reused' | 'created'
      prNumber: number
      prUrl: string
    }
  | {
      kind: 'terminal'
      prNumber: number
      prUrl: string
      prState: 'closed' | 'merged'
      replacementNeeded: true
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
  const checkExistingPr = dependencies.checkPrExists ?? checkPrExists
  const createPullRequest = dependencies.createPr ?? createPr
  const pushManagedBranch = dependencies.pushBranch ?? pushBranch

  // Check idempotency: PR might already exist
  const existing = await checkExistingPr(branch, config)

  if (hasReusableOpenPr(existing)) {
    const url = existing.prUrl ?? ''
    await pushManagedBranch(worktreePath, branch, logger)
    logger.log(`[pr] PR already exists: #${existing.prNumber} (${url})`)
    return { kind: 'reused', prNumber: existing.prNumber, prUrl: url }
  }

  if (existing.prNumber !== null && existing.prState === 'merged') {
    const url = existing.prUrl ?? ''
    logger.warn(`[pr] PR #${existing.prNumber} is merged; replacement PR is required before continuing`)
    return {
      kind: 'terminal',
      prNumber: existing.prNumber,
      prUrl: url,
      prState: 'merged',
      replacementNeeded: true,
    }
  }

  if (existing.prNumber !== null && existing.prState === 'closed') {
    logger.warn(`[pr] PR #${existing.prNumber} is closed; replacement PR is required before continuing`)
    const url = existing.prUrl ?? ''
    return {
      kind: 'terminal',
      prNumber: existing.prNumber,
      prUrl: url,
      prState: 'closed',
      replacementNeeded: true,
    }
  }

  // Push branch first if not pushed yet
  await pushManagedBranch(worktreePath, branch, logger)

  const body = PR_BODY_TEMPLATE(issueNumber, config.machineId)
  const pr = await createPullRequest(branch, issueNumber, issueTitle, body, config)

  logger.log(`[pr] created PR #${pr.number}: ${pr.url}`)
  return { kind: 'created', prNumber: pr.number, prUrl: pr.url }
}
