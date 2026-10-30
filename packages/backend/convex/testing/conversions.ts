import { v } from 'convex/values'

import { mutation, query } from '../_generated/server'
import { emitAnalyticsEvent } from '../domains/analytics/model'
import { requireApiInternalKey } from '../domains/apiKeys/model'
import { campaigns } from '../domains/campaigns/config'

export const scheduleSignup = mutation({
  args: {
    internalKey: v.string(),
    userId: v.id('users'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const campaignSlug = Object.entries(campaigns).find(
      ([, campaign]) => campaign.enabled && campaign.conversion.on.includes('user.signed_up'),
    )?.[0]
    if (campaignSlug === undefined) throw new Error('No signup conversion campaign configured')
    const now = Date.now()
    const attributionId = await ctx.db.insert('campaignAttributions', {
      campaignSlug,
      action: 'signup',
      acquiredByUserId: args.userId,
      signals: {},
      createdAt: now,
      expiresAt: now + 30_000,
    })
    await emitAnalyticsEvent(ctx, {
      id: `signup:${args.userId}`,
      name: 'user.signed_up',
      version: 1,
      at: now,
      origin: 'product_backend',
      userId: args.userId,
      attributionId,
      properties: {},
    })
    const instance = await ctx.db
      .query('conversionInstances')
      .withIndex('by_attribution_campaign', q =>
        q.eq('attributionId', attributionId).eq('campaignSlug', campaignSlug),
      )
      .unique()
    if (instance?.activeRunId === undefined) throw new Error('Conversion fixture did not start')
    return {
      instanceId: instance._id,
      runId: instance.activeRunId,
    }
  },
})

export const state = query({
  args: {
    internalKey: v.string(),
    instanceId: v.id('conversionInstances'),
    runId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const instance = await ctx.db.get(args.instanceId)
    if (instance === null) throw new Error('Conversion instance not found')
    const inputs = await ctx.db
      .query('conversionInputs')
      .withIndex('by_instance_enqueued', q => q.eq('instanceId', args.instanceId))
      .collect()
    return {
      activeRunId: instance.activeRunId,
      done: instance.doneAt !== undefined,
      inputs: inputs.map(input => input.inputKey),
      lastError: instance.lastError,
      state: instance.state,
    }
  },
})
