import { HumanEntryCodeSchema } from '@repo/contract'

import { matchesMagicLinkIntent } from './auth-code-proof'
import { clearMagicLinkIntentCookie } from './magic-link-intent'
import { safeReturnTo } from './return-to'

export function completeMagicLinkCallback(request: Request, intentCookie?: string): Response {
  const source = new URL(request.url)
  const returnTo = safeReturnTo(source.searchParams.get('returnTo') ?? undefined)
  const intent = source.searchParams.get('intent')
  const code = source.searchParams.get('code')
  const matches = matchesMagicLinkIntent(intent, intentCookie)
  const destination = new URL('/sign-in', source.origin)
  destination.searchParams.set('returnTo', returnTo)
  if (matches && intent !== null && code !== null && HumanEntryCodeSchema.safeParse(code).success) {
    destination.searchParams.set('code', code)
    destination.searchParams.set('intent', intent)
  } else {
    destination.searchParams.set('authError', 'invalid-link')
  }

  const headers = new Headers({ Location: destination.toString() })
  if (!matches) headers.set('Set-Cookie', clearMagicLinkIntentCookie(request.url))
  return new Response(null, { status: 307, headers })
}
