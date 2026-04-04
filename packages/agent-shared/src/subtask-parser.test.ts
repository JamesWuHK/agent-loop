import { describe, expect, it } from 'bun:test'
import { buildPlanningPrompt, buildSubtaskPrompt } from './subtask-parser'

describe('buildPlanningPrompt', () => {
  it('steers desktop tasks toward the existing Vitest/jsdom harness', () => {
    const prompt = buildPlanningPrompt(
      '[US1-4] LoginPage 表单校验',
      '## Context\n### AllowedFiles\n- apps/desktop/src/pages/LoginPage.tsx\n',
    )

    expect(prompt).toContain('use the existing Vitest/jsdom setup')
    expect(prompt).toContain('manual DOM bootstrap')
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
    )

    expect(prompt).toContain('existing Vitest/jsdom setup')
    expect(prompt).toContain('Do not add manual `JSDOM` bootstrap')
    expect(prompt).toContain('apps/desktop/src/test/setup.ts')
  })
})
