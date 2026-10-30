import { expect, test } from '@playwright/test'

/* Turning "All agents" off is the one policy toggle the other playground
   tests never drive: they flip a child. Off must save an explicit empty
   policy — nobody — not clear it, which would mean everybody. */
test('playground/spa-shell turning All agents off saves an empty policy', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page.getByRole('tab', { name: 'Integrations', exact: true }).click()

  const access = page.locator('[data-integration-agent-access="gmail"]')
  const panel = page.locator('[data-integration-agent-access-panel="gmail"]')
  await access.getByRole('button').click()
  const all = panel.getByRole('checkbox', { name: 'All agents', exact: true })
  await expect(all).toBeChecked()

  await all.click()

  await expect(page.getByTestId('integration-policy-mutation')).toHaveText(
    '{"integration":"gmail","input":{"allowedAgentIds":[]}}',
  )
  await expect(all).not.toBeChecked()
  await expect(panel.getByRole('checkbox', { name: 'Duet', exact: true })).not.toBeChecked()
})
