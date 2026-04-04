import { describe, expect, it } from 'bun:test'
import { buildPlanningPrompt, buildSubtaskPrompt } from './subtask-parser'

describe('buildPlanningPrompt', () => {
  it('steers desktop tasks toward the existing Vitest/jsdom harness', () => {
    const prompt = buildPlanningPrompt(
      '[US1-4] LoginPage 表单校验',
      '## Context\n### AllowedFiles\n- apps/desktop/src/pages/LoginPage.tsx\n',
      { profile: 'desktop-vite' },
    )

    expect(prompt).toContain('use the existing Vitest/jsdom setup')
    expect(prompt).toContain('manual DOM bootstrap')
  })

  it('defaults to generic repo-toolchain guidance', () => {
    const prompt = buildPlanningPrompt(
      'Implement auth retry',
      '## Context\n### AllowedFiles\n- services/auth.py\n',
    )

    expect(prompt).toContain('reuse the repository\'s existing build, test, and lint commands')
    expect(prompt).not.toContain('Vitest/jsdom')
  })
})

describe('buildSubtaskPrompt', () => {
  it('warns against manual jsdom bootstrap for desktop frontend tests', () => {
    const prompt = buildSubtaskPrompt(
      {
        id: 'subtask-2',
        title: 'Implement LoginPage validation state',
        status: 'pending',
        order: 2,
      },
      48,
      '[US1-4] LoginPage 表单校验',
      '## Context\n### AllowedFiles\n- apps/desktop/src/pages/LoginPage.tsx\n',
      { profile: 'desktop-vite' },
    )

    expect(prompt).toContain('existing Vitest/jsdom setup')
    expect(prompt).toContain('Do not add manual `JSDOM` bootstrap')
    expect(prompt).toContain('apps/desktop/src/test/setup.ts')
  })

  it('uses generic toolchain guidance by default', () => {
    const prompt = buildSubtaskPrompt(
      {
        id: 'subtask-1',
        title: 'Update login retry handling',
        status: 'pending',
        order: 1,
      },
      52,
      'Update login retry handling',
      '## Context\n### AllowedFiles\n- services/auth.py\n',
    )

    expect(prompt).toContain('Use the repository\'s existing validation commands and test harnesses')
    expect(prompt).not.toContain('Vitest/jsdom setup')
  })
})
