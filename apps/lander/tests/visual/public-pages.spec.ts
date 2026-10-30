import { expect, test } from '@playwright/test'

import {
  isEsHreflangSuppressedSlug,
  isRedirectedEsEditorialSlug,
  type EsEditorialKind,
} from '../../lib/i18n/es-editorial-indexing'
import { isDiscontinuedEsMarketingPath } from '../../lib/i18n/path-classification'
import {
  getLanderOrigin,
  resolveConfiguredLanderOrigin,
  resolveConfiguredProductOrigin,
} from '../../src/config/origins'
import {
  cliInstallBlock,
  devicePairingBlock,
  emailSignInBlock,
  mcpConfigBlock,
} from '../../src/install-copy'
import { PUBLIC_ROUTE_MANIFEST } from '../../src/public-route-manifest'
import { siteConfig } from '../../src/site-config'
import { publicRouteId, VISUAL_PUBLIC_ROUTES } from './public-visual-contract'

const CANDIDATE_ORIGIN = resolveConfiguredLanderOrigin()
const PRODUCT_ORIGIN = resolveConfiguredProductOrigin()
const VISUAL_SERVER_ORIGIN = getLanderOrigin('local')

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
})

const routes = selectRoutes(VISUAL_PUBLIC_ROUTES)
const publicPaths = new Set(PUBLIC_ROUTE_MANIFEST.map(route => route.publicPath))

assertUniqueSnapshotIds(VISUAL_PUBLIC_ROUTES)

test.describe.configure({ mode: 'parallel' })

for (const route of routes) {
  test(`lander/lander-public-${publicRouteId(route.publicPath)}`, async ({ page, context }) => {
    const browserErrors: string[] = []
    page.on('console', message => {
      // Failed resources are reported below with their status and URL. The
      // matching Chromium console entry carries neither and would only add an
      // opaque duplicate.
      if (
        message.type() === 'error' &&
        !message.text().startsWith('Failed to load resource: the server responded')
      ) {
        browserErrors.push(message.text())
      }
      if (message.type() === 'warning' && message.text().startsWith('THREE.Color: Unknown color')) {
        browserErrors.push(message.text())
      }
    })
    page.on('pageerror', error => browserErrors.push(error.message))
    page.on('response', response => {
      if (response.status() >= 400) {
        browserErrors.push(`${response.status()} ${response.url()}`)
      }
    })
    page.on('requestfailed', request => {
      if (request.url().startsWith(VISUAL_SERVER_ORIGIN)) {
        // Chromium reports intentional media-range and Next.js link-prefetch
        // cancellation as ERR_ABORTED. Neither is an asset or server failure.
        // The awaited page.goto still throws for an aborted primary document,
        // and real HTTP failures remain covered by the response listener.
        if (request.failure()?.errorText === 'net::ERR_ABORTED') {
          return
        }
        browserErrors.push(
          `request failed ${request.url()}: ${request.failure()?.errorText ?? 'unknown'}`,
        )
      }
    })

    // Match the server's first render through hydration. Switching the media
    // query at DOMContentLoaded can race React and create a false mismatch.
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' })
    await page.addInitScript(() => {
      let state = 0x5eed1234
      Math.random = () => {
        state = (1664525 * state + 1013904223) >>> 0
        return state / 0x100000000
      }
    })
    const response = await page.goto(route.publicPath, { waitUntil: 'domcontentloaded' })
    expect(response, `${route.publicPath} must return a document response`).not.toBeNull()
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
      true,
    )
    expect(response?.status(), `${route.publicPath} must load successfully`).toBeLessThan(400)

    await settleVisualPage(page)
    if (route.publicPath === '/install') {
      const fidelity = (element: Element) => {
        const styles = getComputedStyle(element)
        return {
          width: element.clientWidth,
          color: styles.color,
          font: styles.fontFamily,
          fontSize: styles.fontSize,
          stepWeight: getComputedStyle(element.querySelector('span')!).fontWeight,
        }
      }
      const fixture = await context.newPage()
      try {
        await fixture.goto('/playground/lander-install-code')
        await fixture.evaluate(() => document.fonts.ready)
        expect(await fixture.locator('pre').evaluate(fidelity)).toEqual(
          await page.locator('main pre').nth(2).evaluate(fidelity),
        )
      } finally {
        await fixture.close()
      }
      const config = siteConfig()
      expect(await page.locator('main pre').allTextContents()).toEqual([
        cliInstallBlock(),
        devicePairingBlock(config),
        emailSignInBlock(config),
        mcpConfigBlock(config),
      ])
      const brokenWords = await page.locator('main pre').evaluateAll(blocks => {
        const broken: string[] = []
        for (const block of blocks) {
          const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
          let node: Node | null
          while ((node = walker.nextNode())) {
            for (const match of (node.textContent ?? '').matchAll(
              /\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g,
            )) {
              const range = document.createRange()
              range.setStart(node, match.index!)
              range.setEnd(node, match.index! + match[0].length)
              if (range.getClientRects().length > 1) broken.push(match[0])
            }
          }
        }
        return broken
      })
      expect(brokenWords, 'display wrapping must keep identifiers and words intact').toEqual([])
      for (const block of await page.locator('main pre').all()) {
        if (!(await block.evaluate(element => element.scrollWidth > element.clientWidth))) continue
        await expect(
          block.locator('..').getByText('Scroll horizontally to see the full line.'),
        ).toBeVisible()
        await block.focus()
        await page.keyboard.press('ArrowRight')
        await expect.poll(() => block.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
        await block.evaluate(element => {
          element.scrollLeft = 0
        })
      }
      await page.evaluate(() => {
        ;(document.activeElement as HTMLElement)?.blur()
        window.scrollTo({ top: 0, behavior: 'instant' })
      })
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `${route.publicPath} must not overflow horizontally`,
    ).toBe(true)
    expect(
      (await context.cookies()).some(cookie => cookie.name === 'duet_session'),
      `${route.publicPath} must remain anonymous`,
    ).toBe(false)
    expect(
      await page.evaluate(expectedOrigin => {
        return [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
          .map(anchor => anchor.href)
          .filter(href => new URL(href).pathname === '/sign-in')
          .filter(href => new URL(href).origin !== expectedOrigin)
      }, PRODUCT_ORIGIN),
      `${route.publicPath} must keep hydrated sign-in links on the configured product origin`,
    ).toEqual([])

    if (route.publicPath === '/') {
      // Every public conversion entry point goes to self-serve signup.
      await expect(page.locator('a[href*="/sign-in"]')).toHaveCount(5)
      await expect(page.locator('a[href*="cal.com"]')).toHaveCount(0)
    }

    if (route.kind === 'marketing' || route.kind === 'editorial') {
      const editorial = parseEditorialPath(route.publicPath)
      const isRedirectedSpanishEditorial =
        editorial?.locale === 'es' && isRedirectedEsEditorialSlug(editorial.kind, editorial.slug)
      const isRedirectedSpanishMarketing = isDiscontinuedEsMarketingPath(route.publicPath)
      const isRedirectedSpanish = isRedirectedSpanishEditorial || isRedirectedSpanishMarketing
      const canonicalPath = isRedirectedSpanish ? route.publicPath.slice(3) : route.publicPath
      const expectedCanonical = `${CANDIDATE_ORIGIN}${canonicalPath === '/' ? '' : canonicalPath}`
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', expectedCanonical)
      if (isRedirectedSpanish) {
        await expect(page).toHaveURL(`${VISUAL_SERVER_ORIGIN}${canonicalPath}`)
      }
      await verifyTranslatedAlternates(page, route.publicPath)
    } else if (route.kind === 'campaign') {
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/i)
    }

    expect(browserErrors, `${route.publicPath} must not log browser errors`).toEqual([])
    await expect(page).toHaveScreenshot(`public-${publicRouteId(route.publicPath)}.png`, {
      // Every resolved route owns a stable fold baseline in both viewports.
      // Representative full-page evidence and no-JavaScript captures remain
      // separate so growing editorial pages cannot make Git history unbounded.
      fullPage: false,
      timeout: 30_000,
    })
  })
}

async function verifyTranslatedAlternates(page: import('@playwright/test').Page, pathname: string) {
  const englishPath =
    pathname === '/es' ? '/' : pathname.startsWith('/es/') ? pathname.slice(3) : pathname
  const spanishPath = pathname.startsWith('/es')
    ? pathname
    : pathname === '/'
      ? '/es'
      : `/es${pathname}`
  if (!publicPaths.has(englishPath) || !publicPaths.has(spanishPath)) return

  const editorial = parseEditorialPath(englishPath)
  const suppressesSpanish =
    editorial !== null && isEsHreflangSuppressedSlug(editorial.kind, editorial.slug)
  const isDiscontinuedSpanishMarketing = isDiscontinuedEsMarketingPath(spanishPath)
  const robotsMeta = page.locator('meta[name="robots"]')
  const robots = (await robotsMeta.count())
    ? ((await robotsMeta.first().getAttribute('content')) ?? '')
    : ''
  const isNoIndexListing =
    /noindex/i.test(robots) &&
    (englishPath.startsWith('/blog/category/') || englishPath.startsWith('/blog/tag/'))

  // Category/tag pages are deliberately crawlable but non-indexable facets;
  // they own canonicals without participating in a locale cluster.
  if (isNoIndexListing) {
    await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveCount(0)
    await expect(page.locator('link[rel="alternate"][hreflang="es"]')).toHaveCount(0)
    return
  }

  // Discontinued programmatic Spanish marketing clusters 308 to EN and the
  // English canonical intentionally advertises no locale alternates.
  if (isDiscontinuedSpanishMarketing) {
    await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveCount(0)
    await expect(page.locator('link[rel="alternate"][hreflang="es"]')).toHaveCount(0)
    return
  }

  await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveAttribute(
    'href',
    `${CANDIDATE_ORIGIN}${englishPath === '/' ? '' : encodeURI(englishPath)}`,
  )
  await expect(page.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveAttribute(
    'href',
    `${CANDIDATE_ORIGIN}${englishPath === '/' ? '' : encodeURI(englishPath)}`,
  )
  const spanishAlternate = page.locator('link[rel="alternate"][hreflang="es"]')
  if (suppressesSpanish) {
    await expect(spanishAlternate).toHaveCount(0)
  } else {
    await expect(spanishAlternate).toHaveAttribute(
      'href',
      `${CANDIDATE_ORIGIN}${encodeURI(spanishPath)}`,
    )
  }
}

function parseEditorialPath(
  pathname: string,
): { kind: EsEditorialKind; locale: 'en' | 'es'; slug: string } | null {
  const locale = pathname.startsWith('/es/') ? 'es' : 'en'
  const localizedPath = locale === 'es' ? pathname.slice(3) : pathname
  const match = localizedPath.match(/^\/(blog|guides)\/([^/]+)$/)
  if (!match) return null
  return { kind: match[1] as EsEditorialKind, locale, slug: decodeURIComponent(match[2]!) }
}

async function settleVisualPage(page: import('@playwright/test').Page) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        scroll-behavior: auto !important;
        transition-delay: 0s !important;
        transition-duration: 0s !important;
      }
    `,
  })
  await page.evaluate(async () => {
    const bounded = (promise: Promise<unknown>, timeoutMs: number) =>
      Promise.race([promise, new Promise<void>(resolve => window.setTimeout(resolve, timeoutMs))])

    await bounded(document.fonts.ready, 5_000)

    const localImages = [...document.images].filter(image => {
      const source = image.currentSrc || image.src
      return source !== '' && new URL(source, location.href).origin === location.origin
    })
    for (const image of localImages) {
      image.loading = 'eager'
      image.fetchPriority = 'high'
    }

    // Walk the whole document before capturing the stable fold so lazy media,
    // reveal observers, and link prefetches are exercised on every route.
    const waitForPaint = () =>
      new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )

    for (const reveal of document.querySelectorAll<HTMLElement>('[data-section-reveal]')) {
      reveal.scrollIntoView({ block: 'center' })
      await waitForPaint()
      await new Promise<void>(resolve => window.setTimeout(resolve, 20))
    }

    const step = Math.max(1, Math.floor(window.innerHeight * 0.65))
    const bottom = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    for (let top = 0; top < bottom; top += step) {
      window.scrollTo(0, top)
      await waitForPaint()
    }
    window.scrollTo(0, bottom)
    await waitForPaint()

    document.querySelectorAll('video').forEach(video => video.pause())
    await bounded(
      Promise.all(
        localImages.map(async image => {
          if (!image.complete) {
            await new Promise<void>(resolve => {
              image.addEventListener('load', () => resolve(), { once: true })
              image.addEventListener('error', () => resolve(), { once: true })
            })
          }
          await image.decode().catch(() => undefined)
        }),
      ),
      10_000,
    )
    const missingImages = localImages
      .filter(image => !image.complete || image.naturalWidth === 0)
      .map(image => image.currentSrc || image.src)
    if (missingImages.length > 0) {
      throw new Error(`Local images did not settle: ${missingImages.join(', ')}`)
    }
    window.scrollTo(0, 0)
    await waitForPaint()
  })
}

function selectShard<T>(items: readonly T[]): readonly T[] {
  const count = readShardValue('PUBLIC_VISUAL_SHARD_COUNT', 1)
  const index = readShardValue('PUBLIC_VISUAL_SHARD_INDEX', 0)
  if (count < 1) throw new Error('PUBLIC_VISUAL_SHARD_COUNT must be at least 1')
  if (index < 0 || index >= count) {
    throw new Error('PUBLIC_VISUAL_SHARD_INDEX must be between 0 and shard count - 1')
  }
  return items.filter((_, itemIndex) => itemIndex % count === index)
}

function selectRoutes<T extends { publicPath: string }>(items: readonly T[]): readonly T[] {
  const sharded = selectShard(items)
  const pattern = process.env.PUBLIC_VISUAL_ROUTE_PATTERN
  if (pattern === undefined) return sharded
  const matcher = new RegExp(pattern)
  return sharded.filter(route => matcher.test(route.publicPath))
}

function readShardValue(name: string, fallback: number): number {
  const value = process.env[name]
  if (value === undefined) return fallback
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`)
  return Number(value)
}

function assertUniqueSnapshotIds(routes: readonly { publicPath: string }[]) {
  const owners = new Map<string, string>()
  for (const route of routes) {
    const id = publicRouteId(route.publicPath)
    const existing = owners.get(id)
    if (existing !== undefined) {
      throw new Error(`Public routes ${existing} and ${route.publicPath} share snapshot id ${id}`)
    }
    owners.set(id, route.publicPath)
  }
}
