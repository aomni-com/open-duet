import { getFunctionName } from 'convex/server'
import { v } from 'convex/values'

import { mutation, query } from '../_generated/server'
import { requireApiInternalKey } from '../domains/apiKeys/model'
import { recordBatch } from '../domains/fileActivity/model'
import { resolveNamespacePath } from '../domains/fileActivity/namespace'
import { projectWorkspaceChunk } from '../domains/fileActivity/projection'
import { readExactHistoryPage } from '../domains/fileActivity/queries'

export const rawFileEventsForTest = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('fileEvents')
      .withIndex('by_workspace_seq', q => q.eq('workspaceId', args.workspaceId))
      .collect()
  },
})

// Stamps `bucketStart` onto an existing change row — the state slice 01 will
// produce for real, reachable here before it does. It exists so the L-A
// invariant (a change row must never satisfy the read-marker lookup) can be
// pinned by a test that fails on an un-discriminated index.
export const stampChangeBucketForTest = mutation({
  args: {
    internalKey: v.string(),
    eventId: v.id('fileEvents'),
    bucketStart: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.patch(args.eventId, { bucketStart: args.bucketStart })
  },
})

export const rawFileAccessForTest = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('fileAccess')
      .withIndex('by_workspace_entity', q => q.eq('workspaceId', args.workspaceId))
      .collect()
  },
})

export const rawFileEventBatchesForTest = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('fileEventBatches')
      .withIndex('by_workspace_batch', q => q.eq('workspaceId', args.workspaceId))
      .collect()
  },
})

export const recordBatchWithProjectionDiagnosticsForTest = mutation({
  args: {
    pauseProjection: v.optional(v.boolean()),
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    batch: v.any(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    let projectionWakeups = 0
    const result = await recordBatch(
      {
        ...ctx,
        scheduler: {
          ...ctx.scheduler,
          runAfter: async (delay, reference, ...scheduledArgs) => {
            const id = await ctx.scheduler.runAfter(delay, reference, ...scheduledArgs)
            if (
              getFunctionName(reference) === 'domains/fileActivity/projection:advanceProjection'
            ) {
              projectionWakeups += 1
              // Cancel in the recording transaction so pending-state fixtures cannot
              // race the zero-delay projector before their first query.
              if (args.pauseProjection) await ctx.scheduler.cancel(id)
            }
            return id
          },
        },
      },
      args,
    )
    return { ...result, projectionWakeups }
  },
})

export const rawFileActivityNamespaceForTest = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('fileActivityNamespaces')
      .withIndex('by_workspace', q => q.eq('workspaceId', args.workspaceId))
      .unique()
  },
})

export const rawFileActivityBindingsForTest = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    entityId: v.id('fileActivityEntities'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const entity = await ctx.db.get(args.entityId)
    if (entity === null || entity.workspaceId !== args.workspaceId) return []
    return await ctx.db
      .query('fileActivityBindings')
      .withIndex('by_child_start', q =>
        q
          .eq('workspaceId', args.workspaceId)
          .eq('epoch', entity.epoch)
          .eq('childEntityId', args.entityId),
      )
      .collect()
  },
})

export const exactHistoryOperationsForTest = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    path: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const result = await readExactHistoryPage(ctx, {
      workspaceId: args.workspaceId,
      path: args.path,
      limit: args.limit,
      includeReads: true,
    })
    return { indexedReads: result.indexedReads, response: result.response }
  },
})

export const seedIndexedRunForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    path: v.string(),
    startSeq: v.number(),
    count: v.number(),
    kind: v.union(v.literal('read'), v.literal('restore')),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    if (!Number.isInteger(args.count) || args.count < 0 || args.count > 7_000) {
      throw new Error('invalid test run count')
    }
    const resolution =
      args.kind === 'read'
        ? await resolveNamespacePath(ctx.db, args.workspaceId, args.path, 'current')
        : null
    if (args.kind === 'read' && resolution === null) throw new Error('test path missing')
    for (let index = 0; index < args.count; index += 1) {
      const seq = args.startSeq + index
      await ctx.db.insert('fileEvents', {
        workspaceId: args.workspaceId,
        seq,
        kind: args.kind,
        ...(args.kind === 'read'
          ? { path: args.path, entityId: resolution!.entityId, bucketStart: seq }
          : {}),
        actorContext: 'terminal',
        at: seq,
        isRead: args.kind === 'read',
      })
    }
  },
})

export const projectWorkspaceChunkForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await projectWorkspaceChunk(ctx, args.workspaceId)
  },
})

export const resetAndProjectWorkspaceChunkForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    completedSeq: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const scopes = await ctx.db
      .query('fileEventScopes')
      .withIndex('by_workspace_scope_seq', q => q.eq('workspaceId', args.workspaceId))
      .collect()
    for (const scope of scopes) await ctx.db.delete(scope._id)
    const state = await ctx.db
      .query('fileEventProjectionState')
      .withIndex('by_workspace', q => q.eq('workspaceId', args.workspaceId))
      .unique()
    if (state === null) throw new Error('projection state missing')
    await ctx.db.patch(state._id, {
      completedSeq: args.completedSeq ?? 0,
      cursor: undefined,
      oldestPendingAt: undefined,
      lastSkippedSeq: undefined,
    })
    const result = await projectWorkspaceChunk(ctx, args.workspaceId)
    const projected = await ctx.db
      .query('fileEventScopes')
      .withIndex('by_workspace_scope_seq', q => q.eq('workspaceId', args.workspaceId))
      .collect()
    return {
      ...result,
      physicalMemberships: projected.length,
      visibleMemberships: projected.filter(row => row.seq <= result.completedSeq).length,
    }
  },
})

export const rawProjectionForTest = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const state = await ctx.db
      .query('fileEventProjectionState')
      .withIndex('by_workspace', q => q.eq('workspaceId', args.workspaceId))
      .unique()
    const scopes = await ctx.db
      .query('fileEventScopes')
      .withIndex('by_workspace_scope_seq', q => q.eq('workspaceId', args.workspaceId))
      .collect()
    return { state, scopes }
  },
})
