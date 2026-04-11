import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  AgentLoopAutoUpgradeOutcome,
  AgentLoopAutoUpgradeRuntimeState,
} from '@agent/shared'

interface AutoUpgradeStateRecord {
  attemptCount?: unknown
  successCount?: unknown
  failureCount?: unknown
  noChangeCount?: unknown
  lastAttemptAt?: unknown
  lastSuccessAt?: unknown
  lastOutcome?: unknown
  lastTargetVersion?: unknown
  lastTargetRevision?: unknown
  lastError?: unknown
}

export function createInitialAutoUpgradeRuntimeState(): AgentLoopAutoUpgradeRuntimeState {
  return {
    attemptCount: 0,
    successCount: 0,
    failureCount: 0,
    noChangeCount: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastOutcome: null,
    lastTargetVersion: null,
    lastTargetRevision: null,
    lastError: null,
  }
}

export function resolveAutoUpgradeStatePath(runtimeRecordPath: string | null): string | null {
  if (!runtimeRecordPath || runtimeRecordPath.trim().length === 0) {
    return null
  }

  return runtimeRecordPath.endsWith('.json')
    ? `${runtimeRecordPath.slice(0, -'.json'.length)}.auto-upgrade.json`
    : `${runtimeRecordPath}.auto-upgrade.json`
}

export function readAutoUpgradeRuntimeState(
  path: string | null,
): AgentLoopAutoUpgradeRuntimeState {
  if (!path || !existsSync(path)) {
    return createInitialAutoUpgradeRuntimeState()
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as AutoUpgradeStateRecord
    return {
      attemptCount: normalizeNonNegativeInteger(parsed.attemptCount),
      successCount: normalizeNonNegativeInteger(parsed.successCount),
      failureCount: normalizeNonNegativeInteger(parsed.failureCount),
      noChangeCount: normalizeNonNegativeInteger(parsed.noChangeCount),
      lastAttemptAt: normalizeOptionalString(parsed.lastAttemptAt),
      lastSuccessAt: normalizeOptionalString(parsed.lastSuccessAt),
      lastOutcome: normalizeOutcome(parsed.lastOutcome),
      lastTargetVersion: normalizeOptionalString(parsed.lastTargetVersion),
      lastTargetRevision: normalizeOptionalString(parsed.lastTargetRevision),
      lastError: normalizeOptionalString(parsed.lastError),
    }
  } catch {
    return createInitialAutoUpgradeRuntimeState()
  }
}

export function writeAutoUpgradeRuntimeState(
  path: string | null,
  state: AgentLoopAutoUpgradeRuntimeState,
): AgentLoopAutoUpgradeRuntimeState {
  if (!path) {
    return state
  }

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf-8')
  return state
}

export function recordAutoUpgradeAttemptStarted(
  state: AgentLoopAutoUpgradeRuntimeState,
  input: {
    attemptedAt: string
    targetVersion: string | null
    targetRevision: string | null
  },
): AgentLoopAutoUpgradeRuntimeState {
  return {
    ...state,
    attemptCount: state.attemptCount + 1,
    lastAttemptAt: input.attemptedAt,
    lastOutcome: 'attempting',
    lastTargetVersion: normalizeOptionalString(input.targetVersion),
    lastTargetRevision: normalizeOptionalString(input.targetRevision),
    lastError: null,
  }
}

export function recordAutoUpgradeAttemptCompleted(
  state: AgentLoopAutoUpgradeRuntimeState,
  input: {
    outcome: Exclude<AgentLoopAutoUpgradeOutcome, 'attempting'>
    completedAt: string
    targetVersion: string | null
    targetRevision: string | null
    error?: string | null
  },
): AgentLoopAutoUpgradeRuntimeState {
  const next: AgentLoopAutoUpgradeRuntimeState = {
    ...state,
    lastAttemptAt: state.lastAttemptAt ?? input.completedAt,
    lastOutcome: input.outcome,
    lastTargetVersion: normalizeOptionalString(input.targetVersion),
    lastTargetRevision: normalizeOptionalString(input.targetRevision),
    lastError: normalizeOptionalString(input.error),
  }

  if (input.outcome === 'succeeded') {
    next.successCount += 1
    next.lastSuccessAt = input.completedAt
    next.lastError = null
  } else if (input.outcome === 'failed') {
    next.failureCount += 1
  } else {
    next.noChangeCount += 1
    next.lastError = null
  }

  return next
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null
}

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0
}

function normalizeOutcome(value: unknown): AgentLoopAutoUpgradeOutcome | null {
  return value === 'attempting'
    || value === 'succeeded'
    || value === 'failed'
    || value === 'no_change'
    ? value
    : null
}
