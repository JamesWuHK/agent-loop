import { $ } from 'bun'
import { getProjectPromptGuidance, type AgentConfig, type Subtask } from '@agent/shared'
import {
  buildPlanningPrompt,
  parsePlanningOutput,
  findNextSubtask,
  buildSubtaskPrompt,
} from '@agent/shared'
import { runConfiguredAgent, type AgentFailureKind, type TaskExecutionMonitor } from './cli-agent'

const PLANNING_TIMEOUT_MS = 2 * 60 * 1000 // 2 minutes for planning
const SUBTASK_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes per subtask

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
      timeoutMs: SUBTASK_TIMEOUT_MS,
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

export interface IssueRecoveryResult {
  success: boolean
  exitCode: 0 | 1 | 2 | 3
  error?: string
  commitSha?: string
  commitCreated: boolean
  failureKind?: AgentFailureKind
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
): Promise<string | null> {
  const status = (await $`git -C ${worktreePath} status --short`.quiet().text()).trim()
  if (!status) return null

  logger.warn(`[salvage] found uncommitted changes in ${worktreePath}; creating recovery commit`)

  await $`git -C ${worktreePath} add -A`.quiet()
  await $`git -C ${worktreePath} -c user.name=${config.git.authorName} -c user.email=${config.git.authorEmail} commit -m ${commitMessage}`.quiet()

  const commitSha = (await $`git -C ${worktreePath} rev-parse HEAD`.quiet().text()).trim()
  logger.log(`[salvage] created commit ${commitSha.slice(0, 7)} from pending worktree changes`)
  return commitSha
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
  const salvagedBeforeRun = await salvageDirtyWorktree(
    worktreePath,
    `fix(issue-recovery): salvage pending changes for issue #${issueNumber}`,
    config,
    logger,
  )
  if (salvagedBeforeRun) {
    return {
      success: true,
      exitCode: 0,
      commitSha: salvagedBeforeRun,
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
  )
  monitor?.setPhase?.('issue-recovery')
  const result = await runConfiguredAgent({
    prompt,
    worktreePath,
    config,
    timeoutMs: SUBTASK_TIMEOUT_MS,
    logger,
    allowWrites: true,
    monitor: monitor?.agentMonitor,
  })

  const afterHead = (await $`git -C ${worktreePath} rev-parse HEAD`.quiet().text()).trim()
  const commitCreated = beforeHead !== afterHead

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
    )
    if (salvagedCommit) {
      logger.warn(`[issue-recovery] agent exited ${result.exitCode} but left recoverable changes — continuing with salvaged commit ${salvagedCommit.slice(0, 7)}`)
      return {
        success: true,
        exitCode: 0,
        commitSha: salvagedCommit,
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
    )
    if (salvagedCommit) {
      return {
        success: true,
        exitCode: 0,
        commitSha: salvagedCommit,
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
  const prompt = buildReviewAutoFixPrompt(
    issueNumber,
    prNumber,
    prUrl,
    reviewReason,
    config.project,
  )
  monitor?.setPhase?.('review-auto-fix')
  const result = await runConfiguredAgent({
    prompt,
    worktreePath,
    config,
    timeoutMs: SUBTASK_TIMEOUT_MS,
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
    )
    if (salvagedCommit) {
      logger.warn(`[review-fix] agent exited ${result.exitCode} but left recoverable changes — continuing with salvaged commit ${salvagedCommit.slice(0, 7)}`)
      return {
        success: true,
        exitCode: 0,
        outcome: 'salvaged',
        commitSha: salvagedCommit,
      }
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
    )
    if (salvagedCommit) {
      logger.log(`[review-fix] salvaged commit ${salvagedCommit.slice(0, 7)} for PR #${prNumber}`)
      return {
        success: true,
        exitCode: 0,
        outcome: 'salvaged',
        commitSha: salvagedCommit,
      }
    }

    return {
      success: false,
      exitCode: 1,
      outcome: 'no_commit',
      error: 'auto-fix agent exited 0 but no commit was made',
    }
  }

  logger.log(`[review-fix] created commit ${afterHead.slice(0, 7)} for PR #${prNumber}`)
  return {
    success: true,
    exitCode: 0,
    outcome: 'committed',
    commitSha: afterHead,
  }
}

export function buildReviewAutoFixPrompt(
  issueNumber: number,
  prNumber: number,
  prUrl: string,
  reviewReason: string,
  project: AgentConfig['project'] = { profile: 'generic' },
): string {
  const projectGuidance = getProjectPromptGuidance(project, 'reviewFix')

  return `You are fixing review-blocking issues on an existing branch.

Issue #${issueNumber}
PR #${prNumber}
PR URL: ${prUrl}

Review feedback to fix:
${reviewReason}

Requirements:
- Fix only the blocking issues described above.
- The review feedback may include a structured JSON block. Treat its fields as authoritative, especially \`mustFix\`, \`mustNotDo\`, \`validation\`, and \`scopeRationale\`.
- Preserve the linked issue's explicit acceptance contract; do not change semantics that the issue explicitly requires just to satisfy a different interpretation.
- Do not introduce new API calls, persistence, gateway actions, or unrelated refactors unless the review feedback proves they are required by the linked issue.
- Keep the touched file set as small as possible. If you find unrelated drift on the branch, prefer removing or reverting that drift rather than adding more code around it.
- Stay on the current branch and in the current worktree.
- Do not create a new branch.
- Do not create or modify PR metadata.
- Make the minimal code changes necessary.
- Commit your changes if you make any fixes.
- If no code change is needed, do not fake a commit.
${projectGuidance.length > 0 ? `${projectGuidance.map((line) => `- ${line}`).join('\n')}
` : ''}
`
}

export function buildIssueRecoveryPrompt(
  issueNumber: number,
  issueTitle: string,
  issueBody: string,
  repo: string,
  existingPr: { number: number; url: string; branch: string } | null,
  recentBlockingReasons: string[],
  project: AgentConfig['project'] = { profile: 'generic' },
): string {
  const projectGuidance = getProjectPromptGuidance(project, 'recovery')
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
2. If there is an existing PR branch, sync your local branch with the remote PR branch before doing anything else. Prefer:
   - \`git fetch origin ${existingPr?.branch ?? 'your-branch'}\`
   - \`git rebase origin/${existingPr?.branch ?? 'your-branch'}\`
   Resolve any rebase conflicts instead of ignoring them.
3. Treat the latest blocking review feedback as input, but verify it against the issue scope before changing code.
4. If a blocker conflicts with the issue's explicit constraints or asks for later-scope work, do not expand scope just to satisfy that blocker.
5. Preserve the issue's explicit acceptance semantics. Do not "fix" review feedback by changing required behavior from the issue body or RED tests.
6. Remove unrelated branch drift instead of building on top of it. If a file or behavior is outside this issue's scope, prefer restoring it toward \`origin/main\` unless the issue explicitly requires otherwise.
7. Do not introduce new API logic, persistence, gateway handlers, or broader app rewrites unless the issue explicitly requires them.
8. Finish the smallest remaining code changes needed to make this issue merge-ready.
9. Stay on the current branch and in the current worktree.
10. Commit your changes if you make any code changes.
11. If the existing branch is already merge-ready for this issue scope and no code change is needed, do not fake a commit.

${blockingReasonsSection}

Helpful checks:
- Run \`git status --short\`
- Run \`git log origin/main..HEAD --oneline\`
- If review feedback includes structured JSON, treat \`mustFix\`, \`mustNotDo\`, \`validation\`, and \`scopeRationale\` as the recovery contract.
- Run \`git diff --stat origin/main...HEAD\` and sanity-check that the changed files still match the issue scope.
${projectGuidance.map((line) => `- ${line}`).join('\n')}
${existingPr ? `- Run \`git log HEAD..origin/${existingPr.branch} --oneline\` to see whether the remote PR branch is ahead of you` : ''}
${existingPr ? `- Run \`gh api repos/${repo}/issues/${existingPr.number}/comments --paginate\` if you need the full review history` : ''}
`
}
