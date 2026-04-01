import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { AgentConfig, WorktreeInfo } from '@agent/shared'
import { getPrState } from '@agent/shared'

/**
 * Run a git subcommand synchronously, returning stdout or throwing on error.
 * Only use this for expected-to-succeed operations (create, remove).
 */
function gitSync(...args: string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * Run a git subcommand that may fail (e.g. list worktrees outside a repo).
 * Returns { exitCode, stdout, stderr } without throwing.
 */
function gitCheck(...args: string[]): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('git', args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { exitCode: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number; stderr?: string }
    return {
      exitCode: e.status ?? 1,
      stdout: (e as unknown as { stdout?: string }).stdout ?? '',
      stderr: e.stderr ?? String(e),
    }
  }
}

/**
 * Validate branch name to prevent injection attacks.
 * Git branch names must not contain: whitespace, ~, ^, :, *, ?, [, ], \, or NUL.
 */
function validateBranchName(branch: string): void {
  // Allow only safe characters: alphanumeric, hyphen, underscore, forward slash
  if (!/^[a-zA-Z0-9/_-]+$/.test(branch)) {
    throw new WorktreeError(`Invalid branch name: contains forbidden characters: ${branch}`)
  }

  // Git branch name cannot start with '-' or '.' or end with '/'
  if (/^[-.]|[\/]$/.test(branch)) {
    throw new WorktreeError(`Invalid branch name: cannot start with '-' or '.', or end with '/': ${branch}`)
  }

  // Check for empty segments (consecutive slashes or leading/trailing slashes after split)
  const segments = branch.split('/')
  for (const segment of segments) {
    if (segment === '') {
      throw new WorktreeError(`Invalid branch name: empty segment: ${branch}`)
    }
  }
}

/**
 * Check if a branch exists locally or on the remote.
 */
function branchExists(branch: string): boolean {
  // Check local branches
  const localResult = gitCheck('branch', '--list', branch)
  if (localResult.exitCode === 0 && localResult.stdout.trim() !== '') {
    return true
  }

  // Check remote branches (allow failure - just means it doesn't exist on remote)
  gitCheck('fetch', '--quiet', 'origin', branch)

  const remoteResult = gitCheck('rev-parse', '--verify', `origin/${branch}`)
  return remoteResult.exitCode === 0
}

/**
 * Create a new worktree for the given issue.
 * The branch name is globally unique: agent/{issue}/{machineId}
 */
export async function createWorktree(
  issueNumber: number,
  config: AgentConfig,
): Promise<string> {
  const branch = `agent/${issueNumber}/${config.machineId}`

  // Validate branch name to prevent injection attacks
  validateBranchName(branch)

  const worktreePath = resolve(config.worktreesBase, `issue-${issueNumber}-${config.machineId}`)

  // Ensure base directory exists
  if (!existsSync(config.worktreesBase)) {
    mkdirSync(config.worktreesBase, { recursive: true })
  }

  // Check if worktree already exists
  if (existsSync(worktreePath)) {
    console.log(`[worktree] worktree already exists at ${worktreePath}, skipping create`)
    return worktreePath
  }

  // Check if branch already exists (from a previous failed run)
  if (branchExists(branch)) {
    console.log(`[worktree] branch '${branch}' already exists, removing stale branch`)
    // Delete the stale branch to allow recreation
    gitCheck('branch', '-D', branch)
  }

  // Create worktree with unique branch based on origin/{defaultBranch}
  try {
    gitSync('worktree', 'add', worktreePath, '-b', branch, `origin/${config.git.defaultBranch}`)
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string }
    throw new WorktreeError(`git worktree add failed: ${e.stderr ?? String(err)}`)
  }

  // Configure git author for this worktree
  gitSync('-C', worktreePath, 'config', 'user.name', config.git.authorName)
  gitSync('-C', worktreePath, 'config', 'user.email', config.git.authorEmail)

  console.log(`[worktree] created ${worktreePath} (branch: ${branch})`)
  return worktreePath
}

/**
 * Remove a worktree after task completion or failure.
 */
export async function removeWorktree(
  worktreePath: string,
  branch: string,
  force = false,
): Promise<void> {
  const args = ['worktree', 'remove', worktreePath]
  if (force) args.push('--force')

  const result = gitCheck(...args)

  if (result.exitCode !== 0) {
    console.warn(`[worktree] remove failed (may already be removed): ${result.stderr.trim()}`)
    return
  }

  // Also delete the branch
  gitCheck('branch', '-D', branch)
  console.log(`[worktree] removed ${worktreePath}`)
}

/**
 * List all worktrees for this machine.
 */
export async function listWorktrees(config: AgentConfig): Promise<WorktreeInfo[]> {
  const result = gitCheck('worktree', 'list', '--json')

  if (result.exitCode !== 0) {
    // Not in a git repository — return empty list
    return []
  }

  let worktrees: { path: string; branch: string; detached: boolean }[] = []
  try {
    worktrees = JSON.parse(result.stdout)
  } catch {
    return []
  }

  return worktrees
    .filter((wt) => wt.path.startsWith(config.worktreesBase) && !wt.detached)
    .map((wt) => {
      const match = wt.branch.match(/^agent\/(\d+)\/(.+)$/)
      return {
        path: wt.path,
        branch: wt.branch,
        issueNumber: match ? parseInt(match[1]!) : 0,
        machineId: match ? match[2]! : 'unknown',
        state: 'active' as const,
        createdAt: new Date().toISOString(),
      }
    })
    .filter((wt) => wt.machineId === config.machineId)
}

/**
 * Clean up orphaned worktrees on startup.
 * A worktree is orphaned if its PR is merged or closed.
 */
export async function cleanupOrphanedWorktrees(config: AgentConfig): Promise<void> {
  const worktrees = await listWorktrees(config)

  for (const wt of worktrees) {
    const prState = await getPrState(wt.branch, config)

    if (prState === 'merged' || prState === 'closed') {
      console.log(`[worktree] cleaning up orphaned worktree ${wt.path} (PR is ${prState})`)
      await removeWorktree(wt.path, wt.branch, true)
    }
  }
}

export class WorktreeError extends Error {
  name = 'WorktreeError'
}

/**
 * Check whether a worktree exists locally for the given issue + machineId.
 * Only matches worktrees owned by this machine.
 */
export function hasWorktreeForIssue(issueNumber: number, config: AgentConfig): boolean {
  const worktreePath = resolve(config.worktreesBase, `issue-${issueNumber}-${config.machineId}`)
  return existsSync(worktreePath)
}
