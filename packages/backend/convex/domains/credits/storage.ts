import { CreditTransactionReferenceSchema } from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { assertCreditTransactionMetadataBound } from './metadata'

type StoredCreditTransaction = Omit<Doc<'creditTransactions'>, '_id' | '_creationTime'>

/** The one insertion seam for both workspace and account ledger rows. */
export async function insertCreditTransaction(
  ctx: MutationCtx,
  row: StoredCreditTransaction,
): Promise<Id<'creditTransactions'>> {
  if (row.metadata !== undefined) assertCreditTransactionMetadataBound(row.metadata)
  const reference = CreditTransactionReferenceSchema.parse(row.reference)
  if (row.workspaceId === undefined) {
    return await ctx.db.insert('creditTransactions', {
      ...row,
      reference,
      workspaceName: undefined,
    })
  }
  const workspace = await ctx.db.get(row.workspaceId)
  if (workspace === null) throw new Error('Workspace not found')
  return await ctx.db.insert('creditTransactions', {
    ...row,
    reference,
    workspaceName: workspace.name,
  })
}
