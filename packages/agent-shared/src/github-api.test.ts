import { describe, expect, it } from 'bun:test'
import { applyDependencyClaimability } from './github-api'
import type { AgentIssue } from './types'

function makeIssue(overrides: Partial<AgentIssue> = {}): AgentIssue {
  return {
    number: 1,
    title: 'issue',
    body: '',
    state: 'ready',
    labels: ['agent:ready'],
    assignee: null,
    isClaimable: true,
    updatedAt: '2026-04-01T00:00:00Z',
    dependencyIssueNumbers: [],
    hasDependencyMetadata: false,
    dependencyParseError: false,
    claimBlockedBy: [],
    ...overrides,
  }
}

describe('applyDependencyClaimability', () => {
  it('keeps ready unassigned issue without dependencies claimable', () => {
    const [issue] = applyDependencyClaimability([makeIssue({ number: 45 })])
    expect(issue!.isClaimable).toBe(true)
    expect(issue!.claimBlockedBy).toEqual([])
  })

  it('blocks issue when dependency is unfinished in open issues', () => {
    const issues = applyDependencyClaimability([
      makeIssue({ number: 46, dependencyIssueNumbers: [45] }),
      makeIssue({ number: 45, state: 'working', labels: ['agent:working'], isClaimable: false }),
    ])
    const blocked = issues.find(issue => issue.number === 46)!
    expect(blocked.isClaimable).toBe(false)
    expect(blocked.claimBlockedBy).toEqual([45])
  })

  it('allows issue when dependency is done in resolved dependencies', () => {
    const resolved = new Map<number, AgentIssue>([
      [45, makeIssue({ number: 45, state: 'done', labels: ['agent:done'], isClaimable: false })],
    ])
    const [issue] = applyDependencyClaimability([
      makeIssue({ number: 46, dependencyIssueNumbers: [45] }),
    ], resolved)
    expect(issue!.isClaimable).toBe(true)
    expect(issue!.claimBlockedBy).toEqual([])
  })

  it('blocks issue on dependency parse error', () => {
    const [issue] = applyDependencyClaimability([
      makeIssue({ number: 46, dependencyIssueNumbers: [45], dependencyParseError: true }),
    ])
    expect(issue!.isClaimable).toBe(false)
    expect(issue!.claimBlockedBy).toEqual([45])
  })
})
