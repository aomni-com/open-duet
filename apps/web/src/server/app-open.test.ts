import { expect, test } from 'bun:test'

import { completeBrowserSession } from '../auth/complete-browser-session'
import { safeReturnTo } from '../auth/return-to'
import { isProtectedProductPath } from '../routing/product-routes'
import { openApp } from './app-open'
import { createDuetProxy } from './duet-proxy'

test('existing identity completion returns a private deep link through the protected bridge', async () => {
  const destination = '/w/acme/apps/todo/open?host=aomni.co&path=%2Fdeep%3Ftheme%3Ddark'
  expect(isProtectedProductPath(new URL(destination, 'https://web.example').pathname)).toBe(true)
  expect(safeReturnTo(destination)).toBe(destination)
  let received: Request | undefined
  const proxy = createDuetProxy({
    apiOrigin: 'https://ctl.example',
    now: () => 1_000,
    browserSessions: {
      mint: async () => ({ token: 'duet_sk_fixture', prefix: 'duet_sk_', expiresAt: 10_000_000 }),
      rotate: async () => null,
      revoke: async () => {},
    },
    fetch: async request => {
      received = request
      return new Response(null, {
        status: 302,
        headers: { location: 'https://aomni.co/deep?theme=dark&duet_access=fresh' },
      })
    },
  })
  const completed = await completeBrowserSession({
    request: new Request('https://web.example/api/session', {
      method: 'POST',
      headers: { origin: 'https://web.example' },
    }),
    bootstrap: async () => ({ workspaceSlug: 'acme', invited: false }),
    exchange: request => proxy.exchange(request),
  })
  expect(completed.status).toBe(204)
  const cookie = completed.headers.get('set-cookie')!.split(';')[0]!
  const response = await openApp(
    new Request(`https://web.example${safeReturnTo(destination)}`, { headers: { cookie } }),
    { workspaceSlug: 'acme', slug: 'todo' },
    proxy,
  )
  expect(response.status).toBe(302)
  expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
  expect(response.headers.get('location')).toBe(
    'https://aomni.co/deep?theme=dark&duet_access=fresh',
  )
  expect(received?.url).toBe(
    'https://ctl.example/v1/ws/acme/apps/todo/launch?host=aomni.co&path=%2Fdeep%3Ftheme%3Ddark',
  )
  expect(received?.headers.get('authorization')).toBe('Bearer duet_sk_fixture')
  expect(received?.headers.get('cookie')).toBeNull()
  expect(safeReturnTo('https://aomni.co/deep')).toBe('/')
})
