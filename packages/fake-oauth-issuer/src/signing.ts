/**
 * Every credential this issuer hands out is a signed, self-contained value:
 * device codes, access and refresh tokens, authorization codes, client ids and
 * registration access tokens alike. Nothing is ever stored, so any serverless
 * instance can consume a value minted by any other one.
 */
const SIGNING_KEY = new TextEncoder().encode('duet-fake-oauth-issuer-stateless-v1')
const signingKey = crypto.subtle.importKey(
  'raw',
  SIGNING_KEY,
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign', 'verify'],
)

export async function signValue(prefix: string, payload: unknown): Promise<string> {
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))
  const signature = await crypto.subtle.sign(
    'HMAC',
    await signingKey,
    new TextEncoder().encode(encoded),
  )
  return `${prefix}${encoded}.${base64UrlEncode(new Uint8Array(signature))}`
}

export async function verifyValue(prefix: string, value: string | undefined): Promise<unknown> {
  if (!value?.startsWith(prefix)) return undefined
  const [encoded, signature, extra] = value.slice(prefix.length).split('.')
  if (!encoded || !signature || extra !== undefined) return undefined
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await signingKey,
      base64UrlDecode(signature),
      new TextEncoder().encode(encoded),
    )
    if (!valid) return undefined
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded))) as unknown
  } catch {
    return undefined
  }
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return base64UrlEncode(new Uint8Array(digest))
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function base64UrlDecode(value: string): ArrayBuffer {
  return Uint8Array.from(Buffer.from(value, 'base64url')).buffer
}
