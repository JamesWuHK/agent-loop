import { ISSUE_LABELS } from './types'
import type { IssueLabel, IssueState, ClaimEvent, IssueDependencyMetadata } from './types'

// Valid state transitions
const VALID_TRANSITIONS: Record<IssueState, IssueState[]> = {
  ready: ['claimed'],
  claimed: ['working', 'stale'],
  working: ['done', 'failed', 'stale'],
  done: [],       // terminal
  failed: ['working', 'ready'], // resumable locally or requeueable for a fresh attempt
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

const CLAIM_EVENT_PATTERN = /<!--\s*({[\s\S]*})\s*-->/
const CLAIM_RESET_EVENTS = new Set<ClaimEvent['event']>(['done', 'failed', 'stale', 'stale-requeue', 'failed-requeue'])

export function parseClaimEventComment(body: string): ClaimEvent | null {
  const match = body.match(CLAIM_EVENT_PATTERN)
  if (!match) return null

  try {
    const parsed = JSON.parse(match[1]!.trim()) as Partial<ClaimEvent>
    if (!parsed || typeof parsed !== 'object') return null
    if (
      parsed.event !== 'claimed'
      && parsed.event !== 'done'
      && parsed.event !== 'failed'
      && parsed.event !== 'stale'
      && parsed.event !== 'stale-requeue'
      && parsed.event !== 'failed-requeue'
    ) {
      return null
    }
    if (typeof parsed.machine !== 'string' || parsed.machine.trim().length === 0) return null
    if (typeof parsed.ts !== 'string' || parsed.ts.trim().length === 0) return null
    return parsed as ClaimEvent
  } catch {
    return null
  }
}

export function resolveActiveClaimMachine(
  comments: Array<{ body: string; createdAt?: string }>,
): string | null {
  const orderedEvents = comments
    .map((comment, index) => ({
      index,
      createdAt: comment.createdAt ?? '',
      event: parseClaimEventComment(comment.body),
    }))
    .filter((entry): entry is { index: number; createdAt: string; event: ClaimEvent } => entry.event !== null)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.index - right.index)

  let activeMachine: string | null = null
  for (const entry of orderedEvents) {
    if (CLAIM_RESET_EVENTS.has(entry.event.event)) {
      activeMachine = null
      continue
    }

    if (entry.event.event === 'claimed' && activeMachine === null) {
      activeMachine = entry.event.machine
    }
  }

  return activeMachine
}

/**
 * Parse a structured event comment from the issue.
 */
export function parseIssueDependencyMetadata(
  body: string,
  issueNumber?: number,
): IssueDependencyMetadata {
  const contextStart = body.search(/^##\s+Context\b/m)
  if (contextStart === -1) {
    return {
      dependsOn: [],
      hasDependencyMetadata: false,
      dependencyParseError: false,
    }
  }

  const afterContext = body.slice(contextStart)
  const nextSectionOffset = afterContext.slice(1).search(/\n##\s+/)
  const contextSection = nextSectionOffset === -1
    ? afterContext
    : afterContext.slice(0, nextSectionOffset + 1)

  const dependenciesMatch = contextSection.match(
    /^###\s+Dependencies\b([\s\S]*?)(?=\n###\s+|\n##\s+|(?![\s\S]))/m,
  )
  if (!dependenciesMatch) {
    return {
      dependsOn: [],
      hasDependencyMetadata: false,
      dependencyParseError: false,
    }
  }

  const jsonBlockMatch = dependenciesMatch[1]?.match(/```json\s*([\s\S]*?)```/)
  if (!jsonBlockMatch) {
    return {
      dependsOn: [],
      hasDependencyMetadata: true,
      dependencyParseError: true,
    }
  }

  try {
    const parsed = JSON.parse(jsonBlockMatch[1]!.trim()) as { dependsOn?: unknown }
    const unique = new Set<number>()

    if (Array.isArray(parsed.dependsOn)) {
      for (const value of parsed.dependsOn) {
        if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
          if (value !== issueNumber) unique.add(value)
        }
      }
    }

    return {
      dependsOn: [...unique].sort((a, b) => a - b),
      hasDependencyMetadata: true,
      dependencyParseError: false,
    }
  } catch {
    return {
      dependsOn: [],
      hasDependencyMetadata: true,
      dependencyParseError: true,
    }
  }
}
