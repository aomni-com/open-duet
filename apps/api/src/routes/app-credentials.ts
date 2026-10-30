import { ConvexError } from 'convex/values'

import {
  ExportAppCredentialRequestSchema,
  ExportAppCredentialResponseSchema,
  AppCredentialListQuerySchema,
  AppCredentialListResponseSchema,
  RevokeAppCredentialResponseSchema,
  AppCredentialErrorSchema,
} from '@repo/contract'

import {
  fn,
  fnQuery,
  readJson,
  requireAuthedWorkspace,
  type ApiApp,
  type ApiContext,
  type ApiRouteRuntime,
} from '../shared'

export function registerAppCredentialHeaders(app: ApiApp): void {
  app.use('/v1/ws/:workspaceSlug/apps/:slug/credentials/*', async (c, next) => {
    c.header('cache-control', 'private, no-store')
    await next()
  })
}

export function registerAppCredentialRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  options: { apiUrl: string; gatewayBaseUrl: string | null },
): void {
  app.get('/v1/ws/:workspaceSlug/apps/:slug/credentials', async c => {
    const workspace = requireAuthedWorkspace(c, 'apps')
    if ('response' in workspace) return workspace.response
    if (!AppCredentialListQuerySchema.safeParse(c.req.query()).success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const caller = c.get('credentialReference')
    try {
      const result = await runtime.convex.query(
        fnQuery('domains/apiKeys/appExports:listCredentials'),
        {
          internalKey: runtime.internalKey,
          workspaceId: workspace.id,
          appSlug: c.req.param('slug'),
          caller,
        },
      )
      return c.json(AppCredentialListResponseSchema.parse(result))
    } catch (error) {
      return appCredentialErrorResponse(c, error)
    }
  })
  app.post('/v1/ws/:workspaceSlug/apps/:slug/credentials/export', async c => {
    const workspace = requireAuthedWorkspace(c, 'apps')
    if ('response' in workspace) return workspace.response
    if (workspace.role === 'viewer') return c.json({ error: 'forbidden' }, 403)
    const body = ExportAppCredentialRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const caller = c.get('credentialReference')
    const urls = ExportAppCredentialResponseSchema.pick({
      apiUrl: true,
      gatewayBaseUrl: true,
    }).safeParse(options)
    if (!urls.success) return c.json({ error: 'app_credentials_not_configured' }, 503)
    try {
      const result = await runtime.convex.mutation(
        fn('domains/apiKeys/appExports:exportCredential'),
        {
          internalKey: runtime.internalKey,
          workspaceId: workspace.id,
          appSlug: c.req.param('slug'),
          caller,
          expiration: body.data.expiration,
        },
      )
      return c.json(ExportAppCredentialResponseSchema.parse({ ...result, ...urls.data }), 201)
    } catch (error) {
      return appCredentialErrorResponse(c, error)
    }
  })
  app.delete('/v1/ws/:workspaceSlug/apps/:slug/credentials/:credentialId', async c => {
    const workspace = requireAuthedWorkspace(c, 'apps')
    if ('response' in workspace) return workspace.response
    if (workspace.role === 'viewer') return c.json({ error: 'forbidden' }, 403)
    const caller = c.get('credentialReference')
    try {
      const result = await runtime.convex.mutation(
        fn('domains/apiKeys/appExports:revokeCredential'),
        {
          internalKey: runtime.internalKey,
          workspaceId: workspace.id,
          appSlug: c.req.param('slug'),
          caller,
          credentialId: c.req.param('credentialId'),
        },
      )
      return c.json(RevokeAppCredentialResponseSchema.parse(result))
    } catch (error) {
      return appCredentialErrorResponse(c, error)
    }
  })
}

function appCredentialErrorResponse(c: ApiContext, error: unknown): Response {
  const data = error instanceof ConvexError ? error.data : null
  const parsed = AppCredentialErrorSchema.safeParse(
    typeof data === 'object' && data !== null && 'code' in data
      ? { ...data, error: data.code }
      : null,
  )
  if (!parsed.success) return c.json({ error: 'internal_error' }, 500)
  const statuses = {
    unauthorized: 401,
    forbidden: 403,
    insufficient_scope: 403,
    invalid_request: 400,
    not_found: 404,
    app_disabled: 409,
    app_has_no_api_scopes: 409,
    app_credential_limit: 409,
    app_credentials_not_configured: 503,
    internal_error: 500,
  } as const
  return c.json(parsed.data, statuses[parsed.data.error])
}
