import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'

import { FILE_ACTIVITY_LIMITS } from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import { internalMutation } from '../../_generated/server'
import type { MutationCtx } from '../../_generated/server'
import { parentEntityAt } from './namespace'

type Phase = 'normal' | 'rename-old' | 'rename-new'
type Cursor = NonNullable<Doc<'fileEventProjectionState'>['cursor']>

export interface ProjectionRunResult {
  completedSeq: number
  projectionOperations: number
  pending: boolean
}

// One final cursor write shares the contract's 64-operation transaction budget
// with ancestry membership and event/phase completion work.
const WORK_PER_CHUNK = FILE_ACTIVITY_LIMITS.maxProjectorOperations - 1

const advanceProjectionRef = makeFunctionReference<'mutation', { workspaceId: Id<'workspaces'> }>(
  'domains/fileActivity/projection:advanceProjection',
)

export const advanceProjection = internalMutation({
  args: { workspaceId: v.id('workspaces') },
  handler: async (ctx, args) => {
    const result = await projectWorkspaceChunk(ctx, args.workspaceId)
    if (result.pending) await ctx.scheduler.runAfter(0, advanceProjectionRef, args)
    return result
  },
})

export async function projectWorkspaceChunk(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
): Promise<ProjectionRunResult> {
  let state = await projectionState(ctx, workspaceId)
  let operations = 0

  while (operations < WORK_PER_CHUNK) {
    if (state.cursor === undefined) {
      const event = await nextEvent(ctx, workspaceId, state.completedSeq)
      if (event === null) {
        const latestSeq = await allocatedSeq(ctx, workspaceId)
        if (latestSeq > state.completedSeq) {
          state = { ...state, completedSeq: latestSeq, oldestPendingAt: undefined }
        }
        await persistState(ctx, state)
        return {
          completedSeq: state.completedSeq,
          projectionOperations: operations,
          pending: false,
        }
      }
      if (event.seq > state.completedSeq + 1) {
        state = { ...state, completedSeq: event.seq - 1 }
      }
      const cursor = await initialCursor(
        ctx,
        event,
        event.kind === 'rename' ? 'rename-old' : 'normal',
      )
      state = { ...state, cursor, oldestPendingAt: state.oldestPendingAt ?? event._creationTime }
    }

    const activeCursor = state.cursor
    if (activeCursor === undefined) throw new Error('projection cursor missing')
    const event = await eventAt(ctx, workspaceId, activeCursor.eventSeq)
    if (event === null) {
      state = { ...state, completedSeq: activeCursor.eventSeq, cursor: undefined }
      continue
    }
    if (activeCursor.currentEntityId === undefined) {
      const next = await nextPhaseCursor(ctx, event, activeCursor.phase)
      operations += 1
      if (next !== null) {
        state = { ...state, cursor: next }
        continue
      }
      state = { ...state, completedSeq: event.seq, cursor: undefined, oldestPendingAt: undefined }
      continue
    }

    await insertMembership(ctx, event, activeCursor.currentEntityId)
    operations += 1
    const parent = await parentAt(ctx, event, activeCursor.currentEntityId, activeCursor.phase)
    if (
      parent === activeCursor.currentEntityId ||
      (parent !== null && activeCursor.remainingAncestors <= 1)
    ) {
      console.error('[file-activity-projection] ancestry limit reached', {
        workspaceId,
        eventSeq: event.seq,
        reason: parent === activeCursor.currentEntityId ? 'cycle' : 'ancestry_limit',
        maxAncestorHops: FILE_ACTIVITY_LIMITS.maxPathSegments,
      })
      state = {
        ...state,
        completedSeq: event.seq,
        cursor: undefined,
        oldestPendingAt: undefined,
        lastSkippedSeq: event.seq,
      }
      continue
    }
    const cursor: Cursor = {
      ...activeCursor,
      currentEntityId: parent ?? undefined,
      remainingAncestors: activeCursor.remainingAncestors - 1,
    }
    state = { ...state, cursor }
  }

  await persistState(ctx, state)
  return { completedSeq: state.completedSeq, projectionOperations: operations, pending: true }
}

async function projectionState(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
): Promise<Doc<'fileEventProjectionState'>> {
  const existing = await ctx.db
    .query('fileEventProjectionState')
    .withIndex('by_workspace', q => q.eq('workspaceId', workspaceId))
    .unique()
  if (existing === null) throw new Error('file activity projection state missing')
  return existing
}

async function persistState(
  ctx: MutationCtx,
  state: Doc<'fileEventProjectionState'>,
): Promise<void> {
  await ctx.db.patch(state._id, {
    completedSeq: state.completedSeq,
    cursor: state.cursor,
    oldestPendingAt: state.oldestPendingAt,
    lastSkippedSeq: state.lastSkippedSeq,
  })
}

async function nextEvent(ctx: MutationCtx, workspaceId: Id<'workspaces'>, completedSeq: number) {
  return await ctx.db
    .query('fileEvents')
    .withIndex('by_workspace_seq', q => q.eq('workspaceId', workspaceId).gt('seq', completedSeq))
    .first()
}

async function eventAt(ctx: MutationCtx, workspaceId: Id<'workspaces'>, seq: number) {
  return await ctx.db
    .query('fileEvents')
    .withIndex('by_workspace_seq', q => q.eq('workspaceId', workspaceId).eq('seq', seq))
    .unique()
}

async function allocatedSeq(ctx: MutationCtx, workspaceId: Id<'workspaces'>): Promise<number> {
  const namespace = await ctx.db
    .query('fileActivityNamespaces')
    .withIndex('by_workspace', q => q.eq('workspaceId', workspaceId))
    .unique()
  return (namespace?.nextSequence ?? 1) - 1
}

async function initialCursor(
  ctx: MutationCtx,
  event: Doc<'fileEvents'>,
  phase: Phase,
): Promise<Cursor> {
  if (event.entityId === undefined) {
    return {
      eventSeq: event.seq,
      phase,
      remainingAncestors: FILE_ACTIVITY_LIMITS.maxPathSegments + 1,
    }
  }
  const entity = await ctx.db.get(event.entityId)
  return {
    eventSeq: event.seq,
    phase,
    remainingAncestors: FILE_ACTIVITY_LIMITS.maxPathSegments + 1,
    currentEntityId:
      entity?.kind === 'folder'
        ? event.entityId
        : ((await parentAt(ctx, event, event.entityId, phase)) ?? undefined),
  }
}

async function nextPhaseCursor(
  ctx: MutationCtx,
  event: Doc<'fileEvents'>,
  phase: Phase,
): Promise<Cursor | null> {
  if (phase !== 'rename-old') return null
  return await initialCursor(ctx, event, 'rename-new')
}

async function parentAt(
  ctx: MutationCtx,
  event: Doc<'fileEvents'>,
  childEntityId: Id<'fileActivityEntities'>,
  phase: Phase,
): Promise<Id<'fileActivityEntities'> | null> {
  return await parentEntityAt(ctx, {
    workspaceId: event.workspaceId,
    childEntityId,
    atSequence: event.seq,
    exclusive: phase === 'rename-old',
  })
}

async function insertMembership(
  ctx: MutationCtx,
  event: Doc<'fileEvents'>,
  scopeEntityId: Id<'fileActivityEntities'>,
): Promise<void> {
  const existing = await ctx.db
    .query('fileEventScopes')
    .withIndex('by_event_scope', q => q.eq('eventId', event._id).eq('scopeEntityId', scopeEntityId))
    .unique()
  if (existing !== null) return
  await ctx.db.insert('fileEventScopes', {
    workspaceId: event.workspaceId,
    scopeEntityId,
    seq: event.seq,
    isRead: event.kind === 'read' || event.kind === 'viewed-summary',
    eventId: event._id,
  })
}
