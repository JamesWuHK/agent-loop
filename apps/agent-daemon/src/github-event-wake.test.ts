import { describe, expect, test } from 'bun:test'
import { buildWakeRequestFromGitHubEvent, readWakeRequestFromGitHubEventContext } from './github-event-wake'

describe('github event wake parser', () => {
  test('builds an issue wake when agent:ready is labeled', () => {
    expect(buildWakeRequestFromGitHubEvent({
      eventName: 'issues',
      requestedAt: '2026-04-11T10:00:00.000Z',
      event: {
        action: 'labeled',
        label: {
          name: 'agent:ready',
        },
        issue: {
          number: 374,
          labels: [{ name: 'agent:ready' }],
          updated_at: '2026-04-11T09:59:59.000Z',
        },
      },
    })).toEqual({
      kind: 'issue',
      issueNumber: 374,
      reason: 'issues.labeled:agent:ready',
      sourceEvent: 'issues.labeled',
      dedupeKey: 'issues:labeled:374:agent:ready',
      requestedAt: '2026-04-11T10:00:00.000Z',
    })
  })

  test('wakes non-ready actionable issues when they are edited', () => {
    expect(buildWakeRequestFromGitHubEvent({
      eventName: 'issues',
      requestedAt: '2026-04-11T10:05:00.000Z',
      event: {
        action: 'edited',
        issue: {
          number: 88,
          labels: [{ name: 'agent:failed' }],
          updated_at: '2026-04-11T10:04:30.000Z',
        },
      },
    })).toEqual({
      kind: 'issue',
      issueNumber: 88,
      reason: 'issues.edited',
      sourceEvent: 'issues.edited',
      dedupeKey: 'issues:edited:88:2026-04-11T10:04:30.000Z',
      requestedAt: '2026-04-11T10:05:00.000Z',
    })
  })

  test('ignores draft pull requests until they are ready for review', () => {
    expect(buildWakeRequestFromGitHubEvent({
      eventName: 'pull_request',
      requestedAt: '2026-04-11T10:10:00.000Z',
      event: {
        action: 'opened',
        pull_request: {
          number: 205,
          draft: true,
          head: {
            sha: 'abc123',
          },
        },
      },
    })).toBeNull()
  })

  test('builds a pr wake on synchronize using the new head sha as dedupe key', () => {
    expect(buildWakeRequestFromGitHubEvent({
      eventName: 'pull_request',
      requestedAt: '2026-04-11T10:12:00.000Z',
      event: {
        action: 'synchronize',
        pull_request: {
          number: 205,
          draft: false,
          head: {
            sha: 'def456',
          },
        },
      },
    })).toEqual({
      kind: 'pr',
      prNumber: 205,
      reason: 'pull_request.synchronize',
      sourceEvent: 'pull_request.synchronize',
      dedupeKey: 'pull_request:synchronize:205:def456',
      requestedAt: '2026-04-11T10:12:00.000Z',
    })
  })

  test('builds a pr wake when review labels change', () => {
    expect(buildWakeRequestFromGitHubEvent({
      eventName: 'pull_request',
      requestedAt: '2026-04-11T10:15:00.000Z',
      event: {
        action: 'labeled',
        label: {
          name: 'agent:review-approved',
        },
        pull_request: {
          number: 205,
          draft: false,
          head: {
            sha: 'def456',
          },
        },
      },
    })).toEqual({
      kind: 'pr',
      prNumber: 205,
      reason: 'pull_request.labeled:agent:review-approved',
      sourceEvent: 'pull_request.labeled',
      dedupeKey: 'pull_request:labeled:205:agent:review-approved',
      requestedAt: '2026-04-11T10:15:00.000Z',
    })
  })

  test('wakes an issue when a structured resolution comment is posted', () => {
    expect(buildWakeRequestFromGitHubEvent({
      eventName: 'issue_comment',
      requestedAt: '2026-04-11T10:20:00.000Z',
      event: {
        action: 'created',
        issue: {
          number: 104,
          labels: [{ name: 'agent:failed' }],
        },
        comment: {
          id: 9001,
          body: '<!-- agent-loop:issue-resume-resolved {"issueNumber":104,"prNumber":205} -->\nresolved',
        },
      },
    })).toEqual({
      kind: 'issue',
      issueNumber: 104,
      reason: 'issue_comment.issue-resume-resolved',
      sourceEvent: 'issue_comment.created',
      dedupeKey: 'issue_comment:9001:issue-resume-resolved',
      requestedAt: '2026-04-11T10:20:00.000Z',
    })
  })

  test('supports workflow_dispatch issue and fallback wake-now inputs', () => {
    expect(buildWakeRequestFromGitHubEvent({
      eventName: 'workflow_dispatch',
      requestedAt: '2026-04-11T10:25:00.000Z',
      event: {
        inputs: {
          wake_target: 'issue',
          issue_number: '42',
        },
      },
    })).toEqual({
      kind: 'issue',
      issueNumber: 42,
      reason: 'workflow_dispatch:issue',
      sourceEvent: 'workflow_dispatch',
      dedupeKey: 'workflow_dispatch:issue:42',
      requestedAt: '2026-04-11T10:25:00.000Z',
    })

    expect(buildWakeRequestFromGitHubEvent({
      eventName: 'workflow_dispatch',
      requestedAt: '2026-04-11T10:26:00.000Z',
      event: {
        inputs: {
          wake_target: 'auto',
        },
      },
    })).toEqual({
      kind: 'now',
      reason: 'workflow_dispatch',
      sourceEvent: 'workflow_dispatch',
      dedupeKey: 'workflow_dispatch:now',
      requestedAt: '2026-04-11T10:26:00.000Z',
    })
  })

  test('loads github event context from the actions environment', () => {
    const request = readWakeRequestFromGitHubEventContext({}, {
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: '/tmp/github-event.json',
    }, () => JSON.stringify({
      action: 'ready_for_review',
      pull_request: {
        number: 205,
        draft: false,
        head: {
          sha: 'fedcba',
        },
      },
    }))

    expect(request).toEqual({
      kind: 'pr',
      prNumber: 205,
      reason: 'pull_request.ready_for_review',
      sourceEvent: 'pull_request.ready_for_review',
      dedupeKey: 'pull_request:ready_for_review:205:fedcba',
      requestedAt: expect.any(String),
    })
  })
})
