import { v } from 'convex/values'

import { mutation, query } from '../_generated/server'
import { requireApiInternalKey } from '../domains/apiKeys/model'
import {
  currentSeedBundleImpl,
  generateSeedBundleUploadUrlImpl,
  recordSeedBundleImpl,
  seedWorkspaceAtBirth,
} from '../domains/workspaces/seed'

export const generateSeedBundleUploadUrl = mutation({
  args: { internalKey: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await generateSeedBundleUploadUrlImpl(ctx)
  },
})

export const recordSeedBundle = mutation({
  args: {
    internalKey: v.string(),
    sha256: v.string(),
    storageId: v.id('_storage'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await recordSeedBundleImpl(ctx, args)
  },
})

export const currentSeedBundle = query({
  args: { internalKey: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await currentSeedBundleImpl(ctx)
  },
})

export const rawSeedDriveBundles = query({
  args: { internalKey: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db.query('seedDriveBundles').take(100)
  },
})

export const seedWorkspaceAtBirthForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    actorId: v.id('users'),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await seedWorkspaceAtBirth(ctx, args)
  },
})

export const clearCurrentSeedBundleForTest = mutation({
  args: { internalKey: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const current = await ctx.db
      .query('seedDriveBundles')
      .withIndex('by_current', q => q.eq('current', true))
      .unique()
    if (current !== null) await ctx.db.patch(current._id, { current: false })
  },
})

export const deleteSeedStorageForTest = mutation({
  args: { internalKey: v.string(), storageId: v.id('_storage') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.storage.delete(args.storageId)
  },
})
