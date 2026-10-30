import { describe, expect, test } from 'bun:test'

import {
  MAX_AUDIT_PROVENANCE_JSON_BYTES,
  assertAuditProvenanceBound,
  projectAuditProperties,
  shouldEmitAuditAnalytics,
} from './model'

describe('audit analytics policy', () => {
  test('rejects oversized or non-finite provenance at the insertion owner', () => {
    expect(() => assertAuditProvenanceBound({ source: 'api' })).not.toThrow()
    expect(() =>
      assertAuditProvenanceBound({ source: 'x'.repeat(MAX_AUDIT_PROVENANCE_JSON_BYTES) }),
    ).toThrow('Audit provenance exceeds')
    expect(() => assertAuditProvenanceBound({ confidence: Number.NaN })).toThrow('finite JSON')
  })

  test('projects explicit scalar fields, array counts, and no device user code', () => {
    expect(
      projectAuditProperties({
        source: 'device_approval',
        userCode: 'SECRET-CODE',
        scopes: ['ws:acme:files:read', 'ws:acme:files:write'],
        candidates: [{ path: 'one' }, { path: 'two' }, { path: 'three' }],
        nestedUnknown: { secret: true },
      }),
    ).toEqual({
      source: 'device_approval',
      scopeCount: 2,
      candidateCount: 3,
    })
  })

  test('excludes internal credential and impersonation audit events', () => {
    expect(
      (
        [
          'api_key.impersonation_issued',
          'api_key.vm_model_key_minted',
          'api_key.vm_model_key_rotated',
          'api_key.vm_model_key_revoked',
          'api_key.app_key_minted',
          'api_key.app_key_rotated',
          'api_key.app_key_revoked',
        ] as const
      ).every(event => !shouldEmitAuditAnalytics(event)),
    ).toBeTrue()
    expect(shouldEmitAuditAnalytics('api_key.browser_session_issued')).toBeTrue()
  })
})
