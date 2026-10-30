import { v } from 'convex/values'

import { mutation, query } from '../_generated/server'
import { requireApiInternalKey } from '../domains/apiKeys/model'
import {
  listingByPublisherAndAgent,
  resolveListingOrigin,
  registerListingImpl,
  resolveListingMetadata,
} from '../domains/marketplace/listings'

export const registerListingImplForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    agentId: v.id('agents'),
    anchorId: v.id('anchors'),
    publishId: v.id('publishes'),
    agentName: v.string(),
    actorId: v.id('users'),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await registerListingImpl(ctx, {
      workspaceId: args.workspaceId,
      agentId: args.agentId,
      anchorId: args.anchorId,
      publishId: args.publishId,
      agentName: args.agentName,
      agentSubpath: '',
      derived: {
        title: 'Bounded listing',
        summary: 'Summary',
        skills: [],
        changelog: '',
        tags: [],
      },
      actorId: args.actorId,
      now: args.now,
      publishingEnabled: true,
    })
  },
})

/**
 * Insert a listing directly. Real registration arrives in slice 06; until then
 * this is how fixtures put a listing row in front of the model under test.
 */
/** Stand in for a hub sync press, so a test can prove a report cannot overwrite. */
export const stampListingRevisionForTest = mutation({
  args: {
    internalKey: v.string(),
    listingId: v.id('agentListings'),
    contentRevision: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.patch(args.listingId, {
      contentRevision: args.contentRevision,
      updatedAt: args.now,
    })
  },
})

export const insertListingForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    agentId: v.id('agents'),
    anchorId: v.id('anchors'),
    publishId: v.id('publishes'),
    agentName: v.string(),
    agentSubpath: v.string(),
    createdByUserId: v.id('users'),
    titleOverride: v.optional(v.string()),
    summaryOverride: v.optional(v.string()),
    derivedTitle: v.optional(v.string()),
    derivedSummary: v.optional(v.string()),
    contentRevision: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db.insert('agentListings', {
      workspaceId: args.workspaceId,
      agentId: args.agentId,
      anchorId: args.anchorId,
      publishId: args.publishId,
      agentName: args.agentName,
      agentSubpath: args.agentSubpath,
      state: 'listed',
      availability: 'available',
      installs: 0,
      ...(args.contentRevision === undefined ? {} : { contentRevision: args.contentRevision }),
      ...(args.titleOverride === undefined ? {} : { titleOverride: args.titleOverride }),
      ...(args.summaryOverride === undefined ? {} : { summaryOverride: args.summaryOverride }),
      ...(args.derivedTitle === undefined && args.derivedSummary === undefined
        ? {}
        : {
            derived: {
              title: args.derivedTitle ?? '',
              summary: args.derivedSummary ?? '',
              skills: [],
              changelog: '',
            },
          }),
      createdByUserId: args.createdByUserId,
      createdAt: args.now,
      updatedAt: args.now,
    })
  },
})

export const resolvedListingForTest = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    agentName: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const listing = await listingByPublisherAndAgent(ctx, args)
    if (listing === null) return null
    return {
      metadata: resolveListingMetadata(listing),
      sourceUrl: (await resolveListingOrigin(ctx, listing))?.sourceUrl ?? null,
    }
  },
})

export const deletePublishRowForTest = mutation({
  args: { internalKey: v.string(), publishId: v.id('publishes') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.delete(args.publishId)
  },
})

export const markVerifiedPublisherForTest = mutation({
  args: { internalKey: v.string(), workspaceId: v.id('workspaces'), now: v.number() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.patch(args.workspaceId, { verifiedPublisherAt: args.now })
  },
})

export const seedSubscriptionListHistoryForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    listingId: v.id('agentListings'),
    createdByUserId: v.id('users'),
    detachedCount: v.number(),
    live: v.array(
      v.object({
        agentName: v.string(),
        path: v.string(),
        state: v.union(v.literal('installing'), v.literal('active'), v.literal('error')),
      }),
    ),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    for (let index = 0; index < args.detachedCount; index += 1) {
      await ctx.db.insert('agentSubscriptions', {
        workspaceId: args.workspaceId,
        listingId: args.listingId,
        agentName: `detached-${String(index).padStart(4, '0')}`,
        path: `agents/detached-${String(index).padStart(4, '0')}`,
        mode: 'clone_once',
        state: 'detached',
        createdByUserId: args.createdByUserId,
        createdAt: index,
        updatedAt: index,
      })
    }
    for (const [index, row] of args.live.entries()) {
      await ctx.db.insert('agentSubscriptions', {
        workspaceId: args.workspaceId,
        listingId: args.listingId,
        agentName: row.agentName,
        path: row.path,
        mode: 'subscribe',
        state: row.state,
        createdByUserId: args.createdByUserId,
        createdAt: args.detachedCount + index,
        updatedAt: args.detachedCount + index,
      })
    }
  },
})

export const publishBySlugForTest = query({
  args: { internalKey: v.string(), workspaceId: v.id('workspaces'), slug: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('publishes')
      .withIndex('by_workspace_and_slug', q =>
        q.eq('workspaceId', args.workspaceId).eq('slug', args.slug),
      )
      .unique()
  },
})

/**
 * Force a listing's catalog state or availability. Availability is written in
 * production ONLY by `sweepListingAvailability`; a test that needs a dead
 * listing states that directly rather than staging a dead publisher.
 */
export const setListingStateForTest = mutation({
  args: {
    internalKey: v.string(),
    listingId: v.id('agentListings'),
    state: v.optional(v.union(v.literal('listed'), v.literal('unlisted'), v.literal('removed'))),
    availability: v.optional(v.union(v.literal('available'), v.literal('unavailable'))),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.patch(args.listingId, {
      ...(args.state === undefined ? {} : { state: args.state }),
      ...(args.availability === undefined
        ? {}
        : {
            availability: args.availability,
            unavailableSince: args.availability === 'unavailable' ? args.now : undefined,
          }),
      updatedAt: args.now,
    })
  },
})

export const rawSubscriptionsForTest = query({
  args: { internalKey: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('agentSubscriptions')
      .withIndex('by_workspace', q => q.eq('workspaceId', args.workspaceId))
      .take(10_000)
  },
})

export const rawListingsForTest = query({
  args: { internalKey: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db.query('agentListings').take(1000)
  },
})
