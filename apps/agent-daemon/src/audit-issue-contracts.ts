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
import { runConfiguredAgent } from './cli-agent'
import {
  simulateIssueExecutability,
  type IssueSimulationPlannerRunner,
  type IssueSimulationResult,
} from './issue-simulate'

export const LOW_ISSUE_QUALITY_SCORE_THRESHOLD = 80

export interface AuditedIssue {
  number: number
  title: string
  state: string
  labels: string[]
  isClaimable: boolean
  hasExecutableContract: boolean
  claimBlockedBy: number[]
  contractValidationErrors: string[]
  qualityScore: number
  contractWarnings: string[]
  contract: IssueLintReport
  simulation?: IssueSimulationResult
}

export interface AuditIssuesSummary {
  auditedIssueCount: number
  invalidIssueCount: number
  invalidReadyIssueCount: number
  lowScoreIssueCount: number
  warningIssueCount: number
}

export interface IssueOpsSummary {
  invalidReadyIssueCount: number
  lowScoreIssueCount: number
  warningIssueCount: number
}

export interface AuditIssuesReport {
  summary: AuditIssuesSummary
  issues: AuditedIssue[]
}

export type AuditIssueContractsJsonReport = AuditIssuesReport

export interface AuditIssuesInput {
  issues: Array<Pick<
    AgentIssue,
    | 'number'
    | 'title'
    | 'body'
    | 'state'
    | 'labels'
    | 'isClaimable'
    | 'claimBlockedBy'
    | 'hasExecutableContract'
    | 'contractValidationErrors'
  >>
  repo: string
  includeSimulation?: boolean
  repoRoot?: string
  runPlanner?: IssueSimulationPlannerRunner
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

interface LoadIssuesForAuditDependencies {
  listOpenAgentIssues: typeof listOpenAgentIssues
  getAgentIssueByNumber: typeof getAgentIssueByNumber
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

const DEFAULT_LOAD_ISSUES_FOR_AUDIT_DEPENDENCIES: LoadIssuesForAuditDependencies = {
  listOpenAgentIssues,
  getAgentIssueByNumber,
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

export async function loadIssuesForAudit(
  input: {
    config: AgentConfig
    issueNumbers?: number[]
  },
  deps: LoadIssuesForAuditDependencies = DEFAULT_LOAD_ISSUES_FOR_AUDIT_DEPENDENCIES,
): Promise<AgentIssue[]> {
  const issueNumbers = dedupeIssueNumbers(input.issueNumbers ?? [])

  if (issueNumbers.length === 0) {
    return deps.listOpenAgentIssues(input.config)
  }

  const issues = await Promise.all(issueNumbers.map(async (issueNumber) => {
    const issue = await deps.getAgentIssueByNumber(issueNumber, input.config)
    if (!issue) {
      throw new Error(`Issue #${issueNumber} was not found in ${input.config.repo}`)
    }
    return issue
  }))

  return issues
}

export async function auditIssues(
  input: AuditIssuesInput,
): Promise<AuditIssuesReport> {
  if (input.includeSimulation && !input.runPlanner) {
    throw new Error('auditIssues includeSimulation requires runPlanner')
  }

  const issues = await Promise.all(input.issues.map(async (issue) => {
    const contract = buildIssueLintReport(issue.body, {
      kind: 'issue',
      issueNumber: issue.number,
      repo: input.repo,
    }, issue.title)
    const simulation = input.includeSimulation
      ? await simulateIssueExecutability({
          issueTitle: issue.title,
          issueBody: issue.body,
          repoRoot: input.repoRoot,
          runPlanner: input.runPlanner!,
        })
      : undefined

    return {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      labels: [...issue.labels],
      isClaimable: issue.isClaimable,
      hasExecutableContract: contract.valid,
      claimBlockedBy: [...issue.claimBlockedBy],
      contractValidationErrors: [...contract.errors],
      qualityScore: contract.score,
      contractWarnings: [...contract.warnings],
      contract,
      simulation,
    }
  }))

  return {
    summary: buildAuditSummary(issues),
    issues,
  }
}

export function formatAuditLine(issue: AuditedIssue): string {
  const simulationStatus = issue.simulation
    ? ` simulate=${issue.simulation.valid ? 'pass' : 'fail'}`
    : ''

  return `#${issue.number} state=${issue.state} claimable=${issue.isClaimable} `
    + `contract=${issue.hasExecutableContract} score=${issue.qualityScore} warnings=${issue.contractWarnings.length}`
    + `${simulationStatus} `
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
      ...(issue.simulation?.valid === false
        ? issue.simulation.failures.map((failure) => `- simulate: ${failure}`)
        : []),
    ]),
  ].join('\n')
}

export function buildAuditIssueContractsJsonReport(
  input: AuditedIssue[] | AuditIssuesReport,
): AuditIssueContractsJsonReport {
  if ('summary' in input) {
    return input
  }

  return {
    summary: buildAuditSummary(input),
    issues: input,
  }
}

export function formatAuditJsonReport(
  input: AuditedIssue[] | AuditIssuesReport,
): string {
  return JSON.stringify(buildAuditIssueContractsJsonReport(input), null, 2)
}

export function formatAuditOutput(
  report: AuditIssuesReport,
  asJson = false,
): string {
  if (asJson) {
    return formatAuditJsonReport(report)
  }

  const lines = [
    `audited issues: ${report.summary.auditedIssueCount}`,
    `invalid issues: ${report.summary.invalidIssueCount}`,
    `invalid ready issues: ${report.summary.invalidReadyIssueCount}`,
    `low score issues: ${report.summary.lowScoreIssueCount}`,
    `warning issues: ${report.summary.warningIssueCount}`,
  ]

  if (report.issues.length > 0) {
    lines.push('', ...report.issues.map(formatAuditLine))
  }

  const invalidReadySection = formatInvalidReadySection(
    report.issues.filter((issue) => issue.state === 'ready' && !issue.hasExecutableContract),
  )
  if (invalidReadySection) {
    lines.push('', invalidReadySection)
  }

  return lines.join('\n')
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

export function buildIssueOpsSummary(input: Array<{
  state: string
  readyGateBlocked: boolean
  qualityScore: number
  warningCount: number
}>): IssueOpsSummary {
  return {
    invalidReadyIssueCount: input.filter((issue) => issue.state === 'ready' && issue.readyGateBlocked).length,
    lowScoreIssueCount: input.filter((issue) => issue.qualityScore < LOW_ISSUE_QUALITY_SCORE_THRESHOLD).length,
    warningIssueCount: input.filter((issue) => issue.warningCount > 0).length,
  }
}

function buildAuditSummary(issues: AuditedIssue[]): AuditIssuesSummary {
  const issueOpsSummary = buildIssueOpsSummary(issues.map((issue) => ({
    state: issue.state,
    readyGateBlocked: issue.contract.readyGateBlocked,
    qualityScore: issue.qualityScore,
    warningCount: issue.contractWarnings.length,
  })))

  return {
    auditedIssueCount: issues.length,
    invalidIssueCount: issues.filter((issue) => !issue.contract.valid).length,
    invalidReadyIssueCount: issueOpsSummary.invalidReadyIssueCount,
    lowScoreIssueCount: issueOpsSummary.lowScoreIssueCount,
    warningIssueCount: issueOpsSummary.warningIssueCount,
  }
}

function dedupeIssueNumbers(issueNumbers: number[]): number[] {
  const seen = new Set<number>()
  const deduped: number[] = []

  for (const issueNumber of issueNumbers) {
    if (seen.has(issueNumber)) continue
    seen.add(issueNumber)
    deduped.push(issueNumber)
  }

  return deduped
}

function parseIssueNumber(value: string, flag: string): number {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${flag} must be a positive integer`)
  }

  return parseInt(trimmed, 10)
}

function parseArgs(argv: string[]): CliArgs & {
  json?: boolean
  issueNumbers?: number[]
  simulate?: boolean
} {
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
      const value = argv[index + 1]
      if (typeof value !== 'string') {
        throw new Error('--issue requires a number')
      }
      issueNumbers.push(parseIssueNumber(value, '--issue'))
      index += 1
    }
  }

  return {
    repo,
    json,
    simulate,
    issueNumbers: dedupeIssueNumbers(issueNumbers),
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const config = loadConfig(args)
  const issues = await loadIssuesForAudit({
    config,
    issueNumbers: args.issueNumbers,
  })
  const report = await auditIssues({
    issues,
    repo: config.repo,
    includeSimulation: args.simulate,
    repoRoot: process.cwd(),
    runPlanner: args.simulate
      ? async ({ prompt, repoRoot }) => {
          const result = await runConfiguredAgent({
            prompt,
            worktreePath: repoRoot,
            timeoutMs: config.agent.timeoutMs,
            config,
            logger: console,
            allowWrites: false,
          })

          if (!result.ok) {
            throw new Error(result.stderr || result.stdout || 'Issue audit simulation agent execution failed')
          }

          return {
            responseText: result.responseText,
          }
        }
      : undefined,
  })

  console.log(formatAuditOutput(report, args.json))

  if ((args.issueNumbers?.length ?? 0) > 0 && report.summary.invalidIssueCount > 0) {
    process.exitCode = 1
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[audit-issue-contracts] failed:', error)
    process.exit(1)
  })
}
