import type {
  BuildRepoAuthoringContextInput,
  RepoAuthoringContext,
} from '@agent/shared'
import {
  buildIssueLintReport,
  formatIssueLintReport,
  type IssueLintReport,
} from './audit-issue-contracts'
import { buildRepoAuthoringContext } from './issue-authoring-context'
import { normalizeCanonicalIssueMarkdown } from './issue-authoring'
import {
  parseIssueSimulationDocument,
  simulateIssueExecutability,
  type IssueSimulationPlannerRunner,
  type IssueSimulationResult,
} from './issue-simulate'

export interface RepairIssueDraftInput {
  issueText: string
  repoRoot: string
  includeSimulation?: boolean
  lintReport?: IssueLintReport
  simulationResult?: IssueSimulationResult
}

export interface RepairIssueDraftResult {
  success: boolean
  repairedMarkdown: string
  appliedFindingCodes: string[]
  blockingFindings: string[]
  before: {
    validation: IssueLintReport
    simulation?: IssueSimulationResult
  }
  after: {
    validation: IssueLintReport
    simulation?: IssueSimulationResult
  }
  authoringContext: RepoAuthoringContext
}

export interface IssueRepairAgentResponse {
  responseText: string
}

export type IssueRepairAgentRunner = (input: {
  prompt: string
  repoRoot: string
}) => Promise<IssueRepairAgentResponse>

interface RepairIssueDraftDependencies {
  buildRepoAuthoringContext?: (input: BuildRepoAuthoringContextInput) => Promise<RepoAuthoringContext>
  runAgent: IssueRepairAgentRunner
  runPlanner?: IssueSimulationPlannerRunner
}

export async function repairIssueDraft(
  input: RepairIssueDraftInput,
  deps: RepairIssueDraftDependencies,
): Promise<RepairIssueDraftResult> {
  const authoringContext = await (deps.buildRepoAuthoringContext ?? buildRepoAuthoringContext)({
    repoRoot: input.repoRoot,
    issueText: input.issueText,
  })
  const beforeValidation = input.lintReport ?? buildIssueLintReport(input.issueText, {
    kind: 'file',
    path: 'stdin',
  })
  const beforeSimulation = input.includeSimulation
    ? await resolveSimulationResult({
        issueText: input.issueText,
        repoRoot: input.repoRoot,
        simulationResult: input.simulationResult,
        runPlanner: deps.runPlanner,
      })
    : undefined
  const prompt = buildIssueRepairPrompt({
    issueText: input.issueText,
    authoringContext,
    lintReport: beforeValidation,
    simulationResult: beforeSimulation,
  })
  const response = await deps.runAgent({
    prompt,
    repoRoot: input.repoRoot,
  })
  const repairedMarkdown = normalizeCanonicalIssueMarkdown(response.responseText)
  const afterValidation = buildIssueLintReport(repairedMarkdown, {
    kind: 'file',
    path: 'stdout',
  })
  const afterSimulation = input.includeSimulation
    ? await rerunSimulation({
        sourceMarkdown: repairedMarkdown,
        repoRoot: input.repoRoot,
        runPlanner: deps.runPlanner,
      })
    : undefined
  const blockingFindings = collectBlockingFindings({
    validation: afterValidation,
    simulation: afterSimulation,
  })

  return {
    success: blockingFindings.length === 0,
    repairedMarkdown,
    appliedFindingCodes: collectAppliedFindingCodes({
      lintReport: beforeValidation,
      simulationResult: beforeSimulation,
    }),
    blockingFindings,
    before: {
      validation: beforeValidation,
      simulation: beforeSimulation,
    },
    after: {
      validation: afterValidation,
      simulation: afterSimulation,
    },
    authoringContext,
  }
}

export function buildIssueRepairPrompt(input: {
  issueText: string
  authoringContext: RepoAuthoringContext
  lintReport: IssueLintReport
  simulationResult?: IssueSimulationResult
}): string {
  const candidateAllowedFiles = input.authoringContext.candidateAllowedFiles.length > 0
    ? input.authoringContext.candidateAllowedFiles.map((value) => `- ${value}`).join('\n')
    : '- none'
  const candidateForbiddenFiles = input.authoringContext.candidateForbiddenFiles.length > 0
    ? input.authoringContext.candidateForbiddenFiles.map((value) => `- ${value}`).join('\n')
    : '- none'
  const candidateValidationCommands = input.authoringContext.candidateValidationCommands.length > 0
    ? input.authoringContext.candidateValidationCommands.map((value) => `- \`${value}\``).join('\n')
    : '- none'
  const candidateReviewHints = (input.authoringContext.candidateReviewHints ?? []).length > 0
    ? (input.authoringContext.candidateReviewHints ?? []).map((value) => `- ${value}`).join('\n')
    : '- none'
  const lintErrors = input.lintReport.errors.length > 0
    ? input.lintReport.errors.map((value) => `- ${value}`).join('\n')
    : '- none'
  const lintWarnings = input.lintReport.warnings.length > 0
    ? input.lintReport.warnings.map((value) => `- ${value}`).join('\n')
    : '- none'
  const simulationSection = input.simulationResult
    ? [
        `Current simulation summary: ${input.simulationResult.summary}`,
        `Current simulation failures:\n${input.simulationResult.failures.map((value) => `- ${value}`).join('\n') || '- none'}`,
        `Current simulation findings:\n${input.simulationResult.findings.map((finding) => `- [${finding.code}] ${finding.message}`).join('\n') || '- none'}`,
      ].join('\n\n')
    : 'Current simulation findings:\n- none'
  const projectIssueRules = formatProjectIssueRules(input.authoringContext)

  return `你正在对一条“接近可执行但仍有 lint / simulate findings”的 issue contract 做最小 repair。

只返回修复后的 markdown 本体，不要输出解释、前言、结尾，也不要包在代码块里。
输出必须保持 canonical executable contract，并严格保留下面这组 section 顺序：

## 用户故事
## Context
### Dependencies
\`\`\`json
{"dependsOn":[]}
\`\`\`
### Constraints
### AllowedFiles
### ForbiddenFiles
### MustPreserve
### OutOfScope
### RequiredSemantics
### ReviewHints
### Validation
## RED 测试
\`\`\`ts
throw new Error('red')
\`\`\`
## 实现步骤
## 验收

Repair 要求：
- 只做最小修正，优先修 findings 指向的问题；不要重写需求、扩大 scope、删除具体约束
- 如果当前 \`### Dependencies\` fenced JSON 已存在且机器可解析，必须保留它的结构和依赖数字
- 不要为了“修过 lint”而把具体 \`AllowedFiles\` 宽化成模糊描述
- 不要把具体 \`Validation\` 命令改成泛泛描述
- 输出仍然必须是 canonical executable contract markdown

当前 lint errors:
${lintErrors}

当前 lint warnings:
${lintWarnings}

${simulationSection}

${projectIssueRules}

Repo-grounded candidate AllowedFiles:
${candidateAllowedFiles}

Repo-grounded candidate ForbiddenFiles:
${candidateForbiddenFiles}

Repo-grounded candidate Validation commands:
${candidateValidationCommands}

Repo-grounded candidate ReviewHints:
${candidateReviewHints}

当前 issue markdown:
${input.issueText.trim() || '(empty draft)'}
`
}

export function formatIssueRepairResult(
  result: RepairIssueDraftResult,
  asJson = false,
): string {
  if (asJson) {
    return JSON.stringify(result, null, 2)
  }

  return result.repairedMarkdown
}

function collectAppliedFindingCodes(input: {
  lintReport: IssueLintReport
  simulationResult?: IssueSimulationResult
}): string[] {
  const lintCodes = [
    ...input.lintReport.errors.map(deriveLintFindingCode),
    ...input.lintReport.warnings.map(deriveLintFindingCode),
  ]
  const simulationCodes = input.simulationResult?.findings.map((finding) => finding.code) ?? []

  return uniqueStrings([...lintCodes, ...simulationCodes])
}

function collectBlockingFindings(input: {
  validation: IssueLintReport
  simulation?: IssueSimulationResult
}): string[] {
  const findings = [...input.validation.errors]

  if (input.simulation && !input.simulation.valid) {
    findings.push(...input.simulation.failures)
  }

  return findings
}

async function resolveSimulationResult(input: {
  issueText: string
  repoRoot: string
  simulationResult?: IssueSimulationResult
  runPlanner?: IssueSimulationPlannerRunner
}): Promise<IssueSimulationResult> {
  if (input.simulationResult) {
    return input.simulationResult
  }

  if (!input.runPlanner) {
    throw new Error('repair simulation requires a planner runner')
  }

  const document = parseIssueSimulationDocument(input.issueText, 'Issue Draft')
  return simulateIssueExecutability({
    issueTitle: document.title,
    issueBody: document.body,
    repoRoot: input.repoRoot,
    runPlanner: input.runPlanner,
  })
}

async function rerunSimulation(input: {
  sourceMarkdown: string
  repoRoot: string
  runPlanner?: IssueSimulationPlannerRunner
}): Promise<IssueSimulationResult> {
  if (!input.runPlanner) {
    throw new Error('repair simulation requires a planner runner')
  }

  const document = parseIssueSimulationDocument(input.sourceMarkdown, 'Repaired Issue Draft')
  return simulateIssueExecutability({
    issueTitle: document.title,
    issueBody: document.body,
    repoRoot: input.repoRoot,
    runPlanner: input.runPlanner,
  })
}

function deriveLintFindingCode(message: string): string {
  if (message.startsWith('AllowedFiles should use exact paths or tightly scoped directories:')) {
    return 'allowed_files_too_broad'
  }

  if (message.startsWith('Validation should use concrete executable commands instead of generic guidance:')) {
    return 'validation_too_generic'
  }

  if (message === 'missing ### Dependencies JSON block') {
    return 'missing_dependencies_block'
  }

  if (message === 'missing ## 实现步骤 / Implementation Steps') {
    return 'missing_implementation_steps'
  }

  if (message === 'missing ## 验收 / Acceptance') {
    return 'missing_acceptance'
  }

  if (message === 'missing ## RED 测试 / RED Tests') {
    return 'missing_red_tests'
  }

  if (message === 'missing ### Validation / Validation Commands') {
    return 'missing_validation_commands'
  }

  if (message === 'missing executable scope contract (AllowedFiles/ForbiddenFiles/MustPreserve/OutOfScope/RequiredSemantics)') {
    return 'missing_executable_scope_contract'
  }

  return message
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function formatProjectIssueRules(authoringContext: RepoAuthoringContext): string {
  const rules = authoringContext.projectIssueRules ?? {
    preferredValidationCommands: [],
    preferredAllowedFiles: [],
    forbiddenPaths: [],
    reviewHints: [],
  }

  if (
    rules.preferredValidationCommands.length === 0
    && rules.preferredAllowedFiles.length === 0
    && rules.forbiddenPaths.length === 0
    && rules.reviewHints.length === 0
  ) {
    return 'Project Issue Rules:\n- none'
  }

  return [
    'Project Issue Rules:',
    rules.preferredAllowedFiles.length > 0
      ? `Preferred AllowedFiles:\n${rules.preferredAllowedFiles.map((value) => `- ${value}`).join('\n')}`
      : null,
    rules.forbiddenPaths.length > 0
      ? `Forbidden paths:\n${rules.forbiddenPaths.map((value) => `- ${value}`).join('\n')}`
      : null,
    rules.preferredValidationCommands.length > 0
      ? `Preferred Validation commands:\n${rules.preferredValidationCommands.map((value) => `- \`${value}\``).join('\n')}`
      : null,
    rules.reviewHints.length > 0
      ? `Review hints:\n${rules.reviewHints.map((value) => `- ${value}`).join('\n')}`
      : null,
  ].filter((value): value is string => value !== null).join('\n\n')
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const deduped: string[] = []

  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    deduped.push(trimmed)
  }

  return deduped
}
