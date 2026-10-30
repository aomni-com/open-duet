import createMiddleware from 'next-intl/middleware'
import { NextResponse, type NextRequest } from 'next/server'

import { routing } from './i18n/routing'
import { publicRedirectTarget, shouldBypassI18n } from './lib/i18n/path-classification'
import { mdRewriteTarget } from './lib/llms/md-url'
import { getLanderOrigin } from './src/config/origins'

const intlMiddleware = createMiddleware(routing)
const LEGACY_PRODUCTION_HOST = 'lander.duet.so'
const CANONICAL_PRODUCTION_ORIGIN = getLanderOrigin('production')

export default function proxy(request: NextRequest) {
  if (request.nextUrl.hostname === LEGACY_PRODUCTION_HOST) {
    return NextResponse.redirect(
      new URL(request.nextUrl.pathname + request.nextUrl.search, CANONICAL_PRODUCTION_ORIGIN),
      308,
    )
  }

  const { pathname } = request.nextUrl

  // `/<route>.md` is the agent-readable twin of `/<route>`. It is served from
  // its own `/md/*` segment (see `app/md/[...path]/route.ts`) and rewritten
  // here rather than routed directly, so the twins never compete with the
  // localized page tree for a URL.
  const mdTarget = mdRewriteTarget(pathname)
  if (mdTarget !== null) {
    const url = request.nextUrl.clone()
    url.pathname = mdTarget
    return NextResponse.rewrite(url)
  }

  const redirectTarget = publicRedirectTarget(pathname)
  if (redirectTarget !== null) {
    const url = request.nextUrl.clone()
    url.pathname = redirectTarget
    return NextResponse.redirect(url, 308)
  }
  if (shouldBypassI18n(pathname)) return NextResponse.next()
  return intlMiddleware(request)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
