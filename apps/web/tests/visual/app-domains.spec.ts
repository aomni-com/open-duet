import { expect, test, type Page } from '@playwright/test'

// These controls only mutate the deterministic REST fixture's remote facts.
async function fixtureControl(page: Page, name: string) {
  await page
    .getByRole('button', { name: `Domain: ${name}`, exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
}

test('playground/app-domains-journey', async ({ page }) => {
  await page.goto('/playground/app-domains-management')
  await page.waitForSelector('body[data-playground-ready="true"]')
  const dialog = page.locator('[data-app-domain-dialog="site"]')
  const panel = page.locator('[data-app-domain-panel="site"]')
  await expect(panel.getByText('TXT', { exact: true })).toBeVisible()
  await expect(panel.getByText('cname.vercel-dns.com', { exact: true })).toBeVisible()
  await expect(dialog).toHaveScreenshot('app-domains-dns.png')
  await fixtureControl(page, 'empty')
  await expect(panel.getByLabel('Domain', { exact: true })).toBeVisible()
  await expect(dialog).toHaveScreenshot('app-domains-empty.png')
  await fixtureControl(page, 'hold mutation')
  await panel.getByLabel('Domain', { exact: true }).fill('https://PORTAL.EXAMPLE.COM/')
  await panel.getByRole('button', { name: 'Attach domain', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Attaching…', exact: true })).toBeDisabled()
  await expect(dialog).toHaveScreenshot('app-domains-submitting.png')
  await fixtureControl(page, 'release mutation')
  await expect(panel.getByText('Connecting', { exact: true })).toBeVisible()
  await expect(panel.getByText('portal.example.com', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Attach domain' })).toHaveCount(0)
  await expect(dialog).toHaveScreenshot('app-domains-pending.png')
  await fixtureControl(page, 'activate')
  await expect(panel.getByText('Connected', { exact: true })).toBeVisible()
  await expect(page.locator('[data-domain-primary-link]')).toHaveAttribute(
    'href',
    'https://portal.example.com/',
  )
  await expect(dialog).toHaveScreenshot('app-domains-active.png')
  await panel.getByRole('button', { name: 'Recheck', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Rechecking…', exact: true })).toBeDisabled()
  await expect(panel.getByRole('status')).toHaveText('Rechecking…')
  await expect(panel.getByRole('button', { name: 'Remove domain', exact: true })).toBeEnabled()
  await expect(page.locator('[data-domain-primary-link]')).toHaveAttribute(
    'href',
    'https://portal.example.com/',
  )
  await expect(dialog).toHaveScreenshot('app-domains-queued-recheck-active.png')
  await fixtureControl(page, 'complete recheck')
  await expect(panel.getByRole('button', { name: 'Recheck', exact: true })).toBeEnabled()
  await expect(panel.getByRole('status')).toHaveText('Connected')
  await panel.getByRole('button', { name: 'Remove domain', exact: true }).click()
  await expect(
    panel.getByText(
      'The app will use its Duet address for standalone links. Its files and visibility will stay the same.',
    ),
  ).toBeVisible()
  await expect(dialog).toHaveScreenshot('app-domains-remove-confirmation.png')
  await panel.getByRole('button', { name: 'Confirm removal', exact: true }).click()
  await expect(panel.getByText('Removing…', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Attach domain' })).toHaveCount(0)
  await expect(page.locator('[data-domain-primary-link]')).toHaveAttribute(
    'href',
    'https://site--acme.edge-staging.duet.so/',
  )
  await expect(dialog).toHaveScreenshot('app-domains-removing.png')
  await fixtureControl(page, 'finish cleanup')
  await expect(panel.getByRole('button', { name: 'Attach domain', exact: true })).toBeVisible()
  await fixtureControl(page, 'conflict next')
  await panel.getByLabel('Domain', { exact: true }).fill('occupied.example.com')
  await panel.getByRole('button', { name: 'Attach domain', exact: true }).click()
  await expect(panel.getByRole('alert')).toHaveText(
    'This domain is already attached to another app.',
  )
  await expect(dialog).toHaveScreenshot('app-domains-refusal.png')
  await fixtureControl(page, 'conflicts')
  await expect(panel.getByRole('region', { name: 'Conflicting DNS records' })).toContainText(
    '192.0.2.8',
  )
  await expect(dialog).toHaveScreenshot('app-domains-conflicts.png')
  await fixtureControl(page, 'long-records')
  await expect(panel.getByText('TXT', { exact: true })).toBeVisible()
  await expect(dialog).toHaveScreenshot('app-domains-long-records.png')
  const overflow = await panel.evaluate(element => element.scrollWidth - element.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
  await fixtureControl(page, 'failed')
  await expect(panel.getByText('Needs attention', { exact: true })).toBeVisible()
  await fixtureControl(page, 'hold mutation')
  await panel.getByRole('button', { name: 'Recheck', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Rechecking…', exact: true })).toBeDisabled()
  await expect(dialog).toHaveScreenshot('app-domains-rechecking.png')
  await fixtureControl(page, 'release mutation')
  await expect(panel.getByRole('status')).toHaveText('Rechecking…')
  await expect(panel.getByRole('button', { name: 'Rechecking…', exact: true })).toBeDisabled()
  await expect(panel.getByRole('button', { name: 'Remove domain', exact: true })).toBeEnabled()
  await expect(dialog).toHaveScreenshot('app-domains-queued-recheck-failed.png')
  await fixtureControl(page, 'complete recheck')
  await expect(panel.getByRole('button', { name: 'Recheck', exact: true })).toBeEnabled()
  await expect(panel.getByRole('status')).toHaveText('Needs attention')
  await expect(dialog).toHaveScreenshot('app-domains-failed.png')
  await fixtureControl(page, 'cleanup-retry')
  await expect(panel.getByRole('button', { name: 'Retry cleanup', exact: true })).toBeVisible()
  await expect(dialog).toHaveScreenshot('app-domains-cleanup-retry.png')
  await panel.getByRole('button', { name: 'Retry cleanup', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Retry cleanup', exact: true })).toHaveCount(0)
  await expect(panel.getByText('Removing…', { exact: true })).toBeVisible()
  await fixtureControl(page, 'operator-repair')
  await expect(panel.getByText('Domain repair needs support', { exact: true })).toBeVisible()
  await expect(panel.getByRole('alert')).toHaveText(
    'A provider operation has an uncertain outcome.',
  )
  await expect(panel.getByRole('button', { name: 'Retry cleanup', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Recheck', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Remove domain', exact: true })).toHaveCount(0)
  await expect(dialog).toHaveScreenshot('app-domains-operator-repair.png')
  await fixtureControl(page, 'unavailable')
  await expect(panel.getByText(/This app is currently unavailable/)).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Remove domain', exact: true })).toBeEnabled()
  await expect(dialog).toHaveScreenshot('app-domains-unavailable.png')
  await fixtureControl(page, 'read-only')
  await expect(panel.getByText(/You can view this domain/)).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Recheck', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Remove domain', exact: true })).toHaveCount(0)
  await expect(dialog).toHaveScreenshot('app-domains-read-only.png')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'App options', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Custom domains', exact: true })).toBeVisible()
  await expect(page.getByRole('menu')).toHaveScreenshot('app-domains-menu.png')
  await page.getByRole('menuitem', { name: 'Custom domains', exact: true }).click()
  await expect(panel.getByText(/You can view this domain/)).toBeVisible()
  await fixtureControl(page, 'Spanish')
  await expect(
    dialog.getByRole('heading', { name: 'Dominios personalizados', exact: true }),
  ).toBeVisible()
  await expect(dialog).toHaveScreenshot('app-domains-read-only-spanish.png')
})
