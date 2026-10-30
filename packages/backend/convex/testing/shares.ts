import { v } from 'convex/values'

import { normalizeDrivePath, type ShareMode, type ShareState } from '@repo/contract'

import type { Doc } from '../_generated/dataModel'
import { mutation, query } from '../_generated/server'
import { requireApiInternalKey } from '../domains/apiKeys/model'
import { ensureWorkspaceShareDirectoryEntry } from '../domains/shares/directory'
import { createShareForActor, reshareForActor, SHARE_LIFETIME_MS } from '../domains/shares/model'
import {
  loadShareSyncProjectionInput,
  projectShareSyncGenerations,
} from '../domains/shares/syncProjection'
import { requireCurrentUserId } from '../domains/workspaces/authorization'

const shareMode = v.union(v.literal('read'), v.literal('write'))

export const createShareForTest = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.optional(v.id('users')),
    fromWorkspaceId: v.id('workspaces'),
    toEmail: v.string(),
    path: v.string(),
    mode: shareMode,
    ignorePatterns: v.optional(v.array(v.string())),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const invitationToken = testInvitationToken()
    const created = await createShareForActor(ctx, {
      ...args,
      actorId: args.actorId ?? (await requireCurrentUserId(ctx)),
      invitationToken,
      now: args.now ?? Date.now(),
      enforceEmailRateLimit: false,
    })
    return { share: created.share, invitationToken }
  },
})

export const reshareForTest = mutation({
  args: {
    internalKey: v.string(),
    parentShareId: v.id('shares'),
    fromWorkspaceId: v.id('workspaces'),
    toEmail: v.string(),
    mode: shareMode,
    ignorePatterns: v.optional(v.array(v.string())),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const invitationToken = testInvitationToken()
    const created = await reshareForActor(ctx, {
      ...args,
      actorId: await requireCurrentUserId(ctx),
      invitationToken,
      now: args.now ?? Date.now(),
      enforceEmailRateLimit: false,
    })
    return { share: created.share, invitationToken }
  },
})

export const rawSharesForTest = query({
  args: { internalKey: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    // Tests create a small bounded graph; exceeding this is fixture leakage, not a reason to collect.
    return (await ctx.db.query('shares').order('desc').take(1001)).map(toShare).sort(compareShares)
  },
})

/** Drive desired mount relocation independently from anchor policy in live probes. */
export const patchShareMountPathForTest = mutation({
  args: {
    internalKey: v.string(),
    shareId: v.id('shares'),
    mountPath: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const share = await ctx.db.get(args.shareId)
    if (
      share === null ||
      share.state !== 'active' ||
      share.toWorkspaceId === undefined ||
      share.mountPath === undefined ||
      share.mountAnchorId === undefined
    ) {
      throw new Error('Only an active accepted share can be relocated')
    }
    const normalized = normalizeDrivePath(args.mountPath)
    if (!normalized.ok) throw new Error('Invalid share mount path')
    const mountAnchor = await ctx.db.get(share.mountAnchorId)
    if (
      mountAnchor === null ||
      mountAnchor.workspaceId !== share.toWorkspaceId ||
      mountAnchor.kind !== 'share-mount' ||
      mountAnchor.state !== 'active'
    ) {
      throw new Error('Active share mount anchor is missing')
    }
    await ctx.db.patch(share._id, { mountPath: normalized.relativePath })
    await ctx.db.patch(mountAnchor._id, { path: normalized.relativePath })
  },
})

export const seedHistoricalSharesForTest = mutation({
  args: {
    internalKey: v.string(),
    templateShareId: v.id('shares'),
    count: v.number(),
    state: v.union(v.literal('pending'), v.literal('revoked')),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const template = await ctx.db.get(args.templateShareId)
    if (template === null) throw new Error('Template share not found')
    const shareIds = []
    for (let index = 0; index < args.count; index += 1) {
      const shareId = await ctx.db.insert('shares', {
        anchorId: template.anchorId,
        originWorkspaceId: template.originWorkspaceId,
        fromWorkspaceId: template.fromWorkspaceId,
        toEmail: template.toEmail,
        tokenHash: `historical-${template._id}-${index}`,
        tokenPrefix: `historical-${index}`,
        expiresAt: args.expiresAt,
        mode: template.mode,
        ignorePatterns: template.ignorePatterns,
        state: args.state,
        createdByUserId: template.createdByUserId,
        createdAt: index,
        ...(template.toUserId === undefined ? {} : { toUserId: template.toUserId }),
        ...(template.toWorkspaceId === undefined ? {} : { toWorkspaceId: template.toWorkspaceId }),
        ...(template.mountPath === undefined ? {} : { mountPath: template.mountPath }),
        ...(template.acceptedAt === undefined ? {} : { acceptedAt: template.acceptedAt }),
        ...(args.state === 'revoked' ? { revokedAt: args.expiresAt } : {}),
      })
      await ctx.db.patch(shareId, { paginationId: shareId })
      await ensureWorkspaceShareDirectoryEntry(ctx, {
        workspaceId: template.fromWorkspaceId,
        shareId,
        direction: 'outgoing',
        createdAt: index,
      })
      if (template.toWorkspaceId !== undefined) {
        await ensureWorkspaceShareDirectoryEntry(ctx, {
          workspaceId: template.toWorkspaceId,
          shareId,
          direction: 'incoming',
          createdAt: index,
        })
      }
      shareIds.push(shareId)
    }
    return shareIds
  },
})

export const seedPendingSharesForTest = mutation({
  args: {
    internalKey: v.string(),
    templateShareId: v.id('shares'),
    count: v.number(),
    createdAtStart: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const template = await ctx.db.get(args.templateShareId)
    if (template === null) throw new Error('Template share not found')
    const shareIds = []
    for (let index = 0; index < args.count; index += 1) {
      const createdAt = args.createdAtStart + index
      const shareId = await ctx.db.insert('shares', {
        anchorId: template.anchorId,
        originWorkspaceId: template.originWorkspaceId,
        fromWorkspaceId: template.fromWorkspaceId,
        toEmail: template.toEmail,
        tokenHash: `pending-${template._id}-${index}`,
        tokenPrefix: `pending-${index}`,
        expiresAt: createdAt + SHARE_LIFETIME_MS,
        mode: template.mode,
        ignorePatterns: template.ignorePatterns,
        state: 'pending',
        createdByUserId: template.createdByUserId,
        createdAt,
      })
      await ctx.db.patch(shareId, { paginationId: shareId })
      await ensureWorkspaceShareDirectoryEntry(ctx, {
        workspaceId: template.fromWorkspaceId,
        shareId,
        direction: 'outgoing',
        createdAt,
      })
      shareIds.push(shareId)
    }
    return shareIds
  },
})

export const seedActiveShareCapacityForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    peerWorkspaceId: v.id('workspaces'),
    anchorId: v.id('anchors'),
    mountAnchorId: v.id('anchors'),
    actorId: v.id('users'),
    outgoing: v.number(),
    incoming: v.number(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    for (let index = 0; index < args.outgoing + args.incoming; index += 1) {
      const outgoing = index < args.outgoing
      const shareId = await ctx.db.insert('shares', {
        anchorId: outgoing ? args.anchorId : args.mountAnchorId,
        originWorkspaceId: outgoing ? args.workspaceId : args.peerWorkspaceId,
        fromWorkspaceId: outgoing ? args.workspaceId : args.peerWorkspaceId,
        toEmail: `capacity-${index}@example.test`,
        toUserId: args.actorId,
        toWorkspaceId: outgoing ? args.peerWorkspaceId : args.workspaceId,
        tokenHash: `capacity-${args.workspaceId}-${index}`,
        tokenPrefix: `capacity-${index}`,
        expiresAt: args.now + SHARE_LIFETIME_MS,
        mode: 'read',
        mountPath: `capacity/${index}`,
        mountAnchorId: outgoing ? args.mountAnchorId : args.anchorId,
        ignorePatterns: [],
        state: 'active',
        sync: {
          sourceToTargetAcceptId: `source-${index}`,
          targetToSourceAcceptId: `target-${index}`,
          sourceToTargetNonce: `source-${index}`,
          targetToSourceNonce: `target-${index}`,
          tokenSecret: `secret-${index}`,
          tokenExpiresAt: args.now + SHARE_LIFETIME_MS,
          preparedAt: args.now,
        },
        createdByUserId: args.actorId,
        createdAt: args.now + index,
        acceptedAt: args.now + index,
      })
      await ctx.db.patch(shareId, { paginationId: shareId })
    }
  },
})

export const stripSharePaginationForTest = mutation({
  args: { internalKey: v.string(), shareId: v.id('shares') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const share = await ctx.db.get(args.shareId)
    if (share === null) throw new Error('Share not found')
    const subjects = [
      { workspaceId: share.fromWorkspaceId, direction: 'outgoing' as const },
      ...(share.toWorkspaceId === undefined
        ? []
        : [{ workspaceId: share.toWorkspaceId, direction: 'incoming' as const }]),
    ]
    for (const subject of subjects) {
      const entry = await ctx.db
        .query('workspaceShareDirectory')
        .withIndex('by_workspace_share_direction', query =>
          query
            .eq('workspaceId', subject.workspaceId)
            .eq('shareId', share._id)
            .eq('direction', subject.direction),
        )
        .unique()
      if (entry !== null) await ctx.db.delete(entry._id)
    }
    await ctx.db.patch(share._id, { paginationId: undefined })
  },
})

export const shareEmailFixtureForTest = query({
  args: { internalKey: v.string(), shareId: v.id('shares') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const share = await ctx.db.get(args.shareId)
    if (share === null) throw new Error('Share not found')
    const user = await ctx.db.get(share.createdByUserId)
    const anchor = await ctx.db.get(share.anchorId)
    if (user === null || anchor === null) throw new Error('Share email fixture is incomplete')
    return {
      share: { id: share._id, toEmail: share.toEmail },
      sharerName: user.name?.trim() || user.email,
      folderName: anchor.path.split('/').at(-1) || 'workspace',
    }
  },
})

export const currentShareSyncGenerationsForTest = query({
  args: { internalKey: v.string(), shareId: v.id('shares'), now: v.number() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const share = await ctx.db.get(args.shareId)
    if (share === null) throw new Error('Share not found')
    return (
      await projectShareSyncGenerations({
        ...(await loadShareSyncProjectionInput(ctx, [share])),
        now: args.now,
      })
    ).find(row => row.shareId === args.shareId)
  },
})

export const upsertShareSyncRealizationForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    shareId: v.id('shares'),
    generation: v.string(),
    state: v.union(
      v.literal('applying'),
      v.literal('ready'),
      v.literal('paused'),
      v.literal('error'),
    ),
    errorCode: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const previous = await ctx.db
      .query('shareSyncRealizations')
      .withIndex('by_workspace_share', q =>
        q.eq('workspaceId', args.workspaceId).eq('shareId', args.shareId),
      )
      .unique()
    const row = {
      workspaceId: args.workspaceId,
      shareId: args.shareId,
      generation: args.generation,
      state: args.state,
      errorCode: args.errorCode,
      updatedAt: args.now,
    }
    if (previous === null) return await ctx.db.insert('shareSyncRealizations', row)
    await ctx.db.patch(previous._id, row)
    return previous._id
  },
})

function toShare(share: Doc<'shares'>) {
  return {
    id: share._id,
    anchorId: share.anchorId,
    originWorkspaceId: share.originWorkspaceId,
    fromWorkspaceId: share.fromWorkspaceId,
    toEmail: share.toEmail,
    toUserId: share.toUserId,
    toWorkspaceId: share.toWorkspaceId,
    tokenPrefix: share.tokenPrefix,
    activeKey: share.activeKey,
    expiresAt: share.expiresAt,
    mode: share.mode as ShareMode,
    mountPath: share.mountPath,
    mountAnchorId: share.mountAnchorId,
    ignorePatterns: share.ignorePatterns,
    parentShareId: share.parentShareId,
    state: share.state as ShareState,
    sync:
      share.sync === undefined
        ? undefined
        : {
            sourceToTargetAcceptId: share.sync.sourceToTargetAcceptId,
            targetToSourceAcceptId: share.sync.targetToSourceAcceptId,
            sourceToTargetNonce: share.sync.sourceToTargetNonce,
            targetToSourceNonce: share.sync.targetToSourceNonce,
            tokenExpiresAt: share.sync.tokenExpiresAt,
            preparedAt: share.sync.preparedAt,
          },
    createdByUserId: share.createdByUserId,
    createdAt: share.createdAt,
    acceptedAt: share.acceptedAt,
    pausedAt: share.pausedAt,
    declinedAt: share.declinedAt,
    revokedAt: share.revokedAt,
    unlinkedAt: share.unlinkedAt,
  }
}

function compareShares(
  left: ReturnType<typeof toShare>,
  right: ReturnType<typeof toShare>,
): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id)
}

function testInvitationToken(): string {
  return `duet_share_${crypto.randomUUID().replaceAll('-', '')}${crypto
    .randomUUID()
    .replaceAll('-', '')}`
}
