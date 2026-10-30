import { makeFunctionReference, type FunctionReference } from 'convex/server'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { requireSessionPointFromDb, sessionAccessAllows } from './access'
import { writeDefaultSessionPointer } from './agentSessionsShared'
import { scheduleReadySessionDeletionWork } from './deletionExternal'
import {
  DELETE_DISCOVERY_BATCH,
  deleteSessionDiscovery,
  patchSessionAndReconcileDiscovery,
} from './discovery'
import { admitSessionId, throwSessionError } from './errors'
import { assertSessionIdentityAttribution, type SessionRequestIdentity } from './identity'
import { deleteSessionReadsBatch } from './reads'

export const SESSION_DELETION_CHILD_BATCH = 10
export const DELETE_EVENT_BATCH = 100
const DELETE_RELAY_RECEIPT_BATCH = 100
const DELETE_IMAGE_BATCH = 100
export const DELETE_SESSION_READ_BATCH = 100
export const DELETE_MEMBER_STATE_BATCH = 100

export interface SessionDeletionFrontierEffects {
  scheduleReadyWork(ctx: MutationCtx, workId: Id<'agentSessionDeletionWork'>): Promise<unknown>
}

const productionFrontierEffects: SessionDeletionFrontierEffects = {
  scheduleReadyWork: scheduleReadySessionDeletionWork,
}

export async function beginSessionSubtreeDeletionImpl(
  ctx: MutationCtx,
  args: {
    internalKey: string
    workspaceId: Id<'workspaces'>
    sessionId: string
    actorId: Id<'users'>
    identity: SessionRequestIdentity
    now?: number
  },
  effects: SessionDeletionFrontierEffects = productionFrontierEffects,
) {
  requireApiInternalKey(args.internalKey)
  assertSessionIdentityAttribution(args.identity, args.actorId)
  const sessionId = admitSessionId(ctx, args.sessionId)
  const existing = await ctx.db
    .query('agentSessionDeletionWork')
    .withIndex('by_session', q => q.eq('sessionId', sessionId))
    .unique()
  // A claimed session is already sealed and so no longer point-readable; a
  // replay must answer from its durable claim, not from admission, to stay
  // idempotent.
  if (existing?.workspaceId === args.workspaceId) return { accepted: true as const }
  const admitted = await requireSessionPointFromDb(ctx, args)
  if (!sessionAccessAllows(admitted.access, 'global-lifecycle')) throwSessionError('forbidden')
  await beginOrResumeSessionSubtreeDeletion(
    ctx,
    {
      workspaceId: args.workspaceId,
      sessionId: admitted.session._id,
      rootSessionId: admitted.session._id,
      now: args.now ?? Date.now(),
    },
    effects,
  )
  return { accepted: true as const }
}

export async function beginOrResumeSessionSubtreeDeletion(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    sessionId: Id<'agentSessions'>
    rootSessionId: Id<'agentSessions'>
    now: number
  },
  effects: SessionDeletionFrontierEffects = productionFrontierEffects,
) {
  const session = await ctx.db.get(args.sessionId)
  if (session === null || session.workspaceId !== args.workspaceId) return null
  await sealSession(ctx, session, args.now)
  const workId = await ensureDeletionWork(ctx, session, args.rootSessionId, args.now)
  await advanceSessionDeletionFrontierImpl(ctx, { workId, now: args.now }, effects)
  return workId
}

export async function advanceSessionDeletionFrontierImpl(
  ctx: MutationCtx,
  args: { workId: Id<'agentSessionDeletionWork'>; now?: number },
  effects: SessionDeletionFrontierEffects = productionFrontierEffects,
): Promise<{ status: 'pending' | 'scan_complete' | 'stale' }> {
  const work = await ctx.db.get(args.workId)
  if (work === null) return { status: 'stale' }
  if (work.childScanComplete) return { status: 'scan_complete' }
  const session = await ctx.db.get(work.sessionId)
  if (session === null || session.workspaceId !== work.workspaceId) return { status: 'stale' }

  const page = await ctx.db
    .query('agentSessions')
    .withIndex('by_workspace_parent', q =>
      q.eq('workspaceId', work.workspaceId).eq('createdBySessionId', work.sessionId),
    )
    .paginate({ cursor: work.childScanCursor ?? null, numItems: SESSION_DELETION_CHILD_BATCH })
  const now = args.now ?? Date.now()
  for (const child of page.page) {
    await sealSession(ctx, child, now)
    const childWorkId = await ensureDeletionWork(ctx, child, work.rootSessionId, now)
    await scheduleAdvance(ctx, childWorkId)
  }
  await ctx.db.patch(work._id, {
    childScanComplete: page.isDone,
    childScanCursor: page.isDone ? undefined : page.continueCursor,
    updatedAt: now,
  })
  if (page.isDone) await effects.scheduleReadyWork(ctx, work._id)
  else await scheduleAdvance(ctx, work._id)
  return { status: page.isDone ? 'scan_complete' : 'pending' }
}

export async function deleteSessionBatchImpl(
  ctx: MutationCtx,
  args: { workId: Id<'agentSessionDeletionWork'> },
) {
  const work = await ctx.db.get(args.workId)
  if (work === null) return { done: true }
  if (!work.childScanComplete || work.externalState !== 'complete') return { done: false }
  const session = await ctx.db.get(work.sessionId)
  if (session === null || session.workspaceId !== work.workspaceId) return { done: false }

  const events = await ctx.db
    .query('agentSessionEvents')
    .withIndex('by_session_seq', q => q.eq('sessionId', session._id))
    .order('asc')
    .take(DELETE_EVENT_BATCH)
  for (const event of events) await ctx.db.delete(event._id)
  if (events.length === DELETE_EVENT_BATCH) return await continuePhysicalCleanup(ctx, work._id)

  const relayReceipts = await ctx.db
    .query('agentSessionRelayReceipts')
    .withIndex('by_session_relay', q => q.eq('sessionId', session._id))
    .take(DELETE_RELAY_RECEIPT_BATCH)
  for (const receipt of relayReceipts) await ctx.db.delete(receipt._id)
  if (relayReceipts.length === DELETE_RELAY_RECEIPT_BATCH)
    return await continuePhysicalCleanup(ctx, work._id)

  const images = await ctx.db
    .query('agentSessionImages')
    .withIndex('by_session_storage', q => q.eq('sessionId', session._id))
    .take(DELETE_IMAGE_BATCH)
  for (const image of images) {
    await ctx.storage.delete(image.storageId)
    await ctx.db.delete(image._id)
  }
  if (images.length === DELETE_IMAGE_BATCH) return await continuePhysicalCleanup(ctx, work._id)

  /* One cursor per member per session can exceed a page. These rows otherwise
     outlive their canonical session without any product path that can find or
     repair them. */
  const reads = await deleteSessionReadsBatch(ctx, session._id, DELETE_SESSION_READ_BATCH)
  if (reads === DELETE_SESSION_READ_BATCH) return await continuePhysicalCleanup(ctx, work._id)

  const memberStates = await ctx.db
    .query('agentSessionMemberStates')
    .withIndex('by_session_membership', q => q.eq('sessionId', session._id))
    .take(DELETE_MEMBER_STATE_BATCH)
  for (const state of memberStates) await ctx.db.delete(state._id)
  if (memberStates.length === DELETE_MEMBER_STATE_BATCH)
    return await continuePhysicalCleanup(ctx, work._id)

  const toolRouterConfig = await ctx.db
    .query('composioToolRouterSessions')
    .withIndex('by_duet_session', q => q.eq('duetSessionId', session._id))
    .unique()
  if (toolRouterConfig !== null) await ctx.db.delete(toolRouterConfig._id)
  const deletedDiscoveryRows = await deleteSessionDiscovery(ctx, session._id)
  if (deletedDiscoveryRows === DELETE_DISCOVERY_BATCH)
    return await continuePhysicalCleanup(ctx, work._id)

  await ctx.db.delete(session._id)
  await ctx.db.delete(work._id)
  return { done: true }
}

async function continuePhysicalCleanup(ctx: MutationCtx, workId: Id<'agentSessionDeletionWork'>) {
  await ctx.scheduler.runAfter(
    0,
    makeFunctionReference(
      'domains/agentSessions/model:deleteSessionBatch',
    ) as FunctionReference<'mutation'>,
    { workId },
  )
  return { done: false }
}

async function ensureDeletionWork(
  ctx: MutationCtx,
  session: Doc<'agentSessions'>,
  rootSessionId: Id<'agentSessions'>,
  now: number,
) {
  const existing = await ctx.db
    .query('agentSessionDeletionWork')
    .withIndex('by_session', q => q.eq('sessionId', session._id))
    .unique()
  if (existing !== null) return existing._id
  const provider = await ctx.db
    .query('composioToolRouterSessions')
    .withIndex('by_duet_session', q => q.eq('duetSessionId', session._id))
    .unique()
  return await ctx.db.insert('agentSessionDeletionWork', {
    workspaceId: session.workspaceId,
    sessionId: session._id,
    rootSessionId,
    childScanComplete: false,
    ...(provider?.providerSessionId === undefined
      ? {}
      : { providerSessionId: provider.providerSessionId }),
    externalState: 'pending',
    createdAt: now,
    updatedAt: now,
  })
}

async function sealSession(ctx: MutationCtx, session: Doc<'agentSessions'>, now: number) {
  if (session.archiveState !== 'deleting') {
    await patchSessionAndReconcileDiscovery(ctx, session, {
      archiveState: 'deleting',
      visible: false,
      updatedAt: now,
    })
  }
  const workspace = await ctx.db.get(session.workspaceId)
  if (workspace?.rootDefaultSessionId === session._id) {
    await writeDefaultSessionPointer(ctx, session.workspaceId, { kind: 'root' }, undefined)
  }
  if (session.agentId === undefined) return
  const agent = await ctx.db.get(session.agentId)
  if (agent?.defaultSessionId === session._id) {
    await writeDefaultSessionPointer(
      ctx,
      session.workspaceId,
      { kind: 'agent', agentId: agent._id },
      undefined,
    )
  }
}

async function scheduleAdvance(ctx: MutationCtx, workId: Id<'agentSessionDeletionWork'>) {
  await ctx.scheduler.runAfter(
    0,
    makeFunctionReference(
      'domains/agentSessions/model:advanceSessionDeletionFrontier',
    ) as FunctionReference<'mutation'>,
    { workId },
  )
}
