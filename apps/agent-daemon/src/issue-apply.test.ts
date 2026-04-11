import { describe, expect, test } from 'bun:test'
import {
  applyIssueBodyUpdate,
  formatIssueApplyResult,
} from './issue-apply'

const VALID_MARKDOWN = [
  '## 用户故事',
  '作为维护者，我希望安全回写 issue contract。',
  '',
  '## Context',
  '### Dependencies',
  '```json',
  '{ "dependsOn": [53] }',
  '```',
  '### Constraints',
  '- 只更新 issue body',
  '### AllowedFiles',
  '- apps/agent-daemon/src/issue-apply.ts',
  '### ForbiddenFiles',
  '- apps/agent-daemon/src/dashboard.ts',
  '### MustPreserve',
  '- stale write 必须失败',
  '### OutOfScope',
  '- 自动加 label',
  '### RequiredSemantics',
  '- apply 只回写 canonical markdown',
  '### ReviewHints',
  '- 优先检查并发保护',
  '### Validation',
  '- `bun test apps/agent-daemon/src/issue-apply.test.ts`',
  '',
  '## RED 测试',
  '```ts',
  'expect(true).toBe(false)',
  '```',
  '',
  '## 实现步骤',
  '1. 先做远端并发保护',
  '',
  '## 验收',
  '- [ ] stale write 被阻止',
].join('\n')

describe('applyIssueBodyUpdate', () => {
  test('returns conflict when the remote issue changed after the expected timestamp', async () => {
    const result = await applyIssueBodyUpdate({
      issueNumber: 54,
      markdown: VALID_MARKDOWN,
      expectedUpdatedAt: '2026-04-11T10:00:00.000Z',
      config: { repo: 'owner/repo' } as never,
      fetchIssue: async () => ({
        number: 54,
        title: '[AL-14] apply',
        body: 'remote body',
        url: 'https://github.com/owner/repo/issues/54',
        updatedAt: '2026-04-11T10:05:00.000Z',
      }),
      updateIssueBody: async () => {
        throw new Error('should not patch on conflict')
      },
    })

    expect(result.status).toBe('conflict')
    expect(result.updated).toBe(false)
  })

  test('patches the remote issue only when the snapshot still matches expectations', async () => {
    const calls: string[] = []
    const result = await applyIssueBodyUpdate({
      issueNumber: 54,
      markdown: VALID_MARKDOWN,
      expectedUpdatedAt: '2026-04-11T10:00:00.000Z',
      config: { repo: 'owner/repo' } as never,
      fetchIssue: async () => ({
        number: 54,
        title: '[AL-14] apply',
        body: 'older body',
        url: 'https://github.com/owner/repo/issues/54',
        updatedAt: '2026-04-11T10:00:00.000Z',
      }),
      updateIssueBody: async ({ issueNumber, body }) => {
        calls.push(`patch:${issueNumber}`)
        expect(body).toBe(VALID_MARKDOWN)
        return {
          number: issueNumber,
          url: 'https://github.com/owner/repo/issues/54',
          updatedAt: '2026-04-11T10:06:00.000Z',
        }
      },
    })

    expect(calls).toEqual(['patch:54'])
    expect(result.status).toBe('updated')
    expect(result.updated).toBe(true)
    expect(result.newUpdatedAt).toBe('2026-04-11T10:06:00.000Z')
  })

  test('returns noop without patching when the remote body already matches', async () => {
    const result = await applyIssueBodyUpdate({
      issueNumber: 54,
      markdown: VALID_MARKDOWN,
      expectedUpdatedAt: '2026-04-11T10:00:00.000Z',
      config: { repo: 'owner/repo' } as never,
      fetchIssue: async () => ({
        number: 54,
        title: '[AL-14] apply',
        body: VALID_MARKDOWN,
        url: 'https://github.com/owner/repo/issues/54',
        updatedAt: '2026-04-11T10:05:00.000Z',
      }),
      updateIssueBody: async () => {
        throw new Error('should not patch when the body already matches')
      },
    })

    expect(result.status).toBe('noop')
    expect(result.updated).toBe(false)
    expect(result.newUpdatedAt).toBe('2026-04-11T10:05:00.000Z')
  })

  test('rejects invalid markdown before reading the remote issue', async () => {
    const result = await applyIssueBodyUpdate({
      issueNumber: 54,
      markdown: '## 用户故事\n只有用户故事',
      config: { repo: 'owner/repo' } as never,
      expectedUpdatedAt: '2026-04-11T10:00:00.000Z',
      fetchIssue: async () => {
        throw new Error('should not fetch the remote issue for invalid markdown')
      },
    })

    expect(result.status).toBe('invalid')
    expect(result.updated).toBe(false)
    expect(result.validation.valid).toBe(false)
    expect(formatIssueApplyResult(result, true)).toContain('"status": "invalid"')
  })
})
