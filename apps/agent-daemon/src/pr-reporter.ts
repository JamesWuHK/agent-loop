import { $ } from 'bun'
import type { AgentConfig } from '@agent/shared'
import { checkPrExists, createPr } from '@agent/shared'

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
  branch: string,
  issueNumber: number,
  issueTitle: string,
  worktreePath: string,
  config: AgentConfig,
  logger = console,
): Promise<{ prNumber: number; prUrl: string }> {
  // Check idempotency: PR might already exist
  const existing = await checkPrExists(branch, config)

  if (existing.prNumber !== null && existing.prState === 'open') {
    const url = existing.prUrl ?? ''
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
  await $`git push -u origin ${branch}`.cwd(worktreePath).quiet()

  const body = PR_BODY_TEMPLATE(issueNumber, config.machineId)
  const pr = await createPr(branch, issueNumber, issueTitle, body, config)

  logger.log(`[pr] created PR #${pr.number}: ${pr.url}`)
  return { prNumber: pr.number, prUrl: pr.url }
}
