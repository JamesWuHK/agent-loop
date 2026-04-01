import { describe, expect, it } from 'bun:test'
import { parseIssueDependencyMetadata } from './state-machine'

describe('parseIssueDependencyMetadata', () => {
  it('returns no dependency metadata when Context section is missing', () => {
    expect(parseIssueDependencyMetadata('## 用户故事\nhello')).toEqual({
      dependsOn: [],
      hasDependencyMetadata: false,
      dependencyParseError: false,
    })
  })

  it('returns no dependency metadata when Dependencies section is missing', () => {
    expect(parseIssueDependencyMetadata('## Context\n### Constraints\n- x')).toEqual({
      dependsOn: [],
      hasDependencyMetadata: false,
      dependencyParseError: false,
    })
  })

  it('parses valid dependsOn values, dedupes, sorts, and drops self dependency', () => {
    const body = [
      '## Context',
      '### Dependencies',
      '```json',
      '{ "dependsOn": [48, 45, 48, 47, 45] }',
      '```',
    ].join('\n')
    expect(parseIssueDependencyMetadata(body, 47)).toEqual({
      dependsOn: [45, 48],
      hasDependencyMetadata: true,
      dependencyParseError: false,
    })
  })

  it('marks malformed dependency json as parse error', () => {
    const body = [
      '## Context',
      '### Dependencies',
      '```json',
      '{ invalid }',
      '```',
    ].join('\n')
    expect(parseIssueDependencyMetadata(body)).toEqual({
      dependsOn: [],
      hasDependencyMetadata: true,
      dependencyParseError: true,
    })
  })
})
