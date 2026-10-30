import type { Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import {
  requireCurrentSessionMembership,
  requireSessionPointFromDb,
  sessionAccessAllows,
} from './access'
import { writeDefaultSessionPointer } from './agentSessionsShared'
import { requireDefaultOwnerReady, sessionMatchesDefaultOwner } from './defaultSession'
import { patchSessionAndReconcileDiscovery } from './discovery'
import { throwSessionError } from './errors'
import { assertSessionIdentityAttribution, type SessionRequestIdentity } from './identity'
import { setSessionPersonalArchive } from './memberState'
import type { DefaultSessionOwner } from './model'
import { projectSessionSnapshot, projectSessionSummary } from './projection'
import { unreadForSession } from './queries'

export async function setSessionArchiveImpl(
  ctx: MutationCtx,
  args: {
    internalKey: string
    workspaceId: Id<'workspaces'>
    sessionId: string
    actorId: Id<'users'>
    identity: SessionRequestIdentity
    kind: 'personal' | 'global'
    archived: boolean
    now?: number
  },
) {
  requireApiInternalKey(args.internalKey)
  assertSessionIdentityAttribution(args.identity, args.actorId)
  const { session, access } = await requireSessionPointFromDb(ctx, args)
  const now = args.now ?? Date.now()
  if (args.kind === 'personal') {
    if (access.basis === 'workspace') throwSessionError('forbidden')
    await setSessionPersonalArchive(ctx, {
      workspaceId: args.workspaceId,
      sessionId: session._id,
      membershipId: access.membership.membershipId as Id<'workspaceMembers'>,
      archivedAt: args.archived ? now : undefined,
    })
    return await projectSessionSummary(ctx, session, {
      access,
      unread: await unreadForSession(ctx, args.workspaceId, args.actorId, session),
    })
  }
  if (!sessionAccessAllows(access, 'global-lifecycle')) throwSessionError('forbidden')
  const archiveState = args.archived ? ('archived' as const) : ('active' as const)
  if (session.archiveState !== archiveState) {
    await patchSessionAndReconcileDiscovery(ctx, session, {
      archiveState,
      archivedAt: args.archived ? now : undefined,
      updatedAt: now,
    })
  }
  const patched =
    session.archiveState === archiveState
      ? session
      : {
          ...session,
          archiveState,
          archivedAt: args.archived ? now : undefined,
          updatedAt: now,
        }
  /* Archiving does not read the session, so `unread` is whatever it already
     was — recomputed rather than assumed, because the actor here is a real
     person and answering `false` would clear a badge they never cleared. */
  return await projectSessionSummary(ctx, patched, {
    access,
    unread: await unreadForSession(
      ctx,
      args.workspaceId,
      args.identity.principal.kind === 'human' ? args.identity.principal.userId : undefined,
      patched,
    ),
  })
}

/**
 * Move an owner's default-chat pointer, or clear it.
 *
 * Clearing is a demotion, not an archive: the session keeps its `archiveState`
 * and stays exactly where it was, and the only durable change is the owner's
 * slot. What that produces is the whole feature — the conversation leaves the
 * `excludeDefault` filter and appears in Jobs, the alias read starts answering
 * `null`, and the owner's next message mints a fresh default through the
 * ordinary create path.
 *
 * Idempotent in both directions: an already-clear slot is a success, because
 * the caller asked for a state and not for a transition.
 */
export async function setDefaultSessionImpl(
  ctx: MutationCtx,
  args: {
    internalKey: string
    workspaceId: Id<'workspaces'>
    owner: DefaultSessionOwner
    sessionId: string | null
    actorId: Id<'users'>
    identity: SessionRequestIdentity
  },
) {
  requireApiInternalKey(args.internalKey)
  assertSessionIdentityAttribution(args.identity, args.actorId)
  if (args.identity.principal.kind === 'human') {
    const membership = await requireCurrentSessionMembership(
      ctx,
      args.workspaceId,
      args.identity.principal.userId,
    )
    if (membership.role === 'viewer') throwSessionError('forbidden')
  }
  await requireDefaultOwnerReady(ctx, args.workspaceId, args.owner)
  if (args.sessionId === null) {
    await writeDefaultSessionPointer(ctx, args.workspaceId, args.owner, undefined)
    return null
  }
  const { session, access } = await requireSessionPointFromDb(ctx, {
    workspaceId: args.workspaceId,
    sessionId: args.sessionId,
    identity: args.identity,
  })
  // Delivery's own guard, re-asserted: a pointer is only meaningful while it
  // names a live session of this owner, so the two writers must agree on what
  // is pointable or this one can persist a state the readers all miss on.
  if (!sessionMatchesDefaultOwner(session, args.owner))
    throwSessionError(session.audienceKind === 'specific' ? 'audience_kind_immutable' : 'not_found')
  await writeDefaultSessionPointer(ctx, args.workspaceId, args.owner, session._id)
  return await projectSessionSnapshot(ctx, session, {
    access,
    unread: await unreadForSession(
      ctx,
      args.workspaceId,
      args.identity.principal.kind === 'human' ? args.identity.principal.userId : undefined,
      session,
    ),
  })
}
