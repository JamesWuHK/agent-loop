# Roadmaps

这些 roadmap 记录 issue harness 的本地演进切片，不重新定义 GitHub 上的 issue schema。

## Issue Harness

- [Issue Harness Phase 1](./issue-harness-phase-1/README.md)

`Sprint Contract` 属于 issue harness 的本地 durable artifact：它从 issue body 派生，服务于单次 attempt 的 planner / executor / evaluator / recovery 协作，不替代远端 issue body，也不会把本地 contract 回写到 GitHub。
