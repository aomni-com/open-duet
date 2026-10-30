import { expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import schema from '../../schema'
import { registerMachine, removeMachine, machineOwnedByUser, machineIdsForUser } from './model'

test('two peers retain independent identity across retries and removing one machine', async () => {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
  await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'sync@example.test',
      createdAt: 1,
      updatedAt: 1,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      memberDirectoryRevision: 0,
    })
    const args = { actorId: userId, name: 'MacBook', syncthingDeviceId: 'AAAAAAA-BBBBBBB', now: 10 }
    const first = await registerMachine(ctx, args)
    const second = await registerMachine(ctx, {
      ...args,
      name: 'Desktop',
      syncthingDeviceId: 'CCCCCCC-DDDDDDD',
    })
    const retried = await registerMachine(ctx, { ...args, name: 'Renamed', now: 20 })
    expect(retried).toEqual({ ...first, name: 'Renamed', lastUsedAt: 20 })
    expect(second.machineId).not.toBe(first.machineId)
    expect(await machineIdsForUser(ctx, userId)).toEqual([first.machineId, second.machineId])
    const removed = await removeMachine(ctx, {
      actorId: userId,
      machineId: first.machineId,
      now: 30,
    })
    expect(removed).toEqual({
      ok: true,
      machineId: first.machineId,
      removedAt: 30,
      workspaceSlugs: [],
    })
    expect(
      await removeMachine(ctx, { actorId: userId, machineId: first.machineId, now: 40 }),
    ).toEqual(removed)
    expect(await machineOwnedByUser(ctx, { actorId: userId, machineId: first.machineId })).toBe(
      false,
    )
    expect(await machineOwnedByUser(ctx, { actorId: userId, machineId: second.machineId })).toBe(
      true,
    )
    expect(await machineIdsForUser(ctx, userId)).toEqual([second.machineId])
  })
})

test('mirror use requires current write membership and preserves history after removal', async () => {
  const { useMachine } = await import('./model')
  const { resolveFileActorUsers } = await import('../fileActivity/actors')
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
  await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'member@example.test',
      createdAt: 1,
      updatedAt: 1,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      memberDirectoryRevision: 0,
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'acme',
      name: 'Acme',
      billingUserId: userId,
      status: 'active',
      createdAt: 1,
    })
    const memberId = await ctx.db.insert('workspaceMembers', {
      workspaceId,
      userId,
      role: 'editor',
    })
    const machine = await registerMachine(ctx, {
      actorId: userId,
      name: 'Mac',
      syncthingDeviceId: 'AAAAAAA-BBBBBBB',
      now: 10,
    })
    const args = {
      actorId: userId,
      machineId: machine.machineId,
      syncthingDeviceId: machine.syncthingDeviceId,
      workspaceId,
      now: 20,
    }
    expect(await useMachine(ctx, args)).toMatchObject({
      machineId: machine.machineId,
      lastUsedAt: 20,
    })
    await ctx.db.patch(memberId, { role: 'viewer' })
    await expect(useMachine(ctx, args)).rejects.toThrow('Workspace write access required')
    await ctx.db.delete(memberId)
    await expect(useMachine(ctx, args)).rejects.toThrow('Workspace write access required')
    await ctx.db.insert('workspaceMembers', { workspaceId, userId, role: 'editor' })
    await removeMachine(ctx, { actorId: userId, machineId: machine.machineId, now: 30 })
    await expect(useMachine(ctx, args)).rejects.toThrow('Sync machine not found')
    const actor = `mirror:${machine.machineId}`
    expect((await resolveFileActorUsers(ctx.db, [actor])).get(actor)).toBe(userId)
  })
})

test('replacing a user key retains both machines and revocation only refuses the old login', async () => {
  const { issueUserKey, revokeUserKey } = await import('../apiKeys/userKeys')
  const { resolveCredential } = await import('../apiKeys/authenticate')
  const { hashApiKey } = await import('@repo/contract')
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
  await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'rotation@example.test',
      createdAt: 1,
      updatedAt: 1,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      memberDirectoryRevision: 0,
    })
    const oldKey = await issueUserKey(ctx, { actorId: userId, name: 'Login', now: 10 })
    const first = await registerMachine(ctx, {
      actorId: userId,
      name: 'Laptop',
      syncthingDeviceId: 'AAAAAAA-BBBBBBB',
      now: 20,
    })
    const second = await registerMachine(ctx, {
      actorId: userId,
      name: 'Desktop',
      syncthingDeviceId: 'CCCCCCC-DDDDDDD',
      now: 20,
    })
    const replacement = await issueUserKey(ctx, { actorId: userId, name: 'Replacement', now: 30 })
    await revokeUserKey(ctx, { actorId: userId, keyId: oldKey.record.id, now: 40 })
    expect(
      await resolveCredential(ctx, {
        hashedKey: await hashApiKey(oldKey.key),
        keyPrefix: oldKey.record.prefix,
        now: 50,
      }),
    ).toEqual({ ok: false, reason: 'revoked' })
    expect(
      await resolveCredential(ctx, {
        hashedKey: await hashApiKey(replacement.key),
        keyPrefix: replacement.record.prefix,
        now: 50,
      }),
    ).toMatchObject({ ok: true, auth: { credentialKind: 'user', user: { id: userId } } })
    const retried = await registerMachine(ctx, {
      actorId: userId,
      name: 'Laptop',
      syncthingDeviceId: first.syncthingDeviceId,
      now: 50,
    })
    expect(retried.machineId).toBe(first.machineId)
    expect(await machineIdsForUser(ctx, userId)).toEqual([first.machineId, second.machineId])
  })
})

test('desired mirror access follows removal and current roles within only the changed workspace', async () => {
  const { mirrorMachineIdsForWorkspace } = await import('./model')
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
  await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'projection@example.test',
      createdAt: 1,
      updatedAt: 1,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      memberDirectoryRevision: 0,
    })
    const firstWorkspace = await ctx.db.insert('workspaces', {
      slug: 'first',
      name: 'First',
      billingUserId: userId,
      status: 'active',
      createdAt: 1,
    })
    const secondWorkspace = await ctx.db.insert('workspaces', {
      slug: 'second',
      name: 'Second',
      billingUserId: userId,
      status: 'active',
      createdAt: 1,
    })
    const member = await ctx.db.insert('workspaceMembers', {
      workspaceId: firstWorkspace,
      userId,
      role: 'editor',
    })
    await ctx.db.insert('workspaceMembers', { workspaceId: secondWorkspace, userId, role: 'owner' })
    const first = await registerMachine(ctx, {
      actorId: userId,
      name: 'Laptop',
      syncthingDeviceId: 'AAAAAAA',
      now: 1,
    })
    const second = await registerMachine(ctx, {
      actorId: userId,
      name: 'Desktop',
      syncthingDeviceId: 'BBBBBBB',
      now: 1,
    })
    expect(await mirrorMachineIdsForWorkspace(ctx, firstWorkspace)).toEqual([
      first.machineId,
      second.machineId,
    ])
    await removeMachine(ctx, { actorId: userId, machineId: first.machineId, now: 2 })
    expect(await mirrorMachineIdsForWorkspace(ctx, firstWorkspace)).toEqual([second.machineId])
    await ctx.db.patch(member, { role: 'viewer' })
    expect(await mirrorMachineIdsForWorkspace(ctx, firstWorkspace)).toEqual([])
    expect(await mirrorMachineIdsForWorkspace(ctx, secondWorkspace)).toEqual([second.machineId])
    await ctx.db.delete(member)
    expect(await mirrorMachineIdsForWorkspace(ctx, firstWorkspace)).toEqual([])
  })
})

test('explicit machine registration re-enables the same peer identity after removal', async () => {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
  await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'reenable@example.test',
      createdAt: 1,
      updatedAt: 1,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      memberDirectoryRevision: 0,
    })
    const args = { actorId: userId, name: 'Laptop', syncthingDeviceId: 'AAAAAAA-BBBBBBB', now: 10 }
    const machine = await registerMachine(ctx, args)
    await removeMachine(ctx, { actorId: userId, machineId: machine.machineId, now: 20 })
    expect(await machineOwnedByUser(ctx, { actorId: userId, machineId: machine.machineId })).toBe(
      false,
    )
    const restored = await registerMachine(ctx, { ...args, now: 30 })
    expect(restored).toEqual({ ...machine, lastUsedAt: 30 })
    expect(await machineOwnedByUser(ctx, { actorId: userId, machineId: machine.machineId })).toBe(
      true,
    )
  })
})

test('the same Mac peer has independent account rows and retries by authenticated user', async () => {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
  await t.run(async ctx => {
    const firstOwner = await ctx.db.insert('users', {
      email: 'first@example.test',
      createdAt: 1,
      updatedAt: 1,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      memberDirectoryRevision: 0,
    })
    const secondOwner = await ctx.db.insert('users', {
      email: 'second@example.test',
      createdAt: 1,
      updatedAt: 1,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      memberDirectoryRevision: 0,
    })
    const peer = { name: 'Shared Mac', syncthingDeviceId: 'AAAAAAA-BBBBBBB', now: 10 }
    const first = await registerMachine(ctx, { ...peer, actorId: firstOwner })
    const second = await registerMachine(ctx, { ...peer, actorId: secondOwner })
    expect(first.machineId).not.toBe(second.machineId)
    expect((await ctx.db.get(first.machineId))?.userId).toBe(firstOwner)
    expect((await ctx.db.get(second.machineId))?.userId).toBe(secondOwner)
    await removeMachine(ctx, { actorId: firstOwner, machineId: first.machineId, now: 20 })
    const retried = await registerMachine(ctx, { ...peer, actorId: secondOwner, now: 30 })
    expect(retried).toEqual({ ...second, lastUsedAt: 30 })
    expect(await machineIdsForUser(ctx, firstOwner)).toEqual([])
    expect(await machineIdsForUser(ctx, secondOwner)).toEqual([second.machineId])
    const restored = await registerMachine(ctx, { ...peer, actorId: firstOwner, now: 40 })
    expect(restored).toEqual({ ...first, lastUsedAt: 40 })
    expect(
      await machineOwnedByUser(ctx, { actorId: secondOwner, machineId: first.machineId }),
    ).toBe(false)
  })
})
