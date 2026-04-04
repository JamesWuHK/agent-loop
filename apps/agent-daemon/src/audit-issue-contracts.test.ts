import { describe, expect, test } from 'bun:test'
import { formatAuditLine, formatInvalidReadySection } from './audit-issue-contracts'

describe('audit-issue-contracts', () => {
  test('formats claimability, blockers, and contract errors on one line', () => {
    expect(
      formatAuditLine({
        number: 51,
        title: '[CI-A1] 固定登录相关 smoke tests',
        state: 'ready',
        isClaimable: false,
        hasExecutableContract: false,
        claimBlockedBy: [49, 50],
        contractValidationErrors: ['missing ## RED 测试 / RED Tests'],
      }),
    ).toBe(
      '#51 state=ready claimable=false contract=false blockedBy=49,50 errors=missing ## RED 测试 / RED Tests',
    )
  })

  test('renders a dedicated section for invalid ready issues', () => {
    const section = formatInvalidReadySection([
      {
        number: 52,
        title: '[CI-A2] Sprint A 发布前最小检查清单',
        state: 'ready',
        isClaimable: false,
        hasExecutableContract: false,
        claimBlockedBy: [],
        contractValidationErrors: [
          'missing ### Dependencies JSON block',
          'missing executable scope contract (AllowedFiles/ForbiddenFiles/MustPreserve/OutOfScope/RequiredSemantics)',
        ],
      },
    ])

    expect(section).toContain('invalid ready issues:')
    expect(section).toContain('#52 [CI-A2] Sprint A 发布前最小检查清单')
    expect(section).toContain('- missing ### Dependencies JSON block')
  })
})
