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
import {
  simulateIssueExecutability,
  type IssueSimulationResult,
} from './issue-simulate'

const LOW_SCORE_THRESHOLD = 80

type AuditableIssue = Pick<AgentIssue, 'number' | 'title' | 'body' | 'state'> & Partial<Pick<AgentIssue,
  'labels'
  | 'isClaimable'
  | 'hasExecutableContract'
  | 'claimBlockedBy'
  | 'contractValidationErrors'
>>

export interface AuditedIssueContract {
  valid: boolean
  errors: string[]
  warnings: string[]
}

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
  contract: AuditedIssueContract
  simulation?: IssueSimulationResult
}

export interface AuditIssueSummary {
  auditedIssueCount: number
  invalidIssueCount: number
  invalidReadyIssueCount: number
  lowScoreIssueCount: number
  warningIssueCount: number
}

export interface AuditIssueContractsJsonReport {
  summary: AuditIssueSummary
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

interface AuditIssuesDependencies {
  simulateIssueExecutability: typeof simulateIssueExecutability
}

const DEFAULT_REMOTE_ISSUE_FETCH_DEPENDENCIES: RemoteIssueFetchDependencies = {
  runIssueViewCommand: async () => ({
    stdout: '',
    stderr: '',
    exitCode: 1,
  }),
}

const DEFAULT_AUDIT_ISSUES_DEPENDENCIES: AuditIssuesDependencies = {
  simulateIssueExecutability,
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
  issue: AuditableIssue,
): AuditedIssue {
  const report = buildIssueLintReport(issue.body, {
    kind: 'issue',
    issueNumber: issue.number,
    repo: 'unknown',
  }, issue.title)
  const contractErrors = [...report.errors]
  const claimBlockedBy = [...(issue.claimBlockedBy ?? [])]
  const hasExecutableContract = issue.hasExecutableContract ?? report.valid

  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    isClaimable: issue.isClaimable ?? (
      issue.state === 'ready'
      && hasExecutableContract
      && claimBlockedBy.length === 0
    ),
    hasExecutableContract,
    claimBlockedBy,
    contractValidationErrors: contractErrors,
    qualityScore: report.score,
    contractWarnings: [...report.warnings],
    contract: {
      valid: report.valid,
      errors: contractErrors,
      warnings: [...report.warnings],
    },
  }
}

export function buildAuditIssueSummary(issues: AuditedIssue[]): AuditIssueSummary {
  return {
    auditedIssueCount: issues.length,
    invalidIssueCount: issues.filter((issue) => !issue.contract.valid).length,
    invalidReadyIssueCount: issues.filter((issue) => issue.state === 'ready' && !issue.contract.valid).length,
    lowScoreIssueCount: issues.filter((issue) => issue.qualityScore < LOW_SCORE_THRESHOLD).length,
    warningIssueCount: issues.filter((issue) => issue.contract.warnings.length > 0).length,
  }
}

export async function auditIssues(
  input: {
    issues: AuditableIssue[]
    includeSimulation: boolean
    repoRoot?: string
    config?: AgentConfig
  },
  deps: AuditIssuesDependencies = DEFAULT_AUDIT_ISSUES_DEPENDENCIES,
): Promise<AuditIssueContractsJsonReport> {
  if (input.includeSimulation && !input.repoRoot) {
    throw new Error('repoRoot is required when includeSimulation is enabled')
  }

  const auditedIssues = await Promise.all(input.issues.map(async (issue) => {
    const audited = buildAuditedIssue(issue)

    if (!input.includeSimulation) {
      return audited
    }

    const simulation = await deps.simulateIssueExecutability({
      issueTitle: issue.title,
      issueBody: issue.body,
      repoRoot: input.repoRoot!,
      config: input.config,
    })

    return {
      ...audited,
      simulation,
    }
  }))

  return buildAuditIssueContractsJsonReport(auditedIssues)
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
    summary: buildAuditIssueSummary(issues),
    issues: issues.map((issue) => ({
      ...issue,
      readyGateBlocked: !issue.contract.valid,
    })),
  }
}

export function formatAuditJsonReport(issues: AuditedIssue[]): string {
  return JSON.stringify(buildAuditIssueContractsJsonReport(issues), null, 2)
}

export function formatAuditOutput(
  report: AuditIssueContractsJsonReport,
  asJson = false,
): string {
  if (asJson) {
    return JSON.stringify(report, null, 2)
  }

  const lines = [
    `audited issues: ${report.summary.auditedIssueCount}`,
    `summary: invalid=${report.summary.invalidIssueCount} invalidReady=${report.summary.invalidReadyIssueCount} lowScore=${report.summary.lowScoreIssueCount} warnings=${report.summary.warningIssueCount}`,
    ...report.issues.map(formatAuditLine),
  ]

  const invalidReadySection = formatInvalidReadySection(
    report.issues.filter((issue) => issue.state === 'ready' && !issue.contract.valid),
  )
  if (invalidReadySection) {
    lines.push('', invalidReadySection)
  }

  const simulatedIssues = report.issues.filter((issue) => issue.simulation)
  if (simulatedIssues.length > 0) {
    lines.push('', 'simulation results:')
    for (const issue of simulatedIssues) {
      lines.push(
        `#${issue.number} simulation=${issue.simulation!.valid ? 'pass' : 'fail'} summary=${issue.simulation!.summary}`,
      )
      lines.push(...issue.simulation!.failures.map((failure) => `- ${failure}`))
    }
  }

  return lines.join('\n')
}

export function resolveAuditExitCode(
  report: AuditIssueContractsJsonReport,
  explicitIssueSet: boolean,
): number {
  return explicitIssueSet && report.summary.invalidIssueCount > 0 ? 1 : 0
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

function parsePositiveIssueNumber(value: string, flagName: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`)
  }

  return parsed
}

function parseArgs(argv: string[]): CliArgs & { json?: boolean; simulate?: boolean; issueNumbers: number[] } {
  let repo: string | undefined
  let json = false
  let simulate = false
  const issueNumbers: number[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--repo') {
      repo = argv[index + 1]
      index += 1
    } else if (arg === '--json') {
      json = true
    } else if (arg === '--simulate') {
      simulate = true
    } else if (arg === '--issue') {
      const rawIssueNumber = argv[index + 1]
      if (!rawIssueNumber) {
        throw new Error('--issue requires a value')
      }

      issueNumbers.push(parsePositiveIssueNumber(rawIssueNumber, '--issue'))
      index += 1
    }
  }

  return { repo, json, simulate, issueNumbers }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const config = loadConfig(args)
  const issues = args.issueNumbers.length > 0
    ? await Promise.all(args.issueNumbers.map(async (issueNumber) => {
        const issue = await getAgentIssueByNumber(issueNumber, config)
        if (!issue) {
          throw new Error(`Issue #${issueNumber} was not found in ${config.repo}`)
        }

        return issue
      }))
    : await listOpenAgentIssues(config)
  const report = await auditIssues({
    issues,
    includeSimulation: args.simulate ?? false,
    repoRoot: process.cwd(),
    config,
  })

  console.log(formatAuditOutput(report, args.json))
  const exitCode = resolveAuditExitCode(report, args.issueNumbers.length > 0)
  if (exitCode !== 0) {
    process.exit(exitCode)
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[audit-issue-contracts] failed:', error)
    process.exit(1)
  })
}
