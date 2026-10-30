import { hashApiKey, type PreAuthRateLimitEndpoint } from '@repo/contract'

import { fn, type ApiRouteRuntime } from '../shared'

// An unauthenticated caller is limited by a named identity, not by "the IP" —
// the network is one namespace among several, and it is the weakest one.
export type PreAuthRateLimitIdentity =
  | { kind: 'network'; value: string }
  | { kind: 'email'; value: string }
  // A sign-in request, for the endpoint that spends guesses against one. Keying
  // that on the address instead would let anyone lock a victim out of their own
  // sign-in by burning the bucket from outside.
  | { kind: 'request'; value: string }

// Both fallbacks collapse every unrelated caller into a single bucket, so on the
// paths that use them the network limit stops nobody in particular: `net:global`
// is every request when proxy headers are untrusted, `net:unknown` is every
// request that arrives without an IP header. That is precisely why an endpoint
// that sends mail must ALSO carry an email bucket — the network bucket cannot be
// relied on to isolate one abuser, and it cannot stop one victim being bombed
// from many addresses.
const UNTRUSTED_PROXY_IDENTITY: PreAuthRateLimitIdentity = { kind: 'network', value: 'global' }
const UNKNOWN_NETWORK_IDENTITY: PreAuthRateLimitIdentity = { kind: 'network', value: 'unknown' }

export function networkIdentity(
  request: Request,
  trustProxyHeaders: boolean,
): PreAuthRateLimitIdentity {
  if (!trustProxyHeaders) return UNTRUSTED_PROXY_IDENTITY
  const cfIp = request.headers.get('cf-connecting-ip')
  if (cfIp !== null && cfIp.trim().length > 0) return { kind: 'network', value: cfIp.trim() }
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor !== null && forwardedFor.trim().length > 0) {
    return { kind: 'network', value: forwardedFor.split(',')[0]!.trim() }
  }
  const realIp = request.headers.get('x-real-ip')
  if (realIp !== null && realIp.trim().length > 0) return { kind: 'network', value: realIp.trim() }
  return UNKNOWN_NETWORK_IDENTITY
}

export function emailIdentity(email: string): PreAuthRateLimitIdentity {
  return { kind: 'email', value: email.trim().toLowerCase() }
}

export function requestIdentity(requestId: string): PreAuthRateLimitIdentity {
  return { kind: 'request', value: requestId }
}

// Namespaced before hashing so the two identity spaces cannot collide: an email
// that reads like an IP, or the literal `global`, still lands in its own bucket.
// The stored key grammar (`preauth:<endpoint>:<sha256>`) is unchanged.
const NAMESPACES: Record<PreAuthRateLimitIdentity['kind'], string> = {
  network: 'net',
  email: 'email',
  request: 'request',
}

export async function preAuthRateLimitIdentityHash(
  identity: PreAuthRateLimitIdentity,
): Promise<string> {
  return await hashApiKey(`${NAMESPACES[identity.kind]}:${identity.value}`)
}

export async function consumePreAuthRateLimit(
  runtime: ApiRouteRuntime,
  args: {
    endpoint: PreAuthRateLimitEndpoint
    identity: PreAuthRateLimitIdentity
    limit: number
    windowMs?: number
  },
): Promise<Response | null> {
  const identityHash = await preAuthRateLimitIdentityHash(args.identity)
  const result = (await runtime.convex.mutation(fn('domains/apiKeys/api:consumePreAuthRateLimit'), {
    internalKey: runtime.internalKey,
    identityHash,
    endpoint: args.endpoint,
    limit: args.limit,
    windowMs: args.windowMs ?? 60_000,
    now: runtime.now(),
  })) as PreAuthRateLimitResult
  if (result.ok) return null
  return Response.json(
    { error: 'rate_limited', retryAfterSeconds: result.retryAfterSeconds },
    { status: 429, headers: { 'retry-after': String(result.retryAfterSeconds) } },
  )
}

type PreAuthRateLimitResult =
  | { ok: true; remaining: number; resetAt: number }
  | { ok: false; retryAfterSeconds: number }
