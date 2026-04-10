import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'

export type WakeRequest =
  | {
      kind: 'now'
      reason: string
      sourceEvent: string
      dedupeKey: string
      requestedAt: string
    }
  | {
      kind: 'issue'
      issueNumber: number
      reason: string
      sourceEvent: string
      dedupeKey: string
      requestedAt: string
    }
  | {
      kind: 'pr'
      prNumber: number
      reason: string
      sourceEvent: string
      dedupeKey: string
      requestedAt: string
    }

export interface InvalidWakeQueueEntry {
  lineNumber: number
  line: string
  error: string
}

export interface DrainWakeQueueResult {
  requests: WakeRequest[]
  invalidEntries: InvalidWakeQueueEntry[]
}

export function formatWakeQueueRepoSlug(repo: string): string {
  return repo.replaceAll('/', '-')
}

export function resolveWakeQueueHomeDirFromWorktreesBase(worktreesBase: string): string | undefined {
  const resolved = resolve(worktreesBase)
  const parentDir = dirname(resolved)

  if (basename(resolved) === 'worktrees') {
    return parentDir
  }

  if (basename(parentDir) === '.agent-worktrees') {
    return dirname(parentDir)
  }

  return undefined
}

export function buildWakeQueuePath(input: {
  repo: string
  machineId: string
  homeDir?: string
}): string {
  return resolve(
    input.homeDir ?? homedir(),
    '.agent-loop',
    'wake-queue',
    formatWakeQueueRepoSlug(input.repo),
    `${input.machineId}.jsonl`,
  )
}

export function appendWakeRequest(queuePath: string, request: WakeRequest): void {
  mkdirSync(dirname(queuePath), { recursive: true })
  appendFileSync(queuePath, `${JSON.stringify(request)}\n`, 'utf-8')
}

export function hasPendingWakeRequests(queuePath: string): boolean {
  try {
    return statSync(queuePath).size > 0
  } catch {
    return false
  }
}

export function drainWakeQueue(queuePath: string): DrainWakeQueueResult {
  const drainingPath = beginWakeQueueDrain(queuePath)
  if (drainingPath === null) {
    return {
      requests: [],
      invalidEntries: [],
    }
  }

  let content: string
  try {
    content = readFileSync(drainingPath, 'utf-8')
  } catch (error) {
    try {
      renameSync(drainingPath, queuePath)
    } catch {
      // Keep the original read error as the main signal; restore is best-effort.
    }
    throw error
  }

  try {
    return parseWakeQueueContent(content)
  } finally {
    unlinkSync(drainingPath)
  }
}

function beginWakeQueueDrain(queuePath: string): string | null {
  if (!hasPendingWakeRequests(queuePath)) {
    return null
  }

  const drainingPath = `${queuePath}.draining-${process.pid}-${Date.now()}-${crypto.randomUUID()}`

  try {
    renameSync(queuePath, drainingPath)
    return drainingPath
  } catch {
    return null
  }
}

function parseWakeQueueContent(content: string): DrainWakeQueueResult {
  const requests: WakeRequest[] = []
  const invalidEntries: InvalidWakeQueueEntry[] = []

  const lines = content.split('\n')

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? ''
    if (line.length === 0) {
      continue
    }

    try {
      requests.push(parseWakeRequest(line))
    } catch (error) {
      invalidEntries.push({
        lineNumber: index + 1,
        line,
        error: error instanceof Error ? error.message : 'Unknown wake queue parse error',
      })
    }
  }

  return {
    requests,
    invalidEntries,
  }
}

function parseWakeRequest(line: string): WakeRequest {
  const parsed = JSON.parse(line) as Record<string, unknown> | null

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Wake request must be a JSON object')
  }

  const kind = parsed.kind
  const reason = parsed.reason
  const sourceEvent = parsed.sourceEvent
  const dedupeKey = parsed.dedupeKey
  const requestedAt = parsed.requestedAt

  if (kind !== 'now' && kind !== 'issue' && kind !== 'pr') {
    throw new Error('Wake request kind must be one of now, issue, or pr')
  }

  if (
    typeof reason !== 'string'
    || typeof sourceEvent !== 'string'
    || typeof dedupeKey !== 'string'
    || typeof requestedAt !== 'string'
  ) {
    throw new Error('Wake request is missing required string fields')
  }

  if (kind === 'now') {
    return {
      kind,
      reason,
      sourceEvent,
      dedupeKey,
      requestedAt,
    }
  }

  const targetField = kind === 'issue' ? parsed.issueNumber : parsed.prNumber
  if (!Number.isSafeInteger(targetField) || (targetField as number) <= 0) {
    throw new Error(`Wake request ${kind} target must be a positive integer`)
  }

  if (kind === 'issue') {
    return {
      kind,
      issueNumber: targetField as number,
      reason,
      sourceEvent,
      dedupeKey,
      requestedAt,
    }
  }

  return {
    kind,
    prNumber: targetField as number,
    reason,
    sourceEvent,
    dedupeKey,
    requestedAt,
  }
}
