# Issue Writing Spec

本文件定义当前仓库里会被 `agent-loop` 自动消费的 GitHub Issue 写法。目标不是“描述需求”，而是把 issue 写成 coding agent、reviewer、auto-fix、ready gate 都能共同依赖的可执行 contract。

## 目标

一个可执行 issue 必须同时满足：

- 人类能读懂
- agent 能稳定执行
- scheduler 能解析依赖
- reviewer 能据此判断 scope 和验收
- auto-fix 能据此修复 rejection，而不是靠猜

## Issue 分类

### Tracking Parent

用于跟踪拆分和排期：

- 可以概述目标、拆分、里程碑
- 通常不进入 `agent:ready`
- 通常不需要完整 RED 测试

### Executable Child

用于 daemon 真正消费：

- 必须是 execution-sized 的代码切片
- happy path 应该自然产生真实代码变更和真实 commit
- 必须写成完整 executable contract

## Canonical Child Issue Structure

每个 executable child issue 默认使用下面结构：

```md
## 用户故事

作为 <角色>，我希望 <能力>，从而 <业务价值>。

## Context

### Dependencies
```json
{
  "dependsOn": []
}
```

### Constraints
- 本次切片的约束、边界、禁止事项

### AllowedFiles
- 允许修改的精确文件或紧凑目录

### ForbiddenFiles
- 明确禁止修改的文件或目录

### MustPreserve
- 必须保持不变的已有行为、接口或状态语义

### OutOfScope
- 明确不在本 issue 内的后续工作

### RequiredSemantics
- 本 issue 完成后必须成立的行为

### ReviewHints
- reviewer 应优先检查的风险点

### Validation
- `自动化验证命令`
- `scope 或语义自检动作`

## RED 测试

```tsx
// 完整失败测试，agent 可直接复制
```

## 实现步骤

1. 先补 RED 测试
2. 再做最小实现
3. 最后跑验证并准备提交

## 验收

- [ ] 只修改 `AllowedFiles` 内文件
- [ ] `MustPreserve` 行为未回归
- [ ] `OutOfScope` 内容未混入
- [ ] RED 测试转绿
- [ ] 完成 `Validation` 中要求的验证
```

## Dependencies 规则

- 依赖信息只能放在 `## Context` -> `### Dependencies` 的 fenced JSON 里
- `dependsOn` 必须是 GitHub issue number 数组，不要写 URL
- 没有依赖时也必须显式写：

```json
{
  "dependsOn": []
}
```

- malformed JSON 视为 contract 错误，应阻止进入 `agent:ready`

## Executable Contract 规则

以下字段共同构成 executable contract：

- `AllowedFiles`
- `ForbiddenFiles`
- `MustPreserve`
- `OutOfScope`
- `RequiredSemantics`
- `ReviewHints`
- `Validation`

规则如下：

- `AllowedFiles` 要具体，不要写“前端相关文件”
- `ForbiddenFiles` 要覆盖那些最容易被顺手改坏的关键文件
- `MustPreserve` 要写成旧行为，不要写“保持现有逻辑”
- `OutOfScope` 要写 reviewer 容易误判成“应该一起做”的内容
- `RequiredSemantics` 要写成可判定的行为
- `Validation` 至少给一个自动化命令和一个 scope/行为自检动作

## Happy Path First

issue 设计先服务正常执行路径：

- 子 issue 必须是能产出代码的执行切片，不是阅读型或调查型任务
- RED 测试和实现步骤应该自然导向 commit
- parent issue / child issue / `dependsOn` 必须第一次就写对
- 不要先发布半成品 issue，指望后面补 metadata

如果一个 subtask 经常以 “no commit made” 结束，优先怀疑 issue 写作，而不是执行器。

## Ready Pool 规则

当父 issue 已经拆成 execution-sized child issues，且每个 child issue 的 `dependsOn` 已写准确：

- child issue 默认可以进入 `agent:ready`
- 是否可 claim 由 daemon 根据依赖完成状态判断
- 不要靠人工按顺序一个个切 ready

parent / epic issue 通常保持 tracking-only，不进入 `agent:ready`

## Ready 前自检

如果下面任意一项回答是“否”，就不应该进入 `agent:ready`：

- coding agent 能否只靠 issue body 完成任务？
- happy path 是否大概率产生真实代码变更和 commit？
- `dependsOn` 是否是最终正确值，且 JSON 合法？
- 允许改/禁止改的文件边界是否足够清晰？
- 必保语义和必达语义是否可观察、可验证？
- 是否明确写出了本 issue 不该混入的后续工作？
- `RED 测试` 是否包含完整失败测试，而不是 TODO？
- `实现步骤` 和 `验收` 是否与 contract 对齐？

## 推荐写法

如果你在 Codex 里起草 issue，优先使用全局 skill：

- `用 $issuewriting 写一个 agent-loop child issue`
- `用 $issuewriting 拆 parent issue 和 child issues，并补好 dependsOn`
- `用 $issuewriting 把这个 issue 改成可进 agent:ready 的 contract`
