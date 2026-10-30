import assert from 'node:assert/strict'

import { expect, type BrowserContext, type Page } from '@playwright/test'
import { z } from 'zod'

import {
  ApiDeploymentSchema,
  WebDeploymentSchema,
  DocsDeploymentSchema,
  AppResponseSchema,
  AppDomainResponseSchema,
  AppDomainListResponseSchema,
  canonicalAppUrl,
  DUET_STAGING_EDGE_HOST,
  DUET_APP_ACCESS_QUERY,
  APP_ACCESS_LAUNCH_TTL_MS,
  ROOT_AGENT_SCOPE,
  type App,
  type AppDomain,
  type DomainTarget,
} from '@repo/contract'

import { readDomain } from '../../backend/convex/services/vercelDomains'
import { createAppDomainFixtureCleanup } from './staging-live-app-domain-cleanup'
import { stagingProtectionHeaders } from './staging-live-artifacts'
import {
  attachBrowserDiagnostics,
  installStagingProtection,
  markExpectedBrowserTransition,
  navigateDeployedPage,
} from './staging-live-browser'
import { waitForBrowserMagicLink } from './staging-live-browser-acceptance'
import { verifyReleaseDeploymentTarget } from './staging-live-deployment'
import { fnMutation, fnQuery } from './staging-live-env'
import { waitForForwardProgress } from './staging-live-forward-progress'
import { apiJson, apiText, bearer, bearerJson, timedFetch, stagingFetch } from './staging-live-http'
import { resolveAgentMailInbox } from './staging-live-mailbox'
import { waitForHydratedMagicLinkControls } from './staging-live-public-site'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
} from './staging-live-workspace-browser'

const HOSTNAME = 'aomni.co'
const TARGET: DomainTarget = {
  teamId: 'team_I18zdvAznXXwqq1PcIampT1t',
  projectId: 'prj_mPNx8yJ4JRlThnK3NMZOIpeenJjM',
  gitBranch: 'staging',
}
const DEEP_PATH = '/deep/items?q=a%2Fb'
const READ_DEADLINE_MS = 30_000

function inspectionToken(): string {
  const token = process.env.VERCEL_TOKEN
  assert(
    token,
    'App domains journey requires the existing local VERCEL_TOKEN for read-only alias/release inspection',
  )
  assert(
    process.env.DUET_VERCEL_DOMAINS_TOKEN,
    'App domains journey requires DUET_VERCEL_DOMAINS_TOKEN for owned assignment inspection',
  )
  return token
}
async function vercelJson(path: string, allowMissing = false): Promise<unknown | null> {
  const response = await stagingFetch(
    `https://api.vercel.com${path}${path.includes('?') ? '&' : '?'}teamId=${TARGET.teamId}`,
    {
      headers: bearer(inspectionToken()),
      signal: AbortSignal.timeout(READ_DEADLINE_MS),
    },
  )
  if (allowMissing && response.status === 404) return null
  assert.equal(response.status, 200, `Read-only Vercel inspection returned HTTP ${response.status}`)
  return response.json()
}
const AliasSchema = z.object({ alias: z.string(), projectId: z.string(), deploymentId: z.string() })

async function readAlias() {
  const body = await vercelJson(`/v4/aliases/${HOSTNAME}`, true)
  return body === null ? null : AliasSchema.parse(body)
}

export async function runAppDomainsJourney(args: { onProgress?: (stage: string) => void }) {
  inspectionToken()
  assert.equal(
    await readAlias(),
    null,
    'aomni.co is already assigned; refusing to steal another run or app binding',
  )
  assert.equal(
    await readDomain(HOSTNAME, TARGET),
    null,
    'aomni.co has an existing project-domain assignment',
  )
  const result = await runWorkspaceBrowserJourney({
    journey: 'app-domains',
    label: 'App domains',
    entitlement: 'synthetic-subscription',
    ...(args.onProgress === undefined ? {} : { onProgress: args.onProgress }),
    run: runAppDomainsAcceptance,
  })
  return result.evidence
}

async function runAppDomainsAcceptance(context: WorkspaceBrowserJourneyContext) {
  const { env, page, apiToken, workspace, runId, artifacts, ledger, progress } = context
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}`
  const slug = 'domain-probe'
  const appPath = `apps/${slug}`
  const marker = `app-domains-${runId}`
  const standard = canonicalAppUrl(workspace.slug, slug, DUET_STAGING_EDGE_HOST)
  const custom = `https://${HOSTNAME}/`
  const route = `${env.appUrl}/w/${workspace.slug}/agents/${ROOT_AGENT_SCOPE}/apps/${slug}`
  const docsUrl = (process.env.DUET_DOCS_URL?.trim() || 'https://docs-staging.duet.so').replace(
    /\/+$/,
    '',
  )
  const request = (url: string, init: RequestInit = {}) =>
    timedFetch(url, { ...init, signal: AbortSignal.timeout(READ_DEADLINE_MS) }, artifacts)
  const json: typeof apiJson = (url, init, status, label, collector = artifacts) =>
    apiJson(
      url,
      { ...init, signal: AbortSignal.timeout(READ_DEADLINE_MS) },
      status,
      label,
      collector,
    )
  const text: typeof apiText = (url, init, status, label, collector = artifacts) =>
    apiText(
      url,
      { ...init, signal: AbortSignal.timeout(READ_DEADLINE_MS) },
      status,
      label,
      collector,
    )
  const app = async () =>
    AppResponseSchema.parse(
      await json(
        `${base}/apps/${slug}`,
        { headers: bearer(apiToken) },
        200,
        'fixture app detail',
        artifacts,
      ),
    ).app
  const domain = async () =>
    AppDomainResponseSchema.parse(
      await json(
        `${base}/apps/${slug}/domain`,
        { headers: bearer(apiToken) },
        200,
        'fixture domain detail',
        artifacts,
      ),
    ).domain
  const waitDomain = (complete: (row: AppDomain | null) => boolean) =>
    waitForForwardProgress({
      label: 'app domain lifecycle',
      load: domain,
      isComplete: row => {
        if (row?.operatorRepairRequired)
          throw new Error(
            `Domain ${row.id} requires operator repair; no automatic uncertainty acknowledgement`,
          )
        if (row?.retryRequired || row?.status === 'failed')
          throw new Error(`Domain ${row?.id} needs repair: ${row?.lastError ?? row?.status}`)
        return complete(row)
      },
      hasProgress: (before, after) =>
        before?.status !== after?.status || before?.updatedAt !== after?.updatedAt,
      maxConsecutiveUnchangedObservations: 24,
      timeoutMs: 300_000,
      pollMs: 5_000,
      summarize: row =>
        row === null
          ? null
          : {
              id: row.id,
              status: row.status,
              lastError: row.lastError,
              lastCheckedAt: row.lastCheckedAt,
            },
    })
  const waitProviderAbsent = () =>
    waitForForwardProgress({
      label: 'provider domain cleanup',
      load: async () => ({
        assignment: await readDomain(HOSTNAME, TARGET),
        alias: await readAlias(),
      }),
      isComplete: value => value.assignment === null && value.alias === null,
      hasProgress: (before, after) =>
        (before.assignment === null) !== (after.assignment === null) ||
        (before.alias === null) !== (after.alias === null),
      maxConsecutiveUnchangedObservations: 12,
      timeoutMs: 90_000,
      pollMs: 5_000,
      summarize: value => ({
        assignmentPresent: value.assignment !== null,
        aliasPresent: value.alias !== null,
      }),
    })
  const detach = async () => {
    await json(
      `${base}/apps/${slug}/domain`,
      { method: 'DELETE', headers: bearer(apiToken) },
      200,
      'domain detachment',
      artifacts,
    )
    await waitDomain(row => row === null)
    await waitProviderAbsent()
  }
  const cleanup = createAppDomainFixtureCleanup({
    ledger,
    convex: context.convex,
    internalKey: env.internalKey,
    workspaceId: workspace._id,
    base,
    hostname: HOSTNAME,
    appPath,
    apiToken,
    request,
    waitProviderAbsent,
    providerAbsent: async () =>
      (await readDomain(HOSTNAME, TARGET)) === null && (await readAlias()) === null,
  })
  const register = async (nextMarker: string) => {
    await text(
      `${base}/files/${appPath}/server.ts`,
      {
        method: 'PUT',
        headers: bearer(apiToken, { 'content-type': 'text/plain' }),
        body: fixtureSource(nextMarker),
      },
      200,
      'fixture server write',
      artifacts,
    )
    const row = AppResponseSchema.parse(
      await json(
        `${base}/apps`,
        {
          method: 'POST',
          headers: bearerJson(apiToken),
          body: JSON.stringify({
            path: appPath,
            slug,
            name: 'App domains probe',
            command: 'bun run server.ts',
            apiScopes: [],
          }),
        },
        201,
        'fixture app register',
        artifacts,
      ),
    ).app
    cleanup.recordApp(row.id)
    return await waitForForwardProgress({
      label: 'fixture app reconciliation',
      load: app,
      isComplete: current => {
        assert.notEqual(
          current.runtimeStatus,
          'reconcile_failed',
          current.reconciliationError ?? 'fixture runtime reconciliation failed',
        )
        return current.runtimeStatus === 'reconciled'
      },
      hasProgress: (before, after) =>
        before.runtimeStatus !== after.runtimeStatus || before.updatedAt !== after.updatedAt,
      maxConsecutiveUnchangedObservations: 24,
      timeoutMs: 180_000,
      pollMs: 5_000,
      summarize: current => ({ id: current.id, status: current.runtimeStatus }),
    })
  }
  const attach = async (row: App) => {
    cleanup.recordDomain(row.id)
    await json(
      `${base}/apps/${slug}/domain`,
      {
        method: 'PUT',
        headers: bearerJson(apiToken),
        body: JSON.stringify({ hostname: HOSTNAME }),
      },
      200,
      'custom domain attach',
      artifacts,
    )
    const active = await waitDomain(value => value?.status === 'active')
    assert(active !== null)
    const observation = await readDomain(HOSTNAME, TARGET)
    assert(
      observation !== null && observation.ownershipVerified && !observation.misconfigured,
      'provider binding was not ready on the captured staging target',
    )
    return active
  }
  const visibility = async (value: 'public' | 'folder') =>
    json(
      `${base}/apps/${slug}/visibility`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({ visibility: value }),
      },
      200,
      'fixture app visibility',
      artifacts,
    )
  const matrix: Array<{ host: string; path: string; robots: string | null; status: number }> = []
  const check = async (
    origin: string,
    path: string,
    indexing: 'custom' | 'standard' | 'opt-out',
    expectedMarker = marker,
  ) => {
    const response = await request(new URL(path, origin).toString(), { redirect: 'manual' })
    matrix.push({
      host: new URL(origin).host,
      path,
      robots: response.headers.get('x-robots-tag'),
      status: response.status,
    })
    await assertAppDomainResponse(response, {
      marker: expectedMarker,
      host: new URL(origin).host,
      path,
      indexing,
    })
  }

  progress('app-domains:release-preflight')
  const genericRelease = await verifyReleaseDeploymentTarget(
    { apiUrl: env.apiUrl, appUrl: env.appUrl, docsUrl },
    {
      resolveGateway: async () =>
        await context.convex.query(
          fnQuery('domains/workspaces/provisioning:gatewayConnectionBySlug'),
          { internalKey: env.internalKey, slug: workspace.slug },
        ),
      readJson: (url, init = {}, label = 'release deployment') => json(url, init, 200, label),
      readText: (url, init = {}, label = 'release docs') => text(url, init, 200, label),
    },
  )
  progress('app-domains:fixture')
  cleanup.recordDirectory()
  await json(
    `${base}/files/actions`,
    {
      method: 'POST',
      headers: bearerJson(apiToken),
      body: JSON.stringify({ operation: 'mkdir', path: appPath, recursive: true }),
    },
    200,
    'fixture directory',
    artifacts,
  )
  let row = await register(marker)
  assert.equal(row.visibility, 'folder')
  progress('app-domains:attach-private')
  const firstDomain = await attach(row)
  progress('app-domains:manual-recheck')
  const queuedCheck = AppDomainResponseSchema.parse(
    await json(
      `${base}/apps/${slug}/domain/recheck`,
      { method: 'POST', headers: bearer(apiToken) },
      200,
      'active domain recheck',
    ),
  ).domain
  assert(
    queuedCheck !== null && queuedCheck.status === 'active' && queuedCheck.checking === true,
    'manual recheck did not expose its queued work while keeping the active address',
  )
  const completedCheck = await waitDomain(
    value =>
      value?.status === 'active' &&
      value.checking !== true &&
      value.lastCheckedAt !== undefined &&
      value.lastCheckedAt > (firstDomain.lastCheckedAt ?? 0),
  )
  assert(
    completedCheck !== null && completedCheck.lastError === undefined,
    'manual domain recheck did not settle successfully',
  )
  assert.equal((await app()).visibility, 'folder', 'attaching a domain changed app visibility')
  const release = await readRelease(context, docsUrl)

  progress('app-domains:public-serving')
  await visibility('public')
  assert.equal((await app()).canonicalUrl, custom)
  for (const path of ['/', DEEP_PATH]) {
    await check(custom, path, 'custom')
    await check(standard, path, 'standard')
  }
  await check(custom, '/opt-out', 'opt-out')
  markExpectedBrowserTransition(page)
  const browserResponse = await navigateDeployedPage(page, custom)
  assert(browserResponse !== null && browserResponse.status() === 200)
  assert(
    await browserResponse.securityDetails(),
    'custom hostname did not complete a browser TLS handshake',
  )
  await expect(page.getByRole('heading', { name: marker, exact: true })).toBeVisible()
  const tls = await browserResponse.securityDetails()

  progress('app-domains:primary-and-embeds')
  await addAppProtection(page.context(), env.vercelBypassSecret, [standard, custom])
  await openEmbedded(page, route, standard, marker, env.appUrl, workspace.slug, slug)
  await page
    .context()
    .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: env.appUrl })
  await page.getByRole('button', { name: 'App options', exact: true }).click()
  const popupReady = page.waitForEvent('popup')
  await page.getByRole('menuitem', { name: 'Open in new tab', exact: true }).click()
  const popup = await popupReady
  await popup.waitForLoadState('domcontentloaded')
  assert.equal(new URL(popup.url()).origin, new URL(custom).origin)
  await expect(popup.getByRole('heading', { name: marker, exact: true })).toBeVisible()
  await popup.close()
  await page.getByRole('button', { name: 'App options', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Copy public link', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 10_000 })
    .toBe(custom)
  await page.getByRole('button', { name: 'App options', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Custom domains', exact: true }).click()
  await expect(page.locator(`[data-app-domain-dialog="${slug}"]`)).toContainText(HOSTNAME)
  await page.keyboard.press('Escape')
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${env.appUrl}/w/${workspace.slug}/settings/app-domains`)
  await expect(page.locator(`[data-app-domain-row="${slug}"]`)).toContainText(HOSTNAME)
  const overview = AppDomainListResponseSchema.parse(
    await json(
      `${base}/app-domains`,
      { headers: bearer(apiToken) },
      200,
      'workspace domain inventory',
      artifacts,
    ),
  )
  assert(
    overview.items.some(
      item =>
        item.domain.id === firstDomain.id &&
        item.app.id === row.id &&
        item.app.controls.manageDomain,
    ),
  )

  progress('app-domains:private-return')
  await visibility('folder')
  await openEmbedded(page, route, standard, marker, env.appUrl, workspace.slug, slug)
  const browser = page.context().browser()
  assert(browser)
  const documentContext = await browser.newContext()
  try {
    attachBrowserDiagnostics(documentContext, artifacts)
    await installStagingProtection(documentContext, { ...env, landerUrl: env.appUrl })
    await addAppProtection(documentContext, env.vercelBypassSecret, [standard, custom])
    const guestPage = await documentContext.newPage()
    for (const origin of [standard, custom]) {
      const url = new URL(DEEP_PATH, origin)
      const documentResponse = guestPage.waitForResponse(
        response => response.url() === url.toString(),
      )
      markExpectedBrowserTransition(guestPage)
      await navigateDeployedPage(guestPage, url.toString())
      const guest = await documentResponse
      assert.equal(
        guest.status(),
        302,
        `guest browser document at ${url.host} did not enter private return`,
      )
      const bridge = new URL(guest.headers()['location']!)
      assert.equal(bridge.origin, new URL(env.appUrl).origin)
      assert.equal(bridge.pathname, `/w/${workspace.slug}/apps/${slug}/open`)
      assert.equal(bridge.searchParams.get('host'), url.host)
      assert.equal(bridge.searchParams.get('path'), DEEP_PATH)
      for (const headers of [
        { accept: 'application/json', 'sec-fetch-dest': 'empty' },
        { accept: 'text/html', 'sec-fetch-dest': 'iframe' },
      ]) {
        const refusal = await request(url.toString(), { headers, redirect: 'manual' })
        assert.equal(refusal.status, 403)
        assert(refusal.headers.get('x-robots-tag')?.includes('noindex'))
      }
    }
  } finally {
    await documentContext.close()
  }
  const privateContext = await browser.newContext()
  try {
    attachBrowserDiagnostics(privateContext, artifacts)
    await installStagingProtection(privateContext, { ...env, landerUrl: env.appUrl })
    await addAppProtection(privateContext, env.vercelBypassSecret, [standard, custom])
    const privatePage = await privateContext.newPage()
    await coldPrivateSignIn(context, privatePage, new URL(DEEP_PATH, custom).toString())
    await assertPrivateDocument(privatePage, custom, marker)
    markExpectedBrowserTransition(privatePage)
    await navigateDeployedPage(privatePage, new URL(DEEP_PATH, standard).toString())
    await assertPrivateDocument(privatePage, standard, marker)

    progress('app-domains:servicing')
    await context.convex.mutation(fnMutation('testing/workspaces:setWorkspaceServicingForTest'), {
      internalKey: env.internalKey,
      workspaceId: workspace._id,
      servicingStatus: 'paused',
      now: Date.now(),
    })
    try {
      for (const origin of [standard, custom]) {
        const paused = await privateContext.request.get(origin, {
          headers: { 'x-vercel-protection-bypass': env.vercelBypassSecret },
          maxRedirects: 0,
          timeout: READ_DEADLINE_MS,
        })
        assert.equal(paused.status(), 503)
        assert(paused.headers()['x-robots-tag']?.includes('noindex'))
        assert((await paused.text()).includes('App domains probe'))
      }
      assert.equal((await domain())?.status, 'active')
    } finally {
      await context.convex.mutation(fnMutation('testing/workspaces:setWorkspaceServicingForTest'), {
        internalKey: env.internalKey,
        workspaceId: workspace._id,
        servicingStatus: 'active',
        now: Date.now(),
      })
    }
    await json(
      `${base}/admin/suspension`,
      {
        method: 'PUT',
        headers: bearerJson(apiToken),
        body: JSON.stringify({ suspended: true, reason: runId }),
      },
      200,
      'suspend fixture workspace',
      artifacts,
    )
    try {
      for (const origin of [standard, custom]) {
        const suspended = await privateContext.request.get(origin, {
          headers: {
            'x-vercel-protection-bypass': env.vercelBypassSecret,
            'sec-fetch-dest': 'document',
            'sec-fetch-mode': 'navigate',
          },
          maxRedirects: 0,
          timeout: READ_DEADLINE_MS,
        })
        assert.equal(suspended.status(), 403)
        assert.equal(suspended.headers().location, undefined)
        assert(suspended.headers()['x-robots-tag']?.includes('noindex'))
      }
    } finally {
      await json(
        `${base}/admin/suspension`,
        {
          method: 'PUT',
          headers: bearerJson(apiToken),
          body: JSON.stringify({ suspended: false }),
        },
        200,
        'resume fixture workspace',
        artifacts,
      )
    }

    progress('app-domains:remove-and-recover')
    await visibility('public')
    await openEmbedded(page, route, standard, marker, env.appUrl, workspace.slug, slug)
    await page.getByRole('button', { name: 'App options', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Custom domains', exact: true }).click()
    const manager = page.locator(`[data-app-domain-dialog="${slug}"]`)
    await manager.getByRole('button', { name: 'Remove domain', exact: true }).click()
    await manager.getByRole('button', { name: 'Confirm removal', exact: true }).click()
    await waitDomain(value => value === null || value.status === 'removing')
    assert.equal((await app()).canonicalUrl, standard)
    await waitDomain(value => value === null)
    await waitProviderAbsent()
    assert.equal((await app()).canonicalUrl, standard)
    await check(standard, DEEP_PATH, 'standard')
    const removed = await request(custom, { redirect: 'manual' })
    assert([404, 421].includes(removed.status), 'detached custom host continued serving')
    await page.keyboard.press('Escape')

    // Keep the real first-generation cookies; rebuilding the same slug must not
    // grant a different durable app merely because its public labels match.
    const firstAppId = row.id
    const grantIssuedAt = Date.now()
    const firstLaunch = await request(`${base}/apps/${slug}/launch`, {
      headers: bearer(apiToken),
      redirect: 'manual',
    })
    assert.equal(firstLaunch.status, 302)
    const firstGrantUrl = firstLaunch.headers.get('location')
    assert(
      firstGrantUrl !== null && new URL(firstGrantUrl).searchParams.has(DUET_APP_ACCESS_QUERY),
      'ordinary launch omitted the grant',
    )
    await json(
      `${base}/apps/${slug}`,
      { method: 'DELETE', headers: bearer(apiToken) },
      200,
      'delete first fixture app',
      artifacts,
    )
    const replacementMarker = `${marker}-replacement`
    row = await register(replacementMarker)
    assert.notEqual(row.id, firstAppId)
    assert(
      Date.now() - grantIssuedAt < APP_ACCESS_LAUNCH_TTL_MS,
      'Fixture replacement exceeded the original grant lifetime; replay would not prove app identity',
    )
    const replay = await request(firstGrantUrl, {
      headers: { accept: 'text/html', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' },
      redirect: 'manual',
    })
    await replay.arrayBuffer()
    assertAppDomainGrantReplay(replay, grantIssuedAt + APP_ACCESS_LAUNCH_TTL_MS)
    await attach(row)
    await visibility('public')
    for (const origin of [standard, custom]) {
      const stalePublic = await privateContext.request.get(origin, {
        headers: {
          'x-vercel-protection-bypass': env.vercelBypassSecret,
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate',
        },
        maxRedirects: 0,
        timeout: READ_DEADLINE_MS,
      })
      assert.equal(stalePublic.status(), 200, 'stale app cookie blocked a public replacement')
      assert((await stalePublic.text()).includes(`<h1>${replacementMarker}</h1>`))
      if (origin === custom) assert.equal(stalePublic.headers()['x-robots-tag'], undefined)
      else assert(stalePublic.headers()['x-robots-tag']?.includes('noindex'))
    }
    await visibility('folder')
    for (const origin of [standard, custom]) {
      const stalePrivate = await privateContext.request.get(origin, {
        headers: {
          'x-vercel-protection-bypass': env.vercelBypassSecret,
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate',
        },
        maxRedirects: 0,
        timeout: READ_DEADLINE_MS,
      })
      assert.equal(stalePrivate.status(), 302, 'stale cookie was not treated as a private guest')
      assert(stalePrivate.headers()['x-robots-tag']?.includes('noindex'))
      const bridge = new URL(stalePrivate.headers().location!)
      assert.equal(bridge.origin, new URL(env.appUrl).origin)
      assert.equal(bridge.pathname, `/w/${workspace.slug}/apps/${slug}/open`)
      const staleIframe = await privateContext.request.get(origin, {
        headers: {
          'x-vercel-protection-bypass': env.vercelBypassSecret,
          'sec-fetch-dest': 'iframe',
        },
        maxRedirects: 0,
        timeout: READ_DEADLINE_MS,
      })
      assert.equal(staleIframe.status(), 403, 'stale app cookie admitted a private replacement')
      assert.equal(staleIframe.headers().location, undefined)
      assert(staleIframe.headers()['x-robots-tag']?.includes('noindex'))
    }
    markExpectedBrowserTransition(privatePage)
    await navigateDeployedPage(
      privatePage,
      `${env.appUrl}/w/${workspace.slug}/apps/${slug}/open?${new URLSearchParams({ host: new URL(standard).host, path: DEEP_PATH })}`,
    )
    await assertPrivateDocument(privatePage, standard, replacementMarker)
    await detach()
    assert.equal((await app()).canonicalUrl, standard)
    markExpectedBrowserTransition(privatePage)
    await navigateDeployedPage(privatePage, new URL(DEEP_PATH, standard).toString())
    await assertPrivateDocument(privatePage, standard, replacementMarker)
    const evidence = {
      hostname: HOSTNAME,
      target: TARGET,
      release: { ...release, ...genericRelease },
      firstAppId,
      replacementAppId: row.id,
      tls,
      http: matrix,
      publicAndPrivateEmbeddedOrigin: new URL(standard).origin,
      primaryOrigin: new URL(custom).origin,
      manualRecheck: { queued: true, completedLastCheckedAt: completedCheck.lastCheckedAt },
      privateReturn: 'real magic-link and existing protected bridge',
      staleCookiePolicy: { public: 200, privateDocument: 302, privateIframe: 403 },
      originalAppQueryGrant: { replayStatus: 403, withinLaunchLifetime: true },
      cleanup: { domainSlot: 'absent', providerAssignment: 'absent', servingAlias: 'absent' },
    }
    await artifacts.writeJson('app-domains-receipt.json', evidence)
    return evidence
  } finally {
    await privateContext.close()
  }
}

async function addAppProtection(context: BrowserContext, secret: string, origins: string[]) {
  const allowed = new Set(origins.map(value => new URL(value).origin))
  for (const origin of allowed)
    await context.route(`${origin}/**`, route =>
      route.continue({
        headers: stagingProtectionHeaders(
          route.request().url(),
          allowed,
          route.request().headers(),
          secret,
        ),
      }),
    )
}
async function openEmbedded(
  page: Page,
  route: string,
  standard: string,
  marker: string,
  appUrl: string,
  workspaceSlug: string,
  slug: string,
) {
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, route)
  const iframe = page.getByTitle('App domains probe', { exact: true }).and(page.locator('iframe'))
  await iframe.waitFor({ timeout: 120_000 })
  const source = await iframe.getAttribute('src')
  assert.equal(
    new URL(source!, appUrl).pathname,
    `/api/duet/ws/${workspaceSlug}/apps/${slug}/launch`,
  )
  assert.equal(new URL(source!, appUrl).search, '')
  const frame = iframe.contentFrame()
  await expect(frame.getByRole('heading', { name: marker, exact: true })).toBeVisible({
    timeout: 120_000,
  })
  const actual = new URL(await frame.locator('body').evaluate(() => location.href))
  assert.equal(
    actual.origin,
    new URL(standard).origin,
    'embedded app depended on the custom hostname',
  )
  assert(
    !actual.searchParams.has(DUET_APP_ACCESS_QUERY),
    'launch grant remained in the embedded URL',
  )
}
async function coldPrivateSignIn(
  context: WorkspaceBrowserJourneyContext,
  page: Page,
  destination: string,
) {
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, destination)
  await page.waitForURL(
    url => url.origin === new URL(context.env.appUrl).origin && url.pathname === '/sign-in',
    { timeout: 120_000 },
  )
  const returnTo = new URL(page.url()).searchParams.get('returnTo')!
  assert(returnTo.startsWith(`/w/${context.workspace.slug}/apps/domain-probe/open?`))
  const inbox = await resolveAgentMailInbox({
    apiKey: context.env.agentMailApiKey,
    address: context.env.agentMailInboxAddress,
  })
  const controls = await waitForHydratedMagicLinkControls(page)
  await controls.email.fill(context.email)
  const requestedAt = Date.now()
  const [intent] = await Promise.all([
    page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/auth/magic-link',
      { timeout: 60_000 },
    ),
    controls.submit.click({ noWaitAfter: true, timeout: 60_000 }),
  ])
  assert.equal(intent.status(), 204)
  const link = await waitForBrowserMagicLink({
    env: context.env,
    page,
    ledger: context.ledger,
    email: context.email,
    inboxId: inbox.id,
    requestedAt,
    runId: context.runId,
    returnTo,
  })
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, link)
}
async function assertPrivateDocument(page: Page, origin: string, marker: string) {
  await page.waitForURL(
    url => url.origin === new URL(origin).origin && `${url.pathname}${url.search}` === DEEP_PATH,
    { timeout: 120_000 },
  )
  await expect(page.getByRole('heading', { name: marker, exact: true })).toBeVisible()
  assert(!new URL(page.url()).searchParams.has(DUET_APP_ACCESS_QUERY))
  const admitted = await page.evaluate(async () => {
    const response = await fetch(location.href, { signal: AbortSignal.timeout(30_000) })
    return { status: response.status, robots: response.headers.get('x-robots-tag') }
  })
  assert.equal(admitted.status, 200)
  assert(admitted.robots?.includes('noindex'), 'private app document lost noindex')
}
async function readRelease(context: WorkspaceBrowserJourneyContext, docsUrl: string) {
  const api = await apiJson(
    `${context.env.apiUrl}/deployment`,
    { signal: AbortSignal.timeout(READ_DEADLINE_MS) },
    200,
    'API release',
    context.artifacts,
  )
  const web = await apiJson(
    `${context.env.appUrl}/api/version`,
    { signal: AbortSignal.timeout(READ_DEADLINE_MS) },
    200,
    'web release',
    context.artifacts,
  )
  const docs = await apiJson(
    `${docsUrl}/deployment.json`,
    { signal: AbortSignal.timeout(READ_DEADLINE_MS) },
    200,
    'docs release',
    context.artifacts,
  )
  const alias = await readAlias()
  assert(alias !== null, 'aomni.co has no serving alias')
  const deployment = await vercelJson(`/v13/deployments/${alias.deploymentId}?withGitRepoInfo=true`)
  return assertAppDomainRelease({
    api,
    web,
    docs,
    alias,
    deployment,
    hostname: HOSTNAME,
    target: TARGET,
  })
}

// Keep only release identity: the provider response can contain deployment secrets.
export function assertAppDomainRelease(input: {
  hostname: string
  target: Pick<DomainTarget, 'projectId' | 'gitBranch'>
  api: unknown
  web: unknown
  docs: unknown
  alias: unknown
  deployment: unknown
}) {
  const api = ApiDeploymentSchema.parse(input.api)
  const web = WebDeploymentSchema.parse(input.web)
  const docs = DocsDeploymentSchema.parse(input.docs)
  assert(
    api.revision !== null &&
      api.revision === api.backend.revision &&
      api.revision === web.revision &&
      api.revision === docs.revision,
    'API/backend/web/docs release revisions do not match',
  )
  const alias = AliasSchema.parse(input.alias)
  assert.equal(alias.alias, input.hostname, 'provider returned another alias')
  assert.equal(alias.projectId, input.target.projectId, 'app domain routed to another project')
  const deployment = z
    .object({
      id: z.string(),
      readyState: z.literal('READY'),
      meta: z.record(z.string(), z.unknown()).optional(),
      gitSource: z.object({ sha: z.string(), ref: z.string() }).nullish(),
      gitMetadata: z.object({ commitSha: z.string(), commitRef: z.string() }).nullish(),
    })
    .parse(input.deployment)
  assert.equal(deployment.id, alias.deploymentId, 'provider returned another deployment')
  const revision =
    deployment.gitMetadata?.commitSha ??
    deployment.gitSource?.sha ??
    deployment.meta?.githubCommitSha
  const branch =
    deployment.gitMetadata?.commitRef ??
    deployment.gitSource?.ref ??
    deployment.meta?.githubCommitRef
  assert.equal(revision, api.revision, 'aomni.co routed to a different edge release')
  assert.equal(branch, input.target.gitBranch, 'app domain routed to a non-staging deployment')
  return {
    api: api.revision,
    backend: api.backend.revision,
    web: web.revision,
    docs: docs.revision,
    edge: revision,
    edgeDeploymentId: deployment.id,
    edgeProjectId: alias.projectId,
    gitBranch: branch,
  }
}
function fixtureSource(marker: string): string {
  return `const marker = ${JSON.stringify(marker)}
Bun.serve({ port: Number(process.env.PORT), fetch(request) {
 const url = new URL(request.url)
 const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'x-app-domains-marker': marker, 'x-app-domains-path': url.pathname, 'x-app-domains-query': url.search, 'x-app-domains-host': request.headers.get('x-forwarded-host') ?? '' }
 if (url.pathname === '/opt-out') headers['x-robots-tag'] = 'noindex, noarchive'
 return new Response('<!doctype html><html><title>App domains probe</title><h1>' + marker + '</h1></html>', { headers })
} })
`
}

export async function assertAppDomainResponse(
  response: Response,
  expected: {
    marker: string
    host: string
    path: string
    indexing: 'custom' | 'standard' | 'opt-out'
  },
) {
  const url = new URL(expected.path, `https://${expected.host}`)
  if (response.status !== 200) throw new Error(`Fixture app returned HTTP ${response.status}`)
  if (response.headers.get('x-app-domains-marker') !== expected.marker)
    throw new Error('wrong app marker')
  if (!(await response.text()).includes(`<h1>${expected.marker}</h1>`))
    throw new Error('wrong app marker body')
  if (
    response.headers.get('x-app-domains-host') !== expected.host ||
    response.headers.get('x-app-domains-path') !== url.pathname ||
    (response.headers.get('x-app-domains-query') ?? '') !== url.search
  )
    throw new Error(
      `App origin lost original host/path/query: host=${response.headers.get('x-app-domains-host')} expected=${expected.host}; path=${response.headers.get('x-app-domains-path')} expected=${url.pathname}; queryMatches=${(response.headers.get('x-app-domains-query') ?? '') === url.search}`,
    )
  const robots = response.headers.get('x-robots-tag')
  if (expected.indexing === 'custom' && robots !== null)
    throw new Error('custom public host unexpectedly excluded indexing')
  if (expected.indexing === 'standard' && !robots?.includes('noindex'))
    throw new Error('Duet host lost noindex')
  if (expected.indexing === 'opt-out' && robots !== 'noindex, noarchive')
    throw new Error('app opt-out was lost')
}

export function assertAppDomainGrantReplay(
  response: Response,
  expiresAt: number,
  completedAt = Date.now(),
) {
  assert(
    completedAt < expiresAt,
    'Grant replay completed after launch lifetime; app identity proof is unverified',
  )
  assert.equal(response.status, 403, 'first app query grant admitted its replacement')
  assert.equal(
    response.headers.get('location'),
    null,
    'query grant rejection became a sign-in loop',
  )
}
