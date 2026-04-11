import { describe, expect, test } from 'bun:test'
import {
  buildReplacementBranchName,
  buildSupersededPrComment,
  buildPrLineageMetadata,
  choosePrLifecycleAction,
  inferPrAttemptFromBranch,
  parsePrLineageMetadata,
  PrLineageMetadataParseError,
  renderPrLineageMetadataComment,
} from './pr-lineage'

describe('pr lineage metadata', () => {
  test('round-trips a deterministic fingerprint without runtime-only fields', () => {
    const metadata = buildPrLineageMetadata({
      issueNumber: 37,
      headBranch: 'agent/37-rebuild/codex-dev',
      baseBranch: 'master',
      baseSha: '11fc78e',
      attempt: 2,
    })

    const parsed = parsePrLineageMetadata(renderPrLineageMetadataComment(metadata))

    expect(parsed).toEqual(metadata)
    expect(metadata.fingerprint).toBe(buildPrLineageMetadata({
      issueNumber: 37,
      headBranch: 'agent/37-rebuild/codex-dev',
      baseBranch: 'master',
      baseSha: '11fc78e',
      attempt: 2,
    }).fingerprint)
    expect(JSON.stringify(metadata)).not.toContain('/tmp/')
    expect(JSON.stringify(metadata)).not.toContain('"timestamp"')
  })

  test('throws a structured error when required fields are missing', () => {
    expect(() => parsePrLineageMetadata(
      '<!-- agent-loop:pr-lineage {"version":1,"issue":37} -->',
    )).toThrow(PrLineageMetadataParseError)

    try {
      parsePrLineageMetadata('<!-- agent-loop:pr-lineage {"version":1,"issue":37} -->')
      throw new Error('expected parser to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(PrLineageMetadataParseError)
      expect((error as PrLineageMetadataParseError).code).toBe('missing_required_fields')
    }
  })

  test('throws a structured error when the fingerprint is tampered', () => {
    expect(() => parsePrLineageMetadata(
      '<!-- agent-loop:pr-lineage {"version":1,"issue":37,"headBranch":"agent/37-rebuild/codex-dev","baseBranch":"master","baseSha":"11fc78e","attempt":2,"fingerprint":"tampered"} -->',
    )).toThrow(PrLineageMetadataParseError)

    try {
      parsePrLineageMetadata(
        '<!-- agent-loop:pr-lineage {"version":1,"issue":37,"headBranch":"agent/37-rebuild/codex-dev","baseBranch":"master","baseSha":"11fc78e","attempt":2,"fingerprint":"tampered"} -->',
      )
      throw new Error('expected parser to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(PrLineageMetadataParseError)
      expect((error as PrLineageMetadataParseError).code).toBe('fingerprint_mismatch')
    }
  })

  test('infers replacement attempts from rebuild branch names', () => {
    expect(inferPrAttemptFromBranch('agent/37/codex-dev')).toBe(1)
    expect(inferPrAttemptFromBranch('agent/37-rebuild/codex-dev')).toBe(2)
    expect(inferPrAttemptFromBranch('agent/37-rebuild-2/codex-dev')).toBe(3)
  })

  test('builds deterministic replacement branch names', () => {
    expect(buildReplacementBranchName('agent/37/codex-dev', 2)).toBe('agent/37-rebuild/codex-dev')
    expect(buildReplacementBranchName('agent/37-rebuild/codex-dev', 3)).toBe('agent/37-rebuild-2/codex-dev')
  })

  test('requests a replacement PR when the only matching lineage is closed', () => {
    const decision = choosePrLifecycleAction({
      issueNumber: 37,
      headBranch: 'agent/37/codex-dev',
      baseBranch: 'master',
      baseSha: '11fc78e',
    }, [
      {
        number: 45,
        prUrl: 'https://example.test/pr/45',
        prState: 'closed',
        headRefName: 'agent/37/codex-dev',
        baseRefName: 'master',
        body: renderPrLineageMetadataComment(buildPrLineageMetadata({
          issueNumber: 37,
          headBranch: 'agent/37/codex-dev',
          baseBranch: 'master',
          baseSha: '0176283',
          attempt: 1,
        })),
      },
    ])

    expect(decision).toEqual({
      kind: 'replacement-needed',
      supersedesPrNumber: 45,
      supersedesPrState: 'closed',
      replacementBranch: 'agent/37-rebuild/codex-dev',
      replacementAttempt: 2,
      reason: 'terminal-closed',
    })
  })

  test('reuses the matching open lineage when metadata fingerprint matches', () => {
    const metadata = buildPrLineageMetadata({
      issueNumber: 37,
      headBranch: 'agent/37-rebuild/codex-dev',
      baseBranch: 'master',
      baseSha: '11fc78e',
      attempt: 2,
    })
    const decision = choosePrLifecycleAction({
      issueNumber: 37,
      headBranch: 'agent/37-rebuild/codex-dev',
      baseBranch: 'master',
      baseSha: '11fc78e',
    }, [
      {
        number: 91,
        prUrl: 'https://example.test/pr/91',
        prState: 'open',
        headRefName: 'agent/37-rebuild/codex-dev',
        baseRefName: 'master',
        body: renderPrLineageMetadataComment(metadata),
      },
    ])

    expect(decision).toEqual({
      kind: 'reuse-open-lineage',
      prNumber: 91,
      prUrl: 'https://example.test/pr/91',
      branch: 'agent/37-rebuild/codex-dev',
      attempt: 2,
    })
  })

  test('marks an open mismatched lineage for replacement', () => {
    const decision = choosePrLifecycleAction({
      issueNumber: 37,
      headBranch: 'agent/37-rebuild/codex-dev',
      baseBranch: 'master',
      baseSha: '11fc78e',
    }, [
      {
        number: 91,
        prUrl: 'https://example.test/pr/91',
        prState: 'open',
        headRefName: 'agent/37-rebuild/codex-dev',
        baseRefName: 'agent/36/codex-dev',
        body: renderPrLineageMetadataComment(buildPrLineageMetadata({
          issueNumber: 37,
          headBranch: 'agent/37-rebuild/codex-dev',
          baseBranch: 'master',
          baseSha: '0176283',
          attempt: 2,
        })),
      },
    ])

    expect(decision).toEqual({
      kind: 'replacement-needed',
      supersedesPrNumber: 91,
      supersedesPrState: 'open',
      replacementBranch: 'agent/37-rebuild-2/codex-dev',
      replacementAttempt: 3,
      reason: 'lineage-mismatch',
    })
  })

  test('renders a structured supersede comment for audit trails', () => {
    const comment = buildSupersededPrComment({
      previousPrNumber: 45,
      replacementPrNumber: 91,
      replacementBranch: 'agent/37-rebuild/codex-dev',
      replacementAttempt: 2,
      reason: 'terminal-closed',
    })

    expect(comment).toContain('<!-- agent-loop:pr-superseded')
    expect(comment).toContain('This PR has been superseded by #91.')
    expect(comment).toContain('Replacement branch: `agent/37-rebuild/codex-dev`')
  })
})
