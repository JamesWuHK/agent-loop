import { buildGhEnv, renderIssueContractForPrompt, type AgentConfig } from '@agent/shared'

export interface PrReviewFinding {
  severity: string
  file: string
  summary: string
  mustFix?: string[]
  mustNotDo?: string[]
  validation?: string[]
  scopeRationale?: string
}

export interface PrReviewResult {
  approved: boolean
  reason: string
  canMerge: boolean
  findings?: PrReviewFinding[]
  reviewFailed?: boolean
}

interface ReviewFindingContractViolation {
  findingIndex: number
  file: string
  summary: string
  missingFields: Array<'mustFix' | 'mustNotDo' | 'validation' | 'scopeRationale'>
}

interface LinkedIssueContext {
  number: number
  title: string
  body: string
}

interface PrReviewContext {
  title: string
  body: string
  files: Array<{ path: string; additions?: number; deletions?: number }>
  diff: string
  linkedIssue: LinkedIssueContext | null
}

interface StructuredReviewFeedbackPayload {
  approved: boolean
  canMerge: boolean
  reason: string
  findings: PrReviewFinding[]
}

export async function reviewPr(
  prNumber: number,
  prUrl: string,
  worktreePath: string,
  config: AgentConfig,
  logger = console,
): Promise<PrReviewResult> {
  logger.log(`[pr-review] starting review for PR #${prNumber}`)

  try {
    const context = await fetchPrReviewContext(prNumber, config)
    const prompt = buildReviewPrompt(prNumber, prUrl, config.repo, context)
    const result = await runReviewAgent(prompt, worktreePath)
    logger.log(`[pr-review] PR #${prNumber} review complete: ${result.approved ? 'APPROVED' : 'REJECTED'}`)
    return result
  } catch (err) {
    logger.error('[pr-review] review failed:', err)
    return {
      approved: false,
      reason: `Review failed: ${String(err)}`,
      canMerge: false,
      reviewFailed: true,
    }
  }
}

async function fetchPrReviewContext(prNumber: number, config: AgentConfig): Promise<PrReviewContext> {
  const viewProc = Bun.spawn([
    'gh',
    'pr',
    'view',
    String(prNumber),
    '--repo',
    config.repo,
    '--json',
    'title,body,files',
  ], {
    env: buildGhEnv(config),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [viewStdout, viewStderr] = await Promise.all([
    new Response(viewProc.stdout).text(),
    new Response(viewProc.stderr).text(),
  ])
  const viewExitCode = await viewProc.exited
  if (viewExitCode !== 0) {
    throw new Error(`gh pr view failed: ${viewStderr}`)
  }

  const diffProc = Bun.spawn([
    'gh',
    'pr',
    'diff',
    String(prNumber),
    '--repo',
    config.repo,
  ], {
    env: buildGhEnv(config),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [diffStdout, diffStderr] = await Promise.all([
    new Response(diffProc.stdout).text(),
    new Response(diffProc.stderr).text(),
  ])
  const diffExitCode = await diffProc.exited
  if (diffExitCode !== 0) {
    throw new Error(`gh pr diff failed: ${diffStderr}`)
  }

  const pr = JSON.parse(viewStdout)
  const linkedIssueNumber = extractIssueNumberFromPrTitle(pr.title ?? '') ?? extractIssueNumberFromPrBody(pr.body ?? '')

  return {
    title: pr.title ?? '',
    body: pr.body ?? '',
    files: (pr.files ?? []).map((file: any) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
    })),
    diff: diffStdout.slice(0, 40000),
    linkedIssue: linkedIssueNumber == null ? null : await fetchLinkedIssueContext(linkedIssueNumber, config),
  }
}

async function fetchLinkedIssueContext(issueNumber: number, config: AgentConfig): Promise<LinkedIssueContext | null> {
  const proc = Bun.spawn([
    'gh',
    'issue',
    'view',
    String(issueNumber),
    '--repo',
    config.repo,
    '--json',
    'title,body',
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

  const issue = JSON.parse(stdout)
  return {
    number: issueNumber,
    title: issue.title ?? '',
    body: issue.body ?? '',
  }
}

export function buildReviewPrompt(
  prNumber: number,
  prUrl: string,
  repo: string,
  context: PrReviewContext,
): string {
  const parsedContractBlock = context.linkedIssue
    ? renderIssueContractForPrompt(context.linkedIssue.body || '')
    : 'Parsed issue contract: unavailable because no linked issue was found.'
  const linkedIssueBlock = context.linkedIssue
    ? `
Linked Issue #${context.linkedIssue.number}: ${context.linkedIssue.title}
Issue Body:
${context.linkedIssue.body || '(empty)'}
`
    : `
Linked Issue:
(not found from PR title/body; review only the concrete branch diff and changed files)
`

  return `You are reviewing a GitHub pull request for merge readiness from the checked-out PR worktree.

PR #${prNumber}
URL: ${prUrl}
Repo: ${repo}
Title: ${context.title}

PR Body:
${context.body || '(empty)'}

${linkedIssueBlock}

${parsedContractBlock}

Files changed:
${context.files.map(file => `- ${file.path} (+${file.additions ?? 0}/-${file.deletions ?? 0})`).join('\n')}

Diff:
${context.diff}

Check:
1. Use the linked issue as the primary scope and acceptance contract for the review.
2. Prioritize merge blockers: bugs, regressions, missing integration required by the issue, or contract mismatches against the issue acceptance.
3. Do not reject for intentionally out-of-scope work when the issue explicitly excludes it.
4. Focus on concrete issues, not style nits.
5. Approve if the branch is ready to merge for this issue as scoped, even if later issues still exist.
6. When the issue provides AllowedFiles, ForbiddenFiles, MustPreserve, OutOfScope, RequiredSemantics, or ReviewHints, treat them as an executable review contract.
7. If you reject, explain how the diff violated the issue contract and what the fixer must not do while repairing it.
8. Every rejection finding is mandatory contract data: each finding must include mustFix, mustNotDo, validation, and scopeRationale. Missing any of them makes the review unusable.

Respond with JSON only:
{
  "approved": true,
  "reason": "brief explanation",
  "canMerge": true,
  "findings": [
    {
      "severity": "high",
      "file": "path/to/file",
      "summary": "blocking issue",
      "mustFix": ["specific repair requirement"],
      "mustNotDo": ["scope expansion or semantic regressions to avoid"],
      "validation": ["exact command or observable behavior to verify"],
      "scopeRationale": "why this is inside the linked issue contract"
    }
  ]
}`
}

export function buildPrReviewComment(
  prNumber: number,
  review: PrReviewResult,
  attempt: number,
  action: 'approved' | 'retrying' | 'human-needed',
): string {
  const title = action === 'approved'
    ? 'Automated review approved'
    : action === 'retrying'
      ? 'Automated review found blocking issues — starting one auto-fix retry'
      : 'Automated review still failing — human intervention required'

  const nextStep = action === 'approved'
    ? 'Next step: ready to merge.'
    : action === 'retrying'
      ? 'Next step: daemon will attempt one automatic fix on the same branch.'
      : 'Next step: stopping automation and leaving the worktree/branch for a human.'

  const findingsBlock = review.findings && review.findings.length > 0
    ? `\n- Findings:\n${review.findings.slice(0, 5).map((finding) => `  - ${formatReviewFinding(finding)}`).join('\n')}\n`
    : ''
  const feedbackPayload = buildStructuredReviewFeedbackPayload(review)
  const structuredFeedbackBlock = `<!-- agent-loop:review-feedback ${JSON.stringify(feedbackPayload)} -->`

  return `<!-- agent-loop:pr-review {"pr":${prNumber},"attempt":${attempt},"approved":${review.approved},"canMerge":${review.canMerge}} -->
${structuredFeedbackBlock}
## ${title}

- Attempt: ${attempt}
- Merge ready: ${review.canMerge ? 'yes' : 'no'}
- Reason: ${review.reason}
${findingsBlock}

${nextStep}`
}

export function buildReviewFeedback(review: PrReviewResult): string {
  return serializeStructuredReviewFeedback(buildStructuredReviewFeedbackPayload(review))
}

export function parsePrReviewResponse(responseText: string): PrReviewResult {
  const normalized = responseText.trim().replace(/^```json\s*/, '').replace(/```$/, '').trim()
  const json = JSON.parse(normalized) as Partial<PrReviewResult> & {
    findings?: Array<{
      severity?: string
      file?: string
      summary?: string
      mustFix?: unknown
      mustNotDo?: unknown
      validation?: unknown
      scopeRationale?: string
    }>
  }

  const findings = Array.isArray(json.findings)
    ? json.findings
      .map((finding) => {
        if (!finding) return null
        const summary = typeof finding.summary === 'string' ? finding.summary.trim() : ''
        if (!summary) return null
        return {
          severity: typeof finding.severity === 'string' && finding.severity.trim().length > 0
            ? finding.severity.trim()
            : 'issue',
          file: typeof finding.file === 'string' ? finding.file.trim() : '',
          summary,
          mustFix: normalizeReviewInstructionList(finding.mustFix),
          mustNotDo: normalizeReviewInstructionList(finding.mustNotDo),
          validation: normalizeReviewInstructionList(finding.validation),
          scopeRationale: typeof finding.scopeRationale === 'string' && finding.scopeRationale.trim().length > 0
            ? finding.scopeRationale.trim()
            : undefined,
        } satisfies PrReviewFinding
      })
      .filter((finding): finding is NonNullable<typeof finding> => Boolean(finding))
    : []

  const review: PrReviewResult = {
    approved: json.approved === true,
    reason: typeof json.reason === 'string' && json.reason.length > 0
      ? json.reason
      : findings[0] ? formatReviewFinding(findings[0]) : 'No reason provided',
    canMerge: json.canMerge === true,
    ...(findings.length > 0 ? { findings } : {}),
  }

  const violations = validateRejectedReviewFindings(review)
  if (violations.length > 0) {
    return {
      ...review,
      approved: false,
      canMerge: false,
      reason: buildInvalidReviewReason(violations),
      reviewFailed: true,
    }
  }

  return review
}

async function runReviewAgent(
  prompt: string,
  worktreePath: string,
): Promise<PrReviewResult> {
  const cleanEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) cleanEnv[k] = v
  }
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT
  delete cleanEnv.VSCODE_INJECTION_ID

  const proc = Bun.spawn(['claude', '--print', '--permission-mode', 'bypassPermissions'], {
    cwd: worktreePath,
    env: cleanEnv,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  proc.stdin.write(prompt)
  proc.stdin.end()

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    throw new Error(`Agent exited with code ${exitCode}: ${stderr}`)
  }

  return parsePrReviewResponse(stdout)
}

function formatReviewFinding(finding: PrReviewFinding): string {
  return `${finding.severity}${finding.file ? ` in ${finding.file}` : ''}: ${finding.summary}`
}

function normalizeReviewInstructionList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined

  const normalized = value
    .map(item => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean)

  return normalized.length > 0 ? normalized : undefined
}

function buildStructuredReviewFeedbackPayload(review: PrReviewResult): StructuredReviewFeedbackPayload {
  return {
    approved: review.approved,
    canMerge: review.canMerge,
    reason: review.reason,
    findings: review.findings ?? [],
  }
}

function serializeStructuredReviewFeedback(payload: StructuredReviewFeedbackPayload): string {
  if (payload.findings.length === 0) {
    return payload.reason
  }

  return `${payload.reason}

Structured review feedback:
\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`

Blocking findings:
${payload.findings.map((finding) => `- ${formatReviewFinding(finding)}`).join('\n')}`
}

export function validateRejectedReviewFindings(
  review: Pick<PrReviewResult, 'approved' | 'canMerge' | 'findings'>,
): ReviewFindingContractViolation[] {
  if (review.approved || review.canMerge) return []

  const findings = review.findings ?? []
  if (findings.length === 0) {
    return [{
      findingIndex: 1,
      file: '',
      summary: 'missing rejection finding',
      missingFields: ['mustFix', 'mustNotDo', 'validation', 'scopeRationale'],
    }]
  }

  return findings.flatMap((finding, index) => {
    const missingFields: ReviewFindingContractViolation['missingFields'] = []

    if (!finding.mustFix || finding.mustFix.length === 0) missingFields.push('mustFix')
    if (!finding.mustNotDo || finding.mustNotDo.length === 0) missingFields.push('mustNotDo')
    if (!finding.validation || finding.validation.length === 0) missingFields.push('validation')
    if (!finding.scopeRationale || finding.scopeRationale.trim().length === 0) missingFields.push('scopeRationale')

    if (missingFields.length === 0) return []

    return [{
      findingIndex: index + 1,
      file: finding.file,
      summary: finding.summary,
      missingFields,
    }]
  })
}

function buildInvalidReviewReason(violations: ReviewFindingContractViolation[]): string {
  const details = violations.map((violation) => {
    const location = violation.file ? ` in ${violation.file}` : ''
    return `finding ${violation.findingIndex}${location} (${violation.summary}) missing ${violation.missingFields.join(', ')}`
  })

  return `Review output failed validation: every rejection finding must include mustFix, mustNotDo, validation, and scopeRationale. ${details.join(' | ')}`
}

export function extractIssueNumberFromPrTitle(title: string): number | null {
  const match = title.match(/#(\d+)/)
  if (!match) return null
  const parsed = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(parsed) ? parsed : null
}

export function extractIssueNumberFromPrBody(body: string): number | null {
  const match = body.match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i)
  if (!match) return null
  const parsed = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(parsed) ? parsed : null
}
