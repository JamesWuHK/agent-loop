import { type AgentConfig } from '@agent/shared'
import {
  buildBootstrapGateReportForRepo,
  type BootstrapGateReport,
} from './bootstrap-gate'
import {
  buildBootstrapScorecardForRepo,
  type BootstrapFailureKind,
  type BootstrapScorecard,
} from './bootstrap-scorecard'

export type BootstrapConvergenceActionKind =
  | 'issue_state_sync'
  | 'pull_request_cleanup'

export interface BootstrapConvergenceAction {
  kind: BootstrapConvergenceActionKind
  issueNumber?: number | null
  prNumber?: number | null
  remoteState?: string | null
  categories: BootstrapFailureKind[]
  reasons: string[]
  localImplementationHeadline?: string | null
  recommendedAction: string
  summary: string
}

export interface BootstrapConvergenceReportSummary {
  totalActions: number
  issueActions: number
  pullRequestActions: number
}

export interface BootstrapConvergenceReport {
  gateReady: boolean
  scorecardReady: boolean
  converged: boolean
  summary: BootstrapConvergenceReportSummary
  actions: BootstrapConvergenceAction[]
}

interface BuildBootstrapConvergenceReportForRepoInput {
  config: AgentConfig
  repoRoot?: string
}

interface BootstrapConvergenceDependencies {
  buildBootstrapGateReportForRepo: typeof buildBootstrapGateReportForRepo
  buildBootstrapScorecardForRepo: typeof buildBootstrapScorecardForRepo
}

const DEFAULT_BOOTSTRAP_CONVERGENCE_DEPENDENCIES: BootstrapConvergenceDependencies = {
  buildBootstrapGateReportForRepo,
  buildBootstrapScorecardForRepo,
}

export async function buildBootstrapConvergenceReportForRepo(
  input: BuildBootstrapConvergenceReportForRepoInput,
  deps: BootstrapConvergenceDependencies = DEFAULT_BOOTSTRAP_CONVERGENCE_DEPENDENCIES,
): Promise<BootstrapConvergenceReport> {
  const [gate, scorecard] = await Promise.all([
    deps.buildBootstrapGateReportForRepo({
      config: input.config,
      repoRoot: input.repoRoot,
    }),
    deps.buildBootstrapScorecardForRepo({
      config: input.config,
      repoRoot: input.repoRoot,
    }),
  ])

  const actions = buildBootstrapConvergenceActions(gate, scorecard)

  return {
    gateReady: gate.ready,
    scorecardReady: scorecard.ready,
    converged: actions.length === 0,
    summary: {
      totalActions: actions.length,
      issueActions: actions.filter((action) => action.kind === 'issue_state_sync').length,
      pullRequestActions: actions.filter((action) => action.kind === 'pull_request_cleanup').length,
    },
    actions,
  }
}

export function formatBootstrapConvergenceReport(
  report: BootstrapConvergenceReport,
): string {
  return [
    'Bootstrap Convergence',
    `gateReady=${report.gateReady}`,
    `scorecardReady=${report.scorecardReady}`,
    `converged=${report.converged}`,
    `summary: total=${report.summary.totalActions} issueActions=${report.summary.issueActions} pullRequestActions=${report.summary.pullRequestActions}`,
    'actions:',
    ...(report.actions.length > 0
      ? report.actions.map((action) => `- ${action.kind}: ${formatBootstrapConvergenceAction(action)}`)
      : ['- none']),
  ].join('\n')
}

export function formatBootstrapConvergenceReportJson(
  report: BootstrapConvergenceReport,
): string {
  return JSON.stringify(report, null, 2)
}

export function resolveBootstrapConvergenceExitCode(
  report: Pick<BootstrapConvergenceReport, 'converged'>,
): number {
  return report.converged ? 0 : 1
}

function buildBootstrapConvergenceActions(
  gate: BootstrapGateReport,
  scorecard: BootstrapScorecard,
): BootstrapConvergenceAction[] {
  const actionsByKey = new Map<string, BootstrapConvergenceAction>()

  for (const blocker of gate.suppressedBlockers) {
    const key = `issue:${blocker.issueNumber}`
    const existing = actionsByKey.get(key)
    if (existing) {
      if (!existing.remoteState) {
        existing.remoteState = blocker.state
      }
      continue
    }

    actionsByKey.set(key, {
      kind: 'issue_state_sync',
      issueNumber: blocker.issueNumber,
      prNumber: null,
      remoteState: blocker.state,
      categories: [],
      reasons: [],
      localImplementationHeadline: blocker.localImplementationHeadline ?? null,
      recommendedAction: 'sync_issue_state',
      summary: `Issue #${blocker.issueNumber} is still ${blocker.state} remotely even though the current branch already contains the implementation.`,
    })
  }

  for (const blocker of scorecard.suppressedBlockers) {
    const key = blocker.prNumber !== null
      ? `pr:${blocker.issueNumber ?? 'unknown'}:${blocker.prNumber}`
      : `issue:${blocker.issueNumber ?? 'unknown'}`
    const existing = actionsByKey.get(key)

    if (existing) {
      appendBootstrapFailureCategory(existing.categories, blocker.category)
      appendUniqueReason(existing.reasons, blocker.reason)
      if (!existing.localImplementationHeadline && blocker.localImplementationHeadline) {
        existing.localImplementationHeadline = blocker.localImplementationHeadline
      }
      existing.summary = buildBootstrapConvergenceSummary(existing)
      continue
    }

    const action: BootstrapConvergenceAction = {
      kind: blocker.prNumber !== null ? 'pull_request_cleanup' : 'issue_state_sync',
      issueNumber: blocker.issueNumber ?? null,
      prNumber: blocker.prNumber ?? null,
      remoteState: null,
      categories: [blocker.category],
      reasons: [blocker.reason],
      localImplementationHeadline: blocker.localImplementationHeadline ?? null,
      recommendedAction: blocker.prNumber !== null ? 'close_or_supersede_pr' : 'sync_issue_state',
      summary: '',
    }
    action.summary = buildBootstrapConvergenceSummary(action)
    actionsByKey.set(key, action)
  }

  return [...actionsByKey.values()].sort(compareBootstrapConvergenceActions)
}

function buildBootstrapConvergenceSummary(
  action: Pick<BootstrapConvergenceAction, 'kind' | 'issueNumber' | 'prNumber' | 'remoteState' | 'categories'>,
): string {
  const categorySuffix = action.categories.length > 0
    ? ` suppressed categories=${action.categories.join(',')}`
    : ''

  if (action.kind === 'pull_request_cleanup') {
    return `PR #${action.prNumber ?? '?'} for issue #${action.issueNumber ?? '?'} still needs remote cleanup because the current branch already contains the implementation.${categorySuffix}`
  }

  const remoteState = action.remoteState ? ` is still ${action.remoteState} remotely` : ' still has remote drift'
  return `Issue #${action.issueNumber ?? '?'}${remoteState} even though the current branch already contains the implementation.${categorySuffix}`
}

function formatBootstrapConvergenceAction(
  action: BootstrapConvergenceAction,
): string {
  const refs: string[] = []
  if (action.issueNumber !== null && action.issueNumber !== undefined) {
    refs.push(`issue#${action.issueNumber}`)
  }
  if (action.prNumber !== null && action.prNumber !== undefined) {
    refs.push(`pr#${action.prNumber}`)
  }

  return [
    refs.join(' '),
    action.remoteState ? `remoteState=${action.remoteState}` : null,
    action.categories.length > 0 ? `categories=${action.categories.join(',')}` : null,
    `recommended=${action.recommendedAction}`,
    action.localImplementationHeadline ? `localCommit=${action.localImplementationHeadline}` : null,
    `summary=${action.summary}`,
    action.reasons.length > 0 ? `reasons=${action.reasons.join(' | ')}` : null,
  ].filter((part): part is string => part !== null && part.length > 0).join(' ')
}

function appendBootstrapFailureCategory(
  categories: BootstrapFailureKind[],
  category: BootstrapFailureKind,
): void {
  if (!categories.includes(category)) {
    categories.push(category)
  }
}

function appendUniqueReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason)
  }
}

function compareBootstrapConvergenceActions(
  left: BootstrapConvergenceAction,
  right: BootstrapConvergenceAction,
): number {
  const leftKindWeight = left.kind === 'issue_state_sync' ? 0 : 1
  const rightKindWeight = right.kind === 'issue_state_sync' ? 0 : 1
  if (leftKindWeight !== rightKindWeight) {
    return leftKindWeight - rightKindWeight
  }

  const leftIssue = left.issueNumber ?? Number.MAX_SAFE_INTEGER
  const rightIssue = right.issueNumber ?? Number.MAX_SAFE_INTEGER
  if (leftIssue !== rightIssue) {
    return leftIssue - rightIssue
  }

  const leftPr = left.prNumber ?? Number.MAX_SAFE_INTEGER
  const rightPr = right.prNumber ?? Number.MAX_SAFE_INTEGER
  return leftPr - rightPr
}
