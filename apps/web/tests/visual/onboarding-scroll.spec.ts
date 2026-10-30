import { expect, test } from '@playwright/test'

/* Onboarding fills the window and scrolls a box inside it, so the box has to BE
   the window: a reader whose pointer is over the margin beside the text still
   expects the wheel to move the step. A scroll owner clamped to the reading
   column leaves the rest of the window dead to it. */
test('an onboarding step scrolls with the pointer anywhere in the window', async ({ page }) => {
  // The goal param drops the walk at the goal's only follow-up; one tap on the
  // smart default reaches the team step, the one tall enough to overflow.
  await page.goto('/playground/onboarding?goal=grow-business')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Choose your starting team' })).toBeVisible()

  const scroller = page.locator('[data-onboarding-scroll]')
  const overflow = await scroller.evaluate(element => element.scrollHeight - element.clientHeight)
  expect(
    overflow,
    'the step under test has to overflow before scrolling can prove anything',
  ).toBeGreaterThan(0)

  // The far edge of the window, well outside the reading column.
  const viewport = page.viewportSize()!
  await page.mouse.move(8, Math.round(viewport.height / 2))
  await page.mouse.wheel(0, 400)

  await expect
    .poll(async () => await scroller.evaluate(element => element.scrollTop))
    .toBeGreaterThan(0)
})
