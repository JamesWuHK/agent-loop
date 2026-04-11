import {
  fetchIssueBodySnapshot,
  type AgentConfig,
  type IssueBodySnapshot,
  type IssueBodyUpdateResult,
  updateIssueBody,
} from '@agent/shared'
import {
  buildIssueLintReport,
  formatIssueLintReport,
  type IssueLintReport,
} from './audit-issue-contracts'

export type ApplyIssueBodyUpdateStatus =
  | 'updated'
  | 'noop'
  | 'conflict'
  | 'invalid'

export interface ApplyIssueBodyUpdateResult {
  status: ApplyIssueBodyUpdateStatus
  updated: boolean
  issueNumber: number
  issueUrl: string | null
  oldUpdatedAt: string | null
  newUpdatedAt: string | null
  expectedUpdatedAt: string | null
  validation: IssueLintReport
  message: string
}

export type IssueBodySnapshotFetcher = (input: {
  issueNumber: number
  config: AgentConfig
}) => Promise<IssueBodySnapshot>

export type IssueBodyRemoteUpdater = (input: {
  issueNumber: number
  body: string
  config: AgentConfig
}) => Promise<IssueBodyUpdateResult>

export interface ApplyIssueBodyUpdateInput {
  issueNumber: number
  markdown: string
  config: AgentConfig
  expectedUpdatedAt?: string
  force?: boolean
  fetchIssue?: IssueBodySnapshotFetcher
  updateIssueBody?: IssueBodyRemoteUpdater
}

export async function applyIssueBodyUpdate(
  input: ApplyIssueBodyUpdateInput,
): Promise<ApplyIssueBodyUpdateResult> {
  const validation = buildIssueLintReport(input.markdown, {
    kind: 'file',
    path: 'stdin',
  })

  if (!validation.valid) {
    return {
      status: 'invalid',
      updated: false,
      issueNumber: input.issueNumber,
      issueUrl: null,
      oldUpdatedAt: null,
      newUpdatedAt: null,
      expectedUpdatedAt: input.expectedUpdatedAt ?? null,
      validation,
      message: `Local issue contract failed validation:\n${formatIssueLintReport(validation)}`,
    }
  }

  const fetchIssue = input.fetchIssue ?? (async ({ issueNumber, config }: {
    issueNumber: number
    config: AgentConfig
  }) => fetchIssueBodySnapshot(issueNumber, config))
  const remoteIssue = await fetchIssue({
    issueNumber: input.issueNumber,
    config: input.config,
  })

  if (remoteIssue.body === input.markdown) {
    return {
      status: 'noop',
      updated: false,
      issueNumber: remoteIssue.number,
      issueUrl: remoteIssue.url,
      oldUpdatedAt: remoteIssue.updatedAt,
      newUpdatedAt: remoteIssue.updatedAt,
      expectedUpdatedAt: input.expectedUpdatedAt ?? null,
      validation,
      message: 'Remote issue body already matches target markdown',
    }
  }

  if (
    !input.force
    && typeof input.expectedUpdatedAt === 'string'
    && remoteIssue.updatedAt !== input.expectedUpdatedAt
  ) {
    return {
      status: 'conflict',
      updated: false,
      issueNumber: remoteIssue.number,
      issueUrl: remoteIssue.url,
      oldUpdatedAt: remoteIssue.updatedAt,
      newUpdatedAt: null,
      expectedUpdatedAt: input.expectedUpdatedAt,
      validation,
      message: `Remote issue updatedAt changed from expected ${input.expectedUpdatedAt} to ${remoteIssue.updatedAt}`,
    }
  }

  const updateRemoteIssueBody = input.updateIssueBody ?? (async ({ issueNumber, body, config }: {
    issueNumber: number
    body: string
    config: AgentConfig
  }) => updateIssueBody(issueNumber, body, config))
  const updatedIssue = await updateRemoteIssueBody({
    issueNumber: input.issueNumber,
    body: input.markdown,
    config: input.config,
  })

  return {
    status: 'updated',
    updated: true,
    issueNumber: updatedIssue.number,
    issueUrl: updatedIssue.url,
    oldUpdatedAt: remoteIssue.updatedAt,
    newUpdatedAt: updatedIssue.updatedAt,
    expectedUpdatedAt: input.expectedUpdatedAt ?? null,
    validation,
    message: 'Remote issue body updated',
  }
}

export function formatIssueApplyResult(
  result: ApplyIssueBodyUpdateResult,
  asJson = false,
): string {
  if (asJson) {
    return JSON.stringify(result, null, 2)
  }

  const lines = [
    `status=${result.status}`,
    `updated=${result.updated}`,
    `issue=${result.issueNumber}`,
    `url=${result.issueUrl ?? '-'}`,
    `oldUpdatedAt=${result.oldUpdatedAt ?? '-'}`,
    `newUpdatedAt=${result.newUpdatedAt ?? '-'}`,
  ]

  if (result.expectedUpdatedAt) {
    lines.push(`expectedUpdatedAt=${result.expectedUpdatedAt}`)
  }

  lines.push(`message=${result.message}`)

  return lines.join('\n')
}
