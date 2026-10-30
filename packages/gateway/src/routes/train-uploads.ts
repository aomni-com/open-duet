import { Hono, type Context } from 'hono'

import {
  DUET_TRAIN_SOURCE_URL_HEADER,
  InvalidCollectionCursorError,
  TrainUploadsListQuerySchema,
  TrainUploadsListResponseSchema,
  TrainUrlUploadRequestSchema,
} from '@repo/contract'

import { InvalidUploadScopeError } from '../auth/upload-scope'
import { TrainScopeResolutionError, trainScopeErrorResponse } from '../train/agent-scope'
import { UploadStoreError, type UploadsStore } from '../train/uploads-store'

export function createTrainUploadsRoutes(options: {
  resolveStore: (c: Context) => UploadsStore
  capBytes: number
  // Scope-aware like resolveStore: "running" means a job for THIS scope.
  isRunning: (c: Context) => boolean
  ready?: Promise<void>
}): Hono {
  const app = new Hono()

  app.put('/:filename', async c => {
    await options.ready
    const contentLength = parseContentLength(c.req.header('content-length'))
    try {
      const sourceUrlHeader = c.req.header(DUET_TRAIN_SOURCE_URL_HEADER)
      const sourceUrl =
        sourceUrlHeader === undefined
          ? undefined
          : TrainUrlUploadRequestSchema.safeParse({ url: sourceUrlHeader })
      if (sourceUrl !== undefined && !sourceUrl.success) {
        return c.json({ error: 'invalid_request' }, 400)
      }
      const store = options.resolveStore(c)
      const file =
        sourceUrl === undefined
          ? await store.put(c.req.param('filename'), c.req.raw.body, contentLength)
          : await store.putUrl(
              c.req.param('filename'),
              c.req.raw.body,
              sourceUrl.data.url,
              contentLength,
            )
      return c.json({ file }, 201)
    } catch (error) {
      return uploadErrorResponse(c, error)
    }
  })

  app.get('/', async c => {
    await options.ready
    try {
      const query = TrainUploadsListQuerySchema.safeParse(c.req.query())
      if (!query.success) return c.json({ error: 'invalid_request' }, 400)
      const page = await options.resolveStore(c).list(query.data)
      return c.json(
        TrainUploadsListResponseSchema.parse({
          items: page.items,
          nextCursor: page.nextCursor,
          meta: {
            ...page.meta,
            capBytes: options.capBytes,
            running: options.isRunning(c),
          },
        }),
      )
    } catch (error) {
      return uploadErrorResponse(c, error)
    }
  })

  app.delete('/:filename', async c => {
    await options.ready
    if (options.isRunning(c)) return c.json({ error: 'train_running' }, 409)
    try {
      await options.resolveStore(c).remove(c.req.param('filename'))
      return c.json({ ok: true })
    } catch (error) {
      return uploadErrorResponse(c, error)
    }
  })

  return app
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function uploadErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof InvalidUploadScopeError) {
    return c.json({ error: 'invalid_anchor_id' }, 400)
  }
  if (error instanceof TrainScopeResolutionError) {
    return trainScopeErrorResponse(error)
  }
  if (error instanceof UploadStoreError) {
    return c.json({ error: error.code }, error.status)
  }
  if (error instanceof InvalidCollectionCursorError) {
    return c.json({ error: error.code }, 400)
  }
  throw error
}
