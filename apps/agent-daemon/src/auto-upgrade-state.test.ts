import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeAutoUpgradePauseUntil,
  createInitialAutoUpgradeRuntimeState,
  isAutoUpgradePauseActiveForTarget,
  readAutoUpgradeRuntimeState,
  recordAutoUpgradeAttemptCompleted,
  recordAutoUpgradeAttemptStarted,
  resolveAutoUpgradeStatePath,
  writeAutoUpgradeRuntimeState,
} from './auto-upgrade-state'

describe('auto-upgrade state helpers', () => {
  test('derives a stable sidecar path from the managed runtime record path', () => {
    expect(resolveAutoUpgradeStatePath('/tmp/daemon.json')).toBe('/tmp/daemon.auto-upgrade.json')
    expect(resolveAutoUpgradeStatePath('/tmp/daemon')).toBe('/tmp/daemon.auto-upgrade.json')
    expect(resolveAutoUpgradeStatePath(null)).toBeNull()
  })

  test('records attempt lifecycle and persists it on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-loop-auto-upgrade-state-'))
    const path = join(dir, 'daemon.auto-upgrade.json')

    let state = createInitialAutoUpgradeRuntimeState()
    state = recordAutoUpgradeAttemptStarted(state, {
      attemptedAt: '2026-04-11T12:00:00.000Z',
      targetVersion: '0.1.2',
      targetRevision: '2222222222222222222222222222222222222222',
    })
    state = recordAutoUpgradeAttemptCompleted(state, {
      outcome: 'succeeded',
      completedAt: '2026-04-11T12:00:05.000Z',
      targetVersion: '0.1.2',
      targetRevision: '2222222222222222222222222222222222222222',
    })
    writeAutoUpgradeRuntimeState(path, state)

    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toContain('"successCount": 1')
    expect(readAutoUpgradeRuntimeState(path)).toEqual({
      attemptCount: 1,
      successCount: 1,
      failureCount: 0,
      noChangeCount: 0,
      consecutiveFailureCount: 0,
      lastAttemptAt: '2026-04-11T12:00:00.000Z',
      lastSuccessAt: '2026-04-11T12:00:05.000Z',
      lastOutcome: 'succeeded',
      lastTargetVersion: '0.1.2',
      lastTargetRevision: '2222222222222222222222222222222222222222',
      lastError: null,
      pausedUntil: null,
    })
  })

  test('tolerates missing or malformed persisted state files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-loop-auto-upgrade-state-invalid-'))
    const missingPath = join(dir, 'missing.auto-upgrade.json')
    const malformedPath = join(dir, 'malformed.auto-upgrade.json')

    writeAutoUpgradeRuntimeState(malformedPath, {
      ...createInitialAutoUpgradeRuntimeState(),
      attemptCount: 3,
    })

    expect(readAutoUpgradeRuntimeState(missingPath)).toEqual(createInitialAutoUpgradeRuntimeState())

    writeFileSync(malformedPath, '{not-json', 'utf-8')
    expect(readAutoUpgradeRuntimeState(malformedPath)).toEqual(createInitialAutoUpgradeRuntimeState())
  })

  test('tracks failed and no-change outcomes separately', () => {
    let state = createInitialAutoUpgradeRuntimeState()
    state = recordAutoUpgradeAttemptStarted(state, {
      attemptedAt: '2026-04-11T12:10:00.000Z',
      targetVersion: '0.1.2',
      targetRevision: '2222222222222222222222222222222222222222',
    })
    state = recordAutoUpgradeAttemptCompleted(state, {
      outcome: 'failed',
      completedAt: '2026-04-11T12:10:02.000Z',
      targetVersion: '0.1.2',
      targetRevision: '2222222222222222222222222222222222222222',
      error: 'git pull failed',
      pausedUntil: '2026-04-11T12:25:02.000Z',
    })
    state = recordAutoUpgradeAttemptStarted(state, {
      attemptedAt: '2026-04-11T12:11:00.000Z',
      targetVersion: '0.1.2',
      targetRevision: '2222222222222222222222222222222222222222',
    })
    state = recordAutoUpgradeAttemptCompleted(state, {
      outcome: 'no_change',
      completedAt: '2026-04-11T12:11:01.000Z',
      targetVersion: '0.1.2',
      targetRevision: '2222222222222222222222222222222222222222',
    })

    expect(state).toMatchObject({
      attemptCount: 2,
      failureCount: 1,
      noChangeCount: 1,
      consecutiveFailureCount: 0,
      lastOutcome: 'no_change',
      lastError: null,
      pausedUntil: null,
    })
  })

  test('computes exponential pause windows for repeated failures and only applies them to the same target', () => {
    expect(computeAutoUpgradePauseUntil('2026-04-11T12:00:00.000Z', 900_000, 1)).toBe('2026-04-11T12:15:00.000Z')
    expect(computeAutoUpgradePauseUntil('2026-04-11T12:00:00.000Z', 900_000, 3)).toBe('2026-04-11T13:00:00.000Z')

    const pausedState = {
      ...createInitialAutoUpgradeRuntimeState(),
      lastTargetVersion: '0.1.2',
      lastTargetRevision: '2222222222222222222222222222222222222222',
      pausedUntil: '2026-04-11T12:15:00.000Z',
      consecutiveFailureCount: 1,
      lastOutcome: 'failed' as const,
    }

    expect(isAutoUpgradePauseActiveForTarget(pausedState, {
      targetVersion: '0.1.2',
      targetRevision: '2222222222222222222222222222222222222222',
    }, Date.parse('2026-04-11T12:05:00.000Z'))).toBe(true)

    expect(isAutoUpgradePauseActiveForTarget(pausedState, {
      targetVersion: '0.1.3',
      targetRevision: '3333333333333333333333333333333333333333',
    }, Date.parse('2026-04-11T12:05:00.000Z'))).toBe(false)
  })
})
