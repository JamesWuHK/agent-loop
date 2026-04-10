import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendWakeRequest,
  buildWakeQueuePath,
  coalesceWakeRequests,
  drainWakeQueue,
  hasPendingWakeRequests,
  resolveWakeQueueHomeDirFromWorktreesBase,
} from './wake-queue'

describe('wake queue helpers', () => {
  test('builds queue paths under the repo and machine specific wake queue directory', () => {
    expect(buildWakeQueuePath({
      repo: 'JamesWuHK/agent-loop',
      machineId: 'codex-dev',
      homeDir: '/tmp/agent-loop-home',
    })).toBe('/tmp/agent-loop-home/.agent-loop/wake-queue/JamesWuHK-agent-loop/codex-dev.jsonl')
  })

  test('appends wake requests as newline-delimited JSON records', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'agent-loop-wake-queue-test-'))
    const queuePath = buildWakeQueuePath({
      repo: 'JamesWuHK/agent-loop',
      machineId: 'codex-dev',
      homeDir,
    })

    appendWakeRequest(queuePath, {
      kind: 'issue',
      issueNumber: 42,
      reason: 'cli:wake-issue',
      sourceEvent: 'cli',
      dedupeKey: 'cli:wake-issue:42',
      requestedAt: '2026-04-11T09:00:00.000Z',
    })

    appendWakeRequest(queuePath, {
      kind: 'now',
      reason: 'cli:wake-now',
      sourceEvent: 'cli',
      dedupeKey: 'cli:wake-now',
      requestedAt: '2026-04-11T09:01:00.000Z',
    })

    expect(existsSync(queuePath)).toBe(true)
    expect(readFileSync(queuePath, 'utf-8')).toBe([
      '{"kind":"issue","issueNumber":42,"reason":"cli:wake-issue","sourceEvent":"cli","dedupeKey":"cli:wake-issue:42","requestedAt":"2026-04-11T09:00:00.000Z"}',
      '{"kind":"now","reason":"cli:wake-now","sourceEvent":"cli","dedupeKey":"cli:wake-now","requestedAt":"2026-04-11T09:01:00.000Z"}',
      '',
    ].join('\n'))
  })

  test('drains queued wake requests once and removes the consumed queue file', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'agent-loop-wake-drain-test-'))
    const queuePath = buildWakeQueuePath({
      repo: 'JamesWuHK/agent-loop',
      machineId: 'codex-dev',
      homeDir,
    })

    appendWakeRequest(queuePath, {
      kind: 'pr',
      prNumber: 381,
      reason: 'cli:wake-pr',
      sourceEvent: 'cli',
      dedupeKey: 'cli:wake-pr:381',
      requestedAt: '2026-04-11T09:05:00.000Z',
    })

    expect(hasPendingWakeRequests(queuePath)).toBe(true)

    expect(drainWakeQueue(queuePath)).toEqual({
      requests: [{
        kind: 'pr',
        prNumber: 381,
        reason: 'cli:wake-pr',
        sourceEvent: 'cli',
        dedupeKey: 'cli:wake-pr:381',
        requestedAt: '2026-04-11T09:05:00.000Z',
      }],
      invalidEntries: [],
    })

    expect(hasPendingWakeRequests(queuePath)).toBe(false)
    expect(existsSync(queuePath)).toBe(false)
  })

  test('drain skips malformed entries while preserving valid wake requests', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'agent-loop-wake-invalid-test-'))
    const queuePath = buildWakeQueuePath({
      repo: 'JamesWuHK/agent-loop',
      machineId: 'codex-dev',
      homeDir,
    })

    appendWakeRequest(queuePath, {
      kind: 'issue',
      issueNumber: 42,
      reason: 'workflow',
      sourceEvent: 'issues.labeled',
      dedupeKey: 'issue:42',
      requestedAt: '2026-04-11T09:10:00.000Z',
    })

    writeFileSync(queuePath, [
      '{"kind":"issue","issueNumber":42,"reason":"workflow","sourceEvent":"issues.labeled","dedupeKey":"issue:42","requestedAt":"2026-04-11T09:10:00.000Z"}',
      '{"kind":"issue","issueNumber":"oops"}',
      'not-json',
      '',
    ].join('\n'))

    const result = drainWakeQueue(queuePath)

    expect(result.requests).toEqual([{
      kind: 'issue',
      issueNumber: 42,
      reason: 'workflow',
      sourceEvent: 'issues.labeled',
      dedupeKey: 'issue:42',
      requestedAt: '2026-04-11T09:10:00.000Z',
    }])
    expect(result.invalidEntries).toHaveLength(2)
    expect(result.invalidEntries[0]?.lineNumber).toBe(2)
    expect(result.invalidEntries[1]?.lineNumber).toBe(3)
    expect(existsSync(queuePath)).toBe(false)
  })

  test('coalesces duplicate wake requests by dedupe key while preserving the latest payload', () => {
    expect(coalesceWakeRequests([
      {
        kind: 'issue',
        issueNumber: 42,
        reason: 'issues.edited',
        sourceEvent: 'issues.edited',
        dedupeKey: 'issues:edited:42',
        requestedAt: '2026-04-11T10:00:00.000Z',
      },
      {
        kind: 'now',
        reason: 'workflow_dispatch',
        sourceEvent: 'workflow_dispatch',
        dedupeKey: 'workflow_dispatch:now',
        requestedAt: '2026-04-11T10:01:00.000Z',
      },
      {
        kind: 'issue',
        issueNumber: 42,
        reason: 'issues.edited',
        sourceEvent: 'issues.edited',
        dedupeKey: 'issues:edited:42',
        requestedAt: '2026-04-11T10:02:00.000Z',
      },
    ])).toEqual([
      {
        kind: 'now',
        reason: 'workflow_dispatch',
        sourceEvent: 'workflow_dispatch',
        dedupeKey: 'workflow_dispatch:now',
        requestedAt: '2026-04-11T10:01:00.000Z',
      },
      {
        kind: 'issue',
        issueNumber: 42,
        reason: 'issues.edited',
        sourceEvent: 'issues.edited',
        dedupeKey: 'issues:edited:42',
        requestedAt: '2026-04-11T10:02:00.000Z',
      },
    ])
  })

  test('derives the wake queue home dir from supported worktree layouts', () => {
    expect(resolveWakeQueueHomeDirFromWorktreesBase('/tmp/agent-loop-home/worktrees')).toBe('/tmp/agent-loop-home')
    expect(resolveWakeQueueHomeDirFromWorktreesBase('/Users/wujames/.agent-worktrees/JamesWuHK-agent-loop')).toBe('/Users/wujames')
    expect(resolveWakeQueueHomeDirFromWorktreesBase('/tmp/custom-layout')).toBeUndefined()
  })
})
