import { expect, test } from '@playwright/test'

const scenarios = [
  {
    id: 'sign-in-en',
    locale: 'en',
    colorScheme: 'light',
    heading: 'Welcome to Duet',
    terms: 'terms',
    privacy: 'privacy policy',
    legalPrefix: '',
  },
  {
    id: 'sign-in-es',
    locale: 'es-419',
    colorScheme: 'light',
    heading: 'Te damos la bienvenida',
    terms: 'términos',
    privacy: 'política de privacidad',
    legalPrefix: '/es',
  },
  {
    id: 'sign-in-dark-en',
    locale: 'en',
    colorScheme: 'dark',
    heading: 'Welcome to Duet',
    terms: 'terms',
    privacy: 'privacy policy',
    legalPrefix: '',
  },
] as const

for (const scenario of scenarios) {
  test(`auth/auth-surfaces-${scenario.id}`, async ({ page, context }) => {
    const browserErrors: string[] = []
    page.on('console', message => {
      if (message.type() === 'error') browserErrors.push(message.text())
    })
    page.on('pageerror', error => browserErrors.push(error.message))
    page.on('response', response => {
      if (response.status() >= 400 && response.url().startsWith('http://localhost:3000')) {
        browserErrors.push(`${response.status()} ${response.url()}`)
      }
    })

    await page.emulateMedia({
      colorScheme: scenario.colorScheme,
      reducedMotion: 'reduce',
    })
    await context.addCookies([
      {
        name: 'DUET_LOCALE',
        value: scenario.locale,
        url: 'http://localhost:3000',
      },
    ])
    const response = await page.goto('/sign-in', { waitUntil: 'networkidle' })

    expect(response?.status()).toBeLessThan(400)
    await expect(page).toHaveURL('http://localhost:3000/sign-in')
    await expect(page.locator('[data-runtime-locale]')).toHaveAttribute(
      'data-runtime-locale',
      scenario.locale,
    )
    await expect(page.getByRole('heading', { name: scenario.heading })).toBeVisible()
    await expect(page.getByRole('link', { name: scenario.terms })).toHaveAttribute(
      'href',
      `https://duet.so${scenario.legalPrefix}/terms`,
    )
    await expect(page.getByRole('link', { name: scenario.privacy })).toHaveAttribute(
      'href',
      `https://duet.so${scenario.legalPrefix}/privacy-policy`,
    )
    await page.evaluate(() => document.fonts.ready)
    expect(browserErrors).toEqual([])
    await expect(page).toHaveScreenshot(`${scenario.id}.png`, {
      fullPage: true,
      timeout: 15_000,
    })
  })
}

test('auth/auth-surfaces maps provider return and workspace preparation states', async ({
  page,
}) => {
  await page.goto('/playground/auth-surfaces')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page
    .getByRole('button', { name: 'Auth scenario: Google return' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByRole('status')).toContainText('Signing you in with Google')
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0)
  const googleCardHeight = (await page.locator('section').boundingBox())?.height
  await expect(page).toHaveScreenshot('auth-google-return.png', {
    fullPage: true,
    maxDiffPixelRatio: 0,
  })

  await page
    .getByRole('button', { name: 'Auth scenario: workspace preparation' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByRole('status')).toContainText('Getting your agents ready')
  await expect(page.getByText('Opening Duet…')).toBeVisible()
  const preparingCardHeight = (await page.locator('section').boundingBox())?.height
  expect(Math.abs((googleCardHeight ?? 0) - (preparingCardHeight ?? 0))).toBeLessThanOrEqual(2)
  await expect(page).toHaveScreenshot('auth-workspace-preparing.png', {
    fullPage: true,
    maxDiffPixelRatio: 0,
  })
})

test('auth/auth-surfaces gives a failed sign-out a recovery path', async ({ page }) => {
  await page.goto('/playground/auth-surfaces')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page
    .getByRole('button', { name: 'Auth scenario: sign-out failure' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByRole('heading', { name: "We couldn't finish signing out" })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry sign-out' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Return to sign in' })).toBeVisible()
  await expect(page).toHaveScreenshot('auth-sign-out-failed.png', {
    fullPage: true,
    maxDiffPixelRatio: 0,
  })
})

test('auth/device-approval retires login approval when the inspected code changes', async ({
  page,
}) => {
  await page.goto('/playground/device-approval')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const card = page.locator('section').first()
  await expect(
    card.getByRole('button', {
      name: 'Sign in',
    }),
  ).toBeVisible()
  await card.getByLabel('Device code').fill('ZZZZ-ZZZZ')
  await expect(card.getByText('MacBook Pro', { exact: true })).toHaveCount(0)
  await expect(
    card.getByRole('button', {
      name: 'Sign in',
    }),
  ).toHaveCount(0)
})
