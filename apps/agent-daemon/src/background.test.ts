import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildBackgroundRuntimePaths,
  readBackgroundRuntimeRecord,
  removeBackgroundRuntimeRecord,
  sanitizeDaemonBackgroundArgs,
  stopBackgroundRuntime,
} from './background'

describe('background helpers', () => {
  test('builds stable runtime record and log paths', () => {
    const paths = buildBackgroundRuntimePaths({
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-verify-20260405',
      healthPort: 9311,
    }, '/tmp/agent-loop-home')

    expect(paths.runtimeDir).toBe('/tmp/agent-loop-home/.agent-loop/runtime')
    expect(paths.recordPath).toContain('jameswuhk-digital-employee__codex-verify-20260405__9311.json')
    expect(paths.logPath).toContain('jameswuhk-digital-employee__codex-verify-20260405__9311.log')
  })

  test('removes daemon control flags before background launch', () => {
    expect(sanitizeDaemonBackgroundArgs([
      '--daemonize',
      '--repo', 'JamesWuHK/digital-employee',
      '--health-port', '9311',
      '--stop',
    ])).toEqual([
      '--repo', 'JamesWuHK/digital-employee',
      '--health-port', '9311',
    ])
  })

  test('reads persisted background runtime records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-loop-background-test-'))
    const path = join(dir, 'runtime.json')
    writeFileSync(path, JSON.stringify({
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-verify-20260405',
      healthPort: 9311,
      pid: 12345,
      metricsPort: 9091,
      cwd: '/tmp/workdir',
      startedAt: '2026-04-05T02:00:00.000Z',
      command: ['bun', 'apps/agent-daemon/src/index.ts'],
      logPath: '/tmp/daemon.log',
    }))

    expect(readBackgroundRuntimeRecord(path)).toMatchObject({
      repo: 'JamesWuHK/digital-employee',
      pid: 12345,
      metricsPort: 9091,
    })
  })

  test('reports when no background runtime record exists to stop', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-loop-background-stop-test-'))
    const path = join(dir, 'missing-runtime.json')

    expect(stopBackgroundRuntime(path)).toEqual({
      stopped: false,
      message: `No background runtime record found at ${path}`,
    })
  })

  test('removes runtime records idempotently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-loop-background-remove-test-'))
    const path = join(dir, 'runtime.json')
    writeFileSync(path, '{}')

    expect(existsSync(path)).toBe(true)
    removeBackgroundRuntimeRecord(path)
    expect(existsSync(path)).toBe(false)
    removeBackgroundRuntimeRecord(path)
    expect(existsSync(path)).toBe(false)
  })
})
