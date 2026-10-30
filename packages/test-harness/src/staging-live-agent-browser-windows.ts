import assert from 'node:assert/strict'
import path from 'node:path'

import { type Frame, type Page } from '@playwright/test'

import {
  BROWSER_IDLE_DISCARD_GRACE_MS,
  DesktopBrowserBatchSchema,
  DesktopSessionResponseSchema,
  DesktopStatusResponseSchema,
  DESKTOP_SCREEN,
  FocusBrowserOwnerResultSchema,
  SessionCreateResponseSchema,
  browserOwnerKey,
  type BrowserOwner,
  type DesktopSessionResponse,
  type DesktopStatusResponse,
} from '@repo/contract'

import { provisionStagingAgent } from './staging-live-agent-fixture.ts'
import { deleteStagingSession, waitForSessionHistory } from './staging-live-agent-sessions.ts'
import { assertNoCredentialArtifacts, redactArtifactValue } from './staging-live-artifacts.ts'
import {
  runBrowserHumanHandoff,
  type BrowserHumanHandoffEvidence,
} from './staging-live-browser-human-handoff.ts'
import { markExpectedBrowserTransition, navigateDeployedPage } from './staging-live-browser.ts'
import { fnQuery } from './staging-live-env.ts'
import { apiJson, bearer, bearerJson, stagingFetch } from './staging-live-http.ts'
import {
  assertPublicDesktopAdmissionExpiry,
  startPublicDesktopAcceptance,
} from './staging-live-public-desktop.ts'
import { workspaceIsDeleted } from './staging-live-resource-ledger.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'

const DESKTOP_WAIT_MS = 180_000
const AGENT_BROWSER_WAIT_MS = 360_000
const POLL_MS = 1_000

interface ManagedBrowserInventory {
  windows: Array<{ owner: BrowserOwner; chromeWindowId: number }>
  batches: Array<{
    batchId: string
    owner: BrowserOwner
    tabs: Array<{ logicalTabId: string; discarded?: boolean; tabId?: number; targetId?: string }>
  }>
}

export function summarizeManagedBrowserInventory(
  inventory: ManagedBrowserInventory,
): Record<string, { windowId: number; batchCount: number; batchTabCount: number }> {
  return Object.fromEntries(
    inventory.windows.map(window => {
      const key = browserOwnerKey(window.owner)
      const batches = inventory.batches.filter(batch => browserOwnerKey(batch.owner) === key)
      return [
        key,
        {
          windowId: window.chromeWindowId,
          batchCount: batches.length,
          batchTabCount: batches.reduce((count, batch) => count + batch.tabs.length, 0),
        },
      ]
    }),
  )
}

export function activeTargetInWindow(value: unknown, windowId: number): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const snapshot = (value as { snapshot?: unknown }).snapshot
  if (typeof snapshot !== 'object' || snapshot === null) return undefined
  const windows = (snapshot as { windows?: unknown }).windows
  if (!Array.isArray(windows)) return undefined
  const window = windows.find(
    candidate =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as { windowId?: unknown }).windowId === windowId,
  ) as { tabs?: unknown } | undefined
  if (!Array.isArray(window?.tabs)) return undefined
  const active = window.tabs.find(
    tab => typeof tab === 'object' && tab !== null && (tab as { active?: unknown }).active === true,
  ) as { targetId?: unknown } | undefined
  return typeof active?.targetId === 'string' ? active.targetId : undefined
}

export interface AgentBrowserWindowsEvidence {
  workspaceRoute: string
  screen: typeof DESKTOP_SCREEN
  connectingObserved: true
  letterboxed: true
  ownerWindows: Record<string, { windowId: number; batchCount: number; batchTabCount: number }>
  sharedCookieObserved: true
  exactFocusObserved: true
  idempotentFocusObserved: true
  discardObserved: true
  deletedOwnerRemoved: true
  credentiallessStatus: 401
  expiredStatus: 401
  publicApi: {
    responseKeys: string[]
    phase: string
    screen: { width: number; height: number }
    correctOriginInteractive: true
    wrongOriginRefused: true
    admittedViewerSurvivedExpiry: true
  }
  humanHandoff: BrowserHumanHandoffEvidence
  screenshots: string[]
}

export async function runAgentBrowserWindowsJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<AgentBrowserWindowsEvidence>> {
  const result = await runWorkspaceBrowserJourney({
    journey: 'agent-browser-windows',
    label: 'Agent browser windows',
    onProgress: options.onProgress,
    run: runAgentBrowserWindowsAcceptance,
  })
  await assertNoCredentialArtifacts(result.artifactDirectory)
  return result
}

export async function runAgentBrowserWindowsAcceptance(
  context: WorkspaceBrowserJourneyContext,
): Promise<AgentBrowserWindowsEvidence> {
  const { page, env, workspace, apiToken, runId, ledger, convex, artifacts, progress } = context
  await page.setViewportSize({ width: 1600, height: 1100 })
  const workspaceRoute = `/w/${workspace.slug}/agents/root/desktop`
  const suffix = runId.slice(-8).toLowerCase()
  const alphaSlug = `browser-alpha-${suffix}`
  const betaSlug = `browser-beta-${suffix}`

  progress('agent-browser-windows:1-cold-start')
  await page.route(
    `**/api/duet/ws/${encodeURIComponent(workspace.slug)}/desktop/session`,
    async route => {
      await Bun.sleep(750)
      await route.continue()
    },
    { times: 1 },
  )
  markExpectedBrowserTransition(page)
  const navigation = navigateDeployedPage(page, `${env.appUrl}${workspaceRoute}`)
  await page.getByText('Connecting to the desktop', { exact: true }).waitFor({
    state: 'visible',
    timeout: 30_000,
  })
  await navigation
  const workspaceFrame = await waitForDesktopFrame(page)
  await waitForDesktopPixels(workspaceFrame)
  const geometry = await readDesktopGeometry(page)
  assert(isLetterboxedDesktop(geometry), `desktop was not letterboxed: ${JSON.stringify(geometry)}`)

  const issued = await mintBrowserDesktopSession(page, workspace.slug)
  const credentialless = await stagingFetch(credentiallessDesktopUrl(issued.entryUrl), {
    redirect: 'manual',
  })
  assert.equal(credentialless.status, 401, 'credential-free desktop URL was not refused')

  progress('agent-browser-windows:2-public-api')
  const publicDesktop = await startPublicDesktopAcceptance(context, waitForDesktopPixels)
  const publicApiEvidence = publicDesktop.evidence
  await assertPublicDesktopAdmissionExpiry(publicDesktop)

  progress('agent-browser-windows:3-agents')
  const alpha = await provisionStagingAgent({
    env,
    workspace,
    apiToken,
    runId,
    slug: alphaSlug,
    name: 'Browser Alpha',
    description: 'Owns the first named browser window in staging acceptance.',
    ledger,
    convex,
    artifacts,
  })
  const beta = await provisionStagingAgent({
    env,
    workspace,
    apiToken,
    runId,
    slug: betaSlug,
    name: 'Browser Beta',
    description: 'Owns the second named browser window in staging acceptance.',
    ledger,
    convex,
    artifacts,
  })
  const connection = await loadDesktopGatewayConnection(context)
  const beforeMissingFocus = await readManagedBrowserInventory(connection)
  const missingFocus = await focusProductOwner(
    context,
    betaSlug,
    crypto.randomUUID(),
    publicDesktop.credentialKey,
  )
  assert.equal(missingFocus.focused, false, 'focus-if-present created the missing beta window')
  assert.deepEqual(
    summarizeManagedBrowserInventory(await readManagedBrowserInventory(connection)),
    summarizeManagedBrowserInventory(beforeMissingFocus),
    'missing focus changed managed browser inventory',
  )

  progress('agent-browser-windows:4-shared-profile')
  const cookieName = `duet_browser_${suffix.replaceAll('-', '_')}`
  const rootReady = `ROOT_BROWSER_${suffix}`
  const rootSessionId = await createBrowserJourneySession(context, {
    label: 'root-cookie',
    prompt: browserCookieSetupPrompt('write', cookieName, runId, rootReady),
  })
  await waitForSuccessfulSession(context, rootSessionId, rootReady)
  const betaReady = `BETA_BROWSER_${suffix}`
  const betaSessionId = await createBrowserJourneySession(context, {
    label: 'beta-cookie',
    cwd: beta.anchorPath,
    expectedAgentId: beta.id,
    prompt: browserCookieSetupPrompt('read', cookieName, runId, betaReady),
  })
  await waitForSuccessfulSession(context, betaSessionId, betaReady)

  progress('agent-browser-windows:5-owner-windows')
  const alphaSessionTwo = await createBrowserJourneySession(context, {
    label: 'alpha-two',
    cwd: alpha.anchorPath,
    expectedAgentId: alpha.id,
    prompt: 'Reply with exactly ALPHA_TWO_READY.',
  })
  await waitForSuccessfulSession(context, alphaSessionTwo, 'ALPHA_TWO_READY')
  await startDirectBrowserBatch(connection, alphaSessionTwo)
  const alphaSessionOne = await createBrowserJourneySession(context, {
    label: 'alpha-one',
    cwd: alpha.anchorPath,
    expectedAgentId: alpha.id,
    prompt: 'Reply with exactly ALPHA_ONE_READY.',
  })
  await waitForSuccessfulSession(context, alphaSessionOne, 'ALPHA_ONE_READY')
  await startDirectBrowserBatch(connection, alphaSessionOne)
  const inventory = await waitForBrowserInventory(connection, candidate => {
    const summary = summarizeManagedBrowserInventory(candidate)
    return (
      (summary.root?.batchCount ?? 0) >= 1 &&
      summary[`agent:${alpha.id}`]?.batchCount === 2 &&
      (summary[`agent:${alpha.id}`]?.batchTabCount ?? 0) >= 2 &&
      (summary[`agent:${beta.id}`]?.batchCount ?? 0) >= 1
    )
  })
  const ownerWindows = summarizeManagedBrowserInventory(inventory)
  assert.notEqual(
    ownerWindows[`agent:${alpha.id}`]?.windowId,
    ownerWindows[`agent:${beta.id}`]?.windowId,
    'distinct agents shared one native Chrome window',
  )

  progress('agent-browser-windows:6-focus')
  assert.equal(
    (await focusProductOwner(context, 'root', crypto.randomUUID(), publicDesktop.credentialKey))
      .focused,
    true,
  )
  await waitForNativeFocusedWindow(connection, ownerWindows.root!.windowId)
  const focusRequestId = crypto.randomUUID()
  assert.equal(
    (await focusProductOwner(context, alphaSlug, focusRequestId, publicDesktop.credentialKey))
      .focused,
    true,
  )
  assert.equal(
    (await focusProductOwner(context, alphaSlug, focusRequestId, publicDesktop.credentialKey))
      .focused,
    true,
  )
  await waitForNativeFocusedWindow(connection, ownerWindows[`agent:${alpha.id}`]!.windowId)
  await waitForDesktopStatus(page, workspace.slug, status =>
    status.owners.some(
      owner => owner.owner.kind === 'agent' && owner.owner.agentId === alpha.id && owner.focused,
    ),
  )
  assert.equal(
    (await focusProductOwner(context, betaSlug, crypto.randomUUID(), publicDesktop.credentialKey))
      .focused,
    true,
  )
  await waitForNativeFocusedWindow(connection, ownerWindows[`agent:${beta.id}`]!.windowId)
  const alphaDoorFocus = page.waitForResponse(response => {
    const request = response.request()
    return (
      request.method() === 'POST' &&
      new URL(response.url()).pathname.endsWith(
        `/agents/${encodeURIComponent(alphaSlug)}/desktop/focus`,
      )
    )
  })
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${env.appUrl}/w/${workspace.slug}/agents/${alphaSlug}/desktop`)
  assert.equal((await alphaDoorFocus).status(), 200, 'agent Desktop focus mutation failed')
  const alphaFrame = await waitForDesktopFrame(page)
  await waitForDesktopPixels(alphaFrame)
  await waitForNativeFocusedWindow(connection, ownerWindows[`agent:${alpha.id}`]!.windowId)
  await waitForDesktopStatus(page, workspace.slug, status =>
    status.owners.some(
      owner => owner.owner.kind === 'agent' && owner.owner.agentId === alpha.id && owner.focused,
    ),
  )
  await waitForProductFocusedOwner(page, 'Browser Alpha')

  const alphaProductScreenshot = path.join(artifacts.directory, 'agent-browser-alpha-product.png')
  const alphaFramebufferScreenshot = path.join(
    artifacts.directory,
    'agent-browser-alpha-framebuffer.png',
  )
  await page.screenshot({ path: alphaProductScreenshot, fullPage: true, animations: 'disabled' })
  await screenshotDesktopFrame(alphaFrame, alphaFramebufferScreenshot)

  progress('agent-browser-windows:7-discard')
  assert.equal((await focusProductOwner(context, betaSlug, crypto.randomUUID())).focused, true)
  await waitForNativeFocusedWindow(connection, ownerWindows[`agent:${beta.id}`]!.windowId)
  await waitForDesktopStatus(page, workspace.slug, status =>
    status.owners.some(
      owner => owner.owner.kind === 'agent' && owner.owner.agentId === beta.id && owner.focused,
    ),
  )
  await waitForProductFocusedOwner(page, 'Browser Beta')
  const betaProductScreenshot = path.join(artifacts.directory, 'agent-browser-beta-product.png')
  const betaFramebufferScreenshot = path.join(
    artifacts.directory,
    'agent-browser-beta-framebuffer.png',
  )
  await page.screenshot({ path: betaProductScreenshot, fullPage: true, animations: 'disabled' })
  await screenshotDesktopFrame(alphaFrame, betaFramebufferScreenshot)
  const humanHandoff = await runBrowserHumanHandoff(context, {
    owner: { agentId: beta.id, slug: betaSlug, anchorPath: beta.anchorPath },
    windowId: ownerWindows[`agent:${beta.id}`]!.windowId,
    readInventory: async () => await readManagedBrowserInventory(connection),
    waitForInventory: async predicate => await waitForBrowserInventory(connection, predicate),
    readActiveTarget: async windowId => await readActiveTargetInWindow(connection, windowId),
    createSession: async args =>
      await createBrowserJourneySession(context, { ...args, expectedAgentId: beta.id }),
  })
  const discarded = await waitForDesktopStatus(
    page,
    workspace.slug,
    status =>
      status.owners.some(
        owner =>
          owner.owner.kind === 'agent' &&
          owner.owner.agentId === alpha.id &&
          owner.phase === 'idle' &&
          owner.discardedBatchTabCount > 0,
      ),
    BROWSER_IDLE_DISCARD_GRACE_MS + 45_000,
  )
  assert(
    discarded.owners.some(
      owner =>
        owner.owner.kind === 'agent' &&
        owner.owner.agentId === alpha.id &&
        owner.discardedBatchTabCount > 0,
    ),
    'background alpha window did not discard a batch tab',
  )

  progress('agent-browser-windows:9-delete')
  await apiJson(
    `${env.apiUrl}/v1/ws/${workspace.slug}/agents/${alphaSlug}`,
    { method: 'DELETE', headers: bearer(apiToken) },
    200,
    'delete browser alpha agent',
    artifacts,
  )
  await waitForBrowserInventory(
    connection,
    candidate =>
      !candidate.windows.some(window => browserOwnerKey(window.owner) === `agent:${alpha.id}`),
  )

  progress('agent-browser-windows:10-expired-token')
  const remainingMs = issued.expiresAt - Date.now() + 1_000
  if (remainingMs > 0) await Bun.sleep(remainingMs)
  const expired = await stagingFetch(issued.entryUrl, { redirect: 'manual' })
  assert.equal(expired.status, 401, 'expired desktop URL was not refused')

  const evidence: AgentBrowserWindowsEvidence = {
    workspaceRoute,
    screen: issued.screen,
    connectingObserved: true,
    letterboxed: true,
    ownerWindows,
    sharedCookieObserved: true,
    exactFocusObserved: true,
    idempotentFocusObserved: true,
    discardObserved: true,
    deletedOwnerRemoved: true,
    credentiallessStatus: 401,
    expiredStatus: 401,
    publicApi: {
      responseKeys: publicApiEvidence.responseKeys,
      phase: publicApiEvidence.phase,
      screen: publicApiEvidence.screen,
      correctOriginInteractive: true,
      wrongOriginRefused: true,
      admittedViewerSurvivedExpiry: true,
    },
    humanHandoff,
    screenshots: [
      path.basename(alphaProductScreenshot),
      path.basename(alphaFramebufferScreenshot),
      path.basename(betaProductScreenshot),
      path.basename(betaFramebufferScreenshot),
    ],
  }
  await artifacts.writeJson('agent-browser-windows.json', evidence)
  return evidence
}

interface DesktopGatewayConnection {
  httpsUrl: string
  vmToken: string
}

async function loadDesktopGatewayConnection(
  context: WorkspaceBrowserJourneyContext,
): Promise<DesktopGatewayConnection> {
  const connection = (await context.convex.query(
    fnQuery('domains/workspaces/provisioning:gatewayConnectionBySlug'),
    { internalKey: context.env.internalKey, slug: context.workspace.slug },
  )) as DesktopGatewayConnection | { refusal: 'paused' } | null
  assert(connection !== null && !('refusal' in connection), 'workspace gateway was unavailable')
  return connection
}

async function readManagedBrowserInventory(
  connection: DesktopGatewayConnection,
): Promise<ManagedBrowserInventory> {
  const response = await stagingFetch(
    `${connection.httpsUrl.replace(/\/+$/, '')}/v1/desktop/browser/windows/inventory`,
    { headers: bearer(connection.vmToken) },
  )
  assert.equal(response.status, 200, 'browser inventory request failed')
  const body = (await response.json()) as ManagedBrowserInventory
  assert(Array.isArray(body.windows), 'browser inventory omitted windows')
  assert(Array.isArray(body.batches), 'browser inventory omitted batches')
  return body
}

async function waitForBrowserInventory(
  connection: DesktopGatewayConnection,
  predicate: (inventory: ManagedBrowserInventory) => boolean,
  timeoutMs = DESKTOP_WAIT_MS,
): Promise<ManagedBrowserInventory> {
  const deadline = Date.now() + timeoutMs
  let latest: ManagedBrowserInventory | undefined
  for (;;) {
    latest = await readManagedBrowserInventory(connection)
    if (predicate(latest)) return latest
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for browser inventory: ${JSON.stringify(summarizeManagedBrowserInventory(latest))}`,
      )
    }
    await Bun.sleep(POLL_MS)
  }
}

async function startDirectBrowserBatch(
  connection: DesktopGatewayConnection,
  sessionId: string,
): Promise<{
  batchId: string
  targetId: string
  owner: BrowserOwner
  webSocketDebuggerUrl: string
}> {
  const response = await stagingFetch(
    `${connection.httpsUrl.replace(/\/+$/, '')}/v1/desktop/browser/batches`,
    {
      method: 'POST',
      headers: bearer(connection.vmToken, { 'content-type': 'application/json' }),
      body: JSON.stringify({ sessionId }),
    },
  )
  assert.equal(response.status, 200, 'direct browser batch start failed')
  const batch = DesktopBrowserBatchSchema.parse(await response.json())
  return {
    batchId: batch.batchId,
    targetId: batch.targetId,
    owner: batch.owner,
    webSocketDebuggerUrl: batch.webSocketDebuggerUrl,
  }
}

async function focusProductOwner(
  context: WorkspaceBrowserJourneyContext,
  agentSlug: string,
  requestId: string,
  credential = context.apiToken,
): Promise<{ focused: boolean }> {
  return FocusBrowserOwnerResultSchema.parse(
    await apiJson(
      `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/agents/${agentSlug}/desktop/focus`,
      {
        method: 'POST',
        headers: bearerJson(credential),
        body: JSON.stringify({ requestId }),
      },
      200,
      'focus managed browser owner',
      context.artifacts,
    ),
  )
}

async function waitForNativeFocusedWindow(
  connection: DesktopGatewayConnection,
  windowId: number,
): Promise<void> {
  const deadline = Date.now() + DESKTOP_WAIT_MS
  let latest: unknown
  for (;;) {
    const response = await stagingFetch(
      `${connection.httpsUrl.replace(/\/+$/, '')}/v1/desktop/browser-extension/status`,
      { headers: bearer(connection.vmToken) },
    )
    if (response.status === 200) {
      latest = await response.json()
      const windows = extensionWindows(latest)
      if (windows.some(window => window.windowId === windowId && window.focused)) return
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for native Chrome focus: ${JSON.stringify(latest)}`)
    }
    await Bun.sleep(POLL_MS)
  }
}

async function readActiveTargetInWindow(
  connection: DesktopGatewayConnection,
  windowId: number,
): Promise<string | undefined> {
  const response = await stagingFetch(
    `${connection.httpsUrl.replace(/\/+$/, '')}/v1/desktop/browser-extension/status`,
    { headers: bearer(connection.vmToken) },
  )
  assert.equal(response.status, 200, 'browser extension snapshot request failed')
  return activeTargetInWindow(await response.json(), windowId)
}

async function waitForProductFocusedOwner(page: Page, ownerName: string): Promise<void> {
  await page.getByLabel(`${ownerName} browser window is focused`, { exact: true }).waitFor({
    state: 'visible',
    timeout: DESKTOP_WAIT_MS,
  })
}

function extensionWindows(value: unknown): Array<{ windowId: number; focused: boolean }> {
  if (typeof value !== 'object' || value === null) return []
  const snapshot = (value as { snapshot?: unknown }).snapshot
  if (typeof snapshot !== 'object' || snapshot === null) return []
  const windows = (snapshot as { windows?: unknown }).windows
  if (!Array.isArray(windows)) return []
  return windows.filter(
    (window): window is { windowId: number; focused: boolean } =>
      typeof window === 'object' &&
      window !== null &&
      typeof (window as { windowId?: unknown }).windowId === 'number' &&
      typeof (window as { focused?: unknown }).focused === 'boolean',
  )
}

async function createBrowserJourneySession(
  context: WorkspaceBrowserJourneyContext,
  args: { label: string; prompt: string; cwd?: string; expectedAgentId?: string },
): Promise<string> {
  const deadline = Date.now() + DESKTOP_WAIT_MS
  let attempt = 0
  for (;;) {
    attempt += 1
    const created = SessionCreateResponseSchema.parse(
      await apiJson(
        `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/agent/sessions`,
        {
          method: 'POST',
          headers: bearerJson(context.apiToken),
          body: JSON.stringify({
            prompt: args.prompt,
            ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
          }),
        },
        201,
        `agent browser session ${args.label} attempt ${attempt}`,
        context.artifacts,
      ),
    )
    const sessionId = created.session.sessionId
    context.ledger.record({
      kind: 'session',
      id: sessionId,
      label: `${context.runId}:agent-browser:${args.label}:${sessionId}`,
      cleanup: async () =>
        await deleteStagingSession(
          context.env,
          context.workspace.slug,
          sessionId,
          context.apiToken,
        ),
      verify: async () =>
        await workspaceIsDeleted(context.convex, context.env.internalKey, context.workspace._id),
    })
    if (args.expectedAgentId === undefined || created.snapshot.agent?.id === args.expectedAgentId) {
      return sessionId
    }
    await deleteStagingSession(context.env, context.workspace.slug, sessionId, context.apiToken)
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${args.label} session ownership: expected ${args.expectedAgentId}, received ${created.snapshot.agent?.id ?? 'root'}`,
      )
    }
    await Bun.sleep(POLL_MS)
  }
}

async function waitForSuccessfulSession(
  context: WorkspaceBrowserJourneyContext,
  sessionId: string,
  marker: string,
): Promise<void> {
  const history = await waitForSessionHistory(
    context.env,
    context.workspace.slug,
    sessionId,
    context.apiToken,
    candidate => candidate.events.some(row => row.event.type === 'complete'),
    AGENT_BROWSER_WAIT_MS,
  )
  const completed = history.events.findLast(row => row.event.type === 'complete')
  assert(completed?.event.type === 'complete', 'browser session did not complete')
  const result = completed.event.result
  if (typeof result !== 'string') throw new Error('browser session returned no text result')
  assert(result.includes(marker), `browser session omitted ${marker}: ${result}`)
}

async function screenshotDesktopFrame(frame: Frame, outputPath: string): Promise<void> {
  await frame
    .locator('#noVNC_container canvas[width="1440"][height="900"]')
    .first()
    .screenshot({ path: outputPath, animations: 'disabled' })
}

export function credentiallessDesktopUrl(entryUrl: string): string {
  const url = new URL(entryUrl)
  const prefix = '/v1/desktop/'
  if (!url.pathname.startsWith(prefix)) throw new Error('Desktop entry URL has an invalid path')
  const credential = url.pathname.slice(prefix.length).split('/', 1)[0]
  const separator = credential?.lastIndexOf('.') ?? -1
  if (credential === undefined || separator <= 0) {
    throw new Error('Desktop entry URL omitted its credential')
  }
  url.pathname = `${prefix}${credential.slice(0, separator)}/`
  url.search = ''
  url.hash = ''
  return url.toString()
}

export function browserCookieSetupPrompt(
  mode: 'write' | 'read',
  cookieName: string,
  cookieValue: string,
  replyMarker: string,
): string {
  const script = [
    'import json, subprocess',
    'from playwright.sync_api import sync_playwright',
    `MODE = ${JSON.stringify(mode)}`,
    `COOKIE_NAME = ${JSON.stringify(cookieName)}`,
    `COOKIE_VALUE = ${JSON.stringify(cookieValue)}`,
    "handle = json.loads(subprocess.check_output(['duet-browser'], text=True))",
    'with sync_playwright() as playwright:',
    "    browser = playwright.chromium.connect_over_cdp(handle['webSocketDebuggerUrl'])",
    '    page = None',
    '    for context in browser.contexts:',
    '        for candidate in context.pages:',
    '            cdp = context.new_cdp_session(candidate)',
    "            target_id = cdp.send('Target.getTargetInfo')['targetInfo']['targetId']",
    '            cdp.detach()',
    "            if target_id == handle['targetId']:",
    '                page = candidate',
    '                break',
    '        if page is not None:',
    '            break',
    "    if page is None: raise RuntimeError('exact browser target missing')",
    '    context = page.context',
    "    if MODE == 'write':",
    "        context.add_cookies([{'name': COOKIE_NAME, 'value': COOKIE_VALUE, 'domain': 'example.com', 'path': '/'}])",
    "        page.set_content('<h1>ROOT BROWSER ' + COOKIE_VALUE + '</h1>')",
    '    else:',
    "        cookies = context.cookies('https://example.com')",
    "        if not any(item['name'] == COOKIE_NAME and item['value'] == COOKIE_VALUE for item in cookies):",
    "            raise RuntimeError('shared cookie mismatch')",
    "        page.set_content('<h1>SHARED COOKIE ' + COOKIE_VALUE + '</h1>')",
    '    page.bring_to_front()',
    '    browser.close()',
  ].join('\n')
  return [
    'Run the following shell command exactly once. Do not substitute another browser approach or add exploratory steps.',
    "python3 - <<'PY'",
    script,
    'PY',
    `Reply with exactly ${replyMarker} only if the command exits successfully.`,
  ].join('\n')
}

interface Size {
  width: number
  height: number
}

export function isLetterboxedDesktop(args: {
  host: Size
  rendered: Size
  intrinsic: Size
  offset: { x: number; y: number }
}): boolean {
  const fixedSurface =
    args.intrinsic.width === DESKTOP_SCREEN.width && args.intrinsic.height === DESKTOP_SCREEN.height
  const renderedRatio = args.rendered.width / args.rendered.height
  const intrinsicRatio = args.intrinsic.width / args.intrinsic.height
  const aspectPreserved = Math.abs(renderedRatio - intrinsicRatio) < 0.001
  const fits =
    args.rendered.width <= args.host.width + 1 && args.rendered.height <= args.host.height + 1
  const padded =
    args.host.width - args.rendered.width > 1 || args.host.height - args.rendered.height > 1
  const centered =
    Math.abs(args.offset.x - (args.host.width - args.rendered.width) / 2) <= 1 &&
    Math.abs(args.offset.y - (args.host.height - args.rendered.height) / 2) <= 1
  return fixedSurface && aspectPreserved && fits && padded && centered
}

async function mintBrowserDesktopSession(
  page: Page,
  workspaceSlug: string,
): Promise<DesktopSessionResponse> {
  const embedOrigin = await page.evaluate(() => window.location.origin)
  const response = await browserJson(
    page,
    `/api/duet/ws/${workspaceSlug}/desktop/session`,
    'POST',
    { embedOrigin },
  )
  assert.equal(response.status, 200, 'browser desktop mint failed')
  return DesktopSessionResponseSchema.parse(response.body)
}

async function waitForDesktopStatus(
  page: Page,
  workspaceSlug: string,
  predicate: (status: DesktopStatusResponse) => boolean,
  timeoutMs = DESKTOP_WAIT_MS,
): Promise<DesktopStatusResponse> {
  const deadline = Date.now() + timeoutMs
  let latest: DesktopStatusResponse | undefined
  for (;;) {
    const response = await browserJson(page, `/api/duet/ws/${workspaceSlug}/desktop/status`)
    assert.equal(response.status, 200, 'browser desktop status failed')
    latest = DesktopStatusResponseSchema.parse(response.body)
    if (predicate(latest)) return latest
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for desktop status: ${JSON.stringify(latest)}`)
    }
    await Bun.sleep(POLL_MS)
  }
}

async function browserJson(
  page: Page,
  requestPath: string,
  method = 'GET',
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return await page.evaluate(
    async ({ requestPath, method, body }) => {
      const response = await fetch(requestPath, {
        method,
        cache: 'no-store',
        ...(body === undefined
          ? {}
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
      })
      return { status: response.status, body: await response.json() }
    },
    { requestPath, method, body },
  )
}

async function waitForDesktopFrame(page: Page): Promise<Frame> {
  const deadline = Date.now() + DESKTOP_WAIT_MS
  for (;;) {
    const frame = page.frames().find(candidate => candidate.url().includes('/v1/desktop/'))
    if (frame !== undefined) return frame
    if (Date.now() >= deadline) {
      const diagnostic = await page.evaluate(() => ({
        body: document.body.innerText.slice(0, 2_000),
        iframes: Array.from(document.querySelectorAll('iframe'), iframe => iframe.src),
      }))
      throw new Error(
        `Timed out waiting for the desktop iframe: ${JSON.stringify(
          redactArtifactValue(
            { ...diagnostic, frames: page.frames().map(candidate => candidate.url()) },
            [],
          ),
        )}`,
      )
    }
    await Bun.sleep(250)
  }
}

interface FramebufferProbe {
  signature: number[]
  distinct: number
}

async function waitForDesktopPixels(frame: Frame): Promise<FramebufferProbe> {
  const deadline = Date.now() + DESKTOP_WAIT_MS
  let latest: FramebufferProbe | undefined
  for (;;) {
    latest = await probeDesktopPixels(frame)
    if (latest !== undefined && latest.distinct >= 8) return latest
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for desktop pixels: ${JSON.stringify(latest)}`)
    }
    await Bun.sleep(500)
  }
}

async function probeDesktopPixels(frame: Frame): Promise<FramebufferProbe | undefined> {
  return await frame.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '#noVNC_container canvas[width="1440"][height="900"]',
    )
    const context = canvas?.getContext('2d')
    if (canvas === null || canvas === undefined || context === null || context === undefined) {
      return undefined
    }
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    const signature: number[] = []
    const colors = new Set<string>()
    for (let row = 1; row <= 8; row += 1) {
      for (let column = 1; column <= 12; column += 1) {
        const x = Math.floor((column * canvas.width) / 13)
        const y = Math.floor((row * canvas.height) / 9)
        const offset = (y * canvas.width + x) * 4
        const sample = [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!]
        signature.push(...sample)
        colors.add(sample.join(','))
      }
    }
    return { signature, distinct: colors.size }
  })
}

async function readDesktopGeometry(page: Page): Promise<{
  host: Size
  rendered: Size
  intrinsic: Size
  offset: { x: number; y: number }
}> {
  return await page.locator('iframe[width="1440"][height="900"]').evaluate(element => {
    const frame = element as HTMLIFrameElement
    const rendered = frame.getBoundingClientRect()
    const host = frame.parentElement?.parentElement?.getBoundingClientRect()
    if (host === undefined) throw new Error('Desktop iframe host was missing')
    return {
      host: { width: host.width, height: host.height },
      rendered: { width: rendered.width, height: rendered.height },
      intrinsic: { width: Number(frame.width), height: Number(frame.height) },
      offset: { x: rendered.left - host.left, y: rendered.top - host.top },
    }
  })
}
