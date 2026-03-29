import { resolve } from 'node:path'
import { writeFileSync } from 'node:fs'
import { $ } from 'bun'
import type { AgentConfig, AgentResult } from '@agent/shared'
import { recordAgentExecution } from './metrics'

/**
 * Execute Claude Code or Codex CLI in the given worktree.
 * Primary: Claude Code, Fallback: Codex CLI, then error.
 */
export async function runAgent(
  worktreePath: string,
  issueNumber: number,
  issueTitle: string,
  issueBody: string,
  config: AgentConfig,
  logger = console,
): Promise<AgentResult> {
  const startTime = Date.now()
  const timeoutMs = config.agent.timeoutMs

  logger.log(`[agent] starting agent execution in ${worktreePath}`)
  logger.log(`[agent] issue: #${issueNumber} — ${issueTitle}`)

  const primaryBinary = config.agent.primary === 'claude'
    ? config.agent.claudePath
    : config.agent.codexPath

  const fallbackBinary = config.agent.fallback
    ? (config.agent.fallback === 'claude'
        ? config.agent.claudePath
        : config.agent.codexPath)
    : null

  // Write prompt file for the agent
  const promptPath = resolve(worktreePath, 'prompt.md')
  const prompt = buildPrompt(issueNumber, issueTitle, issueBody)
  writeFileSync(promptPath, prompt, 'utf-8')

  // Try primary agent
  const primaryResult = await runClaude(primaryBinary, worktreePath, prompt, timeoutMs, logger)

  if (primaryResult.exitCode === 0) {
    const result = { ...primaryResult, durationMs: Date.now() - startTime }
    recordAgentExecution(true, config.agent.primary, result.durationMs)
    return result
  }

  // Try fallback if primary failed and fallback is configured
  if (fallbackBinary && fallbackBinary !== primaryBinary) {
    logger.warn(`[agent] primary agent failed (exit ${primaryResult.exitCode}), trying fallback...`)
    const fallbackResult = await runClaude(fallbackBinary, worktreePath, prompt, timeoutMs, logger)
    const result = { ...fallbackResult, durationMs: Date.now() - startTime }
    recordAgentExecution(fallbackResult.exitCode === 0, 'fallback', result.durationMs)
    return result
  }

  const result = { ...primaryResult, durationMs: Date.now() - startTime }
  recordAgentExecution(false, config.agent.primary, result.durationMs)
  return result
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms),
  )
  return Promise.race([promise, timeout])
}

async function runClaude(
  binaryPath: string,
  worktreePath: string,
  prompt: string,
  timeoutMs: number,
  logger: typeof console,
): Promise<Omit<AgentResult, 'durationMs'>> {
  // Check if binary exists
  const whichResult = await $`which ${binaryPath}`.quiet()
  if (whichResult.exitCode !== 0) {
    logger.error(`[agent] binary not found: ${binaryPath}`)
    return {
      success: false,
      exitCode: 2,
      error: `Agent binary not found: ${binaryPath}`,
    }
  }

  // Run with timeout — positional argument avoids stdin-pipe CWD scan hang
  let result: { exitCode: number; stdout: Buffer; stderr: Buffer }
  try {
    // Build clean env: remove VSCode plugin mode vars so claude runs in CLI mode
    const cleanEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) cleanEnv[k] = v
    }
    delete cleanEnv['CLAUDE_CODE_ENTRYPOINT']
    delete cleanEnv['VSCODE_INJECTION_ID']

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
      return { success: false, exitCode: 3, error: `Agent timed out after ${timeoutMs}ms` }
    }
    return { success: false, exitCode: 1, error: String(err) }
  }

  const stderr = await new Response(result.stderr).text()
  const exitCode = result.exitCode === 0 ? 0 : 1

  return {
    success: result.exitCode === 0,
    exitCode: exitCode as 0 | 1 | 2 | 3,
    error: result.exitCode !== 0 ? stderr : undefined,
  }
}

function buildPrompt(issueNumber: number, title: string, body: string): string {
  return `# Task: Fix Issue #${issueNumber}

## Issue Title
${title}

## Issue Description
${body || '(no description)'}

## Instructions
1. Understand the issue
2. Make necessary code changes
3. Write tests if applicable
4. Commit your changes with message: \`fix #${issueNumber}: <title>\`
5. Push the branch to origin

Branch name should follow: agent/${issueNumber}/<machine-id>
`
}
