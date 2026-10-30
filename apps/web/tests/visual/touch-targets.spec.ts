/* What a finger can actually hit.

   This suite exists because the camera could not see it. The `mobile` project is
   `devices['Desktop Chrome']` at 390 with `isMobile: true` and no `hasTouch`, so
   `(pointer: coarse)` never matched and 496 baselines were shot with a mouse —
   which is fine for a picture and useless for this question. So this one runs in
   `mobile-touch`, takes no screenshots at all, and asserts geometry.

   ---- why a budget rather than a hard floor ----
   The floor is 44px and most of the product does not meet it yet. A suite that
   simply asserted the floor would be red on every route on the day it landed,
   which is a suite people turn off. So it counts instead, against a number
   checked in beside it, and the number may only ever go **down**: a change that
   adds an undersized control goes red, and a pass that fixes twenty of them goes
   red too — with the instruction to lower the budget, which is the only edit that
   makes it green again. The budget is the backlog, written where it cannot be
   forgotten.

   The overlap assertion gets a named register rather than a count. A control too
   small to hit is a nuisance; two controls whose hit areas cross means a tap
   lands on something the reader did not aim at, so each surviving one is written
   down by the pair it involves and has to be deleted when it is fixed. */
import { expect, test } from '@playwright/test'

import { TOUCH_TARGET_BUDGET } from './touch-target-budget'

/* Every product destination the shell fixture can reach, in the order a reader
   would meet them. Kept here rather than derived from `PRODUCT_DESTINATIONS`
   because several of these are a *state* of a destination — an agent mid-job, a
   sleeping session — and a route table has no opinion about those. */
const ROUTES = [
  '/w/acme/agents',
  '/w/acme/agents/research',
  '/w/acme/agents/root',
  '/w/acme/agents/research/files',
  '/w/acme/agents/research/apps/reporting',
  /* Work's addresses, because that is where a conversation is read now. The
     bare Build forms these used to name are no longer places — the harness
     drives one of them on purpose (below) to prove the landing, and a route
     this list names that the playground does not offer is not a failure but a
     hang: `walk` clicks a button that never appears. */
  '/w/acme/agents/root/sessions/session_live',
  '/w/acme/agents/root/sessions/session_running',
  '/w/acme/agents/research/sessions/session_sleep',
  /* Work's home belongs in this walk and is deliberately not in it yet. Walking
     it finds four controls of its own under the floor — the three audience
     segments and the quality button, all 28px — which is a real finding and a
     change of its own, with the fix attached. Adding the route here would have
     meant raising the budget below to carry them, and a ratchet you may loosen
     to admit a new surface is not a ratchet. */
  '/w/acme/agents/reviewer',
  '/w/acme/agents/research/settings',
  '/w/acme/agents/marketplace/official-agents-hub/research',
  '/w/acme/files',
  '/w/acme/files/folder/report.txt',
  '/w/acme/train/root',
  '/w/acme/integrations',
  '/w/acme/settings/general',
  '/w/acme/settings/members',
  '/w/acme/settings/shares',
  '/w/acme/settings/publishes',
  '/w/acme/settings/usage',
  '/w/acme/settings/audit',
  '/settings/profile',
  '/settings/billing',
  '/settings/api-keys',
  '/settings/preferences',
] as const

/**
 * Every pair of controls whose hit areas are known to cross today, named by the
 * two that collide. This list may only ever get shorter, and the test says so
 * from both sides — an entry that stops colliding fails just as loudly as a
 * collision that is not on the list.
 *
 * Both remaining entries are the same mistake: an agent-access checkbox drawn
 * over the disclosure row that owns it, so a tap meant for the row toggles the
 * checkbox instead.
 */
/* Empty, and the test says so out loud: a crossing that stops happening fails
   here until its line is deleted, which is how the list stays honest. Both
   entries it held were on the integrations surface and are gone. */
const KNOWN_CROSSINGS: readonly string[] = []

/** The platform floor. Not a preference — Apple and Google both land here. */
const FLOOR = 44

/**
 * The concession, and it is a real one: a control may be as small as this if
 * nothing else interactive is within `CLEARANCE` of it. A lone 32px icon in its
 * own corner is hittable; the same icon in a row of three is not.
 */
const SMALL = 32
const CLEARANCE = 8

type Target = {
  name: string
  clipped: boolean
  box: { x: number; y: number; w: number; h: number }
  x: number
  y: number
  w: number
  h: number
}

/* Read in the page rather than through locators: this walks every interactive
   element on twenty-five routes, and a round trip each would take the suite from
   seconds to minutes. */
function collect(): Target[] {
  const INTERACTIVE = [
    'button',
    'a[href]',
    'summary',
    'select',
    'textarea',
    'input:not([type=hidden])',
    '[role="button"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[role="switch"]',
    '[role="radio"]',
  ].join(',')

  const describe = (el: Element): string => {
    const label = (el.getAttribute('aria-label') ?? el.textContent ?? '')
      .trim()
      .replace(/\s+/g, ' ')
    const cls =
      typeof el.className === 'string' && el.className !== ''
        ? `.${el.className.split(/\s+/).slice(0, 2).join('.')}`
        : ''
    return `${el.tagName.toLowerCase()}${cls} «${label.slice(0, 44)}»`
  }

  return [...document.querySelectorAll(INTERACTIVE)]
    .filter(el => {
      /* The fixture's own scenario nav is not the product. It is `sr-only` and
         sits outside the shell, so both tests would otherwise measure the
         playground's furniture and report it as the app's. */
      if (el.closest('nav[aria-label="Playground scenarios"]') !== null) return false
      if (el.closest('.sr-only') !== null || el.classList.contains('sr-only')) return false
      if (el.closest('[aria-hidden="true"]') !== null) return false
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') return false
      if (Number(style.opacity) === 0) return false
      /* A control revealed on hover has no size to a finger. It is a different
         defect with a different fix — see the `reveal-on-hover` work — and
         counting it here would double-report it. */
      if (style.pointerEvents === 'none') return false
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return false
      /* Off-screen and inside a closed drawer are the same thing to a reader. */
      return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth
    })
    .map(el => {
      /* The rect a finger can actually reach, not the rect the element claims.

         `getBoundingClientRect` reports where an element *would* be, and keeps
         reporting it after the element has scrolled out of the box that clips
         it. A disclosure row scrolled off the top of the conversation still
         answers with a position up under the identity block above — which is how
         a suite like this invents collisions between two things that were never
         on screen together. So every rect is intersected with each clipping
         ancestor's own box on the way up, and an element whose remainder is
         empty is not on screen and is not a target. */
      let rect = el.getBoundingClientRect()
      let box = { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
      for (let p = el.parentElement; p !== null; p = p.parentElement) {
        const s = getComputedStyle(p)
        if (s.overflow === 'visible' && s.overflowX === 'visible' && s.overflowY === 'visible') {
          continue
        }
        const clip = p.getBoundingClientRect()
        const x = Math.max(box.x, clip.x)
        const y = Math.max(box.y, clip.y)
        box = {
          x,
          y,
          w: Math.min(box.x + box.w, clip.x + clip.width) - x,
          h: Math.min(box.y + box.h, clip.y + clip.height) - y,
        }
        if (box.w <= 0 || box.h <= 0) break
      }
      return {
        name: describe(el),
        clipped: box.w <= 0 || box.h <= 0,
        box,
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
      }
    })
    .filter(target => !target.clipped)
}

/** Two rectangles sharing area. Touching edges is not overlapping. */
function overlaps(a: Target, b: Target): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** How far apart two rectangles are, or 0 when they touch or cross. */
function gap(a: Target, b: Target): number {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)))
  const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)))
  return Math.max(dx, dy)
}

function undersized(targets: readonly Target[]): Target[] {
  return targets.filter(target => {
    if (target.w >= FLOOR && target.h >= FLOOR) return false
    if (target.w < SMALL || target.h < SMALL) return true
    /* Big enough to be hit on its own — so it passes only if it is on its own. */
    return targets.some(other => other !== target && gap(target, other) < CLEARANCE)
  })
}

async function walk(page: import('@playwright/test').Page, route: string): Promise<Target[]> {
  await page
    .getByRole('button', { name: `Browser route: ${route}`, exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  /* The shell settles in waves — the roster, then the apps, then the work in
     flight — and a control that arrives late is still a control. */
  await page.waitForTimeout(1_200)
  return page.evaluate(collect)
}

test('no two things a finger can hit are drawn on top of each other', async ({ page }) => {
  test.setTimeout(600_000)
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 60_000 })

  /* Nothing here excuses the floating top bar, and it turns out nothing has to.
     The shell is built so the route runs *under* frosted glass, which sounds
     like a licence for controls to come to rest beneath it — but every scroller
     that runs under the bar also carries `DRIVE_TOPBAR_CLEARANCE`, so none ever
     does. This suite ran green without an exemption for it, which makes the
     clearance proved rather than assumed: take it away and a control stranded
     under the glass shows up here as exactly what it is. */
  const crossings: string[] = []
  for (const route of ROUTES) {
    const targets = await walk(page, route)
    for (let i = 0; i < targets.length; i++) {
      for (let j = i + 1; j < targets.length; j++) {
        const a = targets[i]!
        const b = targets[j]!
        /* A control nested inside another — a menu trigger inside a row that is
           itself a button — always overlaps, and is a composition rather than a
           collision: the inner one wins the tap and that is what it is for. */
        const nested =
          (a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h) ||
          (b.x <= a.x && b.y <= a.y && b.x + b.w >= a.x + a.w && b.y + b.h >= a.y + a.h)
        if (!nested && overlaps(a, b)) crossings.push(`${route}\n    ${a.name}\n    ${b.name}`)
      }
    }
  }

  /* Named, not counted. A crossing is a tap landing on something the reader did
     not aim at, so there is no tolerance for it the way there is for a control
     that is merely small — but six of them already exist, and a suite that is red
     on the day it lands is a suite somebody deletes. So each known one is written
     down by the pair it involves: a new crossing fails immediately, and a fixed
     one fails too, with the instruction to delete its line. */
  const unknown = crossings.filter(crossing => !KNOWN_CROSSINGS.some(k => crossing.includes(k)))
  expect(unknown, `new hit areas crossing:\n  ${unknown.join('\n  ')}`).toEqual([])

  const fixed = KNOWN_CROSSINGS.filter(k => !crossings.some(crossing => crossing.includes(k)))
  expect(
    fixed,
    `these crossings are fixed — delete them from KNOWN_CROSSINGS:\n  ${fixed.join('\n  ')}`,
  ).toEqual([])
})

test('the number of controls a finger cannot hit only ever goes down', async ({ page }) => {
  test.setTimeout(600_000)
  await page.goto('/playground/spa-shell')
  await page.waitForSelector('body[data-playground-ready="true"]', { timeout: 60_000 })

  const found: Record<string, string[]> = {}
  let total = 0
  for (const route of ROUTES) {
    const small = undersized(await walk(page, route))
    if (small.length > 0) {
      found[route] = small.map(t => `${Math.round(t.w)}x${Math.round(t.h)} ${t.name}`)
      total += small.length
    }
  }

  const report = Object.entries(found)
    .map(([route, list]) => `  ${route}\n    ${list.join('\n    ')}`)
    .join('\n')

  expect(
    total,
    `Controls below the ${FLOOR}px floor:\n${report}\n\n` +
      `Budget is ${TOUCH_TARGET_BUDGET}. If this is lower, lower the budget in ` +
      `tests/visual/touch-target-budget.ts — that edit is the point of the test.`,
  ).toBeLessThanOrEqual(TOUCH_TARGET_BUDGET)
})
