import type { ProjectProfileConfig, Subtask } from './types'
import { renderIssueContractForPrompt } from './issue-contract'
import { getProjectPromptGuidance } from './project-profile'

/**
 * Build the planning prompt that asks the agent to break down an issue into
 * a numbered list of concrete subtasks.
 */
export function buildPlanningPrompt(
  issueTitle: string,
  issueBody: string,
  project?: ProjectProfileConfig,
): string {
  // Strip HTML comments (e.g. stale bot markers) from body before planning
  const stripped = issueBody
    ? issueBody.replace(/<!--[\s\S]*?-->/g, '').trim()
    : ''
  const body = stripped.length > 20
    ? stripped
    : '(no description — use issue title and your judgment)'

  const profileGuidance = getProjectPromptGuidance(project, 'planning')

  return `# Task Planning

## Issue
**Title:** ${issueTitle}
**Description:**
${body}

## Parsed Contract
${renderIssueContractForPrompt(body)}

## Your Job
Analyze the issue and break it down into a small number (1–5) of concrete, actionable subtasks. Each subtask must be a single logical unit of work that produces a verifiable code change and can be committed independently.

Do NOT include pure reading, inspection, investigation, or analysis-only subtasks.
Do NOT include subtasks that only say to read docs or inspect files.
If documentation or code reading is necessary, fold it into a code-producing subtask instead.
Every subtask must be capable of producing a non-empty git commit.
Respect explicit file scope, out-of-scope clauses, and must-preserve semantics from the parsed contract.
${profileGuidance.length > 0 ? `

## Project Profile Guidance
${profileGuidance.map((line) => `- ${line}`).join('\n')}` : ''}

## Output Format (STRICT — no exceptions)
Return ONLY a plain numbered list. No headers. No explanations. No markdown.
Exactly like this:
1. Add a build status badge to README.md
2. Update the CI pipeline to run tests on PRs

Start your response with "1. " on the very first line.
If the issue is too vague to plan, output exactly:
1. Investigate and fix: ${issueTitle.slice(0, 60)}
`
}

/**
 * Parse the planning agent's plain-text output into an array of Subtask objects.
 * Handles flexible parsing: strips bullet points, markdown numbers, etc.
 */
export function parsePlanningOutput(output: string, startOrder = 1): Subtask[] {
  const lines = output.split('\n')
  const subtasks: Subtask[] = []
  let order = startOrder

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    // Strip common prefixes: "1.", "1)", "- ", "* ", "• ", etc.
    const stripped = line
      .replace(/^[\d]+[.)]\s*/, '')
      .replace(/^[-*•]\s*/, '')
      .trim()

    // Skip lines that don't look like task descriptions
    if (stripped.length < 3) continue
    // Skip lines that look like headers or empty-ish content
    if (!/[a-zA-Z]{3,}/.test(stripped)) continue

    subtasks.push({
      id: `subtask-${order}`,
      title: stripped,
      status: 'pending',
      order: order++,
    })

    if (order > startOrder + 9) break // safety: max 10 subtasks
  }

  // If parsing failed (no subtasks extracted), create a single fallback
  if (subtasks.length === 0) {
    return [{
      id: 'subtask-1',
      title: `Investigate and fix: ${output.slice(0, 100).trim() || 'unknown task'}`,
      status: 'pending',
      order: startOrder,
    }]
  }

  return subtasks
}

/**
 * Find the next subtask to execute.
 * Only pending subtasks are eligible for execution.
 */
export function findNextSubtask(subtasks: Subtask[]): Subtask | null {
  return subtasks.find(s => s.status === 'pending') ?? null
}

/**
 * Build the prompt for executing a single subtask.
 * Includes git verification steps to detect empty commits.
 */
export function buildSubtaskPrompt(
  subtask: Subtask,
  issueNumber: number,
  issueTitle: string,
  issueBody: string,
  project?: ProjectProfileConfig,
): string {
  const profileGuidance = getProjectPromptGuidance(project, 'implementation')

  return `# Subtask: ${subtask.title}

## Context
You are working on issue #${issueNumber}.
Issue title: ${issueTitle}
Your specific task is: **${subtask.title}**

## Parsed Contract
${renderIssueContractForPrompt(issueBody)}

## Instructions
1. Read the codebase to understand the current state.
2. Make the necessary code changes to complete this subtask.
3. Treat explicit AllowedFiles, ForbiddenFiles, MustPreserve, OutOfScope, and RequiredSemantics as a hard contract.
4. Do not expand scope to satisfy speculative improvements or unrelated follow-up work.
5. Before committing, run \`git diff --stat origin/main...HEAD\` and verify the touched files still match the issue scope.
6. Run: \`git status --short\` — if empty, the file is already correct. In that case, run: \`echo "NO_CHANGES" && exit 1\`
7. Commit with message: \`fix #${subtask.id}: ${subtask.title}\`
8. Push to origin
9. Run: \`git log origin/main..HEAD --oneline\` — verify at least one commit appears. If empty, the commit failed. Run: \`echo "COMMIT_FAILED" && exit 1\`
${profileGuidance.length > 0 ? `

## Project Profile Guidance
${profileGuidance.map((line) => `- ${line}`).join('\n')}` : ''}
`
}
