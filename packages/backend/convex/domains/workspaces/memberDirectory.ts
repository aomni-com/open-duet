import type { GenericMutationCtx } from 'convex/server'
import { ConvexError } from 'convex/values'

import {
  normalizeWorkspaceMemberSearch,
  WORKSPACE_MEMBER_LIMIT,
  type WorkspaceMemberAdmissionRefusal,
} from '@repo/contract'

import type { DataModel, Doc, Id } from '../../_generated/dataModel'

type MutationCtx = GenericMutationCtx<DataModel>
type Role = Doc<'workspaceMembers'>['role']

const ROLE_RANK: Record<Role, number> = { owner: 0, editor: 1, viewer: 2 }

export function normalizeMemberDirectoryText(value: string | undefined): string {
  return (value ?? '').normalize('NFKC').trim().toLocaleLowerCase('en-US')
}

export function normalizeMemberDirectorySearch(value: string | undefined): string {
  return normalizeWorkspaceMemberSearch(value)
}

export function memberDirectorySearchText(normalizedName: string, normalizedEmail: string): string {
  return `${normalizedName}\n${normalizedEmail}`
}

export async function insertWorkspaceMember(
  ctx: MutationCtx,
  fields: Pick<Doc<'workspaceMembers'>, 'workspaceId' | 'userId' | 'role'>,
): Promise<Id<'workspaceMembers'>> {
  const currentMembers = await ctx.db
    .query('workspaceMembers')
    .withIndex('by_workspace_and_user', q => q.eq('workspaceId', fields.workspaceId))
    .take(WORKSPACE_MEMBER_LIMIT)
  if (currentMembers.length === WORKSPACE_MEMBER_LIMIT) {
    throw new ConvexError({
      error: 'workspace_member_limit_reached',
      limit: WORKSPACE_MEMBER_LIMIT,
    } satisfies WorkspaceMemberAdmissionRefusal)
  }
  const membershipId = await ctx.db.insert('workspaceMembers', fields)
  const membership = await ctx.db.get(membershipId)
  if (membership === null) throw new Error('Workspace membership insert disappeared')
  await writeMemberDirectoryEntry(ctx, membership)
  return membershipId
}

export async function writeMemberDirectoryEntry(
  ctx: MutationCtx,
  membership: Doc<'workspaceMembers'>,
  identity?: { email: string; name?: string },
): Promise<void> {
  const user = identity ?? (await ctx.db.get(membership.userId))
  if (user === null) throw new Error('Workspace member user not found')
  await deleteMemberDirectoryEntry(ctx, membership._id)

  const fields = directoryFields(membership, user)
  await ctx.db.insert('workspaceMemberDirectory', fields)
}

export async function deleteMemberDirectoryEntry(
  ctx: MutationCtx,
  membershipId: Id<'workspaceMembers'>,
): Promise<void> {
  const row = await ctx.db
    .query('workspaceMemberDirectory')
    .withIndex('by_membership', q => q.eq('membershipId', membershipId))
    .unique()
  if (row !== null) await ctx.db.delete(row._id)
}

function directoryFields(
  membership: Doc<'workspaceMembers'>,
  user: { email: string; name?: string },
) {
  const normalizedName = normalizeMemberDirectoryText(user.name)
  const normalizedEmail = normalizeMemberDirectoryText(user.email)
  return {
    workspaceId: membership.workspaceId,
    membershipId: membership._id,
    userId: membership.userId,
    role: membership.role,
    roleRank: ROLE_RANK[membership.role],
    normalizedName,
    normalizedEmail,
    searchText: memberDirectorySearchText(normalizedName, normalizedEmail),
    email: user.email,
    ...(user.name === undefined ? {} : { name: user.name }),
  }
}
