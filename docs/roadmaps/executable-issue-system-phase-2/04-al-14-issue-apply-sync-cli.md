## 用户故事

作为仓库维护者，我希望把本地修好的 executable issue contract 安全回写到 GitHub 现有 issue，从而让 rewrite / repair 的结果真正进入远端事实状态，而不是停留在本地草稿。

## Context

### Dependencies
```json
{
  "dependsOn": [53]
}
```

### Constraints
- 本次切片只更新现有 GitHub issue body，不自动创建 issue、不自动拆 child issue、不自动改 label
- 回写前必须先做本地 contract 校验，拒绝把 invalid markdown 写到远端
- 远端写入必须带并发保护；不能在远端 issue 已经被别人更新后还静默覆盖

### AllowedFiles
- apps/agent-daemon/src/index.ts
- apps/agent-daemon/src/index.test.ts
- apps/agent-daemon/src/issue-apply.ts
- apps/agent-daemon/src/issue-apply.test.ts
- packages/agent-shared/src/github-api.ts
- packages/agent-shared/src/github-api.test.ts

### ForbiddenFiles
- apps/agent-daemon/src/daemon.ts
- apps/agent-daemon/src/ready-gate.ts
- apps/agent-daemon/src/dashboard.ts
- apps/agent-daemon/src/issue-splitter.ts

### MustPreserve
- 当远端 issue body 已与目标 markdown 完全一致时，apply 必须是 no-op，而不是重复 PATCH
- apply 成功前必须验证本地 markdown 是 executable contract；不能为“方便同步”放宽 contract 规则
- 本 issue 不得顺手改 `agent:*` labels、assignee、comment 或 ready gate 行为
- 发生并发冲突时必须显式失败并保留远端现状，不能静默覆盖

### OutOfScope
- 自动创建 parent / child issues
- 自动加 `agent:ready` 或自动触发 ready gate
- dashboard / metrics 观测
- review / repair 自动循环

### RequiredSemantics
- `agent-loop --apply-file <path> --issue <number> --repo owner/repo --expected-updated-at <iso>` 会先读取本地 markdown、做 contract 校验、再读取远端 issue snapshot，并在 `updatedAt` 与预期不一致时以 conflict 非 0 退出
- `--force` 可以显式绕过 `--expected-updated-at` 并发检查，但仍然必须保留本地 contract 校验
- 当远端 body 与本地 markdown 一致时，命令返回 `noop` 结果且不发出 PATCH
- 成功更新时，命令返回包含 issue number、issue url、old updatedAt、new updatedAt、status=`updated` 的稳定结果；`--json` 时必须输出单一 JSON 对象
- 回写实现必须走共享 GitHub API helper，而不是散落在 CLI 中直接拼 gh 命令

### ReviewHints
- 优先检查 apply 是否在 PATCH 前严格校验本地 markdown，而不是把远端当实验场
- 优先检查并发保护是否真的阻止了 stale write，而不是只打印 warning 继续覆盖
- 优先检查 no-op 路径是否跳过了 PATCH，避免无意义更新远端 `updatedAt`

### Validation
- `bun test apps/agent-daemon/src/issue-apply.test.ts apps/agent-daemon/src/index.test.ts packages/agent-shared/src/github-api.test.ts`
- `bun run typecheck`
- `git diff --stat origin/master...HEAD`

## RED 测试

```ts
import { describe, expect, test } from 'bun:test'
import { applyIssueBodyUpdate } from './issue-apply'

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
].join('\\n')

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
})
```

## 实现步骤

1. 先新增 `issue-apply.ts` 和测试，定义远端 snapshot 获取、stale-write 检查、no-op 判定与 body PATCH helper
2. 再在 shared GitHub API 层补共享的 issue body update primitive，并保证 CLI 不直接散落 gh PATCH 逻辑
3. 最后把 `--apply-file`、`--issue`、`--expected-updated-at`、`--force`、`--json` 接入 CLI，并串好退出码与结果输出

## 验收

- [ ] 只修改 `AllowedFiles` 内文件
- [ ] invalid markdown 不会被写回 GitHub
- [ ] stale write 会以 conflict 显式失败
- [ ] no-op 路径不会发出 PATCH
- [ ] RED 测试转绿
- [ ] 完成 `Validation` 中要求的验证
