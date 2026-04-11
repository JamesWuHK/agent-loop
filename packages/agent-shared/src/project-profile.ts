import type {
  ProjectIssueAuthoringRules,
  ProjectProfileConfig,
  ProjectProfileName,
  ProjectPromptContext,
  ResolvedProjectIssueAuthoringRules,
} from './types'

const BUILTIN_GUIDANCE: Record<ProjectProfileName, Partial<Record<ProjectPromptContext, string[]>>> = {
  generic: {
    planning: [
      'Prefer subtasks that reuse the repository\'s existing build, test, and lint commands instead of introducing a new harness or framework rewrite.',
    ],
    implementation: [
      'Use the repository\'s existing validation commands and test harnesses when available. Do not invent replacement toolchains, bootstrap files, or framework rewrites unless the issue explicitly requires them.',
    ],
    reviewFix: [
      'Validate fixes with the repository\'s existing commands from the linked issue or branch. Do not rewrite the toolchain or add a new framework-specific harness just to satisfy review feedback.',
    ],
    recovery: [
      'Prefer the repository\'s existing validation commands and tooling. Do not add new harnesses or change toolchains unless the issue explicitly requires it.',
    ],
  },
  'desktop-vite': {
    planning: [
      'When the issue is a desktop frontend task, prefer subtasks that use the existing Vitest/jsdom setup instead of introducing new manual DOM bootstrap or test harness rewrites.',
    ],
    implementation: [
      'For desktop frontend tests, use the existing Vitest/jsdom setup from `apps/desktop/vite.config.ts` and `apps/desktop/src/test/setup.ts`. Do not add manual `JSDOM` bootstrap, duplicate DOM globals, or replacement test harness files unless the issue explicitly requires that.',
    ],
    reviewFix: [
      'When validating desktop frontend tests, run them from `apps/desktop` so Vitest loads `vite.config.ts` and the `jsdom` environment. Prefer Bun-native execution to avoid host Node mismatches (for example `cd apps/desktop && bun run --bun test src/App.test.tsx`).',
    ],
    recovery: [
      'For desktop frontend tests, prefer running from `apps/desktop` so Vitest picks up `vite.config.ts` and `jsdom`. Prefer Bun-native execution to avoid host Node mismatches (for example `cd apps/desktop && bun run --bun test src/App.test.tsx`).',
    ],
  },
}

export function getProjectPromptGuidance(
  project: ProjectProfileConfig | undefined,
  context: ProjectPromptContext,
): string[] {
  const profile = project?.profile ?? 'generic'
  const builtin = BUILTIN_GUIDANCE[profile]?.[context] ?? []
  const overrides = project?.promptGuidance?.[context] ?? []
  return [...builtin, ...overrides]
}

export function getProjectIssueAuthoringRules(
  project: ProjectProfileConfig | undefined,
): ResolvedProjectIssueAuthoringRules {
  const configuredRules = project?.issueAuthoring

  return {
    preferredValidationCommands: normalizeProjectIssueAuthoringValues(
      configuredRules?.preferredValidationCommands,
    ),
    preferredAllowedFiles: normalizeProjectIssueAuthoringValues(
      configuredRules?.preferredAllowedFiles,
    ),
    forbiddenPaths: normalizeProjectIssueAuthoringValues(
      configuredRules?.forbiddenPaths,
    ),
    reviewHints: normalizeProjectIssueAuthoringValues(
      configuredRules?.reviewHints,
    ),
  }
}

export function hasProjectIssueAuthoringRules(
  rules: ProjectIssueAuthoringRules | ResolvedProjectIssueAuthoringRules | undefined,
): boolean {
  if (!rules) {
    return false
  }

  return (
    (rules.preferredValidationCommands?.length ?? 0) > 0
    || (rules.preferredAllowedFiles?.length ?? 0) > 0
    || (rules.forbiddenPaths?.length ?? 0) > 0
    || (rules.reviewHints?.length ?? 0) > 0
  )
}

function normalizeProjectIssueAuthoringValues(values: string[] | undefined): string[] {
  const normalizedValues: string[] = []
  const seen = new Set<string>()

  for (const value of values ?? []) {
    const normalized = value.trim()
    if (!normalized || seen.has(normalized)) {
      continue
    }

    seen.add(normalized)
    normalizedValues.push(normalized)
  }

  return normalizedValues
}
