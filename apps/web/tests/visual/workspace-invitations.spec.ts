import { expect, test } from '@playwright/test'

test('playground/workspace-invitations-blocked can log out from the subscription wall', async ({
  page,
}) => {
  await page.goto('/playground/workspace-invitations-blocked')
  const wall = page.locator('[data-entitlement-wall]')
  const logout = wall.getByRole('button', { name: 'Log out', exact: true })
  await expect(logout).toBeVisible()
  await logout.scrollIntoViewIfNeeded()
  await wall.evaluate(element => {
    element.scrollTop = element.scrollHeight
  })
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await expect(page).toHaveScreenshot('entitlement-wall-logout-dark.png', { fullPage: true })
  await logout.focus()
  await expect(logout).toBeFocused()
  await logout.press('Enter')
  await expect(
    page.getByRole('status').filter({ hasText: 'Browser session revoked.' }),
  ).toBeVisible()
})

test('playground/workspace-invitations keeps the accepted destination when earlier onboarding completes', async ({
  page,
}) => {
  await page.goto('/playground/workspace-invitations-onboarding')
  const accept = page.getByRole('button', { name: 'Accept invitation to NewEra' })
  await accept.click()
  await expect(
    page.getByRole('alert').filter({ hasText: 'Could not join the workspace' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: 'Grow my business', exact: true }).click()
  await expect(page.locator('[data-onboarding-step]')).toHaveAttribute(
    'data-onboarding-step',
    'follow-ups',
  )
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.locator('[data-onboarding-step]')).toHaveAttribute(
    'data-onboarding-step',
    'team',
  )
  await page.getByRole('checkbox', { name: 'Select Research', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Select Brief Writer', exact: true }).click()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: 'Enter your workspace' }).click()
  await accept.click()
  await expect(page.locator('[data-team-space="work"]')).toContainText('NewEra')
  await page.evaluate(async () => {
    window.dispatchEvent(new Event('complete-invitation-onboarding'))
    await new Promise<void>(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
  })
  await expect(page.locator('[data-team-space="work"]')).toContainText('NewEra')
  await expect(page.locator('[data-onboarding-step]')).toHaveCount(0)
})

test('playground/low-credit-shell-lifecycle suspends an open workspace dialog during recovery', async ({
  page,
}) => {
  await page.goto('/playground/low-credit-shell-lifecycle')
  await expect(page.locator('[data-low-credit-gate]')).toBeVisible()
  const recover = page.getByRole('button', {
    name: 'Simulate low credit recovery complete',
    includeHidden: true,
  })
  await recover.evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.locator('[data-low-credit-gate]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Switch workspace', exact: true }).click()
  await page.getByRole('menuitem', { name: /Create workspace/ }).click()
  await page.getByLabel('Workspace name').fill('Preserve this workspace draft')
  await page
    .getByRole('button', { name: 'Simulate low credit subscribe', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.locator('[data-low-credit-gate]')).toBeVisible()
  await expect(page.getByLabel('Workspace name')).toHaveCount(0)
  const action = page.getByRole('button', { name: 'Subscribe and continue' })
  await action.focus()
  await expect(action).toBeFocused()
  await recover.evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.locator('[data-low-credit-gate]')).toHaveCount(0)
  await expect(page.getByLabel('Workspace name')).toHaveValue('Preserve this workspace draft')
})

for (const scenario of ['', '-onboarding', '-blocked', '-low-credit']) {
  const onboarding = scenario === '-onboarding'
  test(`playground/workspace-invitations${scenario} accepts from above the current page`, async ({
    page,
  }) => {
    await page.goto(`/playground/workspace-invitations${scenario}`)
    const banner = page.getByRole('region', { name: 'Workspace invitations' })
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('NewEra')
    if (scenario === '-blocked') await expect(page.locator('[data-entitlement-wall]')).toBeVisible()
    const header = onboarding
      ? page.locator('[data-onboarding-step] header')
      : page.locator('[data-team-space="work"]')
    await expect(header).toBeVisible()
    const [bannerBox, headerBox] = await Promise.all([banner.boundingBox(), header.boundingBox()])
    expect(bannerBox).not.toBeNull()
    expect(headerBox).not.toBeNull()
    expect(headerBox!.y).toBeGreaterThanOrEqual(bannerBox!.y + bannerBox!.height)
    if (scenario === '-blocked') {
      const wall = page.locator('[data-entitlement-wall]')
      const dialog = wall.getByRole('dialog')
      const card = await dialog.boundingBox()
      expect(card).not.toBeNull()
      expect(card!.y).toBeGreaterThanOrEqual(bannerBox!.y + bannerBox!.height + 8)
      await wall.evaluate(element =>
        element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }),
      )
      const [scrolledCard, wallBox] = await Promise.all([dialog.boundingBox(), wall.boundingBox()])
      expect(scrolledCard).not.toBeNull()
      expect(wallBox).not.toBeNull()
      expect(scrolledCard!.y + scrolledCard!.height).toBeLessThanOrEqual(
        wallBox!.y + wallBox!.height,
      )
      await expect(banner).toBeInViewport()
      await wall.evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }))
    }
    if (scenario === '-blocked' || scenario === '-low-credit') {
      if (scenario === '-low-credit')
        await expect(page.locator('[data-low-credit-gate]')).toBeVisible()
      const acceptButton = banner.getByRole('button', { name: 'Accept invitation to NewEra' })
      await acceptButton.focus()
      await expect(acceptButton).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(banner.getByRole('button', { name: 'View all' })).toBeFocused()
      const backgroundControl = page.locator('[data-workspace-content] button').first()
      await backgroundControl.focus()
      await expect(backgroundControl).not.toBeFocused()
    }
    const onboardingVisits: string[] = []
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame() && frame.url().includes('/w/newera/onboarding'))
        onboardingVisits.push(frame.url())
    })
    await banner.getByRole('button', { name: 'Accept invitation to NewEra' }).click()
    if (onboarding) {
      await expect(
        page.getByRole('alert').filter({ hasText: 'Could not join the workspace' }),
      ).toContainText('Could not join the workspace. Try again.')
      await expect(page.locator('[data-onboarding-step]')).toBeVisible()
      await expect(banner).toContainText('NewEra')
      await banner.getByRole('button', { name: 'Accept invitation to NewEra' }).click()
    }

    await expect(page.locator('[data-team-space="work"]')).toContainText('NewEra')
    await expect(page.locator('[data-onboarding-step]')).toHaveCount(0)
    await expect(banner).toContainText('International Research Studio')
    expect(onboardingVisits).toEqual([])
    await banner
      .getByRole('button', { name: 'Accept invitation to International Research Studio' })
      .click()
    await expect(page.locator('[data-team-space="work"]')).toContainText(
      'International Research Studio',
    )
    await expect(banner).toHaveCount(0)
  })
}

test('playground/workspace-invitations reviews every invitation and accepts the selected workspace', async ({
  page,
}) => {
  await page.goto('/playground/workspace-invitations')
  const banner = page.getByRole('region', { name: 'Workspace invitations' })
  await banner.getByRole('button', { name: 'View all' }).click()
  await expect(banner).toContainText('From Chris · Editor')
  await expect(banner).toContainText('From Grace · Viewer')
  await expect(page).toHaveScreenshot('workspace-invitations-expanded.png', { fullPage: true })
  await banner
    .getByRole('button', { name: 'Accept invitation to International Research Studio' })
    .click()
  await expect(page.locator('[data-team-space="work"]')).toContainText(
    'International Research Studio',
  )
  await expect(banner).toContainText('NewEra')
})
