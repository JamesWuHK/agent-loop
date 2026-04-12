import {
  buildIssueQualityReport,
  parseIssueContract,
  type AgentConfig,
  type IssueQualityReport,
  type RepoAuthoringContext,
} from '@agent/shared'
import { runConfiguredAgent } from './cli-agent'
import { buildRepoAuthoringContext } from './issue-authoring-context'

export interface IssueAuthoringAgentRunInput {
  prompt: string
  repoRoot: string
  config?: AgentConfig
}

export interface IssueAuthoringAgentRunResult {
  responseText: string
}

export interface RewriteIssueDraftInput {
  issueText: string
  repoRoot: string
  config?: AgentConfig
  buildAuthoringContext?: (input: {
    repoRoot: string
    issueText: string
  }) => Promise<RepoAuthoringContext>
  runAgent?: (
    input: IssueAuthoringAgentRunInput,
  ) => Promise<IssueAuthoringAgentRunResult>
}

export interface RewriteIssueDraftResult {
  markdown: string
  validation: IssueQualityReport
}

export async function rewriteIssueDraft(
  input: RewriteIssueDraftInput,
): Promise<RewriteIssueDraftResult> {
  const buildContext = input.buildAuthoringContext ?? defaultBuildAuthoringContext
  const runAgent = input.runAgent ?? defaultRunIssueAuthoringAgent
  const authoringContext = await buildContext({
    repoRoot: input.repoRoot,
    issueText: input.issueText,
  })
  const prompt = buildIssueRewritePrompt({
    issueText: input.issueText,
    authoringContext,
  })
  const agentResult = await runAgent({
    prompt,
    repoRoot: input.repoRoot,
    config: input.config,
  })
  const markdown = normalizeIssueRewriteMarkdown(agentResult.responseText)

  if (!markdown.startsWith('## 用户故事') && !markdown.startsWith('## User Story')) {
    throw new Error('rewrite output must be canonical markdown only and start with ## 用户故事 / User Story')
  }

  const validation = buildIssueQualityReport(parseIssueContract(markdown))
  if (!validation.valid) {
    throw new Error(`rewrite output failed contract validation: ${validation.errors.join(' | ')}`)
  }

  return {
    markdown,
    validation,
  }
}

export function buildIssueRewritePrompt(input: {
  issueText: string
  authoringContext: RepoAuthoringContext
}): string {
  const blocks = [
    '你是 agent-loop 的 issue rewrite worker。',
    '把下面的模糊 issue 草稿重写成 canonical executable contract markdown。',
    '输出要求：',
    '- 只输出 markdown 合同本体，不要在前后加解释性 prose。',
    '- 不要把整份输出再包一层 ```markdown fenced code block。',
    '- 必须使用现有 canonical section 结构，并保留 `### Dependencies` 的 fenced JSON。',
    '- `### Validation` 必须只包含可执行命令。',
    '- 优先使用 repo-grounded authoring context 提供的候选路径和命令，不要猜宽泛 scope。',
    'Canonical section order:',
    '1. `## 用户故事`',
    '2. `## Context`',
    '3. `### Dependencies`',
    '4. `### Constraints`',
    '5. `### AllowedFiles`',
    '6. `### ForbiddenFiles`',
    '7. `### MustPreserve`',
    '8. `### OutOfScope`',
    '9. `### RequiredSemantics`',
    '10. `### ReviewHints`',
    '11. `### Validation`',
    '12. `## RED 测试`',
    '13. `## 实现步骤`',
    '14. `## 验收`',
    renderSuggestionBlock('Candidate Validation Commands', input.authoringContext.candidateValidationCommands),
    renderSuggestionBlock('Candidate Allowed Files', input.authoringContext.candidateAllowedFiles),
    renderSuggestionBlock('Candidate Forbidden Files', input.authoringContext.candidateForbiddenFiles),
    'Draft issue text:',
    '```markdown',
    input.issueText.trim(),
    '```',
  ]

  return blocks.filter(Boolean).join('\n\n')
}

export function normalizeIssueRewriteMarkdown(responseText: string): string {
  const trimmed = responseText.trim()
  const fencedMatch = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i)
  return (fencedMatch?.[1] ?? trimmed).trim()
}

function renderSuggestionBlock(title: string, values: string[]): string {
  if (values.length === 0) {
    return `${title}:\n- (none found; keep the rewrite explicit and tightly scoped)`
  }

  return `${title}:\n${values.map((value) => `- ${value}`).join('\n')}`
}

async function defaultBuildAuthoringContext(input: {
  repoRoot: string
  issueText: string
}): Promise<RepoAuthoringContext> {
  return buildRepoAuthoringContext({
    repoRoot: input.repoRoot,
    issueText: input.issueText,
  })
}

async function defaultRunIssueAuthoringAgent(
  input: IssueAuthoringAgentRunInput,
): Promise<IssueAuthoringAgentRunResult> {
  if (!input.config) {
    throw new Error('rewriteIssueDraft requires config when no custom runAgent is provided')
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
    throw new Error(`issue rewrite agent failed: ${detail}`)
  }

  return {
    responseText: result.responseText,
  }
}
