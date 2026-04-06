import type { IssueContract } from './issue-contract'

export interface IssueContractValidationResult {
  valid: boolean
  errors: string[]
}

const EXECUTABLE_COMMAND_PREFIXES = [
  'bun',
  'npm',
  'pnpm',
  'yarn',
  'npx',
  'node',
  'python',
  'python3',
  'pytest',
  'cargo',
  'go',
  'make',
  'just',
  'uv',
  'deno',
  'vitest',
  'jest',
  'playwright',
  'cypress',
  'rspec',
  'bundle',
  'phpunit',
  'mix',
  'gradle',
  'mvn',
  'dotnet',
  'swift',
  'bash',
  'sh',
  'git',
  'cd',
  './',
  '../',
] as const

export function normalizeValidationEntry(entry: string): string {
  const trimmed = entry.trim()
  if (trimmed.startsWith('`') && trimmed.endsWith('`')) {
    return trimmed.slice(1, -1).trim()
  }

  return trimmed
}

export function looksLikeExecutableCommand(entry: string): boolean {
  const normalized = normalizeValidationEntry(entry)
  return EXECUTABLE_COMMAND_PREFIXES.some((prefix) =>
    normalized === prefix || normalized.startsWith(`${prefix} `),
  )
}

export function looksLikeExecutableTestCommand(entry: string): boolean {
  if (!looksLikeExecutableCommand(entry)) {
    return false
  }

  const normalized = normalizeValidationEntry(entry)
  return /\b(test|tests|check|build|lint|verify|typecheck|coverage)\b/i.test(normalized)
}

export function getExecutableValidationCommands(
  contract: Pick<IssueContract, 'validation'>,
): string[] {
  return contract.validation
    .map(normalizeValidationEntry)
    .filter((entry) => looksLikeExecutableCommand(entry))
}

export function validateIssueContract(contract: IssueContract): IssueContractValidationResult {
  const errors: string[] = []

  if (!contract.userStory.trim()) {
    errors.push('missing ## 用户故事 / User Story')
  }

  if (!contract.hasDependencyMetadata) {
    errors.push('missing ### Dependencies JSON block')
  } else if (contract.dependencyParseError) {
    errors.push('malformed ### Dependencies JSON block')
  }

  if (contract.implementationSteps.length === 0) {
    errors.push('missing ## 实现步骤 / Implementation Steps')
  }

  if (contract.acceptance.length === 0) {
    errors.push('missing ## 验收 / Acceptance')
  }

  if (!contract.redTest.trim()) {
    errors.push('missing ## RED 测试 / RED Tests')
  }

  if (contract.validation.length === 0) {
    errors.push('missing ### Validation / Validation Commands')
  } else {
    if (!contract.validation.some(looksLikeExecutableCommand)) {
      errors.push('missing executable validation command in ### Validation')
    }

    if (!contract.validation.some(looksLikeExecutableTestCommand)) {
      errors.push('missing executable test/build/check command in ### Validation')
    }
  }

  const hasScopeContract = [
    contract.allowedFiles.length > 0,
    contract.forbiddenFiles.length > 0,
    contract.mustPreserve.length > 0,
    contract.outOfScope.length > 0,
    contract.requiredSemantics.length > 0,
  ].some(Boolean)

  if (!hasScopeContract) {
    errors.push('missing executable scope contract (AllowedFiles/ForbiddenFiles/MustPreserve/OutOfScope/RequiredSemantics)')
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}
