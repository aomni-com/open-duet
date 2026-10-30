import { getAuthUserId } from '@convex-dev/auth/server'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'

export type WorkspaceRole = 'owner' | 'editor' | 'viewer'
interface WorkspaceAuthorizationOptions {
  allowNonLiveWorkspace?: boolean
}

const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 0,
  editor: 1,
  owner: 2,
}

export function isLiveWorkspace(status: Doc<'workspaces'>['status']): boolean {
  return status !== 'deleted' && status !== 'retired'
}

export async function requireCurrentUserId(ctx: QueryCtx | MutationCtx): Promise<Id<'users'>> {
  const userId = await getAuthUserId(ctx)
  if (userId === null) throw new Error('Unauthenticated')
  return userId as Id<'users'>
}

export async function assertRole(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  minimumRole: WorkspaceRole,
  options: WorkspaceAuthorizationOptions = {},
): Promise<{ userId: Id<'users'>; membershipId: Id<'workspaceMembers'>; role: WorkspaceRole }> {
  const userId = await requireCurrentUserId(ctx)
  await assertWorkspaceLiveness(ctx, workspaceId, options)
  const membership = await ctx.db
    .query('workspaceMembers')
    .withIndex('by_workspace_and_user', q => q.eq('workspaceId', workspaceId).eq('userId', userId))
    .unique()
  if (membership === null || ROLE_RANK[membership.role] < ROLE_RANK[minimumRole]) {
    throw new Error(`Requires ${minimumRole} access`)
  }
  return { userId, membershipId: membership._id, role: membership.role }
}

export async function assertActorRole(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  actorId: Id<'users'>,
  minimumRole: WorkspaceRole,
  options: WorkspaceAuthorizationOptions = {},
): Promise<{ userId: Id<'users'>; membershipId: Id<'workspaceMembers'>; role: WorkspaceRole }> {
  await assertWorkspaceLiveness(ctx, workspaceId, options)
  const membership = await ctx.db
    .query('workspaceMembers')
    .withIndex('by_workspace_and_user', q => q.eq('workspaceId', workspaceId).eq('userId', actorId))
    .unique()
  if (membership === null || ROLE_RANK[membership.role] < ROLE_RANK[minimumRole]) {
    throw new Error(`Requires ${minimumRole} access`)
  }
  return { userId: actorId, membershipId: membership._id, role: membership.role }
}

async function assertWorkspaceLiveness(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  options: WorkspaceAuthorizationOptions,
): Promise<void> {
  const workspace = await ctx.db.get(workspaceId)
  if (
    workspace === null ||
    (options.allowNonLiveWorkspace !== true && !isLiveWorkspace(workspace.status))
  ) {
    throw new Error('Workspace not found')
  }
}
