import { describe, expect, test } from 'bun:test'
import {
  applyDependencyClaimability,
  buildGhEnv,
  deriveIssueStateFromRaw,
  parseGhApiErrorMessage,
  parseMergePrResponse,
  shouldClearIssueAssigneesForStateLabel,
} from './github-api'
import { ISSUE_LABELS } from './types'

describe('buildGhEnv', () => {
  test('removes proxy variables and injects GitHub auth tokens', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
    process.env.http_proxy = 'http://127.0.0.1:7890'
    process.env.NO_PROXY = '127.0.0.1,localhost'

    const env = buildGhEnv({ pat: 'ghp_test' })

    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.http_proxy).toBeUndefined()
    expect(env.NO_PROXY).toBe('127.0.0.1,localhost')
    expect(env.GH_TOKEN).toBe('ghp_test')
    expect(env.GITHUB_TOKEN).toBe('ghp_test')
  })
})

describe('parseGhApiErrorMessage', () => {
  test('prefers JSON message from stdout when present', () => {
    expect(parseGhApiErrorMessage('{"message":"Pull Request is not mergeable"}', '')).toBe(
      'Pull Request is not mergeable',
    )
  })

  test('falls back to stderr when stdout is empty', () => {
    expect(parseGhApiErrorMessage('', 'gh: GraphQL error')).toBe('gh: GraphQL error')
  })
})

describe('parseMergePrResponse', () => {
  test('parses successful merge responses', () => {
    expect(parseMergePrResponse('{"merged":true,"message":"Pull Request successfully merged","sha":"abc123"}')).toEqual({
      merged: true,
      message: 'Pull Request successfully merged',
      sha: 'abc123',
    })
  })

  test('surfaces non-merged API responses', () => {
    expect(parseMergePrResponse('{"merged":false,"message":"Pull Request is not mergeable"}')).toEqual({
      merged: false,
      message: 'Pull Request is not mergeable',
      sha: undefined,
    })
  })
})

describe('deriveIssueStateFromRaw', () => {
  test('treats closed issues as done even if stale labels remain', () => {
    expect(deriveIssueStateFromRaw(['agent:failed'], 'closed')).toBe('done')
  })

  test('treats GitHub GraphQL CLOSED states as done even if stale labels remain', () => {
    expect(deriveIssueStateFromRaw(['agent:failed'], 'CLOSED')).toBe('done')
  })

  test('still infers state from labels for open issues', () => {
    expect(deriveIssueStateFromRaw(['agent:failed'], 'open')).toBe('failed')
  })
})

describe('shouldClearIssueAssigneesForStateLabel', () => {
  test('clears assignees when re-queueing an issue into agent:ready', () => {
    expect(shouldClearIssueAssigneesForStateLabel(ISSUE_LABELS.READY)).toBe(true)
  })

  test('keeps assignees intact for in-progress managed states', () => {
    expect(shouldClearIssueAssigneesForStateLabel(ISSUE_LABELS.CLAIMED)).toBe(false)
    expect(shouldClearIssueAssigneesForStateLabel(ISSUE_LABELS.WORKING)).toBe(false)
    expect(shouldClearIssueAssigneesForStateLabel(ISSUE_LABELS.FAILED)).toBe(false)
  })
})

describe('applyDependencyClaimability', () => {
  test('blocks ready issues that do not have an executable contract', () => {
    const [issue] = applyDependencyClaimability([
      {
        number: 46,
        title: 'bad issue',
        body: '## 用户故事\nx',
        state: 'ready',
        labels: ['agent:ready'],
        assignee: null,
        isClaimable: true,
        updatedAt: '2026-04-04T00:00:00Z',
        dependencyIssueNumbers: [],
        hasDependencyMetadata: false,
        dependencyParseError: false,
        claimBlockedBy: [],
        hasExecutableContract: false,
        contractValidationErrors: ['missing ## 实现步骤 / Implementation Steps'],
      },
    ])

    expect(issue?.isClaimable).toBe(false)
    expect(issue?.hasExecutableContract).toBe(false)
    expect(issue?.contractValidationErrors).toEqual(['missing ## 实现步骤 / Implementation Steps'])
  })

  test('keeps valid ready issues claimable when dependencies are satisfied', () => {
    const [issue] = applyDependencyClaimability([
      {
        number: 47,
        title: 'good issue',
        body: 'valid',
        state: 'ready',
        labels: ['agent:ready'],
        assignee: null,
        isClaimable: true,
        updatedAt: '2026-04-04T00:00:00Z',
        dependencyIssueNumbers: [],
        hasDependencyMetadata: true,
        dependencyParseError: false,
        claimBlockedBy: [],
        hasExecutableContract: true,
        contractValidationErrors: [],
      },
    ])

    expect(issue?.isClaimable).toBe(true)
    expect(issue?.claimBlockedBy).toEqual([])
  })
})
