import { v } from 'convex/values'

import { AnalyticsEventSchema } from '@repo/contract'

import { mutation } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { emitAnalyticsEvent } from './model'

export const emitFromApi = mutation({
  args: {
    internalKey: v.string(),
    event: v.any(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await emitAnalyticsEvent(ctx, AnalyticsEventSchema.parse(args.event))
    return { accepted: true as const }
  },
})
