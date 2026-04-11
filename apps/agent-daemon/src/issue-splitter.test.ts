import { describe, expect, test } from 'bun:test'
import { splitTrackingIssue } from './issue-splitter'

describe('splitTrackingIssue', () => {
  test('returns ordered child issue contracts with explicit dependsOn arrays', async () => {
    const result = await splitTrackingIssue({
      title: '[AL-EPIC] 把 issue 质量能力接入 agent-loop',
      body: '需要补 issue lint、rewrite、split 和 simulate 四块能力',
      repoRoot: '/tmp/repo',
      issueNumberAllocator: (() => {
        let current = 17
        return () => current++
      })(),
    }, {
      runAgent: async () => ({
        responseText: `1. [AL-X] 引入 issue lint
2. [AL-Y] 增加 rewrite CLI
3. [AL-Z] 增加 simulate`,
      }),
      buildRepoAuthoringContext: async () => ({
        candidateValidationCommands: ['bun run typecheck'],
        candidateAllowedFiles: [],
        candidateForbiddenFiles: ['package.json'],
      }),
    })

    expect(result.children).toHaveLength(3)
    expect(result.children[0]?.body).toContain('"dependsOn":[]')
    expect(result.children[1]?.body).toContain('"dependsOn":[17]')
    expect(result.children[2]?.body).toContain('"dependsOn":[17,18]')
    expect(result.children.every((child) => child.body.includes('## RED 测试'))).toBe(true)
    expect(result.parentSummary).toContain('#17 [AL-X] 引入 issue lint')
  })

  test('rejects investigation-only child issues from the split outline', async () => {
    await expect(splitTrackingIssue({
      title: '[AL-EPIC] 改进 authoring flow',
      body: '需要把 child issue 拆干净',
      repoRoot: '/tmp/repo',
      issueNumberAllocator: (() => {
        let current = 30
        return () => current++
      })(),
    }, {
      runAgent: async () => ({
        responseText: `1. 调研 ready gate 的失败原因
2. 增加 rewrite CLI`,
      }),
      buildRepoAuthoringContext: async () => ({
        candidateValidationCommands: ['bun run typecheck'],
        candidateAllowedFiles: ['apps/agent-daemon/src/index.ts'],
        candidateForbiddenFiles: ['package.json'],
      }),
    })).rejects.toThrow('non-executable child title')
  })
})
