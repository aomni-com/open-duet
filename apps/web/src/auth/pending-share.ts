export const PENDING_SHARE_COOKIE = 'duet_pending_share'
export const PENDING_SHARE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
const SHARE_TOKEN_PATTERN = /^duet_share_[a-f0-9]{64}$/

export function normalizedPendingShareToken(token: string): string {
  return SHARE_TOKEN_PATTERN.test(token) ? token : 'invalid'
}

export function clearPendingShareCookie(): string {
  return `${PENDING_SHARE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
}

export async function consumePendingShareCookie(args: {
  token?: string
  resolve(token: string): Promise<Response>
}): Promise<Response> {
  const token = args.token === undefined ? undefined : normalizedPendingShareToken(args.token)
  const locallyTerminal = token === undefined || token === 'invalid'
  const resolved = locallyTerminal ? new Response(null, { status: 204 }) : await args.resolve(token)
  const response = new Response(resolved.body, {
    status: resolved.status,
    statusText: resolved.statusText,
    headers: resolved.headers,
  })
  if (locallyTerminal || resolved.ok || [400, 404, 410].includes(resolved.status)) {
    response.headers.append('set-cookie', clearPendingShareCookie())
  }
  return response
}
