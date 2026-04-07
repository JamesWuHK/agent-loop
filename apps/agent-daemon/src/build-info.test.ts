import { describe, expect, test } from 'bun:test'
import { buildAgentLoopBuildInfo } from './build-info'

describe('build info', () => {
  test('prefers tag build source when a matching tag is present', () => {
    expect(buildAgentLoopBuildInfo({
      packageVersion: '0.1.0',
      gitCommit: '49fa8f3c8b14c4f84f2b3e44d31ad7b9d29b0abc',
      gitBranch: 'feat/control-console',
      gitTag: 'control-console-baseline-20260407',
      gitDirty: false,
    })).toEqual({
      version: '0.1.0',
      gitCommit: '49fa8f3c8b14c4f84f2b3e44d31ad7b9d29b0abc',
      gitCommitShort: '49fa8f3',
      gitBranch: 'feat/control-console',
      buildSource: 'tag',
      buildDirty: false,
    })
  })

  test('falls back to dev build source when no tag is present and the tree is dirty', () => {
    expect(buildAgentLoopBuildInfo({
      packageVersion: '0.1.0',
      gitCommit: 'a718d1e28fefd559ced57a1e0031b86be222b6d6',
      gitBranch: 'feat/control-console',
      gitTag: null,
      gitDirty: true,
    })).toEqual({
      version: '0.1.0',
      gitCommit: 'a718d1e28fefd559ced57a1e0031b86be222b6d6',
      gitCommitShort: 'a718d1e',
      gitBranch: 'feat/control-console',
      buildSource: 'dev',
      buildDirty: true,
    })
  })

  test('keeps package-only metadata when git data is unavailable', () => {
    expect(buildAgentLoopBuildInfo({
      packageVersion: '0.1.0',
      gitCommit: null,
      gitBranch: null,
      gitTag: null,
      gitDirty: null,
    })).toEqual({
      version: '0.1.0',
      gitCommit: null,
      gitCommitShort: null,
      gitBranch: null,
      buildSource: 'package',
      buildDirty: null,
    })
  })
})
