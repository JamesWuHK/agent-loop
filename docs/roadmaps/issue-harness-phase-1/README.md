# Issue Harness Phase 1

Phase 1 先建立 issue attempt 的本地 durable contract，不在这一阶段接入 planner、executor 或 daemon 主流程。

## Sprint Contract

`Sprint Contract` 是 worktree 内 `.agent-loop/sprint-contract.json` 的本地 artifact。它由当前 issue body 派生，保存这一轮 attempt 最小但可执行的 contract：

- `artifactVersion`
- `issueNumber`
- `issueTitle`
- `attemptKind`
- `objective`
- `allowedFiles`
- `requiredSemantics`
- `validationCommands`
- `plannedSteps`
- `createdAt`

首批 `attemptKind` vocabulary 固定为：

- `fresh-claim`
- `issue-recovery`
- `review-auto-fix`

## Scope Boundary

- GitHub issue body 仍然是任务语义的权威来源
- `Sprint Contract` 只是在本地落盘的派生 snapshot，不是新的远端 issue schema
- 缺少本地 artifact 时，后续流程应该返回 `null` 或 empty state，而不是把 daemon 直接打崩
