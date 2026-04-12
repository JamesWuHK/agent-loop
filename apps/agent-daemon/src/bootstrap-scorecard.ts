import {
  PR_REVIEW_LABELS,
  getAgentIssueByNumber,
  listIssueComments,
  listOpenAgentIssues,
  listOpenAgentPullRequests,
  type AgentConfig,
  type AgentIssue,
  type IssueComment,
  type ManagedPullRequest,
} from '@agent/shared'
import {
  buildAuditedIssue,
  buildAuditIssueSummary,
  type AuditIssueSummary,
} from './audit-issue-contracts'
import {
  DEFAULT_BOOTSTRAP_BLOCKER_ISSUE_NUMBERS,
  buildBootstrapGateReportForRepo,
} from './bootstrap-gate'
import {
  canResumeHumanNeededPrReview,
  extractLatestAutomatedPrReviewBlockerSummary,
} from './pr-reviewer'
import {
  extractBlockedIssueResumeEscalationComment,
  evaluateBlockedIssueResumeResolution,
  getFailedIssueResumeBlock,
} from './daemon'

export type BootstrapFailureKind =
  | 'contract_failure'
  | 'runtime_failure'
  | 'pr_lifecycle_failure'
  | 'review_failure'
  | 'github_transport_failure'
  | 'release_process_failure'

export interface BootstrapScorecardSignal {
  issueNumber?: number | null
  prNumber?: number | null
  reason: string
}

export interface BootstrapScorecardBlocker extends BootstrapScorecardSignal {
  category: BootstrapFailureKind
}

export interface BootstrapScorecard {
  ready: boolean
  categoryCounts: Record<BootstrapFailureKind, number>
  topBlockers: BootstrapScorecardBlocker[]
  auditSummary: AuditIssueSummary
}

interface BootstrapScorecardInput {
  audit: AuditIssueSummary
  prBlockers?: BootstrapScorecardSignal[]
  reviewBlockers?: BootstrapScorecardSignal[]
  runtimeBlockers?: BootstrapScorecardSignal[]
  transportBlockers?: BootstrapScorecardSignal[]
  releaseEvidenceMissing: string[]
}

interface BootstrapScorecardDependencies {
  listOpenAgentIssues: typeof listOpenAgentIssues
  listOpenAgentPullRequests: typeof listOpenAgentPullRequests
  listIssueComments: typeof listIssueComments
  getAgentIssueByNumber: typeof getAgentIssueByNumber
}

const DEFAULT_BOOTSTRAP_SCORECARD_DEPENDENCIES: BootstrapScorecardDependencies = {
  listOpenAgentIssues,
  listOpenAgentPullRequests,
  listIssueComments,
  getAgentIssueByNumber,
}

const BOOTSTRAP_FAILURE_KIND_ORDER: BootstrapFailureKind[] = [
  'contract_failure',
  'runtime_failure',
  'pr_lifecycle_failure',
  'review_failure',
  'github_transport_failure',
  'release_process_failure',
]

const DEFAULT_MAX_AUTOMATED_PR_REVIEW_ATTEMPTS = 3
const REQUIRED_RELEASE_EVIDENCE_SPECS = [
  {
    code: 'self_bootstrap_suite_green',
    issueNumber: 69,
  },
  {
    code: 'bootstrap_scorecard_green',
    issueNumber: 70,
  },
] as const
const BOOTSTRAP_SCOPE_ISSUE_NUMBERS = new Set<number>([
  ...DEFAULT_BOOTSTRAP_BLOCKER_ISSUE_NUMBERS,
  ...REQUIRED_RELEASE_EVIDENCE_SPECS.map((spec) => spec.issueNumber),
])

export function classifyBootstrapFailureKind(reason: string): BootstrapFailureKind {
  const normalized = reason.toLowerCase()

  if (
    normalized.includes('rate limit')
    || normalized.includes('github api')
    || normalized.includes('socket')
    || normalized.includes('econn')
    || normalized.includes('timeout')
    || normalized.includes('transport')
    || normalized.includes('connection reset')
  ) {
    return 'github_transport_failure'
  }

  if (
    normalized.includes('missing required evidence:')
    || normalized.includes('release evidence missing')
  ) {
    return 'release_process_failure'
  }

  if (
    normalized.includes('closed pr')
    || normalized.includes('fresh pr')
    || normalized.includes('merge checks')
    || normalized.includes('merge checks gate')
    || normalized.includes('merge gate')
    || normalized.includes('required self-bootstrap checks')
    || normalized.includes('before merge can resume')
    || normalized.includes('pr lifecycle')
  ) {
    return 'pr_lifecycle_failure'
  }

  if (
    normalized.includes('human-needed')
    || normalized.includes('review blocker')
    || normalized.includes('review failed')
    || normalized.includes('auto-fix')
    || normalized.includes('review ')
  ) {
    return 'review_failure'
  }

  if (
    normalized.includes('runtime blocker:')
    || normalized.includes('daemon runtime failure:')
  ) {
    return 'runtime_failure'
  }

  return 'contract_failure'
}

export function buildBootstrapScorecard(
  input: BootstrapScorecardInput,
): BootstrapScorecard {
  const categoryCounts = createEmptyCategoryCounts()
  const blockers: BootstrapScorecardBlocker[] = []
  const mutuallyExclusiveBlockers = dedupePrLifecycleAndReviewBlockers(
    input.prBlockers ?? [],
    input.reviewBlockers ?? [],
  )
  const prLifecycleBlockers = mutuallyExclusiveBlockers.prBlockers
  const reviewBlockers = mutuallyExclusiveBlockers.reviewBlockers

  if (input.audit.invalidReadyIssueCount > 0) {
    categoryCounts.contract_failure += input.audit.invalidReadyIssueCount
    blockers.push({
      category: 'contract_failure',
      issueNumber: null,
      prNumber: null,
      reason: `${input.audit.invalidReadyIssueCount} invalid ready issue(s) require executable contracts`,
    })
  }

  for (const blocker of input.runtimeBlockers ?? []) {
    categoryCounts.runtime_failure += 1
    blockers.push({
      category: 'runtime_failure',
      ...normalizeScorecardSignal(blocker),
    })
  }

  for (const blocker of prLifecycleBlockers) {
    categoryCounts.pr_lifecycle_failure += 1
    blockers.push({
      category: 'pr_lifecycle_failure',
      ...normalizeScorecardSignal(blocker),
    })
  }

  for (const blocker of reviewBlockers) {
    categoryCounts.review_failure += 1
    blockers.push({
      category: 'review_failure',
      ...normalizeScorecardSignal(blocker),
    })
  }

  for (const blocker of input.transportBlockers ?? []) {
    categoryCounts.github_transport_failure += 1
    blockers.push({
      category: 'github_transport_failure',
      ...normalizeScorecardSignal(blocker),
    })
  }

  for (const code of input.releaseEvidenceMissing) {
    categoryCounts.release_process_failure += 1
    blockers.push({
      category: 'release_process_failure',
      issueNumber: null,
      prNumber: null,
      reason: `missing required evidence: ${code}`,
    })
  }

  return {
    ready: BOOTSTRAP_FAILURE_KIND_ORDER.every((category) => categoryCounts[category] === 0),
    categoryCounts,
    topBlockers: BOOTSTRAP_FAILURE_KIND_ORDER.flatMap((category) => {
      const blocker = blockers.find((candidate) => candidate.category === category)
      return blocker ? [blocker] : []
    }),
    auditSummary: input.audit,
  }
}

export async function buildBootstrapScorecardForRepo(
  input: {
    config: AgentConfig
  },
  deps: BootstrapScorecardDependencies = DEFAULT_BOOTSTRAP_SCORECARD_DEPENDENCIES,
): Promise<BootstrapScorecard> {
  const transportBlockers: BootstrapScorecardSignal[] = []
  const issuesResult = await collectScorecardSource(
    () => deps.listOpenAgentIssues(input.config),
    transportBlockers,
    'open issues',
  )
  const pullRequestsResult = await collectScorecardSource(
    () => deps.listOpenAgentPullRequests(input.config),
    transportBlockers,
    'open pull requests',
  )

  const managedIssues = (issuesResult ?? [])
    .filter((issue) => issue.labels.some((label) => label.startsWith('agent:')))
    .filter((issue) => BOOTSTRAP_SCOPE_ISSUE_NUMBERS.has(issue.number))
  const pullRequests = (pullRequestsResult ?? []).filter((pullRequest) => {
    const issueNumber = parseIssueNumberFromManagedBranch(pullRequest.headRefName)
    return issueNumber !== null && BOOTSTRAP_SCOPE_ISSUE_NUMBERS.has(issueNumber)
  })
  const issueBodiesByNumber = new Map(managedIssues.map((issue) => [issue.number, issue.body]))
  const issueCommentsByNumber = new Map<number, IssueComment[] | null>()
  const prCommentsByNumber = new Map<number, IssueComment[] | null>()
  const linkedIssuesByNumber = new Map<number, AgentIssue | null>()
  const commentLoader = createScorecardCommentLoader(
    input.config,
    deps,
    transportBlockers,
    issueCommentsByNumber,
    prCommentsByNumber,
  )
  const linkedIssueLoader = createLinkedIssueLoader(
    input.config,
    deps,
    transportBlockers,
    linkedIssuesByNumber,
  )
  const [prBlockers, reviewBlockers] = await Promise.all([
    collectPrLifecycleBlockers(
      managedIssues,
      pullRequests,
      commentLoader,
    ),
    collectReviewBlockers(
      pullRequests,
      issueBodiesByNumber,
      commentLoader,
      linkedIssueLoader,
    ),
  ])
  const runtimeBlockers = await collectRuntimeBlockers(
    managedIssues,
    commentLoader,
  )
  const releaseEvidenceMissing = await collectReleaseEvidenceMissing(
    input.config,
    deps,
    transportBlockers,
  )

  return buildBootstrapScorecard({
    audit: issuesResult
      ? buildAuditIssueSummary(managedIssues.map(buildAuditedIssue))
      : buildEmptyAuditIssueSummary(),
    runtimeBlockers,
    prBlockers,
    reviewBlockers,
    transportBlockers,
    releaseEvidenceMissing: releaseEvidenceMissing ?? [],
  })
}

export function formatBootstrapScorecard(
  scorecard: BootstrapScorecard,
): string {
  return [
    'Bootstrap Scorecard',
    `ready=${scorecard.ready}`,
    `auditSummary=managed:${scorecard.auditSummary.managedIssueCount} ready:${scorecard.auditSummary.readyIssueCount} invalidReady:${scorecard.auditSummary.invalidReadyIssueCount} lowScore:${scorecard.auditSummary.lowScoreIssueCount} warnings:${scorecard.auditSummary.warningIssueCount}`,
    'categoryCounts:',
    ...BOOTSTRAP_FAILURE_KIND_ORDER.map((category) => `- ${category}: ${scorecard.categoryCounts[category]}`),
    'topBlockers:',
    ...(scorecard.topBlockers.length > 0
      ? scorecard.topBlockers.map((blocker) => `- ${blocker.category}: ${formatScorecardBlockerTarget(blocker)}${blocker.reason}`)
      : ['- none']),
  ].join('\n')
}

export function formatBootstrapScorecardJson(
  scorecard: BootstrapScorecard,
): string {
  return JSON.stringify(scorecard, null, 2)
}

export function resolveBootstrapScorecardExitCode(
  scorecard: Pick<BootstrapScorecard, 'ready'>,
): number {
  return scorecard.ready ? 0 : 1
}

function createEmptyCategoryCounts(): Record<BootstrapFailureKind, number> {
  return {
    contract_failure: 0,
    runtime_failure: 0,
    pr_lifecycle_failure: 0,
    review_failure: 0,
    github_transport_failure: 0,
    release_process_failure: 0,
  }
}

function normalizeScorecardSignal(signal: BootstrapScorecardSignal): BootstrapScorecardSignal {
  return {
    issueNumber: signal.issueNumber ?? null,
    prNumber: signal.prNumber ?? null,
    reason: signal.reason,
  }
}

function dedupePrLifecycleAndReviewBlockers(
  prBlockers: BootstrapScorecardSignal[],
  reviewBlockers: BootstrapScorecardSignal[],
): {
  prBlockers: BootstrapScorecardSignal[]
  reviewBlockers: BootstrapScorecardSignal[]
} {
  const prLifecycleKeys = new Set(
    prBlockers
      .map(buildIssuePrPairKey)
      .filter((key): key is string => key !== null),
  )

  return {
    prBlockers,
    // Failed-issue resume blockers win over PR review blockers for the same linked issue/PR pair.
    reviewBlockers: reviewBlockers.filter((blocker) => {
      const key = buildIssuePrPairKey(blocker)
      return key === null || !prLifecycleKeys.has(key)
    }),
  }
}

function buildIssuePrPairKey(signal: BootstrapScorecardSignal): string | null {
  const normalized = normalizeScorecardSignal(signal)
  if (normalized.issueNumber === null || normalized.prNumber === null) {
    return null
  }

  return `${normalized.issueNumber}:${normalized.prNumber}`
}

function buildEmptyAuditIssueSummary(): AuditIssueSummary {
  return {
    managedIssueCount: 0,
    readyIssueCount: 0,
    invalidReadyIssueCount: 0,
    lowScoreIssueCount: 0,
    warningIssueCount: 0,
  }
}

async function collectReleaseEvidenceMissing(
  config: AgentConfig,
  deps: BootstrapScorecardDependencies,
  transportBlockers: BootstrapScorecardSignal[],
): Promise<string[]> {
  try {
    const report = await buildBootstrapGateReportForRepo({
      config,
    }, {
      getAgentIssueByNumber: deps.getAgentIssueByNumber,
    })

    return report.requiredEvidence
      .filter((evidence) => !evidence.satisfied)
      .map((evidence) => evidence.code)
  } catch (error) {
    transportBlockers.push({
      reason: `release evidence: ${formatBootstrapScorecardError(error)}`,
    })
  }

  const missingEvidence: string[] = []
  for (const evidence of REQUIRED_RELEASE_EVIDENCE_SPECS) {
    const issue = await collectScorecardSource(
      () => deps.getAgentIssueByNumber(evidence.issueNumber, config),
      transportBlockers,
      `issue#${evidence.issueNumber} lookup`,
    )
    if (issue?.state !== 'done') {
      missingEvidence.push(evidence.code)
    }
  }

  return missingEvidence
}

async function collectScorecardSource<T>(
  load: () => Promise<T>,
  transportBlockers: BootstrapScorecardSignal[],
  target: string,
): Promise<T | null> {
  try {
    return await load()
  } catch (error) {
    transportBlockers.push({
      reason: `${target}: ${formatBootstrapScorecardError(error)}`,
    })
    return null
  }
}

async function collectReviewBlockers(
  pullRequests: ManagedPullRequest[],
  issueBodiesByNumber: Map<number, string>,
  commentLoader: ReturnType<typeof createScorecardCommentLoader>,
  linkedIssueLoader: ReturnType<typeof createLinkedIssueLoader>,
): Promise<BootstrapScorecardSignal[]> {
  const blockers: BootstrapScorecardSignal[] = []

  for (const pullRequest of pullRequests) {
    const labelSet = new Set(pullRequest.labels)
    if (!labelSet.has(PR_REVIEW_LABELS.HUMAN_NEEDED) && !labelSet.has(PR_REVIEW_LABELS.FAILED)) {
      continue
    }

    const prComments = await commentLoader.loadPrComments(pullRequest.number)
    if (!prComments) {
      continue
    }

    const latestReviewBlocker = extractLatestAutomatedPrReviewBlockerSummary(prComments)
    if (!latestReviewBlocker) {
      continue
    }

    const issueNumber = parseIssueNumberFromManagedBranch(pullRequest.headRefName)
    const linkedIssueBody = await resolveLinkedIssueBody(issueNumber, issueBodiesByNumber, linkedIssueLoader)

    if (
      labelSet.has(PR_REVIEW_LABELS.HUMAN_NEEDED)
      && canResumeHumanNeededPrReview(
        prComments,
        DEFAULT_MAX_AUTOMATED_PR_REVIEW_ATTEMPTS,
        pullRequest.headRefOid,
        linkedIssueBody,
      )
    ) {
      continue
    }

    if (issueNumber !== null) {
      const issueComments = await commentLoader.loadIssueComments(issueNumber)
      if (issueComments && evaluateBlockedIssueResumeResolution(issueComments, issueNumber, pullRequest.number).canResume) {
        continue
      }
    }

    blockers.push({
      issueNumber,
      prNumber: pullRequest.number,
      reason: latestReviewBlocker.reason,
    })
  }

  return blockers
}

function parseIssueNumberFromManagedBranch(headRefName: string): number | null {
  const match = headRefName.match(/^agent\/(\d+)(?:\/|$)/)
  if (!match) return null

  const parsed = Number.parseInt(match[1] ?? '', 10)
  return Number.isSafeInteger(parsed) ? parsed : null
}

async function collectPrLifecycleBlockers(
  issues: AgentIssue[],
  pullRequests: ManagedPullRequest[],
  commentLoader: ReturnType<typeof createScorecardCommentLoader>,
): Promise<BootstrapScorecardSignal[]> {
  const blockers: BootstrapScorecardSignal[] = []
  const pullRequestsByIssueNumber = new Map<number, ManagedPullRequest[]>()

  for (const pullRequest of pullRequests) {
    const issueNumber = parseIssueNumberFromManagedBranch(pullRequest.headRefName)
    if (issueNumber === null) continue
    pullRequestsByIssueNumber.set(issueNumber, [...(pullRequestsByIssueNumber.get(issueNumber) ?? []), pullRequest])
  }

  for (const issue of issues) {
    if (issue.state !== 'failed') {
      continue
    }

    const issueComments = await commentLoader.loadIssueComments(issue.number)
    if (!issueComments) {
      continue
    }

    const linkedPullRequests = pullRequestsByIssueNumber.get(issue.number) ?? []
    const fallbackBlockedEscalation = findLatestUnresolvedPrLifecycleEscalation(
      issueComments,
      issue.number,
      new Set(linkedPullRequests.map((pullRequest) => pullRequest.number)),
    )

    let hasResumableLinkedPr = false
    let firstBlocked: BootstrapScorecardSignal | null = null

    for (const pullRequest of linkedPullRequests) {
      const prComments = await commentLoader.loadPrComments(pullRequest.number)
      if (!prComments) {
        continue
      }

      const pullRequestLabels = new Set(pullRequest.labels)
      const canResumeHumanNeededReview = pullRequestLabels.has(PR_REVIEW_LABELS.HUMAN_NEEDED)
        ? canResumeHumanNeededPrReview(
          prComments,
          DEFAULT_MAX_AUTOMATED_PR_REVIEW_ATTEMPTS,
          pullRequest.headRefOid,
          issue.body,
        )
        : false
      const blocked = getFailedIssueResumeBlock(pullRequest, canResumeHumanNeededReview)

      if (blocked === null) {
        if (
          fallbackBlockedEscalation?.prNumber === pullRequest.number
          && shouldRetainOpenPrLifecycleEscalation(fallbackBlockedEscalation.reason)
        ) {
          firstBlocked = fallbackBlockedEscalation
          continue
        }

        hasResumableLinkedPr = true
        break
      }

      if (evaluateBlockedIssueResumeResolution(issueComments, issue.number, pullRequest.number).canResume) {
        continue
      }

      if (firstBlocked === null) {
        firstBlocked = {
          issueNumber: issue.number,
          prNumber: pullRequest.number,
          reason:
            fallbackBlockedEscalation?.prNumber === pullRequest.number
            && shouldRetainOpenPrLifecycleEscalation(fallbackBlockedEscalation.reason)
              ? fallbackBlockedEscalation.reason
              : blocked.reason,
        }
      }
    }

    if (!hasResumableLinkedPr && firstBlocked) {
      blockers.push(firstBlocked)
      continue
    }

    if (!hasResumableLinkedPr && fallbackBlockedEscalation) {
      blockers.push(fallbackBlockedEscalation)
    }
  }

  return blockers
}

async function collectRuntimeBlockers(
  issues: AgentIssue[],
  commentLoader: ReturnType<typeof createScorecardCommentLoader>,
): Promise<BootstrapScorecardSignal[]> {
  const blockers: BootstrapScorecardSignal[] = []

  for (const issue of issues) {
    if (issue.state !== 'failed') {
      continue
    }

    const issueComments = await commentLoader.loadIssueComments(issue.number)
    if (!issueComments) {
      continue
    }

    const runtimeBlocker = findLatestUnresolvedRuntimeEscalation(issueComments, issue.number)
    if (runtimeBlocker) {
      blockers.push(runtimeBlocker)
    }
  }

  return blockers
}

function isGenericLinkedPrLifecycleReason(reason: string): boolean {
  return /^linked pr #\d+ is not in a resumable automated state\b/i.test(reason)
}

function shouldRetainOpenPrLifecycleEscalation(reason: string): boolean {
  return /^linked pr #\d+\b/i.test(reason)
    && classifyBootstrapFailureKind(reason) === 'pr_lifecycle_failure'
}

function findLatestUnresolvedPrLifecycleEscalation(
  issueComments: IssueComment[],
  issueNumber: number,
  openLinkedPrNumbers: Set<number>,
): BootstrapScorecardSignal | null {
  let latestBlocked: { signal: BootstrapScorecardSignal; timestamp: number } | null = null

  for (const comment of issueComments) {
    const escalation = extractBlockedIssueResumeEscalationComment(comment.body)
    if (!escalation || escalation.issueNumber !== issueNumber) {
      continue
    }

    if (classifyBootstrapFailureKind(escalation.reason) !== 'pr_lifecycle_failure') {
      continue
    }

    if (escalation.prNumber !== null) {
      if (
        openLinkedPrNumbers.has(escalation.prNumber)
        && !shouldRetainOpenPrLifecycleEscalation(escalation.reason)
      ) {
        continue
      }

      if (evaluateBlockedIssueResumeResolution(issueComments, issueNumber, escalation.prNumber).canResume) {
        continue
      }
    }

    const timestamp = readScorecardCommentTimestamp(comment, escalation.escalatedAt)
    if (latestBlocked && latestBlocked.timestamp >= timestamp) {
      continue
    }

    latestBlocked = {
      signal: {
        issueNumber,
        prNumber: escalation.prNumber,
        reason: escalation.reason,
      },
      timestamp,
    }
  }

  return latestBlocked?.signal ?? null
}

function findLatestUnresolvedRuntimeEscalation(
  issueComments: IssueComment[],
  issueNumber: number,
): BootstrapScorecardSignal | null {
  let latestBlocked: { signal: BootstrapScorecardSignal; timestamp: number } | null = null

  for (const comment of issueComments) {
    const escalation = extractBlockedIssueResumeEscalationComment(comment.body)
    if (!escalation || escalation.issueNumber !== issueNumber) {
      continue
    }

    if (classifyBootstrapFailureKind(escalation.reason) !== 'runtime_failure') {
      continue
    }

    if (
      escalation.prNumber !== null
      && evaluateBlockedIssueResumeResolution(issueComments, issueNumber, escalation.prNumber).canResume
    ) {
      continue
    }

    const timestamp = readScorecardCommentTimestamp(comment, escalation.escalatedAt)
    if (latestBlocked && latestBlocked.timestamp >= timestamp) {
      continue
    }

    latestBlocked = {
      signal: {
        issueNumber,
        prNumber: escalation.prNumber,
        reason: escalation.reason,
      },
      timestamp,
    }
  }

  return latestBlocked?.signal ?? null
}

function readScorecardCommentTimestamp(
  comment: Pick<IssueComment, 'updatedAt' | 'createdAt'>,
  fallbackIso: string | null = null,
): number {
  const candidates = [comment.updatedAt, comment.createdAt, fallbackIso]

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue
    }

    const parsed = Date.parse(candidate)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return 0
}

function createScorecardCommentLoader(
  config: AgentConfig,
  deps: BootstrapScorecardDependencies,
  transportBlockers: BootstrapScorecardSignal[],
  issueCommentsByNumber: Map<number, IssueComment[] | null>,
  prCommentsByNumber: Map<number, IssueComment[] | null>,
) {
  return {
    loadIssueComments: async (issueNumber: number): Promise<IssueComment[] | null> => {
      if (issueCommentsByNumber.has(issueNumber)) {
        return issueCommentsByNumber.get(issueNumber) ?? null
      }

      const comments = await collectScorecardSource(
        () => deps.listIssueComments(issueNumber, config),
        transportBlockers,
        `issue#${issueNumber} comments`,
      )
      issueCommentsByNumber.set(issueNumber, comments)
      return comments
    },
    loadPrComments: async (prNumber: number): Promise<IssueComment[] | null> => {
      if (prCommentsByNumber.has(prNumber)) {
        return prCommentsByNumber.get(prNumber) ?? null
      }

      const comments = await collectScorecardSource(
        () => deps.listIssueComments(prNumber, config),
        transportBlockers,
        `pr#${prNumber} comments`,
      )
      prCommentsByNumber.set(prNumber, comments)
      return comments
    },
  }
}

function createLinkedIssueLoader(
  config: AgentConfig,
  deps: BootstrapScorecardDependencies,
  transportBlockers: BootstrapScorecardSignal[],
  linkedIssuesByNumber: Map<number, AgentIssue | null>,
) {
  return {
    loadLinkedIssue: async (issueNumber: number): Promise<AgentIssue | null> => {
      if (linkedIssuesByNumber.has(issueNumber)) {
        return linkedIssuesByNumber.get(issueNumber) ?? null
      }

      const linkedIssue = await collectScorecardSource(
        () => deps.getAgentIssueByNumber(issueNumber, config),
        transportBlockers,
        `issue#${issueNumber} lookup`,
      )
      linkedIssuesByNumber.set(issueNumber, linkedIssue)
      return linkedIssue
    },
  }
}

async function resolveLinkedIssueBody(
  issueNumber: number | null,
  issueBodiesByNumber: Map<number, string>,
  linkedIssueLoader: ReturnType<typeof createLinkedIssueLoader>,
): Promise<string | null> {
  if (issueNumber === null) {
    return null
  }

  if (issueBodiesByNumber.has(issueNumber)) {
    return issueBodiesByNumber.get(issueNumber) ?? null
  }

  const linkedIssue = await linkedIssueLoader.loadLinkedIssue(issueNumber)
  return linkedIssue?.body ?? null
}

function formatScorecardBlockerTarget(blocker: BootstrapScorecardBlocker): string {
  if (blocker.issueNumber !== null && blocker.issueNumber !== undefined) {
    return `issue#${blocker.issueNumber} `
  }
  if (blocker.prNumber !== null && blocker.prNumber !== undefined) {
    return `pr#${blocker.prNumber} `
  }
  return ''
}

function formatBootstrapScorecardError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
