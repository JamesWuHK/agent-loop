import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildManagedRestartArgs,
  formatManagedRuntimeLog,
  readManagedRuntimeLog,
  startManagedRuntime,
  reconcileManagedRuntime,
  formatLaunchdStatus,
  formatRuntimeListing,
  restartManagedRuntime,
  shouldRemoveManagedRuntimeRecord,
  stopManagedRuntime,
} from './index'
import type { BackgroundRuntimeSnapshot } from './background'

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

  test('preserves launchd runtime records on managed shutdown for offline diagnostics', () => {
    expect(shouldRemoveManagedRuntimeRecord('launchd')).toBe(false)
    expect(shouldRemoveManagedRuntimeRecord('detached')).toBe(true)
    expect(shouldRemoveManagedRuntimeRecord('direct')).toBe(true)
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
    const result = readManagedRuntimeLog({
      discoveredRuntime: null,
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-dev',
      healthPort: 9311,
    })

    expect(result.found).toBe(false)
    expect(result.path).toContain('jameswuhk-digital-employee__codex-dev__9311.log')
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
      stopBackgroundRuntime: (recordPath) => {
        calls.push(`stop:${recordPath}`)
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
      'stop:/Users/wujames/.agent-loop/runtime/runtime.json',
      'launch:JamesWuHK/digital-employee:codex-dev:9311:9091',
    ])
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
