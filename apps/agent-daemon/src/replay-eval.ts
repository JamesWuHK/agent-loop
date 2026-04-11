#!/usr/bin/env bun

import { readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  applyDependencyClaimability,
  deriveIssueStateFromRaw,
  parseIssueContract,
  validateIssueContract,
  type AgentIssue,
  type IssueComment,
  type ManagedPullRequest,
} from '@agent/shared'
import {
  getFailedIssueResumeBlock,
  listBlockedIssueResumeEscalationComments,
} from './daemon'

export interface ReplayIssueFixture {
  number: number
  title: string
  body: string
  labels: string[]
  assignees: string[]
  state: 'open' | 'closed'
  updatedAt: string
}

export interface ReplayIssueCommentFixture {
  issueNumber: number
  commentId?: number
  body: string
  createdAt: string
  updatedAt: string
}

export interface ReplayPullRequestFixture {
  number: number
  title: string
  labels: string[]
  isDraft?: boolean
  headRefName?: string
  headRefOid?: string | null
  url?: string
}

export interface ReplayFixtureSummary {
  claimable: number
  blocked: number
  invalid: number
}

export interface ReplayFixtureCase {
  name: string
  openIssues: ReplayIssueFixture[]
  issueComments: ReplayIssueCommentFixture[]
  openPullRequests: ReplayPullRequestFixture[]
  expected: ReplayFixtureSummary
}

export interface ReplayFixtureCaseResult {
  name: string
  ok: boolean
  actual: ReplayFixtureSummary
  expected: ReplayFixtureSummary
  mismatches: string[]
}

export interface ReplayFixtureReportSummary extends ReplayFixtureSummary {
  totalCases: number
  passedCases: number
  failedCases: number
}

export interface ReplayFixtureReport {
  ok: boolean
  cases: ReplayFixtureCaseResult[]
  summary: ReplayFixtureReportSummary
}

const DEFAULT_FIXTURES_DIR = 'apps/agent-daemon/src/fixtures/replay'
export const DEFAULT_BOOTSTRAP_SCENARIO_SUITE = 'self-bootstrap-v0.2'
export const REQUIRED_BOOTSTRAP_SCENARIO_CASES = [
  'self-bootstrap-happy-path',
  'self-bootstrap-closed-pr-recreate',
  'self-bootstrap-checks-pending',
  'self-bootstrap-checks-fail',
] as const

export interface BootstrapScenarioSuiteCaseReport {
  name: string
  ok: boolean
  present: boolean
  mismatches: string[]
  actual: ReplayFixtureSummary | null
  expected: ReplayFixtureSummary | null
}

export interface BootstrapScenarioSuiteReportSummary {
  requiredCases: number
  presentCases: number
  passedCases: number
  failedCases: number
}

export interface BootstrapScenarioSuiteReport {
  suite: string
  ok: boolean
  cases: BootstrapScenarioSuiteCaseReport[]
  failedCases: string[]
  summary: BootstrapScenarioSuiteReportSummary
}

export function evaluateReplayFixtures(fixtures: ReplayFixtureCase[]): ReplayFixtureReport {
  const caseResults = fixtures.map(evaluateReplayFixtureCase)

  return {
    ok: caseResults.every((fixture) => fixture.ok),
    cases: caseResults,
    summary: {
      totalCases: caseResults.length,
      passedCases: caseResults.filter((fixture) => fixture.ok).length,
      failedCases: caseResults.filter((fixture) => !fixture.ok).length,
      claimable: caseResults.reduce((total, fixture) => total + fixture.actual.claimable, 0),
      blocked: caseResults.reduce((total, fixture) => total + fixture.actual.blocked, 0),
      invalid: caseResults.reduce((total, fixture) => total + fixture.actual.invalid, 0),
    },
  }
}

export function evaluateReplayFixtureDirectory(fixturesDir: string): ReplayFixtureReport {
  return evaluateReplayFixtures(loadReplayFixtures(fixturesDir))
}

export function evaluateBootstrapScenarioSuite(input: {
  suite?: string
  cases: Array<{
    name: string
    ok: boolean
    present?: boolean
    mismatches?: string[]
    actual?: ReplayFixtureSummary | null
    expected?: ReplayFixtureSummary | null
  }>
}): BootstrapScenarioSuiteReport {
  const reportedCases = new Map(input.cases.map((fixture) => [fixture.name, fixture]))
  const cases = REQUIRED_BOOTSTRAP_SCENARIO_CASES.map<BootstrapScenarioSuiteCaseReport>((name) => {
    const reportedCase = reportedCases.get(name)
    if (!reportedCase) {
      return {
        name,
        ok: false,
        present: false,
        mismatches: ['required self-bootstrap scenario is missing'],
        actual: null,
        expected: null,
      }
    }

    return {
      name,
      ok: reportedCase.ok,
      present: reportedCase.present ?? true,
      mismatches: [...(reportedCase.mismatches ?? [])],
      actual: reportedCase.actual ?? null,
      expected: reportedCase.expected ?? null,
    }
  })
  const failedCases = cases.filter((fixture) => !fixture.ok).map((fixture) => fixture.name)

  return {
    suite: input.suite ?? DEFAULT_BOOTSTRAP_SCENARIO_SUITE,
    ok: failedCases.length === 0,
    cases,
    failedCases,
    summary: {
      requiredCases: REQUIRED_BOOTSTRAP_SCENARIO_CASES.length,
      presentCases: cases.filter((fixture) => fixture.present).length,
      passedCases: cases.filter((fixture) => fixture.ok).length,
      failedCases: failedCases.length,
    },
  }
}

export function evaluateBootstrapScenarioFixtureDirectory(
  fixturesDir: string,
): BootstrapScenarioSuiteReport {
  const replayReport = evaluateReplayFixtureDirectory(fixturesDir)

  return evaluateBootstrapScenarioSuite({
    suite: DEFAULT_BOOTSTRAP_SCENARIO_SUITE,
    cases: replayReport.cases.map((fixture) => ({
      name: fixture.name,
      ok: fixture.ok,
      present: true,
      mismatches: fixture.mismatches,
      actual: fixture.actual,
      expected: fixture.expected,
    })),
  })
}

export function loadReplayFixtures(fixturesDir: string): ReplayFixtureCase[] {
  const resolvedDir = resolve(fixturesDir)
  const fixtureFiles = readdirSync(resolvedDir)
    .filter((entry) => entry.endsWith('.json'))
    .sort((left, right) => left.localeCompare(right))

  return fixtureFiles.map((entry) => {
    const filePath = join(resolvedDir, entry)
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<ReplayFixtureCase>
    return normalizeReplayFixture(parsed, basename(entry, '.json'))
  })
}

export function formatReplayFixtureReport(report: ReplayFixtureReport): string {
  const lines = ['Replay Eval']

  for (const fixture of report.cases) {
    const status = fixture.ok ? 'ok' : 'failed'
    const mismatchSuffix = fixture.mismatches.length > 0
      ? ` mismatches=${fixture.mismatches.join(' | ')}`
      : ''
    lines.push(
      `${fixture.name}: ${status} actual=${formatReplaySummary(fixture.actual)} expected=${formatReplaySummary(fixture.expected)}${mismatchSuffix}`,
    )
  }

  lines.push(
    `summary: total=${report.summary.totalCases} passed=${report.summary.passedCases} failed=${report.summary.failedCases} actual=${formatReplaySummary(report.summary)}`,
  )

  return lines.join('\n')
}

export function formatBootstrapScenarioSuiteReport(
  report: BootstrapScenarioSuiteReport,
): string {
  return [
    'Bootstrap Scenarios',
    `suite=${report.suite}`,
    `ok=${report.ok}`,
    'cases:',
    ...report.cases.map((fixture) => {
      const status = fixture.ok ? 'ok' : fixture.present ? 'failed' : 'missing'
      const mismatchSuffix = fixture.mismatches.length > 0
        ? ` mismatches=${fixture.mismatches.join(' | ')}`
        : ''
      return `- ${fixture.name}: ${status}${mismatchSuffix}`
    }),
    `failedCases=${report.failedCases.join(',') || '-'}`,
    `summary: required=${report.summary.requiredCases} present=${report.summary.presentCases} passed=${report.summary.passedCases} failed=${report.summary.failedCases}`,
  ].join('\n')
}

export function formatBootstrapScenarioSuiteReportJson(
  report: BootstrapScenarioSuiteReport,
): string {
  return JSON.stringify(report, null, 2)
}

export function resolveBootstrapScenarioSuiteExitCode(
  report: Pick<BootstrapScenarioSuiteReport, 'ok'>,
): number {
  return report.ok ? 0 : 1
}

function evaluateReplayFixtureCase(fixture: ReplayFixtureCase): ReplayFixtureCaseResult {
  const openIssues = applyDependencyClaimability(
    fixture.openIssues.map(mapReplayIssueFixture),
  )
  const invalidIssueNumbers = new Set(
    openIssues
      .filter((issue) => issue.state === 'ready' && (!issue.hasExecutableContract || issue.dependencyParseError))
      .map((issue) => issue.number),
  )
  const blockedIssueNumbers = new Set<number>()

  for (const issue of openIssues) {
    if (issue.state === 'ready' && !issue.isClaimable && !invalidIssueNumbers.has(issue.number)) {
      blockedIssueNumbers.add(issue.number)
    }
  }

  for (const issueNumber of evaluateBlockedResumeIssueNumbers(fixture.openIssues, fixture.issueComments, fixture.openPullRequests)) {
    blockedIssueNumbers.add(issueNumber)
  }

  const actual: ReplayFixtureSummary = {
    claimable: openIssues.filter((issue) => issue.isClaimable).length,
    blocked: blockedIssueNumbers.size,
    invalid: invalidIssueNumbers.size,
  }
  const mismatches = compareReplaySummary(actual, fixture.expected)

  return {
    name: fixture.name,
    ok: mismatches.length === 0,
    actual,
    expected: fixture.expected,
    mismatches,
  }
}

function mapReplayIssueFixture(issue: ReplayIssueFixture): AgentIssue {
  const contract = parseIssueContract(issue.body)
  const validation = validateIssueContract(contract)

  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: deriveIssueStateFromRaw(issue.labels, issue.state),
    labels: [...issue.labels],
    assignee: issue.assignees[0] ?? null,
    isClaimable: false,
    updatedAt: issue.updatedAt,
    dependencyIssueNumbers: contract.dependencies,
    hasDependencyMetadata: contract.hasDependencyMetadata,
    dependencyParseError: contract.dependencyParseError,
    claimBlockedBy: [],
    hasExecutableContract: validation.valid,
    contractValidationErrors: validation.errors,
  }
}

function evaluateBlockedResumeIssueNumbers(
  openIssues: ReplayIssueFixture[],
  issueComments: ReplayIssueCommentFixture[],
  openPullRequests: ReplayPullRequestFixture[],
): Set<number> {
  const blockedIssueNumbers = new Set<number>()

  for (const issue of openIssues) {
    const issueState = deriveIssueStateFromRaw(issue.labels, issue.state)
    if (issueState !== 'failed') {
      continue
    }

    const linkedPr = openPullRequests
      .map(mapReplayPullRequestFixture)
      .find((pullRequest) => extractIssueNumberFromPrTitle(pullRequest.title) === issue.number) ?? null
    const issueScopedComments = issueComments
      .filter((comment) => comment.issueNumber === issue.number)
      .map(mapReplayIssueCommentFixture)

    if (
      listBlockedIssueResumeEscalationComments(
        issueScopedComments,
        issue.number,
        linkedPr?.number ?? null,
      ).length > 0
    ) {
      blockedIssueNumbers.add(issue.number)
      continue
    }

    if (getFailedIssueResumeBlock(linkedPr, false) !== null) {
      blockedIssueNumbers.add(issue.number)
    }
  }

  return blockedIssueNumbers
}

function mapReplayPullRequestFixture(pullRequest: ReplayPullRequestFixture): ManagedPullRequest {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url ?? `https://example.invalid/pr/${pullRequest.number}`,
    headRefName: pullRequest.headRefName ?? `agent/${pullRequest.number}`,
    headRefOid: pullRequest.headRefOid ?? null,
    isDraft: pullRequest.isDraft ?? false,
    labels: [...pullRequest.labels],
  }
}

function mapReplayIssueCommentFixture(comment: ReplayIssueCommentFixture, index: number): IssueComment
function mapReplayIssueCommentFixture(comment: ReplayIssueCommentFixture): IssueComment
function mapReplayIssueCommentFixture(comment: ReplayIssueCommentFixture, index = 0): IssueComment {
  return {
    commentId: comment.commentId ?? index + 1,
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  }
}

function compareReplaySummary(actual: ReplayFixtureSummary, expected: ReplayFixtureSummary): string[] {
  const keys: Array<keyof ReplayFixtureSummary> = ['claimable', 'blocked', 'invalid']

  return keys
    .filter((key) => actual[key] !== expected[key])
    .map((key) => `${key}: expected ${expected[key]}, received ${actual[key]}`)
}

function normalizeReplayFixture(parsed: Partial<ReplayFixtureCase>, fallbackName: string): ReplayFixtureCase {
  if (typeof parsed.name !== 'string' && parsed.name !== undefined) {
    throw new Error(`Fixture ${fallbackName} has a non-string name`)
  }

  return {
    name: typeof parsed.name === 'string' && parsed.name.trim().length > 0
      ? parsed.name.trim()
      : fallbackName,
    openIssues: normalizeOpenIssues(parsed.openIssues, fallbackName),
    issueComments: normalizeIssueComments(parsed.issueComments, fallbackName),
    openPullRequests: normalizePullRequests(parsed.openPullRequests, fallbackName),
    expected: normalizeExpectedSummary(parsed.expected, fallbackName),
  }
}

function normalizeOpenIssues(input: unknown, fixtureName: string): ReplayIssueFixture[] {
  if (!Array.isArray(input)) {
    throw new Error(`Fixture ${fixtureName} must define openIssues as an array`)
  }

  return input.map((issue, index) => {
    if (!issue || typeof issue !== 'object') {
      throw new Error(`Fixture ${fixtureName} openIssues[${index}] must be an object`)
    }

    const candidate = issue as Partial<ReplayIssueFixture>
    if (
      !Number.isInteger(candidate.number)
      || typeof candidate.title !== 'string'
      || typeof candidate.body !== 'string'
      || !Array.isArray(candidate.labels)
      || !Array.isArray(candidate.assignees)
      || (candidate.state !== 'open' && candidate.state !== 'closed')
      || typeof candidate.updatedAt !== 'string'
    ) {
      throw new Error(`Fixture ${fixtureName} openIssues[${index}] is malformed`)
    }

    const number = candidate.number as number
    const title = candidate.title
    const body = candidate.body
    const state = candidate.state
    const updatedAt = candidate.updatedAt

    return {
      number,
      title,
      body,
      labels: candidate.labels.filter((label): label is string => typeof label === 'string'),
      assignees: candidate.assignees.filter((assignee): assignee is string => typeof assignee === 'string'),
      state,
      updatedAt,
    }
  })
}

function normalizeIssueComments(input: unknown, fixtureName: string): ReplayIssueCommentFixture[] {
  if (!Array.isArray(input)) {
    throw new Error(`Fixture ${fixtureName} must define issueComments as an array`)
  }

  return input.map((comment, index) => {
    if (!comment || typeof comment !== 'object') {
      throw new Error(`Fixture ${fixtureName} issueComments[${index}] must be an object`)
    }

    const candidate = comment as Partial<ReplayIssueCommentFixture>
    if (
      !Number.isInteger(candidate.issueNumber)
      || typeof candidate.body !== 'string'
      || typeof candidate.createdAt !== 'string'
      || typeof candidate.updatedAt !== 'string'
    ) {
      throw new Error(`Fixture ${fixtureName} issueComments[${index}] is malformed`)
    }

    const issueNumber = candidate.issueNumber as number
    const body = candidate.body
    const createdAt = candidate.createdAt
    const updatedAt = candidate.updatedAt

    return {
      issueNumber,
      commentId: Number.isInteger(candidate.commentId) ? candidate.commentId : undefined,
      body,
      createdAt,
      updatedAt,
    }
  })
}

function normalizePullRequests(input: unknown, fixtureName: string): ReplayPullRequestFixture[] {
  if (!Array.isArray(input)) {
    throw new Error(`Fixture ${fixtureName} must define openPullRequests as an array`)
  }

  return input.map((pullRequest, index) => {
    if (!pullRequest || typeof pullRequest !== 'object') {
      throw new Error(`Fixture ${fixtureName} openPullRequests[${index}] must be an object`)
    }

    const candidate = pullRequest as Partial<ReplayPullRequestFixture>
    if (
      !Number.isInteger(candidate.number)
      || typeof candidate.title !== 'string'
      || !Array.isArray(candidate.labels)
    ) {
      throw new Error(`Fixture ${fixtureName} openPullRequests[${index}] is malformed`)
    }

    const number = candidate.number as number
    const title = candidate.title

    return {
      number,
      title,
      labels: candidate.labels.filter((label): label is string => typeof label === 'string'),
      isDraft: candidate.isDraft,
      headRefName: candidate.headRefName,
      headRefOid: candidate.headRefOid,
      url: candidate.url,
    }
  })
}

function normalizeExpectedSummary(input: unknown, fixtureName: string): ReplayFixtureSummary {
  if (!input || typeof input !== 'object') {
    throw new Error(`Fixture ${fixtureName} must define expected summary fields`)
  }

  const candidate = input as Partial<ReplayFixtureSummary>
  if (
    !Number.isInteger(candidate.claimable)
    || !Number.isInteger(candidate.blocked)
    || !Number.isInteger(candidate.invalid)
  ) {
    throw new Error(`Fixture ${fixtureName} expected summary is malformed`)
  }

  return {
    claimable: candidate.claimable as number,
    blocked: candidate.blocked as number,
    invalid: candidate.invalid as number,
  }
}

function formatReplaySummary(summary: ReplayFixtureSummary): string {
  return `claimable=${summary.claimable} blocked=${summary.blocked} invalid=${summary.invalid}`
}

function extractIssueNumberFromPrTitle(title: string): number | null {
  const match = title.match(/#(\d+)/)
  if (!match) return null

  const parsed = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(parsed) ? parsed : null
}

function parseArgs(argv: string[]): {
  fixturesDir: string
} {
  let fixturesDir = DEFAULT_FIXTURES_DIR

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token) {
      continue
    }

    if (token === '--fixtures-dir') {
      const nextToken = argv[index + 1]
      fixturesDir = typeof nextToken === 'string' ? nextToken : fixturesDir
      index += 1
      continue
    }

    if (!token.startsWith('-')) {
      fixturesDir = token
    }
  }

  return {
    fixturesDir,
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const report = evaluateReplayFixtureDirectory(args.fixturesDir)

  console.log(formatReplayFixtureReport(report))
  process.exit(report.ok ? 0 : 1)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[replay-eval] failed:', error)
    process.exit(1)
  })
}
