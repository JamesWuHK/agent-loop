## 背景

`agent-loop` 要成为长期有用的自动化开发框架，核心不只是“能跑 issue”，而是“能把需求稳定收敛成 agent 可执行、review 可判定、auto-fix 可修复的合同”。

Anthropic 关于 long-running apps 的文章给我们的直接启发是：长期运行的 agent 系统，可靠性主要来自 harness 设计，而不是某一次 prompt 运气够好。对 `agent-loop` 来说，这个 harness 的最前置边界就是 issue contract：

- 它是 planning 的输入，不是附属文档
- 它是 review / repair / ready gate 的共享状态面，不是单次 agent 提示词
- 它必须可观察、可修复、可回写，而不是只在创建那一刻“看起来写得不错”

phase 1 已经把单点能力链补齐：

- issue quality / lint
- repo-grounded authoring context
- rewrite 模糊 issue 为 executable contract
- split tracking parent 为 execution-sized child issues
- simulate issue 的可执行性，而不只做静态模板检查

phase 2 要做的是把这条能力链变成 issue ops system，也就是 `agent-loop` 的 spec control plane。

## 设计启发

- 长时运行的 agent app 需要 durable、inspectable、repairable 的状态面；issue contract 就是 `agent-loop` 的 durable spec state
- “先审计、再修复、再同步、再观测”的闭环，比“多调 prompt”更接近工程系统
- repo / project 的局部规则必须进入 authoring harness；否则开源框架只能停在 generic demo，无法稳定落到真实团队
- 如果 issue 质量不能持续量化，commercial control plane 也就没有可收费的运营抓手

## 目标

- 把 phase 1 的 authoring primitives 升级为 repo 级 issue operations 闭环
- 让 maintainer 可以批量审计 issue pool，而不是逐条肉眼判断
- 让 repo / project 的 issue authoring rules 能稳定注入 rewrite / split / repair 流程
- 把 lint / simulate findings 转成可执行 repair loop，而不是只能报错
- 把修好的 contract 安全回写 GitHub，避免“本地改好了、线上 issue 还是旧的”
- 在 dashboard / metrics 中暴露 issue quality drift，让 issue 质量成为可运营信号

## Open Source 与商业价值

- 开源基线：
  本地 CLI、repo 规则、repair loop、GitHub 安全回写、dashboard / metrics
- 商业延展：
  org 级 policy packs、跨 repo 质量基线、团队审批流、历史趋势、托管控制面

## 成功指标

- `agent:ready` issue 的 invalid / rewrite-before-run 比例持续下降
- `no commit made` 与 scope 漂移的失败率相对 phase 1 基线继续下降
- 从模糊 issue 到 ready contract 的中位耗时继续下降
- repo 能显式声明自己的 issue authoring rules，并被 rewrite / repair 流程消费
- dashboard / metrics 能直接指出“是 runtime 坏了”还是“issue contract 坏了”

## 子 Issue 规划

- `#50` `[AL-11]` 增加 repo issue audit report CLI 与 JSON 输出
- `#51` `[AL-12]` 支持 project issue authoring profile / ruleset 注入
- `#53` `[AL-13]` 增加 issue repair CLI 并消费 lint / simulate findings
- `#54` `[AL-14]` 增加 issue apply / sync CLI 安全回写 GitHub
- `#55` `[AL-15]` 在 dashboard / metrics 中暴露 issue ops 信号

## 执行顺序

1. 先完成 `#50`，拿到 repo 级质量视图和机器可读输出
2. 再完成 `#51`，把 repo / project 规则注入 authoring harness
3. 再完成 `#53`，把 findings 转成 repair loop
4. 再完成 `#54`，把本地修好的 contract 安全回写 GitHub
5. 最后完成 `#55`，把 issue quality drift 变成可观测信号

## 非目标

- 本 epic 不做 hosted SaaS、多租户 RBAC、账单或 org 管理后台
- 本 epic 不改 daemon 的核心 claim / worktree / merge 主流程
- 本 epic 不实现完整 parent -> child issue 自动创建流水线
- 本 epic 不做 browser evaluator 或新的 runtime sandbox

## 验收

- [ ] 五个 child issue 都是 execution-sized，并且 `dependsOn` 最终准确
- [ ] 每个 child issue 的 happy path 都会自然产出真实代码改动与 commit
- [ ] phase 2 能形成 issue 审计、修复、同步、观测的闭环
- [ ] 这组能力既能作为开源版核心价值，也能自然承接商业化控制面
