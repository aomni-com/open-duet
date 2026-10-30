import { describe, expect, test } from 'bun:test'

import { hashApiKey } from '@repo/contract'

import type { ApiRouteRuntime } from '../shared'
import {
  consumePreAuthRateLimit,
  emailIdentity,
  networkIdentity,
  preAuthRateLimitIdentityHash,
} from './pre-auth-rate-limit'

describe('pre-auth rate-limit identity', () => {
  test('prefers the closest trusted proxy header and never keeps a port or list', () => {
    expect(
      networkIdentity(
        requestWith({
          'cf-connecting-ip': '203.0.113.17',
          'x-forwarded-for': '198.51.100.9, 203.0.113.17',
          'x-real-ip': '192.0.2.4',
        }),
        true,
      ),
    ).toEqual({ kind: 'network', value: '203.0.113.17' })
    expect(
      networkIdentity(requestWith({ 'x-forwarded-for': ' 198.51.100.9 , 203.0.113.17' }), true),
    ).toEqual({ kind: 'network', value: '198.51.100.9' })
    expect(networkIdentity(requestWith({ 'x-real-ip': '192.0.2.4' }), true)).toEqual({
      kind: 'network',
      value: '192.0.2.4',
    })
  })

  test('degrades to one shared bucket when the network cannot be identified', async () => {
    const untrusted = networkIdentity(requestWith({ 'cf-connecting-ip': '203.0.113.17' }), false)
    expect(untrusted).toEqual({ kind: 'network', value: 'global' })
    expect(await preAuthRateLimitIdentityHash(untrusted)).toBe(await hashApiKey('net:global'))

    const headerless = networkIdentity(requestWith({}), true)
    expect(headerless).toEqual({ kind: 'network', value: 'unknown' })
    expect(await preAuthRateLimitIdentityHash(headerless)).toBe(await hashApiKey('net:unknown'))
  })

  test('folds an address to one bucket however the sender capitalized it', async () => {
    expect(await preAuthRateLimitIdentityHash(emailIdentity('A@B.com'))).toBe(
      await preAuthRateLimitIdentityHash(emailIdentity('a@b.com')),
    )
    expect(await preAuthRateLimitIdentityHash(emailIdentity('  Casey@Example.COM  '))).toBe(
      await preAuthRateLimitIdentityHash(emailIdentity('casey@example.com')),
    )
    expect(await preAuthRateLimitIdentityHash(emailIdentity('casey@example.com'))).not.toBe(
      await preAuthRateLimitIdentityHash(emailIdentity('dana@example.com')),
    )
  })

  test('keeps the two identity spaces apart even when they stringify the same', async () => {
    for (const value of ['global', 'unknown', '203.0.113.17']) {
      expect(await preAuthRateLimitIdentityHash({ kind: 'network', value }), value).not.toBe(
        await preAuthRateLimitIdentityHash({ kind: 'email', value }),
      )
    }
  })

  test('hashes the identity before it leaves the process', async () => {
    const { runtime, mutations } = convexFixture()
    expect(
      await consumePreAuthRateLimit(runtime, {
        endpoint: 'auth_email_start',
        identity: emailIdentity('Casey@Example.com'),
        limit: 3,
        windowMs: 3_600_000,
      }),
    ).toBeNull()

    expect(mutations).toEqual([
      {
        internalKey: 'test-internal-key',
        identityHash: await hashApiKey('email:casey@example.com'),
        endpoint: 'auth_email_start',
        limit: 3,
        windowMs: 3_600_000,
        now: 10_000,
      },
    ])
    expect(JSON.stringify(mutations)).not.toContain('casey@example.com')
  })

  test('forwards the requested window and answers a refusal with 429 and retry-after', async () => {
    const { runtime, mutations } = convexFixture({ limited: true })
    const response = await consumePreAuthRateLimit(runtime, {
      endpoint: 'auth_email_verify',
      identity: networkIdentity(requestWith({ 'cf-connecting-ip': '203.0.113.17' }), true),
      limit: 10,
      windowMs: 123_456,
    })

    expect(mutations[0]).toMatchObject({ windowMs: 123_456, endpoint: 'auth_email_verify' })
    expect(response?.status).toBe(429)
    expect(response?.headers.get('retry-after')).toBe('60')
    expect(await response?.json()).toEqual({ error: 'rate_limited', retryAfterSeconds: 60 })
  })
})

function requestWith(headers: Record<string, string>): Request {
  return new Request('https://api-staging.duet.so/v1/auth/email/start', { headers })
}

function convexFixture(options: { limited?: boolean } = {}): {
  runtime: ApiRouteRuntime
  mutations: Array<Record<string, unknown>>
} {
  const mutations: Array<Record<string, unknown>> = []
  const runtime = {
    internalKey: 'test-internal-key',
    now: () => 10_000,
    convex: {
      mutation: async (_reference: unknown, args: Record<string, unknown>) => {
        mutations.push(args)
        return options.limited === true
          ? { ok: false, retryAfterSeconds: 60 }
          : { ok: true, remaining: 2, resetAt: 70_000 }
      },
    },
  } as unknown as ApiRouteRuntime
  return { runtime, mutations }
}
