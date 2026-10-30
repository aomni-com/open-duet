import { getDocumentSize } from 'convex/values'

import {
  type SessionRequestIdentity as ContractSessionRequestIdentity,
  type WorkspaceRole,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { admitSessionId, throwSessionError } from './errors'
import {
  assertSessionIdentityAttribution,
  type SessionRequestIdentity as DbSessionRequestIdentity,
} from './identity'

export interface ResolvedSessionMembership {
  membershipId: string
  userId: string
  role: WorkspaceRole
  joinedAt?: number
}

export interface SessionAccessTarget {
  audience:
    | { kind: 'workspace' }
    // Point authorization resolves only this principal's generation-bound row;
    // loading the complete audience here would make one access check unbounded.
    | { kind: 'specific'; membershipGrant: { membershipId: string } | null }
  agentState: 'root' | 'agent' | 'missing' | 'onboarding'
}

export type SessionPointAccess =
  | { ok: true; basis: 'workspace' }
  | {
      ok: true
      basis: 'workspace-member' | 'specific-participant' | 'owner-override'
      membership: ResolvedSessionMembership
    }
  | { ok: false; error: 'not_found' }

export type SessionDiscoveryScope =
  | {
      ok: true
      scope:
        | { kind: 'workspace'; membershipId?: string }
        | { kind: 'membership'; membershipId: string }
    }
  | { ok: false; error: 'not_found' }

const SESSION_NOT_FOUND = { ok: false, error: 'not_found' } as const

type DbCtx = QueryCtx | MutationCtx
type AdmittedSessionPointAccess = Extract<SessionPointAccess, { ok: true }>

export interface AdmittedSessionPoint {
  session: Doc<'agentSessions'>
  access: AdmittedSessionPointAccess
  accessTarget: SessionAccessTarget
}

/**
 * Resolve one session and the caller's current admission from canonical rows.
 *
 * This is deliberately a point lookup: one session, one current membership,
 * and (for a specific audience) that membership generation's one state row.
 * Collection discovery has a different indexed owner and must never call this
 * once per post-filtered row.
 */
export async function resolveSessionPointFromDb(
  ctx: DbCtx,
  args: {
    workspaceId: Id<'workspaces'>
    sessionId: string
    identity: DbSessionRequestIdentity
  },
): Promise<AdmittedSessionPoint | null> {
  assertSessionIdentityAttribution(args.identity, args.identity.actorId)
  const session = await ctx.db.get(admitSessionId(ctx, args.sessionId))
  if (
    session === null ||
    session.workspaceId !== args.workspaceId ||
    !session.visible ||
    session.archiveState === 'deleting'
  ) {
    return null
  }

  const membership =
    args.identity.principal.kind === 'workspace'
      ? null
      : await currentSessionMembership(
          ctx,
          args.workspaceId,
          args.identity.principal.userId as Id<'users'>,
        )
  const memberState =
    session.audienceKind === 'specific' && membership !== null
      ? await ctx.db
          .query('agentSessionMemberStates')
          .withIndex('by_session_membership', q =>
            q
              .eq('sessionId', session._id)
              .eq('membershipId', membership.membershipId as Id<'workspaceMembers'>),
          )
          .unique()
      : null
  const accessTarget: SessionAccessTarget = {
    audience:
      session.audienceKind === 'workspace'
        ? { kind: 'workspace' }
        : {
            kind: 'specific',
            membershipGrant:
              memberState?.audienceGranted === true
                ? { membershipId: memberState.membershipId }
                : null,
          },
    agentState: await sessionAgentState(ctx, session),
  }
  const access = resolvePreloadedSessionAccess({
    identity: args.identity,
    membership,
    session: accessTarget,
  })
  return access.ok ? { session, access, accessTarget } : null
}

export async function requireSessionPointFromDb(
  ctx: DbCtx,
  args: {
    workspaceId: Id<'workspaces'>
    sessionId: string
    identity: DbSessionRequestIdentity
  },
): Promise<AdmittedSessionPoint> {
  return (await resolveSessionPointFromDb(ctx, args)) ?? throwSessionError('not_found')
}

/** Internal VM/runner admission. The actor is attribution only; workspace trust is the gate. */
export async function requireWorkspaceSessionPointFromDb(
  ctx: DbCtx,
  args: { workspaceId: Id<'workspaces'>; sessionId: string },
): Promise<AdmittedSessionPoint> {
  const sessionId = admitSessionId(ctx, args.sessionId)
  const session = await ctx.db.get(sessionId)
  if (session === null || session.workspaceId !== args.workspaceId) throwSessionError('not_found')
  return await requireSessionPointFromDb(ctx, {
    ...args,
    sessionId,
    identity: { principal: { kind: 'workspace' }, actorId: session.userId },
  })
}

/** Resolve the one principal scope used by indexed session discovery reads. */
export async function resolveSessionDiscoveryScopeFromDb(
  ctx: DbCtx,
  args: { workspaceId: Id<'workspaces'>; identity: DbSessionRequestIdentity },
): Promise<Extract<SessionDiscoveryScope, { ok: true }>> {
  assertSessionIdentityAttribution(args.identity, args.identity.actorId)
  const membership =
    args.identity.principal.kind === 'workspace'
      ? null
      : await currentSessionMembership(
          ctx,
          args.workspaceId,
          args.identity.principal.userId as Id<'users'>,
        )
  const resolved = resolveSessionDiscoveryScope({ identity: args.identity, membership })
  if (!resolved.ok) throwSessionError('not_found')
  return resolved
}

export async function currentSessionMembership(
  ctx: DbCtx,
  workspaceId: Id<'workspaces'>,
  userId: Id<'users'>,
): Promise<ResolvedSessionMembership | null> {
  return (await currentSessionMembershipWithReadCost(ctx, workspaceId, userId)).membership
}

/** Load the current generation once when a collection needs both scope and projection support. */
export async function currentSessionMembershipWithReadCost(
  ctx: DbCtx,
  workspaceId: Id<'workspaces'>,
  userId: Id<'users'>,
): Promise<{ membership: ResolvedSessionMembership | null; readBytes: number }> {
  const row = await ctx.db
    .query('workspaceMembers')
    .withIndex('by_workspace_and_user', q => q.eq('workspaceId', workspaceId).eq('userId', userId))
    .unique()
  return {
    membership:
      row === null
        ? null
        : {
            membershipId: row._id,
            userId: row.userId,
            role: row.role,
            joinedAt: row._creationTime,
          },
    readBytes: row === null ? 0 : getDocumentSize(row),
  }
}

export async function requireCurrentSessionMembership(
  ctx: DbCtx,
  workspaceId: Id<'workspaces'>,
  userId: Id<'users'>,
): Promise<ResolvedSessionMembership> {
  return (
    (await currentSessionMembership(ctx, workspaceId, userId)) ?? throwSessionError('not_found')
  )
}

/**
 * How a session's agent bears on human access: its row is there or it is gone.
 * Whether the agent has completed a declared onboarding is not an access fact
 * — the declaration lives in the agent's config on the VM, so the lock it
 * draws belongs to the web, and an ordinary agent never carries `onboardedAt`
 * at all. Only a session that is itself onboarding is gated, by its own flag.
 */
export function sessionAgentStateOf(
  session: Pick<Doc<'agentSessions'>, 'agentId' | 'onboarding' | 'workspaceId'>,
  agent: Pick<Doc<'agents'>, 'workspaceId'> | null,
): SessionAccessTarget['agentState'] {
  if (session.agentId === undefined) return 'root'
  if (session.onboarding === true) return 'onboarding'
  return agent !== null && agent.workspaceId === session.workspaceId ? 'agent' : 'missing'
}

async function sessionAgentState(
  ctx: DbCtx,
  session: Doc<'agentSessions'>,
): Promise<SessionAccessTarget['agentState']> {
  const agent =
    session.agentId === undefined || session.onboarding === true
      ? null
      : await ctx.db.get(session.agentId)
  return sessionAgentStateOf(session, agent)
}

export function sessionAccessAllows(
  access: SessionPointAccess,
  capability: 'participate' | 'global-lifecycle',
): boolean {
  if (!access.ok) return false
  if (capability === 'participate' || access.basis === 'workspace') return true
  return access.membership.role !== 'viewer'
}

export function sessionAudienceAdmitsMembership(args: {
  audienceKind: 'workspace' | 'specific'
  audienceGranted: boolean
  role: WorkspaceRole
}): boolean {
  return (
    args.audienceKind === 'workspace' ||
    (args.audienceKind === 'specific' && (args.audienceGranted || args.role === 'owner'))
  )
}

/**
 * Projection context for callers that already admitted the principal. Keeping
 * this conversion at the gate prevents the public projector from interpreting
 * roles or re-answering access for itself.
 */
export function admittedWorkspaceSessionAccess(
  membership?: ResolvedSessionMembership,
): Extract<SessionPointAccess, { ok: true }> {
  return membership === undefined
    ? { ok: true, basis: 'workspace' }
    : { ok: true, basis: 'workspace-member', membership }
}

export function resolveSessionDiscoveryScope(args: {
  identity: Pick<ContractSessionRequestIdentity, 'principal'> &
    Partial<Pick<ContractSessionRequestIdentity, 'actorId'>>
  membership: ResolvedSessionMembership | null
}): SessionDiscoveryScope {
  if (args.identity.principal.kind === 'workspace') {
    return { ok: true, scope: { kind: 'workspace' } }
  }
  const membership = args.membership
  if (membership === null || membership.userId !== args.identity.principal.userId) {
    return SESSION_NOT_FOUND
  }
  return membership.role === 'owner'
    ? { ok: true, scope: { kind: 'workspace', membershipId: membership.membershipId } }
    : { ok: true, scope: { kind: 'membership', membershipId: membership.membershipId } }
}

/** Decide access from rows already loaded by a point read, list projection, or mutation. */
export function resolvePreloadedSessionAccess(args: {
  identity: ContractSessionRequestIdentity
  membership: ResolvedSessionMembership | null
  session: SessionAccessTarget | null
}): SessionPointAccess {
  if (args.session === null) return SESSION_NOT_FOUND
  if (args.identity.principal.kind === 'workspace') return { ok: true, basis: 'workspace' }
  const membership = args.membership
  if (membership === null || membership.userId !== args.identity.principal.userId) {
    return SESSION_NOT_FOUND
  }
  if (args.session.agentState === 'missing') {
    return SESSION_NOT_FOUND
  }
  if (args.session.agentState === 'onboarding' && membership.role === 'viewer') {
    return SESSION_NOT_FOUND
  }
  const audienceGranted =
    args.session.audience.kind === 'specific' &&
    args.session.audience.membershipGrant?.membershipId === membership.membershipId
  if (
    !sessionAudienceAdmitsMembership({
      audienceKind: args.session.audience.kind,
      audienceGranted,
      role: membership.role,
    })
  ) {
    return SESSION_NOT_FOUND
  }
  if (args.session.audience.kind === 'workspace') {
    return { ok: true, basis: 'workspace-member', membership }
  }
  if (audienceGranted) {
    return { ok: true, basis: 'specific-participant', membership }
  }
  return { ok: true, basis: 'owner-override', membership }
}
