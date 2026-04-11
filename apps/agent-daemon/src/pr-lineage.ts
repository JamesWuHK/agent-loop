import { createHash } from 'node:crypto'
import type { PrLineageMetadata } from '@agent/shared'

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
