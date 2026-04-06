import { $ } from 'bun'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { buildGhEnv, renderIssueContractForPrompt, type AgentConfig } from '@agent/shared'
import { runConfiguredAgent, type AgentFailureKind, type CliAgentRunOptions, type TaskExecutionMonitor } from './cli-agent'

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
  failureKind?: AgentFailureKind
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
  headRefName: string
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

interface AutomatedPrReviewMetadata {
  pr: number
  attempt: number
  approved: boolean
  canMerge: boolean
  headRefOid?: string
  issueContractFingerprint?: string
}

export interface AutomatedPrReviewCommentLike {
  body: string
  createdAt?: string
  updatedAt?: string
}

export interface LatestAutomatedPrReviewState {
  metadata: AutomatedPrReviewMetadata
  feedback: StructuredReviewFeedbackPayload | null
  commentCreatedAt: string | null
  commentUpdatedAt: string | null
}

export interface LatestAutomatedPrReviewBlockerSummary {
  attempt: number
  reason: string
  findingSummary: string | null
  commentCreatedAt: string | null
  commentUpdatedAt: string | null
}

export interface ReviewAgentResponse {
  responseText: string
}

export type ReviewAgentRunner = (
  prompt: string,
  worktreePath: string,
  config: AgentConfig,
  logger?: typeof console,
  monitor?: TaskExecutionMonitor,
) => Promise<ReviewAgentResponse>

class ReviewAgentExecutionError extends Error {
  constructor(
    message: string,
    readonly failureKind?: AgentFailureKind,
  ) {
    super(message)
    this.name = 'ReviewAgentExecutionError'
  }
}

const REVIEW_DEPENDENCY_DIRNAME = 'node_modules'
const REVIEW_DEPENDENCY_SCAN_DEPTH = 3
const MAX_REVIEW_OUTPUT_ATTEMPTS = 2
const DETACHED_REVIEW_EXCLUDE_MARKER = '# agent-loop detached review dependency symlinks'

/**
 * Review a PR using the configured CLI agent to determine if it can be merged.
 */
export async function reviewPr(
  prNumber: number,
  prUrl: string,
  worktreePath: string,
  config: AgentConfig,
  logger = console,
  monitor?: TaskExecutionMonitor,
): Promise<PrReviewResult> {
  logger.log(`[pr-review] starting review for PR #${prNumber}`)

  try {
    const context = await fetchPrReviewContext(prNumber, config)
    const result = await reviewPrAgainstContext(
      prNumber,
      prUrl,
      worktreePath,
      config.repo,
      context,
      config,
      logger,
      runReviewSubagentResponse,
      monitor,
    )
    logger.log(`[pr-review] PR #${prNumber} review complete: ${result.approved ? 'APPROVED' : 'REJECTED'}`)
    return result
  } catch (err) {
    logger.error(`[pr-review] review failed:`, err)
    return {
      approved: false,
      reason: `Review failed: ${String(err)}`,
      canMerge: false,
      reviewFailed: true,
      failureKind: err instanceof ReviewAgentExecutionError ? err.failureKind : undefined,
    }
  }
}

export async function reviewPrAgainstContext(
  prNumber: number,
  prUrl: string,
  worktreePath: string,
  repo: string,
  context: PrReviewContext,
  config: AgentConfig,
  logger = console,
  runAgent: ReviewAgentRunner = runReviewSubagentResponse,
  monitor?: TaskExecutionMonitor,
): Promise<PrReviewResult> {
  const basePrompt = buildReviewPrompt(prNumber, prUrl, repo, context)

  let prompt = basePrompt
  let lastParsedReview: PrReviewResult | null = null
  let lastFailureMessage = ''

  for (let attempt = 1; attempt <= MAX_REVIEW_OUTPUT_ATTEMPTS; attempt++) {
    monitor?.setPhase?.(attempt === 1 ? 'pr-review' : `pr-review-repair:${attempt}`)
    const response = await runAgent(prompt, worktreePath, config, logger, monitor)

    try {
      const parsed = parsePrReviewResponse(response.responseText)
      if (!parsed.reviewFailed) {
        return parsed
      }

      lastParsedReview = parsed
      lastFailureMessage = parsed.reason
    } catch {
      lastFailureMessage = `Failed to parse review response: ${response.responseText}`
    }

    if (attempt >= MAX_REVIEW_OUTPUT_ATTEMPTS) {
      if (lastParsedReview) {
        return lastParsedReview
      }

      throw new Error(lastFailureMessage)
    }

    logger.warn(
      `[pr-review] output contract invalid on attempt ${attempt}; retrying reviewer before commenting`,
    )
    prompt = buildReviewRepairPrompt(
      basePrompt,
      response.responseText,
      lastFailureMessage,
      attempt + 1,
    )
  }

  if (lastParsedReview) {
    return lastParsedReview
  }

  throw new Error(lastFailureMessage || 'Review failed without producing a usable result')
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
    'title,body,files,headRefName',
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
    headRefName: pr.headRefName ?? '',
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

  return `You are a daemon-launched PR review subagent running inside the checked-out PR worktree.
Review the actual branch contents in your current working tree, and use the diff below as supporting context.

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
3. Do not reject for intentionally out-of-scope work when the issue explicitly excludes it, such as future login flows, persistence, or API wiring not required by the issue.
4. Focus on concrete issues, not style nits.
5. Approve if the branch is ready to merge for this issue as scoped, even if later issues are still needed to complete the full feature.
6. When the issue provides AllowedFiles, ForbiddenFiles, MustPreserve, OutOfScope, RequiredSemantics, or ReviewHints, treat them as an executable review contract.
7. If you reject, explain how the diff violated the issue contract and what the fixer must not do while repairing it.
8. Every rejection finding is mandatory contract data: each finding must include mustFix, mustNotDo, validation, and scopeRationale. Missing any of them makes the review unusable.

Respond with JSON only:
{
  "approved": true,
  "canMerge": true,
  "reason": "brief explanation",
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

export function buildReviewRepairPrompt(
  basePrompt: string,
  invalidResponseText: string,
  failureReason: string,
  attempt: number,
): string {
  return `${basePrompt}

Your previous review output failed agent-loop validation before any PR comment was posted.
Repair attempt: ${attempt}

Validation failure:
${failureReason}

Previous response:
\`\`\`
${invalidResponseText.trim() || '(empty response)'}
\`\`\`

Return corrected JSON only.
Requirements:
- Keep the same review target: this PR, its checked-out branch, and the linked issue contract.
- If you reject, every finding must include \`mustFix\`, \`mustNotDo\`, \`validation\`, and \`scopeRationale\`.
- Do not output prose before or after the JSON.
- Do not use markdown fences around the corrected JSON.`
}

export function buildPrReviewComment(
  prNumber: number,
  review: PrReviewResult,
  attempt: number,
  action: 'approved' | 'retrying' | 'human-needed',
  headRefOid?: string,
  linkedIssueBody?: string | null,
): string {
  const issueContractFingerprint = buildIssueContractFingerprint(linkedIssueBody)
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
  const structuredFeedbackBlock = shouldEmbedStructuredReviewFeedback(review)
    ? `\n<!-- agent-loop:review-feedback ${JSON.stringify(buildStructuredReviewFeedbackPayload(review))} -->`
    : ''

  const metadata: AutomatedPrReviewMetadata = {
    pr: prNumber,
    attempt,
    approved: review.approved,
    canMerge: review.canMerge,
    ...(headRefOid ? { headRefOid } : {}),
    ...(issueContractFingerprint ? { issueContractFingerprint } : {}),
  }

  return `<!-- agent-loop:pr-review ${JSON.stringify(metadata)} -->
${structuredFeedbackBlock}
## ${title}

- Attempt: ${attempt}
- Merge ready: ${review.canMerge ? 'yes' : 'no'}
- Reason: ${review.reason}
${findingsBlock}

${nextStep}`
}

export function buildReviewFeedback(review: PrReviewResult): string {
  if (review.reviewFailed) {
    return review.reason
  }

  return serializeStructuredReviewFeedback(buildStructuredReviewFeedbackPayload(review))
}

export function extractAutomatedReviewReasons(
  comments: Array<{ body: string }>,
  limit = 2,
): string[] {
  const reasons: string[] = []

  for (let index = comments.length - 1; index >= 0; index--) {
    const body = comments[index]?.body ?? ''
    if (!body.includes('<!-- agent-loop:pr-review')) continue

    if (body.includes('<!-- agent-loop:review-feedback ')) {
      const structuredFeedback = extractStructuredReviewFeedback(body)
      if (!structuredFeedback) continue

      const combined = serializeStructuredReviewFeedback(structuredFeedback)
      if (!reasons.includes(combined)) {
        reasons.push(combined)
        if (reasons.length >= limit) break
      }
      continue
    }

    const reasonMatch = body.match(/- Reason:\s+([^\n]+)/)
    if (!reasonMatch) continue

    const reason = reasonMatch[1]!.trim()
    const findings = [...body.matchAll(/^  - (.+)$/gm)].map((match) => match[1]!.trim())
    const combined = findings.length > 0
      ? `${reason}\n\nBlocking findings:\n${findings.map((finding) => `- ${finding}`).join('\n')}`
      : reason
    if (!combined || reasons.includes(combined)) continue

    reasons.push(combined)
    if (reasons.length >= limit) break
  }

  return reasons
}

export function extractLatestAutomatedPrReviewState(
  comments: AutomatedPrReviewCommentLike[],
): LatestAutomatedPrReviewState | null {
  for (let index = comments.length - 1; index >= 0; index--) {
    const metadata = extractAutomatedPrReviewMetadata(comments[index]?.body ?? '')
    if (!metadata) continue

    return {
      metadata,
      feedback: extractStructuredReviewFeedback(comments[index]?.body ?? ''),
      commentCreatedAt: comments[index]?.createdAt ?? null,
      commentUpdatedAt: comments[index]?.updatedAt ?? comments[index]?.createdAt ?? null,
    }
  }

  return null
}

export function extractLatestAutomatedPrReviewBlockerSummary(
  comments: AutomatedPrReviewCommentLike[],
): LatestAutomatedPrReviewBlockerSummary | null {
  for (let index = comments.length - 1; index >= 0; index--) {
    const comment = comments[index]
    const body = comment?.body ?? ''
    const metadata = extractAutomatedPrReviewMetadata(body)
    if (!metadata) continue
    if (metadata.approved || metadata.canMerge) return null

    const feedback = extractStructuredReviewFeedback(body)
    const reason = feedback?.reason ?? extractLegacyAutomatedPrReviewReason(body)
    if (!reason) return null

    return {
      attempt: metadata.attempt,
      reason,
      findingSummary: feedback?.findings?.[0]?.summary ?? extractLegacyAutomatedPrReviewFindingSummary(body),
      commentCreatedAt: comment?.createdAt ?? null,
      commentUpdatedAt: comment?.updatedAt ?? comment?.createdAt ?? null,
    }
  }

  return null
}

export function getNextAutomatedPrReviewAttempt(
  comments: AutomatedPrReviewCommentLike[],
): number {
  const latest = extractLatestAutomatedPrReviewState(comments)
  return latest ? latest.metadata.attempt + 1 : 1
}

export function canResumeAutomatedPrReview(
  comments: AutomatedPrReviewCommentLike[],
  maxAttempt: number,
): boolean {
  const latest = extractLatestAutomatedPrReviewState(comments)
  if (!latest) return false

  return (
    latest.metadata.approved === false
    && latest.metadata.canMerge === false
    && latest.feedback !== null
    && latest.metadata.attempt < maxAttempt
  )
}

export function shouldRestartAutomatedPrReviewOnNewHead(
  comments: AutomatedPrReviewCommentLike[],
  currentHeadRefOid: string | null | undefined,
): boolean {
  if (!currentHeadRefOid) return false

  const latest = extractLatestAutomatedPrReviewState(comments)
  if (!latest) return false
  if (latest.metadata.approved || latest.metadata.canMerge) return false
  if (!latest.metadata.headRefOid) return false

  return latest.metadata.headRefOid !== currentHeadRefOid
}

export function shouldRestartAutomatedPrReviewOnIssueUpdate(
  comments: AutomatedPrReviewCommentLike[],
  issueBody: string | null | undefined,
): boolean {
  const currentIssueContractFingerprint = buildIssueContractFingerprint(issueBody)
  if (!currentIssueContractFingerprint) return false

  const latest = extractLatestAutomatedPrReviewState(comments)
  if (!latest) return false
  if (latest.metadata.approved || latest.metadata.canMerge) return false

  const latestIssueContractFingerprint = latest.metadata.issueContractFingerprint
  if (!latestIssueContractFingerprint) return false

  return latestIssueContractFingerprint !== currentIssueContractFingerprint
}

export function canResumeHumanNeededPrReview(
  comments: AutomatedPrReviewCommentLike[],
  maxAttempt: number,
  currentHeadRefOid: string | null | undefined,
  issueBody: string | null | undefined,
): boolean {
  return (
    canResumeAutomatedPrReview(comments, maxAttempt)
    || shouldRestartAutomatedPrReviewOnNewHead(comments, currentHeadRefOid)
    || shouldRestartAutomatedPrReviewOnIssueUpdate(comments, issueBody)
  )
}

export function getReusableAutomatedPrReviewFeedback(
  comments: AutomatedPrReviewCommentLike[],
  currentHeadRefOid: string,
  maxAttempt: number,
): { attempt: number; feedback: StructuredReviewFeedbackPayload } | null {
  const latest = extractLatestAutomatedPrReviewState(comments)
  if (!latest) return null
  if (latest.feedback === null) return null
  if (latest.metadata.approved || latest.metadata.canMerge) return null
  if (latest.metadata.attempt >= maxAttempt) return null
  if (!latest.metadata.headRefOid || latest.metadata.headRefOid !== currentHeadRefOid) return null

  return {
    attempt: latest.metadata.attempt,
    feedback: latest.feedback,
  }
}

export function buildReviewRunOptions(
  prompt: string,
  worktreePath: string,
  config: AgentConfig,
  logger = console,
  monitor?: TaskExecutionMonitor,
): CliAgentRunOptions {
  return {
    prompt,
    worktreePath,
    timeoutMs: Math.min(config.agent.timeoutMs, 10 * 60 * 1000),
    config,
    logger,
    allowWrites: false,
    monitor: monitor?.agentMonitor,
  }
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
        const severity = typeof finding.severity === 'string' && finding.severity.trim().length > 0
          ? finding.severity.trim()
          : 'issue'
        const file = typeof finding.file === 'string' ? finding.file.trim() : ''
        return {
          severity,
          file,
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

export function classifyPrReviewOutcome(
  review: Pick<PrReviewResult, 'approved' | 'canMerge' | 'reviewFailed' | 'reason'>,
): 'approved' | 'rejected' | 'invalid_output' | 'execution_failed' {
  if (review.approved && review.canMerge) {
    return 'approved'
  }

  if (!review.reviewFailed) {
    return 'rejected'
  }

  if (review.reason.startsWith('Review output failed validation:')) {
    return 'invalid_output'
  }

  return 'execution_failed'
}

export function normalizeWorktreePath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function isMissingGitWorktreeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message || ''
  return message.includes('is not a working tree')
}

async function runReviewSubagentResponse(
  prompt: string,
  worktreePath: string,
  config: AgentConfig,
  logger = console,
  monitor?: TaskExecutionMonitor,
): Promise<ReviewAgentResponse> {
  logger.log(`[pr-review] launching review subagent in ${worktreePath}`)
  const result = await runConfiguredAgent(buildReviewRunOptions(
    prompt,
    worktreePath,
    config,
    logger,
    monitor,
  ))

  if (!result.ok) {
    throw new ReviewAgentExecutionError(
      `Agent exited with code ${result.exitCode}: ${result.stderr || result.stdout}`,
      result.failureKind,
    )
  }

  return {
    responseText: result.responseText,
  }
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

function shouldEmbedStructuredReviewFeedback(review: PrReviewResult): boolean {
  return !review.reviewFailed
}

function extractAutomatedPrReviewMetadata(body: string): AutomatedPrReviewMetadata | null {
  const match = body.match(/<!-- agent-loop:pr-review ([\s\S]*?) -->/)
  if (!match?.[1]) return null

  try {
    const parsed = JSON.parse(match[1]) as Partial<AutomatedPrReviewMetadata>
    const pr = Number(parsed.pr)
    const attempt = Number(parsed.attempt)
    if (!Number.isFinite(pr) || !Number.isFinite(attempt)) {
      return null
    }

    return {
      pr,
      attempt,
      approved: parsed.approved === true,
      canMerge: parsed.canMerge === true,
      headRefOid: typeof parsed.headRefOid === 'string' && parsed.headRefOid.trim().length > 0
        ? parsed.headRefOid.trim()
        : undefined,
      issueContractFingerprint: typeof parsed.issueContractFingerprint === 'string'
        && parsed.issueContractFingerprint.trim().length > 0
        ? parsed.issueContractFingerprint.trim()
        : undefined,
    }
  } catch {
    return null
  }
}

function buildIssueContractFingerprint(body: string | null | undefined): string | null {
  if (typeof body !== 'string' || body.trim().length === 0) return null

  return createHash('sha256')
    .update(renderIssueContractForPrompt(body))
    .digest('hex')
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

function extractStructuredReviewFeedback(body: string): StructuredReviewFeedbackPayload | null {
  const match = body.match(/<!-- agent-loop:review-feedback ([\s\S]*?) -->/)
  if (!match?.[1]) return null

  try {
    const parsed = JSON.parse(match[1]) as Partial<StructuredReviewFeedbackPayload>
    const findings = Array.isArray(parsed.findings)
      ? parsed.findings
        .map((finding) => {
          if (!finding) return null
          const normalized = finding as PrReviewFinding
          if (typeof normalized.summary !== 'string' || normalized.summary.trim().length === 0) {
            return null
          }
          return {
            severity: typeof normalized.severity === 'string' && normalized.severity.trim().length > 0
              ? normalized.severity.trim()
              : 'issue',
            file: typeof normalized.file === 'string' ? normalized.file.trim() : '',
            summary: normalized.summary.trim(),
            mustFix: normalizeReviewInstructionList(normalized.mustFix),
            mustNotDo: normalizeReviewInstructionList(normalized.mustNotDo),
            validation: normalizeReviewInstructionList(normalized.validation),
            scopeRationale: typeof normalized.scopeRationale === 'string' && normalized.scopeRationale.trim().length > 0
              ? normalized.scopeRationale.trim()
              : undefined,
          } satisfies PrReviewFinding
        })
        .filter((finding): finding is NonNullable<typeof finding> => Boolean(finding))
      : []

    const payload = {
      approved: parsed.approved === true,
      canMerge: parsed.canMerge === true,
      reason: typeof parsed.reason === 'string' && parsed.reason.trim().length > 0
        ? parsed.reason.trim()
        : findings[0]?.summary ?? 'No reason provided',
      findings,
    }

    return validateRejectedReviewFindings(payload).length === 0 ? payload : null
  } catch {
    return null
  }
}

function extractLegacyAutomatedPrReviewReason(body: string): string | null {
  const reasonMatch = body.match(/- Reason:\s+([^\n]+)/)
  const reason = reasonMatch?.[1]?.trim() ?? ''
  return reason.length > 0 ? reason : null
}

function extractLegacyAutomatedPrReviewFindingSummary(body: string): string | null {
  const findingMatch = body.match(/^  - (.+)$/m)
  const finding = findingMatch?.[1]?.trim() ?? ''
  return finding.length > 0 ? finding : null
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

export function collectDependencyDirectories(
  repoRoot: string,
  maxDepth = REVIEW_DEPENDENCY_SCAN_DEPTH,
): string[] {
  const directories: string[] = []

  const visit = (currentPath: string, depth: number): void => {
    if (depth > maxDepth) return

    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue

      const entryPath = join(currentPath, entry.name)
      if (entry.name === REVIEW_DEPENDENCY_DIRNAME) {
        directories.push(relative(repoRoot, entryPath))
        continue
      }

      visit(entryPath, depth + 1)
    }
  }

  visit(repoRoot, 0)
  return directories.sort()
}

export function hydrateDetachedReviewWorktree(
  repoRoot: string,
  worktreePath: string,
  logger = console,
): void {
  const dependencyDirectories = collectDependencyDirectories(repoRoot)
  const linkedDependencyDirectories: string[] = []

  for (const relativePath of dependencyDirectories) {
    const sourcePath = join(repoRoot, relativePath)
    const targetPath = join(worktreePath, relativePath)
    const targetParentPath = dirname(targetPath)

    if (targetParentPath !== worktreePath && !existsSync(targetParentPath)) {
      logger.log(`[pr-review] skipped ${relativePath} because ${relative(worktreePath, targetParentPath)} is not present in detached review worktree`)
      continue
    }

    if (existsSync(targetPath)) {
      if (dependencyTargetMatchesSource(targetPath, sourcePath)) continue
      rmSync(targetPath, { recursive: true, force: true })
      logger.log(`[pr-review] replaced stale ${relativePath} in detached review worktree`)
    }

    mkdirSync(targetParentPath, { recursive: true })
    symlinkSync(sourcePath, targetPath, 'dir')
    linkedDependencyDirectories.push(relativePath)
    logger.log(`[pr-review] linked ${relativePath} into detached review worktree`)
  }

  registerDetachedReviewWorktreeExcludes(worktreePath, linkedDependencyDirectories, logger)
}

function dependencyTargetMatchesSource(targetPath: string, sourcePath: string): boolean {
  try {
    return realpathSync(targetPath) === realpathSync(sourcePath)
  } catch {
    return false
  }
}

function registerDetachedReviewWorktreeExcludes(
  worktreePath: string,
  relativePaths: string[],
  logger = console,
): void {
  if (relativePaths.length === 0) return

  const commonGitDir = resolveCommonGitDirForWorktree(worktreePath)
  if (!commonGitDir) return

  const excludePath = join(commonGitDir, 'info', 'exclude')
  const existingContent = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
  const existingEntries = new Set(
    existingContent
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#')),
  )

  const additions = relativePaths
    .flatMap((path) => {
      const normalized = path.trim().replace(/\\/g, '/').replace(/^\/+/, '')
      if (!normalized) return []
      return [`/${normalized}`, `/${normalized}/`]
    })
    .filter((path) => !existingEntries.has(path))

  if (additions.length === 0) return

  let nextContent = existingContent
  if (nextContent.length > 0 && !nextContent.endsWith('\n')) {
    nextContent += '\n'
  }
  if (!nextContent.includes(DETACHED_REVIEW_EXCLUDE_MARKER)) {
    nextContent += `${DETACHED_REVIEW_EXCLUDE_MARKER}\n`
  }
  nextContent += `${additions.join('\n')}\n`

  mkdirSync(dirname(excludePath), { recursive: true })
  writeFileSync(excludePath, nextContent, 'utf8')
  logger.log(`[pr-review] excluded ${additions.length} dependency paths from git status in detached review worktree`)
}

function resolveCommonGitDirForWorktree(worktreePath: string): string | null {
  const gitEntryPath = join(worktreePath, '.git')
  if (!existsSync(gitEntryPath)) return null

  const gitEntryStat = lstatSync(gitEntryPath)
  if (gitEntryStat.isDirectory()) {
    return gitEntryPath
  }

  const gitFile = readFileSync(gitEntryPath, 'utf8').trim()
  const match = gitFile.match(/^gitdir:\s*(.+)$/i)
  if (!match?.[1]) return null

  const gitDir = resolve(worktreePath, match[1])
  const commonDirPath = join(gitDir, 'commondir')
  if (!existsSync(commonDirPath)) {
    return gitDir
  }

  const commonDir = readFileSync(commonDirPath, 'utf8').trim()
  return commonDir ? resolve(gitDir, commonDir) : gitDir
}

export async function createDetachedPrWorktree(
  prNumber: number,
  config: AgentConfig,
  logger = console,
): Promise<{ worktreePath: string; cleanup: () => Promise<void>; headRefName: string }> {
  const context = await fetchPrReviewContext(prNumber, config)
  if (!context.headRefName) {
    throw new Error(`PR #${prNumber} is missing headRefName`)
  }

  const repoRoot = await resolveRepoRoot()
  const worktreePath = normalizeWorktreePath(
    mkdtempSync(join(tmpdir(), 'agent-loop-pr-review-')),
  )

  await $`git -C ${repoRoot} fetch origin ${context.headRefName}`.quiet()
  await $`git -C ${repoRoot} worktree add --detach ${worktreePath} origin/${context.headRefName}`.quiet()
  hydrateDetachedReviewWorktree(repoRoot, worktreePath, logger)
  logger.log(`[pr-review] created detached review worktree ${worktreePath} for ${context.headRefName}`)

  return {
    worktreePath,
    headRefName: context.headRefName,
    cleanup: async () => {
      try {
        await $`git -C ${repoRoot} worktree remove --force ${worktreePath}`.quiet()
      } catch (error) {
        if (!isMissingGitWorktreeError(error)) {
          throw error
        }
        logger.warn(`[pr-review] worktree already gone during cleanup: ${worktreePath}`)
      } finally {
        rmSync(worktreePath, { recursive: true, force: true })
      }
    },
  }
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

async function resolveRepoRoot(): Promise<string> {
  return (await $`git rev-parse --show-toplevel`.quiet().text()).trim()
}
