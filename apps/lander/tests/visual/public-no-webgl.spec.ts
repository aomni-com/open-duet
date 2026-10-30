import { expect, test } from '@playwright/test'

import { NO_WEBGL_PUBLIC_ROUTES, publicRouteId } from './public-visual-contract'

/**
 * The WebGL pages, served to a client that has no WebGL.
 *
 * Decoration must never be able to take the document with it: a scraper, an
 * agent's headless browser, or a machine whose GPU process has died gets a
 * `null` back from `getContext('webgl2')`, three.js turns that into a throw,
 * and — with no error boundary above it — React unmounts the whole page. The
 * assertion is therefore about the page BELOW the canvas still being there,
 * and about the train section still telling its story through the DOM
 * centrepiece it already ships for phones.
 *
 * No screenshots here: this suite runs in a container that HAS WebGL, so the
 * GL-less state is produced by stubbing the context, and what it proves is
 * structural, not pixel-level.
 */

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      contextId: string,
      ...rest: unknown[]
    ) {
      if (typeof contextId === 'string' && contextId.toLowerCase().includes('webgl')) return null
      return (getContext as (...args: unknown[]) => unknown).call(this, contextId, ...rest)
    } as typeof getContext
  })
})

test.describe.configure({ mode: 'parallel' })

for (const route of NO_WEBGL_PUBLIC_ROUTES) {
  test(`lander/lander-no-webgl-${publicRouteId(route)}`, async ({ page }) => {
    const uncaught: string[] = []
    page.on('pageerror', error => uncaught.push(error.message))

    const response = await page.goto(route, { waitUntil: 'load' })
    expect(response?.status(), `${route} must load without WebGL`).toBeLessThan(400)

    // Walk the page so the lazily-mounted shader sections enter view and get
    // their chance to throw.
    await page.evaluate(async () => {
      const step = window.innerHeight
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y)
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      window.scrollTo(0, 0)
    })

    expect(uncaught, `${route} must not throw without WebGL`).toEqual([])
    await expect(
      page.locator('h1').first(),
      `${route} must still render its headline`,
    ).not.toBeEmpty()
    await expect(
      page.locator('footer').first(),
      `${route} must still render everything below the canvas`,
    ).toBeAttached()
    await expect(
      page.locator('[data-train-demo]'),
      `${route} must still offer a train centrepiece`,
    ).toBeAttached()
  })
}
