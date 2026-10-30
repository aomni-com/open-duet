import { v } from 'convex/values'

import { query } from '../_generated/server'
import { requireApiInternalKey } from '../domains/apiKeys/model'

export const listForTest = query({
  args: {
    internalKey: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    // Test suites create only a handful of feedback rows; cap the fixture so it
    // cannot become an unbounded production-deployment scan.
    return await ctx.db.query('feedback').take(1_000)
  },
})
