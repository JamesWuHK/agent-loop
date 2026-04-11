import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildWakeRequestFromCli,
  buildManagedRestartArgs,
  buildManagedRuntimeLaunchArgs,
  cleanupManagedRuntimeRecord,
  executeAuditIssuesCommand,
  executeIssueLintCommand,
  executeIssueSimulationCommand,
  executeIssueRewriteCommand,
  executeIssueSplitCommand,
  executeWakeCommand,
  executeWakeRequest,
  formatAuditIssuesOutput,
  formatIssueLintOutput,
  formatIssueSimulationOutput,
  formatManagedRuntimeLog,
  readManagedRuntimeLog,
  resolveAuditIssuesInput,
  resolveIssueLintTarget,
  resolveIssueRewritePath,
  resolveIssueSimulationTarget,
  resolveIssueSplitInput,
  resolveWakeCommand,
  startManagedRuntime,
  reconcileManagedRuntime,
  formatLaunchdStatus,
  formatRuntimeListing,
  restartManagedRuntime,
  shouldFailAuditIssuesCommand,
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

  test('resolves audit-issues selections and validates dependent flags', () => {
    expect(resolveAuditIssuesInput({
      'audit-issues': true,
    })).toEqual({
      issueNumbers: [],
      includeSimulation: false,
    })

    expect(resolveAuditIssuesInput({
      'audit-issues': true,
      issue: ['50', '51', '50'],
      simulate: true,
    })).toEqual({
      issueNumbers: [50, 51],
      includeSimulation: true,
    })

    expect(() => resolveAuditIssuesInput({
      issue: ['50'],
    })).toThrow('--issue requires --audit-issues')

    expect(() => resolveAuditIssuesInput({
      simulate: true,
    })).toThrow('--simulate requires --audit-issues')
  })

  test('executes audit-issues against default open managed issues without simulation', async () => {
    const result = await executeAuditIssuesCommand({
      repo: 'JamesWuHK/agent-loop',
      pat: 'ghp_test',
      repoRoot: '/tmp/repo-root',
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
            timeoutMs: 300_000,
          },
          git: {
            defaultBranch: 'main',
            authorName: 'agent-loop',
            authorEmail: 'agent-loop@example.com',
          },
        }
      },
      loadIssuesForAudit: async ({ config, issueNumbers }) => {
        expect(config.repo).toBe('JamesWuHK/agent-loop')
        expect(issueNumbers).toEqual([])

        return [{
          number: 50,
          title: '[AL-11] 增加 repo issue audit report CLI 与 JSON 输出',
          body: 'body',
          state: 'ready',
          labels: ['agent:ready'],
          isClaimable: true,
          updatedAt: '2026-04-12T10:00:00.000Z',
          dependencyIssueNumbers: [],
          hasDependencyMetadata: true,
          dependencyParseError: false,
          claimBlockedBy: [],
          hasExecutableContract: true,
          contractValidationErrors: [],
          assignee: null,
        }]
      },
      auditIssues: async ({ issues, repo, includeSimulation, repoRoot, runPlanner }) => {
        expect(repo).toBe('JamesWuHK/agent-loop')
        expect(includeSimulation).toBeUndefined()
        expect(repoRoot).toBe('/tmp/repo-root')
        expect(runPlanner).toBeUndefined()
        expect(issues).toHaveLength(1)

        return {
          summary: {
            auditedIssueCount: 1,
            invalidIssueCount: 0,
            invalidReadyIssueCount: 0,
            lowScoreIssueCount: 0,
            warningIssueCount: 0,
          },
          issues: [],
        }
      },
      runConfiguredAgent: async () => {
        throw new Error('audit without --simulate should not invoke the agent')
      },
    })

    expect(result).toEqual({
      report: {
        summary: {
          auditedIssueCount: 1,
          invalidIssueCount: 0,
          invalidReadyIssueCount: 0,
          lowScoreIssueCount: 0,
          warningIssueCount: 0,
        },
        issues: [],
      },
      explicitIssueNumbers: [],
    })
    expect(shouldFailAuditIssuesCommand(result)).toBe(false)
  })

  test('executes audit-issues for an explicit issue set with simulation and exposes failure exit semantics', async () => {
    const result = await executeAuditIssuesCommand({
      issueNumbers: [50, 53],
      includeSimulation: true,
      repo: 'JamesWuHK/agent-loop',
      pat: 'ghp_test',
      repoRoot: '/tmp/repo-root',
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
            timeoutMs: 300_000,
          },
          git: {
            defaultBranch: 'main',
            authorName: 'agent-loop',
            authorEmail: 'agent-loop@example.com',
          },
        }
      },
      loadIssuesForAudit: async ({ config, issueNumbers }) => {
        expect(config.repo).toBe('JamesWuHK/agent-loop')
        expect(issueNumbers).toEqual([50, 53])

        return [{
          number: 53,
          title: '[AL-13] 增加 issue repair CLI 并消费 lint / simulate findings',
          body: 'body',
          state: 'ready',
          labels: ['agent:ready'],
          isClaimable: false,
          updatedAt: '2026-04-12T10:01:00.000Z',
          dependencyIssueNumbers: [],
          hasDependencyMetadata: true,
          dependencyParseError: false,
          claimBlockedBy: [50],
          hasExecutableContract: false,
          contractValidationErrors: ['missing ## RED 测试 / RED Tests'],
          assignee: null,
        }]
      },
      auditIssues: async ({ issues, repo, includeSimulation, repoRoot, runPlanner }) => {
        expect(repo).toBe('JamesWuHK/agent-loop')
        expect(includeSimulation).toBe(true)
        expect(repoRoot).toBe('/tmp/repo-root')
        expect(issues).toHaveLength(1)

        const response = await runPlanner!({
          prompt: 'audit simulate prompt',
          repoRoot: '/tmp/repo-root',
        })

        expect(response.responseText).toBe('1. Simulate the issue audit plan')

        return {
          summary: {
            auditedIssueCount: 1,
            invalidIssueCount: 1,
            invalidReadyIssueCount: 1,
            lowScoreIssueCount: 1,
            warningIssueCount: 1,
          },
          issues: [
            {
              number: 53,
              title: '[AL-13] 增加 issue repair CLI 并消费 lint / simulate findings',
              state: 'ready',
              labels: ['agent:ready'],
              isClaimable: false,
              hasExecutableContract: false,
              claimBlockedBy: [50],
              contractValidationErrors: ['missing ## RED 测试 / RED Tests'],
              qualityScore: 70,
              contractWarnings: ['AllowedFiles should use exact paths or tightly scoped directories: frontend files'],
              contract: {
                source: {
                  kind: 'issue',
                  issueNumber: 53,
                  repo: 'JamesWuHK/agent-loop',
                },
                valid: false,
                readyGateBlocked: true,
                readyGateStatus: 'blocked',
                readyGateSummary: 'ready gate would still block on hard validation errors',
                score: 70,
                errors: ['missing ## RED 测试 / RED Tests'],
                warnings: ['AllowedFiles should use exact paths or tightly scoped directories: frontend files'],
                contract: {
                  allowedFiles: ['frontend files'],
                },
              } as any,
              simulation: {
                valid: false,
                failures: ['planning output does not contain commit-shaped subtasks'],
                plannerOutput: response.responseText,
                checks: {
                  commitShapedPlan: false,
                  scopedAllowedFiles: true,
                  specificValidation: true,
                },
              },
            },
          ],
        }
      },
      runConfiguredAgent: async (options) => {
        expect(options.prompt).toBe('audit simulate prompt')
        expect(options.worktreePath).toBe('/tmp/repo-root')
        expect(options.allowWrites).toBe(false)
        expect(options.config.repo).toBe('JamesWuHK/agent-loop')

        return {
          ok: true,
          exitCode: 0,
          stdout: '',
          stderr: '',
          responseText: '1. Simulate the issue audit plan',
          usedAgent: 'codex',
          usedFallback: false,
        }
      },
    })

    expect(result.explicitIssueNumbers).toEqual([50, 53])
    expect(shouldFailAuditIssuesCommand(result)).toBe(true)
    expect(JSON.parse(formatAuditIssuesOutput(result.report, true))).toMatchObject({
      summary: {
        invalidIssueCount: 1,
      },
      issues: [
        {
          number: 53,
          state: 'ready',
        },
      ],
    })
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

  test('resolves rewrite file paths and rejects empty values', () => {
    expect(resolveIssueRewritePath({
      'rewrite-file': 'docs/issues/draft.md',
    })).toBe('docs/issues/draft.md')

    expect(resolveIssueRewritePath({})).toBeNull()

    expect(() => resolveIssueRewritePath({
      'rewrite-file': '   ',
    })).toThrow('--rewrite-file must be a non-empty path')
  })

  test('resolves simulate targets and rejects conflicting selectors', () => {
    expect(resolveIssueSimulationTarget({
      'simulate-file': 'docs/issues/simulate.md',
    })).toEqual({
      kind: 'file',
      path: 'docs/issues/simulate.md',
    })

    expect(resolveIssueSimulationTarget({
      'simulate-issue': '40',
    })).toEqual({
      kind: 'issue',
      issueNumber: 40,
    })

    expect(() => resolveIssueSimulationTarget({
      'simulate-issue': '40',
      'simulate-file': 'docs/issues/simulate.md',
    })).toThrow('Only one of --simulate-issue or --simulate-file can be used at a time')
  })

  test('executes local issue simulation through the read-only agent runner', async () => {
    const result = await executeIssueSimulationCommand({
      target: {
        kind: 'file',
        path: 'docs/issues/simulate.md',
      },
      repo: 'JamesWuHK/agent-loop',
      pat: 'ghp_test',
      repoRoot: '/tmp/repo-root',
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
            timeoutMs: 300_000,
          },
          git: {
            defaultBranch: 'main',
            authorName: 'agent-loop',
            authorEmail: 'agent-loop@example.com',
          },
        }
      },
      readIssueDraftFile: (path) => {
        expect(path).toBe('docs/issues/simulate.md')
        return [
          '# [AL-10] Simulate local draft',
          '',
          '## 用户故事',
          '作为维护者，我希望本地 draft 也能直接 simulate。',
        ].join('\n')
      },
      fetchRemoteIssueDocument: async () => {
        throw new Error('should not fetch a remote issue for local simulation')
      },
      simulateIssueExecutability: async ({ issueTitle, issueBody, repoRoot, runPlanner }) => {
        expect(issueTitle).toBe('[AL-10] Simulate local draft')
        expect(issueBody).toBe('## 用户故事\n作为维护者，我希望本地 draft 也能直接 simulate。')
        expect(repoRoot).toBe('/tmp/repo-root')

        const response = await runPlanner({
          prompt: 'simulate prompt',
          repoRoot: '/tmp/repo-root',
        })

        expect(response.responseText).toBe('1. Add local simulate coverage')

        return {
          valid: true,
          failures: [],
          plannerOutput: response.responseText,
          checks: {
            commitShapedPlan: true,
            scopedAllowedFiles: true,
            specificValidation: true,
          },
        }
      },
      runConfiguredAgent: async (options) => {
        expect(options.prompt).toBe('simulate prompt')
        expect(options.worktreePath).toBe('/tmp/repo-root')
        expect(options.allowWrites).toBe(false)
        expect(options.config.repo).toBe('JamesWuHK/agent-loop')

        return {
          ok: true,
          exitCode: 0,
          stdout: '',
          stderr: '',
          responseText: '1. Add local simulate coverage',
          usedAgent: 'codex',
          usedFallback: false,
        }
      },
    })

    expect(result).toEqual({
      source: {
        kind: 'file',
        path: 'docs/issues/simulate.md',
        title: '[AL-10] Simulate local draft',
      },
      result: {
        valid: true,
        failures: [],
        plannerOutput: '1. Add local simulate coverage',
        checks: {
          commitShapedPlan: true,
          scopedAllowedFiles: true,
          specificValidation: true,
        },
      },
    })
    expect(JSON.parse(formatIssueSimulationOutput(result, true))).toMatchObject({
      source: {
        kind: 'file',
        path: 'docs/issues/simulate.md',
      },
      result: {
        valid: true,
      },
    })
  })

  test('executes remote issue simulation with repo-aware config', async () => {
    const result = await executeIssueSimulationCommand({
      target: {
        kind: 'issue',
        issueNumber: 40,
      },
      repo: 'JamesWuHK/agent-loop',
      pat: 'ghp_test',
      repoRoot: '/tmp/repo-root',
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
            timeoutMs: 300_000,
          },
          git: {
            defaultBranch: 'main',
            authorName: 'agent-loop',
            authorEmail: 'agent-loop@example.com',
          },
        }
      },
      readIssueDraftFile: () => {
        throw new Error('should not read a local file for remote simulation')
      },
      fetchRemoteIssueDocument: async ({ issueNumber, config }) => {
        expect(issueNumber).toBe(40)
        expect(config.repo).toBe('JamesWuHK/agent-loop')

        return {
          number: 40,
          title: '[AL-10] Simulate remote issue',
          body: '## 用户故事\n作为维护者，我希望远端 issue 也能 simulate。',
          url: 'https://github.com/JamesWuHK/agent-loop/issues/40',
        }
      },
      simulateIssueExecutability: async ({ issueTitle, issueBody, repoRoot, runPlanner }) => {
        expect(issueTitle).toBe('[AL-10] Simulate remote issue')
        expect(issueBody).toBe('## 用户故事\n作为维护者，我希望远端 issue 也能 simulate。')
        expect(repoRoot).toBe('/tmp/repo-root')

        const response = await runPlanner({
          prompt: 'remote simulate prompt',
          repoRoot: '/tmp/repo-root',
        })

        expect(response.responseText).toBe('1. Implement remote simulate path')

        return {
          valid: false,
          failures: ['planning output does not contain commit-shaped subtasks'],
          plannerOutput: response.responseText,
          checks: {
            commitShapedPlan: false,
            scopedAllowedFiles: true,
            specificValidation: true,
          },
        }
      },
      runConfiguredAgent: async (options) => {
        expect(options.prompt).toBe('remote simulate prompt')
        expect(options.worktreePath).toBe('/tmp/repo-root')
        expect(options.allowWrites).toBe(false)
        expect(options.config.repo).toBe('JamesWuHK/agent-loop')

        return {
          ok: true,
          exitCode: 0,
          stdout: '',
          stderr: '',
          responseText: '1. Implement remote simulate path',
          usedAgent: 'codex',
          usedFallback: false,
        }
      },
    })

    expect(result).toEqual({
      source: {
        kind: 'issue',
        issueNumber: 40,
        repo: 'JamesWuHK/agent-loop',
        title: '[AL-10] Simulate remote issue',
      },
      result: {
        valid: false,
        failures: ['planning output does not contain commit-shaped subtasks'],
        plannerOutput: '1. Implement remote simulate path',
        checks: {
          commitShapedPlan: false,
          scopedAllowedFiles: true,
          specificValidation: true,
        },
      },
    })
    expect(formatIssueSimulationOutput(result)).toContain('source=issue:JamesWuHK/agent-loop#40')
  })

  test('executes local issue rewrite through the read-only agent runner', async () => {
    const result = await executeIssueRewriteCommand({
      path: 'docs/issues/draft.md',
      repo: 'JamesWuHK/agent-loop',
      pat: 'ghp_test',
      repoRoot: '/tmp/repo-root',
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
            timeoutMs: 300_000,
          },
          git: {
            defaultBranch: 'main',
            authorName: 'agent-loop',
            authorEmail: 'agent-loop@example.com',
          },
        }
      },
      readIssueDraftFile: (path) => {
        expect(path).toBe('docs/issues/draft.md')
        return '修复 ready gate 的 validation path 提示'
      },
      rewriteIssueDraft: async ({ issueText, repoRoot }, { runAgent }) => {
        expect(issueText).toBe('修复 ready gate 的 validation path 提示')
        expect(repoRoot).toBe('/tmp/repo-root')

        const response = await runAgent({
          prompt: 'rewrite prompt',
          repoRoot,
        })

        expect(response.responseText).toBe('## 用户故事\n\nrewritten markdown')

        return {
          markdown: response.responseText,
          validation: {
            source: {
              kind: 'file',
              path: 'stdout',
            },
            valid: true,
            readyGateBlocked: false,
            readyGateStatus: 'pass',
            readyGateSummary: 'ready gate would pass hard validation checks',
            score: 100,
            errors: [],
            warnings: [],
            contract: {
              allowedFiles: ['apps/agent-daemon/src/ready-gate.ts'],
            },
          },
          authoringContext: {
            candidateValidationCommands: ['bun test apps/agent-daemon/src/ready-gate.test.ts'],
            candidateAllowedFiles: ['apps/agent-daemon/src/ready-gate.ts'],
            candidateForbiddenFiles: ['package.json'],
          },
        }
      },
      runConfiguredAgent: async (options) => {
        expect(options.prompt).toBe('rewrite prompt')
        expect(options.worktreePath).toBe('/tmp/repo-root')
        expect(options.allowWrites).toBe(false)
        expect(options.config.repo).toBe('JamesWuHK/agent-loop')

        return {
          ok: true,
          exitCode: 0,
          stdout: '',
          stderr: '',
          responseText: '## 用户故事\n\nrewritten markdown',
          usedAgent: 'codex',
          usedFallback: false,
        }
      },
    })

    expect(result.markdown).toBe('## 用户故事\n\nrewritten markdown')
    expect(result.validation.valid).toBe(true)
  })

  test('resolves split inputs and requires a starting issue number', () => {
    expect(resolveIssueSplitInput({
      'split-file': 'docs/issues/epic.md',
      'split-start-number': '41',
    })).toEqual({
      path: 'docs/issues/epic.md',
      startingIssueNumber: 41,
    })

    expect(resolveIssueSplitInput({})).toBeNull()

    expect(() => resolveIssueSplitInput({
      'split-file': 'docs/issues/epic.md',
    })).toThrow('--split-file requires --split-start-number')

    expect(() => resolveIssueSplitInput({
      'split-start-number': '41',
    })).toThrow('--split-start-number requires --split-file')
  })

  test('executes local issue split through the read-only agent runner', async () => {
    const result = await executeIssueSplitCommand({
      path: 'docs/issues/epic.md',
      startingIssueNumber: 41,
      repo: 'JamesWuHK/agent-loop',
      pat: 'ghp_test',
      repoRoot: '/tmp/repo-root',
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
            timeoutMs: 300_000,
          },
          git: {
            defaultBranch: 'main',
            authorName: 'agent-loop',
            authorEmail: 'agent-loop@example.com',
          },
        }
      },
      readIssueDraftFile: (path) => {
        expect(path).toBe('docs/issues/epic.md')
        return `# [AL-EPIC] 改进 issue authoring

需要补 lint、rewrite、split 三块能力`
      },
      splitTrackingIssue: async ({ title, body, repoRoot, issueNumberAllocator }, { runAgent }) => {
        expect(title).toBe('[AL-EPIC] 改进 issue authoring')
        expect(body).toContain('需要补 lint')
        expect(repoRoot).toBe('/tmp/repo-root')
        expect(issueNumberAllocator()).toBe(41)
        expect(issueNumberAllocator()).toBe(42)

        const response = await runAgent({
          prompt: 'split prompt',
          repoRoot,
        })

        expect(response.responseText).toBe('1. [AL-X] 引入 lint\n2. [AL-Y] 增加 rewrite CLI')

        return {
          parentSummary: 'summary',
          children: [
            {
              issueNumber: 41,
              title: '[AL-X] 引入 lint',
              body: 'child body 41',
              validation: {
                source: { kind: 'file', path: 'child-41.md' },
                valid: true,
                readyGateBlocked: false,
                readyGateStatus: 'pass',
                readyGateSummary: 'ready gate would pass hard validation checks',
                score: 100,
                errors: [],
                warnings: [],
                contract: { allowedFiles: ['apps/agent-daemon/src/audit-issue-contracts.ts'] },
              },
              authoringContext: {
                candidateValidationCommands: ['bun run typecheck'],
                candidateAllowedFiles: ['apps/agent-daemon/src/audit-issue-contracts.ts'],
                candidateForbiddenFiles: ['package.json'],
              },
            },
          ],
        }
      },
      runConfiguredAgent: async (options) => {
        expect(options.prompt).toBe('split prompt')
        expect(options.worktreePath).toBe('/tmp/repo-root')
        expect(options.allowWrites).toBe(false)
        expect(options.config.repo).toBe('JamesWuHK/agent-loop')

        return {
          ok: true,
          exitCode: 0,
          stdout: '',
          stderr: '',
          responseText: '1. [AL-X] 引入 lint\n2. [AL-Y] 增加 rewrite CLI',
          usedAgent: 'codex',
          usedFallback: false,
        }
      },
    })

    expect(result.parentSummary).toBe('summary')
    expect(result.children).toHaveLength(1)
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
