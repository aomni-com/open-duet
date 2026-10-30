import type { Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'

export type WorkspaceShareDirection = 'incoming' | 'outgoing'

export async function ensureWorkspaceShareDirectoryEntry(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    shareId: Id<'shares'>
    direction: WorkspaceShareDirection
    createdAt: number
  },
): Promise<boolean> {
  const existing = await ctx.db
    .query('workspaceShareDirectory')
    .withIndex('by_workspace_share_direction', query =>
      query
        .eq('workspaceId', args.workspaceId)
        .eq('shareId', args.shareId)
        .eq('direction', args.direction),
    )
    .unique()
  if (existing !== null) return false
  await ctx.db.insert('workspaceShareDirectory', args)
  return true
}
