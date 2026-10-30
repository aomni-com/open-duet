import {
  convexAuthNextjsMiddleware,
  nextjsMiddlewareRedirect,
} from '@convex-dev/auth/nextjs/server'
import { NextRequest, NextResponse, type NextFetchEvent } from 'next/server'

import { IDENTITY_SESSION_INACTIVE_MS } from '@repo/contract'

import { resolveAuthCodeProof } from './src/auth/auth-code-proof'
import { oauthVerifierCookieName } from './src/auth/auth-cookie-names'
import { clearMagicLinkIntentCookie, magicLinkIntentCookieName } from './src/auth/magic-link-intent'
import {
  shouldHandleAuthCode,
  usesAuthMiddleware,
  usesInternalAdminDuetSession,
} from './src/auth/middleware-routing'
import { safeReturnTo } from './src/auth/return-to'
import { withProductLocation } from './src/routing/product-request-path'
import { isProtectedProductPath } from './src/routing/product-routes'

const authMiddleware = convexAuthNextjsMiddleware(
  async (request, { convexAuth }) => {
    const pathname = request.nextUrl.pathname
    const protectedRoute = isProtectedProductPath(pathname)
    if (!protectedRoute || (await convexAuth.isAuthenticated())) return
    const returnTo = safeReturnTo(`${pathname}${request.nextUrl.search}`)
    return nextjsMiddlewareRedirect(request, `/sign-in?returnTo=${encodeURIComponent(returnTo)}`)
  },
  {
    shouldHandleCode: request =>
      shouldHandleAuthCode(request.nextUrl.pathname, authCodeProof(request) !== undefined),
    // Without a max-age the identity cookies are session cookies, gone when
    // the browser quits; the refresh token they carry outlives that by weeks.
    // Every refresh re-sets them, so the deadline slides with use.
    cookieConfig: { maxAge: IDENTITY_SESSION_INACTIVE_MS / 1000 },
  },
)

export default async function proxy(request: NextRequest, event: NextFetchEvent) {
  const { pathname } = request.nextUrl

  if (pathname === '/sign-in' && request.nextUrl.searchParams.has('code')) {
    const proof = authCodeProof(request)
    if (proof === undefined) return rejectUnprovenAuthCode(request)
    if (proof === 'magic-link') request.cookies.delete(oauthVerifierCookieName(request.url))
    const response = await authMiddleware(request, event)
    if (!(response instanceof Response)) throw new Error('Auth code exchange did not respond')
    const destination = request.nextUrl.clone()
    destination.searchParams.delete('code')
    destination.searchParams.delete('intent')
    destination.searchParams.set('authReturn', proof)
    response.headers.set('Location', destination.toString())
    if (proof === 'magic-link') {
      response.headers.append('Set-Cookie', clearMagicLinkIntentCookie(request.url))
    }
    return response
  }

  const forwardedRequest = isProtectedProductPath(pathname)
    ? new NextRequest(request, {
        headers: withProductLocation(request.headers, pathname, request.nextUrl.search),
      })
    : request

  if (usesInternalAdminDuetSession(pathname, request.cookies.has('duet_session'))) {
    return NextResponse.next({ request: { headers: forwardedRequest.headers } })
  }
  if (usesAuthMiddleware(pathname)) return authMiddleware(forwardedRequest, event)

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}

function authCodeProof(request: NextRequest) {
  return resolveAuthCodeProof({
    pathname: request.nextUrl.pathname,
    code: request.nextUrl.searchParams.get('code'),
    intent: request.nextUrl.searchParams.get('intent'),
    intentCookie: request.cookies.get(magicLinkIntentCookieName(request.url))?.value,
    oauthVerifierCookie: request.cookies.get(oauthVerifierCookieName(request.url))?.value,
  })
}

function rejectUnprovenAuthCode(request: NextRequest): NextResponse {
  const destination = request.nextUrl.clone()
  destination.searchParams.delete('code')
  destination.searchParams.delete('intent')
  destination.searchParams.set('authError', 'invalid-link')
  const response = NextResponse.redirect(destination, 307)
  response.headers.append('Set-Cookie', clearMagicLinkIntentCookie(request.url))
  return response
}
