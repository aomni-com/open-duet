import path from 'node:path'

import { expect, test } from '@playwright/test'

import type { AgentTurnState } from '@repo/contract'

import { PLAYGROUND_ENTRIES } from '../../app/playground/registry'
import { MARKETPLACE_STATE_KINDS } from '../../components/playground/marketplace-fixture-states'
import { CURRENT_RUNTIME_VERSION } from '../../components/playground/runtime-fixture'

const COMPLETED_TURN_STATE = {
  status: 'completed',
  mode: 'agent',
  agent: { status: 'completed', messages: [] },
} as const satisfies AgentTurnState

async function expectEditableText(locator: import('@playwright/test').Locator, expected: string) {
  await expect
    .poll(() =>
      locator.evaluate(element =>
        element instanceof HTMLTextAreaElement ? element.value : (element.textContent ?? ''),
      ),
    )
    .toBe(expected)
}

function qualityMenuOption(page: import('@playwright/test').Page, label: string) {
  const name = new RegExp(`^${label}\\b`)
  return page.getByRole('menuitemradio', { name }).or(page.getByRole('radio', { name }))
}

async function openWorkConversation(
  page: import('@playwright/test').Page,
  testInfo: import('@playwright/test').TestInfo,
  sessionId: string,
) {
  // The chat list is a sheet on mobile and a rail on desktop, so a row can be
  // attached and unreachable. Mobile opens inside a conversation, which owns
  // the whole width — leave it for home, then open the sheet.
  if (testInfo.project.name === 'mobile') {
    const back = page.getByRole('button', { name: 'Back to Home' })
    if (await back.isVisible()) await back.click()
    await page.getByRole('button', { name: 'Chats', exact: true }).click()
  }
  await page.locator(`[data-work-conversation="${sessionId}"]:visible`).click()
}

async function scrollTimelineContentClear(
  timeline: import('@playwright/test').Locator,
  target: import('@playwright/test').Locator,
) {
  await target.evaluate(element => element.scrollIntoView({ block: 'end' }))
  await expect
    .poll(async () => {
      const [timelineBox, targetBox] = await Promise.all([
        timeline.boundingBox(),
        target.boundingBox(),
      ])
      if (timelineBox === null || targetBox === null) return Number.NEGATIVE_INFINITY
      return timelineBox.y + timelineBox.height - (targetBox.y + targetBox.height)
    })
    // The timeline fades its bottom 1rem under the composer; the shot subject
    // must sit fully above that band, with margin for sub-pixel scroll rest.
    .toBeGreaterThanOrEqual(24)
}

async function routeSessionInlineMediaAssets(page: import('@playwright/test').Page) {
  await page.route('**/playground/session-files/*', async route => {
    const filename = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!)
    const contentType = filename.endsWith('.docx')
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : filename.endsWith('.pptx')
        ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        : filename.endsWith('.pdf')
          ? 'application/pdf'
          : undefined
    if (contentType === undefined) return route.fallback()
    await route.fulfill({
      contentType,
      path: path.join(process.cwd(), 'public/playground/session-files', filename),
    })
  })
  await page.route('**/playground/inline-media/*', async route => {
    const filename = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!)
    if (filename === 'portrait.png' || filename === 'panorama.png') {
      const portrait = filename === 'portrait.png'
      const width = portrait ? 480 : 1200
      const height = portrait ? 800 : 300
      await route.fulfill({
        contentType: 'image/svg+xml',
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#164e63"/><rect x="${width * 0.12}" y="${height * 0.1}" width="${width * 0.76}" height="${height * 0.8}" rx="24" fill="none" stroke="#67e8f9" stroke-width="18"/><circle cx="${width * 0.5}" cy="${height * 0.32}" r="${Math.min(width, height) * 0.12}" fill="#fbbf24"/><path d="M ${width * 0.22} ${height * 0.78} L ${width * 0.43} ${height * 0.55} L ${width * 0.58} ${height * 0.68} L ${width * 0.8} ${height * 0.42}" fill="none" stroke="#fb7185" stroke-width="24"/></svg>`,
      })
      return
    }
    if (filename === 'logo.svg') {
      await route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 24"><rect width="16" height="10" y="12" fill="#f5b301"/><rect width="16" height="18" x="24" y="4" fill="#2ecc8f"/></svg>',
      })
      return
    }
    const extension = filename.split('.').at(-1)
    const contentType =
      extension === 'webm'
        ? 'video/webm'
        : extension === 'wav'
          ? 'audio/wav'
          : extension === 'png'
            ? 'image/png'
            : 'application/octet-stream'
    await route.fulfill({
      contentType,
      path: path.join(process.cwd(), 'tests/visual/assets/session-inline-media', filename),
    })
  })
  await page.route('https://media.example.test/remote.png', async route => {
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#164e63"/><circle cx="480" cy="270" r="170" fill="#67e8f9"/><path d="M280 330 L410 210 L520 300 L680 150" fill="none" stroke="#fef3c7" stroke-width="24"/></svg>',
    })
  })
  await page.route('**/api/duet/ws/acme/files/agents/research/uploads/*', async route => {
    const filename = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!)
    if (filename === 'panorama.png') {
      await route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="300" viewBox="0 0 1200 300"><rect width="1200" height="300" fill="#164e63"/><rect x="60" y="45" width="1080" height="210" rx="24" fill="none" stroke="#67e8f9" stroke-width="18"/><circle cx="250" cy="150" r="58" fill="#fbbf24"/><path d="M430 210 L580 80 L720 190 L930 65" fill="none" stroke="#fb7185" stroke-width="28"/></svg>',
      })
      return
    }
    /* An SVG is markup, and the harness has to say so. It used to be served the
       same PNG as `hero.png`, which was invisible while an `.svg` attachment
       previewed as an image — and became a card full of `IHDR…IDATx` the moment
       `previewKind` started routing text-like extensions to the text preview.
       Production fetches the real file, so the stub serves real markup. */
    if (filename === 'logo.svg') {
      await route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 24">\n  <rect width="16" height="10" y="12" fill="#f5b301"/>\n  <rect width="16" height="18" x="24" y="4" fill="#2ecc8f"/>\n</svg>\n',
      })
      return
    }
    if (filename.endsWith('.csv')) {
      await route.fulfill({
        contentType: 'text/csv',
        body: 'Channel,Owner,Status\nWeb,David,Ready\nMobile,Ada,Review\nEmail,Grace,Ready',
      })
      return
    }
    await route.fulfill({
      contentType: filename.endsWith('.json') ? 'application/json' : 'text/plain',
      body: '# Launch handoff\n\nShip the approved assets and verify every channel.',
    })
  })
}

/* The drive's own actions live behind one mark on the page — upload, create,
   show-hidden and the activity feed are all items in it. Reaching them is two
   steps everywhere, so it is one helper: a test that opens the menu by hand is
   a test that will forget to close it.

   `stayOpen` is for the toggles. They are checkbox items and deliberately leave
   the menu up, because a reader who just showed hidden files is very often
   about to reach for another view control. */
async function runDriveAction(
  page: import('@playwright/test').Page,
  name: string,
  { stayOpen = false }: { stayOpen?: boolean } = {},
) {
  await page.locator('[data-drive-actions]').click()
  const item = page.getByRole(stayOpen ? 'menuitemcheckbox' : 'menuitem', { name, exact: true })
  await expect(item).toBeVisible()
  await item.click()
  if (stayOpen) await page.keyboard.press('Escape')
  await expect(page.locator('[data-drive-actions]')).toBeVisible()
}

async function settleInitialFilesView(page: import('@playwright/test').Page) {
  const browser = page.getByLabel('File browser')
  // The column stack is what "the drive has rendered" means now. The card grid's
  // hero heading is gone with the grid; the surface still carries the sr-only h1.
  const heading = page.getByRole('tree', { name: 'Drive columns' })
  /* What the strip draws in the open. The drive's own actions are behind
     `[data-drive-actions]` — their presence is asserted where they are used,
     not here, because opening a menu is not part of settling a view. */
  const controls = [
    page.locator('[data-drive-actions]'),
    page.getByRole('button', { name: 'Show', exact: true }),
    page.getByRole('button', { name: 'Sort', exact: true }),
    page.locator('[data-drive-density="compact"]'),
  ] as const

  await expect(browser).toBeVisible()
  await expect(heading).toBeAttached()
  await Promise.all(controls.map(control => expect(control).toBeAttached()))
  await browser.evaluate(element => element.scrollTo({ top: 0, left: 0, behavior: 'instant' }))
  await expect
    .poll(() =>
      browser.evaluate(element => ({
        left: element.scrollLeft,
        top: element.scrollTop,
      })),
    )
    .toEqual({ left: 0, top: 0 })
  await expect(heading).toBeVisible()
  await Promise.all(controls.map(control => expect(control).toBeVisible()))

  if ((page.viewportSize()?.width ?? 0) < 640) {
    // The claim worth pinning is not a geometry — the strip wraps — it is that
    // every control it still draws stays reachable inside the viewport rather
    // than running off the edge of a row that does not scroll.
    const viewportWidth = page.viewportSize()?.width ?? 0
    const boxes = await Promise.all(controls.map(control => control.boundingBox()))
    for (const box of boxes) {
      expect(box).not.toBeNull()
      if (box === null) continue
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth + 1)
    }
  }
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
})
test('playground/session-relay-compact protects relay meaning in both hosts under width pressure', async ({
  page,
}) => {
  await page.goto('/playground/session-relay-compact')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const sessionHost = page.getByTestId('relay-session-host')
  const jobHost = page.getByTestId('relay-job-host')
  const isMobile = (page.viewportSize()?.width ?? 0) < 520
  const widths = isMobile ? (['roomy'] as const) : (['roomy', '520', '380'] as const)

  for (const width of widths) {
    await page
      .getByRole('button', { name: `Host width ${width}` })
      .evaluate((button: HTMLButtonElement) => button.click())
    await expect(sessionHost).toHaveAttribute('data-host-width', width)
    const suffix = isMobile ? 'mobile' : width
    await expect(sessionHost).toHaveScreenshot(`session-relay-session-${suffix}.png`, {
      mask: [sessionHost.locator('[data-mask-host]')],
    })
    await expect(jobHost).toHaveScreenshot(`session-relay-job-${suffix}.png`, {
      mask: [jobHost.locator('[data-mask-host]')],
    })
  }

  const sessionSummary = await sessionHost.getByRole('status').getAttribute('aria-label')
  const jobSummary = await jobHost.getByRole('status').getAttribute('aria-label')
  expect(sessionSummary).toBe(jobSummary)
  expect(sessionSummary).toContain('Next: Publish the verified export')

  const coverage = page.getByRole('region', { name: 'Relay state coverage' })
  for (const kind of [
    'agent',
    'script',
    'poll',
    'timer',
    'park',
    'terminal',
    'provider-specific',
  ]) {
    await expect(coverage.locator(`[data-relay-kind="${kind}"]`).first()).toBeVisible()
  }
  await expect(
    coverage.locator('[data-relay-kind="unknown"]').filter({ visible: true }).first(),
  ).toBeVisible()
  await expect(coverage.getByRole('status', { name: /Approval retry relay/ })).toContainText(
    'Wait for approval',
  )
})

test('playground/session-relay-disclosure opens the retained definition path on desktop hover', async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) < 768, 'desktop disclosure contract')

  await page.goto('/playground/session-relay-disclosure')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page
    .getByTestId('relay-disclosure-host')
    .getByRole('status', { name: /Nightly Customer Export/ })
    .hover()
  const disclosure = page.getByLabel('Active relay', { exact: true }).filter({ visible: true })
  await expect(disclosure).toBeVisible()
  await expect(disclosure).toContainText('Relay')
  await expect(disclosure).toContainText('Nightly Customer Export')
  await expect(disclosure).toHaveScreenshot('session-relay-path-desktop.png')
})

test('playground/session-relay-disclosure supports keyboard dismissal and stable current identity', async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) < 768, 'desktop disclosure contract')

  await page.goto('/playground/session-relay-disclosure')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const host = page.getByTestId('relay-disclosure-host')
  const trigger = host.getByRole('status', { name: /Active relay/ })
  const disclosure = page.getByLabel('Active relay', { exact: true }).filter({ visible: true })
  await trigger.focus()
  await expect(disclosure).toBeVisible()

  const viewport = disclosure.getByTestId('relay-path-viewport')
  const current = viewport.locator('[aria-current="step"]')
  await expect(current).toHaveAttribute('data-relay-item-id', '7:retry-two:current')
  await expect
    .poll(async () => {
      const [viewportBox, currentBox] = await Promise.all([
        viewport.boundingBox(),
        current.boundingBox(),
      ])
      if (viewportBox === null || currentBox === null) return false
      return (
        currentBox.y >= viewportBox.y &&
        currentBox.y + currentBox.height <= viewportBox.y + viewportBox.height
      )
    })
    .toBe(true)
  await expect(disclosure.getByTestId('relay-path-top-fade')).toHaveClass(/opacity-100/)
  await expect(disclosure.getByTestId('relay-path-bottom-fade')).toHaveClass(/opacity-100/)

  await viewport.focus()
  await expect(viewport).toBeFocused()
  /* The path reaches the reader by keyboard: it takes focus, and it is a real
     scroll owner rather than a clipped strip.

     What is deliberately NOT asserted here is that PageUp leaves the path
     somewhere new. The path keeps the current step in view and re-asserts that
     on every relay update, and the current step is the last one — so the popover
     sits at its maximum scroll and any key that moves it is immediately undone.
     A press-and-check pinned that as `94` about one run in three, and pressing
     until it took never once won in ten seconds: the product is not racing the
     test, it is overruling it on purpose. An assertion that only passes when it
     samples between a scroll and its correction is measuring the sampling. */
  await expect
    .poll(() => viewport.evaluate(element => element.scrollHeight > element.clientHeight))
    .toBe(true)

  await page.keyboard.press('Escape')
  await expect(disclosure).toBeHidden()

  await trigger.evaluate((button: HTMLButtonElement) => button.blur())
  await page
    .getByRole('button', { name: 'Relay case repeated' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await trigger.focus()
  await expect(disclosure).toBeVisible()
  const repeatedRows = disclosure.getByText('Wait for approval', { exact: true })
  await expect(repeatedRows).toHaveCount(2)
  await expect(disclosure.locator('[aria-current="step"]')).toHaveAttribute(
    'data-relay-item-id',
    '1:second-wait:current',
  )

  await page.mouse.click(12, 12)
  await expect(disclosure).toBeHidden()
})

test('playground/session-relay-disclosure traps and restores focus in the mobile sheet', async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 768, 'mobile disclosure contract')

  await page.goto('/playground/session-relay-disclosure')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const trigger = page
    .getByTestId('relay-disclosure-host')
    .getByRole('status', { name: /Active relay/ })
  await trigger.click()

  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()
  await expect(sheet.locator('[aria-current="step"]')).toHaveAttribute(
    'data-relay-item-id',
    '7:retry-two:current',
  )
  await expect(sheet).toHaveScreenshot('session-relay-path-mobile.png')

  for (let index = 0; index < 3; index += 1) await page.keyboard.press('Tab')
  expect(await sheet.evaluate(element => element.contains(document.activeElement))).toBe(true)

  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await expect(trigger).toBeFocused()

  await trigger.click()
  await expect(sheet).toBeVisible()
  await page.locator('[data-state="open"].fixed.inset-0').click({ position: { x: 12, y: 12 } })
  await expect(sheet).toBeHidden()
  await expect(trigger).toBeFocused()
})

test('playground/session-relay-disclosure preserves short, terminal, and unknown classified paths', async ({
  page,
}) => {
  await page.goto('/playground/session-relay-disclosure')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const host = page.getByTestId('relay-disclosure-host')
  const trigger = host.getByRole('status', { name: /Active relay/ })
  const openDisclosure = async () => {
    if ((page.viewportSize()?.width ?? 0) < 768) await trigger.click()
    else await trigger.hover()
    return page.getByLabel('Active relay', { exact: true }).filter({ visible: true })
  }

  await page
    .getByRole('button', { name: 'Relay case short' })
    .evaluate((button: HTMLButtonElement) => button.click())
  let disclosure = await openDisclosure()
  await expect(disclosure.locator('[data-relay-item-id]')).toHaveCount(2)
  await expect(disclosure.getByLabel(/Possible relay outcomes: Status reported/)).toBeVisible()
  await expect(disclosure.locator('[aria-current="step"]')).toHaveAttribute(
    'data-relay-item-id',
    '0:check:current',
  )
  await page.keyboard.press('Escape')

  await page
    .getByRole('button', { name: 'Relay case terminal' })
    .evaluate((button: HTMLButtonElement) => button.click())
  disclosure = await openDisclosure()
  await expect(disclosure.locator('[aria-current="step"]')).toHaveAttribute(
    'data-relay-item-id',
    '4:failure:outcome',
  )
  await expect(disclosure.getByText('Complete', { exact: true })).toBeVisible()
  await expect(disclosure.getByText('Failed', { exact: true })).toBeVisible()
  await expect(disclosure.getByText('Canceled', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')

  await page
    .getByRole('button', { name: 'Relay case unknown' })
    .evaluate((button: HTMLButtonElement) => button.click())
  disclosure = await openDisclosure()
  await expect(disclosure.locator('[data-relay-kind="provider-specific"]')).toBeVisible()
  await expect(disclosure.locator('[aria-current="step"]')).toHaveAttribute(
    'data-relay-item-id',
    '0:extension:current',
  )
})

// There used to be two production hosts for this disclosure — a Job row and a
// Session timeline — and the test opened it from both. There is one host now:
// a job *is* a session, so the row and the timeline are the same surface seen
// from two distances. The Job half of this test went with the route.
test('playground/session-relay-disclosure opens from its production Session host', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  const mobile = (page.viewportSize()?.width ?? 0) < 768

  /* The one host a session has: Work's conversation, whose strip owns
     `RelayStatus`. Scoped to `[data-work-session]` rather than to the page,
     because Work keeps other conversations on screen beside this one — the rail
     to its left and, on a delegated job, the panel of siblings. This used to
     scope to the jobs dialog, for the same reason and on the other mode. */
  await page
    .getByRole('button', {
      name: 'Browser route: /w/acme/agents/research/sessions/session_sleep',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  const conversation = page.locator('[data-work-session="session_sleep"]')
  await expect(conversation.getByLabel('Session timeline')).toBeVisible()
  const sessionStatus = conversation.getByRole('status', {
    name: /Active relay: Nightly export relay/,
  })
  if (mobile) await sessionStatus.click()
  else await sessionStatus.hover()
  const disclosure = page.getByLabel('Active relay', { exact: true }).filter({ visible: true })
  await expect(disclosure).toBeVisible()
  await expect(disclosure).toHaveScreenshot(
    `session-relay-path-session-${mobile ? 'mobile' : 'desktop'}.png`,
  )
})

/* The same session, judged as a whole surface rather than through the relay's
   own popover. The host names the conversation in its header — one title, and
   one ⋯ menu beside it — but a relay is live state, not a second title: which
   step a session is parked on is the reason a reader opens a sleeping one at
   all, so the strip stays and the heading is not repeated under it. */
test('playground/spa-shell keeps the relay reachable on a session opened in Work', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Browser route: /w/acme/agents/research/sessions/session_sleep',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())

  const conversation = page.locator('[data-work-session="session_sleep"]')
  await expect(conversation.getByLabel('Session timeline')).toBeVisible()
  await expect(
    conversation.getByRole('status', { name: /Active relay: Nightly export relay/ }),
  ).toBeVisible()
  /* One title, and no ⋯ menu — this is a delegated job, and a job's name and
     disposal belong to the run that spawned it rather than to whoever is
     reading it. Work already withheld the audience control from a child for
     that reason; rename, archive and delete arrived on this header under the
     same rule when Build's jobs dialog was deleted. The dialog gave every
     session the same band, which is the difference this pins. */
  await expect(conversation.getByRole('button', { name: 'Session actions' })).toHaveCount(0)
  /* The strip sits between that header and the conversation, and the thing to
     look at is the seam: one header, not two stacked. */
  await expect(conversation).toHaveScreenshot('spa-shell-work-session-relay.png')
})

/* The delegated-work panel answers to one fact, and every piece of it has to
   answer to the same one. On a delegated job the children query is disabled
   (a job's children are not this panel's subject) and the header carries no
   toggle — so a panel that drew itself anyway was a 19rem column of skeletons
   that could never resolve and had no control to close it. */
test('playground/spa-shell gives a delegated job no jobs panel to be stuck behind', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Browser route: /w/acme/agents/research/sessions/session_sleep',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(
    page.locator('[data-work-session="session_sleep"]').getByLabel('Session timeline'),
  ).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Recent jobs' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Recent jobs' })).toHaveCount(0)
  // The panel's other form, below `lg`, where it is a sheet over the conversation.
  await expect(page.getByRole('dialog', { name: 'Recent jobs' })).toHaveCount(0)
})

/* And a top-level conversation keeps it, open on arrival — the control case,
   because "no panel anywhere" would satisfy the assertion above. */
test('playground/spa-shell opens the jobs panel on a top-level conversation', async ({ page }) => {
  // The column beside the conversation, which is a desktop shape. Below `lg`
  // the same panel is a sheet, and a sheet that opens itself is the bug two
  // tests down.
  test.skip((page.viewportSize()?.width ?? 0) < 1024)
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Browser route: /w/acme/agents/root/sessions/session_live',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  const panel = page.getByRole('complementary', { name: 'Recent jobs' })
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('button', { name: /Wait for the nightly export/ })).toBeVisible()
})

/* Narrowing the window is not a request for the panel. The same flag draws a
   column beside the conversation above `lg` and a modal sheet below it, so a
   default carried across the breakpoint arrives as a focus trap over the
   conversation the reader was reading. The default follows the viewport
   instead; only a reader's own answer outlives it. */
test('playground/spa-shell does not open the jobs sheet when the window narrows', async ({
  page,
}) => {
  // Drives its own two viewports, so it belongs to whichever project starts wide.
  test.skip((page.viewportSize()?.width ?? 0) < 1024)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Browser route: /w/acme/agents/root/sessions/session_live',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByRole('complementary', { name: 'Recent jobs' })).toBeVisible()

  await page.setViewportSize({ width: 900, height: 900 })
  await expect(page.getByRole('dialog', { name: 'Recent jobs' })).toBeHidden()
  // and the conversation is still the thing on screen
  await expect(
    page.locator('[data-work-session="session_live"]').getByLabel('Session timeline'),
  ).toBeVisible()
})

/* A long agent turn pushes the prompt that started it onto the page behind, and
   what lands is one message of the agent's own work. It does not fill the
   viewport, so there is no upward gesture to make and nothing to scroll — the
   reader is looking at an answer with no question, and no way to ask for it.

   The unprompted read used to fire only for a *completely* empty transcript,
   which is the same trap one message short of closing. */
test('playground/spa-shell reaches the prompt behind a long agent turn', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Scenario: sessions-prompt-behind-history',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())

  const conversation = page.locator('[data-work-session]')
  await expect(conversation.getByText('collect_valuation_multiples')).toBeVisible()
  await expect(conversation.getByText('Value the S&P 500 against long-run earnings.')).toBeVisible()
})

test('playground/spa-shell virtualizes every chat and reads one older page on arrival', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Scenario: sessions-long', exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())

  const conversation = page.locator('[data-work-session]')
  const timeline = conversation.locator('[data-virtualized-session-timeline]')
  await expect(conversation.getByText('Launch evidence 14:', { exact: false })).toBeVisible()
  await expect(timeline).toHaveAttribute('data-virtualized-message-count', '30')
  expect(await timeline.locator('[data-virtualized-message]').count()).toBeLessThan(20)
  const sharedSurface = conversation.locator('[data-session-surface="product"]')
  const surfaceFit = await sharedSurface.evaluate(element => {
    const host = element.closest('[data-work-session]')
    if (host === null) return { fits: false }
    const surfaceBounds = element.getBoundingClientRect()
    const hostBounds = host.getBoundingClientRect()
    return {
      fits: surfaceBounds.left >= hostBounds.left && surfaceBounds.right <= hostBounds.right,
      host: { left: hostBounds.left, right: hostBounds.right, width: hostBounds.width },
      surface: {
        left: surfaceBounds.left,
        right: surfaceBounds.right,
        width: surfaceBounds.width,
      },
    }
  })
  expect(
    surfaceFit.fits,
    `the shared chat surface must stay inside the conversation column: ${JSON.stringify(surfaceFit)}`,
  ).toBe(true)

  await expect(conversation.getByText('Earlier launch context', { exact: false })).toHaveCount(0)
  // Reaching the beginning is the whole gesture: no pill, no click, the page
  // is already on its way by the time the reader gets there.
  await timeline.evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }))
  await expect(timeline).toHaveAttribute('data-virtualized-message-count', '31')
  await expect(
    conversation.getByText('Earlier launch context', { exact: false }).first(),
  ).toBeVisible()
  await expect(timeline).toHaveAttribute('data-has-older-messages', 'false')
})

test('playground/spa-shell loads through an event-only latest history page', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Scenario: sessions-event-only-tail',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())

  const conversation = page.locator('[data-work-session]')
  const timeline = conversation.locator('[data-virtualized-session-timeline]')
  // An event-only latest page renders no message, so the reader sits at the
  // beginning with no scroll available to make. The timeline has to reach for
  // its successor unprompted or the chat stays permanently empty.
  await expect(
    conversation.getByText('Visible history survived an event-only latest page.', { exact: true }),
  ).toBeVisible()
  await expect(timeline).toHaveAttribute('data-has-older-messages', 'false')
})

test('playground/spa-shell retains history, spends one request on a failed arrival, and retries', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Scenario: sessions-history-continuation-error',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())

  const conversation = page.locator('[data-work-session]')
  const timelineFrame = conversation.locator('[data-session-timeline-frame]')
  const timeline = conversation.locator('[data-virtualized-session-timeline]')
  const retained = conversation.getByText(
    'Staging is healthy. The remaining decision is who owns the production rollout.',
    { exact: true },
  )
  await expect(retained).toHaveCount(1)
  const retainedCount = await timeline.getAttribute('data-virtualized-message-count')
  if (retainedCount === null)
    throw new Error('the session timeline did not report its message count')

  // Reading back is the whole gesture now, and it must still spend exactly one
  // request however many scroll events the trip produces (asserted below).
  await timeline.evaluate(element =>
    element.scrollTo({ top: Math.max(element.scrollTop - 80, 0), behavior: 'instant' }),
  )
  await expect(conversation.getByRole('alert')).toContainText('Could not load earlier messages')
  await expect(conversation.getByRole('alert')).toBeVisible()
  // The retry band takes height from the viewport, and the timeline re-anchors
  // the message that band would have covered. Geometry read mid-flight belongs
  // to neither layout, so wait for the scroll position to come to rest.
  await expect
    .poll(async () => {
      const first = await timeline.evaluate((element: HTMLElement) => element.scrollTop)
      await page.waitForTimeout(120)
      const second = await timeline.evaluate((element: HTMLElement) => element.scrollTop)
      return first === second
    })
    .toBe(true)
  const [alertBox, frameBox, timelineBox] = await Promise.all([
    conversation.getByRole('alert').boundingBox(),
    timelineFrame.boundingBox(),
    timeline.boundingBox(),
  ])
  expect(alertBox).not.toBeNull()
  expect(frameBox).not.toBeNull()
  expect(timelineBox).not.toBeNull()
  expect(alertBox!.y).toBeGreaterThanOrEqual(frameBox!.y)
  expect(alertBox!.y + alertBox!.height).toBeLessThanOrEqual(timelineBox!.y)
  const visibleMessageBoxes = await timeline.locator('[data-virtualized-message]').evaluateAll(
    (messages, viewport) =>
      messages
        .map(message => message.getBoundingClientRect())
        .filter(box => box.bottom > viewport.top && box.top < viewport.bottom)
        .map(box => ({
          top: Math.max(box.top, viewport.top),
          bottom: Math.min(box.bottom, viewport.bottom),
        })),
    { top: timelineBox!.y, bottom: timelineBox!.y + timelineBox!.height },
  )
  expect(
    visibleMessageBoxes.every(
      messageBox =>
        alertBox!.y + alertBox!.height <= messageBox.top || alertBox!.y >= messageBox.bottom,
    ),
  ).toBe(true)
  // The band must not eat the transcript it sits above. Reading back to the
  // beginning scrolls the agent's latest turn out of view, so the claim is
  // made about whatever row the reader has actually arrived at: the topmost
  // visible message has to start below the band, not under it.
  const topVisibleMessage = [...visibleMessageBoxes].sort((left, right) => left.top - right.top)[0]
  expect(topVisibleMessage).toBeDefined()
  expect(topVisibleMessage!.top).toBeGreaterThanOrEqual(
    Math.max(alertBox!.y + alertBox!.height, timelineBox!.y),
  )
  expect(topVisibleMessage!.bottom).toBeLessThanOrEqual(timelineBox!.y + timelineBox!.height)
  await expect(retained).toHaveCount(1)
  await expect(timeline).toHaveAttribute('data-virtualized-message-count', retainedCount)
  await expect(page.getByTestId('history-continuation-requests')).toHaveText('1')
  await expect(timeline).toHaveAttribute('data-has-older-messages', 'true')
  await expect(timelineFrame).toHaveScreenshot('spa-shell-history-continuation-error.png')

  await conversation.getByRole('button', { name: 'Try again' }).click()
  await expect(
    conversation.getByText('Earlier retry context recovered.', { exact: true }),
  ).toBeVisible()
  await expect(page.getByTestId('history-continuation-requests')).toHaveText('2')
  await expect(conversation.getByRole('alert')).toHaveCount(0)
  await expect(timeline).toHaveAttribute('data-has-older-messages', 'false')
})

test('playground/spa-shell keeps cached browser collections visible when refresh or continuation fails', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  const scenario = scenarioSwitch(page)

  await scenario('marketplace-refetch-error')
  await expect(page.getByRole('heading', { name: 'Research', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  const marketplaceAlert = page.getByRole('alert').filter({ hasText: 'saved results' })
  await expect(marketplaceAlert).toBeVisible()
  await expect(page.locator('main')).toHaveScreenshot('marketplace-refetch-error.png')

  await scenario('integrations-refetch-error')
  await expect(page.getByText('Connected apps', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'saved results' })).toBeVisible()
  await expect(page).toHaveScreenshot('integrations-refetch-error.png', { fullPage: true })

  await scenario('settings-members-refetch-error')
  await expect(page.getByText('owner@duet.so', { exact: true })).toBeVisible()
  await page.evaluate(() => {
    window.dispatchEvent(new Event('offline'))
    window.dispatchEvent(new Event('online'))
  })
  const memberAlert = page.getByRole('alert').filter({ hasText: 'saved members' })
  await expect(memberAlert).toBeVisible()
  await expect(page).toHaveScreenshot('settings-members-refetch-error.png', { fullPage: true })

  await scenario('agent-sessions-pagination-error')
  const sessionsCard = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Sessions', exact: true }),
  })
  await sessionsCard.getByRole('button', { name: 'Show all' }).click()
  await expect(sessionsCard.getByRole('button', { name: 'Try again' })).toBeVisible()
  await expect(sessionsCard).toHaveScreenshot('agent-sessions-continuation-error.png')

  await scenario('train-uploads-error')
  const sourceCard = page.getByTestId('train-source-card')
  await expect(sourceCard.getByText('Staged sources could not be loaded.')).toBeVisible()
  await expect(sourceCard.getByLabel('Website URL')).toBeDisabled()
  await expect(sourceCard).toHaveScreenshot('train-uploads-error.png')
})

test('playground/session-chat exercises the shared job and default chat primitive', async ({
  page,
}) => {
  await page.goto('/playground/session-chat')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const preview = page.getByRole('region', { name: 'Default AI chat preview' })
  const timeline = preview.locator('[data-virtualized-session-timeline]')
  await expect(preview.locator('[data-loaded-message-count]')).toHaveText('32 loaded')
  await expect
    .poll(() =>
      timeline.evaluate(element =>
        Math.round(element.scrollHeight - element.scrollTop - element.clientHeight),
      ),
    )
    .toBeLessThan(4)
  await page.waitForTimeout(250)
  await expect(preview.locator('[data-loaded-message-count]')).toHaveText('32 loaded')
  await expect(preview.getByText('Review launch checkpoint 60.', { exact: true })).toBeVisible()
  expect(await timeline.locator('[data-virtualized-message]').count()).toBeLessThan(20)

  const distanceFromDefaultTail = () =>
    timeline.evaluate(element =>
      Math.round(element.scrollHeight - element.scrollTop - element.clientHeight),
    )
  await timeline.evaluate((element, distance) => {
    element.scrollTo({
      top: element.scrollHeight - element.clientHeight - distance,
      behavior: 'instant',
    })
  }, 120)
  await expect.poll(distanceFromDefaultTail).toBeGreaterThan(80)
  await page.waitForTimeout(250)
  const readerAnchorBeforeDetachedAppend = await timeline.evaluate(element => {
    const rootBounds = element.getBoundingClientRect()
    const visibleMessage = Array.from(
      element.querySelectorAll<HTMLElement>('[data-virtualized-message]'),
    ).find(message => {
      const bounds = message.getBoundingClientRect()
      return bounds.top >= rootBounds.top && bounds.bottom <= rootBounds.bottom
    })
    if (visibleMessage === undefined) return null
    return {
      id: visibleMessage.dataset.virtualizedMessage,
      top: Math.round(visibleMessage.getBoundingClientRect().top - rootBounds.top),
    }
  })
  expect(readerAnchorBeforeDetachedAppend).not.toBeNull()
  await page.getByRole('button', { name: 'Append AI turn' }).click()
  await expect(preview.locator('[data-loaded-message-count]')).toHaveText('33 loaded')
  await expect
    .poll(() =>
      timeline.evaluate((element, anchor) => {
        const message = element.querySelector<HTMLElement>(
          `[data-virtualized-message="${anchor?.id}"]`,
        )
        if (message === null || anchor === null) return Number.POSITIVE_INFINITY
        return Math.abs(
          Math.round(message.getBoundingClientRect().top - element.getBoundingClientRect().top) -
            anchor.top,
        )
      }, readerAnchorBeforeDetachedAppend),
    )
    .toBeLessThan(4)
  await expect.poll(distanceFromDefaultTail).toBeGreaterThan(80)

  await page.getByRole('button', { name: 'Reset' }).click()
  await expect(preview.locator('[data-loaded-message-count]')).toHaveText('32 loaded')
  await expect.poll(distanceFromDefaultTail).toBeLessThan(4)
  await timeline.evaluate((element, distance) => {
    element.scrollTo({
      top: element.scrollHeight - element.clientHeight - distance,
      behavior: 'instant',
    })
  }, 40)
  await expect.poll(distanceFromDefaultTail).toBeGreaterThan(0)
  await expect.poll(distanceFromDefaultTail).toBeLessThan(80)
  await page.waitForTimeout(250)
  await page.getByRole('button', { name: 'Append AI turn' }).click()
  await expect(preview.locator('[data-loaded-message-count]')).toHaveText('33 loaded')
  await expect.poll(distanceFromDefaultTail).toBeLessThan(4)

  await page.getByRole('button', { name: 'Job', exact: true }).click()
  const job = page.getByRole('region', { name: 'Job chat preview' })
  const jobTimeline = job.locator('[data-virtualized-session-timeline]')
  await expect(job).toHaveAttribute('data-chat-playground-surface', 'job')

  await expect(job.locator('[data-loaded-message-count]')).toHaveText('33 loaded')
  // A chat never asks to be continued. With 48 messages still unfetched there
  // is no affordance in the timeline offering to fetch them.
  await expect(job.getByRole('button', { name: /earlier|load more/i })).toHaveCount(0)
  // Each arrival at the beginning buys exactly one page, and the restored
  // reading position means the next page costs another trip back.
  await page.getByRole('button', { name: 'Scroll to history' }).click()
  await expect(job.locator('[data-loaded-message-count]')).toHaveText('57 loaded')
  await page.getByRole('button', { name: 'Scroll to history' }).click()
  await expect(job.locator('[data-loaded-message-count]')).toHaveText('81 loaded')

  await job.getByLabel('Continue this job').fill('Add the mobile QA result to the handoff.')
  await job.getByRole('button', { name: 'Send' }).click()
  await expect(
    job.getByText('Add the mobile QA result to the handoff.', { exact: true }),
  ).toBeVisible()
  await expect
    .poll(() =>
      jobTimeline.evaluate(element =>
        Math.round(element.scrollHeight - element.scrollTop - element.clientHeight),
      ),
    )
    .toBeLessThan(4)
})

test('playground/session-chat keeps streamed growth inside the bottom threshold', async ({
  page,
}) => {
  await page.goto('/playground/session-chat')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const preview = page.getByRole('region', { name: 'Default AI chat preview' })
  const timeline = preview.locator('[data-virtualized-session-timeline]')
  const distanceFromTail = () =>
    timeline.evaluate(element =>
      Math.round(element.scrollHeight - element.scrollTop - element.clientHeight),
    )
  await expect.poll(distanceFromTail).toBeLessThan(4)
  await page.waitForTimeout(250)

  const streamChunk = page.getByRole('button', { name: 'Stream AI chunk' })
  await streamChunk.click()
  await expect(preview.locator('[data-loaded-message-count]')).toHaveText('33 loaded')
  const streamingMessage = timeline.locator('[data-virtualized-message^="playground-stream-"]')
  await expect(streamingMessage).toContainText('Streaming chunk 1')
  await expect(streamingMessage.getByRole('status')).toHaveCount(0)
  await expect(streamingMessage.getByText('working', { exact: true })).toHaveCount(0)
  await expect.poll(distanceFromTail).toBeLessThan(4)

  await timeline.evaluate(element => {
    const sampledTimeline = element as HTMLElement & { bottomDistanceSamples?: number[] }
    sampledTimeline.bottomDistanceSamples = []
    element.dataset.sampleBottomDistance = 'true'

    const samplePaintedFrame = () => {
      requestAnimationFrame(() => {
        setTimeout(() => {
          sampledTimeline.bottomDistanceSamples?.push(
            Math.round(element.scrollHeight - element.scrollTop - element.clientHeight),
          )
          if (element.dataset.sampleBottomDistance === 'true') samplePaintedFrame()
        }, 0)
      })
    }
    samplePaintedFrame()
  })

  for (let chunk = 2; chunk <= 8; chunk += 1) {
    await streamChunk.click()
    await page.waitForTimeout(24)
  }
  await expect(preview.locator('[data-loaded-message-count]')).toHaveText('33 loaded')
  await expect(streamingMessage).toContainText('Streaming chunk 8')
  await expect.poll(distanceFromTail).toBeLessThan(80)
  const bottomDistanceSamples = await timeline.evaluate(element => {
    element.dataset.sampleBottomDistance = 'false'
    return (
      (element as HTMLElement & { bottomDistanceSamples?: number[] }).bottomDistanceSamples ?? []
    )
  })
  expect(bottomDistanceSamples.length).toBeGreaterThan(1)
  expect(
    Math.max(...bottomDistanceSamples),
    'a pinned streaming answer must grow upward without exposing a gap at the live tail',
  ).toBeLessThan(4)
})

test('playground/session-chat loads history by scrolling and keeps failure in the viewport', async ({
  page,
}) => {
  await page.goto('/playground/session-chat')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const preview = page.getByRole('region', { name: 'Default AI chat preview' })
  await page.getByRole('button', { name: 'Scroll to history' }).click()
  await expect(preview.locator('[data-loaded-message-count]')).toHaveText('56 loaded')
  await expect(preview.getByText('Review launch checkpoint 45.', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Short history failure' }).click()
  await expect(preview.locator('[data-loaded-message-count]')).toHaveText('2 loaded')
  await expect(preview.getByText('Could not load earlier messages', { exact: true })).toBeVisible()
  await expect(preview.getByRole('button', { name: 'Try again' })).toBeVisible()
  await expect(page).toHaveScreenshot('session-chat-history-failed.png', { fullPage: true })
})

test('playground/session-composer owns exact intent, retry, mode, and pending behavior', async ({
  page,
}) => {
  await page.goto('/playground/session-composer')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const existing = page.getByRole('region', { name: 'Existing session composer' })
  const newSession = page.getByRole('region', { name: 'New session composer' })

  // The follow-up checkbox is hidden for now, so a message always steers.
  await expect(existing.getByRole('checkbox')).toHaveCount(0)
  await existing.getByLabel('Message Duet').fill('Steer the current task now')
  await existing.getByRole('button', { name: 'Send' }).click()
  await expect(existing.getByTestId('submitted-payload')).toHaveText(
    JSON.stringify({
      value: 'Steer the current task now',
      mode: 'message',
      behavior: 'steer',
      surface: 'existing',
    }),
  )
  await expect(existing.getByLabel('Message Duet')).toHaveText('')

  await existing
    .getByRole('button', { name: 'Existing session composer disposition: failed' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await existing.getByLabel('Message Duet').fill('Keep this draft on failure')
  await existing.getByRole('button', { name: 'Send' }).click()
  await expect(existing.getByRole('alert')).toContainText('That action could not be completed.')
  await expect(existing.getByLabel('Message Duet')).toHaveText('Keep this draft on failure')
  await expect(existing).toHaveScreenshot('session-composer-existing-failed-retained.png')

  await existing.getByLabel('Message Duet').press('Shift+Tab')
  await expect(existing.getByLabel('Add a note')).toBeVisible()
  await expect(existing).toHaveScreenshot('session-composer-existing-note.png')
  await existing
    .getByRole('button', { name: 'Existing session composer disposition: accepted' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await existing.getByLabel('Add a note').fill('Context only')
  await existing.getByRole('button', { name: 'Send' }).click()
  await expect(existing.getByTestId('submitted-payload')).toHaveText(
    JSON.stringify({ value: 'Context only', mode: 'note', surface: 'existing' }),
  )
  await existing.getByLabel('Add a note').press('Shift+Tab')
  await expect(existing.getByLabel('Message Duet')).toBeVisible()
  await existing.getByRole('button', { name: 'Answer' }).click()
  await expect(existing).toHaveScreenshot('session-composer-existing-answer.png')
  await existing.getByLabel('Answer Duet').fill('Yes, ship it')
  await existing.getByRole('button', { name: 'Send' }).click()
  await expect(existing.getByTestId('submitted-payload')).toHaveText(
    JSON.stringify({ value: 'Yes, ship it', mode: 'answer', surface: 'existing' }),
  )
  await existing.getByRole('button', { name: 'Message' }).click()

  await newSession.getByLabel('Describe a task for Duet').fill('Start this right away')
  await newSession.getByRole('button', { name: 'Start' }).click()
  await expect(newSession.getByTestId('submitted-payload')).toHaveText(
    JSON.stringify({
      value: 'Start this right away',
      mode: 'message',
      behavior: 'steer',
      surface: 'new',
    }),
  )

  await existing
    .getByRole('button', { name: 'Existing session composer disposition: pending' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await existing.getByLabel('Message Duet').fill('Stay visible while delivery is pending')
  await existing.getByRole('button', { name: 'Send' }).click()
  await expect(existing.getByRole('button', { name: 'Sending…' })).toBeDisabled()
  await expect(existing).toHaveScreenshot('session-composer-existing-pending.png')
  // A send in flight holds Send and nothing else: the next message is written
  // meanwhile, into an editor that never went read-only.
  await existing.getByLabel('Message Duet').fill('The next thought, mid-send')
  await expect(existing.getByLabel('Message Duet')).toHaveText('The next thought, mid-send')
  await expect(existing.getByRole('button', { name: 'Sending…' })).toBeDisabled()

  if ((page.viewportSize()?.width ?? 0) < 768) {
    const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(pageWidth).toBeLessThanOrEqual(390)
  }
})

test('playground/entitlement-polling learns webhook pause and resume while staying on the workspace route', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  const route = page.url()

  await page
    .getByRole('button', { name: 'Simulate entitlement pause webhook', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByRole('dialog', { name: 'Acme Studio is asleep' })).toBeVisible()
  expect(page.url()).toBe(route)
  await expect(page.getByRole('button', { name: 'Wake Acme Studio' })).toBeVisible()

  await page
    .getByRole('button', { name: 'Simulate entitlement resume webhook', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByRole('dialog', { name: 'Acme Studio is asleep' })).toHaveCount(0)
  expect(page.url()).toBe(route)
})

/* The wall makes the shell behind it inert, its own switcher included. Somebody
   whose only live workspace is a different one must be able to reach it from
   the wall, and arriving there must leave the wall behind. */
test('playground/entitlement-wall switches to a workspace that is still awake', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Simulate entitlement pause webhook', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  const wall = page.getByRole('dialog', { name: 'Acme Studio is asleep' })
  await expect(wall).toBeVisible({ timeout: 30_000 })

  await wall.getByRole('button', { name: 'Switch workspace', exact: true }).click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: /Acme Studio.*Asleep/ })).toBeVisible()
  await expect(page).toHaveScreenshot('entitlement-wall-workspace-switcher.png', { fullPage: true })

  await menu.getByRole('menuitem', { name: /Duet Labs/ }).click()
  await expect(page.locator('[data-entitlement-wall]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('Duet Labs')
})

/* A member waiting on another payer's top-up can wait indefinitely behind a gate
   that makes the shell inert. The gate itself has to lead to their other
   workspaces. */
test('playground/low-credit-shell-lifecycle lets a waiting member switch workspaces', async ({
  page,
}) => {
  await page.goto('/playground/low-credit-shell-lifecycle')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Simulate low credit member waiting', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  const gate = page.locator('[data-low-credit-gate="member"]')
  await expect(gate).toBeVisible()

  await gate.getByRole('button', { name: 'Switch workspace', exact: true }).click()
  const menu = page.getByRole('menu')
  await expect(page).toHaveScreenshot('low-credit-shell-member-workspace-switcher.png', {
    fullPage: true,
  })

  await menu.getByRole('menuitem', { name: /Duet Labs/ }).click()
  await expect(page.locator('[data-low-credit-gate]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('Duet Labs')
})

/* The reported bug, end to end: the gate opens checkout in a tab of its own, so
   Stripe's `?billing=success` lands somewhere the gate cannot see, and the payer
   comes back to a workspace still demanding money it already has. Two real tabs
   in one browser — the same relationship production has. */
test('playground/low-credit-shell-lifecycle lets go when checkout returns in another tab', async ({
  page,
  context,
}) => {
  await page.goto('/playground/low-credit-shell-lifecycle')
  await page.waitForSelector('[data-low-credit-gate="topup"]', { timeout: 30_000 })

  const checkout = await context.newPage()
  await checkout.goto('/playground/spa-shell')
  await checkout.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await scenarioSwitch(checkout)('settings-billing-payment-received')
  await expect(checkout.locator('[data-checkout-celebration]')).toBeVisible()

  /* No reload, no refocus: the workspace tab is still in the background where
     the payer left it, and it must already be out of the way when they return. */
  await expect(page.locator('[data-low-credit-gate]')).toHaveCount(0)
  await checkout.close()

  /* The grace is spent once the server confirms the money, so a shortfall that
     comes after it is answered honestly instead of being waved through by a
     payment that has already been credited. */
  await page
    .getByRole('button', { name: 'Simulate low credit recovery complete', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.locator('[data-low-credit-gate]')).toHaveCount(0)
  await page
    .getByRole('button', { name: 'Simulate low credit subscribe', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.locator('[data-low-credit-gate="subscribe"]')).toBeVisible()
})

test('playground/low-credit-shell-lifecycle preserves the mounted task through checkout and fresh recovery', async ({
  page,
}, testInfo) => {
  await page.goto('/playground/low-credit-shell-lifecycle')
  await page.waitForSelector('[data-low-credit-gate="topup"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Simulate low credit recovery complete', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.locator('[data-low-credit-gate]')).toHaveCount(0)
  await page.waitForSelector('[data-compose-bar-editor]', { timeout: 30_000 })
  const route = page.url()
  const editor = page.locator('[data-compose-bar-editor]').first()
  await editor.fill('Keep this launch handoff draft mounted')

  await page
    .getByRole('button', { name: 'Simulate low credit subscribe', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.locator('[data-low-credit-gate="subscribe"]')).toBeVisible()
  await expect(page).toHaveScreenshot('low-credit-shell-subscribe.png', { fullPage: true })

  await page
    .getByRole('button', { name: 'Simulate low credit still pending', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  const gate = page.locator('[data-low-credit-gate="topup"]')
  await expect(gate).toBeVisible()
  await expect(page.getByRole('radio', { name: '$50 Paid reserve', exact: true })).toBeFocused()
  await expect(editor).toContainText('Keep this launch handoff draft mounted')

  await page.evaluate(() => {
    window.open = (() => null) as typeof window.open
  })
  await page.getByRole('button', { name: 'Add credits' }).click()
  await expect(page.locator('[data-low-credit-gate] [role="alert"]')).toHaveText(
    'Your browser blocked the checkout tab. Allow popups and try again.',
  )
  await expect(page.getByTestId('recovery-checkout-payload')).toHaveText('No recovery checkout')
  expect(page.url()).toBe(route)

  await page.evaluate(() => {
    const checkoutTabs: Array<{ url: string; target: string; closed: boolean }> = []
    ;(globalThis as { __checkoutTabs?: typeof checkoutTabs }).__checkoutTabs = checkoutTabs
    window.open = ((url?: string | URL, target?: string) => {
      const state = { url: String(url), target: target ?? '', closed: false }
      checkoutTabs.push(state)
      return {
        opener: window,
        close: () => {
          state.closed = true
        },
        location: {
          replace: (next: string) => {
            state.url = next
          },
        },
      } as unknown as Window
    }) as typeof window.open
  })
  await page.getByRole('button', { name: 'Add credits' }).click()
  await expect(page.getByTestId('recovery-checkout-payload')).toHaveText(
    JSON.stringify({ workspaceSlug: 'acme', amountMicroUsd: 50_000_000 }),
  )
  expect(page.url()).toBe(route)
  expect(
    await page.evaluate(
      () => (globalThis as { __checkoutTabs?: Array<{ url: string }> }).__checkoutTabs,
    ),
  ).toEqual([{ url: 'https://checkout.stripe.test/topup', target: '_blank', closed: false }])

  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(gate).toBeVisible()
  await page
    .getByRole('button', { name: 'Simulate low credit recovery complete', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(gate).toHaveCount(0)
  await expect(editor).toContainText('Keep this launch handoff draft mounted')
  expect(page.url()).toBe(route)

  if (testInfo.project.name === 'mobile') {
    await page.evaluate(() => {
      ;(
        globalThis as { __lowCreditCheckoutMode?: 'ready' | 'pending' | 'error' }
      ).__lowCreditCheckoutMode = 'pending'
    })
    await page
      .getByRole('button', { name: 'Simulate low credit subscribe', includeHidden: true })
      .evaluate((button: HTMLButtonElement) => button.click())
    await page.getByRole('button', { name: 'Subscribe and continue' }).click()
    await expect(page.getByRole('button', { name: 'Opening secure checkout…' })).toBeDisabled()
    await expect(page).toHaveScreenshot('low-credit-shell-subscribe-pending.png', {
      fullPage: true,
    })
    await page
      .getByRole('button', { name: 'Simulate low credit recovery complete', includeHidden: true })
      .evaluate((button: HTMLButtonElement) => button.click())
    await expect(page.locator('[data-low-credit-gate]')).toHaveCount(0)

    await page.evaluate(() => {
      ;(
        globalThis as { __lowCreditCheckoutMode?: 'ready' | 'pending' | 'error' }
      ).__lowCreditCheckoutMode = 'error'
    })
    await page
      .getByRole('button', { name: 'Simulate low credit subscribe', includeHidden: true })
      .evaluate((button: HTMLButtonElement) => button.click())
    await page.getByRole('button', { name: 'Subscribe and continue' }).click()
    await expect(page.locator('[data-low-credit-gate] [role="alert"]')).toHaveText(
      'Checkout could not open. Try again.',
    )
    await expect(page).toHaveScreenshot('low-credit-shell-checkout-error.png', { fullPage: true })
    await page.evaluate(() => {
      ;(
        globalThis as { __lowCreditCheckoutMode?: 'ready' | 'pending' | 'error' }
      ).__lowCreditCheckoutMode = 'ready'
    })
    await page
      .getByRole('button', { name: 'Simulate low credit recovery complete', includeHidden: true })
      .evaluate((button: HTMLButtonElement) => button.click())
    await expect(page.locator('[data-low-credit-gate]')).toHaveCount(0)

    await page
      .getByRole('button', { name: 'Simulate low credit member waiting', includeHidden: true })
      .evaluate((button: HTMLButtonElement) => button.click())
    await expect(page.locator('[data-low-credit-gate="member"]')).toBeVisible()
    await expect(page.getByText('Waiting for the workspace owner')).toBeFocused()
    await expect(page).toHaveScreenshot('low-credit-shell-member-waiting.png', { fullPage: true })
    await page
      .getByRole('button', { name: 'Simulate low credit recovery complete', includeHidden: true })
      .evaluate((button: HTMLButtonElement) => button.click())
    await expect(page.locator('[data-low-credit-gate]')).toHaveCount(0)
  }

  await page
    .getByRole('button', {
      name: 'Simulate entitlement precedence over low credit',
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.locator('[data-entitlement-wall]')).toBeVisible()
  await expect(page.locator('[data-low-credit-gate]')).toHaveCount(0)
  if (testInfo.project.name === 'mobile') {
    await expect(page).toHaveScreenshot('low-credit-shell-entitlement-precedence.png', {
      fullPage: true,
    })
  }
})

test('playground/entitlement-wall opens the payer billing portal while paused and retries failures', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]')
  await page
    .getByRole('button', { name: 'Simulate entitlement pause webhook', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  const wall = page.locator('[data-entitlement-wall]')
  await expect(wall).toBeVisible({ timeout: 30_000 })
  const portal = wall.getByRole('button', { name: 'Manage billing', exact: true })
  await page.evaluate(() => {
    ;(globalThis as { __billingPortalMode?: string }).__billingPortalMode = 'pending'
  })
  await portal.click()
  await expect(wall.getByRole('button', { name: 'Opening billing…' })).toBeDisabled()
  await expect(wall.getByRole('button', { name: 'Log out', exact: true })).toBeEnabled()
  await expect(wall).toHaveScreenshot('entitlement-wall-portal-pending.png')

  await page.reload()
  await page
    .getByRole('button', { name: 'Simulate entitlement pause webhook', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(wall).toBeVisible({ timeout: 30_000 })
  await page.evaluate(() => {
    ;(globalThis as { __billingPortalMode?: string }).__billingPortalMode = 'error'
  })
  await portal.click()
  await expect(wall.getByRole('alert')).toHaveText('Billing portal could not open. Try again.')
  await expect(portal).toBeEnabled()
  await expect(wall).toHaveScreenshot('entitlement-wall-portal-error.png')
  await page.evaluate(() => {
    delete (globalThis as { __billingPortalMode?: string }).__billingPortalMode
  })
  await page.route('https://billing.stripe.com/**', route =>
    route.fulfill({
      contentType: 'text/html',
      body: '<h1>Billing portal</h1>',
    }),
  )
  await portal.click()
  await expect(page).toHaveURL('https://billing.stripe.com/fixture?workspace=acme')
  await expect(page.getByRole('heading', { name: 'Billing portal' })).toBeVisible()
})

test('playground/entitlement-wall primary recovery opens Stripe directly', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await scenarioSwitch(page)('settings-billing-active-starter')
  await page
    .getByRole('button', { name: 'Browser route: /w/acme/files', exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await page
    .getByRole('button', { name: 'Simulate entitlement pause webhook', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  const wall = page.locator('[data-entitlement-wall="billing-issue"]')
  await expect(wall).toBeVisible({ timeout: 30_000 })
  const primary = wall.getByRole('button', {
    name: 'Review billing and payment methods',
    exact: true,
  })
  await page.evaluate(() => {
    ;(globalThis as { __billingPortalMode?: string }).__billingPortalMode = 'error'
  })
  await primary.click()
  await expect(wall.getByRole('alert')).toHaveText('Billing portal could not open. Try again.')
  await expect(primary).toBeEnabled()
  await page.evaluate(() => {
    delete (globalThis as { __billingPortalMode?: string }).__billingPortalMode
  })
  await page.route('https://billing.stripe.com/**', route =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Billing portal</h1>' }),
  )
  await primary.click()
  await expect(page).toHaveURL('https://billing.stripe.com/fixture?workspace=acme')
})

test('playground/entitlement-wall keeps the footer reachable in tall walls', async ({ page }) => {
  for (const id of [
    'entitlement-wall-lapsed',
    'entitlement-wall-day-14',
    'storage-seven-day-wall-es',
  ]) {
    await page.goto(`/playground/${id}`)
    const portal = page.getByRole('button', {
      name: id.endsWith('-es') ? 'Administrar facturación' : 'Manage billing',
      exact: true,
    })
    await portal.scrollIntoViewIfNeeded()
    await expect(portal).toBeInViewport({ ratio: 1 })
    await expect(
      page.getByRole('button', {
        name: id.endsWith('-es') ? 'Cerrar sesión' : 'Log out',
        exact: true,
      }),
    ).toBeInViewport({ ratio: 1 })
  }
})

test('playground/low-credit-shell-lifecycle also covers selected global settings and admin shells', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  for (const path of ['/settings/profile', '/internal-admin']) {
    await page
      .getByRole('button', { name: `Browser route: ${path}`, includeHidden: true })
      .evaluate((button: HTMLButtonElement) => button.click())
    await page
      .getByRole('button', { name: 'Simulate low credit subscribe', includeHidden: true })
      .evaluate((button: HTMLButtonElement) => button.click())
    await expect(page.locator('[data-low-credit-gate="subscribe"]')).toBeVisible()
    await expect(page.locator('[data-destination-content]')).toBeAttached()
    await page
      .getByRole('button', { name: 'Simulate low credit recovery complete', includeHidden: true })
      .evaluate((button: HTMLButtonElement) => button.click())
    await expect(page.locator('[data-low-credit-gate]')).toHaveCount(0)
  }

  await page
    .getByRole('button', { name: 'Simulate low credit subscribe', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.locator('[data-low-credit-gate="subscribe"]')).toBeVisible()
  await page
    .getByRole('button', {
      name: 'Browser route: /w/labs/files',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.locator('[data-low-credit-gate]')).toHaveCount(0)
  await page
    .getByRole('button', {
      name: 'Browser route: /w/acme/files',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.locator('[data-low-credit-gate="subscribe"]')).toBeVisible()
})

test('playground/compose-bar exposes controlled quality, attachments, and submit events', async ({
  page,
}) => {
  await page.goto('/playground/compose-bar')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  // A draft loaded from Markdown containing `<Skill …/>` must come back as the
  // chip it was composed from, not as the tag's source text.
  await page
    .getByRole('button', { name: 'Load skill draft' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByLabel('Message Duet').locator('[data-compose-bar-mention]')).toHaveText(
    '/review',
  )
  await page
    .getByRole('button', { name: 'Show skill picker' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByRole('list', { name: 'Skills' }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Load more', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Loading more…', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('compose-bar-skills.png', { fullPage: true })
  await page
    .getByRole('button', { name: 'Hide skill picker' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByTestId('compose-bar-skills-preview')).toHaveCount(0)

  // The `@` roster: parent badge, two colleagues separated only by their slugs,
  // a locked child, an all-locked list, and the empty state that a workspace
  // with no agents registered yet actually gets.
  await page
    .getByRole('button', { name: 'Load agent draft' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByLabel('Message Duet').locator('[data-compose-bar-mention]')).toHaveText(
    '@Scout',
  )
  await page
    .getByRole('button', { name: 'Show agent picker' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByRole('list', { name: 'Agents' }).first()).toBeVisible()
  await expect(page).toHaveScreenshot('compose-bar-agents.png', { fullPage: true })
  await page
    .getByRole('button', { name: 'Hide agent picker' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByTestId('compose-bar-agents-preview')).toHaveCount(0)

  await page.getByLabel('Message Duet').fill('Prepare the launch handoff')
  await page.getByRole('button', { name: 'Quality: Standard' }).click()
  await expect(qualityMenuOption(page, 'Max')).toContainText(/Automatically routes each task/)
  await expect(qualityMenuOption(page, 'Standard')).toContainText(/Automatically routes each task/)
  await expect(
    qualityMenuOption(page, 'Standard').locator('[aria-label="Performance: 4/5"]'),
  ).toBeVisible()
  await expect(
    qualityMenuOption(page, 'Standard').locator('[aria-label="Intelligence: 4/5"]'),
  ).toBeVisible()
  await expect(qualityMenuOption(page, 'Max').locator('[aria-label="Cost: 5/5"]')).toBeVisible()
  await expect(page).toHaveScreenshot('compose-bar-quality-menu.png', { fullPage: true })
  await qualityMenuOption(page, 'Max').click()
  await page.getByRole('button', { name: 'Reasoning: Thoughtful' }).click()
  await page.getByRole('menuitemradio', { name: 'Extended' }).click()
  // The session pill's identity comes from the host's session config — the
  // bar itself has no agent picker.
  const workingPanel = page.locator('[data-compose-bar-session="working"]')
  await expect(workingPanel.getByText('Duet is working')).toBeVisible()
  await expect(workingPanel.locator('[data-agent-avatar="duet"]')).toBeVisible()
  await page.locator('input[type="file"]').setInputFiles({
    name: 'launch-notes.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Launch notes'),
  })
  await expect(page.getByText('launch-notes.md')).toBeVisible()
  await page.getByRole('button', { name: 'Enable web search' }).click()
  await expect(page).toHaveScreenshot('compose-bar-ready.png', { fullPage: true })

  await page.getByLabel('Message Duet').press('Enter')

  await expectEditableText(page.getByLabel('Message Duet'), '')
  await expect(page.getByTestId('compose-bar-last-submit')).toHaveText(
    JSON.stringify({
      value: 'Prepare the launch handoff',
      qualityId: 'frontier',
      reasoningId: 'extended',
      attachmentNames: ['launch-notes.md'],
    }),
  )
})

test('playground/compose-bar explains the submit state after a deliberate hover', async ({
  page,
}) => {
  await page.goto('/playground/compose-bar')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const submitCluster = page.locator('[data-compose-submit-cluster]')
  await submitCluster.hover()
  await page.waitForTimeout(250)
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await expect(
    page.getByRole('tooltip', { name: 'Write a message or attach a file first.' }),
  ).toBeVisible()

  /* This suite disables CSS animations, so Radix cannot observe the close
     animation ending and unmount the first tooltip reliably. A fresh render
     keeps the two timing assertions independent. */
  await page.reload()
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page.getByLabel('Message Duet').fill('Prepare the handoff')
  const readySend = page.getByRole('button', { name: 'Send message' })
  await readySend.hover()
  await page.waitForTimeout(250)
  await expect(page.getByRole('tooltip', { name: 'Send message' })).toBeHidden()
  await expect(page.getByRole('tooltip', { name: 'Send message' })).toBeVisible()
})

test('playground/compose-bar quality options own one centered selection marker', async ({
  page,
}, testInfo) => {
  await page.goto('/playground/compose-bar')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page.getByRole('button', { name: 'Quality: Standard' }).click()
  const optionRole = testInfo.project.name === 'mobile' ? 'radio' : 'menuitemradio'
  const options = page.getByRole(optionRole)
  await expect(options).toHaveText([/Max/, /Standard/, /Economy/])
  await expect(options.locator('[data-quality-option-marker]')).toHaveCount(3)
  await expect(
    page.getByRole(optionRole, { name: /Standard/ }).locator('[data-quality-option-selected]'),
  ).toHaveCount(1)
  await page.getByRole(optionRole, { name: /Economy/ }).click()
  await expect(page.getByRole('button', { name: 'Quality: Economy' })).toBeVisible()
})

test('playground/compose-bar presents the complete attachment upload lifecycle', async ({
  page,
}) => {
  await page.goto('/playground/compose-bar')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  for (const state of ['uploading', 'failed', 'ready', 'mixed', 'ten'] as const) {
    await page
      .getByRole('button', { name: `Show ${state} attachments`, includeHidden: true })
      .evaluate((button: HTMLButtonElement) => button.click())
    const cards = page.locator('[data-attachment-card]')
    await expect(cards).toHaveCount(state === 'mixed' ? 3 : state === 'ten' ? 10 : 1)
    await page
      .locator('[data-compose-attachments]')
      .evaluate((row: HTMLElement) => row.scrollTo({ left: 0 }))
    if (state === 'failed') await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
    await expect(page).toHaveScreenshot(`compose-bar-attachments-${state}.png`, { fullPage: true })
  }
})

test('playground/spa-shell presents paid and snapshot quality states', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page
    .getByRole('button', {
      name: 'Scenario: sessions-quality-paid',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  const paidQuality = page.getByRole('button', { name: 'Quality: Standard' })
  await paidQuality.click()
  await expect(qualityMenuOption(page, 'Standard')).toBeVisible()
  await expect(qualityMenuOption(page, 'Standard')).toBeChecked()
  await expect(qualityMenuOption(page, 'Max')).toBeVisible()
  await expect(
    qualityMenuOption(page, 'Standard').locator('[aria-label="Performance: 4/5"]'),
  ).toBeVisible()
  await expect(
    qualityMenuOption(page, 'Standard').locator('[aria-label="Intelligence: 4/5"]'),
  ).toBeVisible()
  await expect(qualityMenuOption(page, 'Max').locator('[aria-label="Cost: 5/5"]')).toBeVisible()
  await expect(page).toHaveScreenshot('sessions-quality-paid.png', { fullPage: true })
  await page.keyboard.press('Escape')

  await page
    .getByRole('button', {
      name: 'Scenario: sessions-quality-snapshot',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByRole('button', { name: 'Quality: Max' })).toBeVisible()
})

test('playground/compose-bar exposes controlled session progress and action intent', async ({
  page,
}) => {
  await page.goto('/playground/compose-bar')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const workingPanel = page.locator('[data-compose-bar-session="working"]')
  await expect(workingPanel.getByText('Duet is working')).toBeVisible()
  await expect(workingPanel.locator('[data-agent-avatar="duet"]')).toBeVisible()
  await expect(workingPanel.locator('img')).toHaveCount(1)
  await expect(page.getByText('Prepare the handoff')).toBeVisible()
  await expect(
    page.getByRole('listitem', { name: /in progress.*prepare the handoff/i }),
  ).toBeVisible()
  await expect(page).toHaveScreenshot('compose-bar-session-working.png', { fullPage: true })
  await page.getByRole('button', { name: 'Collapse session tasks' }).click()
  await expect(page.getByText('Inspect launch notes')).toHaveCount(0)
  await expect(page.getByText('Prepare the handoff')).toBeVisible()
  await page.getByRole('button', { name: 'Interrupt', exact: true }).click()
  await expect(page.getByTestId('compose-bar-session-action')).toHaveText('Interrupt requested')

  await page
    .getByRole('button', { name: 'Show failed session action' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.locator('[data-compose-bar-session="working"]').getByRole('alert')).toHaveText(
    'The session could not be interrupted.',
  )

  await page
    .getByRole('button', { name: 'Disable session action' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByRole('button', { name: 'Interrupt', exact: true })).toBeDisabled()
})

test('playground/compose-bar presents waiting and sleeping session states above the editor', async ({
  page,
}) => {
  await page.goto('/playground/compose-bar')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page
    .getByRole('button', { name: 'Show waiting session' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(
    page.locator('[data-compose-bar-session="waiting"]').getByText('Milo needs your input'),
  ).toBeVisible()
  await expect(page.getByText('Who should own the production rollout?')).toBeVisible()
  await expect(page).toHaveScreenshot('compose-bar-session-waiting.png', { fullPage: true })

  await page
    .getByRole('button', { name: 'Show sleeping session' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(
    page.getByText('Duet has a reminder set for an upcoming scheduled task.'),
  ).toBeVisible()
  await expect(page.getByText('Chat with Duet anytime in the meantime.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop session', exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('compose-bar-session-sleeping.png', { fullPage: true })
})

test('playground/compose-bar makes clipped text-only session detail keyboard-scrollable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 480 })
  await page.goto('/playground/compose-bar')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Show waiting session' })
    .evaluate((button: HTMLButtonElement) => button.click())

  /* A waiting session can carry plain status text without questions or an
     action. Grow that real text-only shape until it clips; ResizeObserver must
     then promote the viewport itself into the keyboard order. */
  await page
    .locator('[data-compose-bar-session="waiting"]')
    .getByText('Who should own the production rollout?')
    .evaluate(element => {
      element.textContent = Array.from(
        { length: 80 },
        (_, index) => `Rollout detail ${index + 1} needs keyboard review.`,
      ).join(' ')
    })
  const sessionViewport = page.locator('[data-compose-session-viewport]')
  await expect.poll(() => sessionViewport.getAttribute('tabindex')).toBe('0')
  await expect(sessionViewport).toHaveAttribute('role', 'region')
  await expect(sessionViewport).toHaveAttribute('aria-label', 'Milo needs your input')
  await expect(page.getByRole('region', { name: 'Milo needs your input' })).toHaveCount(1)
  /* Enter through the real tab order from the fixture's preceding control;
     direct `.focus()` would not prove the overflow owner became tabbable. */
  await page.getByRole('button', { name: 'Show ten attachments', includeHidden: true }).focus()
  await page.keyboard.press('Tab')
  await expect(sessionViewport).toBeFocused()
  await expect(sessionViewport).toHaveCSS('mask-image', 'none')
  const scrollBefore = await sessionViewport.evaluate(viewport => viewport.scrollTop)
  await page.keyboard.press('PageDown')
  await expect
    .poll(() => sessionViewport.evaluate(viewport => viewport.scrollTop))
    .toBeGreaterThan(scrollBefore)
})

test('playground/compose-bar keeps the session panel visible through rapid lifecycle flickers', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/playground/compose-bar')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const panel = page.locator('[data-compose-bar-session="working"]')
  await expect(panel).toBeVisible()

  // A live session flickers running -> complete -> running between turns; the
  // panel must re-enter cleanly even when the exit animation is interrupted.
  await page
    .getByRole('button', { name: 'Replay session handoff' })
    .evaluate((button: HTMLButtonElement) => button.click())
  // Let the replay's 60ms re-show timer fire mid-exit before asserting, so the
  // assertions cover the interrupted-exit -> re-enter path rather than the
  // still-expanded panel.
  await page.waitForTimeout(200)
  await expect(panel).toBeVisible()
  await expect
    .poll(async () => (await panel.boundingBox())?.height ?? 0, { timeout: 5_000 })
    .toBeGreaterThan(24)
  await expect(page.getByText('Duet is working')).toBeVisible()

  // A settled hide must fully remove the panel, and a later show must restore it.
  await page
    .getByRole('button', { name: 'Hide session' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(panel).toBeHidden()
  await page
    .getByRole('button', { name: 'Show working session' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(panel).toBeVisible()
  await expect
    .poll(async () => (await panel.boundingBox())?.height ?? 0, { timeout: 5_000 })
    .toBeGreaterThan(24)
})

test('playground/compose-bar honors reduced motion across progress indicators', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/playground/compose-bar')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const activeProgress = page
    .getByText('Prepare the handoff', { exact: true })
    .locator('xpath=..')
    .locator('svg')
  await expect
    .poll(() => activeProgress.evaluate(icon => getComputedStyle(icon).animationName))
    .toBe('none')

  await page
    .getByRole('button', { name: 'Show pending session action' })
    .evaluate((button: HTMLButtonElement) => button.click())
  const pendingAction = page.getByRole('button', { name: 'Interrupting', exact: true })
  await expect(pendingAction).toBeDisabled()
  await expect
    .poll(() => pendingAction.locator('svg').evaluate(icon => getComputedStyle(icon).animationName))
    .toBe('none')
})

test('playground/compose-bar disables every mutation surface as one unit', async ({ page }) => {
  await page.goto('/playground/compose-bar')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Disable compose bar' })
    .evaluate((button: HTMLButtonElement) => button.click())

  await expect(page.getByLabel('Message Duet')).toHaveAttribute('contenteditable', 'false')
  await expect(page.getByLabel('Message Duet')).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByRole('button', { name: 'Quality: Standard' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Reasoning: Thoughtful' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Attach files' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Enable web search' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Interrupt', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Collapse session tasks' })).toBeDisabled()

  await page.locator('input[type="file"]').setInputFiles({
    name: 'must-not-attach.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Disabled'),
  })
  await expect(page.getByText('must-not-attach.md')).toHaveCount(0)

  const dropPrevented = await page.locator('form').evaluate(form => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(['disabled'], 'disabled-drop.md', { type: 'text/markdown' }))
    const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer })
    form.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(dropPrevented).toBe(true)
})

test('playground/compose-bar takes a dropped batch, not just the first file', async ({ page }) => {
  await page.goto('/playground/compose-bar')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const dropPrevented = await page.locator('form').evaluate(form => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(['first'], 'first.md', { type: 'text/markdown' }))
    dataTransfer.items.add(new File(['second'], 'second.md', { type: 'text/markdown' }))
    const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer })
    form.dispatchEvent(event)
    return event.defaultPrevented
  })

  // The composer takes a batch from the picker and the clipboard; a drop is the
  // third door into the same contract, so every dropped file attaches.
  expect(dropPrevented).toBe(true)
  await expect(page.getByText('first.md')).toBeVisible()
  await expect(page.getByText('second.md')).toBeVisible()
})

test('playground/compose-bar clears its local drop affordance when a drag is canceled', async ({
  page,
}) => {
  await page.goto('/playground/compose-bar')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const editor = page.getByLabel('Message Duet')
  await editor.evaluate(element => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(['draft'], 'draft.md', { type: 'text/markdown' }))
    element.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer }))
  })
  await expect(page.getByText('Drop files to attach')).toBeVisible()

  await editor.evaluate(element => {
    element.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: null }))
  })
  await expect(page.getByText('Drop files to attach')).toHaveCount(0)
})

test('playground/compose-bar claims page drops without a page-wide affordance, yields to Files, and attaches large pastes', async ({
  page,
}) => {
  await page.goto('/playground/compose-bar')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page.locator('main').evaluate(main => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(['page'], 'page-drop.pdf', { type: 'application/pdf' }))
    main.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }))
  })
  await expect(page.getByText('Drop files to attach')).toHaveCount(0)
  await expect(page).toHaveScreenshot('compose-bar-page-drop.png', { fullPage: true })
  await page.locator('main').evaluate(main => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(['page'], 'page-drop.pdf', { type: 'application/pdf' }))
    main.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
  })
  await expect(page.getByText('page-drop.pdf')).toBeVisible()
  await expect(page.getByLabel('Message Duet')).toBeFocused()

  await page.locator('main').evaluate(main => {
    const dropzone = document.createElement('div')
    dropzone.dataset.filesDropzone = ''
    main.append(dropzone)
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(['files'], 'files-owned.pdf', { type: 'application/pdf' }))
    dropzone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
    dropzone.remove()
  })
  await expect(page.getByText('files-owned.pdf')).toHaveCount(0)

  await page.getByLabel('Message Duet').evaluate(editor => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', 'x'.repeat(10_001))
    editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData }))
  })
  await expect(page.getByText(/^pasted-text-.*\.txt$/)).toBeVisible()
  await expectEditableText(page.getByLabel('Message Duet'), '')

  await page
    .getByRole('button', { name: 'Show ten attachments', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await page.getByLabel('Message Duet').evaluate(editor => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', 'y'.repeat(10_001))
    editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData }))
  })
  await expectEditableText(page.getByLabel('Message Duet'), 'y'.repeat(10_001))
})

/* The toolbar is gone, but Markdown stays the transport: what a person types
   as markdown has to leave the composer as the markdown string the agent
   parses, not as editor JSON or flattened plain text. */
test('playground/compose-bar submits typed markdown as markdown', async ({ page }) => {
  await page.goto('/playground/compose-bar')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page.getByLabel('Message Duet').click()
  await page.keyboard.type('**Launch** handoff')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()

  await expect(page.getByTestId('compose-bar-last-submit')).toHaveText(
    JSON.stringify({
      value: '**Launch** handoff',
      qualityId: 'balanced',
      reasoningId: 'thoughtful',
      attachmentNames: [],
    }),
  )
})

/* The whole point of the picker: what a person types as `/rev` has to leave the
   composer as the tag the agent parses. No screenshot — this is about the
   submitted string, and focusing the editor puts a blinking caret in frame. */
test('playground/compose-bar turns a typed slash command into a skill tag', async ({ page }) => {
  await page.goto('/playground/compose-bar')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page.getByLabel('Message Duet').click()
  await page.keyboard.type('/rev')
  const list = page.getByRole('list', { name: 'Skills' })
  await expect(list).toBeVisible()
  // Exactness ranks: the literal `review` sits above the names containing it.
  await expect(list.getByRole('button').first()).toContainText('/review')

  await page.keyboard.press('Enter')
  await expect(list).toHaveCount(0)
  await expect(page.getByLabel('Message Duet').locator('[data-compose-bar-mention]')).toHaveText(
    '/review',
  )

  // Tab completes too, and a second command in the same message is ordinary.
  // Tab is the reflex a terminal teaches, and a contenteditable would happily
  // move focus out of the editor instead if the picker let the key through.
  await page.keyboard.type('then /write-s')
  await expect(list).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Message Duet')).toBeFocused()
  await expect(page.getByLabel('Message Duet').locator('[data-compose-bar-mention]')).toHaveText([
    '/review',
    '/write-spec',
  ])

  await page.keyboard.type('before the release goes out')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()

  await expect(page.getByTestId('compose-bar-last-submit')).toHaveText(
    JSON.stringify({
      value:
        '<Skill name="review" path="/home/duet/drive/.agents/skills/review" /> then ' +
        '<Skill name="write-spec" path="/home/duet/.duet/skills/write-spec" /> before the release goes out',
      qualityId: 'balanced',
      reasoningId: 'thoughtful',
      attachmentNames: [],
    }),
  )
})

/* The `@` trigger's own version of the above, plus the rule that only exists
   here: a colleague still awaiting onboarding is listed but cannot be picked.
   Enter must stay swallowed while that row is highlighted — the composer's
   Enter-to-send shortcut stands down whenever a picker is open, so a key that
   fell through would send the half-written message instead of doing nothing. */
test('playground/compose-bar turns a typed mention into an agent tag', async ({ page }) => {
  await page.goto('/playground/compose-bar')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page.getByLabel('Message Duet').click()
  await page.keyboard.type('@sco')
  const list = page.getByRole('list', { name: 'Agents' })
  await expect(list).toBeVisible()

  // Both colleagues answer to "Scout"; the slug is what separates them, so it
  // has to be typeable and visible.
  await expect(list.getByRole('button')).toHaveCount(2)
  await page.keyboard.type('ut-web')
  await expect(list.getByRole('button').first()).toContainText('scout-web')

  await page.keyboard.press('Enter')
  await expect(list).toHaveCount(0)
  await expect(page.getByLabel('Message Duet').locator('[data-compose-bar-mention]')).toHaveText(
    '@Scout',
  )

  // A colleague still awaiting onboarding is listed — hiding it would read as
  // "no such colleague" — but the highlight never lands on it, and neither a
  // click nor Enter can insert it.
  await page.keyboard.type(' and @cart')
  await expect(list).toBeVisible()
  const locked = list.getByRole('button').filter({ hasText: 'Cartographer' })
  await expect(locked).toHaveAttribute('aria-disabled', 'true')
  await expect(locked).toHaveAttribute('aria-current', 'false')

  const chips = page.getByLabel('Message Duet').locator('[data-compose-bar-mention]')
  // Forced, because the row already reports itself unavailable and Playwright
  // will not deliver an ordinary click to it — which is the accessibility half
  // of the rule. Forcing past that proves the other half: even a click that
  // lands inserts nothing, because the engine refuses it rather than the row
  // merely being hard to hit.
  await locked.click({ force: true })
  await expect(chips).toHaveCount(1)
  // Nothing was sent either: the composer's Enter-to-send stands down while a
  // picker is open, and a refused row must not resurrect it.
  await expect(page.getByTestId('compose-bar-last-submit')).toHaveText('No submission')

  await page.keyboard.press('Escape')
  await expect(list).toHaveCount(0)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()

  await expect(page.getByTestId('compose-bar-last-submit')).toHaveText(
    JSON.stringify({
      value: '<Agent name="Scout" slug="scout-web" path="agents/research/scout-web" /> and @cart',
      qualityId: 'balanced',
      reasoningId: 'thoughtful',
      attachmentNames: [],
    }),
  )
})

/* The agent you are talking to is nameable too. It leads the list and is badged
   as you, so it reads as "this one is me" rather than as a colleague to hand
   work to — but it inserts exactly like any other mention. */
test('playground/compose-bar mentions the agent the session belongs to', async ({ page }) => {
  await page.goto('/playground/compose-bar')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page.getByLabel('Message Duet').click()
  await page.keyboard.type('@atl')
  const list = page.getByRole('list', { name: 'Agents' })
  await expect(list).toBeVisible()
  await expect(list.getByRole('button').first()).toContainText('Atlas')

  await page.keyboard.press('Enter')
  await expect(page.getByLabel('Message Duet').locator('[data-compose-bar-mention]')).toHaveText(
    '@Atlas',
  )

  await page.keyboard.type('should own this')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()

  await expect(page.getByTestId('compose-bar-last-submit')).toHaveText(
    JSON.stringify({
      value: '<Agent name="Atlas" slug="atlas" path="agents/research" /> should own this',
      qualityId: 'balanced',
      reasoningId: 'thoughtful',
      attachmentNames: [],
    }),
  )
})

/* `@` is a character people type in ordinary prose, so a word that names no
   agent has to stop being a pick. If the picker stayed open it would hold Enter
   — the composer's send shortcut stands down for any open picker — and the
   message would gain a line break instead of being sent. */
test('playground/compose-bar lets an unmatched mention fall back to prose', async ({ page }) => {
  await page.goto('/playground/compose-bar')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page.getByLabel('Message Duet').click()
  await page.keyboard.type('ask @sarah')
  await expect(page.getByRole('list', { name: 'Agents' })).toHaveCount(0)

  await page.keyboard.press('Enter')

  await expect(page.getByTestId('compose-bar-last-submit')).toHaveText(
    JSON.stringify({
      value: 'ask @sarah',
      qualityId: 'balanced',
      reasoningId: 'thoughtful',
      attachmentNames: [],
    }),
  )
})

/* A workspace that has registered nobody still opens the picker and says so —
   the trigger is never dormant. But a picker with nothing to insert must not
   own Enter: holding it there turns a send into a line break, which is the
   same trap an unmatched mention used to set. */
test('playground/compose-bar still sends when the roster is empty', async ({ page }) => {
  await page.goto('/playground/compose-bar')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page
    .getByRole('button', { name: 'Empty the agent roster' })
    .evaluate((button: HTMLButtonElement) => button.click())

  await page.getByLabel('Message Duet').click()
  await page.keyboard.type('ping @')
  await expect(page.getByText('No agents yet')).toBeVisible()

  await page.keyboard.press('Enter')

  await expect(page.getByTestId('compose-bar-last-submit')).toHaveText(
    JSON.stringify({
      value: 'ping @',
      qualityId: 'balanced',
      reasoningId: 'thoughtful',
      attachmentNames: [],
    }),
  )
})

/* A draft that already contains an agent tag has to come back as the chip it
   was composed from, or reloading a saved message would show raw markup. */
test('playground/compose-bar restores an agent tag from a saved draft', async ({ page }) => {
  await page.goto('/playground/compose-bar')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  // The fixture's toggles are sr-only, so they are driven the way the rest of
  // this spec drives them: Playwright will not click what it cannot see.
  await page
    .getByRole('button', { name: 'Load agent draft' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByLabel('Message Duet').locator('[data-compose-bar-mention]')).toHaveText(
    '@Scout',
  )
})

/* Put the page back at the top — the document *and* every nested scroller.

   The product scrolls inside its own containers, not the document, so
   `window.scrollTo(0, 0)` alone leaves a panel's scroll owner wherever the last
   interaction put it. Playwright scrolls an element into view before it clicks
   it, and that scroll lands on the nearest scrollable ancestor, which outlives
   the scenario switch that replaces the content inside it. The next capture
   then photographs a surface offset by whatever residue the previous scenario
   left, and the residue depends on render timing — nothing on one run, ninety
   pixels on the next. That is the rotating whole-content vertical shift.

   Resetting twice, a frame apart, catches a scroll restored on the frame after
   the switch. */
async function resetScroll(page: import('@playwright/test').Page) {
  await page.evaluate(async () => {
    const toTop = () => {
      window.scrollTo(0, 0)
      for (const element of document.querySelectorAll<HTMLElement>('*')) {
        if (element.scrollTop !== 0) element.scrollTop = 0
        if (element.scrollLeft !== 0) element.scrollLeft = 0
      }
    }
    toTop()
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    toTop()
  })
}

/**
 * Switch the playground to a named scenario, and leave the page where a shot
 * can be taken from it.
 *
 * Thirteen tests wrote this out by hand and four of them drifted: two reset no
 * scroll at all and four used a bare `window.scrollTo`, which is the half-fix
 * `resetScroll` above exists to replace. The one that reset nothing photographed
 * six full pages, and `settings-viewer-members` failed only under a full-suite
 * load — the residue is invisible on an idle machine. A scenario switch and the
 * settling it needs are one act, so they are one function.
 */
function scenarioSwitch(page: import('@playwright/test').Page, prefix = 'Scenario') {
  return async (name: string) => {
    await page
      .getByRole('button', { name: `${prefix}: ${name}`, exact: true })
      .evaluate((button: HTMLButtonElement) => button.click())
    await resetScroll(page)
  }
}

/* The roster's controls live in its head, and the head is unreachable while the
   column is folded — `inert` takes it out of the accessibility tree entirely.
   It can be folded for two different reasons (the window is inside the band, or
   it is an overlay below `sm`), so this asks the control what state it is in
   rather than guessing from a width. */
async function openRosterIfFolded(page: import('@playwright/test').Page) {
  /* At `sm` and above the column is permanent — it rests one face wide and has
     no control that takes it away — so there is nothing to open and the only
     thing to wait for is the column itself. */
  if ((page.viewportSize()?.width ?? 0) >= 640) {
    await expect(page.getByRole('navigation', { name: 'Agents' })).toBeVisible()
    return
  }
  /* Below `sm` it is a drawer over the conversation, which has a control and can
     be shut. Wait for that control to exist before asking which state it is in:
     checking `count()` first and returning on zero looks defensive and is the
     opposite — the roster mounts a beat after the route resolves, so a bare
     count races it and silently decides the column is already out. */
  const control = page.getByRole('button', { name: /^(Show|Hide) agents$/ })
  await expect(control).toBeVisible()
  if ((await control.getAttribute('aria-expanded')) === 'true') return
  await control.click()
  /* Wait for the column itself, not for the click. A shut drawer is `inert`,
     which takes it out of the accessibility tree entirely — so every `getByRole`
     inside it finds nothing until the fold has actually lifted, and a test that
     pressed the control and moved on would look for a control that is still
     hidden. */
  await expect(page.getByRole('navigation', { name: 'Agents' })).toBeVisible()
}

function destinationHeading(page: import('@playwright/test').Page, name: string) {
  return page
    .locator('[data-destination-content]')
    .getByRole('heading', { name, exact: true })
    .last()
}

function sessionSurface(
  page: import('@playwright/test').Page,
  surface: 'product' | 'access-denied',
) {
  return page.locator(`[data-session-surface="${surface}"]`).last()
}

async function sessionInputPayload(page: import('@playwright/test').Page) {
  return await page
    .getByTestId('session-input-payload')
    .evaluate(output => JSON.parse(output.textContent ?? 'null'))
}

test('playground/spa-shell keeps an arriving first drive out of the unavailable state', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page.evaluate(() => {
    const seenHeadings: string[] = []
    const recordHeadings = () => {
      for (const heading of document.querySelectorAll('h1')) {
        const text = heading.textContent?.trim()
        if (text !== undefined && text !== '' && !seenHeadings.includes(text)) {
          seenHeadings.push(text)
        }
      }
    }
    recordHeadings()
    new MutationObserver(recordHeadings).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    Object.assign(window, { __spaShellSeenHeadings: seenHeadings })
  })

  await page
    .getByRole('button', { name: 'Scenario: workspace-arriving', exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(
    page.getByRole('heading', { name: 'Name your assistant', exact: true }),
  ).toBeVisible()

  const seenHeadings = await page.evaluate(
    () => (window as typeof window & { __spaShellSeenHeadings: string[] }).__spaShellSeenHeadings,
  )
  expect(seenHeadings).not.toContain('Workspace unavailable')
})

test('playground/spa-shell-file-pagination loads visible Drive continuations and stops at the terminal page', async ({
  page,
}, testInfo) => {
  await page.goto('/playground/spa-shell-file-pagination')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await expect(destinationHeading(page, 'Drive')).toBeVisible()
  await expect(page).toHaveScreenshot('spa-shell-file-pagination-before.png', { fullPage: true })
  await page.getByRole('button', { name: 'Load more' }).click()
  await expect(page.getByText('Templates', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Load more' })).toBeVisible()
  await page.mouse.move(1_000, 250)
  await expect(page).toHaveScreenshot('spa-shell-file-pagination-after.png', { fullPage: true })
  await page.getByRole('button', { name: 'Load more' }).click()
  await expect(page.getByText('Archive', { exact: true })).toBeVisible()
  await expect(page.getByText('Templates', { exact: true })).toBeVisible()
  const terminalCapture = testInfo.outputPath('drive-terminal-page.png')
  await page.screenshot({ path: terminalCapture, fullPage: true })
  await testInfo.attach('drive-terminal-page', {
    path: terminalCapture,
    contentType: 'image/png',
  })
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0)
  await expect(page.getByText('4 items', { exact: true })).toBeVisible()
})

test('playground/spa-shell wires explicit steer behavior through new and existing Session requests', async ({
  page,
}) => {
  // Behavior is a property of the request, so it is asserted on both requests
  // that can carry one: a message into a session that already exists, and the
  // create that opens a new one. With the follow-up control hidden, every
  // composer submit must still say `steer` explicitly rather than omit the
  // field and lean on a server default.
  await openProductRoute(page, '/w/acme/agents/root')
  await page.getByLabel('Message Milo').fill('Wait for the readiness report')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect
    .poll(() => sessionInputPayload(page))
    .toMatchObject({
      kind: 'message',
      input: {
        prompt: 'Wait for the readiness report',
        behavior: 'steer',
        tier: 'balanced',
        clientRequestId: expect.any(String),
      },
    })

  await openProductRoute(page, '/w/acme/agents/research')
  await page.getByLabel('Describe a task for Research…').fill('Schedule the handoff summary')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect
    .poll(() => sessionInputPayload(page))
    .toMatchObject({
      kind: 'create',
      input: {
        prompt: 'Schedule the handoff summary',
        behavior: 'steer',
        tier: 'balanced',
        clientRequestId: expect.any(String),
      },
    })
})

test('playground/spa-shell drives the sessions product on its detail route', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  // The default scenario boots on an agent, and the agent's chat card *is* the
  // sessions product — there is no Sessions destination wrapper around it any
  // more, so the surface is asserted on its own attribute.
  await expect(page.locator('[data-session-surface="product"]').last()).toBeVisible()

  // One conversation, addressed by its one route — Work's, since Build stopped
  // holding a surface for a session that is not an agent's own chat. The header
  // carries the chrome this test drives (title, actions menu, archive), and
  // Work keeps other conversations on screen beside this one, so every query
  // scopes to the conversation rather than to the page.
  await openProductRoute(page, '/w/acme/agents/root/sessions/session_live')
  const conversation = page.locator('[data-work-session="session_live"]')
  const sessionTimeline = conversation.getByLabel('Session timeline')
  const userMessage = sessionTimeline.getByRole('article', {
    name: 'Message from Ada Lovelace',
  })
  const duetMessage = sessionTimeline
    .getByRole('article', { name: 'Message from Milo' })
    .filter({ hasText: 'Staging is healthy' })
  await sessionTimeline.evaluate((timeline: HTMLElement) => timeline.scrollTo({ top: 0, left: 0 }))
  await expect(sessionTimeline).toHaveAttribute('data-has-older-messages', 'false')
  await expect(userMessage).toContainText(
    'Build a launch readiness report from the staging checks.',
  )
  await expect(duetMessage).toContainText(
    'Staging is healthy. The remaining decision is who owns the production rollout.',
  )
  await expect(duetMessage.locator('img[src*="duet-avatar"]')).toBeVisible()
  await expect(
    conversation
      .getByRole('region', { name: 'Milo needs your input' })
      .locator('[data-compose-bar-session="waiting"]'),
  ).toBeVisible()
  await expect(conversation.getByAltText('Session attachment')).toBeVisible()
  await sessionTimeline.evaluate((timeline: HTMLElement) => timeline.scrollTo({ top: 0, left: 0 }))
  await expect(conversation).toHaveScreenshot('sessions-detail-paged-history.png')
  const requestCard = duetMessage.getByText('Milo needs your input').locator('..')
  await requestCard.scrollIntoViewIfNeeded()
  await expect(page).toHaveScreenshot('sessions-detail-ask.png', { fullPage: true })

  /* The settled turn wears its wall-clock span, and the terminal event's tally
     opens as a readout — a hover card beside a pointer, a bottom sheet under a
     thumb. */
  await expect(duetMessage).toContainText('thought for 30s')
  // A failed tool call settles to a quiet dash, a successful one to a checkbox;
  // neither prints a status word and nothing turns red.
  await expect(
    duetMessage.locator('[data-tool-call-id="tool_probe"] [aria-label="error"]'),
  ).toBeVisible()
  await expect(
    duetMessage.locator('[data-tool-call-id="tool_launch"] [aria-label="complete"]'),
  ).toBeVisible()
  const usageTrigger = duetMessage.getByRole('button', { name: 'View token usage' })
  const mobileUsageSurface = (page.viewportSize()?.width ?? 0) < 768
  if (mobileUsageSurface) await usageTrigger.click()
  else await usageTrigger.hover()
  await expect(page.getByText('Token usage', { exact: true })).toBeVisible()
  // `.first()`: the readout repeats a figure, so exact-text matches are not
  // unique.
  await expect(page.getByText('25.4k', { exact: true }).first()).toBeVisible()
  // Tokens only: dollars never reach the readout.
  await expect(page.getByText('$', { exact: false })).toHaveCount(0)
  await expect(page).toHaveScreenshot('sessions-usage-details.png', { fullPage: true })
  if (mobileUsageSurface) await page.keyboard.press('Escape')
  else await page.mouse.move(0, 0)
  await expect(page.getByText('Token usage', { exact: true })).toHaveCount(0)

  await conversation.getByText('Reasoning', { exact: true }).click()
  await scrollTimelineContentClear(sessionTimeline, requestCard)
  await expect(page).toHaveScreenshot('sessions-reasoning-expanded.png', { fullPage: true })
  await conversation.getByText('read_file', { exact: true }).click()
  await scrollTimelineContentClear(sessionTimeline, requestCard)
  await expect(page).toHaveScreenshot('sessions-tool-expanded.png', { fullPage: true })
  await sessionTimeline.evaluate((timeline: HTMLElement) => {
    timeline.scrollTo({ top: 0 })
    timeline.dispatchEvent(new Event('scroll'))
  })
  await expect(conversation.getByAltText('Session attachment')).toBeVisible()
  await expect(page).toHaveScreenshot('sessions-detail-image.png', { fullPage: true })
  await sessionTimeline.evaluate((timeline: HTMLElement) => {
    timeline.scrollTo({ top: timeline.scrollHeight })
  })

  /* The header names the session, so the header is where it is renamed — the
     control moved there with the rest of a conversation's chrome when Build's
     dialog was deleted. `exact` keeps the rail row (title + timestamp) out of
     the match. */
  await conversation
    .getByRole('button', { name: 'Prepare the launch readiness report', exact: true })
    .click()
  await conversation.getByLabel('Session title').fill('Production launch decision')
  await expect(page).toHaveScreenshot('sessions-title-edit.png', { fullPage: true })
  await conversation.getByLabel('Session title').press('Enter')
  await expect(
    conversation.getByRole('button', { name: 'Production launch decision', exact: true }),
  ).toBeVisible()
  await expect(page).toHaveScreenshot('sessions-renamed.png', { fullPage: true })

  await conversation.getByRole('checkbox', { name: /Ada owns the rollout/ }).click()
  await expect(page).toHaveScreenshot('sessions-answer-options.png', { fullPage: true })
  await conversation.getByRole('button', { name: 'Done — submit answers' }).click()
  await expect(conversation.locator('[data-compose-bar-session-questions="true"]')).toHaveCount(0)
  await expectEditableText(conversation.getByLabel('Message Milo'), '')
  await expect(conversation.getByText('Ada owns the rollout', { exact: true })).toBeVisible()
  await expect(conversation.getByText('Milo is working')).toBeVisible()
  // The open draft counts out loud, pinned by the playground clock so the
  // number photographs the same on every run.
  await expect(conversation.getByText('thinking for 42s', { exact: true })).toBeVisible()
  await expect(conversation.getByText('Confirm rollout owner', { exact: true })).toBeVisible()
  await expect(conversation.getByRole('button', { name: 'Interrupt', exact: true })).toHaveCount(1)
  await expect
    .poll(() =>
      sessionTimeline.evaluate((timeline: HTMLElement) =>
        Math.round(timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight),
      ),
    )
    .toBeLessThan(4)
  await expect(page).toHaveScreenshot('sessions-answer-success.png', { fullPage: true })

  await conversation.getByRole('button', { name: 'Ask Milo', exact: true }).click()
  await conversation.getByLabel('Add a note').fill('Use the signed staging checklist.')
  await conversation.getByRole('button', { name: 'Send' }).click()
  await expect(
    conversation.getByText('Use the signed staging checklist.', { exact: true }),
  ).toBeVisible()
  /* No screenshot for this step: the frame ghosts by a sub-pixel between runs
     (the sheet's device-pixel phase shifts after the answer step), and what
     the step uniquely shows — a note row in a timeline — is already pinned by
     the session-authored-messages fixture. The DOM asserts above carry the
     behavioral claim. */

  await sessionTimeline.evaluate((timeline: HTMLElement) => {
    timeline.scrollTo({ top: 0 })
    timeline.dispatchEvent(new Event('scroll'))
  })
  await conversation.getByRole('button', { name: 'Ask Milo', exact: true }).click()
  await conversation.getByLabel('Message Milo').fill('Prepare the production handoff.')
  await conversation.getByRole('button', { name: 'Send' }).click()
  await expect(
    conversation.getByText('Prepare the production handoff.', { exact: true }),
  ).toHaveCount(1)
  /* Sending returns to the live tail even when the reader composed from old
     history; wait for that scroll or the shot captures a mid-scroll frame. */
  await expect
    .poll(() =>
      sessionTimeline.evaluate((timeline: HTMLElement) =>
        Math.round(timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight),
      ),
    )
    .toBeLessThan(4)
  await expect(page).toHaveScreenshot('sessions-message-success.png', { fullPage: true })

  await conversation.getByRole('button', { name: 'Interrupt', exact: true }).click()
  await expect(conversation.getByText('Interrupted', { exact: true }).last()).toBeVisible()
  await expect(page).toHaveScreenshot('sessions-interrupted.png', { fullPage: true })

  await conversation.getByRole('button', { name: 'Session actions' }).click()
  for (const item of await page.getByRole('menuitem').all()) {
    const box = await item.boundingBox()
    expect(box?.height).toBeGreaterThanOrEqual(44)
  }
  await expect(page).toHaveScreenshot('sessions-actions-menu.png', { fullPage: true })
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toBeVisible()
  for (const button of await page.getByRole('alertdialog').getByRole('button').all()) {
    const box = await button.boundingBox()
    expect(box?.height).toBeGreaterThanOrEqual(44)
  }
  await expect(page).toHaveScreenshot('sessions-delete-conversation.png', { fullPage: true })
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(conversation.getByRole('button', { name: 'Session actions' })).toBeFocused()

  /* Archiving puts the row away: Work's rail excludes archived sessions, so the
     surface lands back on the list rather than truthfully reporting "not in
     this list" to the reader who just archived it. */
  await conversation.getByRole('button', { name: 'Session actions' }).click()
  await page.getByRole('menuitem', { name: 'Archive for everyone', exact: true }).click()
  await expect(conversation.getByText('Production launch decision', { exact: true })).toHaveCount(0)
  await expect(page.getByText('That action could not be completed.')).toHaveCount(0)
  await expect(page).toHaveScreenshot('sessions-archived.png', { fullPage: true })

  // A sleeping session is a session: same address shape, different state.
  await openProductRoute(page, '/w/acme/agents/research/sessions/session_sleep')
  const sleeping = page.locator('[data-work-session="session_sleep"]')
  await expect(sleeping.getByLabel('Session timeline')).toBeVisible()
  await expect(
    sleeping.getByRole('status', { name: /Active relay: Nightly export relay/ }),
  ).toBeVisible()
  const sleepingSession = sleeping.locator('[data-compose-bar-session="sleeping"]')
  // Which agent owns the session, and which reminder line its wake time earns,
  // are the fixture's business; that a sleeping session names its reminder and
  // still invites a chat is the claim.
  await expect(sleepingSession.getByText(/has a reminder/)).toBeVisible()
  await expect(sleepingSession.getByText(/anytime in the meantime/)).toBeVisible()
  await expect(sleeping.getByRole('button', { name: 'Stop session', exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('sessions-sleep.png', { fullPage: true })

  /* The workspace-level shape is a redirect, not a surface: an agent that
     emitted `/w/:ws/sessions/:id` from the session API must land the
     reader on the conversation's real address. That address is Work's now — the
     query is the load-bearing half, since Build answers for the same path and
     has no surface behind it. */
  await openProductRoute(page, '/w/acme/sessions/session_live')
  await expect
    .poll(() => page.evaluate(() => `${window.location.pathname}${window.location.search}`))
    .toBe('/w/acme/agents/root/sessions/session_live')
  await expect(
    page.locator('[data-work-session="session_live"]').getByLabel('Session timeline'),
  ).toBeVisible()
})

test('playground/spa-shell opens a direct Work link to a child conversation', async ({
  page,
}, testInfo) => {
  await openProductRoute(page, '/w/acme/agents/research/sessions/session_sleep')
  const conversation = page.locator('[data-work-session="session_sleep"]')
  await expect(conversation.getByLabel('Session timeline')).toBeVisible()
  await expect(
    conversation.getByRole('heading', { name: 'Wait for the nightly export' }),
  ).toBeVisible()
  await expect(
    conversation.getByRole('link', { name: 'started by Prepare the launch readiness report' }),
  ).toBeVisible()
  await expect(conversation).toHaveScreenshot('work-direct-child.png')
  await page.screenshot({
    path: testInfo.outputPath('queryless-child-full.png'),
    fullPage: true,
    scale: 'css',
  })
  await page
    .getByRole('button', {
      name: 'Browser route: /w/acme/agents/research/sessions/session_sleep?workParent=wrong-parent',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(conversation.getByLabel('Session timeline')).toBeVisible()
})

test('playground/spa-shell opens a child of the default chat', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Make child parent the default chat',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await page
    .getByRole('button', {
      name: 'Browser route: /w/acme/agents/research/sessions/session_sleep',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  const conversation = page.locator('[data-work-session="session_sleep"]')
  await expect(conversation.getByLabel('Session timeline')).toBeVisible()
  await conversation.getByRole('button', { name: 'Back to conversation' }).click()
  await expect
    .poll(() => page.evaluate(() => `${window.location.pathname}${window.location.search}`))
    .toBe('/w/acme/home')
})

test('playground/spa-shell resolves the short link of a delegated conversation', async ({
  page,
}) => {
  await openProductRoute(page, '/w/acme/sessions/session_sleep')
  await expect
    .poll(() => page.evaluate(() => `${window.location.pathname}${window.location.search}`))
    .toBe('/w/acme/agents/research/sessions/session_sleep')
  // Landing on the address is half of it; the timeline is the half that says
  // the surface actually mounted rather than refusing the conversation.
  await expect(
    page.locator('[data-work-session="session_sleep"]').getByLabel('Session timeline'),
  ).toBeVisible()
})

test('playground/sessions-desktop-pane opens from the session cwd', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024)
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Scenario: sessions-pane-open', exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())

  await expect(page.getByRole('complementary', { name: 'Launch intelligence app' })).toBeVisible()
  await expect(page.locator('[data-session-lineage="linked"]')).toContainText(
    'started by Summarize customer interviews',
  )
})

test('playground/sessions-desktop-pane keeps one responsive app-pane owner', async ({ page }) => {
  await page.goto('/playground/sessions-desktop-pane')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const mobile = (page.viewportSize()?.width ?? 0) < 1024
  await expect(page.getByRole('button', { name: 'Open Launch intelligence app' })).toHaveCount(
    mobile ? 1 : 0,
  )
  await expect(page.getByRole('complementary', { name: 'Launch intelligence app' })).toHaveCount(
    mobile ? 0 : 1,
  )

  await page
    .getByRole('button', {
      name: 'Move running session outside apps',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByRole('button', { name: 'Open Launch intelligence app' })).toHaveCount(0)
  await expect(page.locator('[data-session-app-pane]')).toHaveCount(0)
})

test('playground/sessions-desktop-pane opens and closes the mobile viewer accessibly', async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 1024)
  await page.goto('/playground/sessions-desktop-pane')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  /* The conversation is the host now — it used to be a modal dialog on Build's
     canvas, which needed its entrance waited out before a click could land. */
  const conversation = page.locator('[data-work-session]')
  await expect(conversation).toBeVisible()
  const chip = conversation.getByRole('button', { name: 'Open Launch intelligence app' })
  await expect(chip).toBeVisible()
  await chip.click()
  const viewer = page.getByRole('dialog', { name: 'Launch intelligence app' })
  await expect(viewer).toBeVisible()
  await expect(viewer.getByTitle('Launch intelligence')).toBeVisible()
  await page.keyboard.press('Tab')
  await expect
    .poll(() => viewer.evaluate(element => element.contains(document.activeElement)))
    .toBe(true)

  await page.getByRole('button', { name: 'Close app' }).click()
  await expect(viewer).toHaveCount(0)
  await expect(chip).toBeFocused()

  await chip.click()
  await expect(viewer).toBeVisible()
  /* The viewer trapping focus is the observable for its dismissal layer being
     wired; an Escape pressed into that mount gap has no layer to land on. A
     reader cannot hit that gap — visible-but-not-yet-interactive lasts one
     effects pass — but a test can. */
  await expect
    .poll(() => viewer.evaluate(element => element.contains(document.activeElement)))
    .toBe(true)
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
  await expect(chip).toBeFocused()

  await chip.click()
  await page.setViewportSize({ width: 1024, height: 900 })
  await expect(viewer).toHaveCount(0)
  await expect(page.getByRole('complementary', { name: 'Launch intelligence app' })).toBeVisible()
})

test('playground/sessions-desktop-pane collapses without persisting it', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024)
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Scenario: sessions-pane-open', exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByRole('complementary', { name: 'Launch intelligence app' })).toBeVisible()

  await page.getByRole('button', { name: 'Collapse app pane' }).click()

  await expect(page.getByRole('complementary', { name: 'Launch intelligence app' })).toHaveCount(0)

  // Collapse is never a one-way door: the chat header keeps a reopen control
  // while an app matches the session cwd.
  await page.getByRole('button', { name: 'Reopen the Launch intelligence app pane' }).click()
  await expect(page.getByRole('complementary', { name: 'Launch intelligence app' })).toBeVisible()
})

test('playground/sessions-desktop-pane resets collapse when the cwd changes', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024)
  let releaseCwdEvent: (() => void) | undefined
  await page.route('**/api/duet/ws/acme/agent/sessions/session_running/events*', async route => {
    await new Promise<void>(resolve => {
      releaseCwdEvent = resolve
    })
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: sseFrame(9, {
        type: 'step',
        step: {
          type: 'tool_call',
          toolName: 'move_session_cwd',
          toolCallId: 'tool-cwd',
          input: {},
          isError: false,
          output: [],
        },
      }),
    })
  })
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Scenario: sessions-pane-open', exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByRole('complementary', { name: 'Launch intelligence app' })).toBeVisible()
  await page.getByRole('button', { name: 'Collapse app pane' }).click()
  await page
    .getByRole('button', {
      name: 'Move running session within reporting app',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect.poll(() => releaseCwdEvent).toBeDefined()
  releaseCwdEvent?.()

  await expect(page.getByRole('complementary', { name: 'Launch intelligence app' })).toBeVisible()
})

test('playground/sessions-desktop-pane swaps when cwd selects another app', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024)
  let releaseSwapEvent: (() => void) | undefined
  await page.route('**/api/duet/ws/acme/agent/sessions/session_running/events*', async route => {
    await new Promise<void>(resolve => {
      releaseSwapEvent = resolve
    })
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: sseFrame(9, {
        type: 'step',
        step: {
          type: 'tool_call',
          toolName: 'move_session_cwd',
          toolCallId: 'tool-app-swap',
          input: {},
          isError: false,
          output: [],
        },
      }),
    })
  })
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Scenario: sessions-pane-open', exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByRole('complementary', { name: 'Launch intelligence app' })).toBeVisible()
  await page
    .getByRole('button', {
      name: 'Move running session to status app',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect.poll(() => releaseSwapEvent).toBeDefined()
  releaseSwapEvent?.()

  await expect(
    page.getByRole('complementary', {
      name: 'Customer readiness, launch analytics, and incident response command center app',
    }),
  ).toBeVisible()
  await expect(
    page.getByText(
      "Duet's computer is starting this app. It will appear here as soon as it is running.",
    ),
  ).toBeVisible()
})

test('playground/sessions-desktop-pane swaps the open mobile viewer with the cwd', async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 1024)
  let releaseSwapEvent: (() => void) | undefined
  await page.route('**/api/duet/ws/acme/agent/sessions/session_running/events*', async route => {
    await new Promise<void>(resolve => {
      releaseSwapEvent = resolve
    })
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: sseFrame(9, {
        type: 'step',
        step: {
          type: 'tool_call',
          toolName: 'move_session_cwd',
          toolCallId: 'tool-mobile-app-swap',
          input: {},
          isError: false,
          output: [],
        },
      }),
    })
  })
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Scenario: sessions-pane-open', exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await page.getByRole('button', { name: 'Open Launch intelligence app' }).click()
  await expect(page.getByRole('dialog', { name: 'Launch intelligence app' })).toBeVisible()
  await page
    .locator('button')
    .filter({ hasText: 'Move running session to status app' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect.poll(() => releaseSwapEvent).toBeDefined()
  releaseSwapEvent?.()

  const swappedViewer = page.getByRole('dialog', {
    name: 'Customer readiness, launch analytics, and incident response command center app',
  })
  await expect(swappedViewer).toBeVisible()
  await expect(
    swappedViewer.getByText(
      "Duet's computer is starting this app. It will appear here as soon as it is running.",
    ),
  ).toBeVisible()
})

test('playground/sessions-desktop-pane closes when cwd leaves every app', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024)
  let releaseCloseEvent: (() => void) | undefined
  await page.route('**/api/duet/ws/acme/agent/sessions/session_running/events*', async route => {
    await new Promise<void>(resolve => {
      releaseCloseEvent = resolve
    })
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: sseFrame(9, {
        type: 'step',
        step: {
          type: 'tool_call',
          toolName: 'move_session_cwd',
          toolCallId: 'tool-app-close',
          input: {},
          isError: false,
          output: [],
        },
      }),
    })
  })
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Scenario: sessions-pane-open', exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByRole('complementary', { name: 'Launch intelligence app' })).toBeVisible()
  await page
    .getByRole('button', {
      name: 'Move running session outside apps',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect.poll(() => releaseCloseEvent).toBeDefined()
  releaseCloseEvent?.()

  await expect(page.locator('[data-session-app-pane]')).toHaveCount(0)
})

test('playground/sessions-desktop-pane closes the mobile viewer when cwd leaves apps', async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 1024)
  let releaseCloseEvent: (() => void) | undefined
  await page.route('**/api/duet/ws/acme/agent/sessions/session_running/events*', async route => {
    await new Promise<void>(resolve => {
      releaseCloseEvent = resolve
    })
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: sseFrame(9, {
        type: 'step',
        step: {
          type: 'tool_call',
          toolName: 'move_session_cwd',
          toolCallId: 'tool-mobile-app-close',
          input: {},
          isError: false,
          output: [],
        },
      }),
    })
  })
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Scenario: sessions-pane-open', exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await page.getByRole('button', { name: 'Open Launch intelligence app' }).click()
  await expect(page.getByRole('dialog', { name: 'Launch intelligence app' })).toBeVisible()
  await page
    .locator('button')
    .filter({ hasText: 'Move running session outside apps' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect.poll(() => releaseCloseEvent).toBeDefined()
  releaseCloseEvent?.()

  /* The app viewer closes with the cwd; the conversation hosting the session
     stays — it is the session's own address, not the app's. */
  await expect(page.getByRole('dialog', { name: 'Launch intelligence app' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open Launch intelligence app' })).toHaveCount(0)
})

test('playground/sessions-desktop-pane derives the open pane again after reload', async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024)
  await page.goto('/playground/sessions-desktop-pane')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await expect(page.getByRole('complementary', { name: 'Launch intelligence app' })).toBeVisible()
  await page.getByRole('button', { name: 'Collapse app pane' }).click()
  await expect(page.locator('[data-session-app-pane]')).toHaveCount(0)

  await page.reload()

  await expect(page.getByRole('complementary', { name: 'Launch intelligence app' })).toBeVisible()
})

test('playground/sessions-desktop-pane captures the desktop split states', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024)
  await page.goto('/playground/sessions-desktop-pane')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await expect(page.getByRole('complementary', { name: 'Launch intelligence app' })).toBeVisible()

  for (const [width, shot] of [
    [1024, 'sessions-desktop-pane-1024.png'],
    [1280, 'sessions-desktop-pane-1280.png'],
    [1680, 'sessions-desktop-pane-wide.png'],
  ] as const) {
    await page.setViewportSize({ width, height: 900 })
    await expect(page).toHaveScreenshot(shot, { fullPage: true })
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  // The same pane over a conversation that is waiting on the reader.
  await page
    .getByRole('button', {
      name: 'Scenario: sessions-pane-waiting',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  /* Scoped to the conversation, because Work keeps other conversations on
     screen beside it and more than one can be waiting. */
  await expect(
    page.locator('[data-work-session] [data-compose-bar-session="waiting"]'),
  ).toBeVisible()
  await expect(page).toHaveScreenshot('sessions-desktop-pane-live.png', { fullPage: true })

  await page
    .getByRole('button', {
      name: 'Scenario: sessions-pane-reconciling',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(
    page.getByRole('complementary', {
      name: 'Customer readiness, launch analytics, and incident response command center app',
    }),
  ).toBeVisible()
  await expect(page).toHaveScreenshot('sessions-desktop-pane-reconciling.png', {
    fullPage: true,
  })

  await page
    .getByRole('button', { name: 'Scenario: sessions-pane-open', exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await page.getByRole('button', { name: 'Collapse app pane' }).click()
  await expect(page).toHaveScreenshot('sessions-desktop-pane-collapsed.png', { fullPage: true })
})

test('playground/sessions-desktop-pane captures the mobile chip and viewer states', async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 1024)
  await page.goto('/playground/sessions-desktop-pane')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Open Launch intelligence app' })).toBeVisible()
  await expect(page).toHaveScreenshot('sessions-mobile-chip-closed.png', { fullPage: true })

  await page.getByRole('button', { name: 'Open Launch intelligence app' }).click()
  await expect(page.getByRole('dialog', { name: 'Launch intelligence app' })).toBeVisible()
  await expect(page).toHaveScreenshot('sessions-mobile-viewer.png', { fullPage: true })

  await page.setViewportSize({ width: 768, height: 900 })
  await expect(page.getByRole('dialog', { name: 'Launch intelligence app' })).toBeVisible()
  await expect(page).toHaveScreenshot('sessions-mobile-viewer-tablet.png', { fullPage: true })
  await page.getByRole('button', { name: 'Close app' }).click()
  await page
    .getByRole('button', {
      name: 'Scenario: sessions-pane-reconciling',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  const statusAppName = 'Customer readiness, launch analytics, and incident response command center'
  await page.getByRole('button', { name: `Open ${statusAppName} app` }).click()
  await expect(page.getByRole('dialog', { name: `${statusAppName} app` })).toBeVisible()
  await expect(page).toHaveScreenshot('sessions-mobile-viewer-reconciling.png', {
    fullPage: true,
  })
})

test('playground/sessions-desktop-pane never flashes while apps are loading', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024)
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page.evaluate(() => {
    let paneSeen = false
    new MutationObserver(() => {
      paneSeen ||= document.querySelector('[data-session-app-pane]') !== null
    }).observe(document.body, { childList: true, subtree: true })
    Object.assign(window, { __sessionPaneSeen: () => paneSeen })
  })
  await page
    .getByRole('button', {
      name: 'Scenario: sessions-pane-apps-loading',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  /* Wait for the conversation itself, because that is what the scenario opens
     and what the pane would flash beside. Two earlier spellings of this wait
     have gone stale as the host moved — first the map's skeleton, then the
     agent card's reading stage — and both failed the same way: the selector
     named a surface this scenario no longer mounts, so the wait timed out
     before the claim below was ever asked. The claim is unchanged: while the
     apps read is in flight there is no pane, and none appears late. */
  await expect(page.locator('[data-work-session="session_running"]')).toBeVisible()
  await page.waitForTimeout(250)

  expect(
    await page.evaluate(() =>
      (
        window as typeof window & {
          __sessionPaneSeen: () => boolean
        }
      ).__sessionPaneSeen(),
    ),
  ).toBe(false)
})

test('playground/spa-shell opens an agent on its empty default chat and starts it with Enter', async ({
  page,
}) => {
  /* An agent panel whose default chat has no session yet is an *empty chat* —
     thread above, composer pinned below — never a centred welcome hero. The
     panel already names the agent, and the composer sits where it will sit for
     the rest of the conversation's life. There is no other way to start a
     conversation: a person talks to an agent, and only agents spawn sessions. */
  await openProductRoute(page, '/w/acme/agents/research')
  const mobile = (page.viewportSize()?.width ?? 0) < 768
  const emptyChat = page.locator('[data-session-empty-chat]')
  await expect(emptyChat).toBeVisible()
  await expect(page.getByRole('heading', { name: 'What should Duet work on?' })).toHaveCount(0)
  /* No way "back to sessions" on any width: leaving the chat is leaving the
     agent, and the surface around this panel owns that door. */
  await expect(page.getByRole('button', { name: 'Back to sessions' })).toHaveCount(0)
  /* And no agent picker: the panel is the agent, so there is nobody to pick. */
  await expect(page.getByRole('button', { name: /^Agent:/ })).toHaveCount(0)
  const prompt = page.getByLabel('Describe a task for Research…')
  await expect(prompt).toBeVisible()
  const quality = page.getByRole('button', { name: 'Quality: Standard' })
  await expect(quality).toBeVisible()
  if (mobile) {
    const modelTarget = await quality.boundingBox()
    expect(modelTarget?.height).toBeLessThanOrEqual(32)
    const submitTarget = await page.getByRole('button', { name: 'Send', exact: true }).boundingBox()
    expect(submitTarget?.height).toBeGreaterThanOrEqual(44)
  }
  await quality.click()
  await expect(qualityMenuOption(page, 'Standard')).toBeChecked()
  await expect(qualityMenuOption(page, 'Standard')).toContainText(/Automatically routes each task/)
  await qualityMenuOption(page, 'Max').click()
  await expect(page.getByRole('button', { name: 'Quality: Max' })).toBeVisible()

  await prompt.fill('Inspect the overnight deployment')
  await prompt.press('Shift+Enter')
  await expect(
    page.getByLabel('Session timeline').getByText('Inspect the overnight deployment'),
  ).toHaveCount(0)
  await prompt.press('Enter')

  /* The panel adopts the minted conversation in place: the first message is a
     timeline row, and the composer under it is the live session's. */
  await expect(
    page
      .getByLabel('Session timeline')
      .getByText('Inspect the overnight deployment', { exact: true }),
  ).toHaveCount(1)
  await expect(page.locator('[data-session-empty-chat]')).toHaveCount(0)
  await expect(page.getByLabel('Message Research')).toBeVisible()
})

test('playground/spa-shell hands off an image-bearing new session to its canonical route', async ({
  page,
}) => {
  await openProductRoute(page, '/w/acme/agents/research')
  // Scoped to the chat: the agent surface's drive card carries its own upload
  // input one column over.
  await page.locator('[data-session-empty-chat] input[type="file"]').setInputFiles({
    name: 'launch-dashboard.png',
    mimeType: 'image/png',
    buffer: Buffer.from('playground-image'),
  })
  await expect(page.getByText('launch-dashboard.png', { exact: true })).toBeVisible()
  await page.getByLabel('Describe a task for Research…').fill('Review this launch dashboard')
  await page.getByLabel('Describe a task for Research…').press('Enter')

  await expect(page.locator('[data-session-empty-chat]')).toHaveCount(0)
  await expect(page.getByLabel('Session timeline')).toBeVisible()
  await expect(
    page.getByLabel('Session timeline').getByText('Review this launch dashboard', { exact: true }),
  ).toHaveCount(1)
  await expect(page.getByRole('img', { name: 'Session attachment' })).toBeVisible()
})

/* A short window must squeeze the *editor*, never push the send row under the
   fold: the composer's chrome (quality strip, action row) keeps its height and
   the draft area gives way, scrolling its own overflow. The viewport here is a
   real laptop window at a modest height — the size the bug was reported at. */
test('playground/spa-shell keeps the composer send row on screen in a short window', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1000, height: 480 })
  /* The root owner already has a waiting default chat with todos and a question.
     That full live-composer state is the intermittent shape an empty chat misses:
     the conversation must absorb its height without letting the controls leave. */
  await openProductRoute(page, '/w/acme/agents/root')
  const prompt = page.getByLabel('Message Milo')
  await expect(prompt).toBeVisible()
  await prompt.fill(Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'))
  const send = page.getByRole('button', { name: 'Send', exact: true })
  await expect(send).toBeVisible()
  const box = await send.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.y + box!.height).toBeLessThanOrEqual(480)
  /* The quality strip is the composer's other permanent edge: both survive. */
  await expect(page.getByRole('button', { name: 'Quality: Standard' })).toBeInViewport()
  await page.getByRole('checkbox', { name: /The launch channel/ }).scrollIntoViewIfNeeded()
  // Playwright inserts the whole document in one transaction, unlike typing;
  // settle the editor's owning scroller at the caret after the question tray
  // has taken its final height.
  const editorScroller = prompt.locator('xpath=ancestor::*[@data-compose-bar-editor-scroll]')
  await editorScroller.evaluate(scroller => {
    scroller.scrollTop = scroller.scrollHeight
  })
  const lastDraftLineBox = await prompt.evaluate(editor => {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let lastText: Text | null = null
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.textContent?.trim()) lastText = node as Text
    }
    if (lastText === null) return null
    const range = document.createRange()
    range.selectNodeContents(lastText)
    const rect = range.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
  const actionRowBox = await send.locator('xpath=ancestor::*[@data-compose-chrome]').boundingBox()
  expect(lastDraftLineBox).not.toBeNull()
  expect(actionRowBox).not.toBeNull()
  expect(lastDraftLineBox!.y + lastDraftLineBox!.height).toBeLessThanOrEqual(actionRowBox!.y)
  await expect(page).toHaveScreenshot('agent-chat-short-window.png', { fullPage: true })

  /* Session detail yields to those controls, but remains a real scroll region:
     a short window must not trade an unreachable question for a visible Send. */
  const waitingPanel = page.locator('[data-compose-bar-session="waiting"]')
  const sessionViewport = page.locator('[data-compose-session-viewport]')
  const scrollRange = await sessionViewport.evaluate(
    viewport => viewport.scrollHeight - viewport.clientHeight,
  )
  expect(scrollRange).toBeGreaterThan(0)
  const answers = waitingPanel.getByRole('checkbox')
  const answerCount = await answers.count()
  expect(answerCount).toBeGreaterThan(1)
  await answers.first().focus()
  const scrollBeforeKeyboard = await sessionViewport.evaluate(viewport => ({
    session: viewport.scrollTop,
    page: window.scrollY,
  }))
  for (let index = 1; index < answerCount; index += 1) await page.keyboard.press('Tab')
  const lastAnswer = page.getByRole('checkbox', { name: /Nobody yet/ })
  await expect(lastAnswer).toBeFocused()
  const scrollAfterKeyboard = await sessionViewport.evaluate(viewport => ({
    session: viewport.scrollTop,
    page: window.scrollY,
  }))
  expect(scrollAfterKeyboard.session).toBeGreaterThan(scrollBeforeKeyboard.session)
  expect(scrollAfterKeyboard.page).toBe(scrollBeforeKeyboard.page)
  await expect(page).toHaveScreenshot('agent-chat-short-window-scrolled.png', { fullPage: true })
  const lastAnswerBox = await lastAnswer.boundingBox()
  const lastAnswerTitleBox = await page.getByText('Nobody yet', { exact: true }).boundingBox()
  const questionHeaderBox = await page.locator('[data-compose-question-header]').boundingBox()
  const composerBox = await send.locator('xpath=ancestor::form').boundingBox()
  expect(lastAnswerBox).not.toBeNull()
  expect(lastAnswerTitleBox).not.toBeNull()
  expect(questionHeaderBox).not.toBeNull()
  expect(composerBox).not.toBeNull()
  expect(lastAnswerTitleBox!.y).toBeGreaterThanOrEqual(
    questionHeaderBox!.y + questionHeaderBox!.height,
  )
  expect(lastAnswerBox!.y + lastAnswerBox!.height).toBeLessThanOrEqual(composerBox!.y)
  await expect(send).toBeInViewport()
})

/* Work's starter draws the audience picker in its `compact` variant, which
   names people through the avatar stack's `title` rather than the row of
   removable chips. `[data-audience-selected]` — the chips — exists only in the
   roomy variant Build's jobs composer used, and nothing mounts that any more, so
   the assertions below ask the control that is actually on screen. */

test('playground/session-audience restores a rejected specific audience draft without navigating', async ({
  page,
}) => {
  await page.goto('/playground/session-audience')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const starter = page.locator('[data-work-session-starter]')
  await starter.getByRole('radio', { name: 'Specific people' }).click()
  await expect(starter.locator('[data-audience-summary] [title="Ada Lovelace"]')).toHaveCount(1)
  await expect(starter.locator('[data-audience-summary] [title="Milo"]')).toHaveCount(0)
  const audienceTrigger = starter.getByRole('button', { name: /Choose people ·/ })
  await audienceTrigger.click()
  const picker = page.locator('[data-session-audience-popover]')
  await picker.getByRole('option', { name: /Grace Hopper/ }).click()
  await picker.getByPlaceholder('Search people').press('Escape')
  await expect(audienceTrigger).toBeFocused()

  const composer = starter.getByLabel('Describe a task for Milo…')
  const sessionCount = await page.getByTestId('session-count').textContent()
  await starter.locator('input[type="file"]').setInputFiles({
    name: 'audience-brief.png',
    mimeType: 'image/png',
    buffer: Buffer.from('keep this attachment'),
  })
  await expect(starter.getByText('audience-brief.png', { exact: true })).toBeVisible()
  await composer.fill('Keep this exact draft after refusal')
  const send = starter.getByRole('button', { name: 'Send', exact: true })
  await expect(send).toBeEnabled()
  await send.click()

  await expect(starter).toBeVisible()
  await expect(composer).toHaveText('Keep this exact draft after refusal')
  await expect(starter.getByRole('radio', { name: 'Specific people' })).toBeChecked()
  await expect(starter.locator('[data-audience-summary] [title="Grace Hopper"]')).toHaveCount(1)
  await expect(starter.getByText('audience-brief.png', { exact: true })).toBeVisible()
  await expect(page.getByTestId('session-count')).toHaveText(sessionCount ?? '')
  await expect(starter.getByRole('alert')).toHaveText(
    'The audience changed. Refresh the people list and try again.',
  )
})

test('playground/session-audience sends exact normalized specific-audience JSON', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Browser route: /w/acme/home?agent=research',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())

  const composer = page.locator('[data-work-session-starter]')
  await composer.getByRole('radio', { name: 'Specific people' }).click()
  await composer.getByRole('button', { name: /Choose people · 1/ }).click()
  const picker = page.locator('[data-session-audience-popover]')
  await picker.getByRole('option', { name: /Grace Hopper/ }).click()
  await picker.getByPlaceholder('Search people').press('Escape')
  await composer.getByLabel('Describe a task for Research…').fill('Send to exactly these people')
  await composer.getByRole('button', { name: 'Send', exact: true }).click()

  /* Only the people chosen besides you: the API inserts the authenticated
     human itself, so the client never sends the creator. */
  expect((await sessionInputPayload(page)).input.audience).toEqual({
    kind: 'specific',
    memberUserIds: ['user_grace'],
  })
})

test('playground/session-audience presents the public contract in Spanish', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Scenario: sessions-audience-invalid-es',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())

  const starter = page.locator('[data-work-session-starter]')
  await starter.getByRole('radio', { name: 'Personas específicas' }).click()
  await expect(starter.getByText('Esta sesión incluye a 1 persona.')).toBeVisible()
  await expect(starter).not.toContainText(/Privad|Bloquead|propietari/i)
  await expect(starter).toHaveScreenshot('sessions-audience-specific-es.png')
})

test('playground/session-audience pages and retains the new-job audience on desktop and mobile', async ({
  page,
}) => {
  await page.goto('/playground/session-audience')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Browser route: /w/acme/home?agent=research',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  const starter = page.locator('[data-work-session-starter]')

  await expect(starter).toHaveScreenshot('sessions-audience-workspace-closed.png')
  await starter.getByRole('radio', { name: 'Specific people' }).click()
  await expect(starter.locator('[data-audience-summary] [title="Ada Lovelace"]')).toHaveCount(1)
  await expect(starter.locator('[data-audience-summary] [title="Research"]')).toHaveCount(0)
  await expect(starter).toHaveScreenshot('sessions-audience-specific-closed.png')

  const trigger = starter.getByRole('button', { name: /Choose people · 1/ })
  const sessionCount = await page.getByTestId('session-count').textContent()
  const composer = starter.getByLabel('Describe a task for Research…')
  await composer.fill('Enter in the picker must not submit')
  await trigger.click()
  const picker = page.locator('[data-session-audience-popover]')
  const search = picker.getByPlaceholder('Search people')
  const results = picker.getByRole('listbox')
  const grace = picker.getByRole('option', { name: /Grace Hopper/ })
  await expect(grace).toBeVisible()
  // The picker opens on the first person you can choose (never yourself), so
  // Space and Enter act on Grace without an arrow key first.
  const graceOptionId = await grace.getAttribute('id')
  expect(graceOptionId).toBeTruthy()
  await expect(search).toHaveAttribute('aria-activedescendant', graceOptionId!)
  await expect(grace).toBeInViewport()
  await search.press('Space')
  await expect(starter.locator('[data-audience-summary] [title="Grace Hopper"]')).toHaveCount(1)
  await search.press('Space')
  await expect(starter.locator('[data-audience-summary] [title="Grace Hopper"]')).toHaveCount(0)
  await search.press('Enter')
  await expect(page.getByTestId('session-count')).toHaveText(sessionCount ?? '')
  await expect(starter).toBeVisible()
  await expect(starter.locator('[data-audience-summary] [title="Grace Hopper"]')).toHaveCount(1)
  await search.press('Enter')
  await expect(starter.locator('[data-audience-summary] [title="Grace Hopper"]')).toHaveCount(0)
  await search.press('Escape')
  await trigger.click()
  await expect(picker.getByRole('option', { name: /Grace Hopper/ })).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(search).toHaveAttribute('aria-activedescendant', graceOptionId!)
  await expect(starter).toHaveScreenshot('sessions-audience-open-populated.png')

  await picker.getByRole('option', { name: /Grace Hopper/ }).click()
  await expect(picker.getByRole('button', { name: 'Load more' })).toHaveCount(0)
  const longMember = picker.getByRole('option', { name: /Alexandra Fernández-Montgomery/ })
  await expect(longMember).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(search).toHaveAttribute('aria-activedescendant', graceOptionId!)
  await search.press('ArrowDown')
  const linus = picker.getByRole('option', { name: /Linus Torvalds/ })
  await expect(search).toHaveAttribute('aria-activedescendant', (await linus.getAttribute('id'))!)
  await expect(linus).toBeInViewport()
  await longMember.click()
  await expect(starter).toHaveScreenshot('sessions-audience-open-long-name.png')

  await search.fill('empty')
  await expect(results.getByText('No matching people')).toBeVisible()
  await expect(starter.locator('[data-audience-summary] [title="Grace Hopper"]')).toHaveCount(1)
  await expect(
    starter.locator('[data-audience-summary] [title^="Alexandra Fernández-Montgomery"]'),
  ).toHaveCount(1)
  await expect(starter).toHaveScreenshot('sessions-audience-zero-retained.png')

  await search.fill('error')
  await expect(results.getByText('People could not be loaded.')).toBeVisible()
  await expect(picker.getByRole('button', { name: 'Retry' })).toBeVisible()
  await expect(starter).toHaveScreenshot('sessions-audience-initial-error.png')

  await search.fill('loading')
  await expect(results.getByText('Loading people…')).toBeVisible()
  await expect(starter).toHaveScreenshot('sessions-audience-initial-loading.png')

  await search.fill('page-error')
  await expect(results.getByText('More people could not be loaded.')).toBeVisible()
  await expect(picker.getByRole('status')).toHaveText('More people could not be loaded.')
  await expect(starter).toHaveScreenshot('sessions-audience-next-page-error.png')

  await search.fill('page-loading')
  await expect(results.getByText('Loading more…')).toBeVisible()
  await expect(picker.getByRole('status')).toHaveText('Loading more…')
  await expect(starter).toHaveScreenshot('sessions-audience-next-page-loading.png')

  /* The compact mode segments (Workspace / Specific / Just me) are a deliberate
     density and sit outside this check; every other control the picker draws
     keeps a finger's 44px. */
  const controlGroups = [
    starter.locator('[data-session-audience-picker] button:not([role="radio"])'),
    picker.locator('button, input'),
  ]
  for (const controls of controlGroups) {
    for (let index = 0; index < (await controls.count()); index += 1) {
      const box = await controls.nth(index).boundingBox()
      if (box !== null) expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44)
    }
  }
  await expect(starter).not.toContainText(/Private|Locked|owner override/i)

  const viewport = page.viewportSize()!
  await page.setViewportSize({ width: viewport.width, height: 420 })
  await expect(search).toBeInViewport()
  // `composer` is the labelled editor; the send control sits beside it in the
  // starter's action row, not inside the editable field.
  const send = starter.getByRole('button', { name: 'Send', exact: true })
  await expect(send).toBeInViewport()
  const retainedDraftLine = composer.locator('p').last()
  const retainedDraftLineBox = await retainedDraftLine.boundingBox()
  const actionRowBox = await send.locator('xpath=ancestor::*[@data-compose-chrome]').boundingBox()
  expect(retainedDraftLineBox).not.toBeNull()
  expect(actionRowBox).not.toBeNull()
  expect(retainedDraftLineBox!.y + retainedDraftLineBox!.height).toBeLessThanOrEqual(
    actionRowBox!.y,
  )
  await expect(starter).toHaveScreenshot('sessions-audience-short-mobile-keyboard-space.png')
})

/* How a reader arrives at one product route from outside the app — a link, a
   bookmark, a redirect. The roster rail that used to carry these destinations
   as in-page links is gone; the map is the way *around* the product now, and a
   named destination is addressed by its own URL. */
async function openProductRoute(page: import('@playwright/test').Page, path: string) {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: `Browser route: ${path}`, exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
}

test('playground/spa-shell opens an agent-scoped composer with visible identity and sends its cwd', async ({
  page,
}) => {
  // The agent's own panel: the empty default chat, scoped to the agent by the
  // URL and by nothing else. Identity is the panel's — its face and name head
  // the column — so the chat carries no picker and no second name.
  await openProductRoute(page, '/w/acme/agents/research')

  await expect(page.locator('[data-session-empty-chat]')).toBeVisible()
  // Research's suggested first message opens the empty chat in the agent's
  // own voice — a message bubble, not the generic day-one intro.
  await expect(page.getByText('What should I dig into first?')).toBeVisible()
  await expect(page.locator('[data-session-surface="product"]').last()).toHaveScreenshot(
    'sessions-agent-preselected.png',
  )

  await page.getByLabel('Describe a task for Research…').fill('Compare the vector database vendors')
  await page.getByRole('button', { name: 'Send', exact: true }).click()

  // The first message goes through the owner's default-chat alias, so the
  // client names the agent in the URL and nowhere else: no agentId and no cwd
  // in the payload — attribution is the server's, from the alias owner.
  await expect
    .poll(() => sessionInputPayload(page))
    .toMatchObject({
      kind: 'create',
      input: { prompt: 'Compare the vector database vendors' },
    })
  // No cwd and no agentId ride along — attribution is the server's, from the
  // alias owner. The one addition is the suggested first message the client
  // just rendered, sent so history records exactly what was on screen.
  expect(Object.keys((await sessionInputPayload(page)).input).sort()).toEqual([
    'agentFirstMessage',
    'behavior',
    'clientRequestId',
    'prompt',
    'tier',
  ])

  // After create the conversation is the agent's: its status row wears the
  // agent's own face, never Duet's. The face carries the claim — at narrow the
  // pill gives its words' room to the interrupt control and the label truncates
  // to nothing, so the text is only asserted where it has width to exist.
  const workingSession = page.locator('[data-compose-bar-session="working"]')
  await expect(workingSession).toBeVisible()
  if ((page.viewportSize()?.width ?? 0) >= 768) {
    await expect(workingSession.getByText('Research is working')).toBeVisible()
  }
  await expect(workingSession.locator('[data-agent-avatar="custom"]')).toBeVisible()
  await expect(workingSession.locator('[data-agent-avatar="duet"]')).toHaveCount(0)
  await expect(workingSession).toHaveScreenshot('sessions-agent-working.png')
  await expect(page.locator('[data-session-surface="product"]').last()).toHaveScreenshot(
    'sessions-agent-attribution.png',
  )
})

test('playground/spa-shell a session stamped before its agent was renamed speaks with the live name', async ({
  page,
}) => {
  // The session row stamped 'research' at creation; the profile has since been
  // named 'Research'. Both the compose bar's status line and the agent's
  // message header answer to the live profile, never the stamp. Case is the
  // only thing separating the two names, so the matchers stay case-sensitive:
  // a regex for the pill (its text trails an animated ellipsis) and an exact
  // match for the header.
  await openProductRoute(page, '/w/acme/agents/research/sessions/session_stale_stamp')
  const workingSession = page.locator('[data-compose-bar-session="working"]')
  await expect(workingSession).toBeVisible()
  if ((page.viewportSize()?.width ?? 0) >= 768) {
    await expect(workingSession.getByText(/Research is working/)).toBeVisible()
  }
  // Scoped to the surface the working pill lives on: the agent's own default
  // chat is mounted behind this dialog and its rows already wear the live
  // name, so an unscoped first-match would pass against the wrong surface.
  const sessionSurface = page
    .locator('[data-session-surface="product"]')
    .filter({ has: workingSession })
  const agentMessage = sessionSurface.locator('[data-message-role="agent"]').first()
  await expect(agentMessage.getByText('Research', { exact: true })).toBeVisible()
})

test('playground/spa-shell refuses an ineligible agent deep link instead of a root fallback', async ({
  page,
}) => {
  // Reviewer is a broken-anchor agent: absent from the picker, so a deep link to
  // it is an explicit unavailable state — never a silent root session.
  await openProductRoute(page, '/w/acme/agents/reviewer')
  await expect(page.getByRole('heading', { name: 'Agent unavailable' })).toBeVisible()
  await expect(page.locator('#welcome-prompt')).toHaveCount(0)
  await expect(page.getByTestId('session-input-payload')).toHaveText('No session input')
  await expect(page.locator('[data-session-surface="product"]').last()).toHaveScreenshot(
    'sessions-agent-unavailable.png',
  )

  // An unknown slug degrades to the plain ring, and it says so: the reader
  // asked to look at somebody absent, and the picture they were already looking
  // at is the honest answer — with a toast naming the slug, never a surface
  // unfolded for an agent that does not exist.
  await openProductRoute(page, '/w/acme/agents/ghost')
  await expect(page.getByText('There is no agent called “ghost” in this workspace.')).toBeVisible()
  await expect(page.locator('.km-sheet')).toHaveCount(0)
  await expect(page.getByTestId('session-input-payload')).toHaveText('No session input')
})

for (const role of ['owner', 'editor', 'viewer'] as const) {
  test(`playground/spa-shell keeps a locked agent on setup for ${role}`, async ({ page }) => {
    await page.goto('/playground/spa-shell')
    await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
    await page
      .getByRole('button', {
        name: `Scenario: locked-agent-session-${role}`,
        exact: true,
        includeHidden: true,
      })
      .evaluate((button: HTMLButtonElement) => button.click())
    // Scenario controls replace the fixture through React state. Wait for the
    // locked-agent fixture to land before a browser-route control remounts the
    // SPA, otherwise the remount can capture the previous scenario's API.
    await expect(page.locator('.km-well')).toContainText('Onboarding')
    /* The control, for the role the claim is actually about: a viewer *can*
       start a conversation — Work's home offers them one — so the refusal below
       is about this agent being locked and not about who is reading. */
    if (role === 'viewer') {
      await page
        .getByRole('button', {
          name: 'Browser route: /w/acme/home',
          exact: true,
          includeHidden: true,
        })
        .evaluate((button: HTMLButtonElement) => button.click())
      await expect(
        page.locator('[data-work-session-starter]').getByLabel('Describe a task for Milo…'),
      ).toBeVisible()
    }
    await page
      .getByRole('button', {
        name: 'Browser route: /w/acme/agents/research',
        exact: true,
        includeHidden: true,
      })
      .evaluate((button: HTMLButtonElement) => button.click())

    await expect(page).toHaveURL(/\/w\/acme\/agents\/research(?:\/files\/agents\/research)?$/)
    await expect(page.locator('.km-well')).toContainText('Onboarding')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    if (role === 'viewer') {
      await expect(page.getByTestId('onboarding-session-requests')).toHaveText('0')
      await expect(page.getByTestId('onboarding-app-lookups')).toHaveText('0')
      await expect(page.locator('.km-setup-chat')).toHaveCount(0)
      await expect(
        page.getByText('An owner or editor needs to finish setup before you can use this agent.'),
      ).toBeVisible()
      await expect(page.getByRole('button', { name: 'Start setup' })).toHaveCount(0)
      await expect(page.getByText('Train', { exact: true })).toHaveCount(0)
      await expect(page.getByText('Settings', { exact: true })).toHaveCount(0)
      await expect(page).toHaveScreenshot('locked-agent-viewer-setup.png', { fullPage: true })
    } else {
      await expect(page.locator('.km-setup-chat')).toBeVisible()
      await expect(page.getByTestId('onboarding-session-requests')).not.toHaveText('0')
    }
    if (role === 'owner') {
      await expect(page).toHaveScreenshot('locked-agent-session-deeplink.png', { fullPage: true })
    }
  })
}

test('playground/spa-shell keeps onboarding apps inert for a locked viewer', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Scenario: locked-agent-app-viewer',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.locator('.km-well')).toContainText('Onboarding')
  await page
    .getByRole('button', {
      name: 'Browser route: /w/acme/agents/research',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())

  await expect(page).toHaveURL(/\/w\/acme\/agents\/research(?:\/files\/agents\/research)?$/)
  await expect(page.getByTestId('onboarding-session-requests')).toHaveText('0')
  await expect(page.getByTestId('onboarding-app-lookups')).toHaveText('0')
  await expect(page.getByRole('progressbar', { name: 'Agent setup progress' })).toHaveCount(0)
  await expect(
    page.getByText('An owner or editor needs to finish setup before you can use this agent.'),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start setup' })).toHaveCount(0)
})

test('playground/spa-shell lets a viewer start a session with an onboarded agent', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Scenario: onboarded-agent-session-viewer',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())

  /* Work's home, where starting a conversation lives. There used to be a second
     test beside this one driving the jobs dialog's own composer at
     `…/sessions/new`; that was the same claim on a door that no longer exists. */
  const starter = page.locator('[data-work-session-starter]')
  await expect(starter).toBeVisible()
  await expect(starter.getByLabel('Describe a task for Research…')).toBeVisible()
})

test('playground/spa-shell opens the marketplace from the map, not a blank composer', async ({
  page,
}) => {
  await openProductRoute(page, '/w/acme/agents')
  await openRosterIfFolded(page)
  await page.getByRole('button', { name: 'Add an agent', exact: true }).click()
  // The control asks which kind before it goes anywhere — hire, or write one. The
  // two squares are the same size because the map has no grounds to pick.
  await expect(page.getByRole('dialog')).toContainText('Two ways to fill the new seat')
  await page.getByRole('button', { name: 'Hire an agent' }).click()

  // Hiring is a shelf, not a blank page: it lands on the marketplace, where the
  // agents that already exist are listed and one click installs one.
  await expect(page.getByRole('heading', { name: 'Agent marketplace', exact: true })).toBeVisible()
  // And specifically not where it used to go. It opened Duet's composer carrying
  // a fixed prompt asking it to author an agent from nothing — the slower answer
  // to "add an agent", and a blank conversation for a reader who wanted to pick
  // something. This half of the assertion is the half that would rot silently.
  await expect(page.locator('#welcome-prompt')).toHaveCount(0)

  // The tag rail is how this page stays readable past a handful of listings.
  // `All` is selected on arrival, so a first visit hides nothing.
  const rail = page.getByTestId('marketplace-tag-rail')
  await expect(rail).toBeVisible()
  await expect(page.getByTestId('marketplace-tag-all')).toHaveAttribute('aria-checked', 'true')
  await expect(page).toHaveScreenshot('spa-shell-marketplace-tag-rail.png', { fullPage: true })

  // Choosing a chip narrows the gallery and moves the selection with it —
  // the assertion that would catch a rail that renders but does not filter.
  //
  // Interaction is desktop-only: the mobile shell clips this surface by
  // design, so the chip is not reachable there and a click would be testing
  // the shell rather than the rail. The DOM assertions above still run on both.
  const viewport = page.viewportSize()
  if (viewport !== null && viewport.width >= 900) {
    const cards = page.locator('article[data-marketplace-state]')
    const total = await cards.count()
    await page.getByTestId('marketplace-tag-sales').click()
    await expect(page.getByTestId('marketplace-tag-sales')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('marketplace-tag-all')).toHaveAttribute('aria-checked', 'false')
    expect(await cards.count()).toBeLessThan(total)
    await expect(page).toHaveScreenshot('spa-shell-marketplace-tag-filtered.png', {
      fullPage: true,
    })
  }

  await page.getByRole('button', { name: 'Back to agents', exact: true }).click()
  /* "Back to agents" lands on the section's front door, which is the root
     agent's conversation — and the entry rewrite immediately replaces the bare
     path with the explicit card that reader's arranged row leads with. So the
     assertion is the section rather than one exact string: pinning the bare
     path would be asserting that the rewrite has not happened yet. */
  await expect(page).toHaveURL(/\/w\/acme\/agents\/root(\/|$)/)
  await openRosterIfFolded(page)
  await expect(page.getByRole('button', { name: 'Add an agent', exact: true })).toBeVisible()
})

/* This used to assert the desktop hover contract: a pointer click on the rail's
   control was deliberately inert, hover owned the column transiently, and
   keyboard activation was the accessible exception. All three are gone with the
   peek — the roster is the agents section's navigator now, out by default, and a
   navigator that appears only while a pointer rests on it is not one.

   What survives is the claim underneath: the control says what it does, it is
   reachable by keyboard, and nothing but a real activation changes it. */
/* The roster has no fold control at `sm` and above any more, so the contract
   that used to live here — one control, shared by pointer and keyboard — has no
   subject on desktop. The column is permanent there: it rests one face wide,
   which is the cheapest thing on screen that still says which agents exist.

   Below `sm` the control survives, because there the column covers the
   conversation and a panel over what you are reading has to be closable. That
   is the drawer's contract, and `out.ts` owns it. */
test('playground/spa-shell drops into the pending conversation while awaiting the session id', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Scenario: sessions-create-awaiting-id',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByLabel('Describe a task for Research…')).toBeVisible()

  await page
    .locator('[data-session-empty-chat] input[type="file"]')
    .setInputFiles('public/icons/duet-avatar-goal-launch-project.png')
  await expect(page.getByText('duet-avatar-goal-launch-project.png', { exact: true })).toBeVisible()
  await page.getByLabel('Describe a task for Research…').fill('Inspect the overnight deployment')
  await page.getByLabel('Describe a task for Research…').press('Enter')

  // Submitting hands off to the conversation immediately (message in 'sending'),
  // rather than leaving the empty chat's composer in a loading state. The same
  // panel then adopts the real session without remounting once the id arrives.
  await expect(page.locator('[data-session-empty-chat]')).toHaveCount(0)
  await expect(
    page
      .getByLabel('Session timeline')
      .getByText('Inspect the overnight deployment', { exact: true }),
  ).toHaveCount(1)
  await expect(
    page.getByLabel('Session timeline').locator('[data-message-inline-image]'),
  ).toHaveCount(1)
  await expect(page.getByText('Sending…', { exact: true })).toBeVisible()
  const pendingTimeline = page.getByLabel('Session timeline')
  await pendingTimeline
    .locator('[data-message-inline-image] img')
    .last()
    .evaluate(async (image: HTMLImageElement) => {
      if (!image.complete) await image.decode().catch(() => undefined)
      await new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
    })
  const pendingRow = pendingTimeline
    .getByText('Inspect the overnight deployment', { exact: true })
    .locator('xpath=ancestor::*[@data-message-role][1]')
  await pendingRow.evaluate(row => {
    const timeline = row.closest<HTMLElement>('[aria-label="Session timeline"]')
    if (timeline === null) throw new Error('Pending message row left its session timeline')
    const viewportTop = timeline.getBoundingClientRect().top
    timeline.scrollTop += row.getBoundingClientRect().top - viewportTop
  })
  await expect(page).toHaveScreenshot('sessions-create-awaiting-id.png', { fullPage: true })
})

test('playground/spa-shell sends a session message with the compose bar', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Scenario: sessions-input-pending',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  // Work keeps other conversations on screen beside this one, so every read
  // scopes to the conversation rather than to the page.
  const conversation = page.locator('[data-work-session]')
  await expect(conversation.getByLabel('Session timeline')).toBeVisible()
  await expect(conversation.getByRole('button', { name: /Quality:/ })).toBeVisible()
  const initialInlineImages = await conversation.locator('[data-message-inline-image]').count()
  await conversation
    .locator('input[type="file"]')
    .setInputFiles('public/icons/duet-avatar-goal-launch-project.png')
  await expect(
    conversation.getByText('duet-avatar-goal-launch-project.png', { exact: true }),
  ).toBeVisible()
  await expect(conversation.getByRole('button', { name: 'Ask Milo', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await conversation.getByRole('button', { name: 'Ask Milo', exact: true }).click()
  await expect(conversation.getByRole('button', { name: /Quality:/ })).toHaveCount(0)
  await expect(conversation.getByRole('button', { name: 'Ask Milo', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await conversation.getByRole('button', { name: 'Ask Milo', exact: true }).click()
  await expect(conversation.getByRole('button', { name: /Quality:/ })).toBeVisible()
  await conversation.getByLabel('Message Milo').fill('Prepare the production handoff.')
  await conversation.getByLabel('Message Milo').press('Shift+Enter')
  await expect(
    conversation
      .getByLabel('Session timeline')
      .getByText('Prepare the production handoff.', { exact: true }),
  ).toHaveCount(0)
  await conversation.getByLabel('Message Milo').press('Enter')

  await expect(
    conversation
      .getByLabel('Session timeline')
      .getByText('Prepare the production handoff.', { exact: true }),
  ).toHaveCount(1, { timeout: 250 })
  await expect(conversation.getByText('Sending…', { exact: true })).toHaveCount(1)
  await expect(conversation.locator('[data-message-inline-image]')).toHaveCount(
    initialInlineImages + 1,
  )
  // The button wears its submitting label while the send is in flight, and is
  // unusable either way: nothing may re-send the message that just left.
  await expect(conversation.getByRole('button', { name: /^Send(ing…)?$/ })).toBeDisabled()
  await expectEditableText(conversation.getByLabel('Message Milo'), '')
  // The attachment this test just sent arrives AFTER the page reported ready,
  // so nothing else waits for it. Its first paint is what an approving run
  // captured while a checking run, which retries until two frames agree, saw
  // the settled one — a baseline that disagreed with every later run.
  await conversation
    .locator('[data-message-inline-image] img')
    .last()
    .evaluate(async (image: HTMLImageElement) => {
      if (!image.complete) await image.decode().catch(() => undefined)
      // The virtualizer learns the image's aspect-correct height through a
      // ResizeObserver. Let that measurement and its following paint settle
      // before aligning the scroll viewport to the resized message row.
      await new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
    })
  // The pending row remains at the bottom, but align the viewport to a whole
  // message above it so the visual contract never blesses a clipped sender.
  await conversation.getByLabel('Session timeline').evaluate(timeline => {
    const viewportTop = timeline.getBoundingClientRect().top
    const clipped = [...timeline.querySelectorAll<HTMLElement>('[data-message-role]')].find(row => {
      const bounds = row.getBoundingClientRect()
      return bounds.top < viewportTop && bounds.bottom > viewportTop
    })
    if (clipped !== undefined)
      timeline.scrollTop -= viewportTop - clipped.getBoundingClientRect().top
  })
  await expect(page).toHaveScreenshot('sessions-input-pending.png', { fullPage: true })
})

test('playground/spa-shell carries follow-up images through the canonical timeline', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Scenario: sessions-member', exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  const conversation = page.locator('[data-work-session]')
  const timeline = conversation.getByLabel('Session timeline')
  // The seeded history carries one attachment; wait for it so the count below
  // is of a loaded timeline, not of however much had streamed in at call time.
  // On a phone the virtualized row can be outside the visible scroll window,
  // but it remains the canonical rendered timeline entry we need to count.
  await expect(timeline.getByRole('img', { name: 'Session attachment' })).toHaveCount(1)
  const initialImages = await timeline.getByRole('img', { name: 'Session attachment' }).count()

  await conversation.locator('input[type="file"]').setInputFiles({
    name: 'follow-up.webp',
    mimeType: 'image/webp',
    buffer: Buffer.from('follow-up-image'),
  })
  await conversation.getByLabel('Message Milo').fill('Use this updated dashboard')
  await conversation.getByLabel('Message Milo').press('Enter')

  await expect(timeline.getByText('Use this updated dashboard', { exact: true })).toHaveCount(1)
  await expect(timeline.getByRole('img', { name: 'Session attachment' })).toHaveCount(
    initialImages + 1,
  )
  await expect(conversation.getByText('follow-up.webp', { exact: true })).toHaveCount(0)
})

test('playground/spa-shell exposes session loading and failure states', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  for (const [scenario, shot] of [
    ['sessions-loading', 'sessions-loading.png'],
    ['sessions-detail-loading', 'sessions-detail-loading.png'],
    ['sessions-error', 'sessions-error.png'],
  ] as const) {
    await page
      .getByRole('button', { name: `Scenario: ${scenario}`, exact: true, includeHidden: true })
      .evaluate((button: HTMLButtonElement) => button.click())
    await expect(page).toHaveScreenshot(shot, { fullPage: true })
  }

  /* Work keeps other conversations on screen beside the one under review, so
     every read scopes to the conversation rather than to the page. */
  await page
    .getByRole('button', {
      name: 'Scenario: sessions-detail-error',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  const errored = page.locator('[data-work-session]')
  /* The surface's own failure. The session it was asked for is one no page of
     the list can hold — snapshot-only, the stand-in for an archived session or
     one past the first page — so the read that failed is the one resolving that
     session by id, and the whole surface says "that did not load" rather than
     claiming the link named something this workspace does not have. */
  await expect(errored.getByText('That did not load')).toBeVisible()
  await expect(page).toHaveScreenshot('sessions-detail-error.png', { fullPage: true })
  // The backend recovers, and only then is Try again the click that heals.
  await page.evaluate(() => {
    ;(globalThis as { __sessionDetailHealed?: boolean }).__sessionDetailHealed = true
  })
  await errored.getByRole('button', { name: 'Try again', exact: true }).click()
  /* Healed means the conversation itself is on screen: this session is running
     rather than waiting on a person, so what proves the retry landed is its
     timeline, not a composer state that belongs to a different session. */
  await expect(errored.getByLabel('Session timeline')).toBeVisible()
  await expect(errored.getByText('Refresh the competitor briefing').first()).toBeVisible()

  await page
    .getByRole('button', { name: 'Scenario: sessions-member', exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  const member = page.locator('[data-work-session]')
  await expect(
    member
      .getByRole('region', { name: 'Milo needs your input' })
      .locator('[data-compose-bar-session="waiting"]'),
  ).toBeVisible()
  await expect(member.getByRole('button', { name: 'Session actions' })).toBeVisible()

  await page
    .getByRole('button', { name: 'Scenario: sessions-viewer', exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(sessionSurface(page, 'access-denied')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Sessions access required' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Session actions' })).toHaveCount(0)
  await expect(page).toHaveScreenshot('sessions-access-denied.png', { fullPage: true })

  await page
    .getByRole('button', { name: 'Scenario: sessions-long', exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  const long = page.locator('[data-work-session]')
  const latestEvidence = long.getByText('Launch evidence 14:', { exact: false })
  await expect(latestEvidence).toBeVisible()
  const longTimeline = long.locator('[data-virtualized-session-timeline]')
  expect(await longTimeline.locator('[data-virtualized-message]').count()).toBeLessThan(20)
  await scrollTimelineContentClear(longTimeline, latestEvidence)
  await expect(page).toHaveScreenshot('sessions-long.png', { fullPage: true })
})

test('playground/spa-shell restores rejected optimistic mutations and owns create errors', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  // The dialog hosts the session; the agent's own chat column behind it reads
  // the same fixtures, so every read scopes to the conversation.
  const conversation = page.locator('[data-work-session]')
  await page
    .getByRole('button', {
      name: 'Scenario: sessions-mutation-error',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await conversation.getByRole('button', { name: 'Interrupt', exact: true }).click()
  await expect(
    conversation.getByRole('button', { name: 'Interrupting', exact: true }),
  ).toBeDisabled()
  await expect(
    conversation.locator('[data-compose-bar-session="working"]').getByRole('alert'),
  ).toHaveText('That action could not be completed.')
  await expect(conversation.getByRole('button', { name: 'Interrupt', exact: true })).toBeEnabled()

  // The same rejecting backend, on the session that is waiting for an answer:
  // rename and archive each roll back to what the server still holds.
  await page
    .getByRole('button', {
      name: 'Scenario: sessions-mutation-error-ask',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(
    conversation
      .getByRole('region', { name: 'Milo needs your input' })
      .locator('[data-compose-bar-session="waiting"]'),
  ).toBeVisible()
  await conversation
    .getByRole('button', { name: 'Prepare the launch readiness report', exact: true })
    .click()
  await conversation.getByLabel('Session title').fill('Title that must roll back')
  await conversation.getByLabel('Session title').press('Enter')
  await expect(
    conversation.getByRole('button', { name: 'Prepare the launch readiness report', exact: true }),
  ).toBeVisible()
  await conversation.getByRole('button', { name: 'Session actions' }).click()
  await page.getByRole('menuitem', { name: 'Archive for everyone', exact: true }).click()
  // Failure is inline and retryable: the canonical state and the open menu stay put.
  await expect(page.getByRole('menu').getByRole('alert')).toHaveText(
    'That action could not be completed.',
  )
  await expect(
    page.getByRole('menuitem', { name: 'Archive for everyone', exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(conversation.getByRole('button', { name: 'Session actions' })).toBeFocused()
  await conversation.getByRole('button', { name: 'Session actions' }).click()
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  const deleteDialog = page.getByRole('alertdialog')
  await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(deleteDialog.getByRole('alert')).toHaveText(
    'The conversation could not be deleted. Try again.',
  )
  await expect(deleteDialog.getByRole('button', { name: 'Try deleting again' })).toBeEnabled()
  await expect(page).toHaveScreenshot('sessions-mutation-error.png', { fullPage: true })
  await deleteDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  /* The failure toasts dismiss themselves on a 6s clock; wait them out so the
     shot captures the settled surface rather than a race with that timer. */
  await expect(
    page.getByRole('status').filter({ hasText: 'That action could not be completed.' }),
  ).toHaveCount(0, { timeout: 15_000 })
  await page
    .getByRole('button', {
      name: 'Scenario: sessions-input-error',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await conversation.getByLabel('Message Milo').fill('This message must roll back')
  await conversation.getByLabel('Message Milo').press('Enter')
  await expect(conversation.getByText('That action could not be completed.')).toBeVisible()
  await expectEditableText(conversation.getByLabel('Message Milo'), 'This message must roll back')
  await expect(
    conversation
      .getByLabel('Session timeline')
      .getByText('This message must roll back', { exact: true }),
  ).toHaveCount(0)

  const rolloutOwner = conversation.getByRole('checkbox', { name: /Ada owns the rollout/ })
  await rolloutOwner.click()
  await conversation.getByRole('button', { name: 'Done — submit answers' }).click()
  await expect(
    conversation.locator('[data-compose-bar-session-questions="true"]').getByRole('alert'),
  ).toHaveText('Your answer could not be sent. Try again.')
  await expect(rolloutOwner).toBeChecked()

  await page
    .getByRole('button', {
      name: 'Scenario: sessions-input-response-lost',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await conversation.getByLabel('Message Milo').fill('This accepted message must not roll back')
  await conversation.getByLabel('Message Milo').press('Enter')
  await expect(
    conversation
      .getByLabel('Session timeline')
      .getByText('This accepted message must not roll back', { exact: true }),
  ).toHaveCount(1)
  await expect(page.getByText('That action could not be completed.')).toHaveCount(0)
  await expectEditableText(conversation.getByLabel('Message Milo'), '')

  await page
    .getByRole('button', {
      name: 'Scenario: sessions-create-error',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  // That scenario opens on an agent whose default chat has no session yet —
  // the empty chat, whose composer holds the draft through the failure.
  await page.getByLabel('Describe a task for Research…').fill('This creation must fail')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('Session could not be created.')).toBeVisible()
  await expectEditableText(
    page.getByLabel('Describe a task for Research…'),
    'This creation must fail',
  )
  await expect(page).toHaveScreenshot('sessions-create-error.png', { fullPage: true })

  await page
    .getByRole('button', {
      name: 'Scenario: sessions-create-response-lost',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await page.getByLabel('Describe a task for Research…').fill('Keep the accepted session')
  await page.getByLabel('Describe a task for Research…').press('Enter')
  await expect(
    page.getByLabel('Session timeline').getByText('Keep the accepted session', { exact: true }),
  ).toHaveCount(1)
  await expect(page.getByText('Session could not be created.')).toHaveCount(0)
})

test('playground/spa-shell makes out-of-credits refusals recoverable without losing drafts', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  /* Out of credits is not "something went wrong": it is a refusal the payer can
     resolve, so the composer has to name it and offer the way out. The draft
     survives for the same reason it survives any rejection — the send never
     happened. */
  await page
    .getByRole('button', {
      name: 'Scenario: sessions-spend-blocked',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  const conversation = page.locator('[data-work-session]')
  await conversation.getByLabel('Message Milo').fill('This message outruns the credits')
  await conversation.getByLabel('Message Milo').press('Enter')
  const spendRefusal = conversation.locator('[data-spend-refusal="insufficient_credits"]')
  await expect(spendRefusal).toContainText('out of credits')
  await expect(spendRefusal.getByRole('link', { name: 'Add credits' })).toHaveAttribute(
    'href',
    '/settings/billing',
  )
  await expect(conversation.getByText('That action could not be completed.')).toHaveCount(0)
  await expectEditableText(
    conversation.getByLabel('Message Milo'),
    'This message outruns the credits',
  )
  await expect(
    conversation.getByRole('button', { name: 'Resolve billing to send', exact: true }),
  ).toBeDisabled()
  await expect(conversation.getByText('Sending is paused', { exact: true })).toBeVisible()

  // A recovery completed elsewhere releases the refusal without sacrificing
  // the rejected draft or forcing a reload.
  await page
    .getByRole('button', { name: 'Simulate low credit still pending', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.locator('[data-low-credit-gate="topup"]')).toBeVisible()
  await page
    .getByRole('button', { name: 'Simulate low credit recovery complete', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.locator('[data-low-credit-gate]')).toHaveCount(0)
  await expect(conversation.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  await expectEditableText(
    conversation.getByLabel('Message Milo'),
    'This message outruns the credits',
  )

  // The first message of a chat that does not exist yet refuses the same way.
  await page
    .getByRole('button', {
      name: 'Scenario: sessions-spend-blocked-create',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await page.getByLabel('Describe a task for Research…').fill('This creation outruns the credits')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('[data-spend-refusal="insufficient_credits"]')).toContainText(
    'out of credits',
  )
  await expect(page.getByText('Session could not be created.')).toHaveCount(0)
  await expectEditableText(
    page.getByLabel('Describe a task for Research…'),
    'This creation outruns the credits',
  )
  await expect(
    page.getByRole('button', { name: 'Resolve billing to send', exact: true }),
  ).toBeDisabled()
  await expect(page.getByText('Sending is paused', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('sessions-spend-blocked.png', { fullPage: true })
})

test('playground/spa-shell removes a deleted session after its response is lost', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Scenario: sessions-delete-response-lost',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())

  await page.getByRole('button', { name: 'Session actions' }).click()
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click()

  /* Same landing as every other delete, and the list it lands on is Work's
     home now rather than the jobs dialog's pane: the conversation this surface
     was showing is gone, so there is nowhere on it to stay. What has to be true
     is that the reader arrives somewhere real and the deleted row is not in the
     rail — and that the lost response is not reported as a failure, because the
     delete did happen. */
  await expect(page.locator('[data-work-session-starter]')).toBeVisible()
  await expect(page.locator('[data-work-session]')).toHaveCount(0)
  await expect(
    page.getByRole('navigation', { name: 'Work' }).getByText('Prepare the launch readiness report'),
  ).toHaveCount(0)
  await expect(page.getByText('That action could not be completed.')).toHaveCount(0)
})

test('playground/spa-shell reconciles metadata after mutation responses are lost', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Scenario: sessions-metadata-response-lost',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())

  const conversation = page.locator('[data-work-session]')
  await conversation
    .getByRole('button', { name: 'Prepare the launch readiness report', exact: true })
    .click()
  await conversation.getByLabel('Session title').fill('Durably renamed session')
  await conversation.getByLabel('Session title').press('Enter')
  await expect(
    conversation.getByRole('button', { name: 'Durably renamed session', exact: true }),
  ).toBeVisible()
  await conversation.getByRole('button', { name: 'Session actions' }).click()
  await page.getByRole('menuitem', { name: 'Archive for everyone', exact: true }).click()
  /* The archive response was lost but the archive landed durably: reconciled,
     the row is put away and the dialog is back on its list, with no error. */
  await expect(conversation.getByText('Durably renamed session', { exact: true })).toHaveCount(0)
  await expect(page.getByText('That action could not be completed.')).toHaveCount(0)
})

test('playground/spa-shell reconciles a lost personal-archive response', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Scenario: sessions-personal-response-lost',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())

  const conversation = page.locator('[data-work-session]')
  await conversation.getByRole('button', { name: 'Session actions' }).click()
  await page.getByRole('menuitem', { name: 'Archive for me', exact: true }).click()

  await expect(
    conversation.getByText('Prepare the launch readiness report', { exact: true }),
  ).toHaveCount(0)
  await expect(page.getByText('That action could not be completed.')).toHaveCount(0)
})

test('playground/spa-shell renders lifecycle state only from archive timestamps and permissions', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  const cases = [
    ['sessions-lifecycle-workspace-viewer', ['Archive for me']],
    ['sessions-lifecycle-workspace-editor', ['Restore for me', 'Archive for everyone', 'Delete']],
    ['sessions-lifecycle-specific-viewer', ['Archive for me']],
    ['sessions-lifecycle-specific-editor', ['Restore for me', 'Restore for everyone', 'Delete']],
    ['sessions-lifecycle-owner-override', ['Archive for me', 'Archive for everyone', 'Delete']],
  ] as const

  for (const [scenario, expected] of cases) {
    await page
      .getByRole('button', { name: `Scenario: ${scenario}`, exact: true, includeHidden: true })
      .evaluate((button: HTMLButtonElement) => button.click())
    const trigger = page
      .locator('[data-work-session]')
      .getByRole('button', { name: 'Session actions' })
    await expect(trigger).toBeVisible()
    if (scenario === 'sessions-lifecycle-workspace-viewer') {
      await page.waitForTimeout(50)
      await expect(trigger).not.toBeFocused()
    }
    await trigger.click()
    await expect(page.getByRole('menuitem')).toHaveCount(expected.length)
    for (const label of expected) {
      await expect(page.getByRole('menuitem', { name: label, exact: true })).toBeVisible()
    }
    await expect(page.getByRole('menu')).not.toContainText(/private|owner access/i)
    await page.keyboard.press('Escape')
  }
})

test('playground/spa-shell frames the lifecycle host, menu, and delete confirmation', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Scenario: sessions-lifecycle-workspace-editor',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())

  const conversation = page.locator('[data-work-session]')
  await expect(conversation.getByLabel('Session timeline')).toBeVisible()
  await expect(conversation).toHaveScreenshot('sessions-lifecycle-host.png')
  await conversation.getByRole('button', { name: 'Session actions' }).click()
  const menu = page.getByRole('menu')
  await expect(menu).toHaveScreenshot('sessions-lifecycle-menu.png')
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toHaveScreenshot('sessions-lifecycle-delete.png')
})

test('playground/spa-shell refreshes stale lifecycle permissions and exits missing sessions', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page
    .getByRole('button', {
      name: 'Scenario: sessions-lifecycle-403',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  let conversation = page.locator('[data-work-session]')
  await conversation.getByRole('button', { name: 'Session actions' }).click()
  await page.getByRole('menuitem', { name: 'Archive for everyone', exact: true }).click()
  await expect(conversation.getByRole('button', { name: 'Session actions' })).toHaveCount(0)
  await expect(conversation.getByLabel('Session timeline')).toBeVisible()

  await page
    .getByRole('button', {
      name: 'Scenario: sessions-lifecycle-404',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  conversation = page.locator('[data-work-session]')
  await conversation.getByRole('button', { name: 'Session actions' }).click()
  await page.getByRole('menuitem', { name: 'Archive for everyone', exact: true }).click()
  await expect(
    conversation.getByText('Prepare the launch readiness report', { exact: true }),
  ).toHaveCount(0)
})

test('playground/spa-shell closes stale delete confirmation after a 403 permission refresh', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Scenario: sessions-lifecycle-delete-403',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())

  const conversation = page.locator('[data-work-session]')
  await conversation.getByRole('button', { name: 'Session actions' }).click()
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click()

  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  const actions = conversation.getByRole('button', { name: 'Session actions' })
  await expect(actions).toBeFocused()
  await actions.click()
  await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Archive for me', exact: true })).toBeVisible()
  await expect(conversation.getByLabel('Session timeline')).toBeVisible()
})

test('playground/spa-shell reconnects live sessions from canonical SSE cursor', async ({
  page,
}) => {
  const reconnectCursors: string[] = []
  let requests = 0
  await page.route('**/api/duet/ws/acme/agent/sessions/session_running/events*', async route => {
    requests += 1
    reconnectCursors.push((await route.request().headerValue('last-event-id')) ?? '')
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body:
        requests === 1
          ? [
              'retry: 50\n',
              sseFrame(1, {
                type: 'session_created',
                prompt: 'Reconnect',
                createdAt: '2026-07-11T00:00:00.000Z',
              }),
              sseFrame(2, {
                type: 'prompt_submitted',
                prompt: 'Reconnect',
                inputKind: 'initial',
                behavior: 'steer',
                sender: { kind: 'user', userId: 'user_owner' },
              }),
              sseFrame(3, { type: 'turn_started' }),
              sseFrame(4, {
                type: 'step',
                step: { type: 'text', text: 'Canonical tail restored once.' },
              }),
              sseFrame(5, {
                type: 'step',
                step: { type: 'reasoning', text: 'Reconnect complete.' },
              }),
            ].join('')
          : [
              sseFrame(5, {
                type: 'step',
                step: { type: 'reasoning', text: 'Reconnect complete.' },
              }),
              sseFrame(6, {
                type: 'complete',
                state: COMPLETED_TURN_STATE,
                status: 'completed',
              }),
            ].join(''),
    })
  })
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Browser route: /w/acme/agents/root/sessions/session_running',
      exact: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())

  await expect(page.getByText('Canonical tail restored once.', { exact: true })).toHaveCount(1)
  await expect.poll(() => requests, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  expect(reconnectCursors).toContain('5')
  await expect(page.getByText('Canonical tail restored once.', { exact: true })).toHaveCount(1)
  /* The complete event landed: its reasoning tail is on the timeline. `.first()`
     because a collapsed reasoning group renders the text as its summary line
     and again inside the disclosure. */
  await expect(
    page.locator('[data-work-session]').getByText('Reconnect complete.', { exact: true }).first(),
  ).toBeVisible()
  await page.waitForTimeout(250)
  expect(requests).toBe(2)
})

test('playground/spa-shell backs off across repeated SSE failures', async ({ page }) => {
  const requestTimes: number[] = []
  await page.route('**/api/duet/ws/acme/agent/sessions/session_running/events*', async route => {
    requestTimes.push(Date.now())
    if (requestTimes.length < 3) {
      await route.fulfill({ status: 503, body: 'temporarily unavailable' })
      return
    }
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: [
        sseFrame(1, {
          type: 'session_created',
          prompt: 'Reconnect with backoff',
          createdAt: '2026-07-11T00:00:00.000Z',
        }),
        sseFrame(2, {
          type: 'prompt_submitted',
          prompt: 'Reconnect with backoff',
          inputKind: 'initial',
          behavior: 'steer',
          sender: { kind: 'user', userId: 'user_owner' },
        }),
        sseFrame(3, { type: 'turn_started' }),
        sseFrame(4, { type: 'step', step: { type: 'text', text: 'Recovered safely.' } }),
        sseFrame(5, { type: 'step', step: { type: 'reasoning', text: 'Backoff worked.' } }),
        sseFrame(6, {
          type: 'complete',
          state: COMPLETED_TURN_STATE,
          status: 'completed',
        }),
      ].join(''),
    })
  })

  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Browser route: /w/acme/agents/root/sessions/session_running',
      exact: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())

  await expect(page.getByText('Recovered safely.', { exact: true })).toBeVisible()
  expect(requestTimes).toHaveLength(3)
  expect(requestTimes[1]! - requestTimes[0]!).toBeGreaterThanOrEqual(200)
  expect(requestTimes[2]! - requestTimes[1]!).toBeGreaterThanOrEqual(400)
})

function sseFrame(seq: number, event: Record<string, unknown>): string {
  return `id: ${seq}\nevent: ${String(event.type)}\ndata: ${JSON.stringify({ seq, event })}\n\n`
}

test('playground/ui-primitives keeps the default button compact', async ({ page }) => {
  await page.goto('/playground/ui-primitives')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const defaultButton = page.getByRole('button', { name: 'Default', exact: true }).first()
  await expect(defaultButton).toBeVisible()
  await expect.poll(async () => (await defaultButton.boundingBox())?.height).toBe(36)
})

test('playground/session-markdown keeps supporting paragraphs attached to numbered claims', async ({
  page,
}) => {
  await page.goto('/playground/session-markdown')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const firstItemParagraphs = page
    .locator('[data-markdown-session] ol > li')
    .first()
    .locator(':scope > p')
  await expect(firstItemParagraphs).toHaveCount(2)
  const title = await firstItemParagraphs.nth(0).boundingBox()
  const support = await firstItemParagraphs.nth(1).boundingBox()
  expect(title).not.toBeNull()
  expect(support).not.toBeNull()
  expect(Math.round(support!.y - (title!.y + title!.height))).toBeLessThanOrEqual(8)
})

test('playground/markdown renders every supported block and inline family', async ({ page }) => {
  await page.goto('/playground/markdown')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const markdown = page.locator('[data-markdown-document]')
  await expect(markdown.getByRole('heading', { level: 1 })).toHaveText('Markdown field guide')
  await expect(markdown.getByRole('heading', { level: 6 })).toHaveText('Heading level six')
  await expect(markdown.locator('strong')).not.toHaveCount(0)
  await expect(markdown.locator('em')).not.toHaveCount(0)
  await expect(markdown.locator('del')).toHaveText('struck through')
  await expect(markdown.locator('br')).toHaveCount(1)
  await expect(markdown.locator('a')).not.toHaveCount(0)
  await expect(markdown.locator('ol')).not.toHaveCount(0)
  await expect(markdown.locator('ul')).not.toHaveCount(0)
  await expect(markdown.locator('input[type="checkbox"]')).toHaveCount(2)
  await expect(
    markdown
      .locator('li:has(> input[type="checkbox"])')
      .first()
      .evaluate(element => getComputedStyle(element).listStyleType),
  ).resolves.toBe('none')
  await expect(markdown.locator('blockquote')).toContainText('Durable work')
  await expect(markdown.locator('pre code.language-ts')).toContainText('SessionState')
  await expect(markdown.locator('table')).toBeVisible()
  await expect(markdown.locator('img')).toHaveAttribute('src', '/playground/session-image.jpg')
  await expect(markdown.locator('.math-inline')).toContainText('E = mc')
  await expect(markdown.locator('.math-display')).toContainText('sum')
})

test('playground/markdown gives code distinct readable surfaces in both themes', async ({
  page,
}) => {
  await page.goto('/playground/markdown')
  await expect(page.getByRole('heading', { name: 'Markdown field guide' })).toBeVisible()

  const palette = async () =>
    page.locator('[data-markdown-document]').evaluate(markdown => {
      const inline = markdown.querySelector(':not(pre) > code:not(.math-inline)')
      const block = markdown.querySelector('pre')
      if (!(inline instanceof HTMLElement) || !(block instanceof HTMLElement)) {
        throw new Error('Markdown code fixtures did not render')
      }
      const inlineStyle = getComputedStyle(inline)
      const blockStyle = getComputedStyle(block)
      return {
        inlineBackground: inlineStyle.backgroundColor,
        inlineForeground: inlineStyle.color,
        blockBackground: blockStyle.backgroundColor,
        blockForeground: blockStyle.color,
      }
    })

  const light = await palette()
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  const dark = await palette()

  expect(light.inlineBackground).not.toBe(light.inlineForeground)
  expect(dark.inlineBackground).not.toBe(dark.inlineForeground)
  expect(dark.inlineBackground).not.toBe(light.inlineBackground)
  expect(light.blockBackground).not.toBe(light.blockForeground)
  expect(dark.blockBackground).not.toBe(dark.blockForeground)
  expect(dark.blockBackground).not.toBe(light.blockBackground)
})

test('playground/app-building shows fallback and empty activity variants', async ({ page }) => {
  await page.goto('/playground/app-building')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  for (const [variant, heading, shot] of [
    ['Slug fallback', 'weekly-metrics-dashboard is being built', 'app-building-slug.png'],
    ['No activity yet', 'new-report is being built', 'app-building-empty.png'],
  ] as const) {
    await page.getByRole('button', { name: variant, exact: true }).click()
    const iframe = page.locator('iframe')
    await expect(iframe.contentFrame().getByRole('heading', { name: heading })).toBeVisible()
    await expect(iframe).toHaveScreenshot(shot)
  }
})

test('playground/onboarding taps goal and follow-ups through to the ready payoff', async ({
  page,
}) => {
  await page.goto('/playground/onboarding?catalog=paged')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await expect(page).toHaveScreenshot('onboarding-dark.png', { fullPage: true })

  // The ⋯ menu beside the step bars: preferences without leaving setup.
  await page.getByRole('button', { name: 'Options', exact: true }).click()
  const optionsMenu = page.getByRole('menu').filter({ visible: true })
  await expect(optionsMenu.getByRole('menuitem', { name: /Theme/ })).toBeVisible()
  await expect(optionsMenu.getByRole('menuitem', { name: /Language/ })).toBeVisible()
  await expect(optionsMenu.getByRole('menuitem', { name: 'Sign out', exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('onboarding-menu.png', { fullPage: true })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)

  const name = page.getByLabel('Assistant name')
  await expect(name).toHaveValue('Duet')
  await name.fill('Milo')
  await expect(page.locator('header').getByText('Milo', { exact: true })).toBeVisible()
  await name.blur()
  await expect(page).toHaveScreenshot('onboarding-name-live.png', { fullPage: true })
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page.getByRole('heading', { name: 'What is your goal here?' })).toBeVisible()
  await expect(page).toHaveScreenshot('onboarding-goal.png', { fullPage: true })
  await page.getByRole('button', { name: 'Grow my business', exact: true }).click()

  // The goal's one follow-up, its smart default already pressed — zero typing
  // to a purpose worth reading, and Continue must leave the step on the press.
  const step = page.locator('[data-onboarding-step]')
  await expect(step).toHaveAttribute('data-followup-index', '0')
  await expect(page.getByRole('button', { name: 'SEO and content', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByLabel('Add detail (optional)')).toBeVisible()
  await expect(page).toHaveScreenshot('onboarding-followups.png', { fullPage: true })
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(step).toHaveAttribute('data-onboarding-step', 'team')

  const research = page.getByRole('checkbox', { name: 'Select Research Assistant' })
  const writer = page.getByRole('checkbox', { name: 'Select Writing Editor' })
  await expect(research).toBeVisible()
  await expect(page.getByText(/Milo is already in your workspace/)).toBeVisible()
  await expect(page.getByText('4 agents loaded · scroll to browse')).toHaveCount(1)
  const loadMoreCatalog = page.getByRole('button', { name: 'Load more official agents' })
  await expect(loadMoreCatalog).toBeVisible()
  await expect(page).toHaveScreenshot('onboarding-team-catalog-continuation.png', {
    fullPage: true,
  })
  await loadMoreCatalog.click()
  await expect(page.getByText('6 agents · scroll to browse')).toHaveCount(1)
  await expect(loadMoreCatalog).toHaveCount(0)
  // The picked-for-you rail hydrated with four personalized reasons.
  await expect(page.locator('[data-onboarding-recommendations="ready"]')).toBeVisible()
  await expect(page.getByText('Picked for you')).toBeVisible()
  await expect(page.locator('[data-testid="marketplace-card-reason"]')).toHaveCount(4)
  await research.click()
  await writer.click()
  /* Two picks are one short of the minimum-3 floor, and the *button* is what
     says so: the gate is a count, so the primary action states the count rather
     than sitting disabled above a hint line — a line that would cost fixed
     footer height on every scroll of a catalog the reader is meant to browse.
     See `primaryLabel` in `onboarding-experience.tsx`. So there is no button
     called Continue to be disabled here, at either width. */
  const shortByOne = page.getByRole('button', { name: 'Pick 1 more agent' })
  await expect(shortByOne).toBeVisible()
  await expect(shortByOne).toBeDisabled()
  await page.getByRole('checkbox', { name: 'Select Outreach Writer' }).click()
  await expect(page.getByRole('checkbox', { name: 'Deselect Research Assistant' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled()
  /* Pin the scroll rather than nudge it. `scrollIntoViewIfNeeded` stops the
     moment the heading is anywhere in view, which lands a couple of pixels
     differently depending on what the previous click left behind — and this
     step is `fixed inset-0`, so the shot photographs whatever its inner
     scroller settled on rather than a page offset. Two pixels is under the
     diff threshold often enough to look stable and fail every few runs. */
  const teamHeading = page.getByRole('heading', { name: 'Choose your starting team' })
  await teamHeading.evaluate(node => {
    let box = node.parentElement
    while (box !== null && box.scrollHeight <= box.clientHeight) box = box.parentElement
    box?.scrollTo({ top: 0 })
  })
  await expect
    .poll(() =>
      teamHeading.evaluate(node => {
        let box = node.parentElement
        while (box !== null && box.scrollHeight <= box.clientHeight) box = box.parentElement
        return box?.scrollTop ?? 0
      }),
    )
    .toBe(0)
  await expect(page).toHaveScreenshot('onboarding-team-selected.png', { fullPage: true })

  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Your workspace is ready' })).toBeVisible()
  // The purpose payoff: the goal echo beside the team roster.
  await expect(page.getByText('Grow my business')).toBeVisible()
  await expect(page.getByText('Your goal', { exact: true })).toBeVisible()
  await expect(page.getByText('Your team', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('onboarding-ready.png', { fullPage: true })

  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.locator('[data-onboarding-step]')).toHaveAttribute(
    'data-onboarding-step',
    'payment',
  )
  const paymentStep = page.locator('[data-onboarding-step="payment"]')
  await expect(
    paymentStep.getByText('We need a valid credit card to unlock your $5 in free credits.', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(paymentStep.getByText(/authorization/i)).toHaveCount(0)
  await expect(page.getByText('Your payment method is ready', { exact: true })).toBeVisible()
  await expect(page.getByText('Your $5 in free credits is ready')).toBeVisible()
  await expect(page).toHaveScreenshot('onboarding-payment.png', { fullPage: true })
  await page.getByRole('button', { name: 'Enter your workspace' }).click()
  await expect(page.locator('main').getByRole('alert')).toHaveText(
    "Setup is complete, but we couldn't open your workspace. Check your connection and try again.",
  )
  const retryCompletion = page.getByRole('button', { name: 'Open workspace again' })
  await expect(retryCompletion).toBeEnabled()
  await expect(retryCompletion).toBeInViewport({ ratio: 1 })
  await expect(page).toHaveScreenshot('onboarding-completion-error.png', { fullPage: true })
})

test('playground/onboarding expands the write-your-own goal into a textarea', async ({ page }) => {
  await page.goto('/playground/onboarding?goal=custom')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const customGoal = page.getByLabel('Describe your goal')
  await expect(customGoal).toBeVisible()
  await expect(page.getByRole('button', { name: /Write your own/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page).toHaveScreenshot('onboarding-goal-custom.png', { fullPage: true })

  // Blank custom text refuses to advance; typed text skips follow-ups for team.
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByText('Describe your goal to continue.')).toBeVisible()
  await customGoal.fill('Ship a weekly newsletter to our customers')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.locator('[data-onboarding-step]')).toHaveAttribute(
    'data-onboarding-step',
    'team',
  )
})

test('playground/onboarding reaches every preset goal directly by URL param', async ({ page }) => {
  await page.goto('/playground/onboarding?goal=replace-software')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await expect(page.locator('[data-onboarding-step]')).toHaveAttribute(
    'data-onboarding-step',
    'follow-ups',
  )
  /* The goal's own question, and the chip it pre-presses. Both are the goal's
     to declare — `onboarding-goals.ts` names the question and its default — so
     this reads them as the pair they are: a deep link lands on a question that
     is already answered, which is the whole claim. */
  await expect(page.getByRole('heading', { name: 'What are you replacing?' })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'A pile of spreadsheets', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
})

test('playground/onboarding keeps navigation visible in a short viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 })
  await page.goto('/playground/onboarding')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const name = page.getByLabel('Assistant name')
  const continueButton = page.getByRole('button', { name: 'Continue' })
  await expect(continueButton).toBeInViewport({ ratio: 1 })

  await name.fill('Milo')
  await name.press('Enter')

  await expect(page.getByRole('button', { name: 'Back' })).toBeInViewport({ ratio: 1 })
  await expect(continueButton).toBeInViewport({ ratio: 1 })
  const growTile = page.getByRole('button', { name: 'Grow my business', exact: true })
  await growTile.scrollIntoViewIfNeeded()
  await expect(growTile).toBeInViewport({ ratio: 0.99 })
  const [tileBox, footerBox] = await Promise.all([
    growTile.boundingBox(),
    page.locator('main footer').boundingBox(),
  ])
  expect(tileBox).not.toBeNull()
  expect(footerBox).not.toBeNull()
  if (tileBox && footerBox) {
    expect(tileBox.y + tileBox.height).toBeLessThanOrEqual(footerBox.y + 2)
  }
  await expect(page).toHaveScreenshot('onboarding-short-viewport.png', { fullPage: true })
})

test('playground/onboarding uses one shell width and restores Continue after Back', async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === 'desktop') {
    await page.setViewportSize({ width: 1146, height: 952 })
  }
  await page.goto('/playground/onboarding')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page.evaluate(() => document.documentElement.classList.add('dark'))

  const [headerBox, footerBox] = await Promise.all([
    page.locator('main header').boundingBox(),
    page.locator('main footer').boundingBox(),
  ])
  expect(headerBox).not.toBeNull()
  expect(footerBox).not.toBeNull()
  if (headerBox && footerBox) {
    expect(footerBox.x).toBe(headerBox.x)
    expect(footerBox.width).toBe(headerBox.width)
  }

  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.locator('[data-onboarding-step="identity"]')).toBeVisible()

  const continueButton = page.getByRole('button', { name: 'Continue', exact: true })
  await expect(continueButton).toBeVisible()
  await expect(continueButton).toBeEnabled()
  await expect(continueButton).toBeInViewport({ ratio: 1 })
  await expect(page).toHaveScreenshot('onboarding-returned-identity.png', { fullPage: true })
})

test('playground/onboarding keeps a forward action visible through every step without dvh', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 500 })
  await page.goto('/playground/onboarding')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  // Chromium supports dvh. Removing only that height declaration exercises the
  // fallback path used by browsers that discard or misreport dynamic viewport units.
  await page.addStyleTag({
    content: 'main[data-onboarding-step] { height: auto !important; }',
  })

  const step = page.locator('[data-onboarding-step]')
  await expect(step).toHaveAttribute('data-onboarding-step', 'identity')
  let forward = page.getByRole('button', { name: 'Continue', exact: true })
  await expect(forward).toBeEnabled()
  await expect(forward).toBeInViewport({ ratio: 1 })
  await forward.click()

  // The goal step advances by tile tap; the footer action must still be there.
  await expect(step).toHaveAttribute('data-onboarding-step', 'goal')
  await expect(forward).toBeInViewport({ ratio: 1 })
  await page.getByRole('button', { name: 'Grow my business', exact: true }).click()

  await expect(step).toHaveAttribute('data-onboarding-step', 'follow-ups')
  await expect(step).toHaveAttribute('data-followup-index', '0')
  await expect(forward).toBeEnabled()
  await expect(forward).toBeInViewport({ ratio: 1 })
  await forward.click()

  await expect(step).toHaveAttribute('data-onboarding-step', 'team')
  // The floor asks for three picks before the forward action unlocks.
  for (const name of [
    'Select Research Assistant',
    'Select Writing Editor',
    'Select Data Analyst',
  ]) {
    await page.getByRole('checkbox', { name }).click()
  }
  await expect(forward).toBeEnabled()
  await expect(forward).toBeInViewport({ ratio: 1 })
  await forward.click()

  await expect(step).toHaveAttribute('data-onboarding-step', 'ready')
  forward = page.getByRole('button', { name: 'Continue', exact: true })
  await expect(forward).toBeEnabled()
  await expect(forward).toBeInViewport({ ratio: 1 })
  await forward.click()
  await expect(step).toHaveAttribute('data-onboarding-step', 'payment')
  forward = page.getByRole('button', { name: 'Enter your workspace', exact: true })
  await expect(forward).toBeEnabled()
  await expect(forward).toBeInViewport({ ratio: 1 })
})

test('playground/onboarding can continue when the marketplace catalog fails', async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === 'desktop') {
    await page.setViewportSize({ width: 1146, height: 952 })
  }
  await page.goto('/playground/onboarding?catalog=error&goal=grow-business')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page.evaluate(() => document.documentElement.classList.add('dark'))

  // The goal param drops the walk at the goal's only follow-up; one tap reaches team.
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  const catalogError = page.getByText('Official agents could not be loaded.', { exact: true })
  await expect(catalogError).toBeVisible()

  const continueButton = page.getByRole('button', { name: 'Continue', exact: true })
  await expect(continueButton).toBeVisible()
  await expect(continueButton).toBeEnabled()
  await expect(continueButton).toBeInViewport({ ratio: 1 })
  await expect(page.locator('main footer p')).toHaveCount(0)
  const [backBox, continueBox] = await Promise.all([
    page.getByRole('button', { name: 'Back', exact: true }).boundingBox(),
    continueButton.boundingBox(),
  ])
  expect(backBox).not.toBeNull()
  expect(continueBox).not.toBeNull()
  if (backBox && continueBox) {
    const backCenter = backBox.y + backBox.height / 2
    const continueCenter = continueBox.y + continueBox.height / 2
    expect(Math.abs(backCenter - continueCenter)).toBeLessThanOrEqual(1)

    await page.mouse.move(
      continueBox.x + continueBox.width / 2,
      continueBox.y + continueBox.height / 2,
    )
    await page.mouse.down()
    await page.waitForTimeout(100)
    expect(await continueButton.evaluate(element => getComputedStyle(element).transform)).toBe(
      'none',
    )
    await page.mouse.move(0, 0)
    await page.mouse.up()
  }
  await expect(page).toHaveScreenshot('onboarding-team-catalog-error.png', { fullPage: true })

  await continueButton.click()
  await expect(page.locator('[data-onboarding-step="ready"]')).toBeVisible()
})

test('playground/onboarding a recommendations request that answers after a real delay still lands', async ({
  page,
}) => {
  // The request is sent by an effect that also marks the rail pending; that
  // state change must not cancel the request it just sent. A source that
  // answers within the same tick cannot show that, so this one waits.
  await page.goto('/playground/onboarding?recommendations=slow&goal=grow-business')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.locator('[data-onboarding-recommendations="pending"]')).toBeVisible()
  await expect(page.locator('[data-onboarding-recommendations="ready"]')).toBeVisible()
  await expect(page.getByText('Picked for you')).toBeVisible()
  await expect(page.locator('[data-testid="marketplace-card-reason"]')).toHaveCount(4)
})

test('playground/onboarding holds a rail skeleton while picks are pending, and collapses on failure', async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === 'desktop') {
    await page.setViewportSize({ width: 1146, height: 952 })
  }
  // A never-settling request: the skeleton band sits above a catalog that is
  // already fully interactive — the rail never gates the step.
  await page.goto('/playground/onboarding?recommendations=pending&goal=grow-business')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  // One tap on the goal's only follow-up reaches team.
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.locator('[data-onboarding-recommendations="pending"]')).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'Select Research Assistant' })).toBeVisible()
  await expect(page.getByText('Picked for you')).toHaveCount(0)
  await expect(page).toHaveScreenshot('onboarding-team-recommendations-pending.png', {
    fullPage: true,
  })

  // A failed request leaves no trace: no rail, no skeleton, plain catalog.
  await page.goto('/playground/onboarding?recommendations=error&goal=grow-business')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'Select Research Assistant' })).toBeVisible()
  await expect(page.locator('[data-onboarding-recommendations]')).toHaveCount(0)
  await expect(page.getByText('Picked for you')).toHaveCount(0)
  await expect(page).toHaveScreenshot('onboarding-team-recommendations-absent.png', {
    fullPage: true,
  })
})

test('playground/spa-shell gates into onboarding without workspace chrome', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Scenario: onboarding', exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())

  await expect(page.locator('[data-onboarding-step="identity"]')).toBeVisible()
  await expect(page.getByRole('tablist')).toHaveCount(0)
  await expect(page).toHaveScreenshot('spa-shell-onboarding-shellless.png', { fullPage: true })
})

test('playground/settings-default-tier-subscribed exposes every tier and the usage tier vocabulary', async ({
  page,
}) => {
  await page.goto('/playground/settings-default-tier-subscribed')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page.getByRole('button', { name: 'Default quality: Standard' }).click()
  await expect(qualityMenuOption(page, 'Standard')).toBeVisible()
  await expect(qualityMenuOption(page, 'Standard')).toBeChecked()
  await expect(qualityMenuOption(page, 'Max')).toBeVisible()
  await expect(
    qualityMenuOption(page, 'Standard').locator('[aria-label="Performance: 4/5"]'),
  ).toBeVisible()
  await expect(
    qualityMenuOption(page, 'Standard').locator('[aria-label="Intelligence: 4/5"]'),
  ).toBeVisible()
  await expect(qualityMenuOption(page, 'Max').locator('[aria-label="Cost: 5/5"]')).toBeVisible()

  await page.goto('/playground/settings-usage-tier-badges')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await expect(page.locator('[data-usage-tier="frontier"]')).toHaveText('Max')
  await expect(page.locator('[data-usage-tier="balanced"]')).toHaveText('Standard')
  await expect(page.getByText('Claude Opus 5', { exact: true })).toHaveCount(0)
  await expect(page.getByText('upstream cost', { exact: false })).toHaveCount(0)
})

test('playground/settings-usage-tier-badges shows the exact spend point on hover', async ({
  page,
}) => {
  await page.goto('/playground/settings-usage-tier-badges')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  const canvases = page.locator('canvas')
  await expect(canvases.first()).toBeVisible()
  const box = await canvases.first().boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 12)
  await expect(canvases.first()).toBeVisible()
})

/* Every node's position is written by the animation loop, not by React, so a
   node can be present, styled and accessible while sitting at the origin with no
   transform at all — which is exactly what happened to the core once the loop
   started skipping writes for nodes that had not moved. Nothing about the DOM
   looks wrong in that state; only the geometry does.

   Being outside the visible frame is *not* the fault: the camera deliberately
   zooms to a subset, so most of the ring is off-frame whenever a branch is
   open. A missing transform is the fault.

   The second half navigates by clicking empty canvas rather than by hunting for
   a chip. A chip's position depends on the camera, so at 390px the one this
   used to reach was outside the visible box and the click missed; the corner of
   the map is empty at every viewport. */
test('playground/knowledge-map gives every node a position', async ({ page }) => {
  await page.goto('/playground/knowledge-map')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  // Read off `style.transform`, not the `transform` *attribute* of the same
  // name. They express the same move and cost very different things — the
  // attribute goes through SVG's own layout path and re-rasterises the subtree,
  // the property is the one browsers composite — so the motion loop writes the
  // property. A check still looking for the attribute reports every node on the
  // map as unplaced while the map is drawn correctly in front of it.
  const unplaced = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<SVGGElement>('.km-n')]
        .filter(node => node.style.transform === '')
        .map(node => `${node.dataset.node}: ${node.getAttribute('aria-label') ?? ''}`),
    )

  const map = page.locator('.km-svg')
  // The fixture opens inside an agent, and an agent's own apps are not drawn
  // from in there — the pane on the right is showing one of them by name. So
  // this node is present and placed and put away, which is three different
  // claims: attached first, because `toBeHidden` also passes for an element
  // that was never rendered at all.
  const carried = page.locator('.km-n[data-node="app"]').first()
  await expect(carried).toBeAttached()
  await expect(carried).toBeHidden()
  expect(await unplaced()).toEqual([])

  // Clicking empty canvas flies the camera back out. Nothing is added or
  // removed by that — the ring is the whole picture at rest — so what this
  // proves is that a re-render with different classes on every node leaves
  // every one of them still carrying a position.
  //
  // Four pixels in, not sixteen: the unfolded surface is inset by at least
  // eight and that gutter is canvas at every viewport, while sixteen is inside
  // the surface's own first row — which is the agent's name on a narrow map.
  const box = await map.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.click(box!.x + 4, box!.y + 4)

  await expect(page.locator('.km-n.km-dim')).toHaveCount(0, { timeout: 10_000 })
  // and the apps that agent carries are back out on the canvas with it
  await expect(carried).toBeVisible()
  expect(await unplaced()).toEqual([])
})

/* Which agent is *working*, and the one distinction the whole signal rests on.
   The home fixture is built for it: Data Analyst has a job running, its own
   conversation running, and one job stuck on a question; SEO Writer has exactly
   one session, asleep with a wake time on it. Both active and sleeping work can
   be `running` on the wire. Only the former should pulse. Get that wrong and the
   map pulses at a drive where nothing is going on. */
test('playground/knowledge-map-home pulses for work in flight, not for work on a clock', async ({
  page,
}) => {
  await page.goto('/playground/knowledge-map-home')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const live = page.locator('.km-n[data-node="agent"][data-live]')
  await expect(live).toHaveCount(1)
  await expect(live).toHaveAttribute('aria-label', /^Data Analyst\. 2 sessions running\./)

  // A comet and the echo behind it, on the one trunk that ends at that agent —
  // and the wire under them tinted, so the line still reads as a line between
  // beats. One ring on the plate per comet, so every arrival strikes something.
  await expect(page.locator('.km-edge.km-trunk.km-live')).toHaveCount(1)
  await expect(page.locator('.km-spark')).toHaveCount(2)
  await expect(page.locator('.km-spark.km-spark-echo')).toHaveCount(1)
  await expect(live.locator('.km-live-flare')).toHaveCount(2)

  // Each agent beats on a clock of its own, so a ring of them never chants. The
  // numbers are a hash of the agent's name — same beat every render, and the
  // same beat in this screenshot.
  const phase = await page
    .locator('.km-live-mark')
    .evaluate(el => getComputedStyle(el).getPropertyValue('--km-phase').trim())
  expect(Number(phase)).toBeGreaterThan(0)
  expect(Number(phase)).toBeLessThan(1)

  // The sleeper says nothing, in the label as well as on the canvas. It is the
  // agent that would be wrongly lit, so it is the one worth naming.
  const asleep = page.getByRole('button', { name: /^SEO Writer/ })
  await expect(asleep).not.toHaveAttribute('data-live', /.*/)
  await expect(asleep).toHaveAttribute('aria-label', /^SEO Writer\. Opens/)
})

/* Artwork is what an app node is *for* — the tile went from a disc to a rounded
   square so a real icon could fill it. Both halves are pinned here, because the
   fallback is the half that rots quietly: an app whose icon row survives its
   icon file draws nothing at all unless the tile notices, and an empty tile is
   worse than the two letters it replaced. `FileIconImage` makes the same
   promise for every HTML surface; this is the SVG one keeping it. */
test('playground/knowledge-map-home draws an app as its artwork, and falls back to initials', async ({
  page,
}) => {
  await page.goto('/playground/knowledge-map-home')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const app = (title: string) =>
    page.locator('.km-n[data-node="app"]').filter({ hasText: title }).first()

  // Metrics ships an icon: the tile is the picture, and no initials are drawn
  // underneath it to show through.
  await expect(app('Metrics').locator('.km-app-art')).toHaveCount(1)
  await expect(app('Metrics').locator('.km-app-mono')).toHaveCount(0)

  // Feeds names an icon the drive cannot serve. The tile has to come back to
  // its initials rather than stay empty.
  await expect(app('Feeds').locator('.km-app-mono')).toHaveText('FS')
  await expect(app('Feeds').locator('.km-app-art')).toHaveCount(0)
})

/* One navigation, one skeleton — see `spa/loading/README.md`.

   A cold load into an agent used to draw the *map* island first: the island
   defaulted its path to `''`, which resolves to the ring, so the reader watched
   a whole drive's worth of skeleton and then had it replaced by the agent's.
   Then the page rendered nothing at all while a bare URL was rewritten to the
   card it opens on. Skeleton, foreign skeleton, blank, content.

   The CPU throttle is what makes this assertable rather than a race: at 1× the
   fixture answers inside a frame or two and every one of those states is real
   but unobservable. Under 8× they are hundreds of milliseconds each, which is
   also what a reader on a slow machine actually gets.

   The recorder is an init script because it has to survive the remount the
   route change causes — a listener installed from the test's own world does
   not. */
test('playground/spa-shell draws one skeleton per navigation, and never somebody else’s', async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) < 640, 'desktop cold-load contract')
  await page.addInitScript(() => {
    const seen: string[] = []
    ;(window as unknown as { __waits: string[] }).__waits = seen
    const tick = () => {
      const island = document.querySelector('[data-bootstrap-island]')
      /* Every page-level wait carries `data-loading-view`, named for the
         destination that owns it — so what the reader is waiting on is read
         off the attribute rather than off a class the next restyle renames. */
      const waitFor = (root: ParentNode) =>
        root.querySelector('[data-loading-view]')?.getAttribute('data-loading-view')
      const here = waitFor(document)
      const surface = document.querySelector('.km-sheet:not([role=status])')
      /* Only what the *reader* is waiting on. Once the page is drawn, a region
         still filling in is not a page-level wait — that distinction is the
         whole point of the rule being tested. */
      const now = island
        ? `island:${waitFor(island) ?? 'other'}`
        : here === 'agent-page'
          ? 'page-skeleton'
          : surface
            ? 'drawn'
            : here
              ? `foreign-page-skeleton:${here}`
              : 'blank'
      if (seen[seen.length - 1] !== now) seen.push(now)
      requestAnimationFrame(tick)
    }
    tick()
  })

  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 8 })

  const coldLoad = async (path: string) => {
    await page.evaluate(() => {
      ;(window as unknown as { __waits: string[] }).__waits.length = 0
    })
    await page
      .getByRole('button', { name: `Browser route: ${path}`, exact: true, includeHidden: true })
      .evaluate((button: HTMLButtonElement) => button.click())
    await expect(page.locator('.km-sheet:not([role=status])')).toBeVisible({ timeout: 30_000 })
    return await page.evaluate(() => (window as unknown as { __waits: string[] }).__waits)
  }

  for (const path of ['/w/acme/agents/research', '/w/acme/agents/root/apps/reporting']) {
    const waits = await coldLoad(path)
    const message = `${path} waited through: ${waits.join(' → ')}`
    // Nobody else's destination, at any point.
    expect(
      waits.filter(wait => wait.startsWith('foreign-page-skeleton')),
      message,
    ).toEqual([])
    // No hole between the skeleton and the page.
    expect(
      waits.filter(wait => wait === 'blank'),
      message,
    ).toEqual([])
    /* And the island is the page's own shape — named, so a wait for somewhere
       else cannot pass as "an island of some kind". Crossing from the streamed
       shell into the route is not a change of picture. */
    expect(
      waits.filter(wait => wait.startsWith('island:') && wait !== 'island:agent-page'),
      message,
    ).toEqual([])
  }

  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
})

/* The canvas is the window, and the roster beside it is not allowed to say
   otherwise.

   The camera centres the map inside the element it is drawn into, so the map is
   only centred on the *screen* while that element is the size of the screen.
   The rail is the one thing on this surface that grows with the drive: one row
   per agent, in a column whose whole height chain is percentages. Percentages
   resolve to `auto` against an auto-sized grid row, so a roster longer than the
   window used to size the row rather than scroll inside it — the canvas
   stretched with it, and the picture was centred in a box hanging off the
   bottom of the screen. Measured at twelve agents on a 900px window: a canvas
   1978px tall and the ring 540px low, with its whole lower half off-screen.

   A short viewport is how the roster is made longer than the window without a
   fixture per fleet size; the fault is the ratio, not the head count. Below
   `sm` the rail is out of flow entirely, so there is nothing there to grow. */
test('playground/spa-shell keeps the canvas the size of the window whatever the roster does', async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) < 640, 'the rail is out of flow below sm')
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      /* The canvas, at its own address. `/w/acme/agents` is the root agent's
         conversation now; the drive's picture of itself is a destination beside
         it. The claim below is unchanged and still the one that matters — a
         roster taller than the window must scroll inside it rather than size
         the row and stretch the canvas past the bottom of the screen. */
      name: 'Browser route: /w/acme/agents/graph',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())

  const width = page.viewportSize()?.width ?? 1440
  const measureAt = async (height: number) => {
    await page.setViewportSize({ width, height })
    await page.waitForSelector('.knowledge-map', { timeout: 30_000 })
    await expect
      .poll(() => page.evaluate(() => document.body.dataset.knowledgeMapSettled))
      .toBe('true')
    /* The settled flag predates a resize, so wait for the camera itself: the
       same picture on two reads in a row. */
    const pictureBox = () =>
      page.evaluate(() => {
        const box = document.querySelector('.km-svg > g')?.getBoundingClientRect()
        return box === undefined ? '' : `${box.y.toFixed(1)}:${box.height.toFixed(1)}`
      })
    let previous = ''
    await expect
      .poll(async () => {
        const current = await pictureBox()
        const steady = current !== '' && current === previous
        previous = current
        return steady
      })
      .toBe(true)
    return page.evaluate(() => {
      const map = document.querySelector('.knowledge-map')
      const drawn = document.querySelector('.km-svg > g')
      if (map === null || drawn === null) return null
      const canvas = map.getBoundingClientRect()
      const picture = drawn.getBoundingClientRect()
      return {
        canvas: canvas.height,
        window: window.innerHeight,
        /* Where the middle of what is drawn sits against the middle of the
           window, as a share of the window. This is the reader's own
           complaint, in one number. */
        off: ((picture.y + picture.bottom) / 2 - window.innerHeight / 2) / window.innerHeight,
      }
    })
  }

  /* The camera frames a fixed point of the drawing, not its bounding box, so
     the picture need not sit dead centre — what it must not do is move with
     the roster. A roster taller than the window that sized the row would push
     the picture down a short window and leave a tall one alone, so the same
     framing at both heights is the claim: the canvas is the window's. */
  const short = await measureAt(360)
  const tall = await measureAt(900)
  expect(short).not.toBeNull()
  expect(tall).not.toBeNull()
  expect(short!.canvas).toBeLessThanOrEqual(short!.window + 1)
  expect(Math.abs(short!.off - tall!.off)).toBeLessThanOrEqual(0.005)
  await page.setViewportSize({ width, height: 360 })

  /* The agent's own page mounts the SAME roster, and that reverses what this
     block used to assert. It pinned `rails === 0` — the column was the canvas's
     alone, so nothing on an agent's page could be sized by how many agents the
     drive has, and the fault above could not reach it.

     It can reach it now, which makes this the more valuable half of the test
     rather than the obsolete one: exactly one column, and the page still does
     not spill past the window however long the list is. That is the same 1978px
     fault from the other side, and the section's explicit grid row is what
     prevents it. */
  await page
    .getByRole('button', {
      name: 'Browser route: /w/acme/agents/research',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  const surface = page.locator('.km-page')
  await expect(surface).toBeVisible()
  const agentPage = await surface.evaluate(element => ({
    spilled: element.getBoundingClientRect().height - window.innerHeight,
    rails: element.closest('main')?.querySelectorAll('aside.km-hues').length ?? -1,
    /* And the column is OUTSIDE `.km-page`, which is the one rule here that
       fails silently. `.km-page` is the `km-frame` container the agent
       surface's phone composition queries at 30rem — nest the roster inside it
       and that query measures roster + sheet, so the phone composition fires at
       the wrong width and nothing raises a thing, because a container query
       that never matches is not an error. Counting rails through
       `closest('main')` above would pass either way, which is exactly why this
       is asked separately. */
    railInsideTheFrame: element.querySelectorAll('aside.km-hues').length,
    /* And exactly one `main` on the page — the landmark the two counts above
       are taken through. `agents-section` owns it; every panel below it — the
       conversation, the drive card, the jobs dialog — is furniture inside it,
       and a panel that draws a `main` of its own costs twice: a screen reader
       is handed several "main"s and has to guess which is the page, and
       `closest('main')` above quietly starts meaning "the nearest panel"
       rather than "the page" for anything mounted inside one. Counted on the
       document rather than on `.km-page`, because a nested `main` above the
       frame is the same fault. */
    pageLandmarks: document.querySelectorAll('main').length,
  }))
  expect(agentPage.rails).toBe(1)
  expect(agentPage.railInsideTheFrame).toBe(0)
  expect(agentPage.pageLandmarks).toBe(1)
  expect(agentPage.spilled).toBeLessThanOrEqual(1)
})

/* The peek, which is the only place on the map that says what a working agent is
   actually doing. Desktop, because it is a hover contract and a phone has no
   pointer to rest — the rim and the pulse are what a touch device gets, and the
   agent's own surface is one tap away. */
test('playground/knowledge-map-home peeks at a working agent without opening it', async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) < 768, 'desktop hover contract')

  await page.goto('/playground/knowledge-map-home')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const peek = page.locator('.km-peek')
  await expect(peek).toHaveCount(0)

  await page.getByRole('button', { name: /^Data Analyst/ }).hover()
  await expect(peek).toBeVisible()
  // What is running, what step it is on, and what is waiting behind it — the
  // three things the card exists to say, none of which the ring can draw.
  await expect(peek).toContainText('Weekly revenue rollup')
  await expect(peek).toContainText('joining orders')
  await expect(peek).toContainText('1 needs you')
  await expect(peek).toHaveScreenshot('knowledge-map-peek.png')

  // Pointing at an agent with nothing in flight closes it rather than swapping
  // its contents, because there is nothing to swap them for.
  await page.getByRole('button', { name: /^SEO Writer/ }).hover()
  await expect(peek).toHaveCount(0)
})

/* The unfolded agent surface, measured rather than looked at.

   Two different things put pixels on this surface and neither is told what the
   other did: the browser lays out the identity block, the row of selectors and
   the two columns, and the map's camera flies the agent's own face into the gap
   the identity block leaves for it. Everything that reconciles the two is
   geometry — see `bodyBox` and `wellFraming` — so the only honest check is to
   measure.

   It has been got wrong three times, and twice by a check that compared the
   face's *centre* with the gap's centre and called it clean. A centre is right
   whenever the aim is right; what shipped was a face whose edges reached out of
   the gap and into the doors beside it, which a centre cannot see. So this
   compares edges, every pair, in both themes, on both drives, at every desktop
   shape the surface claims.

   What is measured is what is *visible*: the strip of app selectors scrolls, so
   a selector past its own scroll port is clipped rather than overlapping, and a
   check that read raw client rects would report a collision the reader cannot
   see while missing the ones they can. */
const SURFACE_SHAPES = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
]

type SurfaceBox = { label: string; x: number; y: number; right: number; bottom: number }

function surfaceCollisions(boxes: SurfaceBox[], where: string): string[] {
  const faults: string[] = []
  for (const [index, one] of boxes.entries()) {
    for (const other of boxes.slice(index + 1)) {
      const overlap = {
        x: Math.min(one.right, other.right) - Math.max(one.x, other.x),
        y: Math.min(one.bottom, other.bottom) - Math.max(one.y, other.y),
      }
      if (overlap.x > 0.5 && overlap.y > 0.5) {
        faults.push(
          `${where}: ${one.label} [${one.x.toFixed(0)}–${one.right.toFixed(0)}] overlaps ${other.label} [${other.x.toFixed(0)}–${other.right.toFixed(0)}] by ${overlap.x.toFixed(0)}×${overlap.y.toFixed(0)}px`,
        )
      }
    }
  }
  return faults
}

/* The two columns have to start together, and "together" is a number: the name
   beside the face and the first selector in the card next door, each measured
   from the top of its own column. They are not built the same way — one is a
   line of type optically centred on a hole the camera flies a face into, the
   other is a chip in a padded header — so they will never be equal to the pixel,
   and asking for that would be pinning an accident of the current type metrics.
   Four is what the eye stops reading as a misalignment.

   The bar is five rather than four because the design sits ON four — the name
   twelve into its column, the chip eight into its own — and the grid's clamped
   column width lands the pair a sixteenth of a pixel past it. A bar set to the
   exact number the design already occupies has no room for sub-pixel layout and
   fails on arithmetic rather than on drift. Real drift moves whole pixels.

   This is the check that was missing while the hole was a share of the surface:
   the two started level on a laptop and thirty-odd pixels apart at 2560, and
   every screenshot taken to verify the surface was taken at one size. */
const COLUMN_START_SKEW_PX = 5

/* One gap, everywhere — see `--km-gap`. The frame on all four sides, the channel
   between the columns, and the step from the agent's cluster down to the
   conversation. Half a pixel for sub-pixel layout, and nothing else: three
   `clamp()`s that nearly agreed is what this replaced, and "nearly" is precisely
   what reads as the panels not lining up. */
const GAP_SKEW_PX = 0.5

for (const drive of ['agent-surface-busy', 'agent-surface-quiet']) {
  for (const theme of ['light', 'dark'] as const) {
    test(`nothing on the ${drive} surface overlaps anything else in ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`/playground/${drive}`)
      await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

      const measure = () =>
        page.evaluate(() => {
          // What the reader can see, not what the layout would have drawn: a
          // strip that scrolls clips its own children.
          const rect = (element: Element) => {
            const box = element.getBoundingClientRect()
            let [x, y, right, bottom] = [box.x, box.y, box.right, box.bottom]
            for (
              let clip: Element | null = element.parentElement;
              clip !== null;
              clip = clip.parentElement
            ) {
              const style = getComputedStyle(clip)
              const port = clip.getBoundingClientRect()
              if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
                x = Math.max(x, port.x)
                right = Math.min(right, port.right)
              }
              if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
                y = Math.max(y, port.y)
                bottom = Math.min(bottom, port.bottom)
              }
            }
            return { x, y, right: Math.max(x, right), bottom: Math.max(y, bottom) }
          }
          const named = (selector: string, label: string) =>
            [...document.querySelectorAll(selector)].map((element, index) => ({
              label: `${label}${index > 0 ? ` ${index + 1}` : ''}`,
              ...rect(element),
            }))
          const focused = document.querySelector('.km-n.km-on')
          // The plate, and only the plate. This used to also take the badge the
          // face wore; an agent's work is drawn as its own nodes now, so there
          // is no badge and that selector was quietly matching nothing.
          //
          // The flare does not replace it. It is the one thing that still
          // reaches past the tile, but it is mid-animation whenever this runs,
          // so its client rect is a function of the animation's phase — a
          // deterministic screenshot test cannot measure it. The reserve it
          // needs is asserted exactly instead, against `FLARE_REACH`, in
          // `well.test.ts`. Captions stay out for the older reason: they are
          // painted with a halo and `bodyBox` reserves ink, not words.
          const face = [focused?.querySelector('.km-agent-disc')].flatMap(element =>
            element ? [rect(element)] : [],
          )
          const hole = document.querySelector('.km-face')
          const sheet = document.querySelector('.km-sheet')
          const canvas = document.querySelector('.km-svg')
          const left = document.querySelector('.km-sheet-left')
          const card = document.querySelector('.km-card')
          const name = document.querySelector('.km-name')
          const selector = document.querySelector('.km-picker .km-pick')
          const well = document.querySelector('.km-well')
          const chat = document.querySelector('.km-chat')
          // Where each column's first line of ink starts, measured from the top
          // of that column rather than from the page: the columns are siblings
          // in one grid row, so the comparison is only meaningful relative to
          // their own tops.
          const starts =
            left && card && name && selector
              ? {
                  name: rect(name).y - rect(left).y,
                  selector: rect(selector).y - rect(card).y,
                }
              : null
          // Every gap the surface draws, as one list. `--km-gap` claims they are
          // all the same number.
          //
          // The frame is measured against the *window*, not against the map. A
          // reader sees one band of air between the panels and the edge of the
          // screen, and every box between the two contributes to it — the map
          // fills its host, and the host is free to inset it. Measured against
          // the map, a page that puts `px-4 py-6` around the whole surface is
          // invisible: the gaps inside stay identical and perfectly equal while
          // what is actually on screen is sixteen pixels of air on one side and
          // twenty-four on another. That is the exact defect this assertion
          // exists for, and it is the one it could not see.
          const win = {
            w: document.documentElement.clientWidth,
            h: document.documentElement.clientHeight,
          }
          const gaps =
            left && card && well && chat
              ? {
                  frameTop: rect(left).y,
                  frameLeft: rect(left).x,
                  frameRight: win.w - rect(card).right,
                  frameBottom: win.h - rect(card).bottom,
                  betweenColumns: rect(card).x - rect(left).right,
                  wellToChat: rect(chat).y - rect(well).bottom,
                }
              : null
          return {
            starts,
            gaps,
            row: [
              ...named('.km-leave', 'way out'),
              ...named('.km-name', 'name'),
              ...named('.km-well-acts .km-act', 'door'),
              ...(face.length > 0
                ? [
                    {
                      label: 'face',
                      x: Math.min(...face.map(part => part.x)),
                      y: Math.min(...face.map(part => part.y)),
                      right: Math.max(...face.map(part => part.right)),
                      bottom: Math.max(...face.map(part => part.bottom)),
                    },
                  ]
                : []),
            ],
            picker: [...named('.km-pick', 'selector'), ...named('.km-open-app', 'open on its own')],
            columns: [...named('.km-sheet-left', 'left column'), ...named('.km-card', 'the card')],
            panels: [...named('.km-well', 'well'), ...named('.km-chat', 'chat')],
            hole: hole === null ? null : { label: 'hole', ...rect(hole) },
            sheet: sheet === null ? null : { label: 'sheet', ...rect(sheet) },
            canvasTop: canvas === null ? null : canvas.getBoundingClientRect().y,
            scrollsSideways: document.documentElement.scrollWidth > window.innerWidth,
          }
        })

      for (const size of SURFACE_SHAPES) {
        await page.setViewportSize(size)
        /* Two gates, and both earn their place.

           First the camera says it has parked. Agreement alone cannot tell
           "settled" from "has not started": the re-aim reaches the camera a
           render after the layout, so two readings taken inside that window
           certify the previous viewport's framing and report it as geometry —
           a face overlapping a name by 26px, on a different shape each run.

           Then readings still have to agree, because parked is not drawn: the
           loop writes transforms and the DOM beside them settles after it. The
           camera gate alone was measured at two failures, then none, then four
           across three runs; with both, four runs clean. */
        await page
          .waitForFunction(() => document.body.dataset.knowledgeMapSettled === 'false', undefined, {
            timeout: 2_000,
          })
          // A shape the camera is already aimed at never unsettles, and then
          // there is no departure to wait for — only the arrival below.
          .catch(() => undefined)
        await page.waitForFunction(
          () => document.body.dataset.knowledgeMapSettled === 'true',
          undefined,
          { timeout: 10_000 },
        )
        let previous = ''
        let agreed = 0
        await expect
          .poll(
            async () => {
              const now = JSON.stringify((await measure()).row)
              agreed = now === previous ? agreed + 1 : 0
              previous = now
              return agreed >= 2
            },
            { timeout: 10_000, intervals: [150] },
          )
          .toBe(true)

        const shot = await measure()
        const where = `${drive} ${theme} ${size.width}×${size.height}`
        expect(
          shot.row.length,
          `${where}: the identity row must have a face and its doors`,
        ).toBeGreaterThan(3)
        expect(
          shot.picker.length,
          `${where}: the card must have a row of selectors`,
        ).toBeGreaterThan(1)

        expect(
          [
            ...surfaceCollisions(shot.row, `${where} identity row`),
            ...surfaceCollisions(shot.picker, `${where} selector row`),
            ...surfaceCollisions(shot.columns, `${where} columns`),
            ...surfaceCollisions(shot.panels, `${where} left column`),
          ],
          `${where}: nothing on this surface may overlap anything beside it`,
        ).toEqual([])

        // Both columns inside the sheet, and the sheet inside the window.
        for (const column of shot.columns) {
          expect(
            column.x >= shot.sheet!.x - 0.5 && column.right <= shot.sheet!.right + 0.5,
            `${where}: ${column.label} [${column.x.toFixed(0)}–${column.right.toFixed(0)}] must stay inside the sheet [${shot.sheet!.x.toFixed(0)}–${shot.sheet!.right.toFixed(0)}]`,
          ).toBe(true)
        }
        expect(shot.scrollsSideways, `${where}: the surface must not scroll sideways`).toBe(false)

        // The two columns begin together. Not a pixel apart at one window size
        // and half an inch apart at another: this is the assertion, and the only
        // one, that the reader's eye was making unaided.
        expect(
          Math.abs(shot.starts!.name - shot.starts!.selector),
          `${where}: the agent's name starts ${shot.starts!.name.toFixed(0)}px into its column and the card's first selector starts ${shot.starts!.selector.toFixed(0)}px into its own — the two columns must begin together`,
        ).toBeLessThanOrEqual(COLUMN_START_SKEW_PX)

        // And every gap on the surface is the same gap.
        const gaps = Object.entries(shot.gaps!)
        const widest = Math.max(...gaps.map(([, value]) => value))
        const narrowest = Math.min(...gaps.map(([, value]) => value))
        expect(
          widest - narrowest,
          `${where}: the surface's gaps must all be one number, and these are ${gaps.map(([name, value]) => `${name} ${value.toFixed(1)}`).join(', ')}`,
        ).toBeLessThanOrEqual(GAP_SKEW_PX)
      }
    })
  }
}

/* ---- the conversation keeps its half of the column ----
   The agent surface's left column is the one host where the conversation is a
   *panel* rather than a page, and a panel is short. Everything above measures
   the surface with a stand-in in that column (`FixtureChat` — four bubbles and
   a div shaped like a composer), so nothing yet has measured the thing the
   product actually mounts there. This does, through `spa-shell`, which is the
   one fixture that runs the real `SessionsProduct` in the real surface.

   The rule it holds is the one a reader would state: **the composer never takes
   more than half the conversation, however much has been typed into it.** The
   thread is the subject of that column and the composer is the tool for it, so
   the tool does not get to evict the subject — which is exactly what an
   uncapped compose bar does, because the thread is `flex-1` off a zero basis
   and therefore absorbs none of the squeeze until it has already reached zero.

   Short viewports only, because that is the only place the rule can bind: on a
   laptop the compose bar wants a fifth of the column and this never fires. */
const CONVERSATION_SHAPES = [
  { width: 1280, height: 640 },
  { width: 1024, height: 560 },
  { width: 900, height: 500 },
] as const

/* A draft far longer than any host could seat, so the compose bar is asking for
   every pixel it can get. Sixty lines rather than a paragraph: the point is to
   pin what happens at the cap, not near it. */
const OVERLONG_DRAFT = Array.from(
  { length: 60 },
  (_, index) => `line ${index + 1}: the quick brown fox jumps over the lazy dog`,
).join('\n')

test('the agent surface keeps the conversation while a long draft is composed', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('[data-compose-bar-editor]', { timeout: 30_000 })

  for (const size of CONVERSATION_SHAPES) {
    await page.setViewportSize(size)
    /* Typed through the editor rather than set as a value: the compose bar is a
       ProseMirror document, and its height is a function of what it laid out.
       Focused in the page rather than clicked: a filled draft is taller than
       the row that scrolls it, so the centre of its box — which is what a click
       aims at — is not a point on screen. */
    await page.evaluate(text => {
      const editor = document.querySelector<HTMLElement>('[data-compose-bar-editor]')!
      editor.focus()
      const selection = window.getSelection()!
      selection.selectAllChildren(editor)
      document.execCommand('insertText', false, text)
    }, OVERLONG_DRAFT)

    const where = `${size.width}\u00d7${size.height}`
    /* Read once the layout has stopped moving: the editor grows over a couple
       of frames as ProseMirror lays the document out, and a reading taken
       inside that window certifies a composer that had not finished asking. */
    const shapeOf = () =>
      page.evaluate(() => {
        const chat = document.querySelector('.km-chat')!
        const conversation = chat.querySelector('[data-session-conversation]')!
        const thread = chat.querySelector<HTMLElement>('[data-virtualized-session-timeline]')!
        const send = chat.querySelector<HTMLElement>('button[type="submit"]')!
        const area = conversation.getBoundingClientRect().height
        return {
          threadShare: Math.round((thread.clientHeight / area) * 100),
          // The invariant the composer already owned, kept honest while the new
          // one lands: the send row never paints under the panel floor.
          sendBelowPanel: Math.round(
            send.getBoundingClientRect().bottom - chat.getBoundingClientRect().bottom,
          ),
        }
      })
    let previous = ''
    await expect
      .poll(
        async () => {
          const now = JSON.stringify(await shapeOf())
          const settled = now === previous
          previous = now
          return settled
        },
        { timeout: 10_000, intervals: [150] },
      )
      .toBe(true)
    const shape = await shapeOf()

    expect(
      shape.threadShare,
      `${where}: a long draft left the conversation ${shape.threadShare}% of its own column — the compose bar may take half, and no more`,
    ).toBeGreaterThanOrEqual(45)
    expect(
      shape.sendBelowPanel,
      `${where}: the send control painted ${shape.sendBelowPanel}px below the panel floor`,
    ).toBeLessThanOrEqual(0)
  }
})

/* ---- and the same rule is what gives a long draft its room ----
   The half is a ceiling in both directions, which is the point of stating it as
   a share: a draft nobody could seat reaches it on any window, instead of
   stopping at a constant that was only ever right for one of them. Measured
   before this held, a sixty-line draft was shown eight lines at a time on a
   1440-tall window with a thousand pixels of empty thread above it — the same
   160px that was starving the short panels.

   Two windows an order of magnitude apart in spare room, and one number for
   both. That is the assertion: not how tall the compose bar is, which is type
   metrics, but that its ceiling is a share of its host. */
test('a draft too long to seat fills the same half of any window', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('[data-compose-bar-editor]', { timeout: 30_000 })

  for (const size of [
    { width: 1280, height: 720 },
    { width: 2560, height: 1440 },
  ] as const) {
    await page.setViewportSize(size)
    await page.evaluate(text => {
      const editor = document.querySelector<HTMLElement>('[data-compose-bar-editor]')!
      editor.focus()
      window.getSelection()!.selectAllChildren(editor)
      document.execCommand('insertText', false, text)
    }, OVERLONG_DRAFT)

    const shareOf = () =>
      page.evaluate(() => {
        const chat = document.querySelector('.km-chat')!
        const conversation = chat.querySelector('[data-session-conversation]')!
        const composer = chat.querySelector<HTMLElement>('footer')!
        return Math.round(
          (composer.getBoundingClientRect().height / conversation.getBoundingClientRect().height) *
            100,
        )
      })
    let previous = -1
    await expect
      .poll(
        async () => {
          const now = await shareOf()
          const settled = now === previous
          previous = now
          return settled
        },
        { timeout: 10_000, intervals: [150] },
      )
      .toBe(true)

    const share = await shareOf()
    expect(
      share,
      `${size.width}\u00d7${size.height}: a draft this long should reach the compose bar's ceiling, and it stopped at ${share}% of the conversation`,
    ).toBeGreaterThanOrEqual(47)
  }
})

/* ---- the running-turn tray is docked to the compose bar, not floating over it ----
   While a turn is in flight the compose bar grows a tray above itself — who is
   working, and the control that stops them. It is drawn as a tab sliding out
   from behind the bar: rounded at the top, open at the bottom, sharing the
   bar's own top border.

   Which only reads as one object if the two line up. The tray was inset a flat
   16px per side, a number written against the full-page conversation, where the
   bar is 896px wide and 16px is under two per cent of it. The agent surface's
   column is half that, the same 16px is seven per cent, and what was a docked
   tab becomes a narrower card floating slightly off-centre above a wider one —
   in a column where the thread, the compose bar and the panel edge all agree to
   the pixel. So the inset is measured here rather than eyeballed at one width. */
test('the running-turn tray lines up with the compose bar under it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('[data-compose-bar-editor]', { timeout: 30_000 })

  await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>('[data-compose-bar-editor]')!
    editor.focus()
    document.execCommand('insertText', false, 'start something')
  })
  await page.keyboard.press('Enter')
  const tray = page.locator('.km-chat [data-compose-bar-session]')
  await expect(tray).toBeVisible({ timeout: 15_000 })

  const edges = await page.evaluate(() => {
    const chat = document.querySelector('.km-chat')!
    const box = (selector: string) => {
      const rect = chat.querySelector(selector)!.getBoundingClientRect()
      return { left: rect.left, right: rect.right }
    }
    return { tray: box('[data-compose-bar-session]'), bar: box('form') }
  })

  expect(
    [
      Math.round(Math.abs(edges.tray.left - edges.bar.left)),
      Math.round(Math.abs(edges.tray.right - edges.bar.right)),
    ],
    `the tray must sit on the compose bar's own edges, and it is inset ${Math.round(edges.tray.left - edges.bar.left)}px on the left and ${Math.round(edges.bar.right - edges.tray.right)}px on the right`,
  ).toEqual([0, 0])
})

/* The jobs dialog's own states, driven the way `share-dialog`'s matrix is: the
   registry entry above gives the automatic desktop/mobile pair of the frame, and
   these reach the three states a static render cannot — the read still out, the
   read failed, and an agent that has never been put to work. */
/* An agent that cannot be used yet. The value of the shot is what is NOT in it:
   no conversation beside the setup, no row of views above it, no jobs door in
   the cluster — the surface is one column, and every one of those absences is a
   deliberate withholding rather than an empty pane. */
test('playground/agent-surface-setup gives the whole surface to the setup', async ({ page }) => {
  await page.goto('/playground/agent-surface-setup')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await expect(page.getByRole('button', { name: 'Start setup' })).toBeVisible()
  /* The agent's own cluster, saying what this is. Positive, and before the
     shot: what is under it is an ordinary session or an ordinary app, so a
     header that quietly went back to its working dress would leave three
     screenshots that each look like a perfectly good product surface. */
  await expect(page.locator('.km-well')).toContainText('Onboarding')
  // The two panes a locked agent cannot fill, asserted as absent rather than
  // left to the pixels: a screenshot cannot tell "withheld" from "empty".
  await expect(page.getByRole('tablist', { name: 'Views' })).toHaveCount(0)
  await expect(page.locator('.km-chat')).toHaveCount(0)
  await expect(page).toHaveScreenshot('agent-surface-setup.png', { fullPage: true })
})

/* Where a reader actually spends the minutes: the control has been pressed and
   a cold workspace machine is waking up behind it. The state has no control of
   its own, so its whole job is telling the truth about the wait — which is why
   it is photographed rather than left to the one that has a button in it. */
test('playground/agent-surface-setup-waiting says what the wait is for', async ({ page }) => {
  await page.goto('/playground/agent-surface-setup-waiting')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await expect(page.locator('.km-well')).toContainText('Onboarding')
  // The control is the same call already in flight, so it is not offered twice.
  await expect(page.getByRole('button', { name: 'Start setup' })).toHaveCount(0)
  await expect(page.getByText("We're setting up your new agent", { exact: true })).toBeVisible()
  await expect(page.getByRole('progressbar', { name: 'Agent setup progress' })).toBeVisible()
  await expect(page).toHaveScreenshot('agent-surface-setup-waiting.png', { fullPage: true })
})

/* The frame's failure modes are geometric — a clipped top, a collapsed height,
   a scroll that never reaches the bottom — and none of them can fail a
   screenshot of a stand-in panel, because a panel is a div. These mount the
   REAL iframe on the map compositions and measure it. A clipped onboarding
   page shipped to prod with every gate green because nothing did. */
for (const [fixture, description] of [
  ['agent-surface-app-frame', 'an app on the ordinary two-column card'],
  ['agent-surface-setup-app', 'an onboarding app taking the whole locked surface'],
] as const) {
  test(`playground/${fixture} frames ${description} unclipped`, async ({ page }) => {
    /* The two-column card is a composition wide surfaces have. Below the
       sheet's own frame query a phone shows one pane at a time and opens on the
       conversation, so the card holding this frame is deliberately not drawn —
       `mobile-composition.spec.ts` is what asserts that, and asserting the
       opposite here would make the two suites disagree about the same rule. */
    test.skip((page.viewportSize()?.width ?? 0) < 768)
    await page.goto(`/playground/${fixture}`)
    await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

    const iframe = page.locator('.km-stage [data-app-frame] > iframe')
    await expect(iframe).toBeVisible()

    /* The frame fills the stage it was given. A collapsed frame still
       screenshots as pleasant whitespace; the ratio is what says the height
       rules survived. */
    const [frameBox, cardBox, sheetBox] = [
      await iframe.boundingBox(),
      await page.locator('.km-card').boundingBox(),
      await page.locator('.km-sheet').boundingBox(),
    ]
    if (frameBox === null || cardBox === null || sheetBox === null) {
      throw new Error('frame, card, or sheet did not lay out')
    }
    /* Against the SHEET as well as the card. Measuring only against the card
       once passed with a 150px frame, because the collapsed frame had pulled
       the card down to its own height — both boxes shrank together and the
       ratio held. The sheet is sized by the surface, not by its content, so
       it is the yardstick that cannot collapse with the thing it measures. */
    expect(cardBox.height).toBeGreaterThan(sheetBox.height * 0.6)
    expect(frameBox.height).toBeGreaterThan(cardBox.height * 0.7)

    /* The document's own top edge is visible INSIDE the frame: the fixture
       page puts its hero flush at the top precisely so a clipped top has
       something to cut. */
    const hero = page.frameLocator('.km-stage [data-app-frame] > iframe').locator('h1')
    await expect(hero).toBeVisible()
    const heroBox = await hero.boundingBox()
    if (heroBox === null) throw new Error('framed hero did not lay out')
    expect(heroBox.y).toBeGreaterThanOrEqual(frameBox.y)

    /* Screenshot at the frame's own resting scroll — the shot must not depend
       on how far the probe below happened to scroll. */
    await expect(page).toHaveScreenshot(`${fixture}.png`, { fullPage: true })

    /* And the bottom is reachable: the end marker scrolls into view within
       the frame, which fails when the frame's height is right but its
       scrolling is not. After the shot, so the scroll cannot smear it. */
    const end = page
      .frameLocator('.km-stage [data-app-frame] > iframe')
      .locator('[data-fixture-page-end]')
    await end.scrollIntoViewIfNeeded()
    await expect(end).toBeVisible()

    /* What shows through an app that has not painted yet follows the drive's
       theme. An empty iframe is transparent, so the frame's own surface is what
       a reader looks at for the whole of an opening — and it was nailed to
       white, which is the whole of what a dark drive saw. Read as two colours
       rather than one literal: the tokens are free to move, a surface that
       cannot tell the themes apart is the bug. */
    const surface = page.locator('.km-stage [data-app-frame]')
    const surfaceIn = async () =>
      surface.evaluate(element => getComputedStyle(element).backgroundColor)
    const light = await surfaceIn()
    await page.evaluate(() => document.documentElement.classList.add('dark'))
    expect(await surfaceIn()).not.toBe(light)
    await page.evaluate(() => document.documentElement.classList.remove('dark'))
  })
}

/* The first second of every app, which no shot of a loaded frame contains: the
   shape drawn under a frame that has not painted anything over it yet. In both
   themes, because the state this replaces was a white rectangle that looked
   deliberate in one of them. */
test('playground/agent-surface-app-loading stands a themed shape in for the app', async ({
  page,
}) => {
  /* The placeholder stands in the card, and on a phone the card is the pane the
     reader has not chosen — see the sibling frame test above. */
  test.skip((page.viewportSize()?.width ?? 0) < 768)
  await page.goto('/playground/agent-surface-app-loading')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const placeholder = page.locator('[data-app-frame-placeholder]')
  await expect(placeholder).toBeVisible()
  const surfaceIn = async () =>
    placeholder.evaluate(element => getComputedStyle(element).backgroundColor)

  const light = await surfaceIn()
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  expect(await surfaceIn()).not.toBe(light)
  await expect(page).toHaveScreenshot('agent-surface-app-loading-dark.png', { fullPage: true })
  await page.evaluate(() => document.documentElement.classList.remove('dark'))
})

/* And the other end of it, on the one fixture that mounts a frame the way the
   product does — through the client SPA, so the app's `load` is what takes the
   placeholder away. Its own test because no screenshot can tell a placeholder
   that left from one still sitting behind an opaque page, and because the
   canvas a loaded app is given is the white one it was written for. */
test('playground/sessions-desktop-pane hands the frame over when the app loads', async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024)
  await page.goto('/playground/sessions-desktop-pane')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  /* The desktop pane, not the mobile viewer: this surface keeps both in the
     DOM at every width and hides one of them, so an unscoped frame locator
     matches twice. */
  const frame = page.locator('[data-session-app-pane] [data-app-frame] > iframe')
  await expect(frame).toBeVisible()
  await expect(page.locator('[data-app-frame-placeholder]')).toHaveCount(0)
  expect(await frame.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(
    'rgb(255, 255, 255)',
  )
})

test('playground/agent-surface-setup-chat gives the conversation the whole surface', async ({
  page,
}) => {
  await page.goto('/playground/agent-surface-setup-chat')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  // One column: the setup conversation is the card, and the ordinary chat
  // panel is withheld beside it — there must be exactly one conversation.
  await expect(page.locator('.km-chat')).toHaveCount(0)
  await expect(page.getByRole('tablist', { name: 'Views' })).toHaveCount(0)
  /* Framed, which is the whole difference between this and any other thread —
     the conversation itself is the product's own, compose bar and all. */
  await expect(page.locator('.km-well')).toContainText('Onboarding')
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
  await expect(page).toHaveScreenshot('agent-surface-setup-chat.png', { fullPage: true })
})

test('playground/low-credit-gate blocks workspace use and presents every recovery state', async ({
  page,
}, testInfo) => {
  await page.goto('/playground/low-credit-gate')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  const gate = page.locator('[data-low-credit-gate]')
  const scenario = async (value: string) => {
    await page
      .locator(`[data-low-credit-scenario="${value}"]`)
      .evaluate((button: HTMLButtonElement) => button.click())
  }

  await expect(gate).toHaveAttribute('data-low-credit-gate', 'subscribe')
  await expect(page.getByRole('radio', { name: /Pro/ })).toBeFocused()
  await expect(page).toHaveScreenshot('low-credit-gate-subscribe.png', { fullPage: true })
  await page.keyboard.press('Escape')
  await expect(gate).toBeVisible()
  await page.locator('[data-low-credit-backdrop]').click({ position: { x: 2, y: 2 } })
  await expect(gate).toBeVisible()
  await page.getByRole('radio', { name: /Starter/ }).click()
  await page.getByRole('button', { name: 'Subscribe and continue' }).click()
  await expect(page.locator('[data-low-credit-action]')).toHaveText('subscribe:starter')

  await scenario('topup')
  await expect(gate).toHaveAttribute('data-low-credit-gate', 'topup')
  await expect(page.getByRole('radio', { name: '$50 Paid reserve', exact: true })).toBeFocused()
  await expect(page).toHaveScreenshot('low-credit-gate-topup.png', { fullPage: true })
  for (const amount of [20, 50, 100]) {
    await page.getByRole('radio', { name: `$${amount} Paid reserve`, exact: true }).click()
    await page.getByRole('button', { name: 'Add credits' }).click()
    await expect(page.locator('[data-low-credit-action]')).toHaveText(`topup:${amount * 1_000_000}`)
  }

  await scenario('member')
  await expect(gate).toHaveAttribute('data-low-credit-gate', 'member')
  await expect(gate.getByRole('button')).toHaveCount(0)
  const memberNotice = gate.locator('[tabindex="0"]')
  await expect(memberNotice).toContainText('Waiting for the workspace owner')
  await expect(memberNotice).toBeFocused()
  await expect(page).toHaveScreenshot('low-credit-gate-member.png', { fullPage: true })

  if (testInfo.project.name === 'mobile') {
    await scenario('subscribe-pending')
    await expect(page.getByRole('button', { name: 'Opening secure checkout…' })).toBeDisabled()
    await expect(gate).toBeFocused()
    await expect(page).toHaveScreenshot('low-credit-gate-subscribe-pending.png', { fullPage: true })
    await scenario('topup-pending')
    await expect(page.getByRole('button', { name: 'Opening secure checkout…' })).toBeDisabled()
    await expect(page).toHaveScreenshot('low-credit-gate-topup-pending.png', { fullPage: true })
    await scenario('error')
    await expect(gate.getByRole('alert')).toHaveText('Checkout could not open. Try again.')
    const retry = page.getByRole('button', { name: 'Subscribe and continue' })
    await expect(retry).toBeEnabled()
    await retry.click()
    await expect(page.locator('[data-low-credit-action]')).toHaveText('subscribe:pro')
    await expect(page).toHaveScreenshot('low-credit-gate-error.png', { fullPage: true })
  }
})

test('playground/team-space-chat exposes recent jobs and preserves parent context', async ({
  page,
}, testInfo) => {
  await page.goto('/playground/team-space-chat')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await expect(page.getByText('With Milo', { exact: true })).toHaveCount(0)

  /* Showing on arrival where it is a column beside the conversation, and only
     there: below `lg` the same flag drives a sheet over the conversation, and a
     sheet that opens itself covers up the thing the reader came for. */
  const onMobile = testInfo.project.name === 'mobile'
  const rail = onMobile
    ? page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Recent jobs' }) })
    : page.getByRole('complementary', { name: 'Recent jobs' })
  await expect(rail).toHaveCount(onMobile ? 0 : 1)
  if (onMobile) await page.getByRole('button', { name: 'Recent jobs', exact: true }).click()
  await expect(rail).toBeVisible()
  /* Every conversation this one spawned, not only the ones running a machine.
     `Draft the handover notes` is the fixture's ordinary delegated child; its
     two siblings both carry a machine, so it is the only row here that can tell
     the two rules apart. */
  await expect(rail.getByRole('button', { name: /Draft the handover notes/ })).toBeVisible()
  await expect(rail).toHaveScreenshot('team-space-recent-jobs.png')

  await rail.getByRole('button', { name: /Wait for the nightly export/ }).click()
  await expect(page.getByRole('heading', { name: 'Wait for the nightly export' })).toBeVisible()
  await expect(page.getByText('Job from Prepare the launch readiness report')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Recent jobs', exact: true })).toHaveCount(0)
  await expect(page).toHaveScreenshot('team-space-job.png', { fullPage: true })
})

test('playground/team-space job lineage returns to its parent in Work', async ({
  page,
}, testInfo) => {
  await page.goto('/playground/team-space-chat')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const onMobile = testInfo.project.name === 'mobile'
  const jobs = onMobile
    ? page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Recent jobs' }) })
    : page.getByRole('complementary', { name: 'Recent jobs' })
  if (onMobile) await page.getByRole('button', { name: 'Recent jobs', exact: true }).click()
  await jobs.getByRole('button', { name: /Wait for the nightly export/ }).click()
  const lineage = page.getByRole('link', {
    name: 'started by Prepare the launch readiness report',
  })
  await expect(lineage).toHaveAttribute('href', '/w/acme/agents/root/sessions/session_live')
  await lineage.click()

  /* A button, not a heading: a top-level conversation's title is the control
     that renames it, which moved onto this header when Build's jobs dialog was
     deleted. The child it came from keeps a plain heading — its name belongs to
     the run that spawned it. */
  await expect(
    page.getByRole('button', { name: 'Prepare the launch readiness report', exact: true }).first(),
  ).toBeVisible()
  await expect(page.locator('[data-team-space="work"]')).toBeVisible()
})

test('playground/team-space-chat gives a new running timeline one quiet starting cue', async ({
  page,
}, testInfo) => {
  await page.goto('/playground/team-space-chat')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  if (testInfo.project.name === 'mobile') {
    await page.getByRole('button', { name: 'Back to Home' }).click()
    await page.getByRole('button', { name: 'Chats', exact: true }).click()
  }
  await page.locator('[data-work-conversation="session_running"]:visible').click()
  await expect(page.getByRole('region', { name: 'Milo is working' })).toBeVisible()
  await expect(page.getByText('Waiting for Duet', { exact: true })).toHaveCount(0)
  await expect(
    page.getByText('The session has started. Live work will appear here.', { exact: true }),
  ).toHaveCount(0)
  const timeline = page.getByLabel('Session timeline')
  await expect(timeline.getByText('Starting…', { exact: true })).toBeVisible()
  await expect(timeline.locator('[data-session-starting]')).toHaveCount(1)
})

test('playground/team-space-chat keeps the composer centered within the conversation', async ({
  page,
}) => {
  await page.goto('/playground/team-space-chat')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const footerBox = await page.locator('[data-session-composer-footer]').boundingBox()
  const composerBox = await page
    .locator('[data-session-composer-footer] [data-compose-bar-root]')
    .boundingBox()
  expect(footerBox).not.toBeNull()
  expect(composerBox).not.toBeNull()
  if (footerBox === null || composerBox === null) return

  expect(
    Math.abs(footerBox.x + footerBox.width / 2 - (composerBox.x + composerBox.width / 2)),
  ).toBeLessThanOrEqual(1)
  if ((page.viewportSize()?.width ?? 0) >= 1024) {
    expect(composerBox.width).toBeLessThanOrEqual(768)
  }
})

test('playground/team-space-chat commits a send to the timeline and chat list immediately', async ({
  page,
}, testInfo) => {
  await page.goto('/playground/team-space-chat')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const conversations = page.locator('[data-work-conversation]')
  await expect(conversations.first()).toHaveAttribute('data-work-conversation', 'session_live')
  await openWorkConversation(page, testInfo, 'session_running')
  await expect(page.getByRole('heading', { name: 'Audit production API latency' })).toBeVisible()

  const composer = page.getByLabel('Message Milo')
  await composer.fill('Prepare the production handoff.')
  await composer.press('Enter')

  await expect(
    page
      .getByLabel('Session timeline')
      .getByText('Prepare the production handoff.', { exact: true }),
  ).toHaveCount(1, { timeout: 250 })
  await expect(page.getByText('Sending…', { exact: true })).toHaveCount(1)
  await expect(conversations.first()).toHaveAttribute('data-work-conversation', 'session_running', {
    timeout: 250,
  })
  await expectEditableText(composer, '')
})

test('playground/team-space-chat keeps an unresolved send committed across navigation', async ({
  page,
}, testInfo) => {
  await page.goto('/playground/team-space-chat')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const conversations = page.locator('[data-work-conversation]')
  await openWorkConversation(page, testInfo, 'session_running')
  const composer = page.getByLabel('Message Milo')
  await composer.fill('Keep this handoff while I check another chat.')
  await composer.press('Enter')

  /* This send never resolves, so the row can only rise on the optimistic
     commit — the wait proves that whatever its length. It is a second rather
     than a quarter of one because the pinned visual container runs slower than
     a laptop, and a quarter-second there failed the same way with no change to
     the code. */
  await expect(conversations.first()).toHaveAttribute('data-work-conversation', 'session_running', {
    timeout: 1_000,
  })
  await openWorkConversation(page, testInfo, 'session_live')
  await expect(
    page.getByRole('heading', { name: 'Prepare the launch readiness report' }).first(),
  ).toBeVisible()
  await expect(conversations.first()).toHaveAttribute('data-work-conversation', 'session_running')

  await openWorkConversation(page, testInfo, 'session_running')
  await expect(
    page
      .getByLabel('Session timeline')
      .getByText('Keep this handoff while I check another chat.', { exact: true }),
  ).toHaveCount(1)
  await expect(page.getByText('Sending…', { exact: true })).toHaveCount(1)
})

test('playground/team-space-chat keeps a pending send visible in a populated timeline', async ({
  page,
}) => {
  await page.goto('/playground/team-space-chat')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const timeline = page.getByLabel('Session timeline')
  const composer = page.getByLabel('Message Milo')
  await composer.fill('Prepare the production handoff.')
  await composer.press('Enter')

  const pendingRow = timeline
    .getByText('Prepare the production handoff.', { exact: true })
    .locator('xpath=ancestor::*[@data-message-role][1]')
  await expect(pendingRow).toBeVisible({ timeout: 250 })
  await expect
    .poll(async () => {
      const [timelineBox, pendingBox] = await Promise.all([
        timeline.boundingBox(),
        pendingRow.boundingBox(),
      ])
      if (timelineBox === null || pendingBox === null) return false
      return (
        pendingBox.y >= timelineBox.y &&
        pendingBox.y + pendingBox.height <= timelineBox.y + timelineBox.height
      )
    })
    .toBe(true)
})

test('playground/team-space-chat never restores an excerpt after showing the generated title', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page
    .getByRole('button', { name: 'Scenario: team-space-chat-generated-title', exact: true })
    .evaluate(element => (element as HTMLButtonElement).click())

  const generatedTitle = 'Launch readiness overview'
  const staleExcerpt = 'Build a launch readiness report from the staging checks'
  const sidebarRow = page.locator('[data-work-conversation="session_live"]').first()
  await expect(sidebarRow).toHaveText(generatedTitle)
  await sidebarRow.evaluate(element => {
    const record = () => {
      const title = element.textContent?.trim()
      if (title === undefined) return
      const observed = JSON.parse(
        document.documentElement.dataset.observedSidebarTitles ?? '[]',
      ) as string[]
      if (observed.at(-1) !== title) observed.push(title)
      document.documentElement.dataset.observedSidebarTitles = JSON.stringify(observed)
    }
    record()
    new MutationObserver(record).observe(element, {
      characterData: true,
      childList: true,
      subtree: true,
    })
  })

  const prompt = 'Turn the findings into an owner-ready update'
  const composer = page.getByLabel('Message Milo')
  await composer.fill(prompt)
  await composer.press('Enter')
  await expect(page.getByLabel('Session timeline').getByText(prompt, { exact: true })).toBeVisible({
    timeout: 250,
  })

  const observedTitles = JSON.parse(
    (await page.locator('html').getAttribute('data-observed-sidebar-titles')) ?? '[]',
  ) as string[]
  expect(observedTitles).toEqual([generatedTitle])
  expect(observedTitles).not.toContain(staleExcerpt)

  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await page.getByRole('button', { name: 'Back to Home' }).click()
    await page.getByRole('button', { name: 'Chats', exact: true }).click()
    await expect(
      page.getByRole('dialog', { name: 'Chats' }).getByText(generatedTitle),
    ).toBeVisible()
  } else {
    await expect(sidebarRow).toBeVisible()
    await expect(sidebarRow).toHaveText(generatedTitle)
  }
})

test('playground/team-space-chat insets the live session panel inside the composer', async ({
  page,
}) => {
  await page.goto('/playground/team-space-chat')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const composerBox = await page
    .locator('[data-session-composer-footer] [data-compose-bar-root]')
    .boundingBox()
  const sessionBox = await page
    .locator('[data-session-composer-footer] [data-compose-bar-session]')
    .boundingBox()
  expect(composerBox).not.toBeNull()
  expect(sessionBox).not.toBeNull()
  if (composerBox === null || sessionBox === null) return

  const leftInset = sessionBox.x - composerBox.x
  const rightInset = composerBox.x + composerBox.width - (sessionBox.x + sessionBox.width)
  expect(leftInset).toBeGreaterThanOrEqual(12)
  expect(Math.abs(leftInset - rightInset)).toBeLessThanOrEqual(1)
})

test('playground/team-space-home starts an ordinary Duet session with a specific audience', async ({
  page,
}) => {
  await page.goto('/playground/team-space-home')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page.getByRole('radio', { name: 'Specific people' }).click()
  await page.getByRole('button', { name: /Choose people · 1/ }).click()
  const picker = page.locator('[data-session-audience-popover]')
  await picker.getByRole('option', { name: /Grace Hopper/ }).click()
  await picker.getByPlaceholder('Search people').press('Escape')
  await page.getByLabel('Describe a task for Milo…').fill('Prepare a team launch brief')
  await page.getByRole('button', { name: 'Send', exact: true }).click()

  const payload = await sessionInputPayload(page)
  expect(payload.kind).toBe('create')
  expect(payload.input).toMatchObject({
    prompt: 'Prepare a team launch brief',
    audience: {
      kind: 'specific',
      memberUserIds: ['user_grace'],
    },
  })
  await expect(page.getByRole('heading', { name: 'Prepare a team launch brief' })).toBeVisible()
  await expect(page.getByText('With Milo', { exact: true })).toHaveCount(0)
})

test('playground/team-space-home starts a personal Duet session without additional people', async ({
  page,
}) => {
  await page.goto('/playground/team-space-home')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const audience = page.getByRole('radiogroup', { name: 'Audience' })
  await expect(audience.getByRole('radio')).toHaveCount(3)
  await audience.getByRole('radio', { name: 'Just me & Milo' }).click()
  await page.getByLabel('Describe a task for Milo…').fill('Draft my private launch notes')
  await page.getByRole('button', { name: 'Send', exact: true }).click()

  const payload = await sessionInputPayload(page)
  expect(payload.kind).toBe('create')
  expect(payload.input).toMatchObject({
    prompt: 'Draft my private launch notes',
    audience: {
      kind: 'specific',
      memberUserIds: [],
    },
  })
})

test('playground/team-space-home seats a new conversation in Chats before it has an id', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page
    .getByRole('button', { name: 'Scenario: team-space-home-awaiting-id', exact: true })
    .evaluate(element => (element as HTMLButtonElement).click())

  const prompt = 'Prepare the investor update while the session starts'
  await page.getByLabel('Describe a task for Milo…').fill(prompt)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('heading', { name: prompt })).toBeVisible()

  const onMobile = (page.viewportSize()?.width ?? 0) < 1024
  if (onMobile) {
    await page.getByRole('button', { name: 'Chats', exact: true }).click()
  }
  const workNavigation = onMobile
    ? page.getByRole('dialog', { name: 'Chats' })
    : page.getByRole('navigation', { name: 'Work' })
  await expect(workNavigation.getByText(prompt, { exact: true }).first()).toBeVisible({
    timeout: 250,
  })
  await expect(workNavigation.getByLabel('Sending…').first()).toBeVisible()
})

test('playground/team-space-home seats an agent-owned create under that agent immediately', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page
    .getByRole('button', { name: 'Scenario: team-space-home-awaiting-id', exact: true })
    .evaluate(element => (element as HTMLButtonElement).click())

  const agentPicker = page.getByRole('button', { name: 'Start with Milo' })
  await agentPicker.click()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')

  const prompt = 'Research the expansion market while the session starts'
  await page.getByLabel('Describe a task for Milo…').fill(prompt)
  await page.getByRole('button', { name: 'Send', exact: true }).click()

  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await page.getByRole('button', { name: 'Chats', exact: true }).click()
  }
  const research = page.locator('[data-work-agent-conversations="research"]:visible')
  await expect(research.getByText(prompt, { exact: true })).toBeVisible({ timeout: 250 })
  await expect(research.getByLabel('Sending…')).toBeVisible()
})

test('playground/team-space-home keeps the created row while its collection is stale', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page
    .getByRole('button', { name: 'Scenario: team-space-home-created-list-stale', exact: true })
    .evaluate(element => (element as HTMLButtonElement).click())
  await expect(page.locator('[data-work-conversation="session_live"]').first()).toBeAttached()

  const prompt = 'Keep the launch brief seated through collection refresh'
  await page.getByLabel('Describe a task for Milo…').fill(prompt)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('heading', { name: prompt })).toBeVisible()

  const onMobile = (page.viewportSize()?.width ?? 0) < 1024
  if (onMobile) {
    await page.getByRole('button', { name: 'Back to Home' }).click()
    await page.getByRole('button', { name: 'Chats', exact: true }).click()
  }
  const workNavigation = onMobile
    ? page.getByRole('dialog', { name: 'Chats' })
    : page.getByRole('navigation', { name: 'Work' })
  const createdRow = workNavigation.getByText(prompt, { exact: true }).first()
  await expect(createdRow).toBeVisible()
  await page.waitForTimeout(500)
  await expect(createdRow).toBeVisible()
  await expect(workNavigation.getByLabel('Sending…')).toHaveCount(0)
})

test('playground/team-space-home starts a top-level conversation with the selected agent', async ({
  page,
}) => {
  await page.goto('/playground/team-space-home')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const agentPicker = page.getByRole('button', { name: 'Start with Milo' })
  const send = page.getByRole('button', { name: 'Send', exact: true })
  await expect(agentPicker.locator('svg')).toHaveCount(0)
  const [agentPickerBox, sendBox] = await Promise.all([
    agentPicker.boundingBox(),
    send.boundingBox(),
  ])
  expect(agentPickerBox).not.toBeNull()
  expect(sendBox).not.toBeNull()
  if (agentPickerBox !== null && sendBox !== null) {
    expect(
      Math.abs(agentPickerBox.y + agentPickerBox.height / 2 - (sendBox.y + sendBox.height / 2)),
    ).toBeLessThanOrEqual(1)
    expect(sendBox.x - (agentPickerBox.x + agentPickerBox.width)).toBeGreaterThanOrEqual(0)
    expect(sendBox.x - (agentPickerBox.x + agentPickerBox.width)).toBeLessThanOrEqual(8)
  }

  await agentPicker.click()
  await expect(page.getByRole('option', { name: 'Milo' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('option', { name: 'Research' })).toBeFocused()
  await page.keyboard.press('Enter')
  await page.getByLabel('Describe a task for Research…').fill('Map the competitive landscape')
  await page.getByRole('button', { name: 'Send', exact: true }).click()

  const payload = await sessionInputPayload(page)
  expect(payload.kind).toBe('create')
  expect(payload.input).toMatchObject({
    prompt: 'Map the competitive landscape',
    cwd: 'agents/research',
  })
  await expect(page.getByRole('heading', { name: 'Map the competitive landscape' })).toBeVisible()
})

test('playground/team-space-home preselects an agent from its sidebar action', async ({ page }) => {
  await page.goto('/playground/team-space-home')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await page.getByRole('button', { name: 'Chats', exact: true }).click()
  }
  const research = page.locator('[data-work-agent-conversations="research"]:visible')
  await research.locator('button[aria-expanded]').hover()
  const newConversation = research.getByRole('button', {
    name: 'New conversation with Research',
  })
  await expect(newConversation).toBeVisible()
  await expect(newConversation).toHaveCSS('opacity', '1')
  await newConversation.click()

  await expect(page.getByRole('button', { name: 'Start with Research' })).toBeVisible()
  await expect(page.getByTestId('session-input-payload')).toHaveText('No session input')
})

test('playground/team-space-home shows only agents with conversations under Other chats', async ({
  page,
}) => {
  await page.goto('/playground/team-space-home')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await page.getByRole('button', { name: 'Chats', exact: true }).click()
  }

  const visibleOtherChats = page.locator('[data-work-other-chats]:visible')
  await expect(visibleOtherChats.getByText('Other chats', { exact: true })).toBeVisible()
  await expect(page.locator('[data-work-agent-conversations="research"]:visible')).toBeVisible()
  await expect(page.locator('[data-work-agent-conversations="reviewer"]')).toHaveCount(0)
})

/* The sidebar's whole job in this section is comparing what several owners are
   doing, and it used to hold one group at a time: opening the second shut the
   first. The fixture behind this scenario moves one conversation to a second
   owner so there are two groups to hold. */
test('playground/team-space-home-two-owners holds several agent groups open at once', async ({
  page,
}) => {
  await page.goto('/playground/team-space-home-two-owners')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await page.getByRole('button', { name: 'Chats', exact: true }).click()
  }

  const research = page.locator('[data-work-agent-conversations="research"]:visible')
  const reviewer = page.locator('[data-work-agent-conversations="reviewer"]:visible')
  const toggle = (group: typeof research) => group.locator('button[aria-expanded]').first()
  await expect(toggle(research)).toBeVisible()
  await expect(toggle(reviewer)).toBeVisible()

  // Open each in turn; the first must still be open once the second is.
  if ((await toggle(research).getAttribute('aria-expanded')) === 'false') {
    await toggle(research).click()
  }
  await expect(toggle(research)).toHaveAttribute('aria-expanded', 'true')
  await toggle(reviewer).click()
  await expect(toggle(reviewer)).toHaveAttribute('aria-expanded', 'true')
  await expect(toggle(research)).toHaveAttribute('aria-expanded', 'true')

  // And closing one closes only itself.
  await toggle(research).click()
  await expect(toggle(research)).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle(reviewer)).toHaveAttribute('aria-expanded', 'true')
})

/* A collapsed group is the only place an owner's unread work can be said at
   all, and activity already knows: it answers for every owner in one poll
   whether the group is open or not. Research keeps an unread conversation in
   this fixture and Reviewer's row is read, so one group is marked and the other
   is not — which is the comparison a single marked group cannot make. */
test('playground/team-space-home-two-owners marks only the collapsed owner with unread work', async ({
  page,
}) => {
  await page.goto('/playground/team-space-home-two-owners')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await page.getByRole('button', { name: 'Chats', exact: true }).click()
  }

  const research = page.locator('[data-work-agent-conversations="research"]:visible')
  const reviewer = page.locator('[data-work-agent-conversations="reviewer"]:visible')
  const researchToggle = research.locator('button[aria-expanded]').first()
  if ((await researchToggle.getAttribute('aria-expanded')) === 'true') {
    await researchToggle.click()
  }
  await expect(researchToggle).toHaveAttribute('aria-expanded', 'false')

  /* Scoped to the owner's own row, not the group: the conversations inside a
     group carry their own unread marks, and those are the ones the reader is
     meant to see once it is open. */
  const reviewerToggle = reviewer.locator('button[aria-expanded]').first()
  await expect(researchToggle.getByText('Unread', { exact: true })).toBeAttached()
  await expect(reviewerToggle.getByText('Unread', { exact: true })).toHaveCount(0)

  // Opening it hands the telling over to the rows, which carry their own.
  await researchToggle.click()
  await expect(researchToggle.getByText('Unread', { exact: true })).toHaveCount(0)
})

/* Deleting a conversation from Work: where the reader lands, and what they are
   told. Landing was already right — the header's exit is Home for a top-level
   conversation — but a destructive action that removes the thing you were
   reading and then says nothing leaves the reader to infer from an empty Home
   whether it worked. The confirmation is the other half of the same action. */
test('playground/spa-shell says what happened when a Work conversation is deleted', async ({
  page,
}) => {
  await openProductRoute(page, '/w/acme/agents/root/sessions/session_live')
  await page.getByRole('button', { name: 'Session actions' }).click()
  await page.getByRole('menuitem', { name: /Delete/ }).click()

  const dialog = page.getByRole('alertdialog')
  // The reader is asked about a conversation, which is what the product calls
  // this everywhere else; "session" is the wire's word, not theirs.
  await expect(dialog).toContainText('Delete this conversation?')
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()

  await expect
    .poll(() => page.evaluate(() => `${window.location.pathname}${window.location.search}`))
    .toBe('/w/acme/home')
  await expect(page.getByRole('status').filter({ hasText: 'Conversation deleted' })).toBeVisible()
})

/* The app dock lives in the desktop rail — `hidden … lg:flex` — and the mobile
   sheet carries chats alone, so its scroll affordances are a desktop contract
   with nothing to assert below `lg`. */
test('playground/team-space-home keeps app edges clear and reveals each scroll direction', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'the app dock is the desktop rail')
  await page.goto('/playground/spa-shell')
  await page
    .getByRole('button', { name: 'Scenario: team-space-home-overflow-apps', exact: true })
    .evaluate(element => (element as HTMLButtonElement).click())

  const dock = page.getByRole('region', { name: 'Apps' })
  await expect(dock).toBeVisible()
  const scroller = dock.locator('[data-work-app-scroller]')
  const startFade = dock.locator('[data-work-app-scroll-fade="start"]')
  const endFade = dock.locator('[data-work-app-scroll-fade="end"]')

  const initial = await scroller.evaluate(element => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  expect(initial.scrollWidth).toBeGreaterThan(initial.clientWidth)
  await expect(startFade).toHaveAttribute('data-visible', 'false')
  await expect(endFade).toHaveAttribute('data-visible', 'true')
  await expect(startFade).toHaveCSS('opacity', '0')
  await expect(endFade).toHaveCSS('opacity', '1')

  const [scrollerBox, firstAppBox] = await Promise.all([
    scroller.boundingBox(),
    dock.getByRole('button').first().boundingBox(),
  ])
  expect(scrollerBox).not.toBeNull()
  expect(firstAppBox).not.toBeNull()
  if (scrollerBox !== null && firstAppBox !== null) {
    expect(firstAppBox.x - scrollerBox.x).toBeGreaterThanOrEqual(3)
  }

  await scroller.evaluate(element => element.scrollTo({ left: element.scrollWidth }))
  await expect(startFade).toHaveAttribute('data-visible', 'true')
  await expect(endFade).toHaveAttribute('data-visible', 'false')
  await expect(startFade).toHaveCSS('opacity', '1')
  await expect(endFade).toHaveCSS('opacity', '0')

  const [scrolledBox, lastAppBox] = await Promise.all([
    scroller.boundingBox(),
    dock.getByRole('button').last().boundingBox(),
  ])
  expect(scrolledBox).not.toBeNull()
  expect(lastAppBox).not.toBeNull()
  if (scrolledBox !== null && lastAppBox !== null) {
    expect(
      scrolledBox.x + scrolledBox.width - (lastAppBox.x + lastAppBox.width),
    ).toBeGreaterThanOrEqual(3)
  }
})

test('playground/team-space-home leaves a fitted app row unfaded', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'the app dock is the desktop rail')
  await page.goto('/playground/team-space-home')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const dock = page.getByRole('region', { name: 'Apps' })
  const scroller = dock.locator('[data-work-app-scroller]')
  const dimensions = await scroller.evaluate(element => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth)
  await expect(dock.locator('[data-work-app-scroll-fade="start"]')).toHaveCSS('opacity', '0')
  await expect(dock.locator('[data-work-app-scroll-fade="end"]')).toHaveCSS('opacity', '0')
})

test('playground/team-space-home keeps Chats and removes Other chats when every list is empty', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page
    .getByRole('button', { name: 'Scenario: team-space-home-empty-chats', exact: true })
    .evaluate(element => (element as HTMLButtonElement).click())

  const onMobile = (page.viewportSize()?.width ?? 0) < 1024
  if (onMobile) await page.getByRole('button', { name: 'Chats', exact: true }).click()
  const workNavigation = onMobile
    ? page.getByRole('dialog', { name: 'Chats' })
    : page.locator('nav[aria-label="Work"]:visible')

  await expect(workNavigation.getByText('Chats', { exact: true })).toBeVisible()
  await expect(workNavigation.getByRole('button', { name: 'New chat', exact: true })).toBeVisible()
  await expect(page.locator('[data-work-other-chats]')).toHaveCount(0)
  await expect(page.locator('[data-work-agent-conversations]')).toHaveCount(0)
})

test('playground/team-space-home owns one Invite action across tablet orientations', async ({
  page,
}) => {
  for (const viewport of [
    { width: 820, height: 1180 },
    { width: 1180, height: 820 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto('/playground/team-space-home')
    await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

    const invite = page
      .locator('[data-team-space="work"] button')
      .filter({ hasText: /^\s*Invite\s*$/ })
    await expect(invite).toHaveCount(1)
    await expect(invite).toBeVisible()
    if (viewport.width < 1024) {
      const box = await invite.boundingBox()
      expect(box).not.toBeNull()
      if (box !== null) expect(box.height).toBeGreaterThanOrEqual(44)
    }
  }
})

test('playground/team-space-home omits the apps section when the workspace has no apps', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page
    .getByRole('button', { name: 'Scenario: team-space-home-empty-apps' })
    .evaluate(element => (element as HTMLButtonElement).click())

  await expect(page.getByRole('heading', { name: 'Good morning, Ada' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Apps in this workspace' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open Build' })).toHaveCount(0)

  const [canvasBox, starterBox] = await Promise.all([
    page.locator('[data-team-space="work"] main').boundingBox(),
    page.locator('[data-work-session-starter]').boundingBox(),
  ])
  expect(canvasBox).not.toBeNull()
  expect(starterBox).not.toBeNull()
  if (canvasBox === null || starterBox === null) return

  const canvasCenter = canvasBox.y + canvasBox.height / 2
  const starterCenter = starterBox.y + starterBox.height / 2
  expect(Math.abs(canvasCenter - starterCenter)).toBeLessThanOrEqual(48)
})

for (const entry of PLAYGROUND_ENTRIES) {
  test(`playground/${entry.id}`, async ({ page }, testInfo) => {
    if (entry.id === 'session-inline-media' || entry.id === 'attachment-cards')
      await routeSessionInlineMediaAssets(page)
    await page.goto(`/playground/${entry.id}`)
    await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
    const iframes = page.locator('iframe')
    for (let index = 0; index < (await iframes.count()); index += 1) {
      const iframe = iframes.nth(index)
      /* Warm up what the capture will actually contain. The desktop app pane
         keeps its iframe in the DOM at every width and hides it with `hidden
         lg:flex`, so at mobile widths it is a `display: none` element with a
         zero box. Scrolling that into view waits on an actionability that can
         never arrive, and the whole test dies on the 120s timeout for an
         iframe that draws nothing.

         The count is also read once, and a fixture can drop an iframe while
         the page settles, so a disappearance is forgiven too. Anything still
         attached and visible when the wait gives up is a fixture that never
         settles, and that failure is the point — bounded so it says so in
         seconds rather than minutes. */
      if (!(await iframe.isVisible().catch(() => false))) continue
      try {
        await iframe.scrollIntoViewIfNeeded({ timeout: 15_000 })
        await iframe.contentFrame().locator('body').waitFor({ state: 'visible', timeout: 15_000 })
      } catch (error) {
        if ((await iframe.count()) > 0) throw error
      }
    }
    // Full-page capture resets the document, not FilesSurface's nested scroll owner.
    if (
      entry.id === 'files' ||
      entry.id === 'share-dialog' ||
      entry.id === 'spa-shell-file-pagination'
    )
      await settleInitialFilesView(page)
    if (entry.id === 'spa-shell-file-pagination') {
      await expect(page.getByText('Projects', { exact: true })).toBeVisible()
      await expect(page.getByText('Shared', { exact: true })).toBeVisible()
    }
    // Before the deliberate scrolls below, not after. Warming up an iframe above
    // scrolls whatever owns it, and on a surface that scrolls inside its own
    // containers `window.scrollTo` cannot undo that — the residue rides into the
    // capture as a whole-content shift of a few pixels.
    if (entry.id === 'session-chat') {
      await page.evaluate(() => window.scrollTo(0, 0))
      const timeline = page.locator('[data-virtualized-session-timeline]')
      await timeline.evaluate(element =>
        element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }),
      )
      await expect
        .poll(() =>
          timeline.evaluate(element =>
            Math.round(element.scrollHeight - element.scrollTop - element.clientHeight),
          ),
        )
        .toBeLessThan(4)
    } else await resetScroll(page)
    if (entry.id === 'settings-usage-tier-badges') {
      await page.locator('[data-usage-tier]').first().scrollIntoViewIfNeeded()
    }
    // The Connected-apps card sits below the API-keys section inside the
    // settings surface's nested scroll owner; bring the review target into
    // frame so the shot captures the card, not the page header.
    await page.evaluate(() => {
      document.querySelectorAll('nextjs-portal').forEach(element => element.remove())
    })
    if (entry.id.startsWith('workspace-backups-')) {
      const card = page.locator('[data-backups-card]')
      await expect(card.getByText('Loading backups…')).toHaveCount(0)
      await card.scrollIntoViewIfNeeded()
      await expect(card).toHaveScreenshot(`${entry.id}.png`, { timeout: 15_000 })
      return
    }
    if (entry.id.startsWith('settings-default-tier-')) {
      const card = page.locator('[data-default-tier-card]')
      await card.scrollIntoViewIfNeeded()
      await expect(card).toHaveScreenshot(`${entry.id}.png`, { timeout: 15_000 })
      return
    }
    // The Connected-apps card lives inside the settings surface's fixed-height
    // nested scroll owner, which a full-page capture can't grow past. Shoot the
    // card element itself — the coverage target is ConnectedAppsCard, not the
    // whole settings shell.
    if (entry.id === 'oauth-grants-settings') {
      const card = page.locator('[data-fixture-id="oauth-grants-settings"]')
      await card.scrollIntoViewIfNeeded()
      await expect(card).toHaveScreenshot(`${entry.id}.png`, { timeout: 15_000 })
      return
    }
    if (entry.id === 'agent-detail') {
      const appsCard = page.getByRole('heading', { name: 'Apps', exact: true }).locator('..')
      await expect(appsCard.getByRole('button', { name: 'Load more', exact: true })).toBeVisible()
    }
    if (entry.id === 'files-seen-by-incomplete') {
      const lowerBound = page.getByTitle('At least 1 more person has seen this file')
      const seenBy = page.getByRole('region', { name: 'Seen by' })
      await expect(seenBy.getByText('Seen by', { exact: true })).toBeVisible()
      await expect(lowerBound).toHaveText('At least 1 more')
      await expect(lowerBound).toBeVisible()
      await expect(page.getByRole('button', { name: 'History' })).toBeInViewport({ ratio: 1 })
      await expect(page.getByRole('link', { name: 'Download' })).toBeInViewport({ ratio: 1 })
    }
    if (entry.id === 'spa-shell-train-pagination-empty' && testInfo.project.name === 'mobile') {
      // Train scrolls inside the workspace shell, so a full-page document shot
      // cannot reveal cards below the mobile viewport. Move that real scroll
      // owner to the changed state and keep the ordinary desktop overview.
      const loadMore = page.getByRole('button', { name: 'Load more', exact: true }).last()
      await loadMore.scrollIntoViewIfNeeded()
      await expect(page.getByText('No training jobs loaded yet', { exact: true })).toBeInViewport()
      await expect(loadMore).toBeInViewport()
      await expect(page).toHaveScreenshot(`${entry.id}.png`, { timeout: 15_000 })
      return
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `${entry.id} must not overflow horizontally`,
    ).toBe(true)
    await expect(page).toHaveScreenshot(`${entry.id}.png`, { fullPage: true, timeout: 15_000 })
  })
}

test('playground/marketplace returns a collision to editable naming before retrying', async ({
  page,
}) => {
  await page.goto('/playground/marketplace')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'State: uninstalled', exact: true })
    .evaluate((button: HTMLButtonElement) => button.click())

  const detail = page.locator('[data-marketplace-detail]')
  const install = detail.getByTestId('marketplace-install')
  await install.click()

  /* Naming comes first, for every publisher. The field starts empty with the
     listing's slug as a placeholder: offered, not demanded.

     These steps were added with the name dialog and then lost in one of
     staging's own merges, which left this test asserting a collision dialog it
     could never reach — the name dialog intercepts the click. Restored rather
     than worked around: without them the request below cannot carry a name. */
  const nameDialog = page.getByTestId('marketplace-install-name')
  const nameField = nameDialog.getByLabel('Name')
  await expect(nameDialog).toBeVisible()
  await expect(nameField).toHaveValue('')
  await expect(nameField).toHaveAttribute('placeholder', 'research')
  await nameField.fill('Mary')
  await nameDialog.getByTestId('marketplace-install-name-confirm').click()
  await expect(nameField).toHaveValue('Mary 2')
  await expect(nameDialog.getByTestId('marketplace-install-path-preview')).toContainText(
    'agents/mary-2',
  )
  await expect(page.getByLabel('New folder path')).toHaveCount(0)
  await expect(nameDialog).toHaveScreenshot('marketplace-install-collision-naming.png')
  await expect(page.getByTestId('marketplace-last-request')).toHaveText(
    JSON.stringify({ action: 'install', input: { listingId: 'listing-research', name: 'Mary' } }),
  )
  await nameDialog.getByTestId('marketplace-install-name-confirm').click()

  await expect(nameDialog).toBeHidden()
  await expect(install).toBeEnabled()
  await expect(install).toHaveText('Add another')
  await expect(page.getByTestId('marketplace-last-request')).toHaveText(
    JSON.stringify({
      action: 'install',
      // A LISTING, not a bare name: two publishers may ship `research`. And the
      // name the user typed, not the listing title the collision form rebuilt
      // its request from — losing it here would install under the wrong name
      // and say nothing.
      input: { listingId: 'listing-research', name: 'Mary 2', path: 'agents/mary-2' },
    }),
  )
})

test('playground/attachment-cards keeps mixed and maximum batches navigable', async ({ page }) => {
  await routeSessionInlineMediaAssets(page)
  await page.goto('/playground/attachment-cards')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const conversation = page.getByRole('log', { name: 'Attachment card conversation' })
  const attachmentCards = conversation.locator('[data-message-attachment-card]')
  await expect(attachmentCards).toHaveCount(12)
  expect(
    await attachmentCards.evaluateAll(cards =>
      cards.every(card => card instanceof HTMLButtonElement),
    ),
  ).toBe(true)
  await expect(conversation.getByRole('button', { name: 'release-brief.pdf' })).toBeVisible()
  await expect(conversation.getByText('Channel', { exact: true }).first()).toBeVisible()
})

test('playground/session files open a PDF in the app and return focus on close', async ({
  page,
  context,
}) => {
  await routeSessionInlineMediaAssets(page)
  await page.goto('/playground/attachment-cards')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const opener = page.getByRole('button', { name: 'release-brief.pdf' })
  const route = page.url()
  const pageCount = context.pages().length
  await opener.click()

  const viewer = page.getByRole('dialog', { name: 'release-brief.pdf' })
  await expect(viewer).toBeVisible()
  const pdfFrame = viewer.locator('iframe[title="release-brief.pdf"]')
  await expect(pdfFrame).toBeVisible()
  await expect(pdfFrame).toHaveAttribute('src', '/playground/session-files/release-brief.pdf')
  const pdf = await page.request.get('/playground/session-files/release-brief.pdf')
  expect(pdf.ok()).toBe(true)
  expect(pdf.headers()['content-type']).toContain('application/pdf')
  const pdfBytes = await pdf.body()
  expect(pdfBytes.byteLength).toBeGreaterThan(1_000)
  expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-')
  expect(page.url()).toBe(route)
  expect(context.pages()).toHaveLength(pageCount)
  const [pdfBodyBox, pdfFrameBox] = await Promise.all([
    viewer.locator('[data-files-preview-body]').boundingBox(),
    pdfFrame.boundingBox(),
  ])
  expect(pdfBodyBox).not.toBeNull()
  expect(pdfFrameBox).not.toBeNull()
  expect(Math.abs(pdfFrameBox!.height - pdfBodyBox!.height)).toBeLessThanOrEqual(2)

  await viewer.getByRole('button', { name: 'Close preview' }).click()
  await expect(viewer).toBeHidden()
  await expect(opener).toBeFocused()

  await opener.click()
  await expect(viewer).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(viewer).toBeHidden()
  await expect(opener).toBeFocused()
})

test('playground/session document viewer stays read-only and free of Drive attribution', async ({
  page,
}) => {
  await routeSessionInlineMediaAssets(page)
  await page.goto('/playground/attachment-cards')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page.getByRole('button', { name: 'launch-plan.md' }).click()
  const viewer = page.getByRole('dialog', { name: 'launch-plan.md' })
  await expect(viewer.getByText('Preview fixture for launch-plan.md')).toBeVisible()
  await expect(viewer.getByRole('textbox')).toHaveCount(0)
  await expect(viewer.getByRole('button', { name: 'Edit' })).toHaveCount(0)
  await expect(viewer.locator('[data-files-seen-by], [data-files-history]')).toHaveCount(0)
  await expect(viewer.getByRole('link', { name: 'Download' })).toBeVisible()
})

test('playground/session Markdown file cards use the same in-app viewer', async ({ page }) => {
  await routeSessionInlineMediaAssets(page)
  await page.goto('/playground/session-inline-media')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page.getByRole('button', { name: 'Release brief' }).click({ timeout: 5_000 })
  const viewer = page.getByRole('dialog', { name: 'release.pdf' })
  await expect(viewer.locator('iframe[title="release.pdf"]')).toBeVisible()
  await expect(viewer.getByRole('link', { name: 'Download' })).toHaveAttribute(
    'download',
    'release.pdf',
  )
})

test('playground/session viewer gives audio and spreadsheets native in-app tools', async ({
  page,
}) => {
  await routeSessionInlineMediaAssets(page)
  await page.goto('/playground/attachment-cards')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page.getByRole('button', { name: 'launch-theme.mp3' }).click()
  const audioViewer = page.getByRole('dialog', { name: 'launch-theme.mp3' })
  await expect(audioViewer.getByRole('button', { name: 'Play' })).toBeVisible()
  const seek = audioViewer.getByRole('slider', { name: 'Seek audio' })
  await expect(seek).toBeVisible()
  await audioViewer.getByRole('button', { name: 'Play' }).click()
  await expect.poll(async () => Number(await seek.inputValue())).toBeGreaterThan(0)
  const pause = audioViewer.getByRole('button', { name: 'Pause' })
  if (await pause.isVisible()) await pause.click()
  await seek.press('Home')
  await expect(seek).toHaveValue('0')
  await seek.evaluate(element => (element as HTMLInputElement).blur())
  await expect(audioViewer).toHaveScreenshot('session-file-viewer-audio-light.png')
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await expect(audioViewer).toHaveScreenshot('session-file-viewer-audio-dark.png')
  await page.evaluate(() => document.documentElement.classList.remove('dark'))
  const audioStage = audioViewer
    .getByRole('button', { name: 'Play' })
    .locator('..')
    .locator('..')
    .locator('..')
  const [audioBodyBox, audioStageBox] = await Promise.all([
    audioViewer.locator('[data-files-preview-body]').boundingBox(),
    audioStage.boundingBox(),
  ])
  expect(audioBodyBox).not.toBeNull()
  expect(audioStageBox).not.toBeNull()
  expect(Math.abs(audioStageBox!.height - audioBodyBox!.height)).toBeLessThanOrEqual(2)
  await audioViewer.getByRole('button', { name: 'Close preview' }).click()

  await page.getByRole('button', { name: 'launch-plan.xlsx' }).click()
  const sheetViewer = page.getByRole('dialog', { name: 'launch-plan.xlsx' })
  await expect(sheetViewer.getByRole('cell', { name: 'API docs', exact: true })).toBeVisible()
  await expect(sheetViewer.getByRole('cell', { name: 'Ready', exact: true })).toBeVisible()
  await expect(sheetViewer.getByRole('tab', { name: 'Launch plan' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(sheetViewer.getByRole('columnheader', { name: 'A' })).toBeVisible()
  await expect(sheetViewer.getByRole('rowheader', { name: '1' })).toBeVisible()
  const longCell = sheetViewer.getByRole('cell', {
    name: 'A deliberately long handoff note that remains readable instead of disappearing into an ellipsis.',
  })
  await expect(longCell).toBeVisible()
  const [viewerBox, cellBox] = await Promise.all([
    sheetViewer.boundingBox(),
    longCell.boundingBox(),
  ])
  expect(cellBox!.x + cellBox!.width).toBeLessThanOrEqual(viewerBox!.x + viewerBox!.width + 1)
  const compactHeight = cellBox!.height
  const longValue = longCell.locator('[tabindex="0"]')
  await longValue.focus()
  if (page.viewportSize()!.width < 640)
    await expect
      .poll(async () => (await longCell.boundingBox())!.height)
      .toBeGreaterThan(compactHeight)
  await longValue.evaluate(element => (element as HTMLElement).blur())
  await sheetViewer.getByRole('tab', { name: 'Launch plan' }).press('ArrowRight')
  await expect(sheetViewer.getByRole('tab', { name: 'Channels' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  if (page.viewportSize()!.width < 640)
    await expect(sheetViewer.locator('[data-spreadsheet-overflow="right"]')).toBeVisible()
  await sheetViewer.getByRole('tab', { name: 'Channels' }).press('Home')
  const launchPlanTab = sheetViewer.getByRole('tab', { name: 'Launch plan' })
  await expect(launchPlanTab).toHaveAttribute('aria-selected', 'true')
  await launchPlanTab.evaluate(element => (element as HTMLElement).blur())
  const [sheetBodyBox, sheetPanelBox] = await Promise.all([
    sheetViewer.locator('[data-files-preview-body]').boundingBox(),
    sheetViewer.getByRole('tabpanel').boundingBox(),
  ])
  expect(sheetBodyBox).not.toBeNull()
  expect(sheetPanelBox).not.toBeNull()
  expect(
    Math.abs(sheetPanelBox!.y + sheetPanelBox!.height - (sheetBodyBox!.y + sheetBodyBox!.height)),
  ).toBeLessThanOrEqual(2)
  await expect(sheetViewer).toHaveScreenshot('session-file-viewer-spreadsheet-light.png')
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await expect(sheetViewer).toHaveScreenshot('session-file-viewer-spreadsheet-dark.png')
})

test('playground/session image viewer uses the full preview canvas', async ({ page }) => {
  await routeSessionInlineMediaAssets(page)
  await page.goto('/playground/attachment-cards')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page.getByRole('button', { name: 'panorama.png' }).click()
  const viewer = page.getByRole('dialog', { name: 'panorama.png' })
  const image = viewer.getByRole('img', { name: 'panorama.png' })
  await expect(image).toBeVisible()
  const stage = image.locator('..').locator('..')
  const [bodyBox, stageBox] = await Promise.all([
    viewer.locator('[data-files-preview-body]').boundingBox(),
    stage.boundingBox(),
  ])
  expect(bodyBox).not.toBeNull()
  expect(stageBox).not.toBeNull()
  expect(Math.abs(stageBox!.height - bodyBox!.height)).toBeLessThanOrEqual(2)
})

test('playground/session video viewer uses the full preview canvas', async ({ page }) => {
  await routeSessionInlineMediaAssets(page)
  await page.goto('/playground/attachment-cards')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page.getByRole('button', { name: 'demo.webm' }).click()
  const viewer = page.getByRole('dialog', { name: 'demo.webm' })
  const video = viewer.locator('video')
  await expect(video).toBeVisible()
  const [bodyBox, stageBox] = await Promise.all([
    viewer.locator('[data-files-preview-body]').boundingBox(),
    video.locator('..').boundingBox(),
  ])
  expect(bodyBox).not.toBeNull()
  expect(stageBox).not.toBeNull()
  expect(Math.abs(stageBox!.height - bodyBox!.height)).toBeLessThanOrEqual(2)
})

test('playground/session presentation viewer can zoom fitted slides', async ({ page }) => {
  await routeSessionInlineMediaAssets(page)
  await page.goto('/playground/attachment-cards')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page.getByRole('button', { name: 'launch-deck.pptx' }).click()
  const viewer = page.getByRole('dialog', { name: 'launch-deck.pptx' })
  const canvas = viewer.locator('canvas')
  await expect(canvas).toBeVisible({ timeout: 15_000 })
  const fitBox = await canvas.boundingBox()
  expect(fitBox).not.toBeNull()
  await viewer.getByRole('button', { name: 'Zoom in' }).click()
  await expect(viewer.getByText('125%', { exact: true })).toBeVisible()
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThan(fitBox!.width)
  if (page.viewportSize()!.width < 640) {
    await viewer.getByRole('button', { name: 'Zoom in' }).click({ clickCount: 3 })
    await expect(viewer.getByText('200%', { exact: true })).toBeVisible()
    const [zoomedBox, previewBodyBox] = await Promise.all([
      canvas.boundingBox(),
      viewer.locator('[data-files-preview-body]').boundingBox(),
    ])
    expect(zoomedBox).not.toBeNull()
    expect(previewBodyBox).not.toBeNull()
    expect(zoomedBox!.x).toBeGreaterThanOrEqual(previewBodyBox!.x)
    expect(zoomedBox!.width / zoomedBox!.height).toBeCloseTo(16 / 9, 1)
    expect(zoomedBox!.y).toBeLessThan(previewBodyBox!.y + previewBodyBox!.height)
    expect(zoomedBox!.y + zoomedBox!.height).toBeGreaterThan(previewBodyBox!.y)
    await page.evaluate(() => document.documentElement.classList.add('dark'))
    await expect
      .poll(async () => (await canvas.boundingBox())!.x)
      .toBeGreaterThanOrEqual(previewBodyBox!.x)
    await expect(viewer).toHaveScreenshot('session-file-viewer-presentation-zoomed-dark.png')
    await page.evaluate(() => document.documentElement.classList.remove('dark'))
    await viewer.getByRole('button', { name: 'Zoom out' }).click({ clickCount: 3 })
  }
  await viewer.getByRole('button', { name: 'Zoom out' }).click()
  await expect(viewer.getByText('100%', { exact: true })).toBeVisible()
})

test('playground/session viewer renders genuine Word and PowerPoint files', async ({ page }) => {
  await routeSessionInlineMediaAssets(page)
  await page.goto('/playground/attachment-cards')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page.getByRole('button', { name: 'launch-brief.docx' }).click()
  const wordViewer = page.getByRole('dialog', { name: 'launch-brief.docx' })
  await expect(wordViewer.getByText('Launch brief', { exact: true })).toBeVisible({
    timeout: 15_000,
  })
  await expect(wordViewer.getByText('A concise handoff for the September release.')).toBeVisible()
  const wordPage = wordViewer.locator('section.docx').first()
  const wordCanvas = wordPage.locator('..').locator('..')
  const [wordBodyBox, wordCanvasBox] = await Promise.all([
    wordViewer.locator('[data-files-preview-body]').boundingBox(),
    wordCanvas.boundingBox(),
  ])
  expect(wordBodyBox).not.toBeNull()
  expect(wordCanvasBox).not.toBeNull()
  expect(Math.abs(wordCanvasBox!.height - wordBodyBox!.height)).toBeLessThanOrEqual(2)
  if (page.viewportSize()!.width < 640) {
    const wordPageBox = await wordPage.boundingBox()
    expect(wordPageBox).not.toBeNull()
    expect(wordPageBox!.x).toBeGreaterThanOrEqual(wordBodyBox!.x - 1)
    expect(wordPageBox!.x + wordPageBox!.width).toBeLessThanOrEqual(
      wordBodyBox!.x + wordBodyBox!.width + 1,
    )
  }
  await expect(wordViewer).toHaveScreenshot('session-file-viewer-word-light.png')
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await expect
    .poll(() => wordCanvas.evaluate(element => getComputedStyle(element).backgroundColor))
    .not.toBe('rgb(226, 232, 240)')
  await expect(wordViewer).toHaveScreenshot('session-file-viewer-word-dark.png')
  await page.evaluate(() => document.documentElement.classList.remove('dark'))
  await wordViewer.getByRole('button', { name: 'Close preview' }).click()

  await page.getByRole('button', { name: 'launch-deck.pptx' }).click()
  const deckViewer = page.getByRole('dialog', { name: 'launch-deck.pptx' })
  await expect(deckViewer.locator('canvas')).toBeVisible()
  await expect(deckViewer.getByText('1 / 2', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(deckViewer.getByRole('button', { name: 'Next slide' })).toBeEnabled()
  const deckStage = deckViewer.locator('canvas').locator('..').locator('..').locator('..')
  const [deckBodyBox, deckStageBox] = await Promise.all([
    deckViewer.locator('[data-files-preview-body]').boundingBox(),
    deckStage.boundingBox(),
  ])
  expect(deckBodyBox).not.toBeNull()
  expect(deckStageBox).not.toBeNull()
  expect(Math.abs(deckStageBox!.height - deckBodyBox!.height)).toBeLessThanOrEqual(2)
  const [deckCanvasBox, deckViewportBox] = await Promise.all([
    deckViewer.locator('canvas').boundingBox(),
    deckViewer.locator('canvas').locator('..').locator('..').boundingBox(),
  ])
  expect(deckCanvasBox).not.toBeNull()
  expect(deckViewportBox).not.toBeNull()
  expect(deckCanvasBox!.y + deckCanvasBox!.height).toBeLessThanOrEqual(
    deckViewportBox!.y + deckViewportBox!.height,
  )
  await expect(deckViewer).toHaveScreenshot('session-file-viewer-presentation-light.png')
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await expect(deckViewer).toHaveScreenshot('session-file-viewer-presentation-dark.png')
  await page.evaluate(() => document.documentElement.classList.remove('dark'))
})

test('playground/session viewer keeps primary mobile controls comfortably tappable', async ({
  page,
}) => {
  await routeSessionInlineMediaAssets(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/playground/attachment-cards')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page.getByRole('button', { name: 'release-brief.pdf' }).click()
  const viewer = page.getByRole('dialog', { name: 'release-brief.pdf' })
  for (const control of [
    viewer.getByRole('button', { name: 'Close preview' }),
    viewer.getByRole('link', { name: 'Download' }),
  ]) {
    const box = await control.boundingBox()
    expect(box?.width).toBeGreaterThanOrEqual(44)
    expect(box?.height).toBeGreaterThanOrEqual(44)
  }
  await viewer.getByRole('button', { name: 'Close preview' }).click()

  await page.getByRole('button', { name: 'launch-deck.pptx' }).click()
  const deckViewer = page.getByRole('dialog', { name: 'launch-deck.pptx' })
  await expect(deckViewer.getByRole('button', { name: 'Zoom in' })).toBeVisible({
    timeout: 15_000,
  })
  for (const control of [
    deckViewer.getByRole('button', { name: 'Previous slide' }),
    deckViewer.getByRole('button', { name: 'Next slide' }),
    deckViewer.getByRole('button', { name: 'Zoom out' }),
    deckViewer.getByRole('button', { name: 'Zoom in' }),
  ]) {
    const box = await control.boundingBox()
    expect(box?.width).toBeGreaterThanOrEqual(44)
    expect(box?.height).toBeGreaterThanOrEqual(44)
  }
})

test('playground/marketplace keeps selection, detail, descriptions, and completed icons honest', async ({
  page,
}) => {
  await page.goto('/playground/marketplace')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const gallery = page.getByTestId('marketplace-verified-gallery')
  const cards = gallery.locator('[data-marketplace-state]')
  const detail = page.locator('[data-marketplace-detail]')
  const descriptions = await cards.locator('p').allTextContents()

  expect(new Set(descriptions).size).toBe(MARKETPLACE_STATE_KINDS.length)
  // The detail heading is the listing's TITLE (a display name), not its slug —
  // one listing shape now feeds card and detail alike.
  await expect(detail.getByRole('heading', { name: 'Source Reviewer', level: 1 })).toBeVisible()
  await expect(detail).toHaveAttribute('data-marketplace-state', 'installed')
  await expect(detail.getByTestId('marketplace-update-badge')).toBeVisible()

  await cards
    .filter({ has: page.getByRole('heading', { name: 'Research', level: 2, exact: true }) })
    .getByRole('button', { name: 'View details' })
    .click()
  await expect(detail.getByRole('heading', { name: 'research', level: 1 })).toBeVisible()
  await expect(detail).toHaveAttribute('data-marketplace-state', 'uninstalled')

  await page
    .getByRole('button', { name: 'State: installed', exact: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(detail.getByRole('heading', { name: 'Installed agents' })).toBeVisible()
  await expect(detail.getByTestId('marketplace-install')).toHaveText('Add another')

  await page
    .getByRole('button', { name: 'State: update-unread', exact: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(detail.getByTestId('marketplace-update-badge')).toBeVisible()
})

/* A card names one agent and leads one place, so the whole card goes there. It
   used to be a static panel with a small ghost button in its bottom corner:
   seventeen rems of name, summary and skills that looked clickable, read as
   clickable, and did nothing — the reader had to find the one control. This
   clicks the parts that were dead, never the button, so it fails the moment the
   card stops carrying the click itself. */
test('playground/marketplace opens a listing from anywhere on its card', async ({ page }) => {
  await page.goto('/playground/marketplace')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const cards = page.getByTestId('marketplace-verified-gallery').locator('[data-marketplace-state]')
  const detail = page.locator('[data-marketplace-detail]')
  const research = cards.filter({
    has: page.getByRole('heading', { name: 'Research', level: 2, exact: true }),
  })

  // Dead centre of the card — the summary block, as far from the button in the
  // corner as a pointer is likely to land. `position` rather than a click on the
  // paragraph itself: the hit area is one stretched control over the whole card,
  // so every point on it resolves to that control, which is the claim.
  const box = await research.boundingBox()
  expect(box).not.toBeNull()
  await research.click({ position: { x: box!.width / 2, y: box!.height / 2 } })
  await expect(detail.getByRole('heading', { name: 'research', level: 1 })).toBeVisible()

  // And the identity block at the top, which is a different corner of the same
  // promise: one card, one destination, whichever part of it you hit.
  const reviewer = cards.filter({
    has: page.getByRole('heading', { name: 'Source Reviewer', level: 2, exact: true }),
  })
  await reviewer.click({ position: { x: 24, y: 24 } })
  await expect(detail.getByRole('heading', { name: 'Source Reviewer', level: 1 })).toBeVisible()

  // The heading is still a heading. A card that carried the click as
  // `role="button"` on its own <article> would make every child presentational
  // and cost a screen reader the structure this asserts.
  await expect(reviewer.getByRole('heading', { level: 2 })).toBeVisible()
})

/* An uninstalled card carries a real Install control, not a status line about
   readiness — "Ready to install" was text shaped like a button that did
   nothing. The other states keep their status text: installing, installed,
   and unavailable are facts, not actions. */
test('playground/marketplace puts a working Install button on an uninstalled card', async ({
  page,
}) => {
  await page.goto('/playground/marketplace')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const card = page.locator('[data-marketplace-state="uninstalled"]').first()
  await expect(card.getByText('Ready to install')).toHaveCount(0)
  const install = card.getByRole('button', { name: 'Install', exact: true })
  const detailsBox = await card.getByRole('button', { name: 'View details' }).boundingBox()
  const installBox = await install.boundingBox()
  expect(installBox).not.toBeNull()
  expect(detailsBox).not.toBeNull()
  expect(
    Math.abs(installBox!.y + installBox!.height / 2 - (detailsBox!.y + detailsBox!.height / 2)),
  ).toBeLessThanOrEqual(1)

  // The click starts the install flow — naming first, like every install — and
  // must NOT open the listing, even though the card's stretched hit area lies
  // underneath the button. Asserted on the fixture's own selection record
  // rather than the detail heading: the modal dialog aria-hides the page
  // behind it, which takes the heading out of the accessibility tree.
  const fixtureState = page.getByTestId('official-agent-fixture-state')
  await expect(fixtureState).toContainText('"agent":"source-reviewer"')
  await install.click()
  const nameDialog = page.getByTestId('marketplace-install-name')
  await expect(nameDialog).toBeVisible()
  await expect(fixtureState).toContainText('"agent":"source-reviewer"')

  await nameDialog.getByTestId('marketplace-install-name-confirm').click()
  await expect(nameDialog).toBeHidden()
  await expect(page.getByTestId('marketplace-last-request')).toContainText(
    // The card's OWN listing, not the selected detail's.
    '"listingId":"listing-research"',
  )
})

/* Apps ride ahead of skills on the card and get their own block on the detail
   page — an agent's apps are what the installer actually gets to open. */
test('playground/marketplace lists included apps on card and detail', async ({ page }) => {
  await page.goto('/playground/marketplace')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const card = page.locator('[data-marketplace-state="uninstalled"]').first()
  const chips = card.getByRole('list', { name: "What's included" })
  await expect(chips.getByText('Insights Board')).toBeVisible()
  // ONE list, apps leading: the first chip is an app chip, so apps are never
  // the ones the cap cuts and no per-row "+n more" can attach to the wrong row.
  await expect(chips.locator('li').first()).toHaveAttribute('data-marketplace-chip', 'app')

  const detail = page.locator('[data-marketplace-detail]')
  await page
    .getByRole('button', { name: 'State: uninstalled', exact: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(detail.getByRole('heading', { name: 'Included apps' })).toBeVisible()
  await expect(
    detail.getByRole('list', { name: 'Included apps' }).getByText('Insights Board'),
  ).toBeVisible()
})

/* Reading the notes IS the receipt — the route acknowledges the applied
   revision the moment this page's changelog is on screen, which the spa-shell
   test above pins against the real mutation. So the notice states what
   happened and asks for nothing: a "Mark as read" button beside it was a
   control racing an effect to become unnecessary, and it lost — it vanished
   under the pointer of anyone who tried to press it, having done nothing the
   viewing had not already done. */
test('playground/marketplace states an applied update without asking to be dismissed', async ({
  page,
}) => {
  await page.goto('/playground/marketplace')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'State: update-unread', exact: true })
    .evaluate((button: HTMLButtonElement) => button.click())

  const detail = page.locator('[data-marketplace-detail]')
  await expect(detail.getByTestId('marketplace-update-badge')).toBeVisible()
  // Nothing in the notice to press, and nothing telling the reader to press it.
  await expect(detail.getByRole('button', { name: /read/i })).toHaveCount(0)
  await expect(detail).not.toContainText('mark it as read')
})

test('playground/marketplace exposes install without a clone affordance', async ({ page }) => {
  await page.goto('/playground/marketplace')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'State: uninstalled', exact: true })
    .evaluate((button: HTMLButtonElement) => button.click())

  const detail = page.locator('[data-marketplace-detail]')
  await expect(detail.getByTestId('marketplace-install')).toBeVisible()
  await expect(detail.getByRole('button', { name: 'Clone', exact: true })).toHaveCount(0)
})

test('playground/marketplace spa-shell install opens the exact new agent without creating a session', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Browser route: /w/acme/agents/marketplace/official-agents-hub/brief-writer',
      exact: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())

  const destination = page.locator('[data-destination-content="marketplace"]')
  const sessionCount = await page.getByTestId('session-count').textContent()
  await expect(destination.getByRole('heading', { name: 'brief-writer', level: 1 })).toBeVisible()
  const install = destination.getByTestId('marketplace-install')
  await install.click()

  /* Naming comes first now, and declining installs under the listing's slug —
     which is what this test wants, since it asserts the heading is still
     `brief-writer` afterwards. The step is required rather than optional: the
     dialog is modal, so while it is open the detail behind it is `aria-hidden`
     and the heading below cannot be found by role at all. */
  const nameDialog = page.getByTestId('marketplace-install-name')
  await expect(nameDialog).toBeVisible()
  await nameDialog.getByTestId('marketplace-install-name-confirm').click()
  await expect(nameDialog).toBeHidden()

  await expect(page).toHaveURL(/\/w\/acme\/agents\/brief-writer(?:\/|$)/)
  /* The exact installed agent lands on its own page, and that surface — not
     marketplace — owns onboarding and the first conversation.
     It used to be asserted as a *face on the map*, back when an agent unfolded
     over the canvas. An agent is a route of its own now and mounts no map at
     all (see `product-destinations`), so the node that name was read off does
     not exist at any width and this had been quietly red ever since. The
     surface names itself as a region, which is the same claim about the same
     thing and is true on a phone as well. */
  await expect(page.getByRole('region', { name: 'brief-writer' })).toBeVisible()
  await expect(page.getByTestId('marketplace-mutation')).toHaveText(
    JSON.stringify({ action: 'install', input: { listingId: 'listing-brief-writer' } }),
  )
  await expect(page.getByTestId('session-count')).toHaveText(sessionCount ?? '')
})

test('playground/marketplace spa-shell Add another names and opens a sibling from the same listing', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Browser route: /w/acme/agents/marketplace/official-agents-hub/research',
      exact: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())

  const destination = page.locator('[data-destination-content="marketplace"]')
  const sessionCount = await page.getByTestId('session-count').textContent()
  await expect(destination.getByRole('heading', { name: 'Installed agents' })).toBeVisible()
  await destination.getByTestId('marketplace-install').click()

  const nameDialog = page.getByTestId('marketplace-install-name')
  const nameField = nameDialog.getByLabel('Name')
  const confirm = nameDialog.getByTestId('marketplace-install-name-confirm')
  await expect(confirm).toBeDisabled()
  await nameField.fill('Customer Portal')
  await expect(nameDialog.getByTestId('marketplace-install-path-preview')).toContainText(
    'agents/customer-portal',
  )
  await confirm.click()

  await expect(page).toHaveURL(/\/w\/acme\/agents\/customer-portal(?:\/|$)/)
  /* The sibling lands on its own page under the name it was given — see the
     note on the install test above for why this is a region and not a map node. */
  await expect(page.getByRole('region', { name: 'Customer Portal' })).toBeVisible()
  await expect(page.getByTestId('marketplace-mutation')).toHaveText(
    JSON.stringify({
      action: 'install',
      input: {
        listingId: 'listing-research',
        name: 'Customer Portal',
        path: 'agents/customer-portal',
      },
    }),
  )
  await expect(page.getByTestId('session-count')).toHaveText(sessionCount ?? '')
})

test('playground/spa-shell presents route-shaped agent loading states', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  for (const [scenario, view, layout, label, screenshot] of [
    [
      'marketplace-bootstrap-loading',
      'marketplace',
      'catalog',
      'Loading agents…',
      'marketplace-home-bootstrap-loading.png',
    ],
    [
      'marketplace-loading',
      'marketplace',
      'catalog',
      'Loading agents…',
      'marketplace-home-loading.png',
    ],
    [
      'marketplace-detail-loading',
      'marketplace-detail',
      'marketplace-detail',
      'Loading agents…',
      'marketplace-detail-loading.png',
    ],
    [
      // Each surface announces itself: the catalog says it is loading agents,
      // and one agent's own route says it is loading that agent.
      'agent-detail-loading',
      'agent-detail',
      'agent-detail',
      'Loading agent',
      'agent-detail-loading.png',
    ],
  ] as const) {
    await page
      .getByRole('button', { name: `Scenario: ${scenario}`, exact: true, includeHidden: true })
      .evaluate((button: HTMLButtonElement) => button.click())

    const loading = page.locator(`[data-loading-view="${view}"]`)
    await expect(loading).toBeVisible()
    await expect(loading).toHaveAccessibleName(label)
    await expect(loading.locator(`[data-agent-loading-layout="${layout}"]`)).toBeVisible()
    await expect(page).toHaveScreenshot(screenshot, {
      fullPage: true,
    })
  }
})

test('playground/marketplace-integration keeps agents out of Drive in both locales', async ({
  page,
}) => {
  await page.goto('/playground/marketplace-integration')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  for (const [control, shot] of [
    ['Scene: hub', 'marketplace-integration-hub.png'],
    ['Scene: drive', 'marketplace-integration-drive.png'],
  ] as const) {
    await page
      .getByRole('button', { name: control, exact: true })
      .evaluate((button: HTMLButtonElement) => button.click())
    if (control === 'Scene: drive') {
      const drive = page.getByTestId('drive-files-and-apps-only')
      await expect(drive).toContainText('Launch Control')
      await expect(drive).toContainText('roadmap.md')
      await expect(drive).not.toContainText('Research')
      await expect(drive.locator('a[href*="/agents"]')).toHaveCount(0)
    }
    await expect(page).toHaveScreenshot(shot, { fullPage: true })
  }

  await page
    .getByRole('button', { name: 'Español', exact: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await page
    .getByRole('button', { name: 'Scene: drive', exact: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.locator('[data-runtime-locale]')).toHaveAttribute('lang', 'es-419')
  const drive = page.getByTestId('drive-files-and-apps-only')
  await expect(drive).not.toContainText('Research')
  await expect(drive.locator('a[href*="/agents"]')).toHaveCount(0)
  await expect(page).toHaveScreenshot('marketplace-integration-drive-es.png', {
    fullPage: true,
  })
})

test('playground/spa-shell acknowledges an update when its changelog is viewed', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Browser route: /w/acme/agents/marketplace/official-agents-hub/research',
      exact: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())

  await expect(page.locator('[data-marketplace-detail]')).toContainText('July 2026')
  await expect(page.getByTestId('marketplace-mutation')).toHaveText(
    JSON.stringify({ action: 'acknowledge', subscriptionId: 'subscription_research' }),
  )
})

test('playground/marketplace frames every detail state in both locales', async ({ page }) => {
  await page.goto('/playground/marketplace')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  for (const [localeControl, locale] of [
    ['English', 'en'],
    ['Español', 'es'],
  ] as const) {
    await page
      .getByRole('button', { name: localeControl, exact: true })
      .evaluate((button: HTMLButtonElement) => button.click())
    await expect(page.locator('[data-runtime-locale]')).toHaveAttribute(
      'lang',
      locale === 'en' ? 'en' : 'es-419',
    )

    for (const state of MARKETPLACE_STATE_KINDS) {
      await page
        .getByRole('button', { name: `State: ${state}`, exact: true })
        .evaluate((button: HTMLButtonElement) => button.click())
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      })
      await expect(page.locator('[data-marketplace-detail]')).toHaveScreenshot(
        `marketplace-detail-${state}-${locale}.png`,
      )
    }
  }
})

// The publish viewer must survive the 320px floor without horizontal overflow —
// narrower than the 390px mobile project — so long banner names, breadcrumbs,
// and the read-only surfaces all stay inside the viewport.
test('playground/publish-viewer holds at the 320px floor', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 })
  for (const id of [
    'publish-viewer-banner',
    'publish-viewer-folder-root',
    'publish-viewer-deep-folder',
    'publish-viewer-single-file',
    'publish-viewer-error',
  ]) {
    await page.goto(`/playground/${id}`)
    await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `${id} must not overflow horizontally at 320px`,
    ).toBe(true)
  }
})

test('playground/agent-detail walks the read-only canvas states and localizes', async ({
  page,
}) => {
  // Desktop owns the canvas-hierarchy comparison against the app-detail canvas
  // (the nearest analogous surface). The rail is masked — it was judged in slices
  // 06–08. The default capture (agent-detail.png) is the healthy agent; this test
  // settles the replica, disabled, broken, and missing-files states plus the
  // Spanish baseline (SE-5).
  test.skip((page.viewportSize()?.width ?? 0) < 768, 'desktop canvas-hierarchy comparison')

  await page.goto('/playground/agent-detail')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const select = (slug: string) =>
    page
      .getByRole('button', { name: `Agent: ${slug}`, exact: true })
      .evaluate((button: HTMLButtonElement) => button.click())
  const setLocale = (name: string) =>
    page
      .getByRole('button', { name, exact: true })
      .evaluate((button: HTMLButtonElement) => button.click())

  // Healthy default: rendered AGENTS.md, five skills, its apps, and sessions.
  await expect(page.getByRole('banner').getByRole('heading', { name: 'Research' })).toBeVisible()
  await expect(page.getByRole('banner').locator('img')).toBeVisible()

  await select('finance-copilot')
  await expect(
    page.getByRole('banner').getByRole('heading', { name: 'Finance Copilot' }),
  ).toBeVisible()
  await expect(page.getByRole('banner').getByText('Shared', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('agent-detail-replica.png', { fullPage: true })

  await select('nightly-scheduler')
  await expect(
    page.getByRole('banner').getByRole('heading', { name: 'Nightly Scheduler' }),
  ).toBeVisible()
  await expect(page).toHaveScreenshot('agent-detail-disabled.png', { fullPage: true })

  await select('legacy-importer')
  await expect(
    page.getByRole('banner').getByRole('heading', { name: 'Legacy Importer' }),
  ).toBeVisible()
  await expect(page.getByRole('banner').getByText('Unavailable', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('agent-detail-broken.png', { fullPage: true })

  // Missing files: a healthy anchor whose files were never written degrades to a
  // readable empty README and no skills — never a crash.
  await select('blank-agent')
  await expect(page.getByRole('banner').getByRole('heading', { name: 'Blank Agent' })).toBeVisible()
  await expect(page.getByText('described itself yet.', { exact: false })).toBeVisible()
  await expect(page).toHaveScreenshot('agent-detail-missing.png', { fullPage: true })

  await select('research')
  await setLocale('Español')
  await expect(page.locator('[data-runtime-locale]')).toHaveAttribute('lang', 'es-419')
  await expect(page.getByRole('banner').getByRole('heading', { name: 'Research' })).toBeVisible()
  await expect(page.getByText('Habilidades', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('agent-detail-spanish.png', { fullPage: true })
})

test('playground/agent-detail opens an encoded agent anchor in Drive', async ({ page }) => {
  await page.goto('/playground/agent-detail')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page
    .getByRole('button', { name: 'Open encoded anchor in Drive', exact: true })
    .evaluate((button: HTMLButtonElement) => button.click())

  await expect(page.getByTestId('agent-action-location')).toHaveText(
    '/w/acme/files/agents/Market%20briefs/%E6%9D%B1%E4%BA%AC%20100%25',
  )
})

test('playground/agent-detail keeps an anchorless agent at the Drive root', async ({ page }) => {
  await page.goto('/playground/agent-detail')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page
    .getByRole('button', { name: 'Open anchorless agent in Drive', exact: true })
    .evaluate((button: HTMLButtonElement) => button.click())

  await expect(page.getByTestId('agent-action-location')).toHaveText('/w/acme/files')
})

test('playground/agent-detail guards a malformed server anchor at the Drive root', async ({
  page,
}) => {
  await page.goto('/playground/agent-detail')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page
    .getByRole('button', { name: 'Open malformed anchor in Drive', exact: true })
    .evaluate((button: HTMLButtonElement) => button.click())

  await expect(page.getByTestId('agent-action-location')).toHaveText('/w/acme/files')
})

test('playground/agent-anchor-link captures the detail header affordance', async ({ page }) => {
  await page.goto('/playground/agent-detail')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const anchor = page.getByRole('banner').getByRole('link', { name: 'agents/research' })
  await expect(anchor).toHaveAttribute('href', '/w/acme/files/agents/research')
  await expect(anchor.locator('..')).toHaveScreenshot('agent-anchor-link.png')
})

test('playground/agent-detail opens the rename and delete dialogs from the header ⋯ menu', async ({
  page,
}) => {
  // The two new mutation surfaces the human checks (slice 13): the display-name
  // rename dialog and the fail-closed delete confirmation. Opening either touches
  // no API — the mutations fire on submit/confirm, which this capture does not do.
  test.skip((page.viewportSize()?.width ?? 0) < 768, 'action dialogs captured on desktop')

  await page.goto('/playground/agent-detail')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const header = page.getByRole('banner')
  await expect(header.getByRole('heading', { name: 'Research' })).toBeVisible()

  // Rename: display-name-only, so the copy never implies the folder moves.
  await header.getByRole('button', { name: 'Agent actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  const rename = page.getByRole('dialog', { name: 'Rename agent' })
  await expect(rename).toBeVisible()
  await expect(rename.getByText('display name only', { exact: false })).toBeVisible()
  // Settle the caret: the field autofocuses and a blinking caret would make the
  // shot non-deterministic (the suite otherwise never screenshots a focused field).
  await rename.getByLabel('Name').blur()
  await expect(rename).toHaveScreenshot('agent-rename-dialog.png')
  await page.keyboard.press('Escape')
  await expect(rename).toHaveCount(0)

  // Delete: the fail-closed confirmation, named for the agent it removes.
  await header.getByRole('button', { name: 'Agent actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  const del = page.getByRole('alertdialog')
  await expect(del).toBeVisible()
  await expect(del.getByRole('heading', { name: 'Delete Research?' })).toBeVisible()
  await expect(del).toHaveScreenshot('agent-delete-dialog.png')
})

test('playground/drive-shell keeps every tab path-visible and keyboard reachable', async ({
  page,
}) => {
  await page.goto('/playground/drive-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const agents = page.getByRole('tab', { name: 'Agents' })
  await agents.focus()
  await expect(agents).toHaveAttribute('aria-selected', 'true')

  await agents.press('ArrowRight')
  const drive = page.getByRole('tab', { name: 'Drive' })
  await expect(drive).toHaveAttribute('aria-selected', 'true')
  await expect(page).toHaveScreenshot('drive-shell-drive.png', { fullPage: true })

  // Jobs is not one of them: the bar carries the three places you go and stay,
  // and an agent's work is stated on the agent's own surface.
  await expect(page.getByRole('tab', { name: 'Jobs' })).toHaveCount(0)

  await drive.press('End')
  const integrations = page.getByRole('tab', { name: 'Integrations' })
  await expect(integrations).toHaveAttribute('aria-selected', 'true')
  await expect(page).toHaveScreenshot('drive-shell-integrations.png', { fullPage: true })

  await integrations.press('Home')
  await expect(agents).toHaveAttribute('aria-selected', 'true')
})

test('playground/session-projection rebuilds at every durable cursor', async ({ page }) => {
  await page.goto('/playground/session-projection')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page.getByLabel('Search and filter').fill('missing session')
  await expect(page.getByText('No sessions match this search.')).toBeVisible()
  await expect(page).toHaveScreenshot('session-projection-search-empty.png', { fullPage: true })

  await page.getByRole('button', { name: 'New', exact: true }).click()
  await expect(page.getByText('Session created from the first user message.')).toBeVisible()
  await page.getByRole('button', { name: 'Run Luna title', exact: true }).click()
  await expect(page.getByText('Diagnose staging deployment failure', { exact: true })).toHaveCount(
    2,
  )
  await expect(
    page.getByText('Luna title generated once from the first user message.'),
  ).toBeVisible()

  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  await page.getByRole('button', { name: 'Run Luna title', exact: true }).click()
  await expect(page.getByText('Release log diagnosis', { exact: true })).toHaveCount(2)
  await expect(
    page.getByText('Luna title ignored because the session was manually renamed.'),
  ).toBeVisible()
  await expect(page).toHaveScreenshot('session-projection-renamed.png', { fullPage: true })

  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByText('Session deleted', { exact: true })).toBeVisible()
  await expect(page.getByText('No sessions yet.')).toBeVisible()
  await expect(page).toHaveScreenshot('session-projection-deleted.png', { fullPage: true })

  await page.getByRole('button', { name: 'New', exact: true }).click()
  await expect(page.getByText('Session created from the first user message.')).toBeVisible()
  await expect(page).toHaveScreenshot('session-projection-created.png', { fullPage: true })

  for (let cursor = 0; cursor <= 6; cursor += 1) {
    await page.getByRole('button', { name: String(cursor), exact: true }).click()
    await expect(page.getByText(`Durable cursor ${cursor} of 6`)).toBeVisible()
  }
  await expect(page.getByText('The web service is missing DATABASE_URL.')).toBeVisible()
  await expect(page.getByText('Milo needs your input')).toBeVisible()
  await expect(page.getByText('Add it to staging?')).toBeVisible()

  await page.getByRole('button', { name: '3', exact: true }).click()
  await expect(page.getByText('Durable cursor 3 of 6')).toBeVisible()
  await expect(page).toHaveScreenshot('session-projection-running.png', { fullPage: true })

  await page.getByRole('button', { name: '0', exact: true }).click()
  await expect(page.getByText('Durable cursor 0 of 6')).toBeVisible()
  await expect(page).toHaveScreenshot('session-projection-rewound.png', { fullPage: true })

  await page.getByRole('button', { name: 'Completed', exact: true }).click()
  await expect(page.getByText('The web service is missing DATABASE_URL.')).toBeVisible()
  // A settled turn ends on its answer — no row echoing it back.
  await expect(page.getByText('Complete ·')).toHaveCount(0)
  await expect(page).toHaveScreenshot('session-projection-complete.png', { fullPage: true })

  await page.getByRole('button', { name: 'Interrupted / error', exact: true }).click()
  await expect(
    page.getByText('Interrupted · Runner exited before the session completed.'),
  ).toBeVisible()
  await expect(page.getByText('Runner exited before the session completed.')).toBeVisible()
  await expect(page).toHaveScreenshot('session-projection-failed.png', { fullPage: true })

  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  await expect(page.getByText('Session moved to Archived.')).toBeVisible()
  await expect(page).toHaveScreenshot('session-projection-archived.png', { fullPage: true })

  await page.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(page.getByText('Session restored to Active.')).toBeVisible()
  await expect(page).toHaveScreenshot('session-projection-restored.png', { fullPage: true })
})

test('playground/session-authored-messages renders one authored shell per message', async ({
  page,
}) => {
  await page.goto('/playground/session-authored-messages')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const primary = page.getByRole('log', { name: 'AI → user → AI' })
  await expect(primary.getByRole('article')).toHaveCount(3)
  await expect(primary.locator('[data-message-avatar]')).toHaveCount(3)

  const mixed = page.getByRole('log', { name: 'One shell for mixed and pending content' })
  await expect(mixed.getByRole('article').first()).toContainText('Should I deploy it to staging?')
  await expect(mixed.getByRole('article').first().locator('[data-message-avatar]')).toHaveCount(1)

  // Each author class names its own author and wears its own mark. A reader
  // and a screen reader get the same four answers.
  const authored = page.getByRole('log', { name: 'Every kind of author' })
  await expect(authored.getByLabel('Message from David Zhang').first()).toBeVisible()
  await expect(
    authored.getByLabel('Message from quartermaster.operations@long-workspace-domain.example.com'),
  ).toBeVisible()
  const calendarRow = authored.getByLabel('Message from Team Calendar (App)')
  await expect(calendarRow).toBeVisible()
  await expect(authored.getByLabel('Message from Duet')).toBeVisible()
  await expect(calendarRow).toContainText('Team Calendar')

  /* A session inside an agent speaks as that agent, and its chip is the way to
     the conversation the message came out of. A root session has no agent to
     speak as and nowhere on the map to send the reader, so it keeps its own
     title and a chip that is plain text. */
  const opsRow = authored.getByLabel('Message from Ops — main (Session)')
  await expect(opsRow).toContainText('Ops — main')
  await expect(opsRow.getByRole('link')).toHaveCount(0)
  const delegatedRow = authored.getByLabel('Message from SEO Specialist (Session)')
  await expect(delegatedRow).toContainText('SEO Specialist')
  await expect(delegatedRow).not.toContainText('session_seo_')
  await expect(delegatedRow.getByRole('link', { name: 'Session' })).toHaveAttribute(
    'href',
    '/w/acme/agents/seo-specialist/sessions/session_seo_board',
  )

  // An app that published an icon is recognized by it; a registered app without
  // one keeps the generic mark in the same footprint.
  await expect(calendarRow.locator('img[data-message-avatar]')).toHaveAttribute(
    'src',
    /provider-googlecalendar\.webp/,
  )
  const iconlessAppRow = authored.getByLabel('Message from Inventory Sync (App)')
  await expect(iconlessAppRow.locator('[data-message-avatar]')).toHaveCount(1)
  await expect(iconlessAppRow.locator('img[data-message-avatar]')).toHaveCount(0)

  // Duet authored the row either way, so a workspace that renamed its assistant
  // reads its own name on the same mascot.
  const renamed = page.getByRole('log', { name: 'A workspace that renamed its Duet' })
  await expect(renamed.getByLabel('Message from Milo')).toBeVisible()
  await expect(renamed).not.toContainText('Duet')

  // A missing app or session degrades to its own handle; a missing person never
  // shows an internal user id.
  const unnameable = page.getByRole('log', { name: 'Identity that current data cannot name' })
  await expect(unnameable.locator('[data-message-attribution="app"]')).toContainText(
    'app_retired_…',
  )
  await expect(unnameable.getByLabel('Message from Unknown member')).toBeVisible()
  await expect(unnameable).not.toContainText('user_departed')

  /* Identity still on its way is a wait, not a failure — and for a relayed row
     that means waiting rather than printing the short id it falls back to only
     once a read has actually come back empty. */
  const loadingIdentity = page.getByRole('log', { name: 'Before identity arrives' })
  await expect(loadingIdentity.getByLabel('Message from a workspace member')).toBeVisible()
  await expect(loadingIdentity.getByLabel('Message from another conversation')).toBeVisible()
  await expect(loadingIdentity).not.toContainText('session_slow')

  // A run from one voice keeps a row each but is announced once: the
  // continuations drop the repeated face and name.
  const stacked = page.getByRole('log', { name: 'Consecutive turns stack' })
  await expect(stacked.getByRole('article')).toHaveCount(5)
  await expect(stacked.locator('[data-message-avatar]')).toHaveCount(2)
  await expect(stacked.locator('[data-message-stacked="true"]')).toHaveCount(3)

  await expect(page).toHaveScreenshot('session-authored-messages.png', { fullPage: true })
})

test('playground/session-inline-media preserves media identity while text streams', async ({
  page,
}) => {
  await routeSessionInlineMediaAssets(page)
  await page.goto('/playground/session-inline-media')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const conversation = page.getByRole('log', { name: 'Inline media conversation' })
  const uploadedImages = conversation.locator('[data-message-inline-image] img')
  await expect(uploadedImages).toHaveCount(3)
  await expect
    .poll(() =>
      uploadedImages.evaluateAll(images =>
        Math.max(
          ...images.map(image => {
            const imageRect = image.getBoundingClientRect()
            const frameRect = image.closest('[data-message-inline-image]')?.getBoundingClientRect()
            if (!frameRect) return Number.POSITIVE_INFINITY
            return Math.max(
              frameRect.left - imageRect.left,
              imageRect.right - frameRect.right,
              frameRect.top - imageRect.top,
              imageRect.bottom - frameRect.bottom,
              0,
            )
          }),
        ),
      ),
    )
    .toBeLessThan(1)
  await expect
    .poll(() =>
      uploadedImages.evaluateAll(images =>
        images.every(image => {
          const element = image as HTMLImageElement
          return (
            element.naturalWidth > 0 &&
            element.naturalHeight > 0 &&
            getComputedStyle(element).objectFit === 'contain'
          )
        }),
      ),
    )
    .toBe(true)
  await expect(conversation.getByAltText('User-authored cwd chart')).toBeVisible()
  await expect(conversation.getByAltText('Nested cwd chart')).toBeVisible()
  await expect(conversation.getByAltText('Remote route-fulfilled chart')).toBeVisible()
  await expect(conversation.getByAltText('Final plot with encoded space')).toBeVisible()
  await expect(conversation.locator('video[controls]')).toHaveCount(1)
  await expect(conversation.locator('audio[controls]')).toHaveCount(1)
  await expect(conversation.locator('[data-session-file-card]')).toHaveCount(3)
  await expect(conversation.locator('[data-message-attachment-card]')).toHaveCount(2)
  await expect(conversation.getByRole('button', { name: 'release-brief.pdf' })).toBeVisible()
  await expect(conversation.getByText('Channel', { exact: true }).first()).toBeVisible()
  await expect(conversation.getByRole('link', { name: 'Open the Research agent' })).toHaveAttribute(
    'href',
    '/w/acme/agents/research',
  )

  const video = conversation.locator('video')
  await expect
    .poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState))
    .toBeGreaterThan(0)
  await video.evaluate(element => {
    ;(element as HTMLVideoElement).playbackRate = 1.5
  })
  const originalVideo = await video.elementHandle()
  if (originalVideo === null) throw new Error('Expected the inline video element')

  await test.step('append streamed tail without changing src', async () => {
    await page.getByRole('button', { name: 'Append streamed tail' }).click()
    await expect(
      conversation.getByText('Streaming tail appended without a new source.'),
    ).toBeVisible()
    expect(
      await video.evaluate((element, previous) => element.isSameNode(previous), originalVideo),
    ).toBe(true)
    await expect
      .poll(() => video.evaluate(element => (element as HTMLVideoElement).playbackRate))
      .toBe(1.5)
  })

  await test.step('change src and replace the media node', async () => {
    await page.getByRole('button', { name: 'Change video source' }).click()
    await expect(video).toHaveAttribute('src', '/playground/inline-media/alternate.webm')
    expect(
      await video.evaluate((element, previous) => element.isSameNode(previous), originalVideo),
    ).toBe(false)
  })
})

test('playground/session-ordered-parts keeps mixed AI activity nested and keyboard-accessible', async ({
  page,
}) => {
  await page.goto('/playground/session-ordered-parts')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await expect(page.locator('[data-agent-part-kind="tool"] pre')).toHaveCount(0)
  await expect(page.getByAltText('Tool image output')).toHaveCount(0)
  await expect(page).toHaveScreenshot('session-ordered-parts-collapsed.png', { fullPage: true })

  const activity = page.locator('[data-agent-activity]').first()
  await activity.locator('summary').first().focus()
  await activity.locator('summary').first().press('Enter')
  await expect(activity).toHaveJSProperty('open', true)
  await expect(activity.locator('[data-agent-part-kind="tool"] summary')).toHaveCount(3)
  await expect(activity).not.toContainText('Production rollout owner is still unassigned.')
  const completedTool = activity.locator('[data-agent-part-id="tool-release-report"]')
  await completedTool.locator('summary').focus()
  await completedTool.locator('summary').press('Enter')
  await expect(completedTool).toContainText('Production rollout owner is still unassigned.')
  await expect(page.locator('[data-agent-activity]:not([open]) pre')).toHaveCount(0)
  await activity.locator('summary').first().press('Space')
  await expect(activity).toHaveJSProperty('open', false)
  await expect(activity.locator('pre')).toHaveCount(0)
  await activity.locator('summary').first().press('Enter')
  await expect(activity).toContainText('Production rollout owner is still unassigned.')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page).toHaveScreenshot('session-ordered-parts-expanded.png', { fullPage: true })

  const secondActivity = page.locator('[data-agent-activity]').nth(1)
  await secondActivity.locator('summary').first().focus()
  await secondActivity.locator('summary').first().press('Enter')
  await expect(secondActivity).toHaveJSProperty('open', true)
  const imageTool = secondActivity.locator('[data-agent-part-id="tool-image"]')
  await imageTool.locator('summary').focus()
  await imageTool.locator('summary').press('Enter')

  const runningToolName = page.getByText('COMPOSIO_CAPTURE_RELEASE_CHART')
  await expect(runningToolName).toHaveCSS('text-transform', 'lowercase')
  const runningTool = page.locator('[data-agent-part-id="tool-running"]')
  await expect(runningTool.getByLabel('running')).toBeVisible()
  await expect(runningTool).not.toContainText('running')

  /* D19: the server that exposed a tool is its own chip, so the reader never
     sees the runner's joined `<server>__<tool>` string. A workspace server
     wears its own name; Duet's integration catalog wears a translated word. */
  await expect(page.locator('[data-tool-server="acme_internal"]')).toHaveText('acme_internal')
  await expect(page.locator('[data-tool-server="integrations"]')).toHaveText('Integrations')
  await expect(page.getByText('__', { exact: false })).toHaveCount(0)

  await expect(page.getByAltText('Tool image output')).toBeVisible()
  await expect(page).toHaveScreenshot('session-ordered-parts-image.png', { fullPage: true })
})

test('playground/files clears its drop affordance when a child drag is canceled', async ({
  page,
}) => {
  await page.goto('/playground/files')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const fileBrowser = page.getByLabel('File browser')
  const child = fileBrowser.locator('[role="tree"]')
  await child.evaluate(element => {
    element.dispatchEvent(new DragEvent('dragenter', { bubbles: true }))
  })
  await expect(page.getByText('Drop files to upload')).toBeVisible()

  await child.evaluate(element => {
    element.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: null }))
  })
  await expect(page.getByText('Drop files to upload')).toHaveCount(0)
})

test('playground/files exercises browser, editor, conflict, CRUD, upload, and error states', async ({
  page,
}) => {
  await page.goto('/playground/files')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await expect(page.getByLabel('File browser')).toBeVisible()
  // The columns replaced the card grid's hero; the tree is the drive's presence.
  await expect(page.getByRole('tree', { name: 'Drive columns' })).toBeVisible()
  await expect(page.getByText('Welcome.md', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'brand-assets', exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('files-browse.png', { fullPage: true })

  // The footer size readout opens the drive-status dialog: total, a
  // per-kind usage bar, and the folder / document tallies.
  await page.getByRole('button', { name: 'View Drive status' }).click()
  const status = page.getByRole('dialog')
  await expect(status.getByRole('heading', { name: 'Drive status' })).toBeVisible()
  await expect(status.getByText('PDFs', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('files-drive-status.png', { fullPage: true })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // The Sheet overlay fades in on open and re-runs its transition on the
  // in-sheet "Load more" commit; settle it before each shot so the backdrop
  // scrim is deterministic rather than caught mid-transition.
  const activity = page.getByRole('dialog')
  await runDriveAction(page, 'Activity')
  await expect(activity.getByText('old-draft.md', { exact: true })).toBeVisible()
  await expect(activity.getByText('renamed a file', { exact: true })).toBeVisible()
  await page.waitForTimeout(600)
  await expect(page).toHaveScreenshot('files-activity-feed.png', { fullPage: true })
  await activity.getByRole('button', { name: 'Load more', exact: true }).click()
  await expect(
    activity.getByRole('button', { name: 'Try loading more again', exact: true }),
  ).toBeVisible()
  await expect(activity.getByText("Couldn't load more activity.", { exact: true })).toBeVisible()
  await expect(activity.getByText('old-draft.md', { exact: true })).toBeVisible()
  await page.waitForTimeout(600)
  await expect(page).toHaveScreenshot('files-activity-page-error.png', { fullPage: true })
  await activity.getByRole('button', { name: 'Try loading more again', exact: true }).click()
  await expect(activity.getByText('edited 3 files', { exact: true })).toBeVisible()
  await page.waitForTimeout(600)
  await expect(page).toHaveScreenshot('files-activity-paginated.png', { fullPage: true })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // Away from root the same drawer follows the addressed folder rather than
  // leaking unrelated workspace activity into the current context.
  await page.getByRole('button', { name: 'research', exact: true }).click()
  await runDriveAction(page, 'Activity')
  /* The subtitle names the folder rather than saying "this folder", which is
     the assertion that the drawer followed the address: a generic subtitle
     reads identically whether the scope moved or not. */
  await expect(activity.getByText('What changed in /research, newest first.')).toBeVisible()
  /* A row is one button that says who did what to which path, so the filename
     alone is not a text node any more. Matching the whole label is the stronger
     read anyway: it pins the actor and the verb beside the file, not just that
     the name appears somewhere in the drawer. */
  await expect(
    activity.getByRole('button', { name: 'Agent · Maya Chen edited /research/market-notes.txt' }),
  ).toBeVisible()
  await expect(activity.getByText('old-draft.md', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page
    .getByRole('navigation', { name: 'Drive path' })
    .getByRole('button', { name: 'Drive' })
    .click()

  // The hero search narrows the open folder live.
  await page.getByLabel('Search this folder…').fill('quarterly')
  await expect(page.getByText('quarterly-plan.md', { exact: true })).toBeVisible()
  await expect(page.getByText('Welcome.md', { exact: true })).toHaveCount(0)
  // Settle the caret: a focused input blinks, which would make the shot
  // non-deterministic (the suite otherwise never screenshots a focused field).
  await page.getByLabel('Search this folder…').blur()
  await expect(page).toHaveScreenshot('files-search.png', { fullPage: true })
  await page.getByLabel('Clear search').click()
  await expect(page.getByText('Welcome.md', { exact: true })).toBeVisible()

  // Opening a document presents it in the preview lightbox.
  await page.getByRole('button', { name: 'Welcome.md', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Welcome to Duet' })).toBeVisible()
  await expect(page).toHaveScreenshot('files-markdown-preview.png', { fullPage: true })

  // The history drawer stacks on top of the lightbox.
  await page.getByRole('button', { name: 'History', exact: true }).click()
  const history = page.getByRole('dialog').last()
  await expect(history.getByText('Seen during this period').first()).toBeVisible()
  await expect(history.getByText('Created', { exact: true })).toBeVisible()
  await page.waitForTimeout(600)
  await expect(page).toHaveScreenshot('files-history-drawer.png', { fullPage: true })
  await history.getByRole('button', { name: 'Load more', exact: true }).click()
  await expect(history.getByText('Restored from a snapshot')).toBeVisible()
  await page.waitForTimeout(600)
  await expect(page).toHaveScreenshot('files-history-paginated.png', { fullPage: true })
  await page.keyboard.press('Escape')
  /* Escape belongs to the innermost dismissible thing: the drawer goes, the
     document stays. The document is not a dialog, so no dialog survives —
     counting one only ever caught the drawer in the frame before it unmounted,
     which passed or failed on how fast that happened. */
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('[data-files-preview]')).toBeVisible()

  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.getByLabel('File editor')
  await expect(editor).toHaveValue(/Welcome to Duet/)
  await editor.fill('# Edited locally\n')
  // There is no Save: the typing settles and the drive takes the words.
  await expect(page.locator('[data-files-save-status="saved"]')).toBeVisible()
  await expect(page).toHaveScreenshot('files-edit-autosaved.png', { fullPage: true })

  /* A conflict, pinned to the moment it is discovered: hold the next write,
     type into the gap so a write is outstanding, replace the file underneath
     it, then let the write go. The preview is a modal, so Radix marks the
     sr-only playground nav aria-hidden — reach these controls by CSS, outside
     the a11y tree, and dispatch the clicks directly. */
  await page
    .locator('button', { hasText: 'Pause next upload' })
    .evaluate(button => (button as HTMLButtonElement).click())
  await editor.fill('# Edited locally, again\n')
  await expect(page.locator('[data-files-save-status="saving"]')).toBeVisible()
  await page
    .locator('button', { hasText: 'Cause file conflict' })
    .evaluate(button => (button as HTMLButtonElement).click())
  await page
    .locator('button', { hasText: 'Complete upload' })
    .evaluate(button => (button as HTMLButtonElement).click())
  await expect(page.getByText('This file changed after you opened it.')).toBeVisible()
  await expect(page).toHaveScreenshot('files-edit-conflict.png', { fullPage: true })
  /* Neither button says what it costs; the tooltips do, and they exist only
     while hovered — so nothing else in the suite would notice their copy going
     missing. Rightmost first: an open tooltip is drawn below its own button and
     would cover the one to its right, and `filter` then reads the newly opened
     one while the previous is still fading. */
  await page.getByRole('button', { name: 'Reload latest' }).hover()
  await expect(page.getByRole('tooltip')).toContainText('discarded')
  await expect(page).toHaveScreenshot('files-conflict-tooltip.png', { fullPage: true })
  /* One tooltip per run, deliberately: this suite disables CSS animations, so
     Radix never receives the animationend that unmounts a closed tooltip and
     no second one opens behind the first. The mechanism and its copy are what
     this asserts — a missing message key renders the key path, and nothing
     else in the suite ever opens one of these. */
  await page.getByRole('button', { name: 'Reload latest' }).click()
  await expect(editor).toHaveValue('A newer server version.')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // Create actions live inside the drive itself.
  await runDriveAction(page, 'New folder')
  await page.getByLabel('Folder name').fill('launch')
  await expect(page).toHaveScreenshot('files-create-folder.png', { fullPage: true })
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByText('launch', { exact: true })).toBeVisible()

  await runDriveAction(page, 'New file')
  await page.getByLabel('File name').fill('notes.txt')
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByText('notes.txt', { exact: true })).toBeVisible()

  // Card actions drive rename, copy, move, and delete.
  await page.getByLabel('Actions for notes.txt').click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  await expect(page.getByLabel('New name')).toBeFocused()
  await page.getByLabel('New name').fill('meeting-notes.txt')
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByRole('button', { name: 'meeting-notes.txt', exact: true })).toBeVisible()

  await page.getByLabel('Actions for meeting-notes.txt').click()
  await page.getByRole('menuitem', { name: 'Make a copy' }).click()
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByText('meeting-notes copy.txt', { exact: true })).toBeVisible()

  await page
    .getByRole('button', { name: 'Fail next move' })
    .evaluate(button => (button as HTMLButtonElement).click())
  await page.getByLabel('Actions for meeting-notes.txt').click()
  await page.getByRole('menuitem', { name: 'Move' }).click()
  await page.getByLabel('Destination path').fill('/launch/meeting-notes.txt')
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByText('move_failed', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'meeting-notes.txt', exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('files-optimistic-rollback.png', { fullPage: true })

  await page.getByLabel('File browser').evaluate(element => {
    element.dispatchEvent(new DragEvent('dragenter', { bubbles: true }))
  })
  await expect(page.getByText('Drop files to upload')).toBeVisible()
  await expect(page).toHaveScreenshot('files-drag-over.png', { fullPage: true })
  await page.getByLabel('File browser').evaluate(element => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['dropped'], 'dropped.txt', { type: 'text/plain' }))
    element.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
    )
  })
  await expect(page.getByText('dropped.txt', { exact: true })).toBeVisible()
  await expect(page.getByRole('status', { name: 'Upload progress' })).toHaveCount(0)

  await page
    .getByRole('button', { name: 'Pause next upload' })
    .evaluate(button => (button as HTMLButtonElement).click(), undefined, { timeout: 1_000 })
  await page.locator('input[type="file"]').setInputFiles({
    name: 'upload.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('uploaded'),
  })
  const uploadStatus = page.getByRole('status', { name: 'Upload progress' })
  await expect(uploadStatus).toContainText('upload.txt')
  // While bytes are moving there is a way out. It disappears with the transfer:
  // once the drive is being re-read there is nothing left to stop.
  await expect(uploadStatus.getByRole('button', { name: 'Stop' })).toBeVisible()
  await expect(page.getByText('Uploaded 1 file.', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Welcome.md', { exact: true })).toBeVisible()
  // The columns own their own scrolling; the page itself does not scroll, and
  // the card grid's hero heading went with the grid.
  await page.getByRole('tree', { name: 'Drive columns' }).scrollIntoViewIfNeeded()
  await expect(page).toHaveScreenshot('files-uploading.png', { fullPage: true })

  // Finishing an upload from the root must not replace a folder the user
  // entered while the write was in flight.
  await page.getByRole('button', { name: 'brand-assets', exact: true }).click()
  await expect(page.getByRole('button', { name: 'logo.svg', exact: true })).toBeVisible()
  await page
    .getByRole('button', { name: 'Complete upload' })
    .evaluate(button => (button as HTMLButtonElement).click())
  await expect(page.getByRole('button', { name: 'logo.svg', exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Drive path' })).toContainText('brand-assets')
  // Columns have no up-button: you walk back via the breadcrumb root.
  await page
    .getByRole('navigation', { name: 'Drive path' })
    .getByRole('button', { name: 'Drive' })
    .click()
  await expect(page.getByText('upload.txt', { exact: true })).toBeVisible()

  await page.getByLabel('Actions for meeting-notes copy.txt').click()
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Delete permanently?' })).toBeVisible()
  await expect(page).toHaveScreenshot('files-delete-confirm.png', { fullPage: true })
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByText('meeting-notes copy.txt', { exact: true })).toHaveCount(0)

  // Images open on the zoomable stage.
  await page.getByRole('button', { name: 'brand-assets', exact: true }).click()
  await page.getByRole('button', { name: 'logo.svg', exact: true }).click()
  await expect(page.getByRole('img', { name: 'logo.svg' })).toBeVisible()
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await expect(page.getByText('125%')).toBeVisible()
  await expect(page).toHaveScreenshot('files-image-preview.png', { fullPage: true })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // Columns have no up-button: you walk back via the breadcrumb root.
  await page
    .getByRole('navigation', { name: 'Drive path' })
    .getByRole('button', { name: 'Drive' })
    .click()
  // The trail keeps its row at the root rather than retiring, so the columns
  // beneath it do not jump a row every time you arrive or leave.
  await expect(page.getByRole('navigation', { name: 'Drive path' })).toHaveCount(1)

  // Folders drill in on a single click; the breadcrumb joins the drive.
  await page.getByRole('button', { name: 'exports', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Drive path' })).toContainText('exports')
  await page.getByRole('button', { name: 'launch-plan.xls', exact: true }).click()
  await expect(page.getByRole('cell', { name: 'API docs', exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'In progress', exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('files-spreadsheet-preview.png', { fullPage: true })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await page.getByRole('button', { name: 'customer-data.bin', exact: true }).click()
  await expect(page.getByText(/00 01 02 03/)).toBeVisible()
  await expect(page).toHaveScreenshot('files-binary-preview.png', { fullPage: true })

  await page.getByRole('button', { name: 'History', exact: true }).click()
  await expect(page.getByRole('dialog').last().getByText('No history yet')).toBeVisible()
  await page.waitForTimeout(600)
  await expect(page).toHaveScreenshot('files-history-empty.png', { fullPage: true })
  // The document is a takeover now, not a dialog, so the history drawer is the
  // only thing Escape has to close — and the drive's own Escape stands down
  // while any dialog is open, so it cannot steal the key from the drawer.
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // A document takes the whole browser region, breadcrumb included, so leaving
  // it is the document's own Back — then the trail is there to walk to the root.
  await page.getByRole('button', { name: 'Back to folder' }).click()
  await page
    .getByRole('navigation', { name: 'Drive path' })
    .getByRole('button', { name: 'Drive' })
    .click()
  // The trail keeps its row at the root rather than retiring, so the columns
  // beneath it do not jump a row every time you arrive or leave.
  await expect(page.getByRole('navigation', { name: 'Drive path' })).toHaveCount(1)
  await expect(page.getByText('Welcome.md', { exact: true })).toBeVisible()

  // An empty drive keeps its control strip and actions; the emptiness is stated
  // by the root column, which is the thing that is actually empty.
  await page
    .getByRole('button', { name: 'Files scenario: empty' })
    .evaluate(button => (button as HTMLButtonElement).click())
  await expect(page.getByText('Empty folder', { exact: true })).toBeVisible()
  await expect(page.getByRole('tree', { name: 'Drive columns' })).toBeVisible()
  // An empty folder still offers a way to fill it — one mark away, not gone.
  await expect(page.locator('[data-drive-actions]')).toBeVisible()
  await expect(page).toHaveScreenshot('files-empty.png', { fullPage: true })

  await page
    .getByRole('button', { name: 'Files scenario: load-error' })
    .evaluate(button => (button as HTMLButtonElement).click())
  await expect(page.getByRole('heading', { name: 'Could not load this folder' })).toBeVisible()
  await expect(page.getByText('list_failed', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Nothing here yet' })).toHaveCount(0)
  await expect(page).toHaveScreenshot('files-load-error.png', { fullPage: true })

  await page
    .getByRole('button', { name: 'Files scenario: not-found' })
    .evaluate(button => (button as HTMLButtonElement).click())
  await expect(page.getByRole('heading', { name: 'This folder no longer exists' })).toBeVisible()
  await expect(page.getByText('It may have been moved, renamed, or deleted.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open parent folder' })).toBeVisible()
  await expect(page.getByText('Try again')).toHaveCount(0)
  await expect(page).toHaveScreenshot('files-not-found.png', { fullPage: true })
  await page.getByRole('button', { name: 'Open parent folder' }).click()
  await expect(page.getByRole('heading', { name: 'This folder no longer exists' })).toBeVisible()
  await page.getByRole('button', { name: 'Open parent folder' }).click()
  await expect(page.getByText('Welcome.md', { exact: true })).toBeVisible()
})

test('playground/files keeps an authenticated preview live across refresh, conflict, recovery, and renderer changes', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.goto('/playground/files')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const cadenceTimeout = 8_000
  const fixtureButton = (name: string) => page.locator('button', { hasText: name }).first()
  const runFixtureAction = async (name: string) => {
    const button = fixtureButton(name)
    await expect(button).toBeAttached()
    await button.evaluate(element => (element as HTMLButtonElement).click())
  }
  const pane = page.locator('[data-files-preview-pane]')
  /* No write outstanding. Autosave states are the one thing in this flow that
     can still be mid-flight when an assertion or a screenshot lands, so every
     step that follows a released write waits for the editor to go quiet. */
  const expectNoWriteInFlight = async () => {
    await expect(page.locator('[data-files-save-status="saving"]')).toHaveCount(0, {
      timeout: cadenceTimeout,
    })
  }
  /* The document's header is a sibling of its body, not a child: standing beside
     a listing it lands in the drive's own breadcrumb row rather than on top of
     the body. So the controls that live in it are looked up through its own
     marker, which follows it wherever the surface puts it. */
  const paneHeader = page.locator('[data-files-preview-header]')
  const skeleton = page.locator('[data-files-preview-skeleton]')
  /* The connection pill is gone from the header — it was chatter, and the size
     that replaced it is the more useful fact. So what a live refresh is held to
     is what it actually does: the document is showing content, not a skeleton.
     The one live state that still has its own surface is `missing`, which keeps
     its banner and is asserted directly where that matters. */
  const expectLiveStatus = async (_status: 'live' | 'updated' | 'reconnecting' | 'missing') => {
    await expect(pane).toHaveCount(1, { timeout: cadenceTimeout })
    await expect(skeleton).toHaveCount(0, { timeout: cadenceTimeout })
  }
  const dismissPreview = async () => {
    // A document is a takeover, not a dialog: it is left, not closed.
    await page.getByRole('button', { name: 'Back to folder' }).click()
    await expect(pane).toHaveCount(0)
  }
  const expectVersionedSourceRefresh = async ({
    open,
    source,
    action,
  }: {
    open(): Promise<void>
    source: string
    action: string
  }) => {
    await open()
    await expectLiveStatus('live')
    const renderedSource = pane.locator(source)
    await expect(renderedSource).toBeAttached()
    const before = await renderedSource.getAttribute('src')
    expect(before).not.toBeNull()
    await runFixtureAction(action)
    await expect
      .poll(() => renderedSource.getAttribute('src'), { timeout: cadenceTimeout })
      .not.toBe(before)
    await expectLiveStatus('updated')
    await dismissPreview()
  }

  await page.getByRole('button', { name: 'Welcome.md', exact: true }).click()
  await expectLiveStatus('live')
  await expect(page.getByRole('heading', { name: 'Welcome to Duet' })).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(page).toHaveScreenshot('files-live.png', { fullPage: true })

  await runFixtureAction('Live update Welcome')
  await expect(page.getByRole('heading', { name: 'Updated from workspace' })).toBeVisible({
    timeout: cadenceTimeout,
  })
  await expectLiveStatus('updated')
  await page.mouse.move(0, 0)
  await expect(page).toHaveScreenshot('files-live-updated.png', { fullPage: true })

  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = pane.locator('[data-files-editor]')
  await expect(editor).toHaveValue('# Updated from workspace\n')

  /* Hold the browser's write so the draft stays unsaved through the rest of
     this section. Autosave otherwise commits the words within a second, and a
     saved draft cannot be in conflict with anything — which is the point, but
     it leaves no way to reach the states below. */
  await runFixtureAction('Pause next upload')
  await runFixtureAction('Live defer next read')
  await runFixtureAction('Live rewrite Welcome')

  // The release control becomes enabled only after the real live controller
  // reaches the deferred content read. Type after that point so this proves
  // the commit-time dirty guard rather than merely starting dirty.
  const releaseRead = fixtureButton('Live release deferred read')
  await expect(releaseRead).toBeEnabled({ timeout: cadenceTimeout })
  await expect(editor).toHaveValue('# Updated from workspace\n')
  await expect(skeleton).toHaveCount(0)
  const localDraft = `# Local draft during refresh\n\n${Array.from(
    { length: 80 },
    (_, index) => `Line ${index + 1}`,
  ).join('\n')}\n`
  await editor.fill(localDraft)
  await editor.evaluate(element => {
    element.scrollTop = 120
  })
  const editorScrollTop = await editor.evaluate(element => element.scrollTop)
  expect(editorScrollTop).toBeGreaterThan(0)
  await releaseRead.evaluate(element => (element as HTMLButtonElement).click())

  const conflict = pane.locator('[data-files-live-conflict]')
  await expect(conflict).toBeVisible({ timeout: cadenceTimeout })
  await expectLiveStatus('live')
  await expect(editor).toHaveValue(localDraft)
  await expect(editor).toBeFocused()
  expect(await editor.evaluate(element => element.scrollTop)).toBe(editorScrollTop)
  /* Let the held write go: it is rejected against an identity the drive has
     moved past, and re-reading finds bytes that really did change — so the
     banner stays, and the conflict is the reader's to answer. */
  await runFixtureAction('Complete upload')
  await expectNoWriteInFlight()
  await expect(conflict).toBeVisible()
  await expect(editor).toHaveValue(localDraft)
  await editor.blur()
  await page.mouse.move(0, 0)
  await expect(page).toHaveScreenshot('files-live-conflict.png', { fullPage: true })

  await runFixtureAction('Live fail next stat')
  await expectLiveStatus('reconnecting')
  await expect(pane.locator('[data-files-live-action="reload-latest"]')).toBeDisabled()
  await expect(pane.locator('[data-files-live-action="replace-file"]')).toBeDisabled()
  await expectLiveStatus('live')

  await pane.locator('[data-files-live-action="reload-latest"]').click()
  await expect(editor).toHaveValue('# Rewritten in the workspace\n')
  await expect(conflict).toHaveCount(0)

  /* Same bytes, new identity. The drive re-writes a file's inode and ctime
     whenever anything touches it, so this is the churn an editor must not
     mistake for someone else's edit: no banner, and the unsaved words stay. */
  await runFixtureAction('Pause next upload')
  const churnDraft = '# Draft through the churn\n'
  await editor.fill(churnDraft)
  await runFixtureAction('Live rewrite Welcome')
  await expect(conflict).toHaveCount(0)
  await expect(editor).toHaveValue(churnDraft)

  const replacement = '# Replace from browser\n'
  await editor.fill(replacement)
  await runFixtureAction('Live update Welcome')
  await expect(conflict).toBeVisible({ timeout: cadenceTimeout })
  await runFixtureAction('Complete upload')
  await expectNoWriteInFlight()
  await pane.locator('[data-files-live-action="replace-file"]').click()
  await expect(editor).toHaveValue(replacement)
  await expect(conflict).toHaveCount(0)
  await expectNoWriteInFlight()
  await expectLiveStatus('live')

  await runFixtureAction('Live fail next stat')
  await expectLiveStatus('reconnecting')
  await editor.blur()
  await page.mouse.move(0, 0)
  await expect(page).toHaveScreenshot('files-live-reconnecting.png', { fullPage: true })
  await expectLiveStatus('live')

  await runFixtureAction('Live delete Welcome')
  await expectLiveStatus('reconnecting')
  await expectLiveStatus('missing')
  await expect(editor).toHaveValue(replacement)
  await expect(editor).toHaveAttribute('readonly', { timeout: cadenceTimeout })
  await expect(paneHeader.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled()
  // A file that is gone takes no writes: nothing autosaves against it.
  await expectNoWriteInFlight()
  await expect(pane.locator('[data-files-live-action="back-to-folder"]')).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(page).toHaveScreenshot('files-live-missing.png', { fullPage: true })

  // Reappearance at the same path recovers the already-open pane. A second
  // deletion then exercises the explicit folder-navigation action.
  await runFixtureAction('Live restore Welcome')
  await expectLiveStatus('updated')
  await expect(editor).not.toHaveValue(replacement)
  await expect(editor).toHaveValue(/workspace/i)
  await runFixtureAction('Live delete Welcome')
  await expectLiveStatus('reconnecting')
  await expectLiveStatus('missing')
  await pane.locator('[data-files-live-action="back-to-folder"]').click()
  await expect(pane).toHaveCount(0)
  await expect(page.locator('[data-files-surface]')).toHaveAttribute('data-files-path', '/')

  await page.getByRole('button', { name: 'brand-assets', exact: true }).click()
  await expectVersionedSourceRefresh({
    open: async () => {
      await page.getByRole('button', { name: 'logo.svg', exact: true }).click()
    },
    source: 'img[alt="logo.svg"]',
    action: 'Live update image',
  })
  // Columns have no up-button: you walk back via the breadcrumb root.
  await page
    .getByRole('navigation', { name: 'Drive path' })
    .getByRole('button', { name: 'Drive' })
    .click()

  await page.getByRole('button', { name: 'exports', exact: true }).click()
  await page.getByRole('button', { name: 'launch-plan.xls', exact: true }).click()
  await expectLiveStatus('live')
  await expect(page.getByRole('cell', { name: 'API docs', exact: true })).toBeVisible()
  await runFixtureAction('Live update spreadsheet')
  await expect(page.getByRole('cell', { name: 'Live refresh', exact: true })).toBeVisible({
    timeout: cadenceTimeout,
  })
  await expectLiveStatus('updated')
  await dismissPreview()

  await page.getByRole('button', { name: 'customer-data.bin', exact: true }).click()
  await expectLiveStatus('live')
  await expect(page.getByText(/00 01 02 03/)).toBeVisible()
  await runFixtureAction('Live update binary')
  await expect(page.getByText(/ff ee dd cc/i)).toBeVisible({ timeout: cadenceTimeout })
  await expectLiveStatus('updated')
  await dismissPreview()
  // Columns have no up-button: you walk back via the breadcrumb root.
  await page
    .getByRole('navigation', { name: 'Drive path' })
    .getByRole('button', { name: 'Drive' })
    .click()

  await expectVersionedSourceRefresh({
    open: async () => {
      await page.getByRole('button', { name: 'product-brief.pdf', exact: true }).click()
    },
    source: 'iframe[title="product-brief.pdf"]',
    action: 'Live update PDF',
  })
  // The existing public PreviewPane path remains one-shot and carries no live
  // controller status or authenticated recovery actions.
  await page.goto('/playground/publish-preview')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await expect(page.getByLabel('File editor')).toHaveCount(2)
  await expect(page.locator('[data-files-live-action]')).toHaveCount(0)
})

test('playground/files is controlled by its router-free path owner', async ({ page }) => {
  await page.goto('/playground/files')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Files scenario: nested-folder' })
    .evaluate(button => (button as HTMLButtonElement).click())

  const surface = page.locator('[data-files-surface]')
  await expect(surface).toHaveAttribute('data-files-path', '/research/notes')
  await expect(page.getByText('deep-link.txt', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('files-nested-folder.png', { fullPage: true })

  // Simulate sync or an agent changing every folder currently represented by
  // the column stack. No mutation flows through FilesSurface, so these rows can
  // appear only when each visible folder's own query refreshes.
  await page
    .getByRole('button', { name: 'Create folders outside the browser' })
    .evaluate(button => (button as HTMLButtonElement).click())
  await expect(page.getByTestId('files-fixture-mutation')).toHaveText('external-folders-created')
  await expect(page.getByText('incoming-root', { exact: true })).toBeVisible({ timeout: 7_000 })
  await expect(page.getByText('uploads', { exact: true })).toBeVisible()
  await expect(page.getByText('evidence', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('files-columns-refreshed.png', { fullPage: true })

  await page.getByLabel('Search this folder…').fill('does-not-match')
  await runDriveAction(page, 'New folder')
  await page.getByLabel('Folder name').fill('created-here')
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByText('Folder created.', { exact: true })).toBeVisible()

  // Up one level, not back to the root: the trail names every ancestor, so the
  // parent is a crumb rather than a single up-button applied repeatedly.
  await page
    .getByRole('navigation', { name: 'Drive path' })
    .getByRole('button', { name: 'research', exact: true })
    .click()
  await expect(surface).toHaveAttribute('data-files-path', '/research')
  await expect(page.getByLabel('Search this folder…')).toHaveValue('')
  await expect(page.getByText('Folder created.', { exact: true })).toHaveCount(0)
  await expect(page.getByTestId('files-fixture-path')).toHaveText('/research')
})

/* Walking the drive is not re-reading it. A folder already listed is served from
   cache the instant you land on it and revalidated behind the picture, so only a
   folder this session has never opened is allowed to show the skeleton. The
   listing is held open across the revisit precisely so a surface that still
   waited on the network would be caught doing it. */
test('playground/files serves a revisited folder from cache while it revalidates', async ({
  page,
}) => {
  await page.goto('/playground/files')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const surface = page.locator('[data-files-surface]')
  const skeleton = page.locator('[data-loading-view="files"]')

  // Warm the root, then walk down. Both listings answer normally.
  await expect(page.getByText('Welcome.md', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'brand-assets', exact: true }).click()
  await expect(surface).toHaveAttribute('data-files-path', '/brand-assets')

  // From here every listing hangs. Walking back up must not wait on one.
  await page
    .getByRole('button', { name: 'Pause next listing' })
    .evaluate(button => (button as HTMLButtonElement).click())
  // Columns have no up-button: you walk back via the breadcrumb root.
  await page
    .getByRole('navigation', { name: 'Drive path' })
    .getByRole('button', { name: 'Drive' })
    .click()

  await expect(surface).toHaveAttribute('data-files-path', '/')
  await expect(page.getByText('Welcome.md', { exact: true })).toBeVisible()
  await expect(skeleton).toHaveCount(0)

  // And the held answer still lands, rather than the cache going unrevalidated.
  await page
    .getByRole('button', { name: 'Complete listing' })
    .evaluate(button => (button as HTMLButtonElement).click())
  await expect(page.getByText('Welcome.md', { exact: true })).toBeVisible()
  await expect(skeleton).toHaveCount(0)
})

test('playground/files recovers missing folders one parent at a time and clamps at root', async ({
  page,
}) => {
  await page.goto('/playground/files')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Files scenario: not-found' })
    .evaluate(button => (button as HTMLButtonElement).click())

  await expect(page.getByTestId('files-fixture-path')).toHaveText('/retired/research')
  await page.getByRole('button', { name: 'Open parent folder' }).click()
  await expect(page.getByTestId('files-fixture-path')).toHaveText('/retired')
  await expect(page.getByRole('heading', { name: 'This folder no longer exists' })).toBeVisible()
  await page.getByRole('button', { name: 'Open parent folder' }).click()
  await expect(page.getByTestId('files-fixture-path')).toHaveText('/')
  await expect(page.getByText('Welcome.md', { exact: true })).toBeVisible()
})

test('playground/files retains malformed route state until explicit root recovery', async ({
  page,
}) => {
  await page.goto('/playground/files')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Files scenario: malformed' })
    .evaluate(button => (button as HTMLButtonElement).click())

  await expect(page.getByTestId('files-fixture-path')).toHaveText('malformed')
  await expect(page.getByRole('heading', { name: 'This folder no longer exists' })).toBeVisible()
  await expect(page.locator('[data-files-surface]')).toHaveAttribute('data-files-path', '/')
  await page.getByRole('button', { name: 'Open parent folder' }).click()
  await expect(page.getByTestId('files-fixture-path')).toHaveText('/')
  await expect(page.getByText('Welcome.md', { exact: true })).toBeVisible()
})

test('playground/files retries a non-404 failure without changing the controlled URL path', async ({
  page,
}) => {
  await page.goto('/playground/files')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Files scenario: load-error' })
    .evaluate(button => (button as HTMLButtonElement).click())

  await expect(page.getByTestId('files-fixture-path')).toHaveText('/research')
  await expect(page.getByText('list_failed', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.locator('[data-files-surface]')).toHaveAttribute('data-files-path', '/research')
  await expect(page.getByTestId('files-fixture-path')).toHaveText('/research')
  await expect(page.getByText('market-notes.txt', { exact: true })).toBeVisible()
})

test('playground/files ignores a stale resolution that completes after a newer path', async ({
  page,
}) => {
  await page.goto('/playground/files')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Files scenario: stale-load' })
    .evaluate(button => (button as HTMLButtonElement).click())
  await expect(page.getByTestId('files-fixture-path')).toHaveText('/slow')

  await page
    .getByRole('button', { name: 'Navigate fixture: /fast' })
    .evaluate(button => (button as HTMLButtonElement).click())
  await expect(page.locator('[data-files-surface]')).toHaveAttribute('data-files-path', '/fast')
  await expect(page.getByText('fresh.txt', { exact: true })).toBeVisible()

  await page
    .getByRole('button', { name: 'Release stale resolution' })
    .evaluate(button => (button as HTMLButtonElement).click())
  await expect(page.getByText('fresh.txt', { exact: true })).toBeVisible()
  await expect(page.getByText('stale.txt', { exact: true })).toHaveCount(0)
  await expect(page.locator('[data-files-surface]')).toHaveAttribute('data-files-path', '/fast')
})

test('playground/files opens a dotfile folder without enabling hidden rows', async ({ page }) => {
  await page.goto('/playground/files')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Files scenario: dotfile-folder' })
    .evaluate(button => (button as HTMLButtonElement).click())

  await expect(page.locator('[data-files-surface]')).toHaveAttribute('data-files-path', '/.vault')
  await expect(page.getByRole('navigation', { name: 'Drive path' })).toContainText('.vault')
  await expect(page.getByText('.secret', { exact: true })).toHaveCount(0)
  // Hiding a dotfile does not empty its folder: `.vault` holds `.secret`, so the
  // column may not claim "Empty folder" while that row is merely filtered out.
  await expect(page.getByText('Empty folder', { exact: true })).toHaveCount(0)
  await expect(page).toHaveScreenshot('files-dotfile-folder.png', { fullPage: true })

  await runDriveAction(page, 'Show hidden files', { stayOpen: true })
  await expect(page.getByText('.secret', { exact: true })).toBeVisible()
})

test('playground/files binds the preview lightbox to its router-free history owner', async ({
  page,
}) => {
  await page.goto('/playground/files')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Files scenario: deep-file' })
    .evaluate(button => (button as HTMLButtonElement).click())

  const preview = page.locator('[data-files-preview]')
  await expect(page.getByTestId('files-fixture-path')).toHaveText('/research/notes/deep-link.txt')
  await expect(preview).toBeVisible()
  // Whether the document stands beside its column or holds the whole region is
  // the surface's business and is measured elsewhere. What the deep link has to
  // prove is that the document it addressed is the one that opened.
  await expect(
    page.locator('[data-files-preview-header]').getByRole('heading', { name: 'deep-link.txt' }),
  ).toBeVisible()
  await expect(page.getByText('This folder was opened directly from a durable URL.')).toBeVisible()
  await expect(page).toHaveScreenshot('files-deep-file.png', { fullPage: true })

  await page.keyboard.press('Escape')
  await expect(preview).toHaveCount(0)
  await expect(page.getByTestId('files-fixture-path')).toHaveText('/research/notes')

  await page
    .getByRole('button', { name: 'Files fixture Back' })
    .evaluate(button => (button as HTMLButtonElement).click())
  await expect(preview).toBeVisible()
  // A document is left, not closed — it was never a dialog.
  await page.getByRole('button', { name: 'Back to folder' }).click()
  await expect(page.getByTestId('files-fixture-path')).toHaveText('/research/notes')

  await page.getByRole('button', { name: 'deep-link.txt', exact: true }).click()
  await expect(page.getByTestId('files-fixture-path')).toHaveText('/research/notes/deep-link.txt')
  // No backdrop to click away: a takeover has nothing behind it to dismiss it
  // with. Leaving is the document's own control, and the deep link's claim is
  // that leaving lands back on the folder it addressed.
  await page.getByRole('button', { name: 'Back to folder' }).click()
  await expect(preview).toHaveCount(0)
  await expect(page.getByTestId('files-fixture-path')).toHaveText('/research/notes')

  await page
    .getByRole('button', { name: 'Files fixture Back' })
    .evaluate(button => (button as HTMLButtonElement).click())
  await expect(preview).toBeVisible()
})

/* A document is not a different place, it is a deeper selection in the same one.

   Opening a file used to replace the whole browser region — toolbar, breadcrumb
   and every column at once — which is the right answer only when there is no
   room for anything else. Given room, the stack slides left until the column the
   file was opened from is the one standing in the rail, and the document takes
   the width that frees up. The ancestors are pushed off the left edge rather
   than thrown away, so walking back up is a scroll and not a re-navigation.

   Measured rather than eyeballed: a screenshot proves a document is on screen,
   but only geometry can say the *deepest* column is the one left standing and
   that its ancestors are still behind it. */
test('playground/files stands a document beside the column it was opened from', async ({
  page,
}) => {
  test.skip(
    (page.viewportSize()?.width ?? 0) < 768,
    'a column and a readable document need room this viewport does not have',
  )
  await page.goto('/playground/files')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Files scenario: deep-file' })
    .evaluate(button => (button as HTMLButtonElement).click())

  const preview = page.locator('[data-files-preview]')
  await expect(
    page.locator('[data-files-preview-header]').getByRole('heading', { name: 'deep-link.txt' }),
  ).toBeVisible()

  // The listing the file was opened from is still a listing: its columns, the
  // breadcrumb that says where they are, and the toolbar that sorts them.
  const scroller = page.locator('[data-drive-columns]')
  await expect(scroller).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Drive path' })).toBeVisible()
  const columns = page.locator('[data-drive-column]')
  // `/`, `/research`, `/research/notes` — the file is a row in the last of them.
  await expect(columns).toHaveCount(3)

  const [rail, deepest, shallowest, document_] = await Promise.all([
    scroller.boundingBox(),
    columns.last().boundingBox(),
    columns.first().boundingBox(),
    preview.boundingBox(),
  ])
  for (const box of [rail, deepest, shallowest, document_]) expect(box).not.toBeNull()

  // The deepest column is the one standing in the rail, whole.
  expect(deepest!.x).toBeGreaterThanOrEqual(rail!.x - 1)
  expect(deepest!.x + deepest!.width).toBeLessThanOrEqual(rail!.x + rail!.width + 1)
  // Its ancestors are off the left edge — pushed, not destroyed.
  expect(shallowest!.x + shallowest!.width).toBeLessThanOrEqual(rail!.x + 1)
  // And the document has the room the stack gave up, which is most of it.
  expect(document_!.x).toBeGreaterThanOrEqual(rail!.x + rail!.width - 1)
  expect(document_!.width).toBeGreaterThan(rail!.width)

  await expect(page).toHaveScreenshot('files-document-beside-columns.png', { fullPage: true })
})

/* Geometry pins the real failure: a takeover document that stops above or runs
   beyond the browser region leaves some of its editor unreachable. */
test('playground/files gives a takeover document the full height of the region', async ({
  page,
}) => {
  // Narrow enough that the document takes the region over instead of standing
  // beside its column, tall enough that a short file cannot fill it by luck.
  await page.setViewportSize({ width: 640, height: 820 })
  await page.goto('/playground/files')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Files scenario: deep-file' })
    .evaluate(button => (button as HTMLButtonElement).click())

  await expect(page.locator('[data-files-preview]')).toBeVisible()
  await expect(page.locator('[data-files-editor]')).toBeVisible()

  const bottomOf = async (selector: string) =>
    await page
      .locator(selector)
      .first()
      .evaluate(element => element.getBoundingClientRect().bottom)
  const surfaceBottom = await bottomOf('[data-files-surface]')
  const bodyBottom = await bottomOf('[data-files-preview-body]')
  expect(Math.abs(surfaceBottom - bodyBottom)).toBeLessThanOrEqual(1)
})

test('playground/files reveals the deepest column on an initial folder deep link', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  await page.goto('/playground/files')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Files scenario: nested-folder' })
    .evaluate(button => (button as HTMLButtonElement).click())

  await expect(page.getByTestId('files-fixture-path')).toHaveText('/research/notes')
  const scroller = page.locator('[data-drive-columns]')
  const deepest = page.locator('[data-drive-column]').last()
  await page.setViewportSize({ width: 390, height: 844 })

  /* A deep URL names the folder the reader came to see. Its listing must be
     visible on arrival even when the viewport cannot fit all of its ancestors.

     Polled rather than measured once: narrowing the viewport re-lays the
     columns out *and* scrolls the deepest one back into view, and neither is
     synchronous — a single read in the same tick as the resize catches the
     scroller mid-flight and compares a column that is still travelling. */
  await expect
    .poll(async () => {
      const [viewport, column] = await Promise.all([scroller.boundingBox(), deepest.boundingBox()])
      if (viewport === null || column === null) return false
      return Math.abs(column.x - viewport.x) < 1 && Math.abs(column.width - viewport.width) < 1
    })
    .toBe(true)
  expect(
    await deepest.getByText('deep-link.txt', { exact: true }).evaluate(name => {
      return name.scrollWidth <= name.clientWidth
    }),
  ).toBe(true)
})

test('playground/files replaces a deleted addressed file with its parent on refresh', async ({
  page,
}) => {
  await page.goto('/playground/files')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Files scenario: deep-file' })
    .evaluate(button => (button as HTMLButtonElement).click())
  await expect(page.locator('[data-files-preview]')).toBeVisible()

  await page
    .locator('button', { hasText: 'Delete addressed fixture file' })
    .evaluate(button => (button as HTMLButtonElement).click())
  await expect(page.getByTestId('files-fixture-mutation')).toHaveText('deleted')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'refresh-trigger.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('refresh'),
  })

  await expect(page.locator('[data-files-preview]')).toHaveCount(0)
  await expect(page.getByTestId('files-fixture-path')).toHaveText('/research/notes')
  await expect(page.getByTestId('files-fixture-history')).toHaveText('1/1')
  await expect(page.getByText('refresh-trigger.txt', { exact: true })).toBeVisible()
})

test('playground/files leaves a cold missing file URL in not-found recovery', async ({ page }) => {
  await page.goto('/playground/files')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Files scenario: missing-file' })
    .evaluate(button => (button as HTMLButtonElement).click())

  await expect(page.getByTestId('files-fixture-path')).toHaveText('/research/notes/missing.txt')
  await expect(page.getByRole('heading', { name: 'This folder no longer exists' })).toBeVisible()
  await expect(page.locator('[data-files-preview]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Open parent folder' }).click()
  await expect(page.getByTestId('files-fixture-path')).toHaveText('/research/notes')
  await expect(page.getByText('deep-link.txt', { exact: true })).toBeVisible()
})

test('playground/files previews an addressed dotfile while hidden rows stay off', async ({
  page,
}) => {
  await page.goto('/playground/files')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Files scenario: dotfile-file' })
    .evaluate(button => (button as HTMLButtonElement).click())

  await expect(page.getByTestId('files-fixture-path')).toHaveText('/.env')
  await expect(page.locator('[data-files-preview]')).toBeVisible()
  // The show-hidden toggle lives in the control strip, which a document takes
  // over along with the rest of the browser region. What still holds while the
  // dotfile is open is that its folder is not listing it behind the document.
  await expect(page.locator('[data-files-card]', { hasText: '.env' })).toHaveCount(0)
  await expect(page.getByText(/44 55 45 54 5f 4d 4f 44/)).toBeVisible()
  await expect(page).toHaveScreenshot('files-dotfile-file.png', { fullPage: true })
})

test('playground/files keeps literal percent and encoded-slash names exact end to end', async ({
  page,
}) => {
  await page.goto('/playground/files')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Files scenario: nested-folder' })
    .evaluate(button => (button as HTMLButtonElement).click())

  for (const [name, path] of [
    ['100%.txt', '/research/notes/100%.txt'],
    ['a%2Fb.txt', '/research/notes/a%2Fb.txt'],
  ] as const) {
    await page.getByRole('button', { name, exact: true }).click()
    await expect(page.getByTestId('files-fixture-path')).toHaveText(path)
    await expect(page.locator('[data-files-preview]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('files-fixture-path')).toHaveText('/research/notes')
  }
})

test('playground/files renders the complete app-folder state matrix', async ({ page }) => {
  await page.goto('/playground/files')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Files scenario: apps', exact: true })
    .evaluate(button => (button as HTMLButtonElement).click())

  for (const [name, status] of [
    ['hello', 'reconciled'],
    ['reconciling-lab', 'reconciling'],
    ['failed-runtime', 'failed'],
    ['broken-folder', 'broken'],
    ['disabled-replica', 'disabled'],
  ] as const) {
    await expect(
      page.locator(`[data-files-card][data-app-status="${status}"]`, { hasText: name }),
    ).toBeVisible()
  }
  await expect(page.getByLabel('hello, App is running')).toBeVisible()
  const validIconCard = page.locator('[data-files-card="app"]', { hasText: 'Launch Control' })
  await expect(validIconCard.locator('img')).toHaveCount(1)
  const missingIconCard = page.locator('[data-files-card="app"]', { hasText: 'failed-runtime' })
  await expect(missingIconCard.locator('img')).toHaveCount(0)
  await expect(missingIconCard.locator('svg').first()).toBeVisible()
  await expect(
    page.locator('[data-files-card="app"]', { hasText: 'reconciling-lab' }).locator('img'),
  ).toHaveCount(0)
  /* No row at all. The listing IS the row set: an app whose folder is not in it
     contributes nothing, where the drive used to synthesize a row so a
     permanently stranded app stayed reachable. `broken-folder` above is the
     state that still draws — a folder that is there but unidentifiable. */
  await expect(page.getByRole('button', { name: /^orphaned-app/ })).toHaveCount(0)
  await expect(
    page.locator('[data-files-card="folder"]', { hasText: 'normal-folder' }),
  ).toBeVisible()
  await expect(page.locator('[data-files-card="document"]', { hasText: 'readme.md' })).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(page).toHaveScreenshot('files-apps.png', { fullPage: true })

  await page.getByLabel('Actions for hello').click()
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  await expect(page.getByLabel('New name')).toHaveValue('hello')
  await expect(page.getByLabel('New name')).not.toHaveValue('Launch Control')
  await page.keyboard.press('Escape')

  await page
    .getByRole('button', { name: 'Files scenario: apps-es' })
    .evaluate(button => (button as HTMLButtonElement).click())
  await expect(page.getByText('Launch Control', { exact: true })).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(page).toHaveScreenshot('files-apps-spanish.png', { fullPage: true })

  await page
    .getByRole('button', { name: 'Files scenario: apps', exact: true })
    .evaluate(button => (button as HTMLButtonElement).click())

  await page
    .getByRole('button', { name: 'Fail next delete' })
    .evaluate(button => (button as HTMLButtonElement).click())
  await page.getByLabel('Actions for hello').click()
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await expect(
    page.getByRole('navigation', { name: 'Drive path' }).getByRole('button', { name: 'hello' }),
  ).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Delete the hello folder?' })).toBeVisible()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await expect(page).toHaveScreenshot('files-origin-app-delete.png', { fullPage: true })
  /* A failed delete is a failed delete, with nothing half-done behind it. Files
     removes the folder and only the folder — the app row follows from the anchor
     rail once the folder is gone — so there is no unlinked-app-without-its-folder
     state to report, and no second button to finish the job. The folder is still
     there, and asking again is the whole recovery. */
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'delete_failed' })).toBeVisible()
  await expect(page.getByLabel('hello, App is running')).toBeVisible()

  await page.getByLabel('Actions for hello').click()
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByText('hello', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Deleted.', { exact: true })).toBeVisible()
  await page.getByRole('status').getByRole('button', { name: '×' }).click()

  await page.getByLabel('Actions for disabled-replica').click()
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Delete shared app folder?' })).toBeVisible()
  await expect(page.getByText(/Duet will remove the replica app automatically/)).toBeVisible()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await expect(page).toHaveScreenshot('files-replica-app-delete.png', { fullPage: true })
  await page.keyboard.press('Escape')
})

test('playground/files-app-continuation keeps app folders visible across a failed lazy continuation', async ({
  page,
}) => {
  await page.goto('/playground/files-app-continuation')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await expect(page.getByLabel('hello, App is running')).toBeVisible()
  await expect(page.getByRole('button', { name: 'page-two-dashboard', exact: true })).toBeVisible()
  await expect(page.getByText('8 loaded', { exact: true })).toBeVisible()
  await expect(page.getByText('More app details', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Load more', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
  await expect(page.getByText('Couldn’t load app details', { exact: true })).toBeVisible()
  await expect(page.getByLabel('hello, App is running')).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(page).toHaveScreenshot('files-apps-continuation-error.png', { fullPage: true })

  await page
    .getByRole('button', { name: 'Allow app continuation', exact: true })
    .evaluate(button => (button as HTMLButtonElement).click())
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(page.getByLabel('page-two-dashboard, App is running')).toBeVisible()
  await expect(page.getByText('8 items', { exact: true })).toBeVisible()
  await page.getByLabel('page-two-dashboard, App is running').click()
  await expect(page.getByText('App navigation: app page-two-dashboard')).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(page).toHaveScreenshot('files-apps-page-two.png', { fullPage: true })
})

test('playground/files routes every app row into the product app view', async ({ page }) => {
  await page.goto('/playground/files')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Files scenario: apps', exact: true })
    .evaluate(button => (button as HTMLButtonElement).click())

  /* The drive hands over the *app*, not a route: where an app opens needs the
     agent roster to say whose it is, and a file browser has no business holding
     that. So the row reports the app it activated and the host decides. */
  for (const [label, slug] of [
    ['hello, App is running', 'hello'],
    ['reconciling-lab, App is starting', 'reconciling-lab'],
    ['failed-runtime, App runtime needs attention', 'failed-runtime'],
    ['broken-folder, App folder link needs repair', 'broken-folder'],
    ['disabled-replica, App is disabled', 'disabled-replica'],
  ] as const) {
    await page.getByRole('button', { name: label }).click()
    await expect(page.getByText(`App navigation: app ${slug}`)).toBeAttached()
  }
})

test('playground/files gives app rows keyboard parity with click', async ({ page }) => {
  await page.goto('/playground/files')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Files scenario: apps', exact: true })
    .evaluate(button => (button as HTMLButtonElement).click())

  /* Parity means the same report, not merely some report: a row hands over the
     app it activated — the slug, not a route — exactly as the click path above
     does, so both paths assert the identical text. */
  await page.getByRole('button', { name: 'hello, App is running' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText('App navigation: app hello')).toBeAttached()

  await page.getByRole('button', { name: 'broken-folder, App folder link needs repair' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText('App navigation: app broken-folder')).toBeAttached()
})

test('playground/files opens an app only once on double-click', async ({ page }) => {
  await page.goto('/playground/files')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Files scenario: apps', exact: true })
    .evaluate(button => (button as HTMLButtonElement).click())

  await page.getByRole('button', { name: 'hello, App is running' }).dblclick()
  await expect(page.getByText('App navigation count: 1')).toBeAttached()
})

test('playground/files app menu opens the folder without launching it', async ({ page }) => {
  await page.goto('/playground/files')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Files scenario: apps', exact: true })
    .evaluate(button => (button as HTMLButtonElement).click())

  await page.getByRole('button', { name: 'Actions for broken-folder' }).click()
  await page.getByRole('menuitem', { name: 'Open folder' }).click()
  await expect(page.getByRole('navigation', { name: 'Drive path' })).toContainText('broken-folder')
  await expect(page.getByText('App navigation:')).toHaveText('App navigation:')
})

test('playground/share-dialog opens the folder-only dialog from the Files card menu', async ({
  page,
}) => {
  await page.goto('/playground/share-dialog')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page.getByLabel('Actions for launch').click()
  await page.getByRole('menuitem', { name: 'Share' }).click()
  await expect(page.getByRole('dialog')).toHaveAttribute('data-share-dialog', 'launch')
  await expect(page.getByRole('heading', { name: 'Share “launch”' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await page.getByLabel('Actions for readme.md').click()
  await expect(page.getByRole('menuitem', { name: 'Share' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByLabel('Actions for shared-app').click()
  await expect(page.getByRole('menuitem', { name: 'Share' })).toHaveCount(0)
})

test('playground/share-dialog captures the complete invitation state matrix', async ({ page }) => {
  const loadFixture = async (query = '') => {
    await page.goto(`/playground/share-dialog${query}`)
    await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
    await settleInitialFilesView(page)
  }
  const openFromMenu = async (name: string) => {
    await page.getByLabel(`Actions for ${name}`).click()
    await page.getByRole('menuitem', { name: 'Share' }).click()
  }
  const setResponse = async (mode: 'submitting' | 'duplicate' | 'cap') => {
    await page
      .getByRole('button', { name: `Share response: ${mode}` })
      .evaluate(button => (button as HTMLButtonElement).click())
  }
  const submit = async () => {
    await page.getByLabel('Recipient email').fill('teammate@example.com')
    await page.getByRole('button', { name: 'Send invitation' }).click()
  }

  await loadFixture('?apps=paged')
  await page.getByLabel('Actions for launch').click()
  await expect(page).toHaveScreenshot('share-dialog-row-entry.png', { fullPage: true })
  await page.getByRole('menuitem', { name: 'Share' }).click()
  await expect(page.getByText('launch-dashboard', { exact: true })).toBeVisible()
  await expect(page.getByText('launch-reports', { exact: true })).toHaveCount(0)
  await expect(
    page.getByText('More apps may be included below. Loaded apps are only part of this folder.'),
  ).toBeVisible()
  await expect(page).toHaveScreenshot('share-dialog-apps-preview.png', { fullPage: true })
  await page.getByRole('button', { name: 'Load more apps' }).click()
  await expect(page.getByText('launch-reports', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Load more apps' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await loadFixture()

  await openFromMenu('empty-folder')
  await expect(page.getByText('No apps are included in this folder.')).toBeVisible()
  await expect(page).toHaveScreenshot('share-dialog-default.png', { fullPage: true })
  await page.getByText('Advanced', { exact: true }).click()
  await page.getByLabel('Extra ignore patterns').fill('.env\nprivate/**')
  await expect(page.getByRole('button', { name: 'Send invitation' })).toBeVisible()
  await expect(page).toHaveScreenshot('share-dialog-advanced.png', { fullPage: true })

  await loadFixture()
  await setResponse('submitting')
  await openFromMenu('launch')
  await submit()
  await expect(page.getByRole('button', { name: 'Sending…' })).toBeDisabled()
  await expect(page).toHaveScreenshot('share-dialog-submitting.png', { fullPage: true })

  await loadFixture()
  await setResponse('duplicate')
  await openFromMenu('launch')
  await submit()
  await expect(page.getByRole('alert')).toContainText('already shared')
  await expect(page).toHaveScreenshot('share-dialog-duplicate-error.png', { fullPage: true })

  await loadFixture()
  await setResponse('cap')
  await openFromMenu('launch')
  await submit()
  await expect(page.getByRole('alert')).toContainText('share-email limit')
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send invitation' })).toBeDisabled()
  await expect(page).toHaveScreenshot('share-dialog-cap-error.png', { fullPage: true })
})

test('playground/internal-admin credit adjustment waits, clears on success, and retries failures', async ({
  page,
}) => {
  const amounts: number[] = []
  await page.exposeFunction('recordCreditAmount', (amount: number) => amounts.push(amount))
  await page.addInitScript(() => {
    window.addEventListener('playground-credit-request', event => {
      void (
        window as unknown as { recordCreditAmount(amount: number): Promise<void> }
      ).recordCreditAmount((event as CustomEvent<{ amountMicroUsd: number }>).detail.amountMicroUsd)
    })
  })
  const finishRequest = (success: boolean) =>
    page.evaluate(value => {
      window.dispatchEvent(new CustomEvent('playground-credit-response', { detail: value }))
    }, success)
  await page.goto('/playground/internal-admin?controlled-credit=1')
  await page.getByRole('button', { name: /Acme Studio/ }).click()
  const panel = page.getByRole('heading', { name: 'Manual credit adjustment' }).locator('..')
  const amount = panel.getByRole('textbox')
  const apply = panel.getByRole('button', { name: 'Apply', exact: true })
  await amount.fill('-20')
  await apply.click()
  await expect.poll(() => amounts).toEqual([-20_000_000])
  await expect(apply).toBeDisabled()
  await expect(apply).toHaveAttribute('aria-busy', 'true')
  await expect(amount).toBeDisabled()
  await expect(amount).toHaveValue('-20')
  await expect(panel).toHaveScreenshot('internal-admin-credit-pending.png')
  await finishRequest(true)
  await expect(amount).toHaveValue('')
  await expect(amount).toBeEnabled()
  await expect(apply).toBeDisabled()
  await expect(panel).toHaveScreenshot('internal-admin-credit-success.png')

  await amount.fill('12.50')
  await apply.click()
  await expect.poll(() => amounts).toEqual([-20_000_000, 12_500_000])
  await finishRequest(false)
  await expect(apply).toBeEnabled()
  await expect(amount).toHaveValue('12.50')
  await apply.click()
  await expect.poll(() => amounts).toEqual([-20_000_000, 12_500_000, 12_500_000])
  await finishRequest(true)
  await expect(amount).toHaveValue('')
})

test('playground/internal-admin-payer restores a payer through failure and retry', async ({
  page,
}) => {
  await page.goto('/playground/internal-admin?paused=1&controlled-payer=1')
  await page.getByRole('button', { name: /Acme Studio/ }).click()
  const controls = page.getByRole('heading', { name: 'Service controls' }).locator('..')
  const select = controls.getByLabel('New payer')
  const save = controls.getByRole('button', { name: 'Change payer', exact: true })
  await expect(save).toBeDisabled()
  await expect(select.locator('option')).toHaveText([
    'Choose another owner',
    'Morgan Reed — billing@acme.test',
  ])
  await select.selectOption('user_billing_owner')
  await expect(controls).toHaveScreenshot('internal-admin-payer.png')
  const requests: unknown[] = []
  await page.exposeFunction('recordPayerRequest', (input: unknown) => {
    requests.push(input)
  })
  await page.evaluate(() =>
    window.addEventListener('playground-payer-request', event => {
      void (
        window as unknown as { recordPayerRequest(input: unknown): Promise<void> }
      ).recordPayerRequest((event as CustomEvent).detail)
    }),
  )
  const finish = (success: boolean) =>
    page.evaluate(value => {
      window.dispatchEvent(new CustomEvent('playground-payer-response', { detail: value }))
    }, success)
  await save.click()
  await expect.poll(() => requests.length).toBe(1)
  await expect(select).toBeDisabled()
  await expect(save).toBeDisabled()
  await finish(false)
  await expect(save).toBeEnabled()
  await expect(select).toHaveValue('user_billing_owner')
  await expect(controls.getByText('Current payer: owner@acme.test', { exact: true })).toBeVisible()
  await save.click()
  await expect.poll(() => requests.length).toBe(2)
  expect(requests[0]).toMatchObject({ operation: 'payer', newBillingUserId: 'user_billing_owner' })
  expect(requests[1]).toEqual(requests[0])
  await finish(true)
  await expect(
    controls.getByText('Current payer: billing@acme.test', { exact: true }),
  ).toBeVisible()
  await expect(page.getByText('Active', { exact: true })).toBeVisible()
  await expect(save).toBeDisabled()
  await expect(select).toHaveValue('')
})

test('playground/internal-admin unpauses servicing independently of suspension', async ({
  page,
}) => {
  await page.goto('/playground/internal-admin?paused=1')
  await page.getByRole('button', { name: /Acme Studio/ }).click()
  const controls = page.getByRole('heading', { name: 'Service controls' }).locator('..')
  await expect(
    controls.getByRole('button', { name: 'Suspend workspace', exact: true }),
  ).toBeEnabled()
  await expect(controls).toHaveScreenshot('internal-admin-paused-controls.png')
  await controls.getByRole('button', { name: 'Unpause workspace', exact: true }).click()
  await expect(
    controls.getByRole('button', { name: 'Unpause workspace', exact: true }),
  ).toHaveCount(0)
  await expect(page.getByText('Active', { exact: true })).toBeVisible()
  await expect(
    controls.getByRole('button', { name: 'Suspend workspace', exact: true }),
  ).toBeEnabled()
})

test('playground/internal-admin exemption activates a paused workspace', async ({ page }) => {
  await page.goto('/playground/internal-admin?paused=1&exempt=1')
  await page.getByRole('button', { name: /Acme Studio/ }).click()
  const controls = page.getByRole('heading', { name: 'Service controls' }).locator('..')
  const exemption = controls.getByRole('switch', { name: 'Servicing exemption' })
  await expect(exemption).toBeChecked()
  await expect(page.getByText('Active', { exact: true })).toBeVisible()
  await expect(
    controls.getByRole('button', { name: 'Unpause workspace', exact: true }),
  ).toHaveCount(0)
  await exemption.click()
  await expect(exemption).not.toBeChecked()
})

test('playground/internal-admin suspends and resumes with one click', async ({ page }) => {
  await page.goto('/playground/internal-admin')
  await page.getByRole('button', { name: /Acme Studio/ }).click()
  await expect(page.getByPlaceholder(/unlock suspension/)).toHaveCount(0)
  await page.getByRole('button', { name: 'Suspend workspace', exact: true }).click()
  await page.getByRole('button', { name: 'Resume workspace', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Suspend workspace', exact: true })).toBeEnabled()
})

test('playground/internal-admin-shell shows operator tools inside account navigation', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]')
  await page.getByRole('button', { name: 'Account and settings' }).click()
  await page.getByRole('menuitem', { name: 'Internal admin', exact: true }).click()
  await expect(destinationHeading(page, 'Internal admin')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Create a user' })).toBeVisible()
  await expect(page).toHaveScreenshot('spa-shell-internal-admin.png', { fullPage: true })
  await page.getByRole('button', { name: 'Account and settings' }).click()
  await expect(page).toHaveScreenshot('spa-shell-account-menu.png', { fullPage: true })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Switch workspace' }).click()
  if ((page.viewportSize()?.width ?? 0) >= 768) {
    await expect(page).toHaveScreenshot('spa-shell-workspace-switcher.png', { fullPage: true })
  }
  await page.keyboard.press('Escape')
  await expect(page.getByRole('region', { name: 'Create a user' })).toHaveScreenshot(
    'internal-admin-shell-form.png',
  )
})

test('playground/internal-admin creates users and recovers from duplicate emails', async ({
  page,
}) => {
  await page.goto('/playground/internal-admin')
  await page.waitForSelector('body[data-playground-ready="true"]')
  const form = page.getByRole('region', { name: 'Create a user' })
  await form.getByLabel('Email address').fill('owner@acme.test')
  await form.getByRole('button', { name: 'Create user' }).click()
  await expect(form.getByRole('alert')).toContainText('already exists')
  await form.getByLabel('Email address').fill('new@example.com')
  await form.getByRole('button', { name: 'Create user' }).click()
  await expect(form.getByRole('status')).toContainText('new@example.com')
  await expect(form.getByLabel('Email address')).toHaveValue('')
  await expect(page).toHaveScreenshot('internal-admin-create-user.png', { fullPage: true })
  await form.getByRole('button', { name: 'Find their workspace' }).click()
  await expect(page.getByRole('button', { name: /New Workspace/ })).toBeVisible()
  await expect(page.getByLabel('Workspace search')).toHaveValue('new@example.com')
})

test('playground/internal-admin shows queued backup acceptance and a retrievable failure', async ({
  page,
}) => {
  await page.goto('/playground/internal-admin')
  await page.waitForSelector('body[data-playground-ready="true"]')
  await page.getByRole('button', { name: /Acme Studio/ }).click()
  await page.getByRole('button', { name: /VM, gateway, files/ }).click()
  await page.getByRole('button', { name: 'Archive VM now', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Backup backup_acme_042 accepted')
  await expect(page.getByRole('button', { name: 'Refresh backup status' })).toBeEnabled()
  await expect(page).toHaveScreenshot('internal-admin-backup-pending.png', { fullPage: true })
  await page.getByRole('button', { name: 'Refresh backup status' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Backup backup_acme_042' })).toContainText(
    'Drive capture was interrupted',
  )
  await expect(page.getByRole('alert').filter({ hasText: 'Backup backup_acme_042' })).toContainText(
    'did not complete',
  )
  await expect(page).toHaveScreenshot('internal-admin-backup-failed.png', { fullPage: true })
})

test('playground/internal-admin-inference compares total billing with known gateway costs', async ({
  page,
}) => {
  await page.goto('/playground/internal-admin')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  const scenario = scenarioSwitch(page, 'Admin scenario')
  await scenario('inference')
  await expect(page.getByRole('heading', { name: 'Inference cost vs. billed' })).toBeVisible()
  // The newest period opens split by tier; the below-cost model is flagged red.
  await expect(page.getByRole('button', { name: 'Hide tiers for 2026-09-17' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'anthropic/claude-fable-5.1' })).toBeVisible()
  await expect(page.getByRole('cell', { name: '-$31.10' })).toBeVisible()
  const routedRow = page
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: 'configured_upstream', exact: true }) })
  await expect(routedRow.getByRole('cell', { name: '$0.00', exact: true })).toBeVisible()
  await expect(routedRow.getByRole('cell', { name: '$3.00', exact: true })).toHaveCount(2)
  await expect(page).toHaveScreenshot('internal-admin-inference.png', { fullPage: true })
  // The current window has nothing newer; paging back reaches an empty window
  // that pages forward to today again.
  await expect(page.getByRole('button', { name: 'Newer' })).toBeDisabled()
  await page.getByRole('button', { name: 'Older' }).click()
  await expect(page.getByText('2026-07-20 – 2026-08-18')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'No settled model calls' })).toBeVisible()
  await page.getByRole('button', { name: 'Newer' }).click()
  await expect(page.getByText('2026-08-19 – 2026-09-17')).toBeVisible()
})

test('playground/internal-admin-model-router edits and saves ordered rules', async ({ page }) => {
  await page.addInitScript(() => {
    window.addEventListener('playground-router-request', event => {
      ;(window as unknown as { routerSaveInput: unknown }).routerSaveInput = (
        event as CustomEvent
      ).detail
    })
  })
  await page.goto('/playground/internal-admin?controlled-router=1')
  await scenarioSwitch(page, 'Admin scenario')('model-router')
  const editor = page.getByTestId('model-router-policy')
  await expect(editor.getByLabel('Model pattern')).toHaveValue('openai/*')
  await editor.getByRole('button', { name: 'Add route', exact: true }).click()
  const second = editor.getByRole('group', { name: 'Route 2', exact: true })
  await second.getByLabel('Model pattern', { exact: true }).fill('anthropic/*')
  await second.getByLabel('Endpoint URL', { exact: true }).fill('https://second.example')
  await second.getByLabel('Header value 1', { exact: true }).fill('Bearer second-secret')
  await second.getByRole('button', { name: 'Move route up', exact: true }).click()
  await expect(editor.getByLabel('Model pattern', { exact: true }).first()).toHaveValue(
    'anthropic/*',
  )
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled()
  await expect(editor.getByLabel('Model pattern', { exact: true }).first()).toBeDisabled()
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
  await expect(editor).toHaveScreenshot('internal-admin-model-router-saving.png')
  const saved = await page.evaluate(() => {
    const state = (window as unknown as { routerSaveInput: unknown }).routerSaveInput
    window.dispatchEvent(new CustomEvent('playground-router-response', { detail: true }))
    return state
  })
  expect(saved).toMatchObject({
    rules: [
      {
        modelGlob: 'anthropic/*',
        baseUrl: 'https://second.example',
        headers: [{ name: 'authorization', value: 'Bearer second-secret' }],
      },
      { modelGlob: 'openai/*', headers: [{ name: 'authorization', value: 'Bearer route-secret' }] },
    ],
  })
  await expect(editor.getByText('Saved with audit provenance.', { exact: true })).toBeVisible()
  await editor.getByLabel('Model pattern', { exact: true }).first().fill('anthropic/claude-*')
  await expect(editor.getByText('Saved with audit provenance.', { exact: true })).toHaveCount(0)
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
  await expect(editor).toHaveScreenshot('internal-admin-model-router.png')
  await editor.getByText('Advanced JSON preview', { exact: true }).click()
  const download = page.waitForEvent('download')
  await editor
    .getByRole('button', { name: 'Export JSON (includes header values)', exact: true })
    .click()
  const exported = await download
  const stream = await exported.createReadStream()
  let json = ''
  for await (const chunk of stream!) json += chunk.toString()
  expect(JSON.parse(json)).toMatchObject([
    {
      modelGlob: 'anthropic/claude-*',
      headers: [{ name: 'authorization', value: 'Bearer second-secret' }],
    },
    { modelGlob: 'openai/*' },
  ])
  await editor.getByLabel('Import rules (JSON)', { exact: true }).fill('invalid')
  await editor.getByRole('button', { name: 'Apply JSON to draft', exact: true }).click()
  await expect(
    editor.getByText('Enter a valid array of routing rules. Your current draft is unchanged.', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(editor.getByLabel('Model pattern', { exact: true }).first()).toHaveValue(
    'anthropic/claude-*',
  )
  await editor.getByLabel('Import rules (JSON)', { exact: true }).fill(
    JSON.stringify([
      {
        id: 'imported',
        enabled: false,
        modelGlob: 'openai/gpt-*',
        baseUrl: 'https://imported.example',
        headers: [{ name: 'x-api-key', value: 'imported-key' }],
      },
    ]),
  )
  await editor.getByRole('button', { name: 'Apply JSON to draft', exact: true }).click()
  await expect(editor.getByLabel('Model pattern', { exact: true })).toHaveValue('openai/gpt-*')
  await expect(editor.getByLabel('Route enabled', { exact: true })).not.toBeChecked()
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled()
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('playground-router-response', { detail: false })),
  )
  await expect(editor.getByText('The change was not applied.', { exact: true })).toBeVisible()
  await expect(editor.getByLabel('Header value 1', { exact: true })).toHaveValue('imported-key')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled()
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('playground-router-response', { detail: true })),
  )
  await expect(editor.getByText('Saved with audit provenance.', { exact: true })).toBeVisible()
})

test('playground/internal-admin covers workspace operations, VM tooling, triage, credits, and states', async ({
  page,
}) => {
  await page.goto('/playground/internal-admin')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const scenario = scenarioSwitch(page, 'Admin scenario')

  await expect(page.getByText('Acme Studio', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('internal-admin-search.png', { fullPage: true })
  await page.getByRole('button', { name: /Acme Studio/ }).click()
  const workspaceQuery = page.locator('[data-admin-query="workspace"]')
  await expect(workspaceQuery).toHaveAttribute('data-query-status', 'success')
  await expect(workspaceQuery).toHaveAttribute('data-fetch-status', 'idle')
  await expect(page.getByRole('heading', { name: 'Acme Studio' })).toBeVisible()
  await expect(page.getByText('Per-member usage')).toBeVisible()
  const syncHealth = page
    .getByRole('heading', { name: 'File sync health', exact: true })
    .locator('..')
  await expect(syncHealth).toContainText('Batches sampled')
  await expect(syncHealth).toContainText('Dropped reads')
  await expect(syncHealth).toContainText('Overflow')
  await expect(syncHealth).toContainText('Last batch')
  await expect(syncHealth.getByText('42', { exact: true })).toBeVisible()
  await expect(syncHealth.getByText('3', { exact: true })).toBeVisible()
  await expect(syncHealth.getByText('0', { exact: true })).toBeVisible()
  await expect(syncHealth.getByText('Jul 10, 18:30', { exact: true })).toBeVisible()
  const recentLedger = page
    .getByRole('heading', { name: 'Recent ledger', exact: true })
    .locator('..')
  await expect(
    recentLedger.locator('[data-ledger-type="usage"][data-ledger-amount-micro-usd="-8420000"]'),
  ).toBeVisible()
  await expect(page).toHaveScreenshot('internal-admin-workspace.png', { fullPage: true })
  await page.getByRole('button', { name: /VM, gateway, files/ }).click()
  await expect(page.getByText('Runtime health')).toBeVisible()
  const runtimeHealth = page.getByText(`Runtime build: ${CURRENT_RUNTIME_VERSION}`, { exact: true })
  await expect(runtimeHealth).toBeVisible()
  expect(
    await runtimeHealth.evaluate(element => element.scrollWidth <= element.clientWidth),
    'the complete status identity must fit its health panel',
  ).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expect(page.getByRole('button', { name: 'projects', exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('internal-admin-vm.png', { fullPage: true })
  await page.getByRole('button', { name: 'Load logs', exact: true }).click()
  await expect(page.getByText(/account-board/)).toBeVisible()
  await expect(page).toHaveScreenshot('internal-admin-logs.png', { fullPage: true })
  await page.getByRole('combobox', { name: 'Guarded command' }).selectOption('git status --short')
  await page.getByRole('button', { name: 'Run command' }).click()
  await expect(page.getByText(/weekly-report\.md/)).toBeVisible()
  await expect(page).toHaveScreenshot('internal-admin-command.png', { fullPage: true })
  await page.getByRole('button', { name: /README.md/ }).click()
  await expect(page.getByText('# Acme operations')).toBeVisible()
  await expect(page).toHaveScreenshot('internal-admin-file.png', { fullPage: true })
  await page.getByRole('button', { name: '.. / Drive root', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Guarded command' })).toBeVisible()

  await scenario('workspace-zero-sync')
  await page.getByRole('button', { name: /Acme Studio/ }).click()
  await expect(page.getByRole('heading', { name: 'File sync health', exact: true })).toBeVisible()
  await expect(page.getByText('No file sync batches have been recorded.')).toBeVisible()
  await expect(page.locator('[data-sync-health="0:0:0"]')).toBeVisible()
  await expect(page.getByText('Not recorded', { exact: true })).toHaveCount(3)
  await expect(page).toHaveScreenshot('internal-admin-sync-empty.png', { fullPage: true })

  await scenario('fleet')
  await expect(page.getByRole('heading', { name: 'Fleet health' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Runtime', exact: true })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Gateway', exact: true })).toHaveCount(0)
  await expect(page.getByRole('columnheader', { name: 'Agent', exact: true })).toHaveCount(0)
  await expect(page.getByText('Runtime build', { exact: true })).toBeVisible()
  const runtimeCells = page.getByRole('cell', { name: /^0\.0\.0\+[a-f0-9]{64}$/ })
  await expect(runtimeCells).toHaveCount(4)
  expect(
    await runtimeCells.evaluateAll(cells =>
      cells.every(cell => {
        const range = document.createRange()
        range.selectNodeContents(cell)
        const bounds = cell.getBoundingClientRect()
        return [...range.getClientRects()].every(
          rect => rect.left >= bounds.left && rect.right <= bounds.right,
        )
      }),
    ),
    'complete runtime identities must remain inside their scrollable table cells',
  ).toBe(true)
  const scrollArea = page.getByRole('table').locator('..')
  if (await scrollArea.evaluate(element => element.scrollWidth > element.clientWidth)) {
    await expect(
      page.getByText('Scroll horizontally to see all VM columns.', { exact: true }),
    ).toBeVisible()
    await scrollArea.focus()
    // Native keyboard scrolling is animated; finish it before restoring the shot.
    const scrollEnded = scrollArea.evaluate(
      element =>
        new Promise<void>(resolve => {
          element.addEventListener('scrollend', () => resolve(), { once: true })
        }),
    )
    await page.keyboard.press('ArrowRight')
    await scrollEnded
    expect(await scrollArea.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
    await scrollArea.scrollIntoViewIfNeeded()
    await scrollArea.evaluate(element => {
      const runtime = element.querySelector('tbody tr td:nth-child(3)') as HTMLElement
      element.scrollTo({
        left: runtime.offsetLeft + runtime.offsetWidth - element.clientWidth,
        behavior: 'instant',
      })
    })
    expect(
      await scrollArea.evaluate(element => {
        const bounds = element.getBoundingClientRect()
        const names = [...element.querySelectorAll('thead th:first-child, tbody tr td:first-child')]
        return names.every(cell => {
          const label = cell.querySelector('span') ?? cell
          const rect = label.getBoundingClientRect()
          const visible = document.elementFromPoint(
            (rect.left + rect.right) / 2,
            (rect.top + rect.bottom) / 2,
          )
          return rect.left >= bounds.left && rect.right <= bounds.right && cell.contains(visible)
        })
      }),
      'workspace names must stay visible above the scrolled runtime values',
    ).toBe(true)
    await expect(page.getByRole('columnheader', { name: 'Workspace', exact: true })).toBeVisible()
    expect(
      await page.getByRole('columnheader', { name: 'Runtime', exact: true }).evaluate(header => {
        const area = header.closest('table')!.parentElement!
        const bounds = area.getBoundingClientRect()
        const workspace = area.querySelector('thead th:first-child')!.getBoundingClientRect()
        const label = document.createRange()
        label.selectNodeContents(header)
        return [...label.getClientRects()].every(
          rect => rect.left >= workspace.right && rect.right <= bounds.right,
        )
      }),
      'the Runtime heading must stay visible beside Workspace at the runtime ending',
    ).toBe(true)
    await scrollArea.evaluate(element => element.scrollTo({ left: 0, behavior: 'instant' }))
    await expect.poll(() => scrollArea.evaluate(element => element.scrollLeft)).toBe(0)
    await page.evaluate(() => {
      ;(document.activeElement as HTMLElement)?.blur()
    })
    await resetScroll(page)
  }
  // The wedged VM: its build lags the fleet and it is burning a whole core.
  await expect(page.getByRole('cell', { name: 'dan-test' })).toBeVisible()
  await expect(page.getByText('1.42', { exact: true })).toBeVisible()
  const cpuGap = await page.getByText('1.42', { exact: true }).evaluate(cores => {
    const percent = cores.nextElementSibling
    if (!percent) throw new Error('CPU percentage is missing')
    return percent.getBoundingClientRect().left - cores.getBoundingClientRect().right
  })
  expect(cpuGap, 'CPU cores and percentages must remain visually distinct').toBeGreaterThan(0)
  await expect(page).toHaveScreenshot('internal-admin-fleet.png', { fullPage: true })

  await scenario('feedback')
  await expect(page.getByRole('heading', { name: 'Feedback triage' })).toBeVisible()
  await expect(page).toHaveScreenshot('internal-admin-feedback.png', { fullPage: true })
  await page.getByRole('button', { name: 'Delete', exact: true }).first().click()
  await expect(page.getByRole('dialog', { name: 'Permanently delete feedback?' })).toBeVisible()
  await expect(page).toHaveScreenshot('internal-admin-feedback-delete.png', { fullPage: true })
  await page.getByRole('button', { name: 'Cancel' }).click()
  await scenario('feedback-empty')
  await expect(page.getByText('Queue clear')).toBeVisible()
  await expect(page).toHaveScreenshot('internal-admin-feedback-empty.png', { fullPage: true })
  await scenario('credits')
  await expect(page.getByText('$842.00')).toBeVisible()
  await expect(page).toHaveScreenshot('internal-admin-credits-confirm.png', { fullPage: true })
  // Listing takedown: both the ready form and the
  // drain-still-running result, since a one-shot takedown never shows the latter.
  await page.getByRole('button', { name: 'Marketplace', exact: true }).click()
  await page.getByTestId('admin-takedown-listing-id').fill('listing-abusive')
  await expect(page).toHaveScreenshot('internal-admin-takedown-confirm.png', { fullPage: true })
  await page.getByTestId('admin-takedown-submit').click()
  await expect(page.getByText(/drain is still running/)).toBeVisible()
  await expect(page).toHaveScreenshot('internal-admin-takedown-draining.png', { fullPage: true })

  await scenario('loading')
  await expect(page.getByText('Searching audited workspace records…')).toBeVisible()
  await expect(page).toHaveScreenshot('internal-admin-loading.png', { fullPage: true })
  await scenario('error')
  await expect(page.getByText('Admin data could not load')).toBeVisible()
  await expect(page).toHaveScreenshot('internal-admin-error.png', { fullPage: true })
  await scenario('denied')
  await expect(page.getByText('Internal access required')).toBeVisible()
  await expect(page).toHaveScreenshot('internal-admin-denied.png', { fullPage: true })
  await scenario('spanish-workspace')
  await expect(page.getByRole('heading', { name: 'Administración interna' })).toBeVisible()
  await page.getByRole('button', { name: /Acme Studio/ }).click()
  await expect(page.locator('input[value="Investigación de soporte"]')).toBeVisible()
  await expect(page.getByText('Uso por miembro')).toBeVisible()
  await expect(page).toHaveScreenshot('internal-admin-spanish.png', { fullPage: true })
  await scenario('spanish-credits')
  await expect(
    page.locator('input[value="Restablecimiento por política de créditos gratis"]'),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Restablecer créditos' }).click()
  await expect(page.getByText('Los créditos se restablecieron y auditaron.')).toBeVisible()
  await expect(page).toHaveScreenshot('internal-admin-spanish-credits.png', { fullPage: true })

  // LAST, because the result banner persists and would grow every screenshot
  // taken after it. The sync button must SAY what it did: a press that
  // silently succeeds is indistinguishable from one that quietly declined to
  // run, which is the failure this whole feature exists to remove.
  await page.getByRole('button', { name: 'Sincronizar desde el repo', exact: true }).click()
  await expect(page.locator('[data-testid="official-hub-sync-result"]')).toContainText(
    '1 archivo(s) escrito(s)',
  )
  // Retirement rides the same press: absent from the manifest means deleted
  // from the hub, and the banner names who left.
  await expect(page.locator('[data-testid="official-hub-sync-result"]')).toContainText(
    'Retirados del hub: recruiter',
  )
})

test('playground/spa-shell-workspace-audit-pagination retains rows through retry and success', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page.getByRole('button', { name: 'Account and settings' }).click()
  await page.getByRole('menuitem', { name: 'Workspace settings', exact: true }).click()
  await page.getByRole('link', { name: 'Audit log', exact: true }).click()
  await expect(destinationHeading(page, 'Audit log')).toBeVisible()
  await expect(page.getByText('Designated payer changed', { exact: true })).toBeVisible()
  await expect(page.getByText('Member role changed', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('spa-shell-workspace-audit.png', { fullPage: true })

  await page.getByRole('button', { name: 'Older activity', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Loading…', exact: true })).toBeDisabled()
  await expect(
    page.getByText('Older activity could not be loaded. The activity above is still available.', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
  await expect(page.getByText('Designated payer changed', { exact: true })).toBeVisible()
  await expect(page.getByText('Member role changed', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('spa-shell-workspace-audit-page-error.png', {
    fullPage: true,
  })

  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Loading…', exact: true })).toBeDisabled()
  await expect(page.getByText('API key issued', { exact: true })).toBeVisible()
  await expect(page.getByText('Designated payer changed', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Older activity', exact: true })).toHaveCount(0)
  await expect(page).toHaveScreenshot('spa-shell-workspace-audit-page-two.png', {
    fullPage: true,
  })
})

test('playground/spa-shell shows a broken app in Files and explains it on its card', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Scenario: agent-app-broken', exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await page.getByRole('tab', { name: 'Drive', exact: true }).click()
  await page.getByRole('button', { name: 'apps', exact: true }).click()

  const broken = page.locator('[data-files-card="app"]', { hasText: 'reporting' })
  await expect(broken).toHaveAttribute('data-app-status', 'broken')

  /* A broken app leads where every app leads — its agent's card — and there it
     says what happened. It offers no repair: putting the folder back meant
     typing a Drive path, a sentence about anchors that no reader outside this
     codebase can write. Deleting it is what the menu offers instead. */
  await broken.click()
  await expect(page.getByText('Folder link needs repair')).toBeVisible()
  await expect(page.getByLabel('New folder path')).toHaveCount(0)
  await expect(page.locator('iframe[title="Launch intelligence"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'App options', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Delete app', exact: true })).toBeVisible()
  // An app Duet cannot connect to its folder can never answer its public URL,
  // so publishing it would only mint a link that is dead on arrival.
  await expect(page.getByRole('menuitem', { name: 'Publish' })).toHaveCount(0)
  await expect(page).toHaveScreenshot('app-broken-on-card.png', { fullPage: true })
})

test('playground/spa-shell covers recipient share discovery and acceptance states', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const openScenario = async (scenario: string) => {
    await page
      .getByRole('button', { name: `Scenario: ${scenario}`, exact: true, includeHidden: true })
      .evaluate((button: HTMLButtonElement) => button.click())
    /* No navigation here on purpose. Most of these scenarios mount with an
       explicit `initialPath` of the Drive, so the destination is already right —
       and pressing a route button to "make sure" remounts the shell and takes
       the pending-share landing with it, which is the thing this test is about.

       Two of them deliberately land somewhere else: the deep-link pair mounts at
       `/?shared=1` to prove a share link works before a workspace is chosen, and
       where the shell then redirects to is not this test's subject. The Drive
       heading is a settling signal rather than a claim, so those two settle on
       the share landing itself. */
    const landsOnTheDrive = scenario !== 'share-deep-link' && scenario !== 'share-link-unavailable'
    if (landsOnTheDrive) {
      await expect(destinationHeading(page, 'Drive')).toBeVisible()
      await expect(page.locator('[data-files-card="folder"]', { hasText: 'Shared' })).toBeVisible()
    }
    await resetScroll(page)
  }

  await openScenario('share-one')
  await expect(page.getByRole('region', { name: 'Accept shared folder qbr-deck' })).toBeVisible()
  await expect(page.getByRole('radio')).toHaveCount(0)
  await expect(page.getByText('qbr-dashboard', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Accept & sync', exact: true })).toBeInViewport()
  await expect(page).toHaveScreenshot('spa-shell-share-single-workspace.png', {
    fullPage: true,
  })

  await page.getByRole('button', { name: 'Choose folder', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Use this folder', exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('spa-shell-share-folder-picker.png', { fullPage: true })
  const acceptPanel = page.getByRole('region', { name: 'Accept shared folder qbr-deck' })
  await acceptPanel.getByRole('button', { name: 'Shared', exact: true }).click()
  await acceptPanel.getByRole('button', { name: 'Finance', exact: true }).click()
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click()
  await page.getByRole('button', { name: 'Accept & sync', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Drive path' })).toContainText(
    'SharedFinanceqbr-deck',
  )
  await expect(
    page.locator('[data-files-card]').filter({ hasText: 'fresh-share.txt' }).first(),
  ).toBeVisible()
  await openScenario('share-multi-workspace')
  await expect(page.getByRole('radio')).toHaveCount(2)
  await expect(page).toHaveScreenshot('spa-shell-share-multi-workspace.png', {
    fullPage: true,
  })
  await page.getByRole('radio').nth(1).click()
  await page.getByRole('button', { name: 'Accept & sync', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Accept shared folder qbr-deck' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Drive path' })).toContainText('qbr-deck')
  await expect(
    page.locator('[data-files-card]').filter({ hasText: 'fresh-share.txt' }).first(),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Account and settings', exact: true }).click()
  const accountMenu = page.getByRole('menu').filter({ visible: true })
  await expect(accountMenu.getByText('Duet Labs', { exact: true })).toBeVisible()
  await expect(accountMenu.getByText('labs', { exact: true })).toBeVisible()
  // Density was removed as a preference; the menu must not resurrect it.
  await expect(accountMenu.getByText('Density', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await openScenario('share-server-normalized')
  await page.getByRole('button', { name: 'Accept & sync', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Drive path' })).toContainText(
    'SharedFinanceserver-qbr',
  )
  await expect(
    page.locator('[data-files-card]').filter({ hasText: 'fresh-share.txt' }).first(),
  ).toBeVisible()

  await openScenario('share-several')
  await expect(page.getByRole('button', { name: /library/ })).toBeVisible()
  await expect(page).toHaveScreenshot('spa-shell-share-several.png', { fullPage: true })

  await openScenario('share-deep-link')
  await expect(page.getByRole('region', { name: 'Accept shared folder qbr-deck' })).toBeVisible()
  await expect(page.getByRole('button', { name: /library/ })).toBeVisible()
  await page.getByRole('tab', { name: 'Agents', exact: true }).click()
  await page.waitForTimeout(250)
  // Leaving the share banner behind lands on the map, the Agents tab's own
  // destination — the catalog lives under it now, at /agents/marketplace.
  await expect(page.locator('[data-destination-content="agentPage"]')).toBeVisible()

  await openScenario('share-link-unavailable')
  await expect(
    page.getByText('This share link is no longer available', { exact: true }),
  ).toBeVisible()

  await openScenario('share-expired')
  await expect(page.getByText('This request has expired', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('spa-shell-share-expired.png', { fullPage: true })

  await openScenario('share-origin-unavailable')
  await expect(
    page.getByText('The source workspace is no longer active', { exact: true }),
  ).toBeVisible()
  await expect(page).toHaveScreenshot('spa-shell-share-origin-unavailable.png', {
    fullPage: true,
  })

  await openScenario('share-target-unavailable')
  await expect(
    page.getByText('You need an active editable workspace', { exact: true }),
  ).toBeVisible()
  await expect(page).toHaveScreenshot('spa-shell-share-target-unavailable.png', {
    fullPage: true,
  })

  await openScenario('share-accept-loading')
  await page.getByRole('button', { name: 'Accept & sync', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Accepting…', exact: true })).toBeDisabled()
  await expect(page).toHaveScreenshot('spa-shell-share-accept-loading.png', {
    fullPage: true,
  })

  await openScenario('share-accept-error')
  await page.getByRole('button', { name: 'Accept & sync', exact: true }).click()
  await expect(page.getByText(/Duet could not accept this request/, { exact: false })).toBeVisible()
  await expect(page).toHaveScreenshot('spa-shell-share-accept-error.png', { fullPage: true })

  await openScenario('share-one')
  await page.getByRole('button', { name: 'Decline', exact: true }).click()
  await expect(page.getByText('Decline this request?', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Accept & sync', exact: true })).toHaveCount(0)
  await expect(page).toHaveScreenshot('spa-shell-share-decline-confirm.png', {
    fullPage: true,
  })
})

test('playground/spa-shell switches theme from the account menu', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const accountTrigger = page.getByRole('button', { name: 'Account and settings' })
  await expect(accountTrigger.locator('[data-identity-avatar="user"]')).toHaveCount(1)
  await accountTrigger.click()
  await page.getByRole('menuitem', { name: 'Theme System', exact: true }).click()
  await page.getByRole('menuitemradio', { name: 'Dark', exact: true }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)

  await page.getByRole('button', { name: 'Account and settings' }).click()
  await page.getByRole('menuitem', { name: 'Theme Dark', exact: true }).click()
  await page.getByRole('menuitemradio', { name: 'System', exact: true }).click()
  await expect(page.locator('html')).toHaveClass(/light/)
})

test('playground/spa-shell omits generic workspace health from shared chrome', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await expect(page.getByRole('button', { name: /Open workspace pulse:/ })).toHaveCount(0)
  await expect(page.getByText('Active', { exact: true }).filter({ visible: true })).toHaveCount(0)
})

test('playground/spa-shell exercises navigation, workspace, locale, and logout', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  const mobile = (page.viewportSize()?.width ?? 0) < 768

  const agentsTab = page.getByRole('tab', { name: 'Agents' })
  await expect(agentsTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: 'Official' })).toHaveCount(0)
  await agentsTab.click()
  // The Agents tab is the map — the drive drawn as itself — and the map is how
  // you get around: an agent's face opens that agent, an app node opens the app.
  await expect(page.locator('[data-destination-content="agentPage"]')).toBeVisible()
  /* The Agents tab is the root agent's conversation now, not the drive's
     picture — so what proves the section has resolved is the roster having
     drawn its rows, which is the same fact at every width. It used to be a face
     on the canvas above `sm` and a row below it, because those were two
     different compositions of one destination; there is one composition now and
     the column is in it.

     Below `sm` the roster is a panel that opens over the conversation, so it
     has to be asked for before it can be waited on. */
  const narrowHome = (page.viewportSize()?.width ?? 0) < 768
  /* Settle on the front door itself rather than on the roster. The section has
     resolved when the agent's own sheet is drawn, and that is true at every
     width — whereas the roster below `sm` is an overlay, so waiting on it means
     opening it, and shooting with it open photographs the list covering the
     front door under a baseline named for the front door. An unprimed critique
     of exactly that picture reported the bottom 40% of the phone as empty with
     no conversation and no route to one. */
  await expect(page.locator('.km-sheet')).toBeVisible()
  await expect(page).toHaveScreenshot('spa-shell-agents-home.png', { fullPage: true })

  /* The centre is the default agent, and it wears the name it was given in
     onboarding — not the drive's. They are two different names for two
     different things: the drive is `Acme Studio` and is already named in the
     chrome above, and the agent standing on the core is `Milo`. The map used to
     put the drive's name on the face and hand the same string to the surface
     that unfolds, so the one agent every drive has was the one agent you could
     never see the name of. */
  /* The same claim, at one composition instead of two: the drive's own agent
     wears the name onboarding gave it and never the drive's. It used to be
     asked of a face on the canvas above `sm` and of a row below it, because the
     Agents tab was the drive's picture and a phone got the list instead. The
     tab is the root agent's conversation now at every width, and the roster is
     where that agent is named — so there is one place to ask, and asking the
     canvas would be asking a surface this tab no longer opens. */
  /* Now the roster, because the drive's own agent is named on a row. Below `sm`
     that means opening the panel — which is why this comes after the shot. */
  if (narrowHome) await openRosterIfFolded(page)
  const core = page
    .getByRole('navigation', { name: 'Agents' })
    .getByRole('button', { name: /^Milo/ })
  await expect(core.first()).toBeVisible()
  await expect(
    narrowHome
      ? page.getByRole('navigation', { name: 'Agents' }).getByText('Acme Studio', { exact: true })
      : page.getByRole('button', { name: /^Acme Studio\. Opens everything/ }),
  ).toHaveCount(0)

  await core.first().click()
  // And inside it, where the same name is set beside the face the camera flew in.
  await expect(page.getByRole('heading', { name: 'Milo', exact: true })).toBeVisible()
  /* The card opens on this agent's first app, framed and whole. There is no
     door out of it any more: an app has no page of its own to be sent to, so
     the card *is* the destination and the chip that names it carries the menu
     of everything that can be done to it.

     On a phone the card is the pane the reader has not chosen yet: arriving at
     an agent opens the conversation, because a bare agent path is a request for
     the agent and not for its folder. So the reader picks the other segment —
     which is named for the very app this asserts, and is the whole reason that
     segment carries a name rather than the word "Work". */
  if (narrowHome) {
    await page
      .locator('.km-pane-switch')
      .getByRole('tab', { name: /Launch intelligence/ })
      .click()
  }
  // Scoped to the card's own row of selectors: the rail beside the canvas lists
  // the same app, so a bare name matches two buttons and resolves to neither.
  await expect(
    page.getByRole('group', { name: 'Views' }).getByRole('button', { name: 'Launch intelligence' }),
  ).toBeVisible()
  await expect(
    page.frameLocator('iframe[title="Launch intelligence"]').getByRole('heading', { level: 1 }),
  ).toContainText('reporting')
  await expect(page).toHaveScreenshot('spa-shell-agent-app-card.png', { fullPage: true })

  // Train has no tab and no node on the map: the drive's own memory is reached
  // by its URL, the way a bookmark or a link into it arrives.
  await page
    .getByRole('button', {
      name: 'Browser route: /w/acme/train/root',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(destinationHeading(page, 'Global memory')).toBeVisible()
  // The hero paints before the data-backed sections; without pinning the
  // records and job-history content the fullPage shot races hydration and
  // freezes a half-loaded page (the old mobile baseline was exactly that).
  await expect(
    page.getByText('Customer support handbook and escalation practices').first(),
  ).toBeVisible()
  await expect(page.getByText('train_running_01', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('spa-shell-train.png', { fullPage: true })

  await page.getByRole('tab', { name: 'Drive', exact: true }).click()
  await expect(destinationHeading(page, 'Drive')).toBeVisible()
  if (!mobile) {
    const desktopViewport = page.viewportSize()!
    await page.setViewportSize({ width: 1024, height: 600 })
    await page.evaluate(
      () =>
        new Promise<void>(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight }))
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
    await expect(page).toHaveScreenshot('spa-shell-files-short-viewport.png', {
      fullPage: false,
    })
    await page.setViewportSize(desktopViewport)
  }
  await expect(page).toHaveScreenshot('spa-shell-files.png', { fullPage: true })

  await page.getByRole('tab', { name: 'Integrations', exact: true }).click()
  await expect(destinationHeading(page, 'Integrations')).toBeVisible()
  await expect(page).toHaveScreenshot('spa-shell-integrations.png', { fullPage: true })

  // Back to the fixture's own router: the browser-route excursions above put the
  // shell on real history, and signing out of THAT one leaves the page instead
  // of reporting the revoked session this test ends on.
  await page
    .getByRole('button', { name: 'Scenario: default', exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())

  await page.getByRole('button', { name: 'Account and settings' }).click()
  await page.getByRole('menuitem', { name: 'Workspace settings', exact: true }).click()
  await expect(destinationHeading(page, 'General')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Designated payer' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Billing', exact: true })).toHaveCount(0)
  for (const setting of [
    ['General', 'general'],
    ['Members', 'members'],
    ['Shares', 'shares'],
    ['Publishes', 'publishes'],
    ['Usage', 'usage'],
    ['Audit log', 'audit'],
    ['Designated payer', 'billing-user'],
  ] as const) {
    await page.getByRole('link', { name: setting[0], exact: true }).click()
    await expect(destinationHeading(page, setting[0])).toBeVisible()
    if (setting[1] === 'usage') {
      await expect(page.getByRole('heading', { name: 'VM telemetry', exact: true })).toBeVisible()
      await expect(page.getByText('Memory used', { exact: true })).toBeVisible()
      await expect(page.getByText(/Disk total/)).toBeVisible()
      if (mobile) {
        await page.locator('[data-telemetry-history-chart]').evaluate(element => {
          element.scrollIntoView({ block: 'start' })
          element.closest('main')?.scrollBy({ top: -80 })
        })
      }
    }
    await expect(page).toHaveScreenshot(`spa-shell-workspace-${setting[1]}.png`, {
      fullPage: true,
    })
  }

  await page.getByRole('button', { name: 'Account and settings' }).click()
  await page.getByRole('menuitem', { name: 'User settings', exact: true }).click()
  for (const setting of [
    ['Profile', 'profile'],
    ['Billing', 'billing'],
    ['API keys', 'api-keys'],
    ['Preferences', 'preferences'],
  ] as const) {
    await page.getByRole('link', { name: setting[0], exact: true }).click()
    await expect(destinationHeading(page, setting[0])).toBeVisible()
    await expect(page).toHaveScreenshot(`spa-shell-user-${setting[1]}.png`, {
      fullPage: true,
    })
  }

  await page.getByRole('button', { name: 'Account and settings' }).click()
  await page.getByRole('menuitem', { name: 'Internal admin', exact: true }).click()
  await expect(destinationHeading(page, 'Internal admin')).toBeVisible()

  await page.getByRole('button', { name: 'Account and settings' }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Switch workspace' }).click()
  await page.getByRole('menuitem', { name: /Create workspace/ }).click()
  await expect(page.getByLabel('Workspace name')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Switch workspace', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Switch workspace' }).click()
  await page.getByRole('menuitem', { name: /Create workspace/ }).click()
  await page.getByLabel('Workspace name').fill('North Star')
  await expect(page.getByLabel('Workspace URL')).toHaveValue('north-star')
  await expect(page).toHaveScreenshot('spa-shell-create-workspace.png', { fullPage: true })
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('North Star')
  await page.getByRole('button', { name: 'Account and settings' }).click()
  await expect(
    page.getByRole('menu').filter({ visible: true }).getByText('Provisioning', { exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Switch workspace' }).click()
  await page.getByRole('menuitem', { name: /Duet Labs/ }).click()
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('Duet Labs')
  /* ⌘1…⌘9 and Ctrl+1…9 belong to the browser's tab strip. The shell used to
     claim them for workspace switching; now it must let them through — no
     switch, and no preventDefault that would swallow the tab change. */
  await page.keyboard.press('Control+1')
  await page.keyboard.press('Meta+1')
  expect(
    await page.evaluate(() => {
      const chord = new KeyboardEvent('keydown', {
        key: '1',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      })
      window.dispatchEvent(chord)
      return chord.defaultPrevented
    }),
  ).toBe(false)
  await expect(page).toHaveScreenshot('spa-shell-workspace-switched.png', { fullPage: true })
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('Duet Labs')

  await page.getByRole('button', { name: 'Account and settings' }).click()
  await page.getByRole('menuitem', { name: /Language/ }).click()
  await page.getByRole('menuitemradio', { name: 'Español', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Agentes' })).toBeVisible()
  await expect
    .poll(
      async () =>
        (await page.context().cookies()).find(cookie => cookie.name === 'DUET_LOCALE')?.value,
    )
    .toBe('es-419')
  await expect(page).toHaveScreenshot('spa-shell-spanish.png', { fullPage: true })
  await expect(page).toHaveScreenshot('sessions-spanish-filters.png', { fullPage: true })

  await page.getByRole('button', { name: 'Cuenta y configuración' }).click()
  await page.getByRole('menuitem', { name: 'Cerrar sesión', exact: true }).click()
  await expect(page.getByText('Browser session revoked.')).toBeVisible()
})

test('playground/spa-shell keeps bootstrap inside the product island', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page
    .getByRole('button', { name: 'Scenario: loading', exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByRole('tablist', { name: 'Workspace sections' })).toBeVisible()
  await expect(page.getByRole('tab').first()).toBeDisabled()
  await expect(page.getByText('Getting Duet ready')).toHaveCount(0)
  /* The loading scenario waits on a session address now, and a session address
     resolves onto the map — so the island wears the map's own skeleton. */
  await expect(page.getByLabel('Opening your workspace')).toBeVisible()
  await expect(page.locator('[data-bootstrap-island="true"]')).toBeVisible()
  await expect(page).toHaveScreenshot('spa-shell-loading.png', {
    fullPage: true,
    // Chromium can vary subpixel glyph antialiasing in the persistent header.
    // Keep this below one rendered control while preserving exact island geometry.
    maxDiffPixels: 500,
  })

  await page
    .getByRole('button', {
      name: 'Scenario: files-bootstrap-loading',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.locator('[data-loading-view="files"]')).toBeVisible()
  await expect(page).toHaveScreenshot('spa-shell-files-bootstrap-loading.png', {
    fullPage: true,
    threshold: 0,
    maxDiffPixels: 500,
  })

  const bootstrapSkeleton = await loadingSkeletonGeometry(page, 'files')
  expect(
    bootstrapSkeleton.boxes.filter(
      ([, , width, height]) =>
        width >= bootstrapSkeleton.rootWidth * 0.35 && height >= 40 && height <= 48,
    ),
  ).toEqual([])
  await page
    .getByRole('button', { name: 'Scenario: files-data-loading', exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.locator('[data-loading-view="files"]')).toBeVisible()
  /* Polled: the scenario switch can briefly hold the outgoing tree alongside
     the incoming one, and a measurement taken mid-transition reads zeros. */
  await expect
    .poll(async () => await loadingSkeletonGeometry(page, 'files'))
    .toEqual(bootstrapSkeleton)
  await expect(page).toHaveScreenshot('spa-shell-files-data-loading.png', {
    fullPage: true,
    threshold: 0,
    maxDiffPixels: 500,
  })
})

async function loadingSkeletonGeometry(page: import('@playwright/test').Page, view: string) {
  return await page.locator(`[data-loading-view="${view}"]`).evaluate(root => ({
    rootWidth: Math.round(root.getBoundingClientRect().width),
    boxes: Array.from(root.querySelectorAll('.shell-skeleton'), element => {
      const box = element.getBoundingClientRect()
      return [
        Math.round(box.x),
        Math.round(box.y),
        Math.round(box.width),
        Math.round(box.height),
      ] as [number, number, number, number]
    }),
  }))
}

test('playground/spa-shell exposes bootstrap and routing states', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const scenario = scenarioSwitch(page)

  for (const state of [
    ['error', 'Duet could not load', 'error'],
    ['unauthorized', 'Your session has expired', 'unauthorized'],
    ['empty', 'Create your first workspace', 'empty'],
    ['invalid-workspace', 'Workspace unavailable', 'invalid-workspace'],
    ['not-found', 'This Duet page does not exist', 'not-found'],
    ['admin-denied', 'Your session has expired', 'admin-denied'],
  ] as const) {
    await scenario(state[0])
    await expect(page.getByRole('heading', { name: state[1] }).first()).toBeVisible()
    await expect(page).toHaveScreenshot(`spa-shell-${state[2]}.png`, { fullPage: true })
  }

  await scenario('switch-error')
  await page
    .getByRole('button', { name: 'Simulate workspace transition failure', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await page.getByRole('button', { name: 'Switch workspace' }).click()
  await page.getByRole('menuitem', { name: /Duet Labs/ }).click()
  await expect(
    page.getByRole('heading', { name: 'Duet could not load', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0)
  await expect(page).toHaveScreenshot('spa-shell-workspace-transition-error.png', {
    fullPage: true,
  })

  await scenario('admin-message')
  await expect(page.getByText('Message from Duet operations:')).toBeVisible()
  await expect(page).toHaveScreenshot('spa-shell-admin-message.png', { fullPage: true })

  await scenario('create-error')
  await page.getByRole('button', { name: 'Switch workspace' }).click()
  await page.getByRole('menuitem', { name: /Create workspace/ }).click()
  await page.getByLabel('Workspace name').fill('Failure Case')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByText('The workspace could not be created.', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('spa-shell-create-error.png', { fullPage: true })
})

test('playground/spa-shell-create-workspace explains the membership limit and opens billing', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  const scenario = scenarioSwitch(page)
  await scenario('create-refused')
  await page.getByRole('button', { name: 'Switch workspace' }).click()
  await page.getByRole('menuitem', { name: /Create workspace/ }).click()
  await page.getByLabel('Workspace name').fill('Second Workspace')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  // The refusal names the rule and offers the way out; the unexplained sentence
  // must not appear beside it.
  await expect(page.getByText('Pro workspace limit reached', { exact: true })).toBeVisible()
  await expect(page.getByText(/You already belong to 3 or more workspaces/)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Compare plans' })).toBeVisible()
  await expect(page.getByText('The workspace could not be created.', { exact: true })).toHaveCount(
    0,
  )
  await expect(page).toHaveScreenshot('spa-shell-create-refused.png', { fullPage: true })

  // The way out has to actually arrive somewhere. The SPA routes with
  // react-router, so a next/link here would move the address and render
  // nothing — a button that reads as broken. The dialog stands aside on the way
  // out; otherwise billing renders under a modal that is still open. (Fixtures
  // route in memory, so the assertion is the surface, not the URL.)
  await page.getByRole('link', { name: 'Compare plans' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(destinationHeading(page, 'Billing')).toBeVisible()
})

test('playground/spa-shell covers Train states and record editing', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  const scenario = scenarioSwitch(page)
  const mobile = (page.viewportSize()?.width ?? 0) < 768
  const shot = async (name: string, exact = false) => {
    await expect(page).toHaveScreenshot(name, {
      fullPage: !mobile,
      ...(exact ? { maxDiffPixelRatio: 0 } : {}),
    })
  }

  await scenario('train-loading')
  // The page title names the scope being edited, so it reads "Global memory"
  // here rather than the generic product noun, which is now the eyebrow.
  await expect(page.getByRole('heading', { name: 'Global memory', exact: true })).toBeVisible()
  await shot('train-loading.png')

  await scenario('train-empty')
  await expect(page.getByText('No training jobs yet', { exact: true })).toBeVisible()
  await expect(page.getByText('No trained memories yet', { exact: true })).toBeVisible()
  await shot('train-empty.png')
  if (mobile) {
    // Scroll to the library card itself; "Global memory" is now the page title
    // at the very top, which would frame the wrong thing.
    await page.getByRole('heading', { name: 'Memory library' }).scrollIntoViewIfNeeded()
    await shot('train-empty-library.png')
  }

  await scenario('train-staged')
  await expect(page.getByText('research-notes.pdf', { exact: true })).toBeVisible()
  await expect(page.getByText('https://docs.example.com/handbook', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Global memory' })).toBeVisible()
  // Train's own scope rail — Duet first, then the agents, each previewing its
  // memory depth. It is not the drive roster, so it carries none of that rail's
  // navigation chrome, and it is present at every width.
  const trainRail = page.getByRole('navigation', { name: 'Training scopes' })
  await expect(trainRail.getByRole('link', { name: /^Milo/ })).toContainText('2 memories')
  await expect(trainRail.getByRole('link', { name: /^Research/ })).toContainText('2 memories')
  await expect(trainRail.getByRole('link', { name: /^Reviewer/ })).toContainText('0 memories')
  await expect(trainRail.getByRole('link', { name: 'Home' })).toHaveCount(0)
  await expect(trainRail.getByRole('link', { name: 'New agent' })).toHaveCount(0)
  // Scroll ownership: the surface scrolls as one pane, so the header and both
  // columns move together and the document itself never scrolls.
  expect(
    await page.locator('[data-train-control-center]').evaluate(element => {
      let ancestorScrollers = 0
      for (let node = element.parentElement; node !== null; node = node.parentElement) {
        if (getComputedStyle(node).overflowY === 'auto') ancestorScrollers += 1
      }
      const nestedScrollers = [...element.querySelectorAll('*')].filter(
        node => getComputedStyle(node).overflowY === 'auto',
      ).length
      return { ancestorScrollers, nestedScrollers }
    }),
  ).toEqual({ ancestorScrollers: 1, nestedScrollers: 0 })
  if (!mobile) {
    // The drive shell clips at 100dvh, so Train can only ever scroll inside it.
    // (Asserted on desktop only: the playground harness itself overflows the
    // document at mobile widths, independent of this surface.)
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight),
    ).toBe(true)
  }
  await shot('train-staged.png')

  // The selected scope has to be obvious in both themes: a plain surface swap
  // reads as recessed against the dark aside, so selection carries a brand wash
  // and an inset ring that lift against near-white and near-black alike.
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await expect(trainRail.getByRole('link', { name: /^Milo/ })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await shot('train-staged-dark.png')
  await page.evaluate(() => document.documentElement.classList.remove('dark'))

  // Switching scope is a rail click, and the clicked entry becomes the current
  // page so the selection stays legible after navigation.
  const researchScope = trainRail.getByRole('link', { name: /^Research/ })
  await researchScope.click()
  await expect(page.getByRole('heading', { name: 'Research memory', exact: true })).toBeVisible()
  await expect(researchScope).toHaveAttribute('aria-current', 'page')

  await scenario('resume-note')
  await expect(page.getByText('These sources are from last time.', { exact: true })).toBeVisible()
  await shot('train-resume-note.png')

  await scenario('failed-retained')
  await expect(page.getByText('retained-corpus.zip', { exact: true })).toBeVisible()
  await expect(
    page.getByText('The last training failed — your sources were kept so you can start it again.', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry training' })).toBeEnabled()
  await shot('train-failed-retained.png')

  await scenario('done-toast')
  await expect(page.getByRole('status').filter({ hasText: 'Training completed.' })).toBeVisible({
    timeout: 12_000,
  })
  await expect(page.getByText('Freshly trained completion record', { exact: true })).toBeAttached()
  await shot('train-done-toast.png')

  await scenario('train-uploading-with-progress')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'dataset.parquet',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(100),
  })
  await expect(page.getByRole('progressbar', { name: 'Upload progress: 43%' })).toHaveAttribute(
    'aria-valuenow',
    '43',
  )
  await expect(page.getByText('43% uploaded', { exact: true })).toBeVisible()
  await shot('train-uploading-with-progress.png', true)

  await scenario('train-cancelled')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'cancel-me.zip',
    mimeType: 'application/zip',
    buffer: Buffer.alloc(100),
  })
  await expect(page.getByLabel('Upload progress: 43%')).toBeVisible()
  await page.getByRole('button', { name: 'Remove cancel-me.zip' }).click()
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible()
  await shot('train-cancelled.png')

  await scenario('train-quota-full-rejection')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'cannot-fit.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from([1]),
  })
  await expect(
    page
      .getByText('No room for this file. Remove a source and try again.', { exact: true })
      .first(),
  ).toBeVisible()
  await shot('train-quota-full-rejection.png')

  await scenario('train-url-pending')
  await page.getByLabel('Website URL').fill('https://pending.example.com/')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByText('Fetching page…', { exact: true })).toBeVisible()
  await shot('train-url-pending.png')

  await scenario('train-url-failed')
  await page.getByLabel('Website URL').fill('https://failed.example.com/')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByText('The page fetch timed out.', { exact: true })).toBeVisible()
  await shot('train-url-failed.png')

  await scenario('train-error')
  await expect(page.getByText('Job history could not be loaded.', { exact: true })).toBeVisible()
  await shot('train-error.png')
  await expect(
    page.getByText('Trained memories could not be loaded.', { exact: true }),
  ).toBeVisible({ timeout: 12_000 })
  if (mobile) {
    await page
      .getByText('Trained memories could not be loaded.', { exact: true })
      .scrollIntoViewIfNeeded()
    await shot('train-error-library.png')
  }

  await scenario('train-long')
  const longRecord = page.getByText(/A very long trained-memory headline/)
  await expect(longRecord).toBeAttached()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  if (mobile) await longRecord.scrollIntoViewIfNeeded()
  await shot('train-long-name.png')

  // Reset to default records, then reach Train by browser route to exercise its
  // editing flows below. The scenario reset restores the default API before the
  // browser route remounts on the train URL. The default-view baseline
  // (`spa-shell-train.png`) is owned by the nav tour, which reaches Train by
  // its URL — the drive's own memory has no tab and no node on the map.
  await scenario('default')
  await page
    .getByRole('button', {
      name: 'Browser route: /w/acme/train/root',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(destinationHeading(page, 'Global memory')).toBeVisible()
  await page.getByLabel('Website URL').fill('Stripe.com')
  await page.getByRole('button', { name: 'Add', exact: true }).press('Enter')
  /* Exactly one row names it, once the list has settled. The optimistic attempt
     and the staged source the drive answers with are separate rows for the same
     URL — the list drops the server's copy while an attempt is outstanding, and
     the handover is a live swap inside an `AnimatePresence` — so for a moment
     the DOM can hold both. `toBeVisible` failed strict mode on that moment
     whenever the machine was loaded enough to catch it. Counting waits the
     window out and still fails on a genuine double add, which is the thing
     worth catching here. */
  await expect(page.getByText('https://stripe.com/', { exact: true })).toHaveCount(1)
  await shot('train-source-selected.png')
  await page.getByRole('button', { name: 'Start training', exact: true }).press('Enter')
  await expect(page.getByText('train_fixture_queued', { exact: true })).toBeVisible()

  const supportRecord = page.getByRole('link', {
    name: /Customer support handbook and escalation practices/,
  })
  await supportRecord.scrollIntoViewIfNeeded()
  await supportRecord.press('Enter')
  await expect(page.getByText('Enterprise customers receive a named owner')).toBeVisible()
  // Anchor the detail title to a fixed scroll alignment on both viewports —
  // scrollIntoViewIfNeeded leaves a prior-state-dependent position and the
  // shot frames differently run to run.
  await page
    .getByText('Customer support handbook and escalation practices', { exact: true })
    .evaluate(el => el.scrollIntoView({ block: 'start' }))
  await shot('train-record-detail.png')
  await page.getByRole('button', { name: 'Delete', exact: true }).press('Enter')
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await shot('train-record-delete-confirm.png')
  await page.getByRole('button', { name: 'Cancel', exact: true }).press('Enter')
  await page.getByRole('button', { name: 'Edit', exact: true }).press('Enter')
  await expect(page.getByLabel('Memory content')).toBeVisible()
  await shot('train-record-edit.png')

  // The preceding detail flow owns a browser route. Reload so this locale
  // scenario starts from its fixture-owned Train index instead of inheriting
  // the selected memory path.
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await scenario('train-spanish')
  const spanishRecord = page.getByRole('link', {
    name: /Manual de soporte al cliente y prácticas de escalamiento|Customer support handbook and escalation practices/,
  })
  await spanishRecord.scrollIntoViewIfNeeded()
  await spanishRecord.press('Enter')
  await expect(page.getByText('Memoria entrenada', { exact: true })).toBeVisible()
  await shot('train-spanish-detail.png')
})

test('playground/agent-train covers scoped ownership and concurrency', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  const scenario = scenarioSwitch(page)
  const mobile = (page.viewportSize()?.width ?? 0) < 768
  const shot = async (name: string) => {
    /* Every agent here wears a generated face, and a scenario switch mounts a
       fresh set of them. The ready signal decoded the images that existed when
       it fired, and `toHaveScreenshot` waits for fonts but not for these — so a
       capture can land while one is still decoding and photograph it soft. It
       shows up as a couple of thousand pixels of difference confined to the
       faces, on a run where the machine was busy enough to make decoding late. */
    await page.evaluate(
      async () =>
        void (await Promise.all(
          Array.from(document.images).map(image => image.decode().catch(() => undefined)),
        )),
    )
    await expect(page).toHaveScreenshot(name, { fullPage: !mobile })
  }

  await scenario('agent-train-local')
  await expect(page.getByRole('heading', { name: 'Research memory', exact: true })).toBeVisible()
  await expect(
    page.getByText('Research method and evidence standards', { exact: true }),
  ).toBeVisible()
  await shot('agent-train-local.png')

  await scenario('agent-train-inherited')
  await expect(
    page.getByRole('heading', { name: 'Research Child memory', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Inherited memories' })).toBeVisible()
  await expect(page.getByText(/^From Duet/)).toBeVisible()
  // Owner attribution reads as the agent's display name, matching the owner
  // avatar beside it — not the raw slug.
  await expect(page.getByText(/^From Research ·/)).toBeVisible()
  if (mobile) {
    // Viewport shots must frame the judged subject: the inherited section
    // stacks below the fold on mobile.
    await page.getByRole('heading', { name: 'Inherited memories' }).scrollIntoViewIfNeeded()
  }
  await shot('agent-train-inherited.png')

  await scenario('agent-train-concurrent')
  await expect(page.getByText('train_competitor_landscape', { exact: true })).toBeVisible()
  await expect(page.getByText('train_customer_interviews', { exact: true })).toBeVisible()
  await expect(page.getByText('train_market_signals', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Website URL')).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Start training' })).toBeEnabled()
  const loadOlderJobs = page.getByRole('button', { name: 'Load more' })
  await expect(loadOlderJobs).toBeVisible()
  await expect(loadOlderJobs).toHaveScreenshot('train-jobs-load-more.png')
  await loadOlderJobs.evaluate(element => element.scrollIntoView({ block: 'center' }))
  await shot('agent-train-concurrent.png')

  await scenario('agent-train-replica')
  await expect(
    page.getByRole('heading', { name: 'Shared Research memory', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText(
      'Review this shared agent’s jobs and memories. Only its owner can change training.',
      { exact: true },
    ),
  ).toBeVisible()
  await expect(page.getByText(/Train this agent on trusted sources/)).toHaveCount(0)
  await expect(page.getByText('Read-only shared agent', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Choose files' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start training' })).toHaveCount(0)
  await shot('agent-train-replica.png')

  await scenario('agent-train-mobile')
  const inheritedHeading = page.getByRole('heading', { name: 'Inherited memories' })
  await inheritedHeading.scrollIntoViewIfNeeded()
  await expect(
    page.getByText('Security escalation and disclosure rules', { exact: true }),
  ).toBeVisible()
  await shot('agent-train-mobile.png')
})

test('playground/train-memory-detail presents dedicated reading and editing', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Scenario: train-memory-detail',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())

  const mobile = (page.viewportSize()?.width ?? 0) < 768
  const shot = async (name: string) => {
    await expect(page).toHaveScreenshot(name, { fullPage: !mobile })
  }

  await expect(
    page.getByRole('heading', { name: 'Company-wide operating principles', exact: true }),
  ).toBeVisible()
  await expect(page.getByText('Every operating decision should leave a short trail')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
  if (mobile) {
    await page
      .getByText('Every operating decision should leave a short trail')
      .scrollIntoViewIfNeeded()
  }
  await shot('train-memory-detail.png')

  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const memoryEditor = page.getByRole('textbox', { name: 'Memory content' })
  await expect(memoryEditor).toBeVisible()
  await memoryEditor.fill(
    'Use explicit evidence grades, preserve dissenting signals, and name the decision each finding informs.\n\nEvery operating decision should leave a short trail: what changed, who owns the next move, and which evidence would reopen it.\n\nKeep exceptions specific and reviewable.',
  )
  /* The record's own header drops Back while editing, so a draft cannot be
     walked away from by accident. The scope rail keeps its own Back — that one
     is the Train control center's, not the record's, and it is a `Link` (it
     middle-clicks), so it answers to `link` rather than `button`. Together
     these pin exactly one Back on the page, and it is the rail's. */
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Back', exact: true })).toHaveCount(1)
  await expect(page.locator('aside').getByRole('link', { name: 'Back', exact: true })).toHaveCount(
    1,
  )
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible()
  await page
    .getByRole('heading', { name: 'Company-wide operating principles', exact: true })
    .click()
  await shot('train-memory-detail-editing.png')
})

test('playground/spa-shell covers integration lifecycle, catalog, and locale states', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  const scenario = scenarioSwitch(page)
  await page.getByRole('tab', { name: 'Integrations', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Integrations', exact: true })).toBeVisible()
  await expect(page.getByText('Gmail', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible()
  await expect(page.getByText('Pending', { exact: true }).locator('svg')).toHaveCSS(
    'animation-name',
    'spin',
  )
  await expect(page.getByText('Notion', { exact: true })).toBeVisible()
  await expect(page.locator('[data-integration-agent-access="gmail"] button')).toContainText(
    'All agents',
  )
  await expect(page.locator('[data-integration-agent-access="github"] button')).toContainText(
    '1 agent',
  )
  await expect(page.locator('[data-integration-agent-access="slack"] button')).toContainText(
    'No agents',
  )
  await expect(page).toHaveScreenshot('integrations-ready.png', { fullPage: true })
  const integrationSearch = page.getByLabel('Search integrations')
  await integrationSearch.fill('Linear')
  await expect(page.getByText('Linear', { exact: true })).toBeVisible()
  await expect(page.getByText('Notion', { exact: true })).toHaveCount(0)
  /* Not `scrollIntoViewIfNeeded`: whether the box needs scrolling depends on
     whether the filtered list has finished shrinking, so it lands at zero on
     one run and ninety pixels down on the next. A fixed alignment on the search
     box is deterministic and, unlike a top-of-page reset, still frames the
     filtered catalog now that a third panel sits above it. */
  await integrationSearch.evaluate(element => element.scrollIntoView({ block: 'start' }))
  await expect(page).toHaveScreenshot('integrations-search.png', { fullPage: true })
  await integrationSearch.fill('')
  await expect(page.getByRole('button', { name: 'Load more', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Load more', exact: true }).click()
  await expect(page.getByText('HubSpot', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('integrations-paginated.png', { fullPage: true })
  await page.getByRole('button', { name: 'Disconnect', exact: true }).first().click()
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await expect(page).toHaveScreenshot('integrations-disconnect-confirm.png', { fullPage: true })
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await scenario('integrations-loading')
  await expect(page.getByLabel('Loading integrations')).toBeVisible()
  await expect(page).toHaveScreenshot('integrations-loading.png', { fullPage: true })
  await scenario('integrations-error')
  await expect(page.getByRole('heading', { name: 'Integrations could not load' })).toBeVisible()
  await expect(page).toHaveScreenshot('integrations-error.png', { fullPage: true })
  await scenario('integrations-empty')
  await expect(page.getByText('No apps connected yet', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('integrations-empty.png', { fullPage: true })
  await scenario('integrations-connect-pending')
  /* Scoped to the catalog: the custom-server panel above it offers a Connect of
     its own on a server awaiting authorization, and a page-wide `.first()`
     would press that one instead. */
  await page
    .locator('[data-integration-catalog]')
    .getByRole('button', { name: 'Connect', exact: true })
    .first()
    .click()
  await expect(page.getByText('Connecting…', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('integrations-connecting.png', { fullPage: true })
  await scenario('integrations-callback-success')
  await expect(page.getByText('Integration connected', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('integrations-callback-success.png', { fullPage: true })
  await scenario('integrations-callback-canceled')
  await expect(page.getByText('Connection canceled', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('integrations-callback-canceled.png', { fullPage: true })
  await scenario('integrations-callback-error')
  await expect(page.getByText('Connection was not completed', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0)
  await expect(page.getByText('Connection was not completed', { exact: true })).toHaveCount(1)
  await expect(page).toHaveScreenshot('integrations-callback-error.png', { fullPage: true })
  await scenario('integrations-callback-provider-failed')
  await expect(page.getByText('Connection was not completed', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0)
  await expect(page).toHaveScreenshot('integrations-callback-provider-failed.png', {
    fullPage: true,
  })
  await scenario('integrations-spanish')
  await expect(destinationHeading(page, 'Integraciones')).toBeVisible()
  await expect(page.getByText('Conecta tus apps', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('integrations-spanish.png', { fullPage: true })
})

test('playground/spa-shell attaches a custom MCP server beside the connected apps', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  const scenario = scenarioSwitch(page)
  await page.getByRole('tab', { name: 'Integrations', exact: true }).click()
  const panel = page.locator('[data-mcp-servers-panel]')
  await expect(panel.getByText('Acme Internal', { exact: true })).toBeVisible()
  await expect(panel.getByText('24 tools · ≈2,450 tokens per turn', { exact: true })).toBeVisible()
  /* The per-agent editor is the same one the connected apps use, on a locator
     of its own: a workspace may name a server after a toolkit it also
     connects, and one attribute for both would make every toolkit locator on
     this page match two editors. */
  await expect(page.locator('[data-mcp-server-agent-access="acme_internal"] button')).toContainText(
    'All agents',
  )
  await expect(page.locator('[data-mcp-server-agent-access="research_wire"] button')).toContainText(
    '1 agent',
  )
  await expect(page.locator('[data-mcp-server-agent-access="ops_bridge"] button')).toContainText(
    'No agents',
  )
  await expect(page.locator('[data-integration-agent-access]')).toHaveCount(3)
  // The health line is the only place a server the runner cannot reach is
  // visible at all.
  await expect(panel.getByText(/Could not reach the server/)).toBeVisible()
  /* Not "waiting for authorization": beside a Connect button that copy claims a
     flow is already in flight, and the row is exactly the one where none has
     started. */
  await expect(panel.getByText('Not authorized yet', { exact: true })).toBeVisible()
  /* D2 reaches the product here: the row that has never been authorized is the
     row that can be consented to, and no other row offers the action. */
  await expect(panel.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(1)
  await page.mouse.move(0, 0)
  await expect(panel).toHaveScreenshot('integrations-mcp-servers.png')

  await panel.getByRole('button', { name: 'Add server', exact: true }).click()
  await page.getByLabel('Server URL').fill('https://mcp.contoso.test/mcp')
  // The name is the tool prefix every agent reads, so it is offered from the
  // host rather than demanded.
  await expect(page.getByLabel('Name')).toHaveValue('contoso')
  await page.getByRole('button', { name: 'Check server', exact: true }).click()
  await expect(page.getByText('Reachable', { exact: true })).toBeVisible()
  await expect(page.getByText('8 tools · ≈900 tokens per turn', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('integrations-mcp-add-probed.png', { fullPage: true })
  await page.getByTestId('mcp-server-add-confirm').click()
  await expect(panel.getByText('contoso', { exact: true })).toBeVisible()
  await expect(page.locator('[data-mcp-server-agent-access="contoso"]')).toHaveCount(1)

  await scenario('integrations-mcp-probing')
  await page.locator('[data-mcp-servers-panel]').getByRole('button', { name: 'Add server' }).click()
  // A second name: the one added above is now taken, and the dialog refuses a
  // duplicate before it reaches the network.
  await page.getByLabel('Server URL').fill('https://mcp.fabrikam.test/mcp')
  await page.getByRole('button', { name: 'Check server', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Checking…', exact: true })).toBeDisabled()
  await expect(page).toHaveScreenshot('integrations-mcp-add-probing.png', { fullPage: true })
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()

  await scenario('integrations-mcp-states')
  const states = page.locator('[data-mcp-servers-panel]')
  await expect(states.getByText('Billing Ledger', { exact: true })).toBeVisible()
  await expect(states.getByText(/The credential is no longer accepted/)).toBeVisible()
  // A dead credential is recoverable from the product, not only removable.
  await expect(states.getByRole('button', { name: 'Reconnect', exact: true })).toHaveCount(1)
  // D8's dropped tools are named on the row, not silently missing.
  await expect(states.getByText(/2 tools left out/)).toBeVisible()
  // Centred rather than left where Playwright's own scroll lands it: the shell's
  // floating tab bar overlays the top of the viewport and would sit across the
  // panel header.
  await states.evaluate(element => element.scrollIntoView({ block: 'center' }))
  await page.mouse.move(0, 0)
  await expect(states).toHaveScreenshot('integrations-mcp-states.png')

  await scenario('integrations-mcp-error')
  // The workspace's own servers and the provider catalog fail independently:
  // one panel says so and the other keeps its rows.
  await expect(page.getByText('Custom servers could not load', { exact: true })).toBeVisible()
  await expect(page.getByText('Gmail', { exact: true }).first()).toBeVisible()
  await expect(page).toHaveScreenshot('integrations-mcp-error.png', { fullPage: true })
})

test('playground/spa-shell edits integration agent access immediately and rolls back one row', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  const scenario = scenarioSwitch(page)
  const access = (integration: string) =>
    page.locator(`[data-integration-agent-access="${integration}"]`)
  const panel = (integration: string) =>
    page.locator(`[data-integration-agent-access-panel="${integration}"]`)

  await page.getByRole('tab', { name: 'Integrations', exact: true }).click()
  const gmail = access('gmail')
  const gmailPanel = panel('gmail')
  await gmail.getByRole('button').click()
  await expect(gmailPanel.getByRole('checkbox', { name: 'All agents' })).toBeChecked()
  await expect(gmailPanel.getByRole('checkbox', { name: 'Duet' })).toBeChecked()
  await expect(gmailPanel.getByRole('checkbox', { name: 'Research' })).toBeChecked()
  await page.mouse.move(0, 0)
  await expect(gmailPanel).toHaveScreenshot('integrations-agent-access-all.png')

  await gmailPanel.getByRole('checkbox', { name: 'Research' }).click()
  await expect(page.getByTestId('integration-policy-mutation')).toHaveText(
    '{"integration":"gmail","input":{"allowedAgentIds":["root","agent_reviewer"]}}',
  )
  await expect(gmailPanel.getByRole('checkbox', { name: 'All agents' })).not.toBeChecked()
  await expect(gmailPanel.getByRole('checkbox', { name: 'Duet' })).toBeChecked()
  await expect(gmailPanel.getByRole('checkbox', { name: 'Reviewer' })).toBeChecked()
  await expect(gmail.locator('../..').getByText('Gmail', { exact: true })).toBeVisible()
  await expect(gmail.locator('../..').getByText('Connected', { exact: true })).toBeVisible()

  const github = access('github')
  const githubPanel = panel('github')
  await github.getByRole('button').click()
  await expect(githubPanel.getByRole('checkbox', { name: 'Duet' })).not.toBeChecked()
  await expect(githubPanel.getByRole('checkbox', { name: 'Research' })).toBeChecked()
  await page.mouse.move(0, 0)
  await expect(githubPanel).toHaveScreenshot('integrations-agent-access-partial.png')
  const slack = access('slack')
  const slackPanel = panel('slack')
  await slack.getByRole('button').click()
  await expect(slackPanel.getByRole('checkbox', { name: 'All agents' })).not.toBeChecked()
  await expect(slackPanel.getByRole('checkbox', { name: 'Duet' })).not.toBeChecked()
  await page.mouse.move(0, 0)
  await expect(slackPanel).toHaveScreenshot('integrations-agent-access-nobody.png')

  await scenario('integrations-agent-access-pending')
  const pendingGmail = access('gmail')
  const pendingGmailPanel = panel('gmail')
  const pendingSlack = access('slack')
  const pendingSlackPanel = panel('slack')
  await pendingGmail.getByRole('button').click()
  await pendingGmailPanel.getByRole('checkbox', { name: 'Research' }).click()
  await expect(pendingGmail).toHaveAttribute('aria-busy', 'true')
  await expect(pendingGmail.getByRole('button')).toContainText('Saving…')
  await expect(pendingGmailPanel.getByRole('checkbox', { name: 'Duet' })).toBeDisabled()
  await page.mouse.move(0, 0)
  await expect(pendingGmailPanel).toHaveScreenshot('integrations-agent-access-pending.png')

  // Opening a second dropdown dismisses the first, the same as any other
  // popover: only one connected row's checklist is ever on screen at once.
  await pendingSlack.getByRole('button').click()
  await expect(pendingSlackPanel.getByRole('checkbox', { name: 'Duet' })).toBeEnabled()
  await pendingSlackPanel.getByRole('checkbox', { name: 'Duet' }).click()
  await expect(pendingSlack).toHaveAttribute('aria-busy', 'true')

  await scenario('integrations-agent-access-error')
  const failingGmail = access('gmail')
  const failingGmailPanel = panel('gmail')
  await failingGmail.getByRole('button').click()
  const failingResearch = failingGmailPanel.getByRole('checkbox', { name: 'Research' })
  await failingResearch.click()
  await expect(failingResearch).not.toBeChecked()
  await expect(failingGmail).toHaveAttribute('aria-busy', 'true')
  await expect(failingGmail.getByRole('alert')).toBeVisible()
  await expect(failingResearch).toBeChecked()
  await expect(failingGmail.getByRole('button')).toBeFocused()
  await expect(failingGmail.locator('../..').getByText('Gmail', { exact: true })).toBeVisible()
  await expect(failingGmail.locator('../..').getByText('Connected', { exact: true })).toBeVisible()
  await expect(failingGmail).not.toHaveAttribute('aria-busy', 'true')
  await page.mouse.move(0, 0)
  await expect(failingGmailPanel).toHaveScreenshot('integrations-agent-access-error.png')
})

test('playground/spa-shell keeps 500 integration agents bounded and reachable', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', {
      name: 'Scenario: integrations-agent-access-overflow',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())

  const editor = page.locator('[data-integration-agent-access="gmail"]')
  const editorPanel = page.locator('[data-integration-agent-access-panel="gmail"]')
  const startedAt = await page.evaluate(() => performance.now())
  await editor.getByRole('button').click()
  const list = editorPanel.locator('.overflow-y-auto')
  const first = editorPanel.getByRole('checkbox', { name: 'Agent 001' })
  await expect(first).toBeVisible()
  await first.focus()
  await page.keyboard.press('Space')
  await expect(first).not.toBeChecked()
  await expect(editor).not.toHaveAttribute('aria-busy', 'true')
  await first.focus()
  await page.keyboard.press('Space')
  await expect(first).toBeChecked()
  await expect(editor).not.toHaveAttribute('aria-busy', 'true')
  const bounds = await list.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  expect(bounds.scrollHeight).toBeGreaterThan(bounds.clientHeight)
  await page.mouse.move(0, 0)
  await expect(editorPanel).toHaveScreenshot('integrations-agent-access-overflow-top.png')

  const middle = editorPanel.getByRole('checkbox', { name: 'Agent 250' })
  await middle.scrollIntoViewIfNeeded()
  await expect(middle).toBeChecked()
  await middle.focus()
  await page.keyboard.press('Space')
  await expect(middle).not.toBeChecked()
  await expect(editor).not.toHaveAttribute('aria-busy', 'true')
  await middle.focus()
  await page.keyboard.press('Space')
  await expect(middle).toBeChecked()
  await expect(editor).not.toHaveAttribute('aria-busy', 'true')
  const last = editorPanel.getByRole('checkbox', { name: 'Agent 500' })
  await last.scrollIntoViewIfNeeded()
  await expect(last).toBeChecked()
  await last.focus()
  await page.keyboard.press('Space')
  await expect(last).not.toBeChecked()
  await expect(editor).not.toHaveAttribute('aria-busy', 'true')
  await expect(editor.getByRole('button')).toContainText('3 agents')
  await page.mouse.move(0, 0)
  await expect(editorPanel).toHaveScreenshot('integrations-agent-access-overflow-end.png')

  const failedWhileScrolled = editorPanel.getByRole('checkbox', { name: 'Agent 499' })
  const scrollTopBeforeFailure = await list.evaluate(element => element.scrollTop)
  await failedWhileScrolled.focus()
  /* Armed before the keystroke, not after it.

     `aria-busy` is true only while the mutation is in flight, and every
     assertion between the press and the check spends some of that flight — so
     on a fast run the row had already failed and rolled back before anything
     looked, and the gate went red for the one reason that is not a defect.
     Calling `expect` first starts its poll first: the claim is unchanged, and it
     can no longer be missed by winning a race. */
  const wentBusy = expect(editor).toHaveAttribute('aria-busy', 'true')
  await page.keyboard.press('Space')
  await expect(failedWhileScrolled).toBeChecked()
  await wentBusy
  expect(await list.evaluate(element => element.scrollTop)).toBe(scrollTopBeforeFailure)
  await expect(editor.getByRole('alert')).toBeVisible()
  await expect(failedWhileScrolled).not.toBeChecked()
  await expect(editor.getByRole('button')).toBeFocused()
  expect(await list.evaluate(element => element.scrollTop)).toBe(scrollTopBeforeFailure)

  const finishedAt = await page.evaluate(() => performance.now())
  console.log(
    `integration-agent-access 501-principal interaction: ${Math.round(finishedAt - startedAt)}ms`,
  )
  const pageOverflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(pageOverflow.scrollWidth).toBe(pageOverflow.clientWidth)
  const editorOverflow = await editorPanel.evaluate(element => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  expect(editorOverflow.scrollWidth).toBe(editorOverflow.clientWidth)
  const listOverflow = await list.evaluate(element => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  expect(listOverflow.scrollWidth).toBe(listOverflow.clientWidth)
  if ((page.viewportSize()?.width ?? 0) < 768) {
    await page.mouse.move(0, 0)
    await expect(page).toHaveScreenshot('integrations-agent-access-overflow-mobile.png', {
      fullPage: true,
    })
  }
})

test('playground/spa-shell drives an app from the menu on its agent card', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const scenario = scenarioSwitch(page)
  const framedApp = (name: string) => page.frameLocator(`iframe[title="${name}"]`)
  // The Spanish leg switches the whole shell, so the trigger answers to either
  // name — asserting one of them would pass on English and hang on Spanish.
  const openMenu = async () => {
    await page.getByRole('button', { name: /^(App options|Opciones de la app)$/ }).click()
    await expect(page.getByRole('menu')).toBeVisible()
  }
  /* Shut for real before touching anything outside it. The menu is modal, so
     Radix `aria-hidden`s the rest of the document while it is open — including
     the scenario switcher, which then cannot be found by role and waits out the
     whole timeout. One Escape is not always enough either: with a tooltip open
     the first press belongs to the tooltip. */
  const closeMenu = async () => {
    // Pointer off the item first: while a tooltip is open it takes the Escape,
    // and the menu stays up with the rest of the document aria-hidden behind
    // it. Moving away dismisses the tooltip without a key at all.
    await page.mouse.move(0, 0)
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
  }

  /* The app has no page of its own any more: it is staged on the card of the
     agent whose folder encloses it, and everything that can be done to it is
     on the one chip that names it. */
  await scenario('agent-app-menu')
  await expect(framedApp('Launch intelligence').getByRole('heading', { level: 1 })).toContainText(
    'reporting',
  )

  // A private app advertises no public URL at all — its own address answers 403
  // to every viewer, members included, and it runs through the launch frame.
  await openMenu()
  await expect(page.getByRole('menu')).toContainText('Private')
  await expect(page.getByRole('menuitem', { name: 'Publish', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Copy public link' })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Open in new tab' })).toHaveCount(0)
  // What authority the app holds stays legible after install, elevated marked.
  await expect(page.getByRole('menu')).toContainText('API access')
  await expect(page.getByRole('menu').getByLabel('Write files: Elevated capability')).toBeVisible()
  await expect(page.getByRole('menu')).toHaveScreenshot('app-menu-private.png')

  await page.getByRole('menuitem', { name: 'Publish', exact: true }).click()
  await openMenu()
  await expect(page.getByRole('menu')).toContainText('Public')
  for (const label of ['Open in new tab', 'Copy public link', 'Make private', 'Delete app']) {
    await expect(page.getByRole('menuitem', { name: label, exact: true })).toBeVisible()
  }
  await expect(page.getByRole('menu')).toHaveScreenshot('app-menu-public.png')

  // Deleting is the one thing here that cannot be taken back, so it is the one
  // thing that stops to ask — and it says what survives, which is the folder.
  await page.getByRole('menuitem', { name: 'Delete app', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toContainText('Delete Launch intelligence?')
  await expect(page.getByRole('alertdialog')).toContainText('stays on the Drive')
  await expect(page).toHaveScreenshot('app-menu-delete-confirm.png', { fullPage: true })
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)

  /* Every item says what it does, off to the right of the menu. `Publish` and
     `Delete app` are two words each and neither says what it leaves behind, so
     the tooltip is where a reader who has not done this before finds out. */
  await openMenu()
  /* Asserted by the tooltip's own words, not by the role alone: the one being
     dismissed and the one opening are both in the DOM for a frame, so a bare
     `getByRole('tooltip')` is two elements often enough to fail at random. */
  for (const [label, says] of [
    ['Open in new tab', 'in a new tab'],
    ['Copy public link', 'send it to someone'],
    ['Make private', 'Stop serving the public URL'],
    ['Delete app', 'folder stays on the Drive'],
  ] as const) {
    await page.getByRole('menuitem', { name: label, exact: true }).hover()
    await expect(page.getByRole('tooltip', { name: new RegExp(says) })).toBeVisible()
  }
  await expect(page).toHaveScreenshot('app-menu-tooltip.png', { fullPage: true })
  await closeMenu()

  /* A subscription-owned app still waiting for its files. It cannot run, so the
     frame says it is coming rather than inviting a switch back on that does not
     exist — and neither publishing nor deleting is offered, because it leaves by
     uninstalling the subscription that ships it. */
  await scenario('agent-app-installing')
  await expect(page.getByText('still arriving from its publisher')).toBeVisible()
  await openMenu()
  await expect(page.getByRole('menuitem', { name: 'Delete app', exact: true })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Publish', exact: true })).toHaveCount(0)
  await expect(page).toHaveScreenshot('app-installing.png', { fullPage: true })
  await closeMenu()

  await scenario('agent-app-menu-es')
  await openMenu()
  await expect(page.getByRole('menuitem', { name: 'Eliminar app', exact: true })).toBeVisible()
  await expect(page.getByRole('menu')).toHaveScreenshot('app-menu-spanish.png')
})

test('playground/billing-settings covers subscription billing states', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  const scenario = scenarioSwitch(page)

  await scenario('settings-billing-trial')
  await expect(page.getByRole('heading', { name: 'Choose your plan', exact: true })).toBeVisible()
  await expect(page.getByText('Monthly credits included', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Subscribe to Pro', exact: true })).toBeVisible()
  await expect(page.getByText('Recommended', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Automatic top-up', exact: true })).toHaveCount(0)
  await expect(page).toHaveScreenshot('settings-billing-trial.png', { fullPage: true })

  await scenario('settings-billing-active-starter')
  await expect(page.getByText('25% used', { exact: true })).toBeVisible()
  await expect(page.getByText('75% remaining this period', { exact: true })).toBeVisible()
  await expect(page.getByText('$12.50', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Upgrade to Pro now', exact: true })).toBeVisible()
  /* On Starter the Pro tier is still an upgrade, so the promotion stays. */
  await expect(page.getByText('Recommended', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /Cancel plan on Aug 1, 2026/ })).toBeVisible()
  await expect(page.getByText('Monthly credits renewed', { exact: true })).toBeVisible()
  await expect(page.getByText('Unused monthly credits expired', { exact: true })).toBeVisible()
  await expect(page.getByText(/^Account ·/)).toHaveCount(2)
  await expect(page).toHaveScreenshot('settings-billing-active-starter.png', { fullPage: true })

  /* The settings surface scrolls inside its own container, so `fullPage` stops
     at the viewport and the history card is below the fold. Scrolling to the
     payer footer pins the end of the scroll area, which is what puts the
     transaction labels -- model spend next to the VM compute fee that must not
     be confused with it -- under a baseline at all. */
  await page.getByText(/^You currently fund/).scrollIntoViewIfNeeded()
  await expect(page.getByText('Usage', { exact: true })).toBeVisible()
  await expect(page.getByText('VM compute', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('settings-billing-history.png')

  await page.getByRole('button', { name: 'Upgrade to Pro now', exact: true }).click()
  await expect(page.getByText('Changes saved.', { exact: true }).last()).toBeVisible()

  await scenario('settings-billing-active-pro-overage')
  await expect(page.getByText('100% used', { exact: true })).toBeVisible()
  /* Already subscribed at Pro or above: there is nothing to promote, so the
     Pro card sheds its Recommended badge and reads like any other tier. */
  await expect(page.getByText('Recommended', { exact: true })).toHaveCount(0)
  await expect(page.getByText('0% remaining this period', { exact: true })).toBeVisible()
  await expect(page.getByText('$24.80', { exact: true })).toBeVisible()
  /* Automatic refills and a one-time Stripe payment are different actions, so
     they live in different cards: the refill card carries its own Save, and
     the one-time card carries its own amount. */
  await expect(page.getByRole('heading', { name: 'Automatic top-up', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'One-time top-up', exact: true })).toBeVisible()
  await expect(page.getByLabel('Automatically refill my paid reserve')).toBeChecked()
  await expect(page).toHaveScreenshot('settings-billing-active-pro-overage.png', {
    fullPage: true,
  })
  /* Save sends the numbers on their own, and the saved value must survive the
     overview the server hands back. */
  await page.getByLabel('Top-up amount').fill('25')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  /* While the save is in flight the fields lock: an edit typed now would be
     overwritten the moment the older save's response lands. */
  await expect(page.getByLabel('Top-up amount')).toBeDisabled()
  await expect(page.getByText('Changes saved.', { exact: true }).last()).toBeVisible()
  await expect(page.getByLabel('Top-up amount')).toBeEnabled()
  await expect(page.getByLabel('Top-up amount')).toHaveValue('25')
  await expect(page.getByLabel('Automatically refill my paid reserve')).toBeChecked()
  /* A further edit is unsaved again, so the confirmation must not outlive it. */
  await page.getByLabel('Top-up amount').fill('30')
  await expect(page.getByText('Changes saved.', { exact: true })).toHaveCount(0)

  await scenario('settings-billing-canceling')
  await expect(page.getByText('Active until Aug 1, 2026', { exact: true })).toBeVisible()
  await expect(page.getByText(/workspaces and monthly credits stay active/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Keep my plan', exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('settings-billing-canceling.png', { fullPage: true })
  await page.getByRole('button', { name: 'Keep my plan', exact: true }).click()
  await expect(page.getByText('Changes saved.', { exact: true }).last()).toBeVisible()

  await scenario('settings-billing-downgrade-scheduled')
  await expect(page.getByText('Switching to Starter on Aug 1, 2026', { exact: true })).toBeVisible()
  await expect(page.getByText('Nothing changes today.', { exact: false })).toBeVisible()
  await expect(page).toHaveScreenshot('settings-billing-downgrade-scheduled.png', {
    fullPage: true,
  })

  await scenario('settings-billing-lapsed')
  await expect(page.getByText('Workspaces paused', { exact: true })).toBeVisible()
  await expect(
    page.getByText(/paid balance is retained and available after resubscribing/).first(),
  ).toBeVisible()
  await expect(page.getByRole('link', { name: 'Resubscribe', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Subscribe to Pro', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Automatic top-up', exact: true })).toHaveCount(0)
  await expect(page).toHaveScreenshot('settings-billing-lapsed.png', { fullPage: true })

  await scenario('settings-billing-past-due')
  await page.getByRole('button', { name: 'Upgrade to Pro now', exact: true }).click()
  await expect(page.getByText('Changes saved.', { exact: true }).last()).toBeVisible()

  await scenario('settings-billing-topup-error')
  await expect(page.getByText('The last automatic top-up failed', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Automatic top-up', exact: true })).toBeVisible()
  await expect(page.getByLabel('Automatically refill my paid reserve')).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Payment methods & invoices' }).last(),
  ).toBeVisible()
  await expect(page).toHaveScreenshot('settings-billing-topup-error.png', { fullPage: true })
  const maxUpgrade = page.getByRole('button', { name: 'Upgrade to Max now', exact: true })
  await maxUpgrade.click()
  await expect(maxUpgrade).toBeDisabled()
  await expect(
    page
      .getByText('That change could not be saved. Review the current access and try again.', {
        exact: true,
      })
      .last(),
  ).toBeVisible()

  await scenario('settings-billing-error')
  await expect(page.getByText('The last automatic top-up failed', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('settings-billing-declined.png', { fullPage: true })
})

/* Its own test, not another scene in the billing sweep: returning from checkout
   records the payment in localStorage for the grace window, and a later scene
   sharing this page context would inherit a celebration it never asked for. */
test('playground/billing-settings greets a payer returning from checkout', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await scenarioSwitch(page)('settings-billing-payment-received')
  await expect(page.locator('[data-checkout-celebration]')).toHaveText(
    'Payment received. Your balance updates in a moment.',
  )
  await expect(page).toHaveScreenshot('settings-billing-payment-received.png', { fullPage: true })
})

test('playground/settings keeps one way back to the workspace across settings pages', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  await page.getByRole('button', { name: 'Account and settings' }).click()
  await page.getByRole('menuitem', { name: 'Workspace settings' }).click()
  await expect(page.locator('[data-destination-content="workspaceSettings"]')).toBeVisible()

  await page.getByRole('link', { name: 'Members', exact: true }).click()
  await page.getByRole('link', { name: 'Back to workspace', exact: true }).click()

  await expect(page.locator('[data-destination-content="agentPage"]')).toBeVisible()
  await expect(page.locator('[data-destination-content="workspaceSettings"]')).toHaveCount(0)
})

test('playground/spa-shell covers settings authorization, failures, billing, keys, and Spanish', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  const scenario = scenarioSwitch(page)

  await scenario('settings-viewer')
  await expect(page.getByRole('heading', { name: /^\d+ members$/ })).toBeVisible()
  await expect(page.getByRole('combobox')).toHaveCount(0)
  await expect(page).toHaveScreenshot('settings-viewer-members.png', { fullPage: true })

  await scenario('settings-not-payer')
  await expect(page.getByText('You are not a designated payer', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('settings-not-payer.png', { fullPage: true })

  await scenario('settings-error')
  await expect(page.getByText('Settings could not load', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('settings-profile-error.png', { fullPage: true })

  await scenario('telemetry-loading')
  await expect(page.getByLabel('Loading VM telemetry history.')).toBeVisible()
  await expect(page).toHaveScreenshot('settings-telemetry-loading.png', { fullPage: true })

  await scenario('telemetry-error')
  await expect(
    page.getByText('VM telemetry is temporarily unavailable.', { exact: true }),
  ).toBeVisible()
  await expect(page).toHaveScreenshot('settings-telemetry-error.png', { fullPage: true })

  await scenario('telemetry-empty')
  await expect(page.getByText('No telemetry yet', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('settings-telemetry-empty.png', { fullPage: true })

  await scenario('settings-spanish')
  await expect(
    page.getByRole('heading', { name: 'Pagador designado', exact: true, level: 1 }),
  ).toBeVisible()
  await expect(page.getByText(/No se puede eliminar ni degradar al pagador/)).toBeVisible()
  await expect(page).toHaveScreenshot('settings-spanish-payer.png', { fullPage: true })

  await scenario('default')
  await page
    .getByRole('button', { name: 'Browser route: /settings/billing', exact: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByRole('heading', { name: 'Choose your plan', exact: true })).toBeVisible()
  await page
    .getByRole('button', {
      name: 'Browser route: /w/acme/settings/billing-user',
      exact: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await page.getByRole('button', { name: /Grace Hopper/ }).click()
  await expect(page.getByRole('button', { name: /Grace Hopper/ })).toHaveClass(/border-primary/)
  await expect(page).toHaveScreenshot('settings-payer-reassigned.png', { fullPage: true })
  await page
    .getByRole('button', { name: 'Browser route: /settings/billing', exact: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByText('You currently fund 1 workspace.', { exact: true })).toBeVisible()
})

test('playground/spa-shell covers managed share states, privacy, confirms, empty, and error', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  const scenario = scenarioSwitch(page)
  const row = (direction: 'incoming' | 'outgoing', path: string) =>
    page.locator(`[data-share-direction="${direction}"]`).filter({ hasText: path })

  await scenario('settings-shares')
  await expect(destinationHeading(page, 'Shares')).toBeVisible()
  await expect(page.getByText('Up to date', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Syncing', { exact: true })).toBeVisible()
  await expect(page.getByText('Pending', { exact: true })).toBeVisible()
  await expect(page.getByText('Expired', { exact: true })).toBeVisible()
  await expect(page.getByText('Unlinked', { exact: true })).toBeVisible()
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible()
  expect(
    (await page.locator('[data-share-direction="outgoing"]').allTextContents()).join('\n'),
  ).not.toContain('private-recipient-destination')
  const mobileMore = page.getByRole('button', { name: 'More', exact: true })
  if (await mobileMore.isVisible()) {
    const [unlinkBox, bottomNavBox] = await Promise.all([
      row('incoming', 'Shared/Launch plan').getByRole('button', { name: 'Unlink' }).boundingBox(),
      mobileMore.locator('..').boundingBox(),
    ])
    expect(unlinkBox).not.toBeNull()
    expect(bottomNavBox).not.toBeNull()
    expect(unlinkBox!.y + unlinkBox!.height).toBeLessThanOrEqual(bottomNavBox!.y - 8)
  }
  await expect(page).toHaveScreenshot('settings-shares-matrix.png', { fullPage: true })

  await row('incoming', 'Shared/Launch plan').getByRole('button', { name: 'Unlink' }).click()
  await expect(page.getByRole('alertdialog')).toContainText(
    'Files stay in your workspace, apps keep running as your own apps, and updates stop both ways.',
  )
  await expect(page).toHaveScreenshot('settings-shares-unlink-confirm.png', { fullPage: true })
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click()

  await row('outgoing', 'Projects/QBR').getByRole('button', { name: 'Revoke' }).click()
  await expect(page.getByRole('alertdialog')).toContainText(
    'The recipient keeps files received so far, and updates stop.',
  )
  await expect(page).toHaveScreenshot('settings-shares-revoke-confirm.png', { fullPage: true })
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click()

  await scenario('settings-shares-empty')
  await expect(page.getByText('No managed shares yet', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('settings-shares-empty.png', { fullPage: true })

  await scenario('settings-shares-error')
  await expect(
    page.getByText('Shares could not be loaded. Try again.', { exact: true }),
  ).toBeVisible({ timeout: 12_000 })
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('settings-shares-error.png', { fullPage: true })
})

test('playground/spa-shell covers every connected-provider card state', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  const scenario = scenarioSwitch(page)
  const provider = (id: 'openai-codex' | 'github-copilot') =>
    page.locator(`[data-provider="${id}"]`)

  await scenario('settings-connected-providers')
  await expect(destinationHeading(page, 'Connected providers')).toBeVisible()
  await expect(provider('openai-codex')).toContainText('Connected by Ada Lovelace')
  await expect(provider('github-copilot')).toContainText('Reconnect needed')
  await expect(provider('github-copilot').getByRole('button', { name: 'Disconnect' })).toHaveCount(
    0,
  )
  await expect(page).toHaveScreenshot('settings-connected-providers.png', { fullPage: true })

  await scenario('settings-connected-providers-plan-ineligible')
  await expect(provider('openai-codex')).toContainText('Not connected')
  await expect(provider('github-copilot')).toContainText('plan is not eligible')
  await expect(page).toHaveScreenshot('settings-connected-providers-plan-ineligible.png', {
    fullPage: true,
  })

  await scenario('settings-connected-providers-connecting')
  await provider('openai-codex').getByRole('button', { name: 'Connect' }).click()
  await expect(provider('openai-codex')).toContainText('Connecting…')
  await expect(page).toHaveScreenshot('settings-connected-providers-connecting.png', {
    fullPage: true,
  })

  await scenario('settings-connected-providers-awaiting-code')
  await provider('openai-codex').getByRole('button', { name: 'Connect' }).click()
  await expect(provider('openai-codex')).toContainText('DUET-CODE')
  await expect(provider('openai-codex').getByRole('button', { name: 'Copy code' })).toBeVisible()
  await expect(page).toHaveScreenshot('settings-connected-providers-awaiting-code.png', {
    fullPage: true,
  })

  await scenario('settings-connected-providers-failed')
  await provider('openai-codex').getByRole('button', { name: 'Connect' }).click()
  await expect(provider('openai-codex')).toContainText('Connection failed')
  await expect(page).toHaveScreenshot('settings-connected-providers-failed.png', {
    fullPage: true,
  })

  await scenario('settings-connected-providers-disconnecting')
  await provider('openai-codex').getByRole('button', { name: 'Disconnect' }).click()
  await expect(provider('openai-codex')).toContainText('Disconnecting…')
  await expect(page).toHaveScreenshot('settings-connected-providers-disconnecting.png', {
    fullPage: true,
  })
})

test('playground/spa-shell covers publish pause controls in both locales', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  const scenario = scenarioSwitch(page)
  for (const locale of ['en', 'es'] as const) {
    const suffix = locale === 'es' ? '-es' : ''
    const labels =
      locale === 'es'
        ? {
            freeze: 'Congelar weekly',
            resume: 'Reanudar weekly',
            live: 'En vivo',
            frozen: 'Congelado',
            freezing: 'Congelando',
            resuming: 'Reanudando',
            error: 'No se pudo actualizar esa publicación. Se restauró su estado anterior.',
          }
        : {
            freeze: 'Freeze weekly',
            resume: 'Resume weekly',
            live: 'Live',
            frozen: 'Frozen',
            freezing: 'Freezing',
            resuming: 'Resuming',
            error: 'That publish could not be updated. Its previous state was restored.',
          }
    await scenario(`publishes-live${suffix}`)
    await expect(page.getByText(labels.live, { exact: true }).first()).toBeVisible()
    await expect(page).toHaveScreenshot(`settings-publishes-live-${locale}.png`, {
      fullPage: true,
    })
    await scenario(`publishes-pausing${suffix}`)
    await page.getByRole('switch', { name: labels.freeze }).click()
    await expect(page.getByText(labels.freezing, { exact: true })).toBeVisible()
    await expect(page).toHaveScreenshot(`settings-publishes-pausing-${locale}.png`, {
      fullPage: true,
    })
    await scenario(`publishes-frozen${suffix}`)
    await expect(page.getByText(labels.frozen, { exact: true })).toBeVisible()
    await expect(page).toHaveScreenshot(`settings-publishes-frozen-${locale}.png`, {
      fullPage: true,
    })
    await scenario(`publishes-resuming${suffix}`)
    await page.getByRole('switch', { name: labels.resume }).click()
    await expect(page.getByText(labels.resuming, { exact: true })).toBeVisible()
    await expect(page).toHaveScreenshot(`settings-publishes-resuming-${locale}.png`, {
      fullPage: true,
    })
    await scenario(`publishes-error${suffix}`)
    await page.getByRole('switch', { name: labels.freeze }).click()
    await expect(page.getByRole('alert').filter({ hasText: labels.error })).toBeVisible()
    await expect(page.getByRole('switch', { name: labels.freeze })).toHaveAttribute(
      'aria-checked',
      'false',
    )
    await expect(page).toHaveScreenshot(`settings-publishes-error-${locale}.png`, {
      fullPage: true,
    })
  }
})

test('playground/spa-shell covers share pause controls in both locales', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  const scenario = scenarioSwitch(page)
  for (const locale of ['en', 'es'] as const) {
    const suffix = locale === 'es' ? '-es' : ''
    const freezeIncoming =
      locale === 'es' ? 'Pausar Shared/Launch plan' : 'Freeze Shared/Launch plan'
    const paused = locale === 'es' ? 'En pausa' : 'Paused'
    const updateError =
      locale === 'es'
        ? 'No se pudo actualizar el compartido. Inténtalo de nuevo.'
        : 'The share could not be updated. Try again.'
    await scenario(`shares-paused-incoming${suffix}`)
    await expect(page.getByText(paused, { exact: true })).toBeVisible()
    await expect(page).toHaveScreenshot(`settings-shares-paused-incoming-${locale}.png`, {
      fullPage: true,
    })
    await scenario(`shares-paused-outgoing${suffix}`)
    await expect(page.getByText(paused, { exact: true })).toBeVisible()
    await expect(page).toHaveScreenshot(`settings-shares-paused-outgoing-${locale}.png`, {
      fullPage: true,
    })
    await scenario(`shares-busy${suffix}`)
    await page.getByRole('switch', { name: freezeIncoming }).click()
    await expect(page.getByRole('switch', { name: freezeIncoming })).toBeDisabled()
    await expect(page).toHaveScreenshot(`settings-shares-busy-${locale}.png`, { fullPage: true })
    await scenario(`shares-failure${suffix}`)
    await page.getByRole('switch', { name: freezeIncoming }).click()
    await expect(page.getByRole('alert').filter({ hasText: updateError })).toBeVisible()
    await expect(page).toHaveScreenshot(`settings-shares-failure-${locale}.png`, {
      fullPage: true,
    })
  }
})

/* The map's URL chain, end to end, in a real browser with real key events.
   Two things here have never been testable before and are the whole point of
   the feature: a *cold* link opens the agent it names, and one Escape moves the
   URL exactly one step. The archived spec flagged the second explicitly — the
   pure rule in `keys.ts` was pinned, but nothing anywhere drove a real Escape
   against the map with a dialog over it, which is the arrangement where the map
   used to fly out from under the layer it hosts. */
test('playground/spa-shell addresses the map, and Escape leaves one layer at a time', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  const openRoute = async (path: string) =>
    await page
      .getByRole('button', { name: `Browser route: ${path}`, exact: true, includeHidden: true })
      .evaluate((button: HTMLButtonElement) => button.click())

  // A naked agent link is only an entry point. This reader arranged Files
  // first for Research, so a cold link resolves to that explicit destination
  // before the surface appears.
  await openRoute('/w/acme/agents/research')
  await expect(page).toHaveURL(/\/w\/acme\/agents\/research\/files\/agents\/research$/)
  const surface = page.getByRole('region', { name: 'Research' })
  await expect(surface).toBeVisible()

  // The short Files entry resolves the agent's registered anchor and leaves no
  // second, pathless Files state behind.
  await openRoute('/w/acme/agents/research/files')
  await expect(page).toHaveURL(/\/w\/acme\/agents\/research\/files\/agents\/research$/)

  /* The doors under the agent's name. There were three; Jobs was the third and
     it opened a dialog over this canvas, which is why this test used to spend a
     block on entering and leaving that layer. An agent's other conversations
     are Work's now, so what is left under the name goes somewhere Build owns —
     and the phone still folds the row behind one control. */
  if ((page.viewportSize()?.width ?? 0) < 768) {
    await surface.locator('.km-overflow').click()
    await expect(page.getByRole('menuitem', { name: 'Settings', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
  } else {
    await expect(surface.getByRole('link', { name: 'Settings', exact: true })).toBeVisible()
    await expect(surface.getByRole('link', { name: 'Jobs', exact: true })).toHaveCount(0)
  }

  /* And the card's own selectors, which are the other half of "what the reader
     can see, they can send": each one names a face of this agent. */
  const filesControl =
    (page.viewportSize()?.width ?? 0) < 768
      ? surface.getByRole('tab', { name: 'Files', exact: true })
      : surface.getByRole('button', { name: 'Files', exact: true })
  await filesControl.click()
  await expect(page).toHaveURL(/\/w\/acme\/agents\/research\/files\/agents\/research$/)

  // A pasted agent-scoped Files URL restores the exact nested path without
  // leaving the conversation and agent surface around it.
  await openRoute('/w/acme/agents/research/files/agents/research/uploads')
  await expect(page).toHaveURL(/\/w\/acme\/agents\/research\/files\/agents\/research\/uploads$/)
  await expect(page.getByRole('region', { name: 'Research' })).toBeVisible()

  // The drive's own agent answers at the slug the contract already spends.
  await openRoute('/w/acme/agents/root')
  await expect(page.locator('.km-sheet')).toBeVisible()

  // Root's short Files entry is also its canonical Drive-root URL. It renders
  // that root directly instead of replacing the URL with itself forever.
  await openRoute('/w/acme/agents/root/files')
  await expect(page).toHaveURL(/\/w\/acme\/agents\/root\/files$/)
  await expect(page.locator('[data-files-surface]')).toHaveAttribute('data-files-path', '/')

  /* The add control's second answer: writing an agent is a modal over the
     section, not a page. The fork comes first — two squares, same size — and
     picking the written one swaps the same dialog to the name step rather than
     closing one modal and opening another. It asks one thing and shows the
     address the name earns before it is claimed; the collision case steps aside
     on its own, which the taken `research` slug proves. */
  await openRoute('/w/acme/agents/graph')
  await expect(page).toHaveURL(/\/w\/acme\/agents\/graph$/)
  await expect(page.getByRole('application', { name: /^Knowledge map\./ })).toBeVisible()
  await openRosterIfFolded(page)
  const addAgentButton = page
    .getByRole('complementary')
    .getByRole('button', { name: 'Add an agent', exact: true })
  await addAgentButton.click()
  const addDialog = page.getByRole('dialog', { name: 'Add an agent' })
  await expect(addDialog).toBeVisible()
  await expect(page).toHaveScreenshot('add-agent-dialog.png', { fullPage: true })
  await addDialog.getByRole('button', { name: 'Create your own' }).click()

  const createDialog = page.getByRole('dialog', { name: 'Create your own agent' })
  await expect(createDialog).toBeVisible()
  await createDialog.getByLabel('Agent name').fill('Research')
  await expect(createDialog.getByText('agents/research-2')).toBeVisible()
  await createDialog.getByLabel('Agent name').fill('Growth Analyst')
  await expect(createDialog.getByText('agents/growth-analyst')).toBeVisible()
  await expect(page).toHaveScreenshot('create-agent-dialog.png', { fullPage: true })

  /* Back is one click, not a reopen: a reader who picked the wrong square
     should not have to find the slot on the ring again to say so. */
  await createDialog.getByRole('button', { name: 'Back' }).click()
  await expect(addDialog.getByRole('button', { name: 'Hire an agent' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(addDialog).toHaveCount(0)

  /* And submitting actually creates: the starter files are written, the
     registration reports the slug it claimed, and the route lands on the new
     agent's card. The server-confirmed row must be addressable before that
     navigation; otherwise the route warns that the agent just created does
     not exist while its roster refetch is still in flight.

     Reopening lands on the fork rather than on the name field, which is the
     assertion that would catch a dialog remembering last time's answer. */
  await openRosterIfFolded(page)
  await addAgentButton.click()
  await expect(addDialog.getByRole('button', { name: 'Hire an agent' })).toBeVisible()
  await addDialog.getByRole('button', { name: 'Create your own' }).click()
  await createDialog.getByLabel('Agent name').fill('Growth Analyst')
  await createDialog.getByRole('button', { name: 'Create agent' }).click()
  await expect(page).toHaveURL(/\/w\/acme\/agents\/growth-analyst/)
  await expect(createDialog).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Growth Analyst' })).toBeVisible()
  await expect(
    page.getByText('There is no agent called “growth-analyst” in this workspace.'),
  ).toHaveCount(0)

  /* A link to an agent this drive does not have keeps its URL and says so,
     rather than rewriting away the evidence somebody would paste into a report.

     Once, and on the page. It used to be a toast as well, because this address
     drew the *ring* — a picture of the drive, which cannot say that the agent
     you asked for is not on it — so the sentence had to arrive from somewhere
     else. `toHaveCount(1)` is the half of this that would go quiet again the
     moment anything re-announced it. */
  await openRoute('/w/acme/agents/ghost-agent')
  await expect(page).toHaveURL(/\/w\/acme\/agents\/ghost-agent$/)
  await expect(page.locator('.km-sheet')).toHaveCount(0)
  await expect(page.locator('.knowledge-map')).toHaveCount(0)
  await expect(
    page.getByText('There is no agent called “ghost-agent” in this workspace.'),
  ).toHaveCount(1)
  // And a way out that is a link rather than a bounce.
  await expect(page.getByRole('link', { name: 'Back to all agents' })).toBeVisible()

  /* `?branch=` was the first half of a two-step that no longer exists, and the
     claim here has always been that an unknown query is not a place: the path
     alone decides, and a stale link lands on whatever the bare path means.

     What the bare path means has changed under this test — it is the root
     agent's conversation now rather than the drive's picture — so the sheet
     that used to prove "nothing unfolded" now proves the opposite thing
     correctly: the query was ignored and the path was honoured. */
  await openRoute('/w/acme/agents?branch=research')
  await expect(page.locator('.km-sheet')).toBeVisible()
  await expect(page.locator('.knowledge-map')).toHaveCount(0)

  // Two stale queries are no more of a place than one.
  await openRoute('/w/acme/agents?branch=research&session=session_sleep')
  await expect(page.locator('.km-sheet')).toBeVisible()

  /* The click that *produces* a branch is not driven here, and the reason is
     the fixture rather than the feature: a Jobs seat is only drawn for an agent
     with work in flight, and this drive's one active session belongs to nobody
     — so it hangs off the core and no ring agent has a seat to click. Giving
     one to Research would redraw the ring and move every map baseline for a
     single assertion. The two-step's own logic is covered where it lives
     (`agents-map-url` round-trips every place, `where.ts` pins that a branch
     does not unfold); what this test owns is that the resulting URLs work. */

  await openRoute('/w/acme/agents/research/sessions/session_sleep')
  await expect(
    page.locator('[data-work-session="session_sleep"]').getByLabel('Session timeline'),
  ).toBeVisible()
})

test('playground/spa-shell resolves every direct BrowserRouter destination', async ({ page }) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })

  for (const [path, heading] of [
    ['/w/acme/agents/root/sessions/session_live', 'Sessions'],
    ['/w/acme/agents/root/sessions/session_running', 'Sessions'],
    ['/w/acme/files', 'Drive'],
    ['/w/acme/files/folder/report.txt', 'Drive'],
    // Train's title is the scope it edits; the product noun is the eyebrow.
    ['/w/acme/train/root', 'Global memory'],
    ['/w/acme/integrations', 'Integrations'],
    ['/w/acme/settings/general', 'General'],
    ['/w/acme/settings/backups', 'Backups'],
    ['/w/acme/settings/members', 'Members'],
    ['/w/acme/settings/shares', 'Shares'],
    ['/w/acme/settings/publishes', 'Publishes'],
    ['/w/acme/settings/usage', 'Usage'],
    ['/w/acme/settings/audit', 'Audit log'],
    ['/w/acme/settings/billing-user', 'Designated payer'],
    ['/w/acme/settings/unknown', 'This Duet page does not exist'],
    ['/settings/profile', 'Profile'],
    ['/settings/billing', 'Billing'],
    ['/settings/api-keys', 'API keys'],
    ['/settings/preferences', 'Preferences'],
    ['/settings/unknown', 'This Duet page does not exist'],
    ['/internal-admin', 'Internal admin'],
  ] as const) {
    await page
      .getByRole('button', { name: `Browser route: ${path}`, exact: true, includeHidden: true })
      .evaluate((button: HTMLButtonElement) => button.click())
    await expect(page).toHaveURL(`http://localhost:3000${path}`)
    if (heading === 'Sessions') {
      // A session id is that conversation, on Work's own surface for it.
      await expect(page.locator('[data-work-session]').getByLabel('Session timeline')).toBeVisible()
    } else if (heading === 'This Duet page does not exist') {
      await expect(page.getByRole('heading', { name: heading, exact: true }).last()).toBeVisible()
    } else {
      await expect(destinationHeading(page, heading)).toBeVisible()
    }
  }

  await page
    .getByRole('button', {
      name: 'Browser route: /w/acme/agents/root/sessions/session_root_chat',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect.poll(() => new URL(page.url()).pathname).toBe('/w/acme/home')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  /* Invitations are rows on the roster, so the address they used to own is the
     one destination here that answers at a different URL than it was asked
     for. It is checked apart from the tour above for exactly that reason — the
     tour's contract is that a path opens itself, and this one's contract is
     that an owner's old bookmark lands on the list instead of a 404. */
  await page
    .getByRole('button', { name: 'Browser route: /w/acme/settings/invites', exact: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page).toHaveURL('http://localhost:3000/w/acme/settings/members')
  await expect(destinationHeading(page, 'Members')).toBeVisible()

  await page.getByRole('button', { name: 'Account and settings' }).click()
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click()
  // Through /sign-out's revocation round-trip, which can outlast the default
  // expectation window under a loaded suite.
  await expect(page).toHaveURL(/\/sign-in$/, { timeout: 15_000 })
})

/* The campaign arrival: three steps, and a celebration that counts agents the
   user never picked. This is the only capture of that path — the walk above
   photographs the organic five-step flow, and the two now share a ready step
   whose roster comes from different places. */
test('playground/onboarding-campaign names the faces a campaign brought', async ({ page }) => {
  await page.goto('/playground/onboarding?campaign=research-assistant,data-analyst,writing-editor')

  // Via the progressbar, not the mono counter — phones hide the counter text.
  const progress = page.getByRole('progressbar', { name: 'Onboarding progress' })
  await expect(progress).toHaveAttribute('aria-valuetext', 'Step 1 of 3')
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page.getByRole('heading', { name: 'Your workspace is ready' })).toBeVisible()
  await expect(progress).toHaveAttribute('aria-valuetext', 'Step 2 of 3')
  // No goal was ever asked, so the goal row is absent and only the roster shows.
  await expect(page.getByText('Your goal', { exact: true })).toBeHidden()
  await expect(page.getByText('Duet + 3 specialists')).toBeVisible()
  await expect(page).toHaveScreenshot('onboarding-campaign-ready.png', { fullPage: true })

  // Hovering a face lifts it clear of the stack and names it underneath.
  await page.getByRole('img', { name: 'Data Analyst' }).hover()
  await expect(page.getByText('Data Analyst', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('onboarding-campaign-face-named.png', { fullPage: true })
})

test('playground/compose-bar selects provider aliases from Advanced', async ({
  page,
}, testInfo) => {
  await page.goto('/playground/compose-bar')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page.getByRole('button', { name: 'Quality: Standard' }).click()
  const mobile = testInfo.project.name === 'mobile'
  const advanced = page.getByRole(mobile ? 'button' : 'menuitem', { name: 'Advanced', exact: true })
  await expect(advanced).toBeVisible()
  if (mobile) await advanced.click()
  else await advanced.hover()
  const option = qualityMenuOption(page, 'OpenAI frontier')
  await expect(option).toContainText('GPT-6 Astra')
  await expect(qualityMenuOption(page, 'OpenAI recommended')).toContainText('GPT-6.1 Sol')
  await expect(qualityMenuOption(page, 'Anthropic recommended')).toContainText('Claude Opus 5.5')
  await expect(option.getByLabel('Performance: 2/5', { exact: true })).toBeVisible()
  await expect(option.getByLabel('Intelligence: 5/5', { exact: true })).toBeVisible()
  await expect(option.getByLabel('Cost: 5/5', { exact: true })).toBeVisible()
  await expect(qualityMenuOption(page, 'Anthropic recommended')).toBeInViewport({ ratio: 1 })
  await expect(page).toHaveScreenshot('compose-bar-provider-models.png', { fullPage: true })
  await option.click()
  await expect(page.getByRole('button', { name: /^Quality: OpenAI frontier\b/ })).toBeVisible()
  await expect(page.getByLabel('Message Duet')).toBeFocused()
  await expect(page.getByRole('button', { name: /^Quality: OpenAI frontier\b/ })).toHaveScreenshot(
    'compose-bar-provider-selected.png',
  )
  let selectedLabel = 'OpenAI frontier'
  for (const label of [
    'OpenAI recommended',
    'Anthropic frontier',
    'Anthropic recommended',
    'OpenAI frontier',
  ]) {
    await page.getByRole('button', { name: new RegExp(`^Quality: ${selectedLabel}\\b`) }).click()
    if (!mobile) await advanced.hover()
    await qualityMenuOption(page, label).click()
    await expect(
      page.getByRole('button', { name: new RegExp(`^Quality: ${label}\\b`) }),
    ).toBeVisible()
    selectedLabel = label
  }
  await page.getByLabel('Message Duet').fill('Use my selected provider')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByTestId('compose-bar-last-submit')).toContainText(
    '"qualityId":"openai-frontier"',
  )
})

test('playground/settings-default-tier-subscribed saves a provider alias', async ({
  page,
}, testInfo) => {
  await page.goto('/playground/settings-default-tier-subscribed')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page.getByRole('button', { name: 'Default quality: Standard' }).click()
  const mobile = testInfo.project.name === 'mobile'
  const advanced = page.getByRole(mobile ? 'button' : 'menuitem', { name: 'Advanced', exact: true })
  if (mobile) await advanced.click()
  else {
    await advanced.focus()
    await page.keyboard.press('ArrowRight')
  }
  const option = qualityMenuOption(page, 'Anthropic recommended')
  await expect(option).toContainText('Claude Opus 5.5')
  await expect(option).toBeInViewport({ ratio: 1 })
  await expect(page).toHaveScreenshot('settings-provider-models.png', { fullPage: true })
  await option.click()
  await expect(
    page.getByRole('button', { name: /^Default quality: Anthropic recommended\b/ }),
  ).toBeVisible()
  await expect
    .poll(() =>
      page
        .getByRole('button', { name: /^Default quality: Anthropic recommended\b/ })
        .getByText('Anthropic recommended', { exact: true })
        .evaluate(label => label.scrollWidth <= label.clientWidth),
    )
    .toBe(true)
  await expect(
    page.getByRole('button', { name: /^Default quality: Anthropic recommended\b/ }),
  ).toHaveScreenshot('settings-provider-selected.png')
  await page.getByRole('button', { name: /^Default quality: Anthropic recommended\b/ }).click()
  if (!mobile) await page.getByRole('menuitem', { name: 'Advanced', exact: true }).hover()
  await expect(qualityMenuOption(page, 'Anthropic recommended')).toBeChecked()
  if (!mobile) {
    await advanced.focus()
    await page.keyboard.press('ArrowRight')
    await expect(qualityMenuOption(page, 'OpenAI frontier')).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(advanced).toBeFocused()
    await page.keyboard.press('Escape')
    const trigger = page.getByRole('button', {
      name: /^Default quality: Anthropic recommended\b/,
    })
    await expect(trigger).toBeFocused()
    await trigger.press('ArrowDown')
    await advanced.focus()
    await page.keyboard.press('ArrowRight')
    await expect(qualityMenuOption(page, 'OpenAI frontier')).toBeFocused()
    await page.keyboard.press('End')
    await expect(qualityMenuOption(page, 'Anthropic balanced')).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(qualityMenuOption(page, 'Anthropic recommended')).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(qualityMenuOption(page, 'Anthropic frontier')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(
      page.getByRole('button', { name: /^Default quality: Anthropic frontier\b/ }),
    ).toBeVisible()
  }
})

test('playground/spa-shell sends the selected provider alias through the product composer', async ({
  page,
}, testInfo) => {
  await openProductRoute(page, '/w/acme/agents/root')
  await page.getByRole('button', { name: 'Quality: Standard' }).click()
  const mobile = testInfo.project.name === 'mobile'
  const advanced = page.getByRole(mobile ? 'button' : 'menuitem', { name: 'Advanced', exact: true })
  if (mobile) await advanced.click()
  else await advanced.hover()
  await qualityMenuOption(page, 'Anthropic frontier').click()
  await page.getByLabel('Message Milo').fill('Use the chosen provider for this turn')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect
    .poll(() => sessionInputPayload(page))
    .toMatchObject({
      kind: 'message',
      input: { tier: 'anthropic-frontier', prompt: 'Use the chosen provider for this turn' },
    })
})

test('playground/spa-shell restores Recent jobs from the Build default chat', async ({
  page,
}, testInfo) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Make child parent the default chat', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await page
    .getByRole('button', {
      name: 'Browser route: /w/acme/agents/root',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  await page.screenshot({ path: testInfo.outputPath('build-header.png'), fullPage: true })
  for (const name of ['Recent jobs', 'archive']) {
    await expect
      .poll(() =>
        page.getByRole('button', { name, exact: true }).evaluate(button => {
          const icon = button.querySelector('svg')!.getBoundingClientRect()
          const label = button.querySelector('span')!.getBoundingClientRect()
          return Math.abs(icon.y + icon.height / 2 - label.y - label.height / 2)
        }),
      )
      .toBeLessThanOrEqual(1)
  }
  await page.getByRole('button', { name: 'Recent jobs', exact: true }).click({ timeout: 10_000 })
  const dialog = page.getByRole('dialog', { name: 'Recent jobs' })
  await expect(dialog.getByRole('link', { name: /Wait for the nightly export/ })).toBeVisible()
  await expect(dialog.getByRole('link', { name: /Draft the handover notes/ })).toBeVisible()
  await expect(dialog.getByText('Reconcile the quarterly ledger')).toHaveCount(0)
  await dialog.getByRole('link', { name: /Wait for the nightly export/ }).click()
  await expect(page).toHaveURL(/\/w\/acme\/agents\/research\/sessions\/session_sleep$/)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('playground/spa-shell Recent jobs reaches older children of an agent default chat', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Prepare agent default chat jobs', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await page
    .getByRole('button', {
      name: 'Browser route: /w/acme/agents/research',
      exact: true,
      includeHidden: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click())
  if ((page.viewportSize()?.width ?? 0) < 768) {
    await page.getByRole('tab', { name: 'Build chat', exact: true }).click()
  }
  const trigger = page.getByRole('button', { name: 'Recent jobs', exact: true })
  await trigger.click({ timeout: 10_000 })
  const dialog = page.getByRole('dialog', { name: 'Recent jobs' })
  await expect(dialog.getByRole('link', { name: /Draft the handover notes/ })).toBeVisible()
  await expect(dialog.getByRole('link', { name: /Track competitor launches/ })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Load more', exact: true }).click()
  await expect(dialog.getByRole('link', { name: /Track competitor launches/ })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0)
  await expect(page).toHaveScreenshot('build-recent-jobs-modal.png', { fullPage: true })
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await expect(page).toHaveURL(/\/w\/acme\/agents\/research\/files\/agents\/research$/)
  await trigger.click()
  await dialog.getByRole('link', { name: /Draft the handover notes/ }).click()
  await expect(page).toHaveURL(/\/w\/acme\/agents\/root\/sessions\/session_export_notes$/)
})

test('playground/spa-shell Recent jobs recovers failed reads without losing loaded children', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  await page
    .getByRole('button', { name: 'Prepare agent default chat jobs', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await scenarioSwitch(page)('build-jobs-errors')
  if ((page.viewportSize()?.width ?? 0) < 768)
    await page.getByRole('tab', { name: 'Build chat', exact: true }).click()
  await page.getByRole('button', { name: 'Recent jobs', exact: true }).click({ timeout: 10_000 })
  const dialog = page.getByRole('dialog', { name: 'Recent jobs' })
  await expect(dialog.getByRole('alert')).toContainText('Recent jobs could not be loaded')
  await dialog.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(dialog.getByRole('link', { name: /Draft the handover notes/ })).toBeVisible()
  await dialog.getByRole('button', { name: 'Load more', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Recent jobs could not be loaded')
  await expect(dialog.getByRole('link', { name: /Draft the handover notes/ })).toBeVisible()
  await dialog.getByRole('button', { name: 'Try loading more', exact: true }).click()
  await expect(dialog.getByRole('link', { name: /Track competitor launches/ })).toBeVisible()
  await expect(dialog.getByRole('alert')).toHaveCount(0)
})

test('playground/spa-shell Recent jobs distinguishes empty and loading and follows the default chat', async ({
  page,
}) => {
  await openProductRoute(page, '/w/acme/agents/root')
  const trigger = page.getByRole('button', { name: 'Recent jobs', exact: true })
  await trigger.click({ timeout: 10_000 })
  const dialog = page.getByRole('dialog', { name: 'Recent jobs' })
  await expect(dialog.getByText('No recent jobs', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('status')).toHaveCount(0)
  await expect(page).toHaveScreenshot('build-recent-jobs-empty.png', { fullPage: true })
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await page.getByRole('button', { name: 'archive', exact: true }).click()
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Archive chat', exact: true })
    .click()
  await expect(trigger).toHaveCount(0)
  await expect(dialog).toHaveCount(0)

  await page
    .getByRole('button', { name: 'Prepare agent default chat jobs', includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await scenarioSwitch(page)('build-jobs-loading')
  if ((page.viewportSize()?.width ?? 0) < 768)
    await page.getByRole('tab', { name: 'Build chat', exact: true }).click()
  await trigger.click({ timeout: 10_000 })
  await expect(dialog.getByRole('status')).toHaveText('Loading…')
  await expect(dialog.getByText('No recent jobs', { exact: true })).toHaveCount(0)
  await expect(page).toHaveScreenshot('build-recent-jobs-loading.png', { fullPage: true })
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('playground/user-logins creates one-time keys and removes one synced Mac independently', async ({
  page,
}) => {
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 30_000 })
  const navigate = async (path: string) =>
    page
      .getByRole('button', { name: `Browser route: ${path}`, exact: true })
      .evaluate((button: HTMLButtonElement) => button.click())
  await navigate('/settings/api-keys')
  await expect(page.getByRole('heading', { name: 'API keys', exact: true, level: 1 })).toBeVisible()
  await expect(page.locator('form').getByRole('combobox')).toHaveCount(0)
  await expect(
    page.locator('form').getByRole('button', { name: 'files:read', exact: true }),
  ).toHaveCount(0)
  await expect(page).toHaveScreenshot('spa-shell-user-api-keys.png', { fullPage: true })
  await page.getByLabel('Key name').fill('Release automation')
  await page.getByRole('button', { name: 'Create key', exact: true }).click()
  await expect(page.getByText('duet_sk_29a8cdef0123456789fixture', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('settings-api-key-secret-once.png', { fullPage: true })
  await navigate('/settings/profile')
  await navigate('/settings/api-keys')
  await expect(page.getByText('duet_sk_29a8cdef0123456789fixture', { exact: true })).toHaveCount(0)
  const laptop = page.locator('[data-sync-machine-id="machine_macbook"]')
  const studio = page.locator('[data-sync-machine-id="machine_studio"]')
  await laptop.getByRole('button', { name: 'Remove Mac MacBook Pro', exact: true }).click()
  await expect(laptop.getByText('Removed', { exact: true })).toBeVisible()
  await expect(
    studio.getByRole('button', { name: 'Remove Mac Mac Studio', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Revoke duet_sk_8f8a21c0', exact: true }),
  ).toHaveCount(1)
  await expect(page).toHaveScreenshot('settings-sync-machine-removed.png', { fullPage: true })
})
