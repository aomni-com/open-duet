import { getDocumentSize, type Value } from 'convex/values'

import {
  normalizeSessionActivityText,
  projectSessionActivityMachine,
  SESSION_ACTIVITY_MAX_LIMIT,
  SESSION_ACTIVITY_PRIORITY,
  WORKSPACE_MEMBER_LIMIT,
  type SessionBucket,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { sessionAudienceAdmitsMembership, type SessionDiscoveryScope } from './access'
import {
  DISCOVERY_LANE_HAS_MORE_PROBE,
  SESSION_LIST_EXCLUDE_ALLOWANCE,
  SESSION_LIST_SOURCE_RESERVATION,
  type SessionListReadCost,
} from './pageBudget'

const OWNER_LANE = 'owner'
const WORKSPACE_LANE = 'workspace'
const MEMBER_LANE_PREFIX = 'member:'
const PERSONAL_LANE_PREFIX = 'personal:'
export const DELETE_DISCOVERY_BATCH = 100
// Activity has no cursor, so personal-archive subtraction may look past one
// full page of seats. Two pages keeps the edge case useful while preserving
// the complete grouped-query transaction bound proved in Slice 05c.
const SESSION_ACTIVITY_CANDIDATE_LIMIT = SESSION_ACTIVITY_MAX_LIMIT * 2

export type DiscoveryArchiveState = 'active' | 'archived'

export type SessionActivityDiscoveryRow = Doc<'agentSessionDiscovery'>

export function sessionDiscoveryOrderKey(
  updatedAt: number,
  sessionId: Id<'agentSessions'> | string,
): string {
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new Error('Session discovery updatedAt must be a non-negative safe integer')
  }
  return `${String(updatedAt).padStart(16, '0')}:${sessionId}`
}

export function sessionDiscoveryLaneKey(
  kind: 'owner' | 'workspace' | 'member' | 'personal',
  membershipId?: Id<'workspaceMembers'> | string,
): string {
  if (kind === 'owner') return OWNER_LANE
  if (kind === 'workspace') return WORKSPACE_LANE
  if (membershipId === undefined) throw new Error(`${kind} discovery lane requires membership`)
  return `${kind === 'member' ? MEMBER_LANE_PREFIX : PERSONAL_LANE_PREFIX}${membershipId}`
}

/**
 * Make the indexed rows reachable by current principals match one session.
 *
 * The session document and generation-bound member state remain authoritative.
 * Rows here copy only equality/order dimensions; they never copy audience or
 * search text. Every caller runs in the canonical transition's transaction.
 */
export async function reconcileSessionDiscovery(
  ctx: MutationCtx,
  sessionOrId: Doc<'agentSessions'> | Id<'agentSessions'>,
  support?: {
    directory: Doc<'workspaceMemberDirectory'>[]
    states: Map<Id<'workspaceMembers'>, Doc<'agentSessionMemberStates'> | null>
  },
  onMetrics?: (metrics: { ranges: number; documents: number; writes: number }) => void,
): Promise<number> {
  const session = typeof sessionOrId === 'string' ? await ctx.db.get(sessionOrId) : sessionOrId
  if (session === null) return 0

  // Current membership rows, unlike historical member state, are bounded by
  // workspace capacity. Deleted generations may wait for their cleanup job;
  // their lane keys are no longer resolvable and must not make an ordinary
  // session event inherit unbounded historical fanout.
  const memberships =
    support?.directory.map(row => ({
      _id: row.membershipId,
      role: row.role,
    })) ??
    (
      await Promise.all(
        (['owner', 'editor', 'viewer'] as const).map(role =>
          ctx.db
            .query('workspaceMembers')
            .withIndex('by_workspace_role', q =>
              q.eq('workspaceId', session.workspaceId).eq('role', role),
            )
            .take(WORKSPACE_MEMBER_LIMIT + 1),
        ),
      )
    ).flat()
  if (memberships.length > WORKSPACE_MEMBER_LIMIT) {
    throw new Error('Workspace member capacity exceeded')
  }

  const states = new Map<Id<'workspaceMembers'>, Doc<'agentSessionMemberStates'> | null>()
  for (const membership of memberships) {
    states.set(
      membership._id,
      support !== undefined
        ? (support.states.get(membership._id) ?? null)
        : await ctx.db
            .query('agentSessionMemberStates')
            .withIndex('by_session_membership', q =>
              q.eq('sessionId', session._id).eq('membershipId', membership._id),
            )
            .unique(),
    )
  }
  const desired = desiredSessionDiscoveryRows(session, memberships, states)

  const candidateLanes = [
    OWNER_LANE,
    WORKSPACE_LANE,
    ...memberships.flatMap(membership => [
      sessionDiscoveryLaneKey('member', membership._id),
      sessionDiscoveryLaneKey('personal', membership._id),
    ]),
  ]
  let writes = 0
  let documents = 0
  for (const laneKey of candidateLanes) {
    const current = await ctx.db
      .query('agentSessionDiscovery')
      .withIndex('by_session_lane', q => q.eq('sessionId', session._id).eq('laneKey', laneKey))
      .unique()
    if (current !== null) documents += 1
    const row = desired.get(laneKey)
    if (row === undefined) {
      if (current !== null) {
        await ctx.db.delete(current._id)
        writes += 1
      }
    } else if (current === null) {
      await ctx.db.insert('agentSessionDiscovery', row)
      writes += 1
    } else if (!sameDiscoveryRow(current, row)) {
      await ctx.db.patch(current._id, row)
      writes += 1
    }
  }
  onMetrics?.({ ranges: candidateLanes.length, documents, writes })
  return writes
}

export function desiredSessionDiscoveryRows(
  session: Doc<'agentSessions'>,
  memberships: Array<Pick<Doc<'workspaceMembers'>, '_id' | 'role'>>,
  states: Map<Id<'workspaceMembers'>, Doc<'agentSessionMemberStates'> | null>,
): Map<string, Omit<Doc<'agentSessionDiscovery'>, '_id' | '_creationTime'>> {
  const desired = new Map<string, Omit<Doc<'agentSessionDiscovery'>, '_id' | '_creationTime'>>()
  const put = (laneKey: string, archiveState: DiscoveryArchiveState) => {
    const machine = projectSessionActivityMachine(session.machine)
    const row = {
      workspaceId: session.workspaceId,
      laneKey,
      sessionId: session._id,
      archiveState,
      agentId: session.agentId,
      createdBySessionId: session.createdBySessionId,
      bucket: session.bucket,
      orderKey: sessionDiscoveryOrderKey(session.updatedAt, session._id),
      title: normalizeSessionActivityText(session.title),
      updatedAt: session.updatedAt,
      lastEventSeq: session.lastEventSeq,
      ...(machine === undefined ? {} : { machine }),
      ...(session.lastMessage === undefined ? {} : { preview: session.lastMessage }),
    }
    assertDiscoveryRowFitsListReservation(row)
    desired.set(laneKey, row)
  }
  const discoverable = session.archiveState !== 'deleting' && session.onboarding !== true
  if (discoverable) {
    const archiveState = session.archiveState as DiscoveryArchiveState
    put(OWNER_LANE, archiveState)
    if (session.audienceKind === 'workspace') put(WORKSPACE_LANE, archiveState)
    for (const membership of memberships) {
      const state = states.get(membership._id) ?? null
      if (state !== null) {
        if (session.audienceKind === 'specific' && state.audienceGranted) {
          put(sessionDiscoveryLaneKey('member', state.membershipId), archiveState)
        }
        const admitted = sessionAudienceAdmitsMembership({
          audienceKind: session.audienceKind,
          audienceGranted: state.audienceGranted,
          role: membership.role,
        })
        if (
          admitted &&
          state.personalArchivedAt !== undefined &&
          session.archiveState === 'active'
        ) {
          // The personal lane participates only in archive-only reads. Its row is
          // labelled archived while the canonical session remains globally active,
          // making it disjoint from every globally archived lane.
          put(sessionDiscoveryLaneKey('personal', state.membershipId), 'archived')
        }
      }
    }
  }
  return desired
}

export function sameDiscoveryRow(
  current: Doc<'agentSessionDiscovery'>,
  desired: Omit<Doc<'agentSessionDiscovery'>, '_id' | '_creationTime'>,
): boolean {
  return (
    current.workspaceId === desired.workspaceId &&
    current.laneKey === desired.laneKey &&
    current.sessionId === desired.sessionId &&
    current.archiveState === desired.archiveState &&
    current.onboarding === desired.onboarding &&
    current.agentId === desired.agentId &&
    current.createdBySessionId === desired.createdBySessionId &&
    current.bucket === desired.bucket &&
    current.orderKey === desired.orderKey &&
    current.title === desired.title &&
    current.updatedAt === desired.updatedAt &&
    current.lastEventSeq === desired.lastEventSeq &&
    JSON.stringify(current.machine) === JSON.stringify(desired.machine) &&
    JSON.stringify(current.preview) === JSON.stringify(desired.preview)
  )
}

export async function deleteSessionDiscovery(
  ctx: MutationCtx,
  sessionId: Id<'agentSessions'>,
): Promise<number> {
  const rows = await ctx.db
    .query('agentSessionDiscovery')
    .withIndex('by_session_lane', q => q.eq('sessionId', sessionId))
    .take(DELETE_DISCOVERY_BATCH)
  for (const row of rows) await ctx.db.delete(row._id)
  return rows.length
}

export async function deleteMembershipSessionDiscovery(
  ctx: MutationCtx,
  sessionId: Id<'agentSessions'>,
  membershipId: Id<'workspaceMembers'>,
): Promise<void> {
  for (const laneKey of [
    sessionDiscoveryLaneKey('member', membershipId),
    sessionDiscoveryLaneKey('personal', membershipId),
  ]) {
    const row = await ctx.db
      .query('agentSessionDiscovery')
      .withIndex('by_session_lane', q => q.eq('sessionId', sessionId).eq('laneKey', laneKey))
      .unique()
    if (row !== null) await ctx.db.delete(row._id)
  }
}

/** The only canonical-session patch path for fields copied into discovery. */
export async function patchSessionAndReconcileDiscovery(
  ctx: MutationCtx,
  session: Doc<'agentSessions'>,
  patch: Partial<Doc<'agentSessions'>>,
  support?: Parameters<typeof reconcileSessionDiscovery>[2],
  onReconcileMetrics?: Parameters<typeof reconcileSessionDiscovery>[3],
): Promise<Doc<'agentSessions'>> {
  await ctx.db.patch(session._id, patch)
  // Re-read after the patch so same-transaction side effects owned by another
  // canonical writer (notably appendEvent's bounded message preview) are not
  // lost by reconciling from a stale caller snapshot.
  const patched = await ctx.db.get(session._id)
  if (patched === null) throw new Error('Session not found')
  await reconcileSessionDiscovery(ctx, patched, support, onReconcileMetrics)
  return patched
}

export interface SessionDiscoveryRequest {
  workspaceId: Id<'workspaces'>
  scope: Extract<SessionDiscoveryScope, { ok: true }>['scope']
  archiveState: DiscoveryArchiveState
  limit: number
  beforeOrderKey?: string
  agentId?: Id<'agents'> | null
  bucket?: SessionBucket
  search?: string
  relationship: SessionDiscoveryRelationship
}

export type SessionDiscoveryRelationship =
  | { kind: 'any' }
  | { kind: 'topLevel' }
  | { kind: 'children'; parentSessionId: Id<'agentSessions'> }

export interface SessionDiscoveryCandidatePage {
  candidates: Doc<'agentSessionDiscovery'>[]
  hasMore: boolean
  readCost: SessionListReadCost
}

/** Indexed authorized source for the bounded public list page processor. */
export async function listSessionDiscoveryCandidates(
  ctx: QueryCtx,
  args: SessionDiscoveryRequest,
): Promise<SessionDiscoveryCandidatePage> {
  const { selected, hasMore, readCost } = await selectDiscoveryCandidates(ctx, args)
  return { candidates: selected, hasMore, readCost }
}

export interface SessionActivityDiscoveryPage {
  rows: SessionActivityDiscoveryRow[]
  truncated: boolean
}

/**
 * Read one owner's bounded activity source without hydrating canonical sessions.
 * Personal archive is presentation subtraction over a bounded candidate
 * window. Hidden rows do not spend seats; reaching the window before proving
 * exhaustion reports truncation instead of pretending the answer is whole.
 */
export async function listSessionActivityDiscovery(
  ctx: QueryCtx,
  args: {
    workspaceId: Id<'workspaces'>
    scope: Extract<SessionDiscoveryScope, { ok: true }>['scope']
    agentId: Id<'agents'> | null
    limit: number
    excludeSessionId?: Id<'agentSessions'>
  },
): Promise<SessionActivityDiscoveryPage> {
  const limit = Math.min(SESSION_ACTIVITY_MAX_LIMIT, Math.max(1, Math.floor(args.limit)))
  const rows: SessionActivityDiscoveryRow[] = []
  let sourceTruncated = false
  let candidateBudget = SESSION_ACTIVITY_CANDIDATE_LIMIT
  for (const [bucketIndex, bucket] of SESSION_ACTIVITY_PRIORITY.entries()) {
    // One extra candidate allows the exact default chat to be removed without
    // consuming the bounded work-candidate budget.
    const excludeAllowance =
      args.excludeSessionId === undefined ? 0 : SESSION_LIST_EXCLUDE_ALLOWANCE
    const page = await selectDiscoveryCandidates(ctx, {
      workspaceId: args.workspaceId,
      scope: args.scope,
      archiveState: 'active',
      agentId: args.agentId,
      bucket,
      limit: candidateBudget + excludeAllowance,
      relationship: { kind: 'any' },
    })
    const work =
      args.excludeSessionId === undefined
        ? page.selected
        : page.selected.filter(row => row.sessionId !== args.excludeSessionId)
    const candidates = work.slice(0, candidateBudget)
    for (const row of candidates) {
      candidateBudget -= 1
      if (await personallyHiddenFromActive(ctx, args.scope, 'active', row.sessionId)) continue
      if (rows.length < limit) {
        rows.push(row)
        continue
      }
      sourceTruncated = true
      break
    }
    if (sourceTruncated) break

    const currentBucketHasMore = page.hasMore || work.length > candidates.length
    if (currentBucketHasMore) {
      sourceTruncated = true
      break
    }
    if (candidateBudget === 0) {
      // The current bucket is exhausted, but lower-priority buckets have not
      // been inspected. Conservatively preserve the truncation signal.
      sourceTruncated = bucketIndex < SESSION_ACTIVITY_PRIORITY.length - 1
      break
    }
  }
  return { rows, truncated: sourceTruncated }
}

/** Resolve a default-chat pointer through its authorized discovery lane. */
export async function getSessionActivityDiscovery(
  ctx: QueryCtx,
  args: {
    workspaceId: Id<'workspaces'>
    scope: Extract<SessionDiscoveryScope, { ok: true }>['scope']
    sessionId: Id<'agentSessions'>
    agentId: Id<'agents'> | null
  },
): Promise<SessionActivityDiscoveryRow | null> {
  const laneKeys =
    args.scope.kind === 'workspace'
      ? [OWNER_LANE]
      : [WORKSPACE_LANE, sessionDiscoveryLaneKey('member', args.scope.membershipId)]
  const rows = (
    await Promise.all(
      laneKeys.map(laneKey =>
        ctx.db
          .query('agentSessionDiscovery')
          .withIndex('by_session_lane', q =>
            q.eq('sessionId', args.sessionId).eq('laneKey', laneKey),
          )
          .unique(),
      ),
    )
  ).filter(
    (row): row is Doc<'agentSessionDiscovery'> =>
      row !== null &&
      row.workspaceId === args.workspaceId &&
      row.agentId === (args.agentId ?? undefined),
  )
  if (rows.length > 1) throw new Error('Duplicate authorized session discovery rows')
  return rows[0] ?? null
}

/**
 * The most candidates any caller may ask one selection for. The widest is the
 * session list: a full public page, plus the row it holds out under
 * `excludeDefault`. Nothing may ask for more than the source reservation proves
 * a lane can read.
 */
export function discoveryRequestCeiling(): number {
  return SESSION_LIST_SOURCE_RESERVATION.rowsPerLane - DISCOVERY_LANE_HAS_MORE_PROBE
}

/**
 * Rows one lane actually reads to answer a request for `limit` candidates. The
 * probe is the difference between the number asked for and the number read, and
 * it is the reason the reservation is not simply the limit — a proof written
 * against the request rather than against this bounds one row per lane too few.
 */
export function discoveryLaneRowCount(limit: number): number {
  return limit + DISCOVERY_LANE_HAS_MORE_PROBE
}

async function selectDiscoveryCandidates(
  ctx: QueryCtx,
  args: SessionDiscoveryRequest,
): Promise<{
  selected: Doc<'agentSessionDiscovery'>[]
  hasMore: boolean
  readCost: SessionListReadCost
}> {
  const limit = Math.min(discoveryRequestCeiling(), Math.max(1, Math.floor(args.limit)))
  const laneKeys = discoveryLaneKeys(args.scope, args.archiveState)
  const pages = await Promise.all(
    laneKeys.map(laneKey =>
      queryDiscoveryLane(ctx, { ...args, laneKey, limit: discoveryLaneRowCount(limit) }),
    ),
  )
  const merged = pages.flat().sort(compareDiscoveryRowsDesc)
  for (const row of merged) assertDiscoveryRowFitsListReservation(row)
  assertNoDuplicateSessions(merged)
  return {
    selected: merged.slice(0, limit),
    hasMore: merged.length > limit,
    readCost: {
      ranges: laneKeys.length,
      documents: merged.length,
      bytes: merged.reduce((total, row) => total + getDocumentSize(row), 0),
    },
  }
}

function assertDiscoveryRowFitsListReservation(value: unknown): void {
  if (
    getDocumentSize(value as Record<string, Value>) > SESSION_LIST_SOURCE_RESERVATION.bytesPerRow
  ) {
    throw new Error('Session discovery row exceeds the list source reservation')
  }
}

async function queryDiscoveryLane(
  ctx: QueryCtx,
  args: SessionDiscoveryRequest & { laneKey: string },
): Promise<Doc<'agentSessionDiscovery'>[]> {
  const before = args.beforeOrderKey
  const take = args.limit
  const relationship = args.relationship
  const parentId =
    relationship.kind === 'any'
      ? undefined
      : relationship.kind === 'topLevel'
        ? undefined
        : relationship.parentSessionId
  if (relationship.kind !== 'any' && args.agentId !== undefined && args.bucket !== undefined) {
    return await ctx.db
      .query('agentSessionDiscovery')
      .withIndex('by_lane_agent_parent_archive_bucket_order', q => {
        const range = q
          .eq('workspaceId', args.workspaceId)
          .eq('laneKey', args.laneKey)
          .eq('onboarding', undefined)
          .eq('agentId', args.agentId ?? undefined)
          .eq('createdBySessionId', parentId)
          .eq('archiveState', args.archiveState)
          .eq('bucket', args.bucket!)
        return before === undefined ? range : range.lt('orderKey', before)
      })
      .order('desc')
      .take(take)
  }
  if (relationship.kind !== 'any' && args.agentId !== undefined) {
    return await ctx.db
      .query('agentSessionDiscovery')
      .withIndex('by_lane_agent_parent_archive_order', q => {
        const range = q
          .eq('workspaceId', args.workspaceId)
          .eq('laneKey', args.laneKey)
          .eq('onboarding', undefined)
          .eq('agentId', args.agentId ?? undefined)
          .eq('createdBySessionId', parentId)
          .eq('archiveState', args.archiveState)
        return before === undefined ? range : range.lt('orderKey', before)
      })
      .order('desc')
      .take(take)
  }
  if (relationship.kind !== 'any' && args.bucket !== undefined) {
    return await ctx.db
      .query('agentSessionDiscovery')
      .withIndex('by_lane_parent_archive_bucket_order', q => {
        const range = q
          .eq('workspaceId', args.workspaceId)
          .eq('laneKey', args.laneKey)
          .eq('onboarding', undefined)
          .eq('createdBySessionId', parentId)
          .eq('archiveState', args.archiveState)
          .eq('bucket', args.bucket!)
        return before === undefined ? range : range.lt('orderKey', before)
      })
      .order('desc')
      .take(take)
  }
  if (relationship.kind !== 'any') {
    return await ctx.db
      .query('agentSessionDiscovery')
      .withIndex('by_lane_parent_archive_order', q => {
        const range = q
          .eq('workspaceId', args.workspaceId)
          .eq('laneKey', args.laneKey)
          .eq('onboarding', undefined)
          .eq('createdBySessionId', parentId)
          .eq('archiveState', args.archiveState)
        return before === undefined ? range : range.lt('orderKey', before)
      })
      .order('desc')
      .take(take)
  }
  if (args.agentId !== undefined && args.bucket !== undefined) {
    return await ctx.db
      .query('agentSessionDiscovery')
      .withIndex('by_lane_agent_archive_bucket_order', q => {
        const range = q
          .eq('workspaceId', args.workspaceId)
          .eq('laneKey', args.laneKey)
          .eq('onboarding', undefined)
          .eq('agentId', args.agentId ?? undefined)
          .eq('archiveState', args.archiveState)
          .eq('bucket', args.bucket!)
        return before === undefined ? range : range.lt('orderKey', before)
      })
      .order('desc')
      .take(take)
  }
  if (args.agentId !== undefined) {
    return await ctx.db
      .query('agentSessionDiscovery')
      .withIndex('by_lane_agent_archive_order', q => {
        const range = q
          .eq('workspaceId', args.workspaceId)
          .eq('laneKey', args.laneKey)
          .eq('onboarding', undefined)
          .eq('agentId', args.agentId ?? undefined)
          .eq('archiveState', args.archiveState)
        return before === undefined ? range : range.lt('orderKey', before)
      })
      .order('desc')
      .take(take)
  }
  if (args.bucket !== undefined) {
    return await ctx.db
      .query('agentSessionDiscovery')
      .withIndex('by_lane_archive_bucket_order', q => {
        const range = q
          .eq('workspaceId', args.workspaceId)
          .eq('laneKey', args.laneKey)
          .eq('onboarding', undefined)
          .eq('archiveState', args.archiveState)
          .eq('bucket', args.bucket!)
        return before === undefined ? range : range.lt('orderKey', before)
      })
      .order('desc')
      .take(take)
  }
  return await ctx.db
    .query('agentSessionDiscovery')
    .withIndex('by_lane_archive_order', q => {
      const range = q
        .eq('workspaceId', args.workspaceId)
        .eq('laneKey', args.laneKey)
        .eq('onboarding', undefined)
        .eq('archiveState', args.archiveState)
      return before === undefined ? range : range.lt('orderKey', before)
    })
    .order('desc')
    .take(take)
}

function discoveryLaneKeys(
  scope: Extract<SessionDiscoveryScope, { ok: true }>['scope'],
  archiveState: DiscoveryArchiveState,
): string[] {
  if (scope.kind === 'workspace') {
    return archiveState === 'archived' && scope.membershipId !== undefined
      ? [OWNER_LANE, sessionDiscoveryLaneKey('personal', scope.membershipId)]
      : [OWNER_LANE]
  }
  const lanes = [WORKSPACE_LANE, sessionDiscoveryLaneKey('member', scope.membershipId)]
  if (archiveState === 'archived') {
    lanes.push(sessionDiscoveryLaneKey('personal', scope.membershipId))
  }
  return lanes
}

async function personallyHiddenFromActive(
  ctx: QueryCtx,
  scope: Extract<SessionDiscoveryScope, { ok: true }>['scope'],
  archiveState: DiscoveryArchiveState,
  sessionId: Id<'agentSessions'>,
): Promise<boolean> {
  if (archiveState !== 'active') return false
  const membershipId = scope.membershipId
  if (membershipId === undefined) return false
  const normalizedMembershipId = ctx.db.normalizeId('workspaceMembers', membershipId)
  if (normalizedMembershipId === null) return false
  const state = await ctx.db
    .query('agentSessionMemberStates')
    .withIndex('by_session_membership', q =>
      q.eq('sessionId', sessionId).eq('membershipId', normalizedMembershipId),
    )
    .unique()
  return state?.personalArchivedAt !== undefined
}

function compareDiscoveryRowsDesc(
  left: Doc<'agentSessionDiscovery'>,
  right: Doc<'agentSessionDiscovery'>,
): number {
  return left.orderKey === right.orderKey ? 0 : left.orderKey > right.orderKey ? -1 : 1
}

function assertNoDuplicateSessions(rows: readonly Doc<'agentSessionDiscovery'>[]): void {
  const seen = new Set<Id<'agentSessions'>>()
  for (const row of rows) {
    if (seen.has(row.sessionId)) throw new Error('Duplicate session discovery row across lanes')
    seen.add(row.sessionId)
  }
}
