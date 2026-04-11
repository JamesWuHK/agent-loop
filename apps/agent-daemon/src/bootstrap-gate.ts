import { join } from 'node:path'
import {
  getAgentIssueByNumber,
  type AgentConfig,
  type AgentIssue,
} from '@agent/shared'
import {
  buildBootstrapScorecardForRepo,
  type BootstrapScorecard,
  type BootstrapScorecardBlocker,
} from './bootstrap-scorecard'
import {
  buildLocalImplementationIndex,
  type LocalImplementationRecord,
} from './local-implementation'
import {
  evaluateBootstrapScenarioFixtureDirectory,
  type BootstrapScenarioSuiteReport,
} from './replay-eval'

export const DEFAULT_BOOTSTRAP_GATE_VERSION = 'v0.2'
export const DEFAULT_BOOTSTRAP_BLOCKER_ISSUE_NUMBERS = [
  37, 38, 39, 40, 50, 51, 53, 54, 60, 61,
] as const

const DEFAULT_REQUIRED_EVIDENCE_SPECS = [
  {
    code: 'self_bootstrap_suite_green',
    sourceIssueNumber: 69,
    summary: 'awaiting the deterministic self-bootstrap scenario suite tracked by #69',
  },
  {
    code: 'bootstrap_scorecard_green',
    sourceIssueNumber: 70,
    summary: 'awaiting the bootstrap scorecard taxonomy report tracked by #70',
  },
] as const
const DEFAULT_BOOTSTRAP_SCENARIO_FIXTURES_DIR = join(import.meta.dir, 'fixtures', 'replay')

export interface BootstrapGateBlocker {
  issueNumber: number
  state: string
  labels: string[]
  title?: string | null
  implementedLocally?: boolean
  localImplementationHeadline?: string | null
}

export interface BootstrapGateEvidence {
  code: string
  satisfied: boolean
  sourceIssueNumber?: number | null
  summary?: string | null
}

export interface BootstrapGateReport {
  version: string
  ready: boolean
  blockers: BootstrapGateBlocker[]
  requiredEvidence: BootstrapGateEvidence[]
  blockingReasons: string[]
}

interface BuildBootstrapGateReportInput {
  version: string
  blockers: BootstrapGateBlocker[]
  requiredEvidence: BootstrapGateEvidence[]
}

interface BuildBootstrapGateReportForRepoInput {
  config: AgentConfig
  version?: string
  fixturesDir?: string
  repoRoot?: string
}

interface BootstrapGateDependencies {
  getAgentIssueByNumber: typeof getAgentIssueByNumber
  evaluateBootstrapScenarioFixtureDirectory: typeof evaluateBootstrapScenarioFixtureDirectory
  buildBootstrapScorecardForRepo: typeof buildBootstrapScorecardForRepo
  buildLocalImplementationIndex: typeof buildLocalImplementationIndex
}

const DEFAULT_BOOTSTRAP_GATE_DEPENDENCIES: BootstrapGateDependencies = {
  getAgentIssueByNumber,
  evaluateBootstrapScenarioFixtureDirectory,
  buildBootstrapScorecardForRepo,
  buildLocalImplementationIndex,
}

export function buildBootstrapGateReport(
  input: BuildBootstrapGateReportInput,
): BootstrapGateReport {
  const blockers = input.blockers.map((blocker) => ({
    ...blocker,
    labels: [...blocker.labels],
  }))
  const requiredEvidence = input.requiredEvidence.map((evidence) => ({
    ...evidence,
  }))
  const blockingReasons = [
    ...blockers
      .filter((blocker) => !isBootstrapBlockerDone(blocker))
      .map((blocker) => `issue #${blocker.issueNumber} is not done (state=${blocker.state}, labels=${formatBootstrapLabels(blocker.labels)})`),
    ...requiredEvidence
      .filter((evidence) => !evidence.satisfied)
      .map((evidence) => `missing required evidence: ${evidence.code}`),
  ]

  return {
    version: input.version,
    ready: blockingReasons.length === 0,
    blockers,
    requiredEvidence,
    blockingReasons,
  }
}

export async function buildBootstrapGateReportForRepo(
  input: BuildBootstrapGateReportForRepoInput,
  deps: BootstrapGateDependencies = DEFAULT_BOOTSTRAP_GATE_DEPENDENCIES,
): Promise<BootstrapGateReport> {
  const localImplementationIndex = deps.buildLocalImplementationIndex(input.repoRoot)
  const [blockers, requiredEvidence] = await Promise.all([
    Promise.all(
      DEFAULT_BOOTSTRAP_BLOCKER_ISSUE_NUMBERS.map(async (issueNumber) => {
        const issue = await deps.getAgentIssueByNumber(issueNumber, input.config)
        return buildBootstrapGateBlocker(
          issueNumber,
          issue,
          localImplementationIndex.get(issueNumber) ?? null,
        )
      }),
    ),
    Promise.all([
      buildScenarioSuiteEvidence({
        fixturesDir: input.fixturesDir ?? DEFAULT_BOOTSTRAP_SCENARIO_FIXTURES_DIR,
        deps,
      }),
      buildBootstrapScorecardEvidence({
        config: input.config,
        repoRoot: input.repoRoot,
        deps,
      }),
    ]),
  ])

  return buildBootstrapGateReport({
    version: input.version ?? DEFAULT_BOOTSTRAP_GATE_VERSION,
    blockers,
    requiredEvidence,
  })
}

export function formatBootstrapGateReport(
  report: BootstrapGateReport,
): string {
  return [
    'Bootstrap Gate',
    `version=${report.version}`,
    `ready=${report.ready}`,
    'blockers:',
    ...report.blockers.map((blocker) => `- #${blocker.issueNumber} state=${blocker.state} labels=${formatBootstrapLabels(blocker.labels)}${blocker.title ? ` title=${blocker.title}` : ''}${blocker.implementedLocally ? ` locallyImplemented=true${blocker.localImplementationHeadline ? ` localCommit=${blocker.localImplementationHeadline}` : ''}` : ''}`),
    'requiredEvidence:',
    ...report.requiredEvidence.map((evidence) => `- ${evidence.code}: ${evidence.satisfied ? 'satisfied' : 'missing'}${evidence.sourceIssueNumber ? ` sourceIssue=#${evidence.sourceIssueNumber}` : ''}${evidence.summary ? ` summary=${evidence.summary}` : ''}`),
    'blockingReasons:',
    ...(report.blockingReasons.length > 0
      ? report.blockingReasons.map((reason) => `- ${reason}`)
      : ['- none']),
  ].join('\n')
}

export function formatBootstrapGateReportJson(
  report: BootstrapGateReport,
): string {
  return JSON.stringify(report, null, 2)
}

export function resolveBootstrapGateExitCode(
  report: Pick<BootstrapGateReport, 'ready'>,
): number {
  return report.ready ? 0 : 1
}

function isBootstrapBlockerDone(
  blocker: Pick<BootstrapGateBlocker, 'state' | 'implementedLocally'>,
): boolean {
  const normalized = blocker.state.trim().toLowerCase()
  return normalized === 'done' || normalized === 'closed' || blocker.implementedLocally === true
}

function formatBootstrapLabels(labels: string[]): string {
  return labels.length > 0 ? labels.join(',') : '-'
}

function buildBootstrapGateBlocker(
  issueNumber: number,
  issue: AgentIssue | null,
  localImplementation: LocalImplementationRecord | null,
): BootstrapGateBlocker {
  return {
    issueNumber,
    state: issue?.state ?? 'missing',
    labels: issue?.labels ? [...issue.labels] : [],
    title: issue?.title ?? null,
    implementedLocally: localImplementation !== null,
    localImplementationHeadline: localImplementation?.latestCommitHeadline ?? null,
  }
}

async function buildScenarioSuiteEvidence(input: {
  fixturesDir: string
  deps: BootstrapGateDependencies
}): Promise<BootstrapGateEvidence> {
  const spec = DEFAULT_REQUIRED_EVIDENCE_SPECS[0]

  try {
    const report = await Promise.resolve(
      input.deps.evaluateBootstrapScenarioFixtureDirectory(input.fixturesDir),
    )
    return {
      code: spec.code,
      satisfied: report.ok,
      sourceIssueNumber: spec.sourceIssueNumber,
      summary: report.ok
        ? `scenario suite ${report.suite} passed (${report.summary.passedCases}/${report.summary.requiredCases} required cases)`
        : summarizeScenarioSuiteFailure(report),
    }
  } catch (error) {
    return {
      code: spec.code,
      satisfied: false,
      sourceIssueNumber: spec.sourceIssueNumber,
      summary: `scenario suite evaluation failed: ${formatBootstrapGateError(error)}`,
    }
  }
}

async function buildBootstrapScorecardEvidence(input: {
  config: AgentConfig
  repoRoot?: string
  deps: BootstrapGateDependencies
}): Promise<BootstrapGateEvidence> {
  const spec = DEFAULT_REQUIRED_EVIDENCE_SPECS[1]

  try {
    const scorecard = await input.deps.buildBootstrapScorecardForRepo({
      config: input.config,
      repoRoot: input.repoRoot,
    })
    return {
      code: spec.code,
      satisfied: scorecard.ready,
      sourceIssueNumber: spec.sourceIssueNumber,
      summary: scorecard.ready
        ? 'bootstrap scorecard reported ready with no blockers'
        : summarizeBootstrapScorecardFailure(scorecard),
    }
  } catch (error) {
    return {
      code: spec.code,
      satisfied: false,
      sourceIssueNumber: spec.sourceIssueNumber,
      summary: `bootstrap scorecard evaluation failed: ${formatBootstrapGateError(error)}`,
    }
  }
}

function summarizeScenarioSuiteFailure(
  report: BootstrapScenarioSuiteReport,
): string {
  return `scenario suite ${report.suite} failed (${report.summary.failedCases}/${report.summary.requiredCases} required cases failed: ${report.failedCases.join(',') || 'unknown'})`
}

function summarizeBootstrapScorecardFailure(
  scorecard: BootstrapScorecard,
): string {
  const topBlocker = scorecard.topBlockers[0]
  if (!topBlocker) {
    return 'bootstrap scorecard is not ready'
  }

  return `bootstrap scorecard still reports blockers: ${topBlocker.category}${formatBootstrapScorecardBlockerTarget(topBlocker)}: ${topBlocker.reason}`
}

function formatBootstrapScorecardBlockerTarget(
  blocker: BootstrapScorecardBlocker,
): string {
  const refs: string[] = []
  if (blocker.issueNumber !== null && blocker.issueNumber !== undefined) {
    refs.push(`#${blocker.issueNumber}`)
  }
  if (blocker.prNumber !== null && blocker.prNumber !== undefined) {
    refs.push(`PR #${blocker.prNumber}`)
  }

  return refs.length > 0 ? ` for ${refs.join(' / ')}` : ''
}

function formatBootstrapGateError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }

  return String(error)
}
