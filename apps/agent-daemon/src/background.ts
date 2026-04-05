import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import type { DaemonRuntimeSupervisor } from '@agent/shared'

const RUNTIME_DIR_NAME = '.agent-loop/runtime'
const AGENT_LOOP_RUNTIME_MANAGER_ENV = 'AGENT_LOOP_RUNTIME_MANAGER'
const MANAGED_DAEMON_CONTROL_FLAGS = new Set([
  '--daemonize',
  '--join-project',
  '--runtimes',
  '--start',
  '--reconcile',
  '--restart',
  '--stop',
  '--logs',
  '--status',
  '--doctor',
  '--once',
  '--launchd-install',
  '--launchd-uninstall',
  '--launchd-status',
])

type ManagedDaemonRuntimeSupervisor = Exclude<DaemonRuntimeSupervisor, 'direct'>

export interface BackgroundRuntimeIdentity {
  repo: string
  machineId: string
  healthPort: number
}

export interface BackgroundRuntimePaths {
  runtimeDir: string
  recordPath: string
  logPath: string
}

export interface BackgroundRuntimeRecord extends BackgroundRuntimeIdentity {
  supervisor: ManagedDaemonRuntimeSupervisor
  pid: number
  metricsPort: number
  cwd: string
  startedAt: string
  command: string[]
  logPath: string
}

export interface BackgroundRuntimeSnapshot {
  recordPath: string
  record: BackgroundRuntimeRecord
  alive: boolean
}

export function buildBackgroundRuntimePaths(
  identity: BackgroundRuntimeIdentity,
  homeDir = homedir(),
): BackgroundRuntimePaths {
  const runtimeDir = resolve(homeDir, RUNTIME_DIR_NAME)
  const slug = [
    sanitizeBackgroundSegment(identity.repo),
    sanitizeBackgroundSegment(identity.machineId),
    String(identity.healthPort),
  ].join('__')

  return {
    runtimeDir,
    recordPath: resolve(runtimeDir, `${slug}.json`),
    logPath: resolve(runtimeDir, `${slug}.log`),
  }
}

export function sanitizeDaemonBackgroundArgs(argv: string[]): string[] {
  const sanitized: string[] = []

  for (const arg of argv) {
    if (MANAGED_DAEMON_CONTROL_FLAGS.has(arg)) continue
    sanitized.push(arg)
  }

  return sanitized
}

export function readBackgroundRuntimeRecord(path: string): BackgroundRuntimeRecord | null {
  if (!existsSync(path)) return null

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<BackgroundRuntimeRecord>
    if (!parsed || typeof parsed !== 'object') return null
    if (
      typeof parsed.repo !== 'string'
      || typeof parsed.machineId !== 'string'
      || !Number.isFinite(parsed.healthPort)
      || !Number.isFinite(parsed.pid)
      || !Number.isFinite(parsed.metricsPort)
      || typeof parsed.cwd !== 'string'
      || typeof parsed.startedAt !== 'string'
      || !Array.isArray(parsed.command)
      || typeof parsed.logPath !== 'string'
    ) {
      return null
    }

    const healthPort = parsed.healthPort as number
    const pid = parsed.pid as number
    const metricsPort = parsed.metricsPort as number

    return {
      repo: parsed.repo,
      machineId: parsed.machineId,
      healthPort,
      supervisor: normalizeManagedRuntimeSupervisor(parsed.supervisor),
      pid,
      metricsPort,
      cwd: parsed.cwd,
      startedAt: parsed.startedAt,
      command: parsed.command.filter((value): value is string => typeof value === 'string'),
      logPath: parsed.logPath,
    }
  } catch {
    return null
  }
}

export function listBackgroundRuntimeRecords(homeDir = homedir()): BackgroundRuntimeSnapshot[] {
  const runtimeDir = resolve(homeDir, RUNTIME_DIR_NAME)
  if (!existsSync(runtimeDir)) return []

  return readdirSync(runtimeDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const recordPath = resolve(runtimeDir, entry.name)
      const record = readBackgroundRuntimeRecord(recordPath)
      if (!record) return null

      return {
        recordPath,
        record,
        alive: isProcessAlive(record.pid),
      } satisfies BackgroundRuntimeSnapshot
    })
    .filter((snapshot): snapshot is BackgroundRuntimeSnapshot => snapshot !== null)
    .sort((left, right) => Date.parse(right.record.startedAt) - Date.parse(left.record.startedAt))
}

export function resolveBackgroundRuntimeRecord(input: {
  repo?: string
  machineId?: string
  healthPort?: number
  homeDir?: string
  preferAlive?: boolean
}): BackgroundRuntimeSnapshot | null {
  const matches = listBackgroundRuntimeRecords(input.homeDir).filter((snapshot) => {
    if (input.repo && snapshot.record.repo !== input.repo) return false
    if (input.machineId && snapshot.record.machineId !== input.machineId) return false
    if (input.healthPort && snapshot.record.healthPort !== input.healthPort) return false
    return true
  })

  if (matches.length === 0) return null

  const preferredMatches = input.preferAlive === false
    ? matches
    : matches.filter((snapshot) => snapshot.alive)
  const effectiveMatches = preferredMatches.length > 0 ? preferredMatches : matches

  if (effectiveMatches.length === 1) {
    return effectiveMatches[0] ?? null
  }

  throw new Error(buildAmbiguousBackgroundRuntimeMessage(effectiveMatches))
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function removeBackgroundRuntimeRecord(path: string): void {
  rmSync(path, { force: true })
}

export function writeBackgroundRuntimeRecord(
  path: string,
  record: BackgroundRuntimeRecord,
): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(record, null, 2))
}

export function buildCurrentProcessRuntimeRecord(input: {
  identity: BackgroundRuntimeIdentity
  metricsPort: number
  cwd: string
  logPath: string
  command?: string[]
  supervisor?: ManagedDaemonRuntimeSupervisor
  env?: NodeJS.ProcessEnv
}): BackgroundRuntimeRecord {
  return {
    ...input.identity,
    supervisor: input.supervisor ?? resolveManagedRuntimeSupervisor(input.env),
    pid: process.pid,
    metricsPort: input.metricsPort,
    cwd: input.cwd,
    startedAt: new Date().toISOString(),
    command: input.command ?? [process.execPath, ...process.argv.slice(1)],
    logPath: input.logPath,
  }
}

export function stopBackgroundRuntime(recordPath: string): {
  stopped: boolean
  message: string
} {
  const record = readBackgroundRuntimeRecord(recordPath)
  if (!record) {
    return {
      stopped: false,
      message: `No background runtime record found at ${recordPath}`,
    }
  }

  if (!isProcessAlive(record.pid)) {
    removeBackgroundRuntimeRecord(recordPath)
    return {
      stopped: false,
      message: `Removed stale background runtime record for pid ${record.pid}`,
    }
  }

  process.kill(record.pid, 'SIGTERM')
  removeBackgroundRuntimeRecord(recordPath)
  return {
    stopped: true,
    message: `Sent SIGTERM to background daemon pid ${record.pid}`,
  }
}

export function launchBackgroundRuntime(input: {
  identity: BackgroundRuntimeIdentity
  metricsPort: number
  cwd: string
  argv: string[]
  scriptPath: string
  env?: NodeJS.ProcessEnv
  homeDir?: string
}): BackgroundRuntimeRecord {
  const paths = buildBackgroundRuntimePaths(input.identity, input.homeDir)
  mkdirSync(paths.runtimeDir, { recursive: true })

  const existing = readBackgroundRuntimeRecord(paths.recordPath)
  if (existing && isProcessAlive(existing.pid)) {
    throw new Error(`Background daemon already running with pid ${existing.pid}`)
  }
  if (existing) {
    removeBackgroundRuntimeRecord(paths.recordPath)
  }

  const logFd = openSync(paths.logPath, 'a')
  const command = [process.execPath, input.scriptPath, ...sanitizeDaemonBackgroundArgs(input.argv)]
  const child = spawn(process.execPath, [input.scriptPath, ...sanitizeDaemonBackgroundArgs(input.argv)], {
    cwd: input.cwd,
    env: {
      ...process.env,
      ...input.env,
      AGENT_LOOP_RUNTIME_FILE: paths.recordPath,
      AGENT_LOOP_LOG_FILE: paths.logPath,
      [AGENT_LOOP_RUNTIME_MANAGER_ENV]: 'detached',
    },
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })

  child.unref()

  const record: BackgroundRuntimeRecord = {
    ...buildCurrentProcessRuntimeRecord({
      identity: input.identity,
      metricsPort: input.metricsPort,
      cwd: input.cwd,
      logPath: paths.logPath,
      command,
      supervisor: 'detached',
    }),
    pid: child.pid!,
  }
  writeBackgroundRuntimeRecord(paths.recordPath, record)
  return record
}

export function resolveCurrentRuntimeSupervisor(
  env: NodeJS.ProcessEnv = process.env,
): DaemonRuntimeSupervisor {
  const supervisor = env[AGENT_LOOP_RUNTIME_MANAGER_ENV]
  if (supervisor === 'launchd' || supervisor === 'detached') {
    return supervisor
  }
  return 'direct'
}

function resolveManagedRuntimeSupervisor(
  env: NodeJS.ProcessEnv = process.env,
): ManagedDaemonRuntimeSupervisor {
  const supervisor = env[AGENT_LOOP_RUNTIME_MANAGER_ENV]
  return supervisor === 'launchd' ? 'launchd' : 'detached'
}

function normalizeManagedRuntimeSupervisor(
  supervisor: unknown,
): ManagedDaemonRuntimeSupervisor {
  return supervisor === 'launchd' ? 'launchd' : 'detached'
}

function sanitizeBackgroundSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

function buildAmbiguousBackgroundRuntimeMessage(
  matches: BackgroundRuntimeSnapshot[],
): string {
  const details = matches
    .map((snapshot) => {
      const state = snapshot.alive ? 'alive' : 'stale'
      return `${snapshot.record.repo} machine=${snapshot.record.machineId} health=${snapshot.record.healthPort} pid=${snapshot.record.pid} ${state}`
    })
    .join('; ')

  return `Multiple background daemon records matched. Refine with --machine-id or --health-port. Matches: ${details}`
}
