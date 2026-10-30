import { v } from 'convex/values'

import { mutation } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { ensureWorkspaceShareDirectoryEntry } from '../shares/directory'

const tableValidator = v.union(
  v.literal('apiKeys'),
  v.literal('oauthGrants'),
  v.literal('creditTransactions'),
  v.literal('workspaceInvites'),
  v.literal('shares'),
)

export const backfill = mutation({
  args: {
    internalKey: v.string(),
    table: tableValidator,
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const paginationOpts = { cursor: args.cursor, numItems: 100 }
    if (args.table === 'apiKeys') {
      const result = await ctx.db.query('apiKeys').order('asc').paginate(paginationOpts)
      let patched = 0
      for (const row of result.page) {
        if (row.paginationCreatedAt === row._creationTime && row.paginationId === row._id) continue
        await ctx.db.patch(row._id, {
          paginationCreatedAt: row._creationTime,
          paginationId: row._id,
        })
        patched += 1
      }
      return pageResult(result, patched)
    }
    if (args.table === 'oauthGrants') {
      const result = await ctx.db.query('oauthGrants').order('asc').paginate(paginationOpts)
      let patched = 0
      for (const row of result.page) {
        if (row.paginationId === row._id) continue
        await ctx.db.patch(row._id, { paginationId: row._id })
        patched += 1
      }
      return pageResult(result, patched)
    }
    if (args.table === 'creditTransactions') {
      const result = await ctx.db.query('creditTransactions').order('asc').paginate(paginationOpts)
      let patched = 0
      for (const row of result.page) {
        if (row.paginationId === row._id) continue
        await ctx.db.patch(row._id, { paginationId: row._id })
        patched += 1
      }
      return pageResult(result, patched)
    }
    if (args.table === 'shares') {
      const result = await ctx.db.query('shares').order('asc').paginate(paginationOpts)
      let patched = 0
      let directoryEntriesCreated = 0
      for (const row of result.page) {
        if (row.paginationId !== row._id) {
          await ctx.db.patch(row._id, { paginationId: row._id })
          patched += 1
        }
        if (
          await ensureWorkspaceShareDirectoryEntry(ctx, {
            workspaceId: row.fromWorkspaceId,
            shareId: row._id,
            direction: 'outgoing',
            createdAt: row.createdAt,
          })
        ) {
          directoryEntriesCreated += 1
        }
        if (row.toWorkspaceId !== undefined) {
          if (
            await ensureWorkspaceShareDirectoryEntry(ctx, {
              workspaceId: row.toWorkspaceId,
              shareId: row._id,
              direction: 'incoming',
              createdAt: row.createdAt,
            })
          ) {
            directoryEntriesCreated += 1
          }
        }
      }
      return { ...pageResult(result, patched), directoryEntriesCreated }
    }
    const result = await ctx.db.query('workspaceInvites').order('asc').paginate(paginationOpts)
    let patched = 0
    for (const row of result.page) {
      if (row.paginationId === row._id) continue
      await ctx.db.patch(row._id, { paginationId: row._id })
      patched += 1
    }
    return pageResult(result, patched)
  },
})

function pageResult(
  result: { continueCursor: string; isDone: boolean; page: unknown[] },
  patched: number,
) {
  return {
    continueCursor: result.continueCursor,
    isDone: result.isDone,
    visited: result.page.length,
    patched,
  }
}
