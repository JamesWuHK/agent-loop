import type { AgentConfig } from '@agent/shared'
import { checkPrExists, createPr } from '@agent/shared'

export async function pushBranch(
  worktreePath: string,
  branch: string,
  logger = console,
): Promise<void> {
  const pushArgs = await syncBranchWithRemote(worktreePath, branch, logger)
  const push = await runGit(worktreePath, pushArgs)
  if (push.exitCode !== 0) {
    throw new Error(push.stderr || push.stdout || `Failed to push ${branch}`)
  }
  logger.log(`[pr] pushed branch ${branch}`)
}

async function syncBranchWithRemote(
  worktreePath: string,
  branch: string,
  logger = console,
): Promise<string[]> {
  await runGit(worktreePath, ['fetch', 'origin', branch])

  const remoteExists = await runGit(worktreePath, ['rev-parse', '--verify', `origin/${branch}`])
  if (remoteExists.exitCode !== 0) return ['push', '-u', 'origin', branch]

  const counts = await runGit(worktreePath, ['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`])
  if (counts.exitCode !== 0) {
    throw new Error(counts.stderr || counts.stdout || `Failed to compare ${branch} with origin/${branch}`)
  }

  const [behindText, aheadText] = counts.stdout.trim().split(/\s+/)
  const behind = Number.parseInt(behindText ?? '0', 10)
  const ahead = Number.parseInt(aheadText ?? '0', 10)

  if (behind === 0 && ahead === 0) {
    return ['push', '-u', 'origin', branch]
  }

  if (behind > 0 && ahead === 0) {
    logger.log(`[pr] fast-forwarding ${branch} to origin/${branch} before push`)
    const ff = await runGit(worktreePath, ['merge', '--ff-only', `origin/${branch}`])
    if (ff.exitCode !== 0) {
      throw new Error(ff.stderr || ff.stdout || `Failed to fast-forward ${branch} to origin/${branch}`)
    }
    return ['push', '-u', 'origin', branch]
  }

  if (behind > 0 && ahead > 0) {
    logger.warn(`[pr] ${branch} diverged from origin/${branch}; using --force-with-lease for managed branch`)
    return ['push', '--force-with-lease', '-u', 'origin', branch]
  }

  return ['push', '-u', 'origin', branch]
}

async function runGit(
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
