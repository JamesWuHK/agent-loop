import { ISSUE_LABELS } from './types'
import type { IssueLabel, IssueState, ClaimEvent } from './types'

// Valid state transitions
const VALID_TRANSITIONS: Record<IssueState, IssueState[]> = {
  ready: ['claimed'],
  claimed: ['working', 'stale'],
  working: ['done', 'failed', 'stale'],
  done: [],       // terminal
  failed: [],     // terminal (or can be re-queued manually)
  stale: ['ready'],
  unknown: [],
}

/**
 * Infer issue state from its current labels.
 * Returns 'unknown' if no agent label is present.
 */
export function inferState(labels: string[]): IssueState {
  const labelSet = new Set(labels)

  if (labelSet.has(ISSUE_LABELS.DONE))    return 'done'
  if (labelSet.has(ISSUE_LABELS.FAILED))   return 'failed'
  if (labelSet.has(ISSUE_LABELS.WORKING))  return 'working'
  if (labelSet.has(ISSUE_LABELS.CLAIMED))  return 'claimed'
  if (labelSet.has(ISSUE_LABELS.STALE))    return 'stale'
  if (labelSet.has(ISSUE_LABELS.READY))    return 'ready'

  // No agent label — treat as unknown (not in the loop yet)
  return 'unknown'
}

/**
 * Check if a state transition is valid.
 */
export function canTransition(from: IssueState, to: IssueState): boolean {
  return (VALID_TRANSITIONS[from] ?? []).includes(to)
}

/**
 * Build a structured event comment body.
 */
export function buildEventComment(event: ClaimEvent): string {
  return `<!-- ${JSON.stringify(event)} -->`
}

/**
 * Parse a structured event comment from the issue.
 */
export function parseEventComment(body: string): ClaimEvent | null {
  if (!body.includes('<!--')) return null
  const match = body.match(/<!--\s*([\s\S]*?)\s*-->/)
  if (!match) return null
  try {
    return JSON.parse(match[1]!.trim()) as ClaimEvent
  } catch {
    return null
  }
}
