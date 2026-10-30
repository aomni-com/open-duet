import { expect, test, type Page } from '@playwright/test'

async function control(page: Page, name: string) {
  await page
    .getByRole('button', {
      name: `Inventory: ${name}`,
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
}

async function requests(page: Page) {
  return JSON.parse(
    (await page.locator('[data-workspace-domain-requests]').textContent()) ?? '[]',
  ) as Array<{ path: string; method: string }>
}

test('playground/workspace-app-domains-journey', async ({ page }) => {
  await page.goto('/playground/workspace-app-domains')
  await page.waitForSelector('body[data-playground-ready="true"]')
  const inventory = page.locator('[data-workspace-app-domains]')
  await expect(inventory.locator('[data-app-domain-row]')).toHaveCount(5)
  await expect(page.getByRole('link', { name: 'App domains', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  )
  expect(await requests(page)).toEqual([
    { path: '/api/duet/ws/acme/app-domains?limit=100', method: 'GET' },
  ])
  await expect(page.locator('section').first()).toHaveScreenshot('workspace-domains-ready.png')
  expect(
    await inventory.evaluate(element => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1)

  await control(page, 'fail next page')
  await page.getByRole('button', { name: 'Load more', exact: true }).click()
  await expect(inventory.locator('[data-app-domain-row]')).toHaveCount(5)
  await expect(
    page.getByText('More domains could not be loaded. Your current list is still shown.'),
  ).toBeVisible()
  await expect(page.locator('section').first()).toHaveScreenshot('workspace-domains-page-error.png')
  await page.getByRole('button', { name: 'Retry loading more', exact: true }).click()
  await expect(inventory.locator('[data-app-domain-row]')).toHaveCount(6)
  await expect(page.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0)
  expect((await requests(page)).filter(item => item.path.includes('cursor=page-two'))).toHaveLength(
    2,
  )
  await expect(page.locator('section').first()).toHaveScreenshot('workspace-domains-paged.png')

  await control(page, 'fail refresh')
  await expect(
    page.getByText('The latest domains could not be loaded. The saved list is still shown.'),
  ).toBeVisible()
  await expect(inventory.locator('[data-app-domain-row]')).toHaveCount(6)
  await expect(page.locator('section').first()).toHaveScreenshot(
    'workspace-domains-refresh-error.png',
  )
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(inventory.getByRole('alert')).toHaveCount(0)

  const reporting = inventory.locator('[data-app-domain-row="reporting"]')
  await reporting.getByRole('button', { name: 'Manage domain', exact: true }).click()
  const reportingPanel = page.locator('[data-app-domain-panel="reporting"]')
  await reportingPanel.getByRole('button', { name: 'Recheck', exact: true }).click()
  await expect(reportingPanel.getByRole('status')).toHaveText('Rechecking…')
  await page.keyboard.press('Escape')
  await expect(reportingPanel).toHaveCount(0)
  await expect(reporting.getByRole('status')).toHaveText('Rechecking…')
  const closedPointReads = (await requests(page)).filter(item =>
    item.path.endsWith('/apps/reporting/domain'),
  ).length
  await expect(page.locator('section').first()).toHaveScreenshot(
    'workspace-domains-queued-recheck-closed.png',
  )
  await control(page, 'complete recheck')
  await expect(reporting.getByRole('status')).toHaveText('Connected')
  expect(
    (await requests(page)).filter(item => item.path.endsWith('/apps/reporting/domain')),
  ).toHaveLength(closedPointReads)

  const site = inventory.locator('[data-app-domain-row="site"]')
  await site.getByRole('button', { name: 'Manage domain', exact: true }).click()
  const panel = page.locator('[data-app-domain-panel="site"]')
  await expect(panel.getByText('TXT', { exact: true })).toBeVisible()
  await expect(page.locator('[data-app-domain-dialog="site"]')).toHaveScreenshot(
    'workspace-domains-shared-manager.png',
  )
  await panel.getByRole('button', { name: 'Remove domain', exact: true }).click()
  await panel.getByRole('button', { name: 'Confirm removal', exact: true }).click()
  await expect(site.getByText('Removing…', { exact: true })).toBeVisible()
  await control(page, 'finish cleanup')
  await expect(panel.getByRole('button', { name: 'Attach domain', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(site).toHaveCount(0)
  await expect(inventory.locator('[data-app-domain-row]')).toHaveCount(5)
  await expect(page.locator('section').first()).toHaveScreenshot(
    'workspace-domains-after-removal.png',
  )

  await control(page, 'fail open')
  await reporting.getByRole('button', { name: 'Open app', exact: true }).click()
  await expect(page.getByText('The app could not be opened. Try again.')).toBeVisible()
  await expect(page).toHaveScreenshot('workspace-domains-open-error.png', {
    fullPage: true,
  })
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
  const navigationRequests = (await requests(page)).filter(
    item => item.path.endsWith('/apps/reporting') || item.path.endsWith('/agents?limit=100'),
  )
  expect(navigationRequests).toHaveLength(2)
  await reporting.getByRole('button', { name: 'Open app', exact: true }).click()
  await expect(page.locator('[data-workspace-domain-destination]')).toHaveText(
    '/w/acme/agents/research/apps/reporting',
  )
  expect((await requests(page)).filter(item => item.path.endsWith('/apps/reporting'))).toHaveLength(
    2,
  )
  expect((await requests(page)).filter(item => item.path.includes('/agents?'))).toHaveLength(1)

  await control(page, 'empty')
  await expect(page.getByText('No app domains yet', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Browse apps', exact: true })).toHaveAttribute(
    'href',
    '/w/acme/agents/graph',
  )
  await expect(page.locator('section').first()).toHaveScreenshot('workspace-domains-empty.png')
  await control(page, 'loading')
  await expect(page.getByText('Loading app domains', { exact: true })).toBeVisible()
  await expect(page.locator('section').first()).toHaveScreenshot('workspace-domains-loading.png')
  await control(page, 'release loading')
  await expect(inventory.locator('[data-app-domain-row]')).toHaveCount(5)
  await control(page, 'error')
  await expect(page.getByText('App domains could not be loaded', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
  await expect(page.locator('section').first()).toHaveScreenshot('workspace-domains-error.png')
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(inventory.locator('[data-app-domain-row]')).toHaveCount(5)
  await control(page, 'read-only')
  await expect(inventory.getByRole('button', { name: 'Manage domain', exact: true })).toHaveCount(0)
  await expect(page.locator('section').first()).toHaveScreenshot('workspace-domains-read-only.png')
  await site.getByRole('button', { name: 'View domain', exact: true }).click()
  await expect(panel.getByText(/You can view this domain/)).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Remove domain', exact: true })).toHaveCount(0)
  await expect(page.locator('[data-app-domain-dialog="site"]')).toHaveScreenshot(
    'workspace-domains-reader-manager.png',
  )
  await page.keyboard.press('Escape')
  await control(page, 'Spanish')
  await expect(page.getByRole('link', { name: 'Dominios de apps', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(page.locator('section').first()).toHaveScreenshot('workspace-domains-spanish.png')
})

test('playground/workspace-app-domains-address-refresh', async ({ page }) => {
  await page.goto('/playground/workspace-app-domains')
  await page.waitForSelector('body[data-playground-ready="true"]')
  const billing = page.locator('[data-app-domain-row="billing"]')
  await expect(billing.getByRole('status')).toHaveText('Needs attention')
  expect((await requests(page)).filter(item => item.path.includes('/apps/'))).toEqual([])
  await control(page, 'show billing app')
  const menu = page.locator('[data-inventory-app-menu]')
  await menu.getByRole('button', { name: 'App options', exact: true }).click()
  await expect(
    page.getByRole('menuitem', { name: 'Open in new tab', exact: true }),
  ).toHaveAttribute('href', 'https://billing--acme.edge-staging.duet.so/')
  await page.keyboard.press('Escape')
  await billing.getByRole('button', { name: 'Manage domain', exact: true }).click()
  const panel = page.locator('[data-app-domain-panel="billing"]')
  await panel.getByRole('button', { name: 'Recheck', exact: true }).click()
  await expect(panel.getByRole('status')).toHaveText('Rechecking…')
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(billing.getByRole('status')).toHaveText('Rechecking…')
  const closedPointReads = (await requests(page)).filter(item =>
    item.path.endsWith('/apps/billing/domain'),
  ).length
  await control(page, 'complete recheck')
  await expect(billing.getByRole('status')).toHaveText('Connected')
  await menu.getByRole('button', { name: 'App options', exact: true }).click()
  await expect(
    page.getByRole('menuitem', { name: 'Open in new tab', exact: true }),
  ).toHaveAttribute('href', 'https://billing.example.com/')
  expect(
    (await requests(page)).filter(item => item.path.endsWith('/apps/billing/domain')),
  ).toHaveLength(closedPointReads)
  expect(
    (await requests(page)).filter(
      item => item.path.includes('/apps/') && !item.path.includes('/apps/billing'),
    ),
  ).toEqual([])
})
