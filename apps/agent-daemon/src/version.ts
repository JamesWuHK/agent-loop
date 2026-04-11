import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  AgentConfig,
  AgentLoopBuildMetadata,
  AgentLoopUpgradeMetadata,
} from '@agent/shared'

export const DEFAULT_AGENT_LOOP_VERSION = '0.1.0'
export const DEFAULT_AGENT_LOOP_UPGRADE_CHECK_INTERVAL_MS = 15 * 60 * 1000
export const DEFAULT_AGENT_LOOP_UPGRADE_REMINDER_INTERVAL_MS = 60 * 60 * 1000

const AGENT_LOOP_REPO_ROOT = resolve(import.meta.dir, '../../..')
const AGENT_LOOP_PACKAGE_JSON_PATH = resolve(AGENT_LOOP_REPO_ROOT, 'package.json')
const AUTO_UPGRADE_IGNORED_LOCAL_PATH_PREFIXES = ['.runtime/'] as const

interface GitHubRepoRecord {
  default_branch?: unknown
}

interface GitHubBranchRecord {
  name?: unknown
  commit?: {
    sha?: unknown
    commit?: {
      committer?: {
        date?: unknown
      }
    }
  }
}

interface GitHubContentRecord {
  content?: unknown
  encoding?: unknown
}

interface VersionFileRecord {
  version?: unknown
}

interface ResolvedUpgradeTarget {
  repo: string
  channel: string
}

export interface AgentLoopLocalCommandResult {
  stdout: string
  stderr: string
}

export interface AgentLoopLocalUpgradeDependencies {
  runCommand: (
    command: string,
    args: string[],
    options?: {
      cwd?: string
    },
  ) => AgentLoopLocalCommandResult
}

const DEFAULT_AGENT_LOOP_LOCAL_UPGRADE_DEPENDENCIES: AgentLoopLocalUpgradeDependencies = {
  runCommand: runLocalCommand,
}

export function resolveAgentLoopBuildMetadata(): AgentLoopBuildMetadata {
  return {
    repo: detectGitHubRepoSlug(AGENT_LOOP_REPO_ROOT),
    version: readAgentLoopVersion(),
    revision: readGitOutput(['-C', AGENT_LOOP_REPO_ROOT, 'rev-parse', 'HEAD']),
  }
}

export function readAgentLoopVersion(): string {
  if (!existsSync(AGENT_LOOP_PACKAGE_JSON_PATH)) {
    return DEFAULT_AGENT_LOOP_VERSION
  }

  try {
    const parsed = JSON.parse(readFileSync(AGENT_LOOP_PACKAGE_JSON_PATH, 'utf-8')) as VersionFileRecord
    return typeof parsed.version === 'string' && parsed.version.trim().length > 0
      ? parsed.version.trim()
      : DEFAULT_AGENT_LOOP_VERSION
  } catch {
    return DEFAULT_AGENT_LOOP_VERSION
  }
}

export function abbreviateRevision(revision: string | null, length = 7): string {
  if (!revision) return 'unknown'
  return revision.slice(0, Math.max(1, length))
}

export function compareAgentLoopVersions(left: string, right: string): number {
  const leftParts = parseVersionParts(left)
  const rightParts = parseVersionParts(right)
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0
    const rightPart = rightParts[index] ?? 0
    if (leftPart < rightPart) return -1
    if (leftPart > rightPart) return 1
  }

  return 0
}

export function createInitialAgentLoopUpgradeMetadata(
  config: AgentConfig,
  build: AgentLoopBuildMetadata,
  safeToUpgradeNow = false,
): AgentLoopUpgradeMetadata {
  const policy = resolveAgentLoopUpgradePolicy(config, build)

  if (!policy.enabled) {
    return {
      enabled: false,
      repo: policy.repo,
      channel: policy.channel,
      checkedAt: null,
      status: 'disabled',
      latestVersion: null,
      latestRevision: null,
      latestCommitAt: null,
      safeToUpgradeNow,
      message: 'upgrade checks are disabled',
    }
  }

  return {
    enabled: true,
    repo: policy.repo,
    channel: policy.channel,
    checkedAt: null,
    status: 'unknown',
    latestVersion: null,
    latestRevision: null,
    latestCommitAt: null,
    safeToUpgradeNow,
    message: null,
  }
}

export function resolveAgentLoopUpgradePolicy(
  config: AgentConfig,
  build: AgentLoopBuildMetadata,
): {
  enabled: boolean
  repo: string | null
  channel: string | null
  checkIntervalMs: number
  reminderIntervalMs: number
  autoApply: boolean
} {
  return {
    enabled: config.upgrade?.enabled !== false,
    repo: normalizeOptionalString(config.upgrade?.repo) ?? build.repo,
    channel: normalizeOptionalString(config.upgrade?.channel),
    checkIntervalMs: normalizePositiveInteger(
      config.upgrade?.checkIntervalMs,
      DEFAULT_AGENT_LOOP_UPGRADE_CHECK_INTERVAL_MS,
    ),
    reminderIntervalMs: normalizePositiveInteger(
      config.upgrade?.reminderIntervalMs,
      DEFAULT_AGENT_LOOP_UPGRADE_REMINDER_INTERVAL_MS,
    ),
    autoApply: config.upgrade?.autoApply !== false,
  }
}

export function listLocalAgentLoopUpgradeDirtyPaths(
  porcelainStatusOutput: string,
): string[] {
  return porcelainStatusOutput
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length >= 4)
    .flatMap((line) => {
      const pathSpec = line.slice(3).trim()
      return pathSpec.includes(' -> ')
        ? pathSpec.split(' -> ').map((part) => part.trim()).filter(Boolean)
        : [pathSpec]
    })
    .filter((path) => !isIgnoredAutoUpgradeDirtyPath(path))
}

export function applyAgentLoopUpgradeToLocalCheckout(
  input: {
    build: AgentLoopBuildMetadata
    upgrade: Pick<AgentLoopUpgradeMetadata, 'channel' | 'repo'>
  },
  deps: AgentLoopLocalUpgradeDependencies = DEFAULT_AGENT_LOOP_LOCAL_UPGRADE_DEPENDENCIES,
): {
  currentBranch: string
  previousRevision: string | null
  nextRevision: string | null
  changed: boolean
} {
  if (!input.build.repo || !input.upgrade.repo || input.build.repo !== input.upgrade.repo) {
    throw new Error(
      `local agent-loop origin ${input.build.repo ?? 'unknown'} does not match upgrade repo ${input.upgrade.repo ?? 'unknown'}`,
    )
  }

  const channel = normalizeOptionalString(input.upgrade.channel)
  if (!channel) {
    throw new Error('agent-loop auto-upgrade requires a resolved channel name')
  }

  const dirtyPaths = listLocalAgentLoopUpgradeDirtyPaths(
    deps.runCommand('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: AGENT_LOOP_REPO_ROOT,
    }).stdout,
  )
  if (dirtyPaths.length > 0) {
    throw new Error(`agent-loop checkout has local changes: ${dirtyPaths.join(', ')}`)
  }

  const currentBranch = deps.runCommand('git', ['branch', '--show-current'], {
    cwd: AGENT_LOOP_REPO_ROOT,
  }).stdout.trim()
  if (!currentBranch) {
    throw new Error('agent-loop auto-upgrade requires a checked-out local branch')
  }
  if (currentBranch !== channel) {
    throw new Error(`agent-loop auto-upgrade requires current branch ${channel}, found ${currentBranch}`)
  }

  const previousRevision = normalizeOptionalString(
    deps.runCommand('git', ['rev-parse', 'HEAD'], {
      cwd: AGENT_LOOP_REPO_ROOT,
    }).stdout,
  )

  deps.runCommand('git', ['pull', '--ff-only', 'origin', channel], {
    cwd: AGENT_LOOP_REPO_ROOT,
  })
  deps.runCommand(process.execPath, ['install', '--frozen-lockfile'], {
    cwd: AGENT_LOOP_REPO_ROOT,
  })

  const nextRevision = normalizeOptionalString(
    deps.runCommand('git', ['rev-parse', 'HEAD'], {
      cwd: AGENT_LOOP_REPO_ROOT,
    }).stdout,
  )

  return {
    currentBranch,
    previousRevision,
    nextRevision,
    changed: previousRevision !== nextRevision,
  }
}

export async function checkForAgentLoopUpgrade(
  config: AgentConfig,
  build: AgentLoopBuildMetadata,
  safeToUpgradeNow: boolean,
): Promise<AgentLoopUpgradeMetadata> {
  const checkedAt = new Date().toISOString()
  const policy = resolveAgentLoopUpgradePolicy(config, build)

  if (!policy.enabled) {
    return {
      ...createInitialAgentLoopUpgradeMetadata(config, build, safeToUpgradeNow),
      checkedAt,
      safeToUpgradeNow,
    }
  }

  if (!policy.repo) {
    return {
      enabled: true,
      repo: null,
      channel: policy.channel,
      checkedAt,
      status: 'error',
      latestVersion: null,
      latestRevision: null,
      latestCommitAt: null,
      safeToUpgradeNow,
      message: 'agent-loop upgrade repo could not be resolved',
    }
  }

  try {
    const target = await resolveUpgradeTarget(policy.repo, policy.channel, config.pat)
    const branch = await requestGitHubJson<GitHubBranchRecord>(
      `https://api.github.com/repos/${target.repo}/branches/${encodeURIComponent(target.channel)}`,
      config.pat,
    )
    const remotePackage = await requestGitHubJson<GitHubContentRecord>(
      `https://api.github.com/repos/${target.repo}/contents/package.json?ref=${encodeURIComponent(target.channel)}`,
      config.pat,
    )

    const latestVersion = extractVersionFromGitHubContent(remotePackage)
    const latestRevision = typeof branch.commit?.sha === 'string' && branch.commit.sha.length > 0
      ? branch.commit.sha
      : null
    const latestCommitAt = typeof branch.commit?.commit?.committer?.date === 'string'
      ? branch.commit.commit.committer.date
      : null

    const message = describeUpgradeState({
      build,
      latestVersion,
      latestRevision,
      channel: target.channel,
    })

    return {
      enabled: true,
      repo: target.repo,
      channel: target.channel,
      checkedAt,
      status: message.status,
      latestVersion,
      latestRevision,
      latestCommitAt,
      safeToUpgradeNow,
      message: message.message,
    }
  } catch (error) {
    return {
      enabled: true,
      repo: policy.repo,
      channel: policy.channel,
      checkedAt,
      status: 'error',
      latestVersion: null,
      latestRevision: null,
      latestCommitAt: null,
      safeToUpgradeNow,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

function describeUpgradeState(input: {
  build: AgentLoopBuildMetadata
  latestVersion: string
  latestRevision: string | null
  channel: string
}): {
  status: AgentLoopUpgradeMetadata['status']
  message: string
} {
  const versionComparison = compareAgentLoopVersions(input.build.version, input.latestVersion)

  if (versionComparison < 0) {
    return {
      status: 'upgrade-available',
      message: `channel ${input.channel} is newer: local v${input.build.version}, latest v${input.latestVersion}`,
    }
  }

  if (versionComparison > 0) {
    return {
      status: 'ahead-of-channel',
      message: `local build v${input.build.version} is ahead of channel ${input.channel} v${input.latestVersion}`,
    }
  }

  if (!input.build.revision || !input.latestRevision) {
    return {
      status: 'unknown',
      message: `local and latest versions are both v${input.latestVersion}, but one side is missing a git revision`,
    }
  }

  if (input.build.revision === input.latestRevision) {
    return {
      status: 'up-to-date',
      message: `running latest ${input.channel} revision ${abbreviateRevision(input.latestRevision)}`,
    }
  }

  return {
    status: 'upgrade-available',
    message: `channel ${input.channel} has a newer revision on the same version v${input.latestVersion}`,
  }
}

async function resolveUpgradeTarget(
  repo: string,
  channel: string | null,
  pat: string,
): Promise<ResolvedUpgradeTarget> {
  if (channel) {
    return { repo, channel }
  }

  const repoRecord = await requestGitHubJson<GitHubRepoRecord>(
    `https://api.github.com/repos/${repo}`,
    pat,
  )
  const defaultBranch = typeof repoRecord.default_branch === 'string' && repoRecord.default_branch.trim().length > 0
    ? repoRecord.default_branch.trim()
    : 'master'

  return {
    repo,
    channel: defaultBranch,
  }
}

async function requestGitHubJson<T>(
  url: string,
  pat: string,
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  }
  if (pat) {
    headers.Authorization = `token ${pat}`
  }

  const response = await fetch(url, { headers })
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`GitHub request failed (${response.status}): ${parseGitHubErrorMessage(body)}`)
  }

  return JSON.parse(body) as T
}

function extractVersionFromGitHubContent(record: GitHubContentRecord): string {
  if (record.encoding !== 'base64' || typeof record.content !== 'string') {
    throw new Error('remote package.json response did not contain base64 content')
  }

  const decoded = Buffer.from(record.content.replace(/\n/g, ''), 'base64').toString('utf-8')
  const parsed = JSON.parse(decoded) as VersionFileRecord
  if (typeof parsed.version !== 'string' || parsed.version.trim().length === 0) {
    throw new Error('remote package.json did not include a version field')
  }

  return parsed.version.trim()
}

function parseGitHubErrorMessage(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) return 'empty response body'

  try {
    const parsed = JSON.parse(trimmed) as { message?: unknown }
    if (typeof parsed.message === 'string' && parsed.message.trim().length > 0) {
      return parsed.message.trim()
    }
  } catch {
    // fall through to raw body
  }

  return trimmed
}

function parseVersionParts(version: string): number[] {
  const [core] = version.trim().split('-')
  return (core ?? version)
    .split('.')
    .map((segment) => Number.parseInt(segment, 10))
    .map((value) => (Number.isFinite(value) ? value : 0))
}

function detectGitHubRepoSlug(repoRoot: string): string | null {
  const remoteUrl = readGitOutput(['-C', repoRoot, 'remote', 'get-url', 'origin'])
  if (!remoteUrl) return null

  const match =
    remoteUrl.match(/github\.com[/:]([\w-]+\/[\w.-]+?)(?:\.git)?$/)
    ?? remoteUrl.match(/^https:\/\/github\.com\/([\w-]+\/[\w.-]+?)(?:\.git)?$/)

  return match?.[1] ?? null
}

function readGitOutput(args: string[]): string | null {
  try {
    const output = execFileSync('git', args, { encoding: 'utf-8' }).trim()
    return output.length > 0 ? output : null
  } catch {
    return null
  }
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : fallback
}

function isIgnoredAutoUpgradeDirtyPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^"\.\//, '').replace(/^\.\//, '')
  return AUTO_UPGRADE_IGNORED_LOCAL_PATH_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))
}

function runLocalCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string
  } = {},
): AgentLoopLocalCommandResult {
  try {
    return {
      stdout: execFileSync(command, args, {
        cwd: options.cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      stderr: '',
    }
  } catch (error) {
    const stdout = typeof error === 'object' && error !== null && 'stdout' in error && typeof error.stdout === 'string'
      ? error.stdout
      : ''
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error && typeof error.stderr === 'string'
      ? error.stderr
      : error instanceof Error
        ? error.message
        : String(error)
    throw new Error(`${command} ${args.join(' ')} failed: ${(stderr || stdout).trim() || 'unknown command failure'}`)
  }
}
