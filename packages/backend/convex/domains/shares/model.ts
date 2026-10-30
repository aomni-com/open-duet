import { paginationOptsValidator } from 'convex/server'
import { v } from 'convex/values'

import {
  isDrivePathWithin,
  ShareIgnorePatternsSchema,
  shareIgnorePatterns,
  type ShareMode,
  type ShareSyncStatus,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { mutation, query } from '../../_generated/server'
import { getOrCreateAnchorForPath, normalizeAnchorPath, requireAnchor } from '../anchors/model'
import { requireApiInternalKey } from '../apiKeys/model'
import { activeAppsWithinShareRoot, loadWorkspaceAppsWithAnchors } from '../apps/replication'
import { writeAuditEvent } from '../audit/model'
import { sharedReplicaAdapters } from '../replication/adapters'
import { convexSharedReplicaGraph, seedSharedReplicasForShare } from '../replication/shared'
import {
  assertNoActiveKey,
  clearActiveKey,
  lookupByToken,
  mintHashedToken,
  type ActiveKeyStore,
  type HashedTokenLookup,
} from '../shared/hashedToken'
import { normalizeEmail } from '../users/identity'
import { assertActorRole, assertRole, requireCurrentUserId } from '../workspaces/authorization'
import { isLiveWorkspace, randomHex } from '../workspaces/vmToken'
import { ensureWorkspaceShareDirectoryEntry } from './directory'
import {
  SHARE_GRAPH_READ_LIMIT,
  cascadeRevokeShares,
  shareChildren,
  unlinkActiveShare,
} from './effects'
import { transitionShareLifecycle } from './lifecycle'
import { consumeShareEmailRateLimit } from './rateLimit'
import {
  SHARE_SYNC_TOKEN_TTL_MS,
  assertActiveShareAdmission,
  loadShareSyncProjectionInput,
  projectShareSyncGenerations,
  shareSyncRealizationsForShare,
  type ShareSyncGenerationProjection,
} from './syncProjection'

const WORKSPACE_SHARE_READ_LIMIT = SHARE_GRAPH_READ_LIMIT
const WORKSPACE_LINKED_ROOT_READ_LIMIT = 1000
export const SHARE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000
const SHARE_TOKEN_PATTERN = /^duet_share_[a-f0-9]{64}$/

export type PreparedShareInvitation = {
  share: ReturnType<typeof toOutgoingShare>
  sharerName: string
  folderName: string
}

export async function createShareForActor(
  ctx: MutationCtx,
  args: {
    fromWorkspaceId: Id<'workspaces'>
    toEmail: string
    path: string
    mode: ShareMode
    ignorePatterns?: string[]
    invitationToken: string
    internalKey?: string
    actorId?: Id<'users'>
    now: number
    enforceEmailRateLimit?: boolean
  },
): Promise<PreparedShareInvitation> {
  assertInvitationToken(args.invitationToken)
  const { userId, user } = await shareActor(ctx, {
    workspaceId: args.fromWorkspaceId,
    internalKey: args.internalKey,
    actorId: args.actorId,
  })
  const path = normalizeAnchorPath(args.path, 'share')
  const anchorRef = await getOrCreateAnchorForPath(ctx, {
    workspaceId: args.fromWorkspaceId,
    path,
    kind: 'share-root',
    settings: {},
    actorId: userId,
    now: args.now,
    kindConflictError: 'Anchor path is not a share-root, app, agent, or publish anchor',
    compatibleExistingKinds: ['app', 'agent', 'publish'],
  })
  const anchor = await requireAnchor(ctx, anchorRef.id as Id<'anchors'>)
  if (anchor.kind === 'app') {
    const app = await ctx.db
      .query('apps')
      .withIndex('by_workspace_and_anchor', q =>
        q.eq('workspaceId', args.fromWorkspaceId).eq('anchorId', anchor._id),
      )
      .unique()
    if (app?.sourceShareId !== undefined) throw new Error('Replica app roots cannot be shared')
  }
  if (anchor.kind === 'agent') {
    const agent = await ctx.db
      .query('agents')
      .withIndex('by_anchor', q => q.eq('anchorId', anchor._id))
      .unique()
    if (agent?.sourceShareId !== undefined) throw new Error('Replica agent roots cannot be shared')
  }
  await assertLinkedRootDoesNotNest(ctx, args.fromWorkspaceId, path, args.now, anchor._id)

  const toEmail = normalizeEmail(args.toEmail)
  const activeKey = shareActiveKey(args.fromWorkspaceId, toEmail, anchor._id)
  const activeKeys = shareActiveKeys(ctx)
  const inactiveShare = await assertNoActiveKey(
    activeKeys,
    activeKey,
    args.now,
    'An active share already exists for this email and folder',
  )
  if (args.enforceEmailRateLimit !== false) {
    await consumeShareEmailRateLimit(ctx, userId, args.now)
  }
  await clearActiveKey(activeKeys, inactiveShare)

  const shareId = await ctx.db.insert('shares', {
    anchorId: anchor._id,
    originWorkspaceId: args.fromWorkspaceId,
    fromWorkspaceId: args.fromWorkspaceId,
    toEmail,
    ...(await mintHashedToken(args.invitationToken, 16)),
    activeKey,
    expiresAt: args.now + SHARE_LIFETIME_MS,
    mode: args.mode,
    ignorePatterns: shareIgnorePatterns(args.ignorePatterns),
    state: 'pending',
    createdByUserId: userId,
    createdAt: args.now,
  })
  await ctx.db.patch(shareId, { paginationId: shareId })
  await ensureWorkspaceShareDirectoryEntry(ctx, {
    workspaceId: args.fromWorkspaceId,
    shareId,
    direction: 'outgoing',
    createdAt: args.now,
  })
  await writeAuditEvent(ctx, {
    workspaceId: args.fromWorkspaceId,
    event: 'share.created',
    actorId: userId,
    at: args.now,
    provenance: {
      shareId,
      anchorId: anchor._id,
      path,
      fromWorkspaceId: args.fromWorkspaceId,
      mode: args.mode,
      targetEmail: toEmail,
      expiresAt: args.now + SHARE_LIFETIME_MS,
    },
  })
  return {
    share: toOutgoingShare(await requireShare(ctx, shareId), args.now),
    sharerName: displayName(user),
    folderName: folderName(path),
  }
}

export async function reshareForActor(
  ctx: MutationCtx,
  args: {
    parentShareId: Id<'shares'>
    fromWorkspaceId: Id<'workspaces'>
    toEmail: string
    mode: ShareMode
    ignorePatterns?: string[]
    invitationToken: string
    internalKey?: string
    actorId?: Id<'users'>
    now: number
    enforceEmailRateLimit?: boolean
  },
): Promise<PreparedShareInvitation> {
  assertInvitationToken(args.invitationToken)
  const parent = await requireShare(ctx, args.parentShareId)
  if (parent.state !== 'active' || parent.toWorkspaceId === undefined)
    throw new Error('Parent share is not active')
  if (parent.toWorkspaceId !== args.fromWorkspaceId)
    throw new Error('Share workspace does not match')
  if (!modeAllows(parent.mode as ShareMode, args.mode))
    throw new Error('Cannot grant a mode above the parent share mode')
  const { userId, user } = await shareActor(ctx, {
    workspaceId: parent.toWorkspaceId,
    internalKey: args.internalKey,
    actorId: args.actorId,
  })
  await assertShareChildLimit(ctx, parent._id)
  const toEmail = normalizeEmail(args.toEmail)
  const activeKey = shareActiveKey(parent.toWorkspaceId, toEmail, parent.anchorId)
  const activeKeys = shareActiveKeys(ctx)
  const inactiveShare = await assertNoActiveKey(
    activeKeys,
    activeKey,
    args.now,
    'An active share already exists for this email and folder',
  )
  if (args.enforceEmailRateLimit !== false) {
    await consumeShareEmailRateLimit(ctx, userId, args.now)
  }
  await clearActiveKey(activeKeys, inactiveShare)
  const shareId = await ctx.db.insert('shares', {
    anchorId: parent.anchorId,
    originWorkspaceId: parent.originWorkspaceId,
    fromWorkspaceId: parent.toWorkspaceId,
    toEmail,
    ...(await mintHashedToken(args.invitationToken, 16)),
    activeKey,
    expiresAt: args.now + SHARE_LIFETIME_MS,
    mode: args.mode,
    ignorePatterns:
      args.ignorePatterns === undefined
        ? ShareIgnorePatternsSchema.parse(parent.ignorePatterns)
        : shareIgnorePatterns(args.ignorePatterns),
    parentShareId: parent._id,
    state: 'pending',
    createdByUserId: userId,
    createdAt: args.now,
  })
  await ctx.db.patch(shareId, { paginationId: shareId })
  await ensureWorkspaceShareDirectoryEntry(ctx, {
    workspaceId: parent.toWorkspaceId,
    shareId,
    direction: 'outgoing',
    createdAt: args.now,
  })
  await writeAuditEvent(ctx, {
    workspaceId: parent.originWorkspaceId,
    event: 'share.reshared',
    actorId: userId,
    at: args.now,
    provenance: {
      shareId,
      parentShareId: parent._id,
      anchorId: parent.anchorId,
      fromWorkspaceId: parent.toWorkspaceId,
      mode: args.mode,
      targetEmail: toEmail,
    },
  })
  const anchor = await requireAnchor(ctx, parent.anchorId)
  return {
    share: toOutgoingShare(await requireShare(ctx, shareId), args.now),
    sharerName: displayName(user),
    folderName: folderName(anchor.path),
  }
}

export const acceptShare = mutation({
  args: {
    shareId: v.optional(v.id('shares')),
    token: v.optional(v.string()),
    toWorkspaceId: v.id('workspaces'),
    mountPath: v.string(),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    const share = await shareByIdOrToken(ctx, args)
    assertPendingConsumable(share, now)
    const { userId, user } = await shareActor(ctx, {
      workspaceId: args.toWorkspaceId,
      internalKey: args.internalKey,
      actorId: args.actorId,
    })
    if (normalizeEmail(user.email) !== share.toEmail)
      throw new Error('Share recipient does not match')
    await requireLiveWorkspace(ctx, share.fromWorkspaceId, 'Share origin is not live')
    await requireLiveWorkspace(ctx, args.toWorkspaceId, 'Share recipient is not live')
    // Admission is the only pending -> active seam. Refuse both participants'
    // combined incoming/outgoing budget before anchors or replicas are written.
    await assertActiveShareAdmission(ctx, [share.fromWorkspaceId, args.toWorkspaceId])
    const mountPath = normalizeAnchorPath(args.mountPath, 'share')
    await assertLinkedRootDoesNotNest(ctx, args.toWorkspaceId, mountPath, now, undefined, true)
    /* Through the adopting owner, not the bare creator: an orphaned anchor at
       the mount path — a revoked share's old mount, a deleted agent, a reaped
       folder — is a tombstone, and re-accepting a share where one stands is
       an ordinary flow, not a conflict. The bare creator refuses ANY existing
       row with an untyped 500. */
    const mountAnchor = await getOrCreateAnchorForPath(ctx, {
      workspaceId: args.toWorkspaceId,
      path: mountPath,
      kindConflictError: 'Share mount path is already claimed by something else',
      kind: 'share-mount',
      settings: {},
      actorId: userId,
      now,
    })
    const originAnchor = await requireAnchor(ctx, share.anchorId)
    await seedSharedReplicasForShare(convexSharedReplicaGraph(ctx), sharedReplicaAdapters(ctx), {
      shareId: share._id,
      originWorkspaceId: share.originWorkspaceId,
      recipientWorkspaceId: args.toWorkspaceId,
      shareRootPath: originAnchor.path,
      mountPath,
      actorId: userId,
      now,
    })
    const transition = transitionShareLifecycle(share.state, { kind: 'accept' }, now)
    await ctx.db.patch(share._id, {
      ...transition.patch,
      toUserId: userId,
      toWorkspaceId: args.toWorkspaceId,
      mountPath,
      mountAnchorId: mountAnchor.id as Id<'anchors'>,
      activeKey: undefined,
      sync: newShareSyncState(share._id, now),
    })
    await ensureWorkspaceShareDirectoryEntry(ctx, {
      workspaceId: args.toWorkspaceId,
      shareId: share._id,
      direction: 'incoming',
      createdAt: share.createdAt,
    })
    await writeAuditEvent(ctx, {
      workspaceId: share.originWorkspaceId,
      event: 'share.accepted',
      actorId: userId,
      at: now,
      provenance: { shareId: share._id, toWorkspaceId: args.toWorkspaceId, mountPath },
    })
    return toIncomingShare(await requireShare(ctx, share._id), now)
  },
})

export const declineShare = mutation({
  args: {
    shareId: v.optional(v.id('shares')),
    token: v.optional(v.string()),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    const share = await shareByIdOrToken(ctx, args)
    assertPendingConsumable(share, now)
    const { userId, user } = await userActor(ctx, args)
    if (normalizeEmail(user.email) !== share.toEmail)
      throw new Error('Share recipient does not match')
    const transition = transitionShareLifecycle(share.state, { kind: 'decline' }, now)
    await ctx.db.patch(share._id, { ...transition.patch, toUserId: userId })
    return { ok: true as const }
  },
})

export const unlinkShare = mutation({
  args: {
    shareId: v.id('shares'),
    toWorkspaceId: v.id('workspaces'),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const share = await requireShare(ctx, args.shareId)
    if (share.toWorkspaceId === undefined) throw new Error('Share is not active')
    if (share.toWorkspaceId !== args.toWorkspaceId)
      throw new Error('Share workspace does not match')
    const { userId } = await shareActor(ctx, {
      workspaceId: share.toWorkspaceId,
      internalKey: args.internalKey,
      actorId: args.actorId,
    })
    const now = args.now ?? Date.now()
    const result = await unlinkActiveShare(ctx, { share, actorId: userId, now })
    return {
      ok: true as const,
      unlinkedShareIds: result.unlinkedShareIds,
      affectedRecipientWorkspaceIds: result.affectedRecipientWorkspaceIds,
    }
  },
})

export const setSharePaused = mutation({
  args: {
    shareId: v.id('shares'),
    workspaceId: v.id('workspaces'),
    paused: v.boolean(),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const share = await requireShare(ctx, args.shareId)
    if (share.state !== 'active' || share.toWorkspaceId === undefined) {
      throw new Error('Share is not active')
    }
    if (share.fromWorkspaceId !== args.workspaceId && share.toWorkspaceId !== args.workspaceId) {
      throw new Error('Share workspace does not match')
    }
    const { userId } = await shareActor(ctx, {
      workspaceId: args.workspaceId,
      internalKey: args.internalKey,
      actorId: args.actorId,
    })
    const currentlyPaused = share.pausedAt !== undefined
    if (currentlyPaused !== args.paused) {
      const now = args.now ?? Date.now()
      await ctx.db.patch(share._id, { pausedAt: args.paused ? now : undefined })
      await writeAuditEvent(ctx, {
        workspaceId: share.originWorkspaceId,
        event: args.paused ? 'share.paused' : 'share.resumed',
        actorId: userId,
        at: now,
        provenance: { shareId: share._id, fromWorkspaceId: args.workspaceId },
      })
    }
    const updated = await requireShare(ctx, share._id)
    return args.workspaceId === share.fromWorkspaceId
      ? toOutgoingShare(updated, args.now ?? Date.now())
      : toIncomingShare(updated, args.now ?? Date.now())
  },
})

export const revokeShare = mutation({
  args: {
    shareId: v.id('shares'),
    fromWorkspaceId: v.id('workspaces'),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const share = await requireShare(ctx, args.shareId)
    if (share.fromWorkspaceId !== args.fromWorkspaceId)
      throw new Error('Share workspace does not match')
    const { userId } = await shareActor(ctx, {
      workspaceId: share.fromWorkspaceId,
      internalKey: args.internalKey,
      actorId: args.actorId,
    })
    const now = args.now ?? Date.now()
    const affectedRecipientWorkspaceIds = new Set<Id<'workspaces'>>()
    const revokedShareIds = await cascadeRevokeShares(
      ctx,
      share._id,
      now,
      affectedRecipientWorkspaceIds,
    )
    await writeAuditEvent(ctx, {
      workspaceId: share.originWorkspaceId,
      event: 'share.revoked',
      actorId: userId,
      at: now,
      provenance: { shareId: share._id, revokedShareIds, fromWorkspaceId: share.fromWorkspaceId },
    })
    return {
      ok: true as const,
      revokedShareIds,
      affectedRecipientWorkspaceIds: [...affectedRecipientWorkspaceIds],
    }
  },
})

export const listForWorkspacePage = query({
  args: {
    workspaceId: v.id('workspaces'),
    internalKey: v.optional(v.string()),
    now: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    if (args.internalKey !== undefined) requireApiInternalKey(args.internalKey)
    else await assertRole(ctx, args.workspaceId, 'viewer')
    const directoryPage = await ctx.db
      .query('workspaceShareDirectory')
      .withIndex('by_workspace_order', query => query.eq('workspaceId', args.workspaceId))
      .order('asc')
      .paginate(args.paginationOpts)
    const entries = await Promise.all(
      directoryPage.page.map(async entry => {
        const share = await ctx.db.get(entry.shareId)
        if (share === null) throw new Error('Workspace share directory is dangling')
        return { entry, share }
      }),
    )
    const active = new Map(
      entries
        .map(({ share }) => share)
        .filter(share => share.state === 'active')
        .map(share => [share._id, share]),
    )
    const generations =
      active.size === 0
        ? []
        : await projectShareSyncGenerations({
            ...(await loadShareSyncProjectionInput(ctx, [...active.values()])),
            now: args.now,
          })
    const generationByShare = new Map(generations.map(row => [row.shareId, row]))
    const realizationByShare = new Map(
      await Promise.all(
        [...active.keys()].map(async shareId => {
          return [shareId, await shareSyncRealizationsForShare(ctx, shareId)] as const
        }),
      ),
    )
    return {
      ...directoryPage,
      page: await Promise.all(
        entries.map(({ entry, share }) => {
          const syncStatus = syncStatusForShare(
            share,
            generationByShare.get(share._id),
            realizationByShare.get(share._id) ?? [],
          )
          return entry.direction === 'incoming'
            ? toIncomingManagementShare(ctx, share, args.now, syncStatus).then(row => ({
                ...row,
                direction: 'incoming' as const,
              }))
            : toOutgoingManagementShare(ctx, share, args.now, syncStatus).then(row => ({
                ...row,
                direction: 'outgoing' as const,
              }))
        }),
      ),
    }
  },
})

export const listPendingForUserPage = query({
  args: {
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
    now: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const { user } = await userActor(ctx, args)
    const email = normalizeEmail(user.email)
    const result = await ctx.db
      .query('shares')
      .withIndex('by_to_email_state_declinedAt_expiresAt', query =>
        query
          .eq('toEmail', email)
          .eq('state', 'pending')
          .eq('declinedAt', undefined)
          .gt('expiresAt', args.now),
      )
      .order('asc')
      // One request can inspect the source workspace's full accepted 100-app budget.
      // Do not multiply that supporting work across sources in one transaction.
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(args.paginationOpts.numItems, 1),
      })
    const workspaceApps = new Map<
      Id<'workspaces'>,
      ReturnType<typeof loadWorkspaceAppsWithAnchors>
    >()
    return {
      ...result,
      page: await Promise.all(
        result.page.map(share => toShareRequest(ctx, share, args.now, workspaceApps)),
      ),
    }
  },
})

export const resolveShareToken = query({
  args: {
    token: v.string(),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const { user } = await userActor(ctx, args)
    const share = await shareByToken(ctx, args.token)
    if (
      share === null ||
      normalizeEmail(user.email) !== share.toEmail ||
      share.declinedAt !== undefined ||
      share.state !== 'pending' ||
      share.expiresAt <= args.now
    ) {
      throw new Error('Share request not found')
    }
    return await toShareRequest(ctx, share, args.now)
  },
})

async function shareActor(
  ctx: QueryCtx | MutationCtx,
  args: { workspaceId: Id<'workspaces'>; internalKey?: string; actorId?: Id<'users'> },
): Promise<{ userId: Id<'users'>; user: Doc<'users'> }> {
  let role: { userId: Id<'users'> }
  if (args.internalKey !== undefined) {
    requireApiInternalKey(args.internalKey)
    if (args.actorId === undefined)
      throw new Error('actorId is required for internal share mutation')
    role = await assertActorRole(ctx, args.workspaceId, args.actorId, 'editor')
  } else {
    if (args.actorId !== undefined) throw new Error('actorId requires internalKey')
    role = await assertRole(ctx, args.workspaceId, 'editor')
  }
  const user = await ctx.db.get(role.userId)
  if (user === null) throw new Error('Unauthenticated')
  return { userId: role.userId, user }
}

async function userActor(
  ctx: QueryCtx | MutationCtx,
  args: { internalKey?: string; actorId?: Id<'users'> },
): Promise<{ userId: Id<'users'>; user: Doc<'users'> }> {
  let userId: Id<'users'>
  if (args.internalKey !== undefined) {
    requireApiInternalKey(args.internalKey)
    if (args.actorId === undefined)
      throw new Error('actorId is required for internal share request')
    userId = args.actorId
  } else {
    if (args.actorId !== undefined) throw new Error('actorId requires internalKey')
    userId = await requireCurrentUserId(ctx)
  }
  const user = await ctx.db.get(userId)
  if (user === null) throw new Error('Unauthenticated')
  return { userId, user }
}

async function requireLiveWorkspace(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  message: string,
): Promise<Doc<'workspaces'>> {
  const workspace = await ctx.db.get(workspaceId)
  if (workspace === null || !isLiveWorkspace(workspace)) throw new Error(message)
  return workspace
}

async function shareByIdOrToken(
  ctx: QueryCtx | MutationCtx,
  args: { shareId?: Id<'shares'>; token?: string },
): Promise<Doc<'shares'>> {
  if ((args.shareId === undefined) === (args.token === undefined))
    throw new Error('Exactly one of shareId or token is required')
  if (args.shareId !== undefined) return await requireShare(ctx, args.shareId)
  if (args.token === undefined) throw new Error('Share token is required')
  const share = await shareByToken(ctx, args.token)
  if (share === null) throw new Error('Share request not found')
  return share
}

async function shareByToken(
  ctx: QueryCtx | MutationCtx,
  token: string,
): Promise<Doc<'shares'> | null> {
  return await lookupByToken(shareTokenLookup(ctx), token)
}

function assertPendingConsumable(share: Doc<'shares'>, now: number): void {
  if (share.state !== 'pending') throw new Error(`Share is ${share.state}`)
  if (share.declinedAt !== undefined) throw new Error('Share request was declined')
  if (share.expiresAt <= now) throw new Error('Share request expired')
}

async function assertLinkedRootDoesNotNest(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  path: string,
  now: number,
  exceptAnchorId?: Id<'anchors'>,
  protectManagedAnchors = false,
): Promise<void> {
  const activeOutgoing = await ctx.db
    .query('shares')
    .withIndex('by_from_workspace_state_declinedAt_expiresAt', q =>
      q.eq('fromWorkspaceId', workspaceId).eq('state', 'active'),
    )
    .take(WORKSPACE_SHARE_READ_LIMIT + 1)
  const pendingOutgoing = await ctx.db
    .query('shares')
    .withIndex('by_from_workspace_state_declinedAt_expiresAt', q =>
      q
        .eq('fromWorkspaceId', workspaceId)
        .eq('state', 'pending')
        .eq('declinedAt', undefined)
        .gt('expiresAt', now),
    )
    .take(WORKSPACE_SHARE_READ_LIMIT + 1)
  const incoming = await ctx.db
    .query('shares')
    .withIndex('by_to_workspace_state', q =>
      q.eq('toWorkspaceId', workspaceId).eq('state', 'active'),
    )
    .take(WORKSPACE_SHARE_READ_LIMIT + 1)
  if (
    activeOutgoing.length + pendingOutgoing.length > WORKSPACE_SHARE_READ_LIMIT ||
    incoming.length > WORKSPACE_SHARE_READ_LIMIT
  ) {
    throw new Error('Workspace linked-root limit exceeded')
  }
  const linkedPaths = new Map<Id<'anchors'>, string>()
  for (const share of [...activeOutgoing, ...pendingOutgoing]) {
    if (share.anchorId === exceptAnchorId) continue
    const anchor = await ctx.db.get(share.anchorId)
    if (anchor?.state === 'active') linkedPaths.set(anchor._id, anchor.path)
  }
  for (const share of incoming) {
    if (share.mountAnchorId === undefined || share.mountPath === undefined) continue
    linkedPaths.set(share.mountAnchorId, share.mountPath)
  }
  for (const linkedPath of linkedPaths.values()) {
    if (isDrivePathWithin(linkedPath, path) || isDrivePathWithin(path, linkedPath))
      throw new Error('Linked roots cannot contain each other')
  }

  if (!protectManagedAnchors) return
  const anchors = await ctx.db
    .query('anchors')
    .withIndex('by_workspace_state', q => q.eq('workspaceId', workspaceId).eq('state', 'active'))
    .take(WORKSPACE_LINKED_ROOT_READ_LIMIT + 1)
  if (anchors.length > WORKSPACE_LINKED_ROOT_READ_LIMIT)
    throw new Error('Workspace linked-root limit exceeded')
  for (const anchor of anchors) {
    if (anchor._id === exceptAnchorId) continue
    const collidesWithProtectedEntity =
      (anchor.kind === 'app' || anchor.kind === 'agent') &&
      (isDrivePathWithin(anchor.path, path) || isDrivePathWithin(path, anchor.path))
    if (collidesWithProtectedEntity) throw new Error('Linked roots cannot contain each other')
  }
}

export async function revokeShareAfterDeliveryFailure(
  ctx: MutationCtx,
  args: { shareId: Id<'shares'>; actorId: Id<'users'>; now: number },
): Promise<void> {
  const share = await requireShare(ctx, args.shareId)
  if (share.createdByUserId !== args.actorId) throw new Error('Share creator does not match')
  if (share.state !== 'pending') return
  const revokedShareIds = await cascadeRevokeShares(ctx, share._id, args.now)
  await writeAuditEvent(ctx, {
    workspaceId: share.originWorkspaceId,
    event: 'share.revoked',
    actorId: args.actorId,
    at: args.now,
    provenance: {
      shareId: share._id,
      revokedShareIds,
      fromWorkspaceId: share.fromWorkspaceId,
      reason: 'email_delivery_failed',
    },
  })
}

async function assertShareChildLimit(
  ctx: QueryCtx | MutationCtx,
  parentShareId: Id<'shares'>,
): Promise<void> {
  if ((await shareChildren(ctx, parentShareId)).length >= WORKSPACE_SHARE_READ_LIMIT)
    throw new Error('Share child limit exceeded')
}

async function requireShare(
  ctx: QueryCtx | MutationCtx,
  shareId: Id<'shares'>,
): Promise<Doc<'shares'>> {
  const share = await ctx.db.get(shareId)
  if (share === null) throw new Error('Share not found')
  return share
}

function newShareSyncState(shareId: Id<'shares'>, now: number): Doc<'shares'>['sync'] {
  return {
    sourceToTargetAcceptId: `share-${shareId}-source-to-target`,
    targetToSourceAcceptId: `share-${shareId}-target-to-source`,
    sourceToTargetNonce: randomHex(16),
    targetToSourceNonce: randomHex(16),
    tokenSecret: randomHex(32),
    tokenExpiresAt: now + SHARE_SYNC_TOKEN_TTL_MS,
    preparedAt: now,
  }
}

function shareActiveKey(
  fromWorkspaceId: Id<'workspaces'>,
  toEmail: string,
  anchorId: Id<'anchors'>,
): string {
  return `${fromWorkspaceId}:${toEmail}:${anchorId}`
}

function shareTokenLookup(ctx: QueryCtx | MutationCtx): HashedTokenLookup<Doc<'shares'>> {
  return {
    byTokenHash: async tokenHash =>
      await ctx.db
        .query('shares')
        .withIndex('by_tokenHash', q => q.eq('tokenHash', tokenHash))
        .unique(),
  }
}

function shareActiveKeys(ctx: MutationCtx): ActiveKeyStore<Doc<'shares'>> {
  return {
    byActiveKey: async activeKey =>
      await ctx.db
        .query('shares')
        .withIndex('by_activeKey', q => q.eq('activeKey', activeKey))
        .unique(),
    clear: async share => {
      await ctx.db.patch(share._id, { activeKey: undefined })
    },
  }
}

function assertInvitationToken(token: string): void {
  if (!SHARE_TOKEN_PATTERN.test(token)) throw new Error('Invalid share invitation token')
}

function displayName(user: Doc<'users'>): string {
  return user.name?.trim() || user.email
}

function folderName(path: string): string {
  return path.split('/').at(-1) || 'workspace'
}

function modeAllows(parent: ShareMode, requested: ShareMode): boolean {
  return parent === 'write' || requested === 'read'
}

function effectiveState(share: Doc<'shares'>, now: number) {
  return share.state === 'pending' && share.expiresAt <= now ? ('expired' as const) : share.state
}

function projectionBase(share: Doc<'shares'>, now: number) {
  return {
    id: share._id,
    anchorId: share.anchorId,
    originWorkspaceId: share.originWorkspaceId,
    fromWorkspaceId: share.fromWorkspaceId,
    toEmail: share.toEmail,
    toUserId: share.toUserId,
    toWorkspaceId: share.toWorkspaceId,
    mode: share.mode as ShareMode,
    ignorePatterns: share.ignorePatterns,
    parentShareId: share.parentShareId,
    state: effectiveState(share, now),
    createdByUserId: share.createdByUserId,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    acceptedAt: share.acceptedAt,
    pausedAt: share.pausedAt,
    revokedAt: share.revokedAt,
    unlinkedAt: share.unlinkedAt,
  }
}

function toIncomingShare(share: Doc<'shares'>, now: number) {
  return { ...projectionBase(share, now), mountPath: share.mountPath }
}

async function toShareRequest(
  ctx: QueryCtx,
  share: Doc<'shares'>,
  now: number,
  workspaceApps?: Map<Id<'workspaces'>, ReturnType<typeof loadWorkspaceAppsWithAnchors>>,
) {
  const sourcePath = await shareSourcePath(ctx, share)
  let appsPromise = workspaceApps?.get(share.fromWorkspaceId)
  if (appsPromise === undefined) {
    appsPromise = loadWorkspaceAppsWithAnchors(ctx, share.fromWorkspaceId)
    workspaceApps?.set(share.fromWorkspaceId, appsPromise)
  }
  const [sourceWorkspace, sharer, includedApps] = await Promise.all([
    ctx.db.get(share.fromWorkspaceId),
    ctx.db.get(share.createdByUserId),
    appsPromise.then(apps => activeAppsWithinShareRoot(apps, sourcePath)),
  ])
  if (sourceWorkspace === null) throw new Error('Share source workspace not found')
  if (sharer === null) throw new Error('Share creator not found')
  return {
    ...toIncomingShare(share, now),
    source: {
      workspaceName: sourceWorkspace.name,
      path: sourcePath,
      folderName: folderName(sourcePath),
      sharerName: displayName(sharer),
      originLive: isLiveWorkspace(sourceWorkspace),
      apps: includedApps
        .map(({ app, anchor }) => ({ slug: app.slug, path: anchor.path }))
        .sort(
          (left, right) =>
            left.path.localeCompare(right.path) || left.slug.localeCompare(right.slug),
        ),
    },
  }
}

async function shareSourcePath(ctx: QueryCtx, share: Doc<'shares'>): Promise<string> {
  if (share.parentShareId !== undefined) {
    const parent = await requireShare(ctx, share.parentShareId)
    if (parent.mountPath === undefined) throw new Error('Parent share mount path is missing')
    return parent.mountPath
  }
  return (await requireAnchor(ctx, share.anchorId)).path
}

function toOutgoingShare(share: Doc<'shares'>, now: number) {
  return { ...projectionBase(share, now), tokenPrefix: share.tokenPrefix }
}

async function toIncomingManagementShare(
  ctx: QueryCtx,
  share: Doc<'shares'>,
  now: number,
  syncStatus: ShareSyncStatus | undefined,
) {
  const [sourceWorkspace, sharer] = await Promise.all([
    ctx.db.get(share.fromWorkspaceId),
    ctx.db.get(share.createdByUserId),
  ])
  if (sourceWorkspace === null) throw new Error('Share source workspace not found')
  if (sharer === null) throw new Error('Share creator not found')
  return {
    ...toIncomingShare(share, now),
    sharerName: displayName(sharer),
    sourceWorkspaceName: sourceWorkspace.name,
    ...(syncStatus === undefined ? {} : { syncStatus }),
  }
}

async function toOutgoingManagementShare(
  ctx: QueryCtx,
  share: Doc<'shares'>,
  now: number,
  syncStatus: ShareSyncStatus | undefined,
) {
  return {
    ...toOutgoingShare(share, now),
    sourcePath: await shareSourcePath(ctx, share),
    ...(syncStatus === undefined ? {} : { syncStatus }),
  }
}

function syncStatusForShare(
  share: Doc<'shares'>,
  generations: ShareSyncGenerationProjection | undefined,
  realizations: Doc<'shareSyncRealizations'>[],
): ShareSyncStatus | undefined {
  if (share.state !== 'active' || share.toWorkspaceId === undefined) return undefined
  const byWorkspace = new Map(realizations.map(row => [row.workspaceId, row]))
  const realization = (
    workspaceId: Id<'workspaces'>,
    expectedGeneration: string | undefined,
  ): ShareSyncStatus['origin'] => {
    const row = byWorkspace.get(workspaceId)
    if (row === undefined) return undefined
    return {
      state: row.state,
      matchesCurrentGeneration:
        expectedGeneration !== undefined && row.generation === expectedGeneration,
      ...(row.errorCode === undefined ? {} : { errorCode: row.errorCode }),
      updatedAt: row.updatedAt,
    }
  }
  return {
    origin: realization(share.fromWorkspaceId, generations?.origin.generation),
    recipient: realization(share.toWorkspaceId, generations?.recipient.generation),
  }
}
