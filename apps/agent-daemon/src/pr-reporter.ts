import type { AgentConfig } from '@agent/shared'
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
): Promise<{ prNumber: number; prUrl: string }> {
  // Check idempotency: PR might already exist
  const existing = await checkPrExists(branch, config)

  if (existing.prNumber !== null && existing.prState === 'open') {
    const url = existing.prUrl ?? ''
    await pushBranch(worktreePath, branch, logger)
    logger.log(`[pr] PR already exists: #${existing.prNumber} (${url})`)
    return { prNumber: existing.prNumber, prUrl: url }
  }

  if (existing.prNumber !== null && existing.prState === 'merged') {
    const url = existing.prUrl ?? ''
    logger.log(`[pr] PR already merged: #${existing.prNumber}`)
    return { prNumber: existing.prNumber, prUrl: url }
  }

  if (existing.prNumber !== null && existing.prState === 'closed') {
    logger.warn(`[pr] PR was closed, not creating new PR`)
    const url = existing.prUrl ?? ''
    return { prNumber: existing.prNumber, prUrl: url }
  }

  // Push branch first if not pushed yet
  await pushBranch(worktreePath, branch, logger)

  const body = PR_BODY_TEMPLATE(issueNumber, config.machineId)
  const pr = await createPr(branch, issueNumber, issueTitle, body, config)

  logger.log(`[pr] created PR #${pr.number}: ${pr.url}`)
  return { prNumber: pr.number, prUrl: pr.url }
}
