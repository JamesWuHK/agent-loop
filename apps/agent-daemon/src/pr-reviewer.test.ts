import { describe, expect, test } from 'bun:test'
import {
  buildPrReviewComment,
  buildReviewFeedback,
  buildReviewPrompt,
  extractIssueNumberFromPrBody,
  extractIssueNumberFromPrTitle,
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

  test('marks rejection output invalid when a finding omits required repair contract fields', () => {
    expect(parsePrReviewResponse(`{
      "approved": false,
      "canMerge": false,
      "reason": "routing contract broken",
      "findings": [
        {
          "severity": "high",
          "file": "apps/web/src/auth.ts",
          "summary": "auth state no longer clears on logout"
        }
      ]
    }`)).toEqual({
      approved: false,
      canMerge: false,
      reason: 'Review output failed validation: every rejection finding must include mustFix, mustNotDo, validation, and scopeRationale. finding 1 in apps/web/src/auth.ts (auth state no longer clears on logout) missing mustFix, mustNotDo, validation, scopeRationale',
      reviewFailed: true,
      findings: [
        {
          severity: 'high',
          file: 'apps/web/src/auth.ts',
          summary: 'auth state no longer clears on logout',
        },
      ],
    })
  })

  test('builds detailed review feedback from findings', () => {
    expect(buildReviewFeedback({
      approved: false,
      canMerge: false,
      reason: 'Issue contract is still broken.',
      findings: [
        {
          severity: 'high',
          file: 'apps/web/src/auth.ts',
          summary: 'logout no longer clears state',
          mustFix: ['restore state clearing in logout'],
          mustNotDo: ['do not expand into persistence work'],
          validation: ['bun test apps/web/src/auth.test.ts'],
          scopeRationale: 'the linked issue explicitly owns logout state semantics',
        },
      ],
    })).toContain('Structured review feedback:')
  })

  test('embeds structured review feedback in PR comments for auto-fix handoff', () => {
    const comment = buildPrReviewComment(61, {
      approved: false,
      canMerge: false,
      reason: 'Issue contract is still broken.',
      findings: [
        {
          severity: 'high',
          file: 'apps/web/src/auth.ts',
          summary: 'logout no longer clears state',
          mustFix: ['restore state clearing in logout'],
          mustNotDo: ['do not expand into persistence work'],
          validation: ['bun test apps/web/src/auth.test.ts'],
          scopeRationale: 'the linked issue explicitly owns logout state semantics',
        },
      ],
    }, 2, 'human-needed')

    expect(comment).toContain('<!-- agent-loop:review-feedback ')
    expect(comment).toContain('"mustFix":["restore state clearing in logout"]')
    expect(comment).toContain('## Automated review still failing')
  })

  test('extracts issue number from generated PR titles', () => {
    expect(extractIssueNumberFromPrTitle('Fix #45: minimal auth state wiring')).toBe(45)
    expect(extractIssueNumberFromPrTitle('minimal auth state wiring')).toBeNull()
  })

  test('extracts linked issue number from PR body closing keywords', () => {
    expect(extractIssueNumberFromPrBody('## Summary\n\nFixes #46\n')).toBe(46)
    expect(extractIssueNumberFromPrBody('Resolves #108 with follow-up cleanup')).toBe(108)
    expect(extractIssueNumberFromPrBody('No linked issue here')).toBeNull()
  })

  test('builds review prompt with linked issue scope and contract guardrails', () => {
    const prompt = buildReviewPrompt(61, 'https://example.com/pr/61', 'owner/repo', {
      title: 'Fix #46: minimal auth state wiring',
      body: 'Fixes #46',
      files: [
        {
          path: 'apps/web/src/auth.ts',
          additions: 10,
          deletions: 0,
        },
      ],
      diff: 'diff --git a/apps/web/src/auth.ts b/apps/web/src/auth.ts',
      linkedIssue: {
        number: 46,
        title: 'minimal auth state wiring',
        body: `## Context
### Constraints
- do not add persistence`,
      },
    })

    expect(prompt).toContain('Linked Issue #46: minimal auth state wiring')
    expect(prompt).toContain('Use the linked issue as the primary scope and acceptance contract for the review.')
    expect(prompt).toContain('treat them as an executable review contract')
    expect(prompt).toContain('Every rejection finding is mandatory contract data')
    expect(prompt).toContain('do not add persistence')
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
})
