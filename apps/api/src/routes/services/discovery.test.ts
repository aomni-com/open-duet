import { expect, test } from 'bun:test'
import { Hono } from 'hono'

import type { ApiRouteRuntime, ApiVariables } from '../../shared'
import { registerServiceProxyRoutes } from './index'

test('service discovery uses an opaque filter-bound cursor', async () => {
  const app = new Hono<{ Variables: ApiVariables }>()
  registerServiceProxyRoutes(app, { internalKey: 'test', convex: {} } as unknown as ApiRouteRuntime, {
    fetchImpl: fetch,
    waitUntil: promise => void promise,
  })

  const first = await app.request('/v1/services?limit=1')
  expect(first.status).toBe(200)
  const firstBody = (await first.json()) as { items: Array<{ id: string }>; nextCursor: string | null }
  expect(firstBody.items).toHaveLength(1)
  expect(firstBody.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/)

  const second = await app.request(`/v1/services?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor!)}`)
  expect(second.status).toBe(200)
  expect((await second.json()).items).toHaveLength(1)

  const mismatched = await app.request(`/v1/services?q=audio&limit=1&cursor=${encodeURIComponent(firstBody.nextCursor!)}`)
  expect(mismatched.status).toBe(400)
  expect(await mismatched.json()).toEqual({ error: 'invalid_cursor' })
})
