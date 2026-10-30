import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { anchorHasLiveConsumer } from '../anchors/consumers'
import { revokeAppKeysForApp } from '../apiKeys/model'
import { writeAuditEvent } from '../audit/model'
import { beginDomainRemovalForApp } from '../customDomains/model'
import { reconcileReplicasForOriginApp } from './replication'

/**
 * Tear down one app row: its keys, the row, its anchor's consumer claim, its
 * replicas, and the audit trail.
 *
 * This lives apart from `deleteApp` because three callers now need it — a user
 * deleting one app, firing an agent whose folder holds the app, and reaping an
 * app whose folder is gone — and a second copy of the sequence is how a cascade
 * quietly forgets to revoke a key.
 *
 * `deleteApp`'s refusals stay with the mutation: replica apps are read-only and
 * marketplace-managed apps belong to their subscription. Those answer "may this
 * caller delete this one app", which is a different question from "this app's
 * folder is gone, take the row with it".
 *
 * The anchor is passed in rather than read here. Every caller already holds it,
 * and taking it as an argument keeps this module off `anchors/model`.
 */
export async function deleteAppRow(
  ctx: MutationCtx,
  args: { app: Doc<'apps'>; anchor: Doc<'anchors'>; actorId: Id<'users'>; now: number },
): Promise<{ affectedRecipientWorkspaceIds: Id<'workspaces'>[] }> {
  const { app, anchor, actorId, now } = args
  await revokeAppKeysForApp(ctx, { app, now })
  await beginDomainRemovalForApp(ctx, app._id, now, { orphan: true })
  await ctx.db.delete(app._id)
  if (!(await anchorHasLiveConsumer(ctx, app.anchorId))) {
    await ctx.db.patch(app.anchorId, { state: 'orphaned', updatedAt: now })
  }
  const fanout = await reconcileReplicasForOriginApp(ctx, { originApp: app, now })
  await writeAuditEvent(ctx, {
    workspaceId: app.workspaceId,
    event: 'app.deleted',
    actorId,
    at: now,
    provenance: { appId: app._id, anchorId: app.anchorId, path: anchor.path, slug: app.slug },
  })
  return fanout
}
