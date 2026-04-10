import { readFileSync } from 'node:fs'
import { ISSUE_LABELS, PR_REVIEW_LABELS } from '@agent/shared'
import type { WakeRequest } from './wake-queue'

const ACTIONABLE_ISSUE_LABELS = new Set<string>([
  ISSUE_LABELS.READY,
  ISSUE_LABELS.CLAIMED,
  ISSUE_LABELS.WORKING,
  ISSUE_LABELS.FAILED,
  ISSUE_LABELS.STALE,
])

const ACTIONABLE_PR_LABELS = new Set<string>(Object.values(PR_REVIEW_LABELS))
const ISSUE_RESUME_RESOLUTION_COMMENT_PREFIX = '<!-- agent-loop:issue-resume-resolved '

export interface GitHubEventWakeInput {
  eventName: string
  event: unknown
  requestedAt?: string
}

export interface GitHubEventWakeContextInput {
  eventName?: string
  eventPath?: string
  requestedAt?: string
}

export function readWakeRequestFromGitHubEventContext(
  input: GitHubEventWakeContextInput = {},
  env: NodeJS.ProcessEnv = process.env,
  readText: (path: string) => string = (path) => readFileSync(path, 'utf-8'),
): WakeRequest | null {
  const eventName = normalizeNonEmptyString(input.eventName ?? env.GITHUB_EVENT_NAME)
  if (!eventName) {
    throw new Error('No GitHub event name available. Pass --github-event-name or run inside GitHub Actions.')
  }

  const eventPath = normalizeNonEmptyString(input.eventPath ?? env.GITHUB_EVENT_PATH)
  if (!eventPath) {
    throw new Error('No GitHub event payload path available. Pass --github-event-path or run inside GitHub Actions.')
  }

  return buildWakeRequestFromGitHubEvent({
    eventName,
    event: JSON.parse(readText(eventPath)),
    requestedAt: input.requestedAt,
  })
}

export function buildWakeRequestFromGitHubEvent(
  input: GitHubEventWakeInput,
): WakeRequest | null {
  const requestedAt = input.requestedAt ?? new Date().toISOString()
  const payload = asRecord(input.event)
  if (!payload) return null

  switch (input.eventName) {
    case 'issues':
      return buildWakeRequestFromIssuesEvent(payload, requestedAt)
    case 'pull_request':
      return buildWakeRequestFromPullRequestEvent(payload, requestedAt)
    case 'issue_comment':
      return buildWakeRequestFromIssueCommentEvent(payload, requestedAt)
    case 'workflow_dispatch':
      return buildWakeRequestFromWorkflowDispatchEvent(payload, requestedAt)
    default:
      return null
  }
}

function buildWakeRequestFromIssuesEvent(
  payload: Record<string, unknown>,
  requestedAt: string,
): WakeRequest | null {
  const action = normalizeNonEmptyString(payload.action)
  const issue = readIssueLike(payload.issue)
  if (!action || !issue || issue.isPullRequest) return null

  if (action === 'labeled') {
    const labelName = readLabelName(payload.label)
    if (labelName !== ISSUE_LABELS.READY) return null

    return {
      kind: 'issue',
      issueNumber: issue.number,
      reason: 'issues.labeled:agent:ready',
      sourceEvent: 'issues.labeled',
      dedupeKey: `issues:labeled:${issue.number}:${labelName}`,
      requestedAt,
    }
  }

  if ((action === 'edited' || action === 'reopened') && hasAnyLabel(issue.labels, ACTIONABLE_ISSUE_LABELS)) {
    return {
      kind: 'issue',
      issueNumber: issue.number,
      reason: `issues.${action}`,
      sourceEvent: `issues.${action}`,
      dedupeKey: `issues:${action}:${issue.number}:${issue.updatedAt ?? requestedAt}`,
      requestedAt,
    }
  }

  return null
}

function buildWakeRequestFromPullRequestEvent(
  payload: Record<string, unknown>,
  requestedAt: string,
): WakeRequest | null {
  const action = normalizeNonEmptyString(payload.action)
  const pullRequest = readPullRequestLike(payload.pull_request)
  if (!action || !pullRequest) return null

  if (
    (action === 'opened' || action === 'reopened' || action === 'synchronize')
    && pullRequest.isDraft
  ) {
    return null
  }

  if (
    action === 'opened'
    || action === 'reopened'
    || action === 'ready_for_review'
    || action === 'synchronize'
  ) {
    return {
      kind: 'pr',
      prNumber: pullRequest.number,
      reason: `pull_request.${action}`,
      sourceEvent: `pull_request.${action}`,
      dedupeKey: `pull_request:${action}:${pullRequest.number}:${pullRequest.headSha ?? requestedAt}`,
      requestedAt,
    }
  }

  if (action === 'labeled' || action === 'unlabeled') {
    const labelName = readLabelName(payload.label)
    if (!labelName || !ACTIONABLE_PR_LABELS.has(labelName)) return null

    return {
      kind: 'pr',
      prNumber: pullRequest.number,
      reason: `pull_request.${action}:${labelName}`,
      sourceEvent: `pull_request.${action}`,
      dedupeKey: `pull_request:${action}:${pullRequest.number}:${labelName}`,
      requestedAt,
    }
  }

  return null
}

function buildWakeRequestFromIssueCommentEvent(
  payload: Record<string, unknown>,
  requestedAt: string,
): WakeRequest | null {
  const action = normalizeNonEmptyString(payload.action) ?? 'created'
  const issue = readIssueLike(payload.issue)
  const comment = readCommentLike(payload.comment)
  if (!issue || !comment || issue.isPullRequest) return null
  if (!comment.body.includes(ISSUE_RESUME_RESOLUTION_COMMENT_PREFIX)) return null

  return {
    kind: 'issue',
    issueNumber: issue.number,
    reason: 'issue_comment.issue-resume-resolved',
    sourceEvent: `issue_comment.${action}`,
    dedupeKey: `issue_comment:${comment.id}:issue-resume-resolved`,
    requestedAt,
  }
}

function buildWakeRequestFromWorkflowDispatchEvent(
  payload: Record<string, unknown>,
  requestedAt: string,
): WakeRequest | null {
  const inputs = asRecord(payload.inputs)
  const wakeTarget = normalizeNonEmptyString(inputs?.wake_target) ?? 'auto'
  const issueNumber = readPositiveInteger(inputs?.issue_number)
  const prNumber = readPositiveInteger(inputs?.pr_number)

  if (wakeTarget === 'issue') {
    if (!issueNumber) {
      throw new Error('workflow_dispatch input wake_target=issue requires a positive issue_number')
    }

    return {
      kind: 'issue',
      issueNumber,
      reason: 'workflow_dispatch:issue',
      sourceEvent: 'workflow_dispatch',
      dedupeKey: `workflow_dispatch:issue:${issueNumber}`,
      requestedAt,
    }
  }

  if (wakeTarget === 'pr') {
    if (!prNumber) {
      throw new Error('workflow_dispatch input wake_target=pr requires a positive pr_number')
    }

    return {
      kind: 'pr',
      prNumber,
      reason: 'workflow_dispatch:pr',
      sourceEvent: 'workflow_dispatch',
      dedupeKey: `workflow_dispatch:pr:${prNumber}`,
      requestedAt,
    }
  }

  if (wakeTarget === 'auto') {
    if (issueNumber && !prNumber) {
      return {
        kind: 'issue',
        issueNumber,
        reason: 'workflow_dispatch:issue',
        sourceEvent: 'workflow_dispatch',
        dedupeKey: `workflow_dispatch:issue:${issueNumber}`,
        requestedAt,
      }
    }

    if (prNumber && !issueNumber) {
      return {
        kind: 'pr',
        prNumber,
        reason: 'workflow_dispatch:pr',
        sourceEvent: 'workflow_dispatch',
        dedupeKey: `workflow_dispatch:pr:${prNumber}`,
        requestedAt,
      }
    }
  }

  return {
    kind: 'now',
    reason: 'workflow_dispatch',
    sourceEvent: 'workflow_dispatch',
    dedupeKey: 'workflow_dispatch:now',
    requestedAt,
  }
}

function readIssueLike(
  value: unknown,
): { number: number; labels: string[]; updatedAt: string | null; isPullRequest: boolean } | null {
  const record = asRecord(value)
  const number = readPositiveInteger(record?.number)
  if (!number) return null

  return {
    number,
    labels: readLabelNames(record?.labels),
    updatedAt: normalizeNonEmptyString(record?.updated_at) ?? null,
    isPullRequest: !!asRecord(record?.pull_request),
  }
}

function readPullRequestLike(
  value: unknown,
): { number: number; isDraft: boolean; headSha: string | null } | null {
  const record = asRecord(value)
  const number = readPositiveInteger(record?.number)
  if (!number) return null

  return {
    number,
    isDraft: record?.draft === true,
    headSha: normalizeNonEmptyString(asRecord(record?.head)?.sha) ?? null,
  }
}

function readCommentLike(
  value: unknown,
): { id: number; body: string } | null {
  const record = asRecord(value)
  const id = readPositiveInteger(record?.id)
  const body = normalizeNonEmptyString(record?.body)
  if (!id || !body) return null

  return {
    id,
    body,
  }
}

function readLabelName(value: unknown): string | null {
  return normalizeNonEmptyString(asRecord(value)?.name)
}

function readLabelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => readLabelName(item))
    .filter((label): label is string => !!label)
}

function hasAnyLabel(labels: string[], allowed: ReadonlySet<string>): boolean {
  return labels.some((label) => allowed.has(label))
}

function readPositiveInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null
  }

  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
  }

  return null
}

function normalizeNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
