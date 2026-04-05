import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildBackgroundRuntimePaths,
  listBackgroundRuntimeRecords,
  readBackgroundRuntimeRecord,
  removeBackgroundRuntimeRecord,
  resolveCurrentRuntimeSupervisor,
  resolveBackgroundRuntimeRecord,
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
      '--join-project',
      '--repo', 'JamesWuHK/digital-employee',
      '--health-port', '9311',
      '--start',
      '--stop',
      '--logs',
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
      supervisor: 'launchd',
      pid: 12345,
      metricsPort: 9091,
      cwd: '/tmp/workdir',
      startedAt: '2026-04-05T02:00:00.000Z',
      command: ['bun', 'apps/agent-daemon/src/index.ts'],
      logPath: '/tmp/daemon.log',
    }))

    expect(readBackgroundRuntimeRecord(path)).toMatchObject({
      repo: 'JamesWuHK/digital-employee',
      supervisor: 'launchd',
      pid: 12345,
      metricsPort: 9091,
    })
  })

  test('defaults missing runtime supervisor to detached for older records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-loop-background-legacy-test-'))
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
      supervisor: 'detached',
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

  test('lists runtime records and marks alive processes', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'agent-loop-background-list-test-'))
    const runtimeDir = join(homeDir, '.agent-loop', 'runtime')
    const firstPath = join(runtimeDir, 'first.json')
    const secondPath = join(runtimeDir, 'second.json')
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(firstPath, JSON.stringify({
      repo: 'JamesWuHK/digital-employee',
      machineId: 'alive-machine',
      healthPort: 9311,
      supervisor: 'launchd',
      pid: process.pid,
      metricsPort: 9091,
      cwd: '/tmp/alive',
      startedAt: '2026-04-05T03:05:00.000Z',
      command: ['bun', 'agent-loop'],
      logPath: '/tmp/alive.log',
    }))
    writeFileSync(secondPath, JSON.stringify({
      repo: 'JamesWuHK/digital-employee',
      machineId: 'stale-machine',
      healthPort: 9312,
      supervisor: 'detached',
      pid: 999999,
      metricsPort: 9092,
      cwd: '/tmp/stale',
      startedAt: '2026-04-05T03:04:00.000Z',
      command: ['bun', 'agent-loop'],
      logPath: '/tmp/stale.log',
    }))

    const snapshots = listBackgroundRuntimeRecords(homeDir)

    expect(snapshots).toHaveLength(2)
    expect(snapshots[0]).toMatchObject({
      alive: true,
      record: {
        machineId: 'alive-machine',
        supervisor: 'launchd',
      },
    })
    expect(snapshots[1]).toMatchObject({
      alive: false,
      record: {
        machineId: 'stale-machine',
        supervisor: 'detached',
      },
    })
  })

  test('resolves a unique runtime record by repo and prefers alive records', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'agent-loop-background-resolve-test-'))
    const runtimeDir = join(homeDir, '.agent-loop', 'runtime')
    const stalePath = join(runtimeDir, 'stale.json')
    const alivePath = join(runtimeDir, 'alive.json')
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(stalePath, JSON.stringify({
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-stale',
      healthPort: 9311,
      supervisor: 'detached',
      pid: 999999,
      metricsPort: 9091,
      cwd: '/tmp/stale',
      startedAt: '2026-04-05T03:00:00.000Z',
      command: ['bun', 'agent-loop'],
      logPath: '/tmp/stale.log',
    }))
    writeFileSync(alivePath, JSON.stringify({
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-alive',
      healthPort: 9312,
      supervisor: 'launchd',
      pid: process.pid,
      metricsPort: 9092,
      cwd: '/tmp/alive',
      startedAt: '2026-04-05T03:06:00.000Z',
      command: ['bun', 'agent-loop'],
      logPath: '/tmp/alive.log',
    }))

    expect(resolveBackgroundRuntimeRecord({
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-alive',
      homeDir,
    })).toMatchObject({
      alive: true,
      record: {
        healthPort: 9312,
      },
    })
  })

  test('throws when multiple runtime records match ambiguously', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'agent-loop-background-ambiguous-test-'))
    const runtimeDir = join(homeDir, '.agent-loop', 'runtime')
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(runtimeDir, 'first.json'), JSON.stringify({
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-a',
      healthPort: 9311,
      supervisor: 'detached',
      pid: process.pid,
      metricsPort: 9091,
      cwd: '/tmp/first',
      startedAt: '2026-04-05T03:01:00.000Z',
      command: ['bun', 'agent-loop'],
      logPath: '/tmp/first.log',
    }))
    writeFileSync(join(runtimeDir, 'second.json'), JSON.stringify({
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-b',
      healthPort: 9312,
      supervisor: 'launchd',
      pid: process.pid,
      metricsPort: 9092,
      cwd: '/tmp/second',
      startedAt: '2026-04-05T03:02:00.000Z',
      command: ['bun', 'agent-loop'],
      logPath: '/tmp/second.log',
    }))

    expect(() => resolveBackgroundRuntimeRecord({
      repo: 'JamesWuHK/digital-employee',
      homeDir,
    })).toThrow('Multiple background daemon records matched')
  })

  test('detects the current process runtime supervisor from environment', () => {
    expect(resolveCurrentRuntimeSupervisor({ AGENT_LOOP_RUNTIME_MANAGER: 'launchd' })).toBe('launchd')
    expect(resolveCurrentRuntimeSupervisor({ AGENT_LOOP_RUNTIME_MANAGER: 'detached' })).toBe('detached')
    expect(resolveCurrentRuntimeSupervisor({})).toBe('direct')
  })
})
