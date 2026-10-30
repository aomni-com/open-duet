import { expect, test } from '@playwright/test'

/* The drive's column stack keeps the focused column on screen as focus moves
   between columns. That effect must not fire on mount: nothing has been focused
   yet, and a column is taller than the panel that holds it, so bringing it into
   view scrolls the panel down by the height of everything above it — the share
   banner, the toolbar, the breadcrumb. A recipient who lands on a drive with a
   pending share sees that banner scroll away on its own, and because the scroll
   is declared `behavior: 'smooth'` it lands tens to hundreds of milliseconds
   after the panel says it is ready. That is also what made the visual suite
   photograph the same surface from two heights on two runs. */
test('opening a drive leaves the panel at the top', async ({ page }) => {
  // The share fixtures leave the folder listing to the workspace API, so the
  // column stack this test is about only renders once that is answered.
  await page.route('**/api/duet/ws/*/files**', async route => {
    const url = new URL(route.request().url())
    if (route.request().method() !== 'GET' || !url.searchParams.has('list')) {
      return await route.continue()
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        entries: ['Shared', 'Projects'].map(name => ({
          name,
          path: name,
          type: 'directory',
          size: 0,
          mtime: '2026-07-15T08:00:00.000Z',
        })),
      }),
    })
  })
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Scenario: share-several', exact: true })
    .evaluate((button: HTMLButtonElement) => button.click())

  const panel = page.locator('#drive-panel-files')
  await expect(
    page.locator('[data-destination-content]').getByRole('heading', { name: 'Drive', exact: true }),
  ).toBeVisible()
  await expect(page.locator('[data-files-card]').first()).toBeVisible()
  const overflow = await panel.evaluate(element => element.scrollHeight - element.clientHeight)
  expect(
    overflow,
    'the panel has to overflow before a stray scroll could prove anything',
  ).toBeGreaterThan(0)

  // Long enough for a smooth scroll to have finished, so a pass means the
  // scroll never started rather than that it had not landed yet.
  await page.waitForTimeout(1_000)
  expect(await panel.evaluate(element => element.scrollTop)).toBe(0)
})
