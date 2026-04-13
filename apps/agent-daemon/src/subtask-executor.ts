import { $ } from 'bun'
import {
  buildPlanningPrompt,
  buildSubtaskPrompt,
  findNextSubtask,
  getExecutableValidationCommands,
  getAgentIssueByNumber,
  getProjectPromptGuidance,
  parseIssueContract,
  parsePlanningOutput,
  renderIssueContractForPrompt,
  type AgentConfig,
  type Subtask,
} from '@agent/shared'
import { runConfiguredAgent, type AgentFailureKind, type TaskExecutionMonitor } from './cli-agent'

const PLANNING_TIMEOUT_MS = 2 * 60 * 1000 // 2 minutes for planning

export function resolveAgentExecutionTimeoutMs(config: AgentConfig): number {
  return config.agent.timeoutMs
}

export interface SubtaskExecutorResult {
  success: boolean
  subtasks: Subtask[]
  exitCode: 0 | 1 | 2 | 3
  error?: string
  failureKind?: AgentFailureKind
  durationMs: number
  prNumber?: number
  prUrl?: string
}

/**
 * Execute the full subtask loop for an issue:
 * 1. Run planning agent to get subtask list
 * 2. Execute each subtask sequentially with HEAD verification
 * 3. Return aggregated result
 */
export async function runSubtaskExecutor(
  worktreePath: string,
  issueNumber: number,
  issueTitle: string,
  issueBody: string,
  config: AgentConfig,
  logger = console,
  monitor?: TaskExecutionMonitor,
): Promise<SubtaskExecutorResult> {
  const startTime = Date.now()

  // ── Step 1: Planning ──────────────────────────────────────────────────────
  monitor?.setPhase?.('planning')
  logger.log('[subtask] running planning agent...')
  const planningPrompt = buildPlanningPrompt(issueTitle, issueBody, config.project)
  const planningOutput = await runConfiguredAgent({
    prompt: planningPrompt,
    config,
    worktreePath,
    timeoutMs: PLANNING_TIMEOUT_MS,
    logger,
    allowWrites: false,
    monitor: monitor?.agentMonitor,
  })

  let subtasks: Subtask[]
  if (!planningOutput.ok) {
    if (planningOutput.failureKind === 'idle_timeout') {
      return {
        success: false,
        subtasks: [],
        exitCode: planningOutput.exitCode,
        error: planningOutput.stderr || planningOutput.stdout || 'planning agent hit idle timeout',
        failureKind: planningOutput.failureKind,
        durationMs: Date.now() - startTime,
      }
    }

    logger.warn(`[subtask] planning failed (${planningOutput.exitCode}): ${planningOutput.stderr || planningOutput.stdout || 'unknown error'} — falling back to single subtask`)
    subtasks = [{
      id: 'subtask-1',
      title: `Implement issue: ${issueTitle}`,
      status: 'pending',
      order: 1,
    }]
  } else {
    const planningText = planningOutput.responseText.trim()
    subtasks = parsePlanningOutput(planningText)
  }

  logger.log(`[subtask] planning produced ${subtasks.length} subtask(s)`)
  for (const s of subtasks) {
    logger.log(`[subtask]   [${s.order}] ${s.title}`)
  }

  // ── Step 2: Execute subtasks ───────────────────────────────────────────────
  let totalRetries = 0

  while (true) {
    const subtask = findNextSubtask(subtasks)
    if (!subtask) break // all done or no pending work remains

    logger.log(`[subtask] executing #${subtask.order}: "${subtask.title}"`)
    monitor?.setPhase?.(`subtask:${subtask.id}`)

    // Capture HEAD before agent runs
    const beforeHead = (await $`git -C ${worktreePath} rev-parse HEAD`.quiet().text()).trim()

    const subtaskPrompt = buildSubtaskPrompt(
      subtask,
      issueNumber,
      issueTitle,
      issueBody,
      config.project,
    )
    const result = await runConfiguredAgent({
      prompt: subtaskPrompt,
      worktreePath,
      timeoutMs: resolveAgentExecutionTimeoutMs(config),
      logger,
      config,
      allowWrites: true,
      monitor: monitor?.agentMonitor,
    })

    const afterHead = (await $`git -C ${worktreePath} rev-parse HEAD`.quiet().text()).trim()
    const realCommit = afterHead !== beforeHead

    if (result.exitCode !== 0) {
      if (realCommit) {
        logger.warn(`[subtask] #${subtask.id} agent exited ${result.exitCode} but produced commit ${afterHead.slice(0, 7)} — treating as success`)
        if (result.stderr) logger.warn(`[subtask] stderr: ${result.stderr.slice(0, 500)}`)
        if (result.stdout) logger.warn(`[subtask] stdout (tail): ${result.stdout.slice(-500)}`)
        subtask.status = 'done'
        continue
      }

      logger.warn(`[subtask] #${subtask.id} agent failed (exit ${result.exitCode})`)
      if (result.stderr) logger.warn(`[subtask] stderr: ${result.stderr.slice(0, 500)}`)
      if (result.stdout) logger.warn(`[subtask] stdout (tail): ${result.stdout.slice(-500)}`)
      subtask.status = 'failed'
      totalRetries++
      logger.error(`[subtask] stopping after failed subtask ${subtask.id}; manual review required`)
      break
    }

    // HEAD verification: detect "exit 0 but no commit" false positives
    if (!realCommit) {
      if (await shouldTreatCleanNoCommitSubtaskAsSuccess(
        worktreePath,
        config.git.defaultBranch,
        subtask.order,
      )) {
        logger.log(`[subtask] #${subtask.id} exited 0 with no new commit, but the worktree is clean and earlier commits already exist on the branch — treating as no-op success`)
        subtask.status = 'done'
        continue
      }

      logger.warn(`[subtask] #${subtask.id} agent exited 0 but no commit was made — treating as failed`)
      subtask.status = 'failed'
      totalRetries++
      logger.error(`[subtask] stopping after non-committing subtask ${subtask.id}; manual review required`)
      break
    }

    logger.log(`[subtask] #${subtask.id} done (commit: ${afterHead.slice(0, 7)})`)
    subtask.status = 'done'
  }

  // ── Step 3: Aggregate result ───────────────────────────────────────────────
  const allDone = subtasks.every(s => s.status === 'done')
  const anyFailed = subtasks.some(s => s.status === 'failed')

  return {
    success: allDone && subtasks.length > 0,
    subtasks,
    exitCode: allDone ? 0 : anyFailed ? 1 : 0,
    failureKind: anyFailed ? 'nonzero_exit' : undefined,
    durationMs: Date.now() - startTime,
  }
}

export interface ReviewAutoFixResult {
  success: boolean
  exitCode: 0 | 1 | 2 | 3
  outcome: 'committed' | 'salvaged' | 'agent_failed' | 'no_commit'
  error?: string
  commitSha?: string
  failureKind?: AgentFailureKind
}

export interface ReviewAutoFixScopeValidationResult {
  valid: boolean
  changedFiles: string[]
  violations: string[]
}

export interface IssueBranchValidationCommandResult {
  command: string
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface IssueBranchPreflightResult {
  valid: boolean
  changedFiles: string[]
  scopeViolations: string[]
  validationFailures: IssueBranchValidationCommandResult[]
  executableValidationCommands: string[]
  violations: string[]
}

export interface IssueRecoveryResult {
  success: boolean
  exitCode: 0 | 1 | 2 | 3
  error?: string
  commitSha?: string
  commitCreated: boolean
  failureKind?: AgentFailureKind
}

export type SalvageDirtyWorktreeResult =
  | {
      kind: 'committed'
      commitSha: string
    }
  | {
      kind: 'blocked'
      outOfScopeFiles: string[]
    }

export async function shouldTreatCleanNoCommitSubtaskAsSuccess(
  worktreePath: string,
  defaultBranch: string,
  subtaskOrder: number,
): Promise<boolean> {
  if (subtaskOrder <= 1) return false

  const status = (await $`git -C ${worktreePath} status --short`.quiet().text()).trim()
  if (status) return false

  let branchCommitCountRaw = ''
  try {
    branchCommitCountRaw = (await $`git -C ${worktreePath} rev-list --count origin/${defaultBranch}..HEAD`.quiet().text()).trim()
  } catch {
    branchCommitCountRaw = (await $`git -C ${worktreePath} rev-list --count ${defaultBranch}..HEAD`.quiet().text()).trim()
  }

  const branchCommitCount = Number.parseInt(branchCommitCountRaw, 10)

  return Number.isFinite(branchCommitCount) && branchCommitCount > 0
}

export async function salvageDirtyWorktree(
  worktreePath: string,
  commitMessage: string,
  config: AgentConfig,
  logger = console,
  allowedFiles: string[] = [],
): Promise<SalvageDirtyWorktreeResult | null> {
  const dirtyFiles = await readDirtyWorktreeFiles(worktreePath)
  if (dirtyFiles.length === 0) return null

  if (allowedFiles.length > 0) {
    const outOfScopeFiles = dirtyFiles.filter(
      (file) => !allowedFiles.some((pattern) => matchesContractFilePattern(file, pattern)),
    )
    if (outOfScopeFiles.length > 0) {
      logger.warn(
        `[salvage] blocked dirty worktree in ${worktreePath}; files outside AllowedFiles: ${outOfScopeFiles.join(', ')}`,
      )
      return {
        kind: 'blocked',
        outOfScopeFiles,
      }
    }
  }

  logger.warn(`[salvage] found uncommitted changes in ${worktreePath}; creating recovery commit`)

  await $`git -C ${worktreePath} add -A`.quiet()
  await $`git -C ${worktreePath} -c user.name=${config.git.authorName} -c user.email=${config.git.authorEmail} commit -m ${commitMessage}`.quiet()

  const commitSha = (await $`git -C ${worktreePath} rev-parse HEAD`.quiet().text()).trim()
  logger.log(`[salvage] created commit ${commitSha.slice(0, 7)} from pending worktree changes`)
  return {
    kind: 'committed',
    commitSha,
  }
}

export async function runIssueRecovery(
  worktreePath: string,
  issueNumber: number,
  issueTitle: string,
  issueBody: string,
  config: AgentConfig,
  logger = console,
  existingPr?: { number: number; url: string; branch: string } | null,
  recentBlockingReasons: string[] = [],
  monitor?: TaskExecutionMonitor,
): Promise<IssueRecoveryResult> {
  const issueContract = parseIssueContract(issueBody)
  const salvagedBeforeRun = await salvageDirtyWorktree(
    worktreePath,
    `fix(issue-recovery): salvage pending changes for issue #${issueNumber}`,
    config,
    logger,
    issueContract.allowedFiles,
  )
  if (salvagedBeforeRun?.kind === 'blocked') {
    return {
      success: false,
      exitCode: 1,
      error: formatBlockedSalvageError(salvagedBeforeRun.outOfScopeFiles),
      commitCreated: false,
    }
  }

  if (salvagedBeforeRun?.kind === 'committed') {
    return {
      success: true,
      exitCode: 0,
      commitSha: salvagedBeforeRun.commitSha,
      commitCreated: true,
    }
  }

  const beforeHead = (await $`git -C ${worktreePath} rev-parse HEAD`.quiet().text()).trim()
  const prompt = buildIssueRecoveryPrompt(
    issueNumber,
    issueTitle,
    issueBody,
    config.repo,
    existingPr ?? null,
    recentBlockingReasons,
    config.project,
    config.git.defaultBranch,
  )
  monitor?.setPhase?.('issue-recovery')
  const result = await runConfiguredAgent({
    prompt,
    worktreePath,
    config,
    timeoutMs: resolveAgentExecutionTimeoutMs(config),
    logger,
    allowWrites: true,
    monitor: monitor?.agentMonitor,
  })

  const afterHead = (await $`git -C ${worktreePath} rev-parse HEAD`.quiet().text()).trim()
  const commitCreated = beforeHead !== afterHead

  if (result.failureKind === 'remote_closed') {
    return {
      success: false,
      exitCode: result.exitCode,
      error: result.stderr || 'issue recovery aborted because the remote issue is already done/closed',
      commitCreated: false,
      failureKind: result.failureKind,
    }
  }

  if (result.exitCode !== 0) {
    if (commitCreated) {
      logger.warn(`[issue-recovery] agent exited ${result.exitCode} but created commit ${afterHead.slice(0, 7)} — continuing`)
      return {
        success: true,
        exitCode: 0,
        commitSha: afterHead,
        commitCreated: true,
      }
    }

    const salvagedCommit = await salvageDirtyWorktree(
      worktreePath,
      `fix(issue-recovery): salvage pending changes for issue #${issueNumber}`,
      config,
      logger,
      issueContract.allowedFiles,
    )
    if (salvagedCommit?.kind === 'blocked') {
      return {
        success: false,
        exitCode: result.exitCode,
        error: formatBlockedSalvageError(salvagedCommit.outOfScopeFiles),
        commitCreated: false,
        failureKind: result.failureKind,
      }
    }

    if (salvagedCommit?.kind === 'committed') {
      logger.warn(`[issue-recovery] agent exited ${result.exitCode} but left recoverable changes — continuing with salvaged commit ${salvagedCommit.commitSha.slice(0, 7)}`)
      return {
        success: true,
        exitCode: 0,
        commitSha: salvagedCommit.commitSha,
        commitCreated: true,
      }
    }

    return {
      success: false,
      exitCode: result.exitCode,
      error: result.stderr || result.stdout || `exit code ${result.exitCode}`,
      commitCreated: false,
      failureKind: result.failureKind,
    }
  }

  const branchCommitCount = Number.parseInt(
    (await $`git -C ${worktreePath} rev-list --count origin/${config.git.defaultBranch}..HEAD`.quiet().text()).trim(),
    10,
  )

  if (!commitCreated && (!Number.isFinite(branchCommitCount) || branchCommitCount <= 0)) {
    const salvagedCommit = await salvageDirtyWorktree(
      worktreePath,
      `fix(issue-recovery): salvage pending changes for issue #${issueNumber}`,
      config,
      logger,
      issueContract.allowedFiles,
    )
    if (salvagedCommit?.kind === 'blocked') {
      return {
        success: false,
        exitCode: 1,
        error: formatBlockedSalvageError(salvagedCommit.outOfScopeFiles),
        commitCreated: false,
      }
    }

    if (salvagedCommit?.kind === 'committed') {
      return {
        success: true,
        exitCode: 0,
        commitSha: salvagedCommit.commitSha,
        commitCreated: true,
      }
    }

    return {
      success: false,
      exitCode: 1,
      error: 'issue recovery exited 0 but the branch still has no commits to review',
      commitCreated: false,
    }
  }

  if (commitCreated) {
    logger.log(`[issue-recovery] created commit ${afterHead.slice(0, 7)} for issue #${issueNumber}`)
  } else {
    logger.log(`[issue-recovery] no new commit created for issue #${issueNumber}, continuing with existing branch state`)
  }

  return {
    success: true,
    exitCode: 0,
    commitSha: commitCreated ? afterHead : undefined,
    commitCreated,
  }
}

export async function runReviewAutoFix(
  worktreePath: string,
  issueNumber: number,
  prNumber: number,
  prUrl: string,
  reviewReason: string,
  config: AgentConfig,
  logger = console,
  monitor?: TaskExecutionMonitor,
): Promise<ReviewAutoFixResult> {
  const beforeHead = (await $`git -C ${worktreePath} rev-parse HEAD`.quiet().text()).trim()
  const linkedIssue = await getAgentIssueByNumber(issueNumber, config)
  const issueBody = linkedIssue?.body ?? ''
  const issueContract = parseIssueContract(issueBody)
  const prompt = buildReviewAutoFixPrompt(
    issueNumber,
    prNumber,
    prUrl,
    reviewReason,
    issueBody,
    config.project,
    config.git.defaultBranch,
  )
  monitor?.setPhase?.('review-auto-fix')
  const result = await runConfiguredAgent({
    prompt,
    worktreePath,
    config,
    timeoutMs: resolveAgentExecutionTimeoutMs(config),
    logger,
    allowWrites: true,
    monitor: monitor?.agentMonitor,
  })

  if (result.exitCode !== 0) {
    const salvagedCommit = await salvageDirtyWorktree(
      worktreePath,
      `fix(review-auto-fix): salvage pending changes for PR #${prNumber}`,
      config,
      logger,
      issueContract.allowedFiles,
    )
    if (salvagedCommit?.kind === 'blocked') {
      return {
        success: false,
        exitCode: result.exitCode,
        outcome: 'agent_failed',
        error: formatBlockedSalvageError(salvagedCommit.outOfScopeFiles),
        failureKind: result.failureKind,
      }
    }

    if (salvagedCommit?.kind === 'committed') {
      logger.warn(`[review-fix] agent exited ${result.exitCode} but left recoverable changes — continuing with salvaged commit ${salvagedCommit.commitSha.slice(0, 7)}`)
      return finalizeReviewAutoFixResult(
        worktreePath,
        issueBody,
        config,
        logger,
        prNumber,
        salvagedCommit.commitSha,
        'salvaged',
      )
    }

    return {
      success: false,
      exitCode: result.exitCode,
      outcome: 'agent_failed',
      error: result.stderr || result.stdout || `exit code ${result.exitCode}`,
      failureKind: result.failureKind,
    }
  }

  const afterHead = (await $`git -C ${worktreePath} rev-parse HEAD`.quiet().text()).trim()
  if (beforeHead === afterHead) {
    const salvagedCommit = await salvageDirtyWorktree(
      worktreePath,
      `fix(review-auto-fix): salvage pending changes for PR #${prNumber}`,
      config,
      logger,
      issueContract.allowedFiles,
    )
    if (salvagedCommit?.kind === 'blocked') {
      return {
        success: false,
        exitCode: 1,
        outcome: 'agent_failed',
        error: formatBlockedSalvageError(salvagedCommit.outOfScopeFiles),
      }
    }

    if (salvagedCommit?.kind === 'committed') {
      logger.log(`[review-fix] salvaged commit ${salvagedCommit.commitSha.slice(0, 7)} for PR #${prNumber}`)
      return finalizeReviewAutoFixResult(
        worktreePath,
        issueBody,
        config,
        logger,
        prNumber,
        salvagedCommit.commitSha,
        'salvaged',
      )
    }

    return {
      success: false,
      exitCode: 1,
      outcome: 'no_commit',
      error: 'auto-fix agent exited 0 but no commit was made',
    }
  }

  return finalizeReviewAutoFixResult(
    worktreePath,
    issueBody,
    config,
    logger,
    prNumber,
    afterHead,
    'committed',
  )
}

export function buildReviewAutoFixPrompt(
  issueNumber: number,
  prNumber: number,
  prUrl: string,
  reviewReason: string,
  issueBody = '',
  project: AgentConfig['project'] = { profile: 'generic' },
  defaultBranch = 'main',
): string {
  const projectGuidance = getProjectPromptGuidance(project, 'reviewFix')
  const issueContractBlock = issueBody.trim().length > 0
    ? renderIssueContractForPrompt(issueBody)
    : 'Parsed issue contract: unavailable because the linked issue body could not be loaded.'

  return `You are fixing review-blocking issues on an existing branch.

Issue #${issueNumber}
PR #${prNumber}
PR URL: ${prUrl}

Review feedback to fix:
${reviewReason}

Linked issue contract:
${issueContractBlock}

Requirements:
- Fix only the blocking issues described above.
- The review feedback may include a structured JSON block. Treat its fields as authoritative, especially \`mustFix\`, \`mustNotDo\`, \`validation\`, and \`scopeRationale\`.
- Preserve the linked issue's explicit acceptance contract; do not change semantics that the issue explicitly requires just to satisfy a different interpretation.
- Treat the linked issue's \`AllowedFiles\`, \`ForbiddenFiles\`, \`MustPreserve\`, \`OutOfScope\`, and \`RequiredSemantics\` as hard boundaries, even if the review feedback is incomplete.
- Never modify files listed under \`ForbiddenFiles\`. If a requested repair would require touching them, stop and leave the branch unchanged instead of expanding scope.
- Do not introduce new API calls, persistence, gateway actions, or unrelated refactors unless the review feedback proves they are required by the linked issue.
- Keep the touched file set as small as possible. If you find unrelated drift on the branch, prefer removing or reverting that drift rather than adding more code around it.
- Stay on the current branch and in the current worktree.
- Do not create a new branch.
- Do not create or modify PR metadata.
- Make the minimal code changes necessary.
- Before committing, run \`git diff --name-only origin/${defaultBranch}...HEAD\` and confirm the changed file set stays inside \`AllowedFiles\` and outside \`ForbiddenFiles\`.
- Commit your changes if you make any fixes.
- If no code change is needed, do not fake a commit.
${projectGuidance.length > 0 ? `${projectGuidance.map((line) => `- ${line}`).join('\n')}
` : ''}
`
}

export async function validateReviewAutoFixScope(
  worktreePath: string,
  issueBody: string,
  defaultBranch: string,
): Promise<ReviewAutoFixScopeValidationResult> {
  if (!issueBody.trim()) {
    return {
      valid: true,
      changedFiles: [],
      violations: [],
    }
  }

  const contract = parseIssueContract(issueBody)
  const changedFiles = await readChangedFilesAgainstDefaultBranch(worktreePath, defaultBranch)
  const violations: string[] = []

  if (contract.allowedFiles.length > 0) {
    const outsideAllowed = changedFiles.filter((file) => !contract.allowedFiles.some((pattern) => matchesContractFilePattern(file, pattern)))
    if (outsideAllowed.length > 0) {
      violations.push(`changed files outside AllowedFiles: ${outsideAllowed.join(', ')}`)
    }
  }

  const forbiddenTouched = changedFiles.filter((file) => contract.forbiddenFiles.some((pattern) => matchesContractFilePattern(file, pattern)))
  if (forbiddenTouched.length > 0) {
    violations.push(`changed forbidden files: ${forbiddenTouched.join(', ')}`)
  }

  return {
    valid: violations.length === 0,
    changedFiles,
    violations,
  }
}

export async function runIssueBranchPreflight(
  worktreePath: string,
  issueBody: string,
  config: AgentConfig,
  logger = console,
  monitor?: TaskExecutionMonitor,
): Promise<IssueBranchPreflightResult> {
  const scopeValidation = await validateReviewAutoFixScope(
    worktreePath,
    issueBody,
    config.git.defaultBranch,
  )
  const contract = parseIssueContract(issueBody)
  const executableValidationCommands = getExecutableValidationCommands(contract)
  const validationFailures: IssueBranchValidationCommandResult[] = []
  const violations = [...scopeValidation.violations]

  if (contract.validation.length > 0 && executableValidationCommands.length === 0) {
    violations.push('issue contract has no executable validation commands to run in preflight')
  }

  for (const command of executableValidationCommands) {
    monitor?.setPhase?.(`preflight:${command.slice(0, 48)}`)
    const result = await runValidationCommand(worktreePath, command, config)
    await monitor?.agentMonitor?.onActivity?.(result.stderr ? 'stderr' : 'stdout')

    if (result.exitCode !== 0) {
      validationFailures.push(result)
      const failureMode = result.timedOut
        ? `timed out after ${config.recovery.workerIdleTimeoutMs}ms`
        : `exit ${result.exitCode}`
      const output = summarizeValidationFailureOutput(result.stdout, result.stderr)
      violations.push(
        output
          ? `validation failed: ${command} (${failureMode}) — ${output}`
          : `validation failed: ${command} (${failureMode})`,
      )
      continue
    }

    logger.log(`[preflight] validation passed: ${command}`)
  }

  return {
    valid: violations.length === 0,
    changedFiles: scopeValidation.changedFiles,
    scopeViolations: scopeValidation.violations,
    validationFailures,
    executableValidationCommands,
    violations,
  }
}

async function finalizeReviewAutoFixResult(
  worktreePath: string,
  issueBody: string,
  config: AgentConfig,
  logger: typeof console,
  prNumber: number,
  commitSha: string,
  outcome: 'committed' | 'salvaged',
): Promise<ReviewAutoFixResult> {
  const preflight = await runIssueBranchPreflight(worktreePath, issueBody, config, logger)
  if (!preflight.valid) {
    logger.warn(
      `[review-fix] auto-fix commit ${commitSha.slice(0, 7)} for PR #${prNumber} failed issue preflight: ${preflight.violations.join('; ')}`,
    )
    return {
      success: false,
      exitCode: 1,
      outcome: 'agent_failed',
      error: `Issue preflight failed after auto-fix: ${preflight.violations.join('; ')}`,
      commitSha,
    }
  }

  logger.log(`[review-fix] created commit ${commitSha.slice(0, 7)} for PR #${prNumber}`)
  return {
    success: true,
    exitCode: 0,
    outcome,
    commitSha,
  }
}

async function readChangedFilesAgainstDefaultBranch(
  worktreePath: string,
  defaultBranch: string,
): Promise<string[]> {
  let raw = ''

  try {
    raw = await $`git -C ${worktreePath} diff --name-only origin/${defaultBranch}...HEAD`.quiet().text()
  } catch {
    raw = await $`git -C ${worktreePath} diff --name-only ${defaultBranch}...HEAD`.quiet().text()
  }

  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

async function readDirtyWorktreeFiles(worktreePath: string): Promise<string[]> {
  const raw = await $`git -C ${worktreePath} status --porcelain`.quiet().text()

  return raw
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((path) => {
      const renameSeparator = path.indexOf(' -> ')
      return renameSeparator >= 0 ? path.slice(renameSeparator + 4) : path
    })
    .map((path) => path.replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
}

function formatBlockedSalvageError(outOfScopeFiles: string[]): string {
  return `dirty worktree contains files outside AllowedFiles: ${outOfScopeFiles.join(', ')}`
}

async function runValidationCommand(
  worktreePath: string,
  command: string,
  config: AgentConfig,
): Promise<IssueBranchValidationCommandResult> {
  const normalizedCommand = normalizeLegacyDefaultBranchCommand(command, config.git.defaultBranch)
  const env: Record<string, string> = {
    ...process.env,
    PWD: worktreePath,
    GIT_AUTHOR_NAME: config.git.authorName,
    GIT_COMMITTER_NAME: config.git.authorName,
    GIT_AUTHOR_EMAIL: config.git.authorEmail,
    GIT_COMMITTER_EMAIL: config.git.authorEmail,
  }

  if (config.pat) {
    env.GH_TOKEN = config.pat
    env.GITHUB_TOKEN = config.pat
  } else {
    delete env.GH_TOKEN
    delete env.GITHUB_TOKEN
  }

  const proc = Bun.spawn(['/bin/sh', '-c', normalizedCommand], {
    cwd: worktreePath,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, config.recovery.workerIdleTimeoutMs)

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  clearTimeout(timeout)

  return {
    command,
    exitCode,
    stdout,
    stderr,
    timedOut,
  }
}

function summarizeValidationFailureOutput(stdout: string, stderr: string): string {
  const text = (stderr || stdout).trim().replace(/\s+/g, ' ')
  if (!text) return ''
  return text.length > 240 ? `${text.slice(0, 237)}...` : text
}

function normalizeLegacyDefaultBranchCommand(command: string, defaultBranch: string): string {
  if (defaultBranch === 'main') return command

  return command.replace(
    /\borigin\/main(?=(?:\.\.\.?HEAD)\b)/g,
    `origin/${defaultBranch}`,
  )
}

function matchesContractFilePattern(path: string, pattern: string): boolean {
  const normalizedPath = path.trim().replace(/^\.\//, '')
  const normalizedPattern = pattern.trim().replace(/^\.\//, '')
  if (!normalizedPattern) return false

  const escaped = normalizedPattern
    .replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*')

  return new RegExp(`^${escaped}$`).test(normalizedPath)
}

export function buildIssueRecoveryPrompt(
  issueNumber: number,
  issueTitle: string,
  issueBody: string,
  repo: string,
  existingPr: { number: number; url: string; branch: string } | null,
  recentBlockingReasons: string[],
  project: AgentConfig['project'] = { profile: 'generic' },
  defaultBranch = 'main',
): string {
  const projectGuidance = getProjectPromptGuidance(project, 'recovery')
  const remoteSyncGuidance = existingPr
    ? `2. Sync your local branch with the remote PR branch before doing anything else. Prefer:
   - \`git fetch origin ${existingPr.branch}\`
   - \`git rebase origin/${existingPr.branch}\`
   Resolve any rebase conflicts instead of ignoring them.`
    : `2. There is no existing PR branch to sync from. Do not run \`git rebase origin/<current-branch>\`, \`git pull --rebase\`, or similar self-sync commands against this managed branch unless you have first verified they are required for the issue itself. Start from the branch snapshot the daemon already prepared for you.`
  const blockingReasonsSection = recentBlockingReasons.length > 0
    ? `Latest automated blockers to fix first:
${recentBlockingReasons.map((reason, index) => `${index + 1}. ${reason}`).join('\n')}
`
    : 'Latest automated blockers to fix first: none recorded.\n'

  return `You are resuming a previously failed agent-loop issue inside its existing git worktree.

Issue #${issueNumber}
Title: ${issueTitle}
Repo: ${repo}
${existingPr ? `Existing PR #${existingPr.number}: ${existingPr.url}` : 'Existing PR: none yet'}

Issue description:
${issueBody || '(no description)'}

Your job:
1. Inspect the current branch state and existing partial implementation.
${remoteSyncGuidance}
3. Treat the latest blocking review feedback as input, but verify it against the issue scope before changing code.
4. If a blocker conflicts with the issue's explicit constraints or asks for later-scope work, do not expand scope just to satisfy that blocker.
5. Preserve the issue's explicit acceptance semantics. Do not "fix" review feedback by changing required behavior from the issue body or RED tests.
6. Remove unrelated branch drift instead of building on top of it. If a file or behavior is outside this issue's scope, prefer restoring it toward \`origin/${defaultBranch}\` unless the issue explicitly requires otherwise.
7. Do not introduce new API logic, persistence, gateway handlers, or broader app rewrites unless the issue explicitly requires them.
8. Finish the smallest remaining code changes needed to make this issue merge-ready.
9. Stay on the current branch and in the current worktree.
10. Commit your changes if you make any code changes.
11. If the existing branch is already merge-ready for this issue scope and no code change is needed, do not fake a commit.

${blockingReasonsSection}

Helpful checks:
- Run \`git status --short\`
- Run \`git log origin/${defaultBranch}..HEAD --oneline\`
- If review feedback includes structured JSON, treat \`mustFix\`, \`mustNotDo\`, \`validation\`, and \`scopeRationale\` as the recovery contract.
- Run \`git diff --stat origin/${defaultBranch}...HEAD\` and sanity-check that the changed files still match the issue scope.
${projectGuidance.map((line) => `- ${line}`).join('\n')}
${existingPr ? `- Run \`git log HEAD..origin/${existingPr.branch} --oneline\` to see whether the remote PR branch is ahead of you` : ''}
${existingPr ? `- Run \`gh api repos/${repo}/issues/${existingPr.number}/comments --paginate\` if you need the full review history` : ''}
`
}
