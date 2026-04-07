import type { AgentConfig, AgentIssue } from '@agent/shared'
import { fetchClaimableIssues, claimIssue } from '@agent/shared'
import { recordClaim } from './metrics'

const BASE_DELAY_MS = 1000
const MAX_ATTEMPTS = 3

export interface ClaimAttempt {
  issueNumber: number
  success: boolean
  reason: 'claimed' | 'already-claimed' | 'rate-limited' | 'error'
}

/**
 * Poll for claimable issues and attempt to claim one.
 * Uses optimistic locking: first to set assignee wins, others get 422 and retry.
 */
export async function pollAndClaim(
  config: AgentConfig,
  logger = console,
): Promise<AgentIssue | null> {
  logger.log(`[claimer] polling for claimable issues...`)

  let issues: AgentIssue[]
  try {
    issues = await fetchClaimableIssues(config)
  } catch (err) {
    logger.error(`[claimer] failed to fetch issues:`, err)
    return null
  }

  if (issues.length === 0) {
    logger.log(`[claimer] no runnable issues found`)
    return null
  }

  logger.log(`[claimer] found ${issues.length} runnable issues`)

  // Try each issue in order with retry + jitter
  for (const issue of issues) {
    const claimed: boolean | 'rate-limited' = await claimWithRetry(issue.number, config, logger)
    if (claimed === true) {
      return issue
    }
    // If rate-limited, wait and retry the whole poll cycle
    if (claimed === 'rate-limited') {
      logger.warn(`[claimer] rate limited, waiting before retry...`)
      await sleep(30_000)
      return null
    }
    // false (already-claimed) → try next issue
  }

  return null
}

/**
 * Attempt to claim an issue with exponential backoff + jitter.
 */
async function claimWithRetry(
  issueNumber: number,
  config: AgentConfig,
  logger: typeof console,
): Promise<boolean | 'rate-limited'> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await claimIssue(issueNumber, config, config.machineId)

      if (result.success) {
        logger.log(`[claimer] claimed issue #${issueNumber}`)
        recordClaim('claimed')
        return true
      }

      if (result.reason === 'already-claimed') {
        logger.log(`[claimer] issue #${issueNumber} already claimed by another machine`)
        recordClaim('already_claimed')
        return false
      }

      if (result.reason === 'rate-limited') {
        recordClaim('rate_limited')
        return 'rate-limited'
      }
    } catch (err) {
      logger.error(`[claimer] claim attempt ${attempt} failed:`, err)
      recordClaim('error')
    }

    if (attempt < MAX_ATTEMPTS) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 500
      logger.log(`[claimer] retrying #${issueNumber} in ${Math.round(delay)}ms...`)
      await sleep(delay)
    }
  }

  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
