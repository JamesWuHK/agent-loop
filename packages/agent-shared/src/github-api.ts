/// <reference types="bun-types" />
import { $ } from 'bun'
import { writeFileSync } from 'node:fs'
import type { AgentConfig, AgentIssue, ClaimEvent, GitHubIssue } from './types'
import { ISSUE_LABELS, PR_REVIEW_LABELS } from './types'
import { inferState, buildEventComment, parseIssueDependencyMetadata } from './state-machine'

const TMP_COMMENT_FILE = '/tmp/agent-loop-comment.txt'
const TMP_BODY_FILE = '/tmp/agent-loop-body.txt'

// ─── gh CLI wrapper ───────────────────────────────────────────────────────────

async function ghRaw(
  cmd: string,
  config: AgentConfig,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const fullCmd = `gh ${cmd} --repo ${config.repo}`
  const proc = Bun.spawn(['sh', '-c', fullCmd], {
    env: { ...process.env, GH_TOKEN: config.pat },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited

  return { stdout, stderr, exitCode }
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

interface RawGitHubIssueNode {
  number: number
  title: string
  body: string | null
  state?: 'open' | 'closed'
  updatedAt: string
  labels: { nodes: Array<{ name: string }> }
  assignees: { nodes: Array<{ login: string }> }
}

function mapRawIssueNode(issue: RawGitHubIssueNode): AgentIssue {
  const labels = issue.labels.nodes.map((l) => l.name)
  const state = labels.length === 0 && issue.state === 'closed'
    ? 'done'
    : inferState(labels)
  const assignee = issue.assignees.nodes[0]?.login ?? null
  const dependencyMetadata = parseIssueDependencyMetadata(issue.body ?? '', issue.number)

  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state,
    labels,
    assignee,
    isClaimable: state === 'ready' && assignee === null,
    updatedAt: issue.updatedAt,
    dependencyIssueNumbers: dependencyMetadata.dependsOn,
    hasDependencyMetadata: dependencyMetadata.hasDependencyMetadata,
    dependencyParseError: dependencyMetadata.dependencyParseError,
    claimBlockedBy: [],
  }
}

export function applyDependencyClaimability(
  issues: AgentIssue[],
  resolvedDependencies: Map<number, AgentIssue> = new Map(),
): AgentIssue[] {
  const openIssueMap = new Map(issues.map(issue => [issue.number, issue]))

  return issues.map((issue) => {
    if (issue.dependencyParseError) {
      return {
        ...issue,
        isClaimable: false,
        claimBlockedBy: issue.dependencyIssueNumbers,
      }
    }

    const blockedBy = issue.dependencyIssueNumbers.filter((dep) => {
      const dependencyIssue = openIssueMap.get(dep) ?? resolvedDependencies.get(dep)
      return !dependencyIssue || dependencyIssue.state !== 'done'
    })

    return {
      ...issue,
      isClaimable: issue.state === 'ready' && issue.assignee === null && blockedBy.length === 0,
      claimBlockedBy: blockedBy,
    }
  })
}

async function fetchIssuesByNumbers(
  issueNumbers: number[],
  config: AgentConfig,
): Promise<Map<number, AgentIssue>> {
  if (issueNumbers.length === 0) return new Map()

  const [owner, repoName] = config.repo.split('/')
  const selections = issueNumbers
    .map((issueNumber, index) => [
      `issue_${index}: issue(number: ${issueNumber}) {`,
      `  number`,
      `  title`,
      `  body`,
      `  state`,
      `  labels(first: 20) { nodes { name } }`,
      `  assignees(first: 1) { nodes { login } }`,
      `  updatedAt`,
      `  url`,
      `}`,
    ].join('\n'))
    .join('\n')

  const query = [
    `query {`,
    `  repository(owner: "${owner}", name: "${repoName}") {`,
    selections,
    `  }`,
    `}`,
  ].join('\n')

  const result = await $`gh api graphql --raw-field query=${query}`
    .env({ ...process.env, GH_TOKEN: config.pat })
    .quiet()

  const stdout = await new Response(result.stdout).text()
  const data = JSON.parse(stdout)
  const repo = data.data?.repository ?? {}
  const resolved = new Map<number, AgentIssue>()

  for (let index = 0; index < issueNumbers.length; index++) {
    const raw = repo[`issue_${index}`] as RawGitHubIssueNode | null | undefined
    if (raw) {
      const mapped = mapRawIssueNode(raw)
      resolved.set(mapped.number, mapped)
    }
  }

  return resolved
}

async function enrichClaimability(
  issues: AgentIssue[],
  config: AgentConfig,
): Promise<AgentIssue[]> {
  const dependencyNumbers = new Set<number>()
  for (const issue of issues) {
    for (const dep of issue.dependencyIssueNumbers) dependencyNumbers.add(dep)
  }

  const openIssueMap = new Map(issues.map(issue => [issue.number, issue]))
  const missingDeps = [...dependencyNumbers].filter(dep => !openIssueMap.has(dep))
  const fetchedDeps = await fetchIssuesByNumbers(missingDeps, config)

  return applyDependencyClaimability(issues, fetchedDeps)
}

export async function listOpenAgentIssues(
  config: AgentConfig,
): Promise<AgentIssue[]> {
  const [owner, repoName] = config.repo.split('/')

  const query = [
    `query {`,
    `  repository(owner: "${owner}", name: "${repoName}") {`,
    `    issues(`,
    `      first: 100`,
    `      orderBy: { field: UPDATED_AT, direction: ASC }`,
    `      states: OPEN`,
    `    ) {`,
    `      nodes {`,
    `        number`,
    `        title`,
    `        body`,
    `        state`,
    `        labels(first: 20) { nodes { name } }`,
    `        assignees(first: 1) { nodes { login } }`,
    `        updatedAt`,
    `        url`,
    `      }`,
    `    }`,
    `  }`,
    `}`,
  ].join('\n')

  const result = await $`gh api graphql --raw-field query=${query}`
    .env({ ...process.env, GH_TOKEN: config.pat })
    .quiet()

  const stdout = await new Response(result.stdout).text()
  const data = JSON.parse(stdout)

  const issues = (data.data?.repository?.issues?.nodes ?? []) as RawGitHubIssueNode[]

  const mapped = issues
    .map(mapRawIssueNode)
    .filter((issue: AgentIssue) => issue.labels.some(label => label.startsWith('agent:')))

  return enrichClaimability(mapped, config)
}

// ─── GraphQL: fetch claimable issues ─────────────────────────────────────────

/**
 * Fetch all open issues with 'agent:ready' label that are not yet claimed.
 * Uses GraphQL for efficiency (1 API call for up to 100 issues).
 */
export async function fetchClaimableIssues(
  config: AgentConfig,
): Promise<import('./types').AgentIssue[]> {
  const issues = await listOpenAgentIssues(config)
  const claimable = issues.filter((issue) => issue.isClaimable)

  console.log('[claimability] candidates:')
  for (const issue of issues) {
    console.log(
      `[claimability] #${issue.number} state=${issue.state} assignee=${issue.assignee ?? '-'} `
      + `deps=${issue.dependencyIssueNumbers.length ? issue.dependencyIssueNumbers.join(',') : '-'} `
      + `blockedBy=${issue.claimBlockedBy.length ? issue.claimBlockedBy.join(',') : '-'} `
      + `parseError=${issue.dependencyParseError} claimable=${issue.isClaimable}`,
    )
  }

  return claimable
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
    `issue edit ${issueNumber} --add-label "${ISSUE_LABELS.CLAIMED}" --add-assignee "@me"`,
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

export async function commentOnPr(
  prNumber: number,
  body: string,
  config: AgentConfig,
): Promise<void> {
  const { exitCode, stderr } = await ghRaw(
    `pr comment ${prNumber} --body ${shellQuote(body)}`,
    config,
  )

  if (exitCode !== 0) {
    throw new GhError(`pr comment ${prNumber}`, exitCode, stderr)
  }
}

export async function addPrLabels(
  prNumber: number,
  labels: string[],
  config: AgentConfig,
): Promise<void> {
  if (labels.length === 0) return
  const args = labels.map(label => `--add-label ${shellQuote(label)}`).join(' ')
  const { exitCode, stderr } = await ghRaw(`pr edit ${prNumber} ${args}`, config)
  if (exitCode !== 0) {
    throw new GhError(`pr edit ${prNumber} add labels`, exitCode, stderr)
  }
}

export async function removePrLabels(
  prNumber: number,
  labels: string[],
  config: AgentConfig,
): Promise<void> {
  if (labels.length === 0) return
  const args = labels.map(label => `--remove-label ${shellQuote(label)}`).join(' ')
  const { exitCode, stderr } = await ghRaw(`pr edit ${prNumber} ${args}`, config)
  if (exitCode !== 0) {
    throw new GhError(`pr edit ${prNumber} remove labels`, exitCode, stderr)
  }
}

export async function setManagedPrReviewLabels(
  prNumber: number,
  state: 'approved' | 'failed' | 'retry' | 'human-needed',
  config: AgentConfig,
): Promise<void> {
  const managed = Object.values(PR_REVIEW_LABELS) as string[]
  const desired = state === 'approved'
    ? [PR_REVIEW_LABELS.APPROVED]
    : state === 'retry'
      ? [PR_REVIEW_LABELS.FAILED, PR_REVIEW_LABELS.RETRY]
      : state === 'human-needed'
        ? [PR_REVIEW_LABELS.FAILED, PR_REVIEW_LABELS.HUMAN_NEEDED]
        : [PR_REVIEW_LABELS.FAILED]

  const desiredSet = new Set<string>(desired)
  const toRemove = managed.filter(label => !desiredSet.has(label))
  await removePrLabels(prNumber, toRemove, config)
  await addPrLabels(prNumber, desired, config)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}
