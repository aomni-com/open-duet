import { MAX_APPS_PER_WORKSPACE } from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { revokeAppKeysForApp } from '../apiKeys/model'

export async function detachMarketplaceAgentSubscription(
  ctx: MutationCtx,
  subscription: Doc<'agentSubscriptions'>,
  now: number,
): Promise<void> {
  // This is the ordinary live -> detached transition owner. Takedown deliberately
  // uses `releaseMarketplaceAgentOwnership` instead because it zeros the listing
  // before draining subscriptions in bounded batches.
  if (subscription.mode === 'subscribe' && subscription.state !== 'detached') {
    await adjustInstallCount(ctx, subscription.listingId, -1, now)
  }
  await releaseMarketplaceAgentOwnership(ctx, subscription, now)
  await ctx.db.patch(subscription._id, { state: 'detached', updatedAt: now })
}

/** Install counts move only on live `subscribe` transitions. */
export async function adjustInstallCount(
  ctx: MutationCtx,
  listingId: Id<'agentListings'>,
  delta: 1 | -1,
  now: number,
): Promise<void> {
  const listing = await ctx.db.get(listingId)
  if (listing === null) return
  await ctx.db.patch(listing._id, {
    installs: Math.max(0, listing.installs + delta),
    updatedAt: now,
  })
}

export async function releaseMarketplaceAgentOwnership(
  ctx: MutationCtx,
  subscription: Doc<'agentSubscriptions'>,
  now: number,
): Promise<void> {
  if (subscription.agentId !== undefined) {
    const agent = await ctx.db.get(subscription.agentId)
    if (agent?.listingSubscriptionId === subscription._id) {
      await ctx.db.patch(agent._id, { listingSubscriptionId: undefined, updatedAt: now })
    }
  }
  const apps = await ctx.db
    .query('apps')
    .withIndex('by_listing_subscription', q => q.eq('listingSubscriptionId', subscription._id))
    .take(MAX_APPS_PER_WORKSPACE + 1)
  if (apps.length > MAX_APPS_PER_WORKSPACE) {
    throw new Error('Marketplace subscription app limit exceeded')
  }
  for (const app of apps) {
    await revokeAppKeysForApp(ctx, { app, now })
    await ctx.db.patch(app._id, {
      listingSubscriptionId: undefined,
      disabledAt: undefined,
      disabledByUserId: undefined,
      updatedAt: now,
    })
  }
}
