import type { Subtask } from './types'

/**
 * Build the planning prompt that asks the agent to break down an issue into
 * a numbered list of concrete subtasks.
 */
export function buildPlanningPrompt(issueTitle: string, issueBody: string): string {
  // Strip HTML comments (e.g. stale bot markers) from body before planning
  const stripped = issueBody
    ? issueBody.replace(/<!--[\s\S]*?-->/g, '').trim()
    : ''
  const body = stripped.length > 20
    ? stripped
    : '(no description — use issue title and your judgment)'

  return `# Task Planning

## Issue
**Title:** ${issueTitle}
**Description:**
${body}

## Your Job
Analyze the issue and break it down into a small number (1–5) of concrete, actionable subtasks. Each subtask should be a single logical unit of work that produces a verifiable code change.

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

    // Strip common prefixes: "1.", "1)", "- ", "* ", "• ", "1. ", etc.
    const stripped = line.replace(/^[\d]+\)\s*/, '').replace(/^[-*•]\s*/, '').trim()

    // Skip lines that don't look like task descriptions
    if (stripped.length < 3) continue
    // Skip lines that look like headers or empty-ish content
    if (!/[a-zA-Z]{3,}/.test(stripped)) continue

    subtasks.push({
      id: `subtask-${order}`,
      title: stripped,
      status: 'pending',
      order: order++,
      attempts: 0,
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
      attempts: 0,
    }]
  }

  return subtasks
}

/**
 * Find the next subtask to execute.
 * Prefers pending tasks, but will retry the last failed one before giving up.
 * @param skipId  Subtask ID to skip (used to avoid re-running the same failed subtask repeatedly)
 */
export function findNextSubtask(
  subtasks: Subtask[],
  skipId?: string | null,
): Subtask | null {
  if (skipId) {
    // Skip the explicitly skipped ID; find another pending or the LAST failed (not skipId)
    const pending = subtasks.find(s => s.status === 'pending' && s.id !== skipId)
    if (pending) return pending
    const failed = subtasks.filter(s => s.status === 'failed' && s.id !== skipId)
    return failed[failed.length - 1] ?? null
  }
  return subtasks.find(s => s.status === 'pending')
    ?? subtasks.find(s => s.status === 'failed')
    ?? null
}

/**
 * Build the prompt for executing a single subtask.
 * Includes git verification steps to detect empty commits.
 */
export function buildSubtaskPrompt(subtask: Subtask, issueNumber: number): string {
  return `# Subtask: ${subtask.title}

## Context
You are working on issue #${issueNumber}.
Your specific task is: **${subtask.title}**

## Instructions
1. Read the codebase to understand the current state.
2. Make the necessary code changes to complete this subtask.
3. If this subtask involves React/UI tests in apps/desktop, use the Vitest runner configured by the app (for example: \`bun run --cwd apps/desktop test -- src/pages/LoginPage.test.tsx\`). Do NOT use plain \`bun test\` for jsdom/Vitest tests.
4. Run: \`git status --short\` — if empty, first verify whether the requested behavior is already implemented and covered by the current HEAD. If it is already satisfied, exit 0 without making changes.
5. If code changes were required, commit with message: \`fix #${subtask.id}: ${subtask.title}\`
6. Push to origin only if a new commit was created.
7. If a new commit was created, run: \`git log main..HEAD --oneline\` — verify at least one commit appears. If empty, run: \`echo "COMMIT_FAILED" && exit 1\`
`
}
