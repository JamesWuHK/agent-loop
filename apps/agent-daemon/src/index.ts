#!/usr/bin/env bun

/**
 * agent-loop — Distributed automation daemon
 *
 * Usage:
 *   bun run src/index.ts                    # Start daemon (reads ~/.agent-loop/config.json)
 *   bun run src/index.ts --repo owner/repo  # Start with repo override
 *   bun run src/index.ts --once             # Run one poll cycle then exit
 */

import { parseArgs } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { AgentDaemon, DEFAULT_HEALTH_SERVER_PORT, DEFAULT_HEALTH_SERVER_HOST, type HealthServerConfig } from './daemon'
import { loadConfig, resolveLocalDaemonIdentity, type CliArgs } from './config'
import { collectDaemonObservability, formatDoctorReport, formatStatusReport } from './status'
import {
  buildCurrentProcessRuntimeRecord,
  buildBackgroundRuntimePaths,
  launchBackgroundRuntime,
  listBackgroundRuntimeRecords,
  removeBackgroundRuntimeRecord,
  resolveCurrentRuntimeSupervisor,
  resolveBackgroundRuntimeRecord,
  stopBackgroundRuntime,
  writeBackgroundRuntimeRecord,
  type BackgroundRuntimeSnapshot,
} from './background'
import {
  assertLaunchdWorkingDirectorySafe,
  buildLaunchdServiceSpec,
  buildLaunchdServicePaths,
  inspectLaunchdService,
  installLaunchdService,
  startLaunchdService,
  restartLaunchdService,
  stopLaunchdService,
  uninstallLaunchdService,
} from './launchd'
import { formatJoinProjectResult, joinProjectMachine } from './join-project'

type PartialHealthServerConfig = Partial<HealthServerConfig>
type LocalDaemonIdentityResolver = typeof resolveLocalDaemonIdentity

export interface RestartManagedRuntimeInput {
  discoveredRuntime: BackgroundRuntimeSnapshot | null
  repo?: string
  machineId?: string
  healthPort: number
  metricsPort?: number
  cwd: string
  scriptPath: string
  argv: string[]
}

export interface RestartManagedRuntimeResult {
  kind: 'launchd' | 'detached' | 'none'
  restarted: boolean
  message: string
}

export interface StartManagedRuntimeResult {
  kind: 'launchd' | 'detached'
  started: boolean
  message: string
}

export interface StopManagedRuntimeResult {
  kind: 'launchd' | 'detached' | 'none'
  stopped: boolean
  message: string
}

export interface ReconcileManagedRuntimeResult {
  kind: 'launchd' | 'detached' | 'none'
  ok: boolean
  changed: boolean
  message: string
}

export interface ManagedRuntimeLogResult {
  found: boolean
  path: string
  content: string
  truncated: boolean
  message: string
}

interface RestartManagedRuntimeDependencies {
  platform: NodeJS.Platform
  resolveLocalDaemonIdentity: LocalDaemonIdentityResolver
  buildLaunchdServicePaths: typeof buildLaunchdServicePaths
  inspectLaunchdService: typeof inspectLaunchdService
  startLaunchdService?: typeof startLaunchdService
  restartLaunchdService: typeof restartLaunchdService
  stopLaunchdService?: typeof stopLaunchdService
  stopBackgroundRuntime: typeof stopBackgroundRuntime
  launchBackgroundRuntime: typeof launchBackgroundRuntime
}

const DEFAULT_RESTART_DEPENDENCIES: RestartManagedRuntimeDependencies = {
  platform: process.platform,
  resolveLocalDaemonIdentity,
  buildLaunchdServicePaths,
  inspectLaunchdService,
  startLaunchdService,
  restartLaunchdService,
  stopLaunchdService,
  stopBackgroundRuntime,
  launchBackgroundRuntime,
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      repo: { type: 'string', short: 'r' },
      pat: { type: 'string', short: 'p' },
      concurrency: { type: 'string', short: 'c' },
      'poll-interval': { type: 'string' },
      'machine-id': { type: 'string' },
      'dry-run': { type: 'boolean' },
      'metrics-port': { type: 'string' },
      daemonize: { type: 'boolean' },
      'join-project': { type: 'boolean' },
      'repo-cap': { type: 'string' },
      runtimes: { type: 'boolean' },
      start: { type: 'boolean' },
      logs: { type: 'boolean' },
      reconcile: { type: 'boolean' },
      restart: { type: 'boolean' },
      'launchd-install': { type: 'boolean' },
      'launchd-uninstall': { type: 'boolean' },
      'launchd-status': { type: 'boolean' },
      stop: { type: 'boolean' },
      once: { type: 'boolean' },
      status: { type: 'boolean' },
      doctor: { type: 'boolean' },
      'health-host': { type: 'string' },
      'health-port': { type: 'string' },
      help: { type: 'boolean' },
    },
  })

  const metricsPort = args['metrics-port']
    ? parseInt(args['metrics-port'] as string)
    : undefined

  if (args.help) {
    printHelp()
    process.exit(0)
  }

  if (args['repo-cap'] && !args['join-project']) {
    throw new Error('--repo-cap can only be used with --join-project')
  }

  if (args['join-project'] && (args.daemonize || args.start || args.logs || args.reconcile || args.restart || args.stop || args.status || args.doctor || args.once || args.runtimes || args['launchd-install'] || args['launchd-uninstall'] || args['launchd-status'])) {
    throw new Error('--join-project cannot be combined with daemon control, status, or launchd management flags')
  }

  if (args.daemonize && (args.start || args.logs || args.reconcile || args.restart || args.stop || args.status || args.doctor || args.once)) {
    throw new Error('--daemonize cannot be combined with --start, --logs, --reconcile, --restart, --stop, --status, --doctor, or --once')
  }

  if (args.runtimes && (args.daemonize || args.start || args.logs || args.reconcile || args.restart || args.stop || args.status || args.doctor || args.once || args['launchd-install'] || args['launchd-uninstall'] || args['launchd-status'])) {
    throw new Error('--runtimes cannot be combined with --daemonize, --start, --logs, --reconcile, --restart, --stop, --status, --doctor, --once, or launchd management flags')
  }

  if (args.start && (args.logs || args.reconcile || args.restart || args.stop || args.status || args.doctor || args.once || args.runtimes || args['launchd-install'] || args['launchd-uninstall'] || args['launchd-status'])) {
    throw new Error('--start cannot be combined with --logs, --reconcile, --restart, --stop, --status, --doctor, --once, --runtimes, or launchd management flags')
  }

  if (args.logs && (args.start || args.reconcile || args.restart || args.stop || args.status || args.doctor || args.once || args.runtimes || args['launchd-install'] || args['launchd-uninstall'] || args['launchd-status'])) {
    throw new Error('--logs cannot be combined with --start, --reconcile, --restart, --stop, --status, --doctor, --once, --runtimes, or launchd management flags')
  }

  if (args.stop && (args.start || args.logs || args.reconcile || args.restart || args.status || args.doctor || args.once || args['launchd-install'] || args['launchd-uninstall'] || args['launchd-status'])) {
    throw new Error('--stop cannot be combined with --start, --logs, --reconcile, --restart, --status, --doctor, --once, or launchd management flags')
  }

  if (args.restart && (args.start || args.logs || args.reconcile || args.stop || args.status || args.doctor || args.once || args.runtimes || args['launchd-install'] || args['launchd-uninstall'] || args['launchd-status'])) {
    throw new Error('--restart cannot be combined with --start, --logs, --reconcile, --stop, --status, --doctor, --once, --runtimes, or launchd management flags')
  }

  if (args.reconcile && (args.start || args.logs || args.restart || args.stop || args.status || args.doctor || args.once || args.runtimes || args['launchd-install'] || args['launchd-uninstall'] || args['launchd-status'])) {
    throw new Error('--reconcile cannot be combined with --start, --logs, --restart, --stop, --status, --doctor, --once, --runtimes, or launchd management flags')
  }

  if (args['launchd-install'] && (args.daemonize || args.start || args.logs || args.stop || args.status || args.doctor || args.once || args.runtimes || args['launchd-uninstall'] || args['launchd-status'])) {
    throw new Error('--launchd-install cannot be combined with other control flags')
  }

  if (args['launchd-uninstall'] && (args.daemonize || args.start || args.logs || args.stop || args.status || args.doctor || args.once || args.runtimes || args['launchd-install'] || args['launchd-status'])) {
    throw new Error('--launchd-uninstall cannot be combined with other control flags')
  }

  if (args['launchd-status'] && (args.daemonize || args.start || args.logs || args.stop || args.status || args.doctor || args.once || args.runtimes || args['launchd-install'] || args['launchd-uninstall'])) {
    throw new Error('--launchd-status cannot be combined with other control flags')
  }

  const runtimeRepoHint = resolveRepoHint(args.repo as string | undefined)
  const runtimeMachineIdHint = args['machine-id'] as string | undefined
  const runtimeHealthPortHint = args['health-port'] ? parseInt(args['health-port'] as string) : undefined

  if (args['join-project']) {
    const result = joinProjectMachine({
      repo: args.repo as string | undefined,
      pat: args.pat as string | undefined,
      machineId: args['machine-id'] as string | undefined,
      concurrency: args.concurrency ? parseInt(args.concurrency as string) : undefined,
      repoCap: args['repo-cap'] ? parseInt(args['repo-cap'] as string) : undefined,
      healthPort: runtimeHealthPortHint ?? DEFAULT_HEALTH_SERVER_PORT,
      metricsPort,
      cwd: process.cwd(),
      scriptPath: process.argv[1]!,
      dryRun: args['dry-run'] as boolean | undefined,
      env: process.env,
    })
    console.log(formatJoinProjectResult(result))
    process.exit(0)
  }

  const discoveredRuntime = args.status || args.doctor || args.start || args.logs || args.stop || args.restart || args.reconcile
    ? resolveDiscoveredRuntime({
      repo: runtimeRepoHint,
      machineId: runtimeMachineIdHint,
      healthPort: runtimeHealthPortHint,
    })
    : null

  if (args.runtimes) {
    const runtimeRecords = listBackgroundRuntimeRecords()
    console.log(formatRuntimeListing(runtimeRecords, runtimeRepoHint))
    process.exit(0)
  }

  if (args.logs) {
    const result = readManagedRuntimeLog({
      discoveredRuntime,
      repo: args.repo as string | undefined,
      machineId: args['machine-id'] as string | undefined,
      healthPort: runtimeHealthPortHint ?? discoveredRuntime?.record.healthPort ?? DEFAULT_HEALTH_SERVER_PORT,
    })
    console.log(formatManagedRuntimeLog(result))
    process.exit(result.found ? 0 : 1)
  }

  if (args.status || args.doctor) {
    let fallbackRepo: string | undefined
    try {
      fallbackRepo = discoveredRuntime?.record.repo ?? resolveLocalDaemonIdentity({
        repo: args.repo as string | undefined,
      }, {
        persistGeneratedMachineId: false,
      }).repo
    } catch {
      fallbackRepo = discoveredRuntime?.record.repo ?? args.repo as string | undefined
    }

    const snapshot = await collectDaemonObservability({
      healthHost: (args['health-host'] as string | undefined) ?? DEFAULT_HEALTH_SERVER_HOST,
      healthPort: runtimeHealthPortHint ?? discoveredRuntime?.record.healthPort ?? DEFAULT_HEALTH_SERVER_PORT,
      metricsPort: metricsPort ?? discoveredRuntime?.record.metricsPort,
      includeGitHubAudit: Boolean(args.doctor),
      fallbackRepo,
      fallbackRuntime: discoveredRuntime ?? undefined,
    })
    console.log(args.doctor ? formatDoctorReport(snapshot) : formatStatusReport(snapshot))
    process.exit(snapshot.ok ? 0 : 1)
  }

  const cliArgs: CliArgs = {
    repo: args.repo as string | undefined,
    pat: args.pat as string | undefined,
    concurrency: args.concurrency ? parseInt(args.concurrency as string) : undefined,
    pollIntervalMs: args['poll-interval'] ? parseInt(args['poll-interval'] as string) : undefined,
    machineId: args['machine-id'] as string | undefined,
    dryRun: args['dry-run'] as boolean | undefined,
    once: args.once as boolean | undefined,
    healthHost: args['health-host'] as string | undefined,
    healthPort: args['health-port'] ? parseInt(args['health-port'] as string) : undefined,
  }

  // Build health server config
  const healthServerConfig: PartialHealthServerConfig = {}
  if (cliArgs.healthHost) healthServerConfig.host = cliArgs.healthHost
  if (cliArgs.healthPort) healthServerConfig.port = cliArgs.healthPort

  try {
    if (args['launchd-install'] || args['launchd-uninstall'] || args['launchd-status']) {
      ensureLaunchdSupported()
      const managedIdentity = resolveLocalDaemonIdentity(
        {
          repo: cliArgs.repo,
          machineId: cliArgs.machineId,
        },
        {
          persistGeneratedMachineId: Boolean(args['launchd-install']),
        },
      )
      const launchdPaths = buildLaunchdServicePaths({
        repo: managedIdentity.repo,
        machineId: managedIdentity.machineId,
        healthPort: healthServerConfig.port ?? DEFAULT_HEALTH_SERVER_PORT,
      })

      if (args['launchd-install']) {
        assertLaunchdWorkingDirectorySafe(process.cwd())
        const spec = buildLaunchdServiceSpec({
          identity: {
            repo: managedIdentity.repo,
            machineId: managedIdentity.machineId,
            healthPort: healthServerConfig.port ?? DEFAULT_HEALTH_SERVER_PORT,
          },
          cwd: process.cwd(),
          scriptPath: process.argv[1]!,
          argv: process.argv.slice(2),
          env: process.env,
        })
        installLaunchdService(spec)
        console.log(`[agent-loop] launchd service installed: ${spec.label}`)
        console.log(`[agent-loop] plist: ${spec.plistPath}`)
        console.log(`[agent-loop] runtime record: ${spec.runtimeRecordPath}`)
        console.log(`[agent-loop] log file: ${spec.logPath}`)
        console.log(`[agent-loop] health: http://${healthServerConfig.host ?? DEFAULT_HEALTH_SERVER_HOST}:${healthServerConfig.port ?? DEFAULT_HEALTH_SERVER_PORT}/health`)
        process.exit(0)
      }

      if (args['launchd-uninstall']) {
        const result = uninstallLaunchdService(launchdPaths)
        console.log(`[agent-loop] ${result.message}`)
        process.exit(result.removed ? 0 : 1)
      }

      const status = inspectLaunchdService(launchdPaths)
      console.log(formatLaunchdStatus(status))
      process.exit(status.loaded ? 0 : status.installed ? 0 : 1)
    }

    if (args.stop) {
      const result = stopManagedRuntime({
        discoveredRuntime,
        repo: cliArgs.repo,
        machineId: cliArgs.machineId,
        healthPort: healthServerConfig.port ?? DEFAULT_HEALTH_SERVER_PORT,
        metricsPort,
        cwd: process.cwd(),
        scriptPath: process.argv[1]!,
        argv: process.argv.slice(2),
      })
      console.log(`[agent-loop] ${result.message}`)
      process.exit(result.stopped ? 0 : 1)
    }

    if (args.start) {
      const result = startManagedRuntime({
        discoveredRuntime,
        repo: cliArgs.repo,
        machineId: cliArgs.machineId,
        healthPort: healthServerConfig.port ?? DEFAULT_HEALTH_SERVER_PORT,
        metricsPort,
        cwd: process.cwd(),
        scriptPath: process.argv[1]!,
        argv: process.argv.slice(2),
      })
      console.log(`[agent-loop] ${result.message}`)
      process.exit(result.started ? 0 : 1)
    }

    if (args.restart) {
      const result = restartManagedRuntime({
        discoveredRuntime,
        repo: cliArgs.repo,
        machineId: cliArgs.machineId,
        healthPort: healthServerConfig.port ?? DEFAULT_HEALTH_SERVER_PORT,
        metricsPort,
        cwd: process.cwd(),
        scriptPath: process.argv[1]!,
        argv: process.argv.slice(2),
      })
      console.log(`[agent-loop] ${result.message}`)
      process.exit(result.restarted ? 0 : 1)
    }

    if (args.reconcile) {
      const result = reconcileManagedRuntime({
        discoveredRuntime,
        repo: cliArgs.repo,
        machineId: cliArgs.machineId,
        healthPort: healthServerConfig.port ?? DEFAULT_HEALTH_SERVER_PORT,
        metricsPort,
        cwd: process.cwd(),
        scriptPath: process.argv[1]!,
        argv: process.argv.slice(2),
      })
      console.log(`[agent-loop] ${result.message}`)
      process.exit(result.ok ? 0 : 1)
    }

    const config = loadConfig(cliArgs)

    const runtimePaths = buildBackgroundRuntimePaths({
      repo: config.repo,
      machineId: config.machineId,
      healthPort: healthServerConfig.port ?? DEFAULT_HEALTH_SERVER_PORT,
    })

    const managedRuntimeFile = process.env.AGENT_LOOP_RUNTIME_FILE
    if (managedRuntimeFile) {
      writeBackgroundRuntimeRecord(
        managedRuntimeFile,
        buildCurrentProcessRuntimeRecord({
          identity: {
            repo: config.repo,
            machineId: config.machineId,
            healthPort: healthServerConfig.port ?? DEFAULT_HEALTH_SERVER_PORT,
          },
          metricsPort: metricsPort ?? 9090,
          cwd: process.cwd(),
          logPath: process.env.AGENT_LOOP_LOG_FILE ?? runtimePaths.logPath,
          supervisor: resolveCurrentRuntimeSupervisor() === 'launchd' ? 'launchd' : 'detached',
          env: process.env,
        }),
      )
    }

    if (args.daemonize) {
      const record = launchBackgroundRuntime({
        identity: {
          repo: config.repo,
          machineId: config.machineId,
          healthPort: healthServerConfig.port ?? DEFAULT_HEALTH_SERVER_PORT,
        },
        metricsPort: metricsPort ?? 9090,
        cwd: process.cwd(),
        argv: process.argv.slice(2),
        scriptPath: process.argv[1]!,
      })
      console.log(`[agent-loop] background daemon started: pid ${record.pid}`)
      console.log(`[agent-loop] runtime record: ${runtimePaths.recordPath}`)
      console.log(`[agent-loop] log file: ${record.logPath}`)
      console.log(`[agent-loop] health: http://${healthServerConfig.host ?? DEFAULT_HEALTH_SERVER_HOST}:${healthServerConfig.port ?? DEFAULT_HEALTH_SERVER_PORT}/health`)
      process.exit(0)
    }

    const daemon = new AgentDaemon(config, console, healthServerConfig, metricsPort)

    const removeRuntimeFileIfManaged = () => {
      const runtimeFile = process.env.AGENT_LOOP_RUNTIME_FILE
      if (runtimeFile && shouldRemoveManagedRuntimeRecord(resolveCurrentRuntimeSupervisor())) {
        removeBackgroundRuntimeRecord(runtimeFile)
      }
    }

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      console.log(`\n[agent-loop] received ${signal}`)
      await daemon.stop()
      removeRuntimeFileIfManaged()
      process.exit(0)
    }

    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))

    await daemon.start()

    if (cliArgs.once) {
      console.log('[agent-loop] --once mode: waiting for first issue to complete...')
      await daemon.waitForInFlightProcess()
      await daemon.stop()
      removeRuntimeFileIfManaged()
      process.exit(0)
    }

    console.log('[agent-loop] daemon running. Press Ctrl+C to stop.')
  } catch (err) {
    if (err instanceof Error && err.name === 'ConfigError') {
      console.error(`[agent-loop] config error: ${err.message}`)
      console.error('Run with --help for usage information.')
      process.exit(1)
    }
    throw err
  }
}

function printHelp() {
  console.log(`
agent-loop — Distributed automation daemon

Usage:
  agent-loop [options]
  agent-loop --join-project [options]
  agent-loop --reconcile [--health-port 9310]
  agent-loop --start [--health-port 9310]
  agent-loop --logs [--health-port 9310]
  agent-loop --restart [--health-port 9310]
  agent-loop --status [--health-port 9310]
  agent-loop --doctor [--health-port 9310]
  agent-loop --runtimes
  agent-loop --launchd-install [options]
  agent-loop --launchd-uninstall [--repo owner/repo --machine-id my-dev-machine --health-port 9310]
  agent-loop --launchd-status [--repo owner/repo --machine-id my-dev-machine --health-port 9310]
  agent-loop --daemonize [options]
  agent-loop --stop [--repo owner/repo --machine-id my-dev-machine --health-port 9310]

Options:
  -r, --repo <owner/repo>     Target GitHub repository
  -p, --pat <token>           GitHub Personal Access Token (or set GITHUB_TOKEN / GH_TOKEN / gh auth login)
  -c, --concurrency <n>       Max concurrent agent tasks (default: 1)
      --poll-interval <ms>    Poll interval in milliseconds (default: 60000)
      --machine-id <id>       Override machine ID (auto-generated by default)
      --health-host <host>    Health check server host (default: 127.0.0.1)
      --health-port <port>    Health check server port (default: 9310)
      --metrics-port <port>   Prometheus metrics port (default: 9090)
      --daemonize             Start the daemon detached from the current terminal
      --join-project          Persist local machine config for the current repo and start a managed daemon (launchd on macOS, detached elsewhere)
      --repo-cap <n>          When used with --join-project, persist a repo-level concurrency cap for this repo in ~/.agent-loop/config.json
      --runtimes              List local background daemon records discovered on this machine
      --start                 Start the managed daemon matching repo/machine-id/health-port if it is not already running
      --logs                  Print the recent local daemon log for the managed daemon matching repo/machine-id/health-port
      --reconcile             Reconcile the managed daemon runtime for this repo/machine-id/health-port
      --restart               Restart the managed daemon matching repo/machine-id/health-port
      --launchd-install       Install and start a macOS launchd service for this daemon (run from a durable repo checkout, not /tmp)
      --launchd-uninstall     Remove the macOS launchd service matching repo/machine-id/health-port
      --launchd-status        Inspect the macOS launchd service matching repo/machine-id/health-port
      --stop                  Stop the managed daemon matching repo/machine-id/health-port
      --status                Print a compact local daemon status report and exit
      --doctor                Print a detailed local daemon diagnostic report and exit
      --dry-run               Simulate without making changes
      --once                  Run one poll cycle then exit
      --help                  Show this help message

Health Check:
  GET /health                Returns daemon status in JSON format
Metrics:
  Prometheus metrics are exposed at /metrics on the metrics port.
  A /health endpoint is also available for health checks.

Configuration:
  Machine config is read from ~/.agent-loop/config.json
  Project config is optionally read from ./.agent-loop/project.json in the current repo
  Environment variables: GITHUB_TOKEN, GH_TOKEN
  Authentication fallback: if no PAT is configured, agent-loop will try gh auth token

Examples:
  agent-loop --repo octocat/hello-world
  agent-loop --repo owner/repo --concurrency 2
  agent-loop --health-port 8080
  agent-loop --metrics-port 9090
  agent-loop --join-project --machine-id macbook-pro-b --health-port 9312 --metrics-port 9092 --repo-cap 2
  agent-loop --runtimes
  agent-loop --start --health-port 9311
  agent-loop --logs --health-port 9311
  agent-loop --reconcile --health-port 9311
  agent-loop --restart --health-port 9311
  agent-loop --launchd-install --health-port 9311 --metrics-port 9091
  agent-loop --launchd-status --health-port 9311
  agent-loop --launchd-uninstall --health-port 9311
  agent-loop --daemonize --repo owner/repo --health-port 9311 --metrics-port 9091
  agent-loop --stop --repo owner/repo --health-port 9311
  agent-loop --status
  agent-loop --doctor --health-port 9311 --metrics-port 9091
  GITHUB_TOKEN=ghp_xxx agent-loop --once
`)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('[agent-loop] fatal error:', err)
    process.exit(1)
  })
}

function resolveRepoHint(repo: string | undefined): string | undefined {
  try {
    return resolveLocalDaemonIdentity(
      {
        repo,
      },
      {
        persistGeneratedMachineId: false,
      },
    ).repo
  } catch {
    return repo
  }
}

function resolveDiscoveredRuntime(input: {
  repo?: string
  machineId?: string
  healthPort?: number
}): BackgroundRuntimeSnapshot | null {
  try {
    return resolveBackgroundRuntimeRecord(input)
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`[agent-loop] ${error.message}`)
    }
    throw error
  }
}

function ensureLaunchdSupported(): void {
  if (process.platform !== 'darwin') {
    throw new Error('launchd management is only supported on macOS')
  }
}

export function buildManagedRestartArgs(input: {
  repo: string
  machineId: string
  healthPort: number
  metricsPort: number
}): string[] {
  return [
    '--repo', input.repo,
    '--machine-id', input.machineId,
    '--health-port', String(input.healthPort),
    '--metrics-port', String(input.metricsPort),
  ]
}

export function readManagedRuntimeLog(input: {
  discoveredRuntime: BackgroundRuntimeSnapshot | null
  repo?: string
  machineId?: string
  healthPort: number
  maxLines?: number
}): ManagedRuntimeLogResult {
  const logPath = resolveManagedRuntimeLogPath(input)

  if (!existsSync(logPath)) {
    return {
      found: false,
      path: logPath,
      content: '',
      truncated: false,
      message: `No managed daemon log file found at ${logPath}`,
    }
  }

  const content = readFileSync(logPath, 'utf-8')
  const rendered = tailLogContent(content, input.maxLines ?? 200)
  return {
    found: true,
    path: logPath,
    content: rendered.content,
    truncated: rendered.truncated,
    message: rendered.truncated
      ? `Showing last ${rendered.lineCount} log lines from ${logPath}`
      : `Showing log contents from ${logPath}`,
  }
}

export function formatManagedRuntimeLog(result: ManagedRuntimeLogResult): string {
  if (!result.found) {
    return [
      'Managed Daemon Log',
      '',
      `path: ${result.path}`,
      `error: ${result.message}`,
    ].join('\n')
  }

  return [
    'Managed Daemon Log',
    '',
    `path: ${result.path}`,
    `status: ${result.message}`,
    '',
    result.content.length > 0 ? result.content : '(log file is empty)',
  ].join('\n')
}

function resolveManagedRuntimeLogPath(input: {
  discoveredRuntime: BackgroundRuntimeSnapshot | null
  repo?: string
  machineId?: string
  healthPort: number
}): string {
  if (input.discoveredRuntime?.record.logPath) {
    return input.discoveredRuntime.record.logPath
  }

  const identity = resolveLocalDaemonIdentity(
    {
      repo: input.repo,
      machineId: input.machineId,
    },
    {
      persistGeneratedMachineId: false,
    },
  )

  return buildBackgroundRuntimePaths({
    repo: identity.repo,
    machineId: identity.machineId,
    healthPort: input.healthPort,
  }).logPath
}

function tailLogContent(content: string, maxLines: number): {
  content: string
  truncated: boolean
  lineCount: number
} {
  const lines = content.split('\n')
  const normalizedLines = lines.at(-1) === '' ? lines.slice(0, -1) : lines
  if (normalizedLines.length <= maxLines) {
    return {
      content: normalizedLines.join('\n'),
      truncated: false,
      lineCount: normalizedLines.length,
    }
  }

  const tail = normalizedLines.slice(-maxLines)
  return {
    content: tail.join('\n'),
    truncated: true,
    lineCount: tail.length,
  }
}

export function shouldRemoveManagedRuntimeRecord(
  supervisor: ReturnType<typeof resolveCurrentRuntimeSupervisor>,
): boolean {
  return supervisor !== 'launchd'
}

export function startManagedRuntime(
  input: RestartManagedRuntimeInput,
  deps: RestartManagedRuntimeDependencies = DEFAULT_RESTART_DEPENDENCIES,
): StartManagedRuntimeResult {
  const runtime = input.discoveredRuntime

  if (runtime?.record.supervisor === 'detached' && runtime.alive) {
    return {
      kind: 'detached',
      started: true,
      message: `Detached daemon pid ${runtime.record.pid} is already running`,
    }
  }

  if (deps.platform === 'darwin') {
    const identity = deps.resolveLocalDaemonIdentity(
      {
        repo: runtime?.record.repo ?? input.repo,
        machineId: runtime?.record.machineId ?? input.machineId,
      },
      {
        persistGeneratedMachineId: false,
      },
    )
    const launchdPaths = deps.buildLaunchdServicePaths({
      repo: identity.repo,
      machineId: identity.machineId,
      healthPort: runtime?.record.healthPort ?? input.healthPort,
    })
    const launchdStatus = deps.inspectLaunchdService(launchdPaths)

    if (launchdStatus.installed) {
      if (launchdStatus.loaded) {
        return {
          kind: 'launchd',
          started: true,
          message: `Launchd service ${launchdStatus.label} is already running`,
        }
      }

      const startResult = (deps.startLaunchdService ?? startLaunchdService)(launchdPaths)
      return {
        kind: 'launchd',
        started: startResult.started,
        message: startResult.message,
      }
    }
  }

  const identity = deps.resolveLocalDaemonIdentity(
    {
      repo: runtime?.record.repo ?? input.repo,
      machineId: runtime?.record.machineId ?? input.machineId,
    },
    {
      persistGeneratedMachineId: false,
    },
  )
  const healthPort = runtime?.record.healthPort ?? input.healthPort
  const metricsPort = runtime?.record.metricsPort ?? input.metricsPort ?? 9090
  const launchArgs = buildManagedRestartArgs({
    repo: identity.repo,
    machineId: identity.machineId,
    healthPort,
    metricsPort,
  })
  const stopPrefix = runtime?.record.supervisor === 'detached' && !runtime.alive
    ? `${deps.stopBackgroundRuntime(runtime.recordPath).message}; `
    : ''
  const started = deps.launchBackgroundRuntime({
    identity: {
      repo: identity.repo,
      machineId: identity.machineId,
      healthPort,
    },
    metricsPort,
    cwd: input.cwd,
    argv: launchArgs,
    scriptPath: input.scriptPath,
  })

  return {
    kind: 'detached',
    started: true,
    message: `${stopPrefix}started detached daemon with pid ${started.pid}`,
  }
}

export function reconcileManagedRuntime(
  input: RestartManagedRuntimeInput,
  deps: RestartManagedRuntimeDependencies = DEFAULT_RESTART_DEPENDENCIES,
): ReconcileManagedRuntimeResult {
  const runtime = input.discoveredRuntime

  if (runtime?.record.supervisor === 'detached') {
    if (runtime.alive) {
      return {
        kind: 'detached',
        ok: true,
        changed: false,
        message: `Detached daemon pid ${runtime.record.pid} is already healthy`,
      }
    }

    const scriptPath = runtime.record.command[1]
    if (typeof scriptPath !== 'string' || scriptPath.length === 0) {
      return {
        kind: 'detached',
        ok: false,
        changed: false,
        message: 'Cannot relaunch stale detached daemon because its runtime record is missing the script path',
      }
    }

    const stopResult = deps.stopBackgroundRuntime(runtime.recordPath)
    const relaunched = deps.launchBackgroundRuntime({
      identity: {
        repo: runtime.record.repo,
        machineId: runtime.record.machineId,
        healthPort: runtime.record.healthPort,
      },
      metricsPort: runtime.record.metricsPort,
      cwd: runtime.record.cwd,
      argv: runtime.record.command.slice(2),
      scriptPath,
    })

    return {
      kind: 'detached',
      ok: true,
      changed: true,
      message: `${stopResult.message}; relaunched detached daemon with pid ${relaunched.pid}`,
    }
  }

  if (deps.platform === 'darwin') {
    const identity = deps.resolveLocalDaemonIdentity(
      {
        repo: runtime?.record.repo ?? input.repo,
        machineId: runtime?.record.machineId ?? input.machineId,
      },
      {
        persistGeneratedMachineId: false,
      },
    )
    const launchdPaths = deps.buildLaunchdServicePaths({
      repo: identity.repo,
      machineId: identity.machineId,
      healthPort: runtime?.record.healthPort ?? input.healthPort,
    })
    const launchdStatus = deps.inspectLaunchdService(launchdPaths)

    if (launchdStatus.installed) {
      const launchdPid = launchdStatus.runtime?.pid ?? null
      const runtimeMissing = runtime === null
      const runtimeDead = runtime !== null && !runtime.alive
      const pidMismatch = runtime !== null && runtime.alive && launchdPid !== null && runtime.record.pid !== launchdPid
      const shouldRestart = !launchdStatus.loaded || runtimeMissing || runtimeDead || pidMismatch

      if (!shouldRestart) {
        return {
          kind: 'launchd',
          ok: true,
          changed: false,
          message: `Launchd service ${launchdStatus.label} is already healthy`,
        }
      }

      const reason = !launchdStatus.loaded
        ? 'service is not loaded'
        : runtimeMissing
          ? 'runtime record is missing'
          : runtimeDead
            ? 'runtime record is stale'
            : 'runtime pid differs from launchd pid'
      const result = deps.restartLaunchdService(launchdPaths)
      return {
        kind: 'launchd',
        ok: result.restarted,
        changed: result.restarted,
        message: `${result.message} (${reason})`,
      }
    }
  }

  return {
    kind: 'none',
    ok: false,
    changed: false,
    message: 'No managed daemon runtime or launchd service matched the current repo/machine-id/health-port',
  }
}

export function stopManagedRuntime(
  input: RestartManagedRuntimeInput,
  deps: RestartManagedRuntimeDependencies = DEFAULT_RESTART_DEPENDENCIES,
): StopManagedRuntimeResult {
  const runtime = input.discoveredRuntime

  if (runtime?.record.supervisor === 'detached') {
    const result = deps.stopBackgroundRuntime(runtime.recordPath)
    return {
      kind: 'detached',
      stopped: result.stopped,
      message: result.message,
    }
  }

  if (deps.platform === 'darwin') {
    const identity = deps.resolveLocalDaemonIdentity(
      {
        repo: runtime?.record.repo ?? input.repo,
        machineId: runtime?.record.machineId ?? input.machineId,
      },
      {
        persistGeneratedMachineId: false,
      },
    )
    const launchdPaths = deps.buildLaunchdServicePaths({
      repo: identity.repo,
      machineId: identity.machineId,
      healthPort: runtime?.record.healthPort ?? input.healthPort,
    })
    const launchdStatus = deps.inspectLaunchdService(launchdPaths)

    if (launchdStatus.installed || runtime?.record.supervisor === 'launchd') {
      const stopResult = (deps.stopLaunchdService ?? stopLaunchdService)(launchdPaths)
      return {
        kind: 'launchd',
        stopped: stopResult.stopped,
        message: stopResult.message,
      }
    }
  }

  return {
    kind: 'none',
    stopped: false,
    message: 'No managed daemon runtime or launchd service matched the current repo/machine-id/health-port',
  }
}

export function restartManagedRuntime(
  input: RestartManagedRuntimeInput,
  deps: RestartManagedRuntimeDependencies = DEFAULT_RESTART_DEPENDENCIES,
): RestartManagedRuntimeResult {
  const runtime = input.discoveredRuntime

  if (runtime?.record.supervisor === 'detached') {
    const stopResult = deps.stopBackgroundRuntime(runtime.recordPath)
    const restarted = deps.launchBackgroundRuntime({
      identity: {
        repo: runtime.record.repo,
        machineId: runtime.record.machineId,
        healthPort: runtime.record.healthPort,
      },
      metricsPort: runtime.record.metricsPort,
      cwd: input.cwd,
      argv: buildManagedRestartArgs({
        repo: runtime.record.repo,
        machineId: runtime.record.machineId,
        healthPort: runtime.record.healthPort,
        metricsPort: runtime.record.metricsPort,
      }),
      scriptPath: input.scriptPath,
    })

    return {
      kind: 'detached',
      restarted: true,
      message: `${stopResult.message}; restarted detached daemon with pid ${restarted.pid}`,
    }
  }

  if (deps.platform === 'darwin') {
    const identity = deps.resolveLocalDaemonIdentity(
      {
        repo: runtime?.record.repo ?? input.repo,
        machineId: runtime?.record.machineId ?? input.machineId,
      },
      {
        persistGeneratedMachineId: false,
      },
    )
    const launchdPaths = deps.buildLaunchdServicePaths({
      repo: identity.repo,
      machineId: identity.machineId,
      healthPort: runtime?.record.healthPort ?? input.healthPort,
    })
    const launchdStatus = deps.inspectLaunchdService(launchdPaths)

    if (launchdStatus.installed) {
      const result = deps.restartLaunchdService(launchdPaths)
      return {
        kind: 'launchd',
        restarted: result.restarted,
        message: result.message,
      }
    }
  }

  return {
    kind: 'none',
    restarted: false,
    message: 'No managed daemon runtime or launchd service matched the current repo/machine-id/health-port',
  }
}

export function formatRuntimeListing(
  runtimes: BackgroundRuntimeSnapshot[],
  repoHint?: string,
): string {
  if (runtimes.length === 0) {
    return 'No local managed daemon runtime records found.'
  }

  const lines = ['Local managed daemons:']

  for (const runtime of runtimes) {
    const state = runtime.alive ? 'alive' : 'stale'
    const match = repoHint && runtime.record.repo === repoHint ? ' current-repo' : ''
    lines.push(
      `- ${state}${match} supervisor=${runtime.record.supervisor} repo=${runtime.record.repo} machine=${runtime.record.machineId} pid=${runtime.record.pid} health=${runtime.record.healthPort} metrics=${runtime.record.metricsPort} started=${runtime.record.startedAt} cwd=${runtime.record.cwd}`,
    )
  }

  return lines.join('\n')
}

export function formatLaunchdStatus(status: ReturnType<typeof inspectLaunchdService>): string {
  const lines = [
    'Launchd Status',
    '',
    `label: ${status.label}`,
    `installed: ${status.installed ? 'yes' : 'no'}`,
    `loaded: ${status.loaded ? 'yes' : 'no'}`,
    `plist: ${status.plistPath}`,
    `runtime record: ${status.runtimeRecordPath}`,
    `log: ${status.logPath}`,
  ]

  if (status.detail) {
    lines.push('', 'detail:', status.detail)
  }

  return lines.join('\n')
}
