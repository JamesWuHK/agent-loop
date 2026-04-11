import { execFileSync } from 'node:child_process'

export interface LocalImplementationRecord {
  issueNumber: number
  latestCommitHeadline: string
  commitCount: number
}

const IMPLEMENTATION_REFERENCE_PATTERNS = [
  /\b[a-z][a-z0-9-]*\(#(\d+)\)/gi,
  /\bfix #(\d+)\b/gi,
]

export function parseLocalImplementationRecords(
  gitLogOutput: string,
): LocalImplementationRecord[] {
  const records = new Map<number, LocalImplementationRecord>()

  for (const rawEntry of gitLogOutput.split('\u001e')) {
    const entry = rawEntry.trim()
    if (!entry) {
      continue
    }

    const lines = entry
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    const latestCommitHeadline = lines[0] ?? '(unknown commit)'
    const issueNumbers = extractImplementedIssueNumbers(entry)

    for (const issueNumber of issueNumbers) {
      const existing = records.get(issueNumber)
      if (existing) {
        existing.commitCount += 1
        continue
      }

      records.set(issueNumber, {
        issueNumber,
        latestCommitHeadline,
        commitCount: 1,
      })
    }
  }

  return [...records.values()]
}

export function buildLocalImplementationIndex(
  repoRoot = process.cwd(),
  maxCommits = 400,
): Map<number, LocalImplementationRecord> {
  try {
    const gitLogOutput = execFileSync('git', [
      '-C',
      repoRoot,
      'log',
      '--format=%s%n%b%x1e',
      '-n',
      String(maxCommits),
    ], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    return new Map(
      parseLocalImplementationRecords(gitLogOutput).map((record) => [record.issueNumber, record]),
    )
  } catch {
    return new Map()
  }
}

function extractImplementedIssueNumbers(message: string): Set<number> {
  const issueNumbers = new Set<number>()

  for (const pattern of IMPLEMENTATION_REFERENCE_PATTERNS) {
    pattern.lastIndex = 0

    for (const match of message.matchAll(pattern)) {
      const rawIssueNumber = match[1]
      if (!rawIssueNumber) {
        continue
      }

      const issueNumber = Number.parseInt(rawIssueNumber, 10)
      if (Number.isSafeInteger(issueNumber)) {
        issueNumbers.add(issueNumber)
      }
    }
  }

  return issueNumbers
}
