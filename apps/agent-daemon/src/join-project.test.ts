import { describe, expect, test } from 'bun:test'
import type { AgentConfig } from '@agent/shared'
import {
  buildJoinProjectConfigFile,
  formatJoinProjectResult,
  joinProjectMachine,
  type JoinProjectDependencies,
} from './join-project'

const baseResolvedConfig: AgentConfig = {
  machineId: 'machine-from-home',
  repo: 'JamesWuHK/digital-employee',
  pat: 'ghp-test',
  pollIntervalMs: 60_000,
  concurrency: 1,
  requestedConcurrency: 1,
  concurrencyPolicy: {
    requested: 1,
    effective: 1,
    repoCap: null,
    profileCap: null,
    projectCap: null,
  },
  scheduling: {
    concurrencyByRepo: {},
    concurrencyByProfile: {},
  },
  recovery: {
    heartbeatIntervalMs: 30_000,
    leaseTtlMs: 60_000,
    workerIdleTimeoutMs: 300_000,
    leaseAdoptionBackoffMs: 5_000,
  },
  worktreesBase: '/tmp/.agent-worktrees/JamesWuHK-digital-employee',
  project: {
    profile: 'desktop-vite',
    maxConcurrency: 2,
  },
  agent: {
    primary: 'codex',
    fallback: 'claude',
    claudePath: 'claude',
    codexPath: 'codex',
    timeoutMs: 1_800_000,
  },
  git: {
    defaultBranch: 'main',
    authorName: 'agent-loop',
    authorEmail: 'agent-loop@local',
  },
}

describe('join-project helpers', () => {
  test('builds machine config updates without clobbering existing scheduling defaults', () => {
    const config = buildJoinProjectConfigFile(
      {
        repo: 'JamesWuHK/agent-loop',
        machineId: 'old-machine',
        concurrency: 4,
        scheduling: {
          concurrencyByRepo: {
            'JamesWuHK/agent-loop': 1,
          },
          concurrencyByProfile: {
            'desktop-vite': 2,
          },
        },
        agent: {
          primary: 'codex',
          fallback: 'claude',
          claudePath: 'claude',
          codexPath: 'codex',
          timeoutMs: 90_000,
        },
      },
      {
        repo: 'JamesWuHK/digital-employee',
        machineId: 'macbook-pro-b',
        pat: ' ghp-next ',
        concurrency: 2,
        repoCap: 3,
      },
    )

    expect(config).toMatchObject({
      repo: 'JamesWuHK/digital-employee',
      machineId: 'macbook-pro-b',
      pat: 'ghp-next',
      concurrency: 2,
      scheduling: {
        concurrencyByRepo: {
          'JamesWuHK/agent-loop': 1,
          'JamesWuHK/digital-employee': 3,
        },
        concurrencyByProfile: {
          'desktop-vite': 2,
        },
      },
      agent: {
        primary: 'codex',
      },
    })
  })

  test('dry-run on macOS reports launchd adoption without writing config', () => {
    let wroteConfig = false
    const result = joinProjectMachine({
      repo: 'JamesWuHK/digital-employee',
      machineId: 'macbook-pro-b',
      healthPort: 9312,
      metricsPort: 9092,
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/Users/wujames/codeRepo/agent-loop/apps/agent-daemon/src/index.ts',
      dryRun: true,
      env: {},
    }, buildDeps({
      platform: 'darwin',
      writeConfigFile: () => {
        wroteConfig = true
      },
      inspectLaunchdService: () => ({
        label: 'com.agentloop.example',
        serviceTarget: 'gui/501/com.agentloop.example',
        plistPath: '/tmp/com.agentloop.example.plist',
        runtimeRecordPath: '/tmp/runtime.json',
        logPath: '/tmp/runtime.log',
        installed: false,
        loaded: false,
        detail: null,
        runtime: null,
      }),
    }))

    expect(wroteConfig).toBe(false)
    expect(result).toMatchObject({
      supervisor: 'launchd',
      action: 'would-install-launchd',
      dryRun: true,
      runtimeRecordPath: '/tmp/runtime.json',
      logPath: '/tmp/runtime.log',
    })
    expect(formatJoinProjectResult(result)).toContain('status: agent-loop --status --repo JamesWuHK/digital-employee --machine-id macbook-pro-b --health-port 9312')
  })

  test('installs launchd with explicit daemon args on macOS join', () => {
    let wroteConfig: Record<string, unknown> | null = null
    let capturedArgv: string[] = []
    const result = joinProjectMachine({
      repo: 'JamesWuHK/digital-employee',
      machineId: 'macbook-pro-b',
      concurrency: 2,
      repoCap: 3,
      healthPort: 9312,
      metricsPort: 9092,
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/Users/wujames/codeRepo/agent-loop/apps/agent-daemon/src/index.ts',
      env: {},
    }, buildDeps({
      platform: 'darwin',
      writeConfigFile: (config) => {
        wroteConfig = config
      },
      inspectLaunchdService: () => ({
        label: 'com.agentloop.example',
        serviceTarget: 'gui/501/com.agentloop.example',
        plistPath: '/tmp/com.agentloop.example.plist',
        runtimeRecordPath: '/tmp/runtime.json',
        logPath: '/tmp/runtime.log',
        installed: false,
        loaded: false,
        detail: null,
        runtime: null,
      }),
      buildLaunchdServiceSpec: (input) => {
        capturedArgv = input.argv
        return {
          label: 'com.agentloop.example',
          serviceTarget: 'gui/501/com.agentloop.example',
          plistPath: '/tmp/com.agentloop.example.plist',
          launchAgentsDir: '/tmp/LaunchAgents',
          domain: 'gui/501',
          runtimeRecordPath: '/tmp/runtime.json',
          logPath: '/tmp/runtime.log',
          programArguments: ['bun', input.scriptPath, ...input.argv],
          workingDirectory: input.cwd,
          environmentVariables: {},
        }
      },
    }))

    expect(wroteConfig).toMatchObject({
      machineId: 'macbook-pro-b',
      repo: 'JamesWuHK/digital-employee',
      concurrency: 2,
      scheduling: {
        concurrencyByRepo: {
          'JamesWuHK/digital-employee': 3,
        },
      },
    })
    expect(capturedArgv).toEqual([
      '--repo', 'JamesWuHK/digital-employee',
      '--machine-id', 'macbook-pro-b',
      '--health-port', '9312',
      '--metrics-port', '9092',
    ])
    expect(result).toMatchObject({
      action: 'installed-launchd',
      requestedConcurrency: 2,
      effectiveConcurrency: 2,
      repoCap: 3,
    })
  })

  test('starts a detached daemon on non-macOS joins', () => {
    let launched = false
    const result = joinProjectMachine({
      repo: 'JamesWuHK/digital-employee',
      machineId: 'linux-dev-b',
      healthPort: 9313,
      metricsPort: 9093,
      cwd: '/srv/digital-employee',
      scriptPath: '/srv/agent-loop/apps/agent-daemon/src/index.ts',
      env: {},
    }, buildDeps({
      platform: 'linux',
      buildBackgroundRuntimePaths: () => ({
        runtimeDir: '/tmp/runtime',
        recordPath: '/tmp/runtime/linux-dev-b.json',
        logPath: '/tmp/runtime/linux-dev-b.log',
      }),
      launchBackgroundRuntime: () => {
        launched = true
        return {
          repo: 'JamesWuHK/digital-employee',
          machineId: 'linux-dev-b',
          healthPort: 9313,
          supervisor: 'detached',
          pid: 45678,
          metricsPort: 9093,
          cwd: '/srv/digital-employee',
          startedAt: '2026-04-05T00:00:00.000Z',
          command: ['bun', 'index.ts'],
          logPath: '/tmp/runtime/linux-dev-b.log',
        }
      },
    }))

    expect(launched).toBe(true)
    expect(result).toMatchObject({
      supervisor: 'detached',
      action: 'started-detached',
      runtimeRecordPath: '/tmp/runtime/linux-dev-b.json',
      logPath: '/tmp/runtime/linux-dev-b.log',
      message: 'Started detached daemon with pid 45678',
    })
  })
})

function buildDeps(
  overrides: Partial<JoinProjectDependencies> = {},
): JoinProjectDependencies {
  return {
    platform: 'darwin',
    resolveLocalDaemonIdentity: (args = {}) => ({
      repo: args.repo ?? 'JamesWuHK/digital-employee',
      machineId: args.machineId ?? 'machine-from-home',
    }),
    readConfigFile: () => ({}),
    writeConfigFile: () => {},
    loadRepoLocalConfig: () => ({
      project: {
        profile: 'desktop-vite',
        maxConcurrency: 2,
      },
    }),
    buildConfig: (args = {}) => ({
      ...baseResolvedConfig,
      repo: args.repo ?? baseResolvedConfig.repo,
      machineId: args.machineId ?? baseResolvedConfig.machineId,
      concurrency: args.concurrency ?? baseResolvedConfig.concurrency,
      requestedConcurrency: args.concurrency ?? baseResolvedConfig.requestedConcurrency,
      concurrencyPolicy: {
        requested: args.concurrency ?? baseResolvedConfig.requestedConcurrency,
        effective: args.concurrency ?? baseResolvedConfig.concurrency,
        repoCap: 3,
        profileCap: null,
        projectCap: 2,
      },
    }),
    buildBackgroundRuntimePaths: () => ({
      runtimeDir: '/tmp/runtime',
      recordPath: '/tmp/runtime/daemon.json',
      logPath: '/tmp/runtime/daemon.log',
    }),
    readBackgroundRuntimeRecord: () => null,
    isProcessAlive: () => false,
    launchBackgroundRuntime: () => ({
      repo: 'JamesWuHK/digital-employee',
      machineId: 'machine-from-home',
      healthPort: 9311,
      supervisor: 'detached',
      pid: 12345,
      metricsPort: 9091,
      cwd: '/tmp/repo',
      startedAt: '2026-04-05T00:00:00.000Z',
      command: ['bun', 'index.ts'],
      logPath: '/tmp/runtime/daemon.log',
    }),
    buildLaunchdServicePaths: () => ({
      label: 'com.agentloop.example',
      serviceTarget: 'gui/501/com.agentloop.example',
      plistPath: '/tmp/com.agentloop.example.plist',
      launchAgentsDir: '/tmp/LaunchAgents',
      domain: 'gui/501',
      runtimeRecordPath: '/tmp/runtime.json',
      logPath: '/tmp/runtime.log',
    }),
    inspectLaunchdService: () => ({
      label: 'com.agentloop.example',
      serviceTarget: 'gui/501/com.agentloop.example',
      plistPath: '/tmp/com.agentloop.example.plist',
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
        runs: 1,
        lastTerminatingSignal: null,
      },
    }),
    buildLaunchdServiceSpec: (input) => ({
      label: 'com.agentloop.example',
      serviceTarget: 'gui/501/com.agentloop.example',
      plistPath: '/tmp/com.agentloop.example.plist',
      launchAgentsDir: '/tmp/LaunchAgents',
      domain: 'gui/501',
      runtimeRecordPath: '/tmp/runtime.json',
      logPath: '/tmp/runtime.log',
      programArguments: ['bun', input.scriptPath, ...input.argv],
      workingDirectory: input.cwd,
      environmentVariables: {},
    }),
    installLaunchdService: () => ({
      label: 'com.agentloop.example',
      serviceTarget: 'gui/501/com.agentloop.example',
      plistPath: '/tmp/com.agentloop.example.plist',
      launchAgentsDir: '/tmp/LaunchAgents',
      domain: 'gui/501',
      runtimeRecordPath: '/tmp/runtime.json',
      logPath: '/tmp/runtime.log',
    }),
    startLaunchdService: () => ({
      started: true,
      message: 'Started launchd service com.agentloop.example',
    }),
    assertLaunchdWorkingDirectorySafe: () => {},
    ...overrides,
  }
}
