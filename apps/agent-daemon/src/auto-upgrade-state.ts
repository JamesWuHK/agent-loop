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
  consecutiveFailureCount?: unknown
  lastAttemptAt?: unknown
  lastSuccessAt?: unknown
  lastOutcome?: unknown
  lastTargetVersion?: unknown
  lastTargetRevision?: unknown
  lastError?: unknown
  pausedUntil?: unknown
}

export function createInitialAutoUpgradeRuntimeState(): AgentLoopAutoUpgradeRuntimeState {
  return {
    attemptCount: 0,
    successCount: 0,
    failureCount: 0,
    noChangeCount: 0,
    consecutiveFailureCount: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastOutcome: null,
    lastTargetVersion: null,
    lastTargetRevision: null,
    lastError: null,
    pausedUntil: null,
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
      consecutiveFailureCount: normalizeNonNegativeInteger(parsed.consecutiveFailureCount),
      lastAttemptAt: normalizeOptionalString(parsed.lastAttemptAt),
      lastSuccessAt: normalizeOptionalString(parsed.lastSuccessAt),
      lastOutcome: normalizeOutcome(parsed.lastOutcome),
      lastTargetVersion: normalizeOptionalString(parsed.lastTargetVersion),
      lastTargetRevision: normalizeOptionalString(parsed.lastTargetRevision),
      lastError: normalizeOptionalString(parsed.lastError),
      pausedUntil: normalizeOptionalString(parsed.pausedUntil),
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
  const targetVersion = normalizeOptionalString(input.targetVersion)
  const targetRevision = normalizeOptionalString(input.targetRevision)
  const targetChanged = hasAutoUpgradeTargetChanged(state, targetVersion, targetRevision)

  return {
    ...state,
    attemptCount: state.attemptCount + 1,
    lastAttemptAt: input.attemptedAt,
    lastOutcome: 'attempting',
    lastTargetVersion: targetVersion,
    lastTargetRevision: targetRevision,
    lastError: null,
    consecutiveFailureCount: targetChanged ? 0 : state.consecutiveFailureCount,
    pausedUntil: targetChanged ? null : state.pausedUntil,
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
    pausedUntil?: string | null
  },
): AgentLoopAutoUpgradeRuntimeState {
  const next: AgentLoopAutoUpgradeRuntimeState = {
    ...state,
    lastAttemptAt: state.lastAttemptAt ?? input.completedAt,
    lastOutcome: input.outcome,
    lastTargetVersion: normalizeOptionalString(input.targetVersion),
    lastTargetRevision: normalizeOptionalString(input.targetRevision),
    lastError: normalizeOptionalString(input.error),
    pausedUntil: normalizeOptionalString(input.pausedUntil),
  }

  if (input.outcome === 'succeeded') {
    next.successCount += 1
    next.consecutiveFailureCount = 0
    next.lastSuccessAt = input.completedAt
    next.lastError = null
    next.pausedUntil = null
  } else if (input.outcome === 'failed') {
    next.failureCount += 1
    next.consecutiveFailureCount += 1
  } else {
    next.noChangeCount += 1
    next.consecutiveFailureCount = 0
    next.lastError = null
    next.pausedUntil = null
  }

  return next
}

export function computeAutoUpgradePauseUntil(
  completedAt: string,
  baseDelayMs: number,
  consecutiveFailureCount: number,
): string | null {
  const completedAtMs = Date.parse(completedAt)
  if (!Number.isFinite(completedAtMs)) {
    return null
  }

  const normalizedBaseDelayMs = Math.max(0, Math.floor(baseDelayMs))
  if (normalizedBaseDelayMs <= 0 || consecutiveFailureCount <= 0) {
    return null
  }

  const multiplier = Math.min(2 ** Math.max(0, consecutiveFailureCount - 1), 8)
  return new Date(completedAtMs + normalizedBaseDelayMs * multiplier).toISOString()
}

export function isAutoUpgradePauseActiveForTarget(
  state: AgentLoopAutoUpgradeRuntimeState,
  input: {
    targetVersion: string | null
    targetRevision: string | null
  },
  nowMs = Date.now(),
): boolean {
  const pausedUntilMs = Date.parse(state.pausedUntil ?? '')
  if (!Number.isFinite(pausedUntilMs) || pausedUntilMs <= nowMs) {
    return false
  }

  return !hasAutoUpgradeTargetChanged(
    state,
    normalizeOptionalString(input.targetVersion),
    normalizeOptionalString(input.targetRevision),
  )
}

function hasAutoUpgradeTargetChanged(
  state: Pick<AgentLoopAutoUpgradeRuntimeState, 'lastTargetVersion' | 'lastTargetRevision'>,
  targetVersion: string | null,
  targetRevision: string | null,
): boolean {
  return state.lastTargetVersion !== targetVersion
    || state.lastTargetRevision !== targetRevision
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
