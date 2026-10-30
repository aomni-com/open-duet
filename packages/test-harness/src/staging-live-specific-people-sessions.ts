import assert from 'node:assert/strict'

import {
  AppResponseSchema,
  SessionActivityResponseSchema,
  SessionAudiencePageSchema,
  SessionCreateResponseSchema,
  SessionHistoryPageSchema,
  type SessionListPage,
  SessionListPageSchema,
  type SessionSummary,
  SessionSummarySchema,
  SessionSnapshotSchema,
  type SessionSnapshot,
} from '@repo/contract'

import { deleteStagingSession, waitForSessionSnapshot } from './staging-live-agent-sessions.ts'
import { markExpectedBrowserTransition, navigateDeployedPage } from './staging-live-browser.ts'
import {
  verifyReleaseDeployment,
  type ReleaseDeploymentEvidence,
} from './staging-live-deployment.ts'
import { fnMutation, fnQuery } from './staging-live-env.ts'
import { apiJson, apiText, bearer, bearerJson, stagingFetch } from './staging-live-http.ts'
import {
  acquireInvitedMemberBrowser,
  createTrackedWorkspaceInvite,
  readBrowserSessionCredential,
  runInviteBrowserAttempt,
  type InvitedMemberBrowser,
} from './staging-live-invited-member.ts'
import { resolveAgentMailInbox, taggedInboxAddress } from './staging-live-mailbox.ts'
import { collectOpaquePages } from './staging-live-pagination.ts'
import { workspaceIsDeleted } from './staging-live-resource-ledger.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'

export type SpecificPeopleSessionsEvidence = {
  release: ReleaseDeploymentEvidence
  sessionId: string
  browserRoles: readonly ['editor-creator', 'selected-viewer', 'owner-override']
  uiCreatedSpecificAudience: true
  ownerOverride: true
  genericDenial: true
  audiencePages: number
  sseReconnectDenied: true
  appPrincipalSurvivedActorRemoval: true
  finalMemberArchived: true
}

export async function runSpecificPeopleSessionsJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<SpecificPeopleSessionsEvidence>> {
  return await runWorkspaceBrowserJourney({
    journey: 'specific-people-sessions',
    label: 'Specific People Sessions',
    onProgress: options.onProgress,
    run: runSpecificPeopleSessionsAcceptance,
  })
}

export async function runSpecificPeopleSessionsAcceptance(
  context: WorkspaceBrowserJourneyContext,
): Promise<SpecificPeopleSessionsEvidence> {
  const browser = context.page.context().browser()
  assert(browser !== null, 'workspace-browser fixture did not expose its browser')
  const inbox = await resolveAgentMailInbox({
    apiKey: context.env.agentMailApiKey,
    address: context.env.agentMailInboxAddress,
  })
  const inviteTag = `staging-e2e-${context.runId.split('-').slice(-2).join('-')}`
  const creatorEmail = taggedInboxAddress(inbox.address, `${inviteTag}-creator`)
  const viewerEmail = taggedInboxAddress(inbox.address, `${inviteTag}-viewer`)
  let creator: InvitedMemberBrowser | undefined
  let viewer: InvitedMemberBrowser | undefined
  let audiencePages = 0

  try {
    context.progress('specific-people:release-deployment')
    const release = await verifyReleaseDeployment(context)
    context.progress('specific-people:docs-contract')
    context.progress('specific-people:members')
    creator = await acquireInvitedMemberBrowser({
      ...context,
      browser,
      ownerToken: context.apiToken,
      email: creatorEmail,
      role: 'editor',
      mailCorrelationMarker: inviteTag,
      inboxId: inbox.id,
    })
    viewer = await acquireInvitedMemberBrowser({
      ...context,
      browser,
      ownerToken: context.apiToken,
      email: viewerEmail,
      role: 'viewer',
      mailCorrelationMarker: inviteTag,
      inboxId: inbox.id,
    })

    context.progress('specific-people:ui-create')
    const sessionId = await createSpecificSessionThroughUi(context, creator, viewer)
    recordSessionCleanup(context, sessionId)
    const base = `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/agent/sessions`
    const sessionPath = `${base}/${sessionId}`

    const createdWire = await apiJson<Record<string, unknown>>(
      sessionPath,
      { headers: bearer(creator.apiToken) },
      200,
      'creator session',
      context.artifacts,
    )
    assertNoLegacySessionWireFields(createdWire)
    const created = SessionSnapshotSchema.parse(createdWire)
    assert.deepEqual(created.audience.kind, 'specific')
    assert.equal(created.audience.kind === 'specific' ? created.audience.count : 0, 2)

    const historyWire = await apiJson(
      `${sessionPath}/history`,
      { headers: bearer(creator.apiToken) },
      200,
      'strict history page for exact UI-created session',
      context.artifacts,
    )
    assert.deepEqual(Object.keys(historyWire as object).sort(), ['items', 'nextCursor'])
    assert(
      !Object.hasOwn(historyWire as object, 'events'),
      'history returned removed events page key',
    )
    const history = SessionHistoryPageSchema.parse(historyWire)
    assert(history.items.length > 0, 'exact UI-created session returned empty history')

    context.progress('specific-people:legacy-refusals')
    await assertLegacySessionShapesRejected(base, sessionPath, creator.apiToken)

    context.progress('specific-people:browser-surfaces')
    await assertSessionInHumanSurfaces(base, viewer.apiToken, sessionId, context)
    await assertSessionBrowserVisible(viewer.page, context, created)
    await assertSessionBrowserListAndActivity(viewer.page, context, created, true)
    await assertSessionBrowserVisible(context.page, context, created)
    await context.page.locator('[data-session-audience-preview]').waitFor()
    await apiJson(
      `${sessionPath}/messages`,
      {
        method: 'POST',
        headers: bearerJson(viewer.apiToken),
        body: JSON.stringify({
          prompt: `Selected viewer prompt ${context.runId}`,
          clientRequestId: crypto.randomUUID(),
        }),
      },
      202,
      'selected viewer prompt',
      context.artifacts,
    )
    const ownerSnapshot = SessionSnapshotSchema.parse(
      await apiJson(
        sessionPath,
        { headers: bearer(context.apiToken) },
        200,
        'owner override point read',
        context.artifacts,
      ),
    )
    assert(ownerSnapshot.permissions.manageAudience, 'workspace owner lacked audience override')

    context.progress('specific-people:audience-api')
    const audiencePath = `${sessionPath}/audience`
    const audienceItems: Array<{ userId: string }> = []
    let audienceCursor: string | null = null
    const seenAudienceCursors = new Set<string>()
    do {
      const audiencePage = SessionAudiencePageSchema.parse(
        await apiJson(
          `${audiencePath}?limit=1${audienceCursor === null ? '' : `&cursor=${encodeURIComponent(audienceCursor)}`}`,
          { headers: bearer(viewer.apiToken) },
          200,
          `audience page ${audiencePages + 1}`,
          context.artifacts,
        ),
      )
      audiencePages += 1
      audienceItems.push(...audiencePage.items)
      audienceCursor = audiencePage.nextCursor
      if (audienceCursor !== null) {
        assert(!seenAudienceCursors.has(audienceCursor), 'audience pagination repeated a cursor')
        seenAudienceCursors.add(audienceCursor)
      }
      assert(audiencePages <= 10, 'audience pagination did not converge')
    } while (audienceCursor !== null)
    assert(audiencePages >= 2, 'two-member audience did not exercise pagination')
    assert.deepEqual(
      new Set(audienceItems.map(item => item.userId)),
      new Set([creator.userId, viewer.userId]),
    )

    context.progress('specific-people:sse-removal')
    // A completed session closes its stream once caught up. Live acceptance
    // therefore owns reconnect revocation; the deterministic API test owns
    // draining an already-admitted response after membership removal.
    const admittedStream = await stagingFetch(`${sessionPath}/events`, {
      headers: bearer(creator.apiToken),
    })
    assert.equal(admittedStream.status, 200, 'creator could not open SSE before removal')
    await admittedStream.body?.cancel()
    const selfRemoval = await stagingFetch(audiencePath, {
      method: 'PATCH',
      headers: bearerJson(creator.apiToken),
      body: JSON.stringify({ remove: [creator.userId] }),
    })
    assert.equal(selfRemoval.status, 204, 'editor self-removal did not lose access atomically')
    await assertGenericNotFound(sessionPath, creator.apiToken)
    await assertSessionAbsentFromHumanSurfaces(base, creator.apiToken, sessionId, context)
    await assertSessionBrowserListAndActivity(creator.page, context, created, false)
    const unavailableContext = await openUncachedBrowserContext(creator.page)
    const unavailablePage = await unavailableContext.newPage()
    try {
      await navigateDeployedPageAndWaitForApi(
        unavailablePage,
        `${context.env.appUrl}/w/${context.workspace.slug}/agents/root/sessions/${sessionId}`,
        `/api/duet/ws/${context.workspace.slug}/agent/sessions/${sessionId}`,
        404,
      )
      await waitForRemovedSessionBrowserSurface(unavailablePage).catch(async error => {
        await Promise.all([
          unavailablePage.screenshot({
            path: `${context.artifacts.directory}/missing-session-unavailable.png`,
            fullPage: true,
          }),
          context.artifacts.writeJson('missing-session-unavailable.json', {
            url: unavailablePage.url(),
            text: await unavailablePage.locator('body').innerText(),
            headings: await unavailablePage.getByRole('heading').allInnerTexts(),
          }),
        ])
        throw error
      })
    } finally {
      await unavailableContext.close()
    }
    const removedReconnect = await stagingFetch(`${sessionPath}/events`, {
      headers: bearer(creator.apiToken),
    })
    assert.equal(removedReconnect.status, 404, 'removed creator reconnected to session SSE')
    const reconnect = await stagingFetch(`${sessionPath}/events`, {
      headers: bearer(viewer.apiToken, { 'last-event-id': String(created.lastEventSeq) }),
    })
    assert.equal(reconnect.status, 200, 'still-selected viewer lost reconnect before removal')
    await reconnect.body?.cancel()

    context.progress('specific-people:archive-precedence')
    const viewerGlobalDenied = await stagingFetch(`${sessionPath}/archive`, {
      method: 'PUT',
      headers: bearerJson(viewer.apiToken),
      body: JSON.stringify({ kind: 'global', archived: true }),
    })
    assert.equal(viewerGlobalDenied.status, 403, 'viewer changed global lifecycle')
    const personal = SessionSummarySchema.parse(
      await apiJson(
        `${sessionPath}/archive`,
        {
          method: 'PUT',
          headers: bearerJson(viewer.apiToken),
          body: JSON.stringify({ kind: 'personal', archived: true }),
        },
        200,
        'viewer personal archive',
        context.artifacts,
      ),
    )
    assert.equal(personal.archive.reason, 'personal')
    await assertSessionBrowserListAndActivity(viewer.page, context, personal, false)
    const global = await putArchive(sessionPath, context.apiToken, 'global', true, context)
    assert.equal(global.archive.reason, 'global')
    await assertSessionBrowserListAndActivity(context.page, context, global, false)
    const restored = await putArchive(sessionPath, context.apiToken, 'global', false, context)
    assert.equal(
      restored.archive.reason,
      null,
      'owner-relative point read inherited viewer archive',
    )
    await assertSessionBrowserListAndActivity(context.page, context, restored, true)
    const viewerRestored = SessionSnapshotSchema.parse(
      await apiJson(
        sessionPath,
        { headers: bearer(viewer.apiToken) },
        200,
        'viewer preserved personal archive',
        context.artifacts,
      ),
    )
    assert.equal(viewerRestored.archive.reason, 'personal')
    await assertSessionBrowserListAndActivity(viewer.page, context, viewerRestored, false)
    const viewerActive = await putArchive(sessionPath, viewer.apiToken, 'personal', false, context)
    await assertSessionBrowserListAndActivity(viewer.page, context, viewerActive, true)

    context.progress('specific-people:app-principal')
    viewer.apiToken = await readBrowserSessionCredential(viewer.context, context.env.appUrl)
    const viewerIdentity = await apiJson<{ user: { id: string } }>(
      `${context.env.apiUrl}/v1/whoami`,
      { headers: bearer(viewer.apiToken) },
      200,
      'refreshed viewer identity',
      context.artifacts,
    )
    assert.equal(
      viewerIdentity.user.id,
      viewer.userId,
      'viewer browser credential changed identity',
    )
    const app = await provisionSessionsAppPrincipal(context)
    const appPoint = SessionSnapshotSchema.parse(
      await apiJson(
        sessionPath,
        { headers: bearer(await app.freshToken()) },
        200,
        'app point read',
        context.artifacts,
      ),
    )
    assert.equal(appPoint.unread, false, 'workspace principal received human unread state')
    assert.equal(appPoint.permissions.personalArchive, false)
    assert(appPoint.permissions.globalArchive)
    await putArchive(sessionPath, await app.freshToken(), 'global', true, context)
    await putArchive(sessionPath, await app.freshToken(), 'global', false, context)

    const child = await createApiSession(
      `${sessionPath}/sessions`,
      await app.freshToken(),
      `Nested audience copy ${context.runId}`,
      undefined,
      context,
    )
    recordSessionCleanup(context, child.snapshot.id)
    assert.equal(child.snapshot.createdBySessionId, sessionId)
    assert.equal(child.snapshot.audience.kind, 'specific')
    assert.equal(
      child.snapshot.audience.kind === 'specific' ? child.snapshot.audience.count : -1,
      1,
    )
    const expandedParent = SessionSummarySchema.parse(
      await apiJson(
        audiencePath,
        {
          method: 'PATCH',
          headers: bearerJson(await app.freshToken()),
          body: JSON.stringify({ add: [creator.userId] }),
        },
        200,
        'app expands parent audience',
        context.artifacts,
      ),
    )
    assert.equal(
      expandedParent.audience.kind === 'specific' ? expandedParent.audience.count : -1,
      2,
    )
    const childAfterParentEdit = SessionSnapshotSchema.parse(
      await apiJson(
        `${base}/${child.snapshot.id}`,
        { headers: bearer(await app.freshToken()) },
        200,
        'nested audience divergence',
        context.artifacts,
      ),
    )
    assert.equal(
      childAfterParentEdit.audience.kind === 'specific' ? childAfterParentEdit.audience.count : -1,
      1,
      'nested audience followed a later parent edit',
    )

    const siblingOne = await createApiSession(
      base,
      await app.freshToken(),
      `Specific paging ${context.runId} one`,
      [viewer.userId],
      context,
    )
    const siblingTwo = await createApiSession(
      base,
      await app.freshToken(),
      `Specific paging ${context.runId} two`,
      [viewer.userId],
      context,
    )
    recordSessionCleanup(context, siblingOne.snapshot.id)
    recordSessionCleanup(context, siblingTwo.snapshot.id)
    for (const [id, title] of [
      [sessionId, `${context.runId} specific main`],
      [siblingOne.snapshot.id, `${context.runId} specific one`],
      [siblingTwo.snapshot.id, `${context.runId} specific two`],
    ]) {
      await apiJson(
        `${base}/${id}`,
        {
          method: 'PATCH',
          headers: bearerJson(await app.freshToken()),
          body: JSON.stringify({ title }),
        },
        200,
        'page-size-two search title',
        context.artifacts,
      )
    }
    const pageTargets = new Set([sessionId, siblingOne.snapshot.id, siblingTwo.snapshot.id])
    const creatorUserId = creator.userId
    viewer.apiToken = await readBrowserSessionCredential(viewer.context, context.env.appUrl)
    let listedIds = await walkSessionPages(
      `${base}?limit=2`,
      viewer.apiToken,
      context,
      async firstPage => {
        const mutable = firstPage.items.find(item =>
          [siblingOne.snapshot.id, siblingTwo.snapshot.id].includes(item.id),
        )
        assert(mutable !== undefined, 'size-two first page omitted a mutable specific session')
        const mutablePath = `${base}/${mutable.id}`
        await apiJson(
          `${mutablePath}/audience`,
          {
            method: 'PATCH',
            headers: bearerJson(await app.freshToken()),
            body: JSON.stringify({ add: [creatorUserId] }),
          },
          200,
          'between-page audience add',
          context.artifacts,
        )
        await apiJson(
          `${mutablePath}/audience`,
          {
            method: 'PATCH',
            headers: bearerJson(await app.freshToken()),
            body: JSON.stringify({ remove: [creatorUserId] }),
          },
          200,
          'between-page audience remove',
          context.artifacts,
        )
        await putArchive(mutablePath, await app.freshToken(), 'global', true, context)
        await putArchive(mutablePath, await app.freshToken(), 'global', false, context)
      },
    )
    // These are real agent sessions, so their event streams may move an
    // untouched row ahead of an already-issued recency cursor while this first
    // traversal deliberately mutates another row between pages. Opaque cursor
    // pagination guarantees a stable boundary, not snapshot isolation across
    // concurrent writes. Retry a fresh traversal until the live rows settle;
    // the first pass above remains the between-page mutation proof.
    if ([...pageTargets].some(id => !listedIds.has(id))) {
      listedIds = await waitForPageCompleteness(
        `${base}?limit=2`,
        viewer.apiToken,
        pageTargets,
        context,
      )
    }
    for (const id of pageTargets) assert(listedIds.has(id), `size-two list omitted ${id}`)
    viewer.apiToken = await readBrowserSessionCredential(viewer.context, context.env.appUrl)
    const searchedIds = await waitForSearchPageCompleteness(
      base,
      viewer.apiToken,
      pageTargets,
      context,
    )
    for (const id of pageTargets) assert(searchedIds.has(id), `size-two search omitted ${id}`)

    await apiJson(
      `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/members/${creator.userId}`,
      { method: 'DELETE', headers: bearer(context.apiToken) },
      200,
      'app surrogate actor membership deletion',
      context.artifacts,
    )
    const postRemovalAppSession = await createApiSession(
      base,
      await app.freshToken(),
      `App survives actor removal ${context.runId}`,
      [viewer.userId],
      context,
    )
    recordSessionCleanup(context, postRemovalAppSession.snapshot.id)
    const postRemovalAppPath = `${base}/${postRemovalAppSession.snapshot.id}`
    const postRemovalAppRead = SessionSnapshotSchema.parse(
      await apiJson(
        postRemovalAppPath,
        { headers: bearer(await app.freshToken()) },
        200,
        'app reads session created after actor deletion',
        context.artifacts,
      ),
    )
    assert.equal(postRemovalAppRead.id, postRemovalAppSession.snapshot.id)
    assert(postRemovalAppRead.permissions.manageAudience)
    assert(postRemovalAppRead.permissions.globalArchive)
    const emptiedPostRemovalAudience = SessionSummarySchema.parse(
      await apiJson(
        `${postRemovalAppPath}/audience`,
        {
          method: 'PATCH',
          headers: bearerJson(await app.freshToken()),
          body: JSON.stringify({ remove: [viewer.userId] }),
        },
        200,
        'app manages audience after actor deletion',
        context.artifacts,
      ),
    )
    assert.equal(
      emptiedPostRemovalAudience.audience.kind === 'specific'
        ? emptiedPostRemovalAudience.audience.count
        : -1,
      0,
    )
    assert.equal(emptiedPostRemovalAudience.archive.reason, 'global')
    for (const [archived, expectedReason] of [
      [false, null],
      [true, 'global'],
      [false, null],
    ] as const) {
      const lifecycle = await putArchive(
        postRemovalAppPath,
        await app.freshToken(),
        'global',
        archived,
        context,
      )
      assert.equal(lifecycle.archive.reason, expectedReason)
    }

    context.progress('specific-people:membership-rejoin')
    const removedViewerUserId = viewer.userId
    await apiJson(
      `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/members/${removedViewerUserId}`,
      { method: 'DELETE', headers: bearer(context.apiToken) },
      200,
      'actual selected-viewer membership deletion',
      context.artifacts,
    )
    const membersAfterRemoval = (await context.convex.query(
      fnQuery('testing/workspaces:workspaceMembersForTest'),
      { internalKey: context.env.internalKey, workspaceId: context.workspace._id },
    )) as Array<{ userId: string }>
    assert(
      !membersAfterRemoval.some(member => member.userId === removedViewerUserId),
      'selected viewer membership survived its deletion response',
    )
    await waitForRemovedMemberSessionDenial(
      sessionPath,
      viewer.apiToken,
      context.workspace.slug,
      'initial viewer removal',
    )
    context.progress('specific-people:membership-removed')
    const deniedReconnect = await stagingFetch(`${sessionPath}/events`, {
      headers: bearer(viewer.apiToken, { 'last-event-id': String(created.lastEventSeq) }),
    })
    assert(
      isRemovedMemberSessionDenial(
        deniedReconnect.status,
        await deniedReconnect.json(),
        context.workspace.slug,
      ),
      'removed participant reconnected to session SSE',
    )

    const archivedAfterFinalMember = await waitForSessionSnapshot(
      context.env,
      context.workspace.slug,
      sessionId,
      await app.freshToken(),
      snapshot =>
        snapshot.audience.kind === 'specific' &&
        snapshot.audience.count === 0 &&
        snapshot.archive.reason === 'global',
      60_000,
      { artifacts: context.artifacts, timeoutLabel: 'final-member archive convergence' },
    )
    assert.equal(archivedAfterFinalMember.audience.kind, 'specific')
    assert.equal(
      archivedAfterFinalMember.audience.kind === 'specific'
        ? archivedAfterFinalMember.audience.count
        : -1,
      0,
    )
    assert.equal(archivedAfterFinalMember.archive.reason, 'global')

    const invite = await createTrackedWorkspaceInvite({
      ...context,
      ownerToken: context.apiToken,
      email: viewerEmail,
      role: 'viewer',
      mailCorrelationMarker: inviteTag,
      inboxId: inbox.id,
    })
    // The existing identity is already ledgered; only its new membership is
    // acquired here. The shared invite helper still owns the browser login.
    await runInviteBrowserAttempt({
      env: context.env,
      browser,
      inviteLink: invite.link,
      email: viewerEmail,
      runId: context.runId,
      mailCorrelationMarker: inviteTag,
      inboxId: inbox.id,
      artifacts: context.artifacts,
      ledger: context.ledger,
      expected: 'accepted',
      workspaceSlug: context.workspace.slug,
    })
    await assertGenericNotFound(sessionPath, viewer.apiToken)
    await apiJson(
      audiencePath,
      {
        method: 'PATCH',
        headers: bearerJson(await app.freshToken()),
        body: JSON.stringify({ add: [viewer.userId] }),
      },
      200,
      'app restores rejoined viewer audience',
      context.artifacts,
    )
    await apiJson(
      sessionPath,
      { headers: bearer(viewer.apiToken) },
      200,
      'rejoined viewer restored point read',
      context.artifacts,
    )
    await apiJson(
      `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/members/${viewer.userId}`,
      { method: 'DELETE', headers: bearer(context.apiToken) },
      200,
      'final selected-viewer membership deletion',
      context.artifacts,
    )
    await waitForRemovedMemberSessionDenial(
      sessionPath,
      viewer.apiToken,
      context.workspace.slug,
      'final viewer removal',
    )
    const appAfterActorRemoval = SessionSnapshotSchema.parse(
      await apiJson(
        sessionPath,
        { headers: bearer(await app.freshToken()) },
        200,
        'app after surrogate actor removal',
        context.artifacts,
      ),
    )
    assert.equal(appAfterActorRemoval.archive.reason, 'global')

    return {
      release,
      sessionId,
      browserRoles: ['editor-creator', 'selected-viewer', 'owner-override'],
      uiCreatedSpecificAudience: true,
      ownerOverride: true,
      genericDenial: true,
      audiencePages,
      sseReconnectDenied: true,
      appPrincipalSurvivedActorRemoval: true,
      finalMemberArchived: true,
    }
  } finally {
    await viewer?.close().catch(() => undefined)
    await creator?.close().catch(() => undefined)
  }
}

export function assertNoLegacySessionWireFields(row: Record<string, unknown>): void {
  assert(!Object.hasOwn(row, 'userId'), 'deployed response leaked flat userId')
  assert(!Object.hasOwn(row, 'archivedAt'), 'deployed response leaked flat archivedAt')
}

async function createSpecificSessionThroughUi(
  context: WorkspaceBrowserJourneyContext,
  creator: InvitedMemberBrowser,
  viewer: InvitedMemberBrowser,
): Promise<string> {
  const route = `/w/${context.workspace.slug}/agents/root/sessions/new`
  markExpectedBrowserTransition(creator.page)
  await navigateDeployedPage(creator.page, `${context.env.appUrl}${route}`)
  const picker = creator.page.locator('[data-session-audience-picker]')
  await picker.waitFor()
  const specificOption = picker.getByRole('radio', { name: 'Specific people' })
  await specificOption.click().catch(async error => {
    await Promise.all([
      creator.page.screenshot({
        path: `${context.artifacts.directory}/missing-specific-people-option.png`,
        fullPage: true,
      }),
      context.artifacts.writeJson('missing-specific-people-option.json', {
        url: creator.page.url(),
        pickerText: await picker.innerText(),
        radioLabels: await picker.getByRole('radio').allInnerTexts(),
      }),
    ])
    throw error
  })
  await picker.getByRole('button', { name: /Choose people/ }).click()
  const search = creator.page.getByRole('combobox', { name: 'Search people' })
  await search.fill(viewer.email)
  const option = creator.page.getByRole('option').filter({ hasText: viewer.email })
  await option.waitFor()
  await option.click()
  await creator.page.keyboard.press('Escape')

  const form = picker.locator('xpath=following::form[1]')
  await form.waitFor()
  const editor = form.locator('[data-compose-bar-editor]')
  await editor.fill(`Specific people staging proof ${context.runId}`)
  const send = form.getByRole('button', { name: 'Send', exact: true })
  await send.waitFor()
  assert.equal(await send.isEnabled(), true, 'specific-audience composer remained disabled')
  const requestPromise = creator.page.waitForRequest(request =>
    isSpecificSessionCreationResponse(
      { method: request.method(), url: request.url() },
      context.workspace.slug,
    ),
  )
  await send.click()
  const request = await requestPromise
  const requestBody = request.postDataJSON() as {
    audience?: { kind?: unknown; memberUserIds?: unknown }
  }
  assert.equal(requestBody.audience?.kind, 'specific')
  assert(Array.isArray(requestBody.audience?.memberUserIds))
  assert.deepEqual(
    new Set(requestBody.audience.memberUserIds),
    new Set([creator.userId, viewer.userId]),
  )
  const response = await request.response()
  assert(response !== null, 'specific-audience UI creation returned no response')
  assert.equal(response.status(), 201, 'specific-audience UI creation failed')
  const created = SessionCreateResponseSchema.parse(await response.json())
  assert.equal(created.snapshot.audience.kind, 'specific')
  return created.snapshot.id
}

export function isSpecificSessionCreationResponse(
  response: { method: string; url: string },
  workspaceSlug: string,
): boolean {
  return (
    response.method === 'POST' &&
    new URL(response.url).pathname === `/api/duet/ws/${workspaceSlug}/agent/sessions`
  )
}

function recordSessionCleanup(context: WorkspaceBrowserJourneyContext, sessionId: string): void {
  context.ledger.record({
    kind: 'session',
    id: sessionId,
    label: `${context.runId}:specific-people-session:${sessionId}`,
    cleanup: async () =>
      await deleteStagingSession(context.env, context.workspace.slug, sessionId, context.apiToken),
    verify: async () => {
      if (
        await workspaceIsDeleted(context.convex, context.env.internalKey, context.workspace._id)
      ) {
        return true
      }
      const response = await stagingFetch(
        `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/agent/sessions/${sessionId}`,
        { headers: bearer(context.apiToken) },
      )
      return response.status === 404
    },
  })
}

async function assertSessionBrowserVisible(
  page: InvitedMemberBrowser['page'],
  context: WorkspaceBrowserJourneyContext,
  session: SessionSnapshot,
): Promise<void> {
  const expected = specificPeopleBrowserExpectations(session)
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(
    page,
    `${context.env.appUrl}/w/${context.workspace.slug}/agents/root${expected.detailSuffix}`,
  )
  assert.equal(new URL(page.url()).pathname.endsWith(expected.detailSuffix), true)
  await page.locator('[data-session-surface="product"]').waitFor()
  const audience = page.locator('[data-session-audience-preview]')
  await audience.waitFor()
  assert.match(await audience.innerText(), new RegExp(`\\b${expected.audienceCount}\\b`))
}

async function assertSessionBrowserListAndActivity(
  page: InvitedMemberBrowser['page'],
  context: WorkspaceBrowserJourneyContext,
  session: SessionSnapshot | SessionSummary,
  visible: boolean,
): Promise<void> {
  const expected = specificPeopleBrowserExpectations(session)
  const proofContext = await openUncachedBrowserContext(page)
  const proofPage = await proofContext.newPage()
  try {
    await navigateDeployedPageAndWaitForApi(
      proofPage,
      `${context.env.appUrl}/w/${context.workspace.slug}/agents/root/settings`,
      `/api/duet/ws/${context.workspace.slug}/agent/sessions`,
      200,
    )
    await proofPage.locator('[data-destination-content="agentDetail"]').waitFor()
    const sessionLink = proofPage.locator(expected.linkSelector)
    if (visible) {
      await sessionLink.waitFor().catch(async error => {
        await Promise.all([
          proofPage.screenshot({
            path: `${context.artifacts.directory}/missing-session-list.png`,
            fullPage: true,
          }),
          context.artifacts.writeJson('missing-session-list.json', {
            url: proofPage.url(),
            expected,
            agent: session.agent,
            sessionLinks: await proofPage.locator('a[href*="/sessions/"]').evaluateAll(links =>
              links.map(link => ({
                href: link.getAttribute('href'),
                text: link.textContent?.trim(),
              })),
            ),
          }),
        ])
        throw error
      })
      assert.equal((await sessionLink.innerText()).trim(), expected.title)
    } else {
      await waitForStableSessionLinkAbsence(async () => await sessionLink.count())
    }

    const activityPage = await proofContext.newPage()
    try {
      const activityPath = `/api/duet/ws/${context.workspace.slug}/agent/sessions/activity`
      const activityResponsePromise = activityPage
        .waitForResponse(response => {
          const request = response.request()
          return request.method() === 'GET' && new URL(response.url()).pathname === activityPath
        })
        .catch(error => {
          throw new Error('cold browser did not load session activity', { cause: error })
        })
      await navigateDeployedPage(
        activityPage,
        `${context.env.appUrl}/w/${context.workspace.slug}/agents/root/sessions`,
      )
      await activityPage.locator('[data-destination-content="agentPage"]').waitFor()
      await activityPage.getByRole('dialog').waitFor()
      const browserActivityResponse = await activityResponsePromise
      assert.equal(browserActivityResponse.status(), 200, 'browser activity initial load failed')
      const browserActivity = SessionActivityResponseSchema.parse(
        await browserActivityResponse.json(),
      )
      assert.equal(
        browserActivity.owners.some(owner => owner.sessions.some(item => item.id === session.id)),
        visible,
        'browser activity response disagreed with participant visibility',
      )
      const activityPreview = activityPage
        .getByRole('dialog')
        .locator('button[data-current-job]')
        .filter({ hasText: expected.title })
      if (visible) {
        await activityPreview
          .first()
          .waitFor()
          .catch(async error => {
            await Promise.all([
              activityPage.screenshot({
                path: `${context.artifacts.directory}/missing-session-activity.png`,
                fullPage: true,
              }),
              context.artifacts.writeJson('missing-session-activity.json', {
                url: activityPage.url(),
                expected,
                visibleSessionRows: await activityPage
                  .getByRole('dialog')
                  .getByRole('button')
                  .allInnerTexts(),
              }),
            ])
            throw error
          })
      } else {
        assert.equal(
          await activityPreview.count(),
          0,
          'nonparticipant browser activity leaked session',
        )
      }
    } finally {
      await activityPage.close()
    }
  } finally {
    await proofContext.close()
  }
}

export async function waitForStableSessionLinkAbsence(
  count: () => Promise<number>,
  options: {
    stableForMs?: number
    timeoutMs?: number
    pollMs?: number
    now?: () => number
    delay?: (milliseconds: number) => Promise<void>
  } = {},
): Promise<void> {
  const stableForMs = options.stableForMs ?? 1_000
  const timeoutMs = options.timeoutMs ?? 5_000
  const pollMs = options.pollMs ?? 100
  const now = options.now ?? Date.now
  const delay =
    options.delay ??
    (async (milliseconds: number) =>
      await new Promise<void>(resolve => setTimeout(resolve, milliseconds)))
  const startedAt = now()
  let absentSince: number | undefined

  while (now() - startedAt <= timeoutMs) {
    if ((await count()) === 0) {
      absentSince ??= now()
      if (now() - absentSince >= stableForMs) return
    } else {
      absentSince = undefined
    }
    if (now() - startedAt >= timeoutMs) break
    await delay(pollMs)
  }

  throw new Error('session link remained visible after the session list settled')
}

async function openUncachedBrowserContext(page: InvitedMemberBrowser['page']) {
  const browser = page.context().browser()
  assert(browser !== null, 'browser proof page had no owning browser')
  const storage = await page.context().storageState()
  const context = await browser.newContext({
    storageState: { cookies: storage.cookies, origins: [] },
  })
  return context
}

export async function waitForRemovedSessionBrowserSurface(
  page: Pick<InvitedMemberBrowser['page'], 'getByText'>,
): Promise<void> {
  await page
    .getByText(
      /^(That job is not in this list\. Pick another from the list\.|Ese trabajo no está en esta lista\. Elige otro de la lista\.)$/,
    )
    .waitFor()
}

async function navigateDeployedPageAndWaitForApi(
  page: InvitedMemberBrowser['page'],
  destination: string,
  pathname: string,
  expectedStatus: number,
): Promise<void> {
  const responsePromise = page
    .waitForResponse(response => {
      const request = response.request()
      return request.method() === 'GET' && new URL(response.url()).pathname === pathname
    })
    .catch(error => {
      throw new Error(`cold browser did not load ${pathname}`, { cause: error })
    })
  await navigateDeployedPage(page, destination)
  await page.locator('[data-destination-content]').waitFor()
  const response = await responsePromise
  assert.equal(response.status(), expectedStatus, `${pathname} cold load failed`)
}

export function specificPeopleBrowserExpectations(session: SessionSnapshot | SessionSummary): {
  detailSuffix: string
  linkSelector: string
  title: string
  audienceCount: number
} {
  assert.equal(session.audience.kind, 'specific', 'browser proof requires a specific audience')
  return {
    detailSuffix: `/sessions/${session.id}`,
    linkSelector: `a[href$="/sessions/${session.id}"]`,
    title: session.title,
    audienceCount: session.audience.count,
  }
}

async function assertSessionInHumanSurfaces(
  base: string,
  token: string,
  sessionId: string,
  context: WorkspaceBrowserJourneyContext,
): Promise<void> {
  const listWire = await apiJson<{ items: Array<Record<string, unknown>>; nextCursor: unknown }>(
    `${base}?limit=2`,
    { headers: bearer(token) },
    200,
    'specific list visibility',
    context.artifacts,
  )
  assert(!Object.hasOwn(listWire, 'sessions'), 'session list returned removed sessions page key')
  for (const row of listWire.items) assertNoLegacySessionWireFields(row)
  const list = SessionListPageSchema.parse(listWire)
  assert(
    list.items.some(item => item.id === sessionId),
    'selected viewer list omitted session',
  )
  const search = SessionListPageSchema.parse(
    await apiJson(
      `${base}?limit=2&search=${encodeURIComponent(context.runId)}`,
      { headers: bearer(token) },
      200,
      'specific search visibility',
      context.artifacts,
    ),
  )
  assert(
    search.items.some(item => item.id === sessionId),
    'selected viewer search omitted session',
  )
  const activity = SessionActivityResponseSchema.parse(
    await apiJson(
      `${base}/activity`,
      { headers: bearer(token) },
      200,
      'specific activity visibility',
      context.artifacts,
    ),
  )
  assert(
    activity.owners.some(owner => owner.sessions.some(item => item.id === sessionId)),
    'selected viewer activity omitted session',
  )
}

async function assertSessionAbsentFromHumanSurfaces(
  base: string,
  token: string,
  sessionId: string,
  context: WorkspaceBrowserJourneyContext,
): Promise<void> {
  for (const suffix of [
    '',
    `?search=${encodeURIComponent(context.runId)}`,
    '?bucket=asking&archived=exclude&agentId=root&excludeDefault=true',
    '?bucket=running&archived=exclude&agentId=root&excludeDefault=true',
    '?bucket=scheduled&archived=exclude&agentId=root&excludeDefault=true',
    '?bucket=done&archived=exclude&agentId=root&excludeDefault=true',
  ]) {
    const page = SessionListPageSchema.parse(
      await apiJson(
        `${base}${suffix}`,
        { headers: bearer(token) },
        200,
        'nonparticipant list/search denial',
        context.artifacts,
      ),
    )
    assert(
      !page.items.some(item => item.id === sessionId),
      'nonparticipant list/search leaked session',
    )
  }
  const activity = SessionActivityResponseSchema.parse(
    await apiJson(
      `${base}/activity`,
      { headers: bearer(token) },
      200,
      'nonparticipant activity denial',
      context.artifacts,
    ),
  )
  assert(
    !activity.owners.some(owner => owner.sessions.some(item => item.id === sessionId)),
    'nonparticipant activity leaked session',
  )
}

async function assertGenericNotFound(path: string, token: string): Promise<void> {
  const response = await stagingFetch(path, { headers: bearer(token) })
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'not_found' })
}

async function assertLegacySessionShapesRejected(
  base: string,
  sessionPath: string,
  token: string,
): Promise<void> {
  const probes: Array<{
    label: string
    url: string
    init?: RequestInit
    error: 'invalid_request' | 'invalid_cursor'
  }> = [
    {
      label: 'legacy SSE since query',
      url: `${sessionPath}/events?since=0`,
      error: 'invalid_request',
    },
    {
      label: 'numeric history cursor',
      url: `${sessionPath}/history?cursor=1`,
      error: 'invalid_cursor',
    },
    {
      label: 'legacy history before query',
      url: `${sessionPath}/history?before=1`,
      error: 'invalid_request',
    },
    {
      label: 'legacy archive body',
      url: `${sessionPath}/archive`,
      init: {
        method: 'PUT',
        headers: bearerJson(token),
        body: JSON.stringify({ archived: true }),
      },
      error: 'invalid_request',
    },
    {
      label: 'legacy include-archived list',
      url: `${base}?archived=include`,
      error: 'invalid_request',
    },
  ]
  const removedJobs = await stagingFetch(base.replace(/\/sessions$/, '/jobs'), {
    headers: bearer(token),
  })
  assert.equal(removedJobs.status, 404, 'removed /agent/jobs route still deployed')
  for (const probe of probes) {
    const response = await stagingFetch(probe.url, {
      ...probe.init,
      headers: probe.init?.headers ?? bearer(token),
    })
    assert.equal(response.status, 400, `${probe.label} was not rejected with HTTP 400`)
    assert.deepEqual(
      await response.json(),
      { error: probe.error },
      `${probe.label} refusal drifted`,
    )
  }
}

export function isRemovedMemberSessionDenial(
  status: number,
  body: unknown,
  workspaceSlug: string,
): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false
  const response = body as Record<string, unknown>
  if (status === 404) return response.error === 'not_found'
  return (
    status === 403 &&
    response.error === 'insufficient_scope' &&
    response.scope === `ws:${workspaceSlug}:sessions`
  )
}

export function isRemovedMemberSessionDenialBody(
  status: number,
  body: string,
  workspaceSlug: string,
): boolean {
  try {
    return isRemovedMemberSessionDenial(status, JSON.parse(body) as unknown, workspaceSlug)
  } catch {
    return false
  }
}

async function waitForRemovedMemberSessionDenial(
  path: string,
  token: string,
  workspaceSlug: string,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 60_000
  let lastStatus = 0
  let lastBody = ''
  for (;;) {
    const response = await stagingFetch(path, { headers: bearer(token) })
    lastStatus = response.status
    lastBody = await response.text()
    if (isRemovedMemberSessionDenialBody(response.status, lastBody, workspaceSlug)) return
    if (Date.now() >= deadline) {
      throw new Error(
        `${label}: timed out waiting for removed member denial; last HTTP ${lastStatus} ${lastBody.slice(0, 500)}`,
      )
    }
    await Bun.sleep(500)
  }
}

async function putArchive(
  path: string,
  token: string,
  kind: 'personal' | 'global',
  archived: boolean,
  context: WorkspaceBrowserJourneyContext,
) {
  return SessionSummarySchema.parse(
    await apiJson(
      `${path}/archive`,
      { method: 'PUT', headers: bearerJson(token), body: JSON.stringify({ kind, archived }) },
      200,
      `${kind} archive ${archived}`,
      context.artifacts,
    ),
  )
}

async function provisionSessionsAppPrincipal(
  context: WorkspaceBrowserJourneyContext,
): Promise<{ slug: string; freshToken: () => Promise<string> }> {
  const slug = `specific-people-${context.runId.slice(-8)}`
  const appPath = `apps/${slug}`
  const workspaceBase = `${context.env.apiUrl}/v1/ws/${context.workspace.slug}`
  await apiJson(
    `${workspaceBase}/files/actions`,
    {
      method: 'POST',
      headers: bearerJson(context.apiToken),
      body: JSON.stringify({ operation: 'mkdir', path: appPath, recursive: true }),
    },
    200,
    'sessions app folder create',
    context.artifacts,
  )
  await apiText(
    `${workspaceBase}/files/${appPath}/server.ts`,
    {
      method: 'PUT',
      headers: bearer(context.apiToken, { 'content-type': 'text/plain' }),
      body: [
        'const port = Number(process.env.PORT ?? 0)',
        "Bun.serve({ port, fetch: () => new Response('ok') })",
        '',
      ].join('\n'),
    },
    200,
    'sessions app server write',
    context.artifacts,
  )
  const app = AppResponseSchema.parse(
    await apiJson(
      `${workspaceBase}/apps`,
      {
        method: 'POST',
        headers: bearerJson(context.apiToken),
        body: JSON.stringify({
          path: appPath,
          command: 'bun run server.ts',
          apiScopes: ['sessions'],
          slug,
        }),
      },
      201,
      'sessions app register',
      context.artifacts,
    ),
  ).app
  assert.equal(app.runtimeStatus, 'reconciled', 'sessions app did not reconcile before key mint')
  context.ledger.record({
    kind: 'app',
    id: app.id,
    label: `${context.runId}:sessions-app:${app.id}`,
    cleanup: async () => undefined,
    verify: async () =>
      await workspaceIsDeleted(context.convex, context.env.internalKey, context.workspace._id),
  })
  return {
    slug: app.slug,
    // Reconciliation may supersede a credential after registration. This
    // journey tests the durable app principal, not one plaintext key's lifetime.
    freshToken: async () => {
      const key = (await context.convex.mutation(
        fnMutation('domains/apiKeys/mutations:rotateAppKey'),
        {
          internalKey: context.env.internalKey,
          appId: app.id,
          now: Date.now(),
        },
      )) as { key: string | null }
      assert(key.key !== null, 'sessions app key rotation returned no credential')
      return key.key
    },
  }
}

async function createApiSession(
  path: string,
  token: string,
  prompt: string,
  memberUserIds: string[] | undefined,
  context: WorkspaceBrowserJourneyContext,
) {
  return SessionCreateResponseSchema.parse(
    await apiJson(
      path,
      {
        method: 'POST',
        headers: bearerJson(token),
        body: JSON.stringify({
          prompt,
          clientRequestId: crypto.randomUUID(),
          ...(memberUserIds === undefined ? {} : { audience: { kind: 'specific', memberUserIds } }),
        }),
      },
      201,
      'specific people API session create',
      context.artifacts,
    ),
  )
}

async function walkSessionPages(
  firstUrl: string,
  token: string,
  context: WorkspaceBrowserJourneyContext,
  afterFirst?: (page: SessionListPage) => Promise<void>,
  minimumPages = 2,
): Promise<Set<string>> {
  const ids = new Set<string>()
  let pageNumber = 0
  await collectOpaquePages(async cursor => {
    const url = cursor === null ? firstUrl : `${firstUrl}&cursor=${encodeURIComponent(cursor)}`
    const page = SessionListPageSchema.parse(
      await apiJson(
        url,
        { headers: bearer(token) },
        200,
        'size-two session page',
        context.artifacts,
      ),
    )
    for (const item of page.items) {
      assert(!ids.has(item.id), `size-two pagination duplicated ${item.id}`)
      ids.add(item.id)
    }
    pageNumber += 1
    if (pageNumber === 1) await afterFirst?.(page)
    return page
  })
  assert(pageNumber >= minimumPages, 'size-two proof did not traverse enough pages')
  return ids
}

async function waitForSearchPageCompleteness(
  base: string,
  token: string,
  expected: ReadonlySet<string>,
  context: WorkspaceBrowserJourneyContext,
): Promise<Set<string>> {
  const firstUrl = `${base}?limit=2&search=${encodeURIComponent(context.runId)}`
  return await waitForPageCompleteness(firstUrl, token, expected, context)
}

async function waitForPageCompleteness(
  firstUrl: string,
  token: string,
  expected: ReadonlySet<string>,
  context: WorkspaceBrowserJourneyContext,
): Promise<Set<string>> {
  const deadline = Date.now() + 60_000
  for (;;) {
    const ids = await walkSessionPages(firstUrl, token, context, undefined, 1)
    if ([...expected].every(id => ids.has(id))) return ids
    if (Date.now() >= deadline) throw new Error('Timed out waiting for size-two list completeness')
    await Bun.sleep(1_000)
  }
}
