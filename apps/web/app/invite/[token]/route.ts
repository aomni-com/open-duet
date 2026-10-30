import { NextResponse, type NextRequest } from 'next/server'

import {
  PENDING_INVITE_COOKIE,
  PENDING_INVITE_MAX_AGE_SECONDS,
  normalizedPendingInviteToken,
} from '../../../src/auth/pending-invite'

export function GET(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  return context.params.then(({ token }) => {
    const response = NextResponse.redirect(new URL('/sign-in?invited=1', request.url))
    response.cookies.set(PENDING_INVITE_COOKIE, normalizedPendingInviteToken(token), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: PENDING_INVITE_MAX_AGE_SECONDS,
    })
    return response
  })
}
