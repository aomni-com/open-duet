import { v } from 'convex/values'

import { query } from '../_generated/server'
import { requireApiInternalKey } from '../domains/apiKeys/model'

export const listRawForTest = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('trainJobs')
      .withIndex('by_workspace', q => q.eq('workspaceId', args.workspaceId))
      .collect()
  },
})

export const completionWorkForTest = query({
  args: { internalKey: v.string(), jobId: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const key = `train_complete:${args.jobId}`
    const scheduled = await ctx.db.system.query('_scheduled_functions').collect()
    return scheduled.filter(
      row => (row.args[0] as { idempotencyKey?: string } | undefined)?.idempotencyKey === key,
    )
  },
})
