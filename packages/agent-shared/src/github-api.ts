import { $ } from 'bun'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  AgentConfig,
  AgentIssue,
  ClaimEvent,
  GitHubIssue,
  IssueComment,
  ManagedLease,
  ManagedLeaseComment,
  ManagedLeaseScope,
  ManagedPullRequest,
} from './types'
import { ISSUE_LABELS, PR_REVIEW_LABELS } from './types'
import {
  inferState,
  buildEventComment,
  parseIssueDependencyMetadata,
  resolveActiveClaimMachine,
} from './state-machine'
import { parseIssueContract } from './issue-contract'
import { validateIssueContract } from './issue-contract-validator'

const TMP_COMMENT_FILE = '/tmp/agent-loop-comment.txt'
const TMP_BODY_FILE = '/tmp/agent-loop-body.txt'
const TMP_PATCH_FILE = '/tmp/agent-loop-patch.json'
const MANAGED_ISSUE_LABELS = Object.values(ISSUE_LABELS) as string[]
const CLAIM_OWNERSHIP_SETTLE_DELAY_MS = 350
const CLAIM_OWNERSHIP_SETTLE_ATTEMPTS = 4
const GH_PROXY_ENV_KEYS = [
  'ALL_PROXY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'all_proxy',
  'https_proxy',
  'http_proxy',
] as const

// ─── gh CLI wrapper ───────────────────────────────────────────────────────────

export function buildGhEnv(config: Pick<AgentConfig, 'pat'>): Record<string, string> {
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }

  for (const key of GH_PROXY_ENV_KEYS) {
    delete env[key]
  }

  env.GH_TOKEN = config.pat
  env.GITHUB_TOKEN = config.pat

  return env
}

async function ghRaw(
  cmd: string,
  config: AgentConfig,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const fullCmd = `gh ${cmd} --repo ${config.repo}`
  const proc = Bun.spawn(['sh', '-c', fullCmd], {
    env: buildGhEnv(config),
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

async function ghApiRaw(
  args: string[],
  config: AgentConfig,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(['gh', 'api', ...args], {
    env: buildGhEnv(config),
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
  state?: string
  updatedAt: string
  labels: { nodes: Array<{ name: string }> }
  assignees: { nodes: Array<{ login: string }> }
}

export function deriveIssueStateFromRaw(
  labels: string[],
  issueState?: string,
): AgentIssue['state'] {
  if (issueState?.toLowerCase() === 'closed') return 'done'
  return inferState(labels)
}

function mapRawIssueNode(issue: RawGitHubIssueNode): AgentIssue {
  const labels = issue.labels.nodes.map((l) => l.name)
  const state = deriveIssueStateFromRaw(labels, issue.state)
  const assignee = issue.assignees.nodes[0]?.login ?? null
  const body = issue.body ?? ''
  const dependencyMetadata = parseIssueDependencyMetadata(body, issue.number)
  const contract = parseIssueContract(body)
  const contractValidation = validateIssueContract(contract)

  return {
    number: issue.number,
    title: issue.title,
    body,
    state,
    labels,
    assignee,
    isClaimable: state === 'ready' && assignee === null && contractValidation.valid,
    updatedAt: issue.updatedAt,
    dependencyIssueNumbers: dependencyMetadata.dependsOn,
    hasDependencyMetadata: dependencyMetadata.hasDependencyMetadata,
    dependencyParseError: dependencyMetadata.dependencyParseError,
    claimBlockedBy: [],
    hasExecutableContract: contractValidation.valid,
    contractValidationErrors: contractValidation.errors,
  }
}

export function applyDependencyClaimability(
  issues: AgentIssue[],
  resolvedDependencies: Map<number, AgentIssue> = new Map(),
): AgentIssue[] {
  const openIssueMap = new Map(issues.map(issue => [issue.number, issue]))

  return issues.map((issue) => {
    if (!issue.hasExecutableContract) {
      return {
        ...issue,
        isClaimable: false,
        claimBlockedBy: issue.dependencyIssueNumbers,
      }
    }

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
    .env(buildGhEnv(config))
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

export async function getAgentIssueByNumber(
  issueNumber: number,
  config: AgentConfig,
): Promise<AgentIssue | null> {
  return fetchIssuesByNumbers([issueNumber], config).then((issues) => issues.get(issueNumber) ?? null)
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
    .env(buildGhEnv(config))
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
      + `parseError=${issue.dependencyParseError} contract=${issue.hasExecutableContract} `
      + `claimable=${issue.isClaimable}`
      + `${issue.contractValidationErrors.length > 0 ? ` contractErrors=${issue.contractValidationErrors.join(';')}` : ''}`,
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
  const { stderr, exitCode } = await ghRaw(
    `issue edit ${issueNumber} --add-assignee "@me"`,
    config,
  )

  if (exitCode === 0) {
    await setManagedIssueStateLabels(issueNumber, ISSUE_LABELS.CLAIMED, config)

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

    const activeClaimMachine = await settleActiveClaimMachine(issueNumber, config)
    if (activeClaimMachine && activeClaimMachine !== machineId) {
      return { success: false, issueNumber, reason: 'already-claimed' }
    }

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
  await setManagedIssueStateLabels(issueNumber, addLabel, config)

  // Add event comment via temp file (gh issue edit has no --comment-file)
  writeFileSync(TMP_COMMENT_FILE, buildEventComment(event), 'utf-8')
  await ghRaw(
    `issue comment ${issueNumber} --body-file "${TMP_COMMENT_FILE}"`,
    config,
  )
}

export async function commentOnIssue(
  issueNumber: number,
  body: string,
  config: AgentConfig,
): Promise<IssueComment> {
  const response = await withTempJsonFile(
    'agent-loop-issue-comment',
    { body },
    async (path) => ghApiRaw([
      `repos/${config.repo}/issues/${issueNumber}/comments`,
      '-X',
      'POST',
      '--input',
      path,
    ], config),
  )

  if (response.exitCode !== 0) {
    throw new GhError(`api issues/${issueNumber}/comments create`, response.exitCode, response.stderr)
  }

  return mapRawIssueComment(JSON.parse(response.stdout) as RawIssueComment)
}

// ─── PR: check existing / create ──────────────────────────────────────────────

export interface PrCheckResult {
  prNumber: number | null
  prUrl: string | null
  prState: 'open' | 'merged' | 'closed' | null
}

export interface MergePrResult {
  merged: boolean
  message: string
  sha?: string
}

interface RawPullRequestListItem {
  number: number
  title: string
  url: string
  headRefName: string
  isDraft?: boolean
  labels?: Array<{ name: string }>
}

interface RawIssueComment {
  id?: number
  body?: string
  created_at?: string
  updated_at?: string
}

const MANAGED_LEASE_COMMENT_PREFIX = '<!-- agent-loop:lease '

function mapRawIssueComment(comment: RawIssueComment): IssueComment {
  return {
    commentId: typeof comment.id === 'number' ? comment.id : 0,
    body: typeof comment.body === 'string' ? comment.body : '',
    createdAt: typeof comment.created_at === 'string' ? comment.created_at : '',
    updatedAt: typeof comment.updated_at === 'string'
      ? comment.updated_at
      : typeof comment.created_at === 'string'
        ? comment.created_at
        : '',
  }
}

function withTempJsonFile<T>(
  prefix: string,
  payload: Record<string, unknown>,
  run: (path: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`))
  const path = join(dir, 'payload.json')
  writeFileSync(path, JSON.stringify(payload), 'utf-8')

  return run(path).finally(() => {
    rmSync(dir, { recursive: true, force: true })
  })
}

export function buildManagedLeaseComment(lease: ManagedLease): string {
  return `${MANAGED_LEASE_COMMENT_PREFIX}${JSON.stringify(lease)} -->\n## Managed lease\n\n- Scope: ${lease.scope}\n- Status: ${lease.status}\n- Phase: ${lease.phase}\n- Machine: ${lease.machineId}\n- Daemon: ${lease.daemonInstanceId}\n- Lease: ${lease.leaseId}`
}

export function extractManagedLeaseComment(
  body: string,
): ManagedLease | null {
  const match = body.match(/<!-- agent-loop:lease (\{.*\}) -->/)
  if (!match?.[1]) return null

  try {
    const parsed = JSON.parse(match[1]) as ManagedLease
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.leaseId !== 'string' || typeof parsed.scope !== 'string') return null
    if (typeof parsed.daemonInstanceId !== 'string' || typeof parsed.machineId !== 'string') return null
    if (typeof parsed.phase !== 'string' || typeof parsed.status !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

export function parseManagedLeaseComments(
  comments: IssueComment[],
  scope?: ManagedLeaseScope,
): ManagedLeaseComment[] {
  return comments
    .map((comment) => {
      const lease = extractManagedLeaseComment(comment.body)
      if (!lease) return null
      if (scope && lease.scope !== scope) return null
      return {
        ...comment,
        lease,
      } satisfies ManagedLeaseComment
    })
    .filter((comment): comment is ManagedLeaseComment => comment !== null)
}

export function isManagedLeaseExpired(
  lease: ManagedLease,
  now = Date.now(),
): boolean {
  const expiresAt = Date.parse(lease.expiresAt)
  if (!Number.isFinite(expiresAt)) return true
  return expiresAt <= now
}

export function getActiveManagedLease(
  comments: IssueComment[],
  scope: ManagedLeaseScope,
  now = Date.now(),
): ManagedLeaseComment | null {
  const active = parseManagedLeaseComments(comments, scope)
    .filter((comment) => comment.lease.status === 'active' && !isManagedLeaseExpired(comment.lease, now))
    .sort((left, right) => {
      const createdDelta = Date.parse(left.createdAt) - Date.parse(right.createdAt)
      if (Number.isFinite(createdDelta) && createdDelta !== 0) return createdDelta
      return left.commentId - right.commentId
    })

  return active[0] ?? null
}

export function getLatestManagedLease(
  comments: IssueComment[],
  scope: ManagedLeaseScope,
): ManagedLeaseComment | null {
  const leases = parseManagedLeaseComments(comments, scope)
    .sort((left, right) => {
      const updatedDelta = Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      if (Number.isFinite(updatedDelta) && updatedDelta !== 0) return updatedDelta
      return right.commentId - left.commentId
    })

  return leases[0] ?? null
}

export function canDaemonAdoptManagedLease(
  activeLease: ManagedLeaseComment | null,
  daemonInstanceId: string,
  now = Date.now(),
): boolean {
  if (!activeLease) return true
  if (activeLease.lease.daemonInstanceId === daemonInstanceId) return true
  return isManagedLeaseExpired(activeLease.lease, now)
}

export async function createManagedLeaseComment(
  issueNumber: number,
  lease: ManagedLease,
  config: AgentConfig,
): Promise<IssueComment> {
  const response = await withTempJsonFile(
    'agent-loop-lease-create',
    { body: buildManagedLeaseComment(lease) },
    async (path) => ghApiRaw([
      `repos/${config.repo}/issues/${issueNumber}/comments`,
      '-X',
      'POST',
      '--input',
      path,
    ], config),
  )

  if (response.exitCode !== 0) {
    throw new GhError(`api issues/${issueNumber}/comments create lease`, response.exitCode, response.stderr)
  }

  return mapRawIssueComment(JSON.parse(response.stdout) as RawIssueComment)
}

export async function updateManagedLeaseComment(
  commentId: number,
  lease: ManagedLease,
  config: AgentConfig,
): Promise<IssueComment> {
  const response = await withTempJsonFile(
    'agent-loop-lease-update',
    { body: buildManagedLeaseComment(lease) },
    async (path) => ghApiRaw([
      `repos/${config.repo}/issues/comments/${commentId}`,
      '-X',
      'PATCH',
      '--input',
      path,
    ], config),
  )

  if (response.exitCode !== 0) {
    throw new GhError(`api issues/comments/${commentId} update lease`, response.exitCode, response.stderr)
  }

  return mapRawIssueComment(JSON.parse(response.stdout) as RawIssueComment)
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

export async function listOpenAgentPullRequests(
  config: AgentConfig,
): Promise<ManagedPullRequest[]> {
  const { stdout, exitCode, stderr } = await ghRaw(
    'pr list --state open --json number,title,url,headRefName,isDraft,labels',
    config,
  )

  if (exitCode !== 0) {
    throw new GhError('pr list --state open', exitCode, stderr)
  }

  const data = JSON.parse(stdout) as RawPullRequestListItem[]
  return data
    .filter((pr) => typeof pr.headRefName === 'string' && pr.headRefName.startsWith('agent/'))
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      headRefName: pr.headRefName,
      isDraft: pr.isDraft === true,
      labels: (pr.labels ?? []).map((label) => label.name),
    }))
}

export async function listIssueComments(
  issueNumber: number,
  config: AgentConfig,
): Promise<IssueComment[]> {
  const { stdout, exitCode, stderr } = await ghApiRaw([
    `repos/${config.repo}/issues/${issueNumber}/comments`,
    '--paginate',
  ], config)

  if (exitCode !== 0) {
    throw new GhError(`api issues/${issueNumber}/comments`, exitCode, stderr)
  }

  const data = JSON.parse(stdout) as RawIssueComment[]
  return data.map(mapRawIssueComment)
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

export function parseGhApiErrorMessage(stdout: string, stderr: string): string {
  const trimmedStdout = stdout.trim()
  if (trimmedStdout) {
    try {
      const parsed = JSON.parse(trimmedStdout) as { message?: unknown }
      if (typeof parsed.message === 'string' && parsed.message.trim().length > 0) {
        return parsed.message.trim()
      }
    } catch {
      return trimmedStdout
    }
  }

  const trimmedStderr = stderr.trim()
  if (trimmedStderr) return trimmedStderr
  return 'GitHub API request failed'
}

export function parseMergePrResponse(stdout: string): MergePrResult {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return {
      merged: false,
      message: 'GitHub merge API returned an empty response',
    }
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      merged?: unknown
      message?: unknown
      sha?: unknown
    }

    return {
      merged: parsed.merged === true,
      message: typeof parsed.message === 'string' && parsed.message.trim().length > 0
        ? parsed.message.trim()
        : parsed.merged === true
          ? 'Pull request merged'
          : 'Pull request was not merged',
      sha: typeof parsed.sha === 'string' && parsed.sha.trim().length > 0
        ? parsed.sha.trim()
        : undefined,
    }
  } catch {
    return {
      merged: false,
      message: trimmed,
    }
  }
}

export async function mergePullRequest(
  prNumber: number,
  config: AgentConfig,
  method: 'merge' | 'squash' | 'rebase' = 'squash',
): Promise<MergePrResult> {
  const { stdout, stderr, exitCode } = await ghApiRaw([
    `repos/${config.repo}/pulls/${prNumber}/merge`,
    '-X',
    'PUT',
    '-f',
    `merge_method=${method}`,
  ], config)

  if (exitCode !== 0) {
    return {
      merged: false,
      message: parseGhApiErrorMessage(stdout, stderr),
    }
  }

  return parseMergePrResponse(stdout)
}

export async function addPrLabels(
  prNumber: number,
  labels: string[],
  config: AgentConfig,
): Promise<void> {
  if (labels.length === 0) return
  const { exitCode, stderr } = await ghApiRaw([
    `repos/${config.repo}/issues/${prNumber}/labels`,
    '-X',
    'POST',
    ...labels.flatMap(label => ['-f', `labels[]=${label}`]),
  ], config)
  if (exitCode !== 0) {
    throw new GhError(`api issues/${prNumber}/labels add`, exitCode, stderr)
  }
}

export async function removePrLabels(
  prNumber: number,
  labels: string[],
  config: AgentConfig,
): Promise<void> {
  if (labels.length === 0) return
  for (const label of labels) {
    const { exitCode, stderr } = await ghApiRaw([
      `repos/${config.repo}/issues/${prNumber}/labels/${encodeURIComponent(label)}`,
      '-X',
      'DELETE',
    ], config)
    if (exitCode !== 0 && !stderr.includes('Label does not exist')) {
      throw new GhError(`api issues/${prNumber}/labels remove`, exitCode, stderr)
    }
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

async function addIssueLabels(
  issueNumber: number,
  labels: string[],
  config: AgentConfig,
): Promise<void> {
  if (labels.length === 0) return
  const { exitCode, stderr } = await ghApiRaw([
    `repos/${config.repo}/issues/${issueNumber}/labels`,
    '-X',
    'POST',
    ...labels.flatMap(label => ['-f', `labels[]=${label}`]),
  ], config)

  if (exitCode !== 0) {
    throw new GhError(`api issues/${issueNumber}/labels add`, exitCode, stderr)
  }
}

async function removeIssueLabels(
  issueNumber: number,
  labels: string[],
  config: AgentConfig,
): Promise<void> {
  if (labels.length === 0) return
  for (const label of labels) {
    const { exitCode, stderr } = await ghApiRaw([
      `repos/${config.repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      '-X',
      'DELETE',
    ], config)

    if (exitCode !== 0 && !stderr.includes('Label does not exist')) {
      throw new GhError(`api issues/${issueNumber}/labels remove`, exitCode, stderr)
    }
  }
}

export function shouldClearIssueAssigneesForStateLabel(desiredLabel: string): boolean {
  return desiredLabel === ISSUE_LABELS.READY
}

async function clearIssueAssignees(
  issueNumber: number,
  config: AgentConfig,
): Promise<void> {
  writeFileSync(TMP_PATCH_FILE, JSON.stringify({ assignees: [] }), 'utf-8')

  const { exitCode, stderr } = await ghApiRaw([
    `repos/${config.repo}/issues/${issueNumber}`,
    '-X',
    'PATCH',
    '--input',
    TMP_PATCH_FILE,
  ], config)

  if (exitCode !== 0) {
    throw new GhError(`api issues/${issueNumber} clear assignees`, exitCode, stderr)
  }
}

async function setManagedIssueStateLabels(
  issueNumber: number,
  desiredLabel: string,
  config: AgentConfig,
): Promise<void> {
  const desired = new Set([desiredLabel])
  const toRemove = MANAGED_ISSUE_LABELS.filter(label => !desired.has(label))
  await removeIssueLabels(issueNumber, toRemove, config)
  await addIssueLabels(issueNumber, [desiredLabel], config)
  if (shouldClearIssueAssigneesForStateLabel(desiredLabel)) {
    await clearIssueAssignees(issueNumber, config)
  }
}

async function settleActiveClaimMachine(
  issueNumber: number,
  config: AgentConfig,
): Promise<string | null> {
  for (let attempt = 1; attempt <= CLAIM_OWNERSHIP_SETTLE_ATTEMPTS; attempt++) {
    const comments = await listIssueComments(issueNumber, config)
    const activeMachine = resolveActiveClaimMachine(comments)
    if (activeMachine !== null) {
      return activeMachine
    }

    if (attempt < CLAIM_OWNERSHIP_SETTLE_ATTEMPTS) {
      await sleep(CLAIM_OWNERSHIP_SETTLE_DELAY_MS)
    }
  }

  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}
