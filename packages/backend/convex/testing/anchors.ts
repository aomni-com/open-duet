import { v } from 'convex/values'

import type { Id } from '../_generated/dataModel'
import { mutation, query } from '../_generated/server'
import {
  anchorKindValidator,
  anchorSettingsValidator,
  createAnchorWithCtx,
  getOrCreateAnchorForPath,
  projectVmTopologyImpl,
  reconcileSharedResourceAnchorChange,
  requireAnchor,
  toAnchor,
} from '../domains/anchors/model'
import { requireApiInternalKey } from '../domains/apiKeys/model'
import { writeAuditEvent } from '../domains/audit/model'
import { assertRole } from '../domains/workspaces/authorization'

export const createAnchorForTest = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    path: v.string(),
    kind: anchorKindValidator,
    settings: anchorSettingsValidator,
    now: v.optional(v.number()),
    // Fixtures modelling a tombstone — the anchor a reaped folder or a
    // deleted consumer leaves behind — create it and immediately orphan it.
    state: v.optional(v.literal('orphaned')),
  },
  handler: async (ctx, args) => {
    const { userId } = await assertRole(ctx, args.workspaceId, 'editor')
    const anchor = await createAnchorWithCtx(ctx, {
      workspaceId: args.workspaceId,
      path: args.path,
      kind: args.kind,
      settings: args.settings,
      actorId: userId,
      now: args.now,
    })
    if (args.state === 'orphaned') {
      await ctx.db.patch(anchor.id as Id<'anchors'>, { state: 'orphaned' })
    }
    return anchor
  },
})

export const rawAnchorsForTest = query({
  args: { internalKey: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db.query('anchors').collect()
  },
})

export const seedAnchorStatesForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    active: v.number(),
    broken: v.number(),
    orphaned: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const ids: Id<'anchors'>[] = []
    for (const [state, count] of [
      ['active', args.active],
      ['broken', args.broken],
      ['orphaned', args.orphaned],
    ] as const) {
      for (let index = 0; index < count; index += 1) {
        ids.push(
          await ctx.db.insert('anchors', {
            workspaceId: args.workspaceId,
            path: `${state}/${String(index).padStart(4, '0')}`,
            kind: 'app',
            settings: {},
            state,
            markerNonce: `${state}-${index}`,
            createdAt: index,
            updatedAt: index,
          }),
        )
      }
    }
    return ids
  },
})

export const reviveAnchorForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    path: v.string(),
    actorId: v.id('users'),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await getOrCreateAnchorForPath(ctx, {
      workspaceId: args.workspaceId,
      path: args.path,
      kind: 'app',
      settings: {},
      actorId: args.actorId,
      now: args.now,
      kindConflictError: 'kind conflict',
    })
  },
})

export const gatewayAnchorsForTest = query({
  args: { internalKey: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace?.vmTokenHash === undefined) throw new Error('workspace VM token missing')
    return (
      await projectVmTopologyImpl(ctx, {
        internalKey: args.internalKey,
        vmTokenHash: workspace.vmTokenHash,
      })
    ).anchors
  },
})

export const gatewayTopologyForTest = query({
  args: { internalKey: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace?.vmTokenHash === undefined) throw new Error('workspace VM token missing')
    return await projectVmTopologyImpl(ctx, {
      internalKey: args.internalKey,
      vmTokenHash: workspace.vmTokenHash,
    })
  },
})

export const forceBrokenForTest = mutation({
  args: { internalKey: v.string(), anchorId: v.id('anchors') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.patch(args.anchorId, { state: 'broken' })
  },
})

/**
 * Force an anchor into `broken` for a test that needs one.
 *
 * Test-only on purpose. Nothing in the product breaks an anchor by hand — the
 * anchor rail decides that from what the drive reports — so this stayed a real
 * editor-authenticated mutation for years with test fixtures as its only
 * callers. A production surface no caller reaches is a surface that can drift.
 */
export const markAnchorBrokenForTest = mutation({
  args: {
    anchorId: v.id('anchors'),
    reason: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const anchor = await requireAnchor(ctx, args.anchorId)
    const { userId } = await assertRole(ctx, anchor.workspaceId, 'editor')
    const now = args.now ?? Date.now()
    await ctx.db.patch(args.anchorId, { state: 'broken', updatedAt: now })
    await writeAuditEvent(ctx, {
      workspaceId: anchor.workspaceId,
      event: 'anchor.broken',
      actorId: userId,
      at: now,
      provenance: {
        anchorId: args.anchorId,
        path: anchor.path,
        kind: anchor.kind,
        reason: args.reason,
      },
    })
    const fanout = await reconcileSharedResourceAnchorChange(ctx, anchor, 'broken', now)
    if (fanout.deletedReplica) {
      return { ...toAnchor(anchor), state: 'broken' as const, updatedAt: now, ...fanout }
    }
    return { ...toAnchor(await requireAnchor(ctx, args.anchorId)), ...fanout }
  },
})
