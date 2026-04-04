import { describe, expect, it } from 'bun:test'
import {
  buildEventComment,
  canTransition,
  parseClaimEventComment,
  parseIssueDependencyMetadata,
  resolveActiveClaimMachine,
} from './state-machine'

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

describe('canTransition', () => {
  it('allows failed issues to resume into working', () => {
    expect(canTransition('failed', 'working')).toBe(true)
  })
})

describe('parseClaimEventComment', () => {
  it('parses structured issue event comments', () => {
    expect(parseClaimEventComment(buildEventComment({
      event: 'claimed',
      machine: 'codex-a',
      ts: '2026-04-04T08:00:03.369Z',
      worktreeId: 'issue-36-codex-a',
    }))).toEqual({
      event: 'claimed',
      machine: 'codex-a',
      ts: '2026-04-04T08:00:03.369Z',
      worktreeId: 'issue-36-codex-a',
    })
  })

  it('ignores unrelated comments', () => {
    expect(parseClaimEventComment('plain text comment')).toBeNull()
    expect(parseClaimEventComment('<!-- agent-loop:pr-review {"approved":true} -->')).toBeNull()
  })
})

describe('resolveActiveClaimMachine', () => {
  it('keeps the earliest claimant as active owner until a reset event occurs', () => {
    const comments = [
      {
        body: buildEventComment({
          event: 'claimed',
          machine: 'codex-a',
          ts: '2026-04-04T08:00:03.369Z',
          worktreeId: 'issue-36-codex-a',
        }),
        createdAt: '2026-04-04T08:00:04Z',
      },
      {
        body: buildEventComment({
          event: 'claimed',
          machine: 'codex-b',
          ts: '2026-04-04T08:00:05.929Z',
          worktreeId: 'issue-36-codex-b',
        }),
        createdAt: '2026-04-04T08:00:07Z',
      },
      {
        body: buildEventComment({
          event: 'claimed',
          machine: 'codex-a',
          ts: '2026-04-04T08:00:10.000Z',
          reason: 'transition-to-working',
        }),
        createdAt: '2026-04-04T08:00:11Z',
      },
    ]

    expect(resolveActiveClaimMachine(comments)).toBe('codex-a')
  })

  it('hands ownership to a later claimant after stale-requeue resets the epoch', () => {
    const comments = [
      {
        body: buildEventComment({
          event: 'claimed',
          machine: 'codex-a',
          ts: '2026-04-04T08:00:03.369Z',
        }),
        createdAt: '2026-04-04T08:00:04Z',
      },
      {
        body: buildEventComment({
          event: 'stale-requeue',
          machine: 'codex-a',
          ts: '2026-04-04T08:30:00.000Z',
          reason: 'startup-reconcile-requeue',
        }),
        createdAt: '2026-04-04T08:30:01Z',
      },
      {
        body: buildEventComment({
          event: 'claimed',
          machine: 'codex-b',
          ts: '2026-04-04T08:31:00.000Z',
        }),
        createdAt: '2026-04-04T08:31:02Z',
      },
    ]

    expect(resolveActiveClaimMachine(comments)).toBe('codex-b')
  })
})
