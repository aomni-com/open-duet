// Everything the outside world says about a signup attempt. Owns the network;
// owns nothing about what the answers mean — that is `policy.ts`.
//
// `fetch` is injected rather than read as a bare global: a bare global `fetch`
// passes Bun's tests and throws "Illegal invocation" in a browser, and this
// codebase has been burned by that before.

import type { MxResolution } from './blockedEmailDomains'

const FINGERPRINT_EVENTS_URL = 'https://api.fpjs.io/events'
const DOH_URL = 'https://cloudflare-dns.com/dns-query'

// A requestId older than this is a replay, not a signup. The client
// identification → server verification round-trip is sub-second, so a few
// minutes is generous. Matches chat-app's window.
export const MAX_REQUEST_AGE_MS = 3 * 60 * 1000

export type BotResult = 'notDetected' | 'good' | 'bad'

export type SignupDevice = { visitorId: string; requestId: string }

export type SignupEvidence = {
  /** What the client said it was, before verification. */
  claimed?: SignupDevice
  /** What Fingerprint says the requestId actually resolves to. */
  resolvedVisitorId?: string
  eventTimestamp?: number
  botResult?: BotResult
  /**
   * Why device evidence is missing, when it is. Present means "we could not
   * tell", never "we checked and it was fine" — the two must stay
   * distinguishable or fail-open silently becomes fail-blind.
   */
  deviceUnavailable?: 'no-device' | 'no-api-key' | 'api-error' | 'event-not-found'
  /**
   * How the email domain's MX resolved. One representation, owned by the
   * blocklist module, so "no usable mail host" and "we could not look it up"
   * can never be confused for each other.
   */
  mx?: MxResolution
  /**
   * Accounts already created on this address's domain in the last day, not
   * counting this one. Our own ledger, not a vendor score: a farm minting an
   * account a minute on a domain it controls is invisible per account and
   * obvious as a rate.
   */
  domainSignupsLastDay?: number
}

/**
 * Structural rather than `typeof globalThis.fetch`: runtimes decorate the global
 * (Bun adds `preconnect`), and the gate only ever needs the call itself.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type Deps = {
  fetch: FetchLike
  now: number
  apiKey?: string
  /**
   * Operational kill-switch for the MX lookup, the gate's only outbound DNS
   * call. Off means the MX rule reports nothing and therefore denies nobody —
   * the same fail-open posture the rest of the evidence takes. Also what keeps
   * the test suite off live DNS.
   */
  mxLookup?: boolean
}

type FingerprintEventResponse = {
  products?: {
    identification?: { data?: { visitorId?: string; timestamp?: number } }
    botd?: { data?: { bot?: { result?: string } } }
  }
}

function toBotResult(value: unknown): BotResult | undefined {
  return value === 'notDetected' || value === 'good' || value === 'bad' ? value : undefined
}

/**
 * Resolve one identification event. Every uncertainty — no key, transport
 * failure, non-200, unparseable body, missing identification — comes back as
 * `deviceUnavailable` rather than an exception.
 *
 * FAIL OPEN IS A LEVER, NOT AN ACCIDENT. A user whose browser cannot identify
 * (adblocker, offline, privacy extension) still signs up, because denying real
 * users on a network hiccup costs more than the trials a determined farmer
 * saves by blocking a script. `def.duet.so` exists to make that blocking
 * harder. If abuse through this path ever outweighs the false positives, this
 * is the single place to change.
 */
async function collectDeviceEvidence(
  device: SignupDevice | undefined,
  deps: Deps,
): Promise<SignupEvidence> {
  if (device === undefined) return { deviceUnavailable: 'no-device' }
  if (!deps.apiKey) return { claimed: device, deviceUnavailable: 'no-api-key' }

  try {
    const response = await deps.fetch(
      `${FINGERPRINT_EVENTS_URL}/${encodeURIComponent(device.requestId)}`,
      { headers: { 'Auth-API-Key': deps.apiKey } },
    )
    if (!response.ok) {
      return {
        claimed: device,
        deviceUnavailable: response.status === 404 ? 'event-not-found' : 'api-error',
      }
    }
    const body = (await response.json()) as FingerprintEventResponse
    const identification = body.products?.identification?.data
    if (identification?.visitorId === undefined) {
      return { claimed: device, deviceUnavailable: 'event-not-found' }
    }
    return {
      claimed: device,
      resolvedVisitorId: identification.visitorId,
      ...(typeof identification.timestamp === 'number'
        ? { eventTimestamp: identification.timestamp }
        : {}),
      ...(toBotResult(body.products?.botd?.data?.bot?.result) === undefined
        ? {}
        : { botResult: toBotResult(body.products?.botd?.data?.bot?.result) }),
    }
  } catch {
    return { claimed: device, deviceUnavailable: 'api-error' }
  }
}

type DohAnswer = { data?: string }

/**
 * MX hosts over DNS-over-HTTPS, replacing chat-app's `node:dns` lookup so the
 * gate stays in Convex's default runtime.
 *
 * An empty answer and the Null MX sentinel (`.`) both mean "this domain
 * publishes no usable mail host", which is suspicious and reported as an empty
 * host list (`kind: 'none'`). A transport failure is uncertainty (`kind:
 * 'error'`), so a DNS hiccup can never deny a real domain.
 */
async function collectMxEvidence(email: string, deps: Deps): Promise<Partial<SignupEvidence>> {
  if (deps.mxLookup === false) return {}
  const domain = email.split('@')[1]?.toLowerCase().trim()
  if (domain === undefined || domain.length === 0) return { mx: { kind: 'none' } }

  try {
    const response = await deps.fetch(`${DOH_URL}?name=${encodeURIComponent(domain)}&type=MX`, {
      headers: { accept: 'application/dns-json' },
    })
    if (!response.ok) return { mx: { kind: 'error' } }
    const body = (await response.json()) as { Answer?: DohAnswer[] }
    const hosts = (body.Answer ?? []).flatMap(answer => {
      // Answers look like "10 alt1.gmail-smtp-in.l.google.com." — preference
      // first, then the exchange, with a trailing root dot. The Null MX
      // sentinel is a bare ".", which strips to nothing and drops out here.
      const exchange = answer.data?.trim().split(/\s+/).at(-1)?.replace(/\.$/, '')
      return exchange === undefined || exchange.length === 0 ? [] : [exchange.toLowerCase()]
    })
    return { mx: hosts.length > 0 ? { kind: 'records', hosts } : { kind: 'none' } }
  } catch {
    return { mx: { kind: 'error' } }
  }
}

/**
 * Device evidence plus the email's MX records.
 *
 * Only call this once something actually consumes `mx` — the MX lookup is
 * a live network round-trip on every cold signup, and collecting evidence no
 * rule reads costs latency in production and turns every test signup into a
 * DNS-dependent one.
 */
export async function collectEvidence(
  input: { email: string; device?: SignupDevice },
  deps: Deps,
): Promise<SignupEvidence> {
  const [device, mx] = await Promise.all([
    collectDeviceEvidence(input.device, deps),
    collectMxEvidence(input.email, deps),
  ])
  return { ...device, ...mx }
}

export function isStale(evidence: SignupEvidence, now: number): boolean {
  return (
    typeof evidence.eventTimestamp === 'number' &&
    now - evidence.eventTimestamp > MAX_REQUEST_AGE_MS
  )
}
