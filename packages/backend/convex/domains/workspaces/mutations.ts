import { v } from 'convex/values'

import { ModelSelectionIdSchema, WorkspaceNameSchema, WorkspaceSlugSchema } from '@repo/contract'

import type { Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { mutation } from '../../_generated/server'
import { deleteWorkspaceMembershipGeneration } from '../agentSessions/membershipRemoval'
import { requireApiInternalKey } from '../apiKeys/model'
import { writeAuditEvent } from '../audit/model'
import { beginDomainRemovalForWorkspace } from '../customDomains/model'
import { reapMcpCredentialsForWorkspace } from '../mcpServers/disconnect'
import { deletionPage } from '../workspaceBackups/deletion'
import { assertActorRole, assertRole, type WorkspaceRole } from './authorization'
import { reassignWorkspacePayer } from './billingUser'
import { requireAvailableWorkspaceSlug } from './internal'
import { writeMemberDirectoryEntry } from './memberDirectory'
import { scheduleWorkspaceVmTeardown } from './vmTeardownSchedule'

const roleValidator = v.union(v.literal('owner'), v.literal('editor'), v.literal('viewer'))

export const rename = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    slug: v.string(),
    name: v.optional(v.string()),
    publicUrlBreakAcknowledged: v.optional(v.boolean()),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
  },
  handler: async (ctx, args) => {
    let userId = args.actorId
    if (args.internalKey !== undefined) {
      requireApiInternalKey(args.internalKey)
      if (userId === undefined) throw new Error('actorId is required for internal workspace rename')
      await assertActorRole(ctx, args.workspaceId, userId, 'owner')
    } else {
      if (userId !== undefined) throw new Error('actorId requires internalKey')
      userId = (await assertRole(ctx, args.workspaceId, 'owner')).userId
    }
    const slug = await requireAvailableWorkspaceSlug(
      ctx,
      WorkspaceSlugSchema.parse(args.slug),
      args.workspaceId,
    )
    const now = Date.now()
    await ctx.db.patch(args.workspaceId, {
      slug,
      ...(args.name === undefined ? {} : { name: WorkspaceNameSchema.parse(args.name) }),
      updatedAt: now,
    })
    await writeAuditEvent(ctx, {
      workspaceId: args.workspaceId,
      event: 'workspace.renamed',
      actorId: userId,
      at: now,
      provenance: {
        breaksPublicUrls: true,
        acknowledged: args.publicUrlBreakAcknowledged === true,
      },
    })
  },
})

export const deleteWorkspace = mutation({
  args: {
    workspaceId: v.id('workspaces'),
  },
  handler: async (ctx, args) => {
    const { userId } = await assertRole(ctx, args.workspaceId, 'owner', {
      allowNonLiveWorkspace: true,
    })
    await deleteWorkspaceImpl(ctx, { workspaceId: args.workspaceId, actorId: userId })
  },
})

export async function deleteWorkspaceImpl(
  ctx: MutationCtx,
  args: { workspaceId: Id<'workspaces'>; actorId: Id<'users'>; now?: number },
): Promise<void> {
  const now = args.now ?? Date.now()
  await ctx.db.patch(args.workspaceId, {
    status: 'deleted',
    pendingBackupLifecycle: undefined,
    lifecycleBackupId: undefined,
    updatedAt: now,
    vmTokenHash: undefined,
    syncthingDeviceId: undefined,
  })
  await beginDomainRemovalForWorkspace(ctx, args.workspaceId, now)
  await ctx.scheduler.runAfter(0, deletionPage, { workspaceId: args.workspaceId, cursor: null })
  // Third-party MCP tokens and client registrations do not survive their
  // workspace. Deleting one is the only remaining event that can reach them —
  // once the workspace is gone there is no server row, no member and no route
  // left through which anyone could ever disconnect them.
  await reapMcpCredentialsForWorkspace(ctx, args.workspaceId)
  await writeAuditEvent(ctx, {
    workspaceId: args.workspaceId,
    event: 'workspace.deleted',
    actorId: args.actorId,
    at: now,
  })
  await scheduleWorkspaceVmTeardown(ctx, args.workspaceId)
}

export const setSuspended = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    suspended: v.boolean(),
    reason: v.optional(v.string()),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let userId = args.actorId
    if (args.internalKey !== undefined) {
      requireApiInternalKey(args.internalKey)
      if (userId === undefined)
        throw new Error('actorId is required for internal workspace suspension')
      await assertActorRole(ctx, args.workspaceId, userId, 'owner')
    } else {
      if (userId !== undefined) throw new Error('actorId requires internalKey')
      userId = (await assertRole(ctx, args.workspaceId, 'owner')).userId
    }
    if ((await ctx.db.get(args.workspaceId)) === null) throw new Error('Workspace not found')
    const now = args.now ?? Date.now()
    if (args.suspended) {
      await ctx.db.patch(args.workspaceId, {
        suspendedAt: now,
        suspendedByUserId: userId,
        suspensionReason: args.reason,
        updatedAt: now,
      })
      await writeAuditEvent(ctx, {
        workspaceId: args.workspaceId,
        event: 'workspace.suspended',
        actorId: userId,
        at: now,
        provenance: { reason: args.reason },
      })
      return {
        suspended: true as const,
        suspendedAt: now,
        ...(args.reason === undefined ? {} : { suspensionReason: args.reason }),
      }
    }
    await ctx.db.patch(args.workspaceId, {
      suspendedAt: undefined,
      suspendedByUserId: undefined,
      suspensionReason: undefined,
      updatedAt: now,
    })
    await writeAuditEvent(ctx, {
      workspaceId: args.workspaceId,
      event: 'workspace.unsuspended',
      actorId: userId,
      at: now,
      provenance: { reason: args.reason },
    })
    return { suspended: false as const }
  },
})

export const setMemberRole = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    userId: v.id('users'),
    role: roleValidator,
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
  },
  handler: async (ctx, args) => {
    const actorId = await ownerActor(ctx, args)
    const membership = await ctx.db
      .query('workspaceMembers')
      .withIndex('by_workspace_and_user', q =>
        q.eq('workspaceId', args.workspaceId).eq('userId', args.userId),
      )
      .unique()
    if (membership === null) throw new Error('Workspace member not found')
    return await changeMemberRole(ctx, {
      workspaceId: args.workspaceId,
      actorId,
      membership,
      role: args.role,
    })
  },
})

export const setBillingUser = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    newBillingUserId: v.id('users'),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
  },
  handler: async (ctx, args) => {
    const actorId = await ownerActor(ctx, args)
    await reassignWorkspacePayer(ctx, { ...args, actorId, now: Date.now() })
  },
})

export const setDefaultModel = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    tier: v.string(),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
  },
  handler: async (ctx, args) => {
    const actorId = await ownerActor(ctx, args)
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) throw new Error('Workspace not found')
    const tier = ModelSelectionIdSchema.parse(args.tier)
    if (workspace.defaultModelId === tier) return
    const now = Date.now()
    await ctx.db.patch(args.workspaceId, { defaultModelId: tier, updatedAt: now })
    await writeAuditEvent(ctx, {
      workspaceId: args.workspaceId,
      event: 'workspace.default_model_changed',
      actorId,
      provenance: { tier },
      at: now,
    })
  },
})

export const removeMember = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    userId: v.id('users'),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
  },
  handler: async (ctx, args) => {
    const actorId = await ownerActor(ctx, args)
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) throw new Error('Workspace not found')
    if (workspace.billingUserId === args.userId) {
      throw new Error('Cannot remove the billing user; reassign billing first')
    }
    const membership = await ctx.db
      .query('workspaceMembers')
      .withIndex('by_workspace_and_user', q =>
        q.eq('workspaceId', args.workspaceId).eq('userId', args.userId),
      )
      .unique()
    if (membership === null) return
    if (membership.role === 'owner') await assertAnotherOwner(ctx, args.workspaceId, args.userId)
    await deleteWorkspaceMembershipGeneration(ctx, membership, Date.now())
    await writeAuditEvent(ctx, {
      workspaceId: args.workspaceId,
      event: 'workspace.member_removed',
      actorId,
      provenance: { memberUserId: args.userId },
    })
  },
})

async function ownerActor(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    internalKey?: string
    actorId?: Id<'users'>
  },
): Promise<Id<'users'>> {
  if (args.internalKey !== undefined) {
    requireApiInternalKey(args.internalKey)
    if (args.actorId === undefined) {
      throw new Error('actorId is required for internal workspace mutation')
    }
    return (await assertActorRole(ctx, args.workspaceId, args.actorId, 'owner')).userId
  }
  if (args.actorId !== undefined) throw new Error('actorId requires internalKey')
  return (await assertRole(ctx, args.workspaceId, 'owner')).userId
}

async function assertAnotherOwner(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  userId: Id<'users'>,
): Promise<void> {
  const owners = await ctx.db
    .query('workspaceMembers')
    .withIndex('by_workspace_role', q => q.eq('workspaceId', workspaceId).eq('role', 'owner'))
    .take(2)
  if (!owners.some(owner => owner.userId !== userId)) {
    throw new Error('Workspace must retain at least one owner')
  }
}

async function changeMemberRole(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    actorId: Id<'users'>
    membership: { _id: Id<'workspaceMembers'>; userId: Id<'users'>; role: WorkspaceRole }
    role: WorkspaceRole
  },
) {
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null) throw new Error('Workspace not found')
  if (workspace.billingUserId === args.membership.userId && args.role !== 'owner') {
    throw new Error('Cannot demote the billing user; reassign billing first')
  }
  if (args.membership.role === 'owner' && args.role !== 'owner') {
    await assertAnotherOwner(ctx, args.workspaceId, args.membership.userId)
  }
  if (args.membership.role === args.role) return args.membership
  await ctx.db.patch(args.membership._id, { role: args.role })
  const updatedMembership = await ctx.db.get(args.membership._id)
  if (updatedMembership === null) throw new Error('Workspace membership disappeared')
  await writeMemberDirectoryEntry(ctx, updatedMembership)
  await writeAuditEvent(ctx, {
    workspaceId: args.workspaceId,
    event: 'workspace.member_role_changed',
    actorId: args.actorId,
    provenance: {
      memberUserId: args.membership.userId,
      oldRole: args.membership.role,
      role: args.role,
    },
  })
  return { ...args.membership, role: args.role }
}
