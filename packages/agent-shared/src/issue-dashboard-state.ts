import type { IssueState } from './types'

export type DashboardIssueLifecycleState =
  | 'untracked'
  | 'queued'
  | 'working'
  | 'failed'
  | 'done'
  | 'recovering'

export type DashboardIssueDerivedState =
  | 'runnable'
  | 'dependency_blocked'
  | 'contract_invalid'
  | 'waiting_review'
  | 'waiting_merge'
  | 'human_needed'
  | 'recoverable'
  | 'stalled'
  | 'idle'

export function deriveDashboardIssueState(input: {
  issue: {
    state: IssueState
    isClaimable: boolean
    claimBlockedBy: number[]
    hasExecutableContract: boolean
    linkedPrNumbers: number[]
    activeLease: { status: string } | null
  }
  hasReviewApprovedPr: boolean
  hasHumanNeededPr: boolean
  activeLeaseProgressStale: boolean
}): {
  lifecycleState: DashboardIssueLifecycleState
  derivedState: DashboardIssueDerivedState
  reasonSummary: string
} {
  const lifecycleState = deriveLifecycleState(input.issue.state)

  if (lifecycleState === 'untracked') {
    return {
      lifecycleState,
      derivedState: 'idle',
      reasonSummary: '尚未进入 agent-loop 队列',
    }
  }

  if (lifecycleState === 'done') {
    return {
      lifecycleState,
      derivedState: 'idle',
      reasonSummary: '已完成并退出队列',
    }
  }

  if (input.hasHumanNeededPr) {
    return {
      lifecycleState,
      derivedState: 'human_needed',
      reasonSummary: '关联 PR 需要人工处理',
    }
  }

  if (input.hasReviewApprovedPr) {
    return {
      lifecycleState,
      derivedState: 'waiting_merge',
      reasonSummary: '评审已通过，等待自动合并',
    }
  }

  if (
    lifecycleState === 'queued'
    && input.issue.linkedPrNumbers.length > 0
  ) {
    return {
      lifecycleState,
      derivedState: 'waiting_review',
      reasonSummary: '已有开放 PR，等待 review',
    }
  }

  if (lifecycleState === 'failed') {
    return {
      lifecycleState,
      derivedState: 'recoverable',
      reasonSummary: '失败后待自动恢复或重排',
    }
  }

  if (lifecycleState === 'recovering') {
    return {
      lifecycleState,
      derivedState: 'recoverable',
      reasonSummary: '处于待恢复状态',
    }
  }

  if (lifecycleState === 'working' && input.activeLeaseProgressStale) {
    return {
      lifecycleState,
      derivedState: 'stalled',
      reasonSummary: '执行中的租约长时间没有进展',
    }
  }

  if (lifecycleState === 'working') {
    return {
      lifecycleState,
      derivedState: 'idle',
      reasonSummary: input.issue.state === 'claimed'
        ? '已认领，等待执行进程接手'
        : '当前正在执行',
    }
  }

  if (!input.issue.hasExecutableContract) {
    return {
      lifecycleState,
      derivedState: 'contract_invalid',
      reasonSummary: 'Issue 合同不完整，暂不可执行',
    }
  }

  if (input.issue.claimBlockedBy.length > 0) {
    return {
      lifecycleState,
      derivedState: 'dependency_blocked',
      reasonSummary: `依赖 issue 未完成：#${input.issue.claimBlockedBy.join(', #')}`,
    }
  }

  if (input.issue.isClaimable) {
    return {
      lifecycleState,
      derivedState: 'runnable',
      reasonSummary: '当前可认领并可开始执行',
    }
  }

  return {
    lifecycleState,
    derivedState: 'idle',
    reasonSummary: '已入队，等待下一轮调度判断',
  }
}

function deriveLifecycleState(state: IssueState): DashboardIssueLifecycleState {
  switch (state) {
    case 'ready':
      return 'queued'
    case 'claimed':
    case 'working':
      return 'working'
    case 'failed':
      return 'failed'
    case 'done':
      return 'done'
    case 'stale':
      return 'recovering'
    case 'unknown':
    default:
      return 'untracked'
  }
}
