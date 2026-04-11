// ─── Issue State Machine ─────────────────────────────────────────────────────

export const ISSUE_LABELS = {
  READY: 'agent:ready',
  CLAIMED: 'agent:claimed',
  WORKING: 'agent:working',
  DONE: 'agent:done',
  FAILED: 'agent:failed',
  STALE: 'agent:stale',
} as const

export const ISSUE_PRIORITY_LABELS = {
  HIGH: 'agent:priority-high',
  LOW: 'agent:priority-low',
} as const

export const PR_REVIEW_LABELS = {
  APPROVED: 'agent:review-approved',
  FAILED: 'agent:review-failed',
  RETRY: 'agent:review-retry',
  HUMAN_NEEDED: 'agent:human-needed',
} as const

export type IssueLabel = (typeof ISSUE_LABELS)[keyof typeof ISSUE_LABELS]
export type IssuePriorityLabel = (typeof ISSUE_PRIORITY_LABELS)[keyof typeof ISSUE_PRIORITY_LABELS]

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
  headRefOid: string | null
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

export type ProjectProfileName =
  | 'generic'
  | 'desktop-vite'

export type ProjectPromptContext =
  | 'planning'
  | 'implementation'
  | 'reviewFix'
  | 'recovery'

export interface ProjectPromptGuidanceOverrides {
  planning?: string[]
  implementation?: string[]
  reviewFix?: string[]
  recovery?: string[]
}

export interface ProjectProfileConfig {
  profile: ProjectProfileName
  promptGuidance?: ProjectPromptGuidanceOverrides
  maxConcurrency?: number
}

export type RepoAuthoringContextCommandSource = 'root-package-json' | 'workspace-package-json'

export interface RepoAuthoringContextCommandCandidate {
  command: string
  scriptName: string
  source: RepoAuthoringContextCommandSource
  packageJsonPath: string
}

export type RepoAuthoringContextFileCandidateKind = 'allowed' | 'forbidden'

export interface RepoAuthoringContextFileCandidate {
  path: string
  kind: RepoAuthoringContextFileCandidateKind
  reason: string
}

export interface BuildRepoAuthoringContextInput {
  repoRoot: string
  issueText: string
  issueTitle?: string
  issueBody?: string
  repoRelativeFilePaths?: string[]
  rootPackageJsonPath?: string
  workspacePackageJsonPaths?: string[]
}

export interface RepoAuthoringContext {
  candidateValidationCommands: string[]
  candidateAllowedFiles: string[]
  candidateForbiddenFiles: string[]
}

export interface AgentSchedulingConfig {
  concurrencyByRepo: Record<string, number>
  concurrencyByProfile: Partial<Record<ProjectProfileName, number>>
}

export interface ConcurrencyPolicy {
  requested: number
  effective: number
  repoCap: number | null
  profileCap: number | null
  projectCap: number | null
}

export interface RecoveryConfig {
  heartbeatIntervalMs: number
  leaseTtlMs: number
  workerIdleTimeoutMs: number
  leaseAdoptionBackoffMs: number
  leaseNoProgressTimeoutMs: number
}

export interface AgentLoopUpgradeConfig {
  enabled: boolean
  repo: string | null
  channel: string | null
  checkIntervalMs: number
  reminderIntervalMs: number
  autoApply: boolean
}

export interface AgentLoopBuildMetadata {
  repo: string | null
  version: string
  revision: string | null
}

export type AgentLoopUpgradeStatusKind =
  | 'disabled'
  | 'unknown'
  | 'up-to-date'
  | 'upgrade-available'
  | 'ahead-of-channel'
  | 'error'

export interface AgentLoopUpgradeMetadata {
  enabled: boolean
  repo: string | null
  channel: string | null
  checkedAt: string | null
  status: AgentLoopUpgradeStatusKind
  latestVersion: string | null
  latestRevision: string | null
  latestCommitAt: string | null
  safeToUpgradeNow: boolean
  message: string | null
}

export type AgentLoopAutoUpgradeOutcome =
  | 'attempting'
  | 'succeeded'
  | 'failed'
  | 'no_change'

export interface AgentLoopAutoUpgradeRuntimeState {
  attemptCount: number
  successCount: number
  failureCount: number
  noChangeCount: number
  consecutiveFailureCount: number
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastOutcome: AgentLoopAutoUpgradeOutcome | null
  lastTargetVersion: string | null
  lastTargetRevision: string | null
  lastError: string | null
  pausedUntil: string | null
}

export type ManagedLeaseScope = 'issue-process' | 'pr-review' | 'pr-merge'
export type ManagedLeaseStatus = 'active' | 'completed' | 'recoverable' | 'released'
export type ManagedLeaseProgressKind = 'stdout' | 'stderr' | 'git-state' | 'phase'

export interface ManagedLease {
  leaseId: string
  scope: ManagedLeaseScope
  issueNumber?: number
  prNumber?: number
  machineId: string
  daemonInstanceId: string
  branch?: string
  worktreeId?: string
  phase: string
  startedAt: string
  lastHeartbeatAt: string
  expiresAt: string
  attempt: number
  lastProgressAt: string
  lastProgressKind?: ManagedLeaseProgressKind
  status: ManagedLeaseStatus
  recoveryReason?: string
}

export interface IssueComment {
  commentId: number
  body: string
  createdAt: string
  updatedAt: string
}

export interface ManagedLeaseComment extends IssueComment {
  lease: ManagedLease
}

export interface ActiveLeaseRuntimeDetail {
  scope: ManagedLeaseScope
  targetNumber: number
  commentId: number
  issueNumber: number | null
  prNumber: number | null
  machineId: string
  daemonInstanceId: string
  branch: string | null
  worktreeId: string | null
  phase: string
  attempt: number
  status: ManagedLeaseStatus
  lastProgressKind: ManagedLeaseProgressKind | null
  heartbeatAgeSeconds: number
  progressAgeSeconds: number
  expiresInSeconds: number
  adoptable: boolean
}

export interface StalledWorkerRuntimeDetail {
  scope: ManagedLeaseScope
  targetNumber: number
  since: string
  durationSeconds: number
  reason: string
}

export interface BlockedIssueResumeRuntimeDetail {
  issueNumber: number
  prNumber: number | null
  since: string
  durationSeconds: number
  reason: string
  escalationCount: number
  lastEscalatedAt: string | null
  lastEscalationAgeSeconds: number | null
}

export interface RecoveryActionRuntimeDetail {
  at: string
  kind: string
  outcome: 'recoverable' | 'completed' | 'blocked' | 'failed'
  scope: ManagedLeaseScope | null
  targetNumber: number | null
  reason: string | null
}

// ─── Claim Event (JSON in issue comment) ────────────────────────────────────

export interface ClaimEvent {
  event: 'claimed' | 'done' | 'failed' | 'stale' | 'stale-requeue' | 'failed-requeue'
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
  idlePollIntervalMs?: number
  concurrency: number
  requestedConcurrency: number
  concurrencyPolicy: ConcurrencyPolicy
  scheduling: AgentSchedulingConfig
  recovery: RecoveryConfig
  worktreesBase: string
  project: ProjectProfileConfig
  agent: {
    primary: 'claude' | 'codex'
    fallback: 'claude' | 'codex' | null
    claudePath: string
    codexPath: string
    codexBaseUrl?: string
    // Agent 执行超时（毫秒）
    timeoutMs: number
  }
  git: {
    defaultBranch: string
    authorName: string
    authorEmail: string
  }
  upgrade?: AgentLoopUpgradeConfig
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

export type DaemonRuntimeSupervisor = 'direct' | 'detached' | 'launchd'

export interface DaemonStatus {
  running: boolean
  machineId: string
  daemonInstanceId: string
  repo: string
  pollIntervalMs: number
  idlePollIntervalMs?: number
  concurrency: number
  requestedConcurrency: number
  concurrencyPolicy: ConcurrencyPolicy
  recovery: RecoveryConfig
  project: {
    profile: ProjectProfileName
    defaultBranch: string
    maxConcurrency: number | null
  }
  agent: {
    primary: AgentConfig['agent']['primary']
    fallback: AgentConfig['agent']['fallback']
  }
  agentLoop?: AgentLoopBuildMetadata
  upgrade?: AgentLoopUpgradeMetadata
  endpoints: {
    health: {
      host: string
      port: number
      path: string
    }
    metrics: {
      host: string
      port: number
      path: string
    }
  }
  runtime: {
    supervisor: DaemonRuntimeSupervisor
    workingDirectory: string
    runtimeRecordPath: string | null
    logPath: string | null
    activePrReviews: number
    inFlightIssueProcess: boolean
    inFlightPrReview: boolean
    startupRecoveryPending: boolean
    effectiveActiveTasks: number
    transientLoopErrorCount: number
    startupRecoveryDeferredCount: number
    lastTransientLoopErrorAt: string | null
    lastTransientLoopErrorKind: string | null
    lastTransientLoopErrorMessage: string | null
    lastTransientLoopErrorAgeSeconds: number | null
    failedIssueResumeAttemptsTracked: number
    failedIssueResumeCooldownsTracked: number
    oldestBlockedIssueResumeAgeSeconds: number
    activeLeaseCount: number
    oldestLeaseHeartbeatAgeSeconds: number
    activeLeaseDetails: ActiveLeaseRuntimeDetail[]
    stalledWorkerCount: number
    stalledWorkerDetails: StalledWorkerRuntimeDetail[]
    blockedIssueResumeCount: number
    blockedIssueResumeEscalationCount: number
    blockedIssueResumeDetails: BlockedIssueResumeRuntimeDetail[]
    lastRecoveryActionAt: string | null
    lastRecoveryActionKind: string | null
    recentRecoveryActions: RecoveryActionRuntimeDetail[]
    oldestBlockedIssueResumeEscalationAgeSeconds: number
    autoUpgrade?: AgentLoopAutoUpgradeRuntimeState | null
  }
  activeWorktrees: WorktreeInfo[]
  lastPollAt: string | null
  lastClaimedAt: string | null
  uptimeMs: number
  pid: number
  nextPollAt: string | null
  nextPollReason: string | null
  nextPollDelayMs: number | null
}
