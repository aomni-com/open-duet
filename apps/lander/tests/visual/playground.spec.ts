import { expect, test } from '@playwright/test'

import { PLAYGROUND_ENTRIES } from '../../app/playground/registry'

/**
 * One deterministic screenshot per playground entry, desktop and mobile.
 * The shell owns readiness (`body[data-playground-ready="true"]`): fonts,
 * image decode, and layout stability. Reduced motion is emulated at the
 * browser level so components that gate their own timelines on
 * `prefers-reduced-motion` (agent-team viz, train scene, section reveals)
 * render their poster state instead of a race.
 */
test.describe('lander playground', () => {
  for (const entry of PLAYGROUND_ENTRIES) {
    test(`lander/${entry.id}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.goto(`/playground/${entry.id}`)
      await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

      // Reveal-on-scroll sections gate on IntersectionObserver; walk the page
      // once so everything below the fold has entered view, then return to a
      // deterministic scroll origin.
      await page.evaluate(async () => {
        const step = window.innerHeight
        for (let y = 0; y < document.body.scrollHeight; y += step) {
          window.scrollTo(0, y)
          await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)))
        }
        window.scrollTo(0, 0)
        await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)))
      })

      await page.evaluate(() => {
        document.querySelectorAll('nextjs-portal').forEach(element => element.remove())
      })
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${entry.id} must not overflow horizontally`,
      ).toBe(true)
      await expect(page).toHaveScreenshot(`${entry.id}.png`, { fullPage: true, timeout: 15_000 })
    })
  }
})
