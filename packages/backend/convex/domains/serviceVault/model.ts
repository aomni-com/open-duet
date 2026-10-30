import { v } from 'convex/values'
import { makeFunctionReference } from 'convex/server'

import { internalMutation, internalQuery } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'

const expirePoolResourceRef = makeFunctionReference<'action'>('domains/serviceVault/actions:expirePoolResource')

async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

const credentialArgs = {
  internalKey: v.string(),
  serviceId: v.string(),
  name: v.string(),
}

export const getServiceCredential = internalQuery({
  args: credentialArgs,
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const row = await ctx.db
      .query('serviceCredentials')
      .withIndex('by_service_and_name', query => query.eq('serviceId', args.serviceId).eq('name', args.name))
      .unique()
    if (row === null) return null
    return { secret: row.value, fingerprint: row.fingerprint, generation: row.generation }
  },
})

export const putServiceCredential = internalMutation({
  args: {
    ...credentialArgs,
    value: v.string(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const existing = await ctx.db
      .query('serviceCredentials')
      .withIndex('by_service_and_name', query => query.eq('serviceId', args.serviceId).eq('name', args.name))
      .unique()
    const now = args.now ?? Date.now()
    const fields = { value: args.value, fingerprint: await fingerprint(args.value), updatedAt: now }
    if (existing === null) {
      await ctx.db.insert('serviceCredentials', { ...fields, serviceId: args.serviceId, name: args.name, generation: 1 })
      return { generation: 1, fingerprint: fields.fingerprint }
    }
    const generation = existing.generation + 1
    await ctx.db.patch(existing._id, { ...fields, generation })
    return { generation, fingerprint: fields.fingerprint }
  },
})

export const recordPoolResource = internalMutation({
  args: {
    internalKey: v.string(),
    serviceId: v.string(),
    pool: v.string(),
    resourceId: v.string(),
    workspaceId: v.id('workspaces'),
    createdAt: v.number(),
    expiresAt: v.number(),
    expiry: v.optional(v.object({
      baseUrl: v.string(),
      method: v.string(),
      path: v.string(),
      body: v.optional(v.any()),
      authKind: v.string(),
      authName: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const existing = await ctx.db
      .query('servicePoolResources')
      .withIndex('by_resource', query => query.eq('serviceId', args.serviceId).eq('pool', args.pool).eq('resourceId', args.resourceId))
      .unique()
    if (existing !== null) return { id: existing._id, inserted: false }
    const id = await ctx.db.insert('servicePoolResources', {
      serviceId: args.serviceId,
      pool: args.pool,
      resourceId: args.resourceId,
      workspaceId: args.workspaceId,
      createdAt: args.createdAt,
      expiresAt: args.expiresAt,
      state: 'live',
      expiry: args.expiry,
    })
    await ctx.scheduler.runAt(args.expiresAt, expirePoolResourceRef, { internalKey: args.internalKey, resourceId: id })
    return { id, inserted: true }
  },
})

export const poolOwner = internalQuery({
  args: { internalKey: v.string(), serviceId: v.string(), pool: v.string(), resourceId: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const row = await ctx.db
      .query('servicePoolResources')
      .withIndex('by_resource', query => query.eq('serviceId', args.serviceId).eq('pool', args.pool).eq('resourceId', args.resourceId))
      .unique()
    return row?.state === 'live' ? row.workspaceId : null
  },
})

export const getPoolResource = internalQuery({
  args: { internalKey: v.string(), resourceId: v.id('servicePoolResources') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const row = await ctx.db.get(args.resourceId)
    return row === null ? null : { serviceId: row.serviceId, resourceId: row.resourceId, state: row.state, expiry: row.expiry }
  },
})

export const markPoolResourceExpired = internalMutation({
  args: { internalKey: v.string(), resourceId: v.id('servicePoolResources') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const row = await ctx.db.get(args.resourceId)
    if (row === null || row.state !== 'live') return { expired: false }
    await ctx.db.patch(row._id, { state: 'expired' })
    return { expired: true }
  },
})

export const markPoolResourceDeleted = internalMutation({
  args: { internalKey: v.string(), serviceId: v.string(), pool: v.string(), resourceId: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const row = await ctx.db
      .query('servicePoolResources')
      .withIndex('by_resource', query => query.eq('serviceId', args.serviceId).eq('pool', args.pool).eq('resourceId', args.resourceId))
      .unique()
    if (row === null || row.state !== 'live') return { deleted: false }
    await ctx.db.patch(row._id, { state: 'deleted' })
    return { deleted: true }
  },
})
