import type { IssueContract } from './issue-contract'
import {
  looksLikeExecutableCommand,
  validateIssueContract,
  type IssueContractValidationResult,
} from './issue-contract-validator'

export interface IssueQualityReport {
  valid: boolean
  score: number
  errors: string[]
  warnings: string[]
}

const ALLOWED_FILE_BROAD_PATTERNS = [
  /\bfiles?\b/i,
  /\bcode\b/i,
  /\bbackend\b/i,
  /\bfrontend\b/i,
  /\bclient\b/i,
  /\bserver\b/i,
  /\bui\b/i,
  /\bany\b/i,
  /\ball\b/i,
] as const

const GENERIC_VALIDATION_PATTERNS = [
  /\b(run|rerun)\b.*\btests?\b/i,
  /\b(check|verify|validate|confirm)\b/i,
  /\bmanual\b/i,
  /\bqa\b/i,
  /\bsmoke\b/i,
  /\bregression\b/i,
  /\bworks?\b/i,
] as const

function isTightlyScopedAllowedFileEntry(entry: string): boolean {
  const trimmed = entry.trim()
  if (!trimmed) {
    return false
  }

  if (trimmed.includes('*')) {
    return trimmed.includes('/')
  }

  if (trimmed.endsWith('/')) {
    return trimmed.includes('/')
  }

  const segments = trimmed.split('/').filter(Boolean)
  return segments.length >= 2
}

function isBroadAllowedFileEntry(entry: string): boolean {
  const trimmed = entry.trim()
  if (!trimmed) {
    return false
  }

  return ALLOWED_FILE_BROAD_PATTERNS.some((pattern) => pattern.test(trimmed))
}

function isGenericValidationEntry(entry: string): boolean {
  const trimmed = entry.trim()
  if (!trimmed || looksLikeExecutableCommand(trimmed)) {
    return false
  }

  return GENERIC_VALIDATION_PATTERNS.some((pattern) => pattern.test(trimmed))
}

function collectIssueQualityWarnings(contract: IssueContract): string[] {
  const warnings: string[] = []

  for (const entry of contract.allowedFiles) {
    if (!isTightlyScopedAllowedFileEntry(entry) || isBroadAllowedFileEntry(entry)) {
      warnings.push(`AllowedFiles should use exact paths or tightly scoped directories: ${entry}`)
    }
  }

  for (const entry of contract.validation) {
    if (isGenericValidationEntry(entry)) {
      warnings.push(`Validation should use concrete executable commands instead of generic guidance: ${entry}`)
    }
  }

  return warnings
}

function calculateIssueQualityScore(
  validation: IssueContractValidationResult,
  warnings: string[],
): number {
  const rawScore = 100 - (validation.errors.length * 25) - (warnings.length * 10)
  return Math.max(0, Math.min(100, rawScore))
}

export function buildIssueQualityReport(
  contract: IssueContract,
  validation: IssueContractValidationResult = validateIssueContract(contract),
): IssueQualityReport {
  const warnings = collectIssueQualityWarnings(contract)

  return {
    valid: validation.valid,
    score: calculateIssueQualityScore(validation, warnings),
    errors: [...validation.errors],
    warnings,
  }
}
