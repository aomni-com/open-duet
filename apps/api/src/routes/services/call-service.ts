import { SERVICE_PROXY_STRIPPED_REQUEST_HEADERS } from '@repo/contract'
import {
  evaluate,
  matchRoute,
  needsOf,
  priceCharge,
  readPath,
  type ServiceDefinition,
} from '@repo/service-catalog'

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface CredentialStore {
  get(serviceId: string): Promise<{ secret: string; fingerprint: string } | null>
  invalidate?(serviceId: string): void
}

export interface CallServiceDeps {
  fetch: FetchLike
  credentials: CredentialStore
  poolOwner?: (serviceId: string, pool: string, resourceId: string) => Promise<string | null>
  now(): number
  recordPoolResource?: (input: {
    serviceId: string
    pool: string
    resourceId: string
    workspaceId: string
    expiresAt: number
    expiry: { baseUrl: string; method: string; path: string; body?: unknown; authKind: string; authName?: string }
  }) => Promise<void>
  cleanupPoolResource?: (input: { serviceId: string; pool: string; resourceId: string }) => Promise<void>
  markPoolResourceDeleted?: (input: { serviceId: string; pool: string; resourceId: string }) => Promise<void>
}

export interface CallServiceRequest {
  serviceId: string
  method: string
  path: string
  search: string
  headers: Headers
  body: unknown
  workspaceId: string
}

export type CallServiceResult =
  | { kind: 'not_found' }
  | { kind: 'unavailable' }
  | { kind: 'pool_record_failed'; routeId: string }
  | { kind: 'ok'; response: Response; charge: ReturnType<typeof priceCharge> | null; routeId: string }

function authHeaders(definition: ServiceDefinition, secret: string): Headers {
  const headers = new Headers()
  if (definition.auth.kind === 'bearer') headers.set('authorization', `Bearer ${secret}`)
  else if (definition.auth.kind === 'basic') headers.set('authorization', `Basic ${secret}`)
  else if (definition.auth.kind === 'header') headers.set(definition.auth.name, secret)
  return headers
}

function strippedHeaders(input: Headers, auth: Headers): Headers {
  const headers = new Headers()
  for (const [name, value] of input) {
    const lower = name.toLowerCase()
    if (SERVICE_PROXY_STRIPPED_REQUEST_HEADERS.has(lower)) continue
    headers.set(name, value)
  }
  for (const [name, value] of auth) headers.set(name, value)
  return headers
}

export async function callService(
  definitions: readonly ServiceDefinition[],
  deps: CallServiceDeps,
  request: CallServiceRequest,
): Promise<CallServiceResult> {
  const definition = definitions.find(item => item.id === request.serviceId)
  if (!definition) return { kind: 'not_found' }
  const matched = matchRoute(definition, request.method, request.path)
  if (!matched) return { kind: 'not_found' }
  const credential = await deps.credentials.get(definition.id)
  if (!credential) return { kind: 'unavailable' }
  const binding = matched.route.pool
  if (binding && (binding.role === 'mutate' || binding.role === 'delete')) {
    const owner = deps.poolOwner ? await deps.poolOwner(definition.id, binding.pool, matched.params[binding.idParam] ?? '') : null
    if (!owner || owner !== request.workspaceId) return { kind: 'ok', response: new Response(JSON.stringify({ code: 'pool_resource_not_owned', error: 'This resource was not created by your workspace. You can use it or create your own.' }), { status: 403, headers: { 'content-type': 'application/json' } }), charge: null, routeId: matched.route.id }
  }
  const needs = needsOf(matched.route.price)
  if (definition.hooks?.needs) {
    needs.requestJson ||= definition.hooks.needs.requestJson
    needs.responseJson ||= definition.hooks.needs.responseJson
  }
  const createBinding = matched.route.pool?.role === 'create' ? matched.route.pool : undefined
  const poolCreate = createBinding !== undefined
  if (poolCreate) needs.responseJson = true
  let body = request.body
  let requestJson: unknown
  if (needs.requestJson && body !== null && body !== undefined) {
    if (body instanceof FormData) {
      // A caller that already supplied a parsed form can be passed directly
      // to a provider hook. Fetch will choose the correct multipart boundary.
    } else if (request.headers.get('content-type')?.toLowerCase().includes('multipart/form-data')) {
      const buffered = new Request('https://service-proxy.invalid', {
        method: request.method,
        headers: request.headers,
        body: body as BodyInit,
        ...(body instanceof ReadableStream ? { duplex: 'half' as const } : {}),
      })
      body = await buffered.formData()
    } else {
      const text = await new Response(body as BodyInit).text()
      try { requestJson = JSON.parse(text) } catch { requestJson = undefined }
      body = text
    }
  }
  if (definition.auth.kind === 'query') {
    const params = new URLSearchParams(request.search)
    params.set(definition.auth.name, credential.secret)
    request = { ...request, search: `?${params.toString()}` }
  }
  if (definition.hooks?.beforeForward) {
    const hooked = definition.hooks.beforeForward({ method: matched.route.method, path: request.path, search: request.search, headers: request.headers, body }, {
      serviceId: definition.id,
      route: matched.route,
      params: matched.params,
      workspaceId: request.workspaceId,
    })
    if ('kind' in hooked) {
      return {
        kind: 'ok',
        response: new Response(JSON.stringify({ code: hooked.code, error: hooked.message }), { status: hooked.status, headers: { 'content-type': 'application/json' } }),
        charge: null,
        routeId: matched.route.id,
      }
    }
    request = { ...request, method: hooked.method, path: hooked.path, search: hooked.search, headers: hooked.headers }
    body = hooked.body
  }
  if (body instanceof FormData) {
    const headers = new Headers(request.headers)
    headers.delete('content-type')
    request = { ...request, headers }
  }
  const startedAt = deps.now()
  const perform = (secret: string) => deps.fetch(`${definition.baseUrl}${request.path}${request.search}`, {
    method: request.method,
    headers: strippedHeaders(request.headers, authHeaders(definition, secret)),
    body: body as BodyInit,
    ...(body instanceof ReadableStream ? { duplex: 'half' as const } : {}),
  })
  let upstream = await perform(credential.secret)
  if (upstream.status === 401 && deps.credentials.invalidate) {
    deps.credentials.invalidate(definition.id)
    const refreshed = await deps.credentials.get(definition.id)
    if (refreshed && refreshed.secret !== credential.secret) upstream = await perform(refreshed.secret)
  }
  const elapsedMs = deps.now() - startedAt
  let responseJson: unknown
  let response: Response = upstream
  if (needs.responseJson) {
    const text = await upstream.text()
    try { responseJson = JSON.parse(text) } catch { responseJson = undefined }
    response = new Response(text, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers })
  }
  if (poolCreate && upstream.ok) {
    const binding = createBinding
    const pool = definition.pools?.find(candidate => candidate.id === binding.pool)
    const resourceId = readPath(responseJson, binding.idFrom)
    if (!pool || typeof resourceId !== 'string' || resourceId.length === 0 || deps.recordPoolResource === undefined) {
      return { kind: 'pool_record_failed', routeId: matched.route.id }
    }
    try {
      await deps.recordPoolResource({
        serviceId: definition.id,
        pool: binding.pool,
        resourceId,
        workspaceId: request.workspaceId,
        expiresAt: deps.now() + pool.ttlMs,
        expiry: {
          baseUrl: definition.baseUrl,
          method: pool.expire.method,
          path: pool.expire.path,
          ...(pool.expire.body === undefined ? {} : { body: pool.expire.body }),
          authKind: definition.auth.kind,
          ...(definition.auth.kind === 'header' || definition.auth.kind === 'query'
            ? { authName: definition.auth.name }
            : {}),
        },
      })
    } catch {
      try {
        await deps.cleanupPoolResource?.({ serviceId: definition.id, pool: binding.pool, resourceId })
      } catch {
        // The marked failure remains the primary signal; the scheduled vendor
        // cleanup path can reconcile a provider that was temporarily down.
      }
      return { kind: 'pool_record_failed', routeId: matched.route.id }
    }
  }
  const charge = upstream.ok
    ? evaluate(definition, { route: matched.route, params: matched.params, status: upstream.status, headers: upstream.headers, elapsedMs, requestJson, responseJson })
    : null
  if (upstream.ok && binding?.role === 'delete') {
    await deps.markPoolResourceDeleted?.({
      serviceId: definition.id,
      pool: binding.pool,
      resourceId: matched.params[binding.idParam] ?? '',
    })
  }
  return { kind: 'ok', response, charge: charge ? priceCharge(definition, charge) : null, routeId: matched.route.id }
}
