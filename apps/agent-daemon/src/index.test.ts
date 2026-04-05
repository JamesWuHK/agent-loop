import { describe, expect, test } from 'bun:test'
import {
  buildManagedRestartArgs,
  formatLaunchdStatus,
  formatRuntimeListing,
  restartManagedRuntime,
} from './index'
import type { BackgroundRuntimeSnapshot } from './background'

function buildRuntimeSnapshot(
  overrides: Partial<BackgroundRuntimeSnapshot['record']> = {},
): BackgroundRuntimeSnapshot {
  return {
    recordPath: '/Users/wujames/.agent-loop/runtime/runtime.json',
    alive: true,
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
