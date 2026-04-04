import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  buildPrReviewComment,
  buildReviewPrompt,
  buildReviewFeedback,
  collectDependencyDirectories,
  extractIssueNumberFromPrBody,
  extractIssueNumberFromPrTitle,
  extractAutomatedReviewReasons,
  hydrateDetachedReviewWorktree,
  normalizeWorktreePath,
  parsePrReviewResponse,
  validateRejectedReviewFindings,
} from './pr-reviewer'

describe('pr-reviewer', () => {
  test('parses reason directly from JSON response', () => {
    expect(parsePrReviewResponse(`{
      "approved": true,
      "canMerge": true,
      "reason": "ready to merge"
    }`)).toEqual({
      approved: true,
      canMerge: true,
      reason: 'ready to merge',
    })
  })

  test('falls back to first finding when reason is omitted', () => {
    expect(parsePrReviewResponse(`{
      "approved": false,
      "canMerge": false,
      "findings": [
        {
          "severity": "high",
          "file": "apps/desktop/src/App.tsx",
          "summary": "logout leaves auth state behind"
        }
      ]
    }`)).toEqual({
      approved: false,
      canMerge: false,
      reason: 'Review output failed validation: every rejection finding must include mustFix, mustNotDo, validation, and scopeRationale. finding 1 in apps/desktop/src/App.tsx (logout leaves auth state behind) missing mustFix, mustNotDo, validation, scopeRationale',
      reviewFailed: true,
      findings: [
        {
          severity: 'high',
          file: 'apps/desktop/src/App.tsx',
          summary: 'logout leaves auth state behind',
        },
      ],
    })
  })

  test('builds detailed review feedback from findings', () => {
    expect(buildReviewFeedback({
      approved: false,
      canMerge: false,
      reason: 'Routing contract is still broken.',
      findings: [
        {
          severity: 'high',
          file: 'apps/desktop/src/App.tsx',
          summary: 'login route still boots dashboard side effects',
          mustFix: ['remove dashboard bootstrap from the login path'],
          mustNotDo: ['do not move the route guard into App.tsx'],
          validation: ['cd apps/desktop && bun run --bun test src/App.test.tsx'],
          scopeRationale: 'issue #46 only allows the AppContext-side wiring',
        },
        {
          severity: 'medium',
          file: 'apps/desktop/src/context/AppContext.tsx',
          summary: 'currentPath can drift from rendered route',
        },
      ],
    })).toContain('Structured review feedback:')
  })

  test('embeds structured review feedback in PR comments for auto-fix handoff', () => {
    const comment = buildPrReviewComment(61, {
      approved: false,
      canMerge: false,
      reason: 'Routing contract is still broken.',
      findings: [
        {
          severity: 'high',
          file: 'apps/desktop/src/App.tsx',
          summary: 'login route still boots dashboard side effects',
          mustFix: ['remove dashboard bootstrap from the login path'],
          mustNotDo: ['do not move the route guard into App.tsx'],
          validation: ['cd apps/desktop && bun run --bun test src/App.test.tsx'],
          scopeRationale: 'issue #46 only allows the AppContext-side wiring',
        },
      ],
    }, 2, 'human-needed')

    expect(comment).toContain('<!-- agent-loop:review-feedback ')
    expect(comment).toContain('"mustFix":["remove dashboard bootstrap from the login path"]')
    expect(comment).toContain('## Automated review still failing')
  })

  test('extracts issue number from generated PR titles', () => {
    expect(extractIssueNumberFromPrTitle('Fix #45: [US1-1] App 路由守卫最小骨架')).toBe(45)
    expect(extractIssueNumberFromPrTitle('[US1-1] App 路由守卫最小骨架')).toBeNull()
  })

  test('extracts linked issue number from PR body closing keywords', () => {
    expect(extractIssueNumberFromPrBody('## Summary\n\nFixes #46\n')).toBe(46)
    expect(extractIssueNumberFromPrBody('Resolves #108 with follow-up cleanup')).toBe(108)
    expect(extractIssueNumberFromPrBody('No linked issue here')).toBeNull()
  })

  test('builds review prompt with linked issue scope and out-of-scope guardrails', () => {
    const prompt = buildReviewPrompt(61, 'https://example.com/pr/61', 'owner/repo', {
      title: 'Fix #46: [US1-2] AppContext 增加最小 auth/navigation 接口',
      body: 'Fixes #46',
      headRefName: 'agent/46/codex-20260403',
      files: [
        {
          path: 'apps/desktop/src/context/AppContext.tsx',
          additions: 10,
          deletions: 0,
        },
      ],
      diff: 'diff --git a/apps/desktop/src/context/AppContext.tsx b/apps/desktop/src/context/AppContext.tsx',
      linkedIssue: {
        number: 46,
        title: '[US1-2] AppContext 增加最小 auth/navigation 接口',
        body: `## Constraints
- 只补以下最小接口：token、currentPath、navigate、setAuth、clearAuth。
- 不接 API，不做 token 持久化。`,
      },
    })

    expect(prompt).toContain('Linked Issue #46: [US1-2] AppContext 增加最小 auth/navigation 接口')
    expect(prompt).toContain('Use the linked issue as the primary scope and acceptance contract for the review.')
    expect(prompt).toContain('Do not reject for intentionally out-of-scope work')
    expect(prompt).toContain('treat them as an executable review contract')
    expect(prompt).toContain('不接 API，不做 token 持久化')
    expect(prompt).toContain('Every rejection finding is mandatory contract data')
  })

  test('extracts the latest automated review reasons from PR comments', () => {
    expect(extractAutomatedReviewReasons([
      {
        body: `<!-- agent-loop:pr-review {"pr":60,"attempt":1,"approved":false,"canMerge":false} -->
## Automated review found blocking issues — starting one auto-fix retry

- Attempt: 1
- Merge ready: no
- Reason: First blocker

Next step: daemon will attempt one automatic fix on the same branch.`,
      },
      {
        body: `<!-- agent-loop:pr-review {"pr":60,"attempt":2,"approved":false,"canMerge":false} -->
<!-- agent-loop:review-feedback {"approved":false,"canMerge":false,"reason":"Second blocker","findings":[{"severity":"high","file":"apps/desktop/src/App.tsx","summary":"login page never renders","mustFix":["restore the login route"],"mustNotDo":["do not add API calls"],"validation":["cd apps/desktop && bun run --bun test src/App.test.tsx"],"scopeRationale":"required by the linked issue contract"},{"severity":"medium","file":"apps/desktop/src/test/setup.ts","summary":"root test command is broken"}]} -->
## Automated review still failing — human intervention required

- Attempt: 2
- Merge ready: no
- Reason: Second blocker
- Findings:
  - high in apps/desktop/src/App.tsx: login page never renders
  - medium in apps/desktop/src/test/setup.ts: root test command is broken

Next step: stopping automation and leaving the worktree/branch for a human.`,
      },
    ])).toEqual([
      'First blocker',
    ])
  })

  test('parses structured review findings with repair constraints', () => {
    expect(parsePrReviewResponse(`{
      "approved": false,
      "canMerge": false,
      "reason": "routing contract broken",
      "findings": [
        {
          "severity": "high",
          "file": "apps/desktop/src/context/AppContext.tsx",
          "summary": "navigate no longer preserves currentPath",
          "mustFix": ["restore currentPath updates"],
          "mustNotDo": ["do not add login persistence"],
          "validation": ["cd apps/desktop && bun run --bun test src/App.test.tsx"],
          "scopeRationale": "the linked issue explicitly requires currentPath + navigate semantics"
        }
      ]
    }`)).toEqual({
      approved: false,
      canMerge: false,
      reason: 'routing contract broken',
      findings: [
        {
          severity: 'high',
          file: 'apps/desktop/src/context/AppContext.tsx',
          summary: 'navigate no longer preserves currentPath',
          mustFix: ['restore currentPath updates'],
          mustNotDo: ['do not add login persistence'],
          validation: ['cd apps/desktop && bun run --bun test src/App.test.tsx'],
          scopeRationale: 'the linked issue explicitly requires currentPath + navigate semantics',
        },
      ],
    })
  })

  test('marks rejection output invalid when a finding omits required repair contract fields', () => {
    expect(parsePrReviewResponse(`{
      "approved": false,
      "canMerge": false,
      "reason": "routing contract broken",
      "findings": [
        {
          "severity": "high",
          "file": "apps/desktop/src/context/AppContext.tsx",
          "summary": "navigate no longer preserves currentPath"
        }
      ]
    }`)).toEqual({
      approved: false,
      canMerge: false,
      reason: 'Review output failed validation: every rejection finding must include mustFix, mustNotDo, validation, and scopeRationale. finding 1 in apps/desktop/src/context/AppContext.tsx (navigate no longer preserves currentPath) missing mustFix, mustNotDo, validation, scopeRationale',
      reviewFailed: true,
      findings: [
        {
          severity: 'high',
          file: 'apps/desktop/src/context/AppContext.tsx',
          summary: 'navigate no longer preserves currentPath',
        },
      ],
    })
  })

  test('flags rejected reviews without findings as invalid', () => {
    expect(validateRejectedReviewFindings({
      approved: false,
      canMerge: false,
      findings: [],
    })).toEqual([
      {
        findingIndex: 1,
        file: '',
        summary: 'missing rejection finding',
        missingFields: ['mustFix', 'mustNotDo', 'validation', 'scopeRationale'],
      },
    ])
  })

  test('ignores invalid structured review comments when extracting retry context', () => {
    expect(extractAutomatedReviewReasons([
      {
        body: `<!-- agent-loop:pr-review {"pr":63,"attempt":1,"approved":false,"canMerge":false} -->
<!-- agent-loop:review-feedback {"approved":false,"canMerge":false,"reason":"Bad blocker","findings":[{"severity":"high","file":"apps/desktop/src/App.tsx","summary":"missing contract fields"}]} -->
## Automated review found blocking issues

- Attempt: 1
- Merge ready: no
- Reason: Bad blocker`,
      },
    ])).toEqual([])
  })

  test('normalizes detached review worktree paths to their real path', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pr-reviewer-test-'))

    try {
      expect(normalizeWorktreePath(tempDir)).toBe(realpathSync(tempDir))
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('collects repo dependency directories without descending into node_modules contents', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pr-reviewer-test-'))
    const repoRoot = join(tempDir, 'repo')

    try {
      mkdirSync(join(repoRoot, 'node_modules'), { recursive: true })
      mkdirSync(join(repoRoot, 'apps', 'desktop', 'node_modules'), { recursive: true })
      mkdirSync(join(repoRoot, 'packages', 'agent-shared', 'node_modules'), { recursive: true })
      mkdirSync(join(repoRoot, 'node_modules', '.bun', 'node_modules'), { recursive: true })

      expect(collectDependencyDirectories(repoRoot)).toEqual([
        'apps/desktop/node_modules',
        'node_modules',
        'packages/agent-shared/node_modules',
      ])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('hydrates detached review worktree with dependency symlinks', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pr-reviewer-test-'))
    const repoRoot = join(tempDir, 'repo')
    const worktreePath = join(tempDir, 'worktree')

    try {
      mkdirSync(join(repoRoot, 'node_modules'), { recursive: true })
      mkdirSync(join(repoRoot, 'apps', 'desktop', 'node_modules'), { recursive: true })
      mkdirSync(worktreePath, { recursive: true })

      hydrateDetachedReviewWorktree(repoRoot, worktreePath, console)

      const rootNodeModules = join(worktreePath, 'node_modules')
      const desktopNodeModules = join(worktreePath, 'apps', 'desktop', 'node_modules')

      expect(existsSync(rootNodeModules)).toBe(true)
      expect(existsSync(desktopNodeModules)).toBe(true)
      expect(lstatSync(rootNodeModules).isSymbolicLink()).toBe(true)
      expect(lstatSync(desktopNodeModules).isSymbolicLink()).toBe(true)
      expect(realpathSync(rootNodeModules)).toBe(realpathSync(join(repoRoot, 'node_modules')))
      expect(realpathSync(desktopNodeModules)).toBe(realpathSync(join(repoRoot, 'apps', 'desktop', 'node_modules')))
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
