import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SprintContract } from '../../../packages/agent-shared/src/types'
import {
  buildSprintContract,
  readSprintContract,
  resolveSprintContractPath,
  serializeSprintContract,
  writeSprintContract,
} from './sprint-contract'

describe('SprintContract artifacts', () => {
  test('round-trips a sprint contract through worktree-local artifact storage', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'agent-loop-sprint-contract-'))

    try {
      const contract = buildSprintContract({
        issueNumber: 34,
        issueTitle: '[AL-34] sprint contract',
        attemptKind: 'fresh-claim',
        objective: 'Introduce a durable attempt contract before the first writable run',
        allowedFiles: ['apps/agent-daemon/src/sprint-contract.ts'],
        requiredSemantics: ['issue body remains the source of truth'],
        validationCommands: ['bun test apps/agent-daemon/src/sprint-contract.test.ts'],
        plannedSteps: ['add artifact helpers', 'add round-trip coverage'],
      })

      await writeSprintContract(worktreePath, contract)

      expect(await readSprintContract(worktreePath)).toEqual(contract)
    } finally {
      rmSync(worktreePath, { recursive: true, force: true })
    }
  })

  test('returns null when the worktree-local sprint contract artifact is missing', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'agent-loop-sprint-contract-missing-'))

    try {
      expect(await readSprintContract(worktreePath)).toBeNull()
    } finally {
      rmSync(worktreePath, { recursive: true, force: true })
    }
  })

  test('serializes sprint contracts deterministically with fixed key order and empty lists', () => {
    const contract = buildSprintContract({
      issueNumber: 106,
      issueTitle: '[AL-34] 引入 Sprint Contract',
      attemptKind: 'issue-recovery',
      objective: 'Recover the smallest in-scope changes for the sprint contract artifact',
      allowedFiles: [],
      requiredSemantics: [],
      validationCommands: [],
      plannedSteps: [],
      createdAt: '2026-04-15T00:00:00.000Z',
    })

    const reordered: SprintContract = {
      plannedSteps: [],
      validationCommands: [],
      requiredSemantics: [],
      allowedFiles: [],
      objective: 'Recover the smallest in-scope changes for the sprint contract artifact',
      attemptKind: 'issue-recovery',
      issueTitle: '[AL-34] 引入 Sprint Contract',
      issueNumber: 106,
      artifactVersion: 1,
      createdAt: '2026-04-15T00:00:00.000Z',
    }

    expect(serializeSprintContract(reordered)).toBe(serializeSprintContract(contract))
    expect(serializeSprintContract(contract)).toBe(`{
  "artifactVersion": 1,
  "issueNumber": 106,
  "issueTitle": "[AL-34] 引入 Sprint Contract",
  "attemptKind": "issue-recovery",
  "objective": "Recover the smallest in-scope changes for the sprint contract artifact",
  "allowedFiles": [],
  "requiredSemantics": [],
  "validationCommands": [],
  "plannedSteps": [],
  "createdAt": "2026-04-15T00:00:00.000Z"
}
`)
  })

  test('returns null for malformed sprint contract artifacts instead of crashing recovery', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'agent-loop-sprint-contract-malformed-'))

    try {
      mkdirSync(join(worktreePath, '.agent-loop'), { recursive: true })
      writeFileSync(resolveSprintContractPath(worktreePath), '{"artifactVersion":999}', 'utf-8')

      expect(await readSprintContract(worktreePath)).toBeNull()
    } finally {
      rmSync(worktreePath, { recursive: true, force: true })
    }
  })
})
