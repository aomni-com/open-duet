import assert from 'node:assert/strict'
import path from 'node:path'

import { Composio } from '@composio/core'
import { type Browser, type Page } from '@playwright/test'

import {
  IntegrationConnectionListSchema,
  IntegrationConnectResponseSchema,
  IntegrationDisconnectResponseSchema,
  type IntegrationConnection,
} from '@repo/contract'

import { assertNoCredentialArtifacts, StagingArtifactCollector } from './staging-live-artifacts.ts'
import {
  installStagingProtection,
  markExpectedBrowserTransition,
  navigateDeployedPage,
  type StagingBrowserEnv,
} from './staging-live-browser.ts'
import { isUsableStagingCredential, type LiveEnv, type Workspace } from './staging-live-env.ts'
import { apiJson, bearer, bearerJson } from './staging-live-http.ts'
import { StagingResourceLedger } from './staging-live-resource-ledger.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'
export async function runFirecrawlIntegrationAcceptance(args: {
  env: StagingBrowserEnv & Pick<LiveEnv, 'composioApiKey' | 'firecrawlApiKey'>
  browser: Browser
  ownerPage: Page
  workspace: Workspace
  apiToken: string
  runId: string
  ledger: StagingResourceLedger
  artifacts: StagingArtifactCollector
  recordProviderSweep?: boolean
  captureConnectedScreenshot?: boolean
  onConnected?: (connection: IntegrationConnection) => Promise<void>
}): Promise<void> {
  const { env, browser, ownerPage, workspace, apiToken, runId, ledger, artifacts } = args
  const connectionsUrl = `${env.apiUrl}/v1/ws/${workspace.slug}/integrations/connections`
  const callbackPath = `/w/${workspace.slug}/integrations`
  const composio = new Composio({ apiKey: env.composioApiKey! })
  const entityId = workspace._id
  assert(
    !(await listProviderConnections(composio, entityId)).some(
      account => account.toolkit.slug === 'firecrawl',
    ),
    'synthetic Firecrawl entity was not clean before connect',
  )
  if (args.recordProviderSweep !== false) {
    ledger.record({
      kind: 'integration',
      id: `provider-sweep:${entityId}`,
      label: `${runId}:integration:firecrawl-provider-sweep`,
      cleanup: async () => {
        const accounts = await listProviderConnections(composio, entityId)
        await Promise.all(
          accounts
            .filter(account => account.toolkit.slug === 'firecrawl')
            .map(async account => await composio.connectedAccounts.delete(account.id)),
        )
      },
      verify: async () =>
        !(await listProviderConnections(composio, entityId)).some(
          account => account.toolkit.slug === 'firecrawl',
        ),
    })
  }

  const connect = IntegrationConnectResponseSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/ws/${workspace.slug}/integrations/connect`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({
          integration: 'firecrawl',
          redirectTo: callbackPath,
        }),
      },
      200,
      'Firecrawl integration connect',
      artifacts,
    ),
  )
  assert.equal(connect.integration, 'firecrawl')

  const providerContext = await browser.newContext()
  try {
    await installStagingProtection(providerContext, env)
    await providerContext.addCookies(await ownerPage.context().cookies(env.appUrl))
    const providerPage = await providerContext.newPage()
    await providerPage.goto(connect.authorizeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    const providerRequests: Array<{
      method: string
      origin: string
      status?: number
      failure?: string
    }> = []
    providerPage.on('response', response => {
      providerRequests.push({
        method: response.request().method(),
        origin: new URL(response.url()).origin,
        status: response.status(),
      })
    })
    providerPage.on('requestfailed', request => {
      providerRequests.push({
        method: request.method(),
        origin: new URL(request.url()).origin,
        failure: request.failure()?.errorText,
      })
    })
    try {
      const baseUrlInput = providerPage.getByPlaceholder('Enter Base URL')
      const apiKeyInput = providerPage.getByPlaceholder('Enter API Key')
      const connectButton = providerPage.getByRole('button', {
        name: 'Connect Account',
        exact: true,
      })
      let returnedToDuet = false
      for (let attempt = 0; attempt < 2 && !returnedToDuet; attempt += 1) {
        await baseUrlInput.fill('https://api.firecrawl.dev/v1')
        await apiKeyInput.fill(env.firecrawlApiKey!)
        assert.equal(
          (await apiKeyInput.inputValue()).length,
          env.firecrawlApiKey!.length,
          'Firecrawl hosted credential field did not retain the supplied key',
        )
        const returned = providerPage
          .waitForURL(url => url.origin === env.appUrl && url.pathname === callbackPath, {
            timeout: 60_000,
          })
          .then(() => true)
          .catch(() => false)
        await connectButton.click()
        returnedToDuet = await returned
        if (!returnedToDuet && attempt === 0) await Bun.sleep(1_500)
      }
      assert(returnedToDuet, 'provider hosted authorization did not return after retry')
    } catch {
      const providerAccounts = await listProviderConnections(composio, entityId)
      const inputValidity = await providerPage.locator('input').evaluateAll(inputs =>
        inputs.map(input => {
          const field = input as HTMLInputElement
          return {
            placeholder: field.placeholder,
            type: field.type,
            valueLength: field.value.length,
            valid: field.validity.valid,
            validationMessage: field.validationMessage,
          }
        }),
      )
      const connectButton = providerPage.getByRole('button', {
        name: 'Connect Account',
        exact: true,
      })
      await providerPage
        .locator('input')
        .evaluateAll(inputs => inputs.forEach(input => ((input as HTMLInputElement).value = '')))
      await providerPage.screenshot({
        path: path.join(artifacts.directory, 'firecrawl-hosted-failure.png'),
        fullPage: true,
      })
      await artifacts.writeJson('firecrawl-hosted-failure.json', {
        pageOrigin: new URL(providerPage.url()).origin,
        title: await providerPage.title(),
        visibleText: (await providerPage.locator('body').innerText()).slice(0, 2_000),
        inputValidity,
        connectButton: {
          disabled: await connectButton.isDisabled(),
          ariaDisabled: await connectButton.getAttribute('aria-disabled'),
        },
        providerRequests: providerRequests.slice(-50),
        providerAccounts: providerAccounts
          .filter(account => account.toolkit.slug === 'firecrawl')
          .map(account => ({ status: account.status, toolkit: account.toolkit.slug })),
      })
      throw new Error('Firecrawl hosted authorization did not return to the SPA')
    }
    const callbackUrl = new URL(providerPage.url())
    assert.equal(callbackUrl.origin, env.appUrl, 'provider callback returned to another origin')
    assert.equal(callbackUrl.pathname, callbackPath, 'provider callback returned to another path')
  } finally {
    await providerContext.close()
  }

  const providerConnection = await waitForProviderConnection(
    composio,
    entityId,
    account => account.status === 'ACTIVE' && account.toolkit.slug === 'firecrawl',
  )
  ledger.record({
    kind: 'integration',
    id: providerConnection.id,
    label: `${runId}:integration:firecrawl-provider:${providerConnection.id}`,
    cleanup: async () => {
      if (await providerConnectionExists(composio, entityId, providerConnection.id)) {
        await composio.connectedAccounts.delete(providerConnection.id)
      }
    },
    verify: async () =>
      !(await providerConnectionExists(composio, entityId, providerConnection.id)),
  })

  await assertProviderScopesByUser(env.composioApiKey!, entityId, providerConnection.id)

  const active = await waitForIntegrationConnection(
    connectionsUrl,
    apiToken,
    connection => connection.id === providerConnection.id && connection.status === 'active',
    artifacts,
  )
  assert.equal(active.integration, 'firecrawl')

  markExpectedBrowserTransition(ownerPage)
  await navigateDeployedPage(ownerPage, `${env.appUrl}/w/${workspace.slug}/integrations`)
  await ownerPage.getByRole('heading', { name: 'Integrations', exact: true }).last().waitFor()
  await ownerPage.getByRole('heading', { name: 'Connected apps', exact: true }).waitFor()
  await ownerPage.getByText('Firecrawl', { exact: false }).first().waitFor()
  const integrationSearch = ownerPage.getByPlaceholder('Search Gmail, GitHub, Notion…')
  await integrationSearch.fill('Firecrawl')
  await ownerPage.getByText('Firecrawl', { exact: false }).first().waitFor()
  if (args.captureConnectedScreenshot !== false) {
    await ownerPage.screenshot({
      path: path.join(artifacts.directory, 'firecrawl-hosted-connect.png'),
      fullPage: true,
    })
  }

  await args.onConnected?.(active)

  // The composio proxy occasionally returns a response Bun's fetch fails to
  // decode (ZlibError on a truncated gzip stream); one retry separates that
  // transport flake from a broken integration.
  const executeScrape = () =>
    apiJson(
      `${env.apiUrl}/v1/integrations/composio/execute/FIRECRAWL_SCRAPE`,
      {
        method: 'POST',
        // Bun's fetch deterministically fails decoding this endpoint's large
        // compressed body (ZlibError); ask for an uncompressed response.
        headers: (() => {
          const headers = bearerJson(apiToken)
          headers.set('accept-encoding', 'identity')
          return headers
        })(),
        body: JSON.stringify({
          workspace: workspace.slug,
          arguments: {
            url: 'https://www.panzura.com/',
            formats: ['markdown'],
            onlyMainContent: true,
          },
        }),
      },
      200,
      'Firecrawl Composio execute',
      artifacts,
    )
  // Retry decode flakes (thrown) and empty upstream scrapes (HTTP 200 with a
  // null payload) alike — both are vendor-side weather, not our proxy.
  let execution: unknown = null
  let lastFailure = 'body was JSON null'
  for (let attempt = 0; execution === null && attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 15_000))
    execution = await executeScrape().catch((error: unknown) => {
      lastFailure = error instanceof Error ? error.message : String(error)
      return null
    })
  }
  assert(
    execution !== null,
    `Firecrawl Composio execute returned no result (last failure: ${lastFailure.slice(0, 500)})`,
  )

  await ownerPage.getByRole('button', { name: 'Disconnect', exact: true }).first().click()
  const [disconnectResponse] = await Promise.all([
    ownerPage.waitForResponse(
      response =>
        response.request().method() === 'DELETE' &&
        new URL(response.url()).pathname ===
          `/api/duet/ws/${workspace.slug}/integrations/connections/${providerConnection.id}`,
    ),
    ownerPage
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Disconnect', exact: true })
      .click(),
  ])
  assert.equal(disconnectResponse.status(), 200, 'Firecrawl integration UI disconnect failed')
  const disconnected = IntegrationDisconnectResponseSchema.parse(await disconnectResponse.json())
  assert(disconnected.disconnected, 'Firecrawl integration did not disconnect')
  assert(
    !(await providerConnectionExists(composio, entityId, providerConnection.id)),
    'Firecrawl provider account remained after Duet disconnect',
  )
  const remaining = await listIntegrationConnections(connectionsUrl, apiToken, artifacts)
  assert(
    !remaining.some(item => item.id === providerConnection.id && item.status !== 'disconnected'),
    'Firecrawl integration remained active after disconnect',
  )
}

async function waitForProviderConnection(
  composio: Composio,
  entityId: string,
  predicate: (
    account: Awaited<ReturnType<Composio['connectedAccounts']['list']>>['items'][number],
  ) => boolean,
): Promise<Awaited<ReturnType<Composio['connectedAccounts']['list']>>['items'][number]> {
  const deadline = Date.now() + 120_000
  for (;;) {
    const account = (await listProviderConnections(composio, entityId)).find(predicate)
    if (account !== undefined) return account
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Firecrawl provider account')
    await Bun.sleep(1_000)
  }
}

async function providerConnectionExists(
  composio: Composio,
  entityId: string,
  connectionId: string,
): Promise<boolean> {
  return (await listProviderConnections(composio, entityId)).some(
    account => account.id === connectionId,
  )
}

async function listProviderConnections(
  composio: Composio,
  entityId: string,
): Promise<Awaited<ReturnType<Composio['connectedAccounts']['list']>>['items']> {
  const accounts: Awaited<ReturnType<Composio['connectedAccounts']['list']>>['items'] = []
  let cursor: string | undefined
  for (;;) {
    const page = await composio.connectedAccounts.list({
      userIds: [entityId],
      limit: 500,
      ...(cursor === undefined ? {} : { cursor }),
    })
    accounts.push(...page.items)
    cursor = page.nextCursor ?? undefined
    if (cursor === undefined) return accounts
  }
}

async function waitForIntegrationConnection(
  url: string,
  token: string,
  predicate: (connection: IntegrationConnection) => boolean,
  artifacts: StagingArtifactCollector,
): Promise<IntegrationConnection> {
  const deadline = Date.now() + 120_000
  for (;;) {
    const connection = (await listIntegrationConnections(url, token, artifacts)).find(predicate)
    if (connection !== undefined) return connection
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Firecrawl connection state')
    await Bun.sleep(1_000)
  }
}

async function listIntegrationConnections(
  url: string,
  token: string,
  artifacts: StagingArtifactCollector,
): Promise<IntegrationConnection[]> {
  return IntegrationConnectionListSchema.parse(
    await apiJson(url, { headers: bearer(token) }, 200, 'integration connections', artifacts),
  ).items
}

/**
 * Duet proves a connection belongs to a workspace by asking Composio for that
 * workspace's accounts narrowed to one id, and removing whatever comes back.
 * No Composio document states that `user_ids` and `connected_account_ids`
 * compose as AND rather than the id filter short-circuiting the owner filter —
 * and if it ever short-circuited, that resolve would hand one workspace
 * another's connection to delete. Locally the provider is a fixture, so this is
 * the only place the real composition is observable.
 */
async function assertProviderScopesByUser(
  apiKey: string,
  entityId: string,
  connectedAccountId: string,
): Promise<void> {
  const query = new URLSearchParams({
    user_ids: `${entityId}-owns-nothing`,
    connected_account_ids: connectedAccountId,
    limit: '2',
  })
  const response = await fetch(
    `https://backend.composio.dev/api/v3.1/connected_accounts?${query}`,
    { headers: { 'x-api-key': apiKey } },
  )
  assert.equal(response.status, 200, 'Composio connected-account filter probe failed')
  const page = (await response.json()) as { items?: Array<{ id: string }> }
  assert.deepEqual(
    page.items ?? [],
    [],
    'Composio returned a connected account for a user that does not own it — ' +
      "the connection-id filter is short-circuiting user_ids, so Duet's disconnect " +
      "ownership check would resolve another workspace's connection",
  )
}

export interface FirecrawlIntegrationEvidence {
  integration: string
  connectionId: string
}

/**
 * Connect an integration through the UI, use it, and disconnect it — the whole
 * lifecycle and nothing else.
 *
 * `integration-agent-access` already drives this acceptance, but it does so
 * from inside its own per-agent policy callback, so any failure in that feature
 * stops the run before disconnect is ever reached. Integration connect and
 * disconnect are the older, more load-bearing contract of the two; they get a
 * journey that cannot be blocked by a feature layered on top of them.
 */
export async function runFirecrawlIntegrationJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<FirecrawlIntegrationEvidence>> {
  const composioApiKey = requireFirecrawlJourneyCredential('COMPOSIO_API_KEY')
  const firecrawlApiKey = requireFirecrawlJourneyCredential('FIRECRAWL_API_KEY')
  const result = await runWorkspaceBrowserJourney({
    journey: 'firecrawl-integration',
    label: 'Firecrawl integration lifecycle',
    onProgress: options.onProgress,
    run: async context => {
      const browser = context.page.context().browser()
      assert(browser !== null, 'firecrawl integration journey page had no browser owner')
      let connected: IntegrationConnection | undefined
      await runFirecrawlIntegrationAcceptance({
        env: {
          ...context.env,
          landerUrl: context.env.appUrl,
          docsUrl: context.env.appUrl,
          composioApiKey,
          firecrawlApiKey,
        },
        browser,
        ownerPage: context.page,
        workspace: context.workspace,
        apiToken: context.apiToken,
        runId: context.runId,
        ledger: context.ledger,
        artifacts: context.artifacts,
        onConnected: async connection => {
          connected = connection
        },
      })
      /* The acceptance asserts the disconnect itself — a 200 carrying
         `disconnected`, the provider account gone, and the connection absent
         from a re-read of the list. Reaching here is that evidence. */
      assert(connected !== undefined, 'firecrawl integration never reported a connection')
      return { integration: connected.integration, connectionId: connected.id }
    },
  })
  await assertNoCredentialArtifacts(result.artifactDirectory)
  return result
}

function requireFirecrawlJourneyCredential(name: 'COMPOSIO_API_KEY' | 'FIRECRAWL_API_KEY'): string {
  const value = process.env[name]
  const normalized = value?.trim()
  if (!isUsableStagingCredential(value) || normalized === undefined) {
    throw new Error(`firecrawl-integration journey requires ${name}`)
  }
  return normalized
}
