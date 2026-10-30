import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import { ConvexError } from 'convex/values'

import { internal } from '../../_generated/api'
import type { DataModel, Doc, Id } from '../../_generated/dataModel'
import { PRODUCT_BACKEND_ANALYTICS_ORIGIN, emitAnalyticsEvent } from '../analytics/model'
import { writeAuditEvent } from '../audit/model'
import { claimCampaignHandoffAttribution } from '../campaigns/handoff'
import {
  assertNoActiveKey,
  clearActiveKey,
  lookupByToken,
  mintHashedToken,
  type ActiveKeyStore,
  type HashedTokenLookup,
} from '../shared/hashedToken'
import { normalizeEmail } from '../users/identity'
import { assertActorRole, isLiveWorkspace, type WorkspaceRole } from '../workspaces/authorization'
import { createWorkspaceRow } from '../workspaces/birth'
import { insertWorkspaceMember } from '../workspaces/memberDirectory'
import { scheduleWorkspaceVm } from '../workspaces/vmSchedule'
import { retrier } from '../../utils'

type MutationCtx = GenericMutationCtx<DataModel>
type QueryCtx = GenericQueryCtx<DataModel>
export interface BootstrapTokens {
  invite?: string
  acquisition?: string
}

interface BootstrapOptions {
  requiresOnboarding?: boolean
  now?: number
  /**
   * What the caller asked this workspace to be called at birth. Absent — which
   * is every browser signup — leaves the derivation below untouched, and this
   * stays the one place that answers "what is a new workspace called".
   *
   * Birth is the only clean moment to honor it: renaming later moves the slug,
   * and with it the workspace's public addresses.
   */
  workspaceName?: string
}

export const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000
export const INVITE_FAILURE_MESSAGE = 'Invite could not be accepted'

export async function bootstrapUser(
  ctx: MutationCtx,
  userId: Id<'users'>,
  tokens: BootstrapTokens = {},
  options: BootstrapOptions = {},
): Promise<{ workspaceId: Id<'workspaces'>; invited: boolean }> {
  const user = await ctx.db.get(userId)
  if (user === null) throw new Error('Unauthenticated')
  await finalizeSignup(ctx, user, tokens.acquisition, options)

  if (tokens.invite !== undefined) {
    return await consumeInvite(ctx, {
      token: tokens.invite,
      userId,
      canonicalEmail: normalizeEmail(user.email),
    })
  }

  // Membership rows outlive the workspaces they point at: deleting a workspace
  // tombstones the row and cascades nothing, and no cron collects either. So
  // "does this user already have a home" has to ask whether the workspace is
  // still live, not merely whether a membership exists — otherwise a returning
  // user whose only workspace was deleted is handed the tombstone and never
  // gets the workspace they came back for. The cap bounds a pathological
  // membership list; a user with more live workspaces than this still has one.
  const memberships = await ctx.db
    .query('workspaceMembers')
    .withIndex('by_user_and_workspace', q => q.eq('userId', userId))
    .take(100)
  for (const membership of memberships) {
    const workspace = await ctx.db.get(membership.workspaceId)
    if (workspace !== null && isLiveWorkspace(workspace.status)) {
      return { workspaceId: membership.workspaceId, invited: false }
    }
  }

  const workspaceName =
    options.workspaceName?.trim() ||
    (user.name?.trim()
      ? `${user.name.trim()}'s Workspace`
      : `${user.email.split('@')[0] ?? 'Workspace'}'s Workspace`)
  const { workspaceId } = await createWorkspaceRow(ctx, {
    ownerUserId: userId,
    name: workspaceName,
    requiresOnboarding: options.requiresOnboarding !== false,
  })
  if (options.requiresOnboarding === false) await scheduleWorkspaceVm(ctx, workspaceId)
  return { workspaceId, invited: false }
}

async function finalizeSignup(
  ctx: MutationCtx,
  user: Doc<'users'>,
  acquisitionToken: string | undefined,
  options: BootstrapOptions,
): Promise<void> {
  const now = options.now ?? Date.now()
  let acquisition: Doc<'campaignAttributions'> | null = null
  if (user.acquisitionAttributionId === undefined && acquisitionToken !== undefined) {
    acquisition = await claimCampaignHandoffAttribution(ctx, acquisitionToken, now, user._id)
  }
  const acquisitionAttributionId = user.acquisitionAttributionId ?? acquisition?._id ?? undefined

  const firstSignup = user.signupProcessedAt === undefined
  if (
    user.signupProcessedAt === undefined ||
    (user.acquisitionAttributionId === undefined && acquisitionAttributionId !== undefined)
  ) {
    await ctx.db.patch(user._id, {
      ...(user.signupProcessedAt === undefined ? { signupProcessedAt: now } : {}),
      ...(acquisitionAttributionId === undefined ? {} : { acquisitionAttributionId }),
    })
  }
  if (!firstSignup) return

  await emitAnalyticsEvent(ctx, {
    id: `signup:${user._id}`,
    name: 'user.signed_up',
    version: 1,
    at: now,
    origin: PRODUCT_BACKEND_ANALYTICS_ORIGIN,
    userId: user._id,
    ...(acquisitionAttributionId === undefined ? {} : { attributionId: acquisitionAttributionId }),
    properties: {},
  })
  await retrier.run(ctx, internal.services.resendContacts.syncUser, { userId: user._id })
}

export async function createInviteForActor(
  ctx: MutationCtx,
  args: {
    actorId: Id<'users'>
    workspaceId: Id<'workspaces'>
    email: string
    role: Exclude<WorkspaceRole, 'owner'>
    token: string
    now: number
  },
): Promise<Doc<'workspaceInvites'>> {
  await assertActorRole(ctx, args.workspaceId, args.actorId, 'owner')
  return await createInviteRow(ctx, { ...args, inviterUserId: args.actorId })
}

async function createInviteRow(
  ctx: MutationCtx,
  args: {
    inviterUserId: Id<'users'>
    workspaceId: Id<'workspaces'>
    email: string
    role: Exclude<WorkspaceRole, 'owner'>
    token: string
    now: number
  },
): Promise<Doc<'workspaceInvites'>> {
  const email = normalizeEmail(args.email)
  const activeKey = `${args.workspaceId}:${email}`
  const activeKeys = inviteActiveKeys(ctx)
  const inactiveInvite = await assertNoActiveKey(
    activeKeys,
    activeKey,
    args.now,
    'An active invite already exists for this email',
  )
  await clearActiveKey(activeKeys, inactiveInvite)

  const inviteId = await ctx.db.insert('workspaceInvites', {
    workspaceId: args.workspaceId,
    email,
    role: args.role,
    ...(await mintHashedToken(args.token, 10)),
    activeKey,
    inviterUserId: args.inviterUserId,
    expiresAt: args.now + INVITE_LIFETIME_MS,
    createdAt: args.now,
  })
  await ctx.db.patch(inviteId, { paginationId: inviteId })
  await writeAuditEvent(ctx, {
    workspaceId: args.workspaceId,
    event: 'workspace.invite_created',
    actorId: args.inviterUserId,
    provenance: { targetEmail: email, role: args.role, expiresAt: args.now + INVITE_LIFETIME_MS },
    at: args.now,
  })
  return (await ctx.db.get(inviteId))!
}

async function visibleInvites(
  ctx: QueryCtx,
  workspaceId: Id<'workspaces'>,
  paginationOpts: { cursor: string | null; numItems: number },
) {
  const result = await ctx.db
    .query('workspaceInvites')
    .withIndex('by_workspace_createdAt_id', q => q.eq('workspaceId', workspaceId))
    .order('desc')
    .paginate(paginationOpts)
  return {
    ...result,
    page: result.page.map(({ tokenHash: _tokenHash, ...invite }) => invite),
  }
}

export async function listInvitesForActor(
  ctx: QueryCtx,
  workspaceId: Id<'workspaces'>,
  actorId: Id<'users'>,
  paginationOpts: { cursor: string | null; numItems: number },
) {
  await assertActorRole(ctx, workspaceId, actorId, 'owner')
  return await visibleInvites(ctx, workspaceId, paginationOpts)
}

async function revokeInviteRow(
  ctx: MutationCtx,
  invite: Doc<'workspaceInvites'>,
  actorId: Id<'users'>,
  now: number,
): Promise<{ revokedAt: number }> {
  if (invite.consumedAt !== undefined) throw new Error('Invite not found')
  const revokedAt = invite.revokedAt ?? now
  if (invite.revokedAt === undefined) {
    await ctx.db.patch(invite._id, { revokedAt, activeKey: undefined })
    await writeAuditEvent(ctx, {
      workspaceId: invite.workspaceId,
      event: 'workspace.invite_revoked',
      actorId,
      provenance: { targetEmail: invite.email, role: invite.role },
      at: now,
    })
  }
  return { revokedAt }
}

export async function listIncomingInvites(
  ctx: QueryCtx,
  actorId: Id<'users'>,
  asOf: number,
  paginationOpts: { cursor: string | null; numItems: number },
) {
  const user = await ctx.db.get(actorId)
  if (user === null) throw new Error('Unauthenticated')
  const result = await ctx.db
    .query('workspaceInvites')
    .withIndex('by_pending_email', q =>
      q
        .eq('email', normalizeEmail(user.email))
        .eq('consumedAt', undefined)
        .eq('revokedAt', undefined)
        .gt('expiresAt', asOf),
    )
    .order('asc')
    .paginate(paginationOpts)
  const page = await Promise.all(
    result.page.map(async invite => {
      const [workspace, inviter] = await Promise.all([
        ctx.db.get(invite.workspaceId),
        ctx.db.get(invite.inviterUserId),
      ])
      if (workspace === null || !isLiveWorkspace(workspace.status)) return null
      return {
        id: invite._id,
        workspace: { id: workspace._id, name: workspace.name, slug: workspace.slug },
        inviter:
          inviter === null
            ? null
            : {
                email: inviter.email,
                ...(inviter.name === undefined ? {} : { name: inviter.name }),
              },
        role: invite.role,
        expiresAt: invite.expiresAt,
      }
    }),
  )
  return { ...result, page: page.filter(invite => invite !== null) }
}

export async function revokeInviteForActor(
  ctx: MutationCtx,
  inviteId: Id<'workspaceInvites'>,
  actorId: Id<'users'>,
  now: number,
): Promise<{ revokedAt: number }> {
  const invite = await ctx.db.get(inviteId)
  if (invite === null) throw new Error('Invite not found')
  await assertActorRole(ctx, invite.workspaceId, actorId, 'owner')
  return await revokeInviteRow(ctx, invite, actorId, now)
}

async function consumeInvite(
  ctx: MutationCtx,
  args: { token: string; userId: Id<'users'>; canonicalEmail: string },
): Promise<{ workspaceId: Id<'workspaces'>; invited: true }> {
  const invite = await lookupByToken(inviteTokenLookup(ctx), args.token)
  return await consumeInviteRow(ctx, invite, args)
}

export async function acceptIncomingInvite(
  ctx: MutationCtx,
  actorId: Id<'users'>,
  inviteId: string,
) {
  const user = await ctx.db.get(actorId)
  if (user === null) throw new Error('Unauthenticated')
  const id = ctx.db.normalizeId('workspaceInvites', inviteId)
  const result = await consumeInviteRow(ctx, id === null ? null : await ctx.db.get(id), {
    userId: actorId,
    canonicalEmail: normalizeEmail(user.email),
  })
  const workspace = await ctx.db.get(result.workspaceId)
  if (workspace === null || !isLiveWorkspace(workspace.status))
    throw new ConvexError(INVITE_FAILURE_MESSAGE)
  return { workspaceId: workspace._id, workspaceSlug: workspace.slug }
}

async function consumeInviteRow(
  ctx: MutationCtx,
  invite: Doc<'workspaceInvites'> | null,
  args: { userId: Id<'users'>; canonicalEmail: string },
): Promise<{ workspaceId: Id<'workspaces'>; invited: true }> {
  if (invite === null || invite.email !== args.canonicalEmail || invite.revokedAt !== undefined) {
    throw new ConvexError(INVITE_FAILURE_MESSAGE)
  }
  if (invite.consumedAt !== undefined) {
    if (invite.consumedByUserId !== args.userId) throw new ConvexError(INVITE_FAILURE_MESSAGE)
    const existing = await ctx.db
      .query('workspaceMembers')
      .withIndex('by_workspace_and_user', q =>
        q.eq('workspaceId', invite.workspaceId).eq('userId', args.userId),
      )
      .unique()
    if (existing === null) throw new ConvexError(INVITE_FAILURE_MESSAGE)
    return { workspaceId: invite.workspaceId, invited: true }
  }

  const now = Date.now()
  if (invite.expiresAt <= now) throw new ConvexError(INVITE_FAILURE_MESSAGE)

  const workspace = await ctx.db.get(invite.workspaceId)
  if (workspace === null || workspace.status === 'deleted' || workspace.status === 'retired') {
    throw new ConvexError(INVITE_FAILURE_MESSAGE)
  }
  const existing = await ctx.db
    .query('workspaceMembers')
    .withIndex('by_workspace_and_user', q =>
      q.eq('workspaceId', invite.workspaceId).eq('userId', args.userId),
    )
    .unique()
  if (existing === null) {
    await insertWorkspaceMember(ctx, {
      workspaceId: invite.workspaceId,
      userId: args.userId,
      role: invite.role,
    })
  }
  await ctx.db.patch(invite._id, {
    consumedAt: now,
    consumedByUserId: args.userId,
    activeKey: undefined,
  })
  await writeAuditEvent(ctx, {
    workspaceId: invite.workspaceId,
    event: 'workspace.invite_accepted',
    actorId: args.userId,
    provenance: { targetEmail: invite.email, role: invite.role },
    at: now,
  })
  return { workspaceId: invite.workspaceId, invited: true }
}

function inviteTokenLookup(
  ctx: QueryCtx | MutationCtx,
): HashedTokenLookup<Doc<'workspaceInvites'>> {
  return {
    byTokenHash: async tokenHash =>
      await ctx.db
        .query('workspaceInvites')
        .withIndex('by_tokenHash', q => q.eq('tokenHash', tokenHash))
        .unique(),
  }
}

function inviteActiveKeys(ctx: MutationCtx): ActiveKeyStore<Doc<'workspaceInvites'>> {
  return {
    byActiveKey: async activeKey =>
      await ctx.db
        .query('workspaceInvites')
        .withIndex('by_activeKey', q => q.eq('activeKey', activeKey))
        .unique(),
    clear: async invite => {
      await ctx.db.patch(invite._id, { activeKey: undefined })
    },
  }
}
