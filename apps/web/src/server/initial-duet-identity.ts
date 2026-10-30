import { Buffer } from 'node:buffer'

import {
  BROWSER_SESSION_ROTATE_BEFORE_MS,
  BrowserSessionCredentialSchema,
  WhoamiResponseSchema,
  type WhoamiResponse,
} from '@repo/contract'

type WhoamiProxy = (request: Request) => Promise<Response>

/**
 * Reuses the browser-session cookie established by the sign-in handoff so the
 * first product document can contain the real shell. A missing, stale, or
 * malformed session deliberately falls back to the client bootstrap path.
 */
export async function loadInitialDuetIdentity(
  cookieHeader: string | undefined,
  proxyWhoami: WhoamiProxy,
  now: () => number = Date.now,
): Promise<WhoamiResponse | undefined> {
  if (cookieHeader === undefined || !hasStableBrowserSession(cookieHeader, now())) return undefined

  try {
    const response = await proxyWhoami(
      new Request('https://app.duet.local/api/duet/whoami', {
        method: 'GET',
        headers: { cookie: cookieHeader },
      }),
    )
    if (!response.ok) return undefined
    const parsed = WhoamiResponseSchema.safeParse(await response.json())
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

function hasStableBrowserSession(cookieHeader: string, now: number): boolean {
  const value = cookieHeader
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith('duet_session='))
    ?.slice('duet_session='.length)
  if (value === undefined || value.length === 0) return false

  try {
    const session = BrowserSessionCredentialSchema.parse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    )
    // The proxy rotates credentials inside this window. Server Components
    // cannot forward that Set-Cookie, so leave rotation to the browser path.
    return session.expiresAt > now + BROWSER_SESSION_ROTATE_BEFORE_MS
  } catch {
    return false
  }
}
