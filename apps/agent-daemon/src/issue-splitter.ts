import { basename } from 'node:path'
import {
  buildIssueLintReport,
  formatIssueLintReport,
  type IssueLintReport,
} from './audit-issue-contracts'
import { buildRepoAuthoringContext } from './issue-authoring-context'
import type {
  BuildRepoAuthoringContextInput,
  RepoAuthoringContext,
} from '@agent/shared'
import type { IssueAuthoringAgentRunner } from './issue-authoring'

export interface SplitTrackingIssueInput {
  title: string
  body: string
  repoRoot: string
  issueNumberAllocator: () => number
}

export interface SplitTrackingIssueChild {
  issueNumber: number
  title: string
  body: string
  validation: IssueLintReport
  authoringContext: RepoAuthoringContext
}

export interface SplitTrackingIssueResult {
  parentSummary: string
  children: SplitTrackingIssueChild[]
}

export interface TrackingIssueDraftDocument {
  title: string
  body: string
}

interface SplitTrackingIssueDependencies {
  buildRepoAuthoringContext?: (input: BuildRepoAuthoringContextInput) => Promise<RepoAuthoringContext>
  runAgent: IssueAuthoringAgentRunner
}

const INVESTIGATION_ONLY_TITLE_PATTERNS = [
  /\binvestigat(?:e|ion)\b/i,
  /\bresearch\b/i,
  /\bspike\b/i,
  /\banalys(?:e|is)\b/i,
  /调研/,
  /调查/,
  /研究/,
] as const

const CHILD_FILE_HINTS = [
  {
    patterns: [/\blint\b/i, /质量/, /\baudit\b/i],
    files: [
      'apps/agent-daemon/src/audit-issue-contracts.ts',
      'apps/agent-daemon/src/audit-issue-contracts.test.ts',
      'apps/agent-daemon/src/index.ts',
      'apps/agent-daemon/src/index.test.ts',
    ],
  },
  {
    patterns: [/\brewrite\b/i, /重写/],
    files: [
      'apps/agent-daemon/src/issue-authoring.ts',
      'apps/agent-daemon/src/issue-authoring.test.ts',
      'apps/agent-daemon/src/index.ts',
      'apps/agent-daemon/src/index.test.ts',
    ],
  },
  {
    patterns: [/\bsplit\b/i, /拆/, /dependson/i, /依赖图/],
    files: [
      'apps/agent-daemon/src/issue-splitter.ts',
      'apps/agent-daemon/src/issue-splitter.test.ts',
      'apps/agent-daemon/src/index.ts',
      'apps/agent-daemon/src/index.test.ts',
    ],
  },
  {
    patterns: [/\bsimulate\b/i, /模拟/],
    files: [
      'apps/agent-daemon/src/issue-simulate.ts',
      'apps/agent-daemon/src/issue-simulate.test.ts',
      'apps/agent-daemon/src/index.ts',
      'apps/agent-daemon/src/index.test.ts',
    ],
  },
  {
    patterns: [/\bcontext\b/i, /上下文/, /grounded/i],
    files: [
      'apps/agent-daemon/src/issue-authoring-context.ts',
      'apps/agent-daemon/src/issue-authoring-context.test.ts',
    ],
  },
] as const

export async function splitTrackingIssue(
  input: SplitTrackingIssueInput,
  deps: SplitTrackingIssueDependencies,
): Promise<SplitTrackingIssueResult> {
  const parentAuthoringContext = await (deps.buildRepoAuthoringContext ?? buildRepoAuthoringContext)({
    repoRoot: input.repoRoot,
    issueText: [input.title, input.body].filter(Boolean).join('\n'),
  })
  const response = await deps.runAgent({
    prompt: buildSplitTrackingIssuePrompt(input.title, input.body, parentAuthoringContext),
    repoRoot: input.repoRoot,
  })
  const childTitles = parseChildIssueTitles(response.responseText)

  if (childTitles.length < 2) {
    throw new Error('Split output must contain at least two execution-sized child issues')
  }

  const seen = new Set<number>()
  const childNumbers = childTitles.map(() => {
    const issueNumber = input.issueNumberAllocator()
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      throw new Error(`Issue number allocator returned an invalid issue number: ${issueNumber}`)
    }
    if (seen.has(issueNumber)) {
      throw new Error(`Issue number allocator returned a duplicate issue number: ${issueNumber}`)
    }
    seen.add(issueNumber)
    return issueNumber
  })

  const children: SplitTrackingIssueChild[] = []

  for (const [index, childTitle] of childTitles.entries()) {
    const authoringContext = await (deps.buildRepoAuthoringContext ?? buildRepoAuthoringContext)({
      repoRoot: input.repoRoot,
      issueText: [input.title, input.body, childTitle].filter(Boolean).join('\n'),
    })
    const issueNumber = childNumbers[index]!
    const dependsOn = childNumbers.slice(0, index)
    const laterTitles = childTitles.slice(index + 1)
    const body = buildChildIssueBody({
      parentTitle: input.title,
      childTitle,
      issueNumber,
      dependsOn,
      authoringContext,
      laterTitles,
    })
    const validation = buildIssueLintReport(body, {
      kind: 'file',
      path: `child-${issueNumber}.md`,
    }, childTitle)

    if (!validation.valid) {
      throw new Error(
        `Split child issue #${issueNumber} failed local validation:\n${formatIssueLintReport(validation)}`,
      )
    }

    children.push({
      issueNumber,
      title: childTitle,
      body,
      validation,
      authoringContext,
    })
  }

  return {
    parentSummary: buildParentSummary({
      parentTitle: input.title,
      childTitles,
      childNumbers,
    }),
    children,
  }
}

export function parseTrackingIssueDocument(
  markdown: string,
  fallbackTitle = 'Tracking Issue Draft',
): TrackingIssueDraftDocument {
  const normalized = markdown.trim()
  if (!normalized) {
    return {
      title: fallbackTitle,
      body: '',
    }
  }

  const lines = normalized.split('\n')
  const headingIndex = lines.findIndex(line => /^#\s+/.test(line.trim()))

  if (headingIndex >= 0) {
    const title = lines[headingIndex]!.replace(/^#\s+/, '').trim() || fallbackTitle
    const body = lines
      .slice(0, headingIndex)
      .concat(lines.slice(headingIndex + 1))
      .join('\n')
      .trim()
    return {
      title,
      body,
    }
  }

  const firstNonEmpty = lines.find(line => line.trim().length > 0)?.trim() ?? fallbackTitle
  const remaining = lines.slice(lines.findIndex(line => line.trim().length > 0) + 1).join('\n').trim()

  return {
    title: firstNonEmpty,
    body: remaining,
  }
}

export function formatSplitTrackingIssueResult(
  result: SplitTrackingIssueResult,
): string {
  return [
    result.parentSummary,
    ...result.children.flatMap((child) => [
      '',
      `## Child Issue #${child.issueNumber}: ${child.title}`,
      '',
      child.body,
    ]),
  ].join('\n')
}

function buildSplitTrackingIssuePrompt(
  title: string,
  body: string,
  authoringContext: RepoAuthoringContext,
): string {
  const projectIssueRules = formatProjectIssueRules(authoringContext)

  return `你正在把一个 tracking parent issue 拆成 execution-sized child issues。

只返回有序编号列表，每行一条 child issue 标题，不要输出解释，不要输出 markdown section，不要输出 dependsOn JSON。
要求：
- child issue 必须是 code-producing slices
- 不能输出 investigation-only / research-only / analysis-only task
- 顺序必须符合执行依赖关系
- 标题要足够具体，能自然落成 canonical executable contract

Tracking parent title:
${title}

${projectIssueRules}

Tracking parent body:
${body.trim() || '(empty body)'}
`
}

function parseChildIssueTitles(responseText: string): string[] {
  const titles = responseText
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(stripOutlinePrefix)
    .filter(Boolean)
    .map(title => title.replace(/^\[[^\]]+\]\s*/, (prefix) => prefix.trimEnd() + ' ').trim())

  const deduped: string[] = []
  const seen = new Set<string>()
  for (const title of titles) {
    const normalized = title.toLowerCase()
    if (seen.has(normalized)) continue
    if (INVESTIGATION_ONLY_TITLE_PATTERNS.some(pattern => pattern.test(title))) {
      throw new Error(`Split output contains a non-executable child title: ${title}`)
    }
    deduped.push(title)
    seen.add(normalized)
  }

  return deduped
}

function stripOutlinePrefix(line: string): string {
  return line
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/^```$/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .trim()
}

function buildParentSummary(input: {
  parentTitle: string
  childTitles: string[]
  childNumbers: number[]
}): string {
  return [
    '## Tracking Parent Summary',
    '',
    `- Parent: ${input.parentTitle}`,
    '- Parent role: tracking-only; do not move it into `agent:ready`',
    `- Child count: ${input.childTitles.length}`,
    '- Suggested creation order:',
    ...input.childTitles.map((title, index) => {
      const dependencies = input.childNumbers
        .slice(0, index)
        .map(number => `#${number}`)
        .join(', ')
      return `${index + 1}. #${input.childNumbers[index]} ${title}${dependencies ? ` | 依赖 issue: ${dependencies}` : ' | 依赖 issue: none'}`
    }),
  ].join('\n')
}

function buildChildIssueBody(input: {
  parentTitle: string
  childTitle: string
  issueNumber: number
  dependsOn: number[]
  authoringContext: RepoAuthoringContext
  laterTitles: string[]
}): string {
  const allowedFiles = resolveAllowedFiles(input.childTitle, input.authoringContext)
  const forbiddenFiles = resolveForbiddenFiles(
    input.childTitle,
    input.laterTitles,
    allowedFiles,
    input.authoringContext,
  )
  const validationCommands = resolveValidationCommands(input.authoringContext)
  const outOfScope = input.laterTitles.length > 0
    ? input.laterTitles.map(title => `后续 child issue: ${title}`)
    : ['自动创建 GitHub issue / label / assignee']
  const reviewHints = uniqueStrings([
    ...(input.authoringContext.candidateReviewHints ?? []),
    '优先检查本 child issue 是否偷混入后续 sibling 工作',
    '优先检查变更文件是否仍落在 `AllowedFiles` 边界内',
  ])

  return `## 用户故事

作为 \`agent-loop\` 维护者，我希望完成 ${input.childTitle}，从而把 \`${input.parentTitle}\` 拆成可进入 ready pool 的 execution-sized child issue。

## Context

### Dependencies
\`\`\`json
{"dependsOn":[${input.dependsOn.join(',')}]}
\`\`\`

### Constraints
- 只完成 \`${input.childTitle}\` 这一条 execution-sized 切片
- 不要把 sibling child issue 的后续工作提前混入本次实现

### AllowedFiles
${allowedFiles.map(value => `- ${value}`).join('\n')}

### ForbiddenFiles
${forbiddenFiles.map(value => `- ${value}`).join('\n')}

### MustPreserve
- tracking parent 仍然保持 tracking-only，不进入 \`agent:ready\`
- 已完成或前序 child issue 的 contract 结构与依赖顺序不回归

### OutOfScope
${outOfScope.map(value => `- ${value}`).join('\n')}

### RequiredSemantics
- 产出与 \`${input.childTitle}\` 对齐的最小代码切片，而不是 investigation-only 结果
- \`AllowedFiles\`、\`Validation\` 与本切片实际实现路径保持一致

### ReviewHints
${reviewHints.map(value => `- ${value}`).join('\n')}

### Validation
${validationCommands.map(value => `- \`${value}\``).join('\n')}

## RED 测试

\`\`\`ts
throw new Error(${JSON.stringify(`red: ${input.childTitle}`)})
\`\`\`

## 实现步骤

1. 先补 RED 测试
2. 再做最小实现
3. 最后跑 Validation 并收紧 scope

## 验收

- [ ] 只修改 \`AllowedFiles\` 内文件
- [ ] \`MustPreserve\` 行为未回归
- [ ] \`OutOfScope\` 内容未混入
- [ ] RED 测试转绿
- [ ] 完成 \`Validation\` 中要求的验证`
}

function resolveAllowedFiles(
  childTitle: string,
  authoringContext: RepoAuthoringContext,
): string[] {
  const contextCandidates = authoringContext.candidateAllowedFiles.slice(0, 4)
  const hintedFiles = collectHintedFiles(childTitle)

  return uniqueStrings([
    ...hintedFiles,
    ...contextCandidates,
    ...(contextCandidates.length === 0 && hintedFiles.length === 0
      ? buildSlugFallbackFiles(childTitle)
      : []),
  ]).slice(0, 4)
}

function resolveForbiddenFiles(
  childTitle: string,
  laterTitles: string[],
  allowedFiles: string[],
  authoringContext: RepoAuthoringContext,
): string[] {
  const forbidden = uniqueStrings([
    ...authoringContext.candidateForbiddenFiles,
    ...laterTitles.flatMap(title => collectHintedFiles(title)),
    ...collectNonMatchingHintFiles(childTitle),
  ]).filter(file => !allowedFiles.includes(file))

  if (forbidden.length > 0) {
    return forbidden.slice(0, 4)
  }

  return [
    'package.json',
    'tsconfig.json',
  ].filter(file => !allowedFiles.includes(file))
}

function resolveValidationCommands(
  authoringContext: RepoAuthoringContext,
): string[] {
  const commands = uniqueStrings([
    ...authoringContext.candidateValidationCommands.slice(0, 2),
    'git diff --stat origin/main...HEAD',
  ])

  return commands
}

function collectHintedFiles(title: string): string[] {
  return CHILD_FILE_HINTS
    .filter(entry => entry.patterns.some(pattern => pattern.test(title)))
    .flatMap(entry => entry.files)
}

function collectNonMatchingHintFiles(title: string): string[] {
  return CHILD_FILE_HINTS
    .filter(entry => !entry.patterns.some(pattern => pattern.test(title)))
    .flatMap(entry => entry.files)
}

function buildSlugFallbackFiles(title: string): string[] {
  const slug = title
    .replace(/^\[[^\]]+\]\s*/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || basename(title).toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'child-issue'

  return [
    `apps/agent-daemon/src/${slug}.ts`,
    `apps/agent-daemon/src/${slug}.test.ts`,
  ]
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
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
