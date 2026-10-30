import assert from 'node:assert/strict'

import type { BrowserContext, Page } from '@playwright/test'

import {
  HARD_BLOCK_FLOOR_MICRO_USD,
  LOW_CREDIT_RECOVERY_THRESHOLD_MICRO_USD,
  WhoamiResponseSchema,
} from '@repo/contract'

import { completeStripeCardCheckout, recordStripeBillingSweep } from './staging-live-billing.ts'
import { waitForBrowserMagicLink } from './staging-live-browser-acceptance.ts'
import {
  attachBrowserDiagnostics,
  installStagingProtection,
  markExpectedBrowserTransition,
  navigateDeployedPage,
} from './staging-live-browser.ts'
import { fnMutation, fnQuery } from './staging-live-env.ts'
import { waitForForwardProgress } from './staging-live-forward-progress.ts'
import { apiJson, bearer, bearerJson } from './staging-live-http.ts'
import { resolveAgentMailInbox, taggedInboxAddress } from './staging-live-mailbox.ts'
import { waitForHydratedMagicLinkControls } from './staging-live-public-site.ts'
import { recordWorkspaceCleanup } from './staging-live-resource-ledger.ts'
import { assertWorkspaceCanBecomeActive, waitForWorkspace } from './staging-live-streaming.ts'
import {
  recordCheckoutSession,
  recordStripeCustomer,
  recordSubscription,
  stripeDelete,
  stripeForm,
  stripeGet,
} from './staging-live-subscriptions.ts'
import {
  runWorkspaceBrowserJourney,
  workspaceBrowserLoginRequest,
  type WorkspaceBrowserJourneyContext,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'

const ABOVE_RECOVERY_MICRO_USD = LOW_CREDIT_RECOVERY_THRESHOLD_MICRO_USD + 1
const AT_RECOVERY_MICRO_USD = LOW_CREDIT_RECOVERY_THRESHOLD_MICRO_USD
const AT_HARD_FLOOR_MICRO_USD = HARD_BLOCK_FLOOR_MICRO_USD

type LowCreditLegEvidence = {
  passed: string[]
}

export type LowCreditRecoveryEvidence = {
  subscriber: LowCreditLegEvidence
  trial: LowCreditLegEvidence
}

export async function runLowCreditRecoveryJourney(
  args: {
    onProgress?: (stage: string) => void
  } = {},
): Promise<WorkspaceBrowserJourneyResult<LowCreditRecoveryEvidence>> {
  return await runWorkspaceBrowserJourney({
    journey: 'low-credit-recovery',
    label: 'Low credit recovery',
    entitlement: 'trial',
    onProgress: args.onProgress,
    run: runSubscriberRecovery,
  })
}

function balanceAdjustment(currentMicroUsd: number, targetMicroUsd: number): number {
  assert(Number.isSafeInteger(currentMicroUsd), 'current balance must be an integer')
  assert(Number.isSafeInteger(targetMicroUsd), 'target balance must be an integer')
  return targetMicroUsd - currentMicroUsd
}

async function runSubscriberRecovery(
  context: WorkspaceBrowserJourneyContext,
): Promise<LowCreditRecoveryEvidence> {
  const passed: string[] = []
  const stripeSecretKey = requireStripeTestKey()
  const stripeEnv = { stripeSecretKey }
  recordStripeBillingSweep({
    env: stripeEnv,
    email: context.email,
    runId: context.runId,
    ledger: context.ledger,
  })
  const customer = await stripeForm<{ id: string }>(stripeEnv, '/v1/customers', {
    email: context.email,
    'metadata[owner]': 'duet-staging-e2e',
    'metadata[run_id]': context.runId,
  })
  recordStripeCustomer(context.ledger, stripeEnv, context.runId, customer.id)
  await context.convex.mutation(fnMutation('testing/stagingE2e:bindStripeTestCustomerForTest'), {
    internalKey: context.env.internalKey,
    email: context.email,
    stripeCustomerId: customer.id,
  })

  const subscriptionId = await createRealSubscription(context, stripeSecretKey, customer.id)
  recordSubscription(context.ledger, stripeEnv, context.runId, subscriptionId)

  await setExactBalance(context, ABOVE_RECOVERY_MICRO_USD, 'subscriber-above-threshold')
  await openDefaultChat(context.page, context.env.appUrl, context.workspace.slug)
  const draft = `Keep this subscriber draft ${context.runId}`
  const composer = sessionComposer(context.page)
  await composer.fill(draft)
  await waitForRecoveryProjection(context.page, context.workspace.slug, null)
  await expectNoGate(context.page)
  passed.push('above-threshold')

  await setExactBalance(context, AT_RECOVERY_MICRO_USD, 'subscriber-at-threshold')
  const payerGate = context.page.locator('[data-low-credit-gate="topup"]')
  await payerGate.waitFor({ timeout: 30_000 })
  assert.deepEqual(await topupChoices(payerGate), ['$20', '$50', '$100'])
  assert.equal(await composer.textContent(), draft)
  passed.push('subscriber-gate')

  const secondary = await openSecondaryTrialBrowser(context)
  try {
    await openDefaultChat(secondary.page, context.env.appUrl, context.workspace.slug)
    const memberGate = secondary.page.locator('[data-low-credit-gate="member"]')
    await memberGate.waitFor({ timeout: 30_000 })
    assert.equal(await memberGate.locator('[data-recovery-action]').count(), 0)
    passed.push('member-wait')

    await payerGate.getByRole('radio', { name: /\$20/ }).click()
    const originalUrl = context.page.url()
    const popupPromise = context.page.context().waitForEvent('page')
    await payerGate.locator('[data-recovery-action]').click()
    const checkoutPage = await popupPromise
    await checkoutPage.waitForURL(url => url.origin === 'https://checkout.stripe.com', {
      timeout: 60_000,
    })
    await recordOpenCheckoutSession(
      context,
      stripeSecretKey,
      customer.id,
      'payment',
      'low-credit-topup',
    )
    assert.equal(context.page.url(), originalUrl)
    assert.equal(await composer.textContent(), draft)
    await completeStripeCardCheckout(
      checkoutPage,
      context.email,
      `${context.runId}-low-credit-topup`,
      context.env.appUrl,
    )
    await context.page.bringToFront()
    await context.page.evaluate(() => window.focus())
    await waitForRecoveryProjection(context.page, context.workspace.slug, null)
    await payerGate.waitFor({ state: 'detached', timeout: 120_000 })
    assert.equal(context.page.url(), originalUrl)
    assert.equal(await composer.textContent(), draft)
    passed.push('hosted-topup-clears')

    await runSubscriberHardFloorRefusal(context)
    passed.push('stale-projection-refusal')

    const updateStatus = await context.page.evaluate(
      async ({ workspaceSlug }) =>
        (
          await fetch('/api/duet/user/billing', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workspaceSlug,
              autoTopupEnabled: true,
              autoTopupThresholdMicroUsd: 5_000_000,
              autoTopupAmountMicroUsd: 20_000_000,
              maxMonthlySpendMicroUsd: 0,
            }),
          })
        ).status,
      { workspaceSlug: context.workspace.slug },
    )
    assert.equal(updateStatus, 200, 'automatic top-up could not be enabled through the billing API')
    await setExactBalance(context, AT_RECOVERY_MICRO_USD, 'subscriber-auto-topup-suppression')
    await waitForRecoveryProjection(context.page, context.workspace.slug, null)
    await expectNoGate(context.page)
    await secondary.page.reload({ waitUntil: 'domcontentloaded' })
    await secondary.page
      .locator('[data-session-surface="product"]')
      .last()
      .waitFor({ timeout: 120_000 })
    await waitForRecoveryProjection(secondary.page, context.workspace.slug, null)
    await expectNoGate(secondary.page)
    passed.push('auto-topup-suppresses')

    const trial = await runTrialRecovery(secondary)

    await stripeDelete(stripeEnv, `/v1/subscriptions/${subscriptionId}`)
    await waitForWorkspaceServicing(context.page, context.workspace.slug, 'paused')
    await context.page.reload({ waitUntil: 'domcontentloaded' })
    await context.page.locator('[data-entitlement-wall]').waitFor({ timeout: 30_000 })
    await expectNoGate(context.page)
    passed.push('entitlement-precedence')
    return { subscriber: { passed }, trial }
  } finally {
    await secondary.browserContext.close()
  }
}

async function runTrialRecovery(
  context: WorkspaceBrowserJourneyContext,
): Promise<LowCreditLegEvidence> {
  const passed: string[] = []
  await setExactBalance(context, AT_RECOVERY_MICRO_USD, 'trial-at-threshold')
  await openDefaultChat(context.page, context.env.appUrl, context.workspace.slug)
  const gate = context.page.locator('[data-low-credit-gate="subscribe"]')
  await gate.waitFor({ timeout: 30_000 })
  for (const plan of ['Starter', 'Pro', 'Max']) {
    await gate.getByText(plan, { exact: true }).first().waitFor()
  }
  const selectedPlan = gate.locator('[role="radio"][aria-checked="true"]')
  assert.equal(await selectedPlan.count(), 1)
  assert.match((await selectedPlan.textContent()) ?? '', /Pro/)
  await gate.getByText('Recommended', { exact: true }).waitFor()
  passed.push('trial-gate')

  return { passed }
}

async function runSubscriberHardFloorRefusal(
  context: WorkspaceBrowserJourneyContext,
): Promise<void> {
  await setExactBalance(context, ABOVE_RECOVERY_MICRO_USD, 'subscriber-stale-race-arm')
  await waitForRecoveryProjection(context.page, context.workspace.slug, null)
  const staleIdentity = await context.page.evaluate(async () => {
    const response = await fetch('/api/duet/whoami')
    return { status: response.status, body: await response.text() }
  })
  assert.equal(staleIdentity.status, 200, 'stale-race identity snapshot failed')
  const identityPattern = '**/api/duet/whoami'
  await context.page.route(identityPattern, async route => {
    await route.fulfill({
      status: staleIdentity.status,
      contentType: 'application/json',
      body: staleIdentity.body,
    })
  })
  try {
    // Reload after installing the route so no identity request that began before
    // interception can race the hard-floor write and reveal the fresh gate.
    await context.page.reload({ waitUntil: 'domcontentloaded' })
    await openDefaultChat(context.page, context.env.appUrl, context.workspace.slug)
    await expectNoGate(context.page)
    const draft = `Preserve this hard-floor draft ${context.runId}`
    const composer = sessionComposer(context.page)
    await composer.fill(draft)
    await setExactBalance(context, AT_HARD_FLOOR_MICRO_USD, 'subscriber-stale-race-refusal')
    const submit = composer.locator('xpath=ancestor::form[1]').locator('button[type="submit"]')
    assert.equal(await submit.getAttribute('data-compose-submit-state'), 'enabled')
    const refusalResponsePromise = context.page.waitForResponse(response => {
      const url = new URL(response.url())
      const workspacePrefix = `/api/duet/ws/${context.workspace.slug}/`
      return (
        response.request().method() === 'POST' &&
        url.pathname.startsWith(workspacePrefix) &&
        (url.pathname === `${workspacePrefix}agent/sessions` || url.pathname.endsWith('/messages'))
      )
    })
    // Model a submit already in flight when the shell's proactive overlay wins
    // the same race. Playwright pointer actionability would correctly stop at
    // the overlay and therefore would not exercise the server hard floor.
    await submit.evaluate(button => (button as HTMLButtonElement).click())
    const refusalResponse = await refusalResponsePromise
    assert.equal(refusalResponse.status(), 402, 'hard-floor send did not return HTTP 402')
    assert.equal(
      ((await refusalResponse.json()) as { code?: string }).code,
      'insufficient_credits',
      'hard-floor send returned the wrong spend-refusal code',
    )
    await context.page
      .locator('[data-spend-refusal="insufficient_credits"]')
      .waitFor({ state: 'attached', timeout: 30_000 })
    assert.equal(await composer.textContent(), draft)
  } finally {
    await context.page.unroute(identityPattern)
    await setExactBalance(context, ABOVE_RECOVERY_MICRO_USD, 'subscriber-stale-race-restore')
    await context.page.reload({ waitUntil: 'domcontentloaded' })
    await openDefaultChat(context.page, context.env.appUrl, context.workspace.slug)
    await waitForRecoveryProjection(context.page, context.workspace.slug, null)
    await expectNoGate(context.page)
  }
}

async function createRealSubscription(
  context: WorkspaceBrowserJourneyContext,
  stripeSecretKey: string,
  customerId: string,
): Promise<string> {
  const checkout = await context.page.evaluate(
    async ({ workspaceSlug }) => {
      const response = await fetch('/api/duet/user/billing/subscription/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceSlug, plan: 'starter' }),
      })
      return { status: response.status, body: (await response.json()) as { url?: string } }
    },
    { workspaceSlug: context.workspace.slug },
  )
  assert.equal(checkout.status, 200, 'real subscriber checkout could not be created')
  assert(typeof checkout.body.url === 'string', 'real subscriber checkout omitted its URL')
  const checkoutPage = await context.page.context().newPage()
  markExpectedBrowserTransition(checkoutPage)
  await navigateDeployedPage(checkoutPage, checkout.body.url)
  await recordOpenCheckoutSession(
    context,
    stripeSecretKey,
    customerId,
    'subscription',
    'subscription-checkout',
  )
  await completeStripeCardCheckout(
    checkoutPage,
    context.email,
    `${context.runId}-subscription`,
    context.env.appUrl,
  )
  await checkoutPage.close()
  const subscription = await waitForStripeSubscription(stripeSecretKey, customerId)
  await waitForBillingSubscriptionActive(context.page)
  return subscription.id
}

async function setExactBalance(
  context: WorkspaceBrowserJourneyContext,
  targetMicroUsd: number,
  label: string,
): Promise<void> {
  const wallet = (await context.convex.query(fnQuery('testing/credits:walletForTest'), {
    internalKey: context.env.internalKey,
    workspaceId: context.workspace._id,
  })) as { balanceMicroUsd: number }
  const amountMicroUsd = balanceAdjustment(wallet.balanceMicroUsd, targetMicroUsd)
  if (amountMicroUsd !== 0) {
    const identity = await currentIdentity(context.page)
    await context.convex.mutation(fnMutation('testing/credits:applyAccountAdjustmentForTest'), {
      internalKey: context.env.internalKey,
      userId: identity.user.id,
      amountMicroUsd,
      reference: `${context.runId}:${label}:${crypto.randomUUID()}`,
      now: Date.now(),
    })
  }
  const exact = (await context.convex.query(fnQuery('testing/credits:walletForTest'), {
    internalKey: context.env.internalKey,
    workspaceId: context.workspace._id,
  })) as { balanceMicroUsd: number }
  assert.equal(exact.balanceMicroUsd, targetMicroUsd, `${label} did not reach the exact balance`)
}

async function currentIdentity(page: Page) {
  const result = await page.evaluate(async () => {
    const response = await fetch('/api/duet/whoami')
    return { status: response.status, body: await response.json() }
  })
  assertBrowserOk(result.status, 'browser whoami')
  return WhoamiResponseSchema.parse(result.body)
}

async function waitForRecoveryProjection(
  page: Page,
  workspaceSlug: string,
  expected: 'subscribe' | 'topup' | null,
): Promise<void> {
  await waitForForwardProgress<'subscribe' | 'topup' | null | undefined>({
    label: `workspace ${workspaceSlug} credit recovery ${String(expected)}`,
    timeoutMs: 30_000,
    maxConsecutiveUnchangedObservations: 30,
    pollMs: 1_000,
    load: async () => {
      const result = await page.evaluate(async () => {
        const response = await fetch('/api/duet/whoami')
        return { status: response.status, body: await response.json() }
      })
      assertBrowserOk(result.status, 'browser whoami recovery projection')
      const identity = WhoamiResponseSchema.parse(result.body)
      return identity.workspaces.find(row => row.slug === workspaceSlug)?.creditRecovery
    },
    isComplete: recovery => recovery === expected,
    hasProgress: (previous, recovery) => previous !== recovery,
  })
}

async function waitForWorkspaceServicing(
  page: Page,
  workspaceSlug: string,
  expected: 'active' | 'paused',
): Promise<void> {
  await waitForForwardProgress<string | undefined>({
    label: `workspace ${workspaceSlug} servicing ${expected}`,
    timeoutMs: 180_000,
    maxConsecutiveUnchangedObservations: 180,
    pollMs: 1_000,
    load: async () => {
      const identity = await currentIdentity(page)
      return identity.workspaces.find(row => row.slug === workspaceSlug)?.servicingStatus
    },
    isComplete: status => status === expected,
    hasProgress: (previous, status) => previous !== status,
  })
}

async function waitForBillingSubscriptionActive(page: Page): Promise<void> {
  await waitForForwardProgress<boolean>({
    label: 'active browser billing subscription',
    timeoutMs: 120_000,
    maxConsecutiveUnchangedObservations: 120,
    pollMs: 1_000,
    load: async () => {
      const result = await page.evaluate(async () => {
        const response = await fetch('/api/duet/user/billing')
        const body = (await response.json()) as { subscription?: { isActive?: boolean } | null }
        return { status: response.status, active: body.subscription?.isActive === true }
      })
      assertBrowserOk(result.status, 'browser billing overview')
      return result.active
    },
    isComplete: active => active,
    hasProgress: (previous, active) => previous !== active,
  })
}

async function openDefaultChat(page: Page, appUrl: string, workspaceSlug: string): Promise<void> {
  const target = `${appUrl}/w/${workspaceSlug}/agents/root`
  if (page.url() !== target) {
    markExpectedBrowserTransition(page)
    await navigateDeployedPage(page, target)
  }
  await page.locator('[data-session-surface="product"]').last().waitFor({ timeout: 120_000 })
}

/** The same editor owns a first message and every follow-up; its visible label
 * intentionally changes between those states, while this product contract does
 * not. The journey must prove both paths without mistaking their copy for two
 * different composers. */
function sessionComposer(page: Page) {
  return page.locator('[data-compose-bar-editor]').last()
}

async function expectNoGate(page: Page): Promise<void> {
  assert.equal(await page.locator('[data-low-credit-gate]').count(), 0)
}

async function topupChoices(gate: ReturnType<Page['locator']>): Promise<string[]> {
  return await gate
    .getByRole('radio')
    .evaluateAll(
      radios =>
        radios.map(radio => radio.textContent?.match(/\$\d+/)?.[0]).filter(Boolean) as string[],
    )
}

async function openSecondaryTrialBrowser(context: WorkspaceBrowserJourneyContext): Promise<
  WorkspaceBrowserJourneyContext & {
    browserContext: BrowserContext
  }
> {
  const inbox = await resolveAgentMailInbox({
    apiKey: context.env.agentMailApiKey,
    address: context.env.agentMailInboxAddress,
  })
  const memberEmail = lowCreditSecondaryEmail(inbox.address, context.runId)
  const login = await apiJson<{
    token: string
    expiresAt: number
    userId: string
    workspaceSlug: string
  }>(
    `${context.env.apiUrl}/v1/admin/login-as`,
    {
      method: 'POST',
      headers: bearerJson(context.env.loginSecret),
      body: JSON.stringify(
        workspaceBrowserLoginRequest({
          email: memberEmail,
          name: `Low credit secondary ${context.runId}`,
        }),
      ),
    },
    200,
    'low-credit member login',
    context.artifacts,
  )
  context.ledger.record({
    kind: 'user',
    id: login.userId,
    label: `${context.runId}:member:${memberEmail}`,
    cleanupPriority: -100,
    cleanup: async () => {
      await context.convex.mutation(fnMutation('testing/stagingE2e:retireUserByEmailForTest'), {
        internalKey: context.env.internalKey,
        email: memberEmail,
      })
    },
    verify: async () =>
      (await context.convex.query(fnQuery('testing/stagingE2e:userByEmailForTest'), {
        internalKey: context.env.internalKey,
        email: memberEmail,
      })) === null,
  })
  const memberIdentity = await apiJson<{
    workspaces: Array<{ id: string; slug: string; status: string }>
  }>(
    `${context.env.apiUrl}/v1/whoami`,
    { headers: bearer(login.token) },
    200,
    'low-credit member whoami',
    context.artifacts,
  )
  const memberSeed = memberIdentity.workspaces.find(row => row.slug === login.workspaceSlug)
  assert(memberSeed !== undefined, 'member bootstrap workspace missing')
  recordWorkspaceCleanup({
    ledger: context.ledger,
    convex: context.convex,
    env: context.env,
    output: { vmNames: context.vmNames },
    workspaceId: memberSeed.id,
    slug: memberSeed.slug,
  })
  await context.convex.mutation(fnMutation('testing/workspaces:addWorkspaceMemberForTest'), {
    internalKey: context.env.internalKey,
    workspaceId: context.workspace._id,
    userId: login.userId,
    role: 'editor',
  })
  const secondaryWorkspace = await waitForWorkspace(
    context.convex,
    context.env.internalKey,
    memberSeed.id,
    row => {
      assertWorkspaceCanBecomeActive(row)
      return row.status === 'active' && row.vmName !== undefined
    },
  )

  const browser = context.page.context().browser()
  assert(browser !== null, 'workspace journey browser was unavailable')
  const browserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await installStagingProtection(browserContext, {
    apiUrl: context.env.apiUrl,
    appUrl: context.env.appUrl,
    landerUrl: context.env.appUrl,
    docsUrl: context.env.appUrl,
    vercelBypassSecret: context.env.vercelBypassSecret,
  })
  attachBrowserDiagnostics(browserContext, context.artifacts)
  const page = await browserContext.newPage()
  try {
    // The full run id belongs in message content for exact mailbox matching,
    // not in the address local part, whose RFC limit is only 64 characters.
    const returnTo = `/w/${secondaryWorkspace.slug}/agents/root?e2e=${context.runId}`
    await navigateDeployedPage(
      page,
      `${context.env.appUrl}/sign-in?returnTo=${encodeURIComponent(returnTo)}`,
    )
    const controls = await waitForHydratedMagicLinkControls(page)
    await controls.email.fill(memberEmail)
    const requestedAt = Date.now()
    const [intent] = await Promise.all([
      page.waitForResponse(
        response =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/auth/magic-link',
      ),
      controls.submit.click({ noWaitAfter: true }),
    ])
    assert.equal(intent.status(), 204, 'member magic-link intent failed')
    const link = await waitForBrowserMagicLink({
      env: context.env,
      page,
      ledger: context.ledger,
      email: memberEmail,
      inboxId: inbox.id,
      requestedAt,
      runId: context.runId,
      returnTo,
    })
    markExpectedBrowserTransition(page)
    await navigateDeployedPage(page, link)
    await page.waitForURL(url => `${url.pathname}${url.search}` === returnTo, { timeout: 120_000 })
    return {
      ...context,
      browserContext,
      page,
      workspace: secondaryWorkspace,
      apiToken: login.token,
      email: memberEmail,
    }
  } catch (error) {
    await browserContext.close()
    throw error
  }
}

export function lowCreditSecondaryEmail(inboxAddress: string, runId: string): string {
  return taggedInboxAddress(inboxAddress, `staging-e2e-lc-${runId.split('-').slice(-2).join('-')}`)
}

function requireStripeTestKey(): string {
  const key = process.env.STRIPE_SECRET_KEY?.trim()
  assert(
    key !== undefined && key.startsWith('sk_test_'),
    'low-credit journey requires STRIPE_SECRET_KEY=sk_test_...',
  )
  return key
}

async function recordOpenCheckoutSession(
  context: WorkspaceBrowserJourneyContext,
  secretKey: string,
  customerId: string,
  mode: 'payment' | 'subscription',
  label: string,
): Promise<void> {
  const sessions = await stripeGet<{
    data: Array<{ id: string; status: string; mode: string; created: number }>
  }>(
    { stripeSecretKey: secretKey },
    `/v1/checkout/sessions?customer=${encodeURIComponent(customerId)}&limit=10`,
  )
  const open = sessions.data
    .filter(session => session.status === 'open' && session.mode === mode)
    .sort((left, right) => right.created - left.created)[0]
  assert(open !== undefined, `${label} did not create an open ${mode} Stripe Checkout session`)
  recordCheckoutSession(context.ledger, { stripeSecretKey: secretKey }, context.runId, open.id)
}

async function waitForStripeSubscription(
  secretKey: string,
  customerId: string,
): Promise<{ id: string }> {
  const subscription = await waitForForwardProgress<{ id: string; status: string } | undefined>({
    label: `Stripe subscription for ${customerId}`,
    timeoutMs: 120_000,
    maxConsecutiveUnchangedObservations: 120,
    pollMs: 1_000,
    load: async () => {
      const subscriptions = await stripeGet<{
        data: Array<{ id: string; status: string }>
      }>(
        { stripeSecretKey: secretKey },
        `/v1/subscriptions?customer=${encodeURIComponent(customerId)}&status=all&limit=10`,
      )
      return subscriptions.data.find(subscription => subscription.status === 'active')
    },
    isComplete: value => value !== undefined,
    hasProgress: (previous, value) =>
      `${previous?.id ?? 'none'}:${previous?.status ?? 'none'}` !==
      `${value?.id ?? 'none'}:${value?.status ?? 'none'}`,
  })
  assert(subscription !== undefined, 'Stripe subscription wait completed without a subscription')
  return subscription
}

function assertBrowserOk(status: number, label: string): void {
  assert(status >= 200 && status < 300, `${label} returned HTTP ${status}`)
}
