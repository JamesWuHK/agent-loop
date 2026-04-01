import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import type { AgentConfig } from '@agent/shared'

const CONFIG_DIR = resolve(homedir(), '.agent-loop')
const CONFIG_PATH = resolve(CONFIG_DIR, 'config.json')

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

  let fileConfig: Partial<AgentConfig> = {}
  if (existsSync(CONFIG_PATH)) {
    try {
      fileConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    } catch (err) {
      console.error(`[config] failed to parse ${CONFIG_PATH}:`, err)
    }
  }

  const machineId =
    args.machineId ??
    fileConfig.machineId ??
    generateMachineId()

  const repo =
    args.repo ??
    fileConfig.repo ??
    guessRepoFromGit()

  const pat =
    args.pat ??
    process.env.GITHUB_TOKEN ??
    process.env.GH_TOKEN ??
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
    worktreesBase: resolve(homedir(), '.agent-worktrees', repo.replace('/', '-')),
    agent: {
      primary: fileConfig.agent?.primary ?? 'claude',
      fallback: fileConfig.agent?.fallback ?? 'codex',
      claudePath: fileConfig.agent?.claudePath ?? 'claude',
      codexPath: fileConfig.agent?.codexPath ?? 'codex',
      timeoutMs: fileConfig.agent?.timeoutMs ?? 30 * 60 * 1000, // 30 min default
    },
    git: {
      defaultBranch: fileConfig.git?.defaultBranch ?? 'main',
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
    const stdout = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim()
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

export { CONFIG_DIR, CONFIG_PATH }
