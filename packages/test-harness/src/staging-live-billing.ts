import assert from 'node:assert/strict'

import { type Page } from '@playwright/test'

import { markExpectedBrowserTransition, navigateDeployedPage } from './staging-live-browser.ts'
import { type LiveEnv } from './staging-live-env.ts'
import { stagingFetch } from './staging-live-http.ts'
import { StagingResourceLedger } from './staging-live-resource-ledger.ts'

type StripeBillingTestEnv = Pick<LiveEnv, 'stripeSecretKey'>

export function recordStripeBillingSweep(args: {
  env: StripeBillingTestEnv
  email: string
  runId: string
  ledger: StagingResourceLedger
}): void {
  const { env, email, runId, ledger } = args
  ledger.record({
    kind: 'stripe-customer',
    id: `sweep-${email}`,
    label: `${runId}:stripe-customer-sweep:${email}`,
    cleanupPriority: -50,
    cleanup: async () => {
      await cleanupStripeBillingByEmail(env, email)
    },
    verify: async () => await stripeBillingByEmailDeleted(env, email),
  })
}

export async function runStripeBillingAcceptance(args: {
  env: LiveEnv
  page: Page
  email: string
  runId: string
  ledger: StagingResourceLedger
}): Promise<void> {
  const { env, page, email, runId, ledger } = args
  assert(env.stripeSecretKey.startsWith('sk_test_'), 'staging E2E refuses a non-test Stripe key')
  recordStripeBillingSweep({ env, email, runId, ledger })
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${env.appUrl}/settings/billing`)
  await page.getByRole('heading', { name: 'Billing', exact: true }).last().waitFor()
  // The main e2e owner runs on a synthetic subscription (the run's charged
  // legs need the subscription_required gate open), and a synthetic
  // subscriber has no Stripe customer — checkout, topup, and portal flows
  // are proven by the subscription lifecycle with a real subscription. What
  // this leg pins is the subscriber rendering contract of the billing page:
  // monthly credits as a percentage (never a dollar amount), the paid
  // reserve in dollars, and plan cards anchored on the current plan.
  await page.getByText('Paid reserve', { exact: true }).first().waitFor()
  await page
    .getByText(/% used$/)
    .first()
    .waitFor()
  // The current plan's own card says so; the tier above it offers the upgrade.
  // This account is Pro because the run needs two workspaces, so Max is the card
  // holding the upgrade.
  await page.getByRole('button', { name: 'Current plan', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Upgrade to Max now', exact: true }).waitFor()
  const overview = await page.evaluate(async () => {
    const response = await fetch('/api/duet/user/billing')
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  })
  assert.equal(overview.status, 200, 'billing overview failed for the browser session')
  assert.equal(
    (overview.body.subscription as { plan?: unknown } | null)?.plan,
    'pro',
    'synthetic subscription did not project onto the billing overview',
  )
}

export async function completeStripeCardCheckout(
  page: Page,
  email: string,
  runId: string,
  appUrl: string,
): Promise<void> {
  await page.locator('html[data-elements-loaded="true"]').waitFor({ state: 'attached' })
  const cardNumber = page.locator('input[name="cardNumber"]')
  const savedCard = page.getByText(/(?:ending in|••••|\*\*\*\*)\s*4242/i).first()
  const usingSavedCard = await savedCard.isVisible().catch(() => false)
  if (!usingSavedCard && !(await cardNumber.isVisible())) {
    const cardMethod = page.getByTestId('card-accordion-item')
    await cardMethod.scrollIntoViewIfNeeded()
    const bounds = await cardMethod.boundingBox()
    assert(bounds !== null, 'Stripe card payment method has no visible bounds')
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  }
  if (!usingSavedCard) await cardNumber.waitFor({ state: 'visible' })
  const saveInformation = page.locator('#enableStripePass')
  if ((await saveInformation.isVisible()) && (await saveInformation.isChecked())) {
    await saveInformation.uncheck()
  }
  if (!usingSavedCard) {
    await cardNumber.fill('4242424242424242')
    await page.locator('input[name="cardExpiry"]').fill('1234')
    await page.locator('input[name="cardCvc"]').fill('123')
  }
  const name = page.locator('input[name="billingName"]')
  if (await name.isVisible()) await name.fill(`Duet ${runId}`)
  const postalCode = page.locator('input[name="billingPostalCode"]')
  if (await postalCode.isVisible()) await postalCode.fill('94107')
  const emailInput = page.locator('input[name="email"]')
  if (await emailInput.isVisible()) await emailInput.fill(email)
  markExpectedBrowserTransition(page)
  await page.locator('button[type="submit"]').click()
  await page.waitForURL(
    url => url.origin === appUrl && url.searchParams.get('billing') === 'success',
    {
      timeout: 120_000,
    },
  )
}

async function stripeRequest<T = unknown>(
  env: StripeBillingTestEnv,
  pathname: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await stagingFetch(`https://api.stripe.com${pathname}`, {
    ...init,
    headers: new Headers({
      ...Object.fromEntries(new Headers(init.headers)),
      authorization: `Bearer ${env.stripeSecretKey}`,
    }),
  })
  if (!response.ok) throw new Error(`Stripe cleanup returned HTTP ${response.status}`)
  return (await response.json()) as T
}

async function cleanupStripeBillingByEmail(
  env: StripeBillingTestEnv,
  email: string,
): Promise<void> {
  const customers = await stripeRequest<{ data: Array<{ id: string; deleted?: boolean }> }>(
    env,
    `/v1/customers?email=${encodeURIComponent(email)}&limit=100`,
  )
  for (const customer of customers.data) {
    const sessions = await stripeRequest<{ data: Array<{ id: string; status: string }> }>(
      env,
      `/v1/checkout/sessions?customer=${encodeURIComponent(customer.id)}&limit=100`,
    )
    for (const session of sessions.data) {
      if (session.status === 'open') {
        await stripeRequest(env, `/v1/checkout/sessions/${session.id}/expire`, { method: 'POST' })
      }
    }
    if (!customer.deleted) {
      await stripeRequest(env, `/v1/customers/${customer.id}`, { method: 'DELETE' })
    }
  }
}

async function stripeBillingByEmailDeleted(
  env: StripeBillingTestEnv,
  email: string,
): Promise<boolean> {
  const customers = await stripeRequest<{ data: Array<{ id: string }> }>(
    env,
    `/v1/customers?email=${encodeURIComponent(email)}&limit=1`,
  )
  return customers.data.length === 0
}
