import assert from 'node:assert/strict'
import path from 'node:path'

import { type Browser, type Page } from '@playwright/test'
import type { ConvexHttpClient } from 'convex/browser'

import {
  AppListResponseSchema,
  AppResponseSchema,
  IncomingShareResponseSchema,
  ROOT_AGENT_SCOPE,
  ShareResponseSchema,
  WhoamiResponseSchema,
  normalizeDrivePath,
  type App,
} from '@repo/contract'
import { shellQuote } from '@repo/exe'

import {
  runAppApiKeyAcceptance,
  type AppApiKeyAcceptanceEvidence,
} from './staging-live-app-api-keys.ts'
import type { StagingArtifactCollector } from './staging-live-artifacts.ts'
import {
  recordMailboxMessageCleanup,
  waitForBrowserMagicLink,
} from './staging-live-browser-acceptance.ts'
import { waitForFinishedBrowserResponse } from './staging-live-browser-response.ts'
import {
  attachBrowserDiagnostics,
  installStagingProtection,
  markExpectedBrowserTransition,
  navigateDeployedPage,
} from './staging-live-browser.ts'
import {
  fnMutation,
  fnQuery,
  SHARE_JOURNEY_LEGS,
  type LiveEnv,
  type Workspace,
} from './staging-live-env.ts'
import {
  apiJson,
  apiText,
  assertResponse,
  bearer,
  bearerJson,
  stagingFetch,
} from './staging-live-http.ts'
import { waitForBrowserSessionCredential } from './staging-live-invite.ts'
import { waitForMailboxLink } from './staging-live-mailbox.ts'
import { waitForHydratedMagicLinkControls } from './staging-live-public-site.ts'
import {
  recordWorkspaceCleanup,
  type StagingResourceLedger,
  workspaceIsDeleted,
} from './staging-live-resource-ledger.ts'
import { waitForSharedFileBytes } from './staging-live-share.ts'
import { assertWorkspaceCanBecomeActive, waitForWorkspace } from './staging-live-streaming.ts'

type ShareRecord = {
  id: string
  state: string
  mountPath?: string
  toWorkspaceId?: string
}

type JourneyLeg = (typeof SHARE_JOURNEY_LEGS)[number]

export const SHARE_INVITE_SUBJECT = /shared “.+” with you/i

// A replica installs and boots on the recipient's own VM, which is slower than a
// metadata round trip; visibility changes only need the edge to observe them.
const REPLICA_RUNTIME_BUDGET_MS = 240_000
const APP_VISIBILITY_BUDGET_MS = 60_000

export interface ShareJourneyResult {
  recipientVmName: string
  fileArrivalMs: number
  moveMs: number
  reverseMs: number
  passedLegs: JourneyLeg[]
  appApiKeys: AppApiKeyAcceptanceEvidence
}

export async function runShareJourneyAcceptance(args: {
  env: LiveEnv
  browser: Browser
  ownerPage: Page
  ownerApiToken: string
  ownerUserId: string
  recipientEmail: string
  ownerWorkspace: Workspace
  appSlug: string
  runId: string
  startedAt: number
  convex: ConvexHttpClient
  ledger: StagingResourceLedger
  artifacts: StagingArtifactCollector
  output: { vmNames: string[] }
  progress: (stage: string) => void
}): Promise<ShareJourneyResult> {
  const passedLegs: JourneyLeg[] = []
  const pass = (leg: JourneyLeg) => {
    if (!passedLegs.includes(leg)) passedLegs.push(leg)
  }
  const sourceRoot = `apps/${args.runId}`
  const folderName = args.runId
  const mainSeedName = 'share-journey-main.txt'
  const mainSeedPath = `${sourceRoot}/${mainSeedName}`
  const mainBytes = `two-account share journey ${args.runId}\n`
  recordSyntheticRecipientCleanup(args)

  await writeTrackedFile({
    ...args,
    workspace: args.ownerWorkspace,
    token: args.ownerApiToken,
    filePath: mainSeedPath,
    bytes: mainBytes,
    label: 'main source',
  })

  args.progress('share-journey:owner-ui')
  const mainShare = await createShareFromFilesUi({
    ...args,
    sourceRoot,
    folderName,
  })
  trackShare({ ...args, shareId: mainShare.id })

  const invitation = await waitForMailboxLink({
    apiKey: args.env.agentMailApiKey,
    inboxId: args.env.agentMailInbox2Id,
    expected: {
      after: args.startedAt,
      recipient: args.recipientEmail,
      subject: SHARE_INVITE_SUBJECT,
      runId: args.runId,
    },
  })
  recordMailboxMessageCleanup(
    args.env,
    args.ledger,
    args.runId,
    invitation.messageId,
    args.env.agentMailInbox2Id,
  )
  pass('share-request-email')

  args.progress('share-journey:recipient-signup')
  const recipient = await signUpRecipientFromShareLink({
    ...args,
    shareId: mainShare.id,
    shareLink: invitation.url,
  })
  pass('share-deep-link')
  if (!args.output.vmNames.includes(recipient.workspace.vmName!)) {
    args.output.vmNames.push(recipient.workspace.vmName!)
  }

  args.progress('share-journey:accept')
  const mainAccepted = await acceptShareInBrowser({
    ...args,
    recipientPage: recipient.page,
    shareId: mainShare.id,
    folderName,
    recipientWorkspace: recipient.workspace,
  })
  assert.equal(mainAccepted.mountPath, folderName)
  pass('share-accept')

  args.progress('share-journey:bidirectional-flow')
  const arrival = await waitForSharedFileBytes({
    url: fileUrl(args.env.apiUrl, recipient.workspace.slug, `${folderName}/${mainSeedName}`),
    token: recipient.token,
    expectedBytes: mainBytes,
  })
  const marker = await stagingFetch(
    fileUrl(args.env.apiUrl, recipient.workspace.slug, `${folderName}/.duet-anchor`),
    { headers: bearer(recipient.token) },
  )
  assert.equal(marker.status, 404, 'workspace-local .duet-anchor crossed the share')
  const reverseName = 'recipient-write.txt'
  const reverseBytes = `recipient write ${args.runId}\n`
  const reverseStarted = Date.now()
  await apiText(
    fileUrl(args.env.apiUrl, recipient.workspace.slug, `${folderName}/${reverseName}`),
    {
      method: 'PUT',
      headers: bearer(recipient.token, { 'content-type': 'text/plain' }),
      body: reverseBytes,
    },
    200,
    'recipient write share proof',
    args.artifacts,
  )
  await waitForSharedFileBytes({
    url: fileUrl(args.env.apiUrl, args.ownerWorkspace.slug, `${sourceRoot}/${reverseName}`),
    token: args.ownerApiToken,
    expectedBytes: reverseBytes,
  })
  const reverseMs = Date.now() - reverseStarted
  pass('share-file-arrival')

  args.progress('share-journey:move')
  const relocation = await proveShareRelocation({
    ...args,
    recipient,
    shareId: mainShare.id,
    sourceRoot,
    initialMountRoot: folderName,
    mainSeedName,
    mainSeedPath,
    mainBytes,
  })
  const relocatedRoot = relocation.mountRoot
  const moveMs = relocation.latencyMs
  pass('share-move')

  args.progress('share-journey:transient-miss')
  const transientRoot = `${relocatedRoot}-transient`
  await movePath({
    env: args.env,
    workspaceSlug: recipient.workspace.slug,
    token: recipient.token,
    source: relocatedRoot,
    destination: transientRoot,
    artifacts: args.artifacts,
    label: 'transient share disappearance',
  })
  await Bun.sleep(2_000)
  assert.equal((await loadShare(args, mainShare.id)).state, 'active')
  await movePath({
    env: args.env,
    workspaceSlug: recipient.workspace.slug,
    token: recipient.token,
    source: transientRoot,
    destination: relocatedRoot,
    artifacts: args.artifacts,
    label: 'transient share restoration',
  })
  await waitForSharedFileBytes({
    url: fileUrl(args.env.apiUrl, recipient.workspace.slug, `${relocatedRoot}/${mainSeedName}`),
    token: recipient.token,
    expectedBytes: mainBytes,
  })
  assert.equal((await loadShare(args, mainShare.id)).state, 'active')
  pass('share-transient-miss')

  args.progress('share-journey:read-repair')
  await proveReadShareRepair({ ...args, recipient })
  pass('share-read-repair')

  args.progress('share-journey:nested-link-moves')
  await proveNestedLinkMoves({ ...args, recipient })

  args.progress('share-journey:shared-app')
  const appApiKeys = await proveSharedAppIsUsableAndPublishable({
    ...args,
    recipient,
    shareId: mainShare.id,
    marker: args.runId,
  })
  pass('share-app-viewer')

  args.progress('share-journey:explicit-unlink')
  await apiJson(
    `${args.env.apiUrl}/v1/ws/${encodeURIComponent(recipient.workspace.slug)}/shares/${encodeURIComponent(mainShare.id)}/unlink`,
    {
      method: 'POST',
      headers: bearerJson(recipient.token),
      body: '{}',
    },
    200,
    'explicit share unlink',
    args.artifacts,
  )
  await waitForShareState({
    expectedState: 'unlinked',
    load: async () => await loadShare(args, mainShare.id),
  })
  assert.equal(
    await apiText(
      fileUrl(args.env.apiUrl, recipient.workspace.slug, `${relocatedRoot}/${mainSeedName}`),
      { headers: bearer(recipient.token) },
      200,
      'unlinked files remain',
      args.artifacts,
    ),
    mainBytes,
  )
  await waitForRecipientReplicaState({
    ...args,
    recipientToken: recipient.token,
    recipientWorkspace: recipient.workspace,
    appSlug: args.appSlug,
    sourceShareId: mainShare.id,
    expectedState: 'detached',
  })
  pass('share-explicit-unlink')

  args.progress('share-journey:delete-auto-unlink')
  await proveRecipientDeleteAutoUnlink({ ...args, recipient })
  await proveOriginDeleteAutoUnlink({ ...args, recipient })
  pass('share-delete-auto-unlink')

  args.progress('share-journey:revoke')
  await proveRevokeStopsFlow({ ...args, recipient })
  pass('share-revoke')

  await recipient.context.close()
  return {
    recipientVmName: recipient.workspace.vmName!,
    fileArrivalMs: arrival.latencyMs,
    moveMs,
    reverseMs,
    passedLegs,
    appApiKeys,
  }
}

export async function waitForShareState<T extends { state: string }>(args: {
  expectedState: string
  load: () => Promise<T>
  timeoutMs?: number
  pollMs?: number
  terminalStates?: readonly string[]
  describe?: (value: T) => string
  sleep?: (milliseconds: number) => Promise<unknown>
  now?: () => number
}): Promise<T> {
  const timeoutMs = args.timeoutMs ?? 180_000
  const pollMs = args.pollMs ?? 2_000
  const sleep = args.sleep ?? Bun.sleep
  const now = args.now ?? Date.now
  const deadline = now() + timeoutMs

  for (;;) {
    const share = await args.load()
    if (share.state === args.expectedState) return share
    const description = args.describe?.(share)
    if (args.terminalStates?.includes(share.state) === true) {
      throw new Error(
        `Share reached terminal state ${share.state} while waiting for ${args.expectedState}${description === undefined ? '' : ` (${description})`}`,
      )
    }
    if (now() >= deadline) {
      throw new Error(
        `Timed out waiting ${timeoutMs}ms for share state ${args.expectedState}${description === undefined ? '' : ` (${description})`}`,
      )
    }
    await sleep(pollMs)
  }
}

export async function waitForShareMountPruned(args: {
  shareId: string
  gateways: readonly [{ httpsUrl: string; vmToken: string }, { httpsUrl: string; vmToken: string }]
  timeoutMs?: number
  pollMs?: number
  fetchImpl?: typeof stagingFetch
  sleep?: (milliseconds: number) => Promise<unknown>
  now?: () => number
}): Promise<void> {
  const folderId = `share-${args.shareId}`
  const timeoutMs = args.timeoutMs ?? 180_000
  const pollMs = args.pollMs ?? 2_000
  const fetchImpl = args.fetchImpl ?? stagingFetch
  const sleep = args.sleep ?? Bun.sleep
  const now = args.now ?? Date.now
  const deadline = now() + timeoutMs

  let lastObservationError: unknown
  for (;;) {
    // VM gateway probes ride the exe proxy from inside the harness container;
    // a refused connection or proxy error is a retryable tick, not a verdict.
    const mountIds = await Promise.all(
      args.gateways.map(async gateway => {
        const response = await fetchImpl(`${gateway.httpsUrl.replace(/\/+$/, '')}/v1/sync/mounts`, {
          headers: bearer(gateway.vmToken),
        })
        assertResponse(response, 200, 'share mount registry observation')
        return syncMountIds(await response.json())
      }),
    ).catch((error: unknown) => {
      lastObservationError = error
      return undefined
    })
    if (mountIds !== undefined && mountIds.every(ids => !ids.includes(folderId))) return
    if (now() >= deadline) {
      throw new Error(
        `Timed out waiting ${timeoutMs}ms for share mount ${folderId} to be pruned${
          lastObservationError === undefined
            ? ''
            : ` (last observation error: ${String(lastObservationError)})`
        }`,
      )
    }
    await sleep(pollMs)
  }
}

function syncMountIds(value: unknown): string[] {
  assert(typeof value === 'object' && value !== null, 'share mount registry was not an object')
  const mounts = (value as { mounts?: unknown }).mounts
  assert(Array.isArray(mounts), 'share mount registry did not contain mounts')
  return mounts.map(mount => {
    assert(typeof mount === 'object' && mount !== null, 'share mount entry was not an object')
    const id = (mount as { id?: unknown }).id
    assert(typeof id === 'string', 'share mount entry did not contain an id')
    return id
  })
}

export function buildMarkerPreservingCopyDeleteCommand(args: {
  driveRoot: string
  source: string
  destination: string
}): string {
  const source = normalizeDrivePath(args.source)
  const destination = normalizeDrivePath(args.destination)
  assert(source.ok, `invalid relocation source path: ${args.source}`)
  assert(destination.ok, `invalid relocation destination path: ${args.destination}`)
  const sourceRoot = path.join(args.driveRoot, source.relativePath)
  const destinationRoot = path.join(args.driveRoot, destination.relativePath)
  return `test ! -e ${shellQuote(destinationRoot)} && test ! -L ${shellQuote(destinationRoot)} && cp -a -- ${shellQuote(sourceRoot)} ${shellQuote(destinationRoot)} && rm -rf -- ${shellQuote(sourceRoot)}`
}

type ExpectedReplicaState = 'absent' | 'attached' | 'detached'
type ReplicaState = ExpectedReplicaState | 'attached-to-other-share' | 'inconsistent'
type JsonRequest = (...args: Parameters<typeof apiJson>) => Promise<unknown>
type Fetch = typeof stagingFetch

export async function registerTrackedShareApp(args: {
  apiUrl: string
  workspace: Workspace
  token: string
  runId: string
  label: string
  sourceRoot: string
  command?: string
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
  internalKey: string
  artifacts: StagingArtifactCollector
  requestJson?: JsonRequest
  fetchImpl?: Fetch
  sleep?: (milliseconds: number) => Promise<unknown>
}): Promise<App> {
  const slug = `share-${args.label}-${args.runId.slice(-8)}`
  const requestJson: JsonRequest =
    args.requestJson ?? (async (...request) => await apiJson(...request))
  const registerOnce = () =>
    requestJson(
      `${args.apiUrl}/v1/ws/${encodeURIComponent(args.workspace.slug)}/apps`,
      {
        method: 'POST',
        headers: bearerJson(args.token),
        body: JSON.stringify({
          path: args.sourceRoot,
          command: args.command ?? 'python3 -m http.server $PORT',
          apiScopes: [],
          slug,
        }),
      },
      201,
      `${args.label} source app register`,
      args.artifacts,
    )
  // Edge app registration occasionally 502s under load; one retry separates
  // the transient from a broken rail (same treatment as the product-api leg).
  const registered = AppResponseSchema.parse(
    await registerOnce().catch(async () => {
      await (args.sleep ?? Bun.sleep)(10_000)
      return await registerOnce()
    }),
  ).app
  const fetchImpl = args.fetchImpl ?? stagingFetch
  const sleep = args.sleep ?? Bun.sleep
  args.ledger.record({
    kind: 'app',
    id: registered.id,
    label: `${args.runId}:share-app:${registered.slug}`,
    cleanup: async () =>
      await deleteTrackedShareApp({
        url: `${args.apiUrl}/v1/ws/${encodeURIComponent(args.workspace.slug)}/apps/${encodeURIComponent(registered.slug)}`,
        token: args.token,
        fetchImpl,
        sleep,
      }),
    verify: async () => {
      if (await workspaceIsDeleted(args.convex, args.internalKey, args.workspace._id)) return true
      const response = await fetchImpl(
        `${args.apiUrl}/v1/ws/${encodeURIComponent(args.workspace.slug)}/apps/${encodeURIComponent(registered.slug)}`,
        { headers: bearer(args.token) },
      )
      await response.arrayBuffer()
      return response.status === 404
    },
  })
  return registered
}

async function deleteTrackedShareApp(args: {
  url: string
  token: string
  fetchImpl: Fetch
  sleep: (milliseconds: number) => Promise<unknown>
}): Promise<void> {
  const transientStatuses = new Set([429, 500, 502, 503, 504])
  const attempts = 3

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response: Response
    try {
      response = await args.fetchImpl(args.url, {
        method: 'DELETE',
        headers: bearer(args.token),
      })
    } catch (error) {
      if (attempt === attempts - 1) throw error
      await args.sleep(1_000 * (attempt + 1))
      continue
    }

    // 401 = the run outlived this user token; the ledger's verify step still
    // proves the resource died with its workspace.
    if (response.status === 200 || response.status === 404 || response.status === 401) return
    await response.arrayBuffer()
    if (!transientStatuses.has(response.status) || attempt === attempts - 1) {
      throw new Error(`share source app cleanup returned HTTP ${response.status}`)
    }
    await args.sleep(1_000 * (attempt + 1))
  }
}

export async function waitForReplicaState(args: {
  appSlug: string
  sourceShareId: string
  expectedState: ExpectedReplicaState
  loadApps: () => Promise<App[]>
  timeoutMs?: number
  pollMs?: number
  sleep?: (milliseconds: number) => Promise<unknown>
  now?: () => number
}): Promise<App | undefined> {
  const result = await waitForShareState({
    expectedState: args.expectedState,
    load: async () => {
      const replica = (await args.loadApps()).find(app => app.slug === args.appSlug)
      return {
        state: replicaState(replica, args.sourceShareId),
        replica,
      }
    },
    timeoutMs: args.timeoutMs,
    pollMs: args.pollMs,
    sleep: args.sleep,
    now: args.now,
  })
  return result.replica
}

function replicaState(app: App | undefined, sourceShareId: string): ReplicaState {
  if (app === undefined) return 'absent'
  if (app.sourceShareId === undefined) {
    return app.sourceAppId === undefined ? 'detached' : 'inconsistent'
  }
  if (app.sourceAppId === undefined) return 'inconsistent'
  return app.sourceShareId === sourceShareId ? 'attached' : 'attached-to-other-share'
}

async function createShareFromFilesUi(
  args: Parameters<typeof runShareJourneyAcceptance>[0] & {
    sourceRoot: string
    folderName: string
  },
): Promise<{ id: string }> {
  const root = `${args.env.appUrl}/w/${args.ownerWorkspace.slug}/files`
  markExpectedBrowserTransition(args.ownerPage)
  await navigateDeployedPage(args.ownerPage, root)
  await args.ownerPage.locator('[data-files-row-key="/apps"]').dblclick()
  const appRow = args.ownerPage.locator(`[data-files-row-key="/${args.sourceRoot}"]`)
  await appRow.waitFor()
  await appRow.locator('button[aria-haspopup="menu"]').click()
  await args.ownerPage.getByRole('menuitem').nth(1).click()
  const dialog = args.ownerPage.locator(`[data-share-dialog="${args.folderName}"]`)
  await dialog.waitFor()
  await dialog.locator('#share-recipient-email').fill(args.recipientEmail)
  await dialog.locator('button[aria-pressed]').nth(1).click()
  const [response] = await Promise.all([
    waitForFinishedBrowserResponse(
      args.ownerPage,
      'POST',
      `/api/duet/ws/${args.ownerWorkspace.slug}/shares`,
    ),
    dialog.locator('button[type="submit"]').click(),
  ])
  const created = ShareResponseSchema.parse(await response.json())
  await args.ownerPage.screenshot({
    path: path.join(args.artifacts.directory, 'share-owner-sent.png'),
    fullPage: true,
  })
  return { id: created.share.id }
}

async function signUpRecipientFromShareLink(
  args: Parameters<typeof runShareJourneyAcceptance>[0] & {
    shareId: string
    shareLink: string
  },
): Promise<{
  context: Awaited<ReturnType<Browser['newContext']>>
  page: Page
  token: string
  workspace: Workspace & { name: string; vmName: string }
}> {
  const context = await args.browser.newContext({ viewport: { width: 1440, height: 900 } })
  await installStagingProtection(context, args.env)
  attachBrowserDiagnostics(context, args.artifacts)
  const page = await context.newPage()
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, args.shareLink)
  await page.waitForURL(
    url => url.pathname === '/sign-in' && url.searchParams.get('shared') === '1',
  )

  const controls = await waitForHydratedMagicLinkControls(page)
  await controls.email.fill(args.recipientEmail)
  const requestedAt = Date.now()
  const [request] = await Promise.all([
    page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/auth/magic-link',
    ),
    controls.submit.click({ noWaitAfter: true }),
  ])
  assert.equal(request.status(), 204, 'recipient sign-up magic link request failed')
  const magicLink = await waitForBrowserMagicLink({
    env: args.env,
    page,
    ledger: args.ledger,
    email: args.recipientEmail,
    inboxId: args.env.agentMailInbox2Id,
    requestedAt,
    runId: args.runId,
    returnTo: '/?shared=1',
  })
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, magicLink)
  const token = await waitForBrowserSessionCredential({
    cookies: async () => await context.cookies(args.env.appUrl),
  })
  const identity = WhoamiResponseSchema.parse(
    await apiJson(
      `${args.env.apiUrl}/v1/whoami`,
      { headers: bearer(token) },
      200,
      'share recipient identity',
      args.artifacts,
    ),
  )
  assert.equal(identity.user.email.toLowerCase(), args.recipientEmail.toLowerCase())
  const seed = identity.workspaces[0]
  assert(seed !== undefined, 'new share recipient did not receive a default workspace')
  recordWorkspaceCleanup({
    ledger: args.ledger,
    convex: args.convex,
    env: args.env,
    output: args.output,
    workspaceId: seed.id,
    slug: seed.slug,
  })
  await args.convex.mutation(
    fnMutation('testing/workspaces:activateSyntheticSubscriptionByEmailForTest'),
    {
      internalKey: args.env.internalKey,
      email: args.recipientEmail,
    },
  )
  await args.convex.mutation(fnMutation('domains/credits/internal:applyLedgerEntry'), {
    internalKey: args.env.internalKey,
    workspaceId: seed.id,
    amountMicroUsd: 10_000_000,
    type: 'grant',
    reference: `grant:staging-share:${crypto.randomUUID()}`,
  })
  const workspace = await waitForWorkspace(args.convex, args.env.internalKey, seed.id, row => {
    assertWorkspaceCanBecomeActive(row)
    return (
      row.status === 'active' &&
      row.vmName !== undefined &&
      row.runtimeVersion === args.ownerWorkspace.runtimeVersion
    )
  })
  assert(workspace.vmName !== undefined)
  /* Past the setup wizard, because a share recipient is a brand new owner and
     every workspace surface is behind it. `onboardingGatePath` redirects an owner
     whose workspace has no `onboardedAt`, so the navigation below landed on
     `/w/<slug>/onboarding` — step 1 of 4, "Name your assistant" — and the accept
     panel it was waiting for was on the other side of it. This run's evidence is
     what said so: the recipient's screen was the wizard and
     `/api/duet/pending-share` answered 204.
     
     Skipped through the product's own endpoint rather than clicked through,
     because the wizard belongs to the agentic-onboarding journey and this one is
     about bytes arriving in someone else's drive. */
  await apiJson(
    `${args.env.apiUrl}/v1/ws/${seed.slug}/onboarding`,
    {
      method: 'POST',
      headers: bearerJson(token),
      body: JSON.stringify({ skip: true, duetName: 'Duet' }),
    },
    200,
    'share recipient onboarding skip',
    args.artifacts,
  )
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(
    page,
    `${args.env.appUrl}/w/${seed.slug}/files?shareRequest=${encodeURIComponent(args.shareId)}`,
  )
  return {
    context,
    page,
    token,
    workspace: { ...workspace, name: seed.name, vmName: workspace.vmName },
  }
}

async function acceptShareInBrowser(
  args: Parameters<typeof runShareJourneyAcceptance>[0] & {
    recipientPage: Page
    shareId: string
    folderName: string
    recipientWorkspace: Workspace
  },
): Promise<{ mountPath?: string }> {
  const panel = args.recipientPage.getByRole('region', {
    name: `Accept shared folder ${args.folderName}`,
  })
  /* The recipient's browser is a second context with no video and no error
     collector, so when this panel does not arrive the run says only that it
     waited. The panel renders for any share in the list, blocked or not, so its
     absence means the list was empty — and the list is the one thing worth
     seeing. Capture what the recipient could see, and what the API told them,
     before giving up on it. */
  try {
    await panel.waitFor()
  } catch (error) {
    await args.recipientPage
      .screenshot({
        path: path.join(args.artifacts.directory, 'share-recipient-no-panel.png'),
        fullPage: true,
      })
      .catch(() => undefined)
    const pending = await args.recipientPage
      .evaluate(async () => {
        const response = await fetch('/api/duet/pending-share')
        return { status: response.status, body: await response.text() }
      })
      .catch(() => undefined)
    await args.artifacts
      .writeJson('share-recipient-no-panel.json', {
        folderName: args.folderName,
        shareId: args.shareId,
        recipientWorkspace: args.recipientWorkspace.slug,
        url: args.recipientPage.url(),
        pending,
      })
      .catch(() => undefined)
    throw error
  }
  await panel.getByRole('button', { name: 'Choose folder', exact: true }).click()
  await panel.getByRole('button', { name: 'Use this folder', exact: true }).click()
  const [response] = await Promise.all([
    waitForFinishedBrowserResponse(
      args.recipientPage,
      'POST',
      `/api/duet/share-requests/${args.shareId}/accept`,
    ),
    panel.getByRole('button', { name: 'Accept & sync', exact: true }).click(),
  ])
  const accepted = IncomingShareResponseSchema.parse(await response.json())
  await args.recipientPage.screenshot({
    path: path.join(args.artifacts.directory, 'share-recipient-accepted.png'),
    fullPage: true,
  })
  return { mountPath: accepted.share.mountPath }
}

async function proveShareRelocation(
  args: Parameters<typeof runShareJourneyAcceptance>[0] & {
    recipient: RecipientIdentity
    shareId: string
    sourceRoot: string
    initialMountRoot: string
    mainSeedName: string
    mainSeedPath: string
    mainBytes: string
  },
): Promise<{ mountRoot: string; latencyMs: number }> {
  const startedAt = Date.now()
  const movedRoot = `${args.initialMountRoot}-moved`
  await movePath({
    env: args.env,
    workspaceSlug: args.recipient.workspace.slug,
    token: args.recipient.token,
    source: args.initialMountRoot,
    destination: movedRoot,
    artifacts: args.artifacts,
    label: 'recipient share mount move',
  })
  await waitForShareMountPath(args, args.shareId, movedRoot)
  await waitForSharedFileBytes({
    url: fileUrl(
      args.env.apiUrl,
      args.recipient.workspace.slug,
      `${movedRoot}/${args.mainSeedName}`,
    ),
    token: args.recipient.token,
    expectedBytes: args.mainBytes,
  })

  const relocatedRoot = `${movedRoot}-relocated`
  await runMarkerPreservingCopyDeleteFixture({
    ...args,
    source: movedRoot,
    destination: relocatedRoot,
  })
  await waitForShareMountPath(args, args.shareId, relocatedRoot)
  await waitForSharedFileBytes({
    url: fileUrl(
      args.env.apiUrl,
      args.recipient.workspace.slug,
      `${relocatedRoot}/${args.mainSeedName}`,
    ),
    token: args.recipient.token,
    expectedBytes: args.mainBytes,
  })
  assert.equal(
    await apiText(
      fileUrl(args.env.apiUrl, args.ownerWorkspace.slug, args.mainSeedPath),
      { headers: bearer(args.ownerApiToken) },
      200,
      'origin survives marker relocation',
      args.artifacts,
    ),
    args.mainBytes,
  )

  const reverseName = 'recipient-write-after-relocation.txt'
  const reverseBytes = `recipient write after relocation ${args.runId}\n`
  await apiText(
    fileUrl(args.env.apiUrl, args.recipient.workspace.slug, `${relocatedRoot}/${reverseName}`),
    {
      method: 'PUT',
      headers: bearer(args.recipient.token, { 'content-type': 'text/plain' }),
      body: reverseBytes,
    },
    200,
    'recipient write after marker relocation',
    args.artifacts,
  )
  await waitForSharedFileBytes({
    url: fileUrl(args.env.apiUrl, args.ownerWorkspace.slug, `${args.sourceRoot}/${reverseName}`),
    token: args.ownerApiToken,
    expectedBytes: reverseBytes,
  })
  await assertShareManagementStatus({
    ...args,
    page: args.recipient.page,
    workspaceSlug: args.recipient.workspace.slug,
    direction: 'incoming',
    sharePath: relocatedRoot,
    status: 'upToDate',
    screenshotName: 'share-recipient-healthy.png',
  })
  await assertShareManagementStatus({
    ...args,
    page: args.ownerPage,
    workspaceSlug: args.ownerWorkspace.slug,
    direction: 'outgoing',
    sharePath: args.sourceRoot,
    status: 'upToDate',
    screenshotName: 'share-owner-healthy.png',
  })
  return { mountRoot: relocatedRoot, latencyMs: Date.now() - startedAt }
}

async function runMarkerPreservingCopyDeleteFixture(
  args: Parameters<typeof runShareJourneyAcceptance>[0] & {
    recipient: RecipientIdentity
    source: string
    destination: string
  },
): Promise<void> {
  const controllerRoot = `apps/${args.runId}-share-relocation-fixture`
  await writeTrackedFile({
    ...args,
    workspace: args.recipient.workspace,
    token: args.recipient.token,
    filePath: `${controllerRoot}/index.html`,
    bytes: '<!doctype html><title>Share relocation fixture</title>\n',
    label: 'share relocation fixture',
  })
  const relocation = buildMarkerPreservingCopyDeleteCommand({
    driveRoot: '/home/exedev/drive',
    source: args.source,
    destination: args.destination,
  })
  await registerTrackedShareApp({
    apiUrl: args.env.apiUrl,
    workspace: args.recipient.workspace,
    token: args.recipient.token,
    runId: args.runId,
    label: 'relocation-fixture',
    sourceRoot: controllerRoot,
    command: `${relocation} && python3 -m http.server $PORT`,
    ledger: args.ledger,
    convex: args.convex,
    internalKey: args.env.internalKey,
    artifacts: args.artifacts,
  })
}

async function waitForShareMountPath(
  args: Pick<Parameters<typeof runShareJourneyAcceptance>[0], 'convex' | 'env'>,
  shareId: string,
  mountPath: string,
): Promise<void> {
  await waitForShareState({
    expectedState: 'mounted',
    terminalStates: ['unlinked', 'revoked'],
    load: async () => {
      const share = await loadShare(args, shareId)
      return share.state === 'active' && share.mountPath === mountPath
        ? { ...share, state: 'mounted' }
        : share.state === 'active'
          ? { ...share, state: 'relocating' }
          : share
    },
    describe: share =>
      `share ${shareId}: state=${share.state}, mountPath=${share.mountPath ?? '<none>'}, expectedMountPath=${mountPath}`,
  })
}

async function assertShareManagementStatus(
  args: Pick<Parameters<typeof runShareJourneyAcceptance>[0], 'env' | 'artifacts'> & {
    page: Page
    workspaceSlug: string
    direction: 'incoming' | 'outgoing'
    sharePath: string
    status: 'syncing' | 'upToDate' | 'unlinked' | 'revoked'
    screenshotName: string
  },
): Promise<void> {
  markExpectedBrowserTransition(args.page)
  await navigateDeployedPage(
    args.page,
    `${args.env.appUrl}/w/${args.workspaceSlug}/settings/shares`,
  )
  const row = args.page
    .locator(
      `article[data-share-direction="${args.direction}"][data-share-status="${args.status}"]`,
    )
    .filter({ hasText: args.sharePath })
  await row.waitFor({ timeout: 180_000 })
  await args.page.screenshot({
    path: path.join(args.artifacts.directory, args.screenshotName),
    fullPage: true,
  })
}

async function proveReadShareRepair(
  args: Parameters<typeof runShareJourneyAcceptance>[0] & {
    recipient: RecipientIdentity
  },
): Promise<void> {
  const fixture = await createAcceptedTestShare({
    ...args,
    recipient: args.recipient,
    label: 'read',
    mode: 'read',
  })
  const original = `read-only origin ${args.runId}\n`
  await writeTrackedFile({
    ...args,
    workspace: args.ownerWorkspace,
    token: args.ownerApiToken,
    filePath: `${fixture.sourceRoot}/read-only.txt`,
    bytes: original,
    label: 'read-only source',
  })
  await waitForSharedFileBytes({
    url: fileUrl(
      args.env.apiUrl,
      args.recipient.workspace.slug,
      `${fixture.mountRoot}/read-only.txt`,
    ),
    token: args.recipient.token,
    expectedBytes: original,
  })
  // A recipient-created file must survive read-mode repair: the enforcer
  // reverts only creator-tracked paths and preserves viewer additions. Create
  // the addition BEFORE tampering so the repair pass runs with both present.
  const additionBytes = `recipient addition ${args.runId}\n`
  const additionUrl = fileUrl(
    args.env.apiUrl,
    args.recipient.workspace.slug,
    `${fixture.mountRoot}/recipient-note.txt`,
  )
  const addition = await stagingFetch(additionUrl, {
    method: 'PUT',
    headers: bearer(args.recipient.token, { 'content-type': 'text/plain' }),
    body: additionBytes,
  })
  assert(addition.status === 200, `read-share addition returned HTTP ${addition.status}`)
  const write = await stagingFetch(
    fileUrl(args.env.apiUrl, args.recipient.workspace.slug, `${fixture.mountRoot}/read-only.txt`),
    {
      method: 'PUT',
      headers: bearer(args.recipient.token, { 'content-type': 'text/plain' }),
      body: `recipient tamper ${args.runId}\n`,
    },
  )
  assert([200, 403].includes(write.status), `read-share write returned HTTP ${write.status}`)
  await waitForSharedFileBytes({
    url: fileUrl(
      args.env.apiUrl,
      args.recipient.workspace.slug,
      `${fixture.mountRoot}/read-only.txt`,
    ),
    token: args.recipient.token,
    expectedBytes: original,
  })
  // After the tamper was reverted, the addition must still be intact — a
  // folder-wide revert (which deletes viewer additions) would fail here.
  await waitForSharedFileBytes({
    url: additionUrl,
    token: args.recipient.token,
    expectedBytes: additionBytes,
  })
  await unlinkShare(args, fixture.shareId, args.recipient)
}

async function proveNestedLinkMoves(
  args: Parameters<typeof runShareJourneyAcceptance>[0] & {
    recipient: RecipientIdentity
  },
): Promise<void> {
  await proveRecipientNestedLinkMove(args)
  await proveOriginNestedLinkMove(args)
}

async function proveRecipientNestedLinkMove(
  args: Parameters<typeof runShareJourneyAcceptance>[0] & {
    recipient: RecipientIdentity
  },
): Promise<void> {
  const recipientContainer = await createAcceptedTestShare({
    ...args,
    recipient: args.recipient,
    label: 'recipient-container',
    mode: 'write',
  })
  const recipientMoved = await createAcceptedTestShare({
    ...args,
    recipient: args.recipient,
    label: 'recipient-nested-moved',
    mode: 'write',
  })
  const recipientNestedPath = `${recipientContainer.mountRoot}/nested-moved`
  await waitForSharedFileBytes({
    url: fileUrl(
      args.env.apiUrl,
      args.recipient.workspace.slug,
      `${recipientMoved.mountRoot}/seed.txt`,
    ),
    token: args.recipient.token,
    expectedBytes: `recipient-nested-moved ${args.runId}\n`,
  })
  await movePath({
    env: args.env,
    workspaceSlug: args.recipient.workspace.slug,
    token: args.recipient.token,
    source: recipientMoved.mountRoot,
    destination: recipientNestedPath,
    artifacts: args.artifacts,
    label: 'recipient nested-link move',
  })
  await waitForShareState({
    expectedState: 'unlinked',
    load: async () => await loadShare(args, recipientMoved.shareId),
  })
  assert.equal(
    await apiText(
      fileUrl(args.env.apiUrl, args.recipient.workspace.slug, `${recipientNestedPath}/seed.txt`),
      { headers: bearer(args.recipient.token) },
      200,
      'recipient nested-link files stay',
      args.artifacts,
    ),
    `recipient-nested-moved ${args.runId}\n`,
  )
  assert.equal((await loadShare(args, recipientContainer.shareId)).state, 'active')
  const recipientContainerProof = `recipient container survives ${args.runId}\n`
  await writeTrackedFile({
    ...args,
    workspace: args.ownerWorkspace,
    token: args.ownerApiToken,
    filePath: `${recipientContainer.sourceRoot}/container-still-syncs.txt`,
    bytes: recipientContainerProof,
    label: 'recipient nested container proof',
  })
  await waitForSharedFileBytes({
    url: fileUrl(
      args.env.apiUrl,
      args.recipient.workspace.slug,
      `${recipientContainer.mountRoot}/container-still-syncs.txt`,
    ),
    token: args.recipient.token,
    expectedBytes: recipientContainerProof,
  })
  await assertShareManagementStatus({
    ...args,
    page: args.recipient.page,
    workspaceSlug: args.recipient.workspace.slug,
    direction: 'incoming',
    sharePath: recipientContainer.mountRoot,
    status: 'upToDate',
    screenshotName: 'share-recipient-nested-container-healthy.png',
  })
  await unlinkShare(args, recipientContainer.shareId, args.recipient)
}

async function proveOriginNestedLinkMove(
  args: Parameters<typeof runShareJourneyAcceptance>[0] & {
    recipient: RecipientIdentity
  },
): Promise<void> {
  const originContainer = await createAcceptedTestShare({
    ...args,
    recipient: args.recipient,
    label: 'origin-container',
    mode: 'write',
  })
  const originMoved = await createAcceptedTestShare({
    ...args,
    recipient: args.recipient,
    label: 'origin-nested-moved',
    mode: 'write',
  })
  const originNestedPath = `${originContainer.sourceRoot}/nested-moved`
  await waitForSharedFileBytes({
    url: fileUrl(
      args.env.apiUrl,
      args.recipient.workspace.slug,
      `${originMoved.mountRoot}/seed.txt`,
    ),
    token: args.recipient.token,
    expectedBytes: `origin-nested-moved ${args.runId}\n`,
  })
  await movePath({
    env: args.env,
    workspaceSlug: args.ownerWorkspace.slug,
    token: args.ownerApiToken,
    source: originMoved.sourceRoot,
    destination: originNestedPath,
    artifacts: args.artifacts,
    label: 'origin nested-link move',
  })
  await waitForShareState({
    expectedState: 'unlinked',
    load: async () => await loadShare(args, originMoved.shareId),
  })
  assert.equal(
    await apiText(
      fileUrl(args.env.apiUrl, args.ownerWorkspace.slug, `${originNestedPath}/seed.txt`),
      { headers: bearer(args.ownerApiToken) },
      200,
      'origin nested-link files stay',
      args.artifacts,
    ),
    `origin-nested-moved ${args.runId}\n`,
  )
  assert.equal(
    await apiText(
      fileUrl(args.env.apiUrl, args.recipient.workspace.slug, `${originMoved.mountRoot}/seed.txt`),
      { headers: bearer(args.recipient.token) },
      200,
      'origin nested-link recipient files stay',
      args.artifacts,
    ),
    `origin-nested-moved ${args.runId}\n`,
  )
  assert.equal((await loadShare(args, originContainer.shareId)).state, 'active')
  const originContainerProof = `origin container survives ${args.runId}\n`
  await writeTrackedFile({
    ...args,
    workspace: args.ownerWorkspace,
    token: args.ownerApiToken,
    filePath: `${originContainer.sourceRoot}/container-still-syncs.txt`,
    bytes: originContainerProof,
    label: 'origin nested container proof',
  })
  await waitForSharedFileBytes({
    url: fileUrl(
      args.env.apiUrl,
      args.recipient.workspace.slug,
      `${originContainer.mountRoot}/container-still-syncs.txt`,
    ),
    token: args.recipient.token,
    expectedBytes: originContainerProof,
  })
  await assertShareManagementStatus({
    ...args,
    page: args.ownerPage,
    workspaceSlug: args.ownerWorkspace.slug,
    direction: 'outgoing',
    sharePath: originContainer.sourceRoot,
    status: 'upToDate',
    screenshotName: 'share-owner-nested-container-healthy.png',
  })
  await unlinkShare(args, originContainer.shareId, args.recipient)
}

async function proveRecipientDeleteAutoUnlink(
  args: Parameters<typeof runShareJourneyAcceptance>[0] & {
    recipient: RecipientIdentity
  },
): Promise<void> {
  const fixture = await createAcceptedTestShare({
    ...args,
    recipient: args.recipient,
    label: 'recipient-delete',
    mode: 'write',
  })
  const bytes = `recipient delete source ${args.runId}\n`
  const name = 'kept-at-origin.txt'
  await writeTrackedFile({
    ...args,
    workspace: args.ownerWorkspace,
    token: args.ownerApiToken,
    filePath: `${fixture.sourceRoot}/${name}`,
    bytes,
    label: 'recipient-delete source',
  })
  await waitForSharedFileBytes({
    url: fileUrl(args.env.apiUrl, args.recipient.workspace.slug, `${fixture.mountRoot}/${name}`),
    token: args.recipient.token,
    expectedBytes: bytes,
  })
  const beforePhaseProbePath = `share-journey/${args.runId}/recipient-delete-phase-before.txt`
  const afterPhaseProbePath = `share-journey/${args.runId}/recipient-delete-phase-after.txt`
  const beforePhase = await loadWorkspaceHeartbeat(args, args.recipient.workspace._id)
  await writeTrackedFile({
    ...args,
    workspace: args.recipient.workspace,
    token: args.recipient.token,
    filePath: beforePhaseProbePath,
    bytes: `phase before delete ${args.runId}\n`,
    label: 'recipient-delete phase probe',
  })
  const phasedHeartbeat = await waitForNewWorkspaceHeartbeat({
    ...args,
    workspaceId: args.recipient.workspace._id,
    previous: beforePhase,
  })
  await deleteShareRoot(
    args.env,
    args.recipient.workspace.slug,
    args.recipient.token,
    fixture.mountRoot,
  )
  await writeTrackedFile({
    ...args,
    workspace: args.recipient.workspace,
    token: args.recipient.token,
    filePath: afterPhaseProbePath,
    bytes: `phase after delete ${args.runId}\n`,
    label: 'recipient-delete first-miss probe',
  })
  await waitForNewWorkspaceHeartbeat({
    ...args,
    workspaceId: args.recipient.workspace._id,
    previous: phasedHeartbeat,
  })
  // Convex persists the heartbeat before the VM response returns. Give that
  // same poll's awaited anchor report time to finish; the next poll cannot
  // start until the report completes and the five-second interval elapses.
  await Bun.sleep(2_000)
  assert.equal(
    (await loadShare(args, fixture.shareId)).state,
    'active',
    'the first marker-negative missing poll unlinked the recipient share',
  )
  await waitForShareState({
    expectedState: 'unlinked',
    load: async () => await loadShare(args, fixture.shareId),
  })
  await assertShareManagementStatus({
    ...args,
    page: args.ownerPage,
    workspaceSlug: args.ownerWorkspace.slug,
    direction: 'outgoing',
    sharePath: fixture.sourceRoot,
    status: 'unlinked',
    screenshotName: 'share-owner-ended.png',
  })
  assert.equal(
    await apiText(
      fileUrl(args.env.apiUrl, args.ownerWorkspace.slug, `${fixture.sourceRoot}/${name}`),
      { headers: bearer(args.ownerApiToken) },
      200,
      'origin survives recipient deletion',
      args.artifacts,
    ),
    bytes,
  )
}

async function proveOriginDeleteAutoUnlink(
  args: Parameters<typeof runShareJourneyAcceptance>[0] & {
    recipient: RecipientIdentity
  },
): Promise<void> {
  const fixture = await createAcceptedTestShare({
    ...args,
    recipient: args.recipient,
    label: 'origin-delete',
    mode: 'write',
  })
  const sourceApp = await registerTrackedShareApp({
    apiUrl: args.env.apiUrl,
    workspace: args.ownerWorkspace,
    token: args.ownerApiToken,
    runId: args.runId,
    label: 'origin-delete',
    sourceRoot: fixture.sourceRoot,
    ledger: args.ledger,
    convex: args.convex,
    internalKey: args.env.internalKey,
    artifacts: args.artifacts,
  })
  const bytes = `origin delete source ${args.runId}\n`
  const name = 'kept-at-recipient.txt'
  await writeTrackedFile({
    ...args,
    workspace: args.ownerWorkspace,
    token: args.ownerApiToken,
    filePath: `${fixture.sourceRoot}/${name}`,
    bytes,
    label: 'origin-delete source',
  })
  await waitForSharedFileBytes({
    url: fileUrl(args.env.apiUrl, args.recipient.workspace.slug, `${fixture.mountRoot}/${name}`),
    token: args.recipient.token,
    expectedBytes: bytes,
  })
  await waitForRecipientReplicaState({
    ...args,
    recipientToken: args.recipient.token,
    recipientWorkspace: args.recipient.workspace,
    appSlug: sourceApp.slug,
    sourceShareId: fixture.shareId,
    expectedState: 'attached',
  })
  await deleteShareRoot(args.env, args.ownerWorkspace.slug, args.ownerApiToken, fixture.sourceRoot)
  await waitForShareState({
    expectedState: 'unlinked',
    load: async () => await loadShare(args, fixture.shareId),
  })
  assert.equal(
    await apiText(
      fileUrl(args.env.apiUrl, args.recipient.workspace.slug, `${fixture.mountRoot}/${name}`),
      { headers: bearer(args.recipient.token) },
      200,
      'recipient survives origin deletion',
      args.artifacts,
    ),
    bytes,
  )
  await waitForRecipientReplicaState({
    ...args,
    recipientToken: args.recipient.token,
    recipientWorkspace: args.recipient.workspace,
    appSlug: sourceApp.slug,
    sourceShareId: fixture.shareId,
    expectedState: 'detached',
  })
}

async function proveRevokeStopsFlow(
  args: Parameters<typeof runShareJourneyAcceptance>[0] & {
    recipient: RecipientIdentity
  },
): Promise<void> {
  const fixture = await createAcceptedTestShare({
    ...args,
    recipient: args.recipient,
    label: 'revoke',
    mode: 'write',
  })
  const sourceApp = await registerTrackedShareApp({
    apiUrl: args.env.apiUrl,
    workspace: args.ownerWorkspace,
    token: args.ownerApiToken,
    runId: args.runId,
    label: 'revoke',
    sourceRoot: fixture.sourceRoot,
    ledger: args.ledger,
    convex: args.convex,
    internalKey: args.env.internalKey,
    artifacts: args.artifacts,
  })
  const seedName = 'before-revoke.txt'
  const seedBytes = `before revoke ${args.runId}\n`
  await writeTrackedFile({
    ...args,
    workspace: args.ownerWorkspace,
    token: args.ownerApiToken,
    filePath: `${fixture.sourceRoot}/${seedName}`,
    bytes: seedBytes,
    label: 'revoke source',
  })
  await waitForSharedFileBytes({
    url: fileUrl(
      args.env.apiUrl,
      args.recipient.workspace.slug,
      `${fixture.mountRoot}/${seedName}`,
    ),
    token: args.recipient.token,
    expectedBytes: seedBytes,
  })
  await waitForRecipientReplicaState({
    ...args,
    recipientToken: args.recipient.token,
    recipientWorkspace: args.recipient.workspace,
    appSlug: sourceApp.slug,
    sourceShareId: fixture.shareId,
    expectedState: 'attached',
  })
  await apiJson(
    `${args.env.apiUrl}/v1/ws/${encodeURIComponent(args.ownerWorkspace.slug)}/shares/${encodeURIComponent(fixture.shareId)}`,
    { method: 'DELETE', headers: bearer(args.ownerApiToken) },
    200,
    'share revoke',
    args.artifacts,
  )
  await waitForShareState({
    expectedState: 'revoked',
    load: async () => await loadShare(args, fixture.shareId),
  })
  await waitForRecipientReplicaState({
    ...args,
    recipientToken: args.recipient.token,
    recipientWorkspace: args.recipient.workspace,
    appSlug: sourceApp.slug,
    sourceShareId: fixture.shareId,
    expectedState: 'absent',
  })
  await waitForShareMountPruned({
    shareId: fixture.shareId,
    gateways: await Promise.all([
      loadGatewayObservationConnection(args, args.ownerWorkspace.slug),
      loadGatewayObservationConnection(args, args.recipient.workspace.slug),
    ]),
  })
  const laterName = 'after-revoke.txt'
  await writeTrackedFile({
    ...args,
    workspace: args.ownerWorkspace,
    token: args.ownerApiToken,
    filePath: `${fixture.sourceRoot}/${laterName}`,
    bytes: `after revoke ${args.runId}\n`,
    label: 'post-revoke source',
  })
  await assertFileStaysMissing({
    url: fileUrl(
      args.env.apiUrl,
      args.recipient.workspace.slug,
      `${fixture.mountRoot}/${laterName}`,
    ),
    token: args.recipient.token,
  })
}

type RecipientIdentity = {
  page: Page
  token: string
  workspace: Workspace & { vmName: string }
}

async function loadRawWorkspace(
  args: Pick<Parameters<typeof runShareJourneyAcceptance>[0], 'convex' | 'env'>,
  workspaceId: string,
): Promise<Workspace> {
  const workspace = (await args.convex.query(
    fnQuery('testing/workspaces:rawWorkspaceByIdForTest'),
    {
      internalKey: args.env.internalKey,
      workspaceId,
    },
  )) as (Workspace & { runtimeVersion?: string }) | null
  assert(workspace !== null, `workspace ${workspaceId} disappeared while observing VM sync`)
  return workspace
}

export async function loadGatewayObservationConnection(
  args: Pick<Parameters<typeof runShareJourneyAcceptance>[0], 'convex' | 'env'>,
  workspaceSlug: string,
): Promise<{ httpsUrl: string; vmToken: string }> {
  const connection = (await args.convex.query(
    fnQuery('domains/workspaces/provisioning:gatewayConnectionBySlug'),
    { internalKey: args.env.internalKey, slug: workspaceSlug },
  )) as { httpsUrl: string; vmToken: string } | { refusal: 'paused' } | null
  assert(
    connection !== null && !('refusal' in connection),
    `workspace ${workspaceSlug} has no live gateway connection`,
  )
  // Read-only observation proves teardown convergence; every mutation remains on the vm-sync rail.
  return { httpsUrl: connection.httpsUrl, vmToken: connection.vmToken }
}

/* The barrier this journey needs is "the VM has completed a sync round trip
   the server persisted". That used to be the activity generation, which forced
   a persist on every file write — the rail is gone, and the heartbeat is what
   every persist writes instead. Coarser: the server persists at most once per
   `VM_SYNC_PERSIST_INTERVAL_MS`, so a wait here can take that long rather than
   one poll. */
async function loadWorkspaceHeartbeat(
  args: Pick<Parameters<typeof runShareJourneyAcceptance>[0], 'convex' | 'env'>,
  workspaceId: string,
): Promise<number | undefined> {
  return (await loadRawWorkspace(args, workspaceId)).lastHeartbeatAt
}

async function waitForNewWorkspaceHeartbeat(
  args: Pick<Parameters<typeof runShareJourneyAcceptance>[0], 'convex' | 'env'> & {
    workspaceId: string
    previous: number | undefined
  },
): Promise<number> {
  const observed = await waitForShareState({
    expectedState: 'changed',
    load: async () => {
      const heartbeat = await loadWorkspaceHeartbeat(args, args.workspaceId)
      return {
        state: heartbeat !== undefined && heartbeat !== args.previous ? 'changed' : 'waiting',
        heartbeat,
      }
    },
    /* The heartbeat is written at most once per `VM_SYNC_PERSIST_INTERVAL_MS`
       (60s), where the activity generation it replaced forced a write on every
       file event. The window has to cover that interval plus a poll. */
    timeoutMs: 90_000,
    pollMs: 500,
  })
  assert(observed.heartbeat !== undefined)
  return observed.heartbeat
}

async function createAcceptedTestShare(
  args: Parameters<typeof runShareJourneyAcceptance>[0] & {
    recipient: RecipientIdentity
    label: string
    mode: 'read' | 'write'
  },
): Promise<{ shareId: string; sourceRoot: string; mountRoot: string }> {
  const sourceRoot = `share-journey/${args.runId}/${args.label}`
  const mountRoot = `shared/${args.runId}/${args.label}`
  await writeTrackedFile({
    ...args,
    workspace: args.ownerWorkspace,
    token: args.ownerApiToken,
    filePath: `${sourceRoot}/seed.txt`,
    bytes: `${args.label} ${args.runId}\n`,
    label: `${args.label} seed`,
  })
  const created = (await args.convex.mutation(fnMutation('testing/shares:createShareForTest'), {
    internalKey: args.env.internalKey,
    actorId: args.ownerUserId,
    fromWorkspaceId: args.ownerWorkspace._id,
    toEmail: args.recipientEmail,
    path: sourceRoot,
    mode: args.mode,
  })) as { share: { id: string } }
  trackShare({ ...args, shareId: created.share.id })
  const accepted = IncomingShareResponseSchema.parse(
    await apiJson(
      `${args.env.apiUrl}/v1/share-requests/${encodeURIComponent(created.share.id)}/accept`,
      {
        method: 'POST',
        headers: bearerJson(args.recipient.token),
        body: JSON.stringify({
          toWorkspaceId: args.recipient.workspace._id,
          mountPath: mountRoot,
        }),
      },
      200,
      `${args.label} share accept`,
      args.artifacts,
    ),
  )
  assert.equal(accepted.share.state, 'active')
  return { shareId: created.share.id, sourceRoot, mountRoot }
}

async function unlinkShare(
  args: Parameters<typeof runShareJourneyAcceptance>[0],
  shareId: string,
  recipient: RecipientIdentity,
): Promise<void> {
  await apiJson(
    `${args.env.apiUrl}/v1/ws/${encodeURIComponent(recipient.workspace.slug)}/shares/${encodeURIComponent(shareId)}/unlink`,
    { method: 'POST', headers: bearerJson(recipient.token), body: '{}' },
    200,
    'test share unlink',
    args.artifacts,
  )
  await waitForShareState({
    expectedState: 'unlinked',
    load: async () => await loadShare(args, shareId),
  })
}

/**
 * The reported failure: a recipient accepts a shared app, clicks it, and gets a
 * bare `forbidden` because a private app's public URL rejects everyone. The
 * product must run the app in-frame for anyone who can read the drive, offer no
 * public URL while it is private, and let a write-mode recipient publish their
 * own copy without touching the owner's.
 */
async function proveSharedAppIsUsableAndPublishable(
  args: Parameters<typeof runShareJourneyAcceptance>[0] & {
    recipient: RecipientIdentity
    shareId: string
    marker: string
  },
): Promise<AppApiKeyAcceptanceEvidence> {
  const { env, recipient, appSlug } = args
  const replica = await waitForRecipientReplicaState({
    ...args,
    recipientToken: recipient.token,
    recipientWorkspace: recipient.workspace,
    appSlug,
    sourceShareId: args.shareId,
    expectedState: 'attached',
  })
  assert(replica !== undefined, 'recipient never received the shared app replica')
  assert.equal(replica.visibility, 'folder', 'a shared app replica must arrive private')
  assert.equal(
    replica.sourceShareMode,
    'write',
    'the journey share is write mode, so its replica must report write access',
  )
  assert.equal(
    replica.controls.makePublic,
    true,
    'a write-mode recipient must be offered the publish control they can actually use',
  )
  const source = AppResponseSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/ws/${args.ownerWorkspace.slug}/apps/${encodeURIComponent(appSlug)}`,
      { headers: bearer(args.ownerApiToken) },
      200,
      'shared app source scope declaration',
      args.artifacts,
    ),
  ).app
  assert.deepEqual(
    replica.apiScopes,
    source.apiScopes,
    'recipient replica did not retain the source app scope declaration',
  )

  // A private app answers the world with 403 and the recipient with its bytes.
  const anonymous = await fetch(replica.canonicalUrl, { redirect: 'manual' })
  assert.equal(anonymous.status, 403, 'a private replica served bytes to an anonymous caller')

  const running = await waitForRunningReplica({ ...args, appSlug })
  const page = recipient.page
  /* The replica lands in the recipient's own drive with no agent's folder
     around it, so it is the drive's own agent's app and opens on that card.
     Everything that can be done to it is behind the ⋯ on the chip naming it —
     the app has no page of its own. */
  await navigateDeployedPage(
    page,
    `${env.appUrl}/w/${recipient.workspace.slug}/agents/${ROOT_AGENT_SCOPE}/apps/${encodeURIComponent(appSlug)}`,
  )
  const frame = page.frameLocator(`iframe[title="${running.name ?? appSlug}"]`)
  const frameBody = frame.locator('body')
  /* The replica's own cold start, on the replica's budget.

     This waited two minutes, and the screenshot it captured on the way out
     showed the marker rendered — the app served, just later than the wait
     allowed. The fixture answers `<main>{marker}</main>`, so the assertion was
     never wrong: a share replica has to accept the share, materialize the mount,
     take the bytes, register, reconcile and bind a port before it can answer, and
     `REPLICA_RUNTIME_BUDGET_MS` is what the rest of this file already allows for
     exactly that.

     The evidence stays. "No marker" and "not yet" look identical from here, and
     the VM is gone by the time anyone reads the leg table. */
  try {
    await frame
      .locator('main', { hasText: args.marker })
      .waitFor({ timeout: REPLICA_RUNTIME_BUDGET_MS })
  } catch (error) {
    await args.artifacts
      .writeJson('share-replica-no-marker.json', {
        appSlug,
        marker: args.marker,
        iframeTitle: running.name ?? appSlug,
        url: page.url(),
        iframeCount: await page
          .locator('iframe')
          .count()
          .catch(() => -1),
        frameHtml: (await frameBody.innerHTML().catch(() => '<unavailable>')).slice(0, 2000),
      })
      .catch(() => undefined)
    await page
      .screenshot({
        path: path.join(args.artifacts.directory, 'share-replica-no-marker.png'),
        fullPage: true,
      })
      .catch(() => undefined)
    throw error
  }
  await assertHidden(page, `text=${replica.canonicalUrl}`, 'private app advertised its public URL')

  const appMenu = async () => {
    await page.getByRole('button', { name: /^(App options|Opciones de la app)$/ }).click()
    await page.getByRole('menu').waitFor()
  }
  await appMenu()
  await page.getByRole('menuitem', { name: /^(Publish|Publicar)$/ }).click()
  await appMenu()
  await page.getByRole('menuitem', { name: /^(Copy public link|Copiar enlace público)$/ }).waitFor()
  await page.keyboard.press('Escape')
  const published = await waitForAnonymousAppStatus(replica.canonicalUrl, 200)
  assert(
    published.includes(args.marker),
    `published replica did not serve the shared app bytes: ${published.slice(0, 200)}`,
  )
  // Publishing the recipient's copy never publishes the owner's app.
  const originAfterPublish = AppResponseSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/ws/${args.ownerWorkspace.slug}/apps/${encodeURIComponent(appSlug)}`,
      { headers: bearer(args.ownerApiToken) },
      200,
      'origin app after replica publish',
      args.artifacts,
    ),
  ).app
  assert.equal(
    originAfterPublish.visibility,
    'folder',
    'publishing a replica published the origin app',
  )

  await appMenu()
  await page.getByRole('menuitem', { name: /^(Make private|Hacer privada)$/ }).click()
  await appMenu()
  await page.getByRole('menuitem', { name: /^(Publish|Publicar)$/ }).waitFor()
  await page.keyboard.press('Escape')
  await waitForAnonymousAppStatus(replica.canonicalUrl, 403)
  return await runAppApiKeyAcceptance({
    frameBody,
    env,
    workspace: recipient.workspace,
    apiToken: recipient.token,
    appSlug,
    appPath: running.anchorPath,
    artifacts: args.artifacts,
  })
}

async function waitForRunningReplica(
  args: Parameters<typeof runShareJourneyAcceptance>[0] & {
    recipient: RecipientIdentity
    appSlug: string
  },
): Promise<App> {
  const deadline = Date.now() + REPLICA_RUNTIME_BUDGET_MS
  let last: App | undefined
  while (Date.now() < deadline) {
    last = AppListResponseSchema.parse(
      await apiJson(
        `${args.env.apiUrl}/v1/ws/${args.recipient.workspace.slug}/apps`,
        { headers: bearer(args.recipient.token) },
        200,
        'recipient replica runtime',
        args.artifacts,
      ),
    ).items.find(app => app.slug === args.appSlug)
    if (last?.runtimeStatus === 'reconciled' && last.anchorState === 'active') return last
    await Bun.sleep(3_000)
  }
  throw new Error(
    `shared app replica never started: ${JSON.stringify({
      runtimeStatus: last?.runtimeStatus,
      anchorState: last?.anchorState,
      reconciliationError: last?.reconciliationError,
    })}`,
  )
}

async function waitForAnonymousAppStatus(url: string, expected: number): Promise<string> {
  const deadline = Date.now() + APP_VISIBILITY_BUDGET_MS
  let lastStatus = 0
  while (Date.now() < deadline) {
    const response = await fetch(url, { redirect: 'manual' })
    const body = await response.text()
    if (response.status === expected) return body
    lastStatus = response.status
    await Bun.sleep(2_000)
  }
  throw new Error(`app URL never reached HTTP ${expected} anonymously (last ${lastStatus})`)
}

async function assertHidden(page: Page, selector: string, message: string): Promise<void> {
  assert.equal(await page.locator(selector).count(), 0, message)
}

async function waitForRecipientReplicaState(
  args: Parameters<typeof runShareJourneyAcceptance>[0] & {
    recipientToken: string
    recipientWorkspace: Workspace
    appSlug: string
    sourceShareId: string
    expectedState: ExpectedReplicaState
  },
): Promise<App | undefined> {
  return await waitForReplicaState({
    appSlug: args.appSlug,
    sourceShareId: args.sourceShareId,
    expectedState: args.expectedState,
    loadApps: async () =>
      AppListResponseSchema.parse(
        await apiJson(
          `${args.env.apiUrl}/v1/ws/${args.recipientWorkspace.slug}/apps`,
          { headers: bearer(args.recipientToken) },
          200,
          'recipient replica list',
          args.artifacts,
        ),
      ).items,
  })
}

async function loadShare(
  args: Pick<Parameters<typeof runShareJourneyAcceptance>[0], 'convex' | 'env'>,
  shareId: string,
): Promise<ShareRecord> {
  const shares = (await args.convex.query(fnQuery('testing/shares:rawSharesForTest'), {
    internalKey: args.env.internalKey,
  })) as ShareRecord[]
  const share = shares.find(candidate => candidate.id === shareId)
  assert(share !== undefined, `share ${shareId} disappeared`)
  return share
}

function trackShare(
  args: Parameters<typeof runShareJourneyAcceptance>[0] & { shareId: string },
): void {
  args.ledger.record({
    kind: 'share',
    id: args.shareId,
    label: `${args.runId}:share:${args.shareId}`,
    cleanupPriority: 100,
    cleanup: async () => {
      const share = await loadShare(args, args.shareId)
      if (share.state !== 'active' && share.state !== 'pending') return
      const response = await stagingFetch(
        `${args.env.apiUrl}/v1/ws/${encodeURIComponent(args.ownerWorkspace.slug)}/shares/${encodeURIComponent(args.shareId)}`,
        { method: 'DELETE', headers: bearer(args.ownerApiToken) },
      )
      assertResponse(response, 200, 'share journey cleanup')
    },
    verify: async () => {
      const share = await loadShare(args, args.shareId)
      return share.state === 'revoked' || share.state === 'unlinked'
    },
  })
}

async function writeTrackedFile(
  args: Parameters<typeof runShareJourneyAcceptance>[0] & {
    workspace: Workspace
    token: string
    filePath: string
    bytes: string
    label: string
  },
): Promise<void> {
  await apiText(
    fileUrl(args.env.apiUrl, args.workspace.slug, args.filePath),
    {
      method: 'PUT',
      headers: bearer(args.token, { 'content-type': 'text/plain' }),
      body: args.bytes,
    },
    200,
    args.label,
    args.artifacts,
  )
  args.ledger.record({
    kind: 'file',
    id: `${args.workspace._id}:${args.filePath}`,
    label: `${args.runId}:file:${args.workspace.slug}:${args.filePath}`,
    cleanup: async () => {
      const response = await stagingFetch(
        fileUrl(args.env.apiUrl, args.workspace.slug, args.filePath),
        { method: 'DELETE', headers: bearer(args.token) },
      )
      assert(
        response.status === 200 || response.status === 404 || response.status === 401,
        `share journey file cleanup returned HTTP ${response.status}`,
      )
    },
    verify: async () =>
      await workspaceIsDeleted(args.convex, args.env.internalKey, args.workspace._id),
  })
}

async function movePath(args: {
  env: LiveEnv
  workspaceSlug: string
  token: string
  source: string
  destination: string
  artifacts: StagingArtifactCollector
  label: string
}): Promise<void> {
  await apiJson(
    `${args.env.apiUrl}/v1/ws/${encodeURIComponent(args.workspaceSlug)}/files/actions`,
    {
      method: 'POST',
      headers: bearerJson(args.token),
      body: JSON.stringify({
        operation: 'move',
        source: args.source,
        destination: args.destination,
        overwrite: false,
      }),
    },
    200,
    args.label,
    args.artifacts,
  )
}

export async function deleteShareRoot(
  env: Pick<LiveEnv, 'apiUrl'>,
  workspaceSlug: string,
  token: string,
  filePath: string,
  fetchImpl: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response> = stagingFetch,
): Promise<void> {
  const response = await fetchImpl(
    `${env.apiUrl}/v1/ws/${encodeURIComponent(workspaceSlug)}/files/actions`,
    {
      method: 'POST',
      headers: bearerJson(token),
      body: JSON.stringify({
        operation: 'delete',
        path: filePath,
        recursive: true,
      }),
    },
  )
  assertResponse(response, 200, 'share root delete')
}

async function assertFileStaysMissing(args: {
  url: string
  token: string
  durationMs?: number
  pollMs?: number
}): Promise<void> {
  const deadline = Date.now() + (args.durationMs ?? 15_000)
  for (;;) {
    const response = await stagingFetch(args.url, { headers: bearer(args.token) })
    assert.equal(response.status, 404, 'revoked share delivered later origin bytes')
    await response.arrayBuffer()
    if (Date.now() >= deadline) return
    await Bun.sleep(args.pollMs ?? 2_000)
  }
}

function recordSyntheticRecipientCleanup(
  args: Parameters<typeof runShareJourneyAcceptance>[0],
): void {
  args.ledger.record({
    kind: 'user',
    id: args.recipientEmail,
    label: `${args.runId}:share-recipient:${args.recipientEmail}`,
    cleanupPriority: -100,
    cleanup: async () => {
      await args.convex.mutation(fnMutation('testing/stagingE2e:retireUserByEmailForTest'), {
        internalKey: args.env.internalKey,
        email: args.recipientEmail,
      })
    },
    verify: async () =>
      (await args.convex.query(fnQuery('testing/stagingE2e:userByEmailForTest'), {
        internalKey: args.env.internalKey,
        email: args.recipientEmail,
      })) === null,
  })
}

function fileUrl(apiUrl: string, workspaceSlug: string, filePath: string): string {
  const encodedPath = filePath
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/')
  return `${apiUrl}/v1/ws/${encodeURIComponent(workspaceSlug)}/files/${encodedPath}`
}
