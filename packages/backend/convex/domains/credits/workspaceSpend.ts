import { currentMonthKey } from '@repo/contract'

import type { Doc } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'

async function spendingRow(ctx: Pick<QueryCtx, 'db'>, workspace: Doc<'workspaces'>) {
  return await ctx.db
    .query('workspaceSpending')
    .withIndex('by_workspace', q => q.eq('workspaceId', workspace._id))
    .unique()
}

export async function workspaceMonthlySpend(
  ctx: Pick<QueryCtx, 'db'>,
  workspace: Doc<'workspaces'>,
  now = Date.now(),
): Promise<number> {
  const row = await spendingRow(ctx, workspace)
  // Compatibility until backfillWorkspaceSpending completes on every deployment.
  const stored = row ?? workspace.billing
  return stored?.monthlySpendPeriodKey === currentMonthKey(now)
    ? (stored.monthlySpendMicroUsd ?? 0)
    : 0
}

export async function adjustWorkspaceMonthlySpend(
  ctx: Pick<MutationCtx, 'db'>,
  workspace: Doc<'workspaces'>,
  deltaMicroUsd: number,
  now = Date.now(),
): Promise<void> {
  if (deltaMicroUsd === 0) return
  const row = await spendingRow(ctx, workspace)
  const stored = row ?? workspace.billing
  const monthlySpendPeriodKey = currentMonthKey(now)
  if (
    stored?.monthlySpendPeriodKey !== undefined &&
    stored.monthlySpendPeriodKey > monthlySpendPeriodKey
  )
    return
  const previous =
    stored?.monthlySpendPeriodKey === monthlySpendPeriodKey ? (stored.monthlySpendMicroUsd ?? 0) : 0
  const value = {
    monthlySpendPeriodKey,
    monthlySpendMicroUsd: Math.max(0, previous + deltaMicroUsd),
  }
  if (row === null)
    await ctx.db.insert('workspaceSpending', { workspaceId: workspace._id, ...value })
  else await ctx.db.patch(row._id, value)
}

export async function backfillWorkspaceSpendingRow(ctx: MutationCtx, workspace: Doc<'workspaces'>) {
  const billing = workspace.billing
  if (billing?.monthlySpendPeriodKey === undefined) return
  if ((await spendingRow(ctx, workspace)) === null) {
    await ctx.db.insert('workspaceSpending', {
      workspaceId: workspace._id,
      monthlySpendPeriodKey: billing.monthlySpendPeriodKey,
      monthlySpendMicroUsd: billing.monthlySpendMicroUsd ?? 0,
    })
  }
  await ctx.db.patch(workspace._id, {
    billing: { maxMonthlySpendMicroUsd: billing.maxMonthlySpendMicroUsd },
  })
}
