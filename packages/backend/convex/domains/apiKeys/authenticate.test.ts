import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import {
  AUTHENTICATED_API_RATE_LIMIT,
  AUTHENTICATED_API_RATE_LIMIT_WINDOW_MS,
} from '@repo/contract'

import type { MutationCtx } from '../../_generated/server'
import schema from '../../schema'
import { gatewayPreflightImpl } from '../modelGateway/preflight'
import { AUTHENTICATED_API_RATE_LIMIT_SHARDS } from './apiRateLimit'
import { recordCredentialUse, resolveCredential } from './authenticate'
import { approveDeviceApproval } from './deviceApproval'
import { hashSecret } from './model'
import { issueUserKey } from './userKeys'

const HASHED_KEY = 'a'.repeat(64)
const STAMP_WINDOW_MS = 37
const originalStampWindow = process.env.DUET_API_KEY_LAST_USED_WINDOW_MS
beforeEach(() => {
  process.env.DUET_API_KEY_LAST_USED_WINDOW_MS = String(STAMP_WINDOW_MS)
})
afterEach(() => {
  if (originalStampWindow === undefined) delete process.env.DUET_API_KEY_LAST_USED_WINDOW_MS
  else process.env.DUET_API_KEY_LAST_USED_WINDOW_MS = originalStampWindow
})

function newTest() {
  return convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
}

async function insertUser(ctx: MutationCtx, email: string) {
  return await ctx.db.insert('users', {
    email,
    createdAt: 100,
    updatedAt: 100,
    paidCreditBalanceMicroUsd: 0,
    monthlyCreditBalanceMicroUsd: 0,
    memberDirectoryRevision: 0,
  })
}

describe('recording a credential use', () => {
  test('model preflight shares the credential timestamp window with ordinary API traffic', async () => {
    const previousKey = process.env.DUET_API_INTERNAL_KEY
    process.env.DUET_API_INTERNAL_KEY = 'credential-window-test'
    try {
      await newTest().run(async ctx => {
        const userId = await insertUser(ctx, 'gateway@example.test')
        const workspaceId = await ctx.db.insert('workspaces', {
          slug: 'gateway-window',
          name: 'Gateway',
          status: 'active',
          billingUserId: userId,
          createdAt: 100,
          onboardedAt: 100,
        })
        const keyId = await ctx.db.insert('apiKeys', {
          userId,
          kind: 'system_vm',
          hashedKey: HASHED_KEY,
          prefix: 'duet_sk_fixture',
          scopes: ['ws:gateway-window:services'],
          workspaceIds: [workspaceId],
        })
        const now = 1_200_000
        const preflight = (at: number) =>
          gatewayPreflightImpl(ctx, {
            internalKey: 'credential-window-test',
            hashedKey: HASHED_KEY,
            requestKind: 'catalog',
            modality: 'text',
            now: at,
          })
        expect(await preflight(now)).toMatchObject({ proceed: true })
        await recordCredentialUse(ctx, { hashedKey: HASHED_KEY, now: now + 1 })
        expect(await preflight(now + 2)).toMatchObject({ proceed: true })
        expect((await ctx.db.get(keyId))?.lastUsedAt).toBe(now)
        const nextWindow = now + STAMP_WINDOW_MS
        expect(await preflight(nextWindow)).toMatchObject({ proceed: true })
        expect((await ctx.db.get(keyId))?.lastUsedAt).toBe(nextWindow)
      })
    } finally {
      if (previousKey === undefined) delete process.env.DUET_API_INTERNAL_KEY
      else process.env.DUET_API_INTERNAL_KEY = previousKey
    }
  })

  test('stamps lastUsedAt once per window while counting every request', async () => {
    await newTest().run(async ctx => {
      const userId = await insertUser(ctx, 'browser@example.test')
      const keyId = await ctx.db.insert('apiKeys', {
        userId,
        kind: 'browser_session',
        hashedKey: HASHED_KEY,
        prefix: 'duet_sk_fixture',
        scopes: [],
        workspaceIds: [],
      })

      const first = await recordCredentialUse(ctx, { hashedKey: HASHED_KEY, now: 1_200_000 })
      const second = await recordCredentialUse(ctx, {
        hashedKey: HASHED_KEY,
        // Stay in the same rate-limit window too: a later window resets a
        // reused shard, so summing counters across windows is not a request total.
        now: 1_200_001,
      })

      expect(first).toEqual({ ok: true })
      expect(second).toEqual({ ok: true })
      // The second request is inside the window, so the row keeps the FIRST
      // stamp: one lastUsedAt write per credential per window is the throttle.
      expect((await ctx.db.get(keyId))?.lastUsedAt).toBe(1_200_000)
      // ...but both requests spend budget. The budget is spread over shard
      // rows, so the spend is the sum across every row of the principal.
      const rows = await ctx.db.query('rateLimits').collect()
      expect(rows.every(row => row.key.startsWith(`api:user:${userId}`))).toBeTrue()
      expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(2)
    })
  })
})

describe('resolving a credential', () => {
  test('one human key follows membership joins, removals and role changes', async () => {
    await newTest().run(async ctx => {
      const userId = await insertUser(ctx, 'identity@example.test')
      const workspace = async (slug: string) =>
        await ctx.db.insert('workspaces', {
          slug,
          name: slug,
          status: 'active',
          billingUserId: userId,
          createdAt: 100,
        })
      const first = await workspace('first')
      const second = await workspace('second')
      const member = await ctx.db.insert('workspaceMembers', {
        workspaceId: first,
        userId,
        role: 'owner',
      })
      const keyId = await ctx.db.insert('apiKeys', {
        kind: 'user',
        userId,
        hashedKey: HASHED_KEY,
        prefix: 'duet_sk_fixture',
      })
      const resolve = () =>
        resolveCredential(ctx, {
          hashedKey: HASHED_KEY,
          keyPrefix: 'duet_sk_fixture',
          now: 1200000,
        })
      expect(await resolve()).toMatchObject({ ok: true, auth: { workspaces: [{ id: first }] } })
      await ctx.db.insert('workspaceMembers', { workspaceId: second, userId, role: 'viewer' })
      let auth = await resolve()
      expect(auth.ok && auth.auth.workspaces.map(row => row.id)).toEqual([first, second])
      expect(auth.ok && auth.auth.scopes).toContain('ws:second:files:read')
      expect(auth.ok && auth.auth.scopes).not.toContain('ws:second:files:write')
      await ctx.db.patch(member, { role: 'viewer' })
      auth = await resolve()
      expect(auth.ok && auth.auth.scopes).not.toContain('ws:first:admin')
      expect(auth.ok && auth.auth.scopes).toContain('ws:first:files:read')
      await ctx.db.delete(member)
      auth = await resolve()
      expect(auth.ok && auth.auth.workspaces.map(row => row.id)).toEqual([second])
      await ctx.db.patch(keyId, { revokedAt: 1000 })
      expect(await resolve()).toEqual({ ok: false, reason: 'revoked' })
    })
  })

  test('issuing a human key saves identity without workspace grants, including before joining', async () => {
    await newTest().run(async ctx => {
      const userId = await insertUser(ctx, 'unjoined@example.test')
      const issued = await issueUserKey(ctx, { actorId: userId, name: 'Laptop' })
      const row = await ctx.db.get(issued.record.id)
      expect(row?.userId).toBe(userId)
      expect(row?.hashedKey).toBe(await hashSecret(issued.key))
      expect(row).not.toHaveProperty('scopes')
      expect(row).not.toHaveProperty('workspaceIds')
      expect(
        await resolveCredential(ctx, {
          hashedKey: await hashSecret(issued.key),
          keyPrefix: issued.record.prefix,
          now: 1200000,
        }),
      ).toMatchObject({ ok: true, auth: { workspaces: [], scopes: [] } })
    })
  })

  test('expired login approval refuses without consuming the pending request', async () => {
    await newTest().run(async ctx => {
      const userId = await insertUser(ctx, 'expired-login@example.test')
      const id = await ctx.db.insert('deviceCodes', {
        code: 'e'.repeat(64),
        userCode: 'TEST-CODE',
        status: 'pending',
        expiresAt: 100,
        intervalSeconds: 5,
      })
      await expect(
        approveDeviceApproval(ctx, { actorId: userId, userCode: 'TEST-CODE', now: 101 }),
      ).rejects.toThrow('Device code expired')
      expect(await ctx.db.get(id)).toMatchObject({ status: 'pending' })
      expect(await ctx.db.query('apiKeys').collect()).toEqual([])
    })
  })

  test('answers from the credential alone: a spent budget does not change it', async () => {
    await newTest().run(async ctx => {
      const userId = await insertUser(ctx, 'spent@example.test')
      const workspaceId = await ctx.db.insert('workspaces', {
        slug: 'spent-workspace',
        name: 'Spent workspace',
        status: 'active',
        billingUserId: userId,
        createdAt: 100,
      })
      await ctx.db.insert('workspaceMembers', { workspaceId, userId, role: 'owner' })
      await ctx.db.insert('apiKeys', {
        userId,
        kind: 'browser_session',
        hashedKey: HASHED_KEY,
        prefix: 'duet_sk_fixture',
        scopes: [],
        workspaceIds: [workspaceId],
      })
      const now = 2 * AUTHENTICATED_API_RATE_LIMIT_WINDOW_MS
      // Every shard of this person's window is spent.
      const shards = AUTHENTICATED_API_RATE_LIMIT_SHARDS
      for (let shard = 0; shard < shards; shard += 1) {
        await ctx.db.insert('rateLimits', {
          key: `api:user:${userId}#api:${shard}`,
          windowStart:
            Math.floor(now / AUTHENTICATED_API_RATE_LIMIT_WINDOW_MS) *
            AUTHENTICATED_API_RATE_LIMIT_WINDOW_MS,
          count: Math.floor(AUTHENTICATED_API_RATE_LIMIT / shards),
          updatedAt: now,
        })
      }

      const resolved = await resolveCredential(ctx, {
        hashedKey: HASHED_KEY,
        keyPrefix: 'duet_sk_fixture',
        now,
      })
      const recorded = await recordCredentialUse(ctx, { hashedKey: HASHED_KEY, now })

      expect(resolved).toMatchObject({
        ok: true,
        auth: { credentialKind: 'browser_session', workspaces: [{ id: workspaceId }] },
      })
      expect(recorded).toEqual({
        ok: false,
        reason: 'rate_limited',
        retryAfterSeconds: Math.ceil(AUTHENTICATED_API_RATE_LIMIT_WINDOW_MS / 1000),
      })
    })
  })

  test('refuses dead credentials by reason and spends nothing on them', async () => {
    await newTest().run(async ctx => {
      const userId = await insertUser(ctx, 'dead@example.test')
      const now = 1_200_000
      const keys = {
        revoked: { hashedKey: 'b'.repeat(64), revokedAt: 500 },
        expired: { hashedKey: 'c'.repeat(64), expiresAt: now },
      }
      for (const row of Object.values(keys)) {
        await ctx.db.insert('apiKeys', {
          userId,
          kind: 'browser_session',
          prefix: 'duet_sk_fixture',
          scopes: [],
          workspaceIds: [],
          ...row,
        })
      }
      const unknownHashedKey = 'd'.repeat(64)

      const answers = {
        unknown: await resolveCredential(ctx, {
          hashedKey: unknownHashedKey,
          keyPrefix: 'duet_sk_fixture',
          now,
        }),
        wrongPrefix: await resolveCredential(ctx, {
          hashedKey: keys.revoked.hashedKey,
          keyPrefix: 'duet_sk_other',
          now,
        }),
        revoked: await resolveCredential(ctx, {
          hashedKey: keys.revoked.hashedKey,
          keyPrefix: 'duet_sk_fixture',
          now,
        }),
        expired: await resolveCredential(ctx, {
          hashedKey: keys.expired.hashedKey,
          keyPrefix: 'duet_sk_fixture',
          now,
        }),
      }
      for (const hashedKey of [unknownHashedKey, keys.revoked.hashedKey, keys.expired.hashedKey]) {
        expect(await recordCredentialUse(ctx, { hashedKey, now })).toEqual({ ok: true })
      }

      expect(answers).toEqual({
        unknown: { ok: false, reason: 'unknown' },
        wrongPrefix: { ok: false, reason: 'unknown' },
        revoked: { ok: false, reason: 'revoked' },
        expired: { ok: false, reason: 'expired' },
      })
      expect(await ctx.db.query('rateLimits').collect()).toEqual([])
      const rows = await ctx.db.query('apiKeys').collect()
      expect(rows.map(row => row.lastUsedAt)).toEqual([undefined, undefined])
    })
  })
})
