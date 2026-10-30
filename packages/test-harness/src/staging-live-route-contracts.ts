import assert from 'node:assert/strict'

import { decodeXml } from '../../../scripts/xml.ts'
import { safeRequestTarget } from './staging-live-artifacts.ts'

export type DeployedPublicLanderRoute = {
  path: string
  kind: 'marketing' | 'editorial' | 'campaign' | 'preserved'
  status: 200 | 308
  redirectTo?: string
}

export type DeployedProductRoute = {
  path: string
  destination:
    | 'root'
    | 'workspace-root'
    | 'sessions'
    | 'apps'
    | 'files'
    | 'jobs'
    | 'train'
    | 'integrations'
    | 'workspaceSettings'
    | 'userSettings'
    | 'internalAdmin'
}

export function assertProductRouteArtifact(
  value: unknown,
  params: { workspaceSlug: string; sessionId: string },
): DeployedProductRoute[] {
  assert(value !== null && typeof value === 'object', 'product route artifact was not an object')
  const artifact = value as { schemaVersion?: unknown; routes?: unknown }
  assert.equal(artifact.schemaVersion, 1, 'product route artifact schema changed')
  assert(Array.isArray(artifact.routes), 'product route artifact omitted routes')

  const destinations = new Set([
    'root',
    'workspace-root',
    'sessions',
    'files',
    'jobs',
    'train',
    'integrations',
    'workspaceSettings',
    'userSettings',
    'internalAdmin',
  ])
  const routes = artifact.routes.map((value, index) => {
    assert(value !== null && typeof value === 'object', `product route ${index} was invalid`)
    const route = value as Record<string, unknown>
    assert(
      typeof route.template === 'string' && isCanonicalPublicPath(route.template),
      `product route ${index} had an invalid template`,
    )
    assert(
      typeof route.destination === 'string' && destinations.has(route.destination),
      `product route ${route.template} had an invalid destination`,
    )
    const path = route.template
      .replaceAll(':workspaceSlug', encodeURIComponent(params.workspaceSlug))
      .replaceAll(':sessionId', encodeURIComponent(params.sessionId))
    assert(
      isCanonicalPublicPath(path) && !path.includes(':'),
      `product route ${route.template} retained an unresolved parameter`,
    )
    return { path, destination: route.destination } as DeployedProductRoute
  })
  assert.equal(
    new Set(routes.map(route => route.path)).size,
    routes.length,
    'product route artifact contained duplicate paths',
  )
  return routes
}

export function assertPublicLanderRouteArtifact(
  value: unknown,
  sitemapRoutes: string[],
): DeployedPublicLanderRoute[] {
  assert(value !== null && typeof value === 'object', 'public route artifact was not an object')
  const artifact = value as { schemaVersion?: unknown; routes?: unknown }
  assert.equal(artifact.schemaVersion, 2, 'public route artifact schema changed')
  assert(Array.isArray(artifact.routes), 'public route artifact omitted routes')

  const routes = artifact.routes.map((value, index) => {
    assert(
      value !== null && typeof value === 'object',
      `public route artifact route ${index} was invalid`,
    )
    const route = value as Record<string, unknown>
    const publicPath = route.path
    assert(typeof publicPath === 'string', `public route artifact route ${index} was not a path`)
    assert(
      isCanonicalPublicPath(publicPath),
      `public route artifact contained invalid path ${publicPath}`,
    )
    assert(
      ['marketing', 'editorial', 'campaign', 'preserved'].includes(String(route.kind)),
      `public route artifact ${publicPath} had invalid kind`,
    )
    assert(
      route.status === 200 || route.status === 308,
      `public route artifact ${publicPath} had invalid status`,
    )
    if (route.status === 200) {
      assert.equal(
        route.redirectTo,
        undefined,
        `public route artifact ${publicPath} declared an unexpected redirect target`,
      )
    } else {
      assert(
        typeof route.redirectTo === 'string' && isCanonicalPublicPath(route.redirectTo),
        `public route artifact ${publicPath} omitted a valid redirect target`,
      )
      assert.notEqual(
        route.redirectTo,
        publicPath,
        `public route artifact ${publicPath} redirected to itself`,
      )
    }
    return route as DeployedPublicLanderRoute
  })
  const routesByPath = new Map(routes.map(route => [route.path, route]))
  assert.equal(routesByPath.size, routes.length, 'public route artifact contained duplicate paths')

  for (const route of routes) {
    if (route.status !== 308) continue
    assert.equal(
      routesByPath.get(route.redirectTo!)?.status,
      200,
      `public route artifact ${route.path} did not redirect to an owned HTML route`,
    )
  }

  for (const route of sitemapRoutes) {
    const pathname = new URL(route, 'https://staging.invalid').pathname
    assert(
      routesByPath.get(pathname)?.status === 200,
      `sitemap route ${pathname} was missing from public route artifact`,
    )
  }
  return routes
}

export function assertLanderSitemapCoverage(discovery: {
  routes: string[]
  sitemapPaths: string[]
}): void {
  const expectedSitemapPaths = [
    '/sitemap.xml',
    '/sitemap/blog-en.xml',
    '/sitemap/blog-es.xml',
    '/sitemap/core.xml',
    '/sitemap/guides-en.xml',
    '/sitemap/guides-es.xml',
    '/sitemap/use-cases.xml',
  ]
  assert.deepEqual(
    [...discovery.sitemapPaths].sort(),
    expectedSitemapPaths,
    'lander sitemap shard topology changed',
  )
  const paths = new Set(
    discovery.routes.map(route => new URL(route, 'https://staging.invalid').pathname),
  )
  for (const required of ['/', '/es', '/blog', '/es/blog', '/guides', '/es/guides', '/use-cases']) {
    assert(paths.has(required), `lander sitemap omitted canonical route ${required}`)
  }
  for (const pathname of paths) {
    assert(
      !/^\/(?:es\/)?(?:blog|guides)\/(?:tag|category)\//.test(pathname),
      `lander sitemap included noindex taxonomy route ${pathname}`,
    )
    assert(
      !/^\/(?:es\/)?vs(?:\/|$)/.test(pathname),
      `lander sitemap included noindex comparison route ${pathname}`,
    )
    assert(
      !/^\/es\/(?:use-cases|for)(?:\/|$)/.test(pathname),
      `lander sitemap included discontinued Spanish route ${pathname}`,
    )
  }
}

export function assertDocsSitemapCoverage(routes: string[]): void {
  const expectedPaths = [
    '/',
    '/agents/',
    '/api-keys/',
    '/apps/',
    '/billing/',
    '/device-flow/',
    '/errors/',
    '/events/',
    '/file-activity/',
    '/files/',
    '/getting-started/',
    '/integrations/',
    '/mirror-devices/',
    '/pagination/',
    '/reference/',
    '/reliability/',
    '/sessions/',
    '/shares-publishes/',
    '/sync/',
    '/train/',
    '/workspaces/',
  ]
  const paths = routes.map(route => new URL(route, 'https://staging.invalid').pathname).sort()
  assert.deepEqual(paths, expectedPaths, 'docs sitemap route set changed')
}

export function assertDeployedPublicHtml(args: {
  route: string
  html: string
  contentType: string | undefined
  cacheControl: string | undefined
  xRobotsTag: string | undefined
  canonicalOrigin: string
  kind: DeployedPublicLanderRoute['kind']
  sitemapMember: boolean
}): string[] {
  assert(
    args.contentType?.toLowerCase().includes('text/html'),
    `${safeRequestTarget(args.route)} did not return HTML`,
  )
  assertSitemapRouteCacheability(args.route, args.cacheControl ?? '', [])
  assert(
    /<html\b[^>]*\blang=["']en["']/i.test(args.html),
    `${safeRequestTarget(args.route)} lost its static root document language`,
  )
  if (new URL(args.route).pathname === '/es' || new URL(args.route).pathname.startsWith('/es/')) {
    assert(
      /document\.documentElement\.lang\s*=\s*["']es-419["']/.test(args.html),
      `${safeRequestTarget(args.route)} lost its static Spanish language handoff`,
    )
  }

  const meaningfulText = decodeXml(args.html)
    .replaceAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replaceAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replaceAll(/<[^>]+>/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
  assert(
    meaningfulText.length >= 100,
    `${safeRequestTarget(args.route)} lost meaningful no-JavaScript HTML`,
  )

  if (args.sitemapMember) {
    assertIndexableSitemapHtml(args.route, args.html, args.xRobotsTag, args.canonicalOrigin)
  } else if (args.kind === 'marketing' || args.kind === 'editorial') {
    assertCanonicalPublicHtml(args.route, args.html, args.canonicalOrigin)
  }

  const canonicalOrigin = new URL(args.canonicalOrigin).origin
  const references = new Set<string>()
  for (const match of args.html.matchAll(/<(?:a|img|link|script|source)\b[^>]*>/gi)) {
    const attributes = parseHtmlAttributes(match[0])
    const rawReferences = [attributes.get('href'), attributes.get('src')]
    const srcset = attributes.get('srcset')
    if (srcset !== undefined) {
      rawReferences.push(...srcset.split(/,\s+/).map(candidate => candidate.trim().split(/\s+/)[0]))
    }
    for (const rawReference of rawReferences) {
      if (rawReference === undefined || rawReference === '') continue
      let target: URL
      try {
        target = new URL(decodeXml(rawReference), args.route)
      } catch {
        throw new Error(`${safeRequestTarget(args.route)} contained an invalid public reference`)
      }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') continue
      assert.notEqual(
        target.hostname,
        'duet.so',
        `${safeRequestTarget(args.route)} advertised duet.so`,
      )
      if (target.origin !== canonicalOrigin) continue
      target.hash = ''
      references.add(target.toString())
    }
  }
  return [...references].sort()
}

export function assertSitemapRouteCacheability(
  route: string,
  cacheControl: string,
  dynamicPaths: readonly string[],
): void {
  if (dynamicPaths.includes(new URL(route).pathname)) return
  assert(
    !/private|no-store/i.test(cacheControl),
    `${safeRequestTarget(route)} was not publicly cacheable`,
  )
}

export function assertCanonicalResponseUrl(
  requestedUrl: string,
  responseUrl: string,
  origin: string,
): void {
  assert.equal(
    new URL(responseUrl, origin).toString(),
    requestedUrl,
    `${safeRequestTarget(requestedUrl)} did not resolve canonically`,
  )
}

export function assertIndexableSitemapHtml(
  route: string,
  html: string,
  xRobotsTag: string | undefined,
  canonicalOrigin: string,
): void {
  assert(
    !hasNoindexDirective(xRobotsTag),
    `${safeRequestTarget(route)} declared X-Robots-Tag noindex despite sitemap membership`,
  )

  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = parseHtmlAttributes(match[0])
    const name = attributes.get('name')?.toLowerCase()
    if (name !== 'robots' && !name?.endsWith('bot')) continue
    assert(
      !hasNoindexDirective(attributes.get('content')),
      `${safeRequestTarget(route)} declared ${name} noindex despite sitemap membership`,
    )
  }

  assertCanonicalPublicHtml(route, html, canonicalOrigin)
}

function assertCanonicalPublicHtml(route: string, html: string, canonicalOrigin: string): void {
  const canonicalLinks = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map(match => parseHtmlAttributes(match[0]))
    .filter(attributes => attributes.get('rel')?.toLowerCase().split(/\s+/).includes('canonical'))
  assert.equal(
    canonicalLinks.length,
    1,
    `${safeRequestTarget(route)} must declare exactly one canonical link`,
  )
  const canonicalHref = canonicalLinks[0]!.get('href')
  assert(canonicalHref, `${safeRequestTarget(route)} canonical link omitted href`)
  const routeUrl = new URL(route)
  const expectedCanonical = new URL(`${routeUrl.pathname}${routeUrl.search}`, canonicalOrigin)
  assert.equal(
    new URL(canonicalHref, canonicalOrigin).toString(),
    expectedCanonical.toString(),
    `${safeRequestTarget(route)} canonical link disagreed with its public route`,
  )
}

function isCanonicalPublicPath(value: string): boolean {
  if (value !== '/' && !/^\/[A-Za-z0-9@._~!$&'()*+,;=:/%-]+$/.test(value)) return false
  if (value.startsWith('//')) return false
  const base = 'https://public-route.invalid'
  const resolved = new URL(value, base)
  return (
    resolved.origin === base &&
    resolved.pathname === value &&
    resolved.search === '' &&
    resolved.hash === ''
  )
}

function parseHtmlAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>()
  for (const attribute of tag.matchAll(
    /\b([a-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
  )) {
    attributes.set(attribute[1]!.toLowerCase(), attribute[2] ?? attribute[3] ?? attribute[4] ?? '')
  }
  return attributes
}

function hasNoindexDirective(value: string | undefined): boolean {
  return (
    value
      ?.split(/[\s,:]+/)
      .some(directive => ['noindex', 'none'].includes(directive.toLowerCase())) ?? false
  )
}

export { decodeXml }
