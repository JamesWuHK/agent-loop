import { describe, expect, test } from 'bun:test'
import { ISSUE_LABELS } from '@agent/shared'
import { buildReadyGateFailureComment, evaluateReadyGate } from './ready-gate'

describe('ready-gate', () => {
  test('skips issues that are not in agent:ready', () => {
    expect(evaluateReadyGate({
      number: 49,
      title: 'example',
      body: '## 用户故事\n- test',
      state: 'open',
      labels: ['bug'],
    })).toEqual({
      shouldEnforce: false,
      valid: true,
      errors: [],
    })
  })

  test('rejects ready issues with incomplete executable contracts', () => {
    expect(evaluateReadyGate({
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
        'missing executable scope contract (AllowedFiles/ForbiddenFiles/MustPreserve/OutOfScope/RequiredSemantics)',
      ],
    })
  })

  test('accepts ready issues with executable contracts', () => {
    expect(evaluateReadyGate({
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
        '- apps/web/src/login.tsx',
        '### RequiredSemantics',
        '- 合法提交时调用登录接口',
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
    })).toEqual({
      shouldEnforce: true,
      valid: true,
      errors: [],
    })
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
