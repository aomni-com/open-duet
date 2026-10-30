import { describe, expect, test } from 'bun:test'

import {
  InternalAdminCommandSchema,
  InternalAdminWorkspaceSummarySchema,
  InternalAdminWorkspaceMutationRequestSchema,
  matchesInternalAdminEmail,
} from './index'

describe('internal admin contract', () => {
  test('keeps operational responses typed and rejects unbounded command output shapes', () => {
    expect(
      InternalAdminWorkspaceSummarySchema.parse({
        id: 'workspace_1',
        slug: 'acme',
        name: 'Acme',
        status: 'active',
        servicingStatus: 'paused',
        suspended: false,
        billingUserId: 'user_1',
        billingEmail: 'payer@acme.test',
        paidCreditBalanceMicroUsd: 0,
        monthlyCreditBalanceMicroUsd: 0,
        memberCount: 2,
      }).servicingStatus,
    ).toBe('paused')
    expect(() =>
      InternalAdminCommandSchema.parse({
        command: 'uptime',
        stdout: '',
        stderr: '',
        exitCode: 0,
        durationMs: -1,
        truncated: false,
        auditId: 'audit_1',
      }),
    ).toThrow()
  })

  test('authorizes only exact duet.so and aomni.com domains', () => {
    expect(matchesInternalAdminEmail('owner@duet.so')).toBe(true)
    expect(matchesInternalAdminEmail('OWNER@AOMNI.COM')).toBe(true)
    expect(matchesInternalAdminEmail('owner@vibetm.ai')).toBe(false)
    expect(matchesInternalAdminEmail('outsider@example.com')).toBe(false)
    expect(matchesInternalAdminEmail('spoof@duet.so.example.com')).toBe(false)
    expect(matchesInternalAdminEmail('duet.so')).toBe(false)
    expect(matchesInternalAdminEmail('outsider@example.com@duet.so')).toBe(false)
  })

  test('rejects the retired generic servicing override', () => {
    for (const servicingStatus of ['active', 'paused'] as const) {
      expect(
        InternalAdminWorkspaceMutationRequestSchema.safeParse({
          operation: 'servicing',
          servicingStatus,
          reason: 'manual servicing override',
        }).success,
      ).toBe(false)
    }
    expect(
      InternalAdminWorkspaceMutationRequestSchema.parse({
        operation: 'ban',
        reason: 'fraud investigation',
      }),
    ).toEqual({ operation: 'ban', reason: 'fraud investigation' })
    expect(
      InternalAdminWorkspaceMutationRequestSchema.parse({
        operation: 'dispute_clear',
        reason: 'evidence reviewed',
      }),
    ).toEqual({ operation: 'dispute_clear', reason: 'evidence reviewed' })
  })
})
