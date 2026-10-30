import assert from 'node:assert/strict'
import path from 'node:path'

import {
  type Browser,
  type BrowserContext,
  type Frame,
  type Page,
  type Request as PlaywrightRequest,
  type Response as PlaywrightResponse,
} from '@playwright/test'

import {
  safeRequestTarget,
  type StagingArtifactCollector,
  stagingProtectionHeaders,
} from './staging-live-artifacts.ts'
import { timedFetch, vercelBypassHeaders } from './staging-live-http.ts'
import {
  assertCanonicalResponseUrl,
  assertDeployedPublicHtml,
  assertDocsSitemapCoverage,
  assertIndexableSitemapHtml,
  assertLanderSitemapCoverage,
  assertProductRouteArtifact,
  assertPublicLanderRouteArtifact,
  assertSitemapRouteCacheability,
  decodeXml,
  type DeployedProductRoute,
  type DeployedPublicLanderRoute,
} from './staging-live-route-contracts.ts'

const DUET_DOCS_CANONICAL_ORIGIN = 'https://docs.duet.so'
const ROUTE_SWEEP_CONCURRENCY = 8
const DEPLOYED_NAVIGATION_TIMEOUT_MS = 60_000
const pageTransitionMarkers = new WeakMap<Page, () => void>()
const pageViewportMarkers = new WeakMap<Page, () => void>()

export interface StagingBrowserEnv {
  apiUrl: string
  appUrl: string
  landerUrl: string
  docsUrl: string
  vercelBypassSecret: string
}

export interface ExpectedBrowserResponse {
  method: string
  origin?: string
  pathname: string
  status: number
  remaining: number
}

interface BrowserRequestContext {
  navigationEpoch: number
  viewportEpoch: number
  pageUrl?: string
  startedOrder: number
}

interface PendingBrowserAbort {
  errorText: string
  failureOrder: number
  navigationEpochAtFailure: number
  pageUrlAtFailure: string
  frameAtFailure: Frame
  mainFrameAtFailure: boolean
  frameDetachedAtFailure: boolean
  explicitPrefetchAtFailure: boolean
  mainNavigationPendingAtFailure: boolean
  methodAtFailure: string
  viewportEpochAtFailure: number
  resourceTypeAtFailure: string
  responseStatus?: number
}

interface CompletedBrowserRequest {
  key: string
  startedOrder: number
  finishedOrder: number
}

interface BrowserFailureEvidence {
  frameDetachedAfterFailure?: boolean
  replacementCompleted?: boolean
}

interface BrowserRequestFailureContext extends BrowserFailureEvidence {
  requestPageUrl?: string
  pageUrlAtFailure?: string
  frameDetachedAtFailure?: boolean
  explicitPrefetchAtFailure?: boolean
  mainNavigationPendingAtFailure?: boolean
  methodAtFailure?: string
  requestViewportEpoch?: number
  viewportEpochAtFailure?: number
  resourceTypeAtFailure?: string
  responseStatus?: number
}

export function configureStagingBrowserContext(
  context: Pick<BrowserContext, 'setDefaultTimeout' | 'setDefaultNavigationTimeout'>,
): void {
  context.setDefaultTimeout(DEPLOYED_NAVIGATION_TIMEOUT_MS)
  context.setDefaultNavigationTimeout(DEPLOYED_NAVIGATION_TIMEOUT_MS)
}

export async function navigateDeployedPage(
  page: Pick<Page, 'goto'>,
  url: string,
): Promise<PlaywrightResponse | null> {
  return await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: DEPLOYED_NAVIGATION_TIMEOUT_MS,
  })
}

// A page.evaluate issued while the SPA is still running post-login client
// redirects dies with "Execution context was destroyed". The navigation storm
// settles quickly, so retry the evaluation into the settled document instead
// of anchoring on any particular intermediate route.
export async function evaluateThroughClientNavigations<T>(
  run: () => Promise<T>,
  options: { delayMs?: number } = {},
): Promise<T> {
  const delayMs = options.delayMs ?? 1_000
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await run()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('Execution context was destroyed')) throw error
      lastError = error
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
  throw lastError
}

export async function forEachBounded<T>(
  values: readonly T[],
  concurrency: number,
  task: (value: T, index: number) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('Bounded concurrency must be a positive integer')
  }
  let nextIndex = 0
  let failed = false
  let failure: unknown
  const worker = async () => {
    while (!failed) {
      const index = nextIndex++
      if (index >= values.length) return
      const value = values[index]!
      try {
        await task(value, index)
      } catch (error) {
        failed = true
        failure = error
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(values.length, concurrency) }, async () => await worker()),
  )
  if (failed) throw failure
}

export async function runProductRouteAcceptance(args: {
  env: StagingBrowserEnv
  page: Page
  workspaceSlug: string
  sessionId: string
  artifacts: StagingArtifactCollector
}): Promise<void> {
  const manifestTarget = new URL('/product-route-manifest.json', args.env.appUrl).toString()
  const manifestResponse = await timedFetch(
    manifestTarget,
    { headers: vercelBypassHeaders(args.env.vercelBypassSecret) },
    args.artifacts,
  )
  assert(manifestResponse.ok, `product route manifest returned HTTP ${manifestResponse.status}`)
  const routes = assertProductRouteArtifact(await manifestResponse.json(), {
    workspaceSlug: args.workspaceSlug,
    sessionId: args.sessionId,
  })
  assert(routes.length >= 20, `product route artifact unexpectedly contained only ${routes.length}`)

  const resourceUrls = new Set<string>()
  const pendingApiRequests = new Set<PlaywrightRequest>()
  const appOrigin = new URL(args.env.appUrl).origin
  const observeResource = (request: PlaywrightRequest) => {
    if (['document', 'script', 'stylesheet', 'image', 'font'].includes(request.resourceType())) {
      resourceUrls.add(request.url())
    }
    const url = new URL(request.url())
    if (url.origin === appOrigin && url.pathname.startsWith('/api/duet/')) {
      pendingApiRequests.add(request)
    }
  }
  const finishApiRequest = (request: PlaywrightRequest) => pendingApiRequests.delete(request)
  args.page.on('request', observeResource)
  args.page.on('requestfinished', finishApiRequest)
  args.page.on('requestfailed', finishApiRequest)
  try {
    for (const route of routes) {
      const target = new URL(route.path, args.env.appUrl).toString()
      const startedAt = Date.now()
      markExpectedBrowserTransition(args.page)
      const response = await navigateDeployedPage(args.page, target)
      args.artifacts.recordApiTiming({
        method: 'GET',
        target: safeRequestTarget(target),
        status: response?.status() ?? 0,
        durationMs: Date.now() - startedAt,
      })
      assert(response?.ok(), `${safeRequestTarget(target)} failed direct product navigation`)
      await assertProductRouteLoaded(args.page, route)
      await waitForPendingRequestsToSettle(pendingApiRequests)

      const refreshStartedAt = Date.now()
      markExpectedBrowserTransition(args.page)
      const refresh = await args.page.reload({
        waitUntil: 'domcontentloaded',
        timeout: DEPLOYED_NAVIGATION_TIMEOUT_MS,
      })
      args.artifacts.recordApiTiming({
        method: 'GET',
        target: safeRequestTarget(target),
        status: refresh?.status() ?? 0,
        durationMs: Date.now() - refreshStartedAt,
      })
      assert(refresh?.ok(), `${safeRequestTarget(target)} failed product refresh`)
      await assertProductRouteLoaded(args.page, route)
      await waitForPendingRequestsToSettle(pendingApiRequests)
    }
  } finally {
    args.page.off('request', observeResource)
    args.page.off('requestfinished', finishApiRequest)
    args.page.off('requestfailed', finishApiRequest)
  }

  const landerOrigin = new URL(args.env.landerUrl).origin
  for (const resource of resourceUrls) {
    const url = new URL(resource)
    assert.notEqual(url.origin, landerOrigin, 'product loaded a lander-owned runtime resource')
    if (url.pathname.startsWith('/_next/')) {
      assert.equal(url.origin, appOrigin, 'product loaded a cross-owner Next.js bundle')
    }
    assert(!BROWSER_AD_HOSTS.has(url.hostname), 'product loaded a browser advertising runtime')
  }

  await assertDeployedOwnerIsolation(args.env, args.page.context(), args.artifacts)
}

export async function waitForPendingRequestsToSettle(
  pending: ReadonlySet<unknown>,
  quietMs = 250,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let idleSince: number | undefined
  for (;;) {
    const now = Date.now()
    if (pending.size === 0) {
      idleSince ??= now
      if (now - idleSince >= quietMs) return
    } else {
      idleSince = undefined
    }
    if (now >= deadline) throw new Error('Timed out waiting for first-party browser requests')
    await Bun.sleep(Math.min(25, quietMs))
  }
}

async function assertProductRouteLoaded(page: Page, route: DeployedProductRoute): Promise<void> {
  const expectedDestination =
    route.destination === 'root' || route.destination === 'workspace-root'
      ? 'sessions'
      : route.destination
  if (expectedDestination === 'internalAdmin') {
    await page.locator('main').first().waitFor()
  } else {
    await page.locator(`[data-destination-content="${expectedDestination}"]`).waitFor()
  }
  assert.equal(
    await page.getByText('404', { exact: true }).count(),
    0,
    `${route.path} rendered 404`,
  )
}

async function assertDeployedOwnerIsolation(
  env: StagingBrowserEnv,
  context: BrowserContext,
  artifacts: StagingArtifactCollector,
): Promise<void> {
  const headers = vercelBypassHeaders(env.vercelBypassSecret)
  for (const pathname of ['/app', '/pricing', '/blog', '/guides', '/use-cases']) {
    const target = new URL(pathname, env.appUrl).toString()
    const startedAt = Date.now()
    const response = await context.request.get(target, { headers, maxRedirects: 0 })
    artifacts.recordApiTiming({
      method: 'GET',
      target: safeRequestTarget(target),
      status: response.status(),
      durationMs: Date.now() - startedAt,
    })
    assert.equal(response.status(), 404, `${pathname} unexpectedly had a product-host owner`)
    assert.equal(
      response.headers().location,
      undefined,
      `${pathname} retained a compatibility redirect`,
    )
  }

  const [landerResponse, productResponse] = await Promise.all([
    context.request.get(env.landerUrl, { headers }),
    context.request.get(`${env.appUrl}/sign-in`, { headers }),
  ])
  assert(landerResponse.ok(), 'lander owner-isolation document failed')
  assert(productResponse.ok(), 'product owner-isolation document failed')
  const [landerHtml, productHtml] = await Promise.all([
    landerResponse.text(),
    productResponse.text(),
  ])
  const browserAdMarkers = [
    'www.googletagmanager.com/gtm.js',
    'www.googletagmanager.com/ns.html',
    'connect.facebook.net/en_US/fbevents.js',
    'www.redditstatic.com/ads/pixel.js',
    'bzrcdn.openai.com/sdk/oaiq.min.js',
  ]
  for (const marker of browserAdMarkers) {
    assert(!landerHtml.includes(marker), `lander retained browser advertising runtime ${marker}`)
    assert(!productHtml.includes(marker), `product retained browser advertising runtime ${marker}`)
  }
  assertNextBundleOwnership(landerHtml, env.landerUrl)
  assertNextBundleOwnership(productHtml, env.appUrl)
}

const BROWSER_AD_HOSTS = new Set([
  'www.googletagmanager.com',
  'connect.facebook.net',
  'www.facebook.com',
  'www.redditstatic.com',
  'alb.reddit.com',
  'bzrcdn.openai.com',
  'bzr.openai.com',
])

function assertNextBundleOwnership(html: string, owner: string): void {
  const ownerOrigin = new URL(owner).origin
  const bundleOrigins = [...html.matchAll(/(?:src|href)=["']([^"']*\/_next\/[^"']+)["']/gi)].map(
    match => new URL(decodeXml(match[1]!), owner).origin,
  )
  assert(bundleOrigins.length > 0, `${ownerOrigin} document omitted its Next.js bundles`)
  assert(
    bundleOrigins.every(origin => origin === ownerOrigin),
    `${ownerOrigin} document loaded a cross-owner Next.js bundle`,
  )
}

export async function runRouteSweeps(
  env: StagingBrowserEnv,
  browser: Browser,
  artifacts: StagingArtifactCollector,
): Promise<{ lander: number; docs: number }> {
  const context = await browser.newContext()
  attachBrowserDiagnostics(context, artifacts)
  await installStagingProtection(context, env)
  try {
    const landerSitemap = await discoverSitemapRoutes(
      env.landerUrl,
      env.vercelBypassSecret,
      artifacts,
    )
    const docsSitemap = await discoverSitemapRoutes(env.docsUrl, env.vercelBypassSecret, artifacts)
    const landerRoutes = await discoverPublicLanderRoutes(
      env.landerUrl,
      env.vercelBypassSecret,
      artifacts,
      landerSitemap.routes,
    )
    const docsRoutes = docsSitemap.routes
    assertLanderSitemapCoverage(landerSitemap)
    assert(
      landerSitemap.routes.length >= 100,
      `lander sitemap unexpectedly contained only ${landerSitemap.routes.length} routes`,
    )

    assertDocsSitemapCoverage(docsRoutes)
    const sitemapPaths = new Set(landerSitemap.routes.map(route => new URL(route).pathname))
    await sweepLanderRoutes(
      context,
      env.landerUrl,
      landerRoutes.filter(route => route.status === 200),
      env.vercelBypassSecret,
      artifacts,
      sitemapPaths,
    )
    await sweepLanderRedirects(
      context,
      env.landerUrl,
      landerRoutes.filter(route => route.status === 308),
      env.vercelBypassSecret,
      artifacts,
      sitemapPaths,
    )
    await sweepRoutes(
      context,
      env.docsUrl,
      docsRoutes,
      env.vercelBypassSecret,
      artifacts,
      DUET_DOCS_CANONICAL_ORIGIN,
      new Set(docsRoutes.map(route => new URL(route).pathname)),
    )

    const page = await context.newPage()
    for (const route of ['/', '/es', '/blog', '/es/blog']) {
      markExpectedBrowserTransition(page)
      await navigateDeployedPage(page, new URL(route, env.landerUrl).toString())
      assert(
        (await page.locator('body').innerText()).trim().length > 100,
        `public route ${route} was blank`,
      )
    }
    markExpectedViewportChange(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await navigateDeployedPage(page, env.landerUrl)
    await page.locator('h1').waitFor()
    await page.screenshot({
      path: path.join(artifacts.directory, 'public-desktop.png'),
    })
    markExpectedViewportChange(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await navigateDeployedPage(page, env.landerUrl)
    await page.locator('h1').waitFor()
    await page.screenshot({
      path: path.join(artifacts.directory, 'public-mobile.png'),
    })
    markExpectedViewportChange(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await navigateDeployedPage(page, env.docsUrl)
    await page.screenshot({
      path: path.join(artifacts.directory, 'docs-desktop.png'),
      fullPage: true,
    })
    markExpectedViewportChange(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({
      path: path.join(artifacts.directory, 'docs-mobile.png'),
      fullPage: true,
    })
    markExpectedBrowserTransition(page)
    await page.close()
    return { lander: landerRoutes.length, docs: docsRoutes.length }
  } finally {
    await context.close()
  }
}

async function discoverPublicLanderRoutes(
  origin: string,
  bypassSecret: string,
  artifacts: StagingArtifactCollector,
  sitemapRoutes: string[],
): Promise<Array<DeployedPublicLanderRoute & { url: string }>> {
  const target = new URL('/public-route-manifest.json', origin).toString()
  const response = await timedFetch(
    target,
    { headers: vercelBypassHeaders(bypassSecret) },
    artifacts,
  )
  assert(response.ok, `${safeRequestTarget(target)} returned HTTP ${response.status}`)
  const routes = assertPublicLanderRouteArtifact(await response.json(), sitemapRoutes)
  assert(
    routes.length >= 500,
    `public route artifact unexpectedly contained only ${routes.length} routes`,
  )

  return routes.map(route => ({ ...route, url: new URL(route.path, origin).toString() }))
}

async function discoverSitemapRoutes(
  origin: string,
  bypassSecret: string,
  artifacts: StagingArtifactCollector,
): Promise<{ routes: string[]; sitemapPaths: string[] }> {
  const pending = [new URL('/sitemap.xml', origin).toString()]
  const visited = new Set<string>()
  const pages = new Set<string>()
  while (pending.length > 0) {
    const sitemap = pending.shift()!
    if (visited.has(sitemap)) continue
    visited.add(sitemap)
    const response = await timedFetch(
      sitemap,
      { headers: vercelBypassHeaders(bypassSecret) },
      artifacts,
    )
    assert(response.ok, `sitemap ${safeRequestTarget(sitemap)} returned HTTP ${response.status}`)
    const xml = await response.text()
    const locations = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => decodeXml(match[1]!))
    for (const location of locations) {
      const url = new URL(location)
      const stagingUrl = new URL(`${url.pathname}${url.search}`, origin).toString()
      if (url.pathname.endsWith('.xml')) pending.push(stagingUrl)
      else pages.add(stagingUrl)
    }
  }
  return {
    routes: [...pages].sort(),
    sitemapPaths: [...visited].map(sitemap => new URL(sitemap).pathname).sort(),
  }
}

async function sweepRoutes(
  context: BrowserContext,
  origin: string,
  routes: string[],
  bypassSecret: string,
  artifacts: StagingArtifactCollector,
  canonicalOrigin: string,
  strictSitemapPaths: ReadonlySet<string>,
): Promise<void> {
  await forEachBounded(routes, ROUTE_SWEEP_CONCURRENCY, async route => {
    const startedAt = Date.now()
    const response = await context.request.get(route, {
      headers: vercelBypassHeaders(bypassSecret),
      maxRedirects: 0,
    })
    artifacts.recordApiTiming({
      method: 'GET',
      target: safeRequestTarget(route),
      status: response.status(),
      durationMs: Date.now() - startedAt,
    })
    assert(response.ok(), `${safeRequestTarget(route)} returned HTTP ${response.status()}`)
    assertCanonicalResponseUrl(route, response.url(), origin)
    const body = await response.text()
    assert(body.length > 200, `${safeRequestTarget(route)} returned empty HTML`)
    if (strictSitemapPaths.has(new URL(route).pathname)) {
      const headers = response.headers()
      assertIndexableSitemapHtml(route, body, headers['x-robots-tag'], canonicalOrigin)
      assertSitemapRouteCacheability(route, headers['cache-control'] ?? '', [])
    }
    assert.equal(new URL(route).origin, new URL(origin).origin, 'public route escaped staging host')
  })
}

async function sweepLanderRoutes(
  context: BrowserContext,
  origin: string,
  routes: Array<DeployedPublicLanderRoute & { url: string }>,
  bypassSecret: string,
  artifacts: StagingArtifactCollector,
  sitemapPaths: ReadonlySet<string>,
): Promise<void> {
  const references = new Set<string>()
  await forEachBounded(routes, ROUTE_SWEEP_CONCURRENCY, async route => {
    const startedAt = Date.now()
    const response = await context.request.get(route.url, {
      headers: vercelBypassHeaders(bypassSecret),
      maxRedirects: 0,
    })
    artifacts.recordApiTiming({
      method: 'GET',
      target: safeRequestTarget(route.url),
      status: response.status(),
      durationMs: Date.now() - startedAt,
    })
    assert(response.ok(), `${safeRequestTarget(route.url)} returned HTTP ${response.status()}`)
    assertCanonicalResponseUrl(route.url, response.url(), origin)
    const headers = response.headers()
    const html = await response.text()
    for (const reference of assertDeployedPublicHtml({
      route: route.url,
      html,
      contentType: headers['content-type'],
      cacheControl: headers['cache-control'],
      xRobotsTag: headers['x-robots-tag'],
      canonicalOrigin: new URL(origin).origin,
      kind: route.kind,
      sitemapMember: sitemapPaths.has(route.path),
    })) {
      references.add(reference)
    }
  })

  await forEachBounded([...references].sort(), ROUTE_SWEEP_CONCURRENCY, async target => {
    const startedAt = Date.now()
    const response = await context.request.get(target, {
      headers: vercelBypassHeaders(bypassSecret),
      maxRedirects: 0,
    })
    artifacts.recordApiTiming({
      method: 'GET',
      target: safeRequestTarget(target),
      status: response.status(),
      durationMs: Date.now() - startedAt,
    })
    assert(
      response.status() >= 200 && response.status() < 400,
      `public link or asset ${safeRequestTarget(target)} returned HTTP ${response.status()}`,
    )
  })
}

async function sweepLanderRedirects(
  context: BrowserContext,
  origin: string,
  routes: Array<DeployedPublicLanderRoute & { url: string }>,
  bypassSecret: string,
  artifacts: StagingArtifactCollector,
  sitemapPaths: ReadonlySet<string>,
): Promise<void> {
  await forEachBounded(routes, ROUTE_SWEEP_CONCURRENCY, async route => {
    const startedAt = Date.now()
    const response = await context.request.get(route.url, {
      headers: vercelBypassHeaders(bypassSecret),
      maxRedirects: 0,
    })
    artifacts.recordApiTiming({
      method: 'GET',
      target: safeRequestTarget(route.url),
      status: response.status(),
      durationMs: Date.now() - startedAt,
    })
    assert.equal(
      response.status(),
      308,
      `${safeRequestTarget(route.url)} did not permanently redirect`,
    )
    assert(
      !sitemapPaths.has(route.path),
      `${safeRequestTarget(route.url)} was both redirected and listed in the sitemap`,
    )
    const location = response.headers().location
    assert(location, `${safeRequestTarget(route.url)} redirect omitted Location`)
    const destination = new URL(location, origin)
    assert.equal(destination.origin, new URL(origin).origin, 'public redirect escaped lander owner')
    assert.equal(
      `${destination.pathname}${destination.search}`,
      route.redirectTo,
      `${safeRequestTarget(route.url)} redirected to the wrong public route`,
    )
  })
}

export function attachBrowserDiagnostics(
  context: BrowserContext,
  artifacts: StagingArtifactCollector,
  expectations: {
    responses?: ExpectedBrowserResponse[]
    aborts?: ExpectedBrowserResponse[]
  } = {},
): void {
  context.on('page', page =>
    attachPageDiagnostics(page, artifacts, expectations.responses ?? [], expectations.aborts ?? []),
  )
}

export async function installStagingProtection(
  context: BrowserContext,
  env: StagingBrowserEnv,
): Promise<void> {
  configureStagingBrowserContext(context)
  const origins = new Set(
    [env.appUrl, env.landerUrl, env.docsUrl, env.apiUrl].map(url => new URL(url).origin),
  )
  await Promise.all(
    [...origins].map(async origin => {
      await context.route(`${origin}/**`, async route => {
        await route.continue({
          headers: stagingProtectionHeaders(
            route.request().url(),
            origins,
            route.request().headers(),
            env.vercelBypassSecret,
          ),
        })
      })
    }),
  )
}

function attachPageDiagnostics(
  page: Page,
  artifacts: StagingArtifactCollector,
  expectedResponses: ExpectedBrowserResponse[],
  expectedAborts: ExpectedBrowserResponse[],
): void {
  let navigationEpoch = 0
  let viewportEpoch = 0
  let eventOrder = 0
  let committedPageUrl = page.url()
  let pendingDocumentUrl: string | undefined
  const requestContexts = new WeakMap<PlaywrightRequest, BrowserRequestContext>()
  const pendingAborts = new Map<PlaywrightRequest, PendingBrowserAbort>()
  const responseStatuses = new WeakMap<PlaywrightRequest, number>()

  pageTransitionMarkers.set(page, () => {
    navigationEpoch += 1
    pendingDocumentUrl = undefined
  })
  pageViewportMarkers.set(page, () => {
    viewportEpoch += 1
  })
  page.once('close', () => {
    for (const request of pendingAborts.keys()) recordRequestFailure(request)
    pageTransitionMarkers.delete(page)
    pageViewportMarkers.delete(page)
  })

  const recordRequestFailure = (
    request: PlaywrightRequest,
    evidence: BrowserFailureEvidence = {},
  ) => {
    const pending = pendingAborts.get(request)
    if (pending === undefined) return
    pendingAborts.delete(request)
    const requestContext = requestContexts.get(request)
    const requestUrl = new URL(request.url())
    artifacts.recordBrowserError({
      kind: browserRequestFailureKindWithExpectedAbort(
        pending.errorText,
        requestContext?.navigationEpoch,
        pending.navigationEpochAtFailure,
        browserFailureContext(pending, requestContext, evidence),
        expectedAborts,
        {
          method: request.method(),
          origin: requestUrl.origin,
          pathname: requestUrl.pathname,
          status: pending.responseStatus,
        },
      ),
      message: `${request.method()} ${safeRequestTarget(request.url())}: ${pending.errorText}`,
    })
  }

  const reconcileCompletedReplacement = (completed: CompletedBrowserRequest) => {
    for (const [request, pending] of pendingAborts) {
      const requestContext = requestContexts.get(request)
      if (
        requestContext !== undefined &&
        isLaterExactBrowserReplacement(
          {
            key: browserRequestKey(request),
            startedOrder: requestContext.startedOrder,
            failureOrder: pending.failureOrder,
          },
          completed,
        )
      ) {
        recordRequestFailure(request, { replacementCompleted: true })
      }
    }
  }

  page.on('request', request => {
    eventOrder += 1
    const mainNavigation = request.isNavigationRequest() && request.frame() === page.mainFrame()
    if (mainNavigation) {
      navigationEpoch += 1
      pendingDocumentUrl = request.url()
    }
    requestContexts.set(request, {
      navigationEpoch,
      viewportEpoch,
      pageUrl: mainNavigation ? undefined : page.url(),
      startedOrder: eventOrder,
    })
  })
  page.on('requestfinished', request => {
    eventOrder += 1
    const requestContext = requestContexts.get(request)
    if (requestContext === undefined) return
    reconcileCompletedReplacement({
      key: browserRequestKey(request),
      startedOrder: requestContext.startedOrder,
      finishedOrder: eventOrder,
    })
  })
  page.on('framenavigated', frame => {
    if (frame !== page.mainFrame() || frame.url() === committedPageUrl) return
    committedPageUrl = frame.url()
    navigationEpoch = navigationEpochAfterCommit(navigationEpoch, pendingDocumentUrl, frame.url())
    pendingDocumentUrl = undefined
  })
  page.on('console', message => {
    if (message.type() === 'error') {
      // The response listener below retains the URL and status that Chromium omits here.
      if (
        /^Failed to load resource: the server responded with a status of \d+/i.test(message.text())
      ) {
        return
      }
      artifacts.recordBrowserError({ kind: 'console', message: message.text() })
    }
  })
  page.on('pageerror', error => {
    artifacts.recordBrowserError({ kind: 'page', message: error.message })
  })
  page.on('requestfailed', request => {
    eventOrder += 1
    const errorText = request.failure()?.errorText ?? 'failed'
    const failedMainNavigation =
      request.isNavigationRequest() && request.frame() === page.mainFrame()
    const mainNavigationPendingAtFailure = pendingDocumentUrl !== undefined && !failedMainNavigation
    if (failedMainNavigation && request.url() === pendingDocumentUrl) {
      pendingDocumentUrl = undefined
    }
    if (/ERR_ABORTED|NS_BINDING_ABORTED/i.test(errorText)) {
      const requestContext = requestContexts.get(request)
      const responseStatus = responseStatuses.get(request)
      const pending: PendingBrowserAbort = {
        errorText,
        failureOrder: eventOrder,
        navigationEpochAtFailure: navigationEpoch,
        pageUrlAtFailure: page.url(),
        frameAtFailure: request.frame(),
        mainFrameAtFailure: request.frame() === page.mainFrame(),
        frameDetachedAtFailure:
          request.frame() !== page.mainFrame() && request.frame().isDetached(),
        explicitPrefetchAtFailure: isExplicitBrowserPrefetch(request.headers()),
        mainNavigationPendingAtFailure,
        methodAtFailure: request.method(),
        viewportEpochAtFailure: viewportEpoch,
        resourceTypeAtFailure: request.resourceType(),
        responseStatus,
      }
      pendingAborts.set(request, pending)
      if (
        browserRequestFailureKind(
          errorText,
          requestContext?.navigationEpoch,
          pending.navigationEpochAtFailure,
          browserFailureContext(pending, requestContext),
        ) === 'navigation-canceled'
      ) {
        recordRequestFailure(request)
      }
      return
    }
    artifacts.recordBrowserError({
      kind: 'request',
      message: `${request.method()} ${safeRequestTarget(request.url())}: ${errorText}`,
    })
  })
  page.on('framedetached', frame => {
    for (const [request, pending] of pendingAborts) {
      if (!pending.mainFrameAtFailure && pending.frameAtFailure === frame) {
        recordRequestFailure(request, { frameDetachedAfterFailure: true })
      }
    }
  })
  page.on('response', response => {
    responseStatuses.set(response.request(), response.status())
    if (response.status() < 400) return
    if (
      consumeExpectedBrowserResponse(expectedResponses, {
        method: response.request().method(),
        origin: new URL(response.url()).origin,
        pathname: new URL(response.url()).pathname,
        status: response.status(),
      })
    ) {
      return
    }
    artifacts.recordBrowserError({
      kind: 'response',
      message: `${response.request().method()} ${safeRequestTarget(response.url())}: HTTP ${response.status()}`,
    })
  })
}

function browserFailureContext(
  pending: PendingBrowserAbort,
  request: BrowserRequestContext | undefined,
  evidence: BrowserFailureEvidence = {},
): BrowserRequestFailureContext {
  return {
    requestPageUrl: request?.pageUrl,
    pageUrlAtFailure: pending.pageUrlAtFailure,
    frameDetachedAtFailure: pending.frameDetachedAtFailure,
    explicitPrefetchAtFailure: pending.explicitPrefetchAtFailure,
    mainNavigationPendingAtFailure: pending.mainNavigationPendingAtFailure,
    methodAtFailure: pending.methodAtFailure,
    requestViewportEpoch: request?.viewportEpoch,
    viewportEpochAtFailure: pending.viewportEpochAtFailure,
    resourceTypeAtFailure: pending.resourceTypeAtFailure,
    responseStatus: pending.responseStatus,
    ...evidence,
  }
}

export function browserRequestFailureKind(
  errorText: string,
  requestEpoch: number | undefined,
  navigationEpochAtFailure: number,
  context: BrowserRequestFailureContext = {},
): 'navigation-canceled' | 'request' {
  return /ERR_ABORTED|NS_BINDING_ABORTED/i.test(errorText) &&
    ((requestEpoch !== undefined && requestEpoch < navigationEpochAtFailure) ||
      context.frameDetachedAtFailure === true ||
      context.frameDetachedAfterFailure === true ||
      context.explicitPrefetchAtFailure === true ||
      context.mainNavigationPendingAtFailure === true ||
      (context.requestViewportEpoch !== undefined &&
        context.viewportEpochAtFailure !== undefined &&
        context.requestViewportEpoch < context.viewportEpochAtFailure &&
        (context.resourceTypeAtFailure === 'image' || context.resourceTypeAtFailure === 'media')) ||
      isCompletedBodylessBrowserResponse(context.methodAtFailure, context.responseStatus) ||
      context.replacementCompleted === true ||
      (context.requestPageUrl !== undefined &&
        context.pageUrlAtFailure !== undefined &&
        context.requestPageUrl !== context.pageUrlAtFailure))
    ? 'navigation-canceled'
    : 'request'
}

export function browserRequestFailureKindWithExpectedAbort(
  errorText: string,
  requestEpoch: number | undefined,
  navigationEpochAtFailure: number,
  context: BrowserRequestFailureContext,
  expectedAborts: ExpectedBrowserResponse[],
  actual: Omit<ExpectedBrowserResponse, 'remaining' | 'status'> & { status?: number },
): 'navigation-canceled' | 'request' {
  const causalKind = browserRequestFailureKind(
    errorText,
    requestEpoch,
    navigationEpochAtFailure,
    context,
  )
  if (causalKind === 'navigation-canceled' || actual.status === undefined) return causalKind
  return consumeExpectedBrowserResponse(expectedAborts, {
    ...actual,
    status: actual.status,
  })
    ? 'navigation-canceled'
    : 'request'
}

function isCompletedBodylessBrowserResponse(
  method: string | undefined,
  status: number | undefined,
): boolean {
  // Chromium may report ERR_ABORTED after headers even though these responses
  // cannot carry a body; observing their successful status completes the exchange.
  return (
    status === 204 || (method === 'HEAD' && status !== undefined && status >= 200 && status < 300)
  )
}

export function isExplicitBrowserPrefetch(headers: Record<string, string>): boolean {
  if (headers['next-router-prefetch'] === '1') return true
  return [headers.purpose, headers['sec-purpose']].some(value =>
    /(?:^|[;,\s])(?:prefetch|prerender)(?:$|[;,\s])/i.test(value ?? ''),
  )
}

function browserRequestKey(request: PlaywrightRequest): string {
  return `${request.method()} ${request.url()}`
}

export function isLaterExactBrowserReplacement(
  aborted: { key: string; startedOrder: number; failureOrder: number },
  completed: CompletedBrowserRequest,
): boolean {
  return (
    aborted.key === completed.key &&
    completed.startedOrder > aborted.startedOrder &&
    completed.finishedOrder > aborted.failureOrder
  )
}

export function markExpectedBrowserTransition(page: Page): void {
  const mark = pageTransitionMarkers.get(page)
  assert(mark !== undefined, 'browser diagnostics were not attached before the page transition')
  mark()
}

export function markExpectedViewportChange(page: Page): void {
  const mark = pageViewportMarkers.get(page)
  assert(mark !== undefined, 'browser diagnostics were not attached before the viewport change')
  mark()
}

export function navigationEpochAfterCommit(
  navigationEpoch: number,
  pendingDocumentUrl: string | undefined,
  committedUrl: string,
): number {
  return pendingDocumentUrl === committedUrl ? navigationEpoch : navigationEpoch + 1
}

export function consumeExpectedBrowserResponse(
  expected: ExpectedBrowserResponse[],
  actual: Omit<ExpectedBrowserResponse, 'remaining'>,
): boolean {
  const match = expected.find(
    candidate =>
      candidate.remaining > 0 &&
      candidate.method === actual.method &&
      (candidate.origin === undefined || candidate.origin === actual.origin) &&
      candidate.pathname === actual.pathname &&
      candidate.status === actual.status,
  )
  if (match === undefined) return false
  match.remaining -= 1
  return true
}

export function isActionableBrowserError(error: {
  kind: 'console' | 'navigation-canceled' | 'page' | 'request' | 'response'
  message: string
}): boolean {
  if (error.kind === 'navigation-canceled') return false
  // 4xx responses are designed states the UI renders gracefully — the paused
  // wall answers files with 402, icon and detached-share probes 404 and fall
  // back. Server errors and console/page failures stay actionable.
  if (error.kind === 'response' && /: HTTP 4\d\d$/.test(error.message)) return false
  return true
}
