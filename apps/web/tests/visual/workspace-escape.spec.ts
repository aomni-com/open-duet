import { expect, test } from '@playwright/test'

test('playground/spa-shell-workspace-escape resets setup when switching between unfinished workspaces', async ({
  page,
}) => {
  await page.goto('/playground/workspace-invitations-onboarding')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page.getByLabel('Assistant name', { exact: true }).fill('Acme assistant')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.locator('[data-onboarding-step]')).toHaveAttribute(
    'data-onboarding-step',
    'goal',
  )
  await page.getByRole('button', { name: 'Switch workspace', exact: true }).click()
  await page.getByRole('menuitem', { name: /Duet Labs/ }).click()
  await expect(page.locator('[data-onboarding-step]')).toHaveAttribute(
    'data-onboarding-step',
    'identity',
  )
  await expect(page.getByLabel('Assistant name', { exact: true })).toHaveValue('Duet')
})

test('playground/spa-shell-workspace-escape recovers from an unavailable workspace', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Scenario: invalid-workspace', exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByRole('heading', { name: 'Workspace unavailable' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Switch workspace', exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('unavailable-workspace.png', { fullPage: true })
  await page.getByRole('button', { name: 'Switch workspace', exact: true }).click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: /Duet Labs/ })).toBeVisible()
  await expect(page).toHaveScreenshot('unavailable-workspace-switcher.png', { fullPage: true })
  await menu.getByRole('menuitem', { name: /Duet Labs/ }).click()
  await expect(page.getByRole('heading', { name: 'Workspace unavailable' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Switch workspace', exact: true })).toContainText(
    'Duet Labs',
  )
})

test('playground/spa-shell-workspace-escape leaves unfinished onboarding for another workspace', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Scenario: onboarding', exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  const onboarding = page.locator('[data-onboarding-step]')
  await expect(onboarding).toBeVisible()
  await expect(page).toHaveScreenshot('unfinished-onboarding.png', { fullPage: true })
  await onboarding.getByRole('button', { name: 'Switch workspace', exact: true }).click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: /Duet Labs/ })).toBeVisible()
  await expect(page).toHaveScreenshot('onboarding-workspace-switcher.png', { fullPage: true })
  await menu.getByRole('menuitem', { name: /Duet Labs/ }).click()
  await expect(onboarding).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Switch workspace', exact: true })).toContainText(
    'Duet Labs',
  )
  await page.getByRole('button', { name: 'Switch workspace', exact: true }).click()
  await page.getByRole('menuitem', { name: /Acme Studio/ }).click()
  await expect(onboarding).toHaveAttribute('data-onboarding-step', 'identity')
})
