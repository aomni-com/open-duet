import { paginationOptsValidator } from 'convex/server'
import { v } from 'convex/values'

import {
  DEFAULT_AGENT_NAME,
  AnchorMoveCandidatesReportSchema,
  MAX_AGENTS_PER_WORKSPACE,
  MAX_NON_ORPHANED_ANCHORS_PER_WORKSPACE,
  normalizeDrivePath,
  ROOT_AGENT_SCOPE,
  type Anchor,
  type AnchorKind,
  type GatewayAgentConfig,
  type GatewayAnchor,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { mutation, query } from '../../_generated/server'
import { agentDisplayName } from '../agents/display'
import { agentSharedReplicaAdapter } from '../agents/replication'
import { requireApiInternalKey } from '../apiKeys/model'
import { appSharedReplicaAdapter } from '../apps/replication'
import { writeAuditEvent } from '../audit/model'
import { liveSubscriptionsByWorkspace } from '../marketplace/subscriptions'
import {
  convexSharedReplicaGraph,
  reconcileSharedReplicasForOrigin,
  type SharedReplicaAdapter,
} from '../replication/shared'
import { resolveShareAnchorTransition } from '../shares/anchorTransitions'
import { SHARE_GRAPH_READ_LIMIT, cascadeRevokeShares, unlinkActiveShare } from '../shares/effects'
import { assertRole } from '../workspaces/authorization'
import { anchorHasLiveConsumer } from './consumers'
import { resolveAnchorRenameDecisions } from './renameDecision'
import { deleteAnchorEntities } from './subtree'

export const anchorKindValidator = v.union(
  v.literal('app'),
  v.literal('agent'),
  v.literal('publish'),
  v.literal('share-root'),
  v.literal('share-mount'),
)
export const anchorSettingsValidator = v.union(
  v.object({ kind: v.union(v.literal('file'), v.literal('folder')) }),
  v.object({}),
)
const renameCandidate = v.object({
  fromPath: v.string(),
  toPath: v.string(),
  confidence: v.number(),
  inodeMatch: v.boolean(),
  markerMatch: v.boolean(),
})
const anchorMoveReport = v.object({
  anchorId: v.id('anchors'),
  candidates: v.array(renameCandidate),
  anchorPathExists: v.boolean(),
  consecutiveMissingPolls: v.number(),
  markerMatches: v.array(v.string()),
  missingIsConclusive: v.optional(v.boolean()),
})

export async function createAnchorWithCtx(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    path: string
    kind: AnchorKind
    settings: AnchorSettings
    actorId: Id<'users'>
    now?: number
  },
): Promise<Anchor> {
  const now = args.now ?? Date.now()
  const path = normalizeAnchorPath(args.path)
  await assertPathAvailable(ctx, args.workspaceId, path)
  await assertWorkspaceAnchorCapacity(ctx, args.workspaceId)
  const anchorId = await ctx.db.insert('anchors', {
    workspaceId: args.workspaceId,
    path,
    kind: args.kind,
    settings: args.settings,
    state: 'active',
    markerNonce: generateMarkerNonce(),
    createdAt: now,
    updatedAt: now,
  })
  await writeAuditEvent(ctx, {
    workspaceId: args.workspaceId,
    event: 'anchor.created',
    actorId: args.actorId,
    at: now,
    provenance: { anchorId, path, kind: args.kind },
  })
  return toAnchor(await requireAnchor(ctx, anchorId))
}

export const applyRename = mutation({
  args: {
    internalKey: v.string(),
    vmTokenHash: v.string(),
    reports: v.array(anchorMoveReport),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const workspace = await workspaceByVmTokenHash(ctx, args.vmTokenHash)
    const now = args.now ?? Date.now()
    const { active: activeAnchors, broken: brokenAnchors } = await completeNonOrphanedAnchors(
      ctx,
      workspace._id,
    )
    // Broken anchors are reconciled too, and that is the whole reason residue used
    // to be permanent: an anchor left the VM projection the moment it broke, so
    // nothing ever looked at it again and no verdict could ever change. A broken
    // anchor is a claim about the filesystem, and claims get rechecked — either the
    // folder comes back under a new name and it reanchors, or it stays gone and its
    // rows are reaped.
    const anchors = [...activeAnchors, ...brokenAnchors]
    // Share transitions stay on the active set alone. Unlinking someone else's
    // share is that rail's decision to make, and widening its input here would
    // start unlinking shares on anchors that broke for unrelated reasons.
    const activeById = new Map(activeAnchors.map(anchor => [anchor._id, anchor]))
    const observedById = new Map(anchors.map(anchor => [anchor._id, anchor]))
    const reports = args.reports.map(rawReport => {
      const report = AnchorMoveCandidatesReportSchema.parse(rawReport)
      return {
        anchorId: report.anchorId as Id<'anchors'>,
        candidates: report.candidates.map(candidate => ({
          fromPath: normalizeAnchorPath(candidate.fromPath),
          toPath: normalizeAnchorPath(candidate.toPath),
          confidence: candidate.confidence,
          inodeMatch: candidate.inodeMatch,
          markerMatch: candidate.markerMatch,
        })),
        anchorPathExists: report.anchorPathExists,
        consecutiveMissingPolls: report.consecutiveMissingPolls,
        markerMatches: report.markerMatches.map(path => normalizeAnchorPath(path)),
        missingIsConclusive: report.missingIsConclusive,
      }
    })
    const shareContext = await loadShareAnchorContext(ctx, workspace._id, now)
    const linkedShareReports = reports.filter(report => {
      const anchor = activeById.get(report.anchorId)
      return (
        (anchor?.kind === 'share-mount' &&
          shareContext.activeByMountAnchorId.has(report.anchorId)) ||
        (shareContext.rootSharesByAnchorId.get(report.anchorId)?.length ?? 0) > 0
      )
    })
    const linkedShareAnchorIds = new Set(linkedShareReports.map(report => report.anchorId))
    const arrivingAnchorIds = new Set(
      (await liveSubscriptionsByWorkspace(ctx, workspace._id))
        .filter(subscription => subscription.state === 'installing')
        .map(subscription => subscription.anchorId),
    )
    const decisions = resolveAnchorRenameDecisions(
      anchors.map(anchor => ({
        anchorId: anchor._id,
        path: anchor.path,
        kind: anchor.kind,
        arriving: arrivingAnchorIds.has(anchor._id),
      })),
      reports.filter(report => !linkedShareAnchorIds.has(report.anchorId)),
    )

    const actorId = await auditActor(ctx, workspace)
    const changed: unknown[] = []
    const affectedRecipientWorkspaceIds = new Set<Id<'workspaces'>>()
    const sharedResourceAnchorChanges: Array<{
      anchor: Doc<'anchors'>
      action: 'reanchor' | 'broken'
    }> = []
    const movingDestinations = new Map<Id<'anchors'>, string>(
      decisions
        .filter(decision => decision.action === 'reanchor')
        .map(decision => [decision.anchorId as Id<'anchors'>, decision.toPath]),
    )
    const preliminaryShareTransitions = new Map<
      Id<'anchors'>,
      ReturnType<typeof resolveShareAnchorTransition>
    >()
    for (const report of linkedShareReports) {
      const anchor = activeById.get(report.anchorId)
      if (anchor === undefined) continue
      const transition = resolveShareAnchorTransition({
        anchorPath: anchor.path,
        anchorPathExists: report.anchorPathExists,
        consecutiveMissingPolls: report.consecutiveMissingPolls,
        candidates: report.candidates,
        markerMatches: report.markerMatches,
        missingIsConclusive: report.missingIsConclusive,
        linkedPaths: [...shareContext.linkedPathsByAnchorId.entries()]
          .filter(([anchorId]) => anchorId !== anchor._id)
          .map(([, path]) => path),
        targetConflict: false,
      })
      preliminaryShareTransitions.set(anchor._id, transition)
      if (transition.kind === 'relocate') movingDestinations.set(anchor._id, transition.toPath)
    }
    const destinationCounts = new Map<string, number>()
    for (const destination of movingDestinations.values()) {
      destinationCounts.set(destination, (destinationCounts.get(destination) ?? 0) + 1)
    }
    for (const report of linkedShareReports) {
      const anchor = activeById.get(report.anchorId)
      const preliminary = preliminaryShareTransitions.get(report.anchorId)
      if (anchor === undefined || preliminary === undefined) continue
      let targetConflict = false
      if (preliminary.kind === 'relocate') {
        const targetOwner = await anchorByPath(ctx, workspace._id, preliminary.toPath)
        const targetOwnerMovesAway =
          targetOwner !== null &&
          movingDestinations.has(targetOwner._id) &&
          movingDestinations.get(targetOwner._id) !== preliminary.toPath
        targetConflict =
          (destinationCounts.get(preliminary.toPath) ?? 0) > 1 ||
          (targetOwner !== null && targetOwner._id !== anchor._id && !targetOwnerMovesAway)
      }
      const transition =
        preliminary.kind === 'unlink'
          ? preliminary
          : resolveShareAnchorTransition({
              anchorPath: anchor.path,
              anchorPathExists: report.anchorPathExists,
              consecutiveMissingPolls: report.consecutiveMissingPolls,
              candidates: report.candidates,
              markerMatches: report.markerMatches,
              missingIsConclusive: report.missingIsConclusive,
              linkedPaths: projectedLinkedPaths(
                anchor._id,
                shareContext.linkedPathsByAnchorId,
                preliminaryShareTransitions,
              ),
              targetConflict,
            })
      if (transition.kind === 'unchanged') continue
      if (transition.kind === 'unlink') {
        const mountedShare = shareContext.activeByMountAnchorId.get(anchor._id)
        if (mountedShare !== undefined) {
          await unlinkActiveShare(ctx, {
            share: mountedShare,
            actorId,
            now,
            reason: 'anchor_transition',
          })
          if (mountedShare.toWorkspaceId !== undefined) {
            affectedRecipientWorkspaceIds.add(mountedShare.toWorkspaceId)
          }
          changed.push({
            action: 'unlinked',
            anchorId: anchor._id,
            shareId: mountedShare._id,
          })
          continue
        }
        for (const share of shareContext.rootSharesByAnchorId.get(anchor._id) ?? []) {
          if (share.state === 'active') {
            await unlinkActiveShare(ctx, {
              share,
              actorId,
              now,
              reason: 'origin_anchor_transition',
            })
            if (share.toWorkspaceId !== undefined) {
              affectedRecipientWorkspaceIds.add(share.toWorkspaceId)
            }
            changed.push({
              action: 'unlinked',
              anchorId: anchor._id,
              shareId: share._id,
            })
            continue
          }
          const revokedShareIds = await cascadeRevokeShares(ctx, share._id, now)
          await writeAuditEvent(ctx, {
            workspaceId: share.originWorkspaceId,
            event: 'share.revoked',
            actorId,
            at: now,
            provenance: {
              shareId: share._id,
              revokedShareIds,
              fromWorkspaceId: share.fromWorkspaceId,
              reason: 'origin_anchor_transition',
            },
          })
          changed.push({
            action: 'revoked',
            anchorId: anchor._id,
            shareId: share._id,
          })
        }
        await ctx.db.patch(anchor._id, { state: 'broken', updatedAt: now })
        await writeAuditEvent(ctx, {
          workspaceId: workspace._id,
          event: 'anchor.broken_by_rename',
          actorId,
          at: now,
          provenance: {
            anchorId: anchor._id,
            kind: anchor.kind,
            path: anchor.path,
            reason: 'share_transition',
            candidates: report.candidates,
          },
        })
        sharedResourceAnchorChanges.push({ anchor, action: 'broken' })
        changed.push({
          action: 'broken',
          anchorId: anchor._id,
          path: anchor.path,
          reason: 'share_transition',
        })
        continue
      }
      const supportingCandidate = report.candidates.find(
        candidate => candidate.toPath === transition.toPath,
      )
      await ctx.db.patch(anchor._id, {
        path: transition.toPath,
        state: 'active',
        updatedAt: now,
      })
      const mountedShare = shareContext.activeByMountAnchorId.get(anchor._id)
      if (mountedShare !== undefined) {
        await ctx.db.patch(mountedShare._id, { mountPath: transition.toPath })
      } else {
        sharedResourceAnchorChanges.push({ anchor, action: 'reanchor' })
      }
      await writeAuditEvent(ctx, {
        workspaceId: workspace._id,
        event: 'anchor.reanchored_by_rename',
        actorId,
        at: now,
        provenance: {
          anchorId: anchor._id,
          kind: anchor.kind,
          fromPath: anchor.path,
          toPath: transition.toPath,
          confidence: supportingCandidate?.confidence,
          inodeMatch: supportingCandidate?.inodeMatch ?? false,
          markerMatch: true,
        },
      })
      changed.push({
        action: 'reanchor',
        anchorId: anchor._id,
        fromPath: anchor.path,
        toPath: transition.toPath,
      })
    }
    for (const decision of decisions) {
      const anchor = observedById.get(decision.anchorId as Id<'anchors'>)
      if (anchor === undefined) continue
      // The drive says gone, but not enough times to delete on. Leave the anchor
      // exactly as it is — no state change, no audit event, nothing for the UI to
      // show and then take back a few seconds later.
      if (decision.action === 'wait') continue
      if (decision.action === 'reap') {
        // The folder is gone for good, so the app or agent it named is gone too.
        // Per-anchor on purpose, never as a subtree sweep: each descendant earns
        // its own verdict from its own evidence, so a child folder that was moved
        // out of a deleted parent gets reanchored instead of deleted with it.
        const entities = await deleteAnchorEntities(ctx, { anchor, actorId, now })
        addAffected(affectedRecipientWorkspaceIds, entities)
        // Orphan the anchor once nothing claims it — that retires it from both the
        // active and broken sets, so a reaped anchor stops being reported instead
        // of re-deciding the same verdict every poll. An anchor a publish or share
        // still consumes stays put; those rails own their own reaction.
        //
        // Unless the teardown took the anchor with it: a replica's anchor belongs
        // to the replica, so removing one removes the other, and there is nothing
        // left here to orphan.
        if (
          (await ctx.db.get(anchor._id)) !== null &&
          !(await anchorHasLiveConsumer(ctx, anchor._id))
        ) {
          await ctx.db.patch(anchor._id, { state: 'orphaned', updatedAt: now })
        }
        if (entities.deleted.length === 0) continue
        await writeAuditEvent(ctx, {
          workspaceId: workspace._id,
          event: 'anchor.reaped_missing_folder',
          actorId,
          at: now,
          provenance: {
            anchorId: anchor._id,
            kind: anchor.kind,
            path: anchor.path,
            deleted: entities.deleted,
            consecutiveMissingPolls: decision.consecutiveMissingPolls,
          },
        })
        changed.push({
          action: 'reap',
          anchorId: anchor._id,
          path: anchor.path,
          deleted: entities.deleted,
        })
        continue
      }
      if (decision.action === 'reanchor') {
        const targetOwner = await anchorByPath(ctx, workspace._id, decision.toPath)
        const targetOwnerMovesAway =
          targetOwner !== null &&
          movingDestinations.has(targetOwner._id) &&
          movingDestinations.get(targetOwner._id) !== decision.toPath
        if (
          (destinationCounts.get(decision.toPath) ?? 0) > 1 ||
          (targetOwner !== null && targetOwner._id !== anchor._id && !targetOwnerMovesAway)
        ) {
          await ctx.db.patch(anchor._id, { state: 'broken', updatedAt: now })
          await writeAuditEvent(ctx, {
            workspaceId: workspace._id,
            event: 'anchor.broken_by_rename',
            actorId,
            at: now,
            provenance: {
              anchorId: anchor._id,
              kind: anchor.kind,
              path: anchor.path,
              reason: 'target_conflict',
              conflictingPath: decision.toPath,
              ...(targetOwner === null ? {} : { conflictingAnchorId: targetOwner._id }),
            },
          })
          sharedResourceAnchorChanges.push({ anchor, action: 'broken' })
          changed.push({
            action: 'broken',
            anchorId: anchor._id,
            path: anchor.path,
            reason: 'target_conflict',
          })
          continue
        }
        await ctx.db.patch(anchor._id, { path: decision.toPath, state: 'active', updatedAt: now })
        await writeAuditEvent(ctx, {
          workspaceId: workspace._id,
          event: 'anchor.reanchored_by_rename',
          actorId,
          at: now,
          provenance: {
            anchorId: anchor._id,
            kind: anchor.kind,
            fromPath: anchor.path,
            toPath: decision.toPath,
            confidence: decision.confidence,
            inodeMatch: decision.inodeMatch,
            markerMatch: decision.markerMatch,
          },
        })
        sharedResourceAnchorChanges.push({ anchor, action: 'reanchor' })
        changed.push({
          action: 'reanchor',
          anchorId: anchor._id,
          fromPath: anchor.path,
          toPath: decision.toPath,
        })
      } else {
        await ctx.db.patch(anchor._id, { state: 'broken', updatedAt: now })
        await writeAuditEvent(ctx, {
          workspaceId: workspace._id,
          event: 'anchor.broken_by_rename',
          actorId,
          at: now,
          provenance: {
            anchorId: anchor._id,
            kind: anchor.kind,
            path: anchor.path,
            reason: decision.reason,
            candidates: decision.candidates,
          },
        })
        sharedResourceAnchorChanges.push({ anchor, action: 'broken' })
        changed.push({
          action: 'broken',
          anchorId: anchor._id,
          path: anchor.path,
          reason: decision.reason,
        })
      }
    }
    for (const { anchor, action } of sharedResourceAnchorChanges) {
      addAffected(
        affectedRecipientWorkspaceIds,
        await reconcileSharedResourceAnchorChange(ctx, anchor, action, now),
      )
    }
    return { changed, affectedRecipientWorkspaceIds: [...affectedRecipientWorkspaceIds] }
  },
})

export const reanchor = mutation({
  args: {
    anchorId: v.id('anchors'),
    path: v.string(),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const anchor = await requireAnchor(ctx, args.anchorId)
    let actorId = args.actorId
    if (args.internalKey !== undefined) {
      requireApiInternalKey(args.internalKey)
      if (actorId === undefined) throw new Error('actorId is required for internal reanchor')
    } else {
      if (actorId !== undefined) throw new Error('actorId requires internalKey')
      actorId = (await assertRole(ctx, anchor.workspaceId, 'editor')).userId
    }
    if (anchor.state !== 'broken') throw new Error('Anchor is not broken')
    const app = await appByAnchor(ctx, anchor)
    if (app?.sourceShareId !== undefined)
      throw new Error('Replica app anchors cannot be reanchored')
    const agent = await agentByAnchor(ctx, anchor)
    if (agent?.sourceShareId !== undefined)
      throw new Error('Replica agent anchors cannot be reanchored')
    const path = normalizeAnchorPath(args.path)
    await assertPathAvailable(ctx, anchor.workspaceId, path, anchor._id)
    const now = args.now ?? Date.now()
    await ctx.db.patch(args.anchorId, {
      path,
      state: 'active',
      markerNonce: generateMarkerNonce(),
      updatedAt: now,
    })
    await writeAuditEvent(ctx, {
      workspaceId: anchor.workspaceId,
      event: 'anchor.reanchored',
      actorId,
      at: now,
      provenance: {
        anchorId: args.anchorId,
        kind: anchor.kind,
        fromPath: anchor.path,
        toPath: path,
      },
    })
    const fanout = await reconcileSharedResourceAnchorChange(ctx, anchor, 'reanchor', now)
    return { ...toAnchor(await requireAnchor(ctx, args.anchorId)), ...fanout }
  },
})

export async function reconcileSharedResourceAnchorChange(
  ctx: MutationCtx,
  anchor: Doc<'anchors'>,
  action: 'reanchor' | 'broken',
  now: number,
): Promise<{ affectedRecipientWorkspaceIds: Id<'workspaces'>[]; deletedReplica?: true }> {
  const affectedRecipientWorkspaceIds = new Set<Id<'workspaces'>>()
  let deletedReplica: true | undefined
  const results = [
    await reconcileAnchorResource(
      ctx,
      action,
      now,
      await appByAnchor(ctx, anchor),
      appSharedReplicaAdapter(ctx),
    ),
    await reconcileAnchorResource(
      ctx,
      action,
      now,
      await agentByAnchor(ctx, anchor),
      agentSharedReplicaAdapter(ctx),
    ),
  ]
  for (const result of results) {
    for (const workspaceId of result.affectedRecipientWorkspaceIds) {
      affectedRecipientWorkspaceIds.add(workspaceId)
    }
    if (result.deletedReplica) deletedReplica = true
  }
  return {
    affectedRecipientWorkspaceIds: [...affectedRecipientWorkspaceIds],
    ...(deletedReplica === undefined ? {} : { deletedReplica }),
  }
}

async function reconcileAnchorResource<
  Row extends { sourceShareId?: Id<'shares'>; workspaceId: Id<'workspaces'> },
>(
  ctx: MutationCtx,
  action: 'reanchor' | 'broken',
  now: number,
  row: Row | null,
  adapter: SharedReplicaAdapter<Row>,
): Promise<{ affectedRecipientWorkspaceIds: Id<'workspaces'>[]; deletedReplica?: true }> {
  if (row === null || (action === 'reanchor' && row.sourceShareId !== undefined)) {
    return { affectedRecipientWorkspaceIds: [] }
  }
  if (row.sourceShareId !== undefined) {
    await adapter.deleteReplica(row, now)
    return { affectedRecipientWorkspaceIds: [row.workspaceId], deletedReplica: true }
  }
  const result = await reconcileSharedReplicasForOrigin(
    convexSharedReplicaGraph(ctx),
    adapter,
    { row },
    now,
  )
  return {
    affectedRecipientWorkspaceIds: result.affectedRecipientWorkspaceIds as Id<'workspaces'>[],
  }
}

async function appByAnchor(
  ctx: QueryCtx | MutationCtx,
  anchor: Doc<'anchors'>,
): Promise<Doc<'apps'> | null> {
  return await ctx.db
    .query('apps')
    .withIndex('by_workspace_and_anchor', q =>
      q.eq('workspaceId', anchor.workspaceId).eq('anchorId', anchor._id),
    )
    .unique()
}

async function agentByAnchor(
  ctx: QueryCtx | MutationCtx,
  anchor: Doc<'anchors'>,
): Promise<Doc<'agents'> | null> {
  return await ctx.db
    .query('agents')
    .withIndex('by_anchor', q => q.eq('anchorId', anchor._id))
    .unique()
}

function addAffected(
  target: Set<Id<'workspaces'>>,
  result: { affectedRecipientWorkspaceIds: Id<'workspaces'>[] },
): void {
  for (const workspaceId of result.affectedRecipientWorkspaceIds) target.add(workspaceId)
}

export const listByWorkspace = query({
  args: {
    workspaceId: v.id('workspaces'),
    internalKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.internalKey !== undefined) requireApiInternalKey(args.internalKey)
    else await assertRole(ctx, args.workspaceId, 'viewer')
    const { all: anchors } = await completeNonOrphanedAnchors(ctx, args.workspaceId)
    return anchors.map(toAnchor).sort((a, b) => a.path.localeCompare(b.path))
  },
})

export const listByWorkspacePage = query({
  args: {
    workspaceId: v.id('workspaces'),
    internalKey: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const page = await ctx.db
      .query('anchors')
      .withIndex('by_workspace_and_path', q => q.eq('workspaceId', args.workspaceId))
      .order('asc')
      .paginate(args.paginationOpts)
    return { ...page, page: page.page.map(toAnchor) }
  },
})

export const listForVm = query({
  args: {
    internalKey: v.string(),
    vmTokenHash: v.string(),
  },
  handler: (ctx, args) => listForVmImpl(ctx, args),
})

export async function listForVmImpl(
  ctx: QueryCtx | MutationCtx,
  args: { internalKey: string; vmTokenHash: string },
): Promise<GatewayAnchor[]> {
  return (await projectVmTopologyImpl(ctx, args)).anchors
}

export interface VmTopologyProjection {
  anchors: GatewayAnchor[]
  agents: GatewayAgentConfig[]
  agentLookupQueries: number
}

/**
 * The one scan behind both halves of the VM's topology: the anchor list the
 * gateway reconciles folders from, and the agent roster sessions are told
 * about. One scan on purpose — the "is this agent live" verdict (enabled, on
 * an active anchor) must come from a single branch, or the roster and the
 * anchor's `agentId` drift apart and a session can address an agent whose
 * anchor no longer claims one.
 *
 * The roster leads with a synthetic root member carrying the workspace's own
 * name: root has no `agents` row, and without it a top-level agent could not
 * name the one agent above it (D1).
 *
 * Broken anchors ride along in the anchor list and nowhere else. They are not
 * live surfaces — they carry no agentId and never reach the roster — but they
 * are still claims about the filesystem, and a claim nobody rechecks can never
 * be settled: a broken anchor used to leave this projection the instant it
 * broke, which is why its app stayed an unrepairable phantom forever. Sending
 * them keeps the reports coming until the folder returns or the row is reaped.
 */
export async function projectVmTopologyImpl(
  ctx: QueryCtx | MutationCtx,
  args: { internalKey: string; vmTokenHash: string },
): Promise<VmTopologyProjection> {
  requireApiInternalKey(args.internalKey)
  const workspace = await workspaceByVmTokenHash(ctx, args.vmTokenHash)
  const { all: anchors } = await completeNonOrphanedAnchors(ctx, workspace._id)
  const agents = await ctx.db
    .query('agents')
    .withIndex('by_workspace', q => q.eq('workspaceId', workspace._id))
    .take(MAX_AGENTS_PER_WORKSPACE + 1)
  if (agents.length > MAX_AGENTS_PER_WORKSPACE) throw new Error('Workspace agent limit exceeded')
  const agentsByAnchor = new Map<Id<'anchors'>, Doc<'agents'>>()
  for (const agent of agents) {
    if (agentsByAnchor.has(agent.anchorId)) throw new Error('Anchor has multiple agents')
    agentsByAnchor.set(agent.anchorId, agent)
  }
  const projected = anchors.map(anchor => {
    const agent = agentsByAnchor.get(anchor._id) ?? null
    const live = anchor.state === 'active' && agent !== null && agent.disabledAt === undefined
    return {
      anchor: toGatewayAnchor(anchor, live ? agent._id : undefined),
      roster: live
        ? ({
            kind: 'agent' as const,
            agentId: agent._id,
            anchorId: anchor._id,
            anchorPath: anchor.path,
            slug: agent.slug,
            name: agentDisplayName(agent),
            ...(agent.onboardedAt === undefined ? {} : { onboardedAt: agent.onboardedAt }),
          } satisfies GatewayAgentConfig)
        : undefined,
    }
  })
  return {
    anchors: projected.map(entry => entry.anchor).sort((a, b) => a.path.localeCompare(b.path)),
    agents: [
      { kind: 'root', slug: ROOT_AGENT_SCOPE, name: workspace.duetName ?? DEFAULT_AGENT_NAME },
      ...projected
        .flatMap(entry => (entry.roster === undefined ? [] : [entry.roster]))
        .sort((a, b) => (a.slug < b.slug ? -1 : 1)),
    ],
    agentLookupQueries: 1,
  }
}

export const getByPath = query({
  args: {
    workspaceId: v.id('workspaces'),
    path: v.string(),
    internalKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.internalKey !== undefined) requireApiInternalKey(args.internalKey)
    else await assertRole(ctx, args.workspaceId, 'viewer')
    const path = normalizeAnchorPath(args.path)
    const anchor = await ctx.db
      .query('anchors')
      .withIndex('by_workspace_and_path', q =>
        q.eq('workspaceId', args.workspaceId).eq('path', path),
      )
      .unique()
    return anchor === null ? null : toAnchor(anchor)
  },
})

export const getById = query({
  args: {
    anchorId: v.id('anchors'),
    internalKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const anchor = await ctx.db.get(args.anchorId)
    if (anchor === null) return null
    if (args.internalKey !== undefined) requireApiInternalKey(args.internalKey)
    else await assertRole(ctx, anchor.workspaceId, 'viewer')
    return toAnchor(anchor)
  },
})

export function normalizeAnchorPath(
  path: string,
  owner: 'anchor' | 'app' | 'agent' | 'publish' | 'share' = 'anchor',
): string {
  const normalized = normalizeDrivePath(path)
  if (!normalized.ok) throw new Error(`Invalid ${owner} path: ${normalized.reason}`)
  return normalized.relativePath
}

export async function requireAnchor(
  ctx: QueryCtx | MutationCtx,
  anchorId: Id<'anchors'>,
): Promise<Doc<'anchors'>> {
  const anchor = await ctx.db.get(anchorId)
  if (anchor === null) throw new Error('Anchor not found')
  return anchor
}

export async function getOrCreateAnchorForPath(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    path: string
    kind: AnchorKind
    settings: AnchorSettings
    actorId: Id<'users'>
    now: number
    kindConflictError: string
    compatibleExistingKinds?: AnchorKind[]
  },
): Promise<Anchor> {
  const existing = await anchorByPath(ctx, args.workspaceId, args.path)
  if (existing !== null) {
    if (existing.state === 'orphaned') {
      await assertWorkspaceAnchorCapacity(ctx, args.workspaceId)
      await ctx.db.patch(existing._id, {
        kind: args.kind,
        settings: args.settings,
        state: 'active',
        updatedAt: args.now,
      })
      return toAnchor(await requireAnchor(ctx, existing._id))
    }
    if (
      existing.kind !== args.kind &&
      !args.compatibleExistingKinds?.includes(existing.kind as AnchorKind)
    ) {
      throw new Error(args.kindConflictError)
    }
    return toAnchor(existing)
  }
  return await createAnchorWithCtx(ctx, args)
}

async function completeNonOrphanedAnchors(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
): Promise<{ active: Doc<'anchors'>[]; broken: Doc<'anchors'>[]; all: Doc<'anchors'>[] }> {
  const active = await ctx.db
    .query('anchors')
    .withIndex('by_workspace_state', q => q.eq('workspaceId', workspaceId).eq('state', 'active'))
    .take(MAX_NON_ORPHANED_ANCHORS_PER_WORKSPACE + 1)
  if (active.length > MAX_NON_ORPHANED_ANCHORS_PER_WORKSPACE) {
    throw new Error('Workspace anchor limit exceeded')
  }
  // Spend only the remainder on broken rows, so even corrupt over-limit state
  // reads at most one overflow witness rather than two full state buckets.
  const broken = await ctx.db
    .query('anchors')
    .withIndex('by_workspace_state', q => q.eq('workspaceId', workspaceId).eq('state', 'broken'))
    .take(MAX_NON_ORPHANED_ANCHORS_PER_WORKSPACE - active.length + 1)
  const all = [...active, ...broken]
  if (all.length > MAX_NON_ORPHANED_ANCHORS_PER_WORKSPACE) {
    throw new Error('Workspace anchor limit exceeded')
  }
  return { active, broken, all }
}

async function assertWorkspaceAnchorCapacity(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
): Promise<void> {
  const { all } = await completeNonOrphanedAnchors(ctx, workspaceId)
  if (all.length >= MAX_NON_ORPHANED_ANCHORS_PER_WORKSPACE) {
    throw new Error('Workspace anchor limit exceeded')
  }
}

async function assertPathAvailable(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  path: string,
  exceptAnchorId?: Id<'anchors'>,
): Promise<void> {
  const existing = await anchorByPath(ctx, workspaceId, path)
  if (existing !== null && existing._id !== exceptAnchorId)
    throw new Error('Anchor path already exists')
}

export async function anchorByPath(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  path: string,
): Promise<Doc<'anchors'> | null> {
  return await ctx.db
    .query('anchors')
    .withIndex('by_workspace_and_path', q => q.eq('workspaceId', workspaceId).eq('path', path))
    .unique()
}

function projectedLinkedPaths(
  currentAnchorId: Id<'anchors'>,
  linkedPathsByAnchorId: Map<Id<'anchors'>, string>,
  transitionsByAnchorId: Map<Id<'anchors'>, ReturnType<typeof resolveShareAnchorTransition>>,
): string[] {
  const paths: string[] = []
  for (const [anchorId, path] of linkedPathsByAnchorId) {
    if (anchorId === currentAnchorId) continue
    const transition = transitionsByAnchorId.get(anchorId)
    if (transition?.kind === 'relocate') paths.push(transition.toPath)
    else if (transition?.kind !== 'unlink') paths.push(path)
  }
  return paths
}

async function loadShareAnchorContext(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  now: number,
): Promise<{
  activeByMountAnchorId: Map<Id<'anchors'>, Doc<'shares'>>
  linkedPathsByAnchorId: Map<Id<'anchors'>, string>
  rootSharesByAnchorId: Map<Id<'anchors'>, Doc<'shares'>[]>
}> {
  const activeIncoming = await ctx.db
    .query('shares')
    .withIndex('by_to_workspace_state', q =>
      q.eq('toWorkspaceId', workspaceId).eq('state', 'active'),
    )
    .take(SHARE_GRAPH_READ_LIMIT + 1)
  const activeOutgoing = await ctx.db
    .query('shares')
    .withIndex('by_from_workspace_state_declinedAt_expiresAt', q =>
      q.eq('fromWorkspaceId', workspaceId).eq('state', 'active'),
    )
    .take(SHARE_GRAPH_READ_LIMIT + 1)
  const pendingOutgoing = await ctx.db
    .query('shares')
    .withIndex('by_from_workspace_state_declinedAt_expiresAt', q =>
      q
        .eq('fromWorkspaceId', workspaceId)
        .eq('state', 'pending')
        .eq('declinedAt', undefined)
        .gt('expiresAt', now),
    )
    .take(SHARE_GRAPH_READ_LIMIT + 1)
  if (
    activeIncoming.length > SHARE_GRAPH_READ_LIMIT ||
    activeOutgoing.length + pendingOutgoing.length > SHARE_GRAPH_READ_LIMIT
  ) {
    throw new Error('Workspace linked-root limit exceeded')
  }

  const activeByMountAnchorId = new Map<Id<'anchors'>, Doc<'shares'>>()
  const linkedPathsByAnchorId = new Map<Id<'anchors'>, string>()
  const rootSharesByAnchorId = new Map<Id<'anchors'>, Doc<'shares'>[]>()
  for (const share of activeIncoming) {
    if (share.mountAnchorId === undefined || share.mountPath === undefined) continue
    activeByMountAnchorId.set(share.mountAnchorId, share)
    linkedPathsByAnchorId.set(share.mountAnchorId, share.mountPath)
  }
  for (const share of [...activeOutgoing, ...pendingOutgoing]) {
    if (share.parentShareId !== undefined) continue
    const rootedShares = rootSharesByAnchorId.get(share.anchorId) ?? []
    rootedShares.push(share)
    rootSharesByAnchorId.set(share.anchorId, rootedShares)
    const anchor = await ctx.db.get(share.anchorId)
    if (anchor === null || anchor.workspaceId !== workspaceId || anchor.state !== 'active') {
      continue
    }
    linkedPathsByAnchorId.set(anchor._id, anchor.path)
  }
  return { activeByMountAnchorId, linkedPathsByAnchorId, rootSharesByAnchorId }
}

async function workspaceByVmTokenHash(
  ctx: QueryCtx | MutationCtx,
  vmTokenHash: string,
): Promise<Doc<'workspaces'>> {
  const workspace = await ctx.db
    .query('workspaces')
    .withIndex('by_vmTokenHash', q => q.eq('vmTokenHash', vmTokenHash))
    .unique()
  if (workspace === null || workspace.status === 'deleted' || workspace.status === 'retired') {
    throw new Error('Invalid VM token')
  }
  return workspace
}

async function auditActor(
  ctx: QueryCtx | MutationCtx,
  workspace: Doc<'workspaces'>,
): Promise<Id<'users'>> {
  if (workspace.createdByUserId !== undefined) return workspace.createdByUserId
  const owner = await ctx.db
    .query('workspaceMembers')
    .withIndex('by_workspace_role', q => q.eq('workspaceId', workspace._id).eq('role', 'owner'))
    .first()
  if (owner === null) throw new Error('Workspace has no audit actor')
  return owner.userId
}

export function toAnchor(anchor: Doc<'anchors'>): Anchor {
  return {
    id: anchor._id,
    workspaceId: anchor.workspaceId,
    path: anchor.path,
    kind: anchor.kind as AnchorKind,
    settings: anchor.settings,
    state: anchor.state,
    createdAt: anchor.createdAt,
    updatedAt: anchor.updatedAt,
  }
}

function toGatewayAnchor(anchor: Doc<'anchors'>, agentId?: Id<'agents'>): GatewayAnchor {
  return {
    ...toAnchor(anchor),
    markerNonce: anchor.markerNonce,
    ...(agentId === undefined ? {} : { agentId }),
  }
}

function generateMarkerNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

type AnchorSettings = { kind: 'file' | 'folder' } | Record<string, never>
