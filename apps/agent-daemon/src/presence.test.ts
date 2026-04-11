import { describe, expect, test } from 'bun:test'
import type { AgentConfig, IssueComment } from '@agent/shared'
import {
  buildManagedDaemonPresenceComment,
  buildManagedDaemonUpgradeAnnouncementComment,
  extractManagedDaemonPresenceIssueNumber,
  extractManagedDaemonPresenceComment,
  extractManagedDaemonUpgradeAnnouncementComment,
  getLatestManagedDaemonUpgradeAnnouncement,
  listActiveManagedDaemonPresenceComments,
  ManagedDaemonPresencePublisher,
  type ManagedDaemonPresence,
  type PresenceApiAdapter,
} from './presence'

const TEST_CONFIG: AgentConfig = {
  machineId: 'machine-a',
  repo: 'JamesWuHK/digital-employee',
  pat: 'ghp_test',
  pollIntervalMs: 60_000,
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
    leaseTtlMs: 60_000,
    workerIdleTimeoutMs: 300_000,
    leaseAdoptionBackoffMs: 5_000,
    leaseNoProgressTimeoutMs: 360_000,
  },
  worktreesBase: '/tmp/agent-loop-test',
  project: {
    profile: 'generic',
  },
  agent: {
    primary: 'codex',
    fallback: null,
    claudePath: 'claude',
    codexPath: 'codex',
    timeoutMs: 60_000,
  },
  git: {
    defaultBranch: 'main',
    authorName: 'agent-loop',
    authorEmail: 'agent-loop@local',
  },
}

function buildPresence(overrides: Partial<ManagedDaemonPresence> = {}): ManagedDaemonPresence {
  return {
    repo: 'JamesWuHK/digital-employee',
    machineId: 'machine-a',
    daemonInstanceId: 'daemon-a',
    status: 'idle',
    startedAt: '2026-04-05T08:00:00.000Z',
    lastHeartbeatAt: '2026-04-05T08:00:30.000Z',
    expiresAt: '2026-04-05T08:02:00.000Z',
    healthPort: 9312,
    metricsPort: 9092,
    activeLeaseCount: 0,
    activeWorktreeCount: 0,
    effectiveActiveTasks: 0,
    agentLoopVersion: '0.1.0',
    agentLoopRevision: 'abcdef1234567890',
    upgradeStatus: 'up-to-date',
    upgradeAutoApplyEnabled: true,
    safeToUpgradeNow: true,
    latestVersion: '0.1.0',
    latestRevision: 'abcdef1234567890',
    upgradeCheckedAt: '2026-04-05T08:00:20.000Z',
    upgradeMessage: 'local and latest versions match',
    autoUpgrade: {
      attemptCount: 1,
      successCount: 1,
      failureCount: 0,
      noChangeCount: 0,
      lastAttemptAt: '2026-04-05T08:00:10.000Z',
      lastSuccessAt: '2026-04-05T08:00:12.000Z',
      lastOutcome: 'succeeded',
      lastTargetVersion: '0.1.0',
      lastTargetRevision: 'abcdef1234567890',
      lastError: null,
    },
    ...overrides,
  }
}

function buildComment(commentId: number, presence: ManagedDaemonPresence): IssueComment {
  return {
    commentId,
    body: buildManagedDaemonPresenceComment(presence),
    createdAt: presence.startedAt,
    updatedAt: presence.lastHeartbeatAt,
  }
}

function createFakePresenceApi(initialComments: IssueComment[] = []): {
  api: PresenceApiAdapter
  comments: IssueComment[]
} {
  const comments = [...initialComments]
  let nextCommentId = Math.max(0, ...comments.map((comment) => comment.commentId)) + 1

  const api: PresenceApiAdapter = {
    async ensurePresenceIssue() {
      return 500
    },
    async listIssueComments() {
      return comments.map((comment) => ({ ...comment }))
    },
    async commentOnIssue(_issueNumber, body) {
      const created: IssueComment = {
        commentId: nextCommentId++,
        body,
        createdAt: '2026-04-05T08:00:00.000Z',
        updatedAt: '2026-04-05T08:00:00.000Z',
      }
      comments.push(created)
      return { ...created }
    },
    async updateIssueComment(commentId, body) {
      const index = comments.findIndex((comment) => comment.commentId === commentId)
      const updated: IssueComment = {
        commentId,
        body,
        createdAt: comments[index]?.createdAt ?? '2026-04-05T08:00:00.000Z',
        updatedAt: '2026-04-05T08:00:30.000Z',
      }
      if (index >= 0) {
        comments[index] = updated
      } else {
        comments.push(updated)
      }
      return { ...updated }
    },
  }

  return { api, comments }
}

describe('managed daemon presence helpers', () => {
  test('round-trips managed daemon presence comments', () => {
    const presence = buildPresence()
    const body = buildManagedDaemonPresenceComment(presence)

    expect(extractManagedDaemonPresenceComment(body)).toEqual(presence)
    expect(body).toContain('"autoUpgrade":{')
    expect(body).toContain('Auto-upgrade outcome: succeeded')
  })

  test('round-trips managed daemon upgrade announcement comments and picks the newest one', () => {
    const older = {
      repo: TEST_CONFIG.repo,
      channel: 'master',
      latestVersion: '0.1.1',
      latestRevision: '1111111111111111111111111111111111111111',
      latestCommitAt: '2026-04-11T09:00:00.000Z',
      announcedAt: '2026-04-11T09:00:10.000Z',
      announcedByMachineId: 'machine-a',
      announcedByDaemonInstanceId: 'daemon-a',
    }
    const newer = {
      ...older,
      latestVersion: '0.1.2',
      latestRevision: '2222222222222222222222222222222222222222',
      latestCommitAt: '2026-04-11T09:10:00.000Z',
      announcedAt: '2026-04-11T09:10:10.000Z',
      announcedByMachineId: 'machine-b',
      announcedByDaemonInstanceId: 'daemon-b',
    }

    expect(extractManagedDaemonUpgradeAnnouncementComment(
      buildManagedDaemonUpgradeAnnouncementComment(newer),
    )).toEqual(newer)

    const latest = getLatestManagedDaemonUpgradeAnnouncement([
      {
        commentId: 11,
        body: buildManagedDaemonUpgradeAnnouncementComment(older),
        createdAt: older.announcedAt,
        updatedAt: older.announcedAt,
      },
      {
        commentId: 12,
        body: buildManagedDaemonUpgradeAnnouncementComment(newer),
        createdAt: newer.announcedAt,
        updatedAt: newer.announcedAt,
      },
    ], TEST_CONFIG.repo)

    expect(latest?.announcement.latestRevision).toBe(newer.latestRevision)
  })

  test('filters active managed daemon presence comments by repo and expiry', () => {
    const comments = [
      buildComment(11, buildPresence({
        machineId: 'machine-a',
        lastHeartbeatAt: '2026-04-05T08:00:30.000Z',
        expiresAt: '2026-04-05T08:02:00.000Z',
      })),
      buildComment(12, buildPresence({
        machineId: 'machine-b',
        status: 'stopped',
      })),
      buildComment(13, buildPresence({
        repo: 'JamesWuHK/another-repo',
      })),
      buildComment(14, buildPresence({
        machineId: 'machine-c',
        expiresAt: '2026-04-05T08:00:10.000Z',
      })),
    ]

    const active = listActiveManagedDaemonPresenceComments(
      comments,
      'JamesWuHK/digital-employee',
      Date.parse('2026-04-05T08:01:00.000Z'),
    )

    expect(active).toHaveLength(1)
    expect(active[0]?.presence.machineId).toBe('machine-a')
  })

  test('finds the managed presence registry issue from REST issue pages', () => {
    expect(extractManagedDaemonPresenceIssueNumber([
      {
        number: 41,
        title: 'Unrelated issue',
        body: 'no marker here',
      },
      {
        number: 42,
        title: 'Agent Loop Presence',
        body: 'registry body',
      },
    ])).toBe(42)

    expect(extractManagedDaemonPresenceIssueNumber([
      {
        number: 43,
        title: 'Agent Loop Presence',
        body: 'registry body',
        pull_request: {},
      },
      {
        number: 44,
        title: 'Infra',
        body: '<!-- agent-loop:presence-registry -->',
      },
    ])).toBe(44)
  })
})

describe('managed daemon presence publisher', () => {
  test('publishes idle, busy, and stopped presence updates through the injected API', async () => {
    const { api, comments } = createFakePresenceApi()
    const runtime: ManagedDaemonPresence = {
      repo: TEST_CONFIG.repo,
      machineId: TEST_CONFIG.machineId,
      daemonInstanceId: 'daemon-a',
      status: 'idle',
      startedAt: '2026-04-05T08:00:00.000Z',
      lastHeartbeatAt: '2026-04-05T08:00:00.000Z',
      expiresAt: '2026-04-05T08:02:00.000Z',
      healthPort: 9312,
      metricsPort: 9092,
      activeLeaseCount: 0,
      activeWorktreeCount: 0,
      effectiveActiveTasks: 0,
      agentLoopVersion: '0.1.0',
      agentLoopRevision: 'abcdef1234567890',
      upgradeStatus: 'up-to-date',
      upgradeAutoApplyEnabled: true,
      safeToUpgradeNow: true,
      latestVersion: '0.1.0',
      latestRevision: 'abcdef1234567890',
      upgradeCheckedAt: '2026-04-05T08:00:20.000Z',
      upgradeMessage: 'local and latest versions match',
      autoUpgrade: {
        attemptCount: 1,
        successCount: 1,
        failureCount: 0,
        noChangeCount: 0,
        lastAttemptAt: '2026-04-05T08:00:10.000Z',
        lastSuccessAt: '2026-04-05T08:00:12.000Z',
        lastOutcome: 'succeeded',
        lastTargetVersion: '0.1.0',
        lastTargetRevision: 'abcdef1234567890',
        lastError: null,
      },
    }

    const publisher = new ManagedDaemonPresencePublisher({
      config: TEST_CONFIG,
      daemonInstanceId: 'daemon-a',
      healthPort: 9312,
      metricsPort: 9092,
      api,
      readRuntimeState: () => runtime,
    })

    await publisher.start()
    expect(comments).toHaveLength(1)
    expect(comments[0]?.body).toContain('"status":"idle"')

    runtime.activeLeaseCount = 1
    runtime.activeWorktreeCount = 1
    runtime.effectiveActiveTasks = 1
    runtime.upgradeStatus = 'upgrade-available'
    runtime.upgradeAutoApplyEnabled = false
    runtime.safeToUpgradeNow = false
    runtime.latestVersion = '0.1.1'
    runtime.latestRevision = 'fedcba9876543210'
    runtime.upgradeMessage = 'channel master is newer: local v0.1.0, latest v0.1.1'
    runtime.autoUpgrade = {
      attemptCount: 2,
      successCount: 1,
      failureCount: 1,
      noChangeCount: 0,
      lastAttemptAt: '2026-04-05T08:00:40.000Z',
      lastSuccessAt: '2026-04-05T08:00:12.000Z',
      lastOutcome: 'failed',
      lastTargetVersion: '0.1.1',
      lastTargetRevision: 'fedcba9876543210',
      lastError: 'git pull failed',
    }

    await publisher.flushHeartbeat()
    expect(comments).toHaveLength(1)
    expect(comments[0]?.body).toContain('"status":"busy"')
    expect(comments[0]?.body).toContain('"activeLeaseCount":1')
    expect(comments[0]?.body).toContain('"upgradeStatus":"upgrade-available"')
    expect(comments[0]?.body).toContain('"upgradeAutoApplyEnabled":false')
    expect(comments[0]?.body).toContain('"safeToUpgradeNow":false')
    expect(comments[0]?.body).toContain('"upgradeMessage":"channel master is newer: local v0.1.0, latest v0.1.1"')
    expect(comments[0]?.body).toContain('"lastOutcome":"failed"')
    expect(comments[0]?.body).toContain('Auto-upgrade last error: git pull failed')

    await publisher.stop()
    expect(comments[0]?.body).toContain('"status":"stopped"')
  })
})
