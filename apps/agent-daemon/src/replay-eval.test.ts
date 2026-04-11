import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  evaluateBootstrapScenarioFixtureDirectory,
  evaluateBootstrapScenarioSuite,
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
      totalCases: 6,
      passedCases: 6,
      failedCases: 0,
      claimable: 3,
      blocked: 3,
      invalid: 1,
    })
  })
})

describe('evaluateBootstrapScenarioSuite', () => {
  test('fails when any required self-bootstrap case is missing or red', () => {
    const report = evaluateBootstrapScenarioSuite({
      suite: 'self-bootstrap-v0.2',
      cases: [
        { name: 'self-bootstrap-happy-path', ok: true },
        { name: 'self-bootstrap-closed-pr-recreate', ok: true },
        { name: 'self-bootstrap-checks-pending', ok: false },
      ],
    })

    expect(report.ok).toBe(false)
    expect(report.failedCases).toEqual([
      'self-bootstrap-checks-pending',
      'self-bootstrap-checks-fail',
    ])
    expect(report.summary).toEqual({
      requiredCases: 4,
      presentCases: 3,
      passedCases: 2,
      failedCases: 2,
    })
  })

  test('loads the fixed self-bootstrap scenario suite from disk', () => {
    const report = evaluateBootstrapScenarioFixtureDirectory(join(import.meta.dir, 'fixtures', 'replay'))

    expect(report.ok).toBe(true)
    expect(report.cases.map((fixture) => fixture.name)).toEqual([
      'self-bootstrap-happy-path',
      'self-bootstrap-closed-pr-recreate',
      'self-bootstrap-checks-pending',
      'self-bootstrap-checks-fail',
    ])
    expect(report.failedCases).toEqual([])
    expect(report.summary).toEqual({
      requiredCases: 4,
      presentCases: 4,
      passedCases: 4,
      failedCases: 0,
    })
  })
})
