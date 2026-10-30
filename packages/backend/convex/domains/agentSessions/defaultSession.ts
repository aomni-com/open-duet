import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { requireSessionPointFromDb, type AdmittedSessionPoint } from './access'
import { throwSessionError } from './errors'
import type { SessionRequestIdentity } from './identity'
import type { DefaultSessionOwner } from './model'

type DbCtx = QueryCtx | MutationCtx

export async function defaultSessionIdForOwner(
  ctx: DbCtx,
  workspaceId: Id<'workspaces'>,
  owner: DefaultSessionOwner,
): Promise<Id<'agentSessions'> | undefined> {
  if (owner.kind === 'root') return (await ctx.db.get(workspaceId))?.rootDefaultSessionId
  const agent = await ctx.db.get(owner.agentId)
  return agent === null || agent.workspaceId !== workspaceId ? undefined : agent.defaultSessionId
}

/**
 * Default chat is an ordinary workspace-visible conversation of a ready owner.
 * Ready means the owner exists and is not disabled — onboarding is not part of
 * it, for the reason `sessionAgentStateOf` gives.
 */
export async function requireDefaultOwnerReady(
  ctx: DbCtx,
  workspaceId: Id<'workspaces'>,
  owner: DefaultSessionOwner,
): Promise<void> {
  if (!(await defaultOwnerIsReady(ctx, workspaceId, owner))) throwSessionError('not_found')
}

async function defaultOwnerIsReady(
  ctx: DbCtx,
  workspaceId: Id<'workspaces'>,
  owner: DefaultSessionOwner,
): Promise<boolean> {
  if (owner.kind === 'root') {
    return (await ctx.db.get(workspaceId)) !== null
  }
  const agent = await ctx.db.get(owner.agentId)
  return !(agent === null || agent.workspaceId !== workspaceId || agent.disabledAt !== undefined)
}

export function sessionMatchesDefaultOwner(
  session: Doc<'agentSessions'>,
  owner: DefaultSessionOwner,
): boolean {
  return (
    session.audienceKind === 'workspace' &&
    session.onboarding !== true &&
    session.archiveState === 'active' &&
    session.visible &&
    (owner.kind === 'root' ? session.agentId === undefined : session.agentId === owner.agentId)
  )
}

export async function resolveDefaultSessionPoint(
  ctx: DbCtx,
  args: {
    workspaceId: Id<'workspaces'>
    owner: DefaultSessionOwner
    identity: SessionRequestIdentity
  },
): Promise<AdmittedSessionPoint | null> {
  if (!(await defaultOwnerIsReady(ctx, args.workspaceId, args.owner))) return null
  const sessionId = await defaultSessionIdForOwner(ctx, args.workspaceId, args.owner)
  if (sessionId === undefined) return null
  const admitted = await requireSessionPointFromDb(ctx, { ...args, sessionId })
  return sessionMatchesDefaultOwner(admitted.session, args.owner) ? admitted : null
}

export async function requireDefaultSessionPoint(
  ctx: DbCtx,
  args: {
    workspaceId: Id<'workspaces'>
    owner: DefaultSessionOwner
    identity: SessionRequestIdentity
  },
): Promise<AdmittedSessionPoint> {
  return (await resolveDefaultSessionPoint(ctx, args)) ?? throwSessionError('not_found')
}

/**
 * Resolve page one of default history without collapsing two different misses.
 * An owner with no pointer has no default conversation; a pointer that exists
 * but fails current owner or point policy remains the ordinary generic miss.
 */
export async function requireDefaultHistorySessionPoint(
  ctx: DbCtx,
  args: {
    workspaceId: Id<'workspaces'>
    owner: DefaultSessionOwner
    identity: SessionRequestIdentity
  },
): Promise<AdmittedSessionPoint> {
  const sessionId = await defaultSessionIdForOwner(ctx, args.workspaceId, args.owner)
  if (sessionId === undefined) throwSessionError('no_default_session')
  await requireDefaultOwnerReady(ctx, args.workspaceId, args.owner)
  const admitted = await requireSessionPointFromDb(ctx, { ...args, sessionId })
  if (!sessionMatchesDefaultOwner(admitted.session, args.owner)) throwSessionError('not_found')
  return admitted
}
