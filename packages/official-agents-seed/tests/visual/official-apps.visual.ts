import { expect, test, type Page } from '@playwright/test'

import type { OfficialAppKey } from './drivers'
import { withOfficialApp } from './harness'
import { OFFICIAL_APP_VISUAL_SCENARIOS } from './scenarios'

for (const scenario of OFFICIAL_APP_VISUAL_SCENARIOS) {
  test(`official-apps/${scenario.id}`, async ({ page }) => {
    await withOfficialApp(scenario.app, async app => {
      await scenario.arrange({ appUrl: app.url, directory: app.directory, edge: app.edge })
      const url = new URL(app.url)
      url.searchParams.set('theme', scenario.theme)

      await page.goto(url.href)
      await scenario.interact?.(page)
      await scenario.assertReady(page)
      await expect(page).toHaveScreenshot(`${scenario.id}.png`, { fullPage: true })
    })
  })
}

test('official-apps/narrow onboarding provider rows do not overlap', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'The product frame reaches this width on mobile')
  await page.setViewportSize({ width: 188, height: 725 })

  const scenarios = OFFICIAL_APP_VISUAL_SCENARIOS.filter(scenario =>
    scenario.id.endsWith('-disconnected'),
  )

  for (const scenario of scenarios) {
    await withOfficialApp(scenario.app, async app => {
      await page.goto(app.url.href)
      await scenario.assertReady(page)
      const providerName = await page.locator('.provider-name').first().boundingBox()
      const providerAction = await page.locator('.provider .pill').first().boundingBox()
      expect(providerName, `${scenario.id} provider name`).not.toBeNull()
      expect(providerAction, `${scenario.id} provider action`).not.toBeNull()
      expect(
        providerAction!.y,
        `${scenario.id} provider action starts below its name`,
      ).toBeGreaterThanOrEqual(providerName!.y + providerName!.height)
    })
  }
})

/**
 * The inverse of a test this file used to hold. These pages once carried a
 * Connect button, and because every provider's authorization page refuses to
 * render in a frame, the button had to open a real tab — which came back to the
 * app's own edge URL, leaving the user on a bare second copy of the app instead
 * of in the product. Connecting moved to the onboarding chat, which passes a
 * `redirectTo` path inside Duet. Nothing in the frame may reopen that hole.
 */
function noInFrameAuthorizationTest(input: { id: string; app: OfficialAppKey; heading: string }) {
  test(`official-apps/${input.id} offers no authorization controls or startup popup inside the app frame`, async ({
    page,
  }) => {
    await withOfficialApp(input.app, async app => {
      const popups: Page[] = []
      const recordPopup = (popup: Page) => popups.push(popup)
      page.on('popup', recordPopup)
      // Match AppFrameCanvas; its server-render test separately pins the real
      // product iframe to this policy.
      await page.setContent(
        `<iframe title="Integration onboarding" src="${app.url.href}" sandbox="allow-same-origin allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads"></iframe>`,
      )
      const appFrame = page.frameLocator('iframe[title="Integration onboarding"]')
      await expect(appFrame.getByRole('heading', { name: input.heading })).toBeVisible()

      await expect(appFrame.getByRole('button', { name: /connect/i })).toHaveCount(0)
      // The status alone would be a dead end, so the card that holds it says
      // where connecting actually happens — once, above the rows.
      await expect(appFrame.locator('.hint').first()).toContainText(/ask your agent/i)
      await expect(appFrame.locator('.provider .pill').first()).toHaveText('Not connected')

      // Observe from before navigation through initialized provider markup;
      // this does not claim that an arbitrary later timer can never open a tab.
      expect(popups).toHaveLength(0)
      page.off('popup', recordPopup)
    })
  })
}

noInFrameAuthorizationTest({
  id: 'agent-app-connect-search-console-disconnected',
  app: 'seo-specialist/connect-search-console',
  heading: 'The site your SEO specialist works on',
})

noInFrameAuthorizationTest({
  id: 'agent-app-connect-accounts-disconnected',
  app: 'social-media-manager/connect-accounts',
  heading: 'The accounts your social media manager may use',
})

noInFrameAuthorizationTest({
  id: 'agent-app-connect-helpdesk-disconnected',
  app: 'support-agent/connect-helpdesk',
  heading: 'The queue your support agent works',
})
