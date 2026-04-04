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

interface RepoLocalConfig {
  project?: {
    profile?: ProjectProfileName
    promptGuidance?: ProjectPromptGuidanceOverrides
  }
  agent?: {
    primary?: AgentConfig['agent']['primary']
    fallback?: AgentConfig['agent']['fallback']
  }
  git?: {
    defaultBranch?: string
  }
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

  const fileConfig = loadJsonFile<Partial<AgentConfig>>(CONFIG_PATH)
  const repoConfig = loadRepoLocalConfig()

  return buildConfig(args, {
    fileConfig,
    repoConfig,
  })
}

export function buildConfig(
  args: CliArgs = {},
  options: {
    fileConfig?: Partial<AgentConfig>
    repoConfig?: RepoLocalConfig
    env?: NodeJS.ProcessEnv
    repoGuess?: string | null
    homeDir?: string
  } = {},
): AgentConfig {
  const fileConfig = options.fileConfig ?? {}
  const repoConfig = options.repoConfig ?? {}
  const env = options.env ?? process.env
  const homeDir = options.homeDir ?? homedir()

  const machineId =
    args.machineId ??
    fileConfig.machineId ??
    generateMachineId()

  const repo =
    args.repo ??
    fileConfig.repo ??
    options.repoGuess ??
    guessRepoFromGit()

  const pat =
    args.pat ??
    env.GITHUB_TOKEN ??
    env.GH_TOKEN ??
    fileConfig.pat ??
    ''

  if (!pat) {
    throw new ConfigError(
      'No GitHub PAT found. Set GITHUB_TOKEN env var or configure pat in ~/.agent-loop/config.json',
    )
  }

  if (!repo) {
    throw new ConfigError(
      'No repo specified. Pass --repo or run inside a git repo with a GitHub remote.',
    )
  }

  const config: AgentConfig = {
    machineId,
    repo,
    pat,
    pollIntervalMs: args.pollIntervalMs ?? fileConfig.pollIntervalMs ?? 60_000,
    concurrency: args.concurrency ?? fileConfig.concurrency ?? 1,
    worktreesBase: resolve(homeDir, '.agent-worktrees', repo.replace('/', '-')),
    project: {
      profile: repoConfig.project?.profile ?? fileConfig.project?.profile ?? 'generic',
      promptGuidance: mergePromptGuidance(
        fileConfig.project?.promptGuidance,
        repoConfig.project?.promptGuidance,
      ),
    },
    agent: {
      primary: repoConfig.agent?.primary ?? fileConfig.agent?.primary ?? 'codex',
      fallback: repoConfig.agent?.fallback ?? fileConfig.agent?.fallback ?? 'claude',
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

function loadRepoLocalConfig(startDir = process.cwd()): RepoLocalConfig {
  const repoRoot = findRepoRoot(startDir)
  if (!repoRoot) return {}

  return loadJsonFile<RepoLocalConfig>(
    resolve(repoRoot, REPO_CONFIG_DIR, REPO_CONFIG_FILE),
  )
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

function saveConfigPartial(partial: Record<string, unknown>): void {
  const existing: Record<string, unknown> = existsSync(CONFIG_PATH)
    ? JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    : {}
  const merged = { ...existing, ...partial }
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2))
}

export class ConfigError extends Error {
  name = 'ConfigError'
}

export { CONFIG_DIR, CONFIG_PATH, REPO_CONFIG_DIR, REPO_CONFIG_FILE }
