import { listOpenAgentIssues } from '@agent/shared'
import { loadConfig, type CliArgs } from './config'

interface AuditedIssue {
  number: number
  title: string
  state: string
  isClaimable: boolean
  hasExecutableContract: boolean
  claimBlockedBy: number[]
  contractValidationErrors: string[]
}

export function formatAuditLine(issue: AuditedIssue): string {
  return `#${issue.number} state=${issue.state} claimable=${issue.isClaimable} `
    + `contract=${issue.hasExecutableContract} blockedBy=${issue.claimBlockedBy.join(',') || '-'} `
    + `errors=${issue.contractValidationErrors.join(' | ') || '-'}`
}

export function formatInvalidReadySection(issues: AuditedIssue[]): string {
  if (issues.length === 0) {
    return ''
  }

  return [
    'invalid ready issues:',
    ...issues.flatMap((issue) => [
      `#${issue.number} ${issue.title}`,
      ...issue.contractValidationErrors.map((error) => `- ${error}`),
    ]),
  ].join('\n')
}

function parseArgs(argv: string[]): CliArgs {
  let repo: string | undefined

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--repo') {
      repo = argv[index + 1]
      index++
    }
  }

  return { repo }
}

async function main(): Promise<void> {
  const config = loadConfig(parseArgs(process.argv.slice(2)))
  const issues = await listOpenAgentIssues(config)
  const managedIssues = issues.filter(issue => issue.labels.some(label => label.startsWith('agent:')))

  console.log(`managed issues: ${managedIssues.length}`)

  for (const issue of managedIssues) {
    console.log(formatAuditLine(issue))
  }

  const invalidReady = managedIssues.filter(issue => issue.state === 'ready' && !issue.hasExecutableContract)
  const invalidReadySection = formatInvalidReadySection(invalidReady)
  if (invalidReadySection) {
    console.log(`\n${invalidReadySection}`)
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[audit-issue-contracts] failed:', error)
    process.exit(1)
  })
}
