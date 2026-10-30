import { MAX_AGENTS_PER_WORKSPACE } from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'

/** The single indexed definition of a live marketplace subscription. */
export async function liveSubscriptionsByWorkspace(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
): Promise<Doc<'agentSubscriptions'>[]> {
  const states = ['installing', 'active', 'error'] as const
  const pages = await Promise.all(
    states.map(state =>
      ctx.db
        .query('agentSubscriptions')
        .withIndex('by_workspace_and_state', q =>
          q.eq('workspaceId', workspaceId).eq('state', state),
        )
        .take(MAX_AGENTS_PER_WORKSPACE + 1),
    ),
  )
  const subscriptions = pages.flat()
  if (subscriptions.length > MAX_AGENTS_PER_WORKSPACE) {
    throw new Error('Too many marketplace agent subscriptions')
  }
  return subscriptions
}
