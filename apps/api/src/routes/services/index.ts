import { z } from 'zod'

import {
  STRIPPED_UPSTREAM_RESPONSE_HEADERS,
  gatewayBlockResponse,
  requestBody,
  type FetchLike,
  type GatewayBlock,
} from '@repo/contract'
import { createBoundCursorCodec } from '@repo/contract'
import { SERVICE_DEFINITIONS, matchRoute } from '@repo/service-catalog'

import {
  fn,
  fnQuery,
  requireWorkspaceFromKey,
  type ApiApp,
  type ApiRouteRuntime,
  type WaitUntil,
} from '../../shared'
import { callService } from './call-service'

const serviceCursorCodec = createBoundCursorCodec(
  'services.list',
  z.object({ offset: z.number().int().nonnegative() }),
)

interface ServiceProxyRouteOptions {
  fetchImpl: FetchLike
  waitUntil: WaitUntil
}

export function registerServiceProxyRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  options: ServiceProxyRouteOptions,
): void {
  const credentialCache = new Map<
    string,
    { value: { secret: string; fingerprint: string } | null; expiresAt: number }
  >()
  app.get('/v1/services', async c => {
    const query = c.req.query('q')?.toLowerCase() ?? ''
    const category = c.req.query('category')
    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(c.req.query('limit') ?? '50', 10) || 50),
    )
    const cursor = c.req.query('cursor')
    const origin = new URL(c.req.url).origin
    const filtered = SERVICE_DEFINITIONS.filter(
      definition => category === undefined || definition.category === category,
    )
      .filter(
        definition =>
          query === '' ||
          `${definition.name} ${definition.category} ${definition.summary}`
            .toLowerCase()
            .includes(query),
      )
      .sort((left, right) => {
        if (query === '') return left.id.localeCompare(right.id)
        const rank = (definition: (typeof SERVICE_DEFINITIONS)[number]): number => {
          if (definition.name.toLowerCase().includes(query)) return 0
          if (definition.category.toLowerCase().includes(query)) return 1
          return 2
        }
        return rank(left) - rank(right) || left.id.localeCompare(right.id)
      })
    let start = 0
    if (cursor !== undefined) {
      try {
        start = (
          await serviceCursorCodec.decode(cursor, {
            subject: 'catalog',
            filters: { q: query, category: category ?? null },
            order: 'catalog relevance, then id',
          })
        ).offset
      } catch {
        return c.json({ error: 'invalid_cursor' }, 400)
      }
    }
    const items = filtered
      .slice(start, start + limit)
      .map(definition => ({
        id: definition.id,
        name: definition.name,
        summary: definition.summary,
        category: definition.category,
        docsUrl: definition.docsUrl,
        ...(definition.llmsTxtUrl ? { llmsTxtUrl: definition.llmsTxtUrl } : {}),
        proxyBaseUrl: `${origin}/v1/services/${definition.id}`,
      }))
    const total = filtered.length
    const nextCursor =
      start + items.length < total
        ? await serviceCursorCodec.encode({
            subject: 'catalog',
            filters: { q: query, category: category ?? null },
            order: 'catalog relevance, then id',
            position: { offset: start + items.length },
          })
        : null
    return c.json({ items, nextCursor })
  })

  app.get('/v1/services/:service', c => {
    const definition = SERVICE_DEFINITIONS.find(item => item.id === c.req.param('service'))
    if (!definition)
      return c.json(
        {
          error: 'Unknown service. Use GET /v1/services to discover available services.',
          code: 'service_not_found',
        },
        404,
      )
    const origin = new URL(c.req.url).origin
    return c.json({
      id: definition.id,
      name: definition.name,
      summary: definition.summary,
      category: definition.category,
      docsUrl: definition.docsUrl,
      ...(definition.llmsTxtUrl ? { llmsTxtUrl: definition.llmsTxtUrl } : {}),
      proxyBaseUrl: `${origin}/v1/services/${definition.id}`,
      notes: definition.notes,
      routes: definition.routes.map(route => ({
        method: route.method,
        path: route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}'),
        billing: route.price.kind === 'free' ? 'free' : 'metered',
        ...(route.pool
          ? {
              pool: {
                pool: route.pool.pool,
                role: route.pool.role,
                ...(definition.pools?.find(pool => pool.id === route.pool?.pool)
                  ? {
                      ttlHours:
                        definition.pools!.find(pool => pool.id === route.pool?.pool)!.ttlMs /
                        3_600_000,
                    }
                  : {}),
              },
            }
          : {}),
      })),
    })
  })

  app.on(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], '/v1/services/:service/*', async c => {
    const requestUrl = new URL(c.req.url)
    const workspace = requireWorkspaceFromKey(
      c,
      'services',
      c.req.header('x-duet-workspace') ?? undefined,
    )
    if ('response' in workspace) return workspace.response

    const service = c.req.param('service')
    const targetPath = requestUrl.pathname.slice(`/v1/services/${service}`.length) || '/'
    const definition = SERVICE_DEFINITIONS.find(item => item.id === service)
    const matched =
      definition === undefined ? null : matchRoute(definition, c.req.method, targetPath)
    if (matched === null) return new Response(null, { status: 404 })
    const metered = matched.route.price.kind !== 'free'
    const preflight = (await runtime.convex.mutation(
      fn('domains/serviceProxy/model:proxyPreflight'),
      {
        internalKey: runtime.internalKey,
        auth: { userId: c.get('auth').user.id },
        workspaceId: workspace.id,
        service,
        metered,
        now: runtime.now(),
      },
    )) as
      | { proceed: true; workspaceId: string; userId: string }
      | { proceed: false; block: GatewayBlock }
    if (!preflight.proceed) return gatewayBlockResponse(preflight.block)

    const result = await callService(
      SERVICE_DEFINITIONS,
      {
        fetch: options.fetchImpl,
        now: runtime.now,
        credentials: {
          get: async serviceId => {
            const cached = credentialCache.get(serviceId)
            if (cached && cached.expiresAt > runtime.now()) return cached.value
            const value = (await runtime.convex.query(
              fnQuery('domains/serviceVault/api:getServiceCredential'),
              { internalKey: runtime.internalKey, serviceId, name: 'apiKey' },
            )) as { secret: string; fingerprint: string } | null
            credentialCache.set(serviceId, { value, expiresAt: runtime.now() + 60_000 })
            return value
          },
          invalidate: serviceId => credentialCache.delete(serviceId),
        },
        poolOwner: async (serviceId, pool, resourceId) =>
          (await runtime.convex.query(fnQuery('domains/serviceVault/api:poolOwner'), {
            internalKey: runtime.internalKey,
            serviceId,
            pool,
            resourceId,
          })) as string | null,
        recordPoolResource: async input => {
          await runtime.convex.mutation(fn('domains/serviceVault/api:recordPoolResource'), {
            internalKey: runtime.internalKey,
            ...input,
            createdAt: runtime.now(),
          })
        },
        markPoolResourceDeleted: async input => {
          await runtime.convex.mutation(fn('domains/serviceVault/api:markPoolResourceDeleted'), {
            internalKey: runtime.internalKey,
            serviceId: input.serviceId,
            pool: input.pool,
            resourceId: input.resourceId,
          })
        },
        cleanupPoolResource: async input => {
          const definition = SERVICE_DEFINITIONS.find(item => item.id === input.serviceId)
          const pool = definition?.pools?.find(item => item.id === input.pool)
          const credential = (await runtime.convex.query(
            fnQuery('domains/serviceVault/api:getServiceCredential'),
            { internalKey: runtime.internalKey, serviceId: input.serviceId, name: 'apiKey' },
          )) as { secret: string } | null
          if (!definition || !pool || !credential) return
          const targetPath = pool.expire.path.replace(/:([A-Za-z0-9_]+)/g, input.resourceId)
          const expiryUrl = new URL(`${definition.baseUrl}${targetPath}`)
          const headers = new Headers()
          if (definition.auth.kind === 'header')
            headers.set(definition.auth.name, credential.secret)
          else if (definition.auth.kind === 'bearer')
            headers.set('authorization', `Bearer ${credential.secret}`)
          else if (definition.auth.kind === 'basic')
            headers.set('authorization', `Basic ${credential.secret}`)
          else if (definition.auth.kind === 'query')
            expiryUrl.searchParams.set(definition.auth.name, credential.secret)
          const expiryHeaders = new Headers(headers)
          const expiryInit: RequestInit = { method: pool.expire.method, headers: expiryHeaders }
          if (pool.expire.body !== undefined) {
            expiryHeaders.set('content-type', 'application/json')
            expiryInit.body = JSON.stringify(pool.expire.body)
          }
          await options.fetchImpl(expiryUrl, expiryInit)
        },
      },
      {
        serviceId: service,
        method: c.req.method,
        path: targetPath,
        search: requestUrl.search,
        headers: c.req.raw.headers,
        body: requestBody(c.req.raw),
        workspaceId: workspace.id,
      },
    )
    if (result.kind === 'unavailable')
      return gatewayBlockResponse({
        status: 503,
        body: { error: 'The requested service is unavailable.', code: 'service_unavailable' },
      })
    if (result.kind === 'pool_record_failed')
      return c.json(
        {
          error: 'The service resource could not be tracked safely.',
          code: 'pool_resource_tracking_failed',
        },
        502,
      )
    if (result.kind === 'not_found') return new Response(null, { status: 404 })
    const upstream = result.response
    const responseBody = upstream.body
    const charge = result.charge

    if (charge !== null && charge.chargeMicroUsd > 0) {
      const reference = charge.reference ?? `service:${service}:${crypto.randomUUID()}`
      options.waitUntil(
        runtime.convex
          .mutation(fn('domains/serviceProxy/model:chargeServiceCall'), {
            internalKey: runtime.internalKey,
            workspaceId: preflight.workspaceId,
            userId: preflight.userId,
            amountMicroUsd: charge.chargeMicroUsd,
            reference,
            metadata: {
              service,
              path: targetPath,
              method: c.req.method,
              routeId: result.routeId,
              vendorCostMicroUsd: charge.vendorCostMicroUsd,
            },
            now: runtime.now(),
          })
          .catch(error => {
            console.error(`[service-proxy:${service}] Failed to charge service call`, error)
          }),
      )
    }

    const responseHeaders = new Headers(upstream.headers)
    for (const name of STRIPPED_UPSTREAM_RESPONSE_HEADERS) responseHeaders.delete(name)
    const requestId = c.req.header('x-duet-request-id')
    if (requestId !== undefined) responseHeaders.set('x-duet-request-id', requestId)

    if (upstream.ok)
      responseHeaders.set(
        'x-duet-charge-usd',
        charge === null ? '0' : (charge.chargeMicroUsd / 1_000_000).toFixed(6),
      )
    return new Response(responseBody as BodyInit, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    })
  })
}
