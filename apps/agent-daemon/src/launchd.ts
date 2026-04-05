import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  buildBackgroundRuntimePaths,
  removeBackgroundRuntimeRecord,
  sanitizeDaemonBackgroundArgs,
  type BackgroundRuntimeIdentity,
} from './background'

const LAUNCH_AGENTS_DIR_NAME = 'Library/LaunchAgents'
const LAUNCHD_LABEL_PREFIX = 'com.agentloop'
const DEFAULT_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
const SAFE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR'] as const
const LAUNCHD_BOOTSTRAP_RETRY_ATTEMPTS = 3
const LAUNCHD_BOOTSTRAP_RETRY_DELAY_MS = 250
const LAUNCHD_RETRYABLE_BOOTSTRAP_ERROR_PATTERNS = [
  'bootstrap failed: 5',
  'input/output error',
  'resource busy',
  'operation already in progress',
] as const

export interface LaunchdServicePaths {
  label: string
  launchAgentsDir: string
  plistPath: string
  domain: string
  serviceTarget: string
  runtimeRecordPath: string
  logPath: string
}

export interface LaunchdServiceSpec extends LaunchdServicePaths {
  programArguments: string[]
  workingDirectory: string
  environmentVariables: Record<string, string>
}

export interface LaunchdServiceStatus {
  label: string
  plistPath: string
  runtimeRecordPath: string
  logPath: string
  installed: boolean
  loaded: boolean
  detail: string | null
}

interface LaunchctlOptions {
  allowFailure?: boolean
}

type LaunchctlRunner = (args: string[], options?: LaunchctlOptions) => string
type SleepFn = (ms: number) => void

export function buildLaunchdServicePaths(
  identity: BackgroundRuntimeIdentity,
  homeDir = homedir(),
  uid = process.getuid?.() ?? 0,
): LaunchdServicePaths {
  const runtimePaths = buildBackgroundRuntimePaths(identity, homeDir)
  const label = buildLaunchdLabel(identity)
  const launchAgentsDir = resolve(homeDir, LAUNCH_AGENTS_DIR_NAME)
  const domain = `gui/${uid}`

  return {
    label,
    launchAgentsDir,
    plistPath: resolve(launchAgentsDir, `${label}.plist`),
    domain,
    serviceTarget: `${domain}/${label}`,
    runtimeRecordPath: runtimePaths.recordPath,
    logPath: runtimePaths.logPath,
  }
}

export function buildLaunchdProgramArguments(input: {
  scriptPath: string
  argv: string[]
  execPath?: string
}): string[] {
  return [
    input.execPath ?? process.execPath,
    input.scriptPath,
    ...sanitizeDaemonBackgroundArgs(input.argv),
  ]
}

export function buildLaunchdEnvironmentVariables(input: {
  runtimeRecordPath: string
  logPath: string
  env?: NodeJS.ProcessEnv
  homeDir?: string
}): Record<string, string> {
  const env = input.env ?? process.env
  const variables: Record<string, string> = {
    AGENT_LOOP_RUNTIME_FILE: input.runtimeRecordPath,
    AGENT_LOOP_LOG_FILE: input.logPath,
    AGENT_LOOP_RUNTIME_MANAGER: 'launchd',
  }

  for (const key of SAFE_ENV_KEYS) {
    const value = env[key]
    if (typeof value === 'string' && value.length > 0) {
      variables[key] = value
    }
  }

  if (!variables.PATH) variables.PATH = DEFAULT_PATH
  if (!variables.HOME) variables.HOME = input.homeDir ?? homedir()

  return variables
}

export function buildLaunchdServiceSpec(input: {
  identity: BackgroundRuntimeIdentity
  cwd: string
  scriptPath: string
  argv: string[]
  env?: NodeJS.ProcessEnv
  execPath?: string
  homeDir?: string
  uid?: number
}): LaunchdServiceSpec {
  const paths = buildLaunchdServicePaths(input.identity, input.homeDir, input.uid)

  return {
    ...paths,
    programArguments: buildLaunchdProgramArguments({
      scriptPath: input.scriptPath,
      argv: input.argv,
      execPath: input.execPath,
    }),
    workingDirectory: input.cwd,
    environmentVariables: buildLaunchdEnvironmentVariables({
      runtimeRecordPath: paths.runtimeRecordPath,
      logPath: paths.logPath,
      env: input.env,
      homeDir: input.homeDir,
    }),
  }
}

export function renderLaunchdPlist(spec: LaunchdServiceSpec): string {
  const programArguments = spec.programArguments
    .map((argument) => `    <string>${escapeXml(argument)}</string>`)
    .join('\n')
  const environmentVariables = Object.entries(spec.environmentVariables)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [
      `      <key>${escapeXml(key)}</key>`,
      `      <string>${escapeXml(value)}</string>`,
    ].join('\n'))
    .join('\n')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>`,
    `  <string>${escapeXml(spec.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    programArguments,
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${escapeXml(spec.workingDirectory)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    environmentVariables,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(spec.logPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(spec.logPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

export function installLaunchdService(
  spec: LaunchdServiceSpec,
  runner: LaunchctlRunner = runLaunchctl,
  sleep: SleepFn = sleepSync,
): LaunchdServicePaths {
  assertLaunchdWorkingDirectorySafe(spec.workingDirectory)
  mkdirSync(spec.launchAgentsDir, { recursive: true })
  writeFileSync(spec.plistPath, renderLaunchdPlist(spec), {
    mode: 0o644,
  })

  for (let attempt = 1; attempt <= LAUNCHD_BOOTSTRAP_RETRY_ATTEMPTS; attempt += 1) {
    runner(['bootout', spec.serviceTarget], { allowFailure: true })

    try {
      runner(['bootstrap', spec.domain, spec.plistPath])
      break
    } catch (error) {
      if (!isRetryableLaunchdBootstrapError(error) || attempt === LAUNCHD_BOOTSTRAP_RETRY_ATTEMPTS) {
        throw error
      }
      sleep(LAUNCHD_BOOTSTRAP_RETRY_DELAY_MS)
    }
  }

  runner(['enable', spec.serviceTarget], { allowFailure: true })
  runner(['kickstart', '-k', spec.serviceTarget])

  return spec
}

export function uninstallLaunchdService(
  paths: LaunchdServicePaths,
  runner: LaunchctlRunner = runLaunchctl,
): {
  removed: boolean
  message: string
} {
  const installed = existsSync(paths.plistPath)

  runner(['bootout', paths.serviceTarget], { allowFailure: true })
  rmSync(paths.plistPath, { force: true })
  removeBackgroundRuntimeRecord(paths.runtimeRecordPath)

  return {
    removed: installed,
    message: installed
      ? `Removed launchd service ${paths.label}`
      : `Launchd service ${paths.label} was not installed`,
  }
}

export function inspectLaunchdService(
  paths: LaunchdServicePaths,
  runner: LaunchctlRunner = runLaunchctl,
): LaunchdServiceStatus {
  const installed = existsSync(paths.plistPath)

  try {
    const detail = runner(['print', paths.serviceTarget])
    return {
      label: paths.label,
      plistPath: paths.plistPath,
      runtimeRecordPath: paths.runtimeRecordPath,
      logPath: paths.logPath,
      installed,
      loaded: true,
      detail,
    }
  } catch {
    return {
      label: paths.label,
      plistPath: paths.plistPath,
      runtimeRecordPath: paths.runtimeRecordPath,
      logPath: paths.logPath,
      installed,
      loaded: false,
      detail: installed ? readFileSync(paths.plistPath, 'utf-8') : null,
    }
  }
}

export function assertLaunchdWorkingDirectorySafe(cwd: string): void {
  const reason = getUnsafeLaunchdWorkingDirectoryReason(cwd)
  if (reason) {
    throw new Error(reason)
  }
}

export function getUnsafeLaunchdWorkingDirectoryReason(
  cwd: string,
  osTempDir = tmpdir(),
): string | null {
  const cwdCandidates = buildPathVariants(cwd)
  const unsafeRoots = [
    '/tmp',
    '/private/tmp',
    osTempDir,
  ]
    .flatMap((path) => buildPathVariants(path))
    .filter((path, index, all) => all.indexOf(path) === index)

  for (const cwdCandidate of cwdCandidates) {
    for (const unsafeRoot of unsafeRoots) {
      if (isSameOrChildPath(cwdCandidate, unsafeRoot)) {
        return `launchd working directory must be a durable repo checkout, not a temporary path (${cwdCandidate} is under ${unsafeRoot})`
      }
    }
  }

  return null
}

function buildLaunchdLabel(identity: BackgroundRuntimeIdentity): string {
  return [
    LAUNCHD_LABEL_PREFIX,
    sanitizeLaunchdSegment(identity.repo),
    sanitizeLaunchdSegment(identity.machineId),
    String(identity.healthPort),
  ].join('.')
}

function sanitizeLaunchdSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

function buildPathVariants(path: string): string[] {
  const variants = new Set([resolve(path)])

  try {
    variants.add(realpathSync(path))
  } catch {
    // ignore paths that do not yet exist
  }

  return [...variants]
}

function isSameOrChildPath(candidate: string, parent: string): boolean {
  const normalizedCandidate = resolve(candidate)
  const normalizedParent = resolve(parent)
  return normalizedCandidate === normalizedParent
    || normalizedCandidate.startsWith(`${normalizedParent}/`)
}

function isRetryableLaunchdBootstrapError(error: unknown): boolean {
  const message = formatLaunchdError(error).toLowerCase()
  return LAUNCHD_RETRYABLE_BOOTSTRAP_ERROR_PATTERNS.some((pattern) => message.includes(pattern))
}

function formatLaunchdError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function runLaunchctl(args: string[], options: LaunchctlOptions = {}): string {
  try {
    return execFileSync('launchctl', args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (error) {
    if (options.allowFailure) {
      return ''
    }

    throw new Error(formatLaunchctlFailure(args, error))
  }
}

function formatLaunchctlFailure(args: string[], error: unknown): string {
  const stderr = extractCommandOutput(error, 'stderr')
  const stdout = extractCommandOutput(error, 'stdout')
  const detail = stderr || stdout || 'unknown launchctl error'
  return `launchctl ${args.join(' ')} failed: ${detail}`
}

function extractCommandOutput(
  error: unknown,
  stream: 'stdout' | 'stderr',
): string {
  if (!error || typeof error !== 'object') return ''

  const value = Reflect.get(error, stream)
  if (typeof value === 'string') return value.trim()
  if (value instanceof Buffer) return value.toString('utf-8').trim()
  return ''
}
