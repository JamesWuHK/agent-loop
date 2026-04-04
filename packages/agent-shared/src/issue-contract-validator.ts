import type { IssueContract } from './issue-contract'

export interface IssueContractValidationResult {
  valid: boolean
  errors: string[]
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
