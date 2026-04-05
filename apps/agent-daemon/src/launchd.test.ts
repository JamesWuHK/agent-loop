import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertLaunchdWorkingDirectorySafe,
  buildLaunchdProgramArguments,
  buildLaunchdServicePaths,
  buildLaunchdServiceSpec,
  getUnsafeLaunchdWorkingDirectoryReason,
  inspectLaunchdService,
  installLaunchdService,
  parseLaunchdServiceDetail,
  restartLaunchdService,
  renderLaunchdPlist,
  uninstallLaunchdService,
} from './launchd'

describe('launchd helpers', () => {
  test('builds stable launchd paths and label', () => {
    const paths = buildLaunchdServicePaths({
      repo: 'JamesWuHK/digital-employee',
      machineId: 'codex-verify-20260405',
      healthPort: 9311,
    }, '/tmp/agent-loop-home', 501)

    expect(paths.label).toBe('com.agentloop.jameswuhk-digital-employee.codex-verify-20260405.9311')
    expect(paths.plistPath).toBe('/tmp/agent-loop-home/Library/LaunchAgents/com.agentloop.jameswuhk-digital-employee.codex-verify-20260405.9311.plist')
    expect(paths.runtimeRecordPath).toContain('jameswuhk-digital-employee__codex-verify-20260405__9311.json')
    expect(paths.serviceTarget).toBe('gui/501/com.agentloop.jameswuhk-digital-employee.codex-verify-20260405.9311')
  })

  test('sanitizes control flags from launchd program arguments', () => {
    expect(buildLaunchdProgramArguments({
      execPath: '/Users/wujames/.local/bin/bun',
      scriptPath: '/repo/apps/agent-daemon/src/index.ts',
      argv: ['--launchd-install', '--machine-id', 'codex-verify-20260405', '--health-port', '9311'],
    })).toEqual([
      '/Users/wujames/.local/bin/bun',
      '/repo/apps/agent-daemon/src/index.ts',
      '--machine-id',
      'codex-verify-20260405',
      '--health-port',
      '9311',
    ])
  })

  test('renders a launchd plist with escaped values and environment variables', () => {
    const spec = buildLaunchdServiceSpec({
      identity: {
        repo: 'JamesWuHK/digital-employee',
        machineId: 'codex-verify-20260405',
        healthPort: 9311,
      },
      cwd: '/Users/wujames/codeRepo/work & dir',
      scriptPath: '/repo/apps/agent-daemon/src/index.ts',
      execPath: '/Users/wujames/.local/bin/bun',
      argv: ['--health-port', '9311'],
      env: {
        PATH: '/usr/bin',
        HOME: '/Users/wujames',
      },
      homeDir: '/tmp/agent-loop-home',
      uid: 501,
    })

    const plist = renderLaunchdPlist(spec)

    expect(plist).toContain('<string>com.agentloop.jameswuhk-digital-employee.codex-verify-20260405.9311</string>')
    expect(plist).toContain('<string>/Users/wujames/codeRepo/work &amp; dir</string>')
    expect(plist).toContain('<key>AGENT_LOOP_RUNTIME_FILE</key>')
    expect(plist).toContain('<key>AGENT_LOOP_RUNTIME_MANAGER</key>')
    expect(plist).toContain('<string>/usr/bin</string>')
  })

  test('installs a launchd service by writing a plist and running launchctl commands', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'agent-loop-launchd-install-'))
    const calls: string[] = []
    const spec = buildLaunchdServiceSpec({
      identity: {
        repo: 'JamesWuHK/digital-employee',
        machineId: 'codex-launchd',
        healthPort: 9314,
      },
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/repo/apps/agent-daemon/src/index.ts',
      execPath: '/Users/wujames/.local/bin/bun',
      argv: ['--launchd-install', '--health-port', '9314', '--metrics-port', '9094'],
      env: {
        PATH: '/usr/bin',
        HOME: '/Users/wujames',
      },
      homeDir,
      uid: 501,
    })

    installLaunchdService(spec, (args) => {
      calls.push(args.join(' '))
      return ''
    }, () => {})

    expect(existsSync(spec.plistPath)).toBe(true)
    expect(calls).toEqual([
      `bootout ${spec.serviceTarget}`,
      `bootstrap ${spec.domain} ${spec.plistPath}`,
      `enable ${spec.serviceTarget}`,
      `kickstart -k ${spec.serviceTarget}`,
    ])
  })

  test('inspects installed and loaded launchd services', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'agent-loop-launchd-inspect-'))
    const spec = buildLaunchdServiceSpec({
      identity: {
        repo: 'JamesWuHK/digital-employee',
        machineId: 'codex-launchd',
        healthPort: 9314,
      },
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/repo/apps/agent-daemon/src/index.ts',
      execPath: '/Users/wujames/.local/bin/bun',
      argv: ['--health-port', '9314'],
      env: {
        PATH: '/usr/bin',
        HOME: '/Users/wujames',
      },
      homeDir,
      uid: 501,
    })
    mkdirSync(spec.launchAgentsDir, { recursive: true })
    writeFileSync(spec.plistPath, '<plist />')

    const status = inspectLaunchdService(spec, () => 'state = running')

    expect(status).toMatchObject({
      serviceTarget: spec.serviceTarget,
      installed: true,
      loaded: true,
      detail: 'state = running',
      runtime: {
        state: 'running',
      },
    })
  })

  test('parses structured runtime fields from launchctl print output', () => {
    expect(parseLaunchdServiceDetail(`
gui/501/com.agentloop.jameswuhk-digital-employee.codex-verify-20260405.9311 = {
  active count = 1
  state = running
  runs = 3
  pid = 13204
  last terminating signal = Terminated: 15
}
`)).toEqual({
      serviceTarget: 'gui/501/com.agentloop.jameswuhk-digital-employee.codex-verify-20260405.9311',
      activeCount: 1,
      state: 'running',
      pid: 13204,
      runs: 3,
      lastTerminatingSignal: 'Terminated: 15',
    })
  })

  test('retries retryable bootstrap failures during launchd install', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'agent-loop-launchd-retry-'))
    const calls: string[] = []
    const spec = buildLaunchdServiceSpec({
      identity: {
        repo: 'JamesWuHK/digital-employee',
        machineId: 'codex-launchd',
        healthPort: 9314,
      },
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/repo/apps/agent-daemon/src/index.ts',
      execPath: '/Users/wujames/.local/bin/bun',
      argv: ['--launchd-install', '--health-port', '9314', '--metrics-port', '9094'],
      env: {
        PATH: '/usr/bin',
        HOME: '/Users/wujames',
      },
      homeDir,
      uid: 501,
    })

    let bootstrapAttempts = 0
    installLaunchdService(spec, (args) => {
      calls.push(args.join(' '))
      if (args[0] === 'bootstrap') {
        bootstrapAttempts += 1
        if (bootstrapAttempts === 1) {
          throw new Error('launchctl bootstrap failed: Bootstrap failed: 5: Input/output error')
        }
      }
      return ''
    }, () => {})

    expect(bootstrapAttempts).toBe(2)
    expect(calls).toEqual([
      `bootout ${spec.serviceTarget}`,
      `bootstrap ${spec.domain} ${spec.plistPath}`,
      `bootout ${spec.serviceTarget}`,
      `bootstrap ${spec.domain} ${spec.plistPath}`,
      `enable ${spec.serviceTarget}`,
      `kickstart -k ${spec.serviceTarget}`,
    ])
  })

  test('does not retry non-retryable bootstrap failures during launchd install', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'agent-loop-launchd-no-retry-'))
    const calls: string[] = []
    const spec = buildLaunchdServiceSpec({
      identity: {
        repo: 'JamesWuHK/digital-employee',
        machineId: 'codex-launchd',
        healthPort: 9314,
      },
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/repo/apps/agent-daemon/src/index.ts',
      execPath: '/Users/wujames/.local/bin/bun',
      argv: ['--launchd-install', '--health-port', '9314', '--metrics-port', '9094'],
      env: {
        PATH: '/usr/bin',
        HOME: '/Users/wujames',
      },
      homeDir,
      uid: 501,
    })

    expect(() => installLaunchdService(spec, (args) => {
      calls.push(args.join(' '))
      if (args[0] === 'bootstrap') {
        throw new Error('launchctl bootstrap failed: permission denied')
      }
      return ''
    }, () => {})).toThrow('permission denied')

    expect(calls).toEqual([
      `bootout ${spec.serviceTarget}`,
      `bootstrap ${spec.domain} ${spec.plistPath}`,
    ])
  })

  test('restarts an installed launchd service without rewriting the plist', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'agent-loop-launchd-restart-'))
    const spec = buildLaunchdServiceSpec({
      identity: {
        repo: 'JamesWuHK/digital-employee',
        machineId: 'codex-launchd',
        healthPort: 9314,
      },
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/repo/apps/agent-daemon/src/index.ts',
      execPath: '/Users/wujames/.local/bin/bun',
      argv: ['--health-port', '9314'],
      env: {
        PATH: '/usr/bin',
        HOME: '/Users/wujames',
      },
      homeDir,
      uid: 501,
    })
    mkdirSync(spec.launchAgentsDir, { recursive: true })
    writeFileSync(spec.plistPath, '<plist />')

    const calls: string[] = []
    const result = restartLaunchdService(spec, (args) => {
      calls.push(args.join(' '))
      return ''
    }, () => {})

    expect(result).toEqual({
      restarted: true,
      message: `Restarted launchd service ${spec.label}`,
    })
    expect(calls).toEqual([
      `bootout ${spec.serviceTarget}`,
      `bootstrap ${spec.domain} ${spec.plistPath}`,
      `enable ${spec.serviceTarget}`,
      `kickstart -k ${spec.serviceTarget}`,
    ])
  })

  test('reports when restarting a launchd service that is not installed', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'agent-loop-launchd-restart-missing-'))
    const spec = buildLaunchdServiceSpec({
      identity: {
        repo: 'JamesWuHK/digital-employee',
        machineId: 'codex-launchd',
        healthPort: 9314,
      },
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/repo/apps/agent-daemon/src/index.ts',
      execPath: '/Users/wujames/.local/bin/bun',
      argv: ['--health-port', '9314'],
      env: {
        PATH: '/usr/bin',
        HOME: '/Users/wujames',
      },
      homeDir,
      uid: 501,
    })

    expect(restartLaunchdService(spec, () => '', () => {})).toEqual({
      restarted: false,
      message: `Launchd service ${spec.label} is not installed`,
    })
  })

  test('retries retryable bootstrap failures during launchd restart', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'agent-loop-launchd-restart-retry-'))
    const spec = buildLaunchdServiceSpec({
      identity: {
        repo: 'JamesWuHK/digital-employee',
        machineId: 'codex-launchd',
        healthPort: 9314,
      },
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/repo/apps/agent-daemon/src/index.ts',
      execPath: '/Users/wujames/.local/bin/bun',
      argv: ['--health-port', '9314'],
      env: {
        PATH: '/usr/bin',
        HOME: '/Users/wujames',
      },
      homeDir,
      uid: 501,
    })
    mkdirSync(spec.launchAgentsDir, { recursive: true })
    writeFileSync(spec.plistPath, '<plist />')

    const calls: string[] = []
    let bootstrapAttempts = 0
    const result = restartLaunchdService(spec, (args) => {
      calls.push(args.join(' '))
      if (args[0] === 'bootstrap') {
        bootstrapAttempts += 1
        if (bootstrapAttempts === 1) {
          throw new Error('launchctl bootstrap failed: Bootstrap failed: 5: Input/output error')
        }
      }
      return ''
    }, () => {})

    expect(result).toEqual({
      restarted: true,
      message: `Restarted launchd service ${spec.label}`,
    })
    expect(bootstrapAttempts).toBe(2)
    expect(calls).toEqual([
      `bootout ${spec.serviceTarget}`,
      `bootstrap ${spec.domain} ${spec.plistPath}`,
      `bootout ${spec.serviceTarget}`,
      `bootstrap ${spec.domain} ${spec.plistPath}`,
      `enable ${spec.serviceTarget}`,
      `kickstart -k ${spec.serviceTarget}`,
    ])
  })

  test('uninstalls a launchd service and clears the runtime record', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'agent-loop-launchd-uninstall-'))
    const spec = buildLaunchdServiceSpec({
      identity: {
        repo: 'JamesWuHK/digital-employee',
        machineId: 'codex-launchd',
        healthPort: 9314,
      },
      cwd: '/Users/wujames/codeRepo/digital-employee-main',
      scriptPath: '/repo/apps/agent-daemon/src/index.ts',
      execPath: '/Users/wujames/.local/bin/bun',
      argv: ['--health-port', '9314'],
      env: {
        PATH: '/usr/bin',
        HOME: '/Users/wujames',
      },
      homeDir,
      uid: 501,
    })
    mkdirSync(spec.launchAgentsDir, { recursive: true })
    mkdirSync(join(homeDir, '.agent-loop', 'runtime'), { recursive: true })
    writeFileSync(spec.plistPath, '<plist />')
    writeFileSync(spec.runtimeRecordPath, '{"pid":1}')

    const calls: string[] = []
    const result = uninstallLaunchdService(spec, (args) => {
      calls.push(args.join(' '))
      return ''
    })

    expect(result).toEqual({
      removed: true,
      message: `Removed launchd service ${spec.label}`,
    })
    expect(existsSync(spec.plistPath)).toBe(false)
    expect(existsSync(spec.runtimeRecordPath)).toBe(false)
    expect(calls).toEqual([
      `bootout ${spec.serviceTarget}`,
    ])
  })

  test('detects unsafe temporary working directories for launchd installs', () => {
    expect(getUnsafeLaunchdWorkingDirectoryReason('/private/tmp/digital-employee-main')).toContain('temporary path')
    expect(getUnsafeLaunchdWorkingDirectoryReason('/Users/wujames/codeRepo/digital-employee-main')).toBeNull()
    expect(() => assertLaunchdWorkingDirectorySafe('/private/tmp/digital-employee-main')).toThrow('durable repo checkout')
  })
})
