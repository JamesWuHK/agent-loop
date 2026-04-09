import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type {
  AgentConfig,
  ProjectProfileName,
  ProjectPromptContext,
  ProjectPromptGuidanceOverrides,
} from '@agent/shared'

const CONFIG_DIR = resolve(homedir(), '.agent-loop')
const CONFIG_PATH = resolve(CONFIG_DIR, 'config.json')
const REPO_CONFIG_DIR = '.agent-loop'
const REPO_CONFIG_FILE = 'project.json'

export interface RepoLocalConfig {
  project?: {
    profile?: ProjectProfileName
    promptGuidance?: ProjectPromptGuidanceOverrides
    maxConcurrency?: number
  }
  agent?: {
    primary?: AgentConfig['agent']['primary']
    fallback?: AgentConfig['agent']['fallback']
  }
  git?: {
    defaultBranch?: string
  }
}

export interface LocalDaemonIdentity {
  repo: string
  machineId: string
}

export interface CliArgs {
  repo?: string
  pat?: string
  concurrency?: number
  pollIntervalMs?: number
  machineId?: string
  dryRun?: boolean
  once?: boolean // run one iteration then exit
  healthHost?: string
  healthPort?: number
}

/**
 * Load config from ~/.agent-loop/config.json, with env var / CLI arg overrides.
 */
export function loadConfig(args: CliArgs = {}): AgentConfig {
  ensureConfigDir()

  const fileConfig = readConfigFile()
  const repoConfig = loadRepoLocalConfig()

  return buildConfig(args, {
    fileConfig,
    repoConfig,
  })
}

export function resolveLocalDaemonIdentity(
  args: Pick<CliArgs, 'repo' | 'machineId'> = {},
  options: {
    fileConfig?: Partial<AgentConfig>
    repoGuess?: string | null
    persistGeneratedMachineId?: boolean
  } = {},
): LocalDaemonIdentity {
  ensureConfigDir()

  const fileConfig: Partial<AgentConfig> =
    options.fileConfig ?? readConfigFile()
  const machineId = args.machineId ?? fileConfig.machineId ?? generateMachineId()
  const repo = args.repo ?? fileConfig.repo ?? options.repoGuess ?? guessRepoFromGit()

  if (!fileConfig.machineId && options.persistGeneratedMachineId !== false) {
    saveConfigPartial({ machineId })
  }

  if (!repo) {
    throw new ConfigError(
      'No repo specified. Pass --repo or run inside a git repo with a GitHub remote.',
    )
  }

  return {
    repo,
    machineId,
  }
}

export function buildConfig(
  args: CliArgs = {},
  options: {
    fileConfig?: Partial<AgentConfig>
    repoConfig?: RepoLocalConfig
    env?: NodeJS.ProcessEnv
    repoGuess?: string | null
    homeDir?: string
    ghAuthToken?: string | null
  } = {},
): AgentConfig {
  const fileConfig = options.fileConfig ?? {}
  const repoConfig = options.repoConfig ?? {}
  const env = options.env ?? process.env
  const homeDir = options.homeDir ?? homedir()
  const requestedConcurrency = args.concurrency ?? fileConfig.concurrency ?? 1
  const projectProfile = repoConfig.project?.profile ?? fileConfig.project?.profile ?? 'generic'
  const heartbeatIntervalMs = normalizePositiveInteger(
    fileConfig.recovery?.heartbeatIntervalMs,
    30_000,
  )
  const leaseTtlMs = normalizePositiveInteger(
    fileConfig.recovery?.leaseTtlMs,
    heartbeatIntervalMs * 2,
  )
  const workerIdleTimeoutMs = normalizePositiveInteger(
    fileConfig.recovery?.workerIdleTimeoutMs,
    5 * 60 * 1000,
  )
  const leaseNoProgressTimeoutMs = normalizePositiveInteger(
    fileConfig.recovery?.leaseNoProgressTimeoutMs,
    workerIdleTimeoutMs + leaseTtlMs,
  )
  const scheduling = {
    concurrencyByRepo: fileConfig.scheduling?.concurrencyByRepo ?? {},
    concurrencyByProfile: fileConfig.scheduling?.concurrencyByProfile ?? {},
  }
  const identity = resolveLocalDaemonIdentity(
    {
      repo: args.repo,
      machineId: args.machineId,
    },
    {
      fileConfig,
      repoGuess: options.repoGuess,
    },
  )
  const { machineId, repo } = identity

  const pat = resolveGitHubToken({
    cliPat: args.pat,
    env,
    filePat: fileConfig.pat,
    ghAuthToken: options.ghAuthToken,
  })
  const hasGhCliSession = pat.length === 0 && canUseGhCliSession(homeDir)

  if (!pat && !hasGhCliSession) {
    throw new ConfigError(
      'No GitHub PAT found. Set GITHUB_TOKEN/GH_TOKEN, configure pat in ~/.agent-loop/config.json, or log in with gh auth login',
    )
  }

  const concurrencyPolicy = resolveConcurrencyPolicy({
    requested: requestedConcurrency,
    repoCap: scheduling.concurrencyByRepo[repo] ?? null,
    profileCap: scheduling.concurrencyByProfile[projectProfile] ?? null,
    projectCap: repoConfig.project?.maxConcurrency ?? fileConfig.project?.maxConcurrency ?? null,
  })
  const agentFallback =
    repoConfig.agent && Object.prototype.hasOwnProperty.call(repoConfig.agent, 'fallback')
      ? (repoConfig.agent.fallback ?? null)
      : fileConfig.agent && Object.prototype.hasOwnProperty.call(fileConfig.agent, 'fallback')
        ? (fileConfig.agent.fallback ?? null)
        : 'claude'

  const config: AgentConfig = {
    machineId,
    repo,
    pat,
    pollIntervalMs: args.pollIntervalMs ?? fileConfig.pollIntervalMs ?? 60_000,
    concurrency: concurrencyPolicy.effective,
    requestedConcurrency,
    concurrencyPolicy,
    scheduling,
    recovery: {
      heartbeatIntervalMs,
      leaseTtlMs,
      workerIdleTimeoutMs,
      leaseAdoptionBackoffMs: normalizePositiveInteger(
        fileConfig.recovery?.leaseAdoptionBackoffMs,
        5_000,
      ),
      leaseNoProgressTimeoutMs,
    },
    worktreesBase: resolve(homeDir, '.agent-worktrees', repo.replace('/', '-')),
    project: {
      profile: projectProfile,
      promptGuidance: mergePromptGuidance(
        fileConfig.project?.promptGuidance,
        repoConfig.project?.promptGuidance,
      ),
      maxConcurrency: repoConfig.project?.maxConcurrency ?? fileConfig.project?.maxConcurrency,
    },
    agent: {
      primary: repoConfig.agent?.primary ?? fileConfig.agent?.primary ?? 'codex',
      fallback: agentFallback,
      claudePath: fileConfig.agent?.claudePath ?? 'claude',
      codexPath: fileConfig.agent?.codexPath ?? 'codex',
      codexBaseUrl:
        env.OPENAI_BASE_URL ??
        env.OPENAI_API_BASE ??
        env.OPENAI_API_URL ??
        env.OPENAI_BASE ??
        fileConfig.agent?.codexBaseUrl,
      timeoutMs: fileConfig.agent?.timeoutMs ?? 30 * 60 * 1000, // 30 min default
    },
    git: {
      defaultBranch: repoConfig.git?.defaultBranch ?? fileConfig.git?.defaultBranch ?? 'main',
      authorName: fileConfig.git?.authorName ?? 'agent-loop',
      authorEmail: fileConfig.git?.authorEmail ?? 'agent-loop@local',
    },
  }

  // Persist machineId if newly generated
  if (!fileConfig.machineId) {
    saveConfigPartial({ machineId: config.machineId })
  }

  return config
}

function generateMachineId(): string {
  // UUID v4
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function guessRepoFromGit(): string | null {
  try {
    const stdout = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf-8' }).trim()
    // git@github.com:owner/repo.git or https://github.com/owner/repo.git
    const match =
      stdout.match(/github\.com[/:]([\w-]+\/[\w.-]+?)(\.git)?$/) ??
      stdout.match(/^https:\/\/github\.com\/([\w-]+\/[\w.-]+?)(\.git)?$/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true })
  }
}

function findRepoRoot(startDir = process.cwd()): string | null {
  try {
    return execFileSync('git', ['-C', startDir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
    }).trim()
  } catch {
    return null
  }
}

export function loadRepoLocalConfig(startDir = process.cwd()): RepoLocalConfig {
  const repoRoot = findRepoRoot(startDir)
  if (!repoRoot) return {}

  return loadJsonFile<RepoLocalConfig>(
    resolve(repoRoot, REPO_CONFIG_DIR, REPO_CONFIG_FILE),
  )
}

export function readConfigFile(path = CONFIG_PATH): Partial<AgentConfig> {
  return loadJsonFile<Partial<AgentConfig>>(path) as Partial<AgentConfig>
}

function loadJsonFile<T extends object>(path: string): T | {} {
  if (!existsSync(path)) {
    return {}
  }

  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch (err) {
    console.error(`[config] failed to parse ${path}:`, err)
    return {}
  }
}

function resolveGitHubToken(input: {
  cliPat?: string
  env: NodeJS.ProcessEnv
  filePat?: string
  ghAuthToken?: string | null
}): string {
  const candidates = [
    input.cliPat,
    input.env.GITHUB_TOKEN,
    input.env.GH_TOKEN,
    input.filePat,
    input.ghAuthToken,
  ]

  for (const candidate of candidates) {
    const normalized = normalizeNonEmptyString(candidate)
    if (normalized) return normalized
  }

  return ''
}

function canUseGhCliSession(homeDir = homedir()): boolean {
  const hostsPath = resolve(homeDir, '.config', 'gh', 'hosts.yml')
  if (!existsSync(hostsPath)) {
    return false
  }

  try {
    const hostsFile = readFileSync(hostsPath, 'utf-8')
    return hostsFile.includes('github.com:')
  } catch {
    return false
  }
}

function mergePromptGuidance(
  globalGuidance?: ProjectPromptGuidanceOverrides,
  repoGuidance?: ProjectPromptGuidanceOverrides,
): ProjectPromptGuidanceOverrides | undefined {
  const merged: ProjectPromptGuidanceOverrides = {}
  const contexts: ProjectPromptContext[] = ['planning', 'implementation', 'reviewFix', 'recovery']

  for (const context of contexts) {
    const lines = [
      ...(globalGuidance?.[context] ?? []),
      ...(repoGuidance?.[context] ?? []),
    ]

    if (lines.length > 0) {
      merged[context] = lines
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined
}

export function writeConfigFile(config: Record<string, unknown>, path = CONFIG_PATH): void {
  ensureConfigDir()
  writeFileSync(path, JSON.stringify(config, null, 2))
}

function saveConfigPartial(partial: Record<string, unknown>): void {
  const existing = readConfigFile() as Record<string, unknown>
  const merged = { ...existing, ...partial }
  writeConfigFile(merged)
}

export class ConfigError extends Error {
  name = 'ConfigError'
}

function resolveConcurrencyPolicy(input: {
  requested: number
  repoCap: number | null
  profileCap: number | null
  projectCap: number | null
}) {
  const requested = normalizePositiveInteger(input.requested, 1)
  const repoCap = normalizeOptionalPositiveInteger(input.repoCap)
  const profileCap = normalizeOptionalPositiveInteger(input.profileCap)
  const projectCap = normalizeOptionalPositiveInteger(input.projectCap)
  const caps = [requested, repoCap, profileCap, projectCap].filter(
    (value): value is number => value !== null,
  )

  return {
    requested,
    effective: Math.max(1, Math.min(...caps)),
    repoCap,
    profileCap,
    projectCap,
  }
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const normalized = normalizeOptionalPositiveInteger(value)
  return normalized ?? fallback
}

function normalizeOptionalPositiveInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const integer = Math.trunc(value)
  return integer >= 1 ? integer : null
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export { CONFIG_DIR, CONFIG_PATH, REPO_CONFIG_DIR, REPO_CONFIG_FILE }
