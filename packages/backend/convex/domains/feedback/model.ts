import { v } from 'convex/values'

import { mutation } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'

export const create = mutation({
  args: {
    internalKey: v.string(),
    content: v.string(),
    source: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db.insert('feedback', {
      content: args.content,
      ...(args.source === undefined ? {} : { source: args.source }),
      createdAt: args.now ?? Date.now(),
    })
  },
})
