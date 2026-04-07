import { describe, expect, test } from 'bun:test'
import { deriveDashboardIssueState } from './issue-dashboard-state'

describe('deriveDashboardIssueState', () => {
  test('marks a ready and claimable issue as queued + runnable', () => {
    expect(deriveDashboardIssueState({
      issue: {
        state: 'ready',
        isClaimable: true,
        claimBlockedBy: [],
        hasExecutableContract: true,
        linkedPrNumbers: [],
        activeLease: null,
      },
      hasReviewApprovedPr: false,
      hasHumanNeededPr: false,
      activeLeaseProgressStale: false,
    })).toEqual({
      lifecycleState: 'queued',
      derivedState: 'runnable',
      reasonSummary: '当前可认领并可开始执行',
    })
  })

  test('marks a ready but blocked issue as queued + dependency_blocked', () => {
    expect(deriveDashboardIssueState({
      issue: {
        state: 'ready',
        isClaimable: false,
        claimBlockedBy: [118],
        hasExecutableContract: true,
        linkedPrNumbers: [],
        activeLease: null,
      },
      hasReviewApprovedPr: false,
      hasHumanNeededPr: false,
      activeLeaseProgressStale: false,
    }).derivedState).toBe('dependency_blocked')
  })

  test('marks a ready issue without an executable contract as queued + contract_invalid', () => {
    expect(deriveDashboardIssueState({
      issue: {
        state: 'ready',
        isClaimable: false,
        claimBlockedBy: [],
        hasExecutableContract: false,
        linkedPrNumbers: [],
        activeLease: null,
      },
      hasReviewApprovedPr: false,
      hasHumanNeededPr: false,
      activeLeaseProgressStale: false,
    }).derivedState).toBe('contract_invalid')
  })

  test('marks a ready issue with an open PR as queued + waiting_review', () => {
    expect(deriveDashboardIssueState({
      issue: {
        state: 'ready',
        isClaimable: false,
        claimBlockedBy: [],
        hasExecutableContract: true,
        linkedPrNumbers: [205],
        activeLease: null,
      },
      hasReviewApprovedPr: false,
      hasHumanNeededPr: false,
      activeLeaseProgressStale: false,
    }).derivedState).toBe('waiting_review')
  })

  test('marks an approved PR path as queued + waiting_merge', () => {
    expect(deriveDashboardIssueState({
      issue: {
        state: 'ready',
        isClaimable: false,
        claimBlockedBy: [],
        hasExecutableContract: true,
        linkedPrNumbers: [205],
        activeLease: null,
      },
      hasReviewApprovedPr: true,
      hasHumanNeededPr: false,
      activeLeaseProgressStale: false,
    }).derivedState).toBe('waiting_merge')
  })

  test('marks a human-needed PR path as queued + human_needed', () => {
    expect(deriveDashboardIssueState({
      issue: {
        state: 'ready',
        isClaimable: false,
        claimBlockedBy: [],
        hasExecutableContract: true,
        linkedPrNumbers: [205],
        activeLease: null,
      },
      hasReviewApprovedPr: false,
      hasHumanNeededPr: true,
      activeLeaseProgressStale: false,
    }).derivedState).toBe('human_needed')
  })

  test('marks a stale issue as recovering + recoverable', () => {
    expect(deriveDashboardIssueState({
      issue: {
        state: 'stale',
        isClaimable: false,
        claimBlockedBy: [],
        hasExecutableContract: true,
        linkedPrNumbers: [],
        activeLease: null,
      },
      hasReviewApprovedPr: false,
      hasHumanNeededPr: false,
      activeLeaseProgressStale: false,
    }).derivedState).toBe('recoverable')
  })

  test('marks a working issue with a stale active lease as stalled', () => {
    expect(deriveDashboardIssueState({
      issue: {
        state: 'working',
        isClaimable: false,
        claimBlockedBy: [],
        hasExecutableContract: true,
        linkedPrNumbers: [],
        activeLease: { status: 'active' },
      },
      hasReviewApprovedPr: false,
      hasHumanNeededPr: false,
      activeLeaseProgressStale: true,
    }).derivedState).toBe('stalled')
  })
})
