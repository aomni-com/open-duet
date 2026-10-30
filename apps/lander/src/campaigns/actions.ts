import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference, type FunctionReference } from 'convex/server'

import {
  AD_CLICK_PARAMS,
  CampaignLeadRequestSchema,
  CampaignLeadResponseSchema,
  MAX_ANALYTICS_JSON_BYTES,
  UTM_PARAMS,
  convexUrlsFromDeployment,
  normalizeAttributionSignals,
  type AttributionSignals,
} from '@repo/contract'

export const CAMPAIGN_JOURNEY_COOKIE = 'duet_campaign_journey'

type CampaignRoute = {
  campaignSlug: string
  action: string
}

type CampaignMutationResult =
  | { ok: true; attributionId: string; expiresAt: number; leadId?: string }
  | { ok: false; error: 'not_found' | 'campaign_disabled' }

export type CampaignActionDependencies = {
  convexMutation?: (name: string, args: Record<string, unknown>) => Promise<unknown>
  appUrl?: string
  now?: () => number
}

// The lander owns anonymous campaign actions end to end: it captures browser
// context, talks to Convex with the internal key, and answers the browser.
export async function handleCampaignAction(
  request: Request,
  route: CampaignRoute,
  dependencies: CampaignActionDependencies = {},
): Promise<Response> {
  const now = dependencies.now?.() ?? Date.now()
  const isGet = request.method === 'GET'
  const body = isGet ? {} : await readObject(request)
  if (body === null) return Response.json({ error: 'invalid_request' }, { status: 400 })

  const cookies = parseCookies(request.headers.get('cookie'))
  const signals = mergeAttributionSignals(
    normalizeAttributionSignals(body.signals),
    cookies,
    request,
  )
  const currentJourneyToken = cookies[CAMPAIGN_JOURNEY_COOKIE]
  const mutate = wrapUnreachable(dependencies.convexMutation ?? defaultConvexMutation)
  const shared = {
    campaignSlug: route.campaignSlug,
    action: route.action,
    ...(currentJourneyToken === undefined ? {} : { currentJourneyToken }),
    signals,
    now,
  }
  const secure = new URL(request.url).protocol === 'https:'
  const journeyHeaders = (attributionId: string, expiresAt: number): Headers =>
    new Headers({ 'set-cookie': journeyCookie(attributionId, expiresAt, now, secure) })

  if (isGet) {
    if (route.action !== 'signup') return Response.json({ error: 'not_found' }, { status: 404 })
    // Resolve the redirect target before minting so a misconfigured app URL
    // cannot create an attribution row and then fail the redirect.
    let handoff: URL
    try {
      handoff = new URL(
        '/api/campaigns/handoff',
        dependencies.appUrl ?? requiredEnv('NEXT_PUBLIC_DUET_APP_URL'),
      )
    } catch (error) {
      return upstreamUnreachable('campaign app URL is invalid', error)
    }
    const result = await mutate('domains/campaigns/api:mintAttribution', shared)
    if (result instanceof Response) return result
    if (!result.ok) return Response.json({ error: 'not_found' }, { status: 404 })
    // The attribution row ID is the handoff value; bootstrap validates it
    // against the row's own action/expiry/claim state.
    handoff.searchParams.set('token', result.attributionId)
    const headers = journeyHeaders(result.attributionId, result.expiresAt)
    headers.set('location', handoff.toString())
    return new Response(null, { status: 302, headers })
  }

  if (route.action === 'lead') {
    const parsed = CampaignLeadRequestSchema.safeParse(body)
    if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 })
    const result = await mutate('domains/campaigns/api:captureLead', {
      campaignSlug: route.campaignSlug,
      data: parsed.data.data,
      now,
    })
    if (result instanceof Response) return result
    if (!result.ok) return Response.json({ error: 'not_found' }, { status: 404 })
    return Response.json(CampaignLeadResponseSchema.parse({ leadId: result.leadId }), {
      status: 201,
    })
  }

  return Response.json({ error: 'not_found' }, { status: 404 })
}

type ConvexMutate = (name: string, args: Record<string, unknown>) => Promise<unknown>

// Convex or configuration failures answer as the stable 502 JSON shape the
// browser forms already handle, never an uncontrolled Next.js error page.
function wrapUnreachable(mutate: ConvexMutate) {
  return async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<CampaignMutationResult | Response> => {
    try {
      return (await mutate(name, args)) as CampaignMutationResult
    } catch (error) {
      return upstreamUnreachable(`campaign convex call failed: ${name}`, error)
    }
  }
}

function upstreamUnreachable(label: string, error: unknown): Response {
  console.error(label, { message: error instanceof Error ? error.message : 'unknown' })
  return Response.json({ error: 'upstream_unreachable' }, { status: 502 })
}

let convexClient: ConvexHttpClient | undefined

async function defaultConvexMutation(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  convexClient ??= new ConvexHttpClient(
    convexUrlsFromDeployment(requiredEnv('CONVEX_DEPLOYMENT')).cloudUrl,
    { logger: false },
  )
  return await convexClient.mutation(makeFunctionReference(name) as FunctionReference<'mutation'>, {
    internalKey: requiredEnv('DUET_API_INTERNAL_KEY'),
    ...args,
  })
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

function journeyCookie(token: string, expiresAt: number, now: number, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - now) / 1_000))
  return [
    `${CAMPAIGN_JOURNEY_COOKIE}=${encodeURIComponent(token)}`,
    `Max-Age=${maxAge}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

function mergeAttributionSignals(
  browserSignals: AttributionSignals,
  cookies: Record<string, string>,
  request: Request,
): AttributionSignals {
  const signals: AttributionSignals = { ...browserSignals }
  for (const key of UTM_PARAMS) {
    const value = cookies[key] ?? browserSignals[key]
    if (value === undefined) delete signals[key]
    else signals[key] = value
  }
  for (const key of AD_CLICK_PARAMS) {
    const value = browserSignals[key] ?? cookies[key]
    if (value === undefined) delete signals[key]
    else signals[key] = value
  }

  delete signals.ip
  delete signals.userAgent
  const ip = clientIp(request)
  const userAgent = request.headers.get('user-agent')?.trim()
  if (ip) signals.ip = ip
  if (userAgent) signals.userAgent = userAgent
  return signals
}

function clientIp(request: Request): string | undefined {
  return (
    request.headers.get('cf-connecting-ip')?.trim() ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    undefined
  )
}

async function readObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.text()
    if (new TextEncoder().encode(body).byteLength > MAX_ANALYTICS_JSON_BYTES) return null
    const value = JSON.parse(body) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    return { ...(value as Record<string, unknown>) }
  } catch {
    return null
  }
}

function parseCookies(header: string | null): Record<string, string> {
  if (header === null) return {}
  return Object.fromEntries(
    header.split(';').flatMap(part => {
      const separator = part.indexOf('=')
      if (separator < 1) return []
      const key = part.slice(0, separator).trim()
      const value = part.slice(separator + 1).trim()
      try {
        return [[key, decodeURIComponent(value)]]
      } catch {
        return [[key, value]]
      }
    }),
  )
}
