import { Buffer } from 'node:buffer'

import { waitUntil as vercelWaitUntil } from '@vercel/functions'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference, type FunctionReference } from 'convex/server'
import { Hono } from 'hono'

import {
  safeTransportCode,
  BLOCKED_UPSTREAM_PATHS,
  APPROVED_MODELS,
  gatewayBlockResponse,
  STRIPPED_UPSTREAM_REQUEST_HEADERS,
  STRIPPED_UPSTREAM_RESPONSE_HEADERS,
  VERCEL_AI_GATEWAY_BASE_URL,
  VERCEL_AI_GATEWAY_REFERER,
  VERCEL_AI_GATEWAY_TITLE,
  convexUrlsFromDeployment,
  DEFAULT_RESERVATION_ESTIMATE_MICRO_USD,
  extractApiKeyCredential,
  GatewayPreflightResultSchema,
  X_DUET_WORKSPACE_HEADER,
  hashApiKey,
  modelByGatewayId,
  requestBody,
  duplexFor,
  type BillingMode,
  type ApprovedModelCatalog,
  type FetchLike,
  type GenerationModality,
  type GatewayPreflightResult,
  type AttributionTierId,
  type RequestKind,
  type ModelRouterPolicy,
} from '@repo/contract'

import { extractGenerationId } from './extract-generation-id'
import { validateModelListResponse } from './model-list'
import {
  addOpenAiStreamUsage,
  classifyModelRouterRequest,
  configuredUpstreamRequest,
  fetchModelRouterPolicy,
} from './model-router-gateway'
import { usageFromModelRouterJson, usageFromModelRouterSse } from './model-router-usage'
import { applyProviderLock } from './provider-lock'
import {
  GatewayRequestInspectionError,
  GatewayTierAttributionError,
  MODEL_ROUTING_HEADERS,
  inspectGatewayRequest,
  type InspectedGatewayRequest,
} from './request-inspection'

// Vercel function config: response streaming for the SSE proxy; 800s cap for long LLM streams.
export const config = { maxDuration: 800, supportsResponseStreaming: true }

const CONFIGURED_STREAM_PROBE_BYTES = 64 * 1024
// Give a configured provider a bounded startup grace period, then let the
// normal Vercel route recover instead of holding the function open indefinitely.
const CONFIGURED_STREAM_PROBE_TIMEOUT_MS = 5_000

export type WaitUntil = (p: Promise<unknown>) => void

export interface ConvexMutationClient {
  mutation(ref: FunctionReference<'mutation'>, args: Record<string, unknown>): Promise<unknown>
  query?(ref: FunctionReference<'query'>, args: Record<string, unknown>): Promise<unknown>
}

export interface ModelGatewayAppOptions {
  convexUrl?: string
  internalKey?: string
  aiGatewayApiKey?: string
  upstreamBaseUrl?: string
  fetch?: FetchLike
  waitUntil?: WaitUntil
  convex?: ConvexMutationClient
  preflight?: typeof preflightModelGatewaySpend
  now?: () => number
  approvedModelCatalog?: ApprovedModelCatalog
  modelRouterPolicy?: ModelRouterPolicy
}

export function createModelGatewayApp(options: ModelGatewayAppOptions = {}): Hono {
  const app = new Hono()
  const fetchImpl = options.fetch ?? globalThis.fetch
  const deployment = process.env.CONVEX_DEPLOYMENT
  const convexUrl =
    options.convexUrl ?? (deployment ? convexUrlsFromDeployment(deployment).cloudUrl : undefined)
  const internalKey = options.internalKey ?? process.env.DUET_API_INTERNAL_KEY
  const convex = options.convex ?? (convexUrl ? createConvexClient(convexUrl) : null)
  const upstreamBaseUrl = trimTrailingSlashes(options.upstreamBaseUrl ?? VERCEL_AI_GATEWAY_BASE_URL)
  const aiGatewayApiKey = options.aiGatewayApiKey ?? process.env.AI_GATEWAY_API_KEY
  const now = options.now ?? Date.now
  const waitUntil = options.waitUntil ?? vercelWaitUntil
  const preflightSpend = options.preflight ?? preflightModelGatewaySpend
  const approvedModelCatalog = options.approvedModelCatalog ?? APPROVED_MODELS

  app.all('*', async c => {
    const request = c.req.raw
    const credential = extractApiKeyCredential(request.headers)
    if (credential === null) {
      return gatewayBlockResponse({ status: 401, body: unauthorizedBody(request.headers) })
    }

    const requestUrl = new URL(request.url)
    if (BLOCKED_UPSTREAM_PATHS.has(requestUrl.pathname)) {
      return gatewayBlockResponse({ status: 403, body: blockedUpstreamBody() })
    }

    let inspected: InspectedGatewayRequest
    try {
      inspected = await inspectGatewayRequest(request, approvedModelCatalog)
    } catch (error) {
      if (error instanceof GatewayRequestInspectionError) return c.json(error.body, 400)
      if (error instanceof GatewayTierAttributionError) {
        return gatewayBlockResponse(error.block)
      }
      throw error
    }
    const modality = billingModality(inspected.modality)
    const estimateMicroUsd =
      inspected.billingMode === 'reservation' ? DEFAULT_RESERVATION_ESTIMATE_MICRO_USD : undefined
    const preflight = await preflightSpend({
      credential: credential.token,
      convex,
      convexUrl,
      internalKey,
      requestKind: inspected.kind,
      modality,
      billingMode: inspected.billingMode,
      ...(request.headers.has(X_DUET_WORKSPACE_HEADER)
        ? { workspaceSlug: request.headers.get(X_DUET_WORKSPACE_HEADER)!.trim() }
        : {}),
      ...(inspected.model === undefined ? {} : { model: inspected.model }),
      ...(inspected.tier === undefined ? {} : { tier: inspected.tier }),
      ...(estimateMicroUsd === undefined ? {} : { estimateMicroUsd }),
      now: now(),
    })
    if (!preflight.proceed) return gatewayBlockResponse(preflight.block)

    if (!aiGatewayApiKey) {
      if (preflight.generationId !== undefined) {
        await releaseGeneration({
          convex,
          convexUrl,
          internalKey,
          generationId: preflight.generationId,
          reason: 'upstream_not_configured',
          now: now(),
        }).catch(() => undefined)
      }
      return c.json({ error: 'upstream_not_configured', code: 'upstream_not_configured' }, 500)
    }

    const shouldCheckRouter = inspected.model !== undefined && request.headers.has('x-duet-tier')
    const routerQueryClient =
      shouldCheckRouter && convex !== null && convex !== undefined && convex.query !== undefined
        ? { query: convex.query.bind(convex) }
        : null
    const routerPolicy =
      options.modelRouterPolicy ??
      (shouldCheckRouter
        ? await fetchModelRouterPolicy({ convex: routerQueryClient, internalKey })
        : { version: 1 as const, rules: [], updatedAt: 0 })
    const routeDecision =
      inspected.model === undefined
        ? { kind: 'vercel' as const, reason: 'no_match' as const }
        : classifyModelRouterRequest({ request, model: inspected.model, policy: routerPolicy })

    const targetUrl = `${upstreamBaseUrl}${requestUrl.pathname}${requestUrl.search}`
    const providerLock =
      inspected.model === undefined
        ? undefined
        : modelByGatewayId(approvedModelCatalog, inspected.model)?.providerLock
    const forwardedJsonBody =
      inspected.jsonBody !== undefined && providerLock !== undefined
        ? applyProviderLock(inspected.jsonBody, providerLock)
        : inspected.jsonBody
    const serializedBody =
      forwardedJsonBody === undefined
        ? undefined
        : JSON.stringify(
            routeDecision.kind === 'configured'
              ? addOpenAiStreamUsage(forwardedJsonBody, requestUrl.pathname)
              : forwardedJsonBody,
          )
    const bufferedConfiguredBody =
      routeDecision.kind === 'configured' && serializedBody === undefined
        ? await request.clone().arrayBuffer()
        : undefined

    if (routeDecision.kind === 'configured') {
      const routed = await fetchConfiguredRoute({
        fetchImpl,
        request,
        rule: routeDecision.rule,
        family: routeDecision.family,
        body: serializedBody ?? bufferedConfiguredBody,
      })
      if (routed.response !== null) {
        if (preflight.generationId !== undefined) {
          waitUntil(
            settleRoutedResponse({
              convex,
              convexUrl,
              internalKey,
              generationId: preflight.generationId,
              response: routed.response,
              pathname: requestUrl.pathname,
              provider: routeDecision.family,
              now: now(),
            }),
          )
        }
        return responseForClient(routed.response)
      }
      logConfiguredRouteFallback({
        request,
        ruleId: routeDecision.rule.id,
        family: routeDecision.family,
        reason: routed.reason,
      })
    }
    const upstreamHeaders = upstreamRequestHeaders(request.headers, aiGatewayApiKey)
    if (serializedBody !== undefined) {
      upstreamHeaders.set('content-length', String(Buffer.byteLength(serializedBody)))
    }
    // The Vercel gateway routes by these headers in preference to the body, so
    // a header left untouched can steer upstream to a different model than
    // preflight authorized (body-approved, header-served). Pin every model
    // header inspection trusts (MODEL_ROUTING_HEADERS) to the inspected slug so
    // upstream can only run the model enforcement actually checked.
    if (inspected.model !== undefined) {
      for (const name of MODEL_ROUTING_HEADERS) {
        if (upstreamHeaders.has(name)) upstreamHeaders.set(name, inspected.model)
      }
    }
    let upstream: Response
    try {
      upstream = await fetchImpl(targetUrl, {
        method: request.method,
        headers: upstreamHeaders,
        body:
          serializedBody ??
          (bufferedConfiguredBody === undefined ? requestBody(request) : bufferedConfiguredBody),
        ...(serializedBody === undefined ? duplexFor(request) : { duplex: 'half' as const }),
      })
    } catch (error) {
      if (routeDecision.kind === 'configured') {
        logVercelFallbackResult({
          request,
          ruleId: routeDecision.rule.id,
          status: null,
          reason: 'vercel_transport_error',
        })
      }
      const generationId = preflight.generationId
      if (generationId !== undefined) {
        await recordForwardingFailure({
          convex,
          convexUrl,
          internalKey,
          generationId,
          billingMode: inspected.billingMode,
          error: errorMessage(error),
          reason: 'upstream_failed',
          now: now(),
        }).catch(recordingError => {
          if (request.signal.aborted || (error instanceof Error && error.name === 'AbortError'))
            return
          logUnrecordedForwardingFailure(error, {
            generationId,
            error: recordingError,
          })
        })
      } else if (
        !request.signal.aborted &&
        !(error instanceof Error && error.name === 'AbortError')
      ) {
        logUnrecordedForwardingFailure(error)
      }
      return c.json({ error: 'upstream_failed', code: 'upstream_failed' }, 502)
    }

    if (routeDecision.kind === 'configured') {
      logVercelFallbackResult({
        request,
        ruleId: routeDecision.rule.id,
        status: upstream.status,
      })
    }

    if (request.method === 'GET' && requestUrl.pathname === '/v1/models') {
      upstream = await validateModelListResponse(upstream)
    }

    /* Preflight already cleared this caller to spend, so an upstream 401 or 402
       is about Duet's own platform credential or provider balance — it is never
       the caller's. Forwarded verbatim they are indistinguishable from the
       refusals this gateway authors itself, and every caller surface reads a
       402 as "you are out of credits": a Duet-side outage would send a fully
       funded person to a billing page that has nothing to fix. Upstream being
       unable to serve us is what 502 already means here. */
    if (upstream.status === 401 || upstream.status === 402) {
      if (preflight.generationId !== undefined) {
        waitUntil(
          recordForwardingFailure({
            convex,
            convexUrl,
            internalKey,
            generationId: preflight.generationId,
            billingMode: inspected.billingMode,
            error: `upstream_${upstream.status}`,
            reason: 'upstream_failed',
            now: now(),
          }),
        )
      }
      return c.json({ error: 'upstream_failed', code: 'upstream_failed' }, 502)
    }

    if (preflight.generationId === undefined) return responseForClient(upstream)

    if (!upstream.ok && inspected.billingMode === 'reservation') {
      waitUntil(
        recordForwardingFailure({
          convex,
          convexUrl,
          internalKey,
          generationId: preflight.generationId,
          billingMode: inspected.billingMode,
          error: `upstream_${upstream.status}`,
          reason: 'upstream_failed',
          now: now(),
        }),
      )
      return responseForClient(upstream)
    }

    const extracted = extractGenerationId(upstream)
    waitUntil(
      recordPostResponseBilling({
        convex,
        convexUrl,
        internalKey,
        generationId: preflight.generationId,
        billingMode: inspected.billingMode,
        upstreamGenerationId: extracted.generationId,
        now: now(),
      }),
    )

    return responseForClient(new Response(extracted.body, upstream))
  })

  return app
}

export async function preflightModelGatewaySpend(args: {
  credential: string
  convex?: ConvexMutationClient | null
  convexUrl?: string
  internalKey?: string
  requestKind: RequestKind
  modality: GenerationModality
  model?: string
  workspaceSlug?: string
  tier?: AttributionTierId
  billingMode: BillingMode
  estimateMicroUsd?: number
  now: number
}): Promise<GatewayPreflightResult> {
  const convex = requireConvex(args.convex, args.convexUrl)
  const internalKey = requireInternalKey(args.internalKey)
  const result = await convex.mutation(fn('domains/modelGateway/model:gatewayPreflight'), {
    internalKey,
    hashedKey: await hashApiKey(args.credential),
    requestKind: args.requestKind,
    modality: args.modality,
    billingMode: args.billingMode,
    ...(args.workspaceSlug === undefined ? {} : { workspaceSlug: args.workspaceSlug }),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.tier === undefined ? {} : { tier: args.tier }),
    ...(args.estimateMicroUsd === undefined ? {} : { estimateMicroUsd: args.estimateMicroUsd }),
    now: args.now,
  })
  const parsed = GatewayPreflightResultSchema.safeParse(result)
  if (!parsed.success) throw new Error('Invalid gateway preflight response')
  return parsed.data
}

export const modelGatewayApp = createLazyModelGatewayApp()
export const fetch = (request: Request): Response | Promise<Response> =>
  modelGatewayApp.fetch(request)
export default { fetch }

function upstreamRequestHeaders(callerHeaders: Headers, aiGatewayApiKey: string): Headers {
  const headers = new Headers()
  for (const [key, value] of callerHeaders.entries()) {
    if (!STRIPPED_UPSTREAM_REQUEST_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value)
    }
  }
  headers.set('authorization', `Bearer ${aiGatewayApiKey}`)
  headers.set('http-referer', VERCEL_AI_GATEWAY_REFERER)
  headers.set('x-title', VERCEL_AI_GATEWAY_TITLE)
  return headers
}

async function fetchConfiguredRoute(args: {
  fetchImpl: FetchLike
  request: Request
  rule: import('@repo/contract').ModelRouterRule
  body?: BodyInit
  family?: 'openai' | 'anthropic'
}): Promise<{ response: Response | null; reason: string }> {
  try {
    const response = await args.fetchImpl(
      configuredUpstreamRequest({
        request: args.request,
        rule: args.rule,
        family: args.family,
        body: args.body,
      }),
    )
    // A configured provider is an optimization. Any refusal before bytes begin
    // returns to the normal Vercel path, which remains the billing fallback.
    if (!response.ok) return { response: null, reason: `configured_http_${response.status}` }
    return await inspectConfiguredStream(response)
  } catch {
    return { response: null, reason: 'configured_transport_error' }
  }
}

async function inspectConfiguredStream(
  response: Response,
): Promise<{ response: Response | null; reason: string }> {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    return { response, reason: 'configured_success' }
  }
  const reader = response.clone().body?.getReader()
  if (reader === undefined) return { response, reason: 'configured_success' }
  const decoder = new TextDecoder()
  let buffered = ''
  let bytes = 0
  const deadline = Date.now() + CONFIGURED_STREAM_PROBE_TIMEOUT_MS
  try {
    while (bytes < CONFIGURED_STREAM_PROBE_BYTES) {
      const remainingMs = deadline - Date.now()
      const next = await readWithTimeout(reader, remainingMs)
      if (next === 'timeout') {
        return { response: null, reason: 'configured_stream_probe_timeout' }
      }
      if (next.done) {
        const event = parseSseEvent(buffered)
        return isSseFailure(event)
          ? { response: null, reason: 'configured_stream_error_before_content' }
          : isSseTerminal(event) || isSseContent(event)
            ? { response, reason: 'configured_success' }
            : { response: null, reason: 'configured_stream_closed_before_content' }
      }
      bytes += next.value.byteLength
      buffered += decoder.decode(next.value, { stream: true })
      const frames = buffered.split(/\r?\n\r?\n/)
      buffered = frames.pop() ?? ''
      for (const frame of frames) {
        const event = parseSseEvent(frame)
        if (isSseFailure(event)) {
          return { response: null, reason: 'configured_stream_error_before_content' }
        }
        if (isSseTerminal(event)) return { response, reason: 'configured_success' }
        if (isSseContent(event)) return { response, reason: 'configured_success' }
      }
    }
    return { response, reason: 'configured_probe_limit' }
  } finally {
    // A provider that never produces bytes may never settle cancellation on a
    // cloned stream. Do not let cleanup hold the fallback response hostage.
    void reader.cancel().catch(() => undefined)
  }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>> | 'timeout'> {
  if (timeoutMs <= 0) return 'timeout'
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function parseSseEvent(frame: string): { event: string; data: unknown } | null {
  const event = frame.match(/^event:\s*(.+)$/m)?.[1]?.trim() ?? ''
  const data = frame
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .join('\n')
  if (!data || data === '[DONE]') return null
  try {
    return { event, data: JSON.parse(data) }
  } catch {
    return null
  }
}

function isSseFailure(event: { event: string; data: unknown } | null): boolean {
  if (event === null) return false
  if (event.event === 'error') return true
  if (event.data === null || typeof event.data !== 'object') return false
  const data = event.data as Record<string, unknown>
  const type = typeof data.type === 'string' ? data.type : ''
  return type === 'error' || type.endsWith('.failed') || 'error' in data
}

function isSseTerminal(event: { event: string; data: unknown } | null): boolean {
  if (event === null || event.data === null || typeof event.data !== 'object') return false
  const type = (event.data as Record<string, unknown>).type
  return type === 'response.completed' || type === 'message_stop'
}

function isSseContent(event: { event: string; data: unknown } | null): boolean {
  if (event === null || event.data === null || typeof event.data !== 'object') return false
  const data = event.data as Record<string, unknown>
  const type = typeof data.type === 'string' ? data.type : ''
  if (type === 'content_block_delta') {
    const delta = data.delta
    return (
      delta !== null &&
      typeof delta === 'object' &&
      typeof (delta as Record<string, unknown>).text === 'string'
    )
  }
  if (type === 'response.output_text.delta') return typeof data.delta === 'string'
  if (type === 'message_delta') return true
  const choices = data.choices
  if (!Array.isArray(choices)) return false
  return choices.some(choice => {
    if (choice === null || typeof choice !== 'object') return false
    const delta = (choice as Record<string, unknown>).delta
    return (
      delta !== null &&
      typeof delta === 'object' &&
      typeof (delta as Record<string, unknown>).content === 'string'
    )
  })
}

function logConfiguredRouteFallback(args: {
  request: Request
  ruleId: string
  family: 'openai' | 'anthropic'
  reason: string
}): void {
  console.info('[model-gateway] configured route falling back to vercel', {
    operation: 'configured_route_fallback',
    path: new URL(args.request.url).pathname,
    ruleId: args.ruleId,
    family: args.family,
    reason: args.reason,
    fallback: 'vercel',
  })
}

function logVercelFallbackResult(args: {
  request: Request
  ruleId: string
  status: number | null
  reason?: string
}): void {
  console.info('[model-gateway] vercel fallback completed', {
    operation: 'configured_route_fallback_result',
    path: new URL(args.request.url).pathname,
    ruleId: args.ruleId,
    fallback: 'vercel',
    ...(args.status === null
      ? { reason: args.reason ?? 'vercel_transport_error' }
      : { status: args.status, ok: args.status >= 200 && args.status < 300 }),
  })
}

async function settleRoutedResponse(args: {
  convex?: ConvexMutationClient | null
  convexUrl?: string
  internalKey?: string
  generationId: string
  response: Response
  pathname: string
  provider: 'openai' | 'anthropic'
  now: number
}): Promise<void> {
  const contentType = args.response.headers.get('content-type') ?? ''
  let usage
  let upstreamGenerationId: string | undefined
  try {
    if (contentType.includes('text/event-stream')) {
      const text = await args.response.clone().text()
      usage = usageFromModelRouterSse(args.pathname, text)
      upstreamGenerationId = providerIdFromSse(text, args.pathname)
    } else {
      const body = (await args.response.clone().json()) as unknown
      usage = usageFromModelRouterJson(args.pathname, body)
      upstreamGenerationId = providerIdFromJson(body, args.pathname)
    }
  } catch {
    usage = { source: 'missing' as const }
  }
  if (usage.source !== 'provider' || upstreamGenerationId === undefined) {
    await releaseGeneration({
      convex: args.convex,
      convexUrl: args.convexUrl,
      internalKey: args.internalKey,
      generationId: args.generationId,
      reason:
        usage.source !== 'provider' ? 'missing_usage_telemetry' : 'missing_upstream_generation_id',
      now: args.now,
    }).catch(() => undefined)
    return
  }
  try {
    await requireConvex(args.convex, args.convexUrl).mutation(
      fn('domains/modelGateway/model:settleRoutedGeneration'),
      {
        internalKey: requireInternalKey(args.internalKey),
        generationId: args.generationId,
        upstreamGenerationId,
        provider: args.provider,
        usage: usage.usage,
        ...(usage.cacheCreationInputTokens === undefined
          ? {}
          : { cacheCreationInputTokens: usage.cacheCreationInputTokens }),
        now: args.now,
      },
    )
  } catch {
    await releaseGeneration({
      convex: args.convex,
      convexUrl: args.convexUrl,
      internalKey: args.internalKey,
      generationId: args.generationId,
      reason: 'routed_settlement_failed',
      now: args.now,
    }).catch(() => undefined)
  }
}

function providerIdFromJson(body: unknown, pathname?: string): string | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  const id = record.id
  if (typeof id === 'string' && id.length > 0) return id
  const nestedKey =
    pathname === '/v1/messages' ? 'message' : pathname === '/v1/responses' ? 'response' : null
  if (nestedKey === null || record[nestedKey] === null || typeof record[nestedKey] !== 'object')
    return undefined
  const nestedId = (record[nestedKey] as Record<string, unknown>).id
  return typeof nestedId === 'string' && nestedId.length > 0 ? nestedId : undefined
}

function providerIdFromSse(text: string, pathname: string): string | undefined {
  for (const frame of text.split(/\n\n+/)) {
    const data = frame
      .split(/\r?\n/)
      .find(line => line.startsWith('data:'))
      ?.slice(5)
      .trim()
    if (!data || data === '[DONE]') continue
    try {
      const id = providerIdFromJson(JSON.parse(data), pathname)
      if (id !== undefined) return id
    } catch {
      // Continue through arbitrary provider event shapes.
    }
  }
  return undefined
}

function responseForClient(upstream: Response): Response {
  const headers = new Headers(upstream.headers)
  for (const header of STRIPPED_UPSTREAM_RESPONSE_HEADERS) headers.delete(header)
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  })
}

async function recordPostResponseBilling(args: {
  convex?: ConvexMutationClient | null
  convexUrl?: string
  internalKey?: string
  generationId: string
  billingMode: BillingMode
  upstreamGenerationId: Promise<string | null>
  now: number
}): Promise<void> {
  const upstreamGenerationId = await args.upstreamGenerationId
  if (upstreamGenerationId === null) {
    await releaseGeneration({
      convex: args.convex,
      convexUrl: args.convexUrl,
      internalKey: args.internalKey,
      generationId: args.generationId,
      reason:
        args.billingMode === 'reservation'
          ? 'missing_generation_id'
          : 'missing_upstream_generation_id',
      now: args.now,
    })
    return
  }
  try {
    await recordUpstreamGenerationId({
      convex: args.convex,
      convexUrl: args.convexUrl,
      internalKey: args.internalKey,
      generationId: args.generationId,
      upstreamGenerationId,
      now: args.now,
    })
  } catch (error) {
    if (args.billingMode !== 'reservation') throw error
    await releaseGeneration({
      convex: args.convex,
      convexUrl: args.convexUrl,
      internalKey: args.internalKey,
      generationId: args.generationId,
      reason: 'reconcile_schedule_failed',
      now: args.now,
    })
  }
}

async function recordUpstreamGenerationId(args: {
  convex?: ConvexMutationClient | null
  convexUrl?: string
  internalKey?: string
  generationId: string
  upstreamGenerationId: string
  now: number
}): Promise<void> {
  await requireConvex(args.convex, args.convexUrl).mutation(
    fn('domains/modelGateway/model:recordUpstreamGenerationId'),
    {
      internalKey: requireInternalKey(args.internalKey),
      generationId: args.generationId,
      upstreamGenerationId: args.upstreamGenerationId,
      now: args.now,
    },
  )
}

async function recordUpstreamFailure(args: {
  convex?: ConvexMutationClient | null
  convexUrl?: string
  internalKey?: string
  generationId: string
  error: string
  now: number
}): Promise<void> {
  await requireConvex(args.convex, args.convexUrl).mutation(
    fn('domains/modelGateway/model:recordUpstreamFailure'),
    {
      internalKey: requireInternalKey(args.internalKey),
      generationId: args.generationId,
      error: args.error,
      now: args.now,
    },
  )
}

async function recordForwardingFailure(args: {
  convex?: ConvexMutationClient | null
  convexUrl?: string
  internalKey?: string
  generationId: string
  billingMode: BillingMode
  error: string
  reason: string
  now: number
}): Promise<void> {
  if (args.billingMode === 'reservation') {
    await releaseGeneration({
      convex: args.convex,
      convexUrl: args.convexUrl,
      internalKey: args.internalKey,
      generationId: args.generationId,
      reason: args.reason,
      now: args.now,
    })
    return
  }
  await recordUpstreamFailure({
    convex: args.convex,
    convexUrl: args.convexUrl,
    internalKey: args.internalKey,
    generationId: args.generationId,
    error: args.error,
    now: args.now,
  })
}

async function releaseGeneration(args: {
  convex?: ConvexMutationClient | null
  convexUrl?: string
  internalKey?: string
  generationId: string
  reason: string
  now: number
}): Promise<void> {
  await requireConvex(args.convex, args.convexUrl).mutation(
    fn('domains/modelGateway/model:releaseGeneration'),
    {
      internalKey: requireInternalKey(args.internalKey),
      generationId: args.generationId,
      reason: args.reason,
      now: args.now,
    },
  )
}

function createConvexClient(convexUrl: string): ConvexMutationClient {
  return new ConvexHttpClient(convexUrl, {
    logger: false,
    skipConvexDeploymentUrlCheck: true,
  })
}

function requireConvex(
  convex: ConvexMutationClient | null | undefined,
  convexUrl: string | undefined,
): ConvexMutationClient {
  if (convex !== null && convex !== undefined) return convex
  if (convexUrl) return createConvexClient(convexUrl)
  throw new Error('CONVEX_DEPLOYMENT is required')
}

function requireInternalKey(internalKey: string | undefined): string {
  if (internalKey) return internalKey
  throw new Error('DUET_API_INTERNAL_KEY is required')
}

function fn(name: string): FunctionReference<'mutation'> {
  return makeFunctionReference(name) as FunctionReference<'mutation'>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'upstream_failed'
}

function billingModality(modality: InspectedGatewayRequest['modality']): GenerationModality {
  return modality === 'chat' || modality === 'embedding' ? 'text' : modality
}

function unauthorizedBody(headers: Headers): {
  error: 'unauthorized'
  code: 'missing_api_key' | 'invalid_api_key'
} {
  const hasCredentialAttempt = headers.has('authorization') || headers.has('x-api-key')
  return {
    error: 'unauthorized',
    code: hasCredentialAttempt ? 'invalid_api_key' : 'missing_api_key',
  }
}

function blockedUpstreamBody(): { error: string; code: 'endpoint_not_available' } {
  return {
    error:
      'This endpoint is not available. To review your AI usage and credit balance, open the billing settings page in your Duet workspace.',
    code: 'endpoint_not_available',
  }
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/g, '')
}

function createLazyModelGatewayApp(): Hono {
  let app: Hono | null = null
  return new Hono().all('*', c => {
    app ??= createModelGatewayApp()
    return app.fetch(c.req.raw)
  })
}

function logUnrecordedForwardingFailure(
  forwardingError: unknown,
  recordingFailure?: { generationId: string; error: unknown },
): void {
  try {
    const forwardingCode = safeTransportCode(forwardingError) ?? 'unknown'
    if (recordingFailure === undefined && forwardingCode === 'unknown') return
    const recordingRequestId =
      recordingFailure?.error instanceof Error
        ? /\[Request ID: ([a-f0-9]{16})\]/.exec(recordingFailure.error.message)?.[1]
        : undefined
    console.error('[model-gateway] forwarding failure not recorded', {
      operation: 'forward_model_request',
      forwardingCode,
      ...(recordingFailure === undefined
        ? {}
        : {
            generationId: recordingFailure.generationId,
            ...(recordingRequestId === undefined
              ? { recordingCode: safeTransportCode(recordingFailure.error) ?? 'unknown' }
              : { recordingRequestId }),
          }),
    })
  } catch {
    // Reporting must not replace the response to the original forwarding failure.
  }
}
