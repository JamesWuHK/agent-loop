# Executable Issue System Phase 2

这组文件把 phase 2 roadmap 拆成可直接提交到 GitHub 的独立 issue body。

创建这组 issue 时，GitHub 实际分配的编号是：

- `#49` `[AL-EPIC] Executable Issue System Phase 2`
- `#50` `[AL-11] 增加 repo issue audit report CLI 与 JSON 输出`
- `#51` `[AL-12] 支持 project issue authoring profile / ruleset 注入`
- `#53` `[AL-13] 增加 issue repair CLI 并消费 lint / simulate findings`
- `#54` `[AL-14] 增加 issue apply / sync CLI 安全回写 GitHub`
- `#55` `[AL-15] 在 dashboard / metrics 中暴露 issue ops 信号`

注意：

- GitHub 的 issue 编号与 PR 共用同一套序号
- 因此 phase 2 的 issue 编号中跳过了 `#52`，因为它已经被 PR `#52` 占用
- 这份目录里的 markdown 现在已经按真实 issue 编号写好，可以继续作为 roadmap source of truth 维护

文件说明：

- [00-parent-epic.md](/Users/wujames/.agent-worktrees/JamesWuHK-agent-loop/roadmap-phase2-codex-dev/docs/roadmaps/executable-issue-system-phase-2/00-parent-epic.md)
- [01-al-11-repo-issue-audit-report.md](/Users/wujames/.agent-worktrees/JamesWuHK-agent-loop/roadmap-phase2-codex-dev/docs/roadmaps/executable-issue-system-phase-2/01-al-11-repo-issue-audit-report.md)
- [02-al-12-project-authoring-ruleset.md](/Users/wujames/.agent-worktrees/JamesWuHK-agent-loop/roadmap-phase2-codex-dev/docs/roadmaps/executable-issue-system-phase-2/02-al-12-project-authoring-ruleset.md)
- [03-al-13-issue-repair-cli.md](/Users/wujames/.agent-worktrees/JamesWuHK-agent-loop/roadmap-phase2-codex-dev/docs/roadmaps/executable-issue-system-phase-2/03-al-13-issue-repair-cli.md)
- [04-al-14-issue-apply-sync-cli.md](/Users/wujames/.agent-worktrees/JamesWuHK-agent-loop/roadmap-phase2-codex-dev/docs/roadmaps/executable-issue-system-phase-2/04-al-14-issue-apply-sync-cli.md)
- [05-al-15-issue-ops-dashboard-metrics.md](/Users/wujames/.agent-worktrees/JamesWuHK-agent-loop/roadmap-phase2-codex-dev/docs/roadmaps/executable-issue-system-phase-2/05-al-15-issue-ops-dashboard-metrics.md)

建议执行顺序：

1. `#50` `AL-11`
2. `#51` `AL-12`
3. `#53` `AL-13`
4. `#54` `AL-14`
5. `#55` `AL-15`

依赖提示：

- `#53` 依赖 `#50` 与 `#51`
- `#54` 依赖 `#53`
- `#55` 只依赖 `#50`

这意味着 `#55` 在依赖图上可以与 `#51` / `#53` / `#54` 并行推进；如果想保持 phase 2 叙事更集中，仍然建议把它放在后面执行。
