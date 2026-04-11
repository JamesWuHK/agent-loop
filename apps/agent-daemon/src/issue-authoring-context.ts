import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import type { BuildRepoAuthoringContextInput, RepoAuthoringContext } from '@agent/shared'

interface PackageManifestRecord {
  scripts?: Record<string, unknown>
  workspaces?: string[] | { packages?: string[] }
}

interface PackageManifest {
  dir: string
  scripts: Record<string, string>
}

interface ScoredFileCandidate {
  path: string
  score: number
}

const IGNORED_DIRECTORY_NAMES = new Set([
  '.agent-loop',
  '.cache',
  '.git',
  '.next',
  '.runtime',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
])

const VALIDATION_SCRIPT_PATTERN = /\b(test|tests|check|lint|typecheck|build|verify|coverage)\b/i
const TEST_INTENT_PATTERN = /\b(test|tests|spec|specs|coverage|verify|validation)\b|测试|用例|验证|回归/i
const SOURCE_FILE_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|java|kt|swift|rb|php|cs|sh|yaml|yml)$/i
const BROAD_SCOPE_FILE_PATTERNS = [
  /(?:^|\/)App\.[^/]+$/i,
  /(?:^|\/)main\.[^/]+$/i,
  /(?:^|\/)index\.[^/]+$/i,
  /(?:^|\/)router\.[^/]+$/i,
  /(?:^|\/)layout\.[^/]+$/i,
  /(?:^|\/)api\.[^/]+$/i,
  /(?:^|\/)daemon\.[^/]+$/i,
] as const

const MAX_ALLOWED_FILE_CANDIDATES = 8
const MAX_FORBIDDEN_FILE_CANDIDATES = 8

export async function buildRepoAuthoringContext(
  input: BuildRepoAuthoringContextInput,
): Promise<RepoAuthoringContext> {
  const repoRoot = resolve(input.repoRoot)
  const packageManifests = collectPackageManifests(
    repoRoot,
    input.rootPackageJsonPath,
    input.workspacePackageJsonPaths,
  )
  const repoFiles = input.repoRelativeFilePaths
    ? sanitizeRepoRelativeFilePaths(repoRoot, input.repoRelativeFilePaths)
    : collectRepoFiles(repoRoot)
  const candidateAllowedFiles = collectCandidateAllowedFiles(resolveIssueText(input), repoFiles)

  return {
    candidateValidationCommands: collectCandidateValidationCommands(repoRoot, packageManifests),
    candidateAllowedFiles,
    candidateForbiddenFiles: collectCandidateForbiddenFiles(
      repoFiles,
      candidateAllowedFiles,
      packageManifests.map((manifest) => manifest.dir),
    ),
  }
}

function collectCandidateValidationCommands(
  repoRoot: string,
  manifests: PackageManifest[],
): string[] {
  const commands = new Set<string>()

  for (const manifest of manifests) {
    for (const [scriptName, scriptCommand] of Object.entries(manifest.scripts).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (!looksLikeValidationScript(scriptName, scriptCommand)) {
        continue
      }

      const normalized = normalizeValidationCommand(repoRoot, manifest.dir, scriptCommand)
      if (normalized) {
        commands.add(normalized)
      }
    }
  }

  return [...commands].sort((left, right) => left.localeCompare(right))
}

function looksLikeValidationScript(name: string, command: string): boolean {
  return VALIDATION_SCRIPT_PATTERN.test(name) || VALIDATION_SCRIPT_PATTERN.test(command)
}

function normalizeValidationCommand(
  repoRoot: string,
  packageDir: string,
  command: string,
): string | null {
  const tokens = tokenizeCommand(command)
  if (tokens.length === 0) {
    return null
  }

  let commandCwd = resolve(repoRoot, packageDir)
  const normalizedTokens: string[] = []

  for (let index = 0; index < tokens.length; index += 1) {
    const token = stripWrappingQuotes(tokens[index] ?? '')
    if (!token) {
      continue
    }

    if ((token === '--cwd' || token === '-C' || token === 'cd') && tokens[index + 1]) {
      const cwdToken = stripWrappingQuotes(tokens[index + 1] ?? '')
      const resolvedCwd = resolveCommandPath(repoRoot, commandCwd, cwdToken)
      if (!resolvedCwd) {
        return null
      }

      commandCwd = resolvedCwd
      normalizedTokens.push(token)
      normalizedTokens.push(toRepoRelativePath(repoRoot, resolvedCwd) || '.')
      index += 1
      continue
    }

    if (looksLikePathToken(token)) {
      const resolvedPath = resolveCommandPath(repoRoot, commandCwd, token)
      if (!resolvedPath) {
        return null
      }

      normalizedTokens.push(toRepoRelativePath(repoRoot, resolvedPath) || '.')
      continue
    }

    normalizedTokens.push(token)
  }

  return normalizedTokens.join(' ')
}

function tokenizeCommand(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
}

function stripWrappingQuotes(token: string): string {
  return token.replace(/^['"]|['"]$/g, '')
}

function looksLikePathToken(token: string): boolean {
  if (!token || token.startsWith('-')) {
    return false
  }

  if (token.includes('...')) {
    return false
  }

  if (token === '.' || token === '..') {
    return true
  }

  if (/^[A-Z_][A-Z0-9_]*=/.test(token)) {
    return false
  }

  if (/^[A-Za-z0-9_.-]+$/.test(token) && !token.includes('.') && !token.includes('/')) {
    return false
  }

  return token.includes('/') || token.includes('\\') || /\.[A-Za-z0-9]+$/.test(token)
}

function resolveCommandPath(
  repoRoot: string,
  commandCwd: string,
  token: string,
): string | null {
  const absolutePath = token.startsWith('/')
    ? resolve(token)
    : resolve(commandCwd, token.replace(/\\/g, '/'))

  if (!isPathInsideRepo(repoRoot, absolutePath)) {
    return null
  }

  return absolutePath
}

function collectCandidateAllowedFiles(
  issueText: string,
  repoFiles: string[],
): string[] {
  const keywords = extractIssueKeywords(issueText)
  if (keywords.length === 0) {
    return []
  }

  const wantsTests = TEST_INTENT_PATTERN.test(issueText)
  const rankedFiles = repoFiles
    .map((path) => ({
      path,
      score: scoreRepoFile(path, keywords, wantsTests),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(compareScoredCandidates)

  const orderedCandidates: string[] = []
  const seen = new Set<string>()

  for (const candidate of rankedFiles) {
    pushUniquePath(orderedCandidates, seen, candidate.path)
    for (const related of collectRelatedAllowedFiles(candidate.path, repoFiles, wantsTests)) {
      pushUniquePath(orderedCandidates, seen, related)
    }

    if (orderedCandidates.length >= MAX_ALLOWED_FILE_CANDIDATES) {
      break
    }
  }

  return orderedCandidates.slice(0, MAX_ALLOWED_FILE_CANDIDATES)
}

function compareScoredCandidates(left: ScoredFileCandidate, right: ScoredFileCandidate): number {
  if (right.score !== left.score) {
    return right.score - left.score
  }

  if (isTestFile(left.path) !== isTestFile(right.path)) {
    return isTestFile(left.path) ? 1 : -1
  }

  return left.path.localeCompare(right.path)
}

function scoreRepoFile(
  path: string,
  keywords: string[],
  wantsTests: boolean,
): number {
  const normalizedPath = path.toLowerCase()
  const fileName = basename(normalizedPath)
  const fileStem = normalizeFileStem(normalizedPath)
  let score = 0

  for (const keyword of keywords) {
    if (fileStem === keyword) {
      score += 24
      continue
    }

    if (fileName.startsWith(`${keyword}.`) || fileName.includes(`${keyword}.`)) {
      score += 18
      continue
    }

    if (keyword.length >= 5 && fileName.includes(keyword)) {
      score += 12
    } else if (normalizedPath.includes(`/${keyword}/`)) {
      score += 8
    } else if (keyword.length >= 5 && normalizedPath.includes(keyword)) {
      score += 6
    }
  }

  if (score > 0 && SOURCE_FILE_PATTERN.test(path)) {
    score += 1
  }

  if (isTestFile(path)) {
    score -= 1
    if (wantsTests) {
      score += 1
    }
  }

  return score
}

function collectRelatedAllowedFiles(
  path: string,
  repoFiles: string[],
  wantsTests: boolean,
): string[] {
  const targetDirectory = dirname(path)
  const targetStem = normalizeFileStem(path)

  return repoFiles
    .filter((candidate) => candidate !== path)
    .filter((candidate) => dirname(candidate) === targetDirectory)
    .filter((candidate) => normalizeFileStem(candidate) === targetStem)
    .filter((candidate) => wantsTests || !isTestFile(candidate))
    .sort((left, right) => {
      if (isTestFile(left) !== isTestFile(right)) {
        return isTestFile(left) ? 1 : -1
      }

      return left.localeCompare(right)
    })
}

function normalizeFileStem(path: string): string {
  return basename(path, extname(path)).replace(/\.(test|spec)$/i, '')
}

function isTestFile(path: string): boolean {
  return /\.(test|spec)\.[^.]+$/i.test(path)
}

function extractIssueKeywords(issueText: string): string[] {
  const keywords = new Set<string>()

  for (const match of issueText.matchAll(/[A-Za-z][A-Za-z0-9._-]{1,}/g)) {
    addKeywordTerms(keywords, match[0])
  }

  for (const match of issueText.matchAll(/[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/g)) {
    addKeywordTerms(keywords, match[0])
  }

  return [...keywords]
    .filter((value) => value.length >= 2)
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
}

function addKeywordTerms(keywords: Set<string>, rawValue: string): void {
  const normalized = rawValue.trim().replace(/^['"`]+|['"`]+$/g, '')
  if (!normalized) {
    return
  }

  const lowered = normalized.toLowerCase()
  keywords.add(lowered)

  const withoutExtension = lowered.replace(/\.[a-z0-9]+$/i, '')
  if (withoutExtension !== lowered) {
    keywords.add(withoutExtension)
  }

  const identifierParts = normalized
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length >= 2)

  for (const part of identifierParts) {
    keywords.add(part)
  }
}

function collectCandidateForbiddenFiles(
  repoFiles: string[],
  allowedFiles: string[],
  packageDirs: string[],
): string[] {
  if (allowedFiles.length === 0) {
    return []
  }

  const relevantPackageDirs = resolveRelevantPackageDirs(allowedFiles, packageDirs)
  const allowedSet = new Set(allowedFiles)

  return repoFiles
    .filter((path) => !allowedSet.has(path))
    .filter((path) => relevantPackageDirs.some((packageDir) =>
      packageDir === '.' || path.startsWith(`${packageDir}/`),
    ))
    .filter((path) => BROAD_SCOPE_FILE_PATTERNS.some((pattern) => pattern.test(path)))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MAX_FORBIDDEN_FILE_CANDIDATES)
}

function resolveRelevantPackageDirs(
  allowedFiles: string[],
  packageDirs: string[],
): string[] {
  const sortedPackageDirs = [...packageDirs].sort((left, right) => right.length - left.length)
  const relevant = new Set<string>()

  for (const allowedFile of allowedFiles) {
    const matchedPackage = sortedPackageDirs.find((packageDir) =>
      packageDir === '.' || allowedFile.startsWith(`${packageDir}/`),
    )

    if (matchedPackage) {
      relevant.add(matchedPackage)
    }
  }

  return [...relevant].sort((left, right) => left.localeCompare(right))
}

function pushUniquePath(target: string[], seen: Set<string>, path: string): void {
  if (seen.has(path)) {
    return
  }

  seen.add(path)
  target.push(path)
}

function resolveIssueText(input: BuildRepoAuthoringContextInput): string {
  const explicitIssueText = input.issueText.trim()
  if (explicitIssueText) {
    return explicitIssueText
  }

  return [input.issueTitle, input.issueBody]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n')
}

function sanitizeRepoRelativeFilePaths(
  repoRoot: string,
  repoRelativeFilePaths: string[],
): string[] {
  const seen = new Set<string>()
  const sanitized: string[] = []

  for (const value of repoRelativeFilePaths) {
    const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\/?/, '')
    if (!normalized || normalized.startsWith('/')) {
      continue
    }

    const absolutePath = resolve(repoRoot, normalized)
    if (!isPathInsideRepo(repoRoot, absolutePath)) {
      continue
    }

    const repoRelativePath = toRepoRelativePath(repoRoot, absolutePath)
    if (seen.has(repoRelativePath)) {
      continue
    }

    seen.add(repoRelativePath)
    sanitized.push(repoRelativePath)
  }

  return sanitized.sort((left, right) => left.localeCompare(right))
}

function collectPackageManifests(
  repoRoot: string,
  rootPackageJsonPath?: string,
  workspacePackageJsonPaths?: string[],
): PackageManifest[] {
  const sanitizedRootPackageJsonPath = sanitizeManifestPath(repoRoot, rootPackageJsonPath?.trim() || 'package.json')
  const rootPackage = sanitizedRootPackageJsonPath
    ? readPackageManifest(join(repoRoot, sanitizedRootPackageJsonPath))
    : null
  const manifests: PackageManifest[] = []
  const packageJsonPaths = new Set<string>()

  if (sanitizedRootPackageJsonPath) {
    packageJsonPaths.add(sanitizedRootPackageJsonPath)
  }

  for (const workspacePackageJsonPath of workspacePackageJsonPaths ?? []) {
    const normalized = sanitizeManifestPath(repoRoot, workspacePackageJsonPath)
    if (normalized) {
      packageJsonPaths.add(normalized)
    }
  }

  if (rootPackage) {
    manifests.push({
      dir: '.',
      scripts: rootPackage.scripts,
    })

    for (const workspaceDir of expandWorkspacePatterns(repoRoot, extractWorkspacePatterns(rootPackage.raw))) {
      packageJsonPaths.add(join(workspaceDir, 'package.json').replace(/\\/g, '/'))
    }
  }

  for (const packageJsonPath of [...packageJsonPaths].sort((left, right) => left.localeCompare(right))) {
    if (packageJsonPath === sanitizedRootPackageJsonPath) {
      continue
    }

    const manifest = readPackageManifest(join(repoRoot, packageJsonPath))
    if (!manifest) {
      continue
    }

    const packageDir = dirname(packageJsonPath).replace(/\\/g, '/')
    manifests.push({
      dir: packageDir === '.' ? '.' : packageDir,
      scripts: manifest.scripts,
    })
  }

  return manifests
    .filter((manifest, index, allManifests) =>
      allManifests.findIndex((candidate) => candidate.dir === manifest.dir) === index,
    )
    .sort((left, right) => left.dir.localeCompare(right.dir))
}

function sanitizeManifestPath(repoRoot: string, manifestPath: string): string | null {
  const normalized = manifestPath.trim().replace(/\\/g, '/').replace(/^\.\/?/, '')
  if (!normalized || normalized.startsWith('/')) {
    return null
  }

  const absolutePath = resolve(repoRoot, normalized)
  if (!isPathInsideRepo(repoRoot, absolutePath)) {
    return null
  }

  return toRepoRelativePath(repoRoot, absolutePath)
}

function readPackageManifest(path: string): { raw: PackageManifestRecord; scripts: Record<string, string> } | null {
  const parsed = readJsonFile<PackageManifestRecord>(path)
  if (!parsed) {
    return null
  }

  return {
    raw: parsed,
    scripts: toStringRecord(parsed.scripts),
  }
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) {
    return null
  }

  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return null
  }
}

function toStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

function extractWorkspacePatterns(manifest: PackageManifestRecord): string[] {
  if (Array.isArray(manifest.workspaces)) {
    return manifest.workspaces.filter((value): value is string => typeof value === 'string')
  }

  const packages = manifest.workspaces?.packages
  if (!Array.isArray(packages)) {
    return []
  }

  return packages.filter((value): value is string => typeof value === 'string')
}

function expandWorkspacePatterns(repoRoot: string, patterns: string[]): string[] {
  const matches = new Set<string>()

  for (const pattern of patterns) {
    const normalizedPattern = pattern.trim().replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/\/$/, '')
    if (!normalizedPattern) {
      continue
    }

    if (!normalizedPattern.includes('*')) {
      const literalPath = join(repoRoot, normalizedPattern)
      if (existsSync(join(literalPath, 'package.json'))) {
        matches.add(normalizedPattern)
      }
      continue
    }

    const segments = normalizedPattern.split('/').filter(Boolean)
    visitWorkspacePattern(repoRoot, repoRoot, segments, 0, matches)
  }

  return [...matches].sort((left, right) => left.localeCompare(right))
}

function visitWorkspacePattern(
  repoRoot: string,
  currentPath: string,
  segments: string[],
  index: number,
  matches: Set<string>,
): void {
  if (index >= segments.length) {
    if (existsSync(join(currentPath, 'package.json'))) {
      matches.add(toRepoRelativePath(repoRoot, currentPath))
    }
    return
  }

  const segment = segments[index]
  if (!segment) {
    return
  }

  if (segment === '**') {
    visitWorkspacePattern(repoRoot, currentPath, segments, index + 1, matches)
    for (const child of listChildDirectories(currentPath)) {
      visitWorkspacePattern(repoRoot, child, segments, index, matches)
    }
    return
  }

  if (segment === '*') {
    for (const child of listChildDirectories(currentPath)) {
      visitWorkspacePattern(repoRoot, child, segments, index + 1, matches)
    }
    return
  }

  const nextPath = join(currentPath, segment)
  if (existsSync(nextPath)) {
    visitWorkspacePattern(repoRoot, nextPath, segments, index + 1, matches)
  }
}

function listChildDirectories(path: string): string[] {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry: Dirent) => entry.isDirectory())
    .filter((entry: Dirent) => !IGNORED_DIRECTORY_NAMES.has(entry.name))
    .map((entry: Dirent) => join(path, entry.name))
    .sort((left, right) => left.localeCompare(right))
}

function collectRepoFiles(repoRoot: string): string[] {
  const files: string[] = []

  const visit = (currentPath: string): void => {
    for (const entry of readdirSync(currentPath, { withFileTypes: true })
      .sort((left: Dirent, right: Dirent) => left.name.localeCompare(right.name))) {
      const entryPath = join(currentPath, entry.name)

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORY_NAMES.has(entry.name)) {
          continue
        }

        visit(entryPath)
        continue
      }

      if (entry.isFile()) {
        files.push(toRepoRelativePath(repoRoot, entryPath))
      }
    }
  }

  visit(repoRoot)
  return files.sort((left, right) => left.localeCompare(right))
}

function toRepoRelativePath(repoRoot: string, absolutePath: string): string {
  return relative(repoRoot, absolutePath).split(sep).join('/')
}

function isPathInsideRepo(repoRoot: string, absolutePath: string): boolean {
  const normalizedRoot = resolve(repoRoot)
  const normalizedPath = resolve(absolutePath)
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`)
}
