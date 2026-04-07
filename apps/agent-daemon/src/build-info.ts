import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AgentLoopBuildInfo } from '@agent/shared'

export function buildAgentLoopBuildInfo(input: {
  packageVersion: string
  gitCommit: string | null
  gitBranch: string | null
  gitTag: string | null
  gitDirty: boolean | null
}): AgentLoopBuildInfo {
  return {
    version: input.packageVersion,
    gitCommit: input.gitCommit,
    gitCommitShort: input.gitCommit ? input.gitCommit.slice(0, 7) : null,
    gitBranch: input.gitBranch,
    buildSource: input.gitTag ? 'tag' : input.gitCommit ? 'dev' : 'package',
    buildDirty: input.gitDirty,
  }
}

export function coerceAgentLoopBuildInfo(value: unknown): AgentLoopBuildInfo | null {
  if (!value || typeof value !== 'object') return null

  const candidate = value as Partial<AgentLoopBuildInfo>
  if (typeof candidate.version !== 'string') return null
  if (
    candidate.gitCommit !== null
    && candidate.gitCommit !== undefined
    && typeof candidate.gitCommit !== 'string'
  ) {
    return null
  }
  if (
    candidate.gitCommitShort !== null
    && candidate.gitCommitShort !== undefined
    && typeof candidate.gitCommitShort !== 'string'
  ) {
    return null
  }
  if (
    candidate.gitBranch !== null
    && candidate.gitBranch !== undefined
    && typeof candidate.gitBranch !== 'string'
  ) {
    return null
  }
  if (
    candidate.buildSource !== 'tag'
    && candidate.buildSource !== 'package'
    && candidate.buildSource !== 'dev'
  ) {
    return null
  }
  if (
    candidate.buildDirty !== null
    && candidate.buildDirty !== undefined
    && typeof candidate.buildDirty !== 'boolean'
  ) {
    return null
  }

  return {
    version: candidate.version,
    gitCommit: candidate.gitCommit ?? null,
    gitCommitShort: candidate.gitCommitShort ?? null,
    gitBranch: candidate.gitBranch ?? null,
    buildSource: candidate.buildSource,
    buildDirty: candidate.buildDirty ?? null,
  }
}

export function readPackageVersion(repoRoot: string): string {
  const packageJsonPath = resolve(repoRoot, 'package.json')
  if (!existsSync(packageJsonPath)) return '0.0.0-dev'

  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version.length > 0
      ? parsed.version
      : '0.0.0-dev'
  } catch {
    return '0.0.0-dev'
  }
}

export function resolveAgentLoopBuildInfo(startDir = process.cwd()): AgentLoopBuildInfo {
  const repoRoot = readGitOutput(startDir, ['rev-parse', '--show-toplevel']) ?? startDir
  const packageVersion = readPackageVersion(repoRoot)
  const gitCommit = readGitOutput(repoRoot, ['rev-parse', 'HEAD'])
  const gitBranchValue = readGitOutput(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const gitBranch = gitBranchValue && gitBranchValue !== 'HEAD' ? gitBranchValue : null
  const gitTag = readGitOutput(repoRoot, ['describe', '--tags', '--exact-match', 'HEAD'])
  const gitDirtyOutput = readGitOutputAllowEmpty(repoRoot, ['status', '--porcelain'])

  return buildAgentLoopBuildInfo({
    packageVersion,
    gitCommit,
    gitBranch,
    gitTag,
    gitDirty: gitDirtyOutput === null ? null : gitDirtyOutput.length > 0,
  })
}

function readGitOutput(repoRoot: string, args: string[]): string | null {
  const output = readGitOutputAllowEmpty(repoRoot, args)
  return output && output.length > 0 ? output : null
}

function readGitOutputAllowEmpty(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}
