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
import { AgentDaemon, DEFAULT_HEALTH_SERVER_PORT, DEFAULT_HEALTH_SERVER_HOST, type HealthServerConfig } from './daemon'
import { loadConfig, resolveLocalDaemonIdentity, type CliArgs } from './config'
import { collectDaemonObservability, formatDoctorReport, formatStatusReport } from './status'
import {
  buildBackgroundRuntimePaths,
  launchBackgroundRuntime,
  listBackgroundRuntimeRecords,
  removeBackgroundRuntimeRecord,
  resolveBackgroundRuntimeRecord,
  stopBackgroundRuntime,
  type BackgroundRuntimeSnapshot,
} from './background'

type PartialHealthServerConfig = Partial<HealthServerConfig>

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
      runtimes: { type: 'boolean' },
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

  if (args.daemonize && (args.stop || args.status || args.doctor || args.once)) {
    throw new Error('--daemonize cannot be combined with --stop, --status, --doctor, or --once')
  }

  if (args.runtimes && (args.daemonize || args.stop || args.status || args.doctor || args.once)) {
    throw new Error('--runtimes cannot be combined with --daemonize, --stop, --status, --doctor, or --once')
  }

  if (args.stop && (args.status || args.doctor || args.once)) {
    throw new Error('--stop cannot be combined with --status, --doctor, or --once')
  }

  const runtimeRepoHint = resolveRepoHint(args.repo as string | undefined)
  const runtimeMachineIdHint = args['machine-id'] as string | undefined
  const runtimeHealthPortHint = args['health-port'] ? parseInt(args['health-port'] as string) : undefined
  const discoveredRuntime = args.status || args.doctor || args.stop
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
    if (args.stop) {
      const result = discoveredRuntime
        ? stopBackgroundRuntime(discoveredRuntime.recordPath)
        : stopBackgroundRuntime(resolveFallbackRuntimeRecordPath({
          repo: cliArgs.repo,
          machineId: cliArgs.machineId,
          healthPort: healthServerConfig.port ?? DEFAULT_HEALTH_SERVER_PORT,
        }))
      console.log(`[agent-loop] ${result.message}`)
      process.exit(result.stopped ? 0 : 1)
    }

    const config = loadConfig(cliArgs)

    const runtimePaths = buildBackgroundRuntimePaths({
      repo: config.repo,
      machineId: config.machineId,
      healthPort: healthServerConfig.port ?? DEFAULT_HEALTH_SERVER_PORT,
    })

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
      if (runtimeFile) {
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
  agent-loop --status [--health-port 9310]
  agent-loop --doctor [--health-port 9310]
  agent-loop --runtimes
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
      --runtimes              List local background daemon records discovered on this machine
      --stop                  Stop the detached daemon instance matching repo/machine-id/health-port
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
  agent-loop --runtimes
  agent-loop --daemonize --repo owner/repo --health-port 9311 --metrics-port 9091
  agent-loop --stop --repo owner/repo --health-port 9311
  agent-loop --status
  agent-loop --doctor --health-port 9311 --metrics-port 9091
  GITHUB_TOKEN=ghp_xxx agent-loop --once
`)
}

main().catch((err) => {
  console.error('[agent-loop] fatal error:', err)
  process.exit(1)
})

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

function resolveFallbackRuntimeRecordPath(input: {
  repo?: string
  machineId?: string
  healthPort: number
}): string {
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
  }).recordPath
}

function formatRuntimeListing(
  runtimes: BackgroundRuntimeSnapshot[],
  repoHint?: string,
): string {
  if (runtimes.length === 0) {
    return 'No local background daemon runtime records found.'
  }

  const lines = ['Local background daemons:']

  for (const runtime of runtimes) {
    const state = runtime.alive ? 'alive' : 'stale'
    const match = repoHint && runtime.record.repo === repoHint ? ' current-repo' : ''
    lines.push(
      `- ${state}${match} repo=${runtime.record.repo} machine=${runtime.record.machineId} pid=${runtime.record.pid} health=${runtime.record.healthPort} metrics=${runtime.record.metricsPort} started=${runtime.record.startedAt} cwd=${runtime.record.cwd}`,
    )
  }

  return lines.join('\n')
}
