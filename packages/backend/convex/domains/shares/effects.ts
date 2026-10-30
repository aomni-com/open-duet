import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { anchorHasLiveConsumer } from '../anchors/consumers'
import { writeAuditEvent } from '../audit/model'
import { sharedReplicaAdapters } from '../replication/adapters'
import { deleteSharedReplicasForShare, detachSharedReplicasForShare } from '../replication/shared'
import { transitionShareLifecycle, type ShareLifecycleState } from './lifecycle'

export const SHARE_GRAPH_READ_LIMIT = 500

export async function unlinkActiveShare(
  ctx: MutationCtx,
  args: {
    share: Doc<'shares'>
    actorId: Id<'users'>
    now: number
    reason?: string
  },
): Promise<{
  unlinkedShareIds: Id<'shares'>[]
  revokedShareIds: Id<'shares'>[]
  affectedRecipientWorkspaceIds: Id<'workspaces'>[]
}> {
  const transition = transitionShareLifecycle(args.share.state, { kind: 'unlink' }, args.now)
  const detached = await detachSharedReplicasForShare(
    sharedReplicaAdapters(ctx),
    args.share._id,
    args.now,
  )
  if (
    args.share.mountAnchorId !== undefined &&
    !detached.preservedAnchorIds.includes(args.share.mountAnchorId)
  ) {
    await ctx.db.delete(args.share.mountAnchorId)
  }
  await ctx.db.patch(args.share._id, {
    ...transition.patch,
    mountAnchorId: undefined,
    activeKey: undefined,
    sync: undefined,
  })
  if (!(await anchorHasLiveConsumer(ctx, args.share.anchorId))) {
    await ctx.db.patch(args.share.anchorId, { state: 'orphaned', updatedAt: args.now })
  }
  await deleteShareSyncRealizations(ctx, args.share._id)
  const affectedRecipientWorkspaceIds = new Set<Id<'workspaces'>>()
  if (args.share.toWorkspaceId !== undefined) {
    affectedRecipientWorkspaceIds.add(args.share.toWorkspaceId)
  }
  const revokedShareIds = await revokeDescendants(
    ctx,
    args.share._id,
    args.now,
    affectedRecipientWorkspaceIds,
  )
  await writeAuditEvent(ctx, {
    workspaceId: args.share.originWorkspaceId,
    event: 'share.unlinked',
    actorId: args.actorId,
    at: args.now,
    provenance: {
      shareId: args.share._id,
      revokedShareIds,
      ...(args.reason === undefined ? {} : { reason: args.reason }),
    },
  })
  return {
    unlinkedShareIds: [args.share._id],
    revokedShareIds,
    affectedRecipientWorkspaceIds: [...affectedRecipientWorkspaceIds],
  }
}

export async function cascadeRevokeShares(
  ctx: MutationCtx,
  rootShareId: Id<'shares'>,
  now: number,
  affectedRecipientWorkspaceIds?: Set<Id<'workspaces'>>,
): Promise<Id<'shares'>[]> {
  const queue: Id<'shares'>[] = [rootShareId]
  const revoked: Id<'shares'>[] = []
  for (let index = 0; index < queue.length; index += 1) {
    const shareId = queue[index]!
    const share = await requireShare(ctx, shareId)
    if (share.toWorkspaceId !== undefined) affectedRecipientWorkspaceIds?.add(share.toWorkspaceId)
    const transition = transitionShareLifecycle(
      share.state as ShareLifecycleState,
      { kind: 'revoke' },
      now,
    )
    if (transition.intent === 'delete-replicas') {
      await deleteSharedReplicasForShare(sharedReplicaAdapters(ctx), shareId, now)
    }
    if (share.mountAnchorId !== undefined) await ctx.db.delete(share.mountAnchorId)
    if (Object.keys(transition.patch).length > 0) {
      await ctx.db.patch(shareId, {
        ...transition.patch,
        mountAnchorId: undefined,
        activeKey: undefined,
        sync: undefined,
      })
      revoked.push(shareId)
    }
    if (!(await anchorHasLiveConsumer(ctx, share.anchorId))) {
      await ctx.db.patch(share.anchorId, { state: 'orphaned', updatedAt: now })
    }
    await deleteShareSyncRealizations(ctx, shareId)
    queue.push(...(await shareChildren(ctx, shareId)).map(child => child._id))
  }
  return revoked
}

async function deleteShareSyncRealizations(ctx: MutationCtx, shareId: Id<'shares'>): Promise<void> {
  const rows = await ctx.db
    .query('shareSyncRealizations')
    .withIndex('by_share', q => q.eq('shareId', shareId))
    .take(SHARE_GRAPH_READ_LIMIT)
  for (const row of rows) {
    await ctx.db.delete(row._id)
  }
}

export async function shareChildren(ctx: QueryCtx | MutationCtx, shareId: Id<'shares'>) {
  const children = await ctx.db
    .query('shares')
    .withIndex('by_parent', q => q.eq('parentShareId', shareId))
    .take(SHARE_GRAPH_READ_LIMIT + 1)
  if (children.length > SHARE_GRAPH_READ_LIMIT) throw new Error('Share child limit exceeded')
  return children
}

async function revokeDescendants(
  ctx: MutationCtx,
  rootShareId: Id<'shares'>,
  now: number,
  affectedRecipientWorkspaceIds?: Set<Id<'workspaces'>>,
): Promise<Id<'shares'>[]> {
  const children = await shareChildren(ctx, rootShareId)
  const revoked: Id<'shares'>[] = []
  for (const child of children) {
    revoked.push(...(await cascadeRevokeShares(ctx, child._id, now, affectedRecipientWorkspaceIds)))
  }
  return revoked
}

async function requireShare(
  ctx: QueryCtx | MutationCtx,
  shareId: Id<'shares'>,
): Promise<Doc<'shares'>> {
  const share = await ctx.db.get(shareId)
  if (share === null) throw new Error('Share not found')
  return share
}
