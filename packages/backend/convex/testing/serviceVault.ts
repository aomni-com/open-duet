import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'

import { mutation, query } from '../_generated/server'
import { requireApiInternalKey } from '../domains/apiKeys/model'

const expirePoolResourceRef = makeFunctionReference<'action'>(
  'domains/serviceVault/actions:expirePoolResource',
)

/**
 * The service-catalog closeout owns a disposable voice and must prove that
 * the same expiry path that production schedules can reclaim it. This is a
 * staging-only seam: callers still need DUET_API_INTERNAL_KEY and the
 * resource must already exist in the pool table.
 */
export const poolResourceForTest = query({
  args: {
    internalKey: v.string(),
    serviceId: v.string(),
    pool: v.string(),
    resourceId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const row = await ctx.db
      .query('servicePoolResources')
      .withIndex('by_resource', query =>
        query.eq('serviceId', args.serviceId).eq('pool', args.pool).eq('resourceId', args.resourceId),
      )
      .unique()
    if (row === null) return null
    return {
      id: row._id,
      serviceId: row.serviceId,
      pool: row.pool,
      resourceId: row.resourceId,
      workspaceId: row.workspaceId,
      expiresAt: row.expiresAt,
      state: row.state,
    }
  },
})

/** Move a disposable row onto a short TTL and queue the real expiry action. */
export const expirePoolResourceForTest = mutation({
  args: {
    internalKey: v.string(),
    serviceId: v.string(),
    pool: v.string(),
    resourceId: v.string(),
    delayMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const row = await ctx.db
      .query('servicePoolResources')
      .withIndex('by_resource', query =>
        query.eq('serviceId', args.serviceId).eq('pool', args.pool).eq('resourceId', args.resourceId),
      )
      .unique()
    if (row === null) throw new Error('Service pool resource not found')
    const delayMs = Math.min(Math.max(args.delayMs ?? 0, 0), 60_000)
    const expiresAt = Date.now() + delayMs
    await ctx.db.patch(row._id, { expiresAt })
    await ctx.scheduler.runAt(expiresAt, expirePoolResourceRef, {
      internalKey: args.internalKey,
      resourceId: row._id,
    })
    return { resourceId: row.resourceId, state: row.state, expiresAt, scheduled: true as const }
  },
})
