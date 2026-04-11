import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ISSUE_LABELS } from '@agent/shared'
import { buildReadyGateFailureComment, evaluateReadyGate } from './ready-gate'

describe('ready-gate', () => {
  test('skips issues that are not in agent:ready', async () => {
    expect(await evaluateReadyGate({
      number: 49,
      title: 'example',
      body: '## 用户故事\n- test',
      state: 'open',
      labels: ['bug'],
    })).toEqual({
      shouldEnforce: false,
      valid: true,
      errors: [],
      simulation: null,
    })
  })

  test('rejects ready issues with incomplete executable contracts', async () => {
    expect(await evaluateReadyGate({
      number: 49,
      title: 'example',
      body: '## 用户故事\n只有故事，没有 contract。',
      state: 'open',
      labels: [ISSUE_LABELS.READY],
    })).toEqual({
      shouldEnforce: true,
      valid: false,
      errors: [
        'missing ### Dependencies JSON block',
        'missing ## 实现步骤 / Implementation Steps',
        'missing ## 验收 / Acceptance',
        'missing ## RED 测试 / RED Tests',
        'missing ### Validation / Validation Commands',
        'missing executable scope contract (AllowedFiles/ForbiddenFiles/MustPreserve/OutOfScope/RequiredSemantics)',
      ],
      simulation: null,
    })
  })

  test('accepts ready issues with executable contracts', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'ready-gate-valid-'))

    try {
      mkdirSync(join(tempDir, 'apps', 'desktop', 'src', 'pages'), { recursive: true })
      writeFileSync(join(tempDir, 'apps', 'desktop', 'src', 'pages', 'LoginPage.test.tsx'), 'test', 'utf-8')

      expect(await evaluateReadyGate({
        number: 49,
        title: 'example',
        body: [
          '## 用户故事',
          '作为用户，我希望 happy path 可提交。',
          '',
          '## Context',
          '### Dependencies',
          '```json',
          '{ "dependsOn": [48] }',
          '```',
          '### AllowedFiles',
          '- apps/desktop/src/pages/LoginPage.tsx',
          '### RequiredSemantics',
          '- 合法提交时调用登录接口',
          '### Validation',
          '- bun --cwd apps/desktop test src/pages/LoginPage.test.tsx',
          '',
          '## RED 测试',
          '```tsx',
          'expect(true).toBe(false)',
          '```',
          '',
          '## 实现步骤',
          '1. 添加 happy path 提交',
          '',
          '## 验收',
          '- 调用 login 后导航到 /main',
        ].join('\n'),
        state: 'open',
        labels: [ISSUE_LABELS.READY],
      }, {
        repoRoot: tempDir,
      })).toEqual({
        shouldEnforce: true,
        valid: true,
        errors: [],
        simulation: null,
      })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('accepts ready issues when validation points at a new file that is explicitly allowed', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'ready-gate-future-file-'))

    try {
      mkdirSync(join(tempDir, 'apps', 'desktop', 'src', 'pages'), { recursive: true })

      expect(await evaluateReadyGate({
        number: 77,
        title: 'example',
        body: [
          '## 用户故事',
          '作为用户，我希望 issue 可以用 RED 测试文件名做 validation。',
          '',
          '## Context',
          '### Dependencies',
          '```json',
          '{ "dependsOn": [76] }',
          '```',
          '### AllowedFiles',
          '- apps/desktop/src/pages/MainPage.future.test.tsx',
          '### ForbiddenFiles',
          '- apps/desktop/src/App.tsx',
          '### MustPreserve',
          '- 既有页面结构保持不变',
          '### OutOfScope',
          '- 其它新功能',
          '### RequiredSemantics',
          '- 新测试文件属于本 issue 合法产物',
          '### Validation',
          '- bun --cwd apps/desktop test src/pages/MainPage.future.test.tsx',
          '',
          '## RED 测试',
          '```tsx',
          'expect(true).toBe(false)',
          '```',
          '',
          '## 实现步骤',
          '1. 先写 RED',
          '',
          '## 验收',
          '- 只改 AllowedFiles',
        ].join('\n'),
        state: 'open',
        labels: [ISSUE_LABELS.READY],
      }, {
        repoRoot: tempDir,
      })).toEqual({
        shouldEnforce: true,
        valid: true,
        errors: [],
        simulation: null,
      })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('rejects ready issues when validation references repo paths that do not exist', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'ready-gate-missing-'))

    try {
      mkdirSync(join(tempDir, 'apps', 'desktop', 'src', 'pages'), { recursive: true })
      writeFileSync(join(tempDir, 'apps', 'desktop', 'src', 'pages', 'MainPage.sprint-c.smoke.test.tsx'), 'test', 'utf-8')

      expect(await evaluateReadyGate({
        number: 92,
        title: 'example',
        body: [
          '## 用户故事',
          '作为用户，我希望 smoke 能跑通。',
          '',
          '## Context',
          '### Dependencies',
          '```json',
          '{ "dependsOn": [90, 91] }',
          '```',
          '### AllowedFiles',
          '- apps/desktop/src/pages/MainPage.sprint-c.smoke.test.tsx',
          '### ForbiddenFiles',
          '- apps/desktop/src/pages/MainPage.sessions-sidebar.test.tsx',
          '### MustPreserve',
          '- 既有 feature tests 不改写',
          '### OutOfScope',
          '- 新业务功能',
          '### RequiredSemantics',
          '- 保持主路径 happy path',
          '### Validation',
          '- bun --cwd apps/desktop test src/pages/MainPage.sprint-c.smoke.test.tsx',
          '- bun --cwd apps/desktop test src/pages/MainPage.sessions-sidebar.test.tsx',
          '',
          '## RED 测试',
          '```tsx',
          'expect(true).toBe(false)',
          '```',
          '',
          '## 实现步骤',
          '1. 添加 smoke',
          '',
          '## 验收',
          '- 只改 AllowedFiles',
        ].join('\n'),
        state: 'open',
        labels: [ISSUE_LABELS.READY],
      }, {
        repoRoot: tempDir,
      })).toEqual({
        shouldEnforce: true,
        valid: false,
        errors: [
          'validation references missing repo path: apps/desktop/src/pages/MainPage.sessions-sidebar.test.tsx',
        ],
        simulation: null,
      })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('merges simulation failures only when explicitly enabled', async () => {
    const evaluation = await evaluateReadyGate({
      number: 105,
      title: '[AL-X] 增加 issue simulate',
      body: [
        '## 用户故事',
        '作为维护者，我希望 ready gate 可选叠加 simulation。',
        '',
        '## Context',
        '### Dependencies',
        '```json',
        '{ "dependsOn": [] }',
        '```',
        '### AllowedFiles',
        '- apps/agent-daemon/src/ready-gate.ts',
        '### ForbiddenFiles',
        '- apps/agent-daemon/src/daemon.ts',
        '### MustPreserve',
        '- 默认 hard validation 保持兼容',
        '### OutOfScope',
        '- runtime evaluator',
        '### RequiredSemantics',
        '- 显式开关控制 simulation',
        '### Validation',
        '- `bun test apps/agent-daemon/src/ready-gate.test.ts`',
        '',
        '## RED 测试',
        '```ts',
        'throw new Error("red")',
        '```',
        '',
        '## 实现步骤',
        '1. 先补测试',
        '',
        '## 验收',
        '- [ ] 默认行为不回归',
      ].join('\n'),
      state: 'open',
      labels: [ISSUE_LABELS.READY],
    }, {
      enableSimulation: true,
      repoRoot: '/tmp/repo',
      simulateIssueExecutability: async () => ({
        valid: false,
        summary: 'simulation failed',
        failures: ['planning output does not contain commit-shaped subtasks'],
        findings: [{
          code: 'planning_not_commit_shaped',
          stage: 'planner',
          message: 'planning output does not contain commit-shaped subtasks',
        }],
        plannerPrompt: 'prompt',
        plannerOutput: '1. Read the codebase',
        plannedSubtasks: ['Read the codebase'],
      }),
    })

    expect(evaluation.valid).toBe(false)
    expect(evaluation.errors).toContain('planning output does not contain commit-shaped subtasks')
    expect(evaluation.simulation?.valid).toBe(false)
  })

  test('renders a repair-oriented failure comment', () => {
    const comment = buildReadyGateFailureComment(49, [
      'missing ## RED 测试 / RED Tests',
      'missing ## 验收 / Acceptance',
    ])

    expect(comment).toContain('<!-- agent-loop:ready-gate {"issue":49,"valid":false} -->')
    expect(comment).toContain('This issue cannot stay in `agent:ready`')
    expect(comment).toContain('- missing ## RED 测试 / RED Tests')
    expect(comment).toContain('re-apply `agent:ready`')
  })
})
