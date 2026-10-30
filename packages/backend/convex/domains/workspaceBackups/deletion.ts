import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'

import type { Id } from '../../_generated/dataModel'
import { internalMutation, type MutationCtx } from '../../_generated/server'

export const deleteWorkspaceBackups = internalMutation({
  args: { workspaceId: v.id('workspaces'), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await deleteWorkspaceBackupPage(ctx, args)
    if (page && !page.isDone)
      await ctx.scheduler.runAfter(0, deletionPage, {
        workspaceId: args.workspaceId,
        cursor: page.continueCursor,
      })
  },
})

export async function deleteWorkspaceBackupPage(
  ctx: MutationCtx,
  args: { workspaceId: Id<'workspaces'>; cursor: string | null },
) {
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace?.status !== 'deleted') return null
  const page = await ctx.db
    .query('workspaceBackups')
    .withIndex('by_workspace', q => q.eq('workspaceId', args.workspaceId))
    .paginate({ cursor: args.cursor, numItems: 100 })
  for (const job of page.page) {
    await ctx.db.patch(job._id, {
      status: 'deleting',
      pendingLifecycleOperation: undefined,
      objectCleanupPending: true,
      phase: undefined,
      updatedAt: Date.now(),
    })
    await ctx.scheduler.runAfter(0, backupTick, { backupId: job._id })
  }
  return page
}

export const deletionPage = makeFunctionReference<'mutation'>(
  'domains/workspaceBackups/deletion:deleteWorkspaceBackups',
)
const backupTick = makeFunctionReference<'action'>('domains/workspaceBackups/dispatch:tick')
