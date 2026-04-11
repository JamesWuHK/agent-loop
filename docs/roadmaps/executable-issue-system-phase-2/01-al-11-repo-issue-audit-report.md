## 用户故事

作为仓库维护者，我希望用一个统一的 `agent-loop` CLI 批量审计 repo 内的 issue contract，并输出机器可读的质量报告，从而在 issue 进入 `agent:ready` 或进入商业化控制面之前，先拿到稳定的 repo-level 基线。

## Context

### Dependencies
```json
{
  "dependsOn": [36, 40]
}
```

### Constraints
- 复用 phase 1 已有的 quality / simulate 能力，不要重新发明另一套评分或 findings 逻辑
- 默认行为继续服务本地维护者排查，不要把现有 human-readable audit 输出直接删掉
- 审计命令本身必须只读，不能修改 issue body、label、comment 或 ready 状态

### AllowedFiles
- apps/agent-daemon/src/audit-issue-contracts.ts
- apps/agent-daemon/src/audit-issue-contracts.test.ts
- apps/agent-daemon/src/index.ts
- apps/agent-daemon/src/index.test.ts
- packages/agent-shared/src/github-api.ts
- packages/agent-shared/src/github-api.test.ts
- packages/agent-shared/src/types.ts

### ForbiddenFiles
- apps/agent-daemon/src/ready-gate.ts
- apps/agent-daemon/src/issue-authoring.ts
- apps/agent-daemon/src/issue-splitter.ts
- apps/agent-daemon/src/dashboard.ts

### MustPreserve
- 不带新参数时，现有审计命令仍然能以 human-readable 方式列出 managed issue 的 claimability 与 contract 问题
- 现有 `ready-gate` 的拦截语义不变；本 issue 只增加审计视图，不做状态变更
- issue quality score、warnings、simulation findings 必须来自已有共享逻辑，而不是第二套分叉实现

### OutOfScope
- 自动修复 issue contract
- 把审计结果直接写回 GitHub comment 或 label
- dashboard / metrics 可视化
- 历史趋势存储或 hosted analytics backend

### RequiredSemantics
- `agent-loop --audit-issues` 可以审计默认 open managed issues，也可以通过重复 `--issue <number>` 只审计显式 issue 集合
- `--json` 输出必须是稳定的单一 JSON 对象，包含 top-level summary 和 per-issue results，不能混入额外 human prose
- 审计结果必须暴露每条 issue 的 quality score、errors、warnings，以及在显式开启 `--simulate` 时附带的 simulation findings
- top-level summary 至少包含 audited issue 总数、invalid issue 数、invalid ready issue 数、low score issue 数、warning issue 数
- 当命令收到显式 issue 集合且其中存在 invalid contract 时，进程退出码必须非 0，便于 CI / control plane 直接消费

### ReviewHints
- 优先检查 CLI 是否真正复用了已有 quality / simulate 逻辑，避免 score 与 findings 在不同入口出现漂移
- 优先检查 `--json` 模式是否完全可机器解析，尤其不要混入日志前缀或 human-readable 段落
- 优先检查默认行为是否仍然对维护者友好，而不是只剩 JSON

### Validation
- `bun test apps/agent-daemon/src/audit-issue-contracts.test.ts apps/agent-daemon/src/index.test.ts packages/agent-shared/src/github-api.test.ts`
- `bun run typecheck`
- `git diff --stat origin/master...HEAD`

## RED 测试

```ts
import { describe, expect, test } from 'bun:test'
import { auditIssues, formatAuditOutput } from './audit-issue-contracts'

const VALID_CONTRACT = [
  '## 用户故事',
  '作为维护者，我希望批量审计 issue contract。',
  '',
  '## Context',
  '### Dependencies',
  '```json',
  '{ "dependsOn": [] }',
  '```',
  '### AllowedFiles',
  '- apps/agent-daemon/src/audit-issue-contracts.ts',
  '### ForbiddenFiles',
  '- apps/agent-daemon/src/dashboard.ts',
  '### MustPreserve',
  '- 默认 human-readable 输出仍可用',
  '### OutOfScope',
  '- dashboard 可视化',
  '### RequiredSemantics',
  '- 支持 repo-level 审计摘要',
  '### ReviewHints',
  '- 检查 JSON 输出是否稳定',
  '### Validation',
  '- `bun test apps/agent-daemon/src/audit-issue-contracts.test.ts`',
  '',
  '## RED 测试',
  '```ts',
  'expect(true).toBe(false)',
  '```',
  '',
  '## 实现步骤',
  '1. 增加 repo-level summary',
  '',
  '## 验收',
  '- [ ] repo-level summary 可用',
].join('\\n')

describe('auditIssues', () => {
  test('returns stable repo summary and issue quality findings in json mode', async () => {
    const result = await auditIssues({
      issues: [
        {
          number: 71,
          title: '[AL-X] invalid contract',
          body: '## 用户故事\\n只有用户故事',
          state: 'ready',
          labels: ['agent:ready'],
        },
        {
          number: 72,
          title: '[AL-Y] valid contract',
          body: VALID_CONTRACT,
          state: 'ready',
          labels: ['agent:ready'],
        },
      ],
      includeSimulation: false,
    })

    expect(result.summary).toEqual({
      auditedIssueCount: 2,
      invalidIssueCount: 1,
      invalidReadyIssueCount: 1,
      lowScoreIssueCount: 1,
      warningIssueCount: 0,
    })
    expect(result.issues[0]?.contract.errors).toContain('missing ### Dependencies JSON block')
    expect(JSON.parse(formatAuditOutput(result, true))).toMatchObject({
      summary: {
        invalidIssueCount: 1,
      },
      issues: [
        {
          number: 71,
          state: 'ready',
        },
      ],
    })
  })
})
```

## 实现步骤

1. 先把当前 audit 逻辑提炼成可复用的 repo-level report builder，并让测试先描述 summary / per-issue JSON 结构
2. 再补 `agent-loop --audit-issues` 的参数解析，支持默认 open managed issues、重复 `--issue` 过滤、`--json` 与可选 `--simulate`
3. 最后串好退出码、human-readable 输出兼容性与 typecheck

## 验收

- [ ] 只修改 `AllowedFiles` 内文件
- [ ] 默认 human-readable 审计输出仍可用
- [ ] `--json` 输出是稳定单一 JSON 对象
- [ ] phase 1 的 quality / simulate 逻辑被复用，没有平行分叉实现
- [ ] RED 测试转绿
- [ ] 完成 `Validation` 中要求的验证
