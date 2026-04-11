import {
  buildIssueLintReport,
  formatIssueLintReport,
  type IssueLintReport,
} from './audit-issue-contracts'
import { buildRepoAuthoringContext } from './issue-authoring-context'
import {
  buildIssueQualityReport,
  parseIssueContract,
  type BuildRepoAuthoringContextInput,
  type RepoAuthoringContext,
} from '@agent/shared'

export interface RewriteIssueDraftInput {
  issueText: string
  repoRoot: string
}

export interface RewriteIssueDraftResult {
  markdown: string
  validation: IssueLintReport
  authoringContext: RepoAuthoringContext
}

export interface IssueAuthoringAgentResponse {
  responseText: string
}

export type IssueAuthoringAgentRunner = (input: {
  prompt: string
  repoRoot: string
}) => Promise<IssueAuthoringAgentResponse>

interface RewriteIssueDraftDependencies {
  buildRepoAuthoringContext?: (input: BuildRepoAuthoringContextInput) => Promise<RepoAuthoringContext>
  runAgent: IssueAuthoringAgentRunner
}

export async function rewriteIssueDraft(
  input: RewriteIssueDraftInput,
  deps: RewriteIssueDraftDependencies,
): Promise<RewriteIssueDraftResult> {
  const authoringContext = await (deps.buildRepoAuthoringContext ?? buildRepoAuthoringContext)({
    repoRoot: input.repoRoot,
    issueText: input.issueText,
  })
  const draftContract = parseIssueContract(input.issueText)
  const draftQuality = buildIssueQualityReport(draftContract)
  const prompt = buildIssueRewritePrompt({
    issueText: input.issueText,
    authoringContext,
    draftQuality,
  })

  const response = await deps.runAgent({
    prompt,
    repoRoot: input.repoRoot,
  })
  const markdown = normalizeRewrittenIssueMarkdown(response.responseText)
  const validation = buildIssueLintReport(markdown, {
    kind: 'file',
    path: 'stdout',
  })

  if (!validation.valid) {
    throw new Error(
      `Rewritten issue contract failed local validation:\n${formatIssueLintReport(validation)}`,
    )
  }

  return {
    markdown,
    validation,
    authoringContext,
  }
}

export function buildIssueRewritePrompt(input: {
  issueText: string
  authoringContext: RepoAuthoringContext
  draftQuality?: ReturnType<typeof buildIssueQualityReport>
}): string {
  const draftQuality = input.draftQuality ?? buildIssueQualityReport(parseIssueContract(input.issueText))
  const candidateAllowedFiles = input.authoringContext.candidateAllowedFiles.length > 0
    ? input.authoringContext.candidateAllowedFiles.map((value) => `- ${value}`).join('\n')
    : '- none'
  const candidateForbiddenFiles = input.authoringContext.candidateForbiddenFiles.length > 0
    ? input.authoringContext.candidateForbiddenFiles.map((value) => `- ${value}`).join('\n')
    : '- none'
  const candidateValidationCommands = input.authoringContext.candidateValidationCommands.length > 0
    ? input.authoringContext.candidateValidationCommands.map((value) => `- \`${value}\``).join('\n')
    : '- none'
  const currentErrors = draftQuality.errors.length > 0
    ? draftQuality.errors.map((value) => `- ${value}`).join('\n')
    : '- none'
  const currentWarnings = draftQuality.warnings.length > 0
    ? draftQuality.warnings.map((value) => `- ${value}`).join('\n')
    : '- none'
  const projectIssueRules = formatProjectIssueRules(input.authoringContext)

  return `你正在把一条模糊或不完整的 issue 草稿重写成 agent-loop 可直接消费的 canonical executable contract。

只返回 markdown 本体，不要加解释、前言、结尾，也不要包在代码块里。
输出必须以 \`## 用户故事\` 开头，并严格保留下面这组 section 顺序：

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

重写要求：
- 继续使用现有 canonical contract 结构，不要发明新的 section
- \`### Dependencies\` 必须始终保留 fenced JSON block
- 优先把 repo-grounded 上下文里的 repo-relative 路径和命令融入 \`AllowedFiles\`、\`ForbiddenFiles\`、\`Validation\`
- \`AllowedFiles\` 必须尽量精确，优先写具体文件或紧边界目录
- \`Validation\` 必须写可执行命令，避免泛泛而谈
- 如果当前草稿缺少信息，可以补齐最小可执行 contract，但不要夹带额外说明 prose

当前草稿质量：
- valid: ${draftQuality.valid}
- score: ${draftQuality.score}

当前草稿 errors:
${currentErrors}

当前草稿 warnings:
${currentWarnings}

${projectIssueRules}

Repo-grounded candidate AllowedFiles:
${candidateAllowedFiles}

Repo-grounded candidate ForbiddenFiles:
${candidateForbiddenFiles}

Repo-grounded candidate Validation commands:
${candidateValidationCommands}

原始草稿：
${input.issueText.trim() || '(empty draft)'}
`
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
    return ''
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

function normalizeRewrittenIssueMarkdown(responseText: string): string {
  let normalized = responseText.trim()

  const firstHeadingIndex = normalized.search(/^##\s*(用户故事|User Story)\b/m)
  if (firstHeadingIndex >= 0) {
    normalized = normalized.slice(firstHeadingIndex).trim()
  }

  normalized = normalized
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()

  const headingIndexAfterFenceTrim = normalized.search(/^##\s*(用户故事|User Story)\b/m)
  if (headingIndexAfterFenceTrim >= 0) {
    normalized = normalized.slice(headingIndexAfterFenceTrim).trim()
  }

  return normalized
}
