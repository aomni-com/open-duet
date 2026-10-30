import { NextResponse, type NextRequest } from 'next/server'

import {
  PENDING_SHARE_COOKIE,
  PENDING_SHARE_MAX_AGE_SECONDS,
  normalizedPendingShareToken,
} from '../../../src/auth/pending-share'

export function GET(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  return context.params.then(({ token }) => {
    const response = NextResponse.redirect(
      new URL('/sign-in?shared=1&returnTo=%2F%3Fshared%3D1', request.url),
    )
    response.cookies.set(PENDING_SHARE_COOKIE, normalizedPendingShareToken(token), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: PENDING_SHARE_MAX_AGE_SECONDS,
    })
    return response
  })
}
