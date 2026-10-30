import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'

export async function transactionByReference(
  ctx: MutationCtx,
  args: { reference: string; userId?: Id<'users'> },
): Promise<Doc<'creditTransactions'> | null> {
  if (args.userId === undefined) {
    return await ctx.db
      .query('creditTransactions')
      .withIndex('by_reference', q => q.eq('reference', args.reference))
      .first()
  }
  const userId = args.userId
  return await ctx.db
    .query('creditTransactions')
    .withIndex('by_user_reference', q => q.eq('userId', userId).eq('reference', args.reference))
    .first()
}
