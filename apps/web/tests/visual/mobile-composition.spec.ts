/* The phone compositions, asserted as geometry rather than photographed.

   A screenshot proves a picture did not change; it cannot say *why* it is right,
   and it goes green again the moment somebody approves a bad one. These are the
   claims the mobile work actually makes, written so that breaking one is a
   failure with a sentence attached:

   - the workspace home is the root agent's conversation, and the roster reaches
     the rest of them;
   - the agent surface is one column, never two;
   - the pane that is showing gets the window, not a share of it;
   - the doors that have no other entrance in the product are reachable from
     *both* panes — which is the whole of the claim that a switch is not hiding;
   - arriving at an agent lands on the conversation.

   Runs in `mobile-touch` because that project is 390 wide. Nothing here needs a
   touchscreen — every question below is about the width of the container — but a
   suite that measures rather than shoots belongs beside the other one. */
import { expect, test } from '@playwright/test'

const PHONE = { width: 390, height: 844 }

async function open(page: import('@playwright/test').Page, route: string) {
  await page
    .getByRole('button', {
      name: `Browser route: ${route}`,
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await page.waitForTimeout(2_200)
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(PHONE)
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', {
    timeout: 90_000,
  })
})

test('Team Space keeps cards and primary touch targets inside every compact viewport', async ({
  page,
}) => {
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 844 })
    await page.goto('/playground/team-space-home')
    await page.waitForSelector('body[data-playground-ready="true"]', {
      timeout: 90_000,
    })

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `Team Space must not overflow horizontally at ${width}px`,
    ).toBe(true)

    for (const card of await page.locator('[data-work-app-card]').all()) {
      await card.scrollIntoViewIfNeeded()
      const box = await card.boundingBox()
      expect(box).not.toBeNull()
      if (box === null) continue
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1)
    }

    const touchTargets = page
      .locator('[data-work-starter]')
      .or(page.getByRole('navigation', { name: 'Work navigation' }).getByRole('button'))
    for (const target of await touchTargets.all()) {
      const box = await target.boundingBox()
      expect(box).not.toBeNull()
      if (box === null) continue
      expect(box.height).toBeGreaterThanOrEqual(44)
    }
  }
})

test('the mobile Chats sheet keeps every conversation target finger-sized', async ({ page }) => {
  await page.goto('/playground/team-space-home')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 90_000 })
  await page.getByRole('button', { name: 'Chats', exact: true }).click()

  const sheet = page.getByRole('dialog')
  await expect(sheet.getByText('Other chats', { exact: true })).toBeVisible()
  const targets = sheet
    .locator('[data-work-conversation]')
    .or(sheet.locator('[data-work-agent-conversations] button'))
  for (const target of await targets.all()) {
    const box = await target.boundingBox()
    expect(box).not.toBeNull()
    if (box !== null) expect(box.height).toBeGreaterThanOrEqual(44)
  }
})

/* This used to assert that a phone's `/agents` was a page-sized list with no
   canvas mounted, drawn by a component built for exactly that width. There is
   no such component any more and no such meaning for that path: the bare path
   is the root agent's conversation at every width, and the list is the roster
   column, which below `sm` is the full-width panel it already knew how to be.

   The claims survive the rewrite because they were never really about that
   component — they are about a phone being able to reach a second agent and
   create one. Both are still asked, of the surface that answers them now. */
test('the workspace home is the root agent on a phone, and the roster still reaches the rest', async ({
  page,
}) => {
  await open(page, '/w/acme/agents')

  /* The canvas is not merely hidden — it is not mounted. A map behind a
     `display: none` would still solve a camera and run a motion loop on a
     device that has neither the room to show it nor the budget to run it. The
     bare path is a conversation now, so this holds for a new reason: the graph
     is a different destination rather than a composition of this one. */
  await expect(page.locator('.knowledge-map')).toHaveCount(0)

  /* The roster is the panel, and it opens over the conversation. Its control is
     the only way to a second agent at this width. */
  await page.getByRole('button', { name: /show agents/i }).click()
  await page.waitForTimeout(600)

  /* Scoped to the roster's own nav: the rows carry a horizontally scrolling
     strip of app pills that is itself a list, and an unscoped `li` picks those
     up and measures the wrong thing. */
  const rows = page.locator('nav[aria-label] > ul > li')
  expect(await rows.count()).toBeGreaterThan(0)
  for (const row of await rows.all()) {
    const box = await row.boundingBox()
    /* Full width, give or take the panel's own gutters. A row that came out
       narrow would mean the panel is still wearing the column it is at desktop
       widths. */
    expect(box!.width).toBeGreaterThan(PHONE.width * 0.85)
  }

  /* The ring's add slot is a face on the canvas, and the phone list that used
     to carry it in a page header is gone. The roster's head is the one door
     left, and a phone that cannot reach it cannot create an agent at all. */
  await expect(page.getByRole('button', { name: /add an agent/i })).toBeVisible()
})

test('the agent surface is one column, and the pane showing gets the window', async ({ page }) => {
  await open(page, '/w/acme/agents/root')

  const sheet = page.locator('.km-sheet')
  await expect(sheet).toHaveAttribute('data-pane', 'chat')

  /* Never both. Two panes on screen at 390 is the defect this composition
     exists to remove: it is what produced a 170px conversation beside a 190px
     card, with the words cut mid-letter. */
  const chat = await page.locator('.km-chat').boundingBox()
  expect(await page.locator('.km-card').boundingBox()).toBeNull()
  expect(chat!.width).toBeGreaterThan(PHONE.width * 0.9)

  /* The header is a header, not a third of the screen. 159px before this work,
     and the conversation was left with about sixty. */
  const well = await page.locator('.km-well').boundingBox()
  expect(well!.height).toBeLessThanOrEqual(72)
  expect(chat!.height).toBeGreaterThan(PHONE.height * 0.7)
})

test('both panes are named, and switching to one does not cost the other', async ({ page }) => {
  await open(page, '/w/acme/agents/root')

  /* Scoped to the switch. The window's own bar is a tablist too, and an
     unscoped `tab` role collects its three destinations as well. */
  const segments = page.locator('.km-pane-switch').getByRole('tab')
  await expect(segments).toHaveCount(2)
  /* A segment names its own content. "Work" would be a category, and a reader
     who has to guess what is behind a tab is reading a menu — which is the
     thing this composition claims not to be. */
  for (const segment of await segments.all()) {
    expect((await segment.textContent())!.trim().length).toBeGreaterThan(0)
  }

  await segments.nth(1).click()
  await expect(page.locator('.km-sheet')).toHaveAttribute('data-pane', 'work')
  expect(await page.locator('.km-chat').boundingBox()).toBeNull()
  /* And back, because a switch that only goes one way is a navigation. */
  await segments.nth(0).click()
  await expect(page.locator('.km-sheet')).toHaveAttribute('data-pane', 'chat')
})

test('Train and Settings are reachable from either pane', async ({ page }) => {
  /* The load-bearing test of the whole design. These have no other door
     anywhere in the product, so if a pane can hide them then the switch really
     is hiding something and the composition is wrong.

     Jobs was the third, and is not a door any more: the dialog behind it is
     gone and an agent's non-default conversations live in Work, which is a mode
     rather than a menu item. Keeping it here would have asserted that a deleted
     surface stays reachable. */
  await open(page, '/w/acme/agents/root')

  const segments = page.locator('.km-pane-switch').getByRole('tab')
  for (const pane of [0, 1]) {
    await segments.nth(pane).click()
    await page.waitForTimeout(400)
    await page.locator('.km-overflow').click()
    const menu = page.getByRole('menu')
    for (const name of [/train/i, /settings/i]) {
      await expect(menu.getByRole('menuitem', { name })).toBeVisible()
    }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }
})

test('the pane follows the address, and arriving means the conversation', async ({ page }) => {
  /* Arriving at an agent opens the conversation even though the bare path
     redirects to the agent's folder — the redirect gives the card something to
     draw and is not a request to look at it. */
  await open(page, '/w/acme/agents/research')
  await expect(page.locator('.km-sheet')).toHaveAttribute('data-pane', 'chat')

  /* But an address that names a card opens on it. This failed before the pane
     learnt to follow the URL: the card changed underneath a reader left looking
     at the conversation, so the link appeared to do nothing at all. */
  await open(page, '/w/acme/agents/root/files')
  await expect(page.locator('.km-sheet')).toHaveAttribute('data-pane', 'work')
})

test('playground/compose-bar provider aliases are reachable by touch', async ({
  page,
}, testInfo) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await page.goto('/playground/compose-bar')
    await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Quality: Standard' }).tap()
    await page.getByRole('button', { name: 'Advanced', exact: true }).tap()
    const choice = page.getByRole('radio', { name: /^Anthropic recommended\b/ })
    await choice.scrollIntoViewIfNeeded()
    await expect(choice).toBeInViewport()
    await choice.tap()
    await expect(
      page.getByRole('button', { name: /^Quality: Anthropic recommended\b/ }),
    ).toBeVisible()
    await expect
      .poll(() =>
        page
          .getByRole('button', { name: /^Quality: Anthropic recommended\b/ })
          .getByText('Anthropic recommended', { exact: true })
          .evaluate(label => label.scrollWidth <= label.clientWidth),
      )
      .toBe(true)
    await page.getByRole('button', { name: /^Quality: Anthropic recommended\b/ }).tap()
    await page.getByRole('radio', { name: /^Anthropic frontier\b/ }).tap()
    await expect
      .poll(() =>
        page
          .getByRole('button', { name: /^Quality: Anthropic frontier\b/ })
          .getByText('Anthropic frontier', { exact: true })
          .evaluate(label => label.scrollWidth <= label.clientWidth),
      )
      .toBe(true)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`provider-label-${width}.png`) })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
})
