import assert from 'node:assert/strict'

import type { Locator } from '@playwright/test'

import {
  AgentListResponseSchema,
  DefaultSessionResponseSchema,
  DRIVE_UPLOAD_MAX_BYTES,
  VmUploadGrantSchema,
  FileHistoryResponseSchema,
  FileStatResponseSchema,
  isKnownTimelineEvent,
  MarketplaceAgentSubscriptionResponseSchema,
  OpenOnboardingSessionResponseSchema,
  SessionSnapshotSchema,
  WhoamiResponseSchema,
  type FileHistoryResponse,
} from '@repo/contract'

import { provisionStagingAgent } from './staging-live-agent-fixture.ts'
import {
  deleteStagingSession,
  waitForSessionHistory,
  waitForSessionSnapshot,
} from './staging-live-agent-sessions.ts'
import { markExpectedBrowserTransition, navigateDeployedPage } from './staging-live-browser.ts'
import { apiJson, bearer, bearerJson, stagingFetch } from './staging-live-http.ts'
import {
  loadAllMarketplaceCatalog,
  type ChronologicalSessionHistory,
} from './staging-live-pagination.ts'
import { workspaceIsDeleted } from './staging-live-resource-ledger.ts'
import {
  classifyUploadCeilingProbe,
  probeDeclaredBodyCeiling,
  type UploadCeilingVerdict,
} from './staging-live-upload-ceiling.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'

const UPLOAD_WAIT_MS = 300_000
/* A declared body is answered on the declaration or not at all, so silence past
   a few seconds means admitted rather than slow. */
const CEILING_PROBE_WAIT_MS = 6_000
// A live model turn can queue behind the opening/onboarding turn in the same VM.
const AGENT_WAIT_MS = 420_000
const POLL_MS = 500
const LARGE_ATTACHMENT_BYTES = 26 * 1024 * 1024
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

export interface ChatAttachmentsEvidence {
  registeredAgent: {
    agentSlug: string
    sessionId: string
    uploadedPaths: string[]
    largeAttachmentBytes: number
    uploadingObserved: boolean
    sendGatedWhileUploading: boolean
    bubbleCardNames: string[]
    viewerOpenedInPlace: boolean
    userAttributedPaths: string[]
    summaryMarker: string
    removedPath: string
    removedFileDeleted: boolean
    filesOnly: { path: string; sendEnabledWithoutWords: boolean; marker: string }
  }
  onboardingAgent: {
    agentSlug: string
    sessionId: string
    uploadedPaths: string[]
    lockedBeforeAttachment: boolean
    summaryMarker: string
  }
  /* Recorded, not asserted. The point of this leg is to learn what the edge
     proxy does with a large declared body — a journey that fails on an unknown
     teaches nothing, and a surprising answer here is the finding. */
  uploadCeiling: {
    overCap: { verdict: UploadCeilingVerdict; status: number | null; elapsedMs: number }
    underCap: { verdict: UploadCeilingVerdict; status: number | null; elapsedMs: number }
    farAboveTransport: { verdict: UploadCeilingVerdict; status: number | null; elapsedMs: number }
  }
}

export async function runChatAttachmentsJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<ChatAttachmentsEvidence>> {
  return await runWorkspaceBrowserJourney({
    journey: 'chat-attachments',
    label: 'Chat Attachments',
    onProgress: options.onProgress,
    run: runChatAttachmentsAcceptance,
  })
}

export function terminalResultIncludes(
  history: Pick<ChronologicalSessionHistory, 'events'>,
  marker: string,
): boolean {
  return history.events.some(
    row =>
      isKnownTimelineEvent(row.event) &&
      row.event.type === 'complete' &&
      row.event.status === 'completed' &&
      row.event.result?.includes(marker) === true,
  )
}

/** A person's message that carried this file and no words — the send the composer once refused. */
export function filesOnlyInputDelivered(
  history: Pick<ChronologicalSessionHistory, 'events'>,
  path: string,
): boolean {
  return history.events.some(
    row =>
      isKnownTimelineEvent(row.event) &&
      row.event.type === 'prompt_submitted' &&
      row.event.prompt.trim().length === 0 &&
      row.event.attachments?.some(attachment => attachment.path === path) === true,
  )
}

export function hasAttributedBrowserWrite(
  history: Pick<FileHistoryResponse, 'items'>,
  path: string,
  userId: string,
): boolean {
  return history.items.some(row => {
    const event = row.event
    return (
      event.kind === 'write' &&
      event.path === path &&
      event.userId === userId &&
      event.actor === `web:${userId}`
    )
  })
}

export function attachmentCardCompletion(
  kind: 'file' | 'inline-image',
): { visible: 'Ready' } | { hidden: 'Preparing' } {
  return kind === 'file' ? { visible: 'Ready' } : { hidden: 'Preparing' }
}

async function runChatAttachmentsAcceptance(
  context: WorkspaceBrowserJourneyContext,
): Promise<ChatAttachmentsEvidence> {
  const { env, page, workspace, apiToken, runId, ledger, convex, artifacts, progress } = context
  const suffix = runId.slice(-8).toLowerCase()
  const userId = WhoamiResponseSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/whoami`,
      { headers: bearer(apiToken) },
      200,
      'chat attachments journey identity',
      artifacts,
    ),
  ).user.id

  /* First, and deliberately: this leg needs only a workspace and a grant, so it
     must not sit behind the composer legs where an unrelated failure would stop
     it from ever asking the one question local tests cannot answer. */
  const uploadCeiling = await runUploadCeilingLeg(context)

  progress('chat-attachments:provision-agent')
  const agentSlug = `attach-${suffix}`
  const agent = await provisionStagingAgent({
    env,
    workspace,
    apiToken,
    runId,
    slug: agentSlug,
    name: `Attachment ${suffix}`,
    description: 'Read files attached in chat and answer from their actual contents.',
    ledger,
    convex,
    artifacts,
  })

  progress('chat-attachments:open-composer')
  const agentUrl = `${env.appUrl}/w/${encodeURIComponent(workspace.slug)}/agents/${encodeURIComponent(agentSlug)}`
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, agentUrl)
  const surface = page.locator('[data-session-surface="product"]')
  await surface.waitFor({ state: 'visible', timeout: 60_000 })

  const summaryMarker = `ORCHID-${suffix}`
  const smallName = `brief-${suffix}.txt`
  const imageName = `reference-${suffix}.png`
  const largeName = `large-${suffix}.bin`
  const smallPath = `agents/${agentSlug}/uploads/${smallName}`
  const largePath = `agents/${agentSlug}/uploads/${largeName}`
  const prompt =
    'Read the attached text brief, summarize its instruction in one sentence, and repeat the unique validation token contained in the file. Do not infer content from filenames.'

  progress('chat-attachments:upload')
  const editor = surface.locator('[data-compose-bar-editor]')
  await editor.fill(prompt)
  const send = surface.getByRole('button', { name: 'Send', exact: true })
  await surface.locator('input[type="file"]').setInputFiles([
    {
      name: smallName,
      mimeType: 'text/plain',
      buffer: Buffer.from(
        `Validation token: ${summaryMarker}\nInstruction: organize the launch assets by audience.\n`,
      ),
    },
    { name: imageName, mimeType: 'image/png', buffer: PNG_1X1 },
    {
      name: largeName,
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(LARGE_ATTACHMENT_BYTES, 0x5a),
    },
  ])

  const uploading = surface.getByText(/^Uploading · \d+%$/).first()
  await uploading.waitFor({ state: 'visible', timeout: 30_000 })
  const sendGatedWhileUploading = await send.isDisabled()
  assert(sendGatedWhileUploading, 'Send became enabled while an attachment was still uploading')
  await waitForReadyCard(surface, smallName)
  await waitForCompletedCard(surface, imageName, 'inline-image')
  await waitForReadyCard(surface, largeName)
  assert.equal(
    await send.isEnabled(),
    true,
    'Send stayed disabled after every attachment was ready',
  )

  for (const path of [smallPath, largePath]) recordFileCleanup(context, path)

  progress('chat-attachments:send')
  await send.click()
  const defaultSession = await waitForDefaultSession(context, agentSlug)
  assert.equal(defaultSession.agent?.id, agent.id, 'default chat attached to a different agent')
  recordSessionCleanup(context, defaultSession.id, 'registered-agent')

  progress('chat-attachments:bubble')
  const bubbleCards = page.locator('[data-message-attachment-card]')
  await bubbleCards.filter({ hasText: smallName }).waitFor({ timeout: 60_000 })
  await bubbleCards.filter({ hasText: largeName }).waitFor({ timeout: 60_000 })
  await page.locator('[data-message-inline-image]').last().waitFor({ timeout: 60_000 })

  /* A sent card opens the file in place, over the conversation, rather than
     sending the reader off to Files: the address does not change, and the
     viewer is named for the file it shows. */
  const smallCard = bubbleCards.filter({ hasText: smallName })
  const conversationPathname = new URL(page.url()).pathname
  await smallCard.click()
  const viewer = page.locator('[data-session-file-viewer]')
  await viewer.waitFor({ state: 'visible', timeout: 60_000 })
  await page
    .locator('[data-files-preview-header]')
    .filter({ hasText: smallName })
    .waitFor({ state: 'visible', timeout: 60_000 })
  const viewerOpenedInPlace = new URL(page.url()).pathname === conversationPathname
  assert(viewerOpenedInPlace, 'opening a sent attachment navigated away from the conversation')
  await page.keyboard.press('Escape')
  await viewer.waitFor({ state: 'hidden', timeout: 30_000 })

  progress('chat-attachments:files-api')
  const smallStat = await readFileStat(context, smallPath, 'small attachment stat')
  const largeStat = await readFileStat(context, largePath, 'large attachment stat')
  assert.equal(
    smallStat.entry.size,
    Buffer.byteLength(
      `Validation token: ${summaryMarker}\nInstruction: organize the launch assets by audience.\n`,
    ),
  )
  assert.equal(largeStat.entry.size, LARGE_ATTACHMENT_BYTES)
  for (const path of [smallPath, largePath]) await waitForAttributedWrite(context, path, userId)

  progress('chat-attachments:agent-summary')
  await waitForSessionHistory(
    env,
    workspace.slug,
    defaultSession.id,
    apiToken,
    history => terminalResultIncludes(history, summaryMarker),
    AGENT_WAIT_MS,
  )

  /* A file is a whole message. The composer once held Send until there were
     words; now an empty editor with a ready file sends, the wire carries an
     empty prompt beside the file, and the agent answers from the file — whose
     contents, not any prompt, say what to do. */
  progress('chat-attachments:files-only')
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, agentUrl)
  await surface.waitFor({ state: 'visible', timeout: 60_000 })
  const filesOnlyMarker = `MAGNOLIA-${suffix}`
  const filesOnlyName = `only-${suffix}.txt`
  const filesOnlyPath = `agents/${agentSlug}/uploads/${filesOnlyName}`
  recordFileCleanup(context, filesOnlyPath)
  assert.equal(
    (await surface.locator('[data-compose-bar-editor]').innerText()).trim(),
    '',
    'the files-only leg needs an empty editor',
  )
  await surface.locator('input[type="file"]').setInputFiles({
    name: filesOnlyName,
    mimeType: 'text/plain',
    buffer: Buffer.from(`Reply with exactly this token and nothing else: ${filesOnlyMarker}\n`),
  })
  await waitForReadyCard(surface, filesOnlyName)
  const sendEnabledWithoutWords = await send.isEnabled()
  assert(sendEnabledWithoutWords, 'Send stayed disabled for a ready file with no words')
  await send.click()
  await waitForSessionHistory(
    env,
    workspace.slug,
    defaultSession.id,
    apiToken,
    history =>
      filesOnlyInputDelivered(history, filesOnlyPath) &&
      terminalResultIncludes(history, filesOnlyMarker),
    AGENT_WAIT_MS,
  )

  progress('chat-attachments:remove')
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, agentUrl)
  await surface.waitFor({ state: 'visible', timeout: 60_000 })
  const removeName = `remove-${suffix}.txt`
  const removePath = `agents/${agentSlug}/uploads/${removeName}`
  recordFileCleanup(context, removePath)
  await surface
    .locator('[data-compose-bar-editor]')
    .fill('This second message is a draft; remove its attachment before sending.')
  await surface.locator('input[type="file"]').setInputFiles({
    name: removeName,
    mimeType: 'text/plain',
    buffer: Buffer.from(`Delete this upload before sending ${suffix}.\n`),
  })
  await waitForReadyCard(surface, removeName)
  await readFileStat(context, removePath, 'removable attachment stat')
  await surface.getByRole('button', { name: `Remove ${removeName}`, exact: true }).click()
  await waitForMissingFile(context, removePath)

  const onboardingAgent = await runLockedOnboardingLeg(context, suffix)

  return {
    registeredAgent: {
      agentSlug,
      sessionId: defaultSession.id,
      uploadedPaths: [smallPath, largePath],
      largeAttachmentBytes: LARGE_ATTACHMENT_BYTES,
      uploadingObserved: true,
      sendGatedWhileUploading,
      bubbleCardNames: [smallName, largeName],
      viewerOpenedInPlace,
      userAttributedPaths: [smallPath, largePath],
      summaryMarker,
      removedPath: removePath,
      removedFileDeleted: true,
      filesOnly: { path: filesOnlyPath, sendEnabledWithoutWords, marker: filesOnlyMarker },
    },
    onboardingAgent,
    uploadCeiling,
  }
}

/**
 * Who refuses an oversize upload on the real edge — asked without sending one.
 *
 * The one thing local tests cannot answer: whether exe.dev's public proxy has a
 * body ceiling of its own in front of the gateway. Two request heads, no
 * payload, milliseconds. Over the cap we expect our own typed refusal; between
 * the old ~1 GiB ceiling and the cap we expect silence, because the server
 * should be waiting for a body. Anything else is the finding.
 */
async function runUploadCeilingLeg(
  context: WorkspaceBrowserJourneyContext,
): Promise<ChatAttachmentsEvidence['uploadCeiling']> {
  const { env, workspace, apiToken, artifacts, progress } = context
  progress('chat-attachments:upload-ceiling')

  const grant = VmUploadGrantSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/ws/${workspace.slug}/file-uploads`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({ pathPrefix: 'uploads' }),
      },
      200,
      'upload ceiling grant',
      artifacts,
    ),
  )

  const ask = async (declaredBytes: number) => {
    const probe = await probeDeclaredBodyCeiling({
      vmBaseUrl: grant.vmBaseUrl,
      uploadPath: grant.uploadPath,
      uploadToken: grant.uploadToken,
      filename: 'ceiling-probe.bin',
      declaredBytes,
      timeoutMs: CEILING_PROBE_WAIT_MS,
    })
    return {
      verdict: classifyUploadCeilingProbe(probe),
      status: probe.kind === 'answered' ? probe.status : null,
      elapsedMs: probe.elapsedMs,
    }
  }

  const overCap = await ask(DRIVE_UPLOAD_MAX_BYTES + 1)
  const underCap = await ask(2 * 1024 ** 3)
  /* A discriminator, not a third question. Bun's own ceiling refuses on the
     declaration with a bare 413 and no CORS header, so a declaration far above
     it tells us whether *any* declare-time refusal reaches this VM at all —
     which is what separates "our cap is not deployed here" from "something in
     the path buffers the body and nobody ever sees the declaration". */
  const farAboveTransport = await ask(200 * 1024 ** 3)

  /* Logged where it is learned, not only returned. A later leg failing for its
     own reasons must not take this answer with it — the whole point of the leg
     is that it is the one thing no local test can establish. */
  console.log(
    'STAGING_LIVE_UPLOAD_CEILING',
    JSON.stringify({ capBytes: DRIVE_UPLOAD_MAX_BYTES, overCap, underCap, farAboveTransport }),
  )

  // Recorded rather than asserted: `refused-in-front` on either probe means the
  // proxy caps below us and the published limit is wrong, which is a decision
  // for a person, not a failed run.
  return { overCap, underCap, farAboveTransport }
}

async function runLockedOnboardingLeg(
  context: WorkspaceBrowserJourneyContext,
  suffix: string,
): Promise<ChatAttachmentsEvidence['onboardingAgent']> {
  const { env, page, workspace, apiToken, runId, ledger, artifacts, progress } = context
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}`
  const agentSlug = 'brand-designer'
  const marker = `LOCKED-${suffix}`
  const logoName = `logo-${suffix}.svg`
  const fontName = `typeface-${suffix}.woff2`
  const fontBytes = Buffer.from(
    await Bun.file(
      new URL('../../../apps/web/public/fonts/sans-variable.woff2', import.meta.url),
    ).arrayBuffer(),
  )

  progress('chat-attachments:onboarding-install-brand-designer')
  const catalog = await loadAllMarketplaceCatalog(
    `${env.apiUrl}/v1/marketplace`,
    apiToken,
    'chat attachments Brand Designer listing',
    artifacts,
  )
  const listing = catalog.items.find(
    candidate =>
      candidate.agentName === agentSlug &&
      candidate.verifiedPublisher &&
      candidate.availability === 'available',
  )
  assert(listing !== undefined, 'the verified Brand Designer listing was not installable')
  const subscriptionsUrl = `${base}/marketplace/subscriptions`
  const installed = MarketplaceAgentSubscriptionResponseSchema.parse(
    await apiJson(
      subscriptionsUrl,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({ listingId: listing.id, name: 'Brand Designer' }),
      },
      201,
      'install Brand Designer for attachment onboarding',
      artifacts,
    ),
  ).subscription
  assert.equal(installed.agentName, agentSlug)
  assert.equal(installed.state, 'active', 'Brand Designer install did not become active')
  assert(installed.agentId !== undefined, 'Brand Designer install omitted its registered agent id')
  ledger.record({
    kind: 'official-agent-subscription',
    id: installed.id,
    label: `${runId}:chat-attachments-brand-designer:${installed.id}`,
    cleanup: async () => {
      const response = await stagingFetch(
        `${subscriptionsUrl}/${encodeURIComponent(installed.id)}`,
        { method: 'DELETE', headers: bearer(apiToken) },
      )
      assert(
        [200, 404].includes(response.status),
        `Brand Designer cleanup returned HTTP ${response.status}`,
      )
    },
    verify: async () =>
      await workspaceIsDeleted(context.convex, context.env.internalKey, context.workspace._id),
  })
  const anchorPath = installed.path
  const uploadedPaths = [`${anchorPath}/uploads/${logoName}`, `${anchorPath}/uploads/${fontName}`]

  const opened = OpenOnboardingSessionResponseSchema.parse(
    await apiJson(
      `${base}/agents/${agentSlug}/onboarding-session`,
      { method: 'POST', headers: bearerJson(apiToken) },
      200,
      'chat attachments onboarding session',
      artifacts,
    ),
  )
  recordSessionCleanup(context, opened.sessionId, 'onboarding-agent')
  await waitForSessionSnapshot(
    env,
    workspace.slug,
    opened.sessionId,
    apiToken,
    snapshot => snapshot.turnStatus !== 'running',
    AGENT_WAIT_MS,
  )
  const locked = SessionSnapshotSchema.parse(
    await apiJson(
      `${base}/agent/sessions/${opened.sessionId}`,
      { headers: bearer(apiToken) },
      200,
      'locked onboarding session snapshot',
      artifacts,
    ),
  )
  assert.equal(locked.onboarding, true, 'attachment onboarding session lost its lock marker')
  assert.equal(
    locked.agent?.id,
    installed.agentId,
    'attachment onboarding session used another agent',
  )
  const listed = AgentListResponseSchema.parse(
    await apiJson(
      `${base}/agents`,
      { headers: bearer(apiToken) },
      200,
      'locked attachment onboarding agent',
      artifacts,
    ),
  )
  const installedAgent = listed.items.find(candidate => candidate.id === installed.agentId)
  assert(installedAgent !== undefined, 'installed Brand Designer was absent from the agent roster')
  assert.equal(
    installedAgent.onboardedAt,
    undefined,
    'attachment onboarding agent unlocked before the user attached a file',
  )

  progress('chat-attachments:onboarding-upload')
  const agentUrl = `${env.appUrl}/w/${encodeURIComponent(workspace.slug)}/agents/${encodeURIComponent(agentSlug)}`
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, agentUrl)
  const surface = page.locator('[data-session-surface="product"]')
  await surface.waitFor({ state: 'visible', timeout: 60_000 })
  const editor = surface.locator('[data-compose-bar-editor]')
  await editor.fill(
    'There is no website to inspect. I attached the real logo and font files. Read the logo file now, summarize its title, and report the validation token from that title.',
  )
  for (const path of uploadedPaths) recordFileCleanup(context, path)
  await surface.locator('input[type="file"]').setInputFiles([
    {
      name: logoName,
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg"><title>Calm blue logo ${marker}</title><rect width="12" height="12" fill="#2457a6"/></svg>\n`,
      ),
    },
    {
      name: fontName,
      mimeType: 'font/woff2',
      buffer: fontBytes,
    },
  ])
  await waitForReadyCard(surface, logoName)
  await waitForReadyCard(surface, fontName)
  await readFileStat(context, uploadedPaths[0]!, 'Brand Designer logo attachment stat')
  await readFileStat(context, uploadedPaths[1]!, 'Brand Designer font attachment stat')
  await surface.getByRole('button', { name: 'Send', exact: true }).click()
  await waitForSessionHistory(
    env,
    workspace.slug,
    opened.sessionId,
    apiToken,
    history => terminalResultIncludes(history, marker),
    AGENT_WAIT_MS,
  )

  return {
    agentSlug,
    sessionId: opened.sessionId,
    uploadedPaths,
    lockedBeforeAttachment: true,
    summaryMarker: marker,
  }
}

async function waitForReadyCard(surface: Locator, name: string): Promise<void> {
  await waitForCompletedCard(surface, name, 'file')
}

async function waitForCompletedCard(
  surface: Locator,
  name: string,
  kind: 'file' | 'inline-image',
): Promise<void> {
  const card = surface.locator('[data-attachment-card]').filter({ hasText: name })
  await card.waitFor({ state: 'visible', timeout: 30_000 })
  const completion = attachmentCardCompletion(kind)
  if ('visible' in completion) {
    await card.getByText(completion.visible, { exact: true }).waitFor({ timeout: UPLOAD_WAIT_MS })
  } else {
    await card.getByText(completion.hidden, { exact: true }).waitFor({
      state: 'hidden',
      timeout: UPLOAD_WAIT_MS,
    })
  }
}

async function waitForDefaultSession(context: WorkspaceBrowserJourneyContext, agentSlug: string) {
  const url = `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/agents/${agentSlug}/sessions/default`
  const deadline = Date.now() + 60_000
  for (;;) {
    // An owner with no chat yet answers 200 `{ session: null }`, not a 404.
    const { session } = DefaultSessionResponseSchema.parse(
      await apiJson<unknown>(
        url,
        { headers: bearer(context.apiToken) },
        200,
        'default session lookup',
        context.artifacts,
      ),
    )
    if (session !== null) return session
    assert(Date.now() < deadline, 'default session was not created after attachment send')
    await Bun.sleep(POLL_MS)
  }
}

async function readFileStat(context: WorkspaceBrowserJourneyContext, path: string, label: string) {
  return FileStatResponseSchema.parse(
    await apiJson(
      `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/files/${encodeDrivePath(path)}?stat=1`,
      { headers: bearer(context.apiToken) },
      200,
      label,
      context.artifacts,
    ),
  )
}

async function waitForAttributedWrite(
  context: WorkspaceBrowserJourneyContext,
  path: string,
  userId: string,
): Promise<void> {
  const deadline = Date.now() + 60_000
  for (;;) {
    const history = FileHistoryResponseSchema.parse(
      await apiJson(
        `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/file-activity?path=${encodeURIComponent(path)}&reads=0`,
        { headers: bearer(context.apiToken) },
        200,
        `attachment attribution: ${path}`,
        context.artifacts,
      ),
    )
    if (hasAttributedBrowserWrite(history, path, userId)) return
    assert(
      Date.now() < deadline,
      `attachment write never received browser-user attribution: ${path}`,
    )
    await Bun.sleep(POLL_MS)
  }
}

async function waitForMissingFile(
  context: WorkspaceBrowserJourneyContext,
  path: string,
): Promise<void> {
  const url = `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/files/${encodeDrivePath(path)}?stat=1`
  const deadline = Date.now() + 60_000
  for (;;) {
    const response = await stagingFetch(url, { headers: bearer(context.apiToken) })
    if (response.status === 404) return
    assert.equal(response.status, 200, `removed attachment stat returned HTTP ${response.status}`)
    assert(Date.now() < deadline, `removed attachment still existed: ${path}`)
    await Bun.sleep(POLL_MS)
  }
}

function recordFileCleanup(context: WorkspaceBrowserJourneyContext, path: string): void {
  const url = `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/files/${encodeDrivePath(path)}`
  context.ledger.record({
    kind: 'file',
    id: path,
    label: `${context.runId}:chat-attachment-file:${path}`,
    cleanup: async () => {
      const response = await stagingFetch(url, {
        method: 'DELETE',
        headers: bearer(context.apiToken),
      })
      assert(
        [200, 404].includes(response.status),
        `chat attachment file cleanup returned HTTP ${response.status}`,
      )
    },
    verify: async () =>
      await workspaceIsDeleted(context.convex, context.env.internalKey, context.workspace._id),
  })
}

function recordSessionCleanup(
  context: WorkspaceBrowserJourneyContext,
  sessionId: string,
  label: string,
): void {
  context.ledger.record({
    kind: 'session',
    id: sessionId,
    label: `${context.runId}:chat-attachments-${label}:${sessionId}`,
    cleanup: async () =>
      await deleteStagingSession(context.env, context.workspace.slug, sessionId, context.apiToken),
    verify: async () =>
      await workspaceIsDeleted(context.convex, context.env.internalKey, context.workspace._id),
  })
}

function encodeDrivePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}
