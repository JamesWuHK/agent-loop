# Issue Writing Spec

This document defines the canonical GitHub Issue format for repositories driven by Agent Loop.

Agent Loop should consume issues as executable contracts, not loose task descriptions.

## Goal

For reliable planning, scheduling, review, and auto-fix, an executable issue must be:

- readable by humans
- stable for agents
- parseable for dependency-aware claiming
- specific enough for reviewer scope checks
- structured enough for rejection feedback to map back to the issue contract

## Issue Types

### Tracking parent

Use parent issues to track decomposition, milestones, and rollout order.

- usually do not need full RED tests
- usually should not enter `agent:ready`
- usually exist to coordinate child issues

### Executable child

Use child issues for daemon-consumable implementation slices.

- must be execution-sized
- must normally produce a real code change and a real commit on the happy path
- must include the full executable contract below

## Canonical Child Structure

Every executable child issue should follow this structure:

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

### AllowedFiles
- [允许修改的精确文件或目录]

### ForbiddenFiles
- [明确禁止修改的文件或目录]

### MustPreserve
- [必须保持不变的已有行为、接口或状态语义]

### OutOfScope
- [明确不在本 issue 内的后续工作]

### RequiredSemantics
- [本 issue 完成后必须成立的行为]

### ReviewHints
- [reviewer 应优先检查的风险点]

### Validation
- `自动化验证命令`
- `scope 或语义自检动作`

## RED 测试
```typescript
[完整失败测试，agent 可直接复制到测试文件]
```

## 实现步骤
1. [步骤1]
2. [步骤2]
3. [步骤3]

## 验收
- [ ] 只修改 `AllowedFiles` 内文件
- [ ] `MustPreserve` 行为未回归
- [ ] `OutOfScope` 内容没有混入
- [ ] RED 测试转绿
- [ ] 完成 `Validation` 中要求的验证
```

## Dependencies Rules

Dependency metadata lives inside `## Context` -> `### Dependencies` as a fenced JSON block.

Rules:

- `dependsOn` must be an array of GitHub issue numbers
- use issue numbers only, not URLs
- all listed dependencies must be completed before the issue is claimable
- if there are no dependencies, use:

```json
{
  "dependsOn": []
}
```

- malformed dependency JSON is a configuration error and should block `agent:ready`

## Executable Contract Rules

These fields form the executable contract:

- `AllowedFiles`
- `ForbiddenFiles`
- `MustPreserve`
- `OutOfScope`
- `RequiredSemantics`
- `ReviewHints`
- `Validation`

Write them as hard boundaries, not fuzzy guidance.

Good examples:

- precise file paths, not "frontend files"
- observable old behavior, not "keep existing logic"
- concrete future exclusions, not "avoid scope creep"
- exact validation commands, not "run tests"

## Authoring Guidance

Good executable issues are:

- small enough to finish in one focused implementation loop
- explicit about RED tests
- explicit about constraints and file boundaries
- explicit about dependencies when another issue must land first
- accurate on first publish: parent issue, child issue, and `dependsOn` values should be correct before the daemon starts consuming them
- scoped so the happy path should normally produce a real code change and a real commit

Avoid:

- mixing multiple unrelated deliverables in one issue
- relying on hidden context outside the issue body
- putting dependency information only in comments or labels
- publishing placeholder, partial, or malformed issue bodies and planning to fix them later
- splitting work so finely that a "subtask" is likely to produce no code change and therefore no commit

## Happy Path First

When writing parent issues and child issues, optimize first for the normal execution path:

- the issue body should be correct the first time
- the child issue should describe a code-producing slice, not a reading-only or investigation-only slice
- the RED test and implementation steps should naturally lead to a commit if the task is valid
- only after the happy path is solid should you add handling for unusual cases

If a subtask frequently ends with "no commit made", that is usually a task-authoring problem before it is an execution-engine problem.

## Ready Labeling and Daemon Scheduling

When a parent issue has already been decomposed into execution-sized child issues, and each child issue has correct `dependsOn` metadata:

- child issues should normally be labeled `agent:ready` immediately
- the daemon should decide claimability from dependency state, not from manual sequential ready toggling
- parent issues should usually remain tracking-only and do not need `agent:ready`

## Ready Checklist

Do not put a child issue into `agent:ready` if any answer below is "no":

- Can a coding agent complete this without hidden context?
- Would the happy path likely create a real code change and commit?
- Are dependencies final and valid JSON?
- Are allowed and forbidden files explicit?
- Are preserved behaviors and required semantics observable?
- Is future work clearly excluded?
- Does the RED test contain concrete failing test code?
- Do implementation steps and acceptance criteria align with the contract?

## Recommendation for Future Skill Prompts

Any issue-writing skill or prompt used with Agent Loop should emit this structure by default so scheduling, review, and auto-fix stay aligned.
