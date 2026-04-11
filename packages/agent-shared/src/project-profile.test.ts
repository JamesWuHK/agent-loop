import { describe, expect, it } from 'bun:test'
import {
  getProjectIssueAuthoringRules,
  getProjectPromptGuidance,
} from './project-profile'

describe('getProjectPromptGuidance', () => {
  it('defaults to generic guidance when no project profile is configured', () => {
    const guidance = getProjectPromptGuidance(undefined, 'implementation')

    expect(guidance.join('\n')).toContain('existing validation commands and test harnesses')
    expect(guidance.join('\n')).not.toContain('Vitest/jsdom')
  })

  it('returns desktop-vite guidance for desktop frontend tasks', () => {
    const guidance = getProjectPromptGuidance({ profile: 'desktop-vite' }, 'reviewFix')

    expect(guidance.join('\n')).toContain('Vitest loads `vite.config.ts` and the `jsdom` environment')
    expect(guidance.join('\n')).toContain('cd apps/desktop && bun run --bun test src/App.test.tsx')
  })

  it('appends custom guidance after the built-in profile guidance', () => {
    const guidance = getProjectPromptGuidance({
      profile: 'generic',
      promptGuidance: {
        implementation: ['Run `pytest` instead of inventing a JS harness.'],
      },
    }, 'implementation')

    expect(guidance.at(-1)).toBe('Run `pytest` instead of inventing a JS harness.')
  })

  it('normalizes project issue authoring rules while preserving deterministic order', () => {
    const rules = getProjectIssueAuthoringRules({
      profile: 'generic',
      issueAuthoring: {
        preferredValidationCommands: [
          'bun test apps/agent-daemon/src/issue-repair.test.ts',
          'bun test apps/agent-daemon/src/issue-repair.test.ts',
          '  ',
        ],
        preferredAllowedFiles: [
          'apps/agent-daemon/src/issue-repair.ts',
          'apps/agent-daemon/src/issue-repair.test.ts',
        ],
        forbiddenPaths: [
          'apps/agent-daemon/src/dashboard.ts',
          'apps/agent-daemon/src/dashboard.ts',
        ],
        reviewHints: [
          '优先检查 repair 流程是否保留合法的 Dependencies JSON',
        ],
      },
    })

    expect(rules).toEqual({
      preferredValidationCommands: [
        'bun test apps/agent-daemon/src/issue-repair.test.ts',
      ],
      preferredAllowedFiles: [
        'apps/agent-daemon/src/issue-repair.ts',
        'apps/agent-daemon/src/issue-repair.test.ts',
      ],
      forbiddenPaths: [
        'apps/agent-daemon/src/dashboard.ts',
      ],
      reviewHints: [
        '优先检查 repair 流程是否保留合法的 Dependencies JSON',
      ],
    })
  })
})
