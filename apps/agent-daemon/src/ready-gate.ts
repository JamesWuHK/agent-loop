import { parseIssueContract, validateIssueContract, ISSUE_LABELS, buildGhEnv, commentOnIssue, type AgentConfig } from '@agent/shared'
import { existsSync } from 'node:fs'
import { isAbsolute, posix, resolve } from 'node:path'
import { loadConfig, type CliArgs } from './config'

interface ReadyGateIssueSnapshot {
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  labels: string[]
}

export interface ReadyGateEvaluation {
  shouldEnforce: boolean
  valid: boolean
  errors: string[]
}

interface ReadyGateOptions {
  repoRoot?: string
}

function normalizeValidationEntry(entry: string): string {
  const trimmed = entry.trim()
  if (trimmed.startsWith('`') && trimmed.endsWith('`')) {
    return trimmed.slice(1, -1).trim()
  }

  return trimmed
}

function tokenizeCommand(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^['"]|['"]$/g, '')) ?? []
}

function looksLikeFilePathToken(token: string): boolean {
  if (!token || token.startsWith('-')) return false
  if (token.includes('...')) return false
  if (/^[A-Za-z0-9_.-]+$/.test(token) && !token.includes('.')) return false
  return /[\\/]/.test(token) || /\.[A-Za-z0-9]+$/.test(token)
}

function extractValidationFileCandidates(entry: string): string[] {
  const tokens = tokenizeCommand(normalizeValidationEntry(entry))
  const candidates = new Set<string>()
  let commandCwd = '.'

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? ''
    if ((token === '--cwd' || token === '-C') && tokens[index + 1]) {
      commandCwd = tokens[index + 1]!
      index++
      continue
    }

    if (token === 'cd' && tokens[index + 1]) {
      commandCwd = tokens[index + 1]!
      index++
      continue
    }

    if (!looksLikeFilePathToken(token)) continue
    if (token === '.' || token === '..') continue

    const resolved = token.startsWith('/')
      ? token
      : posix.normalize(commandCwd === '.' ? token : posix.join(commandCwd, token))
    candidates.add(resolved.replace(/\\/g, '/'))
  }

  return [...candidates]
}

function validateValidationTargets(body: string, repoRoot?: string): string[] {
  if (!repoRoot) return []

  const contract = parseIssueContract(body)
  const missingTargets = new Set<string>()

  for (const entry of contract.validation) {
    for (const candidate of extractValidationFileCandidates(entry)) {
      const absolutePath = isAbsolute(candidate) ? candidate : resolve(repoRoot, candidate)
      if (!existsSync(absolutePath)) {
        missingTargets.add(candidate)
      }
    }
  }

  return [...missingTargets].map((target) => `validation references missing repo path: ${target}`)
}

export function evaluateReadyGate(
  issue: ReadyGateIssueSnapshot,
  options: ReadyGateOptions = {},
): ReadyGateEvaluation {
  if (issue.state === 'closed') {
    return {
      shouldEnforce: false,
      valid: true,
      errors: [],
    }
  }

  if (!issue.labels.includes(ISSUE_LABELS.READY)) {
    return {
      shouldEnforce: false,
      valid: true,
      errors: [],
    }
  }

  const validation = validateIssueContract(parseIssueContract(issue.body))
  const targetErrors = validateValidationTargets(issue.body, options.repoRoot)
  const errors = [...validation.errors, ...targetErrors]

  return {
    shouldEnforce: true,
    valid: errors.length === 0,
    errors,
  }
}

export function buildReadyGateFailureComment(issueNumber: number, errors: string[]): string {
  return `<!-- agent-loop:ready-gate {"issue":${issueNumber},"valid":false} -->
## agent:ready gate blocked

This issue cannot stay in \`agent:ready\` because its executable contract is incomplete.

Missing contract requirements:
${errors.map((error) => `- ${error}`).join('\n')}

Next step: fix the issue body so it matches the executable contract template, then re-apply \`agent:ready\`.`
}

export async function fetchIssueSnapshot(
  issueNumber: number,
  config: AgentConfig,
): Promise<ReadyGateIssueSnapshot> {
  const proc = Bun.spawn([
    'gh',
    'issue',
    'view',
    String(issueNumber),
    '--repo',
    config.repo,
    '--json',
    'number,title,body,state,labels',
  ], {
    env: buildGhEnv(config),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`gh issue view failed: ${stderr}`)
  }

  const parsed = JSON.parse(stdout) as {
    number?: number
    title?: string
    body?: string
    state?: 'open' | 'closed'
    labels?: Array<{ name?: string }>
  }

  return {
    number: parsed.number ?? issueNumber,
    title: parsed.title ?? '',
    body: parsed.body ?? '',
    state: parsed.state === 'closed' ? 'closed' : 'open',
    labels: (parsed.labels ?? [])
      .map((label) => typeof label.name === 'string' ? label.name : '')
      .filter(Boolean),
  }
}

async function removeReadyLabel(
  issueNumber: number,
  config: AgentConfig,
): Promise<void> {
  const proc = Bun.spawn([
    'gh',
    'api',
    `repos/${config.repo}/issues/${issueNumber}/labels/${encodeURIComponent(ISSUE_LABELS.READY)}`,
    '-X',
    'DELETE',
  ], {
    env: buildGhEnv(config),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  if (exitCode !== 0 && !stderr.includes('Label does not exist')) {
    throw new Error(`gh api label delete failed: ${stderr}`)
  }
}

export async function enforceReadyGate(
  issueNumber: number,
  config: AgentConfig,
  logger = console,
): Promise<ReadyGateEvaluation> {
  const issue = await fetchIssueSnapshot(issueNumber, config)
  const evaluation = evaluateReadyGate(issue, { repoRoot: process.cwd() })

  if (!evaluation.shouldEnforce) {
    logger.log(`[ready-gate] issue #${issueNumber} does not currently require enforcement`)
    return evaluation
  }

  if (evaluation.valid) {
    logger.log(`[ready-gate] issue #${issueNumber} passed executable contract validation`)
    return evaluation
  }

  await commentOnIssue(issue.number, buildReadyGateFailureComment(issue.number, evaluation.errors), config)
  await removeReadyLabel(issue.number, config)
  logger.warn(`[ready-gate] removed ${ISSUE_LABELS.READY} from issue #${issue.number}: ${evaluation.errors.join(' | ')}`)
  return evaluation
}

function parseArgs(argv: string[]): CliArgs & { issueNumber: number } {
  let issueNumber: number | null = null
  let repo: string | undefined

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--issue') {
      const value = argv[index + 1]
      issueNumber = value ? Number.parseInt(value, 10) : Number.NaN
      index++
      continue
    }

    if (arg === '--repo') {
      repo = argv[index + 1]
      index++
    }
  }

  if (!Number.isInteger(issueNumber) || issueNumber === null || issueNumber <= 0) {
    throw new Error('Usage: bun apps/agent-daemon/src/ready-gate.ts --issue <number> [--repo owner/name]')
  }

  return {
    issueNumber,
    repo,
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const config = loadConfig({ repo: args.repo })
  const evaluation = await enforceReadyGate(args.issueNumber, config)

  if (evaluation.shouldEnforce && !evaluation.valid) {
    process.exitCode = 1
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[ready-gate] failed:', error)
    process.exit(1)
  })
}
