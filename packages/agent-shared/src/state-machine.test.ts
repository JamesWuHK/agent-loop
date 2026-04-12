import { describe, expect, it } from 'bun:test'
import {
  buildEventComment,
  canTransition,
  inspectClaimSettlementSnapshot,
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

  it('allows failed issues to requeue into ready for a fresh attempt', () => {
    expect(canTransition('failed', 'ready')).toBe(true)
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
  it('keeps ownership with the same machine when it emits a later duplicate claimed event', () => {
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

  it('lets a newer current-epoch claimant override an older historical claimant without a reset', () => {
    const comments = [
      {
        body: buildEventComment({
          event: 'claimed',
          machine: 'codex-old',
          ts: '2026-04-04T08:00:03.369Z',
          worktreeId: 'issue-171-codex-old',
        }),
        createdAt: '2026-04-04T08:00:04Z',
      },
      {
        body: buildEventComment({
          event: 'claimed',
          machine: 'codex-dev',
          ts: '2026-04-04T08:31:00.000Z',
          worktreeId: 'issue-171-codex-dev',
        }),
        createdAt: '2026-04-04T08:31:02Z',
      },
    ]

    expect(resolveActiveClaimMachine(comments)).toBe('codex-dev')
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

  it('hands ownership to a later claimant after failed-requeue resets the epoch', () => {
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
          event: 'failed-requeue',
          machine: 'codex-a',
          ts: '2026-04-04T08:30:00.000Z',
          reason: 'auto-requeue-no-recovery-state',
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

describe('inspectClaimSettlementSnapshot', () => {
  it('keeps a visible conflicting active owner blocked when our expected claim event never appears', () => {
    const expectedClaimEvent = {
      event: 'claimed' as const,
      machine: 'codex-dev',
      ts: '2026-04-04T08:31:00.000Z',
      worktreeId: 'issue-171-codex-dev',
    }
    const staleHistoricalOwnerComments = [
      {
        body: buildEventComment({
          event: 'claimed',
          machine: 'codex-old',
          ts: '2026-04-04T08:00:03.369Z',
          worktreeId: 'issue-171-codex-old',
        }),
        createdAt: '2026-04-04T08:00:04Z',
      },
    ]

    const snapshots = Array.from({ length: 4 }, () => (
      inspectClaimSettlementSnapshot(staleHistoricalOwnerComments, expectedClaimEvent)
    ))

    expect(snapshots).toEqual([
      {
        activeMachine: 'codex-old',
        expectedClaimObserved: false,
        hasConflictingActiveOwner: true,
      },
      {
        activeMachine: 'codex-old',
        expectedClaimObserved: false,
        hasConflictingActiveOwner: true,
      },
      {
        activeMachine: 'codex-old',
        expectedClaimObserved: false,
        hasConflictingActiveOwner: true,
      },
      {
        activeMachine: 'codex-old',
        expectedClaimObserved: false,
        hasConflictingActiveOwner: true,
      },
    ])
  })
})
