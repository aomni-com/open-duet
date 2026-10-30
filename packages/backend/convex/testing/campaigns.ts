import { v } from 'convex/values'

import { query } from '../_generated/server'
import { requireApiInternalKey } from '../domains/apiKeys/model'

export const listAttributionsForTest = query({
  args: { internalKey: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db.query('campaignAttributions').take(1_000)
  },
})
