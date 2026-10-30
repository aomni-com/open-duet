import { expect, test } from 'bun:test'

import { LANDER_ORIGIN } from '@/lib/i18n/metadata'
import { getShardEntries, SHARD_IDS } from '@/lib/seo/sitemap-shards'

import { getLlmsRoutes } from './routes'

async function sitemapEnglishPaths(): Promise<Set<string>> {
  const paths = new Set<string>()
  for (const id of SHARD_IDS) {
    for (const entry of await getShardEntries(id)) {
      const path = String(entry.url).slice(LANDER_ORIGIN.length)
      if (path.startsWith('/es/') || path === '/es') continue
      paths.add(path)
    }
  }
  return paths
}

test('publishes only URLs the sitemap already owns, so there is one route enumeration', async () => {
  const sitemap = await sitemapEnglishPaths()
  const extras = (await getLlmsRoutes())
    .map(route => route.path)
    .filter(path => path !== '/install' && !sitemap.has(path))

  expect(extras).toEqual([])
})

test('carries the homepage as the overview and never a Spanish duplicate', async () => {
  const routes = await getLlmsRoutes()

  expect(routes.find(route => route.path === '/')).toEqual({ path: '/', kind: 'overview' })
  expect(routes.filter(route => route.path.startsWith('/es'))).toEqual([])
})

test('classifies each page by the body source that owns its copy', async () => {
  const byPath = new Map((await getLlmsRoutes()).map(route => [route.path, route.kind]))

  expect(byPath.get('/blog/claude-code-vs-cursor-vs-codex')).toBe('editorial')
  expect(byPath.get('/for/roofers')).toBe('vertical')
  expect(byPath.get('/vs/claude-code')).toBe('comparison')
  expect(byPath.get('/vs')).toBe('marketing')
  expect(byPath.get('/use-cases/small-businesses')).toBe('use-case')
  expect(byPath.get('/use-cases/small-businesses/shopify-store')).toBe('use-case')
  expect(byPath.get('/use-cases/by-job/invoicing')).toBe('use-case')
  // Hubs are index pages, not spec nodes.
  expect(byPath.get('/use-cases/by-job')).toBe('marketing')
  expect(byPath.get('/pricing')).toBe('marketing')
  expect(byPath.get('/install')).toBe('marketing')
})
