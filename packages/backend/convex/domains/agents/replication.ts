import { MAX_AGENTS_PER_WORKSPACE } from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { getOrCreateAnchorForPath } from '../anchors/model'
import {
  availableSharedReplicaSlug,
  convexSharedReplicaGraph,
  reconcileSharedReplicasForOrigin,
  type SharedReplicaAdapter,
} from '../replication/shared'
import { MAX_ACTIVE_SHARES_PER_WORKSPACE_SYNC } from '../shares/syncProjection'

export async function loadWorkspaceAgents(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
): Promise<Doc<'agents'>[]> {
  const agents = await ctx.db
    .query('agents')
    .withIndex('by_workspace', q => q.eq('workspaceId', workspaceId))
    .take(MAX_AGENTS_PER_WORKSPACE + 1)
  if (agents.length > MAX_AGENTS_PER_WORKSPACE) throw new Error('Workspace agent limit exceeded')
  return agents
}

export async function reconcileReplicasForOriginAgent(
  ctx: MutationCtx,
  args: (
    | { originAgent: Doc<'agents'>; originAgentId?: never }
    | { originAgentId: Id<'agents'>; originAgent?: never }
  ) & { now: number; metadataWasExplicitlyUpdated?: boolean },
): Promise<{ affectedRecipientWorkspaceIds: Id<'workspaces'>[] }> {
  const originAgentId = args.originAgent?._id ?? args.originAgentId
  if (originAgentId === undefined) throw new Error('originAgent or originAgentId is required')
  const result = await reconcileSharedReplicasForOrigin(
    convexSharedReplicaGraph(ctx),
    agentSharedReplicaAdapter(ctx),
    args.originAgent === undefined ? { id: originAgentId } : { row: args.originAgent },
    args.now,
    { metadataWasExplicitlyUpdated: args.metadataWasExplicitlyUpdated },
  )
  return {
    affectedRecipientWorkspaceIds: result.affectedRecipientWorkspaceIds as Id<'workspaces'>[],
  }
}

export async function requireWriteModeReplicaOriginAgent(
  ctx: MutationCtx,
  replica: Doc<'agents'>,
): Promise<Doc<'agents'>> {
  if (replica.sourceShareId === undefined || replica.sourceAgentId === undefined) {
    throw new Error('Replica agent source is missing')
  }
  let shareId: Id<'shares'> | undefined = replica.sourceShareId
  while (shareId !== undefined) {
    const share: Doc<'shares'> | null = await ctx.db.get(shareId)
    if (share === null || share.state !== 'active' || share.mode !== 'write') {
      throw new Error('Replica agents are read-only')
    }
    shareId = share.parentShareId
  }
  const origin = await ctx.db.get(replica.sourceAgentId)
  if (origin === null || origin.sourceShareId !== undefined) {
    throw new Error('Replica agent source is missing')
  }
  return origin
}

export function agentSharedReplicaAdapter(ctx: MutationCtx): SharedReplicaAdapter<Doc<'agents'>> {
  return {
    resourceName: 'agent',
    loadOrigin: async id => await ctx.db.get(id as Id<'agents'>),
    loadOriginsForWorkspace: async workspaceId =>
      await loadWorkspaceAgents(ctx, workspaceId as Id<'workspaces'>),
    loadReplicas: async originId => {
      const replicas = await ctx.db
        .query('agents')
        .withIndex('by_source_agent', q => q.eq('sourceAgentId', originId as Id<'agents'>))
        .take(MAX_ACTIVE_SHARES_PER_WORKSPACE_SYNC + 1)
      if (replicas.length > MAX_ACTIVE_SHARES_PER_WORKSPACE_SYNC) {
        throw new Error('Origin agent replica limit exceeded')
      }
      return replicas
    },
    loadReplicasForShare: async shareId => {
      const replicas = await ctx.db
        .query('agents')
        .withIndex('by_source_share', q => q.eq('sourceShareId', shareId as Id<'shares'>))
        .take(MAX_AGENTS_PER_WORKSPACE + 1)
      if (replicas.length > MAX_AGENTS_PER_WORKSPACE) {
        throw new Error('Share agent replica limit exceeded')
      }
      return replicas
    },
    projectOrigin: agent => ({
      id: agent._id,
      workspaceId: agent.workspaceId,
      anchorId: agent.anchorId,
      actorId: agent.createdByUserId,
      isReplica: agent.sourceShareId !== undefined,
    }),
    projectReplica: agent => ({
      shareId: agent.sourceShareId ?? '',
      workspaceId: agent.workspaceId,
      disabled: agent.disabledAt !== undefined,
    }),
    assertCanSeedReplicas: async (recipientWorkspaceId, replicaCount) => {
      const recipientAgents = await loadWorkspaceAgents(
        ctx,
        recipientWorkspaceId as Id<'workspaces'>,
      )
      if (recipientAgents.length + replicaCount > MAX_AGENTS_PER_WORKSPACE) {
        throw new Error('Workspace agent limit exceeded')
      }
    },
    createReplica: async context => {
      const recipientWorkspaceId = context.share.recipientWorkspaceId as Id<'workspaces'>
      const recipientAgents = await loadWorkspaceAgents(ctx, recipientWorkspaceId)
      if (recipientAgents.length >= MAX_AGENTS_PER_WORKSPACE) {
        throw new Error('Workspace agent limit exceeded')
      }
      const slug = availableSharedReplicaSlug(
        new Set(recipientAgents.map(agent => agent.slug)),
        context.origin.row.slug,
      )
      /* The adopting owner: reuses the share-mount anchor when the replica IS
         the mount root, revives an orphaned tombstone left by any earlier
         life at the path, and refuses live claims with a typed error instead
         of the bare creator's 500. */
      const anchor = await getOrCreateAnchorForPath(ctx, {
        workspaceId: recipientWorkspaceId,
        path: context.replicaPath,
        kind: 'agent',
        compatibleExistingKinds: ['share-mount'],
        kindConflictError: 'Replica path is already claimed by something else',
        settings: {},
        actorId: context.actorId as Id<'users'>,
        now: context.now,
      })
      await ctx.db.insert('agents', {
        workspaceId: recipientWorkspaceId,
        anchorId: anchor.id as Id<'anchors'>,
        slug,
        name: context.origin.row.name,
        icon: context.origin.row.icon,
        sourceShareId: context.share.id as Id<'shares'>,
        sourceAgentId: context.origin.row._id,
        createdByUserId: context.actorId as Id<'users'>,
        createdAt: context.now,
        updatedAt: context.now,
      })
    },
    updateReplica: async (replica, origin, context) => {
      if (
        !context.metadataWasExplicitlyUpdated &&
        replica.name === origin.name &&
        replica.icon === origin.icon
      ) {
        return false
      }
      await ctx.db.patch(replica._id, {
        name: origin.name,
        icon: origin.icon,
        updatedAt: context.now,
      })
      return true
    },
    deleteReplica: async replica => {
      await ctx.db.delete(replica._id)
      const anchor = await ctx.db.get(replica.anchorId)
      if (anchor?.kind !== 'share-mount') await ctx.db.delete(replica.anchorId)
    },
    detachReplica: async (replica, now) => {
      const anchor = await ctx.db.get(replica.anchorId)
      let preservedAnchorId: Id<'anchors'> | null = null
      if (anchor?.kind === 'share-mount') {
        await ctx.db.patch(anchor._id, {
          kind: 'agent',
          settings: {},
          updatedAt: now,
        })
        preservedAnchorId = anchor._id
      }
      await ctx.db.patch(replica._id, {
        sourceShareId: undefined,
        sourceAgentId: undefined,
        disabledAt: undefined,
        disabledByUserId: undefined,
        updatedAt: now,
      })
      return preservedAnchorId
    },
  }
}
