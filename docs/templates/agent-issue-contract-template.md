# Agent Issue Contract Template

用于会被 `agent-loop` 自动消费的 execution-sized issue。目标不是“写清楚一点”，而是把 issue 写成 agent、reviewer、auto-fix 都能执行的合同。

推荐先读 [issue-writing.md](../issue-writing.md)，或直接使用全局 skill：`$issuewriting`。

## 标题

`[USX-N] 任务标题`

## 模板

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
- 只能做这次切片所需的最小改动
- 不要修改无关模块

### AllowedFiles
- apps/example-app/src/context/AppContext.tsx
- apps/example-app/src/pages/LoginPage.tsx

### ForbiddenFiles
- apps/example-app/src/App.tsx
- apps/example-app/src/lib/api.ts

### MustPreserve
- `navigate('/main')` 仍然要同步更新 `currentPath`
- 未登录时不允许看到主界面内容

### OutOfScope
- token 持久化
- 真实 API 登录
- gateway / shell 行为扩展

### RequiredSemantics
- 未登录进入桌面壳时只渲染 `/login`
- 本 issue 不得新增 API / persistence 副作用

### ReviewHints
- 优先检查 route guard 是否被偷偷挪到别处
- 优先检查是否为了过 review 擅自改掉 issue 明确要求的语义

### Validation
- `bun --cwd apps/example-app test src/App.test.tsx`
- `git diff --stat origin/<default-branch>...HEAD`

## RED 测试

```tsx
// 贴完整失败测试
```

## 实现步骤

1. 先补最小状态接口
2. 再接最小页面渲染
3. 最后跑 issue 内要求的验证

## 验收

- [ ] 只修改 `AllowedFiles` 内文件
- [ ] `MustPreserve` 行为未回归
- [ ] `OutOfScope` 内容没有偷偷混进来
- [ ] RED 测试转绿
```

## 写作要求

- `AllowedFiles` 要尽量具体，不要只写“前端相关文件”
- `ForbiddenFiles` 要覆盖那些“很容易顺手改坏”的关键文件
- `MustPreserve` 要写旧语义，不要只写“不要破坏现有逻辑”
- `OutOfScope` 要写 reviewer 容易误判成“应该一起做”的内容
- `RequiredSemantics` 要写成可判定的行为，不要写成模糊愿景
- `Validation` 至少给一个自动化命令和一个 scope 自检动作

## 判定标准

如果 reviewer 拿着 issue 仍然会问下面这些问题，说明 contract 还不够：

- 哪些文件可以改，哪些绝对不能改？
- 哪些行为必须保持原样？
- 哪些后续工作不能因为“顺手”被混进来？
- 如果 review 被打回，auto-fix 应该修什么，又绝不能怎么修？
