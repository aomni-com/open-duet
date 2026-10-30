import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { anchorHasLiveConsumer } from '../anchors/consumers'
import { writeAuditEvent } from '../audit/model'

/**
 * Tear down one publish row: the row, its anchor's consumer claim, and the
 * audit trail.
 *
 * The anchor is passed in rather than read here — see the note on
 * `deleteAppRow`, which this mirrors.
 */
export async function deletePublishRow(
  ctx: MutationCtx,
  args: { publish: Doc<'publishes'>; anchor: Doc<'anchors'>; actorId: Id<'users'>; now: number },
): Promise<void> {
  const { publish, anchor, actorId, now } = args
  await ctx.db.delete(publish._id)
  if (!(await anchorHasLiveConsumer(ctx, publish.anchorId))) {
    await ctx.db.patch(publish.anchorId, { state: 'orphaned', updatedAt: now })
  }
  await writeAuditEvent(ctx, {
    workspaceId: publish.workspaceId,
    event: 'publish.deleted',
    actorId,
    at: now,
    provenance: {
      publishId: publish._id,
      anchorId: publish.anchorId,
      path: anchor.path,
      slug: publish.slug,
    },
  })
}
