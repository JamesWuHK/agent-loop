# Control Console Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the current `agent-loop` dashboard and runtime surfaces tell the truth about queue state by adding a shared build/version contract, a derived issue-state layer, and Phase 1 control-console summary/reporting updates.

**Architecture:** Keep GitHub as the only cross-machine source of truth. Add one new shared derived-state module and one daemon-side build-info module, then thread their outputs into health, presence, runtime records, status/doctor, metrics, and dashboard rendering. Do not introduce SQLite, do not change claim/resume/merge semantics, and do not merge daemon/dashboard into one process in this phase.

**Tech Stack:** TypeScript, Bun, Bun test, GitHub CLI-backed daemon runtime, existing dashboard renderer in `apps/agent-daemon/src/dashboard.ts`

---

## File Map

### New files

- `apps/agent-daemon/src/build-info.ts`
  - Resolve `agent-loop` runtime build metadata from `package.json` and Git.
  - Export a pure normalization helper for tests plus a runtime resolver used by the daemon.
- `apps/agent-daemon/src/build-info.test.ts`
  - Cover tag/package/dev build-source selection, short SHA generation, and dirty-tree handling.
- `packages/agent-shared/src/issue-dashboard-state.ts`
  - Centralize lifecycle-to-control-console mapping and derived issue-state calculation.
- `packages/agent-shared/src/issue-dashboard-state.test.ts`
  - Freeze runnable, dependency-blocked, contract-invalid, waiting-review, waiting-merge, human-needed, recoverable, and stalled cases.

### Modified files

- `packages/agent-shared/src/types.ts`
  - Add `AgentLoopBuildInfo`.
  - Extend `DaemonStatus` runtime payloads and any shared surface that needs version visibility.
- `apps/agent-daemon/src/background.ts`
  - Persist build info in local runtime records.
- `apps/agent-daemon/src/background.test.ts`
  - Cover new runtime-record shape while keeping legacy record parsing.
- `apps/agent-daemon/src/presence.ts`
  - Include build info in managed presence comments and parse old comments compatibly.
- `apps/agent-daemon/src/presence.test.ts`
  - Cover version-bearing presence comments and legacy no-version comments.
- `apps/agent-daemon/src/daemon.ts`
  - Replace hard-coded `0.1.0` health reporting with resolved build info.
- `apps/agent-daemon/src/status.ts`
  - Surface build info in status/doctor output.
  - Normalize `no_issues` and `no_runnable_issues`.
- `apps/agent-daemon/src/status.test.ts`
  - Freeze new status text, build-info rendering, and poll-label compatibility.
- `apps/agent-daemon/src/metrics.ts`
  - Rename poll outcome to `no_runnable_issues`.
- `apps/agent-daemon/src/metrics.test.ts`
  - Freeze new poll label.
- `apps/agent-daemon/src/claimer.ts`
  - Update operator-facing log copy from “claimable” wording to “runnable” wording where it describes empty runnable work.
- `apps/agent-daemon/src/dashboard.ts`
  - Thread build info into machine cards.
  - Replace “就绪” wording with “已入队”.
  - Show lifecycle state separately from derived state.
  - Expand summary counts to include runnable/blocking categories.
- `apps/agent-daemon/src/dashboard.test.ts`
  - Freeze summary counts, machine version chips, and Chinese copy.

### Existing files to consult while implementing

- `docs/superpowers/specs/2026-04-07-control-console-state-model-design.md`
- `packages/agent-shared/src/github-api.ts`
- `apps/agent-daemon/src/pr-reviewer.ts`

---

### Task 1: Add Shared Build Info Contract

**Files:**
- Create: `apps/agent-daemon/src/build-info.ts`
- Create: `apps/agent-daemon/src/build-info.test.ts`
- Modify: `packages/agent-shared/src/types.ts`

- [ ] **Step 1: Write the failing build-info tests**

```ts
import { describe, expect, test } from 'bun:test'
import { buildAgentLoopBuildInfo } from './build-info'

describe('build info', () => {
  test('prefers tag build source when a matching tag is present', () => {
    expect(buildAgentLoopBuildInfo({
      packageVersion: '0.1.0',
      gitCommit: '49fa8f3c8b14c4f84f2b3e44d31ad7b9d29b0abc',
      gitBranch: 'feat/control-console',
      gitTag: 'control-console-baseline-20260407',
      gitDirty: false,
    })).toEqual({
      version: '0.1.0',
      gitCommit: '49fa8f3c8b14c4f84f2b3e44d31ad7b9d29b0abc',
      gitCommitShort: '49fa8f3',
      gitBranch: 'feat/control-console',
      buildSource: 'tag',
      buildDirty: false,
    })
  })

  test('falls back to dev build source when no tag is present and the tree is dirty', () => {
    expect(buildAgentLoopBuildInfo({
      packageVersion: '0.1.0',
      gitCommit: 'a718d1e28fefd559ced57a1e0031b86be222b6d6',
      gitBranch: 'feat/control-console',
      gitTag: null,
      gitDirty: true,
    })).toEqual({
      version: '0.1.0',
      gitCommit: 'a718d1e28fefd559ced57a1e0031b86be222b6d6',
      gitCommitShort: 'a718d1e',
      gitBranch: 'feat/control-console',
      buildSource: 'dev',
      buildDirty: true,
    })
  })

  test('keeps package-only metadata when git data is unavailable', () => {
    expect(buildAgentLoopBuildInfo({
      packageVersion: '0.1.0',
      gitCommit: null,
      gitBranch: null,
      gitTag: null,
      gitDirty: null,
    })).toEqual({
      version: '0.1.0',
      gitCommit: null,
      gitCommitShort: null,
      gitBranch: null,
      buildSource: 'package',
      buildDirty: null,
    })
  })
})
```

- [ ] **Step 2: Run the new test file and verify it fails**

Run: `bun test apps/agent-daemon/src/build-info.test.ts`

Expected: FAIL because `./build-info` and `buildAgentLoopBuildInfo` do not exist yet.

- [ ] **Step 3: Add the shared build-info type and the daemon build-info resolver**

```ts
// packages/agent-shared/src/types.ts
export interface AgentLoopBuildInfo {
  version: string
  gitCommit: string | null
  gitCommitShort: string | null
  gitBranch: string | null
  buildSource: 'tag' | 'package' | 'dev'
  buildDirty: boolean | null
}
```

```ts
// apps/agent-daemon/src/build-info.ts
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AgentLoopBuildInfo } from '@agent/shared'

export function buildAgentLoopBuildInfo(input: {
  packageVersion: string
  gitCommit: string | null
  gitBranch: string | null
  gitTag: string | null
  gitDirty: boolean | null
}): AgentLoopBuildInfo {
  return {
    version: input.packageVersion,
    gitCommit: input.gitCommit,
    gitCommitShort: input.gitCommit ? input.gitCommit.slice(0, 7) : null,
    gitBranch: input.gitBranch,
    buildSource: input.gitTag ? 'tag' : input.gitCommit ? 'dev' : 'package',
    buildDirty: input.gitDirty,
  }
}

export function readPackageVersion(repoRoot: string): string {
  const path = resolve(repoRoot, 'package.json')
  if (!existsSync(path)) return '0.0.0-dev'
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { version?: unknown }
  return typeof parsed.version === 'string' && parsed.version.length > 0
    ? parsed.version
    : '0.0.0-dev'
}
```

- [ ] **Step 4: Run the build-info tests and verify they pass**

Run: `bun test apps/agent-daemon/src/build-info.test.ts`

Expected: PASS with 3 passing tests.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-shared/src/types.ts apps/agent-daemon/src/build-info.ts apps/agent-daemon/src/build-info.test.ts
git commit -m "feat(control-console): add agent-loop build info contract"
```

### Task 2: Thread Build Info Through Health, Presence, Runtime Records, and Status

**Files:**
- Modify: `packages/agent-shared/src/types.ts`
- Modify: `apps/agent-daemon/src/background.ts`
- Modify: `apps/agent-daemon/src/background.test.ts`
- Modify: `apps/agent-daemon/src/presence.ts`
- Modify: `apps/agent-daemon/src/presence.test.ts`
- Modify: `apps/agent-daemon/src/daemon.ts`
- Modify: `apps/agent-daemon/src/status.ts`
- Modify: `apps/agent-daemon/src/status.test.ts`

- [ ] **Step 1: Write the failing compatibility tests for runtime records and presence comments**

```ts
// apps/agent-daemon/src/background.test.ts
test('reads runtime records with build info', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-loop-background-build-test-'))
  const path = join(dir, 'runtime.json')
  writeFileSync(path, JSON.stringify({
    repo: 'JamesWuHK/digital-employee',
    machineId: 'codex-verify-20260405',
    healthPort: 9311,
    supervisor: 'launchd',
    pid: 12345,
    metricsPort: 9091,
    cwd: '/tmp/workdir',
    startedAt: '2026-04-05T02:00:00.000Z',
    command: ['bun', 'apps/agent-daemon/src/index.ts'],
    logPath: '/tmp/daemon.log',
    buildInfo: {
      version: '0.1.0',
      gitCommit: '49fa8f3c8b14c4f84f2b3e44d31ad7b9d29b0abc',
      gitCommitShort: '49fa8f3',
      gitBranch: 'feat/control-console',
      buildSource: 'dev',
      buildDirty: false,
    },
  }))

  expect(readBackgroundRuntimeRecord(path)?.buildInfo?.gitCommitShort).toBe('49fa8f3')
})
```

```ts
// apps/agent-daemon/src/presence.test.ts
test('keeps parsing legacy presence comments that do not include build info', () => {
  const legacyBody = `<!-- agent-loop:presence {"repo":"JamesWuHK/digital-employee","machineId":"machine-a","daemonInstanceId":"daemon-a","status":"idle","startedAt":"2026-04-05T08:00:00.000Z","lastHeartbeatAt":"2026-04-05T08:00:30.000Z","expiresAt":"2026-04-05T08:02:00.000Z","healthPort":9312,"metricsPort":9092,"activeLeaseCount":0,"activeWorktreeCount":0,"effectiveActiveTasks":0} -->
## Managed daemon presence`

  expect(extractManagedDaemonPresenceComment(legacyBody)).toMatchObject({
    machineId: 'machine-a',
    buildInfo: null,
  })
})
```

```ts
// apps/agent-daemon/src/status.test.ts
expect(report).toContain('daemon: running v0.1.0 (agent-loop-daemon)')
expect(report).toContain('build: 0.1.0 49fa8f3 feat/control-console')
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `bun test apps/agent-daemon/src/background.test.ts apps/agent-daemon/src/presence.test.ts apps/agent-daemon/src/status.test.ts`

Expected: FAIL because `buildInfo` is not part of the runtime record, presence parser, or status output yet.

- [ ] **Step 3: Add build-info fields to the shared payloads and thread them through the daemon**

```ts
// packages/agent-shared/src/types.ts
export interface DaemonStatus {
  running: boolean
  machineId: string
  daemonInstanceId: string
  repo: string
  pollIntervalMs: number
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
  endpoints: {
    health: { host: string; port: number; path: string }
    metrics: { host: string; port: number; path: string }
  }
  runtime: {
    supervisor: DaemonRuntimeSupervisor
    workingDirectory: string
    runtimeRecordPath: string | null
    logPath: string | null
    effectiveActiveTasks: number
    activeLeaseCount: number
    activeLeaseDetails: ActiveLeaseRuntimeDetail[]
    stalledWorkerCount: number
    blockedIssueResumeCount: number
  }
  activeWorktrees: WorktreeInfo[]
  lastPollAt: string | null
  lastClaimedAt: string | null
  uptimeMs: number
  pid: number
  nextPollAt: string | null
  nextPollReason: string | null
  nextPollDelayMs: number | null
  build: AgentLoopBuildInfo
}
```

```ts
// apps/agent-daemon/src/background.ts
export interface BackgroundRuntimeRecord extends BackgroundRuntimeIdentity {
  supervisor: ManagedDaemonRuntimeSupervisor
  pid: number
  metricsPort: number
  cwd: string
  startedAt: string
  command: string[]
  logPath: string
  buildInfo: AgentLoopBuildInfo | null
}
```

```ts
// apps/agent-daemon/src/presence.ts
export interface ManagedDaemonPresence {
  repo: string
  machineId: string
  daemonInstanceId: string
  status: ManagedDaemonPresenceStatus
  startedAt: string
  lastHeartbeatAt: string
  expiresAt: string
  healthPort: number
  metricsPort: number
  activeLeaseCount: number
  activeWorktreeCount: number
  effectiveActiveTasks: number
  buildInfo: AgentLoopBuildInfo | null
}
```

```ts
// apps/agent-daemon/src/daemon.ts
return Response.json({
  status: this.running ? 'running' : 'stopped',
  mode: 'agent-loop-daemon',
  version: this.buildInfo.version,
  build: this.buildInfo,
  ...this.getStatus(),
})
```

```ts
// apps/agent-daemon/src/status.ts
const lines = [
  `daemon: ${health.status} v${health.version} (${health.mode})`,
  `build: ${health.build.version} ${health.build.gitCommitShort ?? 'no-commit'} ${health.build.gitBranch ?? 'no-branch'}${health.build.buildDirty ? ' dirty' : ''}`,
  `repo: ${health.repo}`,
  `machine: ${health.machineId}`,
  `daemon instance: ${health.daemonInstanceId}`,
]
```

- [ ] **Step 4: Make dashboard machine models carry version data**

```ts
// apps/agent-daemon/src/dashboard.ts
export interface DashboardLocalRuntimeView {
  runtimeKey: string
  supervisor: BackgroundRuntimeSnapshot['record']['supervisor']
  alive: boolean
  pid: number
  cwd: string
  recordPath: string
  logPath: string
  startedAt: string
  healthPort: number
  metricsPort: number
  buildInfo: AgentLoopBuildInfo | null
}

export interface DashboardPresenceView {
  repo: string
  machineId: string
  daemonInstanceId: string
  status: 'idle' | 'busy' | 'stopped'
  startedAt: string
  lastHeartbeatAt: string
  expiresAt: string
  heartbeatAgeSeconds: number | null
  expiresInSeconds: number | null
  healthPort: number
  metricsPort: number
  activeLeaseCount: number
  activeWorktreeCount: number
  effectiveActiveTasks: number
  buildInfo: AgentLoopBuildInfo | null
  source: 'github'
}
```

- [ ] **Step 5: Run the focused tests and verify they pass**

Run: `bun test apps/agent-daemon/src/background.test.ts apps/agent-daemon/src/presence.test.ts apps/agent-daemon/src/status.test.ts apps/agent-daemon/src/dashboard.test.ts`

Expected: PASS with runtime-record, presence, status, and dashboard tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-shared/src/types.ts apps/agent-daemon/src/background.ts apps/agent-daemon/src/background.test.ts apps/agent-daemon/src/presence.ts apps/agent-daemon/src/presence.test.ts apps/agent-daemon/src/daemon.ts apps/agent-daemon/src/status.ts apps/agent-daemon/src/status.test.ts apps/agent-daemon/src/dashboard.ts apps/agent-daemon/src/dashboard.test.ts
git commit -m "feat(control-console): surface agent-loop build metadata"
```

### Task 3: Add Shared Derived Issue-State Calculation

**Files:**
- Create: `packages/agent-shared/src/issue-dashboard-state.ts`
- Create: `packages/agent-shared/src/issue-dashboard-state.test.ts`
- Modify: `packages/agent-shared/src/types.ts`

- [ ] **Step 1: Write the failing derived-state tests**

```ts
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
```

- [ ] **Step 2: Run the new shared-state test file and verify it fails**

Run: `bun test packages/agent-shared/src/issue-dashboard-state.test.ts`

Expected: FAIL because the module does not exist yet.

- [ ] **Step 3: Add the shared lifecycle/derived-state helper**

```ts
// packages/agent-shared/src/issue-dashboard-state.ts
export type DashboardIssueLifecycleState = 'untracked' | 'queued' | 'working' | 'failed' | 'done' | 'recovering'
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
    state: 'ready' | 'claimed' | 'working' | 'done' | 'failed' | 'stale' | 'unknown'
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
  if (input.issue.state === 'unknown') return { lifecycleState: 'untracked', derivedState: 'idle', reasonSummary: '尚未进入 agent-loop 队列' }
  if (input.issue.state === 'done') return { lifecycleState: 'done', derivedState: 'idle', reasonSummary: '已完成并退出队列' }
  if (input.issue.state === 'failed') return { lifecycleState: 'failed', derivedState: 'recoverable', reasonSummary: '失败后待自动恢复或重排' }
  if (input.issue.state === 'stale') return { lifecycleState: 'recovering', derivedState: 'recoverable', reasonSummary: '处于待恢复状态' }
  if (input.issue.state === 'working' && input.activeLeaseProgressStale) {
    return { lifecycleState: 'working', derivedState: 'stalled', reasonSummary: '执行中的租约长时间没有进展' }
  }
  if (input.hasHumanNeededPr) return { lifecycleState: 'queued', derivedState: 'human_needed', reasonSummary: '关联 PR 需要人工处理' }
  if (input.hasReviewApprovedPr) return { lifecycleState: 'queued', derivedState: 'waiting_merge', reasonSummary: '评审已通过，等待自动合并' }
  if (input.issue.linkedPrNumbers.length > 0) return { lifecycleState: 'queued', derivedState: 'waiting_review', reasonSummary: '已有开放 PR，等待 review' }
  if (!input.issue.hasExecutableContract) return { lifecycleState: 'queued', derivedState: 'contract_invalid', reasonSummary: 'Issue 合同不完整，暂不可执行' }
  if (input.issue.claimBlockedBy.length > 0) return { lifecycleState: 'queued', derivedState: 'dependency_blocked', reasonSummary: `依赖 issue 未完成：#${input.issue.claimBlockedBy.join(', #')}` }
  if (input.issue.isClaimable) return { lifecycleState: 'queued', derivedState: 'runnable', reasonSummary: '当前可认领并可开始执行' }
  return { lifecycleState: 'queued', derivedState: 'idle', reasonSummary: '已入队，等待下一轮调度判断' }
}
```

- [ ] **Step 4: Run the shared derived-state tests and verify they pass**

Run: `bun test packages/agent-shared/src/issue-dashboard-state.test.ts`

Expected: PASS with runnable, dependency-blocked, contract-invalid, waiting-review, waiting-merge, human-needed, recoverable, and stalled cases green.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-shared/src/types.ts packages/agent-shared/src/issue-dashboard-state.ts packages/agent-shared/src/issue-dashboard-state.test.ts
git commit -m "feat(control-console): add derived issue dashboard states"
```

### Task 4: Update Dashboard Summary, Machine Cards, and Issue Table Copy

**Files:**
- Modify: `apps/agent-daemon/src/dashboard.ts`
- Modify: `apps/agent-daemon/src/dashboard.test.ts`

- [ ] **Step 1: Write the failing dashboard tests for new summary counts and Chinese labels**

```ts
expect(buildDashboardSummary(machines, issues, prs)).toEqual({
  machineCount: 1,
  localRuntimeCount: 1,
  activeLeaseCount: 2,
  openIssueCount: 5,
  queuedIssueCount: 3,
  runnableIssueCount: 1,
  dependencyBlockedIssueCount: 0,
  contractInvalidIssueCount: 0,
  waitingReviewIssueCount: 0,
  waitingMergeIssueCount: 1,
  humanNeededIssueCount: 1,
  workingIssueCount: 1,
  failedIssueCount: 1,
  openPrCount: 2,
})
```

```ts
expect(script).toContain('Open')
expect(script).toContain('已入队 Issue')
expect(script).toContain('可运行 Issue')
expect(script).toContain('依赖阻塞')
expect(script).toContain('合同无效')
expect(script).toContain('等待评审')
expect(script).toContain('等待合并')
expect(script).toContain('需要人工')
expect(script).toContain('生命周期')
expect(script).toContain('当前状态')
expect(script).toContain('原因')
expect(script).toContain('v0.1.0')
```

- [ ] **Step 2: Run the dashboard test file and verify it fails**

Run: `bun test apps/agent-daemon/src/dashboard.test.ts`

Expected: FAIL because the summary type, render copy, and machine-card version chips are not implemented yet.

- [ ] **Step 3: Expand the dashboard view model and rendering**

```ts
// apps/agent-daemon/src/dashboard.ts
export interface DashboardSummary {
  machineCount: number
  localRuntimeCount: number
  activeLeaseCount: number
  openIssueCount: number
  queuedIssueCount: number
  runnableIssueCount: number
  dependencyBlockedIssueCount: number
  contractInvalidIssueCount: number
  waitingReviewIssueCount: number
  waitingMergeIssueCount: number
  humanNeededIssueCount: number
  workingIssueCount: number
  failedIssueCount: number
  openPrCount: number
}
```

```ts
// apps/agent-daemon/src/dashboard.ts
export interface DashboardIssueView {
  number: number
  title: string
  url: string
  state: AgentIssue['state']
  labels: string[]
  assignee: string | null
  isClaimable: boolean
  updatedAt: string
  dependencyIssueNumbers: number[]
  claimBlockedBy: number[]
  hasExecutableContract: boolean
  contractValidationErrors: string[]
  linkedPrNumbers: number[]
  activeLease: DashboardLeaseView | null
  lifecycleStateLabel: string
  derivedState: DashboardIssueDerivedState
  derivedStateLabel: string
  reasonSummary: string
}
```

```ts
// apps/agent-daemon/src/dashboard.ts
function localizeDerivedIssueState(state: DashboardIssueDerivedState) {
  switch (state) {
    case 'runnable':
      return '可运行'
    case 'dependency_blocked':
      return '依赖阻塞'
    case 'contract_invalid':
      return '合同无效'
    case 'waiting_review':
      return '等待评审'
    case 'waiting_merge':
      return '等待合并'
    case 'human_needed':
      return '需要人工'
    case 'recoverable':
      return '可恢复'
    case 'stalled':
      return '执行卡住'
    default:
      return '已入队'
  }
}
```

```ts
// apps/agent-daemon/src/dashboard.ts
function localizeIssueState(state) {
  switch (state) {
    case 'ready':
      return '已入队'
    case 'working':
      return '执行中'
    case 'claimed':
      return '已认领'
    case 'failed':
      return '失败'
    case 'stale':
      return '待恢复'
    case 'done':
      return '完成'
    case 'unknown':
      return '未入队'
    default:
      return state || '未知'
  }
}
```

```ts
// apps/agent-daemon/src/dashboard.ts
const derived = deriveDashboardIssueState({
  issue,
  hasReviewApprovedPr,
  hasHumanNeededPr,
  activeLeaseProgressStale,
})

return {
  ...issue,
  lifecycleStateLabel: localizeIssueState(issue.state),
  derivedState: derived.derivedState,
  derivedStateLabel: localizeDerivedIssueState(derived.derivedState),
  reasonSummary: derived.reasonSummary,
}
```

```ts
// apps/agent-daemon/src/dashboard.ts
const stats = [
  { label: '机器数', value: snapshot.summary.machineCount, tone: 'accent' },
  { label: '本地运行时', value: snapshot.summary.localRuntimeCount, tone: '' },
  { label: '活跃租约', value: snapshot.summary.activeLeaseCount, tone: 'gold' },
  { label: 'Open', value: snapshot.summary.openIssueCount, tone: '' },
  { label: '已入队 Issue', value: snapshot.summary.queuedIssueCount, tone: '' },
  { label: '可运行 Issue', value: snapshot.summary.runnableIssueCount, tone: snapshot.summary.runnableIssueCount > 0 ? 'accent' : '' },
  { label: '依赖阻塞', value: snapshot.summary.dependencyBlockedIssueCount, tone: snapshot.summary.dependencyBlockedIssueCount > 0 ? 'gold' : '' },
  { label: '合同无效', value: snapshot.summary.contractInvalidIssueCount, tone: snapshot.summary.contractInvalidIssueCount > 0 ? 'error' : '' },
  { label: '等待评审', value: snapshot.summary.waitingReviewIssueCount, tone: '' },
  { label: '等待合并', value: snapshot.summary.waitingMergeIssueCount, tone: '' },
  { label: '需要人工', value: snapshot.summary.humanNeededIssueCount, tone: snapshot.summary.humanNeededIssueCount > 0 ? 'error' : '' },
  { label: '执行中 Issue', value: snapshot.summary.workingIssueCount, tone: 'accent' },
  { label: '失败 Issue', value: snapshot.summary.failedIssueCount, tone: snapshot.summary.failedIssueCount > 0 ? 'gold' : '' },
  { label: '开放 PR', value: snapshot.summary.openPrCount, tone: '' },
]
```

```ts
// apps/agent-daemon/src/dashboard.ts
'<th>生命周期</th>' +
'<th>当前状态</th>' +
'<th>原因</th>' +
```

```ts
// apps/agent-daemon/src/dashboard.ts
'<td>' + escapeHtml(issue.lifecycleStateLabel) + '</td>' +
'<td>' + escapeHtml(issue.derivedStateLabel) + '</td>' +
'<td>' + escapeHtml(issue.reasonSummary) + '</td>' +
```

- [ ] **Step 4: Add version chips to the machine card**

```ts
// apps/agent-daemon/src/dashboard.ts
const versionChips = [
  machine.localRuntimes[0]?.buildInfo?.version ? renderChip(`v${machine.localRuntimes[0].buildInfo.version}`, 'gold') : '',
  machine.localRuntimes[0]?.buildInfo?.gitCommitShort ? renderChip(machine.localRuntimes[0].buildInfo.gitCommitShort, '') : '',
  machine.localRuntimes[0]?.buildInfo?.buildDirty ? renderChip('dirty', 'error') : '',
].join('')
```

```ts
// apps/agent-daemon/src/dashboard.ts
'<div class="chip-row">' +
renderChip(localizeMachineSource(machine.source), machine.source === 'mixed' ? 'accent' : machine.source === 'local' ? 'gold' : '') +
(machine.presence ? renderChip(localizePresenceStatus(machine.presence.status), machine.presence.status === 'busy' ? 'accent' : 'gold') : '') +
versionChips +
machine.daemonInstanceIds.map((daemonId) => renderChip(shortDaemonId(daemonId), '')).join('') +
'</div>'
```

- [ ] **Step 5: Run the dashboard tests and verify they pass**

Run: `bun test apps/agent-daemon/src/dashboard.test.ts`

Expected: PASS with Open/已入队/可运行 split counts, contract-invalid counts, machine version chips, and issue lifecycle/current-state/reason columns rendered in Chinese.

- [ ] **Step 6: Commit**

```bash
git add apps/agent-daemon/src/dashboard.ts apps/agent-daemon/src/dashboard.test.ts
git commit -m "feat(control-console): upgrade dashboard phase-1 summary"
```

### Task 5: Rename Empty-Poll Metrics to `no_runnable_issues` With Compatibility Parsing

**Files:**
- Modify: `apps/agent-daemon/src/metrics.ts`
- Modify: `apps/agent-daemon/src/metrics.test.ts`
- Modify: `apps/agent-daemon/src/status.ts`
- Modify: `apps/agent-daemon/src/status.test.ts`
- Modify: `apps/agent-daemon/src/claimer.ts`

- [ ] **Step 1: Write the failing metric/status tests**

```ts
// apps/agent-daemon/src/metrics.test.ts
test('records the no_runnable_issues poll outcome', async () => {
  recordPoll('no_runnable_issues')
  const metrics = await getMetrics()
  expect(metrics).toContain('result="no_runnable_issues"')
})
```

```ts
// apps/agent-daemon/src/status.test.ts
const metricsText = `
agent_loop_polls_total{result="success"} 12
agent_loop_polls_total{result="skipped_concurrency"} 3
agent_loop_polls_total{result="no_issues"} 2
agent_loop_polls_total{result="no_runnable_issues"} 4
agent_loop_polls_total{result="error"} 1
`

expect(summarizeDaemonMetrics(metricsText).polls).toEqual({
  success: 12,
  skipped_concurrency: 3,
  no_runnable_issues: 6,
  error: 1,
})
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `bun test apps/agent-daemon/src/metrics.test.ts apps/agent-daemon/src/status.test.ts`

Expected: FAIL because `recordPoll()` does not accept `no_runnable_issues` and `summarizeDaemonMetrics()` does not normalize the legacy label.

- [ ] **Step 3: Rename the metric label and normalize legacy reads**

```ts
// apps/agent-daemon/src/metrics.ts
export function recordPoll(result: 'success' | 'skipped_concurrency' | 'no_runnable_issues' | 'error'): void {
  pollsTotal.inc({ result })
}
```

```ts
// apps/agent-daemon/src/status.ts
const POLL_OUTCOME_ORDER = ['success', 'skipped_concurrency', 'no_runnable_issues', 'error'] as const
```

```ts
// apps/agent-daemon/src/status.ts
case 'agent_loop_polls_total': {
  const rawResult = sample.labels.result
  if (!rawResult) break
  const normalizedResult = rawResult === 'no_issues' ? 'no_runnable_issues' : rawResult
  summary.polls[normalizedResult] = (summary.polls[normalizedResult] ?? 0) + sample.value
  break
}
```

```ts
// apps/agent-daemon/src/claimer.ts
if (issues.length === 0) {
  logger.log('[claimer] no runnable issues found')
  return null
}
```

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `bun test apps/agent-daemon/src/metrics.test.ts apps/agent-daemon/src/status.test.ts`

Expected: PASS with legacy + new poll labels collapsing into `no_runnable_issues`.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-daemon/src/metrics.ts apps/agent-daemon/src/metrics.test.ts apps/agent-daemon/src/status.ts apps/agent-daemon/src/status.test.ts apps/agent-daemon/src/claimer.ts
git commit -m "feat(control-console): rename empty poll outcome to no runnable issues"
```

### Task 6: Full Phase 1 Verification Sweep

**Files:**
- Modify: none
- Test: `apps/agent-daemon/src/build-info.test.ts`
- Test: `apps/agent-daemon/src/background.test.ts`
- Test: `apps/agent-daemon/src/presence.test.ts`
- Test: `packages/agent-shared/src/issue-dashboard-state.test.ts`
- Test: `apps/agent-daemon/src/dashboard.test.ts`
- Test: `apps/agent-daemon/src/status.test.ts`
- Test: `apps/agent-daemon/src/metrics.test.ts`

- [ ] **Step 1: Run the focused Phase 1 test set**

Run:

```bash
bun test \
  apps/agent-daemon/src/build-info.test.ts \
  apps/agent-daemon/src/background.test.ts \
  apps/agent-daemon/src/presence.test.ts \
  packages/agent-shared/src/issue-dashboard-state.test.ts \
  apps/agent-daemon/src/dashboard.test.ts \
  apps/agent-daemon/src/status.test.ts \
  apps/agent-daemon/src/metrics.test.ts
```

Expected: PASS across all focused files.

- [ ] **Step 2: Run the broader daemon suite for regression coverage**

Run: `bun test apps/agent-daemon/src`

Expected: PASS with no new failures in dashboard/status/runtime/recovery-related tests.

- [ ] **Step 3: Run the repo-wide suite before asking for review**

Run: `bun test`

Expected: PASS, or a clearly documented pre-existing unrelated failure if the suite is already red before the branch work starts.

- [ ] **Step 4: Inspect the diff for scope**

Run: `git diff --stat origin/master...HEAD`

Expected: only the planned shared/daemon/dashboard/status/runtime files plus the new plan/spec docs if they are intentionally left in scope.

- [ ] **Step 5: Commit any final test-fix adjustments**

```bash
git add .
git commit -m "test(control-console): verify phase 1 control-console surfaces"
```

---

## Self-Review Checklist

- Spec coverage:
  - State model and derived states: Task 3
  - Dashboard summary, Open/已入队/可运行 split, and issue table state copy: Task 4
  - Version visibility in health/presence/runtime/dashboard/status: Tasks 1 and 2
  - `no_runnable_issues` metric semantics: Task 5
- Placeholder scan:
  - No `TODO`, `TBD`, or “implement later” placeholders remain.
- Type consistency:
  - `AgentLoopBuildInfo` is the only build-info contract.
  - `queued` is only a control-console lifecycle label in derived state, not a replacement GitHub label in this phase.
  - `no_runnable_issues` is the only new poll label written; `no_issues` remains read-only compatibility logic.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-07-control-console-phase-1.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
