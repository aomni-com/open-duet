import { MAGIC_LINK_CALLBACK_PATH } from '@repo/contract'

import { clearOAuthVerifierCookie } from './auth-cookie-names'
import { safeReturnTo } from './return-to'

/**
 * The intent nonce, and only the nonce.
 *
 * This used to double as the verification code's pattern, which made the two
 * concepts inseparable: they shared a shape only because the codes Convex Auth
 * minted happened to be 32 hex characters too. The code is a human-typed
 * `XXXX-XXXX` now, so a single constant would have rejected every browser
 * sign-in. The nonce stays hex because nobody ever reads it aloud.
 */
export const MAGIC_LINK_INTENT_PATTERN = /^[a-f0-9]{32}$/
const MAGIC_LINK_INTENT_MAX_AGE_SECONDS = 60 * 60

export interface MagicLinkStart {
  email: string
  redirectTo: string
}

export type SendMagicLink = (start: MagicLinkStart) => Promise<void>

export async function createMagicLinkIntent(
  request: Request,
  send: SendMagicLink,
  generateIntent: () => string = () => crypto.randomUUID().replaceAll('-', ''),
): Promise<Response> {
  const requestUrl = new URL(request.url)
  if (request.headers.get('origin') !== requestUrl.origin) {
    return Response.json({ error: 'Cross-origin request rejected' }, { status: 403 })
  }
  const body = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') return invalidRequest()
  const { email: candidate, returnTo: requestedReturnTo } = body as Record<string, unknown>
  if (typeof candidate !== 'string' || !isEmail(candidate.trim())) return invalidRequest()
  if (requestedReturnTo !== undefined && typeof requestedReturnTo !== 'string') {
    return invalidRequest()
  }

  const email = candidate.trim()
  const returnTo = safeReturnTo(requestedReturnTo)
  const intent = generateIntent()
  if (!MAGIC_LINK_INTENT_PATTERN.test(intent)) throw new Error('Invalid magic-link intent')

  await send({
    email,
    redirectTo: new URL(
      `${MAGIC_LINK_CALLBACK_PATH}?returnTo=${encodeURIComponent(returnTo)}&intent=${intent}`,
      requestUrl.origin,
    ).toString(),
  })

  const headers = new Headers()
  headers.append('Set-Cookie', intentCookie(request.url, intent))
  headers.append('Set-Cookie', clearOAuthVerifierCookie(request.url))
  return new Response(null, { status: 204, headers })
}

function isEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function invalidRequest(): Response {
  return Response.json({ error: 'A valid email is required' }, { status: 400 })
}

function intentCookie(requestUrl: string, intent: string): string {
  const secure = new URL(requestUrl).protocol === 'https:'
  return [
    `${magicLinkIntentCookieName(requestUrl)}=${intent}`,
    'Path=/',
    `Max-Age=${MAGIC_LINK_INTENT_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ')
}

export function clearMagicLinkIntentCookie(requestUrl: string): string {
  const secure = new URL(requestUrl).protocol === 'https:'
  return [
    `${magicLinkIntentCookieName(requestUrl)}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ')
}

export function magicLinkIntentCookieName(requestUrl: string): string {
  return new URL(requestUrl).protocol === 'https:'
    ? '__Host-duet_magic_link_intent'
    : 'duet_magic_link_intent'
}
