import { describe, expect, test } from 'bun:test'

import { PRE_AUTH_RATE_LIMIT_ENDPOINTS } from '@repo/contract'

import {
  browserSessionMintRateLimitKey,
  preAuthRateLimitKey,
  modelGatewayRateLimitKey,
  shareEmailRateLimitKey,
} from '../convex/domains/shared/rateLimits'

describe('shared rate-limit key grammar', () => {
  test('namespaces every rail without exposing a device IP', () => {
    const rawIp = '203.0.113.17'
    const hashedIp = '7a'.repeat(32)
    const keys = [
      preAuthRateLimitKey('device_code', hashedIp),
      modelGatewayRateLimitKey('workspace-1', 'generation'),
      browserSessionMintRateLimitKey('user-1'),
      shareEmailRateLimitKey('user-1'),
    ]

    expect(keys).toEqual([
      `preauth:device_code:${hashedIp}`,
      'mgw:workspace-1:generation',
      'bsmint:user-1',
      'shareemail:user-1',
    ])
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.join('\n')).not.toContain(rawIp)
  })

  test('pre-auth endpoint changes select a different bucket for the same hashed IP', () => {
    const hashedIp = '7a'.repeat(32)
    const keys = PRE_AUTH_RATE_LIMIT_ENDPOINTS.map(endpoint =>
      preAuthRateLimitKey(endpoint, hashedIp),
    )
    expect(new Set(keys).size).toBe(PRE_AUTH_RATE_LIMIT_ENDPOINTS.length)
    expect(keys).toContain(`preauth:auth_email_start:${hashedIp}`)
    expect(keys).toContain(`preauth:auth_email_verify:${hashedIp}`)
  })

  test('rejects an unhashed device identity before it can enter a stored key', () => {
    expect(() => preAuthRateLimitKey('device_code', '203.0.113.17')).toThrow(
      'Pre-auth rate-limit identity must be a SHA-256 hex digest',
    )
  })

  // The Convex mutation takes the endpoint as a bare string, so this is the only
  // guard standing between a caller-chosen name and a stored bucket.
  test('rejects an endpoint outside the contract vocabulary', () => {
    const hashedIp = '7a'.repeat(32)
    for (const endpoint of ['', 'auth_email', 'AUTH_EMAIL_START', 'toString']) {
      expect(() => preAuthRateLimitKey(endpoint, hashedIp), endpoint).toThrow(
        `Unknown pre-auth rate-limit endpoint: ${endpoint}`,
      )
    }
  })
})
