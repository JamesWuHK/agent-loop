import { $ } from 'bun'
import type { AgentConfig, Subtask } from '@agent/shared'
import {
  buildPlanningPrompt,
  parsePlanningOutput,
  findNextSubtask,
  buildSubtaskPrompt,
} from '@agent/shared'

const PLANNING_TIMEOUT_MS = 2 * 60 * 1000 // 2 minutes for planning
const SUBTASK_TIMEOUT_MS = 20 * 60 * 1000 // 20 minutes per subtask
const MAX_SUBTASK_ATTEMPTS = 2

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

  if (!planningOutput.ok) {
    return {
      success: false,
      subtasks: [],
      exitCode: planningOutput.exitCode,
      error: planningOutput.stderr || `exit code ${planningOutput.exitCode}`,
      durationMs: Date.now() - startTime,
    }
  }

  const planningText = planningOutput.stdout.trim()
  const subtasks = parsePlanningOutput(planningText)
  logger.log(`[subtask] planning produced ${subtasks.length} subtask(s)`)
  for (const s of subtasks) {
    logger.log(`[subtask]   [${s.order}] ${s.title}`)
  }

  // ── Step 2: Execute subtasks ───────────────────────────────────────────────
  let lastFailedId: string | null = null

  while (true) {
    const subtask = findNextSubtask(subtasks, lastFailedId)
    if (!subtask) break // all done or all failed

    lastFailedId = null // reset on each new subtask attempt
    subtask.attempts = (subtask.attempts ?? 0) + 1
    logger.log(
      `[subtask] executing #${subtask.order} (attempt ${subtask.attempts}/${MAX_SUBTASK_ATTEMPTS}): "${subtask.title}"`,
    )

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

    if (result.exitCode !== 0) {
      logger.warn(`[subtask] #${subtask.id} agent failed (exit ${result.exitCode})`)
      subtask.status = 'failed'
      if ((subtask.attempts ?? 0) >= MAX_SUBTASK_ATTEMPTS) {
        logger.error(
          `[subtask] #${subtask.id} exceeded max attempts (${MAX_SUBTASK_ATTEMPTS}): ${result.stderr || 'unknown error'}`,
        )
        break
      }
      lastFailedId = subtask.id
      continue
    }

    // HEAD verification: detect "exit 0 but no commit" false positives
    const afterHead = (await $`git -C ${worktreePath} rev-parse HEAD`.quiet().text()).trim()
    const realCommit = afterHead !== beforeHead

    if (!realCommit) {
      const workingTreeClean = (await $`git -C ${worktreePath} status --short`.quiet().text()).trim() === ''
      if (workingTreeClean) {
        logger.log(`[subtask] #${subtask.id} exited 0 with no new commit, but worktree is clean — treating as already satisfied`)
        subtask.status = 'done'
        lastFailedId = null
        continue
      }

      logger.warn(`[subtask] #${subtask.id} agent exited 0 but no commit was made — treating as failed`)
      subtask.status = 'failed'
      if ((subtask.attempts ?? 0) >= MAX_SUBTASK_ATTEMPTS) {
        logger.error(`[subtask] #${subtask.id} exceeded max attempts without producing a commit`)
        break
      }
      lastFailedId = subtask.id
      continue
    }

    logger.log(`[subtask] #${subtask.id} done (commit: ${afterHead.slice(0, 7)})`)
    subtask.status = 'done'
    lastFailedId = null
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

// ─── Internal helpers ────────────────────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms),
  )
  return Promise.race([promise, timeout])
}

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
  _logger: typeof console,
  _config: AgentConfig,
): Promise<AgentRunResult> {
  // Build clean env: remove VSCode plugin mode vars
  const cleanEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) cleanEnv[k] = v
  }
  delete cleanEnv['CLAUDE_CODE_ENTRYPOINT']
  delete cleanEnv['VSCODE_INJECTION_ID']

  let result: { exitCode: number; stdout: Buffer; stderr: Buffer }
  try {
    result = await withTimeout(
      $`${binaryPath} --print --dangerously-skip-permissions ${prompt}`
        .cwd(worktreePath)
        .env({
          ...cleanEnv,
          GIT_AUTHOR_NAME: 'agent-loop',
          GIT_COMMITTER_NAME: 'agent-loop',
          GIT_AUTHOR_EMAIL: 'agent-loop@local',
        })
        .quiet(),
      timeoutMs,
    )
  } catch (err) {
    if (err instanceof Error && err.message.includes('Timeout')) {
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
