import { paginationOptsValidator } from 'convex/server'
import { v } from 'convex/values'

import { query } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { assertRole, requireCurrentUserId } from './authorization'
import { normalizeMemberDirectorySearch } from './memberDirectory'

// Session-gated switcher listing. Projected — the raw workspace row carries VM
// addresses and token/provisioning hashes the session surface must not see.
export const listMine = query({
  args: {},
  handler: async ctx => {
    const userId = await requireCurrentUserId(ctx)
    const memberships = await ctx.db
      .query('workspaceMembers')
      .withIndex('by_user_and_workspace', q => q.eq('userId', userId))
      // A user's workspace switcher renders a finite list; 100 exceeds the expected membership count.
      .take(100)
    const rows = []
    for (const membership of memberships) {
      const workspace = await ctx.db.get(membership.workspaceId)
      if (workspace === null || workspace.status === 'deleted') continue
      rows.push({
        workspace: {
          _id: workspace._id,
          slug: workspace.slug,
          name: workspace.name,
          status: workspace.status,
          servicingStatus: workspace.servicingStatus,
          servicingStatusChangedAt: workspace.servicingStatusChangedAt,
          billingUserId: workspace.billingUserId,
        },
        role: membership.role,
      })
    }
    return rows
  },
})

export const getAuditEvents = query({
  args: {
    workspaceId: v.id('workspaces'),
  },
  handler: async (ctx, args) => {
    await assertRole(ctx, args.workspaceId, 'viewer', { allowNonLiveWorkspace: true })
    const rows = await ctx.db
      .query('auditEvents')
      .withIndex('by_workspace_at', q => q.eq('workspaceId', args.workspaceId))
      // Audit history is displayed as a recent activity feed; 1000 bounds long-lived workspaces.
      .take(1000)
    return rows.map(event => ({
      id: event._id,
      event: event.event,
      actorId: event.actorId,
      at: event.at,
      ...(event.provenance === undefined ? {} : { provenance: event.provenance }),
    }))
  },
})

export const listAuditEventsFromApi = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const page = await ctx.db
      .query('auditEvents')
      .withIndex('by_workspace_at', q => q.eq('workspaceId', args.workspaceId))
      .order('desc')
      .paginate(args.paginationOpts)
    return {
      ...page,
      page: page.page.map(event => ({
        id: event._id,
        event: event.event,
        actorId: event.actorId,
        at: event.at,
        provenance: event.provenance,
      })),
    }
  },
})

export const suspensionState = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) throw new Error('Workspace not found')
    if (workspace.suspendedAt === undefined) return { suspended: false as const }
    return {
      suspended: true as const,
      suspendedAt: workspace.suspendedAt,
      ...(workspace.suspensionReason === undefined
        ? {}
        : { suspensionReason: workspace.suspensionReason }),
    }
  },
})

export const servicingStatus = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) throw new Error('Workspace not found')
    return { servicingStatus: workspace.servicingStatus ?? 'active' }
  },
})

export const refsByIds = query({
  args: {
    internalKey: v.string(),
    workspaceIds: v.array(v.id('workspaces')),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    if (args.workspaceIds.length > 500) throw new Error('Workspace reference limit exceeded')
    const refs = []
    for (const workspaceId of new Set(args.workspaceIds)) {
      const workspace = await ctx.db.get(workspaceId)
      if (workspace === null || workspace.status === 'deleted' || workspace.status === 'retired')
        continue
      refs.push({ id: workspace._id, slug: workspace.slug })
    }
    return refs
  },
})

export const getMemberByUser = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    userId: v.id('users'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) throw new Error('Workspace not found')
    const member = await ctx.db
      .query('workspaceMemberDirectory')
      .withIndex('by_workspace_and_user', q =>
        q.eq('workspaceId', args.workspaceId).eq('userId', args.userId),
      )
      .unique()
    if (member === null) return null
    return {
      id: member.userId,
      email: member.email,
      name: member.name,
      role: member.role,
      isBillingUser: member.userId === workspace.billingUserId,
    }
  },
})

export const listMembersPage = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    search: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) throw new Error('Workspace not found')
    const search = normalizeMemberDirectorySearch(args.search)
    const page = search
      ? await ctx.db
          .query('workspaceMemberDirectory')
          .withSearchIndex('search_text', q =>
            q.search('searchText', search).eq('workspaceId', args.workspaceId),
          )
          .paginate(args.paginationOpts)
      : await ctx.db
          .query('workspaceMemberDirectory')
          .withIndex('by_workspace_order', q => q.eq('workspaceId', args.workspaceId))
          .paginate(args.paginationOpts)
    return {
      ...page,
      page: page.page.map(member => ({
        id: member.userId,
        email: member.email,
        name: member.name,
        role: member.role,
        isBillingUser: member.userId === workspace.billingUserId,
      })),
    }
  },
})
