import { v } from 'convex/values'

import {
  LATEST_WRITERS_MAX_PATHS,
  normalizeDrivePath,
  type FileFeedEvent,
  type SeenByEntry,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import { query } from '../../_generated/server'
import type { QueryCtx } from '../../_generated/server'
import { liveWorkspaceBySlug, requireApiInternalKey } from '../apiKeys/model'
import { assertActorRole, assertRole } from '../workspaces/authorization'
import { resolveFileActorUsers } from './actors'
import { resolveNamespaceChildren, resolveNamespacePath } from './namespace'

const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 100
// Bounded fan-out: seen-by rows per file. The directory-batch cap is the
// contract's LATEST_WRITERS_MAX_PATHS — one owner for what clients may send.
const MAX_ACCESS_ROWS = 500

type ConvexPage<Item> = { page: Item[]; continueCursor: string; isDone: boolean }

// Reader auth follows the agentSessions precedent: a signed-in member, or the
// API server (internalKey) optionally acting for a member (actorId).
const readerArgs = {
  workspaceSlug: v.string(),
  internalKey: v.optional(v.string()),
  actorId: v.optional(v.id('users')),
}

// Per-file history newest-first. Includes the workspace's restore events for
// any path (a restore can change every file), and read markers by default —
// a file's history is about attention (docs-first review, slice 06).
export const fileHistory = query({
  args: {
    ...readerArgs,
    path: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    includeReads: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<ConvexPage<FileFeedEvent>> => {
    const workspaceId = await requireWorkspaceReader(ctx, args)
    return (
      await readExactHistoryPage(ctx, {
        workspaceId,
        path: requireDrivePath(args.path),
        cursor: args.cursor,
        limit: pageLimit(args.limit),
        includeReads: args.includeReads ?? true,
      })
    ).response
  },
})

export async function readExactHistoryPage(
  ctx: QueryCtx,
  args: {
    workspaceId: Id<'workspaces'>
    path: string
    cursor?: string
    limit: number
    includeReads: boolean
  },
): Promise<{ response: ConvexPage<FileFeedEvent>; indexedReads: number }> {
  const beforeSeq = requireBeforeSeq(args.cursor)
  const resolution = await resolveNamespacePath(ctx.db, args.workspaceId, args.path, 'selectable')
  if (resolution === null) return { response: emptyPage(), indexedReads: 1 }
  const entityRows = await pageForEntity(ctx, {
    workspaceId: args.workspaceId,
    entityId: resolution.entityId,
    beforeSeq,
    count: args.limit + 1,
    includeReads: args.includeReads,
  })
  const restoreRows = await pageForRestores(ctx, args.workspaceId, beforeSeq, args.limit + 1)
  const merged = [...entityRows, ...restoreRows].sort((a, b) => b.seq - a.seq)
  return {
    response: await pageResponse(ctx, merged, args.limit),
    indexedReads: resolution.bindingReads + 3,
  }
}

// Workspace-wide feed in seq order. Read markers are excluded by default —
// a workspace feed is about change (docs-first review, slice 06).
export const workspaceActivity = query({
  args: {
    ...readerArgs,
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    includeReads: v.optional(v.boolean()),
    order: v.optional(v.union(v.literal('asc'), v.literal('desc'))),
    path: v.optional(v.string()),
    scope: v.optional(v.union(v.literal('exact'), v.literal('subtree'))),
  },
  handler: async (ctx, args): Promise<ConvexPage<FileFeedEvent>> => {
    const workspaceId = await requireWorkspaceReader(ctx, args)
    const scopePath = args.path === undefined ? undefined : requireDrivePath(args.path)
    if (args.scope !== undefined && scopePath === undefined) {
      throw new Error('scope requires path')
    }
    const limit = pageLimit(args.limit)
    const cursorSeq = requireAfterSeq(args.cursor)
    if (scopePath !== undefined) {
      const rows = await scopedActivityRows(ctx, {
        workspaceId,
        path: scopePath,
        scope: args.scope ?? 'exact',
        cursorSeq,
        hasCursor: args.cursor !== undefined,
        order: args.order ?? 'desc',
        count: limit + 1,
        includeReads: args.includeReads === true,
      })
      return await pageResponse(ctx, rows, limit)
    }

    const order = args.order ?? 'desc'
    const scan =
      args.includeReads === true
        ? ctx.db.query('fileEvents').withIndex('by_workspace_seq', q => {
            const workspace = q.eq('workspaceId', workspaceId)
            return order === 'desc' && args.cursor !== undefined
              ? workspace.lt('seq', cursorSeq)
              : order === 'asc'
                ? workspace.gt('seq', cursorSeq)
                : workspace
          })
        : ctx.db.query('fileEvents').withIndex('by_workspace_read_seq', q => {
            const workspace = q.eq('workspaceId', workspaceId).eq('isRead', false)
            return order === 'desc' && args.cursor !== undefined
              ? workspace.lt('seq', cursorSeq)
              : order === 'asc'
                ? workspace.gt('seq', cursorSeq)
                : workspace
          })
    return await pageResponse(ctx, await scan.order(order).take(limit + 1), limit)
  },
})

export const projectionStatus = query({
  args: readerArgs,
  handler: async (ctx, args) => {
    const workspaceId = await requireWorkspaceReader(ctx, args)
    const [namespace, state] = await Promise.all([
      ctx.db
        .query('fileActivityNamespaces')
        .withIndex('by_workspace', q => q.eq('workspaceId', workspaceId))
        .unique(),
      ctx.db
        .query('fileEventProjectionState')
        .withIndex('by_workspace', q => q.eq('workspaceId', workspaceId))
        .unique(),
    ])
    const latestSeq = (namespace?.nextSequence ?? 1) - 1
    const completedSeq = state?.completedSeq ?? 0
    return {
      latestSeq,
      completedSeq,
      lag: latestSeq - completedSeq,
      ...(state?.oldestPendingAt === undefined
        ? {}
        : { oldestPendingAgeMs: Math.max(0, Date.now() - state.oldestPendingAt) }),
    }
  },
})

// One row per actor context that touched the file, most recently active first.
export const seenBy = query({
  args: { ...readerArgs, path: v.string(), cursor: v.optional(v.string()), limit: v.number() },
  handler: async (ctx, args): Promise<ConvexPage<SeenByEntry>> => {
    const workspaceId = await requireWorkspaceReader(ctx, args)
    const path = requireDrivePath(args.path)
    const resolution = await resolveNamespacePath(ctx.db, workspaceId, path, 'selectable')
    if (resolution === null) return emptyPage()
    const rows = await ctx.db
      .query('fileAccess')
      .withIndex('by_workspace_entity_seen_by', q =>
        q.eq('workspaceId', workspaceId).eq('entityId', resolution.entityId),
      )
      .order('asc')
      .paginate({ cursor: args.cursor ?? null, numItems: args.limit })
    const users = await resolveFileActorUsers(
      ctx.db,
      rows.page.map(row => row.actorContext),
    )
    return {
      page: rows.page.map(row => ({
        actor: row.actorContext,
        ...(users.get(row.actorContext) === undefined
          ? {}
          : { userId: users.get(row.actorContext) }),
        firstAt: row.firstAt,
        lastAt: row.lastAt,
        ...(row.lastWriteAt === undefined ? {} : { lastWriteAt: row.lastWriteAt }),
        readCount: row.readCount,
        writeCount: row.writeCount,
      })),
      continueCursor: rows.continueCursor,
      isDone: rows.isDone,
    }
  },
})

// Latest writer per directory entry for the SPA list column: a bounded batch
// of exact-path rollup lookups — never an unbounded prefix scan.
export const latestWritersForDir = query({
  args: { ...readerArgs, dirPath: v.string(), paths: v.array(v.string()) },
  handler: async (ctx, args) => {
    const workspaceId = await requireWorkspaceReader(ctx, args)
    if (args.paths.length > LATEST_WRITERS_MAX_PATHS) {
      throw new Error(`Too many paths: max ${LATEST_WRITERS_MAX_PATHS}`)
    }
    const dir = requireDriveDirPath(args.dirPath)
    const directory = await resolveNamespacePath(ctx.db, workspaceId, dir, 'current')
    if (directory === null) return { writers: [] }
    const children = await resolveNamespaceChildren(
      ctx.db,
      workspaceId,
      directory.entityId,
      args.paths,
    )
    const writers: Array<{ path: string; actor: string; lastWriteAt: number }> = []
    for (const name of args.paths) {
      requireDrivePath(dir === '' ? name : `${dir}/${name}`)
      const entityId = children.get(name)
      if (entityId === undefined) continue
      const rows = await ctx.db
        .query('fileAccess')
        .withIndex('by_workspace_entity', q =>
          q.eq('workspaceId', workspaceId).eq('entityId', entityId),
        )
        .take(MAX_ACCESS_ROWS)
      let latest: Doc<'fileAccess'> | null = null
      for (const row of rows) {
        if (row.lastWriteAt === undefined) continue
        if (latest?.lastWriteAt === undefined || row.lastWriteAt > latest.lastWriteAt) latest = row
      }
      if (latest?.lastWriteAt === undefined) continue
      writers.push({
        path: name,
        actor: latest.actorContext,
        lastWriteAt: latest.lastWriteAt,
      })
    }
    const users = await resolveFileActorUsers(
      ctx.db,
      writers.map(writer => writer.actor),
    )
    return {
      writers: writers.map(writer => ({
        ...writer,
        ...(users.get(writer.actor) === undefined ? {} : { userId: users.get(writer.actor) }),
      })),
    }
  },
})

async function requireWorkspaceReader(
  ctx: QueryCtx,
  args: { workspaceSlug: string; internalKey?: string; actorId?: Id<'users'> },
): Promise<Id<'workspaces'>> {
  const workspace = await liveWorkspaceBySlug(ctx, args.workspaceSlug)
  if (workspace === null) throw new Error('Workspace not found')
  if (args.internalKey !== undefined) {
    requireApiInternalKey(args.internalKey)
    if (args.actorId !== undefined) {
      await assertActorRole(ctx, workspace._id, args.actorId, 'viewer')
    }
    return workspace._id
  }
  if (args.actorId !== undefined) throw new Error('actorId requires internalKey')
  await assertRole(ctx, workspace._id, 'viewer')
  return workspace._id
}

async function pageForEntity(
  ctx: QueryCtx,
  args: {
    workspaceId: Id<'workspaces'>
    entityId: Id<'fileActivityEntities'>
    beforeSeq: number | undefined
    count: number
    includeReads: boolean
  },
): Promise<Doc<'fileEvents'>[]> {
  const scan = args.includeReads
    ? ctx.db.query('fileEvents').withIndex('by_workspace_entity_seq', q => {
        const entity = q.eq('workspaceId', args.workspaceId).eq('entityId', args.entityId)
        return args.beforeSeq === undefined ? entity : entity.lt('seq', args.beforeSeq)
      })
    : ctx.db.query('fileEvents').withIndex('by_workspace_entity_read_seq', q => {
        const entity = q
          .eq('workspaceId', args.workspaceId)
          .eq('entityId', args.entityId)
          .eq('isRead', false)
        return args.beforeSeq === undefined ? entity : entity.lt('seq', args.beforeSeq)
      })
  return await scan.order('desc').take(args.count)
}

async function pageForRestores(
  ctx: QueryCtx,
  workspaceId: Id<'workspaces'>,
  beforeSeq: number | undefined,
  count: number,
): Promise<Doc<'fileEvents'>[]> {
  return await ctx.db
    .query('fileEvents')
    .withIndex('by_workspace_kind_seq', q => {
      const restores = q.eq('workspaceId', workspaceId).eq('kind', 'restore')
      return beforeSeq === undefined ? restores : restores.lt('seq', beforeSeq)
    })
    .order('desc')
    .take(count)
}

async function scopedActivityRows(
  ctx: QueryCtx,
  args: {
    workspaceId: Id<'workspaces'>
    path: string
    scope: 'exact' | 'subtree'
    cursorSeq: number
    hasCursor: boolean
    order: 'asc' | 'desc'
    count: number
    includeReads: boolean
  },
): Promise<Doc<'fileEvents'>[]> {
  if (args.scope === 'subtree') {
    const resolution = await resolveNamespacePath(ctx.db, args.workspaceId, args.path, 'selectable')
    if (resolution === null) return []
    const scopeEntity = await ctx.db.get(resolution.entityId)
    if (scopeEntity?.kind !== 'folder') return []
    const state = await ctx.db
      .query('fileEventProjectionState')
      .withIndex('by_workspace', q => q.eq('workspaceId', args.workspaceId))
      .unique()
    if (state === null) return []
    const scopedArgs = {
      ...args,
      scopeEntityId: resolution.entityId,
      completedSeq: state.completedSeq,
    }
    const scopeRows = await pageForScope(ctx, scopedArgs)
    const restoreRows = await pageRestoresForActivity(ctx, scopedArgs)
    const eventRows = (await Promise.all(scopeRows.map(row => ctx.db.get(row.eventId)))).filter(
      (row): row is Doc<'fileEvents'> => row !== null,
    )
    return [...eventRows, ...restoreRows]
      .sort((a, b) => (args.order === 'desc' ? b.seq - a.seq : a.seq - b.seq))
      .slice(0, args.count)
  }
  const resolution = await resolveNamespacePath(ctx.db, args.workspaceId, args.path, 'selectable')
  if (resolution === null) return []
  const scan = args.includeReads
    ? ctx.db.query('fileEvents').withIndex('by_workspace_entity_seq', q => {
        const entity = q.eq('workspaceId', args.workspaceId).eq('entityId', resolution.entityId)
        if (args.order === 'desc') return args.hasCursor ? entity.lt('seq', args.cursorSeq) : entity
        return entity.gt('seq', args.cursorSeq)
      })
    : ctx.db.query('fileEvents').withIndex('by_workspace_entity_read_seq', q => {
        const entity = q
          .eq('workspaceId', args.workspaceId)
          .eq('entityId', resolution.entityId)
          .eq('isRead', false)
        if (args.order === 'desc') return args.hasCursor ? entity.lt('seq', args.cursorSeq) : entity
        return entity.gt('seq', args.cursorSeq)
      })
  const entityRows = await scan.order(args.order).take(args.count)
  const restoreRows = await pageRestoresForActivity(ctx, args)
  return [...entityRows, ...restoreRows]
    .sort((a, b) => (args.order === 'desc' ? b.seq - a.seq : a.seq - b.seq))
    .slice(0, args.count)
}

async function pageForScope(
  ctx: QueryCtx,
  args: {
    workspaceId: Id<'workspaces'>
    scopeEntityId: Id<'fileActivityEntities'>
    completedSeq: number
    cursorSeq: number
    hasCursor: boolean
    order: 'asc' | 'desc'
    count: number
    includeReads: boolean
  },
): Promise<Doc<'fileEventScopes'>[]> {
  const scan = args.includeReads
    ? ctx.db.query('fileEventScopes').withIndex('by_workspace_scope_seq', q => {
        const scope = q.eq('workspaceId', args.workspaceId).eq('scopeEntityId', args.scopeEntityId)
        if (args.order === 'desc') {
          return scope.lt(
            'seq',
            Math.min(
              args.hasCursor ? args.cursorSeq : Number.POSITIVE_INFINITY,
              args.completedSeq + 1,
            ),
          )
        }
        return scope.gt('seq', args.cursorSeq).lte('seq', args.completedSeq)
      })
    : ctx.db.query('fileEventScopes').withIndex('by_workspace_scope_read_seq', q => {
        const scope = q
          .eq('workspaceId', args.workspaceId)
          .eq('scopeEntityId', args.scopeEntityId)
          .eq('isRead', false)
        if (args.order === 'desc') {
          return scope.lt(
            'seq',
            Math.min(
              args.hasCursor ? args.cursorSeq : Number.POSITIVE_INFINITY,
              args.completedSeq + 1,
            ),
          )
        }
        return scope.gt('seq', args.cursorSeq).lte('seq', args.completedSeq)
      })
  return await scan.order(args.order).take(args.count)
}

async function pageRestoresForActivity(
  ctx: QueryCtx,
  args: {
    workspaceId: Id<'workspaces'>
    cursorSeq: number
    hasCursor: boolean
    order: 'asc' | 'desc'
    count: number
    completedSeq?: number
  },
): Promise<Doc<'fileEvents'>[]> {
  return await ctx.db
    .query('fileEvents')
    .withIndex('by_workspace_kind_seq', q => {
      const restores = q.eq('workspaceId', args.workspaceId).eq('kind', 'restore')
      if (args.order === 'desc') {
        return restores.lt(
          'seq',
          Math.min(
            args.hasCursor ? args.cursorSeq : Number.POSITIVE_INFINITY,
            args.completedSeq === undefined ? Number.POSITIVE_INFINITY : args.completedSeq + 1,
          ),
        )
      }
      const after = restores.gt('seq', args.cursorSeq)
      return args.completedSeq === undefined ? after : after.lte('seq', args.completedSeq)
    })
    .order(args.order)
    .take(args.count)
}

// Both scans feeding a page fetch limit + 1 rows, so overflow past `limit`
// proves more events exist and pins nextCursor to the last returned seq.
async function pageResponse(
  ctx: QueryCtx,
  rows: Doc<'fileEvents'>[],
  limit: number,
): Promise<ConvexPage<FileFeedEvent>> {
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  const users = await resolveFileActorUsers(
    ctx.db,
    page.map(row => row.actorContext),
  )
  return {
    page: page.map(row => ({
      seq: row.seq,
      event: wireEvent(row, users.get(row.actorContext)),
    })),
    continueCursor: last === undefined ? '' : String(last.seq),
    isDone: rows.length <= limit,
  }
}

function wireEvent(row: Doc<'fileEvents'>, userId: string | undefined): FileFeedEvent['event'] {
  return {
    kind: row.kind,
    ...(row.path === undefined ? {} : { path: row.path }),
    ...(row.fromPath === undefined ? {} : { fromPath: row.fromPath }),
    ...(row.entryKind === undefined ? {} : { entryKind: row.entryKind }),
    ...(row.count === undefined ? {} : { count: row.count }),
    actor: row.actorContext,
    ...(userId === undefined ? {} : { userId }),
    at: row.at,
  } as FileFeedEvent['event']
}

function requireDrivePath(raw: string): string {
  const result = normalizeDrivePath(raw)
  if (!result.ok || result.relativePath !== raw) throw new Error(`Invalid path: ${raw}`)
  return raw
}

function requireDriveDirPath(raw: string): string {
  const result = normalizeDrivePath(raw, { allowRoot: true })
  if (!result.ok || result.relativePath !== raw) throw new Error(`Invalid path: ${raw}`)
  return raw
}

function requireAfterSeq(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  const seq = parseInternalSequence(cursor)
  return seq
}

function requireBeforeSeq(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return undefined
  const seq = parseInternalSequence(cursor)
  return seq
}

function parseInternalSequence(cursor: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(cursor)) throw new Error(`Invalid cursor: ${cursor}`)
  const seq = Number(cursor)
  if (!Number.isSafeInteger(seq)) throw new Error(`Invalid cursor: ${cursor}`)
  return seq
}

function emptyPage<Item>(): ConvexPage<Item> {
  return { page: [], continueCursor: '', isDone: true }
}

function pageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT
  return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(limit)))
}
