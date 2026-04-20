## 用户故事

作为项目维护者，我希望为当前 repo 声明 issue authoring rules，并让 rewrite / split 等 authoring 流程稳定消费这些规则，从而把 `agent-loop` 从 generic demo 提升成真正能落地到不同项目的自动化开发框架。

## Context

### Dependencies
```json
{
  "dependsOn": [37, 38, 39]
}
```

### Constraints
- 这次切片只做 project issue authoring rules 的 schema、聚合与 prompt 注入，不要顺手扩成 hosted profile registry
- repo 没有配置 ruleset 时，现有 rewrite / split 行为必须保持兼容
- 规则注入必须是 deterministic text / candidate merge，不能引入额外网络依赖

### AllowedFiles
- packages/agent-shared/src/types.ts
- packages/agent-shared/src/project-profile.ts
- packages/agent-shared/src/project-profile.test.ts
- apps/agent-daemon/src/issue-authoring-context.ts
- apps/agent-daemon/src/issue-authoring-context.test.ts
- apps/agent-daemon/src/issue-authoring.ts
- apps/agent-daemon/src/issue-authoring.test.ts
- apps/agent-daemon/src/issue-splitter.ts
- apps/agent-daemon/src/issue-splitter.test.ts

### ForbiddenFiles
- apps/agent-daemon/src/issue-simulate.ts
- apps/agent-daemon/src/ready-gate.ts
- apps/agent-daemon/src/dashboard.ts
- packages/agent-shared/src/github-api.ts

### MustPreserve
- 现有 built-in project prompt guidance 顺序和默认行为不变
- repo 没有 issue authoring ruleset 配置时，candidate validation commands / allowed files / forbidden files 的扫描逻辑保持现状
- rewrite / split 依旧必须对 agent 输出做本地 contract 校验，不能因为加入 ruleset 就放宽

### OutOfScope
- hosted policy marketplace
- 可视化编辑 ruleset 的 UI
- issue repair / apply CLI
- runtime dashboard / metrics 集成

### RequiredSemantics
- `ProjectProfileConfig` 可以声明 issue authoring rules，至少覆盖 preferred validation commands、preferred allowed files、forbidden paths、review hints
- `buildRepoAuthoringContext` 会把 project rules 与 repo 扫描结果合并成稳定输出，且不会丢掉 repo-grounded candidates
- rewrite / split prompts 必须显式展示 project issue rules，让 agent 知道哪些路径、命令、review concerns 属于 repo 约束
- 当 ruleset 未配置时，authoring context 与 prompt 内容应保持当前兼容，不出现空标题或占位噪音

### ReviewHints
- 优先检查 ruleset merge 是否 deterministic，避免同一 repo 在不同机器或不同顺序下得到不稳定 prompt
- 优先检查无配置路径的兼容性，尤其不要让 prompt 注入一堆空 section
- 优先检查 preferred / forbidden path 是否真正进入 prompt，而不是只停留在 config types

### Validation
- `bun test packages/agent-shared/src/project-profile.test.ts apps/agent-daemon/src/issue-authoring-context.test.ts apps/agent-daemon/src/issue-authoring.test.ts apps/agent-daemon/src/issue-splitter.test.ts`
- `bun run typecheck`
- `git diff --stat origin/master...HEAD`

## RED 测试

```ts
import { describe, expect, test } from 'bun:test'
import { buildRepoAuthoringContext } from './issue-authoring-context'
import { buildIssueRewritePrompt } from './issue-authoring'

describe('project issue authoring rules', () => {
  test('merges project rules into authoring context and rewrite prompts', async () => {
    const context = await buildRepoAuthoringContext({
      repoRoot: '/repo',
      issueText: '增加 issue repair CLI',
      repoRelativeFilePaths: [
        'apps/agent-daemon/src/issue-repair.ts',
        'apps/agent-daemon/src/issue-repair.test.ts',
        'apps/agent-daemon/src/dashboard.ts',
      ],
      project: {
        profile: 'generic',
        issueAuthoring: {
          preferredValidationCommands: [
            'bun test apps/agent-daemon/src/issue-repair.test.ts',
          ],
          preferredAllowedFiles: [
            'apps/agent-daemon/src/issue-repair.ts',
            'apps/agent-daemon/src/issue-repair.test.ts',
          ],
          forbiddenPaths: [
            'apps/agent-daemon/src/dashboard.ts',
          ],
          reviewHints: [
            '优先检查 repair 流程是否保留合法的 Dependencies JSON',
          ],
        },
      },
    })

    const prompt = buildIssueRewritePrompt({
      issueText: '增加 issue repair CLI',
      authoringContext: context,
    })

    expect(context.candidateValidationCommands).toContain(
      'bun test apps/agent-daemon/src/issue-repair.test.ts',
    )
    expect(context.candidateAllowedFiles.slice(0, 2)).toEqual([
      'apps/agent-daemon/src/issue-repair.ts',
      'apps/agent-daemon/src/issue-repair.test.ts',
    ])
    expect(context.candidateForbiddenFiles).toContain('apps/agent-daemon/src/dashboard.ts')
    expect(prompt).toContain('Project Issue Rules')
    expect(prompt).toContain('优先检查 repair 流程是否保留合法的 Dependencies JSON')
  })
})
```

## 实现步骤

1. 先在 shared types / project profile 中定义最小 issue authoring rules schema，并让测试先约束 merge 后的 authoring context 结果
2. 再让 `buildRepoAuthoringContext` 把 preferred validation commands、preferred allowed files、forbidden paths、review hints 合并进稳定候选集
3. 最后更新 rewrite / split prompt builder，让 project issue rules 明确进入 prompt，并验证无配置路径兼容

## 验收

- [ ] 只修改 `AllowedFiles` 内文件
- [ ] 无 ruleset 配置时的 rewrite / split 行为保持兼容
- [ ] project issue rules 会稳定进入 authoring context 与 prompt
- [ ] repo-grounded candidates 没有因为 ruleset 注入而丢失
- [ ] RED 测试转绿
- [ ] 完成 `Validation` 中要求的验证
