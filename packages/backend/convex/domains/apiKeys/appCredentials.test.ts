import { expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import { MAX_EXPORTED_APP_CREDENTIALS } from '@repo/contract'

import type { Id } from '../../_generated/dataModel'
import schema from '../../schema'
import { registerAppImpl } from '../apps/model'
import { exportCredentialImpl, listCredentialsImpl, revokeCredentialImpl } from './appExports'
import { resolveCredential } from './authenticate'
import {
  hashSecret,
  keyPrefix,
  mintAppKeyForApp,
  revokeAppKeysForApp,
  rotateAppKeyForApp,
} from './model'

async function fixture(ctx: import('../../_generated/server').MutationCtx) {
  const userId = await ctx.db.insert('users', {
    email: 'app-export@example.test',
    createdAt: 100,
    updatedAt: 100,
    paidCreditBalanceMicroUsd: 0,
    monthlyCreditBalanceMicroUsd: 0,
    memberDirectoryRevision: 0,
  })
  const workspaceId = await ctx.db.insert('workspaces', {
    slug: 'app-export',
    name: 'Export fixture',
    status: 'active',
    billingUserId: userId,
    createdByUserId: userId,
    createdAt: 100,
  })
  const anchorId = await ctx.db.insert('anchors', {
    workspaceId,
    path: 'app-export',
    kind: 'app',
    state: 'active',
    settings: {},
    markerNonce: 'fixture-marker',
    createdAt: 100,
    updatedAt: 100,
  })
  const appId = await ctx.db.insert('apps', {
    workspaceId,
    anchorId,
    slug: 'external',
    command: 'bun index.ts',
    apiScopes: ['services'],
    visibility: 'folder',
    runtimeStatus: 'reconciled',
    createdByUserId: userId,
    createdAt: 100,
    updatedAt: 100,
  })
  return { userId, workspaceId, appId }
}

test('managed app refresh and redelivery preserve an independently exported credential', async () => {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
  await t.run(async ctx => {
    const { userId, workspaceId, appId } = await fixture(ctx)
    const firstManaged = await mintAppKeyForApp(ctx, { appId, now: 1000 })
    const exportedKey = 'duet_sk_exported-fixture'
    const exportedId = await ctx.db.insert('apiKeys', {
      kind: 'app',
      appId,
      workspaceId,
      userId,
      appKeyPurpose: 'exported',
      hashedKey: await hashSecret(exportedKey),
      prefix: keyPrefix(exportedKey),
      scopes: ['ws:app-export:services'],
      workspaceIds: [workspaceId],
    })
    const replacement = await rotateAppKeyForApp(ctx, { appId, now: 2000 })
    expect(replacement?.keyId).not.toBe(firstManaged?.keyId)
    expect((await ctx.db.get(firstManaged!.keyId))?.revokedAt).toBe(2000)
    expect((await ctx.db.get(exportedId))?.revokedAt).toBeUndefined()
    expect(
      await resolveCredential(ctx, {
        hashedKey: await hashSecret(exportedKey),
        keyPrefix: keyPrefix(exportedKey),
        now: 2000,
      }),
    ).toMatchObject({
      ok: true,
      auth: { credentialKind: 'app', workspaces: [{ id: workspaceId }] },
    })
    expect(await mintAppKeyForApp(ctx, { appId, now: 2001 })).toMatchObject({
      key: null,
      keyId: replacement!.keyId,
    })
  })
})

test('scope changes away and back permanently revoke exports while equivalent sets preserve them', async () => {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
  await t.run(async ctx => {
    const { userId, workspaceId, appId } = await fixture(ctx)
    const key = 'duet_sk_scope-fixture'
    const keyId = await ctx.db.insert('apiKeys', {
      kind: 'app',
      appId,
      userId,
      workspaceId,
      appKeyPurpose: 'exported',
      hashedKey: await hashSecret(key),
      prefix: keyPrefix(key),
      scopes: ['ws:app-export:services'],
      workspaceIds: [workspaceId],
    })
    const register = (apiScopes: string[], now: number) =>
      registerAppImpl(ctx, {
        workspaceId,
        actorId: userId,
        path: 'app-export',
        slug: 'external',
        command: 'bun index.ts',
        apiScopes,
        now,
      })
    await register(['services', 'services'], 2000)
    expect((await ctx.db.get(keyId))?.revokedAt).toBeUndefined()
    await register(['apps'], 3000)
    await register(['services'], 4000)
    expect(
      await resolveCredential(ctx, {
        hashedKey: await hashSecret(key),
        keyPrefix: keyPrefix(key),
        now: 4000,
      }),
    ).toEqual({ ok: false, reason: 'revoked' })
  })
})

test('export capacity counts only live exported keys and returns plaintext once', async () => {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
  await t.run(async ctx => {
    const { workspaceId, appId } = await fixture(ctx)
    const managed = await mintAppKeyForApp(ctx, { appId, now: 1000 })
    const workspace = (await ctx.db.get(workspaceId))!
    await ctx.db.insert('apiKeys', {
      kind: 'system_vm',
      userId: workspace.createdByUserId!,
      workspaceId,
      workspaceIds: [workspaceId],
      scopes: ['ws:app-export:apps'],
      hashedKey: 'building-agent',
      prefix: 'duet_sk_builder',
    })
    const args = {
      workspaceId,
      appSlug: 'external',
      caller: { hashedKey: 'building-agent', keyPrefix: 'duet_sk_builder' },
    }
    const finite = await exportCredentialImpl(ctx, {
      ...args,
      expiration: { seconds: 1 },
      now: 1000,
    })
    const liveIds: Id<'apiKeys'>[] = []
    for (let i = 0; i < MAX_EXPORTED_APP_CREDENTIALS - 1; i++) {
      const exported = await exportCredentialImpl(ctx, { ...args, expiration: 'never', now: 1000 })
      liveIds.push(exported.credentialId)
    }
    await expect(
      exportCredentialImpl(ctx, { ...args, expiration: 'never', now: 1000 }),
    ).rejects.toMatchObject({
      data: { code: 'app_credential_limit', limit: MAX_EXPORTED_APP_CREDENTIALS },
    })
    const replacement = await exportCredentialImpl(ctx, { ...args, expiration: 'never', now: 2000 })
    expect(replacement.expiresAt).toBeNull()
    expect(finite.expiresAt).toBe(2000)
    const inventory = await listCredentialsImpl(ctx, { ...args, now: 2000 })
    expect(inventory.items.map(item => item.credentialId)).toContain(replacement.credentialId)
    expect(inventory.items.map(item => item.credentialId)).not.toContain(finite.credentialId)
    expect(inventory.items.map(item => item.credentialId).sort()).toEqual(
      [...liveIds, replacement.credentialId].sort(),
    )
    expect(JSON.stringify(inventory)).not.toContain(replacement.key)
    const stored = (await ctx.db.get(replacement.credentialId as Id<'apiKeys'>))!
    expect(stored.hashedKey).toBe(await hashSecret(replacement.key))
    expect(stored).not.toHaveProperty('key')
    expect((await ctx.db.get(managed!.keyId))?.revokedAt).toBeUndefined()
  })
})

test('revoke is idempotent and cannot target the managed key or another app', async () => {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
  await t.run(async ctx => {
    const { workspaceId, appId, userId } = await fixture(ctx)
    await ctx.db.insert('apiKeys', {
      kind: 'system_vm',
      userId,
      workspaceId,
      workspaceIds: [workspaceId],
      scopes: ['ws:app-export:apps'],
      hashedKey: 'builder',
      prefix: 'duet_sk_builder',
    })
    const args = {
      workspaceId,
      appSlug: 'external',
      caller: { hashedKey: 'builder', keyPrefix: 'duet_sk_builder' },
      now: 1000,
    }
    const managed = await mintAppKeyForApp(ctx, { appId, now: 1000 })
    const old = await exportCredentialImpl(ctx, { ...args, expiration: 'never' })
    const replacement = await exportCredentialImpl(ctx, { ...args, expiration: 'never' })
    await expect(
      revokeCredentialImpl(ctx, { ...args, credentialId: managed!.keyId }),
    ).rejects.toMatchObject({ data: { status: 404, code: 'not_found' } })
    expect(await revokeCredentialImpl(ctx, { ...args, credentialId: old.credentialId })).toEqual({
      ok: true,
    })
    expect(await revokeCredentialImpl(ctx, { ...args, credentialId: old.credentialId })).toEqual({
      ok: true,
    })
    expect(await revokeCredentialImpl(ctx, { ...args, credentialId: 'missing' })).toEqual({
      ok: true,
    })
    const resolve = async (key: string) =>
      resolveCredential(ctx, {
        hashedKey: await hashSecret(key),
        keyPrefix: keyPrefix(key),
        now: 1000,
      })
    expect(await resolve(old.key)).toEqual({ ok: false, reason: 'revoked' })
    expect(await resolve(replacement.key)).toMatchObject({ ok: true })
    expect(await resolve(managed!.key!)).toMatchObject({ ok: true })
    const app = (await ctx.db.get(appId))!
    const otherAppId = await ctx.db.insert('apps', {
      workspaceId,
      anchorId: app.anchorId,
      slug: 'other',
      command: app.command,
      apiScopes: app.apiScopes,
      visibility: 'folder',
      runtimeStatus: 'reconciled',
      createdByUserId: userId,
      createdAt: 100,
      updatedAt: 100,
    })
    const other = await exportCredentialImpl(ctx, {
      ...args,
      appSlug: 'other',
      expiration: 'never',
    })
    await expect(
      revokeCredentialImpl(ctx, { ...args, credentialId: other.credentialId }),
    ).rejects.toMatchObject({ data: { status: 404 } })
    expect((await ctx.db.get(otherAppId))?.slug).toBe('other')
  })
})

test('durable management authority admits editors, lists for viewers and survives exporter departure', async () => {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
  await t.run(async ctx => {
    const { workspaceId, userId } = await fixture(ctx)
    const memberId = await ctx.db.insert('workspaceMembers', {
      workspaceId,
      userId,
      role: 'editor',
    })
    const callerId = await ctx.db.insert('apiKeys', {
      kind: 'user',
      userId,
      hashedKey: 'human-editor',
      prefix: 'duet_sk_editor',
    })
    const args = {
      workspaceId,
      appSlug: 'external',
      caller: { hashedKey: 'human-editor', keyPrefix: 'duet_sk_editor' },
      now: 1000,
    }
    const exported = await exportCredentialImpl(ctx, { ...args, expiration: 'never' })
    await ctx.db.patch(memberId, { role: 'viewer' })
    expect((await listCredentialsImpl(ctx, args)).items.map(item => item.credentialId)).toEqual([
      exported.credentialId,
    ])
    await expect(exportCredentialImpl(ctx, { ...args, expiration: 'never' })).rejects.toMatchObject(
      { data: { status: 403, code: 'insufficient_scope' } },
    )
    await expect(
      revokeCredentialImpl(ctx, { ...args, credentialId: exported.credentialId }),
    ).rejects.toMatchObject({ data: { status: 403 } })
    await ctx.db.delete(memberId)
    expect(
      await resolveCredential(ctx, {
        hashedKey: await hashSecret(exported.key),
        keyPrefix: keyPrefix(exported.key),
        now: 1000,
      }),
    ).toMatchObject({ ok: true })
    await ctx.db.patch(callerId, { revokedAt: 1000 })
    await expect(exportCredentialImpl(ctx, { ...args, expiration: 'never' })).rejects.toMatchObject(
      { data: { status: 401, code: 'unauthorized' } },
    )
  })
})

test('expired export history cannot consume capacity or prevent all-purpose teardown', async () => {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
  await t.run(async ctx => {
    const { workspaceId, userId, appId } = await fixture(ctx)
    for (let i = 0; i < 101; i++) {
      await ctx.db.insert('apiKeys', {
        kind: 'app',
        userId,
        appId,
        workspaceId,
        workspaceIds: [workspaceId],
        appKeyPurpose: 'exported',
        scopes: ['ws:app-export:services'],
        hashedKey: `expired-${i}`,
        prefix: `duet_sk_expired${i}`,
        expiresAt: 1000,
      })
    }
    await ctx.db.insert('apiKeys', {
      kind: 'system_vm',
      userId,
      workspaceId,
      workspaceIds: [workspaceId],
      scopes: ['ws:app-export:apps'],
      hashedKey: 'builder-history',
      prefix: 'duet_sk_history',
    })
    const args = {
      workspaceId,
      appSlug: 'external',
      caller: { hashedKey: 'builder-history', keyPrefix: 'duet_sk_history' },
      now: 2000,
    }
    const exported = await exportCredentialImpl(ctx, { ...args, expiration: 'never' })
    const managed = await mintAppKeyForApp(ctx, { appId, now: 2000 })
    expect((await listCredentialsImpl(ctx, args)).items.map(item => item.credentialId)).toEqual([
      exported.credentialId,
    ])
    await revokeAppKeysForApp(ctx, { app: (await ctx.db.get(appId))!, now: 3000 })
    for (const key of [exported.key, managed!.key!]) {
      expect(
        await resolveCredential(ctx, {
          hashedKey: await hashSecret(key),
          keyPrefix: keyPrefix(key),
          now: 3000,
        }),
      ).toEqual({ ok: false, reason: 'revoked' })
    }
    expect(
      await resolveCredential(ctx, {
        hashedKey: 'expired-0',
        keyPrefix: 'duet_sk_expired0',
        now: 3000,
      }),
    ).toEqual({ ok: false, reason: 'expired' })
  })
})
