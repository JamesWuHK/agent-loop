import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shouldTreatCleanNoCommitSubtaskAsSuccess } from './subtask-executor'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

async function createGitRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'subtask-executor-test-'))
  tempDirs.push(dir)

  await Bun.$`git -C ${dir} init -b main`.quiet()
  await Bun.$`git -C ${dir} config user.name agent-loop`.quiet()
  await Bun.$`git -C ${dir} config user.email agent-loop@local`.quiet()

  writeFileSync(join(dir, 'demo.txt'), 'before\n', 'utf-8')
  await Bun.$`git -C ${dir} add demo.txt`.quiet()
  await Bun.$`git -C ${dir} commit -m "chore: init"`.quiet()

  return dir
}

describe('shouldTreatCleanNoCommitSubtaskAsSuccess', () => {
  it('returns true for later subtasks when earlier commits already exist and the worktree is clean', async () => {
    const dir = await createGitRepo()
    await Bun.$`git -C ${dir} checkout -b agent/test`.quiet()
    writeFileSync(join(dir, 'demo.txt'), 'after\n', 'utf-8')
    await Bun.$`git -C ${dir} add demo.txt`.quiet()
    await Bun.$`git -C ${dir} commit -m "feat: progress"`.quiet()

    const result = await shouldTreatCleanNoCommitSubtaskAsSuccess(dir, 'main', 2)

    expect(result).toBe(true)
  })

  it('returns false for the first subtask even when earlier commits exist', async () => {
    const dir = await createGitRepo()
    await Bun.$`git -C ${dir} checkout -b agent/test`.quiet()
    writeFileSync(join(dir, 'demo.txt'), 'after\n', 'utf-8')
    await Bun.$`git -C ${dir} add demo.txt`.quiet()
    await Bun.$`git -C ${dir} commit -m "feat: progress"`.quiet()

    const result = await shouldTreatCleanNoCommitSubtaskAsSuccess(dir, 'main', 1)

    expect(result).toBe(false)
  })

  it('returns false when the worktree is dirty', async () => {
    const dir = await createGitRepo()
    writeFileSync(join(dir, 'demo.txt'), 'after\n', 'utf-8')

    const result = await shouldTreatCleanNoCommitSubtaskAsSuccess(dir, 'main', 2)

    expect(result).toBe(false)
  })
})
