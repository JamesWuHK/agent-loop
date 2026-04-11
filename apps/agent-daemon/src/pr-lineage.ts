import { createHash } from 'node:crypto'
import type { BranchPullRequestRecord, PrLineageMetadata } from '@agent/shared'

const PR_LINEAGE_COMMENT_PREFIX = '<!-- agent-loop:pr-lineage '

export interface BuildPrLineageMetadataInput {
  issueNumber: number
  headBranch: string
  baseBranch: string
  baseSha: string
  attempt: number
}

export type PrLineageMetadataParseErrorCode =
  | 'metadata_comment_missing'
  | 'invalid_json'
  | 'missing_required_fields'
  | 'fingerprint_mismatch'

export class PrLineageMetadataParseError extends Error {
  readonly code: PrLineageMetadataParseErrorCode

  constructor(code: PrLineageMetadataParseErrorCode, message: string) {
    super(message)
    this.name = 'PrLineageMetadataParseError'
    this.code = code
  }
}

export interface ChoosePrLifecycleActionInput {
  issueNumber: number
  headBranch: string
  baseBranch: string
  baseSha: string
}

export type PrLifecycleAction =
  | {
      kind: 'create-new-pr'
      branch: string
      attempt: number
    }
  | {
      kind: 'reuse-open-lineage'
      prNumber: number
      prUrl: string
      branch: string
      attempt: number
    }
  | {
      kind: 'replacement-needed'
      supersedesPrNumber: number
      supersedesPrState: 'open' | 'closed'
      replacementBranch: string
      replacementAttempt: number
      reason: 'lineage-mismatch' | 'terminal-closed'
    }
  | {
      kind: 'terminal-merged'
      prNumber: number
      prUrl: string
      branch: string
      attempt: number
    }

export function buildPrLineageMetadata(input: BuildPrLineageMetadataInput): PrLineageMetadata {
  const fingerprintInput = JSON.stringify({
    issue: input.issueNumber,
    headBranch: input.headBranch,
    baseBranch: input.baseBranch,
    baseSha: input.baseSha,
    attempt: input.attempt,
  })

  return {
    version: 1,
    issue: input.issueNumber,
    headBranch: input.headBranch,
    baseBranch: input.baseBranch,
    baseSha: input.baseSha,
    attempt: input.attempt,
    fingerprint: createHash('sha256').update(fingerprintInput).digest('hex'),
  }
}

export function inferPrAttemptFromBranch(branch: string): number {
  const rebuildMatch = branch.match(/^agent\/\d+-rebuild(?:-(\d+))?\/.+$/)
  if (!rebuildMatch) return 1
  const rebuildIndex = Number.parseInt(rebuildMatch[1] ?? '1', 10)
  return Number.isFinite(rebuildIndex) ? rebuildIndex + 1 : 2
}

export function buildReplacementBranchName(
  branch: string,
  attempt: number,
): string {
  const match = branch.match(/^agent\/(\d+)(?:-rebuild(?:-\d+)?)?\/(.+)$/)
  if (!match?.[1] || !match[2]) {
    return `${branch}-rebuild-${attempt}`
  }

  if (attempt <= 1) {
    return `agent/${match[1]}/${match[2]}`
  }

  if (attempt === 2) {
    return `agent/${match[1]}-rebuild/${match[2]}`
  }

  return `agent/${match[1]}-rebuild-${attempt - 1}/${match[2]}`
}

export function renderPrLineageMetadataComment(metadata: PrLineageMetadata): string {
  return `${PR_LINEAGE_COMMENT_PREFIX}${JSON.stringify(metadata)} -->`
}

export function parsePrLineageMetadata(body: string): PrLineageMetadata {
  const match = body.match(/<!-- agent-loop:pr-lineage (\{.*?\}) -->/s)
  if (!match?.[1]) {
    throw new PrLineageMetadataParseError(
      'metadata_comment_missing',
      'PR lineage metadata comment is missing',
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch {
    throw new PrLineageMetadataParseError(
      'invalid_json',
      'PR lineage metadata comment contains invalid JSON',
    )
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new PrLineageMetadataParseError(
      'missing_required_fields',
      'PR lineage metadata must be a JSON object',
    )
  }

  const candidate = parsed as Partial<PrLineageMetadata>
  if (
    candidate.version !== 1
    || typeof candidate.issue !== 'number'
    || typeof candidate.headBranch !== 'string'
    || candidate.headBranch.length === 0
    || typeof candidate.baseBranch !== 'string'
    || candidate.baseBranch.length === 0
    || typeof candidate.baseSha !== 'string'
    || candidate.baseSha.length === 0
    || typeof candidate.attempt !== 'number'
    || !Number.isInteger(candidate.attempt)
    || candidate.attempt < 1
    || typeof candidate.fingerprint !== 'string'
    || candidate.fingerprint.length === 0
  ) {
    throw new PrLineageMetadataParseError(
      'missing_required_fields',
      'PR lineage metadata is missing one or more required fields',
    )
  }

  const expected = buildPrLineageMetadata({
    issueNumber: candidate.issue,
    headBranch: candidate.headBranch,
    baseBranch: candidate.baseBranch,
    baseSha: candidate.baseSha,
    attempt: candidate.attempt,
  })

  if (candidate.fingerprint !== expected.fingerprint) {
    throw new PrLineageMetadataParseError(
      'fingerprint_mismatch',
      'PR lineage metadata fingerprint does not match its required fields',
    )
  }

  return expected
}

function tryParsePrLineageMetadata(body: string | null): PrLineageMetadata | null {
  if (!body) return null

  try {
    return parsePrLineageMetadata(body)
  } catch {
    return null
  }
}

export function choosePrLifecycleAction(
  input: ChoosePrLifecycleActionInput,
  pullRequests: BranchPullRequestRecord[],
): PrLifecycleAction {
  const expectedAttempt = inferPrAttemptFromBranch(input.headBranch)
  const expectedMetadata = buildPrLineageMetadata({
    issueNumber: input.issueNumber,
    headBranch: input.headBranch,
    baseBranch: input.baseBranch,
    baseSha: input.baseSha,
    attempt: expectedAttempt,
  })
  const parsedPullRequests = pullRequests
    .map((pullRequest) => ({
      ...pullRequest,
      metadata: tryParsePrLineageMetadata(pullRequest.body),
    }))
    .sort((left, right) => right.number - left.number)

  if (parsedPullRequests.length === 0) {
    return {
      kind: 'create-new-pr',
      branch: input.headBranch,
      attempt: expectedAttempt,
    }
  }

  const exactOpenLineage = parsedPullRequests.find((pullRequest) => (
    pullRequest.prState === 'open'
    && pullRequest.headRefName === input.headBranch
    && pullRequest.metadata?.fingerprint === expectedMetadata.fingerprint
  )) ?? null
  if (exactOpenLineage) {
    return {
      kind: 'reuse-open-lineage',
      prNumber: exactOpenLineage.number,
      prUrl: exactOpenLineage.prUrl ?? '',
      branch: input.headBranch,
      attempt: exactOpenLineage.metadata?.attempt ?? expectedAttempt,
    }
  }

  const maxAttempt = parsedPullRequests.reduce((highest, pullRequest) => {
    return Math.max(highest, pullRequest.metadata?.attempt ?? 1)
  }, expectedAttempt)

  const openMismatch = parsedPullRequests.find((pullRequest) => pullRequest.prState === 'open') ?? null
  if (openMismatch) {
    return {
      kind: 'replacement-needed',
      supersedesPrNumber: openMismatch.number,
      supersedesPrState: 'open',
      replacementBranch: buildReplacementBranchName(input.headBranch, maxAttempt + 1),
      replacementAttempt: maxAttempt + 1,
      reason: 'lineage-mismatch',
    }
  }

  const latestTerminal = parsedPullRequests[0] ?? null
  if (latestTerminal?.prState === 'closed') {
    return {
      kind: 'replacement-needed',
      supersedesPrNumber: latestTerminal.number,
      supersedesPrState: 'closed',
      replacementBranch: buildReplacementBranchName(input.headBranch, maxAttempt + 1),
      replacementAttempt: maxAttempt + 1,
      reason: 'terminal-closed',
    }
  }

  return {
    kind: 'terminal-merged',
    prNumber: latestTerminal?.number ?? 0,
    prUrl: latestTerminal?.prUrl ?? '',
    branch: input.headBranch,
    attempt: maxAttempt,
  }
}

export function buildSupersededPrComment(input: {
  previousPrNumber: number
  replacementPrNumber: number
  replacementBranch: string
  replacementAttempt: number
  reason: 'lineage-mismatch' | 'terminal-closed'
}): string {
  return [
    `<!-- agent-loop:pr-superseded {"previousPr":${input.previousPrNumber},"replacementPr":${input.replacementPrNumber},"replacementBranch":"${input.replacementBranch}","replacementAttempt":${input.replacementAttempt},"reason":"${input.reason}"} -->`,
    '## PR Superseded',
    '',
    `This PR has been superseded by #${input.replacementPrNumber}.`,
    '',
    `- Replacement branch: \`${input.replacementBranch}\``,
    `- Replacement attempt: ${input.replacementAttempt}`,
    `- Reason: ${input.reason}`,
  ].join('\n')
}
