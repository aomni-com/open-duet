import {
  FileActivityFeedQuerySchema,
  FileEventsStreamQuerySchema,
  FileHistoryQuerySchema,
  FileHistoryResponseSchema,
  FileSeenByQuerySchema,
  LatestWritersQuerySchema,
  LatestWritersResponseSchema,
  SeenByResponseSchema,
  isCollectionCursorError,
  type FileFeedEvent,
  type FileHistoryResponse,
} from '@repo/contract'

import { createConvexCollectionPage } from '../collection-page'
import { fnQuery, requireAuthedWorkspace, type ApiApp, type ApiRouteRuntime } from '../shared'

// Stream knobs (tweakable; semantics are not). The poll sits well inside the
// gateway pipeline's flush cadence; the keepalive comment keeps intermediaries
// from dropping a quiet connection. Tests inject small values.
const STREAM_POLL_MS = 1_500
const STREAM_KEEPALIVE_MS = 20_000
// Convex page size per poll read — the contract max, so a resume drains a
// long backlog in few round trips.
const STREAM_PAGE_LIMIT = 100
const activityPages = createConvexCollectionPage('file-activity.workspace-sequence')
const seenByPages = createConvexCollectionPage('file-activity.seen-by')

export interface FileEventStreamOptions {
  pollMs?: number
  keepaliveMs?: number
}

// Sole owner of the file-activity HTTP surface (slice 06 + the slice-17 SSE
// feed). Activity-neutral by construction (README sleep-transparency
// firewall): these routes read Convex only — no gateway client is in scope,
// so observing attribution can never create attribution or keep a workspace
// alive.
export function registerFileActivityRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  streamOptions: FileEventStreamOptions = {},
): void {
  const pollMs = streamOptions.pollMs ?? STREAM_POLL_MS
  const keepaliveMs = streamOptions.keepaliveMs ?? STREAM_KEEPALIVE_MS

  app.get('/v1/ws/:workspaceSlug/file-activity', async c => {
    const workspace = requireAuthedWorkspace(c, 'files:read')
    if ('response' in workspace) return workspace.response
    const query = FileHistoryQuerySchema.safeParse(queryParams(c.req.url))
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const binding = activityBinding(workspace.id)
    try {
      const pagination = await activityPages.paginationOpts(query.data, binding)
      const result = await runtime.convex.query(
        fnQuery('domains/fileActivity/queries:fileHistory'),
        {
          internalKey: runtime.internalKey,
          actorId: c.get('auth').user.id,
          workspaceSlug: workspace.slug,
          path: query.data.path,
          ...(pagination.cursor === null ? {} : { cursor: pagination.cursor }),
          limit: pagination.numItems,
          // A file's history is about attention: reads are in unless reads=0.
          includeReads: query.data.reads !== '0',
        },
      )
      return c.json(FileHistoryResponseSchema.parse(await activityPages.response(result, binding)))
    } catch (error) {
      if (isCollectionCursorError(error)) {
        return c.json({ error: 'invalid_cursor' }, 400)
      }
      throw error
    }
  })

  app.get('/v1/ws/:workspaceSlug/file-activity/seen-by', async c => {
    const workspace = requireAuthedWorkspace(c, 'files:read')
    if ('response' in workspace) return workspace.response
    const query = FileSeenByQuerySchema.safeParse(queryParams(c.req.url))
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const binding = seenByBinding(workspace.id, query.data.path)
    try {
      const pagination = await seenByPages.paginationOpts(query.data, binding)
      const result = await runtime.convex.query(fnQuery('domains/fileActivity/queries:seenBy'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceSlug: workspace.slug,
        path: query.data.path,
        ...(pagination.cursor === null ? {} : { cursor: pagination.cursor }),
        limit: pagination.numItems,
      })
      return c.json(SeenByResponseSchema.parse(await seenByPages.response(result, binding)))
    } catch (error) {
      if (isCollectionCursorError(error)) {
        return c.json({ error: 'invalid_cursor' }, 400)
      }
      throw error
    }
  })

  app.get('/v1/ws/:workspaceSlug/file-activity/latest-writers', async c => {
    const workspace = requireAuthedWorkspace(c, 'files:read')
    if ('response' in workspace) return workspace.response
    const url = new URL(c.req.url)
    const query = LatestWritersQuerySchema.safeParse({
      dir: url.searchParams.get('dir'),
      path: url.searchParams.getAll('path'),
    })
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const result = await runtime.convex.query(
      fnQuery('domains/fileActivity/queries:latestWritersForDir'),
      {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceSlug: workspace.slug,
        dirPath: query.data.dir,
        paths: query.data.path,
      },
    )
    return c.json(LatestWritersResponseSchema.parse(result))
  })

  app.get('/v1/ws/:workspaceSlug/file-activity/feed', async c => {
    const workspace = requireAuthedWorkspace(c, 'files:read')
    if ('response' in workspace) return workspace.response
    const query = FileActivityFeedQuerySchema.safeParse(queryParams(c.req.url))
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const binding = activityBinding(workspace.id)
    try {
      const pagination = await activityPages.paginationOpts(query.data, binding)
      const result = await runtime.convex.query(
        fnQuery('domains/fileActivity/queries:workspaceActivity'),
        {
          internalKey: runtime.internalKey,
          actorId: c.get('auth').user.id,
          workspaceSlug: workspace.slug,
          ...(pagination.cursor === null ? {} : { cursor: pagination.cursor }),
          limit: pagination.numItems,
          // A workspace feed is about change: reads are out unless reads=1.
          includeReads: query.data.reads === '1',
          order: query.data.order,
          ...(query.data.path === undefined ? {} : { path: query.data.path }),
          ...(query.data.scope === undefined ? {} : { scope: query.data.scope }),
        },
      )
      return c.json(FileHistoryResponseSchema.parse(await activityPages.response(result, binding)))
    } catch (error) {
      if (isCollectionCursorError(error)) {
        return c.json({ error: 'invalid_cursor' }, 400)
      }
      throw error
    }
  })

  // The feed as SSE: same rows, same cursor. Each frame's id is the contract
  // cursor for its row, so pagination position and stream resume point are
  // the same string. The platform ends segments cleanly at its duration cap;
  // disconnect+resume is this route's normal operating mode.
  app.get('/v1/ws/:workspaceSlug/file-activity/events', async c => {
    const workspace = requireAuthedWorkspace(c, 'files:read')
    if ('response' in workspace) return workspace.response
    const query = FileEventsStreamQuerySchema.safeParse(queryParams(c.req.url))
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    // Header wins over ?cursor=. No resume point means the beginning of the
    // workspace sequence, like the feed.
    const resume = c.req.header('last-event-id') ?? query.data.cursor
    const binding = activityBinding(workspace.id)
    let afterCursor: string | undefined
    try {
      const pagination = await activityPages.paginationOpts(
        { ...(resume === undefined ? {} : { cursor: resume }), limit: 100 },
        binding,
      )
      afterCursor = pagination.cursor ?? undefined
    } catch {
      return c.json({ error: 'invalid_request' }, 400)
    }

    const readPage = async (cursor: string | undefined): Promise<StreamActivityPage> => {
      const result = await runtime.convex.query(
        fnQuery('domains/fileActivity/queries:workspaceActivity'),
        {
          internalKey: runtime.internalKey,
          actorId: c.get('auth').user.id,
          workspaceSlug: workspace.slug,
          ...(cursor === undefined ? {} : { cursor }),
          limit: STREAM_PAGE_LIMIT,
          // An SSE cursor means "everything after this sequence". The paged
          // feed defaults newest-first, so the stream must opt into ascending
          // order explicitly or a reconnect would walk backwards and replay
          // old rows instead of draining the gap.
          order: 'asc',
          // The stream shares the feed's default: reads are dedupe markers,
          // not changes — out unless reads=1.
          includeReads: query.data.reads === '1',
        },
      )
      return {
        response: FileHistoryResponseSchema.parse(await activityPages.response(result, binding)),
        // An empty poll still resumes from the boundary it was asked to read.
        // Dropping that boundary would restart the next poll at sequence zero.
        nextInternalCursor: result.continueCursor.length === 0 ? cursor : result.continueCursor,
      }
    }

    // First page before any stream bytes: a workspace retired or deleted
    // between auth and attach gets a typed JSON 404 instead of an empty 200
    // stream (once retirement lands, auth itself stops resolving the slug).
    let firstPage: StreamActivityPage
    try {
      firstPage = await readPage(afterCursor)
    } catch (error) {
      if (isWorkspaceGoneError(error)) return c.json({ error: 'not_found' }, 404)
      throw error
    }
    return streamFileEvents(c.req.raw, {
      firstPage,
      afterCursor,
      readPage,
      binding,
      pollMs,
      keepaliveMs,
    })
  })
}

function streamFileEvents(
  request: Request,
  args: {
    firstPage: StreamActivityPage
    afterCursor?: string
    readPage: (cursor: string | undefined) => Promise<StreamActivityPage>
    binding: ReturnType<typeof activityBinding>
    pollMs: number
    keepaliveMs: number
  },
): Response {
  const encoder = new TextEncoder()
  let closed = false
  let keepalive: ReturnType<typeof setInterval> | null = null
  let wake: (() => void) | null = null
  const close = () => {
    closed = true
    if (keepalive !== null) clearInterval(keepalive)
    keepalive = null
    wake?.()
  }
  const idlePoll = (): Promise<void> =>
    new Promise(resolve => {
      const timer = setTimeout(() => {
        wake = null
        resolve()
      }, args.pollMs)
      wake = () => {
        clearTimeout(timer)
        wake = null
        resolve()
      }
    })

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      request.signal.addEventListener('abort', close, { once: true })
      const enqueue = (frame: string) => {
        try {
          controller.enqueue(encoder.encode(frame))
        } catch {
          close()
        }
      }
      // Comment ping during quiet stretches so neither the runtime's idle
      // timeout nor an intermediary drops a live stream with no events yet
      // (same discipline as the agent-session relay).
      keepalive = setInterval(() => {
        if (!closed) enqueue(': keepalive\n\n')
      }, args.keepaliveMs)
      void (async () => {
        let internalCursor = args.afterCursor
        let page = args.firstPage
        try {
          while (!closed) {
            for (const row of page.response.items) {
              if (closed) break
              enqueue(await fileEventFrame(row, args.binding))
            }
            if (closed) break
            // A short page means the sequence is drained; wait one poll
            // before asking again. A full page keeps draining immediately.
            internalCursor = page.nextInternalCursor
            if (page.response.nextCursor === null) await idlePoll()
            if (closed) break
            page = await args.readPage(internalCursor)
          }
          if (!closed) controller.close()
        } catch (error) {
          // A workspace retired mid-stream ends the segment cleanly — the
          // reconnect resolves the typed error; nothing here is lost state.
          if (!closed) {
            if (isWorkspaceGoneError(error)) controller.close()
            else controller.error(error)
          }
        } finally {
          request.signal.removeEventListener('abort', close)
          close()
        }
      })()
    },
    cancel() {
      close()
    },
  })
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    },
  })
}

// One frame per feed row: id is the row's cursor, the event name is the file
// event kind, and data is the FileFeedEventSchema object verbatim.
async function fileEventFrame(
  row: FileFeedEvent,
  binding: ReturnType<typeof activityBinding>,
): Promise<string> {
  const cursor = (
    await activityPages.response(
      { page: [], continueCursor: String(row.seq), isDone: false },
      binding,
    )
  ).nextCursor
  return `id: ${cursor}\nevent: ${row.event.kind}\ndata: ${JSON.stringify(row)}\n\n`
}

type StreamActivityPage = { response: FileHistoryResponse; nextInternalCursor?: string }

function activityBinding(workspaceId: string) {
  return { subject: `workspace:${workspaceId}`, filters: {}, order: 'workspace-sequence' } as const
}

function seenByBinding(workspaceId: string, path: string) {
  return {
    subject: `workspace:${workspaceId}`,
    filters: { path },
    order: 'last-seen-desc-actor-asc',
  } as const
}

function isWorkspaceGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /workspace not found/i.test(message)
}

function queryParams(requestUrl: string): Record<string, string> {
  return Object.fromEntries(new URL(requestUrl).searchParams)
}
