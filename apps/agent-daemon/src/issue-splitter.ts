import { existsSync } from 'node:fs'
import {
  buildIssueQualityReport,
  parseIssueContract,
  renderIssueContractForPrompt,
  type AgentConfig,
  type IssueQualityReport,
} from '@agent/shared'
import { runConfiguredAgent } from './cli-agent'
import { rewriteIssueDraft, type RewriteIssueDraftInput, type RewriteIssueDraftResult } from './issue-authoring'
import { buildRepoAuthoringContext, type RepoAuthoringContext } from './issue-authoring-context'

type DependencyReference = string | number

export interface TrackingIssueSplitPlanChild {
  id: string
  title: string
  summary: string
  scopeHints: string[]
  allowedFiles: string[]
  outOfScope: string[]
  requiredSemantics: string[]
  dependencyReferences: DependencyReference[]
  hasExplicitDependencies: boolean
}

export interface TrackingIssueSplitPlan {
  parentSummary: string
  children: TrackingIssueSplitPlanChild[]
}

interface AllocatedTrackingIssueSplitPlanChild extends TrackingIssueSplitPlanChild {
  number: number
}

export interface IssueSplitterAgentRunInput {
  prompt: string
  repoRoot: string
  config?: AgentConfig
}

export interface IssueSplitterAgentRunResult {
  responseText: string
}

export interface SplitTrackingIssueInput {
  title?: string
  body?: string
  issueText?: string
  repoRoot: string
  config?: AgentConfig
  issueNumberAllocator?: () => number
  buildAuthoringContext?: (input: {
    repoRoot: string
    issueText: string
    issueTitle?: string
    issueBody?: string
  }) => Promise<RepoAuthoringContext>
  runAgent?: (
    input: IssueSplitterAgentRunInput,
  ) => Promise<IssueSplitterAgentRunResult>
  rewriteIssueDraft?: (
    input: RewriteIssueDraftInput,
  ) => Promise<RewriteIssueDraftResult>
}

export interface SplitTrackingIssueChildResult {
  number: number
  title: string
  body: string
  dependsOn: number[]
  validation: IssueQualityReport
}

export interface SplitTrackingIssueResult {
  parentSummary: string
  children: SplitTrackingIssueChildResult[]
  markdown: string
}

const MAX_CHILD_ISSUES = 8

export async function splitTrackingIssue(
  input: SplitTrackingIssueInput,
): Promise<SplitTrackingIssueResult> {
  const buildContext = input.buildAuthoringContext ?? defaultBuildAuthoringContext
  const runAgent = input.runAgent ?? defaultRunIssueSplitterAgent
  const rewrite = input.rewriteIssueDraft ?? rewriteIssueDraft
  const source = resolveTrackingIssueSource(input)
  const authoringContext = await buildContext({
    repoRoot: input.repoRoot,
    issueText: source.issueText,
    issueTitle: source.title,
    issueBody: source.body,
  })
  const parentContract = parseIssueContract(source.body)
  const planPrompt = buildTrackingIssueSplitPrompt({
    title: source.title,
    body: source.body,
    issueText: source.issueText,
    authoringContext,
  })
  const agentResult = await runAgent({
    prompt: planPrompt,
    repoRoot: input.repoRoot,
    config: input.config,
  })
  const splitPlan = parseTrackingIssueSplitPlan(agentResult.responseText)
  const allocator = input.issueNumberAllocator ?? createSequentialIssueNumberAllocator()
  const allocatedChildren = allocateChildIssueNumbers(splitPlan.children, allocator)
  const dependencyNumbersByChild = resolveChildDependencyNumbers(allocatedChildren)
  const childResults: SplitTrackingIssueChildResult[] = []
  const shouldUseRewrite = Boolean(input.rewriteIssueDraft || input.config)

  for (let index = 0; index < allocatedChildren.length; index += 1) {
    const child = allocatedChildren[index]!
    const dependsOn = dependencyNumbersByChild[index] ?? []
    const draftedMarkdown = shouldUseRewrite
      ? (await rewrite({
        issueText: buildChildIssueDraft({
          parentTitle: source.title,
          parentBody: source.body,
          child,
        }),
        repoRoot: input.repoRoot,
        config: input.config,
      })).markdown
      : renderDeterministicChildIssue({
        parentTitle: source.title,
        parentContract,
        authoringContext,
        child,
        siblingTitles: allocatedChildren.map((candidate) => candidate.title),
        dependsOn,
      })
    const finalizedMarkdown = applyIssueDependencies(draftedMarkdown, dependsOn)
    const validation = buildIssueQualityReport(parseIssueContract(finalizedMarkdown))

    if (!validation.valid) {
      throw new Error(`split child ${child.title} failed contract validation: ${validation.errors.join(' | ')}`)
    }

    if (validation.warnings.length > 0) {
      throw new Error(`split child ${child.title} failed quality checks: ${validation.warnings.join(' | ')}`)
    }

    childResults.push({
      number: child.number,
      title: child.title,
      body: finalizedMarkdown,
      dependsOn,
      validation,
    })
  }

  const parentSummary = splitPlan.parentSummary.trim() || buildFallbackParentSummary({
    title: source.title,
    children: childResults,
  })

  return {
    parentSummary,
    children: childResults,
    markdown: formatTrackingIssueSplitResult({
      parentTitle: source.title,
      parentSummary,
      children: childResults,
    }),
  }
}

export function buildTrackingIssueSplitPrompt(input: {
  title: string
  body: string
  issueText: string
  authoringContext: RepoAuthoringContext
}): string {
  const parentContract = renderIssueContractForPrompt(input.body)
  const blocks = [
    '你是 agent-loop 的 tracking issue split worker。',
    '把一个 tracking parent issue 拆成 execution-sized child issue plans，再交给 rewrite worker 生成 canonical executable contracts。',
    '输出要求：',
    '- 只输出 strict JSON object，不要输出 markdown、解释、前后缀 prose。',
    '- `children` 必须保持执行顺序；每个 child 都必须是 code-producing slice，而不是 investigation-only task。',
    '- `dependsOn` 只能引用更早的 sibling child，优先使用 child `id`；没有依赖就输出 `[]`。',
    '- `allowedFiles`、`outOfScope`、`requiredSemantics` 要尽量具体，能支撑 reviewer 和 auto-fix。',
    '- parent issue 仍然是 tracking-only，不进入 `agent:ready`。',
    'JSON schema:',
    '```json',
    JSON.stringify({
      parentSummary: '一段 tracking summary，概括 parent 如何串起下面的 child issues',
      children: [
        {
          id: 'issue-lint',
          title: '[AL-X] 引入 issue lint',
          summary: '一句话描述这个 child 的目标与价值',
          scopeHints: ['实现范围提示'],
          allowedFiles: ['apps/agent-daemon/src/example.ts'],
          outOfScope: ['不属于这个 child 的后续工作'],
          requiredSemantics: ['必须保留或新增的行为'],
          dependsOn: [],
        },
      ],
    }, null, 2),
    '```',
    renderSuggestionBlock('Candidate Validation Commands', input.authoringContext.candidateValidationCommands),
    renderSuggestionBlock('Candidate Allowed Files', input.authoringContext.candidateAllowedFiles),
    renderSuggestionBlock('Candidate Forbidden Files', input.authoringContext.candidateForbiddenFiles),
    'Parsed parent contract:',
    parentContract || '(no structured parent contract detected; still keep the split concrete and code-producing)',
    `Parent title: ${input.title}`,
    'Parent issue body:',
    '```markdown',
    input.body.trim() || input.issueText.trim(),
    '```',
  ]

  return blocks.filter(Boolean).join('\n\n')
}

export function parseTrackingIssueSplitPlan(responseText: string): TrackingIssueSplitPlan {
  const normalized = normalizeSplitPlanText(responseText)
  const jsonValue = tryParseSplitPlanJson(normalized)

  if (jsonValue !== null) {
    return parseTrackingIssueSplitPlanJson(jsonValue)
  }

  return parseTrackingIssueSplitPlanList(normalized)
}

export function createSequentialIssueNumberAllocator(startNumber = 1): () => number {
  if (!Number.isSafeInteger(startNumber) || startNumber <= 0) {
    throw new Error('issue number allocator startNumber must be a positive integer')
  }

  let current = startNumber
  return () => current++
}

export function buildChildIssueDraft(input: {
  parentTitle: string
  parentBody: string
  child: Pick<
    TrackingIssueSplitPlanChild,
    'title' | 'summary' | 'scopeHints' | 'allowedFiles' | 'outOfScope' | 'requiredSemantics'
  >
}): string {
  const blocks = [
    input.child.title.trim(),
    input.child.summary.trim(),
    `Parent tracking issue: ${input.parentTitle}`,
    renderSuggestionBlock('Scope Hints', input.child.scopeHints),
    renderSuggestionBlock('Allowed File Hints', input.child.allowedFiles),
    renderSuggestionBlock('Out Of Scope For This Child', input.child.outOfScope),
    renderSuggestionBlock('Required Semantics For This Child', input.child.requiredSemantics),
    'Inherited parent contract:',
    renderIssueContractForPrompt(input.parentBody) || input.parentBody.trim(),
    '要求：',
    '- 这条 child issue 必须是 code-producing contract，并包含 RED 测试、实现步骤、验收和可执行 Validation 命令。',
    '- 保留 canonical executable contract section order。',
    '- 先保留一个合法的 `### Dependencies` fenced JSON block；最终 `dependsOn` 数组会在 split pipeline 里回填。',
    '- 不要把 sibling 的未来工作偷偷混进当前 child 的 RequiredSemantics 或 AllowedFiles。',
  ]

  return blocks.filter(Boolean).join('\n\n')
}

export function applyIssueDependencies(markdown: string, dependsOn: number[]): string {
  const dependencyBlockPattern = /(###\s+Dependencies\s*\n```json\s*\n)([\s\S]*?)(\n```)/m

  if (!dependencyBlockPattern.test(markdown)) {
    throw new Error('split child is missing a ### Dependencies fenced JSON block')
  }

  return markdown.replace(
    dependencyBlockPattern,
    `$1${JSON.stringify({ dependsOn })}$3`,
  )
}

export function formatTrackingIssueSplitResult(input: {
  parentTitle: string
  parentSummary: string
  children: SplitTrackingIssueChildResult[]
}): string {
  const childBlocks = input.children.flatMap((child) => [
    `## Child Issue #${child.number}: ${child.title}`,
    child.body,
  ])

  return [
    '## Parent Summary',
    `Parent issue: ${input.parentTitle}`,
    input.parentSummary.trim(),
    '### Planned Children',
    input.children
      .map((child, index) => `${index + 1}. #${child.number} ${child.title}`)
      .join('\n'),
    ...childBlocks,
  ].filter(Boolean).join('\n\n')
}

function normalizeSplitPlanText(responseText: string): string {
  const trimmed = responseText.trim()
  const fencedMatch = trimmed.match(/^```(?:json|markdown|md)?\s*\n([\s\S]*?)\n```$/i)
  return (fencedMatch?.[1] ?? trimmed).trim()
}

function tryParseSplitPlanJson(text: string): unknown | null {
  const candidates = [
    text,
    extractOuterJson(text, '{', '}'),
    extractOuterJson(text, '[', ']'),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // fall through to the next candidate
    }
  }

  return null
}

function extractOuterJson(text: string, startToken: '{' | '[', endToken: '}' | ']'): string | null {
  const start = text.indexOf(startToken)
  const end = text.lastIndexOf(endToken)

  if (start === -1 || end === -1 || end <= start) {
    return null
  }

  return text.slice(start, end + 1).trim()
}

function parseTrackingIssueSplitPlanJson(value: unknown): TrackingIssueSplitPlan {
  if (Array.isArray(value)) {
    return {
      parentSummary: '',
      children: normalizeSplitPlanChildren(value),
    }
  }

  if (!value || typeof value !== 'object') {
    throw new Error('split plan JSON must be an object or an array of children')
  }

  const raw = value as Record<string, unknown>
  return {
    parentSummary: typeof raw.parentSummary === 'string'
      ? raw.parentSummary.trim()
      : typeof raw.summary === 'string'
        ? raw.summary.trim()
        : '',
    children: normalizeSplitPlanChildren(raw.children),
  }
}

function parseTrackingIssueSplitPlanList(text: string): TrackingIssueSplitPlan {
  const children = text
    .split('\n')
    .map((line) => line.trim().match(/^(?:\d+[.)]|[-*•])\s+(.+)$/)?.[1]?.trim() ?? '')
    .filter((line) => line.length >= 2)
    .map((title, index) => ({
      id: `child-${index + 1}`,
      title,
      summary: title,
      scopeHints: [],
      allowedFiles: [],
      outOfScope: [],
      requiredSemantics: [],
      dependencyReferences: [],
      hasExplicitDependencies: false,
    }))

  if (children.length === 0) {
    throw new Error('split plan must contain at least one child issue')
  }

  return {
    parentSummary: '',
    children,
  }
}

function normalizeSplitPlanChildren(value: unknown): TrackingIssueSplitPlanChild[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('split plan must include a non-empty children array')
  }

  if (value.length > MAX_CHILD_ISSUES) {
    throw new Error(`split plan cannot contain more than ${MAX_CHILD_ISSUES} child issues`)
  }

  const normalized = value.map((entry, index) => normalizeSplitPlanChild(entry, index))
  const seenTitles = new Set<string>()
  const seenIds = new Set<string>()

  for (const child of normalized) {
    const titleKey = normalizeReferenceKey(child.title)
    const idKey = normalizeReferenceKey(child.id)
    if (seenTitles.has(titleKey)) {
      throw new Error(`split plan contains duplicate child title: ${child.title}`)
    }
    if (seenIds.has(idKey)) {
      throw new Error(`split plan contains duplicate child id: ${child.id}`)
    }
    seenTitles.add(titleKey)
    seenIds.add(idKey)
  }

  return normalized
}

function normalizeSplitPlanChild(value: unknown, index: number): TrackingIssueSplitPlanChild {
  if (!value || typeof value !== 'object') {
    throw new Error(`split child #${index + 1} must be an object`)
  }

  const raw = value as Record<string, unknown>
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''

  if (!title) {
    throw new Error(`split child #${index + 1} is missing a title`)
  }

  return {
    id: typeof raw.id === 'string' && raw.id.trim().length > 0
      ? raw.id.trim()
      : `child-${index + 1}`,
    title,
    summary: typeof raw.summary === 'string'
      ? raw.summary.trim()
      : typeof raw.goal === 'string'
        ? raw.goal.trim()
        : title,
    scopeHints: normalizeStringArray(raw.scopeHints ?? raw.scope),
    allowedFiles: normalizeStringArray(raw.allowedFiles ?? raw.allowedFileHints),
    outOfScope: normalizeStringArray(raw.outOfScope),
    requiredSemantics: normalizeStringArray(raw.requiredSemantics ?? raw.mustPreserve),
    dependencyReferences: normalizeDependencyReferences(raw.dependsOn),
    hasExplicitDependencies: Array.isArray(raw.dependsOn),
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const result: string[] = []
  const seen = new Set<string>()

  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue
    }

    const trimmed = entry.trim()
    if (!trimmed) {
      continue
    }

    const key = normalizeReferenceKey(trimmed)
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    result.push(trimmed)
  }

  return result
}

function normalizeDependencyReferences(value: unknown): DependencyReference[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter((entry): entry is DependencyReference =>
    (typeof entry === 'number' && Number.isSafeInteger(entry) && entry > 0)
    || (typeof entry === 'string' && entry.trim().length > 0),
  )
}

function allocateChildIssueNumbers(
  children: TrackingIssueSplitPlanChild[],
  allocator: () => number,
): AllocatedTrackingIssueSplitPlanChild[] {
  const seen = new Set<number>()

  return children.map((child) => {
    const number = allocator()

    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new Error(`issue number allocator returned an invalid issue number: ${number}`)
    }

    if (seen.has(number)) {
      throw new Error(`issue number allocator returned a duplicate issue number: ${number}`)
    }

    seen.add(number)

    return {
      ...child,
      number,
    }
  })
}

function resolveChildDependencyNumbers(
  children: AllocatedTrackingIssueSplitPlanChild[],
): number[][] {
  return children.map((child, index) => {
    if (!child.hasExplicitDependencies) {
      return children.slice(0, index).map((candidate) => candidate.number)
    }

    const previousChildren = children.slice(0, index)
    const dependencyNumbers = child.dependencyReferences.map((reference) =>
      resolveChildDependencyReference(reference, previousChildren, index),
    )

    return [...new Set(dependencyNumbers)].sort((left, right) => left - right)
  })
}

function resolveChildDependencyReference(
  reference: DependencyReference,
  previousChildren: AllocatedTrackingIssueSplitPlanChild[],
  childIndex: number,
): number {
  if (typeof reference === 'number') {
    const byAllocatedNumber = previousChildren.find((candidate) => candidate.number === reference)
    if (byAllocatedNumber) {
      return byAllocatedNumber.number
    }

    const byOrder = previousChildren[reference - 1]
    if (byOrder) {
      return byOrder.number
    }

    throw new Error(`split child #${childIndex + 1} references unknown dependency number: ${reference}`)
  }

  const normalizedReference = normalizeReferenceKey(reference)
  if (!normalizedReference) {
    throw new Error(`split child #${childIndex + 1} contains an empty dependency reference`)
  }

  if (/^#\d+$/.test(reference.trim())) {
    const issueNumber = Number.parseInt(reference.trim().slice(1), 10)
    const byIssueNumber = previousChildren.find((candidate) => candidate.number === issueNumber)
    if (byIssueNumber) {
      return byIssueNumber.number
    }
  }

  const matchedChild = previousChildren.find((candidate) =>
    normalizeReferenceKey(candidate.id) === normalizedReference
    || normalizeReferenceKey(candidate.title) === normalizedReference,
  )

  if (!matchedChild) {
    throw new Error(`split child #${childIndex + 1} references unknown dependency: ${reference}`)
  }

  return matchedChild.number
}

function normalizeReferenceKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function buildFallbackParentSummary(input: {
  title: string
  children: Array<Pick<SplitTrackingIssueChildResult, 'number' | 'title'>>
}): string {
  const childTitles = input.children.map((child) => `#${child.number} ${child.title}`).join(' -> ')

  if (!childTitles) {
    return `Keep ${input.title} as the tracking parent issue.`
  }

  return `Keep ${input.title} as the tracking parent issue and sequence the execution through ${childTitles}.`
}

function resolveTrackingIssueSource(input: SplitTrackingIssueInput): {
  title: string
  body: string
  issueText: string
} {
  const trimmedIssueText = input.issueText?.trim() ?? ''
  const trimmedTitle = input.title?.trim() ?? ''
  const trimmedBody = input.body?.trim() ?? ''
  const issueText = trimmedIssueText || [trimmedTitle, trimmedBody].filter(Boolean).join('\n\n').trim()

  if (!issueText) {
    throw new Error('splitTrackingIssue requires issueText or a non-empty title/body pair')
  }

  return {
    title: trimmedTitle || '(untitled tracking issue)',
    body: trimmedBody || issueText,
    issueText,
  }
}

function renderSuggestionBlock(title: string, values: string[]): string {
  if (values.length === 0) {
    return `${title}:\n- (none found; keep the split explicit and tightly scoped)`
  }

  return `${title}:\n${values.map((value) => `- ${value}`).join('\n')}`
}

async function defaultBuildAuthoringContext(input: {
  repoRoot: string
  issueText: string
  issueTitle?: string
  issueBody?: string
}): Promise<RepoAuthoringContext> {
  if (!existsSync(input.repoRoot)) {
    return {
      candidateValidationCommands: [],
      candidateAllowedFiles: [],
      candidateForbiddenFiles: [],
    }
  }

  return buildRepoAuthoringContext({
    repoRoot: input.repoRoot,
    issueText: input.issueText,
    issueTitle: input.issueTitle,
    issueBody: input.issueBody,
  })
}

async function defaultRunIssueSplitterAgent(
  input: IssueSplitterAgentRunInput,
): Promise<IssueSplitterAgentRunResult> {
  if (!input.config) {
    throw new Error('splitTrackingIssue requires config when no custom runAgent is provided')
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
    throw new Error(`issue split agent failed: ${detail}`)
  }

  return {
    responseText: result.responseText,
  }
}

function renderDeterministicChildIssue(input: {
  parentTitle: string
  parentContract: ReturnType<typeof parseIssueContract>
  authoringContext: RepoAuthoringContext
  child: AllocatedTrackingIssueSplitPlanChild
  siblingTitles: string[]
  dependsOn: number[]
}): string {
  const allowedFiles = uniqueStrings([
    ...input.child.allowedFiles.filter(isConcretePathHint),
    ...input.authoringContext.candidateAllowedFiles.filter(isConcretePathHint),
    ...input.parentContract.allowedFiles.filter(isConcretePathHint),
  ]).slice(0, 8)

  if (allowedFiles.length === 0) {
    throw new Error(`split child ${input.child.title} is missing concrete AllowedFiles hints`)
  }

  const forbiddenFiles = uniqueStrings([
    ...input.parentContract.forbiddenFiles.filter(isConcretePathHint),
    ...input.authoringContext.candidateForbiddenFiles.filter(isConcretePathHint),
  ]).slice(0, 8)
  const constraints = uniqueStrings([
    ...input.parentContract.constraints,
    ...input.child.scopeHints,
    `只实现 ${input.child.title} 这条 child issue 对应的代码路径`,
  ]).slice(0, 8)
  const mustPreserve = uniqueStrings([
    'parent issue 仍然是 tracking-only，不进入 `agent:ready`',
    ...input.parentContract.mustPreserve,
  ]).slice(0, 8)
  const outOfScope = uniqueStrings([
    ...input.child.outOfScope,
    ...input.siblingTitles
      .filter((title) => title !== input.child.title)
      .map((title) => `不在本 child 内完成 ${title}`),
    ...input.parentContract.outOfScope,
  ]).slice(0, 8)
  const requiredSemantics = uniqueStrings([
    ...input.child.requiredSemantics,
    `产出 ${input.child.title} 对应的代码实现与测试`,
    ...input.child.scopeHints,
  ]).slice(0, 8)
  const reviewHints = uniqueStrings([
    '优先检查 AllowedFiles 与 OutOfScope 是否仍然足够具体',
    '优先检查 dependsOn 是否只引用更早 child issues',
    ...input.parentContract.reviewHints,
  ]).slice(0, 8)
  const validationCommands = selectValidationCommands(
    input.parentContract.validation,
    input.authoringContext.candidateValidationCommands,
  )
  const userStoryGoal = input.child.summary.trim() || input.child.title.trim()
  const redTestTitle = input.child.title.replace(/`/g, '').replace(/'/g, "\\'")

  return [
    '## 用户故事',
    '',
    `作为 \`agent-loop\` 维护者，我希望 ${userStoryGoal}，从而把 ${input.parentTitle} 拆成可执行的 child issue。`,
    '',
    '## Context',
    '',
    '### Dependencies',
    '```json',
    JSON.stringify({ dependsOn: input.dependsOn }),
    '```',
    '',
    renderBulletSection('### Constraints', constraints),
    '',
    renderBulletSection('### AllowedFiles', allowedFiles),
    '',
    renderBulletSection('### ForbiddenFiles', forbiddenFiles),
    '',
    renderBulletSection('### MustPreserve', mustPreserve),
    '',
    renderBulletSection('### OutOfScope', outOfScope),
    '',
    renderBulletSection('### RequiredSemantics', requiredSemantics),
    '',
    renderBulletSection('### ReviewHints', reviewHints),
    '',
    renderBulletSection('### Validation', validationCommands),
    '',
    '## RED 测试',
    '',
    '```ts',
    `describe('${redTestTitle}', () => {`,
    `  test('RED: ${userStoryGoal.replace(/'/g, "\\'")}', () => {`,
    `    throw new Error('RED: implement ${userStoryGoal.replace(/'/g, "\\'")}')`,
    '  })',
    '})',
    '```',
    '',
    renderNumberedSection('## 实现步骤', [
      `先为 ${input.child.title} 补失败测试或 contract 校验`,
      '再补最小实现，并把变更限制在 AllowedFiles 内',
      '最后运行 Validation，并确认 dependsOn / OutOfScope 没有回归',
    ]),
    '',
    renderCheckboxSection('## 验收', [
      '只修改 AllowedFiles 内文件',
      'dependsOn 数组与执行顺序一致',
      'Validation 中命令执行通过',
    ]),
  ].join('\n')
}

function renderBulletSection(title: string, items: string[]): string {
  if (items.length === 0) {
    return `${title}\n`
  }

  return `${title}\n${items.map((item) => `- ${item}`).join('\n')}`
}

function renderNumberedSection(title: string, items: string[]): string {
  return `${title}\n${items.map((item, index) => `${index + 1}. ${item}`).join('\n')}`
}

function renderCheckboxSection(title: string, items: string[]): string {
  return `${title}\n${items.map((item) => `- [ ] ${item}`).join('\n')}`
}

function uniqueStrings(values: string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()

  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed) {
      continue
    }

    const key = normalizeReferenceKey(trimmed)
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    result.push(trimmed)
  }

  return result
}

function isConcretePathHint(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) {
    return false
  }

  const segments = trimmed.split('/').filter(Boolean)
  return segments.length >= 2
}

function selectValidationCommands(
  parentValidation: string[],
  candidateValidationCommands: string[],
): string[] {
  const normalized = uniqueStrings([
    ...parentValidation.map(stripWrappingBackticks),
    ...candidateValidationCommands.map(stripWrappingBackticks),
  ])
  const commands = [...normalized]
  const hasExecutableTestCommand = commands.some((command) =>
    /\b(test|tests|check|build|lint|verify|typecheck|coverage)\b/i.test(command),
  )

  if (!hasExecutableTestCommand) {
    commands.unshift('bun test')
  }

  if (!commands.some((command) => command === 'git diff --stat origin/main...HEAD')) {
    commands.push('git diff --stat origin/main...HEAD')
  }

  return uniqueStrings(commands).map((command) => `\`${command}\``)
}

function stripWrappingBackticks(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('`') && trimmed.endsWith('`')) {
    return trimmed.slice(1, -1).trim()
  }

  return trimmed
}
