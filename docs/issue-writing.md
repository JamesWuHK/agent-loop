# Issue Writing Spec

This document defines the canonical GitHub Issue format for repositories driven by Agent Loop.

## Goal

Agent Loop consumes GitHub Issues as executable work items. For reliable planning and scheduling, issue bodies must be:

- readable by humans
- stable for agents
- parseable for dependency-aware claiming

## Required Structure

Every executable issue should follow this structure:

```md
## 用户故事
[业务需求 / 用户价值]

## Context
### Dependencies
```json
{
  "dependsOn": []
}
```

### Constraints
- [约束 / 禁止事项 / 范围限制]
- [可选：涉及文件、不可修改区域、实现边界]

## RED 测试
```typescript
[完整测试代码，agent 可直接复制到测试文件]
```

## 实现步骤
1. [步骤1]
2. [步骤2]
3. [步骤3]

## 验收
- [ ] 运行测试，确认 FAIL（RED）
- [ ] 完成最小实现
- [ ] 运行测试，确认 PASS（GREEN）
- [ ] 完成 git commit
```

## Dependencies Format

Dependency metadata lives inside `## Context` -> `### Dependencies` as a fenced JSON block.

Example:

```md
## Context
### Dependencies
```json
{
  "dependsOn": [123, 124]
}
```
```

### Rules

- `dependsOn` must be an array of GitHub issue numbers
- all listed dependencies must be completed before this issue is claimable
- use issue numbers only, not URLs
- if there are no dependencies, use:

```json
{
  "dependsOn": []
}
```

## Semantics

- missing `## Context` on legacy issues is tolerated by the scheduler
- missing `### Dependencies` is treated as no dependencies
- malformed dependency JSON is treated as configuration error and should block claiming until fixed

## Constraints Section

Use `### Constraints` to record information that should shape implementation but does not affect scheduling, for example:

- allowed files
- prohibited files
- non-goals
- implementation boundaries
- required interfaces or invariants

## Authoring Guidance

Good issues are:

- small enough to finish in one focused implementation loop
- explicit about RED tests
- explicit about constraints
- explicit about dependencies when another issue must land first

Avoid:

- mixing multiple unrelated deliverables in one issue
- relying on hidden context outside the issue body
- putting dependency information only in comments or labels

## Minimal Example

```md
## 用户故事
作为用户，我希望登录状态能被安全保存，这样我重启应用后无需重复登录。

## Context
### Dependencies
```json
{
  "dependsOn": [35]
}
```

### Constraints
- 只修改 apps/desktop/src-tauri/src/*
- 不要改动前端登录流程

## RED 测试
```rust
// failing test here
```

## 实现步骤
1. 添加 keychain 读写测试
2. 实现持久化逻辑
3. 注册 Tauri 命令

## 验收
- [ ] cargo test 先失败
- [ ] 实现通过测试
- [ ] 提交 commit
```

## Recommendation for Future Skill Prompts

Any future issue-writing skill or prompt in Agent Loop should emit this exact structure by default so scheduling and execution stay aligned.
