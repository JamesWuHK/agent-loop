import { listOpenAgentIssues } from '@agent/shared'
import { loadConfig } from './config'

async function main(): Promise<void> {
  const config = loadConfig()
  const issues = await listOpenAgentIssues(config)
  const managedIssues = issues.filter(issue => issue.labels.some(label => label.startsWith('agent:')))

  console.log(`managed issues: ${managedIssues.length}`)

  for (const issue of managedIssues) {
    const blockers = issue.contractValidationErrors.length > 0
      ? issue.contractValidationErrors.join(' | ')
      : '-'
    console.log(
      `#${issue.number} state=${issue.state} claimable=${issue.isClaimable} `
      + `contract=${issue.hasExecutableContract} blockedBy=${issue.claimBlockedBy.join(',') || '-'} `
      + `errors=${blockers}`,
    )
  }

  const invalidReady = managedIssues.filter(issue => issue.state === 'ready' && !issue.hasExecutableContract)
  if (invalidReady.length > 0) {
    console.log('\ninvalid ready issues:')
    for (const issue of invalidReady) {
      console.log(`#${issue.number} ${issue.title}`)
      for (const error of issue.contractValidationErrors) {
        console.log(`- ${error}`)
      }
    }
  }
}

main().catch((error) => {
  console.error('[audit-issue-contracts] failed:', error)
  process.exit(1)
})
