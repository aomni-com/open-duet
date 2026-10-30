import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
})

test('the shared locale preference carries through sign-in into the SPA boundary', async ({
  page,
  context,
}) => {
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
    true,
  )
  await context.addCookies([{ name: 'DUET_LOCALE', value: 'es-419', url: 'http://localhost:3000' }])

  await page.goto('/')
  await expect(page).toHaveURL(/\/sign-in\?returnTo=%2F$/)
  await expect(page.locator('[data-runtime-locale]')).toHaveAttribute(
    'data-runtime-locale',
    'es-419',
  )
  await expect(page.locator('[data-runtime-locale]')).toHaveAttribute('lang', 'es-419')

  await context.clearCookies()
  await context.addCookies([{ name: 'DUET_LOCALE', value: 'en', url: 'http://localhost:3000' }])
  await page.goto('/sign-in')
  await expect(page).toHaveURL('http://localhost:3000/sign-in')
  await expect(page.locator('[data-runtime-locale]')).toHaveAttribute('data-runtime-locale', 'en')
  await expect
    .poll(
      async () => (await context.cookies()).find(cookie => cookie.name === 'DUET_LOCALE')?.value,
    )
    .toBe('en')
})
