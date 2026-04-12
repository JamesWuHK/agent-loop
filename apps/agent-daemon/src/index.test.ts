import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildWakeRequestFromCli,
  buildManagedRestartArgs,
  buildManagedRuntimeLaunchArgs,
  cleanupManagedRuntimeRecord,
  executeBootstrapGateCommand,
  executeBootstrapScenarioCommand,
  executeBootstrapScorecardCommand,
  executeIssueLintCommand,
  executeWakeCommand,
  executeWakeRequest,
  formatBootstrapGateOutput,
  formatBootstrapScenarioOutput,
  formatBootstrapScorecardOutput,
  formatIssueLintOutput,
  formatManagedRuntimeLog,
  readManagedRuntimeLog,
  resolveIssueLintTarget,
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

  test('resolves lint targets and rejects conflicting lint selectors', () => {
    expect(resolveIssueLintTarget({
      'lint-file': 'docs/issues/ready.md',
    })).toEqual({
      kind: 'file',
      path: 'docs/issues/ready.md',
    })

    expect(resolveIssueLintTarget({
      'lint-issue': '36',
    })).toEqual({
      kind: 'issue',
      issueNumber: 36,
    })

    expect(() => resolveIssueLintTarget({
      'lint-issue': '36',
      'lint-file': 'docs/issues/ready.md',
    })).toThrow('Only one of --lint-issue or --lint-file can be used at a time')
  })

  test('executes local issue lint without loading remote config', async () => {
    const report = await executeIssueLintCommand({
      target: {
        kind: 'file',
        path: 'docs/issues/ready.md',
      },
    }, {
      loadConfig: () => {
        throw new Error('should not load remote config for local lint')
      },
      buildIssueLintReportFromMarkdownFile: (path) => ({
        source: {
          kind: 'file',
          path,
        },
        valid: true,
        score: 100,
        errors: [],
        warnings: [],
        readyGateBlocked: false,
        readyGateStatus: 'pass',
        readyGateSummary: 'ready gate would pass current hard validation checks',
        contract: {
          allowedFiles: ['docs/issues/ready.md'],
        },
      }),
      buildIssueLintReportFromRemoteIssue: async () => {
        throw new Error('should not fetch remote issue for local lint')
      },
    })

    expect(report).toMatchObject({
      source: {
        kind: 'file',
        path: 'docs/issues/ready.md',
      },
      valid: true,
      readyGateBlocked: false,
    })
  })

  test('executes remote issue lint with repo-aware config and supports json output', async () => {
    const report = await executeIssueLintCommand({
      target: {
        kind: 'issue',
        issueNumber: 36,
      },
      repo: 'JamesWuHK/agent-loop',
      pat: 'ghp_test',
    }, {
      loadConfig: (args = {}) => {
        expect(args).toEqual({
          repo: 'JamesWuHK/agent-loop',
          pat: 'ghp_test',
        })

        return {
          repo: 'JamesWuHK/agent-loop',
          pat: 'ghp_test',
          machineId: 'codex-dev',
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
          pollIntervalMs: 60_000,
          idlePollIntervalMs: 300_000,
          recovery: {
            heartbeatIntervalMs: 30_000,
            leaseTtlMs: 60_000,
            workerIdleTimeoutMs: 300_000,
            leaseAdoptionBackoffMs: 5_000,
            leaseNoProgressTimeoutMs: 360_000,
          },
          worktreesBase: '/tmp/agent-worktrees',
          project: {
            profile: 'generic',
          },
          agent: {
            primary: 'codex',
            fallback: 'claude',
            claudePath: 'claude',
            codexPath: 'codex',
            codexReasoningEffort: 'high',
            timeoutMs: 300_000,
          },
          git: {
            defaultBranch: 'main',
            authorName: 'agent-loop',
            authorEmail: 'agent-loop@example.com',
          },
        }
      },
      buildIssueLintReportFromMarkdownFile: () => {
        throw new Error('should not read a local file for remote lint')
      },
      buildIssueLintReportFromRemoteIssue: async ({ issueNumber, config }) => {
        expect(issueNumber).toBe(36)
        expect(config.repo).toBe('JamesWuHK/agent-loop')

        return {
          source: {
            kind: 'issue',
            issueNumber,
            repo: config.repo,
          },
          valid: false,
          score: 70,
          errors: ['missing ## RED 测试 / RED Tests'],
          warnings: ['AllowedFiles should use exact paths or tightly scoped directories: frontend files'],
          readyGateBlocked: true,
          readyGateStatus: 'blocked',
          readyGateSummary: 'ready gate would still block on hard validation errors',
          contract: {
            allowedFiles: ['frontend files'],
          },
        }
      },
    })

    expect(report.readyGateBlocked).toBe(true)
    expect(JSON.parse(formatIssueLintOutput(report, true))).toMatchObject({
      valid: false,
      readyGateBlocked: true,
      source: {
        kind: 'issue',
        issueNumber: 36,
        repo: 'JamesWuHK/agent-loop',
      },
    })
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

  test('resolves issue lint targets for local files and remote issues', () => {
    expect(resolveIssueLintTarget({
      'lint-file': 'docs/issues/ready-gate.md',
    })).toEqual({
      kind: 'file',
      path: 'docs/issues/ready-gate.md',
    })

    expect(resolveIssueLintTarget({
      'lint-issue': '36',
    })).toEqual({
      kind: 'issue',
      issueNumber: 36,
    })

    expect(() => resolveIssueLintTarget({
      'lint-file': 'docs/issues/ready-gate.md',
      'lint-issue': '36',
    })).toThrow('Only one of --lint-issue or --lint-file can be used at a time')
  })

  test('builds lint reports from local markdown files', async () => {
    const report = await executeIssueLintCommand({
      target: {
        kind: 'file',
        path: '/tmp/issue-36.md',
      },
    }, {
      loadConfig: () => {
        throw new Error('remote config should not be loaded for local lint')
      },
      buildIssueLintReportFromMarkdownFile: (path) => ({
        source: {
          kind: 'file',
          path,
        },
        valid: true,
        score: 90,
        errors: [],
        warnings: ['AllowedFiles should use exact paths or tightly scoped directories: frontend files'],
        readyGateBlocked: false,
        readyGateStatus: 'pass',
        readyGateSummary: 'ready gate would pass current hard validation checks',
        contract: {
          allowedFiles: ['frontend files'],
        },
      } as any),
      buildIssueLintReportFromRemoteIssue: async () => {
        throw new Error('remote issue loader should not run for local lint')
      },
    })

    expect(report.readyGateBlocked).toBe(false)
    expect(formatIssueLintOutput(report, true)).toContain('"warnings"')
    expect(formatIssueLintOutput(report)).toContain('readyGate=pass')
  })

  test('builds lint reports from remote issue bodies and preserves hard errors', async () => {
    const report = await executeIssueLintCommand({
      target: {
        kind: 'issue',
        issueNumber: 36,
      },
      repo: 'JamesWuHK/agent-loop',
      pat: 'ghp_test',
    }, {
      loadConfig: (args = {}) => ({
        repo: args.repo!,
        pat: args.pat!,
        concurrency: 1,
        pollIntervalMs: 60_000,
        idlePollIntervalMs: 300_000,
        machineId: 'codex-dev',
      } as any),
      buildIssueLintReportFromMarkdownFile: () => {
        throw new Error('local file loader should not run for remote lint')
      },
      buildIssueLintReportFromRemoteIssue: async ({ issueNumber, config }) => ({
        source: {
          kind: 'issue',
          repo: config.repo,
          issueNumber,
        },
        valid: false,
        score: 75,
        errors: ['missing ## RED 测试 / RED Tests'],
        warnings: ['AllowedFiles should use exact paths or tightly scoped directories: frontend files'],
        readyGateBlocked: true,
        readyGateStatus: 'blocked',
        readyGateSummary: 'ready gate would still block on hard validation errors',
        contract: {
          allowedFiles: ['frontend files'],
          validation: ['git diff --stat origin/main...HEAD'],
        },
      } as any),
    })

    expect(report.source).toEqual({
      kind: 'issue',
      repo: 'JamesWuHK/agent-loop',
      issueNumber: 36,
    })
    expect(report.readyGateBlocked).toBe(true)
    expect(report.errors).toEqual(['missing ## RED 测试 / RED Tests'])
  })

  test('executes bootstrap gate with repo-aware config and supports json output', async () => {
    const report = await executeBootstrapGateCommand({
      repo: 'JamesWuHK/agent-loop',
    }, {
      readConfigFile: () => ({
        pat: 'ghp_from_config',
      } as any),
      loadRepoLocalConfig: () => ({
        project: {
          profile: 'generic',
        },
      }),
      buildConfig: (args = {}, options = {}) => {
        expect(args).toEqual({
          repo: 'JamesWuHK/agent-loop',
          pat: undefined,
          machineId: 'bootstrap-gate-readonly',
        })
        expect(options.fileConfig).toMatchObject({
          pat: 'ghp_from_config',
          machineId: 'bootstrap-gate-readonly',
        })

        return {
          repo: 'JamesWuHK/agent-loop',
          pat: 'ghp_from_config',
          machineId: 'bootstrap-gate-readonly',
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
          pollIntervalMs: 60_000,
          idlePollIntervalMs: 300_000,
          recovery: {
            heartbeatIntervalMs: 30_000,
            leaseTtlMs: 60_000,
            workerIdleTimeoutMs: 300_000,
            leaseAdoptionBackoffMs: 5_000,
            leaseNoProgressTimeoutMs: 360_000,
          },
          worktreesBase: '/tmp/agent-worktrees',
          project: {
            profile: 'generic',
          },
          agent: {
            primary: 'codex',
            fallback: 'claude',
            claudePath: 'claude',
            codexPath: 'codex',
            codexReasoningEffort: 'high',
            timeoutMs: 300_000,
          },
          git: {
            defaultBranch: 'main',
            authorName: 'agent-loop',
            authorEmail: 'agent-loop@example.com',
          },
        } as any
      },
      buildBootstrapGateReportForRepo: async ({ config }) => {
        expect(config.repo).toBe('JamesWuHK/agent-loop')
        expect(config.pat).toBe('ghp_from_config')
        expect(config.machineId).toBe('bootstrap-gate-readonly')

        return {
          version: 'v0.2',
          ready: false,
          blockers: [
            {
              issueNumber: 37,
              state: 'working',
              labels: ['agent:working'],
              title: '[AL-7] repo grounded context',
            },
          ],
          requiredEvidence: [
            {
              code: 'self_bootstrap_suite_green',
              satisfied: false,
              sourceIssueNumber: 69,
              summary: 'awaiting the deterministic self-bootstrap scenario suite tracked by #69',
            },
          ],
          blockingReasons: [
            'issue #37 is not done (state=working, labels=agent:working)',
            'missing required evidence: self_bootstrap_suite_green',
          ],
        }
      },
    })

    expect(report.ready).toBe(false)
    expect(JSON.parse(formatBootstrapGateOutput(report, true))).toMatchObject({
      version: 'v0.2',
      ready: false,
      blockers: [
        {
          issueNumber: 37,
          state: 'working',
        },
      ],
      requiredEvidence: [
        {
          code: 'self_bootstrap_suite_green',
          satisfied: false,
        },
      ],
    })
    expect(formatBootstrapGateOutput(report)).toContain('Bootstrap Gate')
  })

  test('executes bootstrap scenarios with the replay fixture suite and supports json output', async () => {
    const report = await executeBootstrapScenarioCommand({}, {
      evaluateBootstrapScenarioFixtureDirectory: (fixturesDir) => {
        expect(fixturesDir.endsWith(join('fixtures', 'replay'))).toBe(true)

        return {
          suite: 'self-bootstrap-v0.2',
          ok: true,
          failedCases: [],
          cases: [
            {
              name: 'self-bootstrap-happy-path',
              ok: true,
              present: true,
              mismatches: [],
              actual: { claimable: 1, blocked: 0, invalid: 0 },
              expected: { claimable: 1, blocked: 0, invalid: 0 },
            },
          ],
          summary: {
            requiredCases: 4,
            presentCases: 4,
            passedCases: 4,
            failedCases: 0,
          },
        }
      },
    })

    expect(report.ok).toBe(true)
    expect(JSON.parse(formatBootstrapScenarioOutput(report, true))).toMatchObject({
      suite: 'self-bootstrap-v0.2',
      ok: true,
    })
    expect(formatBootstrapScenarioOutput(report)).toContain('Bootstrap Scenarios')
  })

  test('requires an explicit repo for the bootstrap gate command', async () => {
    await expect(executeBootstrapGateCommand({})).rejects.toThrow(
      '--bootstrap-gate requires --repo owner/repo',
    )
  })

  test('executes bootstrap scorecard with repo-aware read-only config and supports json output', async () => {
    const scorecard = await executeBootstrapScorecardCommand({
      repo: 'JamesWuHK/agent-loop',
      pat: 'ghp_test',
    }, {
      readConfigFile: () => ({
        pat: 'ghp_from_config',
      } as any),
      loadRepoLocalConfig: () => ({
        project: {
          profile: 'generic',
        },
      }),
      buildConfig: (args = {}, options = {}) => {
        expect(args).toEqual({
          repo: 'JamesWuHK/agent-loop',
          pat: 'ghp_test',
          machineId: 'bootstrap-scorecard-readonly',
        })
        expect(options.fileConfig).toMatchObject({
          pat: 'ghp_from_config',
          machineId: 'bootstrap-scorecard-readonly',
        })

        return {
          repo: 'JamesWuHK/agent-loop',
          pat: 'ghp_test',
          machineId: 'bootstrap-scorecard-readonly',
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
          pollIntervalMs: 60_000,
          idlePollIntervalMs: 300_000,
          recovery: {
            heartbeatIntervalMs: 30_000,
            leaseTtlMs: 60_000,
            workerIdleTimeoutMs: 300_000,
            leaseAdoptionBackoffMs: 5_000,
            leaseNoProgressTimeoutMs: 360_000,
          },
          worktreesBase: '/tmp/agent-worktrees',
          project: {
            profile: 'generic',
          },
          agent: {
            primary: 'codex',
            fallback: 'claude',
            claudePath: 'claude',
            codexPath: 'codex',
            codexReasoningEffort: 'high',
            timeoutMs: 300_000,
          },
          git: {
            defaultBranch: 'main',
            authorName: 'agent-loop',
            authorEmail: 'agent-loop@example.com',
          },
        }
      },
      buildBootstrapScorecardForRepo: async ({ config }) => {
        expect(config.repo).toBe('JamesWuHK/agent-loop')
        expect(config.pat).toBe('ghp_test')
        expect(config.machineId).toBe('bootstrap-scorecard-readonly')

        return {
          ready: false,
          categoryCounts: {
            contract_failure: 2,
            runtime_failure: 0,
            pr_lifecycle_failure: 1,
            review_failure: 1,
            github_transport_failure: 0,
            release_process_failure: 1,
          },
          topBlockers: [
            {
              category: 'contract_failure',
              issueNumber: null,
              prNumber: null,
              reason: '2 invalid ready issue(s) require executable contracts',
            },
          ],
          auditSummary: {
            managedIssueCount: 8,
            readyIssueCount: 3,
            invalidReadyIssueCount: 2,
            lowScoreIssueCount: 3,
            warningIssueCount: 1,
          },
        }
      },
    })

    expect(scorecard.ready).toBe(false)
    expect(JSON.parse(formatBootstrapScorecardOutput(scorecard, true))).toMatchObject({
      ready: false,
      categoryCounts: {
        contract_failure: 2,
        release_process_failure: 1,
      },
      auditSummary: {
        invalidReadyIssueCount: 2,
      },
    })
    expect(formatBootstrapScorecardOutput(scorecard)).toContain('Bootstrap Scorecard')
  })

  test('requires an explicit repo for the bootstrap scorecard command', async () => {
    await expect(executeBootstrapScorecardCommand({})).rejects.toThrow(
      '--bootstrap-scorecard requires --repo owner/repo',
    )
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
        '--idle-poll-interval', '300000',
      ],
      overrideArgs: ['--restart', '--concurrency', '2'],
    })).toEqual([
      '--repo', 'JamesWuHK/digital-employee',
      '--machine-id', 'codex-dev',
      '--health-port', '9311',
      '--metrics-port', '9091',
      '--poll-interval', '45000',
      '--idle-poll-interval', '300000',
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
          '--idle-poll-interval', '300000',
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
          '--idle-poll-interval', '300000',
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
