export const CAMPAIGN_HANDOFF_COOKIE = 'duet_campaign_handoff'

const OPAQUE_HANDOFF_PATTERN = /^[A-Za-z0-9._~-]+$/
const MAX_ENCODED_HANDOFF_COOKIE_BYTES = 3_500

export function campaignHandoffResponse(request: Request): Response {
  const url = new URL(request.url)
  const token = url.searchParams.get('token')
  const response = new Response(null, {
    status: 303,
    headers: {
      location: new URL('/sign-in', url.origin).toString(),
      'referrer-policy': 'no-referrer',
    },
  })
  response.headers.append(
    'set-cookie',
    token !== null &&
      OPAQUE_HANDOFF_PATTERN.test(token) &&
      new TextEncoder().encode(encodeURIComponent(token)).byteLength <=
        MAX_ENCODED_HANDOFF_COOKIE_BYTES
      ? campaignHandoffCookie(token)
      : clearCampaignHandoffCookie(),
  )
  return response
}

export function clearCampaignHandoffCookie(): string {
  return `${CAMPAIGN_HANDOFF_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
}

function campaignHandoffCookie(token: string): string {
  return [
    `${CAMPAIGN_HANDOFF_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ')
}
