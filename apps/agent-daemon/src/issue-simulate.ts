import { basename } from 'node:path'
import {
  buildIssueQualityReport,
  parseIssueContract,
} from '@agent/shared'

export interface IssueSimulationPlannerResponse {
  responseText: string
}

export type IssueSimulationFindingCode =
  | 'planning_not_commit_shaped'
  | 'allowed_files_too_broad'
  | 'validation_too_generic'

export type IssueSimulationFindingStage =
  | 'planner'
  | 'reviewer'

export interface IssueSimulationFinding {
  code: IssueSimulationFindingCode
  stage: IssueSimulationFindingStage
  message: string
}

export type IssueSimulationPlannerRunner = (input: {
  prompt: string
  repoRoot: string
}) => Promise<IssueSimulationPlannerResponse>

export interface SimulateIssueExecutabilityInput {
  issueTitle: string
  issueBody: string
  runPlanner: IssueSimulationPlannerRunner
  repoRoot?: string
}

export interface IssueSimulationResult {
  valid: boolean
  summary: string
  failures: string[]
  findings: IssueSimulationFinding[]
  plannerPrompt: string
  plannerOutput: string
  plannedSubtasks: string[]
  checks: {
    commitShapedPlan: boolean
    scopedAllowedFiles: boolean
    specificValidation: boolean
  }
}

export interface ParsedIssueSimulationDocument {
  title: string
  body: string
}

const READ_ONLY_STEP_PATTERNS = [
  /\bread\b/i,
  /\binspect\b/i,
  /\banaly[sz]e\b/i,
  /\bthink\b/i,
  /\bconsider\b/i,
  /\bpropose\b/i,
  /\bresearch\b/i,
  /阅读/,
  /分析/,
  /思考/,
  /调研/,
] as const

const COMMIT_SHAPED_STEP_PATTERNS = [
  /\b(add|create|implement|fix|update|wire|integrate|refactor|rename|remove|write)\b/i,
  /\btest\b/i,
  /\blint\b/i,
  /\btypecheck\b/i,
  /新增/,
  /实现/,
  /修复/,
  /更新/,
  /接入/,
  /补/,
  /拆分/,
] as const

export async function simulateIssueExecutability(
  input: SimulateIssueExecutabilityInput,
): Promise<IssueSimulationResult> {
  const plannerPrompt = buildIssueSimulationPrompt(input.issueTitle, input.issueBody)
  const contract = parseIssueContract(input.issueBody)
  const quality = buildIssueQualityReport(contract)
  const planner = await input.runPlanner({
    prompt: plannerPrompt,
    repoRoot: input.repoRoot ?? process.cwd(),
  })
  const plannerOutput = planner.responseText.trim()
  const plannerSteps = parsePlannerSteps(plannerOutput)
  const commitShapedPlan = plannerSteps.some(isCommitShapedStep)
  const allowedFilesWarnings = quality.warnings
    .filter((warning) => warning.startsWith('AllowedFiles should use exact paths or tightly scoped directories:'))
  const validationWarnings = quality.warnings
    .filter((warning) => warning.startsWith('Validation should use concrete executable commands instead of generic guidance:'))
  const scopedAllowedFiles = allowedFilesWarnings.length === 0
  const specificValidation = validationWarnings.length === 0
  const failures: string[] = []
  const findings: IssueSimulationFinding[] = []

  if (!commitShapedPlan) {
    failures.push('planning output does not contain commit-shaped subtasks')
    findings.push({
      code: 'planning_not_commit_shaped',
      stage: 'planner',
      message: 'planning output does not contain commit-shaped subtasks',
    })
  }

  if (!scopedAllowedFiles) {
    failures.push('allowed file scope is too broad for reliable reviewer/auto-fix execution')
    findings.push(...allowedFilesWarnings.map((warning) => ({
      code: 'allowed_files_too_broad' as const,
      stage: 'reviewer' as const,
      message: warning.replace(
        'AllowedFiles should use exact paths or tightly scoped directories:',
        'allowed file scope is too broad for reliable reviewer/auto-fix execution:',
      ).trim(),
    })))
  }

  if (!specificValidation) {
    failures.push('validation commands are too generic to confirm issue-specific semantics')
    findings.push(...validationWarnings.map((warning) => ({
      code: 'validation_too_generic' as const,
      stage: 'reviewer' as const,
      message: warning.replace(
        'Validation should use concrete executable commands instead of generic guidance:',
        'validation commands are too generic to confirm issue-specific semantics:',
      ).trim(),
    })))
  }

  return {
    valid: failures.length === 0,
    summary: failures.length === 0 ? 'simulation passed' : 'simulation failed',
    failures,
    findings,
    plannerPrompt,
    plannerOutput,
    plannedSubtasks: plannerSteps,
    checks: {
      commitShapedPlan,
      scopedAllowedFiles,
      specificValidation,
    },
  }
}

export function parseIssueSimulationDocument(
  markdown: string,
  fallbackPath: string,
): ParsedIssueSimulationDocument {
  const normalized = markdown.trim()
  const fallbackTitle = basename(fallbackPath)
  if (!normalized) {
    return {
      title: fallbackTitle,
      body: '',
    }
  }

  const lines = normalized.split('\n')
  const titleLine = lines.find(line => /^#\s+/.test(line.trim()))
  if (!titleLine) {
    return {
      title: fallbackTitle,
      body: normalized,
    }
  }

  const title = titleLine.replace(/^#\s+/, '').trim() || fallbackTitle
  const titleIndex = lines.indexOf(titleLine)
  const body = lines
    .slice(0, titleIndex)
    .concat(lines.slice(titleIndex + 1))
    .join('\n')
    .trim()

  return {
    title,
    body,
  }
}

export function formatIssueSimulationResult(
  result: IssueSimulationResult,
  asJson = false,
): string {
  if (asJson) {
    return JSON.stringify(result, null, 2)
  }

  return [
    `valid=${result.valid}`,
    `summary=${result.summary}`,
    `checks=commitShapedPlan:${result.checks.commitShapedPlan}, scopedAllowedFiles:${result.checks.scopedAllowedFiles}, specificValidation:${result.checks.specificValidation}`,
    `findings=${result.findings.map((finding) => `${finding.code}:${finding.message}`).join(' | ') || '-'}`,
    `failures=${result.failures.join(' | ') || '-'}`,
    `plannerOutput=${result.plannerOutput || '-'}`,
  ].join('\n')
}

function buildIssueSimulationPrompt(
  issueTitle: string,
  issueBody: string,
): string {
  return `你正在对一条 issue contract 做只读 simulation。

只返回一个有序编号列表，表示 planner 会如何执行这个 issue。不要输出解释，不要输出 JSON。
要求：
- 如果 issue 可执行，子任务必须是 commit-shaped coding steps
- 不要输出纯阅读、纯分析、纯思考型步骤
- 步骤应该能映射到真实代码修改、测试或验证动作

Issue title:
${issueTitle}

Issue body:
${issueBody.trim() || '(empty body)'}
`
}

function parsePlannerSteps(responseText: string): string[] {
  return responseText
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map((line) => line
      .replace(/^```(?:markdown|md)?\s*/i, '')
      .replace(/^```$/, '')
      .replace(/^[-*]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .trim())
    .filter(Boolean)
}

function isCommitShapedStep(step: string): boolean {
  if (READ_ONLY_STEP_PATTERNS.some(pattern => pattern.test(step))) {
    return COMMIT_SHAPED_STEP_PATTERNS.some(pattern => pattern.test(step))
  }

  return COMMIT_SHAPED_STEP_PATTERNS.some(pattern => pattern.test(step))
}
