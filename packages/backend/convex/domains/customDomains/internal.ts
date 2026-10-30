import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'

import { internalMutation, internalQuery } from '../../_generated/server'
import { throwDomainError } from './model'

export const listCleanupFailures = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), limit: v.number() },
  handler: async (ctx, args) => {
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)
      throwDomainError('invalid_request')
    const page = await ctx.db
      .query('customDomains')
      .withIndex('by_cleanup_failure', q =>
        q.eq('status', 'removing').gt('repairReason', undefined),
      )
      .paginate({ cursor: args.cursor, numItems: Math.min(20, args.limit) })
    return {
      ...page,
      page: page.page.map(row => ({
        domainId: row._id,
        hostname: row.hostname,
        target: row.target,
        error: row.lastError,
        ...(row.repairReason === 'uncertain' ? { operatorRepairRequired: true } : {}),
      })),
    }
  },
})
export const retryCleanup = internalMutation({
  args: { domainId: v.id('customDomains'), effectSettlementConfirmed: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.domainId)
    if (row === null) return null
    if (row.status !== 'removing') throwDomainError('invalid_request')
    if (row.repairReason === 'uncertain' && args.effectSettlementConfirmed !== true)
      throwDomainError('invalid_request')
    if (!row.workRunning) {
      await ctx.db.patch(row._id, {
        cleanupAttempts: 0,
        repairReason: undefined,
        effectState: undefined,
        nextWorkAt: Date.now(),
        updatedAt: Date.now(),
      })
      await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<'mutation'>('domains/customDomains/work:dispatchDue'),
        {},
      )
    }
    return { domainId: row._id }
  },
})
