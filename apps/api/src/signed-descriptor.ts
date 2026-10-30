import { Buffer } from 'node:buffer'

/**
 * A short-lived, self-describing blob Duet hands to a third party and gets back.
 *
 * Two callbacks depend on this shape: Composio's OAuth return
 * (`routes/composio-oauth.ts`, which puts it in a `nonce` query parameter
 * because Composio builds the authorize URL) and the custom MCP server consent
 * return (`mcp/oauth.ts`, where Duet builds the URL and so the descriptor *is*
 * the OAuth `state`). They differ in where the blob rides and what it says;
 * they must not differ in how it is signed or how strictly it is read back.
 *
 * `hasExactlyKeys` is the part that is easy to leave out and expensive to lack:
 * without it a descriptor from an older version, or one a caller has bolted a
 * field onto, parses partially and takes a branch nobody wrote. With it, an
 * unrecognized shape is simply not a descriptor.
 */

const SEPARATOR = '.'

export async function encodeSignedDescriptor(payload: object, secret: string): Promise<string> {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload))
  return `${encodedPayload}${SEPARATOR}${await sign(encodedPayload, secret)}`
}

/**
 * The signature check and nothing else. What the payload has to CONTAIN is the
 * caller's question — one descriptor kind's required keys are not another's —
 * so this returns the record and leaves that judgment where the type lives.
 */
export async function decodeSignedDescriptor(
  value: string | undefined,
  secret: string,
): Promise<Record<string, unknown> | null> {
  if (value === undefined) return null
  const [encodedPayload, signature, extra] = value.split(SEPARATOR)
  if (!encodedPayload || !signature || extra !== undefined) return null
  if (!(await verify(encodedPayload, signature, secret))) return null
  try {
    const payload: unknown = JSON.parse(base64UrlDecode(encodedPayload))
    return isRecord(payload) ? payload : null
  } catch {
    return null
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await signingKey(secret, ['sign'])
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  return base64UrlEncodeBytes(new Uint8Array(bytes))
}

async function verify(value: string, signature: string, secret: string): Promise<boolean> {
  try {
    const key = await signingKey(secret, ['verify'])
    return await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlDecodeBytes(signature),
      new TextEncoder().encode(value),
    )
  } catch {
    return false
  }
}

async function signingKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  )
}

function base64UrlEncode(value: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(value))
}

function base64UrlEncodeBytes(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

function base64UrlDecode(value: string): string {
  return new TextDecoder().decode(base64UrlDecodeBytes(value))
}

function base64UrlDecodeBytes(value: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(value, 'base64url')
  const bytes = new Uint8Array(decoded.length)
  bytes.set(decoded)
  return bytes
}
