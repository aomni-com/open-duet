import {
  AcceptShareRequestSchema,
  CreateShareRequestSchema,
  IncomingShareResponseSchema,
  isCollectionCursorError,
  PendingShareListResponseSchema,
  PendingShareListQuerySchema,
  ShareRequestResponseSchema,
  ReshareRequestSchema,
  SetSharePausedRequestSchema,
  ShareDeclinedResponseSchema,
  ShareListResponseSchema,
  ShareListQuerySchema,
  type ShareListItem,
  type ShareRequest,
  ShareResponseSchema,
  ShareRevokedResponseSchema,
  ShareUnlinkedResponseSchema,
  UnlinkShareRequestSchema,
} from '@repo/contract'

import { createConvexCollectionPage, createTemporalConvexCollectionPage } from '../collection-page'
import type { GatewayClient } from '../gateway/client'
import {
  fn,
  fnAction,
  fnQuery,
  readJson,
  requireAuthedWorkspace,
  requireHumanActor,
  type ApiApp,
  type ApiContext,
  type ApiRouteRuntime,
} from '../shared'
import { pushAffectedRecipientAnchors } from './apps-fanout'

const workspaceSharePages = createConvexCollectionPage('shares.list')
const pendingSharePages = createTemporalConvexCollectionPage('shares.pending')

export function registerSharesRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
): void {
  app.get('/v1/ws/:workspaceSlug/shares', async c => {
    const workspace = requireAuthedWorkspace(c, 'share')
    if ('response' in workspace) return workspace.response
    const query = ShareListQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const binding = {
      subject: `workspace:${workspace.id}:user:${c.get('auth').user.id}`,
      filters: {},
      order: 'creation time asc, share id asc, direction asc',
    }
    let paginationOpts
    try {
      paginationOpts = await workspaceSharePages.paginationOpts(query.data, binding)
    } catch (error) {
      if (isCollectionCursorError(error)) return c.json({ error: 'invalid_cursor' }, 400)
      throw error
    }
    const result = (await runtime.convex.query(
      fnQuery('domains/shares/model:listForWorkspacePage'),
      {
        internalKey: runtime.internalKey,
        workspaceId: workspace.id,
        now: runtime.now(),
        paginationOpts,
      },
    )) as { page: ShareListItem[]; continueCursor: string; isDone: boolean }
    return c.json(
      ShareListResponseSchema.parse(await workspaceSharePages.response(result, binding)),
    )
  })

  app.post('/v1/ws/:workspaceSlug/shares', async c => {
    const workspace = requireAuthedWorkspace(c, 'share')
    if ('response' in workspace) return workspace.response
    const body = CreateShareRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const created = await runtime.convex.action(
        fnAction('domains/shares/actions:createAndSendFromApi'),
        {
          internalKey: runtime.internalKey,
          actorId: c.get('auth').user.id,
          fromWorkspaceId: workspace.id,
          toEmail: body.data.toEmail,
          path: body.data.path,
          mode: body.data.mode,
          ignorePatterns: body.data.ignorePatterns,
        },
      )
      return c.json(ShareResponseSchema.parse({ share: created.share }), 201)
    } catch (error) {
      return shareMutationError(c, error)
    }
  })

  app.post('/v1/ws/:workspaceSlug/shares/:shareId/reshares', async c => {
    const workspace = requireAuthedWorkspace(c, 'share')
    if ('response' in workspace) return workspace.response
    const body = ReshareRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const created = await runtime.convex.action(
        fnAction('domains/shares/actions:reshareAndSendFromApi'),
        {
          internalKey: runtime.internalKey,
          actorId: c.get('auth').user.id,
          parentShareId: c.req.param('shareId'),
          fromWorkspaceId: workspace.id,
          toEmail: body.data.toEmail,
          mode: body.data.mode,
          ignorePatterns: body.data.ignorePatterns,
        },
      )
      return c.json(ShareResponseSchema.parse({ share: created.share }), 201)
    } catch (error) {
      return shareMutationError(c, error)
    }
  })

  app.get('/v1/share-requests', async c => {
    const auth = requireHumanActor(c)
    if ('response' in auth) return auth.response
    const query = PendingShareListQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const binding = {
      subject: `user:${auth.userId}`,
      filters: {},
      order: 'creation time asc, share id asc',
    }
    let pagination
    try {
      pagination = await pendingSharePages.pagination(query.data, binding, runtime.now())
    } catch (error) {
      if (isCollectionCursorError(error)) return c.json({ error: 'invalid_cursor' }, 400)
      throw error
    }
    const result = (await runtime.convex.query(
      fnQuery('domains/shares/model:listPendingForUserPage'),
      {
        internalKey: runtime.internalKey,
        actorId: auth.userId,
        now: pagination.asOf,
        paginationOpts: pagination.paginationOpts,
      },
    )) as { page: ShareRequest[]; continueCursor: string; isDone: boolean }
    return c.json(
      PendingShareListResponseSchema.parse(
        await pendingSharePages.response(result, binding, pagination.asOf),
      ),
    )
  })

  app.get('/v1/share-requests/:token', async c => {
    const auth = requireHumanActor(c)
    if ('response' in auth) return auth.response
    try {
      const share = await runtime.convex.query(fnQuery('domains/shares/model:resolveShareToken'), {
        internalKey: runtime.internalKey,
        actorId: auth.userId,
        token: c.req.param('token'),
        now: runtime.now(),
      })
      return c.json(ShareRequestResponseSchema.parse({ share }))
    } catch (error) {
      return shareMutationError(c, error)
    }
  })

  app.post('/v1/share-requests/:shareId/accept', async c => {
    const auth = requireHumanActor(c)
    if ('response' in auth) return auth.response
    const body = AcceptShareRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const share = await runtime.convex.mutation(fn('domains/shares/model:acceptShare'), {
        internalKey: runtime.internalKey,
        actorId: auth.userId,
        shareId: c.req.param('shareId'),
        toWorkspaceId: body.data.toWorkspaceId,
        mountPath: body.data.mountPath,
        now: runtime.now(),
      })
      await pushAffectedRecipientAnchors(runtime, gatewayClient, {
        affectedRecipientWorkspaceIds: [body.data.toWorkspaceId],
      })
      return c.json(IncomingShareResponseSchema.parse({ share }))
    } catch (error) {
      return shareMutationError(c, error)
    }
  })

  app.post('/v1/share-requests/:shareId/decline', async c => {
    const auth = requireHumanActor(c)
    if ('response' in auth) return auth.response
    try {
      const result = await runtime.convex.mutation(fn('domains/shares/model:declineShare'), {
        internalKey: runtime.internalKey,
        actorId: auth.userId,
        shareId: c.req.param('shareId'),
        now: runtime.now(),
      })
      return c.json(ShareDeclinedResponseSchema.parse(result))
    } catch (error) {
      return shareMutationError(c, error)
    }
  })

  app.post('/v1/ws/:workspaceSlug/shares/:shareId/unlink', async c => {
    const workspace = requireAuthedWorkspace(c, 'share')
    if ('response' in workspace) return workspace.response
    const body = UnlinkShareRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const result = await runtime.convex.mutation(fn('domains/shares/model:unlinkShare'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        shareId: c.req.param('shareId'),
        toWorkspaceId: workspace.id,
        now: runtime.now(),
      })
      await pushAffectedRecipientAnchors(runtime, gatewayClient, result)
      const { affectedRecipientWorkspaceIds: _, ...response } = result as Record<string, unknown>
      return c.json(ShareUnlinkedResponseSchema.parse(response))
    } catch (error) {
      return shareMutationError(c, error)
    }
  })

  app.post('/v1/ws/:workspaceSlug/shares/:shareId/pause', async c => {
    const workspace = requireAuthedWorkspace(c, 'share')
    if ('response' in workspace) return workspace.response
    const body = SetSharePausedRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const share = await runtime.convex.mutation(fn('domains/shares/model:setSharePaused'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        shareId: c.req.param('shareId'),
        workspaceId: workspace.id,
        paused: body.data.paused,
        now: runtime.now(),
      })
      return c.json(ShareResponseSchema.parse({ share }))
    } catch (error) {
      return shareMutationError(c, error)
    }
  })

  app.delete('/v1/ws/:workspaceSlug/shares/:shareId', async c => {
    const workspace = requireAuthedWorkspace(c, 'share')
    if ('response' in workspace) return workspace.response
    try {
      const result = await runtime.convex.mutation(fn('domains/shares/model:revokeShare'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        shareId: c.req.param('shareId'),
        fromWorkspaceId: workspace.id,
        now: runtime.now(),
      })
      await pushAffectedRecipientAnchors(runtime, gatewayClient, result)
      const { affectedRecipientWorkspaceIds: _, ...response } = result as Record<string, unknown>
      return c.json(ShareRevokedResponseSchema.parse(response))
    } catch (error) {
      return shareMutationError(c, error)
    }
  })
}

function shareMutationError(c: ApiContext, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error)
  if (/not found/i.test(message)) return c.json({ error: 'not_found' }, 404)
  if (/Share email daily rate limit exceeded/i.test(message)) {
    const retryAfterSeconds = Number(message.match(/retry after (\d+) seconds/i)?.[1] ?? 1)
    return c.json(
      { error: 'rate_limited', retryAfterSeconds },
      { status: 429, headers: { 'retry-after': String(retryAfterSeconds) } },
    )
  }
  if (/An active share already exists/i.test(message)) {
    return c.json({ error: 'already_shared' }, 409)
  }
  if (/Share is not active/i.test(message)) {
    return c.json({ error: 'share_not_active' }, 409)
  }
  if (
    /Requires|cannot grant|recipient does not match|workspace does not match|not live|retired/i.test(
      message,
    )
  )
    return c.json({ error: 'forbidden' }, 403)
  if (
    /Invalid|nest|contain|collid|not a share-root|already exists|expired|declined|Share is |Cannot (accept|decline|unlink)/i.test(
      message,
    )
  )
    return c.json({ error: 'invalid_request' }, 400)
  throw error
}
