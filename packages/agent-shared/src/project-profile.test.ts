import { describe, expect, it } from 'bun:test'
import { getProjectPromptGuidance } from './project-profile'

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
})
