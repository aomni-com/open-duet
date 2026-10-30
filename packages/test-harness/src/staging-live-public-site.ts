import assert from 'node:assert/strict'

import { type BrowserContext, type Locator, type Page } from '@playwright/test'

import { StagingArtifactCollector } from './staging-live-artifacts.ts'
import { markExpectedBrowserTransition, navigateDeployedPage } from './staging-live-browser.ts'
import type { LiveEnv } from './staging-live-env.ts'
import { apiJson, vercelBypassHeaders } from './staging-live-http.ts'
import { assertDeployedPublicHtml } from './staging-live-route-contracts.ts'

const BROWSER_TRANSITION_TIMEOUT_MS = 60_000
export type PostHogJourneyState = {
  distinctId: string
  deviceId: string
  sessionId: string
  userState: string
}

export function assertPostHogJourney(args: {
  landerAnonymous: PostHogJourneyState
  productAnonymous: PostHogJourneyState
  productAuthenticated: PostHogJourneyState
  productReset: PostHogJourneyState
  landerReturned: PostHogJourneyState
  userId: string
}): void {
  assert.deepEqual(
    args.productAnonymous,
    args.landerAnonymous,
    'PostHog anonymous identity forked between lander and product',
  )
  assert.equal(
    args.productAuthenticated.distinctId,
    args.userId,
    'PostHog did not identify the authenticated user',
  )
  assert.equal(
    args.productAuthenticated.deviceId,
    args.landerAnonymous.deviceId,
    'PostHog identify replaced the anonymous device',
  )
  assert.equal(
    args.productAuthenticated.sessionId,
    args.landerAnonymous.sessionId,
    'PostHog identify replaced the anonymous session',
  )
  assert.equal(args.productAuthenticated.userState, 'identified')
  assert.notEqual(args.productReset.distinctId, args.userId, 'PostHog logout retained the user id')
  assert.notEqual(
    args.productReset.deviceId,
    args.landerAnonymous.deviceId,
    'PostHog logout retained the pre-auth device',
  )
  assert.notEqual(
    args.productReset.sessionId,
    args.landerAnonymous.sessionId,
    'PostHog logout retained the pre-auth session',
  )
  assert.equal(args.productReset.userState, 'anonymous')
  assert.deepEqual(
    args.landerReturned,
    args.productReset,
    'PostHog reset identity forked when returning to lander',
  )
}

export async function verifyPublicForms(
  env: Pick<LiveEnv, 'landerUrl' | 'vercelBypassSecret'>,
  artifacts: StagingArtifactCollector,
): Promise<void> {
  const headers = new Headers({
    ...vercelBypassHeaders(env.vercelBypassSecret),
    'content-type': 'application/json',
  })
  const lead = await apiJson<{ error?: string }>(
    new URL('/api/campaigns/organic/actions/lead', env.landerUrl).toString(),
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'email', data: { email: 'invalid' } }),
    },
    400,
    'live lead form validation',
    artifacts,
  )
  assert.equal(lead.error, 'invalid_request', 'live lead form changed its safe rejection')
}

export async function runLanguageContinuityAcceptance(
  page: Page,
  context: BrowserContext,
  env: LiveEnv,
): Promise<void> {
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${env.landerUrl}/pricing`)
  markExpectedBrowserTransition(page)
  await page.getByRole('link', { name: 'Español', exact: true }).click()
  await page.waitForURL(url => url.pathname === '/es/pricing')
  await waitForLocaleCookie(context, env.appUrl, 'es-419')
  const englishResponse = await context.request.get(`${env.landerUrl}/pricing`, {
    headers: vercelBypassHeaders(env.vercelBypassSecret),
  })
  assert.equal(englishResponse.status(), 200, 'English lander URL failed with a Spanish cookie')
  const englishHtml = await englishResponse.text()
  assert(
    !/document\.documentElement\.lang\s*=\s*["']es-419["']/.test(englishHtml),
    'locale preference changed the static language owned by the English URL',
  )
  assertDeployedPublicHtml({
    route: `${env.landerUrl}/pricing`,
    html: englishHtml,
    contentType: englishResponse.headers()['content-type'],
    cacheControl: englishResponse.headers()['cache-control'],
    xRobotsTag: englishResponse.headers()['x-robots-tag'],
    canonicalOrigin: new URL(env.landerUrl).origin,
    kind: 'marketing',
    sitemapMember: true,
  })

  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${env.appUrl}/settings/preferences`)
  await page.locator('[data-runtime-locale="es-419"]').waitFor()
  await page.getByText('Preferencias', { exact: true }).first().waitFor()

  await page.getByRole('button', { name: 'English', exact: true }).click()
  await page.locator('[data-runtime-locale="en"]').waitFor()
  await waitForLocaleCookie(context, env.appUrl, 'en')
  await page.getByText('Preferences', { exact: true }).first().waitFor()

  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${env.landerUrl}/pricing`)
  await page.getByRole('link', { name: 'English', exact: true }).waitFor()
  assert.equal(new URL(page.url()).pathname, '/pricing')
}

export async function waitForPostHogState(
  context: BrowserContext,
  origin: string,
  predicate: (state: PostHogJourneyState) => boolean = () => true,
): Promise<PostHogJourneyState> {
  // PostHog boots from its external CDN; a slow fetch can eat most of a
  // 30s budget before the persistence cookie ever appears.
  const deadline = Date.now() + 90_000
  for (;;) {
    const cookie = (await context.cookies(origin)).find(
      candidate => candidate.name.startsWith('ph_') && candidate.name.endsWith('_posthog'),
    )
    if (cookie !== undefined) {
      try {
        const payload = JSON.parse(decodeURIComponent(cookie.value)) as Record<string, unknown>
        const session = payload.$sesid
        const state = {
          distinctId: payload.distinct_id,
          deviceId: payload.$device_id,
          sessionId: Array.isArray(session) ? session[1] : undefined,
          userState: payload.$user_state,
        }
        if (
          typeof state.distinctId === 'string' &&
          typeof state.deviceId === 'string' &&
          typeof state.sessionId === 'string' &&
          typeof state.userState === 'string'
        ) {
          const parsed: PostHogJourneyState = {
            distinctId: state.distinctId,
            deviceId: state.deviceId,
            sessionId: state.sessionId,
            userState: state.userState,
          }
          if (predicate(parsed)) return parsed
        }
      } catch {
        // PostHog may rewrite the persistence cookie while the browser is reading it.
      }
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for PostHog browser state')
    await Bun.sleep(100)
  }
}

export async function waitForHydratedMagicLinkControls(
  page: Page,
): Promise<{ email: Locator; submit: Locator }> {
  const email = page.locator('input[type="email"]')
  const card = page.locator('section').filter({ has: email }).first()
  // The auth card submits via a client-mounted form (button[type="submit"]);
  // the pre-motion card wired an adjacent button[type="button"] directly.
  const submit = card.locator(
    'form button[type="submit"], input[type="email"] + button[type="button"]',
  )
  await submit.first().waitFor({ state: 'visible' })
  assert.equal(await submit.count(), 1, 'auth card did not expose one email action')
  await page.waitForFunction(
    () => {
      const input = document.querySelector<HTMLInputElement>('input[type="email"]')
      if (input === null) return false
      const form = input.closest('form')
      if (form?.querySelector('button[type="submit"]') != null) {
        // SSR renders the form before React attaches onSubmit; hydration is
        // proven by React's internal props key appearing on the element.
        return Object.keys(form).some(key => key.startsWith('__reactProps'))
      }
      const legacy = input.parentElement?.querySelector<HTMLElement>(
        'input[type="email"] + button[type="button"]',
      )
      return typeof legacy?.onclick === 'function'
    },
    undefined,
    { timeout: BROWSER_TRANSITION_TIMEOUT_MS },
  )
  return { email, submit: submit.first() }
}

export async function waitForHydratedButton(page: Page, name: string): Promise<Locator> {
  const button = page.getByRole('button', { name, exact: true })
  await button.waitFor({ state: 'visible' })
  await page.waitForFunction(
    expectedName =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].some(
        candidate =>
          candidate.textContent?.trim() === expectedName && typeof candidate.onclick === 'function',
      ),
    name,
    { timeout: BROWSER_TRANSITION_TIMEOUT_MS },
  )
  return button
}

export async function waitForLocaleCookie(
  context: BrowserContext,
  appUrl: string,
  expected: 'en' | 'es-419',
): Promise<void> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const value = (await context.cookies(appUrl)).find(
      cookie => cookie.name === 'DUET_LOCALE',
    )?.value
    if (value === expected) return
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected} locale cookie`)
    await Bun.sleep(100)
  }
}
