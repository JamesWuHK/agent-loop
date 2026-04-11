import { readdir, readFile } from 'node:fs/promises'
import { dirname, posix, relative, resolve } from 'node:path'
import {
  BuildRepoAuthoringContextInput,
  RepoAuthoringContext,
  getProjectIssueAuthoringRules,
  type ProjectProfileConfig,
} from '../../../packages/agent-shared/src'

interface PackageScriptRecord {
  packageDir: string
  scriptName: string
  command: string
}

interface FileScore {
  path: string
  score: number
}

const SKIPPED_DIRECTORIES = new Set<string>([
  '.agent-loop',
  '.git',
  '.runtime',
  'build',
  'coverage',
  'dist',
  'node_modules',
])

const VALIDATION_SCRIPT_NAME_PATTERN = /(?:^|:)(test|typecheck|lint|check|verify|validate|build)$/i
const TEST_INTENT_PATTERN = /\b(test|tests|spec|jest|vitest|coverage|e2e)\b|测试|用例/i
const CONFIG_INTENT_PATTERN = /\b(config|tsconfig|package|dependency|dependencies|deps|lockfile|workspace|script|build|ci)\b|配置|依赖|脚本|构建/i
const ROOT_FORBIDDEN_FILE_PATTERNS = [
  /^package\.json$/,
  /^bun\.lockb?$/,
  /^package-lock\.json$/,
  /^pnpm-lock\.yaml$/,
  /^yarn\.lock$/,
  /^tsconfig(?:\..+)?\.json$/,
] as const

export async function buildRepoAuthoringContext(
  input: BuildRepoAuthoringContextInput,
): Promise<RepoAuthoringContext> {
  const repoRoot = resolve(input.repoRoot)
  const repoFiles = input.repoRelativeFilePaths
    ? [...input.repoRelativeFilePaths].sort((left, right) => left.localeCompare(right))
    : await listRepoFiles(repoRoot)
  const project = await resolveProjectProfileConfig(repoRoot, input.project)
  const projectIssueRules = getProjectIssueAuthoringRules(project)
  const issueTokens = tokenize(input.issueText)
  const scannedAllowedFiles = collectCandidateAllowedFiles({
    issueText: input.issueText,
    issueTokens,
    repoFiles,
    limit: input.maxAllowedFiles ?? 8,
  })
  const candidateAllowedFiles = uniqueStrings([
    ...projectIssueRules.preferredAllowedFiles,
    ...scannedAllowedFiles,
  ]).slice(0, input.maxAllowedFiles ?? 8)
  const scannedValidationCommands = await collectCandidateValidationCommands({
    repoRoot,
    repoFiles,
    issueTokens,
    candidateAllowedFiles,
    limit: input.maxValidationCommands ?? 8,
  })
  const candidateValidationCommands = uniqueStrings([
    ...projectIssueRules.preferredValidationCommands,
    ...scannedValidationCommands,
  ]).slice(0, input.maxValidationCommands ?? 8)
  const scannedForbiddenFiles = collectCandidateForbiddenFiles({
    issueText: input.issueText,
    repoFiles,
    candidateAllowedFiles,
    limit: input.maxForbiddenFiles ?? 5,
  })
  const candidateForbiddenFiles = uniqueStrings([
    ...projectIssueRules.forbiddenPaths,
    ...scannedForbiddenFiles,
  ]).slice(0, input.maxForbiddenFiles ?? 5)

  return {
    candidateValidationCommands,
    candidateAllowedFiles,
    candidateForbiddenFiles,
    candidateReviewHints: [...projectIssueRules.reviewHints],
    projectIssueRules,
  }
}

async function resolveProjectProfileConfig(
  repoRoot: string,
  explicitProject: ProjectProfileConfig | undefined,
): Promise<ProjectProfileConfig | undefined> {
  if (explicitProject) {
    return explicitProject
  }

  const repoConfig = await readJsonFile(resolve(repoRoot, '.agent-loop', 'project.json'))
  const project = (repoConfig as { project?: ProjectProfileConfig } | null)?.project

  return project && typeof project === 'object'
    ? project
    : undefined
}

async function collectCandidateValidationCommands(input: {
  repoRoot: string
  repoFiles: string[]
  issueTokens: string[]
  candidateAllowedFiles: string[]
  limit: number
}): Promise<string[]> {
  const packageScriptRecords = await listPackageScriptRecords(input.repoRoot, input.repoFiles)
  const allowedPackages = new Set(
    packageScriptRecords
      .map((record) => record.packageDir)
      .filter((packageDir) => (
        input.candidateAllowedFiles.some((file) => isFileInsidePackage(file, packageDir))
      )),
  )
  const allowedFileSet = new Set(input.candidateAllowedFiles)

  const scored = packageScriptRecords.map((record) => ({
    command: record.command,
    score: scoreValidationCommand({
      ...record,
      issueTokens: input.issueTokens,
      candidateAllowedFiles: allowedFileSet,
      isRelevantPackage: allowedPackages.has(record.packageDir),
    }),
  }))

  const deduped = new Map<string, number>()
  for (const record of scored) {
    const previous = deduped.get(record.command)
    if (previous === undefined || record.score > previous) {
      deduped.set(record.command, record.score)
    }
  }

  const preferred = [...deduped.entries()]
    .filter(([, score]) => score > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([command]) => command)

  if (preferred.length >= input.limit) {
    return preferred.slice(0, input.limit)
  }

  const fallback = [...deduped.keys()]
    .filter(command => !preferred.includes(command))
    .sort((left, right) => left.localeCompare(right))

  return [...preferred, ...fallback].slice(0, input.limit)
}

async function listPackageScriptRecords(
  repoRoot: string,
  repoFiles: string[],
): Promise<PackageScriptRecord[]> {
  const records: PackageScriptRecord[] = []

  for (const file of repoFiles) {
    if (!file.endsWith('/package.json') && file !== 'package.json') {
      continue
    }

    const packageJsonPath = resolve(repoRoot, file)
    const manifest = await readJsonFile(packageJsonPath)
    if (!manifest || typeof manifest !== 'object') {
      continue
    }

    const scripts = readStringMap((manifest as { scripts?: unknown }).scripts)
    const packageDir = dirname(file)

    for (const [scriptName, command] of Object.entries(scripts)) {
      if (!isValidationScript(scriptName, command)) {
        continue
      }

      records.push({
        packageDir: packageDir === '.' ? '' : packageDir,
        scriptName,
        command: rewriteWorkspaceCommandPaths(command, {
          repoRoot,
          packageDir: packageDir === '.' ? '' : packageDir,
          repoFiles,
        }),
      })
    }
  }

  return records.sort((left, right) => (
    left.packageDir.localeCompare(right.packageDir)
    || left.scriptName.localeCompare(right.scriptName)
    || left.command.localeCompare(right.command)
  ))
}

function collectCandidateAllowedFiles(input: {
  issueText: string
  issueTokens: string[]
  repoFiles: string[]
  limit: number
}): string[] {
  const hasTestIntent = TEST_INTENT_PATTERN.test(input.issueText)
  const scored = input.repoFiles
    .map((file) => ({
      path: file,
      score: scoreCandidateFile(file, input.issueText, input.issueTokens, hasTestIntent),
    }))
    .filter((record) => record.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))

  const selected = new Map<string, FileScore>()
  for (const record of scored) {
    if (selected.size >= input.limit) break
    selected.set(record.path, record)
  }

  if (hasTestIntent) {
    for (const companion of collectCompanionTestFiles([...selected.keys()], input.repoFiles)) {
      if (selected.size >= input.limit) break
      selected.set(companion.path, companion)
    }
  }

  return [...selected.values()]
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .map(record => record.path)
}

function collectCandidateForbiddenFiles(input: {
  issueText: string
  repoFiles: string[]
  candidateAllowedFiles: string[]
  limit: number
}): string[] {
  if (CONFIG_INTENT_PATTERN.test(input.issueText)) {
    return []
  }

  const allowed = new Set(input.candidateAllowedFiles)

  return input.repoFiles
    .filter((file) => !file.includes('/'))
    .filter((file) => ROOT_FORBIDDEN_FILE_PATTERNS.some(pattern => pattern.test(file)))
    .filter(file => !allowed.has(file))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, input.limit)
}

function scoreValidationCommand(input: PackageScriptRecord & {
  issueTokens: string[]
  candidateAllowedFiles: Set<string>
  isRelevantPackage: boolean
}): number {
  const commandTokens = tokenize(`${input.scriptName} ${input.command}`)
  const overlapScore = countTokenOverlap(input.issueTokens, commandTokens)
  const allowedFileMentionScore = [...input.candidateAllowedFiles]
    .some(file => input.command.includes(file))
    ? 4
    : 0
  const packageScore = input.isRelevantPackage ? 3 : input.packageDir === '' ? 1 : 0

  return allowedFileMentionScore + packageScore + overlapScore
}

function scoreCandidateFile(
  file: string,
  issueText: string,
  issueTokens: string[],
  hasTestIntent: boolean,
): number {
  const fileTokens = tokenize(file)
  const overlap = countTokenOverlap(issueTokens, fileTokens)
  const basename = posix.basename(file)
  const comparableStem = compactToken(stripKnownFileSuffixes(basename))
  const exactStemMention = comparableStem.length > 0 && compactToken(issueText).includes(comparableStem)
    ? 4
    : 0
  const testBonus = hasTestIntent && isTestFile(file) ? 1 : 0
  const packagePenalty = basename === 'package.json' ? 1 : 0

  return (overlap * 2) + exactStemMention + testBonus - packagePenalty
}

function collectCompanionTestFiles(
  selectedFiles: string[],
  repoFiles: string[],
): FileScore[] {
  const selected = new Set(selectedFiles)
  const companions: FileScore[] = []

  for (const file of selectedFiles) {
    const parent = posix.dirname(file)
    const stem = stripKnownFileSuffixes(posix.basename(file))

    for (const candidate of repoFiles) {
      if (selected.has(candidate) || !isTestFile(candidate)) continue
      if (posix.dirname(candidate) !== parent) continue
      if (stripKnownFileSuffixes(posix.basename(candidate)) !== stem) continue

      companions.push({
        path: candidate,
        score: 1,
      })
    }
  }

  return companions.sort((left, right) => left.path.localeCompare(right.path))
}

function rewriteWorkspaceCommandPaths(
  command: string,
  input: {
    repoRoot: string
    packageDir: string
    repoFiles: string[]
  },
): string {
  if (!input.packageDir) {
    return command
  }

  const repoPathSet = new Set(input.repoFiles)
  const tokens = command.match(/"[^"]*"|'[^']*'|`[^`]*`|[^\s]+/g) ?? []

  return tokens
    .map((token) => rewriteCommandToken(token, input.repoRoot, input.packageDir, repoPathSet))
    .join(' ')
}

function rewriteCommandToken(
  token: string,
  repoRoot: string,
  packageDir: string,
  repoPathSet: ReadonlySet<string>,
): string {
  const quote = token[0]
  const isQuoted = quote === '"' || quote === '\'' || quote === '`'
  const rawValue = isQuoted ? token.slice(1, -1) : token

  if (!looksLikeRelativePathToken(rawValue)) {
    return token
  }

  const absolute = resolve(repoRoot, packageDir, rawValue)
  const repoRelative = toRepoRelative(repoRoot, absolute)
  if (!repoRelative) {
    return token
  }

  if (!repoContainsPath(repoRelative, repoPathSet)) {
    return token
  }

  return isQuoted ? `${quote}${repoRelative}${quote}` : repoRelative
}

function looksLikeRelativePathToken(value: string): boolean {
  if (!value) return false
  if (value.startsWith('-')) return false
  if (value.startsWith('$')) return false
  if (value.includes('://')) return false
  if (value.startsWith('/')) return false
  if (value.includes('=')) return false

  return value.includes('/') || value.startsWith('./') || value.startsWith('../')
}

function repoContainsPath(
  repoRelative: string,
  repoPathSet: ReadonlySet<string>,
): boolean {
  if (repoPathSet.has(repoRelative)) {
    return true
  }

  return [...repoPathSet].some((path) => path.startsWith(`${repoRelative}/`))
}

function isValidationScript(scriptName: string, command: string): boolean {
  return VALIDATION_SCRIPT_NAME_PATTERN.test(scriptName) || VALIDATION_SCRIPT_NAME_PATTERN.test(command)
}

function isFileInsidePackage(
  file: string,
  packageDir: string,
): boolean {
  if (!packageDir) {
    return !file.includes('/')
  }

  return file === packageDir || file.startsWith(`${packageDir}/`)
}

function countTokenOverlap(left: string[], right: string[]): number {
  const rightSet = new Set(right)
  return left.filter(token => rightSet.has(token)).length
}

function tokenize(value: string): string[] {
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .toLowerCase()

  return [...new Set(
    spaced
      .split(/\s+/)
      .map(token => token.trim())
      .filter(token => token.length >= 2),
  )]
}

function compactToken(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

function stripKnownFileSuffixes(value: string): string {
  return value
    .replace(/\.(test|spec)(?=\.[^.]+$)/i, '')
    .replace(/\.[^.]+$/, '')
}

function isTestFile(file: string): boolean {
  return /\.(test|spec)\.[^.]+$/i.test(file)
}

async function listRepoFiles(repoRoot: string): Promise<string[]> {
  const files: string[] = []

  await walkDirectory(repoRoot, '', files)

  return files.sort((left, right) => left.localeCompare(right))
}

async function walkDirectory(
  root: string,
  relativeDir: string,
  files: string[],
): Promise<void> {
  const directoryPath = relativeDir ? resolve(root, relativeDir) : root
  const entries = await readdir(directoryPath, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue
    }

    const nextRelative = relativeDir
      ? posix.join(relativeDir, entry.name)
      : entry.name

    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) {
        continue
      }

      await walkDirectory(root, nextRelative, files)
      continue
    }

    if (entry.isFile()) {
      files.push(nextRelative)
    }
  }
}

function toRepoRelative(
  repoRoot: string,
  absolutePath: string,
): string | null {
  const relativePath = relative(repoRoot, absolutePath)
  if (!relativePath || relativePath.startsWith('..')) {
    return null
  }

  return relativePath.split('\\').join('/')
}

function readStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .sort((left, right) => left[0].localeCompare(right[0])),
  )
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

async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}
