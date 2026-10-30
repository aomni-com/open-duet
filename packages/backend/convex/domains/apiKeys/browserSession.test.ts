import { expect, test } from 'bun:test'

import { convexTest } from 'convex-test'
import { makeFunctionReference } from 'convex/server'

import { BROWSER_SESSION_TTL_MS, hashApiKey, type BrowserSessionCredential } from '@repo/contract'

import schema from '../../schema'
import { resolveCredential } from './authenticate'

test('browser credentials honor their lease and can still be revoked immediately', async () => {
  const t = convexTest(schema, {
    '../convex/_generated/api.ts': async () => ({}),
    '../convex/domains/apiKeys/mutations.ts': () => import('./mutations'),
  })
  const userId = await t.run(ctx =>
    ctx.db.insert('users', {
      email: 'browser@example.test',
      createdAt: 100,
      updatedAt: 100,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      memberDirectoryRevision: 0,
    }),
  )
  const signedIn = t.withIdentity({ subject: `${userId}|session` })
  const issuedAfter = Date.now()
  const credential = await signedIn.mutation(
    makeFunctionReference<'mutation', {}, BrowserSessionCredential>(
      'domains/apiKeys/mutations:mintBrowserSession',
    ),
    {},
  )
  expect(credential.expiresAt).toBeGreaterThanOrEqual(issuedAfter + BROWSER_SESSION_TTL_MS)
  const hashedKey = await hashApiKey(credential.token)
  const resolve = (now: number) =>
    t.run(ctx =>
      resolveCredential(ctx, {
        hashedKey,
        keyPrefix: credential.prefix,
        now,
      }),
    )
  expect(await resolve(credential.expiresAt - 1)).toMatchObject({ ok: true })
  expect(await resolve(credential.expiresAt)).toEqual({ ok: false, reason: 'expired' })
  await signedIn.mutation(
    makeFunctionReference<'mutation'>('domains/apiKeys/mutations:revokeBrowserSession'),
    { hashedKey },
  )
  expect(await resolve(Date.now())).toEqual({ ok: false, reason: 'revoked' })
})

test('a stale browser cookie is replaced after its expired row is pruned', async () => {
  const t = convexTest(schema, {
    '../convex/_generated/api.ts': async () => ({}),
    '../convex/domains/apiKeys/mutations.ts': () => import('./mutations'),
  })
  const userId = await t.run(ctx =>
    ctx.db.insert('users', {
      email: 'stale-browser@example.test',
      createdAt: 100,
      updatedAt: 100,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      memberDirectoryRevision: 0,
    }),
  )
  const staleToken = 'stale-browser-token'
  const staleExpiresAt = Date.now() - 1
  await t.run(async ctx => {
    await ctx.db.insert('apiKeys', {
      kind: 'browser_session',
      userId,
      hashedKey: await hashApiKey(staleToken),
      prefix: 'stale',
      scopes: [],
      workspaceIds: [],
      expiresAt: staleExpiresAt,
      lastUsedAt: staleExpiresAt,
    })
  })

  const replacement = await t.withIdentity({ subject: `${userId}|session` }).mutation(
    makeFunctionReference<'mutation', { previousHashedKey?: string }, BrowserSessionCredential>(
      'domains/apiKeys/mutations:mintBrowserSession',
    ),
    { previousHashedKey: await hashApiKey(staleToken) },
  )

  expect(replacement.token).not.toBe(staleToken)
})
