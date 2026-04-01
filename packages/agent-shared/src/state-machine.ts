import { ISSUE_LABELS } from './types'
import type { IssueLabel, IssueState, ClaimEvent, IssueDependencyMetadata } from './types'

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
