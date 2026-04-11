import type { AgentConfig } from '@agent/shared'
import {
  buildBackgroundRuntimePaths,
  isProcessAlive,
  launchBackgroundRuntime,
  readBackgroundRuntimeRecord,
} from './background'
import {
  buildConfig,
  CONFIG_PATH,
  loadRepoLocalConfig,
  readConfigFile,
  resolveLocalDaemonIdentity,
  writeConfigFile,
} from './config'
import { DEFAULT_HEALTH_SERVER_HOST } from './daemon'
import {
  DEFAULT_AGENT_LOOP_UPGRADE_CHECK_INTERVAL_MS,
  DEFAULT_AGENT_LOOP_UPGRADE_REMINDER_INTERVAL_MS,
} from './version'
import {
  assertLaunchdWorkingDirectorySafe,
  buildLaunchdServicePaths,
  buildLaunchdServiceSpec,
  inspectLaunchdService,
  installLaunchdService,
  startLaunchdService,
} from './launchd'

const DEFAULT_METRICS_PORT = 9090

export type JoinProjectSupervisor = 'launchd' | 'detached'
export type JoinProjectAction =
  | 'already-running'
  | 'installed-launchd'
  | 'started-launchd'
  | 'started-detached'
  | 'would-install-launchd'
  | 'would-start-launchd'
  | 'would-start-detached'

export interface JoinProjectInput {
  repo?: string
  pat?: string
  machineId?: string
  concurrency?: number
  repoCap?: number
  healthPort: number
  metricsPort?: number
  cwd: string
  scriptPath: string
  dryRun?: boolean
  env?: NodeJS.ProcessEnv
}

export interface JoinProjectResult {
  repo: string
  machineId: string
  supervisor: JoinProjectSupervisor
  action: JoinProjectAction
  dryRun: boolean
  configPath: string
  requestedConcurrency: number
  effectiveConcurrency: number
  repoCap: number | null
  projectProfile: AgentConfig['project']['profile']
  projectMaxConcurrency: number | null
  runtimeRecordPath: string
  logPath: string
  healthUrl: string
  message: string
  statusCommand: string
  doctorCommand: string
}

export interface JoinProjectDependencies {
  platform: NodeJS.Platform
  resolveLocalDaemonIdentity: typeof resolveLocalDaemonIdentity
  readConfigFile: typeof readConfigFile
  writeConfigFile: typeof writeConfigFile
  loadRepoLocalConfig: typeof loadRepoLocalConfig
  buildConfig: typeof buildConfig
  buildBackgroundRuntimePaths: typeof buildBackgroundRuntimePaths
  readBackgroundRuntimeRecord: typeof readBackgroundRuntimeRecord
  isProcessAlive: typeof isProcessAlive
  launchBackgroundRuntime: typeof launchBackgroundRuntime
  buildLaunchdServicePaths: typeof buildLaunchdServicePaths
  inspectLaunchdService: typeof inspectLaunchdService
  buildLaunchdServiceSpec: typeof buildLaunchdServiceSpec
  installLaunchdService: typeof installLaunchdService
  startLaunchdService: typeof startLaunchdService
  assertLaunchdWorkingDirectorySafe: typeof assertLaunchdWorkingDirectorySafe
}

const DEFAULT_JOIN_PROJECT_DEPENDENCIES: JoinProjectDependencies = {
  platform: process.platform,
  resolveLocalDaemonIdentity,
  readConfigFile,
  writeConfigFile,
  loadRepoLocalConfig,
  buildConfig,
  buildBackgroundRuntimePaths,
  readBackgroundRuntimeRecord,
  isProcessAlive,
  launchBackgroundRuntime,
  buildLaunchdServicePaths,
  inspectLaunchdService,
  buildLaunchdServiceSpec,
  installLaunchdService,
  startLaunchdService,
  assertLaunchdWorkingDirectorySafe,
}

export function buildJoinProjectConfigFile(
  existingConfig: Partial<AgentConfig>,
  input: {
    repo: string
    machineId: string
    pat?: string
    concurrency?: number
    repoCap?: number
  },
): Partial<AgentConfig> {
  const nextConfig: Partial<AgentConfig> = {
    ...existingConfig,
    repo: input.repo,
    machineId: input.machineId,
    upgrade: {
      ...(existingConfig.upgrade ?? {}),
      enabled: existingConfig.upgrade?.enabled !== false,
      repo: existingConfig.upgrade?.repo ?? null,
      channel: existingConfig.upgrade?.channel ?? null,
      checkIntervalMs:
        existingConfig.upgrade?.checkIntervalMs
        ?? DEFAULT_AGENT_LOOP_UPGRADE_CHECK_INTERVAL_MS,
      reminderIntervalMs:
        existingConfig.upgrade?.reminderIntervalMs
        ?? DEFAULT_AGENT_LOOP_UPGRADE_REMINDER_INTERVAL_MS,
      autoApply: existingConfig.upgrade?.autoApply !== false,
    },
  }

  const normalizedPat = normalizeNonEmptyString(input.pat)
  if (normalizedPat) {
    nextConfig.pat = normalizedPat
  }

  const normalizedConcurrency = normalizeOptionalPositiveInteger(input.concurrency)
  if (normalizedConcurrency !== null) {
    nextConfig.concurrency = normalizedConcurrency
  }

  const normalizedRepoCap = normalizeOptionalPositiveInteger(input.repoCap)
  if (normalizedRepoCap !== null) {
    nextConfig.scheduling = {
      concurrencyByRepo: {
        ...(existingConfig.scheduling?.concurrencyByRepo ?? {}),
        [input.repo]: normalizedRepoCap,
      },
      concurrencyByProfile: {
        ...(existingConfig.scheduling?.concurrencyByProfile ?? {}),
      },
    }
  }

  return nextConfig
}

export function joinProjectMachine(
  input: JoinProjectInput,
  deps: JoinProjectDependencies = DEFAULT_JOIN_PROJECT_DEPENDENCIES,
): JoinProjectResult {
  const identity = deps.resolveLocalDaemonIdentity(
    {
      repo: input.repo,
      machineId: input.machineId,
    },
    {
      persistGeneratedMachineId: false,
    },
  )
  const existingConfig = deps.readConfigFile()
  const mergedConfig = buildJoinProjectConfigFile(existingConfig, {
    repo: identity.repo,
    machineId: identity.machineId,
    pat: input.pat,
    concurrency: input.concurrency,
    repoCap: input.repoCap,
  })
  if (!input.dryRun) {
    deps.writeConfigFile(mergedConfig as Record<string, unknown>)
  }

  const repoConfig = deps.loadRepoLocalConfig(input.cwd)
  const resolvedConfig = deps.buildConfig(
    {
      repo: identity.repo,
      machineId: identity.machineId,
      pat: input.pat,
      concurrency: input.concurrency,
    },
    {
      fileConfig: mergedConfig,
      repoConfig,
      env: input.env,
    },
  )

  const healthPort = normalizeOptionalPositiveInteger(input.healthPort) ?? 9310
  const metricsPort = normalizeOptionalPositiveInteger(input.metricsPort) ?? DEFAULT_METRICS_PORT
  const supervisor = resolveJoinProjectSupervisor(deps.platform)
  const daemonArgs = buildManagedDaemonArgs({
    repo: resolvedConfig.repo,
    machineId: resolvedConfig.machineId,
    healthPort,
    metricsPort,
  })

  const runResult = supervisor === 'launchd'
    ? runLaunchdJoin({
      input,
      config: resolvedConfig,
      daemonArgs,
      healthPort,
      metricsPort,
      deps,
    })
    : runDetachedJoin({
      input,
      config: resolvedConfig,
      daemonArgs,
      healthPort,
      metricsPort,
      deps,
    })

  return {
    repo: resolvedConfig.repo,
    machineId: resolvedConfig.machineId,
    supervisor,
    action: runResult.action,
    dryRun: Boolean(input.dryRun),
    configPath: CONFIG_PATH,
    requestedConcurrency: resolvedConfig.requestedConcurrency,
    effectiveConcurrency: resolvedConfig.concurrency,
    repoCap: resolvedConfig.concurrencyPolicy.repoCap,
    projectProfile: resolvedConfig.project.profile,
    projectMaxConcurrency: resolvedConfig.project.maxConcurrency ?? null,
    runtimeRecordPath: runResult.runtimeRecordPath,
    logPath: runResult.logPath,
    healthUrl: `http://${DEFAULT_HEALTH_SERVER_HOST}:${healthPort}/health`,
    message: runResult.message,
    statusCommand: buildStatusCommand(resolvedConfig.repo, resolvedConfig.machineId, healthPort),
    doctorCommand: buildDoctorCommand(resolvedConfig.repo, resolvedConfig.machineId, healthPort),
  }
}

export function formatJoinProjectResult(result: JoinProjectResult): string {
  return [
    'Join Project',
    '',
    `repo: ${result.repo}`,
    `machine: ${result.machineId}`,
    `supervisor: ${result.supervisor}`,
    `action: ${result.action}`,
    `mode: ${result.dryRun ? 'dry-run' : 'applied'}`,
    `message: ${result.message}`,
    `config: ${result.configPath}`,
    `project: ${result.projectProfile} | project max concurrency ${formatNullableNumber(result.projectMaxConcurrency)}`,
    `concurrency: requested ${result.requestedConcurrency} | effective ${result.effectiveConcurrency} | repo cap ${formatNullableNumber(result.repoCap)}`,
    `runtime files: record ${result.runtimeRecordPath} | log ${result.logPath}`,
    `health: ${result.healthUrl}`,
    `status: ${result.statusCommand}`,
    `doctor: ${result.doctorCommand}`,
  ].join('\n')
}

function runLaunchdJoin(input: {
  input: JoinProjectInput
  config: AgentConfig
  daemonArgs: string[]
  healthPort: number
  metricsPort: number
  deps: JoinProjectDependencies
}): {
  action: JoinProjectAction
  runtimeRecordPath: string
  logPath: string
  message: string
} {
  const { config, deps } = input
  const launchdPaths = deps.buildLaunchdServicePaths({
    repo: config.repo,
    machineId: config.machineId,
    healthPort: input.healthPort,
  })
  const status = deps.inspectLaunchdService(launchdPaths)

  if (status.installed && status.loaded) {
    return {
      action: 'already-running',
      runtimeRecordPath: launchdPaths.runtimeRecordPath,
      logPath: launchdPaths.logPath,
      message: `Launchd service ${launchdPaths.label} is already running`,
    }
  }

  if (input.input.dryRun) {
    return {
      action: status.installed ? 'would-start-launchd' : 'would-install-launchd',
      runtimeRecordPath: launchdPaths.runtimeRecordPath,
      logPath: launchdPaths.logPath,
      message: status.installed
        ? `Would start installed launchd service ${launchdPaths.label}`
        : `Would install and start launchd service ${launchdPaths.label}`,
    }
  }

  if (status.installed) {
    const startResult = deps.startLaunchdService(launchdPaths)
    return {
      action: 'started-launchd',
      runtimeRecordPath: launchdPaths.runtimeRecordPath,
      logPath: launchdPaths.logPath,
      message: startResult.message,
    }
  }

  deps.assertLaunchdWorkingDirectorySafe(input.input.cwd)
  const spec = deps.buildLaunchdServiceSpec({
    identity: {
      repo: config.repo,
      machineId: config.machineId,
      healthPort: input.healthPort,
    },
    cwd: input.input.cwd,
    scriptPath: input.input.scriptPath,
    argv: input.daemonArgs,
    env: input.input.env,
  })
  deps.installLaunchdService(spec)

  return {
    action: 'installed-launchd',
    runtimeRecordPath: spec.runtimeRecordPath,
    logPath: spec.logPath,
    message: `Installed and started launchd service ${spec.label}`,
  }
}

function runDetachedJoin(input: {
  input: JoinProjectInput
  config: AgentConfig
  daemonArgs: string[]
  healthPort: number
  metricsPort: number
  deps: JoinProjectDependencies
}): {
  action: JoinProjectAction
  runtimeRecordPath: string
  logPath: string
  message: string
} {
  const { config, deps } = input
  const runtimePaths = deps.buildBackgroundRuntimePaths({
    repo: config.repo,
    machineId: config.machineId,
    healthPort: input.healthPort,
  })
  const existingRecord = deps.readBackgroundRuntimeRecord(runtimePaths.recordPath)

  if (existingRecord && deps.isProcessAlive(existingRecord.pid)) {
    return {
      action: 'already-running',
      runtimeRecordPath: runtimePaths.recordPath,
      logPath: runtimePaths.logPath,
      message: `Detached daemon pid ${existingRecord.pid} is already running`,
    }
  }

  if (input.input.dryRun) {
    return {
      action: 'would-start-detached',
      runtimeRecordPath: runtimePaths.recordPath,
      logPath: runtimePaths.logPath,
      message: existingRecord
        ? `Would replace stale detached daemon record at ${runtimePaths.recordPath}`
        : 'Would start detached daemon',
    }
  }

  const record = deps.launchBackgroundRuntime({
    identity: {
      repo: config.repo,
      machineId: config.machineId,
      healthPort: input.healthPort,
    },
    metricsPort: input.metricsPort,
    cwd: input.input.cwd,
    argv: input.daemonArgs,
    scriptPath: input.input.scriptPath,
    env: input.input.env,
  })

  return {
    action: 'started-detached',
    runtimeRecordPath: runtimePaths.recordPath,
    logPath: record.logPath,
    message: `Started detached daemon with pid ${record.pid}`,
  }
}

function resolveJoinProjectSupervisor(platform: NodeJS.Platform): JoinProjectSupervisor {
  return platform === 'darwin' ? 'launchd' : 'detached'
}

function buildManagedDaemonArgs(input: {
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

function buildStatusCommand(repo: string, machineId: string, healthPort: number): string {
  return `agent-loop --status --repo ${repo} --machine-id ${machineId} --health-port ${healthPort}`
}

function buildDoctorCommand(repo: string, machineId: string, healthPort: number): string {
  return `agent-loop --doctor --repo ${repo} --machine-id ${machineId} --health-port ${healthPort}`
}

function normalizeOptionalPositiveInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const integer = Math.trunc(value)
  return integer >= 1 ? integer : null
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function formatNullableNumber(value: number | null): string {
  return value === null ? 'none' : String(value)
}
