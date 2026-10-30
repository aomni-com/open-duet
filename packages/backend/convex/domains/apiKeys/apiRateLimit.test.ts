import { describe, expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import {
  AUTHENTICATED_API_RATE_LIMIT,
  AUTHENTICATED_API_RATE_LIMIT_WINDOW_MS,
} from '@repo/contract'

import schema from '../../schema'
import { authenticatedApiRateLimitKey, consumeAuthenticatedApiRateLimit } from './apiRateLimit'

describe('authenticated API rate-limit principal', () => {
  test('uses only the widened counters after rollout', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
    await t.run(async ctx => {
      const key = 'api:credential:rollout'
      const windowStart = 20 * AUTHENTICATED_API_RATE_LIMIT_WINDOW_MS
      for (let shard = 0; shard < 8; shard += 1) {
        await ctx.db.insert('rateLimits', {
          key: shard === 0 ? key : `${key}#${shard}`,
          count: Math.ceil(AUTHENTICATED_API_RATE_LIMIT / 8),
          windowStart,
          updatedAt: windowStart,
        })
      }
      const outcome = await consumeAuthenticatedApiRateLimit(ctx, {
        credentialKind: 'user',
        credentialId: 'rollout',
        userId: 'owner',
        now: windowStart + 1,
      })
      expect(outcome).toMatchObject({ ok: true })
      expect(
        await consumeAuthenticatedApiRateLimit(ctx, {
          credentialKind: 'user',
          credentialId: 'rollout',
          userId: 'owner',
          now: windowStart + AUTHENTICATED_API_RATE_LIMIT_WINDOW_MS,
        }),
      ).toMatchObject({ ok: true })
    })
  })

  test('uses the user for browser sessions and impersonation', () => {
    expect(
      authenticatedApiRateLimitKey({
        credentialKind: 'browser_session',
        credentialId: 'browser-1',
        userId: 'user-1',
      }),
    ).toBe('api:user:user-1')
    expect(
      authenticatedApiRateLimitKey({
        credentialKind: 'impersonation',
        credentialId: 'impersonation-1',
        userId: 'user-1',
      }),
    ).toBe('api:user:user-1')
    expect(
      authenticatedApiRateLimitKey({
        credentialKind: 'browser_session',
        credentialId: 'browser-2',
        userId: 'user-2',
      }),
    ).toBe('api:user:user-2')
  })

  test('uses stable credential identity for every non-browser credential', () => {
    for (const credentialKind of ['user', 'oauth', 'app'] as const) {
      expect(
        authenticatedApiRateLimitKey({
          credentialKind,
          credentialId: 'credential-1',
          userId: 'user-1',
        }),
      ).toBe('api:credential:credential-1')
      expect(
        authenticatedApiRateLimitKey({
          credentialKind,
          credentialId: 'credential-2',
          userId: 'user-1',
        }),
      ).toBe('api:credential:credential-2')
    }
  })

  test('exempts the workspace VM credential', () => {
    expect(
      authenticatedApiRateLimitKey({
        credentialKind: 'system_vm',
        credentialId: 'vm-credential',
        userId: 'vm-user',
      }),
    ).toBeNull()
  })

  test('shares and separates durable buckets by the projected principal', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const browser = await consumeAuthenticatedApiRateLimit(ctx, {
        credentialKind: 'browser_session',
        credentialId: 'browser-1',
        userId: 'user-1',
        now: 1_200_000,
      })
      const impersonation = await consumeAuthenticatedApiRateLimit(ctx, {
        credentialKind: 'impersonation',
        credentialId: 'impersonation-1',
        userId: 'user-1',
        now: 1_200_000,
      })
      const otherUser = await consumeAuthenticatedApiRateLimit(ctx, {
        credentialKind: 'browser_session',
        credentialId: 'browser-2',
        userId: 'user-2',
        now: 1_200_000,
      })
      const firstCredential = await consumeAuthenticatedApiRateLimit(ctx, {
        credentialKind: 'oauth',
        credentialId: 'credential-1',
        userId: 'user-1',
        now: 1_200_000,
      })
      const secondCredential = await consumeAuthenticatedApiRateLimit(ctx, {
        credentialKind: 'app',
        credentialId: 'credential-2',
        userId: 'user-1',
        now: 1_200_000,
      })
      await consumeAuthenticatedApiRateLimit(ctx, {
        credentialKind: 'system_vm',
        credentialId: 'vm-credential',
        userId: 'vm-user',
        now: 1_200_000,
      })

      for (const outcome of [
        browser,
        impersonation,
        otherUser,
        firstCredential,
        secondCredential,
      ]) {
        expect(outcome).toMatchObject({ ok: true })
      }
      // Which bucket a request lands in is the whole claim, and a large budget
      // is split over several documents (`#<shard>`), so the principal — not the
      // row count — is what the durable state has to agree on. The VM
      // credential is exempt and writes nothing at all.
      const buckets = (await ctx.db.query('rateLimits').take(20)).map(row => row.key.split('#')[0])
      expect(new Set(buckets)).toEqual(
        new Set([
          'api:user:user-1',
          'api:user:user-2',
          'api:credential:credential-1',
          'api:credential:credential-2',
        ]),
      )
    })
  })
})
