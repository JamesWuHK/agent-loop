import {
  getAgentIssueByNumber,
  type AgentConfig,
  type AgentIssue,
} from '@agent/shared'

export const DEFAULT_BOOTSTRAP_GATE_VERSION = 'v0.2'
export const DEFAULT_BOOTSTRAP_BLOCKER_ISSUE_NUMBERS = [
  37, 38, 39, 40, 50, 51, 53, 54, 60, 61,
] as const

const DEFAULT_REQUIRED_EVIDENCE_SPECS = [
  {
    code: 'self_bootstrap_suite_green',
    issueNumber: 69,
    summary: 'awaiting the deterministic self-bootstrap scenario suite tracked by #69',
  },
  {
    code: 'bootstrap_scorecard_green',
    issueNumber: 70,
    summary: 'awaiting the bootstrap scorecard taxonomy report tracked by #70',
  },
] as const

export interface BootstrapGateBlocker {
  issueNumber: number
  state: string
  labels: string[]
  title?: string | null
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
}

interface BootstrapGateDependencies {
  getAgentIssueByNumber: typeof getAgentIssueByNumber
}

const DEFAULT_BOOTSTRAP_GATE_DEPENDENCIES: BootstrapGateDependencies = {
  getAgentIssueByNumber,
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
  const issueNumbers = new Set<number>(DEFAULT_BOOTSTRAP_BLOCKER_ISSUE_NUMBERS)
  for (const evidence of DEFAULT_REQUIRED_EVIDENCE_SPECS) {
    issueNumbers.add(evidence.issueNumber)
  }

  const issues = await Promise.all(
    [...issueNumbers].map(async (issueNumber) => [
      issueNumber,
      await deps.getAgentIssueByNumber(issueNumber, input.config),
    ] as const),
  )
  const issueMap = new Map<number, AgentIssue | null>(issues)

  return buildBootstrapGateReport({
    version: input.version ?? DEFAULT_BOOTSTRAP_GATE_VERSION,
    blockers: DEFAULT_BOOTSTRAP_BLOCKER_ISSUE_NUMBERS.map((issueNumber) => {
      const issue = issueMap.get(issueNumber) ?? null
      return {
        issueNumber,
        state: issue?.state ?? 'missing',
        labels: issue?.labels ? [...issue.labels] : [],
        title: issue?.title ?? null,
      }
    }),
    requiredEvidence: DEFAULT_REQUIRED_EVIDENCE_SPECS.map((evidence) => {
      const issue = issueMap.get(evidence.issueNumber) ?? null
      return {
        code: evidence.code,
        satisfied: issue?.state === 'done',
        sourceIssueNumber: evidence.issueNumber,
        summary: issue?.state === 'done'
          ? `tracked by #${evidence.issueNumber} and currently done`
          : evidence.summary,
      }
    }),
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
    ...report.blockers.map((blocker) => `- #${blocker.issueNumber} state=${blocker.state} labels=${formatBootstrapLabels(blocker.labels)}${blocker.title ? ` title=${blocker.title}` : ''}`),
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
  blocker: Pick<BootstrapGateBlocker, 'state'>,
): boolean {
  const normalized = blocker.state.trim().toLowerCase()
  return normalized === 'done' || normalized === 'closed'
}

function formatBootstrapLabels(labels: string[]): string {
  return labels.length > 0 ? labels.join(',') : '-'
}
