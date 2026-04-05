import { parseIssueContract, validateIssueContract, ISSUE_LABELS, buildGhEnv, commentOnIssue, type AgentConfig } from '@agent/shared'
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

export function evaluateReadyGate(issue: ReadyGateIssueSnapshot): ReadyGateEvaluation {
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
  return {
    shouldEnforce: true,
    valid: validation.valid,
    errors: validation.errors,
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
  const evaluation = evaluateReadyGate(issue)

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
