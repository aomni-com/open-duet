import { expect, test } from 'bun:test'

import { DEPLOYED_PUBLIC_ROUTE_MANIFEST, PUBLIC_ROUTE_MANIFEST } from '@/src/public-route-manifest'

import { GET } from './route'

test('serializes the public route owner for deployed acceptance', async () => {
  const response = GET()

  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('application/json')
  expect(response.headers.get('cache-control')).toContain('public')
  expect(await response.json()).toEqual({
    schemaVersion: 2,
    routes: DEPLOYED_PUBLIC_ROUTE_MANIFEST,
  })
})

test('declares consolidated Spanish routes as permanent redirects', async () => {
  const artifact = (await GET().json()) as {
    routes: Array<{ path: string; kind: string; status: number; redirectTo?: string }>
  }

  expect(
    artifact.routes.find(route => route.path === '/es/blog/claude-code-vs-cursor-vs-codex'),
  ).toEqual({
    path: '/es/blog/claude-code-vs-cursor-vs-codex',
    kind: 'editorial',
    status: 308,
    redirectTo: '/blog/claude-code-vs-cursor-vs-codex',
  })
})

test('keeps public tag paths URL-safe without changing their prerender owner', () => {
  expect(PUBLIC_ROUTE_MANIFEST).toContainEqual({
    publicPath: '/blog/tag/agent%20builders',
    prerenderPath: '/en/blog/tag/agent builders',
    kind: 'editorial',
  })
  expect(PUBLIC_ROUTE_MANIFEST.some(route => route.publicPath.includes(' '))).toBeFalse()
})
