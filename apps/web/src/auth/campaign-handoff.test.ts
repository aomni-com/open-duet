import { expect, test } from 'bun:test'

import { campaignHandoffResponse, clearCampaignHandoffCookie } from './campaign-handoff'
import { completeBrowserSession } from './complete-browser-session'

test('the app handoff stores a host-only HttpOnly token and redirects to a scrubbed sign-in URL', () => {
  const token = 'k97fakeattributionrowid0000000001'
  const response = campaignHandoffResponse(
    new Request(`https://app.duet.so/api/campaigns/handoff?token=${token}`),
  )
  const cookie = response.headers.get('set-cookie')

  expect(response.status).toBe(303)
  expect(response.headers.get('location')).toBe('https://app.duet.so/sign-in')
  expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  expect(cookie).toContain(`duet_campaign_handoff=${token}`)
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('Secure')
  expect(cookie).toContain('SameSite=Lax')
  expect(cookie).toContain('Path=/')
  expect(cookie).not.toContain('Max-Age=')
  expect(cookie).not.toContain('Domain=')
  expect(response.headers.get('location')).not.toContain(token)
  expect(() => response.headers.set('x-mutable-response', 'yes')).not.toThrow()
})

test('the app transports future opaque handoff formats without interpreting them', () => {
  const token = 'v2~future_format~opaque-token'
  const response = campaignHandoffResponse(
    new Request(`https://app.duet.so/api/campaigns/handoff?token=${token}`),
  )

  expect(response.headers.get('set-cookie')).toContain(
    `duet_campaign_handoff=${encodeURIComponent(token)}`,
  )
})

test('successful bootstrap clears the transported acquisition token and keeps session response empty', async () => {
  const calls: unknown[] = []
  const response = await completeBrowserSession({
    request: sameOriginSessionRequest(),
    tokens: { acquisition: 'k97fakeattributionrowid0000000001' },
    bootstrap: async tokens => {
      calls.push(tokens)
      return { workspaceSlug: 'acme', invited: false }
    },
    exchange: async () => new Response(null, { status: 204 }),
  })

  expect(response.status).toBe(204)
  expect(await response.text()).toBe('')
  expect(calls).toEqual([{ acquisition: 'k97fakeattributionrowid0000000001' }])
  expect(response.headers.get('set-cookie')).toBe(clearCampaignHandoffCookie())
})

test('a real bootstrap failure retains acquisition for retry', async () => {
  const response = await completeBrowserSession({
    request: sameOriginSessionRequest(),
    tokens: { acquisition: 'k97fakeattributionrowid0000000001' },
    bootstrap: async () => {
      throw new Error('database unavailable')
    },
    exchange: async () => {
      throw new Error('must not exchange')
    },
  })

  expect(response.status).toBe(400)
  expect(response.headers.get('set-cookie')).toBeNull()
})

test('a sibling edge origin cannot bootstrap with the product-host cookie', async () => {
  let bootstrapped = false
  const response = await completeBrowserSession({
    request: new Request('https://app.duet.so/api/duet/session', {
      method: 'POST',
      headers: {
        origin: 'https://attacker.edge.duet.so',
        'sec-fetch-site': 'same-site',
      },
    }),
    tokens: { acquisition: 'k97fakeattributionrowid0000000001' },
    bootstrap: async () => {
      bootstrapped = true
      return { workspaceSlug: 'acme', invited: false }
    },
    exchange: async () => {
      throw new Error('must not exchange')
    },
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ error: 'cross_origin_request' })
  expect(bootstrapped).toBe(false)
})

function sameOriginSessionRequest(): Request {
  return new Request('https://app.duet.so/api/duet/session', {
    method: 'POST',
    headers: {
      origin: 'https://app.duet.so',
      'sec-fetch-site': 'same-origin',
    },
  })
}
