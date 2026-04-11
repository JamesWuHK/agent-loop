interface GitCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface PrLineagePreflightExpected {
  issueNumber: number
  headBranch: string
  baseBranch: string
  baseSha: string
  allowedChangedFiles?: string[]
}

export interface PrLineagePreflightActual {
  headBranch: string
  baseBranch: string | null
  baseSha: string
  changedFiles: string[]
}

export type PrLineagePreflightFailureCode =
  | 'head_branch_mismatch'
  | 'base_branch_mismatch'
  | 'base_sha_mismatch'
  | 'unexpected_changed_files'

export interface PrLineagePreflightFailure {
  code: PrLineagePreflightFailureCode
  message: string
  expected: string | string[] | null
  actual: string | string[] | null
}

export interface PrLineagePreflightResult {
  ok: boolean
  failures: string[]
  details: PrLineagePreflightFailure[]
  expected: PrLineagePreflightExpected
  actual: PrLineagePreflightActual
}

export interface CollectPrLineagePreflightActualStateInput {
  worktreePath: string
  expectedBaseBranch: string
  actualHeadBranch?: string | null
  actualBaseBranch?: string | null
  runGit?: (
    worktreePath: string,
    args: string[],
  ) => Promise<GitCommandResult>
}

export class PrLineagePreflightError extends Error {
  readonly stage: string
  readonly result: PrLineagePreflightResult

  constructor(stage: string, result: PrLineagePreflightResult) {
    super(`PR lineage preflight failed before ${stage}: ${result.failures.join('; ')}`)
    this.name = 'PrLineagePreflightError'
    this.stage = stage
    this.result = result
  }
}

export function evaluatePrLineagePreflight(input: {
  expected: PrLineagePreflightExpected
  actual: PrLineagePreflightActual
}): PrLineagePreflightResult {
  const details: PrLineagePreflightFailure[] = []

  const addFailure = (
    code: PrLineagePreflightFailureCode,
    message: string,
    expected: string | string[] | null,
    actual: string | string[] | null,
  ): void => {
    details.push({
      code,
      message,
      expected,
      actual,
    })
  }

  if (input.actual.headBranch !== input.expected.headBranch) {
    addFailure(
      'head_branch_mismatch',
      `head branch mismatch: expected ${input.expected.headBranch} but found ${input.actual.headBranch}`,
      input.expected.headBranch,
      input.actual.headBranch,
    )
  }

  if (
    input.actual.baseBranch !== null
    && input.actual.baseBranch !== input.expected.baseBranch
  ) {
    addFailure(
      'base_branch_mismatch',
      `base branch mismatch: expected ${input.expected.baseBranch} but found ${input.actual.baseBranch}`,
      input.expected.baseBranch,
      input.actual.baseBranch,
    )
  }

  if (input.actual.baseSha !== input.expected.baseSha) {
    addFailure(
      'base_sha_mismatch',
      `base sha mismatch: expected ${input.expected.baseSha} but found ${input.actual.baseSha}`,
      input.expected.baseSha,
      input.actual.baseSha,
    )
  }

  const allowedChangedFiles = new Set(input.expected.allowedChangedFiles ?? [])
  if (allowedChangedFiles.size > 0) {
    const unexpectedChangedFiles = input.actual.changedFiles
      .filter(file => !allowedChangedFiles.has(file))
      .sort((left, right) => left.localeCompare(right))

    if (unexpectedChangedFiles.length > 0) {
      addFailure(
        'unexpected_changed_files',
        `unexpected changed files outside lineage scope: ${unexpectedChangedFiles.join(', ')}`,
        [...allowedChangedFiles].sort((left, right) => left.localeCompare(right)),
        unexpectedChangedFiles,
      )
    }
  }

  return {
    ok: details.length === 0,
    failures: details.map(detail => detail.message),
    details,
    expected: input.expected,
    actual: input.actual,
  }
}

export async function collectPrLineagePreflightActualState(
  input: CollectPrLineagePreflightActualStateInput,
): Promise<PrLineagePreflightActual> {
  const gitRunner = input.runGit ?? runGit
  const fetchBase = await gitRunner(input.worktreePath, ['fetch', 'origin', input.expectedBaseBranch])
  if (fetchBase.exitCode !== 0) {
    throw new Error(
      fetchBase.stderr
        || fetchBase.stdout
        || `Failed to fetch origin/${input.expectedBaseBranch} for PR lineage preflight`,
    )
  }

  const headBranch = input.actualHeadBranch ?? await resolveCurrentHeadBranch(input.worktreePath, gitRunner)
  const mergeBase = await gitRunner(input.worktreePath, ['merge-base', 'HEAD', `origin/${input.expectedBaseBranch}`])
  if (mergeBase.exitCode !== 0) {
    throw new Error(
      mergeBase.stderr
        || mergeBase.stdout
        || `Failed to resolve merge-base against origin/${input.expectedBaseBranch} for PR lineage preflight`,
    )
  }

  const changedFilesResult = await gitRunner(
    input.worktreePath,
    ['diff', '--name-only', `origin/${input.expectedBaseBranch}...HEAD`],
  )
  if (changedFilesResult.exitCode !== 0) {
    throw new Error(
      changedFilesResult.stderr
        || changedFilesResult.stdout
        || `Failed to list changed files against origin/${input.expectedBaseBranch} for PR lineage preflight`,
    )
  }

  return {
    headBranch,
    baseBranch: input.actualBaseBranch ?? null,
    baseSha: mergeBase.stdout.trim(),
    changedFiles: changedFilesResult.stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right)),
  }
}

export async function isCommitAncestorInWorktree(
  worktreePath: string,
  ancestorSha: string,
  descendantSha: string,
  gitRunner: CollectPrLineagePreflightActualStateInput['runGit'] = runGit,
): Promise<boolean> {
  const result = await gitRunner(worktreePath, ['merge-base', '--is-ancestor', ancestorSha, descendantSha])
  if (result.exitCode === 0) return true
  if (result.exitCode === 1) return false
  throw new Error(
    result.stderr
      || result.stdout
      || `Failed to compare commit ancestry for ${ancestorSha} -> ${descendantSha}`,
  )
}

async function resolveCurrentHeadBranch(
  worktreePath: string,
  gitRunner: NonNullable<CollectPrLineagePreflightActualStateInput['runGit']>,
): Promise<string> {
  const branchResult = await gitRunner(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (branchResult.exitCode !== 0) {
    return 'HEAD'
  }

  return branchResult.stdout.trim() || 'HEAD'
}

async function runGit(
  worktreePath: string,
  args: string[],
): Promise<GitCommandResult> {
  const proc = Bun.spawn(['git', '-C', worktreePath, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited

  return {
    exitCode,
    stdout,
    stderr,
  }
}
