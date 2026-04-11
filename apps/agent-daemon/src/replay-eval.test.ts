import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  evaluateReplayFixtureDirectory,
  evaluateReplayFixtures,
} from './replay-eval'

describe('evaluateReplayFixtures', () => {
  test('reports fixture cases as passing only when actual summary matches expectation', () => {
    const report = evaluateReplayFixtures([
      {
        name: 'claimability-basic',
        openIssues: [
          {
            number: 91,
            title: 'ready issue',
            body: `## 用户故事

作为 开发者，我希望 daemon 能 claim 这个 issue。

## Context

### Dependencies
\`\`\`json
{"dependsOn":[]}
\`\`\`

### AllowedFiles
- apps/agent-daemon/src/example.ts

### ForbiddenFiles
- apps/agent-daemon/src/daemon.ts

### MustPreserve
- ready issue remains ready

### OutOfScope
- unrelated scheduler changes

### RequiredSemantics
- issue is claimable

### ReviewHints
- check contract validity

### Validation
- \`bun run typecheck\`

## RED 测试

\`\`\`ts
throw new Error('fixture red test body')
\`\`\`

## 实现步骤
1. add test

## 验收
- [ ] contract valid`,
            labels: ['agent:ready'],
            assignees: [],
            state: 'open',
            updatedAt: '2026-04-11T09:00:00.000Z',
          },
        ],
        issueComments: [],
        openPullRequests: [],
        expected: {
          claimable: 1,
          blocked: 0,
          invalid: 0,
        },
      },
    ])

    expect(report.ok).toBe(true)
    expect(report.summary).toMatchObject({
      totalCases: 1,
      failedCases: 0,
    })
  })

  test('marks a case as failed when actual summary differs from expectation', () => {
    const report = evaluateReplayFixtures([
      {
        name: 'mismatch',
        openIssues: [],
        issueComments: [],
        openPullRequests: [],
        expected: {
          claimable: 1,
          blocked: 0,
          invalid: 0,
        },
      },
    ])

    expect(report.ok).toBe(false)
    expect(report.cases[0]).toMatchObject({
      name: 'mismatch',
      ok: false,
    })
    expect(report.cases[0]?.mismatches).toContain('claimable: expected 1, received 0')
  })

  test('loads repo fixtures from disk and evaluates them deterministically', () => {
    const report = evaluateReplayFixtureDirectory(join(import.meta.dir, 'fixtures', 'replay'))

    expect(report.ok).toBe(true)
    expect(report.summary).toMatchObject({
      totalCases: 2,
      passedCases: 2,
      failedCases: 0,
      claimable: 1,
      blocked: 1,
      invalid: 1,
    })
  })
})
