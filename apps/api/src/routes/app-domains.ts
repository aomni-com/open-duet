import { ConvexError } from 'convex/values'
import { z } from 'zod'

import {
  AppDomainErrorSchema,
  AppDomainListResponseSchema,
  AppDomainResponseSchema,
  appControls,
  AttachAppDomainRequestSchema,
  CollectionPageQuerySchema,
  extractBearerToken,
  isCollectionCursorError,
  normalizeAppDomainHostname,
  type AppDomain,
} from '@repo/contract'

import { createContinuationCollectionPage } from '../collection-page'
import type { GatewayClient } from '../gateway/client'
import { constantTimeSecretMatches } from '../secret-auth'
import { sessionRequestIdentityForAuth } from '../session-principal'
import {
  fn,
  fnQuery,
  readJson,
  requireAuthedWorkspace,
  type ApiApp,
  type ApiContext,
  type ApiRouteRuntime,
} from '../shared'

const domainPages = createContinuationCollectionPage('app-domains.list')
export const APP_DOMAIN_AUTH_BYPASS_PATHS = ['/v1/internal/apps/reconcile'] as const
const ReconcileAppsRequestSchema = z.strictObject({ workspaceId: z.string().min(1).max(256) })

export function registerAppDomainRoutes(app: ApiApp, runtime: ApiRouteRuntime): void {
  app.get('/v1/ws/:workspaceSlug/app-domains', async c => {
    const workspace = requireAuthedWorkspace(c, 'apps')
    if ('response' in workspace) return workspace.response
    const query = CollectionPageQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const binding = {
      subject: `workspace:${workspace.id}`,
      filters: {},
      order: 'creation time asc, domain id asc',
    }
    try {
      const result = await runtime.convex.query(
        fnQuery('domains/customDomains/model:listByWorkspace'),
        {
          internalKey: runtime.internalKey,
          workspaceId: workspace.id,
          paginationOpts: await domainPages.paginationOpts(query.data, binding),
        },
      )
      const page = await domainPages.response(
        result as {
          page: Array<{ domain: AppDomain; app: { id: string; slug: string; name?: string } }>
          continueCursor: string
          isDone: boolean
        },
        binding,
        row => ({
          ...row,
          app: {
            ...row.app,
            controls: { manageDomain: appControls(workspace.role, {}).manageDomain },
          },
        }),
      )
      return c.json(AppDomainListResponseSchema.parse(page))
    } catch (error) {
      if (isCollectionCursorError(error)) return c.json({ error: 'invalid_cursor' }, 400)
      return domainErrorResponse(c, error)
    }
  })
  app.put('/v1/ws/:workspaceSlug/apps/:slug/domain', async c => {
    const workspace = requireAuthedWorkspace(c, 'apps')
    if ('response' in workspace) return workspace.response
    const body = AttachAppDomainRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    let hostname: string
    try {
      hostname = normalizeAppDomainHostname(body.data.hostname)
    } catch {
      return c.json({ error: 'invalid_request' }, 400)
    }
    try {
      const domain = await runtime.convex.mutation(fn('domains/customDomains/model:attach'), {
        internalKey: runtime.internalKey,
        workspaceId: workspace.id,
        slug: c.req.param('slug'),
        identity: sessionRequestIdentityForAuth(c.get('auth')),
        hostname,
        now: runtime.now(),
      })
      return c.json(AppDomainResponseSchema.parse({ domain }))
    } catch (error) {
      return domainErrorResponse(c, error)
    }
  })
  app.get('/v1/ws/:workspaceSlug/apps/:slug/domain', async c => {
    const workspace = requireAuthedWorkspace(c, 'apps')
    if ('response' in workspace) return workspace.response
    try {
      const domain = await runtime.convex.query(fnQuery('domains/customDomains/model:get'), {
        internalKey: runtime.internalKey,
        workspaceId: workspace.id,
        slug: c.req.param('slug'),
      })
      return c.json(AppDomainResponseSchema.parse({ domain }))
    } catch (error) {
      return domainErrorResponse(c, error)
    }
  })
  app.delete('/v1/ws/:workspaceSlug/apps/:slug/domain', async c => {
    const workspace = requireAuthedWorkspace(c, 'apps')
    if ('response' in workspace) return workspace.response
    try {
      const domain = await runtime.convex.mutation(fn('domains/customDomains/model:remove'), {
        internalKey: runtime.internalKey,
        workspaceId: workspace.id,
        slug: c.req.param('slug'),
        identity: sessionRequestIdentityForAuth(c.get('auth')),
        now: runtime.now(),
      })
      return c.json(AppDomainResponseSchema.parse({ domain }))
    } catch (error) {
      return domainErrorResponse(c, error)
    }
  })
  app.post('/v1/ws/:workspaceSlug/apps/:slug/domain/recheck', async c => {
    const workspace = requireAuthedWorkspace(c, 'apps')
    if ('response' in workspace) return workspace.response
    try {
      const domain = await runtime.convex.mutation(fn('domains/customDomains/model:recheck'), {
        internalKey: runtime.internalKey,
        workspaceId: workspace.id,
        slug: c.req.param('slug'),
        identity: sessionRequestIdentityForAuth(c.get('auth')),
        now: runtime.now(),
      })
      return c.json(AppDomainResponseSchema.parse({ domain }))
    } catch (error) {
      return domainErrorResponse(c, error)
    }
  })
}

export function registerAppDomainInternalRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  gateway: Pick<GatewayClient, 'pushAppsReconcile'>,
): void {
  app.post('/v1/internal/apps/reconcile', async c => {
    const bearer = extractBearerToken(c.req.header('authorization') ?? null)
    if (!constantTimeSecretMatches(bearer, runtime.apiInternalKey)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    const body = ReconcileAppsRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const workspaces = (await runtime.convex.query(
      fnQuery('domains/workspaces/queries:refsByIds'),
      {
        internalKey: runtime.internalKey,
        workspaceIds: [body.data.workspaceId],
      },
    )) as Array<{ id: string; slug: string }>
    const workspace = workspaces[0]
    if (workspace === undefined) return c.json({ status: 'noop' })
    const result = await gateway.pushAppsReconcile(workspace.slug, workspace.id)
    return result.ok ? c.json({ status: 'reconciled' }) : result.response
  })
}

function domainErrorResponse(c: ApiContext, error: unknown): Response {
  if (!(error instanceof ConvexError)) throw error
  const result = AppDomainErrorSchema.safeParse(error.data)
  if (!result.success) throw error
  const statuses = {
    invalid_request: 400,
    invalid_cursor: 400,
    forbidden: 403,
    not_found: 404,
    domain_occupied: 409,
    hostname_in_use: 409,
    domain_cleanup_pending: 409,
    domain_not_configured: 503,
  } as const
  return c.json(result.data, statuses[result.data.error])
}
