## 用户故事

作为维护者或团队负责人，我希望在 dashboard 和 metrics 里直接看到 issue contract 质量信号，从而区分“daemon / runtime 出问题”和“issue harness 本身在积累质量债”。

## Context

### Dependencies
```json
{
  "dependsOn": [50]
}
```

### Constraints
- 复用已有 audit / quality 报告逻辑，不要在 dashboard 或 metrics 里重算另一套 score 规则
- 不能把 planner simulate 放进 daemon 热路径；issue ops 观测必须基于已有 issue body 数据与静态质量检查
- 新增观测不能破坏现有 dashboard 的 machine / lease / PR 视图，也不能让 metrics endpoint 因 issue 质量采集失败而不可抓取

### AllowedFiles
- apps/agent-daemon/src/audit-issue-contracts.ts
- apps/agent-daemon/src/dashboard.ts
- apps/agent-daemon/src/dashboard.test.ts
- apps/agent-daemon/src/daemon.ts
- apps/agent-daemon/src/daemon.test.ts
- apps/agent-daemon/src/metrics.ts
- apps/agent-daemon/src/metrics.test.ts

### ForbiddenFiles
- apps/agent-daemon/src/issue-authoring.ts
- apps/agent-daemon/src/issue-repair.ts
- apps/agent-daemon/src/issue-apply.ts
- packages/agent-shared/src/github-api.ts

### MustPreserve
- 现有 dashboard summary、machine cards、PR 视图与 runtime observability 语义不变
- metrics endpoint 在 issue ops 数据暂时不可用时仍必须正常暴露其他指标
- issue ops 计数必须来自已有 issue quality report / managed issue 列表，而不是额外逐条 GitHub 请求
- 本 issue 不得顺手加入 GitHub 写操作、auto-fix、repair 或 apply 行为

### OutOfScope
- hosted analytics、历史趋势图、团队级报表
- 自动修 issue 或自动回写 GitHub
- per-issue planner simulate dashboard
- 告警路由、值班集成或商业计费逻辑

### RequiredSemantics
- dashboard summary 必须新增至少三类 issue ops 计数：`invalidReadyIssueCount`、`lowScoreIssueCount`、`warningIssueCount`
- dashboard 的 issue 视图必须暴露每条 issue 的 quality score、warning count，以及 ready gate 是否会因为 hard validation 被阻塞
- daemon metrics 必须新增对应 gauges，至少覆盖 invalid ready、low score、warning issue 三类 repo-level 计数
- 这些 gauges 必须在 daemon 现有 open issue poll / reconcile 路径中更新，且只基于已拿到的 issue body 做静态质量计算，不额外跑 simulate planner
- 当某次 issue ops 数据刷新失败时，dashboard 应把失败写进 notes / errors，而不是整页不可用；metrics 刷新失败不应影响其他指标输出

### ReviewHints
- 优先检查 dashboard 与 metrics 是否复用了同一套 quality summary，避免两个入口的数字漂移
- 优先检查 daemon 热路径是否没有偷偷加进昂贵的 simulate / planner 调用
- 优先检查 issue 视图新增字段是否真的帮助定位“是 issue 质量差还是 runtime 坏了”

### Validation
- `bun test apps/agent-daemon/src/dashboard.test.ts apps/agent-daemon/src/daemon.test.ts apps/agent-daemon/src/metrics.test.ts`
- `bun run typecheck`
- `git diff --stat origin/master...HEAD`

## RED 测试

```ts
import { describe, expect, test } from 'bun:test'
import { buildDashboardIssueOpsSummary } from './dashboard'
import { registry, setIssueOpsSummaryMetrics } from './metrics'

describe('issue ops observability', () => {
  test('derives dashboard summary counts from audited issue quality data', async () => {
    const summary = buildDashboardIssueOpsSummary([
      {
        number: 50,
        title: '[AL-11] audit',
        state: 'ready',
        isClaimable: true,
        hasExecutableContract: false,
        claimBlockedBy: [],
        contractValidationErrors: ['missing ## RED 测试 / RED Tests'],
        qualityScore: 40,
        contractWarnings: [],
      },
      {
        number: 53,
        title: '[AL-13] repair',
        state: 'ready',
        isClaimable: true,
        hasExecutableContract: true,
        claimBlockedBy: [],
        contractValidationErrors: [],
        qualityScore: 75,
        contractWarnings: ['AllowedFiles should use exact paths or tightly scoped directories: frontend files'],
      },
    ])

    expect(summary).toEqual({
      invalidReadyIssueCount: 1,
      lowScoreIssueCount: 2,
      warningIssueCount: 1,
    })

    setIssueOpsSummaryMetrics(summary)
    const metrics = await registry.metrics()
    expect(metrics).toContain('agent_loop_issue_contract_invalid_ready 1')
    expect(metrics).toContain('agent_loop_issue_contract_warning_issues 1')
    expect(metrics).toContain('agent_loop_issue_contract_low_score_issues 2')
  })
})
```

## 实现步骤

1. 先把 issue quality summary 提炼成 dashboard / daemon / metrics 可复用的轻量 helper，并让测试先固定 summary 计数语义
2. 再把这些 summary 字段接入 dashboard summary 和 issue 视图，保证页面在 issue ops 数据失败时仍然能显示其他 runtime 内容
3. 最后在 daemon 现有 issue poll / reconcile 路径中更新 Prometheus gauges，并完成 metrics / daemon 回归测试

## 验收

- [ ] 只修改 `AllowedFiles` 内文件
- [ ] dashboard 与 metrics 复用了同一套 issue quality summary
- [ ] daemon 热路径没有新增 planner simulate 调用
- [ ] dashboard 可以直接看出 invalid ready、low score、warning issue 的 repo-level 状态
- [ ] RED 测试转绿
- [ ] 完成 `Validation` 中要求的验证
