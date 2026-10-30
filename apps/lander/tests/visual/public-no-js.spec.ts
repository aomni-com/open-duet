import { expect, test } from '@playwright/test'

import { NO_JS_PUBLIC_ROUTES, publicRouteId } from './public-visual-contract'

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
})

const NO_JS_ROUTES = selectShard(NO_JS_PUBLIC_ROUTES)

test.use({ javaScriptEnabled: false })
test.describe.configure({ mode: 'parallel' })

for (const route of NO_JS_ROUTES) {
  test(`lander/lander-no-js-${publicRouteId(route)}`, async ({ page }) => {
    const response = await page.goto(route, { waitUntil: 'domcontentloaded' })
    expect(response, `${route} must return a document response`).not.toBeNull()
    expect(response?.status(), `${route} must load without JavaScript`).toBeLessThan(400)
    expect(
      (await page.locator('body').innerText()).trim().length,
      `${route} must retain meaningful static HTML`,
    ).toBeGreaterThan(100)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `${route} must not overflow horizontally without JavaScript`,
    ).toBe(true)

    await expect(page).toHaveScreenshot(`no-js-${publicRouteId(route)}.png`, {
      fullPage: true,
      timeout: 30_000,
    })
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

function readShardValue(name: string, fallback: number): number {
  const value = process.env[name]
  if (value === undefined) return fallback
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`)
  return Number(value)
}
