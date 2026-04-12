import { describe, expect, test } from 'bun:test'
import {
  ISSUE_LABELS,
  ISSUE_PRIORITY_LABELS,
  sortClaimableIssuesForScheduling,
  type AgentConfig,
  type AgentIssue,
} from '@agent/shared'
import { claimSpecificIssue, pollAndClaim, type ClaimerDependencies } from './claimer'

function buildConfig(): AgentConfig {
  return {
    machineId: 'machine-a',
    repo: 'JamesWuHK/agent-loop',
    pat: '',
    pollIntervalMs: 30_000,
    concurrency: 1,
    requestedConcurrency: 1,
    concurrencyPolicy: {
      requested: 1,
      effective: 1,
      repoCap: null,
      profileCap: null,
      projectCap: null,
    },
    scheduling: {
      concurrencyByRepo: {},
      concurrencyByProfile: {},
    },
    recovery: {
      heartbeatIntervalMs: 30_000,
      leaseTtlMs: 120_000,
      workerIdleTimeoutMs: 600_000,
      leaseAdoptionBackoffMs: 30_000,
      leaseNoProgressTimeoutMs: 300_000,
    },
    worktreesBase: '/tmp/agent-loop',
    project: {
      profile: 'generic',
    },
    agent: {
      primary: 'codex',
      fallback: null,
      claudePath: 'claude',
      codexPath: 'codex',
      codexReasoningEffort: 'high',
      timeoutMs: 1_800_000,
    },
    git: {
      defaultBranch: 'main',
      authorName: 'Agent Loop',
      authorEmail: 'agent-loop@example.com',
    },
  }
}

function buildIssue(input: Partial<AgentIssue> & Pick<AgentIssue, 'number'>): AgentIssue {
  const { number, ...rest } = input

  return {
    number,
    title: `issue-${number}`,
    body: '',
    state: 'ready',
    labels: [ISSUE_LABELS.READY],
    assignee: null,
    isClaimable: true,
    updatedAt: '2026-04-11T08:00:00.000Z',
    dependencyIssueNumbers: [],
    hasDependencyMetadata: true,
    dependencyParseError: false,
    claimBlockedBy: [],
    hasExecutableContract: true,
    contractValidationErrors: [],
    ...rest,
  }
}

function buildDependencies(
  issues: AgentIssue[],
  claimIssue: ClaimerDependencies['claimIssue'],
): ClaimerDependencies {
  return {
    fetchClaimableIssues: async () => issues,
    claimIssue,
    sortClaimableIssuesForScheduling,
    recordClaim: () => {},
    sleep: async () => {},
    random: () => 0,
  }
}

describe('pollAndClaim', () => {
  test('tries claimable issues in scheduling priority order before claiming', async () => {
    const claimAttempts: number[] = []
    const issues = [
      buildIssue({ number: 14 }),
      buildIssue({ number: 13, labels: [ISSUE_LABELS.READY, ISSUE_PRIORITY_LABELS.LOW] }),
      buildIssue({
        number: 12,
        labels: [ISSUE_LABELS.READY, ISSUE_PRIORITY_LABELS.HIGH],
        updatedAt: '2026-04-11T08:05:00.000Z',
      }),
      buildIssue({
        number: 11,
        labels: [ISSUE_LABELS.READY, ISSUE_PRIORITY_LABELS.HIGH],
        updatedAt: '2026-04-11T08:01:00.000Z',
      }),
    ]

    const claimed = await pollAndClaim(
      buildConfig(),
      {
        log: () => {},
        warn: () => {},
        error: () => {},
      } as typeof console,
      buildDependencies(issues, async (issueNumber) => {
        claimAttempts.push(issueNumber)
        if (issueNumber === 11) {
          return { success: false, issueNumber, reason: 'already-claimed' }
        }
        if (issueNumber === 12) {
          return { success: true, issueNumber, reason: 'claimed' }
        }
        return { success: false, issueNumber, reason: 'already-claimed' }
      }),
    )

    expect(claimAttempts).toEqual([11, 12])
    expect(claimed?.number).toBe(12)
  })

  test('claimSpecificIssue short-circuits non-claimable issues', async () => {
    const claimed = await claimSpecificIssue(
      buildIssue({
        number: 22,
        isClaimable: false,
      }),
      buildConfig(),
      {
        log: () => {},
        warn: () => {},
        error: () => {},
      } as typeof console,
      buildDependencies([], async (issueNumber) => ({
        success: true,
        issueNumber,
        reason: 'claimed',
      })),
    )

    expect(claimed).toBeNull()
  })
})
