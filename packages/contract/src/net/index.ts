// The one vocabulary of endpoints an unauthenticated caller can be limited on.
// The API names a bucket from it, the Convex mutation validates against it, and
// the stored key embeds it — so a name that lives in only two of the three is a
// runtime rejection with green types.
export const PRE_AUTH_RATE_LIMIT_ENDPOINTS = [
  'device_code',
  'device_token',
  'feedback',
  'oauth_metadata',
  'oauth_register',
  'oauth_authorize',
  'oauth_token',
  'auth_email_start',
  'auth_email_verify',
] as const

export type PreAuthRateLimitEndpoint = (typeof PRE_AUTH_RATE_LIMIT_ENDPOINTS)[number]

export function isPreAuthRateLimitEndpoint(value: string): value is PreAuthRateLimitEndpoint {
  return (PRE_AUTH_RATE_LIMIT_ENDPOINTS as readonly string[]).includes(value)
}

export function assertPublicHttpUrl(raw: string): URL {
  const parsed = new URL(raw)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    throw new Error('Only http(s) URLs can be trained.')
  parsed.username = ''
  parsed.password = ''
  const hostname = normalizedHostname(parsed.hostname)
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    isPrivateOrReservedIp(hostname)
  ) {
    throw new Error('URL host is not allowed for training.')
  }
  return parsed
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const normalized = normalizedHostname(ip)
  const ipv4 = parseIpv4(normalized)
  if (ipv4 !== null) return isPrivateOrReservedIpv4(ipv4)
  const ipv6 = parseIpv6(normalized)
  if (ipv6 === null) return false
  const mapped = ipv4FromMappedIpv6(ipv6)
  if (mapped !== null) return isPrivateOrReservedIpv4(mapped)
  return (
    ipv6 === 0n ||
    ipv6 === 1n ||
    (ipv6 & 0xfe00_0000_0000_0000_0000_0000_0000_0000n) ===
      0xfc00_0000_0000_0000_0000_0000_0000_0000n ||
    (ipv6 & 0xffc0_0000_0000_0000_0000_0000_0000_0000n) ===
      0xfe80_0000_0000_0000_0000_0000_0000_0000n
  )
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1')
}

function parseIpv4(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
    value = (value << 8) | octet
  }
  return value >>> 0
}

function isPrivateOrReservedIpv4(ip: number): boolean {
  return (
    maskedIpv4(ip, 0xff00_0000) === 0x0000_0000 ||
    maskedIpv4(ip, 0xff00_0000) === 0x0a00_0000 ||
    maskedIpv4(ip, 0xff00_0000) === 0x7f00_0000 ||
    maskedIpv4(ip, 0xffc0_0000) === 0x6440_0000 ||
    maskedIpv4(ip, 0xfff0_0000) === 0xac10_0000 ||
    maskedIpv4(ip, 0xffff_0000) === 0xa9fe_0000 ||
    maskedIpv4(ip, 0xffff_0000) === 0xc0a8_0000 ||
    ip === 0xffff_ffff
  )
}

function maskedIpv4(ip: number, mask: number): number {
  return (ip & mask) >>> 0
}

function parseIpv6(ip: string): bigint | null {
  if (ip.length === 0) return null
  const ipv4 = ip.includes('.') ? trailingIpv4Groups(ip) : null
  const normalized = ipv4 === null ? ip : ipv4.prefix
  const halves = normalized.split('::')
  if (halves.length > 2) return null
  const head = parseIpv6Groups(halves[0] ?? '')
  const tail = parseIpv6Groups(halves[1] ?? '')
  if (head === null || tail === null) return null
  const ipv4Groups = ipv4 === null ? [] : ipv4.groups
  if (halves.length === 1 && head.length + ipv4Groups.length !== 8) return null
  if (halves.length === 2 && head.length + tail.length + ipv4Groups.length >= 8) return null
  const zeroCount = halves.length === 2 ? 8 - head.length - tail.length - ipv4Groups.length : 0
  const groups = [...head, ...Array(zeroCount).fill(0), ...tail, ...ipv4Groups]
  if (groups.length !== 8) return null
  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n)
}

function trailingIpv4Groups(ip: string): { prefix: string; groups: number[] } | null {
  const colon = ip.lastIndexOf(':')
  if (colon === -1) return null
  const ipv4 = parseIpv4(ip.slice(colon + 1))
  if (ipv4 === null) return null
  return {
    prefix: ip.slice(0, colon),
    groups: [(ipv4 >>> 16) & 0xffff, ipv4 & 0xffff],
  }
}

function parseIpv6Groups(value: string): number[] | null {
  if (value.length === 0) return []
  const groups: number[] = []
  for (const group of value.split(':')) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
    groups.push(Number.parseInt(group, 16))
  }
  return groups
}

function ipv4FromMappedIpv6(ipv6: bigint): number | null {
  if (ipv6 >> 32n !== 0xffffn) return null
  return Number(ipv6 & 0xffff_ffffn)
}
