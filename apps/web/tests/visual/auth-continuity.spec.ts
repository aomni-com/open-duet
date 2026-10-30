import { expect, test } from '@playwright/test'

test('playground/auth-surfaces keeps invitation tokens in an HttpOnly cookie', async ({
  context,
  page,
}) => {
  const token = 'a'.repeat(64)
  await page.goto(`/invite/${token}`)
  await expect(page).toHaveURL(/\/sign-in\?invited=1$/)
  expect(page.url()).not.toContain(token)
  const pending = (await context.cookies()).find(cookie => cookie.name === 'duet_pending_invite')
  expect(pending).toMatchObject({ value: token, httpOnly: true, sameSite: 'Lax' })
})

test('playground/auth-surfaces sends protected device deep links through sign-in', async ({
  page,
}) => {
  await page.goto('/device?user_code=DJ7K-MP4Q')
  await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Fdevice%3Fuser_code%3DDJ7K-MP4Q$/)
})

test('signed-out root product routes preserve their full return destination', async ({ page }) => {
  for (const pathname of [
    '/',
    '/w/acme/sessions?from=direct',
    '/settings/billing',
    '/internal-admin',
  ]) {
    await page.goto(pathname)
    await expect(page).toHaveURL(
      `http://localhost:3000/sign-in?returnTo=${encodeURIComponent(pathname)}`,
    )
  }
})

test('the removed app mount is not redirected or rewritten', async ({ page }) => {
  const response = await page.goto('/app')
  expect(response?.status()).toBe(404)
  await expect(page).toHaveURL('http://localhost:3000/app')
})

test('playground/auth-surfaces preserves private app bridge targets through sign-in', async ({
  page,
}) => {
  for (const host of ['todo--acme.edge.duet.so', 'aomni.co']) {
    const destination = `/w/acme/apps/todo/open?${new URLSearchParams({ host, path: '/deep?q=a%2Fb' })}`
    await page.goto(destination)
    await expect(page).toHaveURL(
      `http://localhost:3000/sign-in?returnTo=${encodeURIComponent(destination)}`,
    )
  }
})
