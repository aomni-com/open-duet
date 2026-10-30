/**
 * SUBS-IMPL-12 staging subscription lifecycle.
 *
 * Live prerequisites (all must target the deployed staging stack):
 * DUET_API_URL, DUET_APP_URL, DUET_LANDER_URL, CONVEX_DEPLOYMENT,
 * DUET_API_INTERNAL_KEY, DUET_EDGE_INTERNAL_KEY, DUET_PROGRAMMATIC_LOGIN_SECRET,
 * VERCEL_AUTOMATION_BYPASS_SECRET, AGENTMAIL_API_KEY,
 * DUET_E2E_AGENTMAIL_INBOX_ADDRESS, STRIPE_SECRET_KEY=sk_test_...,
 * STRIPE_WEBHOOK_SECRET=whsec_..., STRIPE_BILLING_PORTAL_CONFIGURATION_ID=bpc_....
 * The deployed backend must carry the same Stripe test key, webhook secret,
 * recurring price ids, and portal configuration id. Stripe's Duet webhook must
 * point exactly at <CONVEX_SITE_URL>/v1/stripe/webhook.
 */
import assert from 'node:assert/strict'
import path from 'node:path'

import type { BrowserContext, Page } from '@playwright/test'
import { ConvexHttpClient } from 'convex/browser'

import {
  DEFAULT_TRIAL_GRANT_MICRO_USD,
  DUET_STAGING_EDGE_HOST,
  UserBillingOverviewSchema,
  type UserBillingOverview,
  SERVICING_ARCHIVE_AFTER_MS,
} from '@repo/contract'

import { StagingArtifactCollector } from './staging-live-artifacts.ts'
import { completeStripeCardCheckout } from './staging-live-billing.ts'
import {
  fnAction,
  fnMutation,
  fnQuery,
  STORAGE_TIER_RESIZE_LEG,
  SUBSCRIPTION_LIFECYCLE_LEGS,
  type LiveEnv,
  type Workspace,
} from './staging-live-env.ts'
import { apiJson, apiText, bearer, bearerJson, stagingFetch } from './staging-live-http.ts'
import { taggedInboxAddress } from './staging-live-mailbox.ts'
import {
  recordWorkspaceCleanup,
  StagingResourceLedger,
  workspaceIsDeleted,
} from './staging-live-resource-ledger.ts'
import {
  captureResizeAuditEventIds,
  proveScheduledDowngradeRetainsProCapacity,
  proveStarterStorageCapacity,
  proveStorageTierResize,
} from './staging-live-storage-tier.ts'
import { waitForWorkspace } from './staging-live-streaming.ts'

const POLL_TIMEOUT_MS = 120_000
/* Derived, never restated: the journey backdates a pause to just past the
   window the sweep actually enforces, so a policy change moves both together. */
const ARCHIVE_AFTER_MS = SERVICING_ARCHIVE_AFTER_MS

type OverviewSnapshot = { leg: number; at: number; overview: UserBillingOverview }
type PortalConfiguration = {
  features: Record<
    'invoice_history' | 'payment_method_update' | 'subscription_update' | 'subscription_cancel',
    { enabled: boolean }
  >
}
type StripeInvoicePaidEvent = { id: string; data: { object: { id: string } } }

export async function runStagingSubscriptionLifecycle(args: {
  env: LiveEnv
  runId: string
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
  output: {
    legs: Record<string, { status: 'pass' | 'fail' | 'skipped'; reason?: string }>
    vmNames: string[]
  }
  progress: (stage: string) => void
  openAuthenticatedPage: (input: {
    email: string
    workspace: Workspace
  }) => Promise<{ context: BrowserContext; page: Page }>
}): Promise<void> {
  const { env, runId, ledger, convex, output, progress } = args
  assert(
    env.stripeSecretKey.startsWith('sk_test_'),
    'subscription lifecycle refuses non-test Stripe keys',
  )
  const evidence = new StagingArtifactCollector(
    path.join(env.artifactRoot, `staging-live-${runId}`),
    [
      env.internalKey,
      env.loginSecret,
      env.stripeSecretKey,
      env.stripeWebhookSecret,
      env.vercelBypassSecret,
    ],
  )
  await evidence.initialize()
  const snapshots: OverviewSnapshot[] = []
  const pass = (index: number) => {
    output.legs[SUBSCRIPTION_LIFECYCLE_LEGS[index - 1]!] = { status: 'pass' }
  }
  const lifecycleEmail = lifecycleAddress(env.agentMailInboxAddress, runId)
  const clock = await stripeForm<{ id: string; status: string }>(
    env,
    '/v1/test_helpers/test_clocks',
    {
      frozen_time: Math.floor(Date.now() / 1_000),
      name: `${runId}-subscription-clock`,
    },
  )
  recordStripeClock(ledger, env, runId, clock.id)

  const login = await apiJson<{
    token: string
    expiresAt: number
    userId: string
    workspaceSlug: string
  }>(
    `${env.apiUrl}/v1/admin/login-as`,
    {
      method: 'POST',
      headers: bearerJson(env.loginSecret),
      body: JSON.stringify({
        email: lifecycleEmail,
        create: true,
        ephemeral: true,
        name: `Subscription ${runId}`,
      }),
    },
    200,
    'subscription lifecycle login',
  )
  ledger.record({
    kind: 'user',
    id: login.userId,
    label: `${runId}:subscription-user:${lifecycleEmail}`,
    cleanupPriority: -100,
    cleanup: async () => {
      await convex.mutation(fnMutation('testing/stagingE2e:retireUserByEmailForTest'), {
        internalKey: env.internalKey,
        email: lifecycleEmail,
      })
    },
    verify: async () =>
      (await convex.query(fnQuery('testing/stagingE2e:userByEmailForTest'), {
        internalKey: env.internalKey,
        email: lifecycleEmail,
      })) === null,
  })
  const whoami = await apiJson<{
    workspaces: Array<{ id: string; slug: string; status: string; billingUserId: string }>
  }>(`${env.apiUrl}/v1/whoami`, { headers: bearer(login.token) }, 200, 'subscription whoami')
  const seed = whoami.workspaces.find(row => row.slug === login.workspaceSlug)
  assert(
    seed !== undefined && seed.billingUserId === login.userId,
    'lifecycle workspace payer mismatch',
  )
  const workspace: Workspace = { _id: seed.id, slug: seed.slug, status: seed.status }
  recordWorkspaceCleanup({ ledger, convex, env, output, workspaceId: seed.id, slug: seed.slug })

  const customer = await stripeForm<{ id: string }>(env, '/v1/customers', {
    email: lifecycleEmail,
    test_clock: clock.id,
    'metadata[owner]': 'duet-staging-e2e',
    'metadata[run_id]': runId,
  })
  recordStripeCustomer(ledger, env, runId, customer.id)
  await convex.mutation(fnMutation('testing/stagingE2e:bindStripeTestCustomerForTest'), {
    internalKey: env.internalKey,
    email: lifecycleEmail,
    stripeCustomerId: customer.id,
  })

  await pollPublicWorkspace(
    env,
    login.token,
    workspace._id,
    row => row.status === 'active' && row.servicingStatus === 'active',
    240_000,
  )
  const attachedWorkspace = await waitForWorkspace(
    convex,
    env.internalKey,
    workspace._id,
    row => row.status === 'active' && row.vmName !== undefined,
    240_000,
  )
  assert(attachedWorkspace.vmName !== undefined, 'lifecycle workspace omitted its VM name')
  const lifecycleVmName = attachedWorkspace.vmName
  workspace.vmName = lifecycleVmName
  if (!output.vmNames.includes(lifecycleVmName)) output.vmNames.push(lifecycleVmName)
  // Billing routes accept only real browser sessions (impersonation keys are
  // deliberately excluded), so all overview reads ride the authenticated
  // page's own fetch — the same transport the product uses.
  const auth = await args.openAuthenticatedPage({ email: lifecycleEmail, workspace })
  const { context, page } = auth
  // A freshly provisioned VM may still be self-updating its gateway right
  // after the workspace flips active; prove the data plane answers before
  // spending the generation poll budget on dispatch readiness.
  await poll(
    async () => {
      const response = await stagingFetch(`${env.apiUrl}/v1/ws/${workspace.slug}/files?list=1`, {
        headers: bearer(login.token),
      })
      return response.ok ? response : undefined
    },
    180_000,
    'lifecycle workspace gateway readiness',
  )
  const initial = await overview(page)
  assertIsolatedLifecycleTrial(initial)
  snapshots.push({ leg: 1, at: Date.now(), overview: initial })
  const generation = await createGeneration(
    env,
    login.token,
    workspace.slug,
    `${runId} cheap trial probe`,
  )
  // dispatched=false still delivers via the runner input rail; the balance
  // poll below is the real proof of the charged turn.
  void generation.dispatched
  ledger.record({
    kind: 'session',
    id: generation.session.sessionId,
    label: `${runId}:subscription-session:${generation.session.sessionId}`,
    cleanup: async () => undefined,
    verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
  })
  // The first generation on a fresh VM can miss its dispatch window (cold
  // exe-proxy connection) and ride the runner-input drain instead, which
  // redelivers on the sync-persistence cadence — minutes, not seconds.
  await pollOverview(page, value => value.balanceMicroUsd < initial.balanceMicroUsd, 360_000)
  pass(1)

  const markerPath = `subscription-${runId}.txt`
  const markerBody = `subscription archive marker ${runId}`
  await apiText(
    `${env.apiUrl}/v1/ws/${workspace.slug}/files/${markerPath}`,
    {
      method: 'PUT',
      headers: new Headers({
        authorization: `Bearer ${login.token}`,
        'content-type': 'text/plain',
      }),
      body: markerBody,
    },
    200,
    'subscription archive marker write',
  )
  ledger.record({
    kind: 'file',
    id: markerPath,
    label: `${runId}:subscription-file:${markerPath}`,
    cleanup: async () => undefined,
    verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
  })
  const appSlug = 'hello'
  const visibility = await stagingFetch(
    `${env.apiUrl}/v1/ws/${workspace.slug}/apps/${appSlug}/visibility`,
    {
      method: 'POST',
      headers: bearerJson(login.token),
      body: JSON.stringify({ visibility: 'public' }),
    },
  )
  assert.equal(visibility.status, 200, 'seeded hello app could not be made public')
  const edgeUrl = `https://${appSlug}--${workspace.slug}.${DUET_STAGING_EDGE_HOST}/`
  await poll(
    async () => {
      const response = await stagingFetch(edgeUrl)
      return response.ok ? response : undefined
    },
    90_000,
    'warm public edge app',
  )

  progress('subscription:exhaustion')
  const beforeExhaust = await overview(page)
  await convex.mutation(fnMutation('domains/credits/internal:applyLedgerEntry'), {
    internalKey: env.internalKey,
    workspaceId: workspace._id,
    userId: login.userId,
    amountMicroUsd: -beforeExhaust.balanceMicroUsd,
    type: 'usage',
    reference: `usage:${runId}:trial-exhaustion`,
  })
  const blocked = await stagingFetch(`${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions`, {
    method: 'POST',
    headers: bearerJson(login.token),
    body: JSON.stringify({ prompt: `${runId} must be blocked` }),
  })
  assert.equal(blocked.status, 402)
  const block = (await blocked.json()) as { code?: string; billingUrl?: string }
  assert.equal(block.code, 'subscription_required')
  assert.equal(typeof block.billingUrl, 'string')
  await pollPublicWorkspace(
    env,
    login.token,
    workspace._id,
    row => row.servicingStatus === 'paused',
  )
  const pausedFiles = await stagingFetch(`${env.apiUrl}/v1/ws/${workspace.slug}/files?list=1`, {
    headers: bearer(login.token),
  })
  assert.equal(pausedFiles.status, 402, 'paused workspace still resolved a VM data-plane token')
  assert.equal(
    ((await pausedFiles.json()) as { error?: string }).error,
    'workspace_paused',
    'paused workspace returned the wrong data-plane refusal code',
  )

  try {
    await page.goto(`${env.appUrl}/w/${workspace.slug}/agents`, { waitUntil: 'domcontentloaded' })
    const wall = page.locator('[data-entitlement-wall="trial-exhausted"]')
    await wall.waitFor()
    /* No "will": `d4eea2c9` made this sentence a computed countdown rather than a
       constant, because the old one said "will shut down in 7 days" on the last
       day too and went on saying it after the workspace was already gone. Seven
       is still exact here — the pause above set `servicingStatusChangedAt` a
       moment ago and the notice ceils the remaining window — so this keeps
       checking the number as well as the words. */
    await wall
      .getByText('Your workspace and all its files shut down in 7 days.', { exact: true })
      .waitFor()
    const wallBackdrop = await wall.evaluate(element => {
      const style = getComputedStyle(element)
      return { backgroundColor: style.backgroundColor, backdropFilter: style.backdropFilter }
    })
    assert.notEqual(wallBackdrop.backgroundColor, 'rgba(0, 0, 0, 0)')
    assert.notEqual(wallBackdrop.backdropFilter, 'none')
    await page.screenshot({
      path: path.join(evidence.directory, '02-subscribe-wall.png'),
      fullPage: true,
    })
    const pausedEdge = await poll(
      async () => {
        const response = await stagingFetch(edgeUrl)
        const body = await response.text()
        return response.status === 503 && body.includes('data-edge-paused-page')
          ? { response, body }
          : undefined
      },
      35_000,
      'branded paused edge page',
    )
    assert(pausedEdge.body.includes('is paused'))
    pass(2)

    progress('subscription:checkout')
    await page.goto(`${env.appUrl}/settings/billing`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: 'Billing', exact: true }).last().waitFor()
    const checkoutRequest = page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/duet/user/billing/subscription/checkout',
    )
    await page.getByRole('button', { name: 'Subscribe to Starter', exact: true }).click()
    assert.equal((await checkoutRequest).status(), 200)
    await page.waitForURL(url => url.origin === 'https://checkout.stripe.com', { timeout: 60_000 })
    const session = await onlyCheckoutSession(env, customer.id, 'subscription')
    assert(session.id.startsWith('cs_test_'))
    recordCheckoutSession(ledger, env, runId, session.id)
    await completeStripeCardCheckout(page, lifecycleEmail, runId, env.appUrl)
    const completedCheckout = await stripeGet<{ subscription: string | null }>(
      env,
      `/v1/checkout/sessions/${session.id}`,
    )
    const subscriptionId = completedCheckout.subscription
    assert(typeof subscriptionId === 'string' && subscriptionId.startsWith('sub_'))
    recordSubscription(ledger, env, runId, subscriptionId)
    pass(3)

    const starter = await pollOverview(
      page,
      value =>
        value.subscription?.plan === 'starter' &&
        value.subscription.isActive &&
        // Exact-allotment reads race late reconciliation of trial generations,
        // which allocate monthly-first once the bucket exists.
        withinReconciliationDrift(value.monthlyCreditBalanceMicroUsd, 20_000_000),
    )
    snapshots.push({ leg: 4, at: Date.now(), overview: starter })
    const subscription = await stripeGet<{ id: string; schedule: string | null }>(
      env,
      `/v1/subscriptions/${completedCheckout.subscription}`,
    )
    const invoice = await newestPaidInvoice(env, customer.id, 'subscription_create')
    recordInvoice(ledger, env, runId, invoice.id)
    await assertGrantEvidence(convex, env, login.userId, invoice.id, 1)
    await pollPublicWorkspace(
      env,
      login.token,
      workspace._id,
      row => row.servicingStatus === 'active',
    )
    await page.goto(`${env.appUrl}/w/${workspace.slug}/agents`, { waitUntil: 'domcontentloaded' })
    await page.locator('[data-entitlement-wall]').waitFor({ state: 'detached' })
    const resumedEdge = await poll(
      async () => {
        const response = await stagingFetch(edgeUrl)
        return response.ok ? response : undefined
      },
      35_000,
      'resumed edge app',
    )
    assert(resumedEdge.ok)
    pass(4)

    progress('subscription:topup-and-spend')
    await page.goto(`${env.appUrl}/settings/billing`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Add to paid reserve', exact: true }).click()
    await page.waitForURL(url => url.origin === 'https://checkout.stripe.com', { timeout: 60_000 })
    const topupSession = await onlyCheckoutSession(env, customer.id, 'payment')
    recordCheckoutSession(ledger, env, runId, topupSession.id)
    await completeStripeCardCheckout(page, lifecycleEmail, `${runId}-topup`, env.appUrl)
    const topupInvoice = await poll(
      async () => await newestPaidInvoiceOrUndefined(env, customer.id, 'manual'),
      POLL_TIMEOUT_MS,
      'paid topup invoice',
    )
    recordInvoice(ledger, env, runId, topupInvoice.id)
    const afterTopup = await pollOverview(page, value => value.paidCreditBalanceMicroUsd > 0)
    const monthlyBeforeGeneration = afterTopup.monthlyCreditBalanceMicroUsd
    const rowsBeforeGeneration = await accountTransactions(convex, env, login.userId)
    const monthlyGeneration = await createGeneration(
      env,
      login.token,
      workspace.slug,
      `${runId} monthly-first probe`,
    )
    void monthlyGeneration.dispatched
    await pollOverview(page, value => value.monthlyCreditBalanceMicroUsd < monthlyBeforeGeneration)
    // Balance snapshots race concurrent reconciliation settlements of earlier
    // generations (adjustments can be thousands of microUSD), so monthly-first
    // allocation is proven on the atomic ledger rows: every generation debit that
    // settled after the topup must have taken nothing from the paid bucket.
    const priorIds = new Set(rowsBeforeGeneration.map(row => row._id))
    // Adjustment rows (settle/reconcile) suffix the base generation reference, so
    // rows belonging to pre-topup generations are excluded by reference prefix:
    // those may legitimately adjust the paid bucket they were allocated from.
    const priorGenerationReferences = rowsBeforeGeneration
      .map(row => row.reference)
      .filter(reference => reference.startsWith('ai_generation:'))
    const rowsAfterGeneration = await accountTransactions(convex, env, login.userId)
    const freshGenerationRows = rowsAfterGeneration.filter(
      row =>
        !priorIds.has(row._id) &&
        row.reference.startsWith('ai_generation:') &&
        !priorGenerationReferences.some(reference => row.reference.startsWith(reference)),
    )
    assert(freshGenerationRows.length > 0, 'monthly-first probe produced no ledger rows')
    for (const row of freshGenerationRows) {
      assert.equal(
        row.paidAmountMicroUsd ?? 0,
        0,
        `monthly-first generation row ${row.reference} took ${row.paidAmountMicroUsd} from paid`,
      )
    }
    assert(
      freshGenerationRows.some(row => (row.monthlyAmountMicroUsd ?? 0) < 0),
      'monthly-first probe never debited the monthly bucket',
    )
    // Bucket-boundary crossing: debit one microUSD past the monthly balance and
    // prove on the resulting row that the allocator drained monthly first, then
    // spilled the remainder into paid. The spill exceeds 1 only by whatever
    // reconciliation drift landed between the read and the debit; a bucket
    // misallocation would show up as a spill of the entire debit.
    const beforeBoundary = await overview(page)
    const boundaryDebitMicroUsd = beforeBoundary.monthlyCreditBalanceMicroUsd + 1
    const boundaryReference = `usage:${runId}:bucket-boundary`
    await convex.mutation(fnMutation('domains/credits/internal:applyLedgerEntry'), {
      internalKey: env.internalKey,
      workspaceId: workspace._id,
      userId: login.userId,
      amountMicroUsd: -boundaryDebitMicroUsd,
      type: 'usage',
      reference: boundaryReference,
    })
    const boundaryRow = (await accountTransactions(convex, env, login.userId)).find(
      row => row.reference === boundaryReference,
    )
    assert(boundaryRow !== undefined, 'bucket-boundary ledger row missing')
    const boundaryMonthly = boundaryRow.monthlyAmountMicroUsd ?? 0
    const boundaryPaid = boundaryRow.paidAmountMicroUsd ?? 0
    assert.equal(boundaryMonthly + boundaryPaid, -boundaryDebitMicroUsd)
    assert(boundaryMonthly < 0, 'boundary debit did not drain monthly')
    assert(
      boundaryPaid <= -1 && boundaryPaid >= -100_000,
      `boundary spill into paid was ${-boundaryPaid} microUSD (expected 1 plus at most reconciliation drift)`,
    )
    await pollOverview(
      page,
      value => value.monthlyCreditBalanceMicroUsd < beforeBoundary.monthlyCreditBalanceMicroUsd,
    )
    pass(5)

    // Concurrent generation settlements insert usage rows at any time; the
    // replay contract only covers billing rows (grants, expiries, topups).
    const billingRows = (rows: Awaited<ReturnType<typeof accountTransactions>>) =>
      rows.filter(row => row.type !== 'usage')
    const beforeReplay = billingRows(await accountTransactions(convex, env, login.userId))
    const paidEvent = await invoicePaidEvent(env, invoice.id)
    await replaySignedWebhook(env, paidEvent)
    const afterReplay = billingRows(await accountTransactions(convex, env, login.userId))
    assert.deepEqual(afterReplay, beforeReplay, 'invoice replay changed durable ledger evidence')
    assert(topupInvoice.id.startsWith('in_'), 'topup did not create a real Stripe invoice')
    assert(
      (await accountTransactions(convex, env, login.userId)).some(
        row => row.type === 'topup' && row.reference === topupInvoice.id,
      ),
      'topup credit did not come from invoice.paid',
    )
    pass(6)

    await proveStarterStorageCapacity(lifecycleVmName)
    await postPlan(page, workspace.slug, { plan: 'pro' })
    const pro = await pollOverview(
      page,
      value =>
        value.subscription?.plan === 'pro' &&
        withinReconciliationDrift(value.monthlyCreditBalanceMicroUsd, 60_000_000) &&
        value.workspaces.find(candidate => candidate.id === workspace._id)?.storage.usableGb === 50,
    )
    const { sessionId: postResizeSessionId } = await proveStorageTierResize({
      env,
      token: login.token,
      workspaceSlug: workspace.slug,
      vmName: lifecycleVmName,
      prompt: `Reply exactly "${runId} storage resize recovered" and do not call tools.`,
    })
    ledger.record({
      kind: 'session',
      id: postResizeSessionId,
      label: `${runId}:storage-tier-resize-session:${postResizeSessionId}`,
      cleanup: async () => undefined,
      verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
    })
    snapshots.push({ leg: 7, at: Date.now(), overview: pro })
    const upgradeInvoice = await newestPaidInvoice(env, customer.id, 'subscription_update')
    recordInvoice(ledger, env, runId, upgradeInvoice.id)
    await assertGrantEvidence(convex, env, login.userId, upgradeInvoice.id, 1, 2)
    const upgradeExpiry = (await accountTransactions(convex, env, login.userId)).find(
      row => row.reference === `subscription_expiry:invoice:${upgradeInvoice.id}`,
    )
    assert(
      upgradeExpiry !== undefined,
      'upgrade did not supersede the Starter monthly bucket before the Pro grant',
    )
    const portalSession = await page.evaluate(async workspaceSlug => {
      const response = await fetch('/api/duet/user/billing/portal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceSlug }),
      })
      return {
        status: response.status,
        body: (await response.json()) as { url?: string; sessionId?: string },
      }
    }, workspace.slug)
    assert.equal(portalSession.status, 200)
    assert(portalSession.body.url?.startsWith('https://billing.stripe.com/'))
    const portalSessionId = portalSession.body.sessionId
    assert(typeof portalSessionId === 'string' && portalSessionId.startsWith('bps_'))
    recordPortalSession(ledger, env, runId, portalSessionId, customer.id)
    const portal = await stripeGet<PortalConfiguration>(
      env,
      `/v1/billing_portal/configurations/${env.stripeBillingPortalConfigurationId}`,
    )
    assert.equal(portal.features.invoice_history.enabled, true)
    assert.equal(portal.features.payment_method_update.enabled, true)
    assert.equal(portal.features.subscription_update.enabled, false)
    assert.equal(portal.features.subscription_cancel.enabled, false)
    output.legs[STORAGE_TIER_RESIZE_LEG] = { status: 'pass' }
    pass(7)

    const auditIdsBeforeDowngrade = await captureResizeAuditEventIds(
      env,
      login.token,
      workspace.slug,
    )
    await postPlan(page, workspace.slug, { plan: 'starter' })
    const downgrade = await pollOverview(
      page,
      value => value.subscription?.pendingPlan === 'starter',
    )
    assert.equal(downgrade.subscription?.plan, 'pro')
    // The pro allotment is granted as exactly 60M; late reconciliation of earlier
    // generations may have nibbled it by the time this leg reads the projection.
    assert(
      withinReconciliationDrift(downgrade.monthlyCreditBalanceMicroUsd, 60_000_000),
      `pro monthly allotment projected as ${downgrade.monthlyCreditBalanceMicroUsd}`,
    )
    const scheduledSubscription = await stripeGet<{ schedule: string }>(
      env,
      `/v1/subscriptions/${subscription.id}`,
    )
    assert(scheduledSubscription.schedule?.startsWith('sub_sched_'))
    recordSchedule(ledger, env, runId, scheduledSubscription.schedule)
    await proveScheduledDowngradeRetainsProCapacity({
      env,
      token: login.token,
      workspaceSlug: workspace.slug,
      vmName: lifecycleVmName,
      auditIdsBeforeDowngrade,
    })
    pass(8)

    await postPlan(page, workspace.slug, { cancel: true })
    const canceling = await pollOverview(
      page,
      value => value.subscription?.cancelAtPeriodEnd === true,
    )
    assert.equal(canceling.subscription?.isActive, true)
    assert(canceling.balanceMicroUsd > 0)
    pass(9)

    await stripeForm(env, `/v1/test_helpers/test_clocks/${clock.id}/advance`, {
      frozen_time: Math.floor(canceling.subscription!.currentPeriodEnd / 1_000) + 60,
    })
    await poll(
      async () => {
        const value = await stripeGet<{ status: string }>(
          env,
          `/v1/test_helpers/test_clocks/${clock.id}`,
        )
        return value.status === 'ready' ? value : undefined
      },
      POLL_TIMEOUT_MS,
      'Stripe test clock readiness',
    )
    const lapsed = await pollOverview(
      page,
      value =>
        value.subscription !== null &&
        !value.subscription.isActive &&
        value.monthlyCreditBalanceMicroUsd === 0,
    )
    snapshots.push({ leg: 10, at: Date.now(), overview: lapsed })
    const lapseExpiryRows = (await accountTransactions(convex, env, login.userId)).filter(
      row =>
        row.type === 'subscription_expiry' &&
        row.reference.startsWith(`subscription_expiry:lapse:${subscription.id}:`),
    )
    assert.equal(lapseExpiryRows.length, 1, 'lapse zeroed the monthly bucket more than once')
    // Lapse must only expire the monthly bucket — proven on the atomic expiry row
    // rather than by comparing paid balances across legs, which races
    // reconciliation settlements of earlier generations.
    assert.equal(
      lapseExpiryRows[0]!.paidAmountMicroUsd ?? 0,
      0,
      'subscription lapse expiry touched the paid bucket',
    )
    const lapseBlock = await stagingFetch(`${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions`, {
      method: 'POST',
      headers: bearerJson(login.token),
      body: JSON.stringify({ prompt: `${runId} lapsed` }),
    })
    assert.equal(lapseBlock.status, 402)
    await pollPublicWorkspace(
      env,
      login.token,
      workspace._id,
      row => row.servicingStatus === 'paused',
    )
    pass(10)

    const gatewayDarkAt = Date.now()
    await poll(
      async () => {
        const response = await stagingFetch(`${env.apiUrl}/v1/ws/${workspace.slug}/files?list=1`, {
          headers: bearer(login.token),
        })
        return response.status === 402 ? response : undefined
      },
      16_000,
      'paused gateway data plane',
    )
    assert(Date.now() - gatewayDarkAt <= 16_000)
    await poll(
      async () => {
        const response = await stagingFetch(edgeUrl)
        return response.status === 503 ? response : undefined
      },
      31_000,
      'warmed paused edge cache',
    )
    // The servicing sweep is idempotent and isolates transient archive errors per
    // workspace. Production retries them periodically; this accelerated journey
    // sweep-and-checks in a bounded loop.
    let archivedProjection = false
    for (let attempt = 0; attempt < 4 && !archivedProjection; attempt += 1) {
      try {
        await convex.action(
          fnAction('domains/workspaces/provisioningActions:decommissionUnservicedWorkspaces'),
          {
            internalKey: env.internalKey,
            now: Date.now() + ARCHIVE_AFTER_MS + 1,
          },
        )
      } catch (error) {
        if (attempt >= 3) throw error
      }
      archivedProjection = await pollPublicWorkspace(
        env,
        login.token,
        workspace._id,
        row => row.status === 'archived',
        60_000,
      ).then(
        () => true,
        () => false,
      )
    }
    assert(archivedProjection, 'paused workspace never archived across decommission sweeps')
    // A fresh Checkout is the public resubscribe seam; invoice.paid then drives reprovision.
    await page.goto(`${env.appUrl}/settings/billing`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Subscribe to Starter', exact: true }).click()
    await page.waitForURL(url => url.origin === 'https://checkout.stripe.com', { timeout: 60_000 })
    const resumeSession = await onlyCheckoutSession(env, customer.id, 'subscription')
    recordCheckoutSession(ledger, env, runId, resumeSession.id)
    await completeStripeCardCheckout(page, lifecycleEmail, `${runId}-resume`, env.appUrl)
    const completedResume = await stripeGet<{ subscription: string | null }>(
      env,
      `/v1/checkout/sessions/${resumeSession.id}`,
    )
    const resumedSubscriptionId = completedResume.subscription
    assert(typeof resumedSubscriptionId === 'string' && resumedSubscriptionId.startsWith('sub_'))
    recordSubscription(ledger, env, runId, resumedSubscriptionId)
    const resumed = await pollOverview(page, value => value.subscription?.isActive === true)
    snapshots.push({ leg: 11, at: Date.now(), overview: resumed })
    await pollPublicWorkspace(
      env,
      login.token,
      workspace._id,
      row => row.status === 'active' && row.servicingStatus === 'active',
      300_000,
    )
    const resumeInvoice = await newestPaidInvoiceExcluding(
      env,
      customer.id,
      'subscription_create',
      new Set([invoice.id]),
    )
    recordInvoice(ledger, env, runId, resumeInvoice.id)
    // The archive restore runs on the VM after it phones home and the
    // workspace flips active — file availability is eventual, so poll.
    const restored = await poll(
      async () => {
        const response = await stagingFetch(
          `${env.apiUrl}/v1/ws/${workspace.slug}/files/${markerPath}`,
          { headers: bearer(login.token) },
        )
        if (!response.ok) return undefined
        return await response.text()
      },
      POLL_TIMEOUT_MS,
      'restored subscription marker read',
    )
    assert.equal(restored, markerBody, 'archived workspace files did not survive resubscription')
    pass(11)
    await page.screenshot({
      path: path.join(evidence.directory, '11-resubscribed.png'),
      fullPage: true,
    })
  } finally {
    await context.close()
  }

  await evidence.writeJson('overview-snapshots.json', snapshots)
  await evidence.writeJson('subscription-timeline.json', {
    runId,
    legs: Object.fromEntries(
      [...SUBSCRIPTION_LIFECYCLE_LEGS, STORAGE_TIER_RESIZE_LEG].map(name => [
        name,
        output.legs[name],
      ]),
    ),
  })
}

export function lifecycleAddress(inbox: string, runId: string): string {
  return taggedInboxAddress(inbox, `${runId}-subscription`)
}

export function assertIsolatedLifecycleTrial(
  overview: Pick<
    UserBillingOverview,
    'trial' | 'paidCreditBalanceMicroUsd' | 'monthlyCreditBalanceMicroUsd' | 'subscription'
  >,
): void {
  assert.equal(overview.trial.status, 'available')
  assert.equal(
    overview.paidCreditBalanceMicroUsd,
    DEFAULT_TRIAL_GRANT_MICRO_USD,
    'lifecycle account did not receive exactly the real trial grant',
  )
  assert.equal(overview.monthlyCreditBalanceMicroUsd, 0)
  assert.equal(overview.subscription, null)
}

function withinReconciliationDrift(value: number, allotment: number): boolean {
  // Several late reconciliation settlements (each up to a full generation's
  // ~50k microUSD) can land between grant and read; a dollar of drift still
  // proves the allotment arrived while a missing grant (20M+) cannot hide.
  return value <= allotment && value > allotment - 1_000_000
}
async function createGeneration(env: LiveEnv, token: string, slug: string, prompt: string) {
  // One POST only: a 201 creates a durable session even when dispatched is
  // false (a fresh VM can miss the immediate window), and the runner input
  // rail drains the queued prompt on the next sync pass. Retrying the POST
  // would mint extra charged sessions and contaminate ledger assertions —
  // callers detect delivery through their balance polls.
  return await apiJson<{ session: { sessionId: string }; dispatched: boolean }>(
    `${env.apiUrl}/v1/ws/${slug}/agent/sessions`,
    { method: 'POST', headers: bearerJson(token), body: JSON.stringify({ prompt }) },
    201,
    'subscription charged generation',
  )
}
async function overview(page: Page) {
  const result = await page.evaluate(async () => {
    const response = await fetch('/api/duet/user/billing')
    return { status: response.status, body: await response.json() }
  })
  if (result.status !== 200) {
    throw new Error(`subscription billing overview expected HTTP 200, got ${result.status}`)
  }
  return UserBillingOverviewSchema.parse(result.body)
}
async function pollOverview(
  page: Page,
  accept: (value: UserBillingOverview) => boolean,
  timeoutMs = POLL_TIMEOUT_MS,
) {
  return await poll(
    async () => {
      const value = await overview(page)
      return accept(value) ? value : undefined
    },
    timeoutMs,
    'billing overview projection',
  )
}
async function pollPublicWorkspace(
  env: LiveEnv,
  token: string,
  workspaceId: string,
  accept: (workspace: { id: string; status: string; servicingStatus: string }) => boolean,
  timeoutMs = POLL_TIMEOUT_MS,
) {
  return await poll(
    async () => {
      const identity = await apiJson<{
        workspaces: Array<{ id: string; status: string; servicingStatus: string }>
      }>(`${env.apiUrl}/v1/whoami`, { headers: bearer(token) }, 200, 'subscription whoami poll')
      const workspace = identity.workspaces.find(row => row.id === workspaceId)
      return workspace !== undefined && accept(workspace) ? workspace : undefined
    },
    timeoutMs,
    'public workspace lifecycle projection',
  )
}
async function postPlan(page: Page, workspaceSlug: string, change: object) {
  const result = await page.evaluate(
    async ({ workspaceSlug, change }) => {
      const response = await fetch('/api/duet/user/billing/subscription/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceSlug, ...change }),
      })
      return { status: response.status, body: await response.text() }
    },
    { workspaceSlug, change },
  )
  assert.equal(result.status, 200, result.body)
}
async function poll<T>(
  read: () => Promise<T | undefined>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error(`Timed out polling ${label}`)
    await Bun.sleep(500)
  }
}

type StripeTestEnv = Pick<LiveEnv, 'stripeSecretKey'>

export async function stripeGet<T>(env: StripeTestEnv, pathname: string): Promise<T> {
  const value = await stripeGetOrUndefined<T>(env, pathname)
  if (value === undefined) throw new Error(`Stripe GET ${pathname} returned HTTP 404`)
  return value
}
async function stripeGetOrUndefined<T>(
  env: StripeTestEnv,
  pathname: string,
): Promise<T | undefined> {
  const response = await stagingFetch(`https://api.stripe.com${pathname}`, {
    headers: { authorization: `Bearer ${env.stripeSecretKey}` },
  })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`Stripe GET ${pathname} returned HTTP ${response.status}`)
  return (await response.json()) as T
}
export async function stripeForm<T>(
  env: StripeTestEnv,
  pathname: string,
  fields: Record<string, string | number>,
): Promise<T> {
  const response = await stagingFetch(`https://api.stripe.com${pathname}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.stripeSecretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(Object.entries(fields).map(([key, value]) => [key, String(value)])),
  })
  if (!response.ok)
    throw new Error(
      `Stripe POST ${pathname} returned HTTP ${response.status}: ${await response.text()}`,
    )
  return (await response.json()) as T
}
export async function stripeDelete(env: StripeTestEnv, pathname: string): Promise<void> {
  const response = await stagingFetch(`https://api.stripe.com${pathname}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${env.stripeSecretKey}` },
  })
  if (!response.ok && response.status !== 404)
    throw new Error(`Stripe DELETE ${pathname} returned HTTP ${response.status}`)
}
async function stripeCustomerDeleted(env: StripeTestEnv, customerId: string): Promise<boolean> {
  const customer = await stripeGetOrUndefined<{ deleted?: boolean }>(
    env,
    `/v1/customers/${customerId}`,
  )
  return customer === undefined || customer.deleted === true
}

async function onlyCheckoutSession(env: LiveEnv, customer: string, mode: string) {
  const list = await stripeGet<{ data: Array<{ id: string; status: string; mode: string }> }>(
    env,
    `/v1/checkout/sessions?customer=${encodeURIComponent(customer)}&limit=10`,
  )
  const matches = list.data.filter(row => row.status === 'open' && row.mode === mode)
  assert.equal(matches.length, 1, 'expected exactly one open subscription Checkout session')
  return matches[0]!
}
async function newestPaidInvoice(env: LiveEnv, customer: string, billingReason: string) {
  return await poll(
    async () => await newestPaidInvoiceOrUndefined(env, customer, billingReason),
    POLL_TIMEOUT_MS,
    `${billingReason} invoice`,
  )
}
async function newestPaidInvoiceExcluding(
  env: LiveEnv,
  customer: string,
  billingReason: string,
  excludedIds: ReadonlySet<string>,
) {
  return await poll(
    async () => {
      const invoice = await newestPaidInvoiceOrUndefined(env, customer, billingReason, excludedIds)
      return invoice
    },
    POLL_TIMEOUT_MS,
    `new ${billingReason} invoice`,
  )
}
async function newestPaidInvoiceOrUndefined(
  env: LiveEnv,
  customer: string,
  billingReason: string,
  excludedIds: ReadonlySet<string> = new Set(),
) {
  const list = await stripeGet<{
    data: Array<{ id: string; status: string; billing_reason: string }>
  }>(env, `/v1/invoices?customer=${encodeURIComponent(customer)}&limit=100`)
  return list.data.find(
    row =>
      row.status === 'paid' && row.billing_reason === billingReason && !excludedIds.has(row.id),
  )
}
async function invoicePaidEvent(env: LiveEnv, invoiceId: string) {
  const list = await stripeGet<{ data: StripeInvoicePaidEvent[] }>(
    env,
    '/v1/events?type=invoice.paid&limit=100',
  )
  const event = list.data.find(row => row.data.object.id === invoiceId)
  assert(event !== undefined, `invoice.paid event for ${invoiceId} not found`)
  return event
}
async function replaySignedWebhook(env: LiveEnv, event: unknown) {
  const body = JSON.stringify(event)
  const timestamp = Math.floor(Date.now() / 1_000)
  const signature = new Bun.CryptoHasher('sha256', env.stripeWebhookSecret)
    .update(`${timestamp}.${body}`)
    .digest('hex')
  const response = await stagingFetch(`${env.convexSiteUrl}/v1/stripe/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': `t=${timestamp},v1=${signature}`,
    },
    body,
  })
  assert.equal(response.status, 200, await response.text())
}
async function accountTransactions(convex: ConvexHttpClient, env: LiveEnv, userId: string) {
  return (await convex.query(fnQuery('testing/credits:listAccountTransactionsForTest'), {
    internalKey: env.internalKey,
    userId,
  })) as Array<{
    _id: string
    type: string
    reference: string
    amountMicroUsd: number
    monthlyAmountMicroUsd?: number
    paidAmountMicroUsd?: number
  }>
}
async function assertGrantEvidence(
  convex: ConvexHttpClient,
  env: LiveEnv,
  userId: string,
  invoiceId: string,
  expectedInvoiceCount: number,
  expectedTotalCount = expectedInvoiceCount,
) {
  const rows = await accountTransactions(convex, env, userId)
  assert.equal(
    rows.filter(row => row.type === 'subscription_grant').length,
    expectedTotalCount,
    'unexpected subscription grant outside invoice.paid',
  )
  assert.equal(
    rows.filter(
      row =>
        row.type === 'subscription_grant' &&
        row.reference === `subscription_grant:invoice:${invoiceId}`,
    ).length,
    expectedInvoiceCount,
  )
  assert.equal(rows.filter(row => row.type === 'subscription_expiry').length, expectedTotalCount)
}
function recordStripeClock(ledger: StagingResourceLedger, env: LiveEnv, runId: string, id: string) {
  ledger.record({
    kind: 'stripe-test-clock',
    id,
    label: `${runId}:stripe-test-clock:${id}`,
    cleanupPriority: -40,
    cleanup: async () => await stripeDelete(env, `/v1/test_helpers/test_clocks/${id}`),
    verify: async () =>
      (await stripeGetOrUndefined(env, `/v1/test_helpers/test_clocks/${id}`)) === undefined,
  })
}
export function recordStripeCustomer(
  ledger: StagingResourceLedger,
  env: StripeTestEnv,
  runId: string,
  id: string,
) {
  ledger.record({
    kind: 'stripe-customer',
    id,
    label: `${runId}:stripe-customer:${id}`,
    cleanupPriority: -30,
    cleanup: async () => await stripeDelete(env, `/v1/customers/${id}`),
    verify: async () => await stripeCustomerDeleted(env, id),
  })
}
export function recordSubscription(
  ledger: StagingResourceLedger,
  env: StripeTestEnv,
  runId: string,
  id: string,
) {
  ledger.record({
    kind: 'stripe-subscription',
    id,
    label: `${runId}:stripe-subscription:${id}`,
    cleanupPriority: 40,
    cleanup: async () => {
      const row = await stripeGetOrUndefined<{ status: string }>(env, `/v1/subscriptions/${id}`)
      if (row === undefined) return
      if (row.status !== 'canceled') await stripeDelete(env, `/v1/subscriptions/${id}`)
    },
    verify: async () => {
      const row = await stripeGetOrUndefined<{ status: string }>(env, `/v1/subscriptions/${id}`)
      return row === undefined || row.status === 'canceled'
    },
  })
}
function recordSchedule(ledger: StagingResourceLedger, env: LiveEnv, runId: string, id: string) {
  ledger.record({
    kind: 'stripe-subscription-schedule',
    id,
    label: `${runId}:stripe-subscription-schedule:${id}`,
    cleanupPriority: 50,
    cleanup: async () => {
      const row = await stripeGetOrUndefined<{ status: string }>(
        env,
        `/v1/subscription_schedules/${id}`,
      )
      if (row === undefined) return
      if (!['released', 'canceled', 'completed'].includes(row.status))
        await stripeForm(env, `/v1/subscription_schedules/${id}/release`, {})
    },
    verify: async () => {
      const row = await stripeGetOrUndefined<{ status: string }>(
        env,
        `/v1/subscription_schedules/${id}`,
      )
      return row === undefined || ['released', 'canceled', 'completed'].includes(row.status)
    },
  })
}
function recordInvoice(ledger: StagingResourceLedger, env: LiveEnv, runId: string, id: string) {
  ledger.record({
    kind: 'stripe-invoice',
    id,
    label: `${runId}:stripe-invoice:${id}`,
    cleanupPriority: 20,
    cleanup: async () => undefined,
    // Paid invoices are immutable records that SURVIVE test-clock deletion
    // (observed live); a settled or voided invoice is a clean remnant, not
    // an orphan — only an open/collectible invoice would be a leak.
    verify: async () => {
      const row = await stripeGetOrUndefined<{ status?: string }>(env, `/v1/invoices/${id}`)
      return row === undefined || ['paid', 'void', 'uncollectible'].includes(row.status ?? '')
    },
  })
}
function recordPortalSession(
  ledger: StagingResourceLedger,
  env: LiveEnv,
  runId: string,
  id: string,
  customerId: string,
) {
  ledger.record({
    kind: 'stripe-portal-session',
    id,
    label: `${runId}:stripe-portal-session:${id}`,
    cleanupPriority: 10,
    cleanup: async () => undefined,
    verify: async () => await stripeCustomerDeleted(env, customerId),
  })
}
export function recordCheckoutSession(
  ledger: StagingResourceLedger,
  env: StripeTestEnv,
  runId: string,
  id: string,
) {
  ledger.record({
    kind: 'stripe-session',
    id,
    label: `${runId}:stripe-session:${id}`,
    cleanupPriority: 30,
    cleanup: async () => {
      const row = await stripeGet<{ status: string }>(env, `/v1/checkout/sessions/${id}`)
      if (row.status === 'open') await stripeForm(env, `/v1/checkout/sessions/${id}/expire`, {})
    },
    verify: async () =>
      ['complete', 'expired'].includes(
        (await stripeGet<{ status: string }>(env, `/v1/checkout/sessions/${id}`)).status,
      ),
  })
}
