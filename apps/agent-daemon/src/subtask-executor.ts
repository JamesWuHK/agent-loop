import { $ } from 'bun'
import type { AgentConfig, AgentResult, Subtask } from '@agent/shared'
import {
  buildPlanningPrompt,
  parsePlanningOutput,
  findNextSubtask,
  buildSubtaskPrompt,
} from '@agent/shared'

const PLANNING_TIMEOUT_MS = 2 * 60 * 1000 // 2 minutes for planning
const SUBTASK_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes per subtask

export interface SubtaskExecutorResult {
  success: boolean
  subtasks: Subtask[]
  exitCode: 0 | 1 | 2 | 3
  error?: string
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
): Promise<SubtaskExecutorResult> {
  const startTime = Date.now()
  const binaryPath = config.agent.primary === 'claude'
    ? config.agent.claudePath
    : config.agent.codexPath

  // ── Step 1: Planning ──────────────────────────────────────────────────────
  logger.log('[subtask] running planning agent...')
  const planningPrompt = buildPlanningPrompt(issueTitle, issueBody)
  const planningOutput = await runAgentWithTimeout(
    binaryPath,
    planningPrompt,
    worktreePath,
    PLANNING_TIMEOUT_MS,
    logger,
    config,
  )

  let subtasks: Subtask[]
  if (!planningOutput.ok) {
    logger.warn(`[subtask] planning failed (${planningOutput.exitCode}): ${planningOutput.stderr || planningOutput.stdout || 'unknown error'} — falling back to single subtask`)
    subtasks = [{
      id: 'subtask-1',
      title: `Implement issue: ${issueTitle}`,
      status: 'pending',
      order: 1,
    }]
  } else {
    const planningText = planningOutput.stdout.trim()
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

    // Capture HEAD before agent runs
    const beforeHead = (await $`git -C ${worktreePath} rev-parse HEAD`.quiet().text()).trim()

    const subtaskPrompt = buildSubtaskPrompt(subtask, issueNumber)
    const result = await runAgentWithTimeout(
      binaryPath,
      subtaskPrompt,
      worktreePath,
      SUBTASK_TIMEOUT_MS,
      logger,
      config,
    )

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
    durationMs: Date.now() - startTime,
  }
}

export interface ReviewAutoFixResult {
  success: boolean
  exitCode: 0 | 1 | 2 | 3
  error?: string
  commitSha?: string
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

export async function runReviewAutoFix(
  worktreePath: string,
  issueNumber: number,
  prNumber: number,
  prUrl: string,
  reviewReason: string,
  config: AgentConfig,
  logger = console,
): Promise<ReviewAutoFixResult> {
  const binaryPath = config.agent.primary === 'claude'
    ? config.agent.claudePath
    : config.agent.codexPath

  const beforeHead = (await $`git -C ${worktreePath} rev-parse HEAD`.quiet().text()).trim()
  const prompt = buildReviewAutoFixPrompt(issueNumber, prNumber, prUrl, reviewReason)
  const result = await runAgentWithTimeout(
    binaryPath,
    prompt,
    worktreePath,
    SUBTASK_TIMEOUT_MS,
    logger,
    config,
  )

  if (result.exitCode !== 0) {
    return {
      success: false,
      exitCode: result.exitCode,
      error: result.stderr || result.stdout || `exit code ${result.exitCode}`,
    }
  }

  const afterHead = (await $`git -C ${worktreePath} rev-parse HEAD`.quiet().text()).trim()
  if (beforeHead === afterHead) {
    return {
      success: false,
      exitCode: 1,
      error: 'auto-fix agent exited 0 but no commit was made',
    }
  }

  logger.log(`[review-fix] created commit ${afterHead.slice(0, 7)} for PR #${prNumber}`)
  return {
    success: true,
    exitCode: 0,
    commitSha: afterHead,
  }
}

function buildReviewAutoFixPrompt(
  issueNumber: number,
  prNumber: number,
  prUrl: string,
  reviewReason: string,
): string {
  return `You are fixing review-blocking issues on an existing branch.

Issue #${issueNumber}
PR #${prNumber}
PR URL: ${prUrl}

Review feedback to fix:
${reviewReason}

Requirements:
- Fix only the blocking issues described above.
- Stay on the current branch and in the current worktree.
- Do not create a new branch.
- Do not create or modify PR metadata.
- Make the minimal code changes necessary.
- Commit your changes if you make any fixes.
- If no code change is needed, do not fake a commit.
`
}

// ─── Internal helpers ────────────────────────────────────────────────────────

interface AgentRunResult {
  ok: boolean
  exitCode: 0 | 1 | 2 | 3
  stdout: string
  stderr: string
}

async function runAgentWithTimeout(
  binaryPath: string,
  prompt: string,
  worktreePath: string,
  timeoutMs: number,
  logger: typeof console,
  config: AgentConfig,
): Promise<AgentRunResult> {
  // Build clean env: remove VSCode plugin mode vars
  const cleanEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) cleanEnv[k] = v
  }
  delete cleanEnv['CLAUDE_CODE_ENTRYPOINT']
  delete cleanEnv['VSCODE_INJECTION_ID']

  let result: { exitCode: number; stdout: Uint8Array; stderr: Uint8Array }
  let proc: ReturnType<typeof Bun.spawn> | null = null
  let timedOut = false
  try {
    proc = Bun.spawn([binaryPath, '--print', '--permission-mode', 'bypassPermissions'], {
      cwd: worktreePath,
      env: {
        ...cleanEnv,
        GIT_AUTHOR_NAME: 'agent-loop',
        GIT_COMMITTER_NAME: 'agent-loop',
        GIT_AUTHOR_EMAIL: 'agent-loop@local',
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdin = proc.stdin
    const stdout = proc.stdout
    const stderr = proc.stderr
    if (!stdin || !stdout || !stderr || typeof stdin === 'number' || typeof stdout === 'number' || typeof stderr === 'number') {
      throw new Error('Agent process stdio pipes were not created')
    }

    stdin.write(prompt)
    stdin.end()

    result = await Promise.race([
      (async () => {
        const [stdoutBuffer, stderrBuffer] = await Promise.all([
          new Response(stdout).arrayBuffer(),
          new Response(stderr).arrayBuffer(),
        ])
        const exitCode = await proc!.exited
        return { exitCode, stdout: new Uint8Array(stdoutBuffer), stderr: new Uint8Array(stderrBuffer) }
      })(),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          timedOut = true
          try {
            proc?.kill('SIGKILL')
          } catch {
            // ignore kill errors
          }
          reject(new Error(`Timeout after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } catch (err) {
    if (timedOut || (err instanceof Error && err.message.includes('Timeout'))) {
      return { ok: false, exitCode: 3, stdout: '', stderr: `Timeout after ${timeoutMs}ms` }
    }
    return { ok: false, exitCode: 1, stdout: '', stderr: String(err) }
  }

  const stdout = await new Response(result.stdout).text()
  const stderr = await new Response(result.stderr).text()

  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode === 0 ? 0 : 1,
    stdout,
    stderr,
  }
}
