import { parseIssueDependencyMetadata } from './state-machine'

export interface IssueContract {
  userStory: string
  dependencies: number[]
  hasDependencyMetadata: boolean
  dependencyParseError: boolean
  constraints: string[]
  allowedFiles: string[]
  forbiddenFiles: string[]
  mustPreserve: string[]
  outOfScope: string[]
  requiredSemantics: string[]
  reviewHints: string[]
  validation: string[]
  acceptance: string[]
  implementationSteps: string[]
  redTest: string
}

function normalizeHeading(text: string): string {
  return text.trim().toLowerCase()
}

function extractSectionByLevel(body: string, level: 2 | 3, headings: string[]): string {
  const lines = body.split('\n')
  const normalizedHeadings = new Set(headings.map(normalizeHeading))
  const headingPattern = new RegExp(`^${'#'.repeat(level)}\\s+(.+?)\\s*$`)
  const stopPattern = level === 2
    ? /^##\s+/
    : /^(?:##|###)\s+/

  let start = -1
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index]?.match(headingPattern)
    if (match && normalizedHeadings.has(normalizeHeading(match[1] ?? ''))) {
      start = index + 1
      break
    }
  }

  if (start === -1) return ''

  let end = lines.length
  for (let index = start; index < lines.length; index++) {
    if (stopPattern.test(lines[index] ?? '')) {
      end = index
      break
    }
  }

  return lines.slice(start, end).join('\n').trim()
}

function extractTopLevelSection(body: string, headings: string[]): string {
  return extractSectionByLevel(body, 2, headings)
}

function extractSubsection(body: string, headings: string[]): string {
  return extractSectionByLevel(body, 3, headings)
}

function parseList(section: string): string[] {
  if (!section.trim()) return []

  const items = section
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !line.startsWith('```'))
    .map((line) => {
      const bullet = line.match(/^[-*]\s+(.+)$/)
      if (bullet) return bullet[1]!.trim()

      const numbered = line.match(/^\d+[.)]\s+(.+)$/)
      if (numbered) return numbered[1]!.trim()

      return line
    })
    .filter(Boolean)

  return [...new Set(items)]
}

function compactMultiline(section: string): string {
  return section
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
}

export function parseIssueContract(body: string): IssueContract {
  const normalizedBody = body || ''
  const contextSection = extractTopLevelSection(normalizedBody, ['Context', '上下文'])
  const subsectionSource = contextSection || normalizedBody
  const dependencyMetadata = parseIssueDependencyMetadata(normalizedBody)

  return {
    userStory: compactMultiline(extractTopLevelSection(normalizedBody, ['用户故事', 'User Story'])),
    dependencies: dependencyMetadata.dependsOn,
    hasDependencyMetadata: dependencyMetadata.hasDependencyMetadata,
    dependencyParseError: dependencyMetadata.dependencyParseError,
    constraints: parseList(extractSubsection(subsectionSource, ['Constraints', '约束'])),
    allowedFiles: parseList(extractSubsection(subsectionSource, ['AllowedFiles', 'Allowed Files', '允许修改文件'])),
    forbiddenFiles: parseList(extractSubsection(subsectionSource, ['ForbiddenFiles', 'Forbidden Files', '禁止修改文件'])),
    mustPreserve: parseList(extractSubsection(subsectionSource, ['MustPreserve', 'Must Preserve', '必须保持'])),
    outOfScope: parseList(extractSubsection(subsectionSource, ['OutOfScope', 'Out Of Scope', '范围外'])),
    requiredSemantics: parseList(extractSubsection(subsectionSource, ['RequiredSemantics', 'Required Semantics', '必保语义'])),
    reviewHints: parseList(extractSubsection(subsectionSource, ['ReviewHints', 'Review Hints', '审查提示'])),
    validation: parseList(extractSubsection(subsectionSource, ['Validation', 'ValidationCommands', '验证命令'])),
    acceptance: parseList(extractTopLevelSection(normalizedBody, ['验收', 'Acceptance'])),
    implementationSteps: parseList(extractTopLevelSection(normalizedBody, ['实现步骤', 'Implementation Steps'])),
    redTest: extractTopLevelSection(normalizedBody, ['RED 测试', 'RED Tests']).trim(),
  }
}

export function summarizeIssueContract(contract: IssueContract): Record<string, unknown> {
  return {
    dependencies: contract.dependencies,
    constraints: contract.constraints,
    allowedFiles: contract.allowedFiles,
    forbiddenFiles: contract.forbiddenFiles,
    mustPreserve: contract.mustPreserve,
    outOfScope: contract.outOfScope,
    requiredSemantics: contract.requiredSemantics,
    reviewHints: contract.reviewHints,
    validation: contract.validation,
    acceptance: contract.acceptance,
    implementationSteps: contract.implementationSteps,
    hasRedTest: contract.redTest.length > 0,
    dependencyParseError: contract.dependencyParseError,
  }
}

function renderList(title: string, items: string[]): string {
  if (items.length === 0) return ''
  return `${title}:\n${items.map(item => `- ${item}`).join('\n')}`
}

export function renderIssueContractForPrompt(body: string): string {
  const contract = parseIssueContract(body)
  const blocks = [
    'Parsed issue contract (authoritative when present):',
    '```json',
    JSON.stringify(summarizeIssueContract(contract), null, 2),
    '```',
    renderList('Constraints', contract.constraints),
    renderList('Allowed files', contract.allowedFiles),
    renderList('Forbidden files', contract.forbiddenFiles),
    renderList('Must preserve', contract.mustPreserve),
    renderList('Out of scope', contract.outOfScope),
    renderList('Required semantics', contract.requiredSemantics),
    renderList('Review hints', contract.reviewHints),
    renderList('Validation', contract.validation),
    renderList('Acceptance', contract.acceptance),
  ].filter(Boolean)

  if (contract.redTest) {
    blocks.push('RED tests are present in the issue body. Treat them as part of the contract.')
  }

  if (contract.dependencyParseError) {
    blocks.push('Dependency metadata is malformed. Do not guess hidden dependencies from the broken JSON block.')
  }

  return blocks.join('\n\n')
}
