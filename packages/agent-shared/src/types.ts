// ─── Issue State Machine ─────────────────────────────────────────────────────

export const ISSUE_LABELS = {
  READY: 'agent:ready',
  CLAIMED: 'agent:claimed',
  WORKING: 'agent:working',
  DONE: 'agent:done',
  FAILED: 'agent:failed',
  STALE: 'agent:stale',
} as const

export const PR_REVIEW_LABELS = {
  APPROVED: 'agent:review-approved',
  FAILED: 'agent:review-failed',
  RETRY: 'agent:review-retry',
  HUMAN_NEEDED: 'agent:human-needed',
} as const

export type IssueLabel = (typeof ISSUE_LABELS)[keyof typeof ISSUE_LABELS]

export type IssueState =
  | 'ready'
  | 'claimed'
  | 'working'
  | 'done'
  | 'failed'
  | 'stale'
  | 'unknown'

// ─── GitHub Issue (from API) ─────────────────────────────────────────────────

export interface GitHubLabel {
  id: number
  name: string
  color: string
}

export interface GitHubUser {
  login: string
  id: number
}

export interface GitHubIssue {
  number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  labels: GitHubLabel[]
  assignees: GitHubUser[]
  createdAt: string
  updatedAt: string
  url: string
}

export interface ManagedPullRequest {
  number: number
  title: string
  url: string
  headRefName: string
  isDraft: boolean
  labels: string[]
}

// ─── Internal Issue (derived) ───────────────────────────────────────────────

export interface AgentIssue {
  number: number
  title: string
  body: string
  state: IssueState
  labels: string[]
  assignee: string | null
  isClaimable: boolean
  updatedAt: string
  dependencyIssueNumbers: number[]
  hasDependencyMetadata: boolean
  dependencyParseError: boolean
  claimBlockedBy: number[]
  hasExecutableContract: boolean
  contractValidationErrors: string[]
}

export interface IssueDependencyMetadata {
  dependsOn: number[]
  hasDependencyMetadata: boolean
  dependencyParseError: boolean
}

// ─── Claim Event (JSON in issue comment) ────────────────────────────────────

export interface ClaimEvent {
  event: 'claimed' | 'done' | 'failed' | 'stale' | 'stale-requeue'
  machine: string
  ts: string
  worktreeId?: string
  prNumber?: number
  exitCode?: number
  reason?: string
  prReview?: unknown
}

// ─── Config ─────────────────────────────────────────────────────────────────

export interface AgentConfig {
  machineId: string
  repo: string
  pat: string
  pollIntervalMs: number
  concurrency: number
  worktreesBase: string
  agent: {
    primary: 'claude' | 'codex'
    fallback: 'claude' | 'codex' | null
    claudePath: string
    codexPath: string
    // Agent 执行超时（毫秒）
    timeoutMs: number
  }
  git: {
    defaultBranch: string
    authorName: string
    authorEmail: string
  }
}

// ─── Worktree ────────────────────────────────────────────────────────────────

export interface WorktreeInfo {
  path: string
  issueNumber: number
  machineId: string
  branch: string
  state: 'active' | 'done' | 'failed' | 'orphaned'
  createdAt: string
  prUrl?: string
}

// ─── Agent Execution Result ──────────────────────────────────────────────────

export type AgentExitCode = 0 | 1 | 2 | 3

export interface AgentResult {
  success: boolean
  exitCode: AgentExitCode
  prNumber?: number
  prUrl?: string
  error?: string
  durationMs: number
}

// ─── Subtask (for multi-step planning) ────────────────────────────────────────

export interface Subtask {
  id: string
  title: string
  status: 'pending' | 'done' | 'failed'
  order: number
}

// ─── Daemon Status ──────────────────────────────────────────────────────────

export interface DaemonStatus {
  running: boolean
  machineId: string
  repo: string
  pollIntervalMs: number
  concurrency: number
  activeWorktrees: WorktreeInfo[]
  lastPollAt: string | null
  lastClaimedAt: string | null
  uptimeMs: number
  pid: number
}
