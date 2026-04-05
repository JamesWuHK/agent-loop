import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const RUNTIME_DIR_NAME = '.agent-loop/runtime'

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
  pid: number
  metricsPort: number
  cwd: string
  startedAt: string
  command: string[]
  logPath: string
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
    if (arg === '--daemonize' || arg === '--stop') continue
    sanitized.push(arg)
  }

  return sanitized
}

export function readBackgroundRuntimeRecord(path: string): BackgroundRuntimeRecord | null {
  if (!existsSync(path)) return null

  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as BackgroundRuntimeRecord
  } catch {
    return null
  }
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
    },
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })

  child.unref()

  const record: BackgroundRuntimeRecord = {
    ...input.identity,
    pid: child.pid!,
    metricsPort: input.metricsPort,
    cwd: input.cwd,
    startedAt: new Date().toISOString(),
    command,
    logPath: paths.logPath,
  }
  writeFileSync(paths.recordPath, JSON.stringify(record, null, 2))
  return record
}

function sanitizeBackgroundSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}
