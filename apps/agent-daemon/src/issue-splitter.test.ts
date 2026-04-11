import { describe, expect, test } from 'bun:test'
import {
  buildTrackingIssueSplitPrompt,
  formatTrackingIssueSplitResult,
  parseTrackingIssueSplitPlan,
  splitTrackingIssue,
} from './issue-splitter'

describe('splitTrackingIssue', () => {
  test('returns ordered child issue contracts with explicit dependsOn arrays', async () => {
    const result = await splitTrackingIssue({
      title: '[AL-EPIC] 把 issue 质量能力接入 agent-loop',
      body: '需要补 issue lint、rewrite、split 和 simulate 四块能力',
      repoRoot: '/tmp/repo',
      buildAuthoringContext: async () => ({
        candidateValidationCommands: [
          'bun test apps/agent-daemon/src/issue-splitter.test.ts',
        ],
        candidateAllowedFiles: [
          'apps/agent-daemon/src/issue-splitter.ts',
          'apps/agent-daemon/src/issue-splitter.test.ts',
        ],
        candidateForbiddenFiles: [
          'apps/agent-daemon/src/daemon.ts',
        ],
      }),
      runAgent: async () => ({
        responseText: `1. [AL-X] 引入 issue lint
2. [AL-Y] 增加 rewrite CLI
3. [AL-Z] 增加 split CLI`,
      }),
      issueNumberAllocator: (() => {
        let current = 17
        return () => current++
      })(),
    })

    expect(result.children).toHaveLength(3)
    expect(result.children[0]?.body).toContain('"dependsOn":[]')
    expect(result.children[1]?.body).toContain('"dependsOn":[17]')
    expect(result.children[2]?.body).toContain('"dependsOn":[17,18]')
    expect(result.children.every((child) => child.body.includes('## RED 测试'))).toBe(true)
    expect(result.markdown).toContain('## Parent Summary')
    expectTopLevelDependsOnToRemainMachineReadable(result.markdown)
  })

  test('uses explicit dependency ids from strict JSON plans', async () => {
    const result = await splitTrackingIssue({
      title: '[AL-EPIC] issue authoring pipeline',
      body: '父 issue 负责串起 lint、rewrite、split 三条子线。',
      repoRoot: '/tmp/repo',
      buildAuthoringContext: async () => ({
        candidateValidationCommands: [
          'bun test apps/agent-daemon/src/issue-splitter.test.ts',
          'bun run typecheck',
        ],
        candidateAllowedFiles: [
          'apps/agent-daemon/src/issue-splitter.ts',
          'apps/agent-daemon/src/issue-authoring.ts',
          'apps/agent-daemon/src/index.ts',
        ],
        candidateForbiddenFiles: [
          'apps/agent-daemon/src/daemon.ts',
        ],
      }),
      runAgent: async () => ({
        responseText: `\`\`\`json
{
  "parentSummary": "按 lint -> rewrite -> split 的顺序推进 child issues。",
  "children": [
    {
      "id": "lint",
      "title": "[AL-LINT] 引入 issue lint",
      "summary": "让维护者先看到 child contract 的质量报告",
      "allowedFiles": ["apps/agent-daemon/src/issue-splitter.ts"],
      "outOfScope": ["rewrite CLI"],
      "requiredSemantics": ["输出可读的质量报告"],
      "dependsOn": []
    },
    {
      "id": "rewrite",
      "title": "[AL-REWRITE] 增加 rewrite CLI",
      "summary": "让维护者能把模糊草稿重写成 canonical contract",
      "allowedFiles": ["apps/agent-daemon/src/issue-authoring.ts"],
      "outOfScope": ["split CLI"],
      "requiredSemantics": ["输出 canonical executable contract"],
      "dependsOn": ["lint"]
    },
    {
      "id": "split",
      "title": "[AL-SPLIT] 增加 split CLI",
      "summary": "让维护者能把 tracking parent 拆成 child contracts",
      "allowedFiles": ["apps/agent-daemon/src/index.ts"],
      "outOfScope": ["issue simulate"],
      "requiredSemantics": ["回填最终 dependsOn 图"],
      "dependsOn": ["rewrite"]
    }
  ]
}
\`\`\``,
      }),
      rewriteIssueDraft: async ({ issueText }) => {
        if (issueText.includes('[AL-LINT]')) {
          return buildCanonicalRewriteResult('[AL-LINT] 引入 issue lint', 'apps/agent-daemon/src/issue-splitter.ts')
        }

        if (issueText.includes('[AL-REWRITE]')) {
          return buildCanonicalRewriteResult('[AL-REWRITE] 增加 rewrite CLI', 'apps/agent-daemon/src/issue-authoring.ts')
        }

        return buildCanonicalRewriteResult('[AL-SPLIT] 增加 split CLI', 'apps/agent-daemon/src/index.ts')
      },
      issueNumberAllocator: (() => {
        let current = 41
        return () => current++
      })(),
    })

    expect(result.parentSummary).toContain('lint -> rewrite -> split')
    expect(result.children).toHaveLength(3)
    expect(result.children[0]?.dependsOn).toEqual([])
    expect(result.children[1]?.dependsOn).toEqual([41])
    expect(result.children[2]?.dependsOn).toEqual([42])
    expect(result.children[2]?.body).toContain('"dependsOn":[42]')
    expectTopLevelDependsOnToRemainMachineReadable(result.markdown)
  })

  test('removes dependsOn prose from the parent summary while preserving child dependency JSON', () => {
    const markdown = formatTrackingIssueSplitResult({
      parentTitle: '[AL-EPIC] issue authoring pipeline',
      parentSummary: [
        '按 lint -> rewrite -> split 的顺序推进。',
        '不要在这里输出 dependsOn: [41, 42]。',
      ].join('\n'),
      children: [
        {
          number: 41,
          title: '[AL-LINT] 引入 issue lint',
          body: buildCanonicalRewriteResult('[AL-LINT] 引入 issue lint', 'apps/agent-daemon/src/issue-splitter.ts').markdown,
          dependsOn: [],
          validation: {
            valid: true,
            score: 100,
            errors: [],
            warnings: [],
          },
        },
      ],
    })

    expect(markdown).toContain('按 lint -> rewrite -> split 的顺序推进。')
    expect(markdown).not.toContain('不要在这里输出 dependsOn: [41, 42]。')
    expectTopLevelDependsOnToRemainMachineReadable(markdown)
  })

  test('rejects child markdown that still carries issue quality warnings', async () => {
    await expect(splitTrackingIssue({
      title: '[AL-EPIC] 质量守门',
      body: '确保 split 输出不能带宽泛 AllowedFiles。',
      repoRoot: '/tmp/repo',
      buildAuthoringContext: async () => ({
        candidateValidationCommands: ['bun test apps/agent-daemon/src/issue-splitter.test.ts'],
        candidateAllowedFiles: ['apps/agent-daemon/src/issue-splitter.ts'],
        candidateForbiddenFiles: ['apps/agent-daemon/src/daemon.ts'],
      }),
      runAgent: async () => ({
        responseText: '1. [AL-X] 收紧 AllowedFiles',
      }),
      rewriteIssueDraft: async () => buildCanonicalRewriteResult('[AL-X] 收紧 AllowedFiles', 'frontend files'),
    })).rejects.toThrow('failed quality checks')
  })
})

describe('issue-splitter helpers', () => {
  test('buildTrackingIssueSplitPrompt embeds repo-grounded suggestions and strict JSON guidance', () => {
    const prompt = buildTrackingIssueSplitPrompt({
      title: '[AL-EPIC] issue authoring pipeline',
      body: '父 issue 负责串起 lint、rewrite、split 三条子线。',
      issueText: '父 issue 负责串起 lint、rewrite、split 三条子线。',
      authoringContext: {
        candidateValidationCommands: ['bun test apps/agent-daemon/src/issue-splitter.test.ts'],
        candidateAllowedFiles: ['apps/agent-daemon/src/issue-splitter.ts'],
        candidateForbiddenFiles: ['apps/agent-daemon/src/daemon.ts'],
      },
    })

    expect(prompt).toContain('strict JSON object')
    expect(prompt).toContain('Candidate Allowed Files')
    expect(prompt).toContain('apps/agent-daemon/src/issue-splitter.ts')
  })

  test('parseTrackingIssueSplitPlan falls back to numbered-list parsing', () => {
    const plan = parseTrackingIssueSplitPlan(`1. [AL-X] 引入 issue lint
2. [AL-Y] 增加 rewrite CLI`)

    expect(plan.children).toHaveLength(2)
    expect(plan.children[0]?.title).toBe('[AL-X] 引入 issue lint')
    expect(plan.children[1]?.hasExplicitDependencies).toBe(false)
  })
})

function buildCanonicalRewriteResult(title: string, allowedFile: string) {
  return {
    markdown: `## 用户故事

作为 \`agent-loop\` 维护者，我希望 ${title}，从而让 split 输出保持 canonical issue contract。

## Context

### Dependencies
\`\`\`json
{"dependsOn":[]}
\`\`\`

### Constraints
- 只实现当前 child 对应的功能切片

### AllowedFiles
- ${allowedFile}

### ForbiddenFiles
- apps/agent-daemon/src/daemon.ts

### MustPreserve
- parent issue 仍然是 tracking-only

### OutOfScope
- sibling child 的后续工作

### RequiredSemantics
- 输出当前 child 对应的代码变更与测试

### ReviewHints
- 检查 scope 是否仍然足够具体

### Validation
- \`bun test apps/agent-daemon/src/issue-splitter.test.ts\`
- \`git diff --stat origin/main...HEAD\`

## RED 测试

\`\`\`ts
throw new Error('red')
\`\`\`

## 实现步骤

1. 先补失败测试
2. 再补最小实现
3. 最后运行验证

## 验收

- [ ] 只修改 AllowedFiles 内文件
- [ ] Validation 中命令执行通过`,
    validation: {
      valid: true,
      score: 100,
      errors: [],
      warnings: [],
    },
  }
}

function expectTopLevelDependsOnToRemainMachineReadable(markdown: string) {
  const dependencyBlocks = markdown.match(/### Dependencies\s*\n```json\s*\n[\s\S]*?"dependsOn":[\s\S]*?\n```/g) ?? []
  const allDependsOnOccurrences = markdown.match(/dependsOn/g) ?? []

  expect(dependencyBlocks.length).toBeGreaterThan(0)
  expect(allDependsOnOccurrences).toHaveLength(dependencyBlocks.length)
}
