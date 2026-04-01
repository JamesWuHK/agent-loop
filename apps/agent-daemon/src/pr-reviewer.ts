import type { AgentConfig } from '@agent/shared'

export interface PrReviewResult {
  approved: boolean
  reason: string
  canMerge: boolean
  reviewFailed?: boolean
}

interface PrReviewContext {
  title: string
  body: string
  files: Array<{ path: string; additions?: number; deletions?: number }>
  diff: string
}

/**
 * Review a PR using a Claude subagent to determine if it can be merged.
 */
export async function reviewPr(
  prNumber: number,
  prUrl: string,
  config: AgentConfig,
  logger = console,
): Promise<PrReviewResult> {
  logger.log(`[pr-review] starting review for PR #${prNumber}`)

  try {
    const context = await fetchPrReviewContext(prNumber, config)
    const prompt = buildReviewPrompt(prNumber, prUrl, config.repo, context)
    const result = await runReviewAgent(prompt)
    logger.log(`[pr-review] PR #${prNumber} review complete: ${result.approved ? 'APPROVED' : 'REJECTED'}`)
    return result
  } catch (err) {
    logger.error(`[pr-review] review failed:`, err)
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
    env: { ...process.env, GH_TOKEN: config.pat },
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
    env: { ...process.env, GH_TOKEN: config.pat },
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
  return {
    title: pr.title ?? '',
    body: pr.body ?? '',
    files: (pr.files ?? []).map((file: any) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
    })),
    diff: diffStdout.slice(0, 40000),
  }
}

function buildReviewPrompt(
  prNumber: number,
  prUrl: string,
  repo: string,
  context: PrReviewContext,
): string {
  return `You are reviewing a GitHub pull request for merge readiness.

PR #${prNumber}
URL: ${prUrl}
Repo: ${repo}
Title: ${context.title}

PR Body:
${context.body || '(empty)'}

Files changed:
${context.files.map(file => `- ${file.path} (+${file.additions ?? 0}/-${file.deletions ?? 0})`).join('\n')}

Diff:
${context.diff}

Check:
1. Does the code follow the project conventions?
2. Is the implementation complete for the issue?
3. Are there obvious bugs, missing integration, or risky changes?
4. Is this ready to merge as-is?

Respond with JSON only:
{
  "approved": true,
  "reason": "brief explanation",
  "canMerge": true
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

  return `<!-- agent-loop:pr-review {"pr":${prNumber},"attempt":${attempt},"approved":${review.approved},"canMerge":${review.canMerge}} -->
## ${title}

- Attempt: ${attempt}
- Merge ready: ${review.canMerge ? 'yes' : 'no'}
- Reason: ${review.reason}

${nextStep}`
}

async function runReviewAgent(prompt: string): Promise<PrReviewResult> {
  const cleanEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) cleanEnv[k] = v
  }
  delete cleanEnv['CLAUDE_CODE_ENTRYPOINT']
  delete cleanEnv['VSCODE_INJECTION_ID']

  const proc = Bun.spawn(['claude', '--print', '--permission-mode', 'bypassPermissions'], {
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

  const normalized = stdout.trim().replace(/^```json\s*/, '').replace(/```$/, '').trim()
  try {
    const json = JSON.parse(normalized)
    return {
      approved: json.approved ?? false,
      reason: json.reason ?? 'No reason provided',
      canMerge: json.canMerge ?? false,
    }
  } catch {
    throw new Error(`Failed to parse review response: ${stdout}`)
  }
}
