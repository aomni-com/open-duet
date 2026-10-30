import { cookies } from 'next/headers'

import { completeMagicLinkCallback } from '../../../../src/auth/magic-link-callback'
import { magicLinkIntentCookieName } from '../../../../src/auth/magic-link-intent'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request): Promise<Response> {
  const cookieStore = await cookies()
  return completeMagicLinkCallback(
    request,
    cookieStore.get(magicLinkIntentCookieName(request.url))?.value,
  )
}
