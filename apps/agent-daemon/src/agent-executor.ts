import { resolve } from 'node:path'
import { writeFileSync } from 'node:fs'
import {
  getProjectPromptGuidance,
  renderIssueContractForPrompt,
  type AgentConfig,
  type AgentResult,
} from '@agent/shared'
import { recordAgentExecution } from './metrics'
import { runConfiguredAgent } from './cli-agent'

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

  // Write prompt file for the agent
  const promptPath = resolve(worktreePath, 'prompt.md')
  const prompt = buildPrompt(issueNumber, issueTitle, issueBody, config.project)
  writeFileSync(promptPath, prompt, 'utf-8')

  const runResult = await runConfiguredAgent({
    prompt,
    worktreePath,
    timeoutMs,
    config,
    logger,
    allowWrites: true,
  })

  const result: AgentResult = {
    success: runResult.ok,
    exitCode: runResult.exitCode,
    error: runResult.ok ? undefined : (runResult.stderr || runResult.stdout || 'Agent execution failed'),
    durationMs: Date.now() - startTime,
  }

  recordAgentExecution(
    runResult.ok,
    runResult.usedFallback ? 'fallback' : runResult.usedAgent,
    result.durationMs,
  )

  return result
}

function buildPrompt(
  issueNumber: number,
  title: string,
  body: string,
  project: AgentConfig['project'],
): string {
  const projectGuidance = getProjectPromptGuidance(project, 'implementation')
  return `# Task: Fix Issue #${issueNumber}

## Issue Title
${title}

## Issue Description
${body || '(no description)'}

## Parsed Contract
${renderIssueContractForPrompt(body)}

## Instructions
1. Understand the issue
2. Treat the parsed contract as authoritative whenever it gives explicit scope or semantics.
3. Make only the necessary code changes for this issue.
4. Do not edit forbidden files or expand into out-of-scope follow-up work.
5. Preserve required semantics and must-preserve behaviors from the issue, even if a shortcut would make review easier.
6. Run the relevant tests from the issue contract if present.
7. Run \`git diff --stat origin/main...HEAD\` and verify the changed file set still matches the issue contract before committing.
8. Commit your changes with message: \`fix #${issueNumber}: <title>\`
9. Push the branch to origin

${projectGuidance.length > 0 ? `## Project Profile Guidance
${projectGuidance.map((line) => `- ${line}`).join('\n')}

` : ''}Branch name should follow: agent/${issueNumber}/<machine-id>
`
}
