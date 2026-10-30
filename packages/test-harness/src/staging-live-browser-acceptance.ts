import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import path from 'node:path'

import { type Browser, type Page } from '@playwright/test'
import { ConvexHttpClient } from 'convex/browser'

import {
  FileListResponseSchema,
  ROOT_AGENT_SCOPE,
  TrainRecordListResponseSchema,
  TrainStartResponseSchema,
  WhoamiResponseSchema,
  type Agent,
  type App,
  type TrainRecordSummary,
} from '@repo/contract'

import { BUSINESS_QUESTION } from './demo-60s.ts'
import { runFreshWorkspaceAppsInFilesBrowserAcceptance } from './staging-live-apps-files.ts'
import { StagingArtifactCollector } from './staging-live-artifacts.ts'
import { runStripeBillingAcceptance } from './staging-live-billing.ts'
import {
  assertBrowserResponseFinished,
  waitForBrowserApiResponse,
  waitForFinishedBrowserResponse,
} from './staging-live-browser-response.ts'
import {
  attachBrowserDiagnostics,
  installStagingProtection,
  markExpectedBrowserTransition,
  markExpectedViewportChange,
  navigateDeployedPage,
  runProductRouteAcceptance,
} from './staging-live-browser.ts'
import { runDeviceApproval } from './staging-live-device.ts'
import { APPS_IN_FILE_VIEW_LEG, type LiveEnv, type Workspace } from './staging-live-env.ts'
import { runFirecrawlIntegrationAcceptance } from './staging-live-firecrawl.ts'
import { apiJson, assertApiCredentialRevoked, bearer, stagingFetch } from './staging-live-http.ts'
import { runInviteAndPayerAcceptance } from './staging-live-invite.ts'
import {
  currentBrowserSessionCredential,
  logoutAndAssertCurrentBrowserSessionRevoked,
} from './staging-live-invite.ts'
import {
  deleteAgentMailMessage,
  isAgentMailMessageDeleted,
  waitForMailboxLink,
} from './staging-live-mailbox.ts'
import { runLanguageContinuityAcceptance } from './staging-live-public-site.ts'
import {
  assertPostHogJourney,
  waitForHydratedMagicLinkControls,
  waitForLocaleCookie,
  waitForPostHogState,
} from './staging-live-public-site.ts'
import {
  recordWorkspaceCleanup,
  StagingResourceLedger,
  workspaceIsDeleted,
} from './staging-live-resource-ledger.ts'
import { waitForTrain } from './staging-live-streaming.ts'
import { runStagingSubscriptionLifecycle } from './staging-live-subscriptions.ts'
import { findInheritedRecord, findNewOwnedRecord } from './staging-live-train.ts'
import type { TimelineOutput } from './staging-live.ts'

const BROWSER_TRANSITION_TIMEOUT_MS = 60_000
export async function runBrowserAcceptance(args: {
  env: LiveEnv
  browser: Browser
  email: string
  userId: string
  runId: string
  startedAt: number
  workspace: Workspace
  apiToken: string
  artifacts: StagingArtifactCollector
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
  output: TimelineOutput
  sessionId: string
  trainJobId: string
  trainAgent: Pick<Agent, 'id' | 'slug' | 'name' | 'anchorPath'>
  rootTrainRecord: TrainRecordSummary
  artifactPath: string
  appSlug: string
  freshWorkspaceApp: App
  manualSessionTitle: string
  secondWorkspace: { id: string; slug: string }
  progress: (stage: string) => void
  onBrowserSessionReady?: (browserCredential: string, ownerPage: Page) => Promise<void>
  inviteIdentities: {
    firstTime: string
    existing: string
    expired: string
    revoked: string
    existingName: string
  }
}): Promise<void> {
  const {
    env,
    browser,
    email,
    userId,
    runId,
    startedAt,
    workspace,
    apiToken,
    artifacts,
    ledger,
    convex,
    output,
    sessionId,
    trainJobId,
    trainAgent,
    rootTrainRecord,
    artifactPath,
    appSlug,
    freshWorkspaceApp,
    manualSessionTitle,
    secondWorkspace,
    progress,
    onBrowserSessionReady,
    inviteIdentities,
  } = args
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: {
      dir: path.join(artifacts.directory, 'video'),
      size: { width: 1440, height: 900 },
    },
  })
  await installStagingProtection(context, env)
  await context.addCookies([
    {
      name: '__Host-__convexAuthOAuthVerifier',
      value: 'stale-google-oauth-verifier',
      url: env.appUrl,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ])

  // The subscription lifecycle is the feature under test — it runs first
  // and never queues behind the share/apps journeys.
  progress('browser:subscription-lifecycle')
  await runStagingSubscriptionLifecycle({
    env,
    runId,
    ledger,
    convex,
    output,
    progress,
    openAuthenticatedPage: async ({ email: lifecycleEmail, workspace: lifecycleWorkspace }) => {
      const lifecycleContext = await browser.newContext({
        viewport: { width: 1440, height: 900 },
      })
      await installStagingProtection(lifecycleContext, env)
      attachBrowserDiagnostics(lifecycleContext, artifacts)
      const lifecyclePage = await lifecycleContext.newPage()
      try {
        const returnTo = `/w/${lifecycleWorkspace.slug}/agents`
        await navigateDeployedPage(
          lifecyclePage,
          `${env.appUrl}/sign-in?returnTo=${encodeURIComponent(returnTo)}`,
        )
        const controls = await waitForHydratedMagicLinkControls(lifecyclePage)
        await controls.email.fill(lifecycleEmail)
        const requestedAt = Date.now()
        const [intent] = await Promise.all([
          lifecyclePage.waitForResponse(
            response =>
              response.request().method() === 'POST' &&
              new URL(response.url()).pathname === '/api/auth/magic-link',
          ),
          controls.submit.click({ noWaitAfter: true }),
        ])
        assert.equal(intent.status(), 204, 'lifecycle magic-link intent failed')
        const link = await waitForBrowserMagicLink({
          env,
          page: lifecyclePage,
          ledger,
          email: lifecycleEmail,
          requestedAt,
          runId,
          returnTo,
        })
        await navigateDeployedPage(lifecyclePage, link)
        await lifecyclePage.waitForURL(url => url.pathname === returnTo, { timeout: 120_000 })
        return { context: lifecycleContext, page: lifecyclePage }
      } catch (error) {
        await lifecycleContext.close()
        throw error
      }
    },
  })

  await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
  attachBrowserDiagnostics(context, artifacts, {
    responses: [
      {
        method: 'GET',
        origin: 'https://apay-us.amazon.com',
        pathname: '/amazonpayMerchantId',
        status: 500,
        remaining: 1,
      },
    ],
    aborts: [
      {
        method: 'POST',
        origin: 'https://bzr.openai.com',
        pathname: '/v1/sdk/events',
        status: 202,
        remaining: 2,
      },
      {
        method: 'POST',
        origin: new URL(env.appUrl).origin,
        pathname: '/sign-out',
        status: 200,
        remaining: 1,
      },
    ],
  })
  const page = await context.newPage()
  let accepted = false
  try {
    progress('browser:anonymous-handoff')
    markExpectedBrowserTransition(page)
    await navigateDeployedPage(page, env.landerUrl)
    progress('browser:anonymous-handoff:lander-loaded')
    // The locale link is present in static HTML, but its cookie-writing click
    // handler exists only after hydration. Clicking earlier changes the URL
    // without persisting the sibling-domain preference the journey must prove.
    await page.waitForFunction(
      () => {
        const link = document.querySelector<HTMLElement>('[aria-label="Language"] a[href="/es"]')
        return typeof link?.onclick === 'function'
      },
      undefined,
      { timeout: BROWSER_TRANSITION_TIMEOUT_MS },
    )
    progress('browser:anonymous-handoff:locale-hydrated')
    markExpectedBrowserTransition(page)
    await page.locator('[aria-label="Language"] a[href="/es"]').click()
    await page.waitForURL(url => url.origin === env.landerUrl && url.pathname === '/es', {
      timeout: BROWSER_TRANSITION_TIMEOUT_MS,
    })
    progress('browser:anonymous-handoff:locale-navigated')
    await waitForLocaleCookie(context, env.appUrl, 'es-419')
    progress('browser:anonymous-handoff:locale-cookie')
    const landerAnonymous = await waitForPostHogState(context, env.landerUrl)
    progress('browser:anonymous-handoff:lander-posthog')
    const productNavigation = page.waitForURL(
      url => url.origin === env.appUrl && url.pathname === '/sign-in',
      { timeout: BROWSER_TRANSITION_TIMEOUT_MS },
    )
    markExpectedBrowserTransition(page)
    await page.getByRole('link', { name: 'Iniciar sesión', exact: true }).first().click()
    await productNavigation
    progress('browser:anonymous-handoff:product-loaded')
    const productAnonymous = await waitForPostHogState(context, env.appUrl)
    progress('browser:anonymous-handoff:product-posthog')

    markExpectedBrowserTransition(page)
    await navigateDeployedPage(
      page,
      `${env.appUrl}/sign-in?returnTo=${encodeURIComponent(`/w/${workspace.slug}/agents`)}`,
    )
    const ownerMagicLink = await waitForHydratedMagicLinkControls(page)
    progress('browser:owner-form-hydrated')
    await ownerMagicLink.email.fill(email)
    assert.equal(
      await ownerMagicLink.email.inputValue(),
      email,
      'owner email did not remain filled',
    )
    progress('browser:owner-email-filled')
    const requestedAt = Math.max(startedAt, Date.now())
    const [magicLinkIntent] = await Promise.all([
      page.waitForResponse(
        response =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/auth/magic-link',
        { timeout: BROWSER_TRANSITION_TIMEOUT_MS },
      ),
      ownerMagicLink.submit.click({ noWaitAfter: true, timeout: BROWSER_TRANSITION_TIMEOUT_MS }),
    ])
    progress('browser:owner-email-submitted')
    assert.equal(magicLinkIntent.status(), 204, 'magic-link intent request did not complete')
    await assertBrowserResponseFinished(magicLinkIntent, 'magic-link intent')
    assert(
      !(await context.cookies(env.appUrl)).some(cookie =>
        cookie.name.endsWith('__convexAuthOAuthVerifier'),
      ),
      'magic-link intent did not clear stale Google OAuth state',
    )
    progress('browser:owner-magic-link')
    const link = await waitForBrowserMagicLink({
      env,
      page,
      ledger,
      email,
      requestedAt,
      runId,
      returnTo: `/w/${workspace.slug}/agents`,
    })
    await assertDirectMagicLinkRejected(browser, env, link)
    markExpectedBrowserTransition(page)
    await navigateDeployedPage(page, link)
    await page.waitForURL(url => url.pathname === `/w/${workspace.slug}/agents`, {
      timeout: 120_000,
    })
    const productAuthenticated = await waitForPostHogState(
      context,
      env.appUrl,
      state => state.distinctId === userId,
    )

    const browserCookies = await context.cookies(env.appUrl)
    const sessionCookie = browserCookies.find(cookie => cookie.name === 'duet_session')
    assert(sessionCookie?.httpOnly, 'browser session cookie was not HttpOnly')
    assert(sessionCookie.secure, 'browser session cookie was not Secure')
    assert.equal(sessionCookie.sameSite, 'Lax', 'browser session cookie was not SameSite=Lax')
    // Playwright reports a session cookie's expiry as -1: an identity that
    // ends when the browser quits sends every daily user back through sign-in.
    const refreshCookie = browserCookies.find(cookie =>
      cookie.name.endsWith('__convexAuthRefreshToken'),
    )
    assert(refreshCookie !== undefined, 'sign-in left no identity refresh cookie')
    assert(
      refreshCookie.expires > Date.now() / 1000,
      'identity refresh cookie does not survive the browser closing',
    )
    const browserVisible = await page.evaluate(() => ({
      cookie: document.cookie,
      local: Object.values(localStorage),
      session: Object.values(sessionStorage),
      html: document.documentElement.innerHTML,
    }))
    const serializedVisible = JSON.stringify(browserVisible)
    assert(
      !serializedVisible.includes(apiToken),
      'programmatic API key was visible to browser JavaScript',
    )
    assert(
      !browserVisible.cookie.includes('duet_session='),
      'HttpOnly session appeared in document.cookie',
    )
    const browserCredential = currentBrowserSessionCredential(browserCookies)
    assert(
      !serializedVisible.includes(browserCredential),
      'browser API key was visible to JavaScript',
    )
    /* Before any leg that reads copy, because this is the leg that decides which
       language that copy is in. The anonymous handoff above signed in through
       `Iniciar sesión`, which is the point of it — a locale chosen on the lander
       survives onto the app — and it leaves the whole app in `es-419`. This leg
       proves the round trip and ends by putting English back.

       It used to run after the three legs that assert English strings, so they
       ran inside the Spanish window and could not match: `Connect` against a
       button rendered `Conectar` waited out its full minute, and the leg after
       it never started. Nothing between the handoff and here reads localized
       copy, and this leg sets its own Spanish rather than inheriting it, so
       proving it early costs nothing. */
    progress('browser:language-continuity')
    await runLanguageContinuityAcceptance(page, context, env)
    output.legs['language-continuity'] = { status: 'pass' }

    /* Ahead of the callback, because everything in it is an independent
       acceptance and this leg is required. It ran last, so a provider that
       would not connect, a share panel that never drew, and a Spanish button
       each took their turn starving the one leg that proves a deleted folder
       reaps its app — six runs without it once being at fault. It works in
       `welcome/`, the callback's legs work in `agents/` and a folder of their
       own, and none of them read its evidence. */
    progress('browser:apps-in-file-view')
    output.appsInFileView = await runFreshWorkspaceAppsInFilesBrowserAcceptance({
      env,
      page,
      workspace,
      apiToken,
      runId,
      initialApp: freshWorkspaceApp,
      artifacts,
      ledger,
      convex,
    })
    output.legs[APPS_IN_FILE_VIEW_LEG] = { status: 'pass' }

    await onBrowserSessionReady?.(browserCredential, page)

    const billingStatus = await page.evaluate(async () => {
      const response = await fetch('/api/duet/user/billing')
      return response.status
    })
    assert.equal(billingStatus, 200, 'browser-session billing overview failed')

    progress('browser:device-approval')
    await runDeviceApproval({
      env,
      page,
      workspace,
      email,
      runId,
      ledger,
      convex,
      artifacts,
    })
    progress('browser:stripe-billing')
    await runStripeBillingAcceptance({
      env,
      page,
      email,
      runId,
      ledger,
    })
    if (env.composioApiKey !== undefined && env.firecrawlApiKey !== undefined) {
      progress('browser:firecrawl-integration')
      await runFirecrawlIntegrationAcceptance({
        env,
        browser,
        ownerPage: page,
        workspace,
        apiToken,
        runId,
        ledger,
        artifacts,
      })
      output.legs['firecrawl-integration'] = { status: 'pass' }
    } else {
      output.legs['firecrawl-integration'] = {
        status: 'skipped',
        reason: 'COMPOSIO_API_KEY and FIRECRAWL_API_KEY are required',
      }
    }
    progress('browser:invite-and-payer-matrix')
    await runInviteAndPayerAcceptance({
      env,
      browser,
      ownerPage: page,
      ownerToken: apiToken,
      ownerEmail: email,
      runId,
      workspace,
      ledger,
      convex,
      output,
      artifacts,
      identities: inviteIdentities,
    })
    output.legs['invite-auth-matrix'] = { status: 'pass' }

    progress('browser:product-ui')
    await exerciseProductUi({
      env,
      page,
      workspace,
      runId,
      apiToken,
      ledger,
      convex,
      output,
      sessionId,
      trainJobId,
      trainAgent,
      rootTrainRecord,
      artifactPath,
      appSlug,
      manualSessionTitle,
      secondWorkspace,
    })
    progress('browser:product-routes')
    await runProductRouteAcceptance({
      env,
      page,
      workspaceSlug: workspace.slug,
      sessionId,
      artifacts,
    })
    output.legs['product-routes'] = { status: 'pass' }
    markExpectedBrowserTransition(page)
    // The drive's own jobs dialog is where every root session is listed now;
    // the route contract is that the session's row renders — presence in the
    // DOM is the assertion.
    await navigateDeployedPage(page, `${env.appUrl}/w/${workspace.slug}/agents/root/sessions`)
    await page.getByText(manualSessionTitle, { exact: true }).first().waitFor({ state: 'attached' })
    await page.screenshot({
      path: path.join(artifacts.directory, 'spa-desktop.png'),
      fullPage: true,
    })

    const mobile = await context.newPage()
    markExpectedViewportChange(mobile)
    await mobile.setViewportSize({ width: 390, height: 844 })
    await navigateDeployedPage(mobile, `${env.appUrl}/w/${workspace.slug}/agents/root/sessions`)
    await mobile
      .getByText(manualSessionTitle, { exact: true })
      .first()
      .waitFor({ state: 'attached' })
    await mobile.screenshot({
      path: path.join(artifacts.directory, 'spa-mobile.png'),
      fullPage: true,
    })
    markExpectedBrowserTransition(mobile)
    await mobile.close()

    progress('browser:logout-and-analytics-reset')
    const productReset = await logoutAndAssertCurrentBrowserSessionRevoked({
      getCookies: async () => await context.cookies(env.appUrl),
      logout: async () => {
        const logoutResponse = page.waitForResponse(
          response =>
            response.request().method() === 'DELETE' &&
            new URL(response.url()).pathname === '/api/duet/session',
        )
        markExpectedBrowserTransition(page)
        await navigateDeployedPage(page, `${env.appUrl}/sign-out`)
        // Full 'load' is hostage to third-party assets (PostHog CDN); the
        // navigation itself is the signal.
        await page.waitForURL(url => url.pathname === '/sign-in', {
          timeout: 60_000,
          waitUntil: 'domcontentloaded',
        })
        const logout = await logoutResponse
        assert(logout.ok(), `browser logout returned HTTP ${logout.status()}`)
        await assertBrowserResponseFinished(logout, 'browser logout')
        const reset = await waitForPostHogState(
          context,
          env.appUrl,
          state => state.distinctId !== userId && state.userState === 'anonymous',
        )
        assert(
          !(await context.cookies(env.appUrl)).some(cookie => cookie.name === 'duet_session'),
          'logout left the browser session cookie behind',
        )
        return reset
      },
      assertRevoked: async credential => await assertApiCredentialRevoked(env.apiUrl, credential),
    })
    markExpectedBrowserTransition(page)
    await navigateDeployedPage(page, env.landerUrl)
    const landerReturned = await waitForPostHogState(context, env.landerUrl)
    assertPostHogJourney({
      landerAnonymous,
      productAnonymous,
      productAuthenticated,
      productReset,
      landerReturned,
      userId,
    })
    output.legs['analytics-journey'] = { status: 'pass' }
    accepted = true
  } finally {
    const tracePath = path.join(artifacts.directory, 'browser-trace.zip')
    const rawTracePath = `${tracePath}.raw-${process.pid}`
    try {
      await artifacts.reservePrivateFile(rawTracePath)
      await context.tracing.stop({ path: rawTracePath })
      await artifacts.sanitizeTraceArchive(rawTracePath, tracePath)
    } finally {
      await rm(rawTracePath, { force: true }).catch(() => undefined)
      if (accepted) {
        for (const openPage of context.pages()) markExpectedBrowserTransition(openPage)
      }
      await context.close()
    }
  }
}

async function assertDirectMagicLinkRejected(
  browser: Browser,
  env: LiveEnv,
  deliveredLink: string,
): Promise<void> {
  const delivered = new URL(deliveredLink)
  const code = delivered.searchParams.get('code')
  assert(code !== null, 'delivered magic link omitted its one-time code')
  const direct = new URL('/sign-in', env.appUrl)
  direct.searchParams.set('code', code)
  direct.searchParams.set('returnTo', '/')

  const context = await browser.newContext()
  await installStagingProtection(context, env)
  const page = await context.newPage()
  try {
    await navigateDeployedPage(page, direct.toString())
    const rejected = new URL(page.url())
    assert.equal(rejected.pathname, '/sign-in', 'unproven magic code left the sign-in route')
    assert.equal(
      rejected.searchParams.get('authError'),
      'invalid-link',
      'unproven magic code was not rejected',
    )
    assert(
      !(await context.cookies(env.appUrl)).some(cookie => cookie.name.endsWith('__convexAuthJWT')),
      'unproven magic code created an auth session',
    )
  } finally {
    await context.close()
  }
}

async function exerciseProductUi(args: {
  env: LiveEnv
  page: Page
  workspace: Workspace
  runId: string
  apiToken: string
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
  output: TimelineOutput
  sessionId: string
  trainJobId: string
  trainAgent: Pick<Agent, 'id' | 'slug' | 'name' | 'anchorPath'>
  rootTrainRecord: TrainRecordSummary
  artifactPath: string
  appSlug: string
  manualSessionTitle: string
  secondWorkspace: { id: string; slug: string }
}): Promise<void> {
  const {
    env,
    page,
    workspace,
    runId,
    apiToken,
    ledger,
    convex,
    output,
    sessionId,
    trainJobId,
    trainAgent,
    rootTrainRecord,
    artifactPath,
    appSlug,
    manualSessionTitle,
    secondWorkspace,
  } = args
  const workspaceRoot = `${env.appUrl}/w/${workspace.slug}`

  markExpectedBrowserTransition(page)
  /* The session's one address: its jobs dialog on the owning agent (root — the
     harness creates it with no cwd). The map keeps a second session pane
     mounted behind the dialog, so timeline reads scope to the dialog. */
  await navigateDeployedPage(page, `${workspaceRoot}/agents/root/sessions/${sessionId}`)
  const jobsDialog = page.getByRole('dialog')
  await jobsDialog.getByRole('log', { name: 'Session timeline' }).waitFor()
  await jobsDialog.getByText(BUSINESS_QUESTION, { exact: false }).first().waitFor()
  const uiTitle = `${runId} browser title`
  await page.getByRole('button', { name: manualSessionTitle, exact: true }).click()
  const titleInput = page.getByRole('textbox', { name: 'Session title' })
  await titleInput.fill(uiTitle)
  await Promise.all([
    waitForBrowserApiResponse(
      page,
      'PATCH',
      `/api/duet/ws/${workspace.slug}/agent/sessions/${sessionId}`,
    ),
    titleInput.press('Enter'),
  ])
  await page.getByRole('button', { name: uiTitle, exact: true }).click()
  await titleInput.fill(manualSessionTitle)
  await Promise.all([
    waitForBrowserApiResponse(
      page,
      'PATCH',
      `/api/duet/ws/${workspace.slug}/agent/sessions/${sessionId}`,
    ),
    titleInput.press('Enter'),
  ])

  markExpectedBrowserTransition(page)
  /* An app is framed on the card of the agent whose folder encloses it, and this
     one is anchored at `apps/<runId>` with no agent around it — so it is the
     drive's own agent's. Everything that can be done to it is behind the ⋯ on
     the chip that names it. */
  await navigateDeployedPage(page, `${workspaceRoot}/agents/${ROOT_AGENT_SCOPE}/apps/${appSlug}`)
  await page.frameLocator(`iframe[title="${appSlug}"]`).locator('body').waitFor()
  const appMenu = async () => {
    await page.getByRole('button', { name: 'App options', exact: true }).click()
    await page.getByRole('menu').waitFor()
  }
  await appMenu()
  await Promise.all([
    waitForBrowserApiResponse(
      page,
      'POST',
      `/api/duet/ws/${workspace.slug}/apps/${appSlug}/visibility`,
    ),
    page.getByRole('menuitem', { name: 'Publish', exact: true }).click(),
  ])
  await appMenu()
  await page.getByRole('menuitem', { name: 'Copy public link', exact: true }).waitFor()
  await Promise.all([
    waitForBrowserApiResponse(
      page,
      'POST',
      `/api/duet/ws/${workspace.slug}/apps/${appSlug}/visibility`,
    ),
    page.getByRole('menuitem', { name: 'Make private', exact: true }).click(),
  ])
  await appMenu()
  await page.getByRole('menuitem', { name: 'Publish', exact: true }).waitFor()
  await page.keyboard.press('Escape')

  const rootFilesResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return (
      response.request().method() === 'GET' &&
      url.pathname === `/api/duet/ws/${workspace.slug}/files` &&
      url.searchParams.get('list') === '1'
    )
  })
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${workspaceRoot}/files`)
  await page.locator('[data-files-surface]').waitFor()
  const listed = await rootFilesResponse
  assert(listed.ok(), `browser root file listing returned HTTP ${listed.status()}`)
  const rootFiles = FileListResponseSchema.parse(await listed.json())
  assert(
    rootFiles.items.some(entry => entry.name === 'reports' && entry.type === 'directory'),
    `browser root file listing omitted reports: ${rootFiles.items.map(entry => entry.name).join(', ')}`,
  )
  await page.getByRole('button', { name: 'reports', exact: true }).click()
  const artifactName = artifactPath.split('/').at(-1)!
  await page.getByRole('button', { name: artifactName, exact: true }).click()
  await page.getByRole('heading', { name: artifactName, exact: true }).first().waitFor()
  // The preview opens as a modal whose backdrop swallows row clicks.
  await page.keyboard.press('Escape')
  await page
    .locator('div[data-aria-hidden="true"][data-state="open"]')
    .first()
    .waitFor({ state: 'detached' })
    .catch(() => undefined)
  await page.waitForURL(
    url => url.pathname === `/w/${encodeURIComponent(workspace.slug)}/files/reports`,
  )
  const copiedName = `${runId}-browser-copy.md`
  const copiedPath = `reports/${copiedName}`
  ledger.record({
    kind: 'file',
    id: copiedPath,
    label: `${runId}:file:${copiedPath}`,
    cleanup: async () => {
      const response = await stagingFetch(
        `${env.apiUrl}/v1/ws/${workspace.slug}/files/${copiedPath}`,
        { method: 'DELETE', headers: bearer(apiToken) },
      )
      assert(
        response.status === 200 || response.status === 404,
        `browser file cleanup returned HTTP ${response.status}`,
      )
    },
    verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
  })
  await page.getByRole('button', { name: `Actions for ${artifactName}` }).click()
  await page.getByRole('menuitem', { name: 'Make a copy', exact: true }).click()
  const copyName = page.getByRole('textbox', { name: 'Copy name' })
  await copyName.fill(copiedName)
  await Promise.all([
    waitForBrowserApiResponse(page, 'POST', `/api/duet/ws/${workspace.slug}/files/actions`),
    page.getByRole('button', { name: 'Confirm', exact: true }).click(),
  ])
  await page.getByRole('button', { name: copiedName, exact: true }).waitFor()
  // Clicking a document opens its preview now; delete rides the row menu.
  await page.getByRole('button', { name: `Actions for ${copiedName}` }).click()
  await page.locator('[data-files-menu-action="delete"]').click()
  await page.getByRole('heading', { name: 'Delete permanently?', exact: true }).waitFor()
  await Promise.all([
    waitForBrowserApiResponse(page, 'POST', `/api/duet/ws/${workspace.slug}/files/actions`),
    page.getByRole('button', { name: 'Delete', exact: true }).click(),
  ])

  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${workspaceRoot}/train`)
  await page.getByRole('heading', { name: 'Train', exact: true }).last().waitFor()
  await page.getByText(trainJobId, { exact: true }).waitFor()
  await page.getByRole('heading', { name: 'Global memory', exact: true }).waitFor()
  await Promise.all([
    waitForFinishedBrowserResponse(page, 'GET', `/api/duet/ws/${workspace.slug}/train/jobs`),
    waitForFinishedBrowserResponse(page, 'GET', `/api/duet/ws/${workspace.slug}/train/records`),
    page.getByRole('button', { name: 'Refresh', exact: true }).click(),
  ])

  const agentTrainPath = `/api/duet/ws/${workspace.slug}/agents/${trainAgent.slug}/train`
  const agentTrainApi = `${env.apiUrl}/v1/ws/${workspace.slug}/agents/${trainAgent.slug}/train`
  const beforeBrowserTrain = TrainRecordListResponseSchema.parse(
    await apiJson(
      `${agentTrainApi}/records`,
      { headers: bearer(apiToken) },
      200,
      'browser agent train record baseline',
    ),
  )
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${workspaceRoot}/train/${encodeURIComponent(trainAgent.slug)}`)
  await page
    .getByRole('heading', { name: `${trainAgent.name ?? trainAgent.slug} memory`, exact: true })
    .last()
    .waitFor()
  await page.getByRole('heading', { name: 'Inherited memories', exact: true }).waitFor()

  const browserTrainFilename = `${runId}-agent-browser.md`
  await page.locator('input[type="file"]').setInputFiles({
    name: browserTrainFilename,
    mimeType: 'text/markdown',
    buffer: Buffer.from(
      `# Browser-trained agent fact\n\nThe browser acceptance marker is ${runId}.\n`,
    ),
  })
  await page.getByText(browserTrainFilename, { exact: true }).waitFor()
  const [agentTrainResponse] = await Promise.all([
    waitForFinishedBrowserResponse(page, 'POST', agentTrainPath),
    page.getByRole('button', { name: 'Start training', exact: true }).click(),
  ])
  const browserTrain = TrainStartResponseSchema.parse(await agentTrainResponse.json())
  ledger.record({
    kind: 'train-job',
    id: browserTrain.jobId,
    label: `${runId}:browser-agent-train:${browserTrain.jobId}`,
    cleanup: async () => undefined,
    verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
  })
  await waitForTrain(env.apiUrl, workspace.slug, browserTrain.jobId, apiToken, {
    agentSlug: trainAgent.slug,
  })
  const afterBrowserTrain = TrainRecordListResponseSchema.parse(
    await apiJson(
      `${agentTrainApi}/records`,
      { headers: bearer(apiToken) },
      200,
      'browser agent train records',
    ),
  )
  const browserOwnedRecord = findNewOwnedRecord(beforeBrowserTrain.items, afterBrowserTrain.items)
  assert(
    browserOwnedRecord !== undefined,
    'browser-started training did not create an owned record',
  )
  const inheritedRoot = findInheritedRecord(afterBrowserTrain.items, rootTrainRecord.memoryId)
  assert(inheritedRoot !== undefined, 'agent Train page data omitted the root-trained inheritance')

  await Promise.all([
    waitForFinishedBrowserResponse(page, 'GET', `${agentTrainPath}/jobs`),
    waitForFinishedBrowserResponse(page, 'GET', `${agentTrainPath}/records`),
    page.getByRole('button', { name: 'Refresh', exact: true }).click(),
  ])
  await page.getByText(browserTrain.jobId, { exact: true }).waitFor()
  await page
    .getByRole('button')
    .filter({ hasText: browserOwnedRecord.headline ?? browserOwnedRecord.slug })
    .first()
    .waitFor()
  await page
    .getByRole('link')
    .filter({ hasText: inheritedRoot.headline ?? inheritedRoot.slug })
    .first()
    .waitFor()

  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${workspaceRoot}/integrations`)
  await page.getByRole('heading', { name: 'Integrations', exact: true }).last().waitFor()
  await page.getByRole('heading', { name: 'Connect your app stack', exact: true }).waitFor()
  const integrationSearch = page.getByPlaceholder('Search Gmail, GitHub, Notion…')
  await Promise.all([
    waitForFinishedBrowserResponse(
      page,
      'GET',
      `/api/duet/ws/${workspace.slug}/integrations/catalog`,
      url => url.searchParams.get('q') === 'Firecrawl',
    ),
    integrationSearch.fill('Firecrawl'),
  ])
  await page.getByText('Firecrawl', { exact: false }).first().waitFor()

  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${workspaceRoot}/settings/billing-user`)
  await page.getByRole('heading', { name: 'Designated payer', exact: true }).last().waitFor()
  await page.getByText('Only current workspace owners are eligible.', { exact: false }).waitFor()
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${env.appUrl}/settings/billing`)
  await page.getByRole('heading', { name: 'Billing', exact: true }).last().waitFor()

  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${workspaceRoot}/agents`)
  await page.getByRole('button', { name: 'Switch workspace' }).click()
  markExpectedBrowserTransition(page)
  await page
    .getByRole('menuitem')
    .filter({ hasText: `${runId} second workspace` })
    .click()
  await page.waitForURL(url => url.pathname.includes(`/w/${secondWorkspace.slug}/`))
  await page.getByRole('button', { name: 'Switch workspace' }).click()
  markExpectedBrowserTransition(page)
  await page
    .getByRole('menuitem')
    .filter({ hasText: `Staging E2E ${runId}'s Workspace` })
    .click()
  await page.waitForURL(url => url.pathname.includes(`/w/${workspace.slug}/`))

  const browserWorkspaceSlug = `ui-${runId.slice(-8)}`
  const browserWorkspaceName = `${runId} browser workspace`
  await page.getByRole('button', { name: 'Switch workspace' }).click()
  await page.getByRole('menuitem', { name: 'Create workspace', exact: true }).click()
  await page.getByLabel('Workspace name').fill(browserWorkspaceName)
  await page.getByLabel('Workspace URL').fill(browserWorkspaceSlug)
  markExpectedBrowserTransition(page)
  const [createdResponse] = await Promise.all([
    page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/duet/workspaces',
    ),
    page.waitForURL(url => url.pathname.includes(`/w/${browserWorkspaceSlug}/agents`)),
    page.getByRole('button', { name: 'Create', exact: true }).click(),
  ])
  assert.equal(createdResponse.status(), 202, 'browser workspace creation failed')
  const createdIdentity = WhoamiResponseSchema.parse(
    await page.evaluate(async () => {
      const response = await fetch('/api/duet/whoami')
      if (!response.ok) throw new Error(`whoami returned HTTP ${response.status}`)
      return await response.json()
    }),
  )
  const created = createdIdentity.workspaces.find(row => row.slug === browserWorkspaceSlug)
  assert(created !== undefined, 'browser-created workspace was absent from whoami')
  recordWorkspaceCleanup({
    ledger,
    convex,
    env,
    output,
    workspaceId: created.id,
    slug: created.slug,
  })
  await page.getByText(browserWorkspaceName, { exact: true }).first().waitFor()
  await page.getByRole('button', { name: 'Switch workspace' }).click()
  markExpectedBrowserTransition(page)
  await page
    .getByRole('menuitem')
    .filter({ hasText: `Staging E2E ${runId}'s Workspace` })
    .click()
  await page.waitForURL(url => url.pathname.includes(`/w/${workspace.slug}/`))
}

export async function waitForBrowserMagicLink(args: {
  // Only the AgentMail fields are read, so workspace-journey envs (a narrow
  // Pick of LiveEnv) can drive the same sign-in as the full acceptance run.
  env: Pick<LiveEnv, 'agentMailApiKey' | 'agentMailInboxId'>
  page: Page
  ledger: StagingResourceLedger
  email: string
  inboxId?: string
  requestedAt: number
  runId: string
  mailCorrelationMarker?: string
  returnTo: string
  deadlineAt?: number
}): Promise<string> {
  const budget = (maximum: number) => {
    const remaining = args.deadlineAt === undefined ? maximum : args.deadlineAt - Date.now()
    assert(remaining > 0, 'Workspace journey acceptance deadline expired')
    return Math.min(maximum, remaining)
  }
  const inboxId = args.inboxId ?? args.env.agentMailInboxId
  let message: Awaited<ReturnType<typeof waitForMailboxLink>>
  try {
    message = await waitForMailboxLink({
      apiKey: args.env.agentMailApiKey,
      inboxId,
      expected: {
        after: args.requestedAt,
        recipient: args.email,
        subject: /sign in to duet/i,
        runId: args.mailCorrelationMarker ?? args.runId,
      },
      timeoutMs: budget(60_000),
    })
  } catch {
    budget(120_000)
    const resendMarker = `${args.runId}-resend-${crypto.randomUUID().slice(0, 8)}`
    const resentAt = Date.now()
    const separator = args.returnTo.includes('?') ? '&' : '?'
    const resendStatus = await args.page.evaluate(
      async ({ recipient, returnTo, timeoutMs }) =>
        (
          await fetch('/api/auth/magic-link', {
            method: 'POST',
            signal: AbortSignal.timeout(timeoutMs),
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: recipient, returnTo }),
          })
        ).status,
      {
        recipient: args.email,
        timeoutMs: budget(120_000),
        returnTo: `${args.returnTo}${separator}e2e=${resendMarker}`,
      },
    )
    assert.equal(resendStatus, 204, 'magic-link resend did not complete')
    message = await waitForMailboxLink({
      apiKey: args.env.agentMailApiKey,
      inboxId,
      expected: {
        after: resentAt,
        recipient: args.email,
        subject: /sign in to duet/i,
        runId: resendMarker,
      },
      timeoutMs: budget(120_000),
    })
  }
  recordMailboxMessageCleanup(args.env, args.ledger, args.runId, message.messageId, inboxId)
  return message.url
}

export function recordMailboxMessageCleanup(
  env: Pick<LiveEnv, 'agentMailApiKey' | 'agentMailInboxId'>,
  ledger: StagingResourceLedger,
  runId: string,
  messageId: string,
  inboxId = env.agentMailInboxId,
): void {
  ledger.record({
    kind: 'mail-message',
    id: messageId,
    label: `${runId}:mail-message:${messageId}`,
    cleanup: async () => {
      await deleteAgentMailMessage({
        apiKey: env.agentMailApiKey,
        inboxId,
        messageId,
      })
    },
    verify: async () =>
      await isAgentMailMessageDeleted({
        apiKey: env.agentMailApiKey,
        inboxId,
        messageId,
      }),
  })
}
