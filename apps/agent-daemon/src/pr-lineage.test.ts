import { describe, expect, test } from 'bun:test'
import {
  buildPrLineageMetadata,
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
})
