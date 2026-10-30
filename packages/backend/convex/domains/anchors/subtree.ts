import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { agentSharedReplicaAdapter } from '../agents/replication'
import { deleteAgentRow } from '../agents/teardown'
import { appSharedReplicaAdapter } from '../apps/replication'
import { deleteAppRow } from '../apps/teardown'
import { deletePublishRow } from '../publishes/teardown'

/**
 * Every anchor strictly inside a folder, in any state.
 *
 * Nesting is a path relation and nothing else — no row anywhere records that
 * one agent sits inside another, so "what does this folder contain" can only be
 * answered from the anchor paths. A prefix range on `by_workspace_and_path`
 * answers it in one index read: `'/'` (0x2f) is the byte before `'0'` (0x30),
 * so `['<path>/', '<path>0')` spans exactly the descendants and excludes both
 * the folder itself and same-prefix siblings like `<path>-old`.
 *
 * State is deliberately unfiltered. A caller tearing a folder down has to see
 * the broken and orphaned anchors too — those are precisely the rows that
 * outlived an earlier deletion, and skipping them is how residue accumulates.
 */
export async function anchorsUnderPath(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  path: string,
): Promise<Doc<'anchors'>[]> {
  if (path === '') throw new Error('Cannot enumerate the drive root as a subtree')
  const anchors = await ctx.db
    .query('anchors')
    .withIndex('by_workspace_and_path', q =>
      q.eq('workspaceId', workspaceId).gte('path', `${path}/`).lt('path', `${path}0`),
    )
    .take(SUBTREE_ANCHOR_READ_LIMIT + 1)
  // Refusing beats truncating. A teardown that silently stops at the cap leaves
  // exactly the residue this enumeration exists to prevent, and the workspace
  // read limits keep a real folder far below it.
  if (anchors.length > SUBTREE_ANCHOR_READ_LIMIT) throw new Error('Folder subtree too large')
  return anchors
}

/** Above any real folder's surface count, and equal to the workspace-wide anchor read limit. */
export const SUBTREE_ANCHOR_READ_LIMIT = 1000

/**
 * Fire an agent and take its folder's contents with it: the agent, then every
 * app, publish and sub-agent anchored inside its folder, recursively.
 *
 * Recursion needs no special case. The descendants are found by anchor path, so
 * a sub-agent three folders down is in the same flat list as a direct child, and
 * its apps are too. Firing the agent deletes the folder from the drive, and once
 * the folder is gone the rows inside it describe nothing — leaving them alive is
 * what stranded apps as unrepairable "folder link needs repair" phantoms.
 *
 * Ordering falls out of the path sort for free: a sub-agent sorts before
 * everything inside it, so its marketplace subscription is released before the
 * apps that subscription managed are reached.
 */
export async function deleteAgentSubtree(
  ctx: MutationCtx,
  args: { agent: Doc<'agents'>; anchor: Doc<'anchors'>; actorId: Id<'users'>; now: number },
): Promise<{ affectedRecipientWorkspaceIds: Id<'workspaces'>[] }> {
  const { agent, anchor, actorId, now } = args
  const affected = new Set<Id<'workspaces'>>()
  // The agent first: its marketplace detach releases the subscription's claim on
  // the apps below, so they are already unmanaged by the time we reach them.
  for (const workspaceId of (await deleteAgentRow(ctx, { agent, anchor, actorId, now }))
    .affectedRecipientWorkspaceIds) {
    affected.add(workspaceId)
  }
  for (const descendant of await anchorsUnderPath(ctx, agent.workspaceId, anchor.path)) {
    for (const workspaceId of (
      await deleteAnchorEntities(ctx, { anchor: descendant, actorId, now })
    ).affectedRecipientWorkspaceIds) {
      affected.add(workspaceId)
    }
  }
  return { affectedRecipientWorkspaceIds: [...affected] }
}

/**
 * Delete whichever app, agent or publish row claims this anchor, because the
 * folder it names is gone.
 *
 * Origins are torn down; replicas go out through the replica adapter instead,
 * because a replica is a projection of someone else's share rather than a thing
 * this workspace owns — no keys of its own to revoke, no replicas of its own to
 * reconcile. Deleting a replica whose folder vanished is not a new rule: it is
 * exactly what a `broken` anchor used to do for one, and it is what the Files
 * delete dialog promises in as many words.
 *
 * Shares on the anchor are left alone. A share is an agreement between two
 * workspaces, and unlinking one is its own rail's call to make.
 */
export async function deleteAnchorEntities(
  ctx: MutationCtx,
  args: { anchor: Doc<'anchors'>; actorId: Id<'users'>; now: number },
): Promise<{
  affectedRecipientWorkspaceIds: Id<'workspaces'>[]
  deleted: Array<'app' | 'agent' | 'publish'>
}> {
  const { anchor, actorId, now } = args
  const affected = new Set<Id<'workspaces'>>()
  const deleted: Array<'app' | 'agent' | 'publish'> = []
  const app = await ctx.db
    .query('apps')
    .withIndex('by_workspace_and_anchor', q =>
      q.eq('workspaceId', anchor.workspaceId).eq('anchorId', anchor._id),
    )
    .first()
  if (app !== null) {
    if (app.sourceShareId === undefined) {
      for (const workspaceId of (await deleteAppRow(ctx, { app, anchor, actorId, now }))
        .affectedRecipientWorkspaceIds) {
        affected.add(workspaceId)
      }
    } else {
      // A replica goes through its own rail, which knows a replica is a
      // projection rather than a thing anyone owns here. The product promises
      // this out loud — "Duet will remove the replica app automatically after it
      // detects the missing folder" — and a vanished folder IS that detection.
      await appSharedReplicaAdapter(ctx).deleteReplica(app, now)
      affected.add(app.workspaceId)
    }
    deleted.push('app')
  }
  const agent = await ctx.db
    .query('agents')
    .withIndex('by_anchor', q => q.eq('anchorId', anchor._id))
    .first()
  if (agent !== null) {
    if (agent.sourceShareId === undefined && agent.sourceAgentId === undefined) {
      for (const workspaceId of (await deleteAgentRow(ctx, { agent, anchor, actorId, now }))
        .affectedRecipientWorkspaceIds) {
        affected.add(workspaceId)
      }
    } else {
      await agentSharedReplicaAdapter(ctx).deleteReplica(agent, now)
      affected.add(agent.workspaceId)
    }
    deleted.push('agent')
  }
  const publish = await ctx.db
    .query('publishes')
    .withIndex('by_anchor', q => q.eq('anchorId', anchor._id))
    .first()
  if (publish !== null) {
    await deletePublishRow(ctx, { publish, anchor, actorId, now })
    deleted.push('publish')
  }
  return { affectedRecipientWorkspaceIds: [...affected], deleted }
}
