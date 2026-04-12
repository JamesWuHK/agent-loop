import { describe, expect, test } from 'bun:test'
import {
  buildIssueRewritePrompt,
  normalizeIssueRewriteMarkdown,
  rewriteIssueDraft,
} from './issue-authoring'

describe('rewriteIssueDraft', () => {
  test('falls back to an empty authoring context when repoRoot does not exist', async () => {
    const output = await rewriteIssueDraft({
      issueText: '修复 ready gate 对 Validation 缺失路径的提示，并补测试',
      repoRoot: '/tmp/nonexistent-agent-loop-repo',
      runAgent: async () => ({
        responseText: `## 用户故事

作为 维护者，我希望 ready gate 能明确指出 validation 引用缺失的路径，从而更快修复不可执行 issue。

## Context

### Dependencies
\`\`\`json
{"dependsOn":[]}
\`\`\`

### Constraints
- 只修 ready gate 的 validation path 提示

### AllowedFiles
- apps/agent-daemon/src/ready-gate.ts
- apps/agent-daemon/src/ready-gate.test.ts

### ForbiddenFiles
- apps/agent-daemon/src/daemon.ts

### MustPreserve
- 已有 hard validation 错误语义保持不变

### OutOfScope
- issue simulate

### RequiredSemantics
- 缺失路径时错误里包含 repo-relative path

### ReviewHints
- 检查 path 解析是否只影响 validation target 分支

### Validation
- \`bun test apps/agent-daemon/src/ready-gate.test.ts\`
- \`git diff --stat origin/main...HEAD\`

## RED 测试

\`\`\`ts
throw new Error('red')
\`\`\`

## 实现步骤

1. 先补失败测试
2. 再补最小实现
3. 最后跑验证

## 验收

- [ ] 只改 ready gate 相关文件
- [ ] RED 测试转绿`,
      }),
    })

    expect(output.validation.valid).toBe(true)
    expect(output.markdown.startsWith('## 用户故事')).toBe(true)
  })

  test('returns canonical executable contract markdown validated against local rules', async () => {
    let capturedPrompt = ''

    const output = await rewriteIssueDraft({
      issueText: '修复 ready gate 对 Validation 缺失路径的提示，并补测试',
      repoRoot: '/tmp/repo',
      buildAuthoringContext: async () => ({
        candidateValidationCommands: [
          'bun test apps/agent-daemon/src/ready-gate.test.ts',
        ],
        candidateAllowedFiles: [
          'apps/agent-daemon/src/ready-gate.ts',
          'apps/agent-daemon/src/ready-gate.test.ts',
        ],
        candidateForbiddenFiles: [
          'apps/agent-daemon/src/daemon.ts',
        ],
      }),
      runAgent: async ({ prompt }) => {
        capturedPrompt = prompt

        return {
          responseText: `## 用户故事

作为 维护者，我希望 ready gate 能明确指出 validation 引用缺失的路径，从而更快修复不可执行 issue。

## Context

### Dependencies
\`\`\`json
{"dependsOn":[]}
\`\`\`

### Constraints
- 只修 ready gate 的 validation path 提示

### AllowedFiles
- apps/agent-daemon/src/ready-gate.ts
- apps/agent-daemon/src/ready-gate.test.ts

### ForbiddenFiles
- apps/agent-daemon/src/daemon.ts

### MustPreserve
- 已有 hard validation 错误语义保持不变

### OutOfScope
- issue simulate

### RequiredSemantics
- 缺失路径时错误里包含 repo-relative path

### ReviewHints
- 检查 path 解析是否只影响 validation target 分支

### Validation
- \`bun test apps/agent-daemon/src/ready-gate.test.ts\`
- \`git diff --stat origin/main...HEAD\`

## RED 测试

\`\`\`ts
throw new Error('red')
\`\`\`

## 实现步骤

1. 先补失败测试
2. 再补最小实现
3. 最后跑验证

## 验收

- [ ] 只改 ready gate 相关文件
- [ ] RED 测试转绿`,
        }
      },
    })

    expect(output.validation.valid).toBe(true)
    expect(output.markdown.startsWith('## 用户故事')).toBe(true)
    expect(output.markdown).toContain('### Dependencies')
    expect(output.markdown).toContain('### AllowedFiles')
    expect(capturedPrompt).toContain('Candidate Validation Commands')
    expect(capturedPrompt).toContain('apps/agent-daemon/src/ready-gate.ts')
  })

  test('fails with explicit local contract validation errors when agent output is invalid', async () => {
    await expect(rewriteIssueDraft({
      issueText: '修复 ready gate 对 Validation 缺失路径的提示，并补测试',
      repoRoot: '/tmp/repo',
      buildAuthoringContext: async () => ({
        candidateValidationCommands: [],
        candidateAllowedFiles: [],
        candidateForbiddenFiles: [],
      }),
      runAgent: async () => ({
        responseText: `## 用户故事

作为 维护者，我希望 rewrite 失败时给出具体错误。`,
      }),
    })).rejects.toThrow('rewrite output failed contract validation')
  })

  test('fails when rewrite drops valid dependency metadata from the input draft', async () => {
    await expect(rewriteIssueDraft({
      issueText: `## 用户故事

作为 维护者，我希望 rewrite 保留 issue 依赖信息。

## Context

### Dependencies
\`\`\`json
{"dependsOn":[36,37]}
\`\`\`

### Constraints
- 保留依赖元数据

### AllowedFiles
- apps/agent-daemon/src/issue-authoring.ts

### ForbiddenFiles
- apps/agent-daemon/src/daemon.ts

### MustPreserve
- Dependencies fenced JSON 必须保留

### OutOfScope
- 自动更新远程 issue

### RequiredSemantics
- 当依赖被改写时直接失败

### Validation
- \`bun test apps/agent-daemon/src/issue-authoring.test.ts\`

## RED 测试

\`\`\`ts
throw new Error('red')
\`\`\`

## 实现步骤

1. 先补失败测试

## 验收

- [ ] 依赖必须保留`,
      repoRoot: '/tmp/repo',
      buildAuthoringContext: async () => ({
        candidateValidationCommands: [],
        candidateAllowedFiles: [],
        candidateForbiddenFiles: [],
      }),
      runAgent: async () => ({
        responseText: `## 用户故事

作为 维护者，我希望 rewrite 保留 issue 依赖信息。

## Context

### Dependencies
\`\`\`json
{"dependsOn":[]}
\`\`\`

### Constraints
- 保留依赖元数据

### AllowedFiles
- apps/agent-daemon/src/issue-authoring.ts

### ForbiddenFiles
- apps/agent-daemon/src/daemon.ts

### MustPreserve
- Dependencies fenced JSON 必须保留

### OutOfScope
- 自动更新远程 issue

### RequiredSemantics
- 当依赖被改写时直接失败

### Validation
- \`bun test apps/agent-daemon/src/issue-authoring.test.ts\`

## RED 测试

\`\`\`ts
throw new Error('red')
\`\`\`

## 实现步骤

1. 先补失败测试

## 验收

- [ ] 依赖必须保留`,
      }),
    })).rejects.toThrow('rewrite output failed dependency preservation')
  })

  test('strips a single outer markdown fence so the result can be pasted directly into GitHub', async () => {
    const output = await rewriteIssueDraft({
      issueText: '修复 ready gate 对 Validation 缺失路径的提示，并补测试',
      repoRoot: '/tmp/repo',
      buildAuthoringContext: async () => ({
        candidateValidationCommands: [],
        candidateAllowedFiles: [],
        candidateForbiddenFiles: [],
      }),
      runAgent: async () => ({
        responseText: `\`\`\`markdown
## 用户故事

作为 维护者，我希望 rewrite 输出不带外层 fence。

## Context

### Dependencies
\`\`\`json
{"dependsOn":[]}
\`\`\`

### Constraints
- 只支持本地输入

### AllowedFiles
- apps/agent-daemon/src/issue-authoring.ts

### ForbiddenFiles
- apps/agent-daemon/src/daemon.ts

### MustPreserve
- 默认保持只读

### OutOfScope
- 自动修改远程 issue

### RequiredSemantics
- 输出 markdown 本体

### ReviewHints
- 检查输出前后没有说明 prose

### Validation
- \`bun test apps/agent-daemon/src/issue-authoring.test.ts\`
- \`git diff --stat origin/main...HEAD\`

## RED 测试

\`\`\`ts
throw new Error('red')
\`\`\`

## 实现步骤

1. 先规范输出
2. 再验证合同

## 验收

- [ ] markdown 可直接粘贴
\`\`\``,
      }),
    })

    expect(output.markdown.startsWith('## 用户故事')).toBe(true)
    expect(output.markdown).not.toContain('```markdown')
  })
})

describe('issue-authoring helpers', () => {
  test('buildIssueRewritePrompt embeds repo-grounded suggestions', () => {
    const prompt = buildIssueRewritePrompt({
      issueText: '修复 ready gate 对 Validation 缺失路径的提示，并补测试',
      authoringContext: {
        candidateValidationCommands: ['bun test apps/agent-daemon/src/ready-gate.test.ts'],
        candidateAllowedFiles: ['apps/agent-daemon/src/ready-gate.ts'],
        candidateForbiddenFiles: ['apps/agent-daemon/src/daemon.ts'],
      },
    })

    expect(prompt).toContain('Candidate Validation Commands')
    expect(prompt).toContain('apps/agent-daemon/src/ready-gate.ts')
    expect(prompt).toContain('### Dependencies')
  })

  test('normalizeIssueRewriteMarkdown removes one outer fence and trims whitespace', () => {
    expect(normalizeIssueRewriteMarkdown('\n```md\n## 用户故事\n```\n')).toBe('## 用户故事')
  })
})
