import { getDocumentSize } from 'convex/values'

import {
  AGENT_TERMINAL_STATES,
  COLLECTION_PAGE_DEFAULT_LIMIT,
  COLLECTION_PAGE_MAX_LIMIT,
  DefaultSessionHistoryCursorCodec,
  ROOT_AGENT_SCOPE,
  SESSION_LIST_MAX_LIMIT,
  SessionHistoryCursorCodec,
  SessionChildrenCursorCodec,
  SessionListCursorCodec,
  type SessionBucket,
  type SessionHistoryView,
  type SessionListItem,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { QueryCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { assertActorRole, assertRole, type WorkspaceRole } from '../workspaces/authorization'
import {
  admittedWorkspaceSessionAccess,
  currentSessionMembershipWithReadCost,
  resolveSessionDiscoveryScope,
  resolveSessionDiscoveryScopeFromDb,
  resolvePreloadedSessionAccess,
  requireSessionPointFromDb,
  resolveSessionPointFromDb,
} from './access'
import {
  requireDefaultHistorySessionPoint,
  resolveDefaultSessionPoint,
  sessionMatchesDefaultOwner,
} from './defaultSession'
import { listSessionDiscoveryCandidates } from './discovery'
import { admitSessionId, decodeSessionCollectionCursor, throwSessionError } from './errors'
import type { SessionRequestIdentity } from './identity'
import type { DefaultSessionOwner } from './model'
import {
  addSessionListReadCost,
  SESSION_LIST_EXCLUDE_ALLOWANCE,
  serializedSessionPageBytes,
  SessionHistoryPageBudget,
  SessionListPageBudget,
  type SessionListReadCost,
} from './pageBudget'
import {
  loadSessionProjectionSupport,
  projectSessionListItemFromSupport,
  projectSessionSnapshot,
} from './projection'
import { unreadBySession, unreadForSessionAtFloorWithReadBytes } from './reads'
import { normalizeSessionSearch } from './search'

const RUNNER_INPUT_DRAIN_CANDIDATE_LIMIT = 50

export async function getSessionImpl(
  ctx: QueryCtx,
  args: {
    workspaceId: Id<'workspaces'>
    sessionId: string
    internalKey?: string
    actorId?: Id<'users'>
  },
) {
  const reader = await assertReader(ctx, args)
  const session = await ctx.db.get(admitSessionId(ctx, args.sessionId))
  if (
    session === null ||
    session.workspaceId !== args.workspaceId ||
    session.archiveState === 'deleting'
  )
    return null
  const unread = await unreadForSession(ctx, args.workspaceId, args.actorId, session)
  return await projectSessionSnapshot(ctx, session, {
    access: admittedWorkspaceSessionAccess(readerMembership(reader)),
    unread,
  })
}

export async function getSessionPointImpl(
  ctx: QueryCtx,
  args: {
    workspaceId: Id<'workspaces'>
    sessionId: string
    internalKey: string
    identity: SessionRequestIdentity
  },
) {
  requireApiInternalKey(args.internalKey)
  const admitted = await resolveSessionPointFromDb(ctx, args)
  if (admitted === null) return null
  return await projectSessionSnapshot(ctx, admitted.session, {
    access: admitted.access,
    unread: await unreadForSession(
      ctx,
      args.workspaceId,
      args.identity.principal.kind === 'human'
        ? (args.identity.principal.userId as Id<'users'>)
        : undefined,
      admitted.session,
    ),
  })
}

export async function getDefaultSessionImpl(
  ctx: QueryCtx,
  args: {
    workspaceId: Id<'workspaces'>
    owner: DefaultSessionOwner
    internalKey: string
    identity: SessionRequestIdentity
  },
) {
  requireApiInternalKey(args.internalKey)
  const admitted = await resolveDefaultSessionPoint(ctx, args)
  if (admitted === null) return null
  return await projectSessionSnapshot(ctx, admitted.session, {
    access: admitted.access,
    unread: await unreadForSession(
      ctx,
      args.workspaceId,
      args.identity.principal.kind === 'human'
        ? (args.identity.principal.userId as Id<'users'>)
        : undefined,
      admitted.session,
    ),
  })
}

async function defaultAgentSessionId(
  ctx: QueryCtx,
  workspaceId: Id<'workspaces'>,
  agentId: Id<'agents'>,
): Promise<{ sessionId: Id<'agentSessions'> | undefined; readCost: SessionListReadCost }> {
  const agent = await ctx.db.get(agentId)
  return {
    sessionId:
      agent === null || agent.workspaceId !== workspaceId ? undefined : agent.defaultSessionId,
    readCost: {
      ranges: 1,
      documents: agent === null ? 0 : 1,
      bytes: agent === null ? 0 : getDocumentSize(agent),
    },
  }
}

export async function listEventsImpl(
  ctx: QueryCtx,
  args: {
    workspaceId: Id<'workspaces'>
    sessionId: string
    afterSeq?: number
    beforeSeq?: number
    limit?: number
    internalKey: string
    identity: SessionRequestIdentity
  },
) {
  requireApiInternalKey(args.internalKey)
  const { session } = await requireSessionPointFromDb(ctx, args)
  const afterSeq = args.afterSeq ?? 0
  const limit = Math.min(args.limit ?? 100, 501)
  if (args.afterSeq !== undefined && args.beforeSeq !== undefined)
    throw new Error('Event query cannot combine afterSeq and beforeSeq')
  const beforeSeq = args.beforeSeq
  const rows =
    beforeSeq === undefined
      ? await ctx.db
          .query('agentSessionEvents')
          .withIndex('by_session_seq', q => q.eq('sessionId', session._id).gt('seq', afterSeq))
          .order('asc')
          .take(limit)
      : await ctx.db
          .query('agentSessionEvents')
          .withIndex('by_session_seq', q => q.eq('sessionId', session._id).lt('seq', beforeSeq))
          .order('desc')
          .take(limit)
  return rows.map(row => ({ seq: row.seq, event: row.event, createdAt: row.createdAt }))
}

type SessionHistoryOrder = 'asc' | 'desc'

export async function listSessionHistoryPageImpl(
  ctx: QueryCtx,
  args: {
    workspaceId: Id<'workspaces'>
    sessionId: string
    cursor?: string
    limit?: number
    order?: SessionHistoryOrder
    afterSeq?: number
    view?: SessionHistoryView
    internalKey: string
    identity: SessionRequestIdentity
  },
) {
  requireApiInternalKey(args.internalKey)
  const admitted = await requireSessionPointFromDb(ctx, args)
  const order = historyOrder(args.order, args.afterSeq)
  const view = args.view ?? 'all'
  const subject = historySubject(args.workspaceId, admitted.access)
  const filters = {
    sessionId: admitted.session._id,
    afterSeq: args.afterSeq ?? null,
    view,
  }
  const position =
    args.cursor === undefined
      ? undefined
      : await decodeSessionCollectionCursor(args.cursor, cursor =>
          SessionHistoryCursorCodec.decode(cursor, { subject, filters, order }),
        )
  const page = await readEventPage(ctx, {
    sessionId: admitted.session._id,
    limit: sessionHistoryPageLimit(args.limit),
    order,
    view,
    afterSeq: args.afterSeq,
    positionSeq: position?.seq,
  })
  return {
    items: page.items,
    nextCursor:
      page.nextSeq === null
        ? null
        : await SessionHistoryCursorCodec.encode({
            subject,
            filters,
            order,
            position: { seq: page.nextSeq },
          }),
  }
}

export async function listDefaultSessionHistoryPageImpl(
  ctx: QueryCtx,
  args: {
    workspaceId: Id<'workspaces'>
    owner: DefaultSessionOwner
    cursor?: string
    limit?: number
    order?: SessionHistoryOrder
    afterSeq?: number
    view?: SessionHistoryView
    internalKey: string
    identity: SessionRequestIdentity
  },
) {
  requireApiInternalKey(args.internalKey)
  const order = historyOrder(args.order, args.afterSeq)
  const view = args.view ?? 'all'
  const discovery = await resolveSessionDiscoveryScopeFromDb(ctx, args)
  const subject = `${args.workspaceId}:${discoveryScopeSubject(discovery.scope)}`
  const filters = {
    owner: args.owner.kind === 'root' ? ROOT_AGENT_SCOPE : args.owner.agentId,
    afterSeq: args.afterSeq ?? null,
    view,
  }
  const position =
    args.cursor === undefined
      ? undefined
      : await decodeSessionCollectionCursor(args.cursor, cursor =>
          DefaultSessionHistoryCursorCodec.decode(cursor, { subject, filters, order }),
        )
  const admitted =
    position === undefined
      ? await requireDefaultHistorySessionPoint(ctx, args)
      : await resolveSessionPointFromDb(ctx, { ...args, sessionId: position.sessionId })
  if (
    admitted === null ||
    (position !== undefined && !sessionMatchesDefaultOwner(admitted.session, args.owner))
  ) {
    throwSessionError('not_found')
  }
  const page = await readEventPage(ctx, {
    sessionId: admitted.session._id,
    limit: sessionHistoryPageLimit(args.limit),
    order,
    view,
    afterSeq: args.afterSeq,
    positionSeq: position?.seq,
  })
  return {
    items: page.items,
    nextCursor:
      page.nextSeq === null
        ? null
        : await DefaultSessionHistoryCursorCodec.encode({
            subject,
            filters,
            order,
            position: { sessionId: admitted.session._id, seq: page.nextSeq },
          }),
  }
}

async function readEventPage(
  ctx: QueryCtx,
  args: {
    sessionId: Id<'agentSessions'>
    limit: number
    order: SessionHistoryOrder
    view: SessionHistoryView
    afterSeq?: number
    positionSeq?: number
  },
) {
  const items: Array<{ seq: number; event: unknown; createdAt: number }> = []
  const budget = new SessionHistoryPageBudget()
  let boundary = args.positionSeq ?? args.afterSeq
  let exhausted = false

  while (true) {
    if (exhausted) return { items, nextSeq: null }

    /* A scan costs the same whether it returns one row or a page of them, so
       it asks for as many as the read budget can still reserve, and one past
       the page's own limit as the witness for whether anything remains behind
       it. Every row it returns is charged, consumed or not: Convex read them
       either way, and charging only the ones that reached the page would
       understate the transaction this budget exists to bound. */
    const wanted = Math.min(budget.readableRows(), args.limit - items.length + 1)
    if (wanted <= 0) return continuedEventPage(items)
    const scanned = await eventRows(ctx, args.sessionId, args.view, args.order, boundary, wanted)
    exhausted = scanned.length < wanted
    const last = scanned.at(-1)
    if (last === undefined) return { items, nextSeq: null }
    budget.commitScan(scanned.map(getDocumentSize))
    boundary = last.seq

    for (const row of scanned) {
      // The count limit needs a witness just like the byte/read limits. This
      // row is deliberately not consumed; the cursor remains on the final
      // emitted sequence so the next request starts with this exact event.
      if (items.length >= args.limit) return continuedEventPage(items)

      const candidate = { seq: row.seq, event: row.event, createdAt: row.createdAt }
      /* Measured once, here, and never again — the budget carries the running
         total. Its envelope allows for the continued shape, cursor included,
         so a row that proves terminal only makes the real response smaller. */
      const candidateBytes = serializedSessionPageBytes(candidate)
      if (!budget.canEmit(candidateBytes)) {
        if (items.length === 0) {
          throw new Error('Maximum valid session event cannot make page progress')
        }
        return continuedEventPage(items)
      }
      budget.commitEmit(candidateBytes)
      items.push(candidate)
    }
  }
}

/**
 * The next `count` rows past `boundary` in the requested direction. Each view
 * is its own index range so the scan touches only documents the page can use:
 * the transcript view never reads the task rows it would skip.
 */
async function eventRows(
  ctx: QueryCtx,
  sessionId: Id<'agentSessions'>,
  view: SessionHistoryView,
  order: SessionHistoryOrder,
  boundary: number | undefined,
  count: number,
): Promise<Array<Doc<'agentSessionEvents'>>> {
  const events = ctx.db.query('agentSessionEvents')
  const ranged =
    view === 'transcript'
      ? events.withIndex('by_session_transcript_seq', q => {
          const range = q.eq('sessionId', sessionId).eq('transcript', true)
          if (order === 'asc') return range.gt('seq', boundary ?? 0)
          return boundary === undefined ? range : range.lt('seq', boundary)
        })
      : events.withIndex('by_session_seq', q => {
          const range = q.eq('sessionId', sessionId)
          if (order === 'asc') return range.gt('seq', boundary ?? 0)
          return boundary === undefined ? range : range.lt('seq', boundary)
        })
  return await ranged.order(order).take(count)
}

function continuedEventPage(items: Array<{ seq: number; event: unknown; createdAt: number }>) {
  const last = items.at(-1)
  if (last === undefined) throw new Error('Session event support reservation made no progress')
  return { items, nextSeq: last.seq }
}

function historyOrder(order: SessionHistoryOrder | undefined, afterSeq: number | undefined) {
  const resolved = order ?? 'desc'
  if (
    (afterSeq !== undefined && resolved !== 'asc') ||
    (afterSeq !== undefined && (!Number.isSafeInteger(afterSeq) || afterSeq < 0))
  ) {
    throwSessionError('invalid_request')
  }
  return resolved
}

function sessionHistoryPageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return COLLECTION_PAGE_DEFAULT_LIMIT
  return Math.min(COLLECTION_PAGE_MAX_LIMIT, Math.max(1, Math.floor(limit)))
}

function historySubject(
  workspaceId: Id<'workspaces'>,
  access: Awaited<ReturnType<typeof requireSessionPointFromDb>>['access'],
): string {
  return `${workspaceId}:${
    access.basis === 'workspace' ? 'workspace' : `membership:${access.membership.membershipId}`
  }`
}

function discoveryScopeSubject(
  scope: Awaited<ReturnType<typeof resolveSessionDiscoveryScopeFromDb>>['scope'],
): string {
  return scope.membershipId === undefined ? 'workspace' : `membership:${scope.membershipId}`
}

/** Frozen internal transcript delivery after a public request was admitted. */
export async function listEventsForDeliveryImpl(
  ctx: QueryCtx,
  args: {
    internalKey: string
    workspaceId: Id<'workspaces'>
    sessionId: Id<'agentSessions'>
    afterSeq?: number
    limit?: number
  },
) {
  requireApiInternalKey(args.internalKey)
  const session = await ctx.db.get(args.sessionId)
  if (
    session === null ||
    session.workspaceId !== args.workspaceId ||
    !session.visible ||
    session.archiveState === 'deleting'
  ) {
    return []
  }
  const rows = await ctx.db
    .query('agentSessionEvents')
    .withIndex('by_session_seq', q => q.eq('sessionId', session._id).gt('seq', args.afterSeq ?? 0))
    .order('asc')
    .take(Math.min(args.limit ?? 100, 501))
  return rows.map(row => ({ seq: row.seq, event: row.event, createdAt: row.createdAt }))
}

/**
 * Continue an SSE stream whose public request already passed point admission.
 * Deliberately does not re-authorize a human principal: reconnect is the next
 * authorization boundary, while this accepted stream follows durable truth.
 */
export async function listEventsForStreamContinuationImpl(
  ctx: QueryCtx,
  args: {
    internalKey: string
    workspaceId: Id<'workspaces'>
    sessionId: Id<'agentSessions'>
    afterSeq: number
  },
) {
  requireApiInternalKey(args.internalKey)
  const session = await ctx.db.get(args.sessionId)
  if (
    session === null ||
    session.workspaceId !== args.workspaceId ||
    !session.visible ||
    session.archiveState === 'deleting'
  ) {
    return { events: [], headSeq: args.afterSeq, closed: true, terminal: false }
  }
  const page = await readEventPage(ctx, {
    sessionId: session._id,
    afterSeq: args.afterSeq,
    limit: 100,
    order: 'asc',
    view: 'all',
  })
  return {
    events: page.items,
    headSeq: session.lastEventSeq,
    closed: false,
    terminal: AGENT_TERMINAL_STATES.includes(
      session.turnStatus as (typeof AGENT_TERMINAL_STATES)[number],
    ),
  }
}

export async function findCoveringTerminalImpl(
  ctx: QueryCtx,
  args: {
    internalKey: string
    workspaceId: Id<'workspaces'>
    sessionId: Id<'agentSessions'>
    inputSeq: number
  },
) {
  requireApiInternalKey(args.internalKey)
  const session = await ctx.db.get(args.sessionId)
  if (
    session === null ||
    session.workspaceId !== args.workspaceId ||
    session.archiveState === 'deleting'
  ) {
    return null
  }
  // Durable input exists before gateway acceptance, so a covering terminal's
  // event seq is necessarily later than inputSeq. The terminal discriminator
  // keeps repeated observer checks off the ordinary transcript rows while seq
  // ordering preserves the earliest durable covering marker.
  const row = await ctx.db
    .query('agentSessionEvents')
    .withIndex('by_session_terminal_seq', q =>
      q.eq('sessionId', args.sessionId).eq('terminal', true).gt('seq', args.inputSeq),
    )
    .filter(q => q.gte(q.field('terminalAcceptedThroughSeq'), args.inputSeq))
    .first()
  if (row === null) return null
  // The cwd rides along so wait callers can resolve the relative file paths a
  // terminal result quotes — they are relative to the covered session's frame,
  // not the caller's. The row's stamp (the cwd when the terminal was appended)
  // wins over the session's current cwd, which a later cd may have moved;
  // pre-stamp rows fall back to the session.
  const cwd = row.cwd ?? session.cwd
  return {
    seq: row.seq,
    event: row.event,
    createdAt: row.createdAt,
    ...(cwd === undefined ? {} : { cwd }),
  }
}

export async function findWaitSubmissionImpl(
  ctx: QueryCtx,
  args: {
    internalKey: string
    workspaceId: Id<'workspaces'>
    identity: SessionRequestIdentity
    clientRequestId: string
    clientRequestFingerprint: string
    sessionId?: string
    parentSessionId?: string
    defaultOwner?: DefaultSessionOwner
    sourceSessionId?: string
  },
) {
  requireApiInternalKey(args.internalKey)
  const actorId = args.identity.actorId as Id<'users'>
  if (args.sourceSessionId !== undefined) {
    await requireSessionPointFromDb(ctx, {
      workspaceId: args.workspaceId,
      sessionId: args.sourceSessionId,
      identity: args.identity,
    })
  }
  if (
    Number(args.sessionId !== undefined) +
      Number(args.parentSessionId !== undefined) +
      Number(args.defaultOwner !== undefined) >
    1
  ) {
    throwSessionError('invalid_request')
  }
  const parentSession =
    args.parentSessionId === undefined
      ? null
      : await requireSessionPointFromDb(ctx, {
          workspaceId: args.workspaceId,
          sessionId: args.parentSessionId,
          identity: args.identity,
        })
  const defaultSession =
    args.defaultOwner === undefined
      ? null
      : await resolveDefaultSessionPoint(ctx, {
          workspaceId: args.workspaceId,
          owner: args.defaultOwner,
          identity: args.identity,
        })
  if (args.sessionId !== undefined) {
    const { session } = await requireSessionPointFromDb(ctx, {
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
      identity: args.identity,
    })
    return await matchingWaitInput(ctx, session, { ...args, actorId })
  }

  const candidates = await ctx.db
    .query('agentSessionEvents')
    .withIndex('by_workspace_submitting_actor_client_request', q =>
      q
        .eq('workspaceId', args.workspaceId)
        .eq('submittingActorId', actorId)
        .eq('clientRequestId', args.clientRequestId),
    )
    // A UUID should name one logical submission. Two matching rows are
    // ambiguous caller reuse, so keep the recovery lookup bounded and fail closed.
    .take(2)
  if (candidates.length === 0) {
    const unattributedCreate = await ctx.db
      .query('agentSessions')
      .withIndex('by_workspace_user_client_request', q =>
        q
          .eq('workspaceId', args.workspaceId)
          .eq('userId', actorId)
          .eq('clientRequestId', args.clientRequestId),
      )
      .unique()
    if (unattributedCreate !== null) {
      const unattributedInput = await ctx.db
        .query('agentSessionEvents')
        .withIndex('by_session_client_request', q =>
          q.eq('sessionId', unattributedCreate._id).eq('clientRequestId', args.clientRequestId),
        )
        .unique()
      if (unattributedInput !== null && unattributedInput.submittingActorId === undefined) {
        throwSessionError('idempotency_conflict')
      }
    }
  }
  const matches = []
  for (const input of candidates) {
    const session = await ctx.db.get(input.sessionId)
    if (session === null) continue
    if (
      (parentSession !== null && session.createdBySessionId !== parentSession.session._id) ||
      (args.defaultOwner !== undefined && session._id !== defaultSession?.session._id)
    ) {
      continue
    }
    const match = waitInputIdentity(session, input, { ...args, actorId })
    if (match === null) continue
    const admitted = await resolveSessionPointFromDb(ctx, {
      workspaceId: args.workspaceId,
      sessionId: session._id,
      identity: args.identity,
    })
    if (admitted === null) throwSessionError('not_found')
    matches.push(match)
  }
  return matches.length === 1 ? matches[0]! : null
}

async function matchingWaitInput(
  ctx: QueryCtx,
  session: Doc<'agentSessions'>,
  args: {
    workspaceId: Id<'workspaces'>
    actorId: Id<'users'>
    clientRequestId: string
    clientRequestFingerprint: string
  },
) {
  const input = await ctx.db
    .query('agentSessionEvents')
    .withIndex('by_session_client_request', q =>
      q.eq('sessionId', session._id).eq('clientRequestId', args.clientRequestId),
    )
    .unique()
  if (input !== null && input.submittingActorId === undefined) {
    throwSessionError('idempotency_conflict')
  }
  return input === null ? null : waitInputIdentity(session, input, args)
}

function waitInputIdentity(
  session: Doc<'agentSessions'>,
  input: Doc<'agentSessionEvents'>,
  args: {
    workspaceId: Id<'workspaces'>
    actorId: Id<'users'>
    clientRequestFingerprint: string
  },
) {
  if (
    session.workspaceId !== args.workspaceId ||
    input.submittingActorId !== args.actorId ||
    session.archiveState === 'deleting' ||
    input.clientRequestFingerprint !== args.clientRequestFingerprint
  ) {
    return null
  }
  return { sessionId: session._id, inputSeq: input.seq }
}

export async function listRunnerInputDrainCandidatesImpl(
  ctx: QueryCtx,
  args: { internalKey: string; workspaceId: Id<'workspaces'>; limit: number },
) {
  requireApiInternalKey(args.internalKey)
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null) throw new Error('Workspace not found')
  const sessions = await ctx.db
    .query('agentSessions')
    .withIndex('by_workspace_visible_pending_updated', q =>
      q.eq('workspaceId', args.workspaceId).eq('visible', true).eq('runnerInputPending', true),
    )
    .order('asc')
    .take(Math.min(Math.max(Math.floor(args.limit), 1), RUNNER_INPUT_DRAIN_CANDIDATE_LIMIT))
  return {
    workspaceSlug: workspace.slug,
    sessions: sessions.map((session: Doc<'agentSessions'>) => ({
      sessionId: session._id,
    })),
  }
}

/**
 * Every session a reader can see, in recency order, optionally narrowed to one
 * bucket and one agent.
 *
 * There is no second list. A session running a state machine — what the product
 * calls a job — differs only in carrying a `machine`, so it pages through
 * here alongside the conversations, and a bucket is complete rather than
 * whatever survived someone else's page boundary.
 */
interface SessionPageArgs {
  workspaceId: Id<'workspaces'>
  cursor?: string
  limit?: number
  search?: string
  bucket?: SessionBucket
  archived?: 'exclude' | 'only'
  agentId?: string
  excludeDefault?: true
  topLevel?: true
  parentSessionId?: string
  internalKey: string
  identity: SessionRequestIdentity
  actorId?: Id<'users'>
  onBudgetSnapshot?: (snapshot: { reads: SessionListReadCost; responseBytes: number }) => void
}

export async function listSessionsImpl(
  ctx: QueryCtx,
  args: Omit<SessionPageArgs, 'parentSessionId'>,
) {
  return await listSessionPageImpl(ctx, args, SessionListCursorCodec)
}

export async function listChildSessionsImpl(
  ctx: QueryCtx,
  args: Omit<SessionPageArgs, 'topLevel' | 'search' | 'agentId' | 'excludeDefault'> & {
    parentSessionId: string
  },
) {
  return await listSessionPageImpl(ctx, args, SessionChildrenCursorCodec)
}

async function listSessionPageImpl(
  ctx: QueryCtx,
  args: SessionPageArgs,
  cursorCodec: typeof SessionListCursorCodec,
) {
  requireApiInternalKey(args.internalKey)
  const membershipLoad =
    args.identity.principal.kind === 'human'
      ? await currentSessionMembershipWithReadCost(
          ctx,
          args.workspaceId,
          args.identity.principal.userId as Id<'users'>,
        )
      : { membership: null, readBytes: 0 }
  const membership = membershipLoad.membership
  if (args.identity.principal.kind === 'human' && membership === null)
    throwSessionError('not_found')
  if (
    (args.identity.principal.kind === 'human' && args.actorId !== args.identity.actorId) ||
    (args.identity.principal.kind === 'workspace' && args.actorId !== undefined)
  ) {
    throwSessionError('invalid_request')
  }
  if (args.parentSessionId !== undefined) {
    await requireSessionPointFromDb(ctx, {
      workspaceId: args.workspaceId,
      sessionId: args.parentSessionId,
      identity: args.identity,
    })
  }
  const discovery = resolveSessionDiscoveryScope({ identity: args.identity, membership })
  if (!discovery.ok) throwSessionError('not_found')
  const normalizedAgentId =
    args.agentId === undefined || args.agentId === ROOT_AGENT_SCOPE
      ? args.agentId
      : ctx.db.normalizeId('agents', args.agentId)
  if (
    args.agentId !== undefined &&
    args.agentId !== ROOT_AGENT_SCOPE &&
    normalizedAgentId === null
  ) {
    return { items: [], nextCursor: null }
  }
  /* Resolved once per query, not once per row: the fact lives on the owner
     (`agents.defaultSessionId`, `workspaces.rootDefaultSessionId`) and stays
     there, so this is one extra read rather than a column on every session.

     Refused without a scope for the same reason the contract refuses it: every
     owner has its own default, so "leave out the default" drive-wide would mean
     one row per face — a filter that silently did almost nothing. */
  let excludedId: Id<'agentSessions'> | undefined
  let defaultPointerReadCost: SessionListReadCost = { ranges: 0, documents: 0, bytes: 0 }
  if (args.excludeDefault === true) {
    if (args.agentId === undefined) throw new Error('excludeDefault requires agentId')
    if (args.agentId === ROOT_AGENT_SCOPE) {
      const workspace = await ctx.db.get(args.workspaceId)
      excludedId = workspace?.rootDefaultSessionId
      defaultPointerReadCost = {
        ranges: 1,
        documents: workspace === null ? 0 : 1,
        bytes: workspace === null ? 0 : getDocumentSize(workspace),
      }
    } else {
      const resolved = await defaultAgentSessionId(
        ctx,
        args.workspaceId,
        normalizedAgentId as Id<'agents'>,
      )
      excludedId = resolved.sessionId
      defaultPointerReadCost = resolved.readCost
    }
  }
  const archiveState = args.archived === 'only' ? 'archived' : 'active'
  const searchText = args.search === undefined ? undefined : normalizeSessionSearch(args.search)
  const baseSubject = `${args.workspaceId}:${discoveryScopeSubject(discovery.scope)}`
  const subject =
    args.parentSessionId === undefined
      ? baseSubject
      : `${baseSubject}:parent:${args.parentSessionId}`
  const filters =
    args.parentSessionId === undefined
      ? {
          search: searchText ?? null,
          bucket: args.bucket ?? null,
          archived: args.archived ?? 'exclude',
          agentId: args.agentId ?? null,
          excludedSessionId: excludedId ?? null,
          topLevel: args.topLevel ?? null,
        }
      : {
          parentSessionId: args.parentSessionId,
          bucket: args.bucket ?? null,
          archived: args.archived ?? 'exclude',
        }
  const decoded =
    args.cursor === undefined
      ? undefined
      : await decodeSessionCollectionCursor(args.cursor, cursor =>
          cursorCodec.decode(cursor, {
            subject,
            filters,
            order: 'updatedAt-desc-sessionId-desc',
          }),
        )
  const candidateLimit = sessionListPageLimit(args.limit)
  /* One extra candidate when a single known row is being held out.
     `excludedId` is not a filter over the data — it is one session id, resolved
     once above from the owner's own pointer, before a single candidate is read.
     Letting it spend a slot out of the page's budget is how a page comes back
     *empty* while a match sits one row behind it: scan `limit` candidates, find
     that the newest of them is the excluded chat, return nothing. An owner
     whose default chat is its most recently updated session then reads as an
     owner with no conversations at all — which is what a caller asking for one
     row was told, and what hid such owners from Work's sidebar entirely.

     `activity.ts` has compensated for this since it was written; this is the
     same allowance on the twin path, spelled the same way. */
  const excludeAllowance = excludedId === undefined ? 0 : SESSION_LIST_EXCLUDE_ALLOWANCE
  const source = await listSessionDiscoveryCandidates(ctx, {
    workspaceId: args.workspaceId,
    scope: discovery.scope,
    archiveState,
    limit: candidateLimit + excludeAllowance,
    ...(decoded === undefined ? {} : { beforeOrderKey: decoded.scannedThroughOrderKey }),
    ...(normalizedAgentId === undefined
      ? {}
      : { agentId: normalizedAgentId === ROOT_AGENT_SCOPE ? null : normalizedAgentId }),
    ...(args.bucket === undefined ? {} : { bucket: args.bucket }),
    relationship:
      args.parentSessionId !== undefined
        ? {
            kind: 'children' as const,
            parentSessionId: admitSessionId(ctx, args.parentSessionId),
          }
        : args.topLevel === true
          ? { kind: 'topLevel' as const }
          : { kind: 'any' as const },
  })
  /* The held-out row comes off the candidate list before the page is measured,
     not out of the loop below: the page has no item cap of its own — its size
     *is* the candidate budget — so admitting the allowance without taking the
     excluded row back out would hand back one row more than was asked for on
     every page that does not contain it. Slicing after the filter is what keeps
     both promises: never short because of the exclusion, never long because of
     the allowance. */
  const admissible =
    excludedId === undefined
      ? source.candidates
      : source.candidates.filter(candidate => candidate.sessionId !== excludedId)
  const candidates = admissible.slice(0, candidateLimit)
  /* A candidate the slice dropped is unscanned work, exactly as `source.hasMore`
     is: the continuation has to know about it or the row is lost. */
  const droppedAdmissibleCandidate = admissible.length > candidates.length
  const items: SessionListItem[] = []
  let scannedThroughOrderKey = decoded?.scannedThroughOrderKey
  let stoppedBeforeCandidate = false
  const pageSupport = addSessionListReadCost(
    {
      ranges: args.identity.principal.kind === 'human' ? 1 : 0,
      documents: membership === null ? 0 : 1,
      bytes: membershipLoad.readBytes,
    },
    addSessionListReadCost(defaultPointerReadCost, source.readCost),
  )
  const pageBudget = new SessionListPageBudget(pageSupport)
  for (const candidate of candidates) {
    // The reservation happens before the canonical get. If it cannot fit, the
    // candidate has not been scanned and the continuation remains before it.
    if (!pageBudget.canReserveCandidate()) {
      stoppedBeforeCandidate = true
      break
    }
    const session = await ctx.db.get(candidate.sessionId)
    const canonicalReadCost: SessionListReadCost = {
      ranges: 1,
      documents: session === null ? 0 : 1,
      bytes: session === null ? 0 : getDocumentSize(session),
    }
    if (
      session === null ||
      session.workspaceId !== args.workspaceId ||
      !session.visible ||
      session.archiveState === 'deleting' ||
      /* The held-out default chat is not tested here any more: it never reaches
         this loop, because it is taken off the candidate list above — which also
         saves the canonical read this branch used to spend on a row it was
         always going to drop. One owner for the rule, and it is the cheaper one. */
      (searchText !== undefined &&
        searchText.length > 0 &&
        !searchText.split(/\s+/).some(term => session.searchText.includes(term)))
    ) {
      scannedThroughOrderKey = candidate.orderKey
      pageBudget.commitCandidate(canonicalReadCost)
      continue
    }
    const support = await loadSessionProjectionSupport(
      ctx,
      session,
      membership === null ? undefined : (membership.membershipId as Id<'workspaceMembers'>),
    )
    const state = support.callerState
    const access = resolvePreloadedSessionAccess({
      identity: args.identity,
      membership,
      session: {
        audience:
          session.audienceKind === 'workspace'
            ? { kind: 'workspace' }
            : {
                kind: 'specific',
                membershipGrant:
                  state?.audienceGranted === true && membership !== null
                    ? { membershipId: membership.membershipId }
                    : null,
              },
        agentState: support.agentState,
      },
    })
    if (!access.ok) {
      scannedThroughOrderKey = candidate.orderKey
      pageBudget.commitCandidate(addSessionListReadCost(canonicalReadCost, support.readCost))
      continue
    }
    if (access.basis !== 'workspace') {
      const personallyArchived = state?.personalArchivedAt !== undefined
      const archiveMatches =
        archiveState === 'active'
          ? session.archiveState === 'active' && !personallyArchived
          : session.archiveState === 'archived' ||
            (session.archiveState === 'active' && personallyArchived)
      if (!archiveMatches) {
        scannedThroughOrderKey = candidate.orderKey
        pageBudget.commitCandidate(addSessionListReadCost(canonicalReadCost, support.readCost))
        continue
      }
    }
    const unreadSupport =
      membership === null
        ? { unread: false, readCost: { ranges: 0, documents: 0, bytes: 0 } }
        : await unreadForSessionAtFloorWithReadBytes(
            ctx,
            args.workspaceId,
            args.actorId!,
            membership.joinedAt!,
            session,
          )
    const projected = projectSessionListItemFromSupport(
      session,
      { access, unread: unreadSupport.unread },
      support,
    )
    // Weighed once, here: the budget carries the page's running total, and its
    // envelope already allows for the continuation cursor minted after the loop.
    pageBudget.commitCandidate(
      addSessionListReadCost(
        canonicalReadCost,
        addSessionListReadCost(support.readCost, unreadSupport.readCost),
      ),
      serializedSessionPageBytes(projected),
    )
    items.push(projected)
    scannedThroughOrderKey = candidate.orderKey
  }
  const needsContinuation = stoppedBeforeCandidate || source.hasMore || droppedAdmissibleCandidate
  const result = {
    items,
    nextCursor:
      needsContinuation && scannedThroughOrderKey !== undefined
        ? await cursorCodec.encode({
            subject,
            filters,
            order: 'updatedAt-desc-sessionId-desc',
            position: { scannedThroughOrderKey },
          })
        : null,
  }
  args.onBudgetSnapshot?.(pageBudget.snapshot())
  return result
}

/** Shared with `activity.ts`, which asks the same question of the same args. */
export async function assertReader(
  ctx: QueryCtx,
  args: { workspaceId: Id<'workspaces'>; internalKey?: string; actorId?: Id<'users'> },
): Promise<{
  userId?: Id<'users'>
  membershipId?: Id<'workspaceMembers'>
  role?: WorkspaceRole
}> {
  if (args.internalKey !== undefined) {
    requireApiInternalKey(args.internalKey)
    if (args.actorId !== undefined) {
      return await assertActorRole(ctx, args.workspaceId, args.actorId, 'viewer')
    }
    return {}
  }
  if (args.actorId !== undefined) throw new Error('actorId requires internalKey')
  return await assertRole(ctx, args.workspaceId, 'viewer')
}

function sessionListPageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return COLLECTION_PAGE_DEFAULT_LIMIT
  return Math.min(SESSION_LIST_MAX_LIMIT, Math.max(1, Math.floor(limit)))
}

/**
 * `unread` for exactly one row. A thin wrapper on the batch, because a second
 * implementation of the predicate is a second place for the floor to be wrong.
 */
export async function unreadForSession(
  ctx: QueryCtx,
  workspaceId: Id<'workspaces'>,
  userId: Id<'users'> | undefined,
  session: Doc<'agentSessions'>,
): Promise<boolean> {
  return (await unreadBySession(ctx, workspaceId, userId, [session])).get(session._id) === true
}

function readerMembership(reader: {
  userId?: Id<'users'>
  membershipId?: Id<'workspaceMembers'>
  role?: WorkspaceRole
}) {
  if (
    reader.userId === undefined ||
    reader.membershipId === undefined ||
    reader.role === undefined
  ) {
    return undefined
  }
  return {
    userId: reader.userId,
    membershipId: reader.membershipId,
    role: reader.role,
  }
}
