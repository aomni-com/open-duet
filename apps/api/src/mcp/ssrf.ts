import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import type { FetchLike } from '@repo/contract'

/**
 * The one owner of "may Duet's control plane fetch this URL?".
 *
 * `SECURITY.md` reasons about this class of hole in the mirror direction — Duet
 * deliberately never fetches a client-metadata document, "so there is no
 * client-metadata SSRF surface" — and its one-trust-domain rule covers the
 * workspace VM, where a user already has a shell. Neither reaches here: a
 * custom MCP server's URL is user-supplied and the fetch happens in `apps/api`,
 * inside the control plane, next to the metadata service and the private
 * network. So the URL is checked before every hop, not once at registration.
 *
 * Every network call this feature makes on a user-supplied address — the MCP
 * probe, the RFC 9728 resource-metadata lookup, the authorization-server
 * metadata lookup, and later the proxy — goes through `guardedFetch`. A second
 * unguarded `fetch` on a user-supplied URL anywhere in this feature is a bug.
 */

export type BlockedUpstreamReason =
  | 'invalid_url'
  | 'not_https'
  | 'private_address'
  | 'unresolvable'
  | 'cross_origin_redirect'
  | 'too_many_redirects'

export class BlockedUpstreamUrlError extends Error {
  constructor(
    readonly reason: BlockedUpstreamReason,
    readonly url: string,
  ) {
    super(`blocked upstream url (${reason})`)
    this.name = 'BlockedUpstreamUrlError'
  }
}

/** Resolve a hostname to every address a connect could land on. */
export type HostResolver = (hostname: string) => Promise<string[]>

export const resolveHostAddresses: HostResolver = async hostname => {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map(record => record.address)
}

/**
 * A redirect chain long enough to be a loop is long enough to be an attack.
 * Real MCP servers redirect at most once, from a bare path to a canonical one.
 */
const MAX_REDIRECTS = 4

export async function requirePublicHttpsUrl(
  raw: string | URL,
  resolve: HostResolver = resolveHostAddresses,
): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new BlockedUpstreamUrlError('invalid_url', String(raw))
  }
  if (url.protocol !== 'https:') throw new BlockedUpstreamUrlError('not_https', url.toString())

  // A bracketed literal is an address the caller chose directly; everything
  // else is a name whose ANSWER is what a connect will use. Both end in the
  // same predicate, because a name that resolves inward is the same reach with
  // one step of indirection.
  const host = url.hostname.replace(/^\[|]$/g, '')
  const addresses = isIP(host) !== 0 ? [host] : await resolveAddresses(url, host, resolve)
  if (addresses.length === 0) throw new BlockedUpstreamUrlError('unresolvable', url.toString())
  // Every answer must be public, not merely the first: a connect is free to
  // pick any of them.
  if (!addresses.every(isPublicUnicastAddress)) {
    throw new BlockedUpstreamUrlError('private_address', url.toString())
  }
  return url
}

async function resolveAddresses(url: URL, host: string, resolve: HostResolver): Promise<string[]> {
  try {
    return await resolve(host)
  } catch {
    throw new BlockedUpstreamUrlError('unresolvable', url.toString())
  }
}

/**
 * `fetch`, with the guard in front of every hop.
 *
 * Redirects are handled here rather than by the platform because a followed
 * redirect is a second fetch to a second address, and the platform performs it
 * without asking. `manual` turns each hop back into a URL this module can
 * check. The re-follow is same-origin only: a cross-origin redirect is refused
 * outright rather than re-checked, because "the address is public" is not the
 * property that matters once a server can point Duet's credential-bearing
 * request at somebody else's host.
 */
export function guardedFetch(
  fetchImpl: FetchLike,
  resolve: HostResolver = resolveHostAddresses,
): FetchLike {
  return async (input, init) => {
    const first = await requirePublicHttpsUrl(urlOf(input), resolve)
    const origin = first.origin
    let target = first.toString()

    for (let hop = 0; ; hop += 1) {
      const response = await fetchImpl(target, { ...init, redirect: 'manual' })
      const location = response.headers.get('location')
      if (!isRedirect(response.status) || location === null) return response
      if (hop >= MAX_REDIRECTS) {
        throw new BlockedUpstreamUrlError('too_many_redirects', target)
      }
      const next = new URL(location, target)
      if (next.origin !== origin) {
        throw new BlockedUpstreamUrlError('cross_origin_redirect', next.toString())
      }
      // Same origin still gets the full check: the guard's contract is that no
      // request leaves without one, and DNS can answer differently per lookup.
      target = (await requirePublicHttpsUrl(next, resolve)).toString()
    }
  }
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/**
 * True only for addresses that route on the public internet. Written as an
 * allowlist of "not special" rather than a denylist of known-bad ranges: a
 * denylist that forgets one range is a hole, and IANA keeps adding ranges.
 */
function isPublicUnicastAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) return isPublicIpv4(parseIpv4(address))
  if (version === 6) return isPublicIpv6(address)
  return false
}

function parseIpv4(address: string): number[] {
  return address.split('.').map(part => Number.parseInt(part, 10))
}

function isPublicIpv4(bytes: number[]): boolean {
  const [a = 0, b = 0, c = 0] = bytes
  if (a === 0) return false // "this network"
  if (a === 10) return false // RFC 1918
  if (a === 127) return false // loopback
  if (a === 100 && b >= 64 && b <= 127) return false // RFC 6598 carrier-grade NAT
  if (a === 169 && b === 254) return false // link-local, incl. the metadata service
  if (a === 172 && b >= 16 && b <= 31) return false // RFC 1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false // IETF protocol / TEST-NET-1
  if (a === 192 && b === 168) return false // RFC 1918
  if (a === 198 && (b === 18 || b === 19)) return false // benchmarking
  if (a === 198 && b === 51 && c === 100) return false // TEST-NET-2
  if (a >= 224) return false // multicast, reserved, broadcast
  return true
}

function isPublicIpv6(address: string): boolean {
  const words = expandIpv6(address)
  if (words === null) return false
  // An IPv4-mapped or IPv4-compatible address is an IPv4 address wearing a
  // costume; judging it as v6 would wave `::ffff:127.0.0.1` straight through.
  const embedded = embeddedIpv4(words)
  if (embedded !== null) return isPublicIpv4(embedded)
  if (words.every(word => word === 0)) return false // unspecified
  const [first = 0] = words
  if ((first & 0xfe00) === 0xfc00) return false // unique local
  if ((first & 0xffc0) === 0xfe80) return false // link-local
  if ((first & 0xff00) === 0xff00) return false // multicast
  return true
}

/** The eight 16-bit words of an address, `::` expanded. */
function expandIpv6(address: string): number[] | null {
  const [head, tail, ...rest] = address.split('::')
  if (rest.length > 0) return null
  const parse = (part: string | undefined): number[] =>
    part === undefined || part === ''
      ? []
      : part.split(':').flatMap(group =>
          group.includes('.')
            ? // A trailing dotted quad is two words.
              ipv4Words(group)
            : [Number.parseInt(group, 16)],
        )
  const left = parse(head)
  const right = parse(tail)
  if (tail === undefined) return left.length === 8 ? left : null
  const gap = 8 - left.length - right.length
  if (gap < 0) return null
  return [...left, ...Array.from({ length: gap }, () => 0), ...right]
}

function ipv4Words(dotted: string): number[] {
  const [a = 0, b = 0, c = 0, d = 0] = parseIpv4(dotted)
  return [(a << 8) | b, (c << 8) | d]
}

function embeddedIpv4(words: number[]): number[] | null {
  const leading = words.slice(0, 5)
  const [sixth = 0, seventh = 0, eighth = 0] = words.slice(5)
  if (!leading.every(word => word === 0)) return null
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, deprecated but honoured
  // by resolvers) both put the v4 address in the last two words.
  if (sixth !== 0xffff && sixth !== 0) return null
  if (sixth === 0 && seventh === 0 && eighth === 0) return null
  return [seventh >> 8, seventh & 0xff, eighth >> 8, eighth & 0xff]
}
