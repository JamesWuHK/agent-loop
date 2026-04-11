import { readFileSync } from 'node:fs'
import {
  getAgentIssueByNumber,
  listOpenAgentIssues,
  type AgentConfig,
  type AgentIssue,
} from '@agent/shared'
import { parseIssueContract, summarizeIssueContract } from '../../../packages/agent-shared/src/issue-contract'
import { buildIssueQualityReport } from '../../../packages/agent-shared/src/issue-quality'
import { loadConfig, type CliArgs } from './config'

export interface AuditedIssue {
  number: number
  title: string
  state: string
  isClaimable: boolean
  hasExecutableContract: boolean
  claimBlockedBy: number[]
  contractValidationErrors: string[]
  qualityScore: number
  contractWarnings: string[]
}

export interface AuditIssueContractsJsonReport {
  totals: {
    managedIssues: number
    readyIssues: number
    invalidReadyIssues: number
    issuesWithWarnings: number
  }
  issues: Array<AuditedIssue & {
    readyGateBlocked: boolean
  }>
}

export type IssueLintSource =
  | {
      kind: 'file'
      path: string
    }
  | {
      kind: 'issue'
      issueNumber: number
      repo: string
    }

export interface IssueLintReport {
  source: IssueLintSource
  title?: string
  valid: boolean
  readyGateBlocked: boolean
  readyGateStatus: 'pass' | 'blocked'
  readyGateSummary: string
  score: number
  errors: string[]
  warnings: string[]
  contract: ReturnType<typeof summarizeIssueContract>
}

export interface RemoteIssueDocument {
  number: number
  title: string
  body: string
  url: string
}

interface RemoteIssueViewCommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface RemoteIssueFetchDependencies {
  runIssueViewCommand: (
    args: string[],
    config: AgentConfig,
  ) => Promise<RemoteIssueViewCommandResult>
}

const DEFAULT_REMOTE_ISSUE_FETCH_DEPENDENCIES: RemoteIssueFetchDependencies = {
  runIssueViewCommand: async () => ({
    stdout: '',
    stderr: '',
    exitCode: 1,
  }),
}

export function buildIssueLintReport(
  body: string,
  source: IssueLintSource,
  title?: string,
): IssueLintReport {
  const contract = parseIssueContract(body)
  const quality = buildIssueQualityReport(contract)

  return {
    source,
    title,
    valid: quality.valid,
    readyGateBlocked: !quality.valid,
    readyGateStatus: quality.valid ? 'pass' : 'blocked',
    readyGateSummary: quality.valid
      ? 'ready gate would pass hard validation checks'
      : 'ready gate would still block on hard validation errors',
    score: quality.score,
    errors: [...quality.errors],
    warnings: [...quality.warnings],
    contract: summarizeIssueContract(contract),
  }
}

export function buildAuditedIssue(
  issue: Pick<AgentIssue, 'number' | 'title' | 'state' | 'isClaimable' | 'hasExecutableContract' | 'claimBlockedBy' | 'contractValidationErrors' | 'body'>,
): AuditedIssue {
  const report = buildIssueLintReport(issue.body, {
    kind: 'issue',
    issueNumber: issue.number,
    repo: 'unknown',
  }, issue.title)

  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    isClaimable: issue.isClaimable,
    hasExecutableContract: issue.hasExecutableContract,
    claimBlockedBy: [...issue.claimBlockedBy],
    contractValidationErrors: [...issue.contractValidationErrors],
    qualityScore: report.score,
    contractWarnings: report.warnings,
  }
}

export function formatAuditLine(issue: AuditedIssue): string {
  return `#${issue.number} state=${issue.state} claimable=${issue.isClaimable} `
    + `contract=${issue.hasExecutableContract} score=${issue.qualityScore} warnings=${issue.contractWarnings.length} `
    + `blockedBy=${issue.claimBlockedBy.join(',') || '-'} `
    + `errors=${issue.contractValidationErrors.join(' | ') || '-'}`
}

export function formatInvalidReadySection(issues: AuditedIssue[]): string {
  if (issues.length === 0) {
    return ''
  }

  return [
    'invalid ready issues:',
    ...issues.flatMap((issue) => [
      `#${issue.number} ${issue.title}`,
      ...issue.contractValidationErrors.map((error) => `- ${error}`),
      ...issue.contractWarnings.map((warning) => `- warning: ${warning}`),
    ]),
  ].join('\n')
}

export function buildAuditIssueContractsJsonReport(
  issues: AuditedIssue[],
): AuditIssueContractsJsonReport {
  return {
    totals: {
      managedIssues: issues.length,
      readyIssues: issues.filter((issue) => issue.state === 'ready').length,
      invalidReadyIssues: issues.filter((issue) => issue.state === 'ready' && !issue.hasExecutableContract).length,
      issuesWithWarnings: issues.filter((issue) => issue.contractWarnings.length > 0).length,
    },
    issues: issues.map((issue) => ({
      ...issue,
      readyGateBlocked: issue.contractValidationErrors.length > 0,
    })),
  }
}

export function formatAuditJsonReport(issues: AuditedIssue[]): string {
  return JSON.stringify(buildAuditIssueContractsJsonReport(issues), null, 2)
}

export function formatIssueLintReportJson(report: IssueLintReport): string {
  return JSON.stringify(report, null, 2)
}

export function formatIssueLintReport(report: IssueLintReport): string {
  const source = report.source.kind === 'file'
    ? report.source.path
    : `${report.source.repo}#${report.source.issueNumber}`
  const errors = report.errors ?? []
  const warnings = report.warnings ?? []

  return [
    `source=${source}`,
    report.title ? `title=${report.title}` : null,
    `valid=${report.valid}`,
    `readyGate=${report.readyGateStatus}`,
    `readyGateSummary=${report.readyGateSummary}`,
    `score=${report.score}`,
    `errors=${errors.join(' | ') || '-'}`,
    `warnings=${warnings.join(' | ') || '-'}`,
  ].filter((line): line is string => line !== null).join('\n')
}

export function buildGhIssueViewArgs(issueNumber: number, repo: string): string[] {
  return [
    'issue',
    'view',
    String(issueNumber),
    '--repo',
    repo,
    '--json',
    'number,title,body,url',
  ]
}

export async function fetchRemoteIssueDocument(
  input: {
    issueNumber: number
    config: AgentConfig
  },
  deps: RemoteIssueFetchDependencies = DEFAULT_REMOTE_ISSUE_FETCH_DEPENDENCIES,
): Promise<RemoteIssueDocument> {
  const result = await deps.runIssueViewCommand(
    buildGhIssueViewArgs(input.issueNumber, input.config.repo),
    input.config,
  )

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `gh issue view failed with exit code ${result.exitCode}`)
  }

  const parsed = JSON.parse(result.stdout) as Partial<RemoteIssueDocument>

  if (
    typeof parsed.number !== 'number'
    || typeof parsed.title !== 'string'
    || typeof parsed.body !== 'string'
    || typeof parsed.url !== 'string'
  ) {
    throw new Error(`Invalid gh issue view payload for issue #${input.issueNumber}`)
  }

  return {
    number: parsed.number,
    title: parsed.title,
    body: parsed.body,
    url: parsed.url,
  }
}

export function buildIssueLintReportFromMarkdownFile(path: string): IssueLintReport {
  return buildIssueLintReport(readFileSync(path, 'utf-8'), {
    kind: 'file',
    path,
  })
}

export async function buildIssueLintReportFromRemoteIssue(input: {
  issueNumber: number
  config: AgentConfig
}): Promise<IssueLintReport> {
  const issue = await getAgentIssueByNumber(input.issueNumber, input.config)

  if (!issue) {
    throw new Error(`Issue #${input.issueNumber} was not found in ${input.config.repo}`)
  }

  return buildIssueLintReport(issue.body, {
    kind: 'issue',
    issueNumber: issue.number,
    repo: input.config.repo,
  }, issue.title)
}

function parseArgs(argv: string[]): CliArgs & { json?: boolean } {
  let repo: string | undefined
  let json = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--repo') {
      repo = argv[index + 1]
      index += 1
    } else if (arg === '--json') {
      json = true
    }
  }

  return { repo, json }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const config = loadConfig(args)
  const issues = await listOpenAgentIssues(config)
  const managedIssues = issues
    .filter((issue) => issue.labels.some((label) => label.startsWith('agent:')))
    .map(buildAuditedIssue)

  if (args.json) {
    console.log(formatAuditJsonReport(managedIssues))
    return
  }

  console.log(`managed issues: ${managedIssues.length}`)

  for (const issue of managedIssues) {
    console.log(formatAuditLine(issue))
  }

  const invalidReady = managedIssues.filter((issue) => issue.state === 'ready' && !issue.hasExecutableContract)
  const invalidReadySection = formatInvalidReadySection(invalidReady)
  if (invalidReadySection) {
    console.log(`\n${invalidReadySection}`)
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[audit-issue-contracts] failed:', error)
    process.exit(1)
  })
}
