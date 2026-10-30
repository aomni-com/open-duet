import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { sessionAudienceAdmitsMembership } from './access'
import { reconcileSessionDiscovery } from './discovery'

type DbCtx = MutationCtx | QueryCtx

export async function sessionMemberState(
  ctx: DbCtx,
  sessionId: Id<'agentSessions'>,
  membershipId: Id<'workspaceMembers'>,
): Promise<Doc<'agentSessionMemberStates'> | null> {
  return await ctx.db
    .query('agentSessionMemberStates')
    .withIndex('by_session_membership', q =>
      q.eq('sessionId', sessionId).eq('membershipId', membershipId),
    )
    .unique()
}

export async function setSessionPersonalArchive(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    sessionId: Id<'agentSessions'>
    membershipId: Id<'workspaceMembers'>
    archivedAt?: number
  },
): Promise<void> {
  const [session, membership, existing] = await Promise.all([
    ctx.db.get(args.sessionId),
    ctx.db.get(args.membershipId),
    sessionMemberState(ctx, args.sessionId, args.membershipId),
  ])
  if (
    session === null ||
    session.workspaceId !== args.workspaceId ||
    session.archiveState === 'deleting'
  ) {
    throw new Error('Session not found')
  }
  if (membership === null || membership.workspaceId !== args.workspaceId) {
    throw new Error('Workspace member not found')
  }
  if (existing !== null && existing.workspaceId !== args.workspaceId) {
    throw new Error('Session member state target is invalid')
  }
  const admitted = sessionAudienceAdmitsMembership({
    audienceKind: session.audienceKind,
    audienceGranted: existing?.audienceGranted === true,
    role: membership.role,
  })
  if (!admitted) throw new Error('Session not found')

  if ((existing?.personalArchivedAt !== undefined) === (args.archivedAt !== undefined)) return

  if (existing === null) {
    if (args.archivedAt === undefined) return
    await ctx.db.insert('agentSessionMemberStates', {
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
      membershipId: args.membershipId,
      audienceGranted: false,
      personalArchivedAt: args.archivedAt,
    })
  } else if (args.archivedAt === undefined && !existing.audienceGranted) {
    await ctx.db.delete(existing._id)
  } else {
    await ctx.db.patch(existing._id, { personalArchivedAt: args.archivedAt })
  }
  await reconcileSessionDiscovery(ctx, session)
}

export function requireSpecificParticipantCount(session: Doc<'agentSessions'>): number {
  if (session.audienceKind !== 'specific') {
    throw new Error('Specific participant count is invalid')
  }
  const count = session.specificGrantedParticipantCount
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('Specific participant count is invalid')
  }
  return count
}
