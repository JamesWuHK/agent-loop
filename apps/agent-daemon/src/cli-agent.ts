import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentConfig, AgentExitCode } from '@agent/shared'

export type AgentKind = AgentConfig['agent']['primary']

export interface CliAgentRunOptions {
  prompt: string
  worktreePath: string
  timeoutMs: number
  config: AgentConfig
  logger?: typeof console
  allowWrites?: boolean
  monitor?: AgentRunMonitor
}

export interface AgentRunMonitor {
  heartbeatIntervalMs?: number
  idleTimeoutMs?: number
  onActivity?: (kind: 'stdout' | 'stderr' | 'git-state') => void | Promise<void>
  shouldAbort?: () => boolean | Promise<boolean>
  abortMessage?: string
}

export interface TaskExecutionMonitor {
  setPhase?: (phase: string) => void
  agentMonitor?: AgentRunMonitor
}

export interface CliAgentRunResult {
  ok: boolean
  exitCode: AgentExitCode
  stdout: string
  stderr: string
  responseText: string
  usedAgent: AgentKind
  usedFallback: boolean
  failureKind?: 'binary_missing' | 'process_timeout' | 'idle_timeout' | 'execution_error' | 'nonzero_exit' | 'remote_closed'
}

export type AgentFailureKind = NonNullable<CliAgentRunResult['failureKind']>

interface SpawnResult {
  exitCode: number
  stdout: Uint8Array
  stderr: Uint8Array
}

const SHELL_BOOTSTRAP_ENV_KEYS = [
  'PATH',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'no_proxy',
  'NO_PROXY',
  'BUN_INSTALL',
  'NVM_BIN',
  'NVM_DIR',
  'VOLTA_HOME',
  'ASDF_DIR',
]

export function resolveAgentBinary(agent: AgentKind, config: AgentConfig): string {
  return agent === 'claude' ? config.agent.claudePath : config.agent.codexPath
}

export function buildAgentCommand(
  agent: AgentKind,
  binaryPath: string,
  responseFilePath: string,
  allowWrites: boolean,
): string[] {
  if (agent === 'claude') {
    return [binaryPath, '--print', '--permission-mode', 'bypassPermissions']
  }

  return [
    binaryPath,
    'exec',
    '--color',
    'never',
    '--output-last-message',
    responseFilePath,
    '-c',
    'model_reasoning_effort="medium"',
    ...(allowWrites ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--sandbox', 'read-only']),
    '-',
  ]
}

export function buildIsolatedCodexConfig(baseUrl?: string | null): string {
  const providerLines = [
    '[model_providers.custom]',
    'name = "custom"',
    ...(baseUrl ? [`base_url = ${JSON.stringify(baseUrl)}`] : []),
    'wire_api = "responses"',
    'requires_openai_auth = true',
  ]

  return `model_provider = "custom"
model = "gpt-5.4"
model_reasoning_effort = "medium"
network_access = "enabled"
disable_response_storage = true

${providerLines.join('\n')}
`
}

export function resolveCodexAuthJson(
  env: Record<string, string>,
  fallbackAuthJson: string | null,
): string | null {
  const authKey = env.OPENAI_API_KEY || env.SUB2API_KEY
  if (authKey) {
    return `${JSON.stringify({ OPENAI_API_KEY: authKey }, null, 2)}\n`
  }

  return fallbackAuthJson
}

export function createIsolatedCodexHome(
  tempDir: string,
  env: Record<string, string>,
  fallbackAuthJson: string | null = readLocalCodexAuthJson(),
): { homeDir: string; codexHomeDir: string } {
  const homeDir = join(tempDir, 'home')
  const codexHomeDir = join(homeDir, '.codex')

  mkdirSync(codexHomeDir, { recursive: true })
  writeFileSync(
    join(codexHomeDir, 'config.toml'),
    buildIsolatedCodexConfig(env.OPENAI_BASE_URL ?? null),
    'utf-8',
  )

  const authJson = resolveCodexAuthJson(env, fallbackAuthJson)
  if (authJson) {
    writeFileSync(join(codexHomeDir, 'auth.json'), authJson, 'utf-8')
  }

  writeShellBootstrapFiles(homeDir, env)

  return { homeDir, codexHomeDir }
}

export async function runConfiguredAgent(
  options: CliAgentRunOptions,
): Promise<CliAgentRunResult> {
  const logger = options.logger ?? console
  const primary = options.config.agent.primary
  const fallback = options.config.agent.fallback

  const primaryResult = await runSingleAgent(primary, false, options)
  if (
    primaryResult.ok
    || !fallback
    || fallback === primary
    || primaryResult.failureKind === 'remote_closed'
  ) {
    return primaryResult
  }

  logger.warn(
    `[agent] primary ${primary} run failed (exit ${primaryResult.exitCode}), trying fallback ${fallback}...`,
  )

  return runSingleAgent(fallback, true, options)
}

async function runSingleAgent(
  agent: AgentKind,
  usedFallback: boolean,
  options: CliAgentRunOptions,
): Promise<CliAgentRunResult> {
  const binaryPath = resolveAgentBinary(agent, options.config)
  const binaryExists = await commandExists(binaryPath)

  if (!binaryExists) {
    return {
      ok: false,
      exitCode: 2,
      stdout: '',
      stderr: `Agent binary not found: ${binaryPath}`,
      responseText: '',
      usedAgent: agent,
      usedFallback,
      failureKind: 'binary_missing',
    }
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'agent-loop-'))
  const responseFilePath = join(tempDir, 'last-message.txt')
  const command = buildAgentCommand(
    agent,
    binaryPath,
    responseFilePath,
    options.allowWrites ?? true,
  )

  let proc: ReturnType<typeof Bun.spawn> | null = null
  let result: SpawnResult
  let timedOut = false
  let idleTimedOut = false
  let activityMonitorTimer: ReturnType<typeof setInterval> | null = null
  let processTimeoutId: ReturnType<typeof setTimeout> | null = null
  let lastActivityAt = Date.now()
  let lastWorktreeSignature: string | null = null
  let monitorInFlight = false
  let aborted = false
  let abortMessage = options.monitor?.abortMessage ?? 'Aborted because the remote issue is already done/closed'

  try {
    const env = buildRuntimeEnv(agent, options.config, tempDir)
    proc = Bun.spawn(command, {
      cwd: options.worktreePath,
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const stdin = proc.stdin
    const stdout = proc.stdout
    const stderr = proc.stderr
    if (
      !stdin || !stdout || !stderr
      || typeof stdin === 'number'
      || typeof stdout === 'number'
      || typeof stderr === 'number'
    ) {
      throw new Error('Agent process stdio pipes were not created')
    }

    if (options.monitor) {
      lastWorktreeSignature = await captureWorktreeSignature(options.worktreePath)
      activityMonitorTimer = setInterval(() => {
        if (monitorInFlight) return
        monitorInFlight = true
        void pollMonitorProgress(
          options,
          () => lastWorktreeSignature,
          (signature) => {
            lastWorktreeSignature = signature
          },
          () => {
            lastActivityAt = Date.now()
            notifyActivity(options.monitor, 'git-state')
          },
          () => lastActivityAt,
          () => {
            idleTimedOut = true
            try {
              proc?.kill('SIGKILL')
            } catch {
              // ignore kill errors
            }
          },
          (message) => {
            aborted = true
            abortMessage = message
            try {
              proc?.kill('SIGKILL')
            } catch {
              // ignore kill errors
            }
          },
        ).finally(() => {
          monitorInFlight = false
        })
      }, options.monitor.heartbeatIntervalMs ?? options.config.recovery.heartbeatIntervalMs)
    }

    stdin.write(options.prompt)
    stdin.end()

    result = await Promise.race([
      (async () => {
        const [stdoutBuffer, stderrBuffer] = await Promise.all([
          readProcessStream(stdout, () => {
            lastActivityAt = Date.now()
            notifyActivity(options.monitor, 'stdout')
          }),
          readProcessStream(stderr, () => {
            lastActivityAt = Date.now()
            notifyActivity(options.monitor, 'stderr')
          }),
        ])
        const exitCode = await proc!.exited
        return {
          exitCode,
          stdout: new Uint8Array(stdoutBuffer),
          stderr: new Uint8Array(stderrBuffer),
        }
      })(),
      new Promise<never>((_, reject) => {
        processTimeoutId = setTimeout(() => {
          timedOut = true
          try {
            proc?.kill('SIGKILL')
          } catch {
            // ignore kill errors
          }
          reject(new Error(`Timeout after ${options.timeoutMs}ms`))
        }, options.timeoutMs)
      }),
    ])
  } catch (err) {
    if (activityMonitorTimer) {
      clearInterval(activityMonitorTimer)
    }
    if (processTimeoutId) {
      clearTimeout(processTimeoutId)
    }
    rmSync(tempDir, { recursive: true, force: true })

    if (aborted) {
      return {
        ok: false,
        exitCode: 1,
        stdout: '',
        stderr: abortMessage,
        responseText: '',
        usedAgent: agent,
        usedFallback,
        failureKind: 'remote_closed',
      }
    }

    if (idleTimedOut) {
      return {
        ok: false,
        exitCode: 3,
        stdout: '',
        stderr: `Idle timeout after ${options.monitor?.idleTimeoutMs ?? options.config.recovery.workerIdleTimeoutMs}ms`,
        responseText: '',
        usedAgent: agent,
        usedFallback,
        failureKind: 'idle_timeout',
      }
    }

    if (timedOut || (err instanceof Error && err.message.includes('Timeout'))) {
      return {
        ok: false,
        exitCode: 3,
        stdout: '',
        stderr: `Timeout after ${options.timeoutMs}ms`,
        responseText: '',
        usedAgent: agent,
        usedFallback,
        failureKind: 'process_timeout',
      }
    }

    return {
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr: String(err),
      responseText: '',
      usedAgent: agent,
      usedFallback,
      failureKind: 'execution_error',
    }
  }

  if (activityMonitorTimer) {
    clearInterval(activityMonitorTimer)
  }
  if (processTimeoutId) {
    clearTimeout(processTimeoutId)
  }

  if (aborted) {
    rmSync(tempDir, { recursive: true, force: true })
    return {
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr: abortMessage,
      responseText: '',
      usedAgent: agent,
      usedFallback,
      failureKind: 'remote_closed',
    }
  }

  if (idleTimedOut) {
    rmSync(tempDir, { recursive: true, force: true })
    return {
      ok: false,
      exitCode: 3,
      stdout: '',
      stderr: `Idle timeout after ${options.monitor?.idleTimeoutMs ?? options.config.recovery.workerIdleTimeoutMs}ms`,
      responseText: '',
      usedAgent: agent,
      usedFallback,
      failureKind: 'idle_timeout',
    }
  }

  if (timedOut) {
    rmSync(tempDir, { recursive: true, force: true })
    return {
      ok: false,
      exitCode: 3,
      stdout: '',
      stderr: `Timeout after ${options.timeoutMs}ms`,
      responseText: '',
      usedAgent: agent,
      usedFallback,
      failureKind: 'process_timeout',
    }
  }

  const stdout = await new Response(result.stdout).text()
  const stderr = await new Response(result.stderr).text()
  const responseText = readResponseText(agent, responseFilePath, stdout)

  rmSync(tempDir, { recursive: true, force: true })

  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode === 0 ? 0 : 1,
    stdout,
    stderr,
    responseText,
    usedAgent: agent,
    usedFallback,
    ...(result.exitCode === 0 ? {} : { failureKind: 'nonzero_exit' as const }),
  }
}

async function readProcessStream(
  stream: ReadableStream<Uint8Array>,
  onChunk: () => void,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    onChunk()
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const combined = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return combined
}

async function pollMonitorProgress(
  options: CliAgentRunOptions,
  getSignature: () => string | null,
  setSignature: (signature: string) => void,
  onGitProgress: () => void,
  getLastActivityAt: () => number,
  onIdleTimeout: () => void,
  onAbort: (message: string) => void,
): Promise<void> {
  if (!options.monitor) return

  const signature = await captureWorktreeSignature(options.worktreePath)
  if (signature !== getSignature()) {
    setSignature(signature)
    onGitProgress()
  }

  if (options.monitor.shouldAbort) {
    try {
      const shouldAbort = await options.monitor.shouldAbort()
      if (shouldAbort) {
        onAbort(options.monitor.abortMessage ?? 'Aborted because the remote issue is already done/closed')
        return
      }
    } catch {
      // abort checks are best-effort and should never fail the agent run
    }
  }

  const idleTimeoutMs = options.monitor.idleTimeoutMs ?? options.config.recovery.workerIdleTimeoutMs
  if (Date.now() - getLastActivityAt() > idleTimeoutMs) {
    onIdleTimeout()
  }
}

function notifyActivity(
  monitor: AgentRunMonitor | undefined,
  kind: 'stdout' | 'stderr' | 'git-state',
): void {
  if (!monitor?.onActivity) return
  void Promise.resolve(monitor.onActivity(kind)).catch(() => {
    // activity callbacks are best-effort and should never fail the agent run
  })
}

async function captureWorktreeSignature(worktreePath: string): Promise<string> {
  const [head, status] = await Promise.all([
    runGitRead(worktreePath, ['rev-parse', 'HEAD']),
    runGitRead(worktreePath, ['status', '--short']),
  ])

  return `${head.trim()}|${status.trim()}`
}

async function runGitRead(
  worktreePath: string,
  args: string[],
): Promise<string> {
  const proc = Bun.spawn(['git', '-C', worktreePath, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stdout = await new Response(proc.stdout).text()
  await proc.exited
  return stdout
}

function readResponseText(
  agent: AgentKind,
  responseFilePath: string,
  stdout: string,
): string {
  if (agent === 'codex' && existsSync(responseFilePath)) {
    return readFileSync(responseFilePath, 'utf-8').trim()
  }

  return stdout.trim()
}

function writeShellBootstrapFiles(
  homeDir: string,
  env: Record<string, string>,
): void {
  const bootstrapPath = join(homeDir, '.agent-loop-shell-env')
  const bootstrapContents = buildShellBootstrapContents(env)
  writeFileSync(bootstrapPath, bootstrapContents, 'utf-8')

  const sourceLine = `. "${bootstrapPath}"\n`
  writeFileSync(join(homeDir, '.zshenv'), sourceLine, 'utf-8')
  writeFileSync(join(homeDir, '.zprofile'), sourceLine, 'utf-8')
  writeFileSync(join(homeDir, '.bash_profile'), sourceLine, 'utf-8')
  writeFileSync(join(homeDir, '.bashrc'), sourceLine, 'utf-8')
  writeFileSync(join(homeDir, '.profile'), sourceLine, 'utf-8')
}

function buildShellBootstrapContents(env: Record<string, string>): string {
  const lines = ['# Generated by agent-loop to preserve runtime toolchain access.']

  for (const key of SHELL_BOOTSTRAP_ENV_KEYS) {
    const value = env[key]
    if (!value) continue
    lines.push(`export ${key}=${shellQuote(value)}`)
  }

  return `${lines.join('\n')}\n`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll('\'', `'\\''`)}'`
}

function buildCleanEnv(config: AgentConfig): Record<string, string> {
  const cleanEnv: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) cleanEnv[key] = value
  }

  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT
  delete cleanEnv.VSCODE_INJECTION_ID

  cleanEnv.GIT_AUTHOR_NAME = config.git.authorName
  cleanEnv.GIT_COMMITTER_NAME = config.git.authorName
  cleanEnv.GIT_AUTHOR_EMAIL = config.git.authorEmail
  cleanEnv.GIT_COMMITTER_EMAIL = config.git.authorEmail
  if (config.pat) {
    cleanEnv.GH_TOKEN = config.pat
    cleanEnv.GITHUB_TOKEN = config.pat
  } else {
    delete cleanEnv.GH_TOKEN
    delete cleanEnv.GITHUB_TOKEN
  }

  if (!cleanEnv.OPENAI_API_KEY && cleanEnv.SUB2API_KEY) {
    cleanEnv.OPENAI_API_KEY = cleanEnv.SUB2API_KEY
  }

  if (config.agent.codexBaseUrl) {
    cleanEnv.OPENAI_BASE_URL = config.agent.codexBaseUrl
  }

  if (!cleanEnv.OPENAI_BASE_URL) {
    const openaiBaseUrl =
      cleanEnv.OPENAI_API_BASE
      || cleanEnv.OPENAI_API_URL
      || cleanEnv.OPENAI_BASE
    if (openaiBaseUrl) {
      cleanEnv.OPENAI_BASE_URL = openaiBaseUrl
    }
  }

  return cleanEnv
}

function buildRuntimeEnv(
  agent: AgentKind,
  config: AgentConfig,
  tempDir: string,
): Record<string, string> {
  const cleanEnv = buildCleanEnv(config)

  if (agent !== 'codex') {
    return cleanEnv
  }

  const { homeDir, codexHomeDir } = createIsolatedCodexHome(tempDir, cleanEnv)

  return {
    ...cleanEnv,
    HOME: homeDir,
    CODEX_HOME: codexHomeDir,
  }
}

function readLocalCodexAuthJson(): string | null {
  const authPath = resolve(homedir(), '.codex', 'auth.json')
  if (!existsSync(authPath)) {
    return null
  }

  return readFileSync(authPath, 'utf-8')
}

async function commandExists(binaryPath: string): Promise<boolean> {
  const proc = Bun.spawn(['which', binaryPath], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const exitCode = await proc.exited
  return exitCode === 0
}
