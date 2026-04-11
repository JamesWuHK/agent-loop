import { describe, expect, test } from 'bun:test'
import {
  buildLocalImplementationIndex,
  parseLocalImplementationRecords,
} from './local-implementation'

describe('parseLocalImplementationRecords', () => {
  test('extracts issue-linked implementation commits from conventional subjects', () => {
    const records = parseLocalImplementationRecords([
      'Fix #70 add bootstrap scorecard taxonomy report',
      '',
      '\u001e',
      'feat(#53): add issue repair cli',
      '',
      '\u001e',
      'docs: mention roadmap only',
      '',
      '\u001e',
    ].join('\n'))

    expect(records).toEqual([
      {
        issueNumber: 70,
        latestCommitHeadline: 'Fix #70 add bootstrap scorecard taxonomy report',
        commitCount: 1,
      },
      {
        issueNumber: 53,
        latestCommitHeadline: 'feat(#53): add issue repair cli',
        commitCount: 1,
      },
    ])
  })

  test('keeps the newest headline and counts repeated implementations for the same issue', () => {
    const records = parseLocalImplementationRecords([
      'fix(#61): gate approved PR merges on check status',
      '',
      '\u001e',
      'feat(#61): first pass at checks gate',
      '',
      '\u001e',
    ].join('\n'))

    expect(records).toEqual([
      {
        issueNumber: 61,
        latestCommitHeadline: 'fix(#61): gate approved PR merges on check status',
        commitCount: 2,
      },
    ])
  })
})

describe('buildLocalImplementationIndex', () => {
  test('returns an empty index when git log cannot be read', () => {
    expect(buildLocalImplementationIndex('/definitely/not/a/repo')).toEqual(new Map())
  })
})
