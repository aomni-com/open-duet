import { expect, test } from '@playwright/test'

/* The journey fixture exists so onboarding can be walked without registering an
   account. That is only true if the walk actually completes: from the root a
   just-registered browser lands on, through identity → goal → follow-ups →
   team → ready → payment, and out into the workspace the product redirects to. Anything
   less and the fixture is a screenshot, not a playground. */
test('the journey fixture walks registration through to the workspace', async ({ page }) => {
  await page.goto('/playground/onboarding-journey')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  // The SPA's root redirect put a fresh owner on the onboarding gate.
  const step = page.locator('[data-onboarding-step]')
  await expect(step).toHaveAttribute('data-onboarding-step', 'identity')

  await page.getByLabel('Assistant name').fill('Ada')
  await page.getByRole('button', { name: 'Continue' }).click()

  // A goal tile advances on tap; the follow-up opens with a chip pre-selected,
  // so one Continue answers it with the smart default — zero typing.
  await expect(step).toHaveAttribute('data-onboarding-step', 'goal')
  await page.getByRole('button', { name: 'Grow my business', exact: true }).click()
  await expect(step).toHaveAttribute('data-onboarding-step', 'follow-ups')
  await expect(step).toHaveAttribute('data-followup-index', '0')
  await expect(page.locator('[data-onboarding-chip-row] [aria-pressed="true"]')).toHaveCount(1)
  await page.getByRole('button', { name: 'Continue' }).click()

  /* The minimum-3 floor: with the fixture's three-agent catalog the primary
     action stays disabled until every agent is selected, and it *states the
     count it is waiting on* rather than reading "Continue" beside a separate
     hint line — the gate is a count, and a hint line would cost fixed footer
     height on every scroll of a catalog meant to be browsed. Both counts are
     walked because the label is a plural: "agents" at two, "agent" at one, and
     a message that hard-coded either would be wrong at the other. */
  await expect(step).toHaveAttribute('data-onboarding-step', 'team')
  await page.getByRole('checkbox', { name: 'Select Research Assistant' }).click()
  await expect(page.getByRole('button', { name: 'Pick 2 more agents' })).toBeDisabled()
  await page.getByRole('checkbox', { name: 'Select Writing Editor' }).click()
  await expect(page.getByRole('button', { name: 'Pick 1 more agent' })).toBeDisabled()
  await page.getByRole('checkbox', { name: 'Select Data Analyst' }).click()
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled()
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(step).toHaveAttribute('data-onboarding-step', 'ready')
  await expect(page.getByText('Grow my business')).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(step).toHaveAttribute('data-onboarding-step', 'payment')
  await expect(page.getByText('Your payment method is ready', { exact: true })).toBeVisible()
  await expect(page.getByText('Your $5 in free credits is ready')).toBeVisible()
  await page.getByRole('button', { name: 'Enter your workspace' }).click()

  await expect(page.locator('[data-destination-content="agentPage"]')).toBeVisible({
    timeout: 20_000,
  })
})
