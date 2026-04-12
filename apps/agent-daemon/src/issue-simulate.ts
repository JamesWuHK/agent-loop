import {
  buildPlanningPrompt,
  parseIssueContract,
  parsePlanningOutput,
  validateIssueContract,
  type AgentConfig,
  type ProjectProfileConfig,
} from '@agent/shared'
import { existsSync } from 'node:fs'
import { isAbsolute, posix, resolve } from 'node:path'
import { runConfiguredAgent } from './cli-agent'

export type IssueSimulationStage = 'contract' | 'planner' | 'reviewer'

export interface IssueSimulationFinding {
  code:
    | 'contract_invalid'
    | 'planning_not_commit_shaped'
    | 'allowed_files_too_broad'
    | 'validation_too_generic'
    | 'validation_targets_missing'
    | 'planner_failed'
  stage: IssueSimulationStage
  message: string
}

export interface IssueSimulationResult {
  valid: boolean
  summary: string
  failures: string[]
  findings: IssueSimulationFinding[]
  plannerPrompt: string
  plannerOutput: string
  plannedSubtasks: string[]
}

export interface IssueSimulateAgentRunInput {
  prompt: string
  repoRoot: string
  config?: AgentConfig
}

export interface IssueSimulateAgentRunResult {
  responseText: string
}

export interface SimulateIssueExecutabilityInput {
  issueTitle: string
  issueBody: string
  repoRoot: string
  config?: AgentConfig
  project?: ProjectProfileConfig
  runPlanner?: (
    input: IssueSimulateAgentRunInput,
  ) => Promise<IssueSimulateAgentRunResult>
}

const BROAD_SCOPE_PATTERNS = [
  /\bfiles?\b/i,
  /\bcode\b/i,
  /\bbackend\b/i,
  /\bfrontend\b/i,
  /\bclient\b/i,
  /\bserver\b/i,
  /\bui\b/i,
  /\ball\b/i,
  /\bany\b/i,
]

const COMMIT_ACTION_PATTERNS = [
  /\b(add|fix|update|implement|create|write|remove|refactor|rename|migrate|wire|integrate|support|tighten|split|rewrite|simulate|validate|expose)\b/i,
  /(增加|添加|修复|实现|更新|删除|重构|迁移|接入|收紧|支持|生成|改造|拆分|补充|补齐|校验|验证)/,
]

const ANALYSIS_ONLY_PATTERNS = [
  /\b(read|inspect|analyze|research|explore|understand|plan|review|think|study|audit)\b/i,
  /(研究|分析|调研|理解|思考|检查|阅读|审查|探索|方案)/,
]

export async function simulateIssueExecutability(
  input: SimulateIssueExecutabilityInput,
): Promise<IssueSimulationResult> {
  const runPlanner = input.runPlanner ?? defaultRunPlanner
  const plannerPrompt = buildPlanningPrompt(
    input.issueTitle,
    input.issueBody,
    input.project ?? input.config?.project,
  )
  const findings: IssueSimulationFinding[] = []
  const contract = parseIssueContract(input.issueBody)
  const validation = validateIssueContract(contract)

  for (const error of validation.errors) {
    findings.push({
      code: 'contract_invalid',
      stage: 'contract',
      message: error,
    })
  }

  for (const error of validateValidationTargets(input.issueBody, input.repoRoot)) {
    findings.push({
      code: 'validation_targets_missing',
      stage: 'reviewer',
      message: error,
    })
  }

  for (const entry of contract.allowedFiles) {
    if (!looksOverlyBroadAllowedFile(entry)) {
      continue
    }

    findings.push({
      code: 'allowed_files_too_broad',
      stage: 'reviewer',
      message: `allowed file scope is too broad for reliable review/auto-fix: ${entry}`,
    })
  }

  if (!hasIssueSpecificValidation(contract.validation)) {
    findings.push({
      code: 'validation_too_generic',
      stage: 'reviewer',
      message: 'validation commands are too generic to confirm issue-specific semantics',
    })
  }

  let plannerOutput = ''
  let plannedSubtasks: string[] = []

  try {
    const plannerResult = await runPlanner({
      prompt: plannerPrompt,
      repoRoot: input.repoRoot,
      config: input.config,
    })
    plannerOutput = plannerResult.responseText.trim()
    plannedSubtasks = plannerOutput
      ? parsePlanningOutput(plannerOutput).map((subtask) => subtask.title)
      : []

    if (plannedSubtasks.length === 0 || !plannedSubtasks.some(looksCommitShapedSubtask)) {
      findings.push({
        code: 'planning_not_commit_shaped',
        stage: 'planner',
        message: 'planning output does not contain commit-shaped subtasks',
      })
    }
  } catch (error) {
    findings.push({
      code: 'planner_failed',
      stage: 'planner',
      message: `planner simulation failed: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  const failures = uniqueStrings(findings.map((finding) => finding.message))

  return {
    valid: failures.length === 0,
    summary: failures.length === 0
      ? 'simulation passed: planning output is commit-shaped and reviewer checks found no blocking scope/validation risks'
      : `simulation failed with ${failures.length} blocking issue${failures.length === 1 ? '' : 's'}`,
    failures,
    findings,
    plannerPrompt,
    plannerOutput,
    plannedSubtasks,
  }
}

export function formatIssueSimulationOutput(
  result: IssueSimulationResult,
  asJson = false,
): string {
  if (asJson) {
    return `${JSON.stringify(result, null, 2)}\n`
  }

  const lines = [
    `simulate=${result.valid ? 'pass' : 'fail'}`,
    `summary: ${result.summary}`,
  ]

  if (result.failures.length > 0) {
    lines.push('failures:')
    lines.push(...result.failures.map((failure) => `- ${failure}`))
  }

  if (result.plannedSubtasks.length > 0) {
    lines.push('plannedSubtasks:')
    lines.push(...result.plannedSubtasks.map((task, index) => `${index + 1}. ${task}`))
  }

  return `${lines.join('\n')}\n`
}

function looksCommitShapedSubtask(title: string): boolean {
  const trimmed = title.trim()
  if (!trimmed) {
    return false
  }

  const hasCommitAction = COMMIT_ACTION_PATTERNS.some((pattern) => pattern.test(trimmed))
  if (!hasCommitAction) {
    return false
  }

  const analysisOnly = ANALYSIS_ONLY_PATTERNS.some((pattern) => pattern.test(trimmed))
  return !analysisOnly || /\bfix\b/i.test(trimmed) || /修复/.test(trimmed)
}

function looksOverlyBroadAllowedFile(entry: string): boolean {
  const trimmed = entry.trim()
  if (!trimmed) {
    return false
  }

  if (BROAD_SCOPE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return true
  }

  const normalized = trimmed.replace(/\\/g, '/').replace(/\/$/, '')
  const segments = normalized.split('/').filter(Boolean)
  const hasWildcard = normalized.includes('*')
  const looksLikeExplicitFile = /\.[A-Za-z0-9]+$/.test(normalized)

  if (hasWildcard) {
    return !normalized.includes('/')
  }

  if (looksLikeExplicitFile) {
    return false
  }

  return segments.length <= 3
}

function hasIssueSpecificValidation(entries: string[]): boolean {
  const normalized = entries
    .map(stripWrappingBackticks)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => entry !== 'git diff --stat origin/main...HEAD')

  if (normalized.length === 0) {
    return false
  }

  return normalized.some((entry) => {
    if (entry.includes('/')) {
      return true
    }

    return extractValidationFileCandidates(entry).length > 0
  })
}

function normalizeValidationEntry(entry: string): string {
  return stripWrappingBackticks(entry)
}

function tokenizeCommand(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^['"]|['"]$/g, '')) ?? []
}

function looksLikeFilePathToken(token: string): boolean {
  if (!token || token.startsWith('-')) return false
  if (token.includes('...')) return false
  if (/^[A-Za-z0-9_.-]+$/.test(token) && !token.includes('.')) return false
  return /[\\/]/.test(token) || /\.[A-Za-z0-9]+$/.test(token)
}

function extractValidationFileCandidates(entry: string): string[] {
  const tokens = tokenizeCommand(normalizeValidationEntry(entry))
  const candidates = new Set<string>()
  let commandCwd = '.'

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ''
    if ((token === '--cwd' || token === '-C') && tokens[index + 1]) {
      commandCwd = tokens[index + 1]!
      index += 1
      continue
    }

    if (token === 'cd' && tokens[index + 1]) {
      commandCwd = tokens[index + 1]!
      index += 1
      continue
    }

    if (!looksLikeFilePathToken(token)) {
      continue
    }

    if (token === '.' || token === '..') {
      continue
    }

    const resolved = token.startsWith('/')
      ? token
      : posix.normalize(commandCwd === '.' ? token : posix.join(commandCwd, token))
    candidates.add(resolved.replace(/\\/g, '/'))
  }

  return [...candidates]
}

function matchesContractFilePattern(path: string, pattern: string): boolean {
  const normalizedPath = normalizeContractPath(path)
  const normalizedPattern = normalizeContractPath(pattern)
  if (!normalizedPattern) return false

  const escaped = normalizedPattern
    .replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*')

  return new RegExp(`^${escaped}$`).test(normalizedPath)
}

function isAllowedFutureValidationTarget(candidate: string, allowedFiles: string[]): boolean {
  const normalizedCandidate = normalizeContractPath(candidate)
  return allowedFiles.some((pattern) => {
    const normalizedPattern = normalizeContractPath(pattern)
    if (!normalizedPattern) return false
    if (matchesContractFilePattern(normalizedCandidate, normalizedPattern)) return true
    return normalizedCandidate.startsWith(`${normalizedPattern.replace(/\/$/, '')}/`)
  })
}

function validateValidationTargets(contractBody: string, repoRoot?: string): string[] {
  const contract = parseIssueContract(contractBody)
  if (!repoRoot) {
    return []
  }

  const missingTargets = new Set<string>()

  for (const entry of contract.validation) {
    for (const candidate of extractValidationFileCandidates(entry)) {
      const absolutePath = isAbsolute(candidate) ? candidate : resolve(repoRoot, candidate)
      if (!existsSync(absolutePath)) {
        if (isAllowedFutureValidationTarget(candidate, contract.allowedFiles)) {
          continue
        }
        missingTargets.add(candidate)
      }
    }
  }

  return [...missingTargets].map((target) => `validation references missing repo path: ${target}`)
}

function normalizeContractPath(value: string): string {
  return value.trim().replace(/^\.\//, '').replace(/\\/g, '/')
}

function stripWrappingBackticks(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('`') && trimmed.endsWith('`')) {
    return trimmed.slice(1, -1).trim()
  }

  return trimmed
}

function uniqueStrings(values: string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()

  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed) {
      continue
    }

    if (seen.has(trimmed)) {
      continue
    }

    seen.add(trimmed)
    result.push(trimmed)
  }

  return result
}

async function defaultRunPlanner(
  input: IssueSimulateAgentRunInput,
): Promise<IssueSimulateAgentRunResult> {
  if (!input.config) {
    throw new Error('simulateIssueExecutability requires config when no custom runPlanner is provided')
  }

  const result = await runConfiguredAgent({
    prompt: input.prompt,
    worktreePath: input.repoRoot,
    timeoutMs: input.config.agent.timeoutMs,
    config: input.config,
    allowWrites: false,
  })

  if (!result.ok) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`
    throw new Error(`issue simulation planner failed: ${detail}`)
  }

  return {
    responseText: result.responseText,
  }
}
