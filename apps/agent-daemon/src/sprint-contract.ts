import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  SPRINT_ATTEMPT_KINDS,
  SPRINT_CONTRACT_ARTIFACT_VERSION,
  type SprintAttemptKind,
  type SprintContract,
} from '../../../packages/agent-shared/src/types'

const SPRINT_CONTRACT_DIRECTORY = '.agent-loop'
const SPRINT_CONTRACT_FILENAME = 'sprint-contract.json'
const SPRINT_ATTEMPT_KIND_SET = new Set<SprintAttemptKind>(SPRINT_ATTEMPT_KINDS)

export interface BuildSprintContractInput {
  issueNumber: number
  issueTitle: string
  attemptKind: SprintAttemptKind
  objective: string
  allowedFiles: string[]
  requiredSemantics: string[]
  validationCommands: string[]
  plannedSteps: string[]
  createdAt?: string
}

export function resolveSprintContractPath(worktreePath: string): string {
  return join(worktreePath, SPRINT_CONTRACT_DIRECTORY, SPRINT_CONTRACT_FILENAME)
}

export function buildSprintContract(input: BuildSprintContractInput): SprintContract {
  return normalizeSprintContractRecord({
    artifactVersion: SPRINT_CONTRACT_ARTIFACT_VERSION,
    issueNumber: input.issueNumber,
    issueTitle: input.issueTitle,
    attemptKind: input.attemptKind,
    objective: input.objective,
    allowedFiles: input.allowedFiles,
    requiredSemantics: input.requiredSemantics,
    validationCommands: input.validationCommands,
    plannedSteps: input.plannedSteps,
    createdAt: input.createdAt ?? new Date().toISOString(),
  })
}

export function serializeSprintContract(contract: SprintContract): string {
  return `${JSON.stringify(normalizeSprintContractRecord(contract), null, 2)}\n`
}

export async function writeSprintContract(
  worktreePath: string,
  contract: SprintContract,
): Promise<SprintContract> {
  const normalized = normalizeSprintContractRecord(contract)
  const artifactPath = resolveSprintContractPath(worktreePath)

  await mkdir(join(worktreePath, SPRINT_CONTRACT_DIRECTORY), { recursive: true })
  await writeFile(artifactPath, serializeSprintContract(normalized), 'utf-8')

  return normalized
}

export async function readSprintContract(worktreePath: string): Promise<SprintContract | null> {
  try {
    const artifact = await readFile(resolveSprintContractPath(worktreePath), 'utf-8')
    return parseSprintContract(artifact)
  } catch (error) {
    if (isMissingFileError(error)) {
      return null
    }

    throw error
  }
}

function parseSprintContract(content: string): SprintContract | null {
  try {
    return normalizeSprintContractRecord(JSON.parse(content))
  } catch {
    return null
  }
}

function normalizeSprintContractRecord(value: unknown): SprintContract {
  const record = value as Partial<Record<keyof SprintContract, unknown>>
  const attemptKind = normalizeAttemptKind(record.attemptKind)

  if (!attemptKind) {
    throw new Error('Invalid sprint contract attempt kind')
  }

  const createdAt = normalizeTimestamp(record.createdAt)
  if (!createdAt) {
    throw new Error('Invalid sprint contract createdAt timestamp')
  }

  return {
    artifactVersion: normalizeArtifactVersion(record.artifactVersion),
    issueNumber: normalizeIssueNumber(record.issueNumber),
    issueTitle: normalizeRequiredString(record.issueTitle, 'issueTitle'),
    attemptKind,
    objective: normalizeRequiredString(record.objective, 'objective'),
    allowedFiles: normalizeStringList(record.allowedFiles, 'allowedFiles'),
    requiredSemantics: normalizeStringList(record.requiredSemantics, 'requiredSemantics'),
    validationCommands: normalizeStringList(record.validationCommands, 'validationCommands'),
    plannedSteps: normalizeStringList(record.plannedSteps, 'plannedSteps'),
    createdAt,
  }
}

function normalizeArtifactVersion(value: unknown): typeof SPRINT_CONTRACT_ARTIFACT_VERSION {
  if (value !== SPRINT_CONTRACT_ARTIFACT_VERSION) {
    throw new Error('Unsupported sprint contract artifactVersion')
  }

  return SPRINT_CONTRACT_ARTIFACT_VERSION
}

function normalizeIssueNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error('Invalid sprint contract issueNumber')
  }

  return value
}

function normalizeAttemptKind(value: unknown): SprintAttemptKind | null {
  return typeof value === 'string' && SPRINT_ATTEMPT_KIND_SET.has(value as SprintAttemptKind)
    ? value as SprintAttemptKind
    : null
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid sprint contract ${field}`)
  }

  return value.trim()
}

function normalizeStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid sprint contract ${field}`)
  }

  return value.map((entry) => {
    if (typeof entry !== 'string') {
      throw new Error(`Invalid sprint contract ${field}`)
    }

    const normalized = entry.trim()
    if (normalized.length === 0) {
      throw new Error(`Invalid sprint contract ${field}`)
    }

    return normalized
  })
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null
  }

  const timestamp = value.trim()
  return Number.isFinite(Date.parse(timestamp)) ? timestamp : null
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT'
}
