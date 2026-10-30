import type { Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'

export async function anchorHasLiveConsumer(
  ctx: QueryCtx | MutationCtx,
  anchorId: Id<'anchors'>,
): Promise<boolean> {
  const anchor = await ctx.db.get(anchorId)
  if (anchor === null) throw new Error('Anchor not found')
  const [app, agent, publish, activeShare] = await Promise.all([
    ctx.db
      .query('apps')
      .withIndex('by_workspace_and_anchor', q =>
        q.eq('workspaceId', anchor.workspaceId).eq('anchorId', anchorId),
      )
      .first(),
    ctx.db
      .query('agents')
      .withIndex('by_anchor', q => q.eq('anchorId', anchorId))
      .first(),
    ctx.db
      .query('publishes')
      .withIndex('by_anchor', q => q.eq('anchorId', anchorId))
      .first(),
    ctx.db
      .query('shares')
      .withIndex('by_anchor', q => q.eq('anchorId', anchorId))
      // A share is a live consumer while its invite is outstanding OR accepted;
      // 'pending' counts too, else deleting an entity with an unaccepted share
      // would orphan the origin anchor and strand the invite (accept would
      // succeed but the origin anchor, now inactive, never projects to sync).
      // Only 'revoked'/'unlinked' are terminal.
      .filter(q => q.or(q.eq(q.field('state'), 'active'), q.eq(q.field('state'), 'pending')))
      .first(),
  ])
  return app !== null || agent !== null || publish !== null || activeShare !== null
}
