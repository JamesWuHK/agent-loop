## 用户故事

作为仓库维护者，我希望 `agent-loop` 能把一条“接近可执行但仍有 lint / simulate 问题”的 issue contract 自动修成可执行合同，从而让高质量 issue 不只是靠第一次写对，还能进入持续 repair loop。

## Context

### Dependencies
```json
{
  "dependsOn": [50, 51]
}
```

### Constraints
- repair 必须复用现有 lint / simulate / repo-grounded authoring 能力，不要再造第三套 findings 或评分模型
- 本次切片只做本地 repair loop 与 CLI 输出，不写 GitHub issue body、不改 label、不触发 ready gate 状态变更
- repair 的 happy path 应该是“最小修正文案合同”，不是重写需求、拆 issue 或扩 scope

### AllowedFiles
- apps/agent-daemon/src/index.ts
- apps/agent-daemon/src/index.test.ts
- apps/agent-daemon/src/issue-authoring.ts
- apps/agent-daemon/src/issue-authoring.test.ts
- apps/agent-daemon/src/issue-repair.ts
- apps/agent-daemon/src/issue-repair.test.ts
- apps/agent-daemon/src/issue-simulate.ts
- apps/agent-daemon/src/issue-simulate.test.ts

### ForbiddenFiles
- packages/agent-shared/src/github-api.ts
- apps/agent-daemon/src/issue-splitter.ts
- apps/agent-daemon/src/ready-gate.ts
- apps/agent-daemon/src/dashboard.ts

### MustPreserve
- repair 成功后的输出仍然必须是 canonical executable contract markdown，而不是解释性 prose 或 JSON-only 结果
- 没有被 findings 指向的关键 metadata 不得被静默改坏，尤其是 `### Dependencies` fenced JSON、标题语义与已有 narrow scope
- repair 成功前必须再次经过本地 contract 校验；不能把“修了但仍不合法”的草稿当成功返回
- CLI 保持只读；本 issue 不得对 GitHub 远端 issue 做任何写操作

### OutOfScope
- 把 repair 结果写回 GitHub issue
- 自动创建 child issue 或回写 parent / child 拆分图
- dashboard / metrics 集成
- 自动恢复 `agent:ready` 或修改 daemon 调度状态

### RequiredSemantics
- `agent-loop --repair-file <path>` 会读取本地 issue markdown，先做 lint，再在显式传入 `--simulate` 时叠加 simulate findings，然后生成 repaired canonical markdown
- repair prompt 必须显式消费当前 issue body、lint errors / warnings、simulate findings、repo-grounded authoring context 与 project issue rules
- 当 repair 输出仍然失败本地 contract 校验，或在要求 `--simulate` 时仍失败 simulate，命令必须非 0 退出并暴露 blocking findings
- 默认 stdout 输出应是 repaired markdown 本体，便于后续人工审阅或交给 apply/sync CLI；`--json` 时输出稳定结果对象，至少包含 before/after validation、applied finding codes、final markdown
- repair 过程必须优先做最小修正，不能为了“修过 lint”而删除 `Dependencies`、宽化 `AllowedFiles`、或把具体 validation 改成泛泛描述

### ReviewHints
- 优先检查 repair 是否真正消费现有 lint / simulate findings，而不是重新猜问题
- 优先检查 repair 成功后的 markdown 是否仍保留 canonical section order 与机器可解析的 `Dependencies` JSON
- 优先检查 `--json` 是否既保留 final markdown，又暴露 before/after 结果，避免后续 apply/sync 无法复用

### Validation
- `bun test apps/agent-daemon/src/issue-repair.test.ts apps/agent-daemon/src/issue-authoring.test.ts apps/agent-daemon/src/issue-simulate.test.ts apps/agent-daemon/src/index.test.ts`
- `bun run typecheck`
- `git diff --stat origin/master...HEAD`

## RED 测试

```ts
import { describe, expect, test } from 'bun:test'
import { repairIssueDraft } from './issue-repair'

const BROKEN_ISSUE = [
  '## 用户故事',
  '作为维护者，我希望修复 issue contract。',
  '',
  '## Context',
  '### Dependencies',
  '```json',
  '{ "dependsOn": [50, 51] }',
  '```',
  '### AllowedFiles',
  '- frontend files',
  '### ForbiddenFiles',
  '- apps/agent-daemon/src/dashboard.ts',
  '### MustPreserve',
  '- `dependsOn` JSON 必须保持机器可解析',
  '### OutOfScope',
  '- GitHub 远端写回',
  '### RequiredSemantics',
  '- repair 结果必须仍然是 canonical markdown',
  '### ReviewHints',
  '- 优先检查是否偷偷删掉 Dependencies',
  '### Validation',
  '- 观察一下 issue 看起来是否更清楚',
  '',
  '## RED 测试',
  '```ts',
  'expect(true).toBe(false)',
  '```',
  '',
  '## 实现步骤',
  '1. 修一下',
  '',
  '## 验收',
  '- [ ] issue 更好一些',
].join('\\n')

const REPAIRED_ISSUE = [
  '## 用户故事',
  '作为维护者，我希望修复 issue contract，从而让 agent-loop 可以稳定消费高质量 issue。',
  '',
  '## Context',
  '### Dependencies',
  '```json',
  '{ "dependsOn": [50, 51] }',
  '```',
  '### Constraints',
  '- 只修 contract 本身，不写 GitHub 远端',
  '### AllowedFiles',
  '- apps/agent-daemon/src/issue-repair.ts',
  '- apps/agent-daemon/src/issue-repair.test.ts',
  '### ForbiddenFiles',
  '- apps/agent-daemon/src/dashboard.ts',
  '### MustPreserve',
  '- `dependsOn` JSON 必须保持机器可解析',
  '### OutOfScope',
  '- GitHub 远端写回',
  '### RequiredSemantics',
  '- repair 结果必须仍然是 canonical markdown',
  '### ReviewHints',
  '- 优先检查是否偷偷删掉 Dependencies',
  '### Validation',
  '- `bun test apps/agent-daemon/src/issue-repair.test.ts`',
  '- `git diff --stat origin/master...HEAD`',
  '',
  '## RED 测试',
  '```ts',
  'expect(true).toBe(false)',
  '```',
  '',
  '## 实现步骤',
  '1. 先让 repair flow 消费 findings',
  '',
  '## 验收',
  '- [ ] repair 输出通过本地 contract 校验',
].join('\\n')

describe('repairIssueDraft', () => {
  test('preserves dependency metadata while repairing lint and simulate findings', async () => {
    const result = await repairIssueDraft({
      issueText: BROKEN_ISSUE,
      repoRoot: '/repo',
      includeSimulation: true,
      lintReport: {
        valid: true,
        readyGateBlocked: false,
        readyGateStatus: 'pass',
        readyGateSummary: 'ok',
        score: 70,
        errors: [],
        warnings: [
          'AllowedFiles should use exact paths or tightly scoped directories: frontend files',
        ],
        source: { kind: 'file', path: 'broken.md' },
        contract: {} as never,
      },
      simulationResult: {
        valid: false,
        summary: 'simulation failed',
        failures: [
          'allowed file scope is too broad for reliable review/auto-fix: frontend files',
          'validation commands are too generic to confirm issue-specific semantics',
        ],
        findings: [
          {
            code: 'allowed_files_too_broad',
            stage: 'reviewer',
            message: 'allowed file scope is too broad for reliable review/auto-fix: frontend files',
          },
          {
            code: 'validation_too_generic',
            stage: 'reviewer',
            message: 'validation commands are too generic to confirm issue-specific semantics',
          },
        ],
        plannerPrompt: '',
        plannerOutput: '',
        plannedSubtasks: [],
      },
      runAgent: async () => ({
        responseText: REPAIRED_ISSUE,
      }),
    })

    expect(result.repairedMarkdown).toContain('{ "dependsOn": [50, 51] }')
    expect(result.appliedFindingCodes).toEqual([
      'allowed_files_too_broad',
      'validation_too_generic',
    ])
    expect(result.after.validation.valid).toBe(true)
    expect(result.after.simulation?.valid).toBe(true)
  })
})
```

## 实现步骤

1. 先新增 `issue-repair.ts` 与对应测试，定义 repair input/output、before/after report，以及基于 findings 的 repair prompt 生成
2. 再把 repair flow 接到现有 lint / simulate / authoring primitives 上，确保输出再次经过本地 validation，且在 `--simulate` 时补做 after-simulate
3. 最后在 CLI 中增加 `--repair-file`、`--simulate`、`--json` 的执行路径与退出码语义

## 验收

- [ ] 只修改 `AllowedFiles` 内文件
- [ ] repair 复用了现有 lint / simulate / authoring 能力，没有平行分叉实现
- [ ] repair 输出保留 canonical section order 和 `Dependencies` JSON
- [ ] CLI 仍是只读，不会写 GitHub issue 或 label
- [ ] RED 测试转绿
- [ ] 完成 `Validation` 中要求的验证
