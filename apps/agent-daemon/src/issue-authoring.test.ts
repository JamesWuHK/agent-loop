import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rewriteIssueDraft } from './issue-authoring'

describe('rewriteIssueDraft', () => {
  test('returns canonical executable contract markdown validated against local rules', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-loop-rewrite-'))
    mkdirSync(join(root, 'apps/agent-daemon/src'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'fixture-repo',
      scripts: {
        test: 'bun test',
        typecheck: 'bun run typecheck',
      },
      workspaces: ['apps/*'],
    }))
    writeFileSync(join(root, 'apps/agent-daemon/src/ready-gate.ts'), 'export const readyGate = true\n')
    writeFileSync(join(root, 'apps/agent-daemon/src/ready-gate.test.ts'), 'export {}\n')

    const output = await rewriteIssueDraft({
      issueText: '修复 ready gate 对 Validation 缺失路径的提示，并补测试',
      repoRoot: root,
    }, {
      runAgent: async ({ prompt }) => {
        expect(prompt).toContain('apps/agent-daemon/src/ready-gate.ts')
        expect(prompt).toContain('apps/agent-daemon/src/ready-gate.test.ts')

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
  })

  test('fails when the rewritten contract is still invalid', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-loop-rewrite-invalid-'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'fixture-repo',
      scripts: {
        test: 'bun test',
      },
    }))

    await expect(rewriteIssueDraft({
      issueText: '把 issue 改成可执行 contract',
      repoRoot: root,
    }, {
      runAgent: async () => ({
        responseText: `## 用户故事

作为 维护者，我希望 rewrite 能工作。

## Context

### Dependencies
\`\`\`json
{"dependsOn":[]}
\`\`\`

### AllowedFiles
- frontend files`,
      }),
    })).rejects.toThrow('Rewritten issue contract failed local validation')
  })
})
