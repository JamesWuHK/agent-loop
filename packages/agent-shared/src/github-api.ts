/// <reference types="bun-types" />
import { $ } from 'bun'
import { writeFileSync } from 'node:fs'
import type { AgentConfig, ClaimEvent, GitHubIssue } from './types'
import { ISSUE_LABELS } from './types'
import { inferState, buildEventComment } from './state-machine'

const TMP_COMMENT_FILE = '/tmp/agent-loop-comment.txt'
const TMP_BODY_FILE = '/tmp/agent-loop-body.txt'

// ─── gh CLI wrapper ───────────────────────────────────────────────────────────

async function ghRaw(
  cmd: string,
  config: AgentConfig,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await $`gh ${cmd} --repo ${config.repo}`.env({
    ...process.env,
    GH_TOKEN: config.pat,
  }).quiet()

  return {
    stdout: await new Response(result.stdout).text(),
    stderr: await new Response(result.stderr).text(),
    exitCode: result.exitCode,
  }
}

export class GhError extends Error {
  constructor(
    public cmd: string,
    public exitCode: number,
    public stderr: string,
  ) {
    super(`gh ${cmd} failed (exit ${exitCode}): ${stderr}`)
    this.name = 'GhError'
  }
}

// ─── GraphQL: fetch claimable issues ─────────────────────────────────────────

/**
 * Fetch all open issues with 'agent:ready' label that are not yet claimed.
 * Uses GraphQL for efficiency (1 API call for up to 100 issues).
 */
export async function fetchClaimableIssues(
  config: AgentConfig,
): Promise<import('./types').AgentIssue[]> {
  const query = `query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      issues(
        first: 100
        orderBy: { field: UPDATED_AT, direction: ASC }
        states: OPEN
      ) {
        nodes {
          number
          title
          body
          state
          labels(first: 20) { nodes { name } }
          assignees(first: 1) { nodes { login } }
          updatedAt
          url
        }
      }
    }
  }`.replace(/\n/g, ' ')

  const [owner, repoName] = config.repo.split('/')

  const result = await $`
    gh api graphql
    --repo ${config.repo}
    --field query=${query}
  `.env({ ...process.env, GH_TOKEN: config.pat }).quiet()

  const stdout = await new Response(result.stdout).text()
  const data = JSON.parse(stdout)

  const issues: GitHubIssue[] = data.data?.repository?.issues?.nodes ?? []

  return issues
    .map((issue: GitHubIssue) => {
      const labels = issue.labels.map((l: { name: string }) => l.name)
      const state = inferState(labels)
      const assignee = issue.assignees[0]?.login ?? null
      return {
        number: issue.number,
        title: issue.title,
        body: issue.body ?? '',
        state,
        labels,
        assignee,
        isClaimable: state === 'ready' && assignee === null,
        updatedAt: issue.updatedAt,
      } as import('./types').AgentIssue
    })
    .filter((issue: import('./types').AgentIssue) => issue.isClaimable)
}

// ─── Claim: atomic assign + label ─────────────────────────────────────────────

export interface ClaimResult {
  success: boolean
  issueNumber: number
  reason: 'claimed' | 'already-claimed' | 'rate-limited' | 'error'
}

/**
 * Atomically claim an issue by setting assignee + adding agent:claimed label.
 * Returns 'already-claimed' if GitHub returns 422 (assignee conflict).
 */
export async function claimIssue(
  issueNumber: number,
  config: AgentConfig,
  machineId: string,
): Promise<ClaimResult> {
  const { stdout, stderr, exitCode } = await ghRaw(
    `issue edit ${issueNumber} --add-label "${ISSUE_LABELS.CLAIMED}" --assignee "@me"`,
    config,
  )

  if (exitCode === 0) {
    // Append claim event comment via temp file to avoid shell escaping issues
    const event: ClaimEvent = {
      event: 'claimed',
      machine: machineId,
      ts: new Date().toISOString(),
      worktreeId: `issue-${issueNumber}-${machineId}`,
    }
    writeFileSync(TMP_COMMENT_FILE, buildEventComment(event), 'utf-8')
    await ghRaw(
      `issue comment ${issueNumber} --body-file "${TMP_COMMENT_FILE}"`,
      config,
    )
    return { success: true, issueNumber, reason: 'claimed' }
  }

  if (stderr.includes('422') || stderr.includes('already assigned')) {
    return { success: false, issueNumber, reason: 'already-claimed' }
  }

  if (stderr.includes('403') || stderr.includes('rate limit')) {
    return { success: false, issueNumber, reason: 'rate-limited' }
  }

  throw new GhError(`issue edit ${issueNumber}`, exitCode, stderr)
}

// ─── Update issue state ───────────────────────────────────────────────────────

export async function transitionIssueState(
  issueNumber: number,
  addLabel: string,
  removeLabel: string | null,
  event: ClaimEvent,
  config: AgentConfig,
): Promise<void> {
  const editParts: string[] = [`issue edit ${issueNumber}`, `--add-label "${addLabel}"`]
  if (removeLabel) editParts.push(`--remove-label "${removeLabel}"`)
  await ghRaw(editParts.join(' '), config)

  // Add event comment via temp file (gh issue edit has no --comment-file)
  writeFileSync(TMP_COMMENT_FILE, buildEventComment(event), 'utf-8')
  await ghRaw(
    `issue comment ${issueNumber} --body-file "${TMP_COMMENT_FILE}"`,
    config,
  )
}

// ─── PR: check existing / create ──────────────────────────────────────────────

export interface PrCheckResult {
  prNumber: number | null
  prUrl: string | null
  prState: 'open' | 'merged' | 'closed' | null
}

/**
 * Check if a PR already exists for the given branch (idempotency guard).
 */
export async function checkPrExists(
  branch: string,
  config: AgentConfig,
): Promise<PrCheckResult> {
  const { stdout, exitCode } = await ghRaw(
    `pr list --head ${branch} --state all --json number,url,state`,
    config,
  )

  if (exitCode !== 0) {
    return { prNumber: null, prUrl: null, prState: null }
  }

  const data = JSON.parse(stdout)
  if (data.length === 0) {
    return { prNumber: null, prUrl: null, prState: null }
  }

  const pr = data[0]!
  return {
    prNumber: pr.number,
    prUrl: pr.url,
    prState: pr.state.toLowerCase() as 'open' | 'merged' | 'closed',
  }
}

/**
 * Create a PR (assumes branch already pushed).
 */
export async function createPr(
  branch: string,
  issueNumber: number,
  issueTitle: string,
  body: string,
  config: AgentConfig,
): Promise<{ number: number; url: string }> {
  writeFileSync(TMP_BODY_FILE, body, 'utf-8')
  const { stdout, exitCode, stderr } = await ghRaw(
    `pr create --title "Fix #${issueNumber}: ${issueTitle}" --body-file "${TMP_BODY_FILE}" --head ${branch}`,
    config,
  )

  if (exitCode !== 0) {
    throw new GhError(`pr create`, exitCode, stderr)
  }

  // gh pr create returns the URL on stdout
  const url = stdout.trim()
  // Extract PR number from URL
  const match = url.match(/\/pull\/(\d+)$/)
  const number = match ? parseInt(match[1]!) : 0

  return { number, url }
}

// ─── Worktree: check PR status ────────────────────────────────────────────────

export async function getPrState(
  branch: string,
  config: AgentConfig,
): Promise<'open' | 'merged' | 'closed' | null> {
  const result = await checkPrExists(branch, config)
  return result.prState
}
