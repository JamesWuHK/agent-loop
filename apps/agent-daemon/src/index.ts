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
import { appendWakeRequest, buildWakeQueuePath, type WakeRequest } from './wake-queue'
import { readWakeRequestFromGitHubEventContext } from './github-event-wake'
import {
  buildCurrentProcessRuntimeRecord,
  buildBackgroundRuntimePaths,
  launchBackgroundRuntime,
  listBackgroundRuntimeRecords,
  removeBackgroundRuntimeRecord,
  removeBackgroundRuntimeRecordIfOwned,
  resolveCurrentRuntimeSupervisor,
  resolveBackgroundRuntimeRecord,
  sanitizeDaemonBackgroundArgs,
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
import {
  DEFAULT_DASHBOARD_HOST,
  DEFAULT_DASHBOARD_PORT,
  startDashboardServer,
} from './dashboard'
import {
  buildIssueLintReportFromMarkdownFile,
  buildIssueLintReportFromRemoteIssue,
  formatIssueLintReport,
  formatIssueLintReportJson,
  type IssueLintReport,
} from './audit-issue-contracts'
import {
  evaluateBootstrapScenarioFixtureDirectory,
  formatBootstrapScenarioSuiteReport,
  formatBootstrapScenarioSuiteReportJson,
  resolveBootstrapScenarioSuiteExitCode,
  type BootstrapScenarioSuiteReport,
} from './replay-eval'

type PartialHealthServerConfig = Partial<HealthServerConfig>
type LocalDaemonIdentityResolver = typeof resolveLocalDaemonIdentity
const RESTART_BACKGROUND_RUNTIME_STOP_TIMEOUT_MS = 30_000

export interface WakeCommand {
  kind: 'now' | 'issue' | 'pr'
  issueNumber?: number
  prNumber?: number
}

export interface IssueLintTarget {
  kind: 'file' | 'issue'
  path?: string
  issueNumber?: number
}

export interface ExecuteWakeCommandInput {
  command: WakeCommand
  repo?: string
  machineId?: string
  healthPort: number
}

export interface ExecuteWakeRequestInput {
  request: WakeRequest
  repo?: string
  machineId?: string
  healthPort: number
}

export interface ExecuteWakeCommandResult {
  queuePath: string
  request: WakeRequest
  notified: boolean
}

export interface ExecuteIssueLintInput {
  target: IssueLintTarget
  repo?: string
  pat?: string
}

export interface ExecuteBootstrapScenarioInput {
  fixturesDir?: string
}

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

export type ManagedRuntimeCleanupResult =
  | 'skipped'
  | 'removed'
  | 'missing'
  | 'not-owned'
  | 'unreadable'

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

interface WakeCommandDependencies {
  resolveLocalDaemonIdentity: LocalDaemonIdentityResolver
  buildWakeQueuePath: typeof buildWakeQueuePath
  appendWakeRequest: typeof appendWakeRequest
  notifyLocalWake: typeof notifyLocalWake
  now: () => Date
}

interface IssueLintCommandDependencies {
  loadConfig: typeof loadConfig
  buildIssueLintReportFromMarkdownFile: typeof buildIssueLintReportFromMarkdownFile
  buildIssueLintReportFromRemoteIssue: typeof buildIssueLintReportFromRemoteIssue
}

interface BootstrapScenarioCommandDependencies {
  evaluateBootstrapScenarioFixtureDirectory: typeof evaluateBootstrapScenarioFixtureDirectory
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

const DEFAULT_WAKE_COMMAND_DEPENDENCIES: WakeCommandDependencies = {
  resolveLocalDaemonIdentity,
  buildWakeQueuePath,
  appendWakeRequest,
  notifyLocalWake,
  now: () => new Date(),
}

const DEFAULT_ISSUE_LINT_COMMAND_DEPENDENCIES: IssueLintCommandDependencies = {
  loadConfig,
  buildIssueLintReportFromMarkdownFile,
  buildIssueLintReportFromRemoteIssue,
}

const DEFAULT_BOOTSTRAP_SCENARIO_COMMAND_DEPENDENCIES: BootstrapScenarioCommandDependencies = {
  evaluateBootstrapScenarioFixtureDirectory,
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      repo: { type: 'string', short: 'r' },
      pat: { type: 'string', short: 'p' },
      concurrency: { type: 'string', short: 'c' },
      'poll-interval': { type: 'string' },
      'idle-poll-interval': { type: 'string' },
      'machine-id': { type: 'string' },
      'dry-run': { type: 'boolean' },
      'metrics-port': { type: 'string' },
      dashboard: { type: 'boolean' },
      'dashboard-host': { type: 'string' },
      'dashboard-port': { type: 'string' },
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
      'wake-now': { type: 'boolean' },
      'wake-issue': { type: 'string' },
      'wake-pr': { type: 'string' },
      'wake-from-github-event': { type: 'boolean' },
      'github-event-name': { type: 'string' },
      'github-event-path': { type: 'string' },
      'lint-issue': { type: 'string' },
      'lint-file': { type: 'string' },
      'bootstrap-scenarios': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  })

  const metricsPort = args['metrics-port']
    ? parseInt(args['metrics-port'] as string)
    : undefined
  const dashboardPort = args['dashboard-port']
    ? parseInt(args['dashboard-port'] as string)
    : DEFAULT_DASHBOARD_PORT

  if (args.help) {
    printHelp()
    process.exit(0)
  }

  const wakeCommand = resolveWakeCommand({
    'wake-now': args['wake-now'] as boolean | undefined,
    'wake-issue': args['wake-issue'] as string | undefined,
    'wake-pr': args['wake-pr'] as string | undefined,
  })
  const issueLintTarget = resolveIssueLintTarget({
    'lint-issue': args['lint-issue'] as string | undefined,
    'lint-file': args['lint-file'] as string | undefined,
  })

  if (wakeCommand) {
    assertWakeCommandCompatible(args)
  }

  if (issueLintTarget) {
    assertIssueLintCompatible(args)
  }

  if (args['bootstrap-scenarios']) {
    assertBootstrapScenarioCompatible(args)
  }

  if (args['wake-from-github-event']) {
    if (wakeCommand) {
      throw new Error('--wake-from-github-event cannot be combined with --wake-now, --wake-issue, or --wake-pr')
    }
    if (issueLintTarget) {
      throw new Error('--wake-from-github-event cannot be combined with --lint-issue or --lint-file')
    }
    if (args['bootstrap-scenarios']) {
      throw new Error('--wake-from-github-event cannot be combined with --bootstrap-scenarios')
    }
    assertWakeCommandCompatible(args)
  }

  if (wakeCommand && issueLintTarget) {
    throw new Error('--lint-issue/--lint-file cannot be combined with wake commands')
  }

  if (args['bootstrap-scenarios'] && wakeCommand) {
    throw new Error('--bootstrap-scenarios cannot be combined with wake commands')
  }

  if (args['bootstrap-scenarios'] && issueLintTarget) {
    throw new Error('--bootstrap-scenarios cannot be combined with --lint-issue or --lint-file')
  }

  if (args['repo-cap'] && !args['join-project']) {
    throw new Error('--repo-cap can only be used with --join-project')
  }

  if (args['join-project'] && (args.daemonize || args.start || args.logs || args.reconcile || args.restart || args.stop || args.status || args.doctor || args.once || args.runtimes || args['launchd-install'] || args['launchd-uninstall'] || args['launchd-status'])) {
    throw new Error('--join-project cannot be combined with daemon control, status, or launchd management flags')
  }

  if (args.dashboard && (args.daemonize || args['join-project'] || args.runtimes || args.start || args.logs || args.reconcile || args.restart || args.stop || args.once || args.status || args.doctor || args['launchd-install'] || args['launchd-uninstall'] || args['launchd-status'])) {
    throw new Error('--dashboard cannot be combined with daemon control, status, runtime listing, or launchd management flags')
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

  if (issueLintTarget) {
    const report = await executeIssueLintCommand({
      target: issueLintTarget,
      repo: args.repo as string | undefined,
      pat: args.pat as string | undefined,
    })
    console.log(formatIssueLintOutput(report, args.json as boolean | undefined))
    process.exit(report.readyGateBlocked ? 1 : 0)
  }

  if (args['bootstrap-scenarios']) {
    const report = await executeBootstrapScenarioCommand()
    console.log(formatBootstrapScenarioOutput(report, args.json as boolean | undefined))
    process.exit(resolveBootstrapScenarioSuiteExitCode(report))
  }

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
      includeGitHubAudit: true,
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
    idlePollIntervalMs: args['idle-poll-interval'] ? parseInt(args['idle-poll-interval'] as string) : undefined,
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
    if (wakeCommand) {
      const result = await executeWakeCommand({
        command: wakeCommand,
        repo: cliArgs.repo,
        machineId: cliArgs.machineId,
        healthPort: healthServerConfig.port ?? DEFAULT_HEALTH_SERVER_PORT,
      })
      console.log(`[agent-loop] queued wake request at ${result.queuePath}`)
      console.log(
        result.notified
          ? `[agent-loop] local daemon notified via http://${DEFAULT_HEALTH_SERVER_HOST}:${healthServerConfig.port ?? DEFAULT_HEALTH_SERVER_PORT}/wake`
          : '[agent-loop] wake request persisted; local daemon notify was not confirmed',
      )
      process.exit(0)
    }

    if (args['wake-from-github-event']) {
      const request = readWakeRequestFromGitHubEventContext({
        eventName: args['github-event-name'] as string | undefined,
        eventPath: args['github-event-path'] as string | undefined,
      })
      if (!request) {
        console.log('[agent-loop] github event did not require a wake request')
        process.exit(0)
      }

      const result = await executeWakeRequest({
        request,
        repo: cliArgs.repo,
        machineId: cliArgs.machineId,
        healthPort: healthServerConfig.port ?? DEFAULT_HEALTH_SERVER_PORT,
      })
      console.log(`[agent-loop] resolved ${result.request.kind} wake request from ${result.request.sourceEvent}`)
      console.log(`[agent-loop] queued wake request at ${result.queuePath}`)
      console.log(
        result.notified
          ? `[agent-loop] local daemon notified via http://${DEFAULT_HEALTH_SERVER_HOST}:${healthServerConfig.port ?? DEFAULT_HEALTH_SERVER_PORT}/wake`
          : '[agent-loop] wake request persisted; local daemon notify was not confirmed',
      )
      process.exit(0)
    }

    if (args.dashboard) {
      const config = loadConfig(cliArgs)
      const server = startDashboardServer({
        config,
        host: (args['dashboard-host'] as string | undefined) ?? DEFAULT_DASHBOARD_HOST,
        port: dashboardPort,
        healthHost: cliArgs.healthHost,
      })
      console.log(`[agent-loop] dashboard listening on http://${server.hostname}:${server.port}`)
      process.exitCode = 0
      return
    }

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
      const cleanupResult = cleanupManagedRuntimeRecord({
        runtimeFile: process.env.AGENT_LOOP_RUNTIME_FILE,
        supervisor: resolveCurrentRuntimeSupervisor(),
      })

      if (cleanupResult === 'not-owned') {
        console.log('[agent-loop] preserving runtime record because a newer daemon instance already owns it')
      } else if (cleanupResult === 'unreadable') {
        console.warn('[agent-loop] skipped runtime record cleanup because the managed runtime record could not be parsed')
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
  agent-loop --wake-now [--repo owner/repo --machine-id my-dev-machine --health-port 9310]
  agent-loop --wake-issue <number> [--repo owner/repo --machine-id my-dev-machine --health-port 9310]
  agent-loop --wake-pr <number> [--repo owner/repo --machine-id my-dev-machine --health-port 9310]
  agent-loop --wake-from-github-event [--repo owner/repo --health-port 9310]
  agent-loop --lint-file <path> [--json]
  agent-loop --lint-issue <number> [--repo owner/repo --json]
  agent-loop --bootstrap-scenarios [--json]
  agent-loop --reconcile [--health-port 9310]
  agent-loop --start [--health-port 9310]
  agent-loop --dashboard [--dashboard-port 9388]
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
      --poll-interval <ms>    Active poll interval in milliseconds (default: 60000)
      --idle-poll-interval <ms>
                              Idle backstop poll interval after wake traffic is observed (default: max(active, 300000))
      --machine-id <id>       Override machine ID (auto-generated by default)
      --health-host <host>    Health check server host (default: 127.0.0.1)
      --health-port <port>    Health check server port (default: 9310)
      --metrics-port <port>   Prometheus metrics port (default: 9090)
      --wake-now              Queue an immediate local wake request and best-effort notify the daemon
      --wake-issue <number>   Queue a targeted issue wake request and best-effort notify the daemon
      --wake-pr <number>      Queue a targeted PR wake request and best-effort notify the daemon
      --wake-from-github-event
                              Translate the current GitHub Actions event into a local wake request
      --github-event-name     Override the GitHub event name used by --wake-from-github-event
      --github-event-path     Override the GitHub event payload path used by --wake-from-github-event
      --lint-file <path>      Lint a local issue markdown file
      --lint-issue <number>   Lint a remote GitHub issue body
      --bootstrap-scenarios   Evaluate the fixed self-bootstrap replay suite
      --json                  Print machine-readable JSON for lint and bootstrap scenario commands
      --dashboard             Start the local monitoring page for the current repo
      --dashboard-host <host> Dashboard server host (default: 127.0.0.1)
      --dashboard-port <port> Dashboard server port (default: 9388)
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
  agent-loop --wake-now --repo owner/repo
  agent-loop --wake-issue 374 --repo owner/repo --machine-id macbook-pro-b
  agent-loop --wake-pr 381 --health-port 9311
  agent-loop --lint-file docs/issues/ready-gate.md --json
  agent-loop --lint-issue 374 --repo owner/repo --json
  agent-loop --bootstrap-scenarios --json
  agent-loop --dashboard
  agent-loop --dashboard --dashboard-port 9390
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

export function resolveWakeCommand(args: {
  'wake-now'?: boolean
  'wake-issue'?: string
  'wake-pr'?: string
}): WakeCommand | null {
  const commands: WakeCommand[] = []

  if (args['wake-now']) {
    commands.push({ kind: 'now' })
  }

  if (typeof args['wake-issue'] === 'string') {
    commands.push({
      kind: 'issue',
      issueNumber: parseWakeTargetNumber(args['wake-issue'], '--wake-issue'),
    })
  }

  if (typeof args['wake-pr'] === 'string') {
    commands.push({
      kind: 'pr',
      prNumber: parseWakeTargetNumber(args['wake-pr'], '--wake-pr'),
    })
  }

  if (commands.length > 1) {
    throw new Error('Only one of --wake-now, --wake-issue, or --wake-pr can be used at a time')
  }

  return commands[0] ?? null
}

export function resolveIssueLintTarget(args: {
  'lint-issue'?: string
  'lint-file'?: string
}): IssueLintTarget | null {
  const targets: IssueLintTarget[] = []

  if (typeof args['lint-issue'] === 'string') {
    targets.push({
      kind: 'issue',
      issueNumber: parseWakeTargetNumber(args['lint-issue'], '--lint-issue'),
    })
  }

  if (typeof args['lint-file'] === 'string') {
    const path = args['lint-file'].trim()
    if (!path) {
      throw new Error('--lint-file must be a non-empty path')
    }
    targets.push({
      kind: 'file',
      path,
    })
  }

  if (targets.length > 1) {
    throw new Error('Only one of --lint-issue or --lint-file can be used at a time')
  }

  return targets[0] ?? null
}

export async function executeIssueLintCommand(
  input: ExecuteIssueLintInput,
  deps: IssueLintCommandDependencies = DEFAULT_ISSUE_LINT_COMMAND_DEPENDENCIES,
): Promise<IssueLintReport> {
  if (input.target.kind === 'file') {
    return deps.buildIssueLintReportFromMarkdownFile(input.target.path!)
  }

  const config = deps.loadConfig({
    repo: input.repo,
    pat: input.pat,
  })

  return deps.buildIssueLintReportFromRemoteIssue({
    issueNumber: input.target.issueNumber!,
    config,
  })
}

export function formatIssueLintOutput(
  report: IssueLintReport,
  asJson = false,
): string {
  return asJson ? formatIssueLintReportJson(report) : formatIssueLintReport(report)
}

export async function executeBootstrapScenarioCommand(
  input: ExecuteBootstrapScenarioInput = {},
  deps: BootstrapScenarioCommandDependencies = DEFAULT_BOOTSTRAP_SCENARIO_COMMAND_DEPENDENCIES,
): Promise<BootstrapScenarioSuiteReport> {
  return deps.evaluateBootstrapScenarioFixtureDirectory(
    input.fixturesDir ?? 'apps/agent-daemon/src/fixtures/replay',
  )
}

export function formatBootstrapScenarioOutput(
  report: BootstrapScenarioSuiteReport,
  asJson = false,
): string {
  return asJson ? formatBootstrapScenarioSuiteReportJson(report) : formatBootstrapScenarioSuiteReport(report)
}

export function buildWakeRequestFromCli(
  command: WakeCommand,
  requestedAt = new Date().toISOString(),
): WakeRequest {
  switch (command.kind) {
    case 'now':
      return {
        kind: 'now',
        reason: 'cli:wake-now',
        sourceEvent: 'cli',
        dedupeKey: 'cli:wake-now',
        requestedAt,
      }
    case 'issue':
      return {
        kind: 'issue',
        issueNumber: command.issueNumber!,
        reason: 'cli:wake-issue',
        sourceEvent: 'cli',
        dedupeKey: `cli:wake-issue:${command.issueNumber!}`,
        requestedAt,
      }
    case 'pr':
      return {
        kind: 'pr',
        prNumber: command.prNumber!,
        reason: 'cli:wake-pr',
        sourceEvent: 'cli',
        dedupeKey: `cli:wake-pr:${command.prNumber!}`,
        requestedAt,
      }
  }
}

export async function executeWakeCommand(
  input: ExecuteWakeCommandInput,
  deps: WakeCommandDependencies = DEFAULT_WAKE_COMMAND_DEPENDENCIES,
): Promise<ExecuteWakeCommandResult> {
  return executeWakeRequest({
    request: buildWakeRequestFromCli(input.command, deps.now().toISOString()),
    repo: input.repo,
    machineId: input.machineId,
    healthPort: input.healthPort,
  }, deps)
}

export async function executeWakeRequest(
  input: ExecuteWakeRequestInput,
  deps: WakeCommandDependencies = DEFAULT_WAKE_COMMAND_DEPENDENCIES,
): Promise<ExecuteWakeCommandResult> {
  const identity = deps.resolveLocalDaemonIdentity(
    {
      repo: input.repo,
      machineId: input.machineId,
    },
    {
      persistGeneratedMachineId: false,
    },
  )
  const queuePath = deps.buildWakeQueuePath({
    repo: identity.repo,
    machineId: identity.machineId,
  })

  deps.appendWakeRequest(queuePath, input.request)

  let notified = false

  try {
    await deps.notifyLocalWake({
      healthPort: input.healthPort,
      request: input.request,
    })
    notified = true
  } catch {
    notified = false
  }

  return {
    queuePath,
    request: input.request,
    notified,
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

export function buildManagedRuntimeLaunchArgs(input: {
  repo: string
  machineId: string
  healthPort: number
  metricsPort: number
  existingArgs?: string[]
  overrideArgs?: string[]
}): string[] {
  const baseArgs = input.existingArgs && input.existingArgs.length > 0
    ? [...input.existingArgs]
    : buildManagedRestartArgs({
        repo: input.repo,
        machineId: input.machineId,
        healthPort: input.healthPort,
        metricsPort: input.metricsPort,
      })
  const overrides = sanitizeManagedRuntimeOverrideArgs(input.overrideArgs ?? [])
  return overrides.length > 0
    ? [...stripManagedRuntimeArgs(baseArgs, collectManagedRuntimeOverrideFlags(overrides)), ...overrides]
    : baseArgs
}

function sanitizeManagedRuntimeOverrideArgs(args: string[]): string[] {
  return sanitizeDaemonBackgroundArgs(args)
}

function collectManagedRuntimeOverrideFlags(args: string[]): Set<string> {
  const flags = new Set<string>()

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (!token?.startsWith('--')) continue

    if (isManagedRuntimeValueFlag(token) || isManagedRuntimeBooleanFlag(token)) {
      flags.add(token)
    }

    if (isManagedRuntimeValueFlag(token)) {
      index += 1
    }
  }

  return flags
}

function stripManagedRuntimeArgs(args: string[], flagsToStrip: Set<string>): string[] {
  if (flagsToStrip.size === 0) {
    return [...args]
  }

  const stripped: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (!token) {
      continue
    }

    if (!token.startsWith('--')) {
      stripped.push(token)
      continue
    }

    if (flagsToStrip.has(token)) {
      if (isManagedRuntimeValueFlag(token)) {
        index += 1
      }
      continue
    }

    stripped.push(token)
    if (isManagedRuntimeValueFlag(token) && index + 1 < args.length) {
      stripped.push(args[index + 1]!)
      index += 1
    }
  }

  return stripped
}

function isManagedRuntimeValueFlag(flag: string): boolean {
  return flag === '--repo'
    || flag === '--pat'
    || flag === '--concurrency'
    || flag === '--poll-interval'
    || flag === '--idle-poll-interval'
    || flag === '--machine-id'
    || flag === '--metrics-port'
    || flag === '--health-host'
    || flag === '--health-port'
}

function isManagedRuntimeBooleanFlag(flag: string): boolean {
  return flag === '--dry-run' || flag === '--once'
}

function assertWakeCommandCompatible(args: {
  pat?: string
  concurrency?: string
  'poll-interval'?: string
  'idle-poll-interval'?: string
  'dry-run'?: boolean
  'metrics-port'?: string
  dashboard?: boolean
  'dashboard-host'?: string
  'dashboard-port'?: string
  daemonize?: boolean
  'join-project'?: boolean
  'repo-cap'?: string
  runtimes?: boolean
  start?: boolean
  logs?: boolean
  reconcile?: boolean
  restart?: boolean
  'launchd-install'?: boolean
  'launchd-uninstall'?: boolean
  'launchd-status'?: boolean
  stop?: boolean
  once?: boolean
  status?: boolean
  doctor?: boolean
  'health-host'?: string
}): void {
  const incompatibleFlags = [
    typeof args.pat === 'string' ? '--pat' : null,
    typeof args.concurrency === 'string' ? '--concurrency' : null,
    typeof args['poll-interval'] === 'string' ? '--poll-interval' : null,
    typeof args['idle-poll-interval'] === 'string' ? '--idle-poll-interval' : null,
    args['dry-run'] ? '--dry-run' : null,
    typeof args['metrics-port'] === 'string' ? '--metrics-port' : null,
    args.dashboard ? '--dashboard' : null,
    typeof args['dashboard-host'] === 'string' ? '--dashboard-host' : null,
    typeof args['dashboard-port'] === 'string' ? '--dashboard-port' : null,
    args.daemonize ? '--daemonize' : null,
    args['join-project'] ? '--join-project' : null,
    typeof args['repo-cap'] === 'string' ? '--repo-cap' : null,
    args.runtimes ? '--runtimes' : null,
    args.start ? '--start' : null,
    args.logs ? '--logs' : null,
    args.reconcile ? '--reconcile' : null,
    args.restart ? '--restart' : null,
    args['launchd-install'] ? '--launchd-install' : null,
    args['launchd-uninstall'] ? '--launchd-uninstall' : null,
    args['launchd-status'] ? '--launchd-status' : null,
    args.stop ? '--stop' : null,
    args.once ? '--once' : null,
    args.status ? '--status' : null,
    args.doctor ? '--doctor' : null,
    typeof args['health-host'] === 'string' ? '--health-host' : null,
  ].filter((flag): flag is string => flag !== null)

  if (incompatibleFlags.length > 0) {
    throw new Error(`Wake commands cannot be combined with ${incompatibleFlags.join(', ')}`)
  }
}

function assertIssueLintCompatible(args: {
  'wake-now'?: boolean
  'wake-issue'?: string
  'wake-pr'?: string
  'wake-from-github-event'?: boolean
  concurrency?: string
  'poll-interval'?: string
  'idle-poll-interval'?: string
  'machine-id'?: string
  'dry-run'?: boolean
  'metrics-port'?: string
  dashboard?: boolean
  'dashboard-host'?: string
  'dashboard-port'?: string
  daemonize?: boolean
  'join-project'?: boolean
  'repo-cap'?: string
  runtimes?: boolean
  start?: boolean
  logs?: boolean
  reconcile?: boolean
  restart?: boolean
  'launchd-install'?: boolean
  'launchd-uninstall'?: boolean
  'launchd-status'?: boolean
  stop?: boolean
  once?: boolean
  status?: boolean
  doctor?: boolean
  'health-host'?: string
  'health-port'?: string
}): void {
  const incompatibleFlags = [
    args['wake-now'] ? '--wake-now' : null,
    typeof args['wake-issue'] === 'string' ? '--wake-issue' : null,
    typeof args['wake-pr'] === 'string' ? '--wake-pr' : null,
    args['wake-from-github-event'] ? '--wake-from-github-event' : null,
    typeof args.concurrency === 'string' ? '--concurrency' : null,
    typeof args['poll-interval'] === 'string' ? '--poll-interval' : null,
    typeof args['idle-poll-interval'] === 'string' ? '--idle-poll-interval' : null,
    typeof args['machine-id'] === 'string' ? '--machine-id' : null,
    args['dry-run'] ? '--dry-run' : null,
    typeof args['metrics-port'] === 'string' ? '--metrics-port' : null,
    args.dashboard ? '--dashboard' : null,
    typeof args['dashboard-host'] === 'string' ? '--dashboard-host' : null,
    typeof args['dashboard-port'] === 'string' ? '--dashboard-port' : null,
    args.daemonize ? '--daemonize' : null,
    args['join-project'] ? '--join-project' : null,
    typeof args['repo-cap'] === 'string' ? '--repo-cap' : null,
    args.runtimes ? '--runtimes' : null,
    args.start ? '--start' : null,
    args.logs ? '--logs' : null,
    args.reconcile ? '--reconcile' : null,
    args.restart ? '--restart' : null,
    args['launchd-install'] ? '--launchd-install' : null,
    args['launchd-uninstall'] ? '--launchd-uninstall' : null,
    args['launchd-status'] ? '--launchd-status' : null,
    args.stop ? '--stop' : null,
    args.once ? '--once' : null,
    args.status ? '--status' : null,
    args.doctor ? '--doctor' : null,
    typeof args['health-host'] === 'string' ? '--health-host' : null,
    typeof args['health-port'] === 'string' ? '--health-port' : null,
  ].filter((flag): flag is string => flag !== null)

  if (incompatibleFlags.length > 0) {
    throw new Error(`Issue lint cannot be combined with ${incompatibleFlags.join(', ')}`)
  }
}

function assertBootstrapScenarioCompatible(args: {
  'wake-now'?: boolean
  'wake-issue'?: string
  'wake-pr'?: string
  'wake-from-github-event'?: boolean
  concurrency?: string
  'poll-interval'?: string
  'idle-poll-interval'?: string
  'machine-id'?: string
  'dry-run'?: boolean
  'metrics-port'?: string
  dashboard?: boolean
  'dashboard-host'?: string
  'dashboard-port'?: string
  daemonize?: boolean
  'join-project'?: boolean
  'repo-cap'?: string
  runtimes?: boolean
  start?: boolean
  logs?: boolean
  reconcile?: boolean
  restart?: boolean
  'launchd-install'?: boolean
  'launchd-uninstall'?: boolean
  'launchd-status'?: boolean
  stop?: boolean
  once?: boolean
  status?: boolean
  doctor?: boolean
  'health-host'?: string
  'health-port'?: string
}): void {
  const incompatibleFlags = [
    args['wake-now'] ? '--wake-now' : null,
    typeof args['wake-issue'] === 'string' ? '--wake-issue' : null,
    typeof args['wake-pr'] === 'string' ? '--wake-pr' : null,
    args['wake-from-github-event'] ? '--wake-from-github-event' : null,
    typeof args.concurrency === 'string' ? '--concurrency' : null,
    typeof args['poll-interval'] === 'string' ? '--poll-interval' : null,
    typeof args['idle-poll-interval'] === 'string' ? '--idle-poll-interval' : null,
    typeof args['machine-id'] === 'string' ? '--machine-id' : null,
    args['dry-run'] ? '--dry-run' : null,
    typeof args['metrics-port'] === 'string' ? '--metrics-port' : null,
    args.dashboard ? '--dashboard' : null,
    typeof args['dashboard-host'] === 'string' ? '--dashboard-host' : null,
    typeof args['dashboard-port'] === 'string' ? '--dashboard-port' : null,
    args.daemonize ? '--daemonize' : null,
    args['join-project'] ? '--join-project' : null,
    typeof args['repo-cap'] === 'string' ? '--repo-cap' : null,
    args.runtimes ? '--runtimes' : null,
    args.start ? '--start' : null,
    args.logs ? '--logs' : null,
    args.reconcile ? '--reconcile' : null,
    args.restart ? '--restart' : null,
    args['launchd-install'] ? '--launchd-install' : null,
    args['launchd-uninstall'] ? '--launchd-uninstall' : null,
    args['launchd-status'] ? '--launchd-status' : null,
    args.stop ? '--stop' : null,
    args.once ? '--once' : null,
    args.status ? '--status' : null,
    args.doctor ? '--doctor' : null,
    typeof args['health-host'] === 'string' ? '--health-host' : null,
    typeof args['health-port'] === 'string' ? '--health-port' : null,
  ].filter((flag): flag is string => flag !== null)

  if (incompatibleFlags.length > 0) {
    throw new Error(`Bootstrap scenarios cannot be combined with ${incompatibleFlags.join(', ')}`)
  }
}

function parseWakeTargetNumber(value: string, flag: string): number {
  const trimmed = value.trim()

  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${flag} must be a positive integer`)
  }

  const parsed = Number.parseInt(trimmed, 10)

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`)
  }

  return parsed
}

async function notifyLocalWake(input: {
  healthPort: number
  request: WakeRequest
}): Promise<void> {
  const response = await fetch(`http://${DEFAULT_HEALTH_SERVER_HOST}:${input.healthPort}/wake`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(input.request),
  })

  if (!response.ok) {
    throw new Error(`Wake endpoint returned ${response.status}`)
  }
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

export function cleanupManagedRuntimeRecord(input: {
  runtimeFile?: string
  supervisor: ReturnType<typeof resolveCurrentRuntimeSupervisor>
  pid?: number
}): ManagedRuntimeCleanupResult {
  if (!input.runtimeFile || !shouldRemoveManagedRuntimeRecord(input.supervisor)) {
    return 'skipped'
  }

  return removeBackgroundRuntimeRecordIfOwned(input.runtimeFile, input.pid ?? process.pid)
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
  const launchArgs = buildManagedRuntimeLaunchArgs({
    repo: identity.repo,
    machineId: identity.machineId,
    healthPort,
    metricsPort,
    existingArgs: runtime?.record.command.slice(2),
    overrideArgs: input.argv,
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
    const stopResult = deps.stopBackgroundRuntime(runtime.recordPath, {
      timeoutMs: RESTART_BACKGROUND_RUNTIME_STOP_TIMEOUT_MS,
    })
    if (runtime.alive && !stopResult.stopped) {
      return {
        kind: 'detached',
        restarted: false,
        message: stopResult.message,
      }
    }
    const restarted = deps.launchBackgroundRuntime({
      identity: {
        repo: runtime.record.repo,
        machineId: runtime.record.machineId,
        healthPort: runtime.record.healthPort,
      },
      metricsPort: runtime.record.metricsPort,
      cwd: input.cwd,
      argv: buildManagedRuntimeLaunchArgs({
        repo: runtime.record.repo,
        machineId: runtime.record.machineId,
        healthPort: runtime.record.healthPort,
        metricsPort: runtime.record.metricsPort,
        existingArgs: runtime.record.command.slice(2),
        overrideArgs: input.argv,
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
