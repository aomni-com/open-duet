import { compareValues, getDocumentSize } from 'convex/values'

import {
  effectiveSessionCreationAudience,
  sessionAudienceCursorCodec,
  SESSION_AUDIENCE_PREVIEW_LIMIT,
  WORKSPACE_MEMBER_LIMIT,
  type SessionAudienceMemberPreview,
  type SessionAudiencePage,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import {
  requireSessionPointFromDb,
  resolvePreloadedSessionAccess,
  type SessionPointAccess,
} from './access'
import { patchSessionAndReconcileDiscovery } from './discovery'
import { decodeSessionCollectionCursor, throwSessionError } from './errors'
import { requireSpecificParticipantCount, sessionMemberState } from './memberState'

type DbCtx = MutationCtx | QueryCtx
type DirectoryRow = Doc<'workspaceMemberDirectory'>
export interface AudienceDirectorySupport {
  directory: DirectoryRow[]
  states: Map<Id<'workspaceMembers'>, Doc<'agentSessionMemberStates'> | null>
}

export interface SessionAudienceMutationMetrics {
  reads: { ranges: number; documents: number }
  writes: number
  reconciliations: number
}

export async function loadSessionAudienceDirectory(
  ctx: DbCtx,
  workspaceId: Id<'workspaces'>,
): Promise<DirectoryRow[]> {
  const rows = await ctx.db
    .query('workspaceMemberDirectory')
    .withIndex('by_workspace_order', q => q.eq('workspaceId', workspaceId))
    .take(WORKSPACE_MEMBER_LIMIT + 1)
  if (rows.length > WORKSPACE_MEMBER_LIMIT) {
    throw new Error('Workspace member directory exceeds capacity')
  }
  return rows
}

export function audienceMemberPreview(row: DirectoryRow): SessionAudienceMemberPreview {
  return {
    memberId: row.membershipId,
    userId: row.userId,
    name: row.name ?? row.email,
    email: row.email,
    role: row.role,
  }
}

export async function projectCurrentSpecificAudience(
  ctx: DbCtx,
  session: Doc<'agentSessions'>,
  callerMembershipId?: Id<'workspaceMembers'>,
  preloaded?: AudienceDirectorySupport,
) {
  const directory =
    preloaded?.directory ?? (await loadSessionAudienceDirectory(ctx, session.workspaceId))
  let callerState: Doc<'agentSessionMemberStates'> | null = null
  let stateDocuments = 0
  let stateBytes = 0
  const granted: DirectoryRow[] = []
  for (const member of directory) {
    const state =
      preloaded !== undefined
        ? (preloaded.states.get(member.membershipId) ?? null)
        : await sessionMemberState(ctx, session._id, member.membershipId)
    if (member.membershipId === callerMembershipId) callerState = state
    if (state !== null) {
      stateDocuments += 1
      stateBytes += getDocumentSize(state)
      if (state.audienceGranted) granted.push(member)
    }
  }
  return {
    callerState,
    readCost: {
      ranges: 1 + directory.length,
      documents: directory.length + stateDocuments,
      bytes: directory.reduce((total, row) => total + getDocumentSize(row), 0) + stateBytes,
    },
    audience: {
      kind: 'specific' as const,
      count: granted.length,
      preview: granted.slice(0, SESSION_AUDIENCE_PREVIEW_LIMIT).map(audienceMemberPreview),
    },
  }
}

export async function resolveFreshCreationAudience(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    principal: { kind: 'human'; userId: string } | { kind: 'workspace' }
    audience: { kind: 'workspace' } | { kind: 'specific'; memberUserIds: string[] }
  },
): Promise<
  | { audience: { kind: 'workspace' }; access: Extract<SessionPointAccess, { ok: true }> }
  | {
      audience: { kind: 'specific'; membershipIds: Id<'workspaceMembers'>[] }
      access: Extract<SessionPointAccess, { ok: true }>
    }
> {
  const effectiveAudience = effectiveSessionCreationAudience(args.principal, args.audience)
  if (effectiveAudience === null) throwSessionError('invalid_audience_member')
  if (args.principal.kind === 'workspace' && effectiveAudience.kind === 'workspace') {
    return { audience: effectiveAudience, access: { ok: true, basis: 'workspace' } }
  }
  const directory = await loadSessionAudienceDirectory(ctx, args.workspaceId)
  const byUserId = new Map(directory.map(member => [String(member.userId), member]))
  const caller = args.principal.kind === 'human' ? byUserId.get(args.principal.userId) : undefined
  if (args.principal.kind === 'human' && caller === undefined) throwSessionError('not_found')
  if (effectiveAudience.kind === 'workspace') {
    if (caller === undefined) throwSessionError('not_found')
    return {
      audience: effectiveAudience,
      access: {
        ok: true,
        basis: 'workspace-member',
        membership: {
          membershipId: caller.membershipId,
          userId: caller.userId,
          role: caller.role,
        },
      },
    }
  }

  if (effectiveAudience.memberUserIds.length > WORKSPACE_MEMBER_LIMIT) {
    throwSessionError('invalid_audience_member')
  }
  const members = effectiveAudience.memberUserIds.map(userId => {
    if (ctx.db.normalizeId('users', userId) === null) throwSessionError('invalid_audience_member')
    return byUserId.get(userId) ?? throwSessionError('invalid_audience_member')
  })
  return {
    audience: { kind: 'specific', membershipIds: members.map(member => member.membershipId) },
    access:
      caller === undefined
        ? { ok: true, basis: 'workspace' }
        : {
            ok: true,
            basis: 'specific-participant',
            membership: {
              membershipId: caller.membershipId,
              userId: caller.userId,
              role: caller.role,
            },
          },
  }
}

function cursorPosition(row: DirectoryRow) {
  return {
    roleRank: row.roleRank,
    normalizedName: row.normalizedName,
    normalizedEmail: row.normalizedEmail,
    membershipId: String(row.membershipId),
  }
}

function positionAfter(row: DirectoryRow, position: ReturnType<typeof cursorPosition>): boolean {
  const candidate = cursorPosition(row)
  for (const key of ['roleRank', 'normalizedName', 'normalizedEmail', 'membershipId'] as const) {
    const comparison = compareValues(candidate[key], position[key])
    if (comparison !== 0) return comparison > 0
  }
  return false
}

function audienceCursorSubject(
  workspaceId: Id<'workspaces'>,
  sessionId: Id<'agentSessions'>,
  access: Extract<SessionPointAccess, { ok: true }>,
): string {
  const scope = access.basis === 'workspace' ? 'workspace' : String(access.membership.membershipId)
  return `${workspaceId}:${sessionId}:${scope}`
}

export async function listSessionAudienceImpl(
  ctx: QueryCtx,
  args: {
    workspaceId: Id<'workspaces'>
    sessionId: string
    identity: Parameters<typeof requireSessionPointFromDb>[1]['identity']
    cursor?: string
    limit: number
  },
): Promise<SessionAudiencePage> {
  const admitted = await requireSessionPointFromDb(ctx, args)
  if (admitted.session.audienceKind !== 'specific') throwSessionError('audience_kind_immutable')
  const subject = audienceCursorSubject(args.workspaceId, admitted.session._id, admitted.access)
  const after =
    args.cursor === undefined
      ? undefined
      : await decodeSessionCollectionCursor(args.cursor, cursor =>
          sessionAudienceCursorCodec.decode(cursor, {
            subject,
            filters: {},
            order: 'member-directory',
          }),
        )
  const directory = await loadSessionAudienceDirectory(ctx, args.workspaceId)
  const candidates =
    after === undefined ? directory : directory.filter(row => positionAfter(row, after))
  const items: SessionAudienceMemberPreview[] = []
  let processed: DirectoryRow | undefined
  for (const member of candidates.slice(0, args.limit)) {
    processed = member
    const state = await sessionMemberState(ctx, admitted.session._id, member.membershipId)
    if (state?.audienceGranted) items.push(audienceMemberPreview(member))
  }
  const hasMore =
    processed !== undefined && directory.some(row => positionAfter(row, cursorPosition(processed!)))
  return {
    items,
    nextCursor:
      hasMore && processed !== undefined
        ? await sessionAudienceCursorCodec.encode({
            subject,
            filters: {},
            order: 'member-directory',
            position: cursorPosition(processed),
          })
        : null,
  }
}

export async function applySessionAudienceDeltaImpl(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    sessionId: string
    identity: Parameters<typeof requireSessionPointFromDb>[1]['identity']
    add: string[]
    remove: string[]
    now: number
    /** Test-only transaction accounting; production callers leave this absent. */
    onMetrics?: (metrics: SessionAudienceMutationMetrics) => void
  },
) {
  const admitted = await requireSessionPointFromDb(ctx, args)
  const session = admitted.session
  if (session.audienceKind !== 'specific') throwSessionError('audience_kind_immutable')

  const directory = await loadSessionAudienceDirectory(ctx, args.workspaceId)
  const byUserId = new Map(directory.map(member => [String(member.userId), member]))
  const addMembers = args.add.map(userId => {
    if (ctx.db.normalizeId('users', userId) === null) throwSessionError('invalid_audience_member')
    return byUserId.get(userId) ?? throwSessionError('invalid_audience_member')
  })
  const removeMembers = args.remove.flatMap(userId => {
    if (ctx.db.normalizeId('users', userId) === null) throwSessionError('invalid_audience_member')
    const member = byUserId.get(userId)
    return member === undefined ? [] : [member]
  })
  const states = new Map<Id<'workspaceMembers'>, Doc<'agentSessionMemberStates'> | null>()
  let stateDocuments = 0
  for (const member of directory) {
    const state = await sessionMemberState(ctx, session._id, member.membershipId)
    if (state !== null) stateDocuments += 1
    states.set(member.membershipId, state)
  }
  const addIds = new Set(addMembers.map(member => member.membershipId))
  const removeIds = new Set(removeMembers.map(member => member.membershipId))
  let added = 0
  let removed = 0
  for (const member of directory) {
    const state = states.get(member.membershipId) ?? null
    if (addIds.has(member.membershipId) && state?.audienceGranted !== true) added += 1
    if (removeIds.has(member.membershipId) && state?.audienceGranted === true) removed += 1
  }
  const support = { directory, states }
  if (added === 0 && removed === 0) {
    args.onMetrics?.({
      reads: { ranges: 1 + directory.length, documents: 1 + directory.length + stateDocuments },
      writes: 0,
      reconciliations: 0,
    })
    return { session, access: admitted.access, audienceSupport: support }
  }
  let stateWrites = 0
  let insertedStateReads = 0
  for (const member of directory) {
    const state = states.get(member.membershipId) ?? null
    if (addIds.has(member.membershipId) && state?.audienceGranted !== true) {
      if (state === null) {
        const stateId = await ctx.db.insert('agentSessionMemberStates', {
          workspaceId: args.workspaceId,
          sessionId: session._id,
          membershipId: member.membershipId,
          audienceGranted: true,
        })
        const inserted = await ctx.db.get(stateId)
        if (inserted === null) throw new Error('Session member state insert disappeared')
        insertedStateReads += 1
        states.set(member.membershipId, inserted)
      } else {
        await ctx.db.patch(state._id, { audienceGranted: true })
        states.set(member.membershipId, { ...state, audienceGranted: true })
      }
      stateWrites += 1
    }
    if (removeIds.has(member.membershipId) && state?.audienceGranted === true) {
      if (state.personalArchivedAt === undefined) {
        await ctx.db.delete(state._id)
        states.set(member.membershipId, null)
      } else {
        await ctx.db.patch(state._id, { audienceGranted: false })
        states.set(member.membershipId, { ...state, audienceGranted: false })
      }
      stateWrites += 1
    }
  }
  const nextStoredCount = requireSpecificParticipantCount(session) + added - removed
  if (nextStoredCount < 0) throw new Error('Specific participant count is invalid')
  const liveCount = directory.reduce((count, member) => {
    const wasGranted = states.get(member.membershipId)?.audienceGranted === true
    const granted = addIds.has(member.membershipId)
      ? true
      : removeIds.has(member.membershipId)
        ? false
        : wasGranted
    return count + (granted ? 1 : 0)
  }, 0)
  const patch = {
    specificGrantedParticipantCount: nextStoredCount,
    ...(liveCount === 0 && session.archiveState === 'active'
      ? { archiveState: 'archived' as const, archivedAt: args.now }
      : {}),
  }
  let discoveryMetrics: { ranges: number; documents: number; writes: number } | undefined
  const patchedSession = await patchSessionAndReconcileDiscovery(
    ctx,
    session,
    patch,
    support,
    metrics => {
      discoveryMetrics = metrics
    },
  )
  if (discoveryMetrics === undefined) throw new Error('Audience reconciliation metrics missing')
  args.onMetrics?.({
    reads: {
      ranges: 1 + directory.length + discoveryMetrics.ranges,
      documents:
        1 + directory.length + stateDocuments + insertedStateReads + 1 + discoveryMetrics.documents,
    },
    writes: stateWrites + 1 + discoveryMetrics.writes,
    reconciliations: 1,
  })
  const membership = admitted.access.basis === 'workspace' ? null : admitted.access.membership
  const membershipId = membership?.membershipId
  const remainsGranted =
    membershipId !== undefined &&
    states.get(membershipId as Id<'workspaceMembers'>)?.audienceGranted === true
  const access = resolvePreloadedSessionAccess({
    identity: args.identity,
    membership,
    session: {
      ...admitted.accessTarget,
      audience: {
        kind: 'specific',
        membershipGrant: remainsGranted && membershipId !== undefined ? { membershipId } : null,
      },
    },
  })
  if (!access.ok) return null
  return { session: patchedSession, access, audienceSupport: support }
}
