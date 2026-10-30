import { randomUUID } from 'node:crypto'

import {
  CreatePublishRequestSchema,
  PublishDeletedResponseSchema,
  PublishListResponseSchema,
  PublishListQuerySchema,
  PublishResponseSchema,
  isCollectionCursorError,
  SetPublishPausedRequestSchema,
  UpdatePublishSlugRequestSchema,
  type PublishRow,
} from '@repo/contract'

import { createConvexCollectionPage } from '../collection-page'
import { type GatewayClient } from '../gateway/client'
import {
  fn,
  fnQuery,
  readJson,
  requireAuthedWorkspace,
  type ApiApp,
  type ApiContext,
  type ApiRouteRuntime,
} from '../shared'

const publishPages = createConvexCollectionPage('publishes.list')

export function registerPublishesRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
): void {
  app.get('/v1/ws/:workspaceSlug/publishes', async c => {
    const workspace = requireAuthedWorkspace(c, 'publish')
    if ('response' in workspace) return workspace.response
    const query = PublishListQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const binding = {
      subject: `workspace:${workspace.id}`,
      filters: {},
      order: 'slug asc, publish id asc',
    }
    let paginationOpts
    try {
      paginationOpts = await publishPages.paginationOpts(query.data, binding)
    } catch (error) {
      if (isCollectionCursorError(error)) return c.json({ error: 'invalid_cursor' }, 400)
      throw error
    }
    const result = (await runtime.convex.query(
      fnQuery('domains/publishes/model:listByWorkspacePage'),
      {
        internalKey: runtime.internalKey,
        workspaceId: workspace.id,
        paginationOpts,
      },
    )) as { page: unknown[]; continueCursor: string; isDone: boolean }
    try {
      return c.json(PublishListResponseSchema.parse(await publishPages.response(result, binding)))
    } catch (error) {
      if (isCollectionCursorError(error)) return c.json({ error: 'invalid_cursor' }, 400)
      throw error
    }
  })

  app.post('/v1/ws/:workspaceSlug/publishes', async c => {
    const workspace = requireAuthedWorkspace(c, 'publish')
    if ('response' in workspace) return workspace.response
    const body = CreatePublishRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const kind = await gatewayClient.detectPublishKind(
      c,
      workspace.slug,
      workspace.id,
      body.data.path,
    )
    if ('response' in kind) return kind.response
    try {
      const publish = await runtime.convex.mutation(fn('domains/publishes/model:createPublish'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
        path: body.data.path,
        kind: kind.kind,
        slug: body.data.slug,
      })
      return c.json(PublishResponseSchema.parse({ publish }), 201)
    } catch (error) {
      return publishMutationError(c, error)
    }
  })

  app.patch('/v1/ws/:workspaceSlug/publishes/:slug', async c => {
    const workspace = requireAuthedWorkspace(c, 'publish')
    if ('response' in workspace) return workspace.response
    const body = UpdatePublishSlugRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const publish = await runtime.convex.mutation(fn('domains/publishes/model:updateSlug'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
        slug: c.req.param('slug'),
        newSlug: body.data.slug,
      })
      return c.json(PublishResponseSchema.parse({ publish }))
    } catch (error) {
      return publishMutationError(c, error)
    }
  })

  app.post('/v1/ws/:workspaceSlug/publishes/:slug/pause', async c => {
    const workspace = requireAuthedWorkspace(c, 'publish')
    if ('response' in workspace) return workspace.response
    const body = SetPublishPausedRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const slug = c.req.param('slug')
    try {
      const current = (await runtime.convex.query(fnQuery('domains/publishes/model:getBySlug'), {
        internalKey: runtime.internalKey,
        workspaceId: workspace.id,
        slug,
      })) as PublishRow | null
      if (current === null) return c.json({ error: 'not_found' }, 404)
      let generation: string | undefined
      if (body.data.paused) {
        generation = randomUUID()
        const snapshot = await gatewayClient.createPublishFreeze(workspace.slug, {
          publishId: current.id,
          generation,
          anchorPath: current.anchorPath,
          kind: current.kind,
        })
        if ('response' in snapshot) return snapshot.response
      }
      const publish = await runtime.convex.mutation(
        fn('domains/publishes/model:setPublishPaused'),
        {
          internalKey: runtime.internalKey,
          actorId: c.get('auth').user.id,
          workspaceId: workspace.id,
          publishId: current.id,
          slug,
          paused: body.data.paused,
          generation,
        },
      )
      // Pause keeps only the confirmed generation; resume keeps nothing —
      // every generation reaps once past the edge-cache staleness bound.
      await gatewayClient.prunePublishFreezes(workspace.slug, {
        publishId: current.id,
        ...(generation === undefined ? {} : { keepGeneration: generation }),
      })
      return c.json(PublishResponseSchema.parse({ publish }))
    } catch (error) {
      return publishMutationError(c, error)
    }
  })

  app.delete('/v1/ws/:workspaceSlug/publishes/:slug', async c => {
    const workspace = requireAuthedWorkspace(c, 'publish')
    if ('response' in workspace) return workspace.response
    const slug = c.req.param('slug')
    try {
      const current = (await runtime.convex.query(fnQuery('domains/publishes/model:getBySlug'), {
        internalKey: runtime.internalKey,
        workspaceId: workspace.id,
        slug,
      })) as PublishRow | null
      const result = await runtime.convex.mutation(fn('domains/publishes/model:deletePublish'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
        slug,
      })
      // A deleted publish references no snapshot; reap its whole shadow tree.
      if (current !== null) {
        await gatewayClient.prunePublishFreezes(workspace.slug, { publishId: current.id })
      }
      return c.json(PublishDeletedResponseSchema.parse(result))
    } catch (error) {
      return publishMutationError(c, error)
    }
  })
}

function publishMutationError(c: ApiContext, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error)
  if (/not found/i.test(message)) return c.json({ error: 'not_found' }, 404)
  if (/Requires/i.test(message)) return c.json({ error: 'forbidden' }, 403)
  if (/Invalid|already exists|Could not allocate|not a publish anchor/.test(message))
    return c.json({ error: 'invalid_request' }, 400)
  throw error
}
