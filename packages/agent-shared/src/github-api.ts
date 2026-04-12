import { writeFileSync, rmSync, readFileSync } from 'node:fs'
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
import { ISSUE_LABELS, ISSUE_PRIORITY_LABELS, PR_REVIEW_LABELS } from './types'
import {
  inferState,
  buildEventComment,
  parseClaimEventComment,
  parseIssueDependencyMetadata,
  resolveActiveClaimMachine,
} from './state-machine'
import { parseIssueContract } from './issue-contract'
import { validateIssueContract } from './issue-contract-validator'

const TMP_COMMENT_FILE = '/tmp/agent-loop-comment.txt'
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

export type GitHubApiTransport = 'graphql' | 'rest'
export type GitHubApiMode = 'direct' | 'gh_cli'
export type GitHubApiOutcome = 'success' | 'error' | 'timeout' | 'rate_limited'

export interface GitHubApiRequestObservation {
  transport: GitHubApiTransport
  mode: GitHubApiMode
  outcome: GitHubApiOutcome
  durationMs: number
}

let githubApiRequestObserver: ((observation: GitHubApiRequestObservation) => void) | null = null

export function setGitHubApiRequestObserver(
  observer: ((observation: GitHubApiRequestObservation) => void) | null,
): void {
  githubApiRequestObserver = observer
}

function observeGitHubApiRequest(observation: GitHubApiRequestObservation): void {
  try {
    githubApiRequestObserver?.(observation)
  } catch {
    // Metrics hooks must never break GitHub API callers.
  }
}

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

  if (config.pat) {
    env.GH_TOKEN = config.pat
    env.GITHUB_TOKEN = config.pat
  } else {
    delete env.GH_TOKEN
    delete env.GITHUB_TOKEN
  }

  return env
}

// Keep the default below the daemon poll interval so a single slow GitHub call
// cannot stall the whole scheduler for multiple minutes.
const DEFAULT_GH_COMMAND_TIMEOUT_MS = 30_000

export interface GhCommandResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

export async function runBoundedGhCommand(
  args: string[],
  config: Pick<AgentConfig, 'pat'>,
  options: {
    timeoutMs?: number
  } = {},
): Promise<GhCommandResult> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_GH_COMMAND_TIMEOUT_MS)
  const proc = Bun.spawn(['gh', ...args], {
    detached: true,
    env: buildGhEnv(config),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdoutPromise = proc.stdout
    ? new Response(proc.stdout).text().catch(() => '')
    : Promise.resolve('')
  const stderrPromise = proc.stderr
    ? new Response(proc.stderr).text().catch(() => '')
    : Promise.resolve('')

  const exitOutcome = await Promise.race([
    proc.exited.then((exitCode) => ({
      kind: 'exited' as const,
      exitCode,
    })),
    Bun.sleep(timeoutMs).then(() => ({
      kind: 'timed-out' as const,
    })),
  ])

  let timedOut = false
  let exitCode: number
  if (exitOutcome.kind === 'exited') {
    exitCode = exitOutcome.exitCode
  } else {
    timedOut = true
    await terminateProcessTree(proc.pid).catch(() => {
      // best-effort cleanup only
    })
    void proc.stdout?.cancel().catch(() => {
      // stream may already be closed
    })
    void proc.stderr?.cancel().catch(() => {
      // stream may already be closed
    })
    exitCode = await settleWithin(proc.exited, 124, 250)
    if (exitCode === 0) {
      exitCode = 124
    }
  }

  const [stdout, stderr] = timedOut
    ? await Promise.all([
        settleWithin(stdoutPromise, '', 250),
        settleWithin(stderrPromise, '', 250),
      ])
    : await Promise.all([stdoutPromise, stderrPromise])

  return {
    stdout,
    stderr: timedOut ? appendGhTimeoutMessage(stderr, `gh ${args.join(' ')}`, timeoutMs) : stderr,
    exitCode,
    timedOut,
  }
}

async function runBoundedShellGhCommand(
  cmd: string,
  config: Pick<AgentConfig, 'pat' | 'repo'>,
  options: {
    timeoutMs?: number
  } = {},
): Promise<GhCommandResult> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_GH_COMMAND_TIMEOUT_MS)
  const fullCmd = `gh ${cmd} --repo ${config.repo}`
  const proc = Bun.spawn(['sh', '-c', fullCmd], {
    detached: true,
    env: buildGhEnv(config),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdoutPromise = proc.stdout
    ? new Response(proc.stdout).text().catch(() => '')
    : Promise.resolve('')
  const stderrPromise = proc.stderr
    ? new Response(proc.stderr).text().catch(() => '')
    : Promise.resolve('')

  const exitOutcome = await Promise.race([
    proc.exited.then((exitCode) => ({
      kind: 'exited' as const,
      exitCode,
    })),
    Bun.sleep(timeoutMs).then(() => ({
      kind: 'timed-out' as const,
    })),
  ])

  let timedOut = false
  let exitCode: number
  if (exitOutcome.kind === 'exited') {
    exitCode = exitOutcome.exitCode
  } else {
    timedOut = true
    await terminateProcessTree(proc.pid).catch(() => {
      // best-effort cleanup only
    })
    void proc.stdout?.cancel().catch(() => {
      // stream may already be closed
    })
    void proc.stderr?.cancel().catch(() => {
      // stream may already be closed
    })
    exitCode = await settleWithin(proc.exited, 124, 250)
    if (exitCode === 0) {
      exitCode = 124
    }
  }

  const [stdout, stderr] = timedOut
    ? await Promise.all([
        settleWithin(stdoutPromise, '', 250),
        settleWithin(stderrPromise, '', 250),
      ])
    : await Promise.all([stdoutPromise, stderrPromise])

  return {
    stdout,
    stderr: timedOut ? appendGhTimeoutMessage(stderr, fullCmd, timeoutMs) : stderr,
    exitCode,
    timedOut,
  }
}

async function ghRaw(
  cmd: string,
  config: AgentConfig,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { stdout, stderr, exitCode } = await runBoundedShellGhCommand(cmd, config)
  return { stdout, stderr, exitCode }
}

export async function ghApiRaw(
  args: string[],
  config: AgentConfig,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const qualifiedArgs = qualifyGhApiArgs(args, config)
  const transport = inferGitHubApiTransportFromArgs(qualifiedArgs)
  if (config.pat) {
    try {
      buildDirectGitHubApiRequest(qualifiedArgs, config)
      const startedAt = Date.now()
      const result = await runDirectGitHubApi(qualifiedArgs, config)
      observeGitHubApiRequest({
        transport,
        mode: 'direct',
        outcome: inferGitHubApiOutcome({
          transport,
          stderr: result.stderr,
          exitCode: result.exitCode,
        }),
        durationMs: Date.now() - startedAt,
      })
      return result
    } catch {
      // Fall back to gh api for argument shapes that direct mode does not support yet.
    }
  }

  const startedAt = Date.now()
  const result = await runBoundedGhCommand(['api', ...qualifiedArgs], config)
  observeGitHubApiRequest({
    transport,
    mode: 'gh_cli',
    outcome: inferGitHubApiOutcome({
      transport,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    }),
    durationMs: Date.now() - startedAt,
  })
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  }
}

interface DirectGitHubApiRequest {
  kind: 'graphql' | 'rest'
  url: string
  method: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT'
  body?: string
  paginate: boolean
}

function normalizeDirectGitHubMethod(
  method: string | undefined,
): DirectGitHubApiRequest['method'] {
  switch ((method ?? '').toUpperCase()) {
    case 'DELETE':
      return 'DELETE'
    case 'PATCH':
      return 'PATCH'
    case 'POST':
      return 'POST'
    case 'PUT':
      return 'PUT'
    default:
      return 'GET'
  }
}

function parseDirectGitHubApiFields(
  fields: string[],
): Record<string, unknown> {
  const payload: Record<string, unknown> = {}

  for (const field of fields) {
    const separatorIndex = field.indexOf('=')
    const rawKey = separatorIndex >= 0 ? field.slice(0, separatorIndex) : field
    const value = separatorIndex >= 0 ? field.slice(separatorIndex + 1) : ''

    if (rawKey.endsWith('[]')) {
      const key = rawKey.slice(0, -2)
      const existing = payload[key]
      if (Array.isArray(existing)) {
        existing.push(value)
      } else if (existing === undefined) {
        payload[key] = [value]
      } else {
        payload[key] = [existing, value]
      }
      continue
    }

    payload[rawKey] = value
  }

  return payload
}

function appendDirectGitHubQueryParams(
  url: string,
  params: Record<string, unknown>,
): string {
  const search = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        search.append(`${key}[]`, String(item))
      }
      continue
    }

    search.append(key, String(value))
  }

  const query = search.toString()
  if (!query) return url
  return `${url}${url.includes('?') ? '&' : '?'}${query}`
}

export function buildDirectGitHubApiRequest(
  args: string[],
  config: Pick<AgentConfig, 'repo'>,
): DirectGitHubApiRequest {
  const qualifiedArgs = qualifyGhApiArgs(args, config)
  const [endpoint, ...rest] = qualifiedArgs
  if (!endpoint) {
    throw new Error('missing GitHub API endpoint')
  }
  const fieldArgs: string[] = []
  let inputPath: string | null = null
  let method: DirectGitHubApiRequest['method'] = 'GET'
  let paginate = false

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if ((token === '-X' || token === '--method') && typeof rest[index + 1] === 'string') {
      method = normalizeDirectGitHubMethod(rest[index + 1])
      index += 1
      continue
    }

    if ((token === '-f' || token === '--field' || token === '--raw-field') && typeof rest[index + 1] === 'string') {
      fieldArgs.push(rest[index + 1]!)
      index += 1
      continue
    }

    if (token === '--input' && typeof rest[index + 1] === 'string') {
      inputPath = rest[index + 1]!
      index += 1
      continue
    }

    if (token === '--paginate') {
      paginate = true
      continue
    }

    if (typeof token === 'string' && token.startsWith('-')) {
      throw new Error(`unsupported gh api option for direct mode: ${token}`)
    }
  }

  if (endpoint === 'graphql') {
    const payload = parseDirectGitHubApiFields(fieldArgs)
    const query = typeof payload.query === 'string' ? payload.query : ''
    delete payload.query

    return {
      kind: 'graphql',
      url: 'https://api.github.com/graphql',
      method: 'POST',
      body: JSON.stringify({
        query,
        variables: payload,
      }),
      paginate: false,
    }
  }

  let url = `https://api.github.com/${endpoint.replace(/^\/+/, '')}`
  let body: string | undefined

  if (inputPath) {
    body = readFileSync(inputPath, 'utf-8')
  } else if (fieldArgs.length > 0) {
    const payload = parseDirectGitHubApiFields(fieldArgs)
    if (method === 'GET') {
      url = appendDirectGitHubQueryParams(url, payload)
    } else {
      body = JSON.stringify(payload)
    }
  }

  return {
    kind: 'rest',
    url,
    method,
    body,
    paginate,
  }
}

function parseDirectGitHubApiErrorMessage(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) return 'GitHub API request failed'

  try {
    const parsed = JSON.parse(trimmed) as {
      message?: unknown
      errors?: Array<{ message?: unknown }>
    }
    if (typeof parsed.message === 'string' && parsed.message.trim().length > 0) {
      return parsed.message.trim()
    }
    if (Array.isArray(parsed.errors)) {
      for (const error of parsed.errors) {
        if (typeof error?.message === 'string' && error.message.trim().length > 0) {
          return error.message.trim()
        }
      }
    }
  } catch {
    // fall through to raw body
  }

  return trimmed
}

function parseDirectGraphQlErrorMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as {
      errors?: Array<{ message?: unknown }>
    }
    if (!Array.isArray(parsed.errors)) return null

    for (const error of parsed.errors) {
      if (typeof error?.message === 'string' && error.message.trim().length > 0) {
        return error.message.trim()
      }
    }
  } catch {
    return null
  }

  return null
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_GH_COMMAND_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`GitHub API request timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

export function extractNextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null

  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/)
    if (match?.[2] === 'next') {
      return match[1] ?? null
    }
  }

  return null
}

export function mergePaginatedRestBodies(pages: string[]): string {
  if (pages.length === 0) return '[]'
  if (pages.length === 1) return pages[0]!

  try {
    const parsedPages = pages.map((page) => JSON.parse(page))
    if (parsedPages.every(Array.isArray)) {
      return JSON.stringify(parsedPages.flat())
    }
  } catch {
    // fall back to raw concatenation below
  }

  return pages.join('\n')
}

async function runDirectGitHubApi(
  args: string[],
  config: Pick<AgentConfig, 'pat' | 'repo'>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let request: DirectGitHubApiRequest
  try {
    request = buildDirectGitHubApiRequest(args, config)
  } catch (error) {
    return {
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 1,
    }
  }

  const headers: Record<string, string> = {
    Authorization: `token ${config.pat}`,
    Accept: request.kind === 'graphql'
      ? 'application/json'
      : 'application/vnd.github+json',
  }

  if (request.body) {
    headers['Content-Type'] = 'application/json'
  }

  const issueRequest = async (
    url: string,
    includeBody: boolean,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; nextPageUrl: string | null }> => {
    const response = await fetchWithTimeout(url, {
      method: request.method,
      headers,
      body: includeBody ? request.body : undefined,
    })
    const stdout = await response.text()
    if (!response.ok) {
      return {
        stdout,
        stderr: parseDirectGitHubApiErrorMessage(stdout),
        exitCode: 1,
        nextPageUrl: null,
      }
    }

    if (request.kind === 'graphql') {
      const graphQlError = parseDirectGraphQlErrorMessage(stdout)
      if (graphQlError) {
        return {
          stdout,
          stderr: `GraphQL: ${graphQlError}`,
          exitCode: 1,
          nextPageUrl: null,
        }
      }
    }

    return {
      stdout,
      stderr: '',
      exitCode: 0,
      nextPageUrl: request.paginate ? extractNextPageUrl(response.headers.get('link')) : null,
    }
  }

  try {
    if (!request.paginate) {
      const response = await issueRequest(request.url, true)
      return {
        stdout: response.stdout,
        stderr: response.stderr,
        exitCode: response.exitCode,
      }
    }

    const pages: string[] = []
    let nextPageUrl: string | null = request.url
    let includeBody = true
    while (nextPageUrl) {
      const response = await issueRequest(nextPageUrl, includeBody)
      if (response.exitCode !== 0) {
        return {
          stdout: response.stdout,
          stderr: response.stderr,
          exitCode: response.exitCode,
        }
      }
      pages.push(response.stdout)
      nextPageUrl = response.nextPageUrl
      includeBody = false
    }

    return {
      stdout: mergePaginatedRestBodies(pages),
      stderr: '',
      exitCode: 0,
    }
  } catch (error) {
    return {
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 1,
    }
  }
}

export function qualifyGhApiArgs(
  args: string[],
  config: Pick<AgentConfig, 'repo'>,
): string[] {
  const [endpoint, ...rest] = args
  if (!endpoint) return args
  if (!shouldQualifyGhApiEndpoint(endpoint)) {
    return args
  }

  const normalizedEndpoint = endpoint.replace(/^\/+/, '')
  return [`repos/${config.repo}/${normalizedEndpoint}`, ...rest]
}

function inferGitHubApiTransportFromArgs(args: string[]): GitHubApiTransport {
  return args[0]?.trim() === 'graphql' ? 'graphql' : 'rest'
}

function inferGitHubApiOutcome(input: {
  transport: GitHubApiTransport
  stderr: string
  exitCode: number
  timedOut?: boolean
}): GitHubApiOutcome {
  if (input.timedOut || input.stderr.toLowerCase().includes('timed out')) {
    return 'timeout'
  }
  if (input.exitCode === 0) {
    return 'success'
  }
  if (isGitHubApiRateLimitErrorMessage(input.transport, input.stderr)) {
    return 'rate_limited'
  }
  return 'error'
}

function isGitHubApiRateLimitErrorMessage(
  transport: GitHubApiTransport,
  message: string,
): boolean {
  if (transport === 'graphql') {
    return isGraphQlRateLimitErrorMessage(message)
  }

  const normalized = message.toLowerCase()
  return (
    normalized.includes('api rate limit')
    || normalized.includes('secondary rate limit')
    || normalized.includes('rate limit exceeded')
  )
}

function shouldQualifyGhApiEndpoint(endpoint: string): boolean {
  const normalized = endpoint.trim()
  if (normalized.length === 0) return false
  if (normalized === 'graphql') return false
  if (normalized.startsWith('repos/')) return false
  if (normalized.startsWith('/repos/')) return false
  if (normalized.startsWith('https://')) return false
  if (normalized.startsWith('http://')) return false
  return true
}

function appendGhTimeoutMessage(stderr: string, command: string, timeoutMs: number): string {
  const base = stderr.trimEnd()
  const message = `${command} timed out after ${timeoutMs}ms`
  return base.length > 0 ? `${base}\n${message}` : message
}

async function terminateProcessTree(rootPid: number): Promise<void> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return
  }

  try {
    process.kill(-rootPid, 'SIGKILL')
    return
  } catch {
    // fall back to best-effort child + parent cleanup
  }

  await killDirectChildProcesses(rootPid)

  try {
    process.kill(rootPid, 'SIGKILL')
  } catch {
    // process may already be gone
  }
}

async function killDirectChildProcesses(parentPid: number): Promise<void> {
  const proc = Bun.spawn(['pkill', '-KILL', '-P', String(parentPid)], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  await settleWithin(proc.exited, 0, 250)
}

async function settleWithin<T>(
  promise: Promise<T>,
  fallback: T,
  timeoutMs: number,
): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(timeoutMs).then(() => fallback),
  ])
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

interface RawGitHubIssueConnection {
  nodes?: RawGitHubIssueNode[]
  pageInfo?: {
    hasNextPage?: boolean
    endCursor?: string | null
  }
}

interface RawRestGitHubIssue {
  number?: number
  title?: string
  body?: string | null
  state?: string
  updated_at?: string
  labels?: Array<{ name?: string }>
  assignees?: Array<{ login?: string }>
  pull_request?: unknown
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

function mapRawRestIssue(issue: RawRestGitHubIssue): AgentIssue | null {
  if (issue.pull_request) return null
  if (typeof issue.number !== 'number') return null

  const labels = (issue.labels ?? [])
    .map((label) => typeof label.name === 'string' ? label.name : '')
    .filter(Boolean)
  const state = deriveIssueStateFromRaw(labels, issue.state)
  const assignee = (issue.assignees ?? [])
    .map((candidate) => typeof candidate.login === 'string' ? candidate.login : '')
    .find(Boolean) ?? null
  const body = issue.body ?? ''
  const dependencyMetadata = parseIssueDependencyMetadata(body, issue.number)
  const contract = parseIssueContract(body)
  const contractValidation = validateIssueContract(contract)

  return {
    number: issue.number,
    title: typeof issue.title === 'string' ? issue.title : '',
    body,
    state,
    labels,
    assignee,
    isClaimable: state === 'ready' && assignee === null && contractValidation.valid,
    updatedAt: typeof issue.updated_at === 'string' ? issue.updated_at : '',
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

function getClaimSchedulingPriorityRank(issue: Pick<AgentIssue, 'labels'>): number {
  if (issue.labels.includes(ISSUE_PRIORITY_LABELS.HIGH)) return 0
  if (issue.labels.includes(ISSUE_PRIORITY_LABELS.LOW)) return 2
  return 1
}

export function sortClaimableIssuesForScheduling(issues: AgentIssue[]): AgentIssue[] {
  return [...issues].sort((left, right) => {
    const priorityDiff = getClaimSchedulingPriorityRank(left) - getClaimSchedulingPriorityRank(right)
    if (priorityDiff !== 0) return priorityDiff

    const updatedAtDiff = left.updatedAt.localeCompare(right.updatedAt)
    if (updatedAtDiff !== 0) return updatedAtDiff

    return left.number - right.number
  })
}

export function isGraphQlRateLimitErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('api rate limit already exceeded')
    || normalized.includes('secondary rate limit')
    || (normalized.includes('graphql') && normalized.includes('rate limit'))
  )
}

export function extractRestOpenIssueListPage(data: unknown): RawRestGitHubIssue[] {
  return Array.isArray(data)
    ? data.filter((item): item is RawRestGitHubIssue => typeof item === 'object' && item !== null)
    : []
}

async function fetchIssuesByNumbersRest(
  issueNumbers: number[],
  config: AgentConfig,
): Promise<Map<number, AgentIssue>> {
  const resolved = new Map<number, AgentIssue>()

  for (const issueNumber of issueNumbers) {
    const { stdout, exitCode, stderr } = await ghApiRaw([
      `repos/${config.repo}/issues/${issueNumber}`,
    ], config)

    if (exitCode !== 0) {
      throw new GhError(
        `api issues/${issueNumber}`,
        exitCode,
        parseGhApiErrorMessage(stdout, stderr),
      )
    }

    const mapped = mapRawRestIssue(JSON.parse(stdout) as RawRestGitHubIssue)
    if (mapped) {
      resolved.set(mapped.number, mapped)
    }
  }

  return resolved
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

  const { stdout, exitCode, stderr } = await ghApiRaw([
    'graphql',
    '--raw-field',
    `query=${query}`,
  ], config)
  if (exitCode !== 0) {
    const errorMessage = parseGhApiErrorMessage(stdout, stderr)
    if (isGraphQlRateLimitErrorMessage(errorMessage)) {
      return fetchIssuesByNumbersRest(issueNumbers, config)
    }
    throw new GhError('api graphql issue lookup', exitCode, errorMessage)
  }

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

export function buildListOpenIssuesQuery(owner: string, repoName: string): string {
  return [
    `query($cursor: String) {`,
    `  repository(owner: "${owner}", name: "${repoName}") {`,
    `    issues(`,
    `      first: 100`,
    `      after: $cursor`,
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
    `      pageInfo {`,
    `        hasNextPage`,
    `        endCursor`,
    `      }`,
    `    }`,
    `  }`,
    `}`,
  ].join('\n')
}

export function extractOpenIssueConnectionPage(data: unknown): {
  nodes: RawGitHubIssueNode[]
  hasNextPage: boolean
  endCursor: string | null
} {
  const connection = (data as {
    data?: {
      repository?: {
        issues?: RawGitHubIssueConnection
      }
    }
  })?.data?.repository?.issues

  return {
    nodes: Array.isArray(connection?.nodes) ? connection.nodes : [],
    hasNextPage: connection?.pageInfo?.hasNextPage === true,
    endCursor: typeof connection?.pageInfo?.endCursor === 'string'
      ? connection.pageInfo.endCursor
      : null,
  }
}

async function listOpenAgentIssuesRest(
  config: AgentConfig,
): Promise<AgentIssue[]> {
  const issues: AgentIssue[] = []

  for (let page = 1; ; page += 1) {
    const { stdout, exitCode, stderr } = await ghApiRaw([
      `repos/${config.repo}/issues?state=open&per_page=100&page=${page}`,
    ], config)

    if (exitCode !== 0) {
      throw new GhError(
        `api issues?state=open&page=${page}`,
        exitCode,
        parseGhApiErrorMessage(stdout, stderr),
      )
    }

    const pageItems = extractRestOpenIssueListPage(JSON.parse(stdout))
    const mapped = pageItems
      .map(mapRawRestIssue)
      .filter((issue): issue is AgentIssue => issue !== null)
      .filter((issue) => issue.labels.some((label) => label.startsWith('agent:')))

    issues.push(...mapped)

    if (pageItems.length < 100) {
      break
    }
  }

  issues.sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt))
  return enrichClaimability(issues, config)
}

export async function listOpenAgentIssues(
  config: AgentConfig,
): Promise<AgentIssue[]> {
  const [owner, repoName] = config.repo.split('/')
  if (!owner || !repoName) {
    throw new Error(`Invalid repo slug: ${config.repo}`)
  }
  const query = buildListOpenIssuesQuery(owner, repoName)
  const issues: RawGitHubIssueNode[] = []
  let cursor: string | null = null

  for (;;) {
    const args = [
      'graphql',
      '--raw-field',
      `query=${query}`,
    ]
    if (cursor) {
      args.push('--raw-field', `cursor=${cursor}`)
    }

    const { stdout, exitCode, stderr } = await ghApiRaw(args, config)
    if (exitCode !== 0) {
      const errorMessage = parseGhApiErrorMessage(stdout, stderr)
      if (isGraphQlRateLimitErrorMessage(errorMessage)) {
        return listOpenAgentIssuesRest(config)
      }
      throw new GhError('api graphql open issues', exitCode, errorMessage)
    }

    const page = extractOpenIssueConnectionPage(JSON.parse(stdout))
    issues.push(...page.nodes)

    if (!page.hasNextPage || !page.endCursor) {
      break
    }

    cursor = page.endCursor
  }

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

    const activeClaimMachine = await settleActiveClaimMachine(issueNumber, config, event)
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
  event: ClaimEvent | null | undefined,
  config: AgentConfig,
): Promise<void> {
  await setManagedIssueStateLabels(issueNumber, addLabel, config)

  if (!event) return

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
  headRefOid?: string
  isDraft?: boolean
  labels?: Array<{ name: string }>
}

interface RawRestPullRequest {
  number?: number
  title?: string
  html_url?: string
  state?: string
  merged_at?: string | null
  draft?: boolean
  head?: {
    ref?: string
    sha?: string
  }
  labels?: Array<{ name?: string }>
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
  const path = join(
    tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  )
  writeFileSync(path, JSON.stringify(payload), 'utf-8')

  return run(path).finally(() => {
    rmSync(path, { force: true })
  })
}

export function derivePullRequestStateFromRaw(
  state?: string,
  mergedAt?: string | null,
): 'open' | 'merged' | 'closed' | null {
  const normalized = typeof state === 'string' ? state.toLowerCase() : null
  if (normalized === 'open') return 'open'
  if (normalized === 'closed') return typeof mergedAt === 'string' && mergedAt.length > 0 ? 'merged' : 'closed'
  return null
}

export function extractRestPullRequestListPage(data: unknown): RawRestPullRequest[] {
  return Array.isArray(data)
    ? data.filter((item): item is RawRestPullRequest => typeof item === 'object' && item !== null)
    : []
}

export function extractRestPullRequest(data: unknown): RawRestPullRequest | null {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? data as RawRestPullRequest
    : null
}

function mapRawRestPullRequest(pr: RawRestPullRequest): ManagedPullRequest | null {
  if (typeof pr.number !== 'number') return null
  if (typeof pr.title !== 'string') return null
  if (typeof pr.html_url !== 'string') return null
  if (typeof pr.head?.ref !== 'string') return null

  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    headRefName: pr.head.ref,
    headRefOid: typeof pr.head.sha === 'string' && pr.head.sha.length > 0
      ? pr.head.sha
      : null,
    isDraft: pr.draft === true,
    labels: (pr.labels ?? [])
      .map((label) => typeof label.name === 'string' ? label.name : '')
      .filter(Boolean),
  }
}

async function checkPrExistsRest(
  branch: string,
  config: AgentConfig,
): Promise<PrCheckResult> {
  const [owner] = config.repo.split('/')
  const endpoint = `repos/${config.repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`
  const { stdout, exitCode } = await ghApiRaw([endpoint], config)

  if (exitCode !== 0) {
    return { prNumber: null, prUrl: null, prState: null }
  }

  const data = extractRestPullRequestListPage(JSON.parse(stdout))
  if (data.length === 0) {
    return { prNumber: null, prUrl: null, prState: null }
  }

  const pr = data[0]!
  return {
    prNumber: typeof pr.number === 'number' ? pr.number : null,
    prUrl: typeof pr.html_url === 'string' ? pr.html_url : null,
    prState: derivePullRequestStateFromRaw(pr.state, pr.merged_at ?? null),
  }
}

async function listOpenAgentPullRequestsRest(
  config: AgentConfig,
): Promise<ManagedPullRequest[]> {
  const pullRequests: ManagedPullRequest[] = []

  for (let page = 1; ; page += 1) {
    const { stdout, exitCode, stderr } = await ghApiRaw([
      `repos/${config.repo}/pulls?state=open&per_page=100&page=${page}`,
    ], config)

    if (exitCode !== 0) {
      throw new GhError(
        `api pulls?state=open&page=${page}`,
        exitCode,
        parseGhApiErrorMessage(stdout, stderr),
      )
    }

    const pageItems = extractRestPullRequestListPage(JSON.parse(stdout))
    pullRequests.push(
      ...pageItems
        .map(mapRawRestPullRequest)
        .filter((pr): pr is ManagedPullRequest => pr !== null)
        .filter((pr) => pr.headRefName.startsWith('agent/')),
    )

    if (pageItems.length < 100) {
      break
    }
  }

  return pullRequests
}

async function getManagedPullRequestByNumberRest(
  prNumber: number,
  config: AgentConfig,
): Promise<ManagedPullRequest | null> {
  const { stdout, exitCode, stderr } = await ghApiRaw([
    `repos/${config.repo}/pulls/${prNumber}`,
  ], config)

  if (exitCode !== 0) {
    const errorMessage = parseGhApiErrorMessage(stdout, stderr).toLowerCase()
    if (errorMessage.includes('not found')) {
      return null
    }

    throw new GhError(
      `api pulls/${prNumber}`,
      exitCode,
      parseGhApiErrorMessage(stdout, stderr),
    )
  }

  const mapped = mapRawRestPullRequest(extractRestPullRequest(JSON.parse(stdout)) ?? {})
  if (!mapped) return null
  if (!mapped.headRefName.startsWith('agent/')) return null
  return mapped
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

export function isManagedLeaseProgressStale(
  lease: ManagedLease,
  maxNoProgressMs: number | null | undefined,
  now = Date.now(),
): boolean {
  if (maxNoProgressMs == null || maxNoProgressMs <= 0) return false

  const lastProgressAt = Date.parse(lease.lastProgressAt)
  if (!Number.isFinite(lastProgressAt)) return true
  return lastProgressAt + maxNoProgressMs <= now
}

export function getActiveManagedLease(
  comments: IssueComment[],
  scope: ManagedLeaseScope,
  now = Date.now(),
  maxNoProgressMs?: number | null,
): ManagedLeaseComment | null {
  const active = parseManagedLeaseComments(comments, scope)
    .filter((comment) => {
      if (comment.lease.status !== 'active') return false
      if (isManagedLeaseExpired(comment.lease, now)) return false
      if (isManagedLeaseProgressStale(comment.lease, maxNoProgressMs, now)) return false
      return true
    })
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
  maxNoProgressMs?: number | null,
): boolean {
  if (!activeLease) return true
  if (activeLease.lease.daemonInstanceId === daemonInstanceId) return true
  return (
    isManagedLeaseExpired(activeLease.lease, now)
    || isManagedLeaseProgressStale(activeLease.lease, maxNoProgressMs, now)
  )
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
  return checkPrExistsRest(branch, config)
}

export async function listOpenAgentPullRequests(
  config: AgentConfig,
): Promise<ManagedPullRequest[]> {
  return listOpenAgentPullRequestsRest(config)
}

export async function getManagedPullRequestByNumber(
  prNumber: number,
  config: AgentConfig,
): Promise<ManagedPullRequest | null> {
  return getManagedPullRequestByNumberRest(prNumber, config)
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
  const response = await withTempJsonFile(
    'agent-loop-pr-create',
    {
      title: `Fix #${issueNumber}: ${issueTitle}`,
      head: branch,
      base: config.git.defaultBranch,
      body,
    },
    async (path) => ghApiRaw([
      `repos/${config.repo}/pulls`,
      '-X',
      'POST',
      '--input',
      path,
    ], config),
  )

  if (response.exitCode !== 0) {
    throw new GhError(`api pulls create`, response.exitCode, parseGhApiErrorMessage(response.stdout, response.stderr))
  }

  const created = JSON.parse(response.stdout) as RawRestPullRequest
  const url = typeof created.html_url === 'string' ? created.html_url : ''
  const number = typeof created.number === 'number' ? created.number : 0

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
  expectedClaimEvent?: ClaimEvent,
): Promise<string | null> {
  for (let attempt = 1; attempt <= CLAIM_OWNERSHIP_SETTLE_ATTEMPTS; attempt++) {
    const comments = await listIssueComments(issueNumber, config)
    const activeMachine = resolveActiveClaimMachine(comments)
    if (
      activeMachine !== null
      && (!expectedClaimEvent || hasObservedClaimEvent(comments, expectedClaimEvent))
    ) {
      return activeMachine
    }

    if (attempt < CLAIM_OWNERSHIP_SETTLE_ATTEMPTS) {
      await sleep(CLAIM_OWNERSHIP_SETTLE_DELAY_MS)
    }
  }

  return null
}

function hasObservedClaimEvent(
  comments: Array<{ body: string }>,
  expectedClaimEvent: ClaimEvent,
): boolean {
  return comments.some((comment) => {
    const event = parseClaimEventComment(comment.body)
    return event?.event === expectedClaimEvent.event
      && event.machine === expectedClaimEvent.machine
      && event.ts === expectedClaimEvent.ts
      && event.worktreeId === expectedClaimEvent.worktreeId
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}
