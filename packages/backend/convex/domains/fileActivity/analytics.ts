/* ============================================================================
   File-activity analytics: the product facts a recorded file event describes.

   Attribution is a join, and the rows it joins are hot. A `session:` actor
   resolves through `agentSessions`, which `relayRunnerEvent` patches on nearly
   every streamed turn event; an `api-key:` or `mirror:` actor resolves through
   `apiKeys`, which `authenticate` stamps on use. A mutation that reads one of
   those rows and also writes a page of file events loses every OCC retry to
   the row's own traffic under load (Convex error #1) — and it is the durable
   file-activity write that fails, not the analytics.

   So the ingest transaction never joins a principal row. It records, drafts
   the analytics it would emit, and schedules this module to finish the job in
   its own small transaction, where a lost race costs one analytics event and
   never the record. The draft carries everything but `userId`, which is the
   one field only the join can supply.
   ========================================================================= */
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'

import { type AnalyticsEvent, type DriveFileEvent } from '@repo/contract'

import type { Id } from '../../_generated/dataModel'
import { internalMutation, type MutationCtx } from '../../_generated/server'
import { PRODUCT_BACKEND_ANALYTICS_ORIGIN, emitAnalyticsEvents } from '../analytics/model'
import { resolveFileActorUsers } from './actors'

export interface FileAnalyticsDraft {
  actor: string
  event: Omit<AnalyticsEvent, 'userId'>
}

export function draftFileAnalytics(
  workspaceId: Id<'workspaces'>,
  event: DriveFileEvent,
  sequence: number,
): FileAnalyticsDraft {
  return {
    actor: event.actor,
    event: {
      id: `file:${workspaceId}:${sequence}`,
      name: fileAnalyticsName(event.kind),
      version: 1,
      at: event.at,
      origin: PRODUCT_BACKEND_ANALYTICS_ORIGIN,
      workspaceId,
      properties: {
        ...(event.kind === 'restore' ? {} : { path: event.path }),
        ...(event.kind === 'rename' ? { fromPath: event.fromPath } : {}),
        ...(event.kind === 'changed-summary' || event.kind === 'viewed-summary'
          ? { count: event.count }
          : {}),
        actorContext: event.actor,
      },
    },
  }
}

export async function scheduleFileAnalytics(
  ctx: MutationCtx,
  drafts: FileAnalyticsDraft[],
): Promise<void> {
  if (drafts.length === 0) return
  await ctx.scheduler.runAfter(0, emitFileAnalyticsRef, { drafts })
}

// A `system` restore or a `terminal` write names no person, so there is no
// product fact to report — only durable history, already written by the
// ingest. Analytics events describe what a user did.
export const emitFileAnalytics = internalMutation({
  args: { drafts: v.array(v.object({ actor: v.string(), event: v.any() })) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const users = await resolveFileActorUsers(
      ctx.db,
      args.drafts.map(draft => draft.actor),
    )
    const events: AnalyticsEvent[] = []
    for (const draft of args.drafts) {
      const userId = users.get(draft.actor)
      if (userId !== undefined) events.push({ ...draft.event, userId })
    }
    await emitAnalyticsEvents(ctx, events)
    return null
  },
})

const emitFileAnalyticsRef = makeFunctionReference<'mutation', { drafts: FileAnalyticsDraft[] }>(
  'domains/fileActivity/analytics:emitFileAnalytics',
)

function fileAnalyticsName(kind: DriveFileEvent['kind']): AnalyticsEvent['name'] {
  switch (kind) {
    case 'create':
      return 'file.created'
    case 'write':
      return 'file.written'
    case 'delete':
      return 'file.deleted'
    case 'rename':
      return 'file.renamed'
    case 'read':
      return 'file.read'
    case 'changed-summary':
      return 'file.written'
    case 'viewed-summary':
      return 'file.read'
    case 'restore':
      return 'file.restored'
  }
}
