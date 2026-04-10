import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildWakeRequestFromCli,
  buildManagedRestartArgs,
  buildManagedRuntimeLaunchArgs,
  cleanupManagedRuntimeRecord,
  executeWakeCommand,
  executeWakeRequest,
  formatManagedRuntimeLog,
  readManagedRuntimeLog,
  resolveWakeCommand,
  startManagedRuntime,
  reconcileManagedRuntime,
  formatLaunchdStatus,
  formatRuntimeListing,
  restartManagedRuntime,
  shouldRemoveManagedRuntimeRecord,
  stopManagedRuntime,
} from './index'
import type { BackgroundRuntimeSnapshot } from './background'
import { appendWakeRequest, buildWakeQueuePath } from './wake-queue'

describe('index helpers', () => {
  test('builds stable restart args for a managed runtime', () => {
    expect(buildManagedRestartArgs({
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-dev',
      healthPort: 9311,
      metricsPort: 9091,
    })).toEqual([
      '--repo', 'JamesWuHK/digital-employee',
      '--machine-id', 'codex-dev',
      '--health-port', '9311',
      '--metrics-port', '9091',
    ])
  })

  test('resolves wake commands and validates targeted wake numbers', () => {
    expect(resolveWakeCommand({
      'wake-now': true,
    })).toEqual({
      kind: 'now',
    })

    expect(resolveWakeCommand({
      'wake-issue': '42',
    })).toEqual({
      kind: 'issue',
      issueNumber: 42,
    })

    expect(resolveWakeCommand({
      'wake-pr': '381',
    })).toEqual({
      kind: 'pr',
      prNumber: 381,
    })

    expect(() => resolveWakeCommand({
      'wake-issue': 'abc',
    })).toThrow('--wake-issue must be a positive integer')

    expect(() => resolveWakeCommand({
      'wake-now': true,
      'wake-pr': '381',
    })).toThrow('Only one of --wake-now, --wake-issue, or --wake-pr can be used at a time')
  })

  test('builds stable wake requests from CLI commands', () => {
    expect(buildWakeRequestFromCli(
      { kind: 'issue', issueNumber: 374 },
      '2026-04-11T09:30:00.000Z',
    )).toEqual({
      kind: 'issue',
      issueNumber: 374,
      reason: 'cli:wake-issue',
      sourceEvent: 'cli',
      dedupeKey: 'cli:wake-issue:374',
      requestedAt: '2026-04-11T09:30:00.000Z',
    })
  })

  test('persists wake requests even when local daemon notification fails', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'agent-loop-wake-command-test-'))

    const result = await executeWakeCommand({
      command: { kind: 'pr', prNumber: 381 },
      healthPort: 9311,
    }, {
      resolveLocalDaemonIdentity: () => ({
        repo: 'JamesWuHK/agent-loop',
        machineId: 'macbook-pro-b',
      }),
      buildWakeQueuePath: (input) => buildWakeQueuePath({
        ...input,
        homeDir,
      }),
      appendWakeRequest,
      notifyLocalWake: async () => {
        throw new Error('connection refused')
      },
      now: () => new Date('2026-04-11T09:40:00.000Z'),
    })

    const queuePath = buildWakeQueuePath({
      repo: 'JamesWuHK/agent-loop',
      machineId: 'macbook-pro-b',
      homeDir,
    })

    expect(result).toEqual({
      queuePath,
      request: {
        kind: 'pr',
        prNumber: 381,
        reason: 'cli:wake-pr',
        sourceEvent: 'cli',
        dedupeKey: 'cli:wake-pr:381',
        requestedAt: '2026-04-11T09:40:00.000Z',
      },
      notified: false,
    })
    expect(readFileSync(queuePath, 'utf-8')).toBe(
      '{"kind":"pr","prNumber":381,"reason":"cli:wake-pr","sourceEvent":"cli","dedupeKey":"cli:wake-pr:381","requestedAt":"2026-04-11T09:40:00.000Z"}\n',
    )
  })

  test('persists prebuilt github-event wake requests through the shared wake execution path', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'agent-loop-wake-request-test-'))

    const result = await executeWakeRequest({
      request: {
        kind: 'issue',
        issueNumber: 374,
        reason: 'issues.labeled:agent:ready',
        sourceEvent: 'issues.labeled',
        dedupeKey: 'issues:labeled:374:agent:ready',
        requestedAt: '2026-04-11T09:41:00.000Z',
      },
      healthPort: 9311,
    }, {
      resolveLocalDaemonIdentity: () => ({
        repo: 'JamesWuHK/agent-loop',
        machineId: 'macbook-pro-b',
      }),
      buildWakeQueuePath: (input) => buildWakeQueuePath({
        ...input,
        homeDir,
      }),
      appendWakeRequest,
      notifyLocalWake: async () => undefined,
      now: () => new Date('2026-04-11T09:41:00.000Z'),
    })

    expect(result).toEqual({
      queuePath: buildWakeQueuePath({
        repo: 'JamesWuHK/agent-loop',
        machineId: 'macbook-pro-b',
        homeDir,
      }),
      request: {
        kind: 'issue',
        issueNumber: 374,
        reason: 'issues.labeled:agent:ready',
        sourceEvent: 'issues.labeled',
        dedupeKey: 'issues:labeled:374:agent:ready',
        requestedAt: '2026-04-11T09:41:00.000Z',
      },
      notified: true,
    })
  })

  test('preserves existing managed runtime launch args and replaces explicit overrides', () => {
    expect(buildManagedRuntimeLaunchArgs({
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-dev',
      healthPort: 9311,
      metricsPort: 9091,
      existingArgs: [
        '--repo', 'JamesWuHK/digital-employee',
        '--machine-id', 'codex-dev',
        '--health-port', '9311',
        '--metrics-port', '9091',
        '--concurrency', '1',
        '--poll-interval', '45000',
      ],
      overrideArgs: ['--restart', '--concurrency', '2'],
    })).toEqual([
      '--repo', 'JamesWuHK/digital-employee',
      '--machine-id', 'codex-dev',
      '--health-port', '9311',
      '--metrics-port', '9091',
      '--poll-interval', '45000',
      '--concurrency', '2',
    ])
  })

  test('replaces selector flags instead of duplicating them during managed restart', () => {
    expect(buildManagedRuntimeLaunchArgs({
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-dev',
      healthPort: 9311,
      metricsPort: 9091,
      existingArgs: [
        '--repo', 'JamesWuHK/digital-employee',
        '--machine-id', 'codex-dev',
        '--health-port', '9311',
        '--metrics-port', '9091',
        '--concurrency', '1',
      ],
      overrideArgs: [
        '--restart',
        '--repo', 'JamesWuHK/digital-employee',
        '--machine-id', 'codex-dev',
        '--health-port', '9311',
        '--metrics-port', '9091',
        '--concurrency', '2',
      ],
    })).toEqual([
      '--repo', 'JamesWuHK/digital-employee',
      '--machine-id', 'codex-dev',
      '--health-port', '9311',
      '--metrics-port', '9091',
      '--concurrency', '2',
    ])
  })

  test('preserves launchd runtime records on managed shutdown for offline diagnostics', () => {
    expect(shouldRemoveManagedRuntimeRecord('launchd')).toBe(false)
    expect(shouldRemoveManagedRuntimeRecord('detached')).toBe(true)
    expect(shouldRemoveManagedRuntimeRecord('direct')).toBe(true)
  })

  test('removes detached runtime records only when the current process still owns them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-loop-managed-cleanup-test-'))
    const runtimeFile = join(dir, 'runtime.json')
    writeFileSync(runtimeFile, JSON.stringify({
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-dev',
      healthPort: 9311,
      supervisor: 'detached',
      pid: 12345,
      metricsPort: 9091,
      cwd: '/tmp/workdir',
      startedAt: '2026-04-05T03:00:00.000Z',
      command: ['bun', 'apps/agent-daemon/src/index.ts'],
      logPath: '/tmp/daemon.log',
    }))

    expect(cleanupManagedRuntimeRecord({
      runtimeFile,
      supervisor: 'detached',
      pid: 12345,
    })).toBe('removed')
    expect(existsSync(runtimeFile)).toBe(false)
  })

  test('preserves detached runtime records when a newer daemon instance already owns them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-loop-managed-cleanup-foreign-test-'))
    const runtimeFile = join(dir, 'runtime.json')
    writeFileSync(runtimeFile, JSON.stringify({
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-dev',
      healthPort: 9311,
      supervisor: 'detached',
      pid: 67890,
      metricsPort: 9091,
      cwd: '/tmp/workdir',
      startedAt: '2026-04-05T03:00:00.000Z',
      command: ['bun', 'apps/agent-daemon/src/index.ts'],
      logPath: '/tmp/daemon.log',
    }))

    expect(cleanupManagedRuntimeRecord({
      runtimeFile,
      supervisor: 'detached',
      pid: 12345,
    })).toBe('not-owned')
    expect(existsSync(runtimeFile)).toBe(true)
  })

  test('reads and tails managed daemon logs from a discovered runtime record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-loop-log-test-'))
    const logPath = join(dir, 'daemon.log')
    writeFileSync(logPath, [
      'line-1',
      'line-2',
      'line-3',
      'line-4',
    ].join('\n'))

    const result = readManagedRuntimeLog({
      discoveredRuntime: buildRuntimeSnapshot({
        logPath,
      }),
      healthPort: 9311,
      maxLines: 2,
    })

    expect(result).toEqual({
      found: true,
      path: logPath,
      content: 'line-3\nline-4',
      truncated: true,
      message: `Showing last 2 log lines from ${logPath}`,
    })
    expect(formatManagedRuntimeLog(result)).toContain('line-3\nline-4')
  })

  test('reports when no managed daemon log file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-loop-missing-log-test-'))
    const missingLogPath = join(dir, 'missing-daemon.log')

    const result = readManagedRuntimeLog({
      discoveredRuntime: buildRuntimeSnapshot({
        logPath: missingLogPath,
      }),
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-dev',
      healthPort: 9311,
    })

    expect(result.found).toBe(false)
    expect(result.path).toBe(missingLogPath)
    expect(formatManagedRuntimeLog(result)).toContain('No managed daemon log file found')
  })

  test('starts detached runtimes by launching a new background daemon when none is running', () => {
    const calls: string[] = []
    const result = startManagedRuntime({
      discoveredRuntime: null,
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-dev',
      healthPort: 9311,
      metricsPort: 9091,
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/Users/wujames/codeRepo/agent-loop/apps/agent-daemon/src/index.ts',
      argv: ['--start'],
    }, {
      platform: 'linux',
      resolveLocalDaemonIdentity: () => ({ repo: 'JamesWuHK/digital-employee', machineId: 'codex-dev' }),
      buildLaunchdServicePaths: () => ({
        label: 'unused',
        launchAgentsDir: '/Users/wujames/Library/LaunchAgents',
        plistPath: '/Users/wujames/Library/LaunchAgents/unused.plist',
        domain: 'gui/501',
        serviceTarget: 'gui/501/unused',
        runtimeRecordPath: '/tmp/unused.json',
        logPath: '/tmp/unused.log',
      }),
      inspectLaunchdService: () => ({
        label: 'unused',
        serviceTarget: 'gui/501/unused',
        plistPath: '/Users/wujames/Library/LaunchAgents/unused.plist',
        runtimeRecordPath: '/tmp/unused.json',
        logPath: '/tmp/unused.log',
        installed: false,
        loaded: false,
        detail: null,
        runtime: null,
      }),
      startLaunchdService: () => ({
        started: false,
        message: 'unused',
      }),
      restartLaunchdService: () => ({
        restarted: false,
        message: 'unused',
      }),
      stopLaunchdService: () => ({
        stopped: false,
        message: 'unused',
      }),
      stopBackgroundRuntime: () => ({
        stopped: false,
        message: 'unused',
      }),
      launchBackgroundRuntime: (input) => {
        calls.push(`launch:${input.identity.repo}:${input.identity.machineId}:${input.identity.healthPort}:${input.metricsPort}`)
        expect(input.argv).toEqual([
          '--repo', 'JamesWuHK/digital-employee',
          '--machine-id', 'codex-dev',
          '--health-port', '9311',
          '--metrics-port', '9091',
        ])
        return {
          ...buildRuntimeSnapshot().record,
          pid: 67890,
        }
      },
    })

    expect(result).toEqual({
      kind: 'detached',
      started: true,
      message: 'started detached daemon with pid 67890',
    })
    expect(calls).toEqual([
      'launch:JamesWuHK/digital-employee:codex-dev:9311:9091',
    ])
  })

  test('starts stale detached runtimes with the recorded concurrency and poll interval when no overrides are provided', () => {
    const result = startManagedRuntime({
      discoveredRuntime: buildRuntimeSnapshot({
        pid: 12345,
        command: [
          '/Users/wujames/.local/bin/bun',
          '/Users/wujames/codeRepo/数字员工/apps/agent-daemon/src/index.ts',
          '--repo', 'JamesWuHK/digital-employee',
          '--machine-id', 'codex-dev',
          '--health-port', '9311',
          '--metrics-port', '9091',
          '--concurrency', '2',
          '--poll-interval', '45000',
        ],
      }, false),
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-dev',
      healthPort: 9311,
      metricsPort: 9091,
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/Users/wujames/codeRepo/agent-loop/apps/agent-daemon/src/index.ts',
      argv: ['--start'],
    }, {
      platform: 'linux',
      resolveLocalDaemonIdentity: () => ({ repo: 'JamesWuHK/digital-employee', machineId: 'codex-dev' }),
      buildLaunchdServicePaths: () => ({
        label: 'unused',
        launchAgentsDir: '/Users/wujames/Library/LaunchAgents',
        plistPath: '/Users/wujames/Library/LaunchAgents/unused.plist',
        domain: 'gui/501',
        serviceTarget: 'gui/501/unused',
        runtimeRecordPath: '/tmp/unused.json',
        logPath: '/tmp/unused.log',
      }),
      inspectLaunchdService: () => ({
        label: 'unused',
        serviceTarget: 'gui/501/unused',
        plistPath: '/Users/wujames/Library/LaunchAgents/unused.plist',
        runtimeRecordPath: '/tmp/unused.json',
        logPath: '/tmp/unused.log',
        installed: false,
        loaded: false,
        detail: null,
        runtime: null,
      }),
      startLaunchdService: () => ({
        started: false,
        message: 'unused',
      }),
      restartLaunchdService: () => ({
        restarted: false,
        message: 'unused',
      }),
      stopLaunchdService: () => ({
        stopped: false,
        message: 'unused',
      }),
      stopBackgroundRuntime: () => ({
        stopped: false,
        message: 'Removed stale background runtime record for pid 12345',
      }),
      launchBackgroundRuntime: (input) => {
        expect(input.argv).toEqual([
          '--repo', 'JamesWuHK/digital-employee',
          '--machine-id', 'codex-dev',
          '--health-port', '9311',
          '--metrics-port', '9091',
          '--concurrency', '2',
          '--poll-interval', '45000',
        ])
        return {
          ...buildRuntimeSnapshot().record,
          pid: 67890,
        }
      },
    })

    expect(result).toEqual({
      kind: 'detached',
      started: true,
      message: 'Removed stale background runtime record for pid 12345; started detached daemon with pid 67890',
    })
  })

  test('starts installed launchd services when they are currently stopped', () => {
    const calls: string[] = []
    const result = startManagedRuntime({
      discoveredRuntime: buildRuntimeSnapshot({
        supervisor: 'launchd',
      }, false),
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-dev',
      healthPort: 9311,
      metricsPort: 9091,
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/Users/wujames/codeRepo/agent-loop/apps/agent-daemon/src/index.ts',
      argv: ['--start'],
    }, {
      platform: 'darwin',
      resolveLocalDaemonIdentity: () => ({ repo: 'JamesWuHK/digital-employee', machineId: 'codex-dev' }),
      buildLaunchdServicePaths: () => ({
        label: 'com.agentloop.example',
        launchAgentsDir: '/Users/wujames/Library/LaunchAgents',
        plistPath: '/Users/wujames/Library/LaunchAgents/com.agentloop.example.plist',
        domain: 'gui/501',
        serviceTarget: 'gui/501/com.agentloop.example',
        runtimeRecordPath: '/tmp/runtime.json',
        logPath: '/tmp/runtime.log',
      }),
      inspectLaunchdService: (paths) => ({
        label: paths.label,
        serviceTarget: paths.serviceTarget,
        plistPath: paths.plistPath,
        runtimeRecordPath: paths.runtimeRecordPath,
        logPath: paths.logPath,
        installed: true,
        loaded: false,
        detail: '<plist />',
        runtime: null,
      }),
      startLaunchdService: (paths) => {
        calls.push(`start:${paths.serviceTarget}`)
        return {
          started: true,
          message: `Started launchd service ${paths.label}`,
        }
      },
      restartLaunchdService: () => ({
        restarted: false,
        message: 'unused',
      }),
      stopLaunchdService: () => ({
        stopped: false,
        message: 'unused',
      }),
      stopBackgroundRuntime: () => ({
        stopped: false,
        message: 'unused',
      }),
      launchBackgroundRuntime: () => buildRuntimeSnapshot().record,
    })

    expect(result).toEqual({
      kind: 'launchd',
      started: true,
      message: 'Started launchd service com.agentloop.example',
    })
    expect(calls).toEqual([
      'start:gui/501/com.agentloop.example',
    ])
  })

  test('reports when launchd services are already running during start', () => {
    expect(startManagedRuntime({
      discoveredRuntime: buildRuntimeSnapshot({
        supervisor: 'launchd',
      }),
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-dev',
      healthPort: 9311,
      metricsPort: 9091,
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/Users/wujames/codeRepo/agent-loop/apps/agent-daemon/src/index.ts',
      argv: ['--start'],
    }, {
      platform: 'darwin',
      resolveLocalDaemonIdentity: () => ({ repo: 'JamesWuHK/digital-employee', machineId: 'codex-dev' }),
      buildLaunchdServicePaths: () => ({
        label: 'com.agentloop.example',
        launchAgentsDir: '/Users/wujames/Library/LaunchAgents',
        plistPath: '/Users/wujames/Library/LaunchAgents/com.agentloop.example.plist',
        domain: 'gui/501',
        serviceTarget: 'gui/501/com.agentloop.example',
        runtimeRecordPath: '/tmp/runtime.json',
        logPath: '/tmp/runtime.log',
      }),
      inspectLaunchdService: (paths) => ({
        label: paths.label,
        serviceTarget: paths.serviceTarget,
        plistPath: paths.plistPath,
        runtimeRecordPath: paths.runtimeRecordPath,
        logPath: paths.logPath,
        installed: true,
        loaded: true,
        detail: 'state = running',
        runtime: {
          serviceTarget: paths.serviceTarget,
          activeCount: 1,
          state: 'running',
          pid: 12345,
          runs: 2,
          lastTerminatingSignal: 'Terminated: 15',
        },
      }),
      startLaunchdService: () => ({
        started: false,
        message: 'unused',
      }),
      restartLaunchdService: () => ({
        restarted: false,
        message: 'unused',
      }),
      stopLaunchdService: () => ({
        stopped: false,
        message: 'unused',
      }),
      stopBackgroundRuntime: () => ({
        stopped: false,
        message: 'unused',
      }),
      launchBackgroundRuntime: () => buildRuntimeSnapshot().record,
    })).toEqual({
      kind: 'launchd',
      started: true,
      message: 'Launchd service com.agentloop.example is already running',
    })
  })

  test('restarts detached runtimes by stopping the old pid and launching a new background daemon', () => {
    const calls: string[] = []
    const result = restartManagedRuntime({
      discoveredRuntime: buildRuntimeSnapshot(),
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-dev',
      healthPort: 9311,
      metricsPort: 9091,
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/Users/wujames/codeRepo/agent-loop/apps/agent-daemon/src/index.ts',
      argv: ['--restart'],
    }, {
      platform: 'darwin',
      resolveLocalDaemonIdentity: () => ({ repo: 'JamesWuHK/digital-employee', machineId: 'codex-dev' }),
      buildLaunchdServicePaths: () => ({
        label: 'unused',
        launchAgentsDir: '/Users/wujames/Library/LaunchAgents',
        plistPath: '/Users/wujames/Library/LaunchAgents/unused.plist',
        domain: 'gui/501',
        serviceTarget: 'gui/501/unused',
        runtimeRecordPath: '/tmp/unused.json',
        logPath: '/tmp/unused.log',
      }),
      inspectLaunchdService: () => ({
        label: 'unused',
        serviceTarget: 'gui/501/unused',
        plistPath: '/Users/wujames/Library/LaunchAgents/unused.plist',
        runtimeRecordPath: '/tmp/unused.json',
        logPath: '/tmp/unused.log',
        installed: false,
        loaded: false,
        detail: null,
        runtime: null,
      }),
      restartLaunchdService: () => ({
        restarted: true,
        message: 'unused',
      }),
      stopBackgroundRuntime: (recordPath, options) => {
        calls.push(`stop:${recordPath}:${options?.timeoutMs ?? 'default'}`)
        return {
          stopped: true,
          message: 'Sent SIGTERM to background daemon pid 12345',
        }
      },
      launchBackgroundRuntime: (input) => {
        calls.push(`launch:${input.identity.repo}:${input.identity.machineId}:${input.identity.healthPort}:${input.metricsPort}`)
        expect(input.argv).toEqual([
          '--repo', 'JamesWuHK/digital-employee',
          '--machine-id', 'codex-dev',
          '--health-port', '9311',
          '--metrics-port', '9091',
        ])
        return {
          ...buildRuntimeSnapshot().record,
          pid: 67890,
        }
      },
    })

    expect(result).toEqual({
      kind: 'detached',
      restarted: true,
      message: 'Sent SIGTERM to background daemon pid 12345; restarted detached daemon with pid 67890',
    })
    expect(calls).toEqual([
      'stop:/Users/wujames/.agent-loop/runtime/runtime.json:30000',
      'launch:JamesWuHK/digital-employee:codex-dev:9311:9091',
    ])
  })

  test('restarts detached runtimes with CLI concurrency overrides on top of the recorded launch args', () => {
    const runtime = buildRuntimeSnapshot({
      command: [
        '/Users/wujames/.local/bin/bun',
        '/Users/wujames/codeRepo/数字员工/apps/agent-daemon/src/index.ts',
        '--repo', 'JamesWuHK/digital-employee',
        '--machine-id', 'codex-dev',
        '--health-port', '9311',
        '--metrics-port', '9091',
        '--concurrency', '1',
      ],
    })

    const result = restartManagedRuntime({
      discoveredRuntime: runtime,
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-dev',
      healthPort: 9311,
      metricsPort: 9091,
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/Users/wujames/codeRepo/agent-loop/apps/agent-daemon/src/index.ts',
      argv: ['--restart', '--concurrency', '2', '--poll-interval', '45000'],
    }, {
      platform: 'linux',
      resolveLocalDaemonIdentity: () => ({ repo: 'JamesWuHK/digital-employee', machineId: 'codex-dev' }),
      buildLaunchdServicePaths: () => ({
        label: 'unused',
        launchAgentsDir: '/Users/wujames/Library/LaunchAgents',
        plistPath: '/Users/wujames/Library/LaunchAgents/unused.plist',
        domain: 'gui/501',
        serviceTarget: 'gui/501/unused',
        runtimeRecordPath: '/tmp/unused.json',
        logPath: '/tmp/unused.log',
      }),
      inspectLaunchdService: () => ({
        label: 'unused',
        serviceTarget: 'gui/501/unused',
        plistPath: '/Users/wujames/Library/LaunchAgents/unused.plist',
        runtimeRecordPath: '/tmp/unused.json',
        logPath: '/tmp/unused.log',
        installed: false,
        loaded: false,
        detail: null,
        runtime: null,
      }),
      restartLaunchdService: () => ({
        restarted: true,
        message: 'unused',
      }),
      stopBackgroundRuntime: () => ({
        stopped: true,
        message: 'Sent SIGTERM to background daemon pid 12345',
      }),
      launchBackgroundRuntime: (input) => {
        expect(input.argv).toEqual([
          '--repo', 'JamesWuHK/digital-employee',
          '--machine-id', 'codex-dev',
          '--health-port', '9311',
          '--metrics-port', '9091',
          '--concurrency', '2',
          '--poll-interval', '45000',
        ])
        return {
          ...runtime.record,
          pid: 67890,
        }
      },
    })

    expect(result).toEqual({
      kind: 'detached',
      restarted: true,
      message: 'Sent SIGTERM to background daemon pid 12345; restarted detached daemon with pid 67890',
    })
  })

  test('does not relaunch a detached runtime until the old pid has actually exited', () => {
    let launched = false
    let timeoutMs: number | undefined

    const result = restartManagedRuntime({
      discoveredRuntime: buildRuntimeSnapshot(),
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-dev',
      healthPort: 9311,
      metricsPort: 9091,
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/Users/wujames/codeRepo/agent-loop/apps/agent-daemon/src/index.ts',
      argv: ['--restart'],
    }, {
      platform: 'linux',
      resolveLocalDaemonIdentity: () => ({ repo: 'JamesWuHK/digital-employee', machineId: 'codex-dev' }),
      buildLaunchdServicePaths: () => ({
        label: 'unused',
        launchAgentsDir: '/Users/wujames/Library/LaunchAgents',
        plistPath: '/Users/wujames/Library/LaunchAgents/unused.plist',
        domain: 'gui/501',
        serviceTarget: 'gui/501/unused',
        runtimeRecordPath: '/tmp/unused.json',
        logPath: '/tmp/unused.log',
      }),
      inspectLaunchdService: () => ({
        label: 'unused',
        serviceTarget: 'gui/501/unused',
        plistPath: '/Users/wujames/Library/LaunchAgents/unused.plist',
        runtimeRecordPath: '/tmp/unused.json',
        logPath: '/tmp/unused.log',
        installed: false,
        loaded: false,
        detail: null,
        runtime: null,
      }),
      restartLaunchdService: () => ({
        restarted: true,
        message: 'unused',
      }),
      stopBackgroundRuntime: (_recordPath, options) => {
        timeoutMs = options?.timeoutMs
        return {
          stopped: false,
          message: 'Sent SIGTERM to background daemon pid 12345, but it did not exit within 30000ms',
        }
      },
      launchBackgroundRuntime: () => {
        launched = true
        return buildRuntimeSnapshot().record
      },
    })

    expect(result).toEqual({
      kind: 'detached',
      restarted: false,
      message: 'Sent SIGTERM to background daemon pid 12345, but it did not exit within 30000ms',
    })
    expect(launched).toBe(false)
    expect(timeoutMs).toBe(30_000)
  })

  test('restarts installed launchd services even when no runtime record is currently discovered', () => {
    const calls: string[] = []
    const result = restartManagedRuntime({
      discoveredRuntime: null,
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-dev',
      healthPort: 9311,
      metricsPort: 9091,
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/Users/wujames/codeRepo/agent-loop/apps/agent-daemon/src/index.ts',
      argv: ['--restart'],
    }, {
      platform: 'darwin',
      resolveLocalDaemonIdentity: () => ({ repo: 'JamesWuHK/digital-employee', machineId: 'codex-dev' }),
      buildLaunchdServicePaths: (identity) => {
        calls.push(`paths:${identity.repo}:${identity.machineId}:${identity.healthPort}`)
        return {
          label: 'com.agentloop.example',
          launchAgentsDir: '/Users/wujames/Library/LaunchAgents',
          plistPath: '/Users/wujames/Library/LaunchAgents/com.agentloop.example.plist',
          domain: 'gui/501',
          serviceTarget: 'gui/501/com.agentloop.example',
          runtimeRecordPath: '/tmp/runtime.json',
          logPath: '/tmp/runtime.log',
        }
      },
      inspectLaunchdService: (paths) => {
        calls.push(`inspect:${paths.serviceTarget}`)
        return {
          label: paths.label,
          serviceTarget: paths.serviceTarget,
          plistPath: paths.plistPath,
          runtimeRecordPath: paths.runtimeRecordPath,
          logPath: paths.logPath,
          installed: true,
          loaded: true,
          detail: 'state = running',
          runtime: null,
        }
      },
      restartLaunchdService: (paths) => {
        calls.push(`restart:${paths.serviceTarget}`)
        return {
          restarted: true,
          message: `Restarted launchd service ${paths.label}`,
        }
      },
      stopBackgroundRuntime: () => ({
        stopped: false,
        message: 'unused',
      }),
      launchBackgroundRuntime: () => buildRuntimeSnapshot().record,
    })

    expect(result).toEqual({
      kind: 'launchd',
      restarted: true,
      message: 'Restarted launchd service com.agentloop.example',
    })
    expect(calls).toEqual([
      'paths:JamesWuHK/digital-employee:codex-dev:9311',
      'inspect:gui/501/com.agentloop.example',
      'restart:gui/501/com.agentloop.example',
    ])
  })

  test('reports when no managed runtime or installed launchd service matches restart request', () => {
    expect(restartManagedRuntime({
      discoveredRuntime: null,
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-dev',
      healthPort: 9311,
      metricsPort: 9091,
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/Users/wujames/codeRepo/agent-loop/apps/agent-daemon/src/index.ts',
      argv: ['--restart'],
    }, {
      platform: 'darwin',
      resolveLocalDaemonIdentity: () => ({ repo: 'JamesWuHK/digital-employee', machineId: 'codex-dev' }),
      buildLaunchdServicePaths: () => ({
        label: 'com.agentloop.example',
        launchAgentsDir: '/Users/wujames/Library/LaunchAgents',
        plistPath: '/Users/wujames/Library/LaunchAgents/com.agentloop.example.plist',
        domain: 'gui/501',
        serviceTarget: 'gui/501/com.agentloop.example',
        runtimeRecordPath: '/tmp/runtime.json',
        logPath: '/tmp/runtime.log',
      }),
      inspectLaunchdService: (paths) => ({
        label: paths.label,
        serviceTarget: paths.serviceTarget,
        plistPath: paths.plistPath,
        runtimeRecordPath: paths.runtimeRecordPath,
        logPath: paths.logPath,
        installed: false,
        loaded: false,
        detail: null,
        runtime: null,
      }),
      restartLaunchdService: () => ({
        restarted: false,
        message: 'unused',
      }),
      stopBackgroundRuntime: () => ({
        stopped: false,
        message: 'unused',
      }),
      launchBackgroundRuntime: () => buildRuntimeSnapshot().record,
    })).toEqual({
      kind: 'none',
      restarted: false,
      message: 'No managed daemon runtime or launchd service matched the current repo/machine-id/health-port',
    })
  })

  test('stops detached runtimes by terminating the recorded background process', () => {
    const calls: string[] = []
    const result = stopManagedRuntime({
      discoveredRuntime: buildRuntimeSnapshot(),
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-dev',
      healthPort: 9311,
      metricsPort: 9091,
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/Users/wujames/codeRepo/agent-loop/apps/agent-daemon/src/index.ts',
      argv: ['--stop'],
    }, {
      platform: 'darwin',
      resolveLocalDaemonIdentity: () => ({ repo: 'JamesWuHK/digital-employee', machineId: 'codex-dev' }),
      buildLaunchdServicePaths: () => ({
        label: 'unused',
        launchAgentsDir: '/Users/wujames/Library/LaunchAgents',
        plistPath: '/Users/wujames/Library/LaunchAgents/unused.plist',
        domain: 'gui/501',
        serviceTarget: 'gui/501/unused',
        runtimeRecordPath: '/tmp/unused.json',
        logPath: '/tmp/unused.log',
      }),
      inspectLaunchdService: () => ({
        label: 'unused',
        serviceTarget: 'gui/501/unused',
        plistPath: '/Users/wujames/Library/LaunchAgents/unused.plist',
        runtimeRecordPath: '/tmp/unused.json',
        logPath: '/tmp/unused.log',
        installed: false,
        loaded: false,
        detail: null,
        runtime: null,
      }),
      restartLaunchdService: () => ({
        restarted: false,
        message: 'unused',
      }),
      stopLaunchdService: () => ({
        stopped: false,
        message: 'unused',
      }),
      stopBackgroundRuntime: (recordPath) => {
        calls.push(`stop:${recordPath}`)
        return {
          stopped: true,
          message: 'Sent SIGTERM to background daemon pid 12345',
        }
      },
      launchBackgroundRuntime: () => buildRuntimeSnapshot().record,
    })

    expect(result).toEqual({
      kind: 'detached',
      stopped: true,
      message: 'Sent SIGTERM to background daemon pid 12345',
    })
    expect(calls).toEqual([
      'stop:/Users/wujames/.agent-loop/runtime/runtime.json',
    ])
  })

  test('stops installed launchd services without falling back to detached pid termination', () => {
    const calls: string[] = []
    const result = stopManagedRuntime({
      discoveredRuntime: buildRuntimeSnapshot({
        supervisor: 'launchd',
      }),
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-dev',
      healthPort: 9311,
      metricsPort: 9091,
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/Users/wujames/codeRepo/agent-loop/apps/agent-daemon/src/index.ts',
      argv: ['--stop'],
    }, {
      platform: 'darwin',
      resolveLocalDaemonIdentity: () => ({ repo: 'JamesWuHK/digital-employee', machineId: 'codex-dev' }),
      buildLaunchdServicePaths: () => ({
        label: 'com.agentloop.example',
        launchAgentsDir: '/Users/wujames/Library/LaunchAgents',
        plistPath: '/Users/wujames/Library/LaunchAgents/com.agentloop.example.plist',
        domain: 'gui/501',
        serviceTarget: 'gui/501/com.agentloop.example',
        runtimeRecordPath: '/tmp/runtime.json',
        logPath: '/tmp/runtime.log',
      }),
      inspectLaunchdService: (paths) => ({
        label: paths.label,
        serviceTarget: paths.serviceTarget,
        plistPath: paths.plistPath,
        runtimeRecordPath: paths.runtimeRecordPath,
        logPath: paths.logPath,
        installed: true,
        loaded: true,
        detail: 'state = running',
        runtime: {
          serviceTarget: paths.serviceTarget,
          activeCount: 1,
          state: 'running',
          pid: 12345,
          runs: 2,
          lastTerminatingSignal: 'Terminated: 15',
        },
      }),
      restartLaunchdService: () => ({
        restarted: false,
        message: 'unused',
      }),
      stopLaunchdService: (paths) => {
        calls.push(`launchd-stop:${paths.serviceTarget}`)
        return {
          stopped: true,
          message: `Stopped launchd service ${paths.label}`,
        }
      },
      stopBackgroundRuntime: (recordPath) => {
        calls.push(`detached-stop:${recordPath}`)
        return {
          stopped: true,
          message: 'unused',
        }
      },
      launchBackgroundRuntime: () => buildRuntimeSnapshot().record,
    })

    expect(result).toEqual({
      kind: 'launchd',
      stopped: true,
      message: 'Stopped launchd service com.agentloop.example',
    })
    expect(calls).toEqual([
      'launchd-stop:gui/501/com.agentloop.example',
    ])
  })

  test('reports when no managed runtime or installed launchd service matches stop request', () => {
    expect(stopManagedRuntime({
      discoveredRuntime: null,
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-dev',
      healthPort: 9311,
      metricsPort: 9091,
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/Users/wujames/codeRepo/agent-loop/apps/agent-daemon/src/index.ts',
      argv: ['--stop'],
    }, {
      platform: 'darwin',
      resolveLocalDaemonIdentity: () => ({ repo: 'JamesWuHK/digital-employee', machineId: 'codex-dev' }),
      buildLaunchdServicePaths: () => ({
        label: 'com.agentloop.example',
        launchAgentsDir: '/Users/wujames/Library/LaunchAgents',
        plistPath: '/Users/wujames/Library/LaunchAgents/com.agentloop.example.plist',
        domain: 'gui/501',
        serviceTarget: 'gui/501/com.agentloop.example',
        runtimeRecordPath: '/tmp/runtime.json',
        logPath: '/tmp/runtime.log',
      }),
      inspectLaunchdService: (paths) => ({
        label: paths.label,
        serviceTarget: paths.serviceTarget,
        plistPath: paths.plistPath,
        runtimeRecordPath: paths.runtimeRecordPath,
        logPath: paths.logPath,
        installed: false,
        loaded: false,
        detail: null,
        runtime: null,
      }),
      restartLaunchdService: () => ({
        restarted: false,
        message: 'unused',
      }),
      stopLaunchdService: () => ({
        stopped: false,
        message: 'unused',
      }),
      stopBackgroundRuntime: () => ({
        stopped: false,
        message: 'unused',
      }),
      launchBackgroundRuntime: () => buildRuntimeSnapshot().record,
    })).toEqual({
      kind: 'none',
      stopped: false,
      message: 'No managed daemon runtime or launchd service matched the current repo/machine-id/health-port',
    })
  })

  test('reconciles a stale detached runtime by relaunching it from its recorded command', () => {
    const calls: string[] = []
    const result = reconcileManagedRuntime({
      discoveredRuntime: buildRuntimeSnapshot({
        pid: 999999,
      }, false),
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-dev',
      healthPort: 9311,
      metricsPort: 9091,
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/Users/wujames/codeRepo/agent-loop/apps/agent-daemon/src/index.ts',
      argv: ['--reconcile'],
    }, {
      platform: 'darwin',
      resolveLocalDaemonIdentity: () => ({ repo: 'JamesWuHK/digital-employee', machineId: 'codex-dev' }),
      buildLaunchdServicePaths: () => ({
        label: 'unused',
        launchAgentsDir: '/Users/wujames/Library/LaunchAgents',
        plistPath: '/Users/wujames/Library/LaunchAgents/unused.plist',
        domain: 'gui/501',
        serviceTarget: 'gui/501/unused',
        runtimeRecordPath: '/tmp/unused.json',
        logPath: '/tmp/unused.log',
      }),
      inspectLaunchdService: () => ({
        label: 'unused',
        serviceTarget: 'gui/501/unused',
        plistPath: '/Users/wujames/Library/LaunchAgents/unused.plist',
        runtimeRecordPath: '/tmp/unused.json',
        logPath: '/tmp/unused.log',
        installed: false,
        loaded: false,
        detail: null,
        runtime: null,
      }),
      restartLaunchdService: () => ({
        restarted: true,
        message: 'unused',
      }),
      stopBackgroundRuntime: (recordPath) => {
        calls.push(`stop:${recordPath}`)
        return {
          stopped: false,
          message: 'Removed stale background runtime record for pid 999999',
        }
      },
      launchBackgroundRuntime: (input) => {
        calls.push(`launch:${input.scriptPath}:${input.cwd}`)
        expect(input.argv).toEqual([])
        return {
          ...buildRuntimeSnapshot().record,
          pid: 67890,
        }
      },
    })

    expect(result).toEqual({
      kind: 'detached',
      ok: true,
      changed: true,
      message: 'Removed stale background runtime record for pid 999999; relaunched detached daemon with pid 67890',
    })
    expect(calls).toEqual([
      'stop:/Users/wujames/.agent-loop/runtime/runtime.json',
      'launch:apps/agent-daemon/src/index.ts:/Users/wujames/codeRepo/digital-employee-main',
    ])
  })

  test('reports healthy detached runtimes during reconcile without restarting', () => {
    expect(reconcileManagedRuntime({
      discoveredRuntime: buildRuntimeSnapshot(),
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-dev',
      healthPort: 9311,
      metricsPort: 9091,
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/Users/wujames/codeRepo/agent-loop/apps/agent-daemon/src/index.ts',
      argv: ['--reconcile'],
    }, {
      platform: 'darwin',
      resolveLocalDaemonIdentity: () => ({ repo: 'JamesWuHK/digital-employee', machineId: 'codex-dev' }),
      buildLaunchdServicePaths: () => ({
        label: 'unused',
        launchAgentsDir: '/Users/wujames/Library/LaunchAgents',
        plistPath: '/Users/wujames/Library/LaunchAgents/unused.plist',
        domain: 'gui/501',
        serviceTarget: 'gui/501/unused',
        runtimeRecordPath: '/tmp/unused.json',
        logPath: '/tmp/unused.log',
      }),
      inspectLaunchdService: () => ({
        label: 'unused',
        serviceTarget: 'gui/501/unused',
        plistPath: '/Users/wujames/Library/LaunchAgents/unused.plist',
        runtimeRecordPath: '/tmp/unused.json',
        logPath: '/tmp/unused.log',
        installed: false,
        loaded: false,
        detail: null,
        runtime: null,
      }),
      restartLaunchdService: () => ({
        restarted: true,
        message: 'unused',
      }),
      stopBackgroundRuntime: () => ({
        stopped: false,
        message: 'unused',
      }),
      launchBackgroundRuntime: () => buildRuntimeSnapshot().record,
    })).toEqual({
      kind: 'detached',
      ok: true,
      changed: false,
      message: 'Detached daemon pid 12345 is already healthy',
    })
  })

  test('reconciles installed launchd services when the runtime record is missing', () => {
    const result = reconcileManagedRuntime({
      discoveredRuntime: null,
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-dev',
      healthPort: 9311,
      metricsPort: 9091,
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/Users/wujames/codeRepo/agent-loop/apps/agent-daemon/src/index.ts',
      argv: ['--reconcile'],
    }, {
      platform: 'darwin',
      resolveLocalDaemonIdentity: () => ({ repo: 'JamesWuHK/digital-employee', machineId: 'codex-dev' }),
      buildLaunchdServicePaths: () => ({
        label: 'com.agentloop.example',
        launchAgentsDir: '/Users/wujames/Library/LaunchAgents',
        plistPath: '/Users/wujames/Library/LaunchAgents/com.agentloop.example.plist',
        domain: 'gui/501',
        serviceTarget: 'gui/501/com.agentloop.example',
        runtimeRecordPath: '/tmp/runtime.json',
        logPath: '/tmp/runtime.log',
      }),
      inspectLaunchdService: (paths) => ({
        label: paths.label,
        serviceTarget: paths.serviceTarget,
        plistPath: paths.plistPath,
        runtimeRecordPath: paths.runtimeRecordPath,
        logPath: paths.logPath,
        installed: true,
        loaded: true,
        detail: 'state = running',
        runtime: {
          serviceTarget: paths.serviceTarget,
          activeCount: 1,
          state: 'running',
          pid: 12345,
          runs: 2,
          lastTerminatingSignal: 'Terminated: 15',
        },
      }),
      restartLaunchdService: (paths) => ({
        restarted: true,
        message: `Restarted launchd service ${paths.label}`,
      }),
      stopBackgroundRuntime: () => ({
        stopped: false,
        message: 'unused',
      }),
      launchBackgroundRuntime: () => buildRuntimeSnapshot().record,
    })

    expect(result).toEqual({
      kind: 'launchd',
      ok: true,
      changed: true,
      message: 'Restarted launchd service com.agentloop.example (runtime record is missing)',
    })
  })

  test('reports healthy launchd services during reconcile without restarting', () => {
    expect(reconcileManagedRuntime({
      discoveredRuntime: buildRuntimeSnapshot({
        supervisor: 'launchd',
      }),
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-dev',
      healthPort: 9311,
      metricsPort: 9091,
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/Users/wujames/codeRepo/agent-loop/apps/agent-daemon/src/index.ts',
      argv: ['--reconcile'],
    }, {
      platform: 'darwin',
      resolveLocalDaemonIdentity: () => ({ repo: 'JamesWuHK/digital-employee', machineId: 'codex-dev' }),
      buildLaunchdServicePaths: () => ({
        label: 'com.agentloop.example',
        launchAgentsDir: '/Users/wujames/Library/LaunchAgents',
        plistPath: '/Users/wujames/Library/LaunchAgents/com.agentloop.example.plist',
        domain: 'gui/501',
        serviceTarget: 'gui/501/com.agentloop.example',
        runtimeRecordPath: '/tmp/runtime.json',
        logPath: '/tmp/runtime.log',
      }),
      inspectLaunchdService: (paths) => ({
        label: paths.label,
        serviceTarget: paths.serviceTarget,
        plistPath: paths.plistPath,
        runtimeRecordPath: paths.runtimeRecordPath,
        logPath: paths.logPath,
        installed: true,
        loaded: true,
        detail: 'state = running',
        runtime: {
          serviceTarget: paths.serviceTarget,
          activeCount: 1,
          state: 'running',
          pid: 12345,
          runs: 2,
          lastTerminatingSignal: 'Terminated: 15',
        },
      }),
      restartLaunchdService: () => ({
        restarted: true,
        message: 'unused',
      }),
      stopBackgroundRuntime: () => ({
        stopped: false,
        message: 'unused',
      }),
      launchBackgroundRuntime: () => buildRuntimeSnapshot().record,
    })).toEqual({
      kind: 'launchd',
      ok: true,
      changed: false,
      message: 'Launchd service com.agentloop.example is already healthy',
    })
  })

  test('formats local runtime and launchd status summaries', () => {
    expect(formatRuntimeListing([
      buildRuntimeSnapshot({
        supervisor: 'launchd',
      }),
    ], 'JamesWuHK/digital-employee')).toContain('supervisor=launchd')

    expect(formatLaunchdStatus({
      label: 'com.agentloop.example',
      serviceTarget: 'gui/501/com.agentloop.example',
      plistPath: '/Users/wujames/Library/LaunchAgents/com.agentloop.example.plist',
      runtimeRecordPath: '/tmp/runtime.json',
      logPath: '/tmp/runtime.log',
      installed: true,
      loaded: true,
      detail: 'state = running',
      runtime: {
        serviceTarget: 'gui/501/com.agentloop.example',
        activeCount: 1,
        state: 'running',
        pid: 12345,
        runs: 3,
        lastTerminatingSignal: 'Terminated: 15',
      },
    })).toContain('loaded: yes')
  })
})

function buildRuntimeSnapshot(
  overrides: Partial<BackgroundRuntimeSnapshot['record']> = {},
  alive = true,
): BackgroundRuntimeSnapshot {
  return {
    recordPath: '/Users/wujames/.agent-loop/runtime/runtime.json',
    alive,
    record: {
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-dev',
      healthPort: 9311,
      supervisor: 'detached',
      pid: 12345,
      metricsPort: 9091,
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      startedAt: '2026-04-05T08:00:00.000Z',
      command: ['bun', 'apps/agent-daemon/src/index.ts'],
      logPath: '/Users/wujames/.agent-loop/runtime/runtime.log',
      ...overrides,
    },
  }
}
