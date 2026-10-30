import type { Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'

export async function bindCreditTransactionPagination(
  ctx: MutationCtx,
  transactionId: Id<'creditTransactions'>,
) {
  await ctx.db.patch(transactionId, { paginationId: transactionId })
}
