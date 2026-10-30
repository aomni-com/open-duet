import { v } from 'convex/values'

import { mutation } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { recordBatch } from './model'

// Ingest seam for the API relay (slice 03). The batch payload is validated
// against the contract FileEventBatchSchema inside recordBatch.
export const recordBatchFromApi = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    batch: v.any(),
    now: v.optional(v.number()),
  },
  returns: v.object({
    deduped: v.boolean(),
    appended: v.number(),
    lastSeq: v.number(),
  }),
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) throw new Error('Workspace not found')
    return await recordBatch(ctx, {
      workspaceId: args.workspaceId,
      batch: args.batch,
      now: args.now ?? Date.now(),
    })
  },
})
