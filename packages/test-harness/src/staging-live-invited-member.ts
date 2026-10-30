import assert from 'node:assert/strict'

import { type Browser, type BrowserContext, type Page } from '@playwright/test'
import { ConvexHttpClient } from 'convex/browser'

import { normalizeWorkspaceMemberSearch, WhoamiResponseSchema } from '@repo/contract'

import { StagingArtifactCollector } from './staging-live-artifacts.ts'
import {
  recordMailboxMessageCleanup,
  waitForBrowserMagicLink,
} from './staging-live-browser-acceptance.ts'
import { assertBrowserResponseFinished } from './staging-live-browser-response.ts'
import {
  attachBrowserDiagnostics,
  installStagingProtection,
  markExpectedBrowserTransition,
  navigateDeployedPage,
} from './staging-live-browser.ts'
import { fnMutation, fnQuery, type LiveEnv, type Workspace } from './staging-live-env.ts'
import { apiJson, bearer, bearerJson, stagingFetch } from './staging-live-http.ts'
import { waitForMailboxLink } from './staging-live-mailbox.ts'
import { waitForHydratedMagicLinkControls } from './staging-live-public-site.ts'
import { StagingResourceLedger, workspaceIsDeleted } from './staging-live-resource-ledger.ts'

const BROWSER_TRANSITION_TIMEOUT_MS = 60_000

type InvitedMemberEnv = Pick<
  LiveEnv,
  | 'apiUrl'
  | 'appUrl'
  | 'internalKey'
  | 'vercelBypassSecret'
  | 'agentMailApiKey'
  | 'agentMailInboxId'
>

type CloseableContext = { close: () => Promise<void> }

/**
 * The acquisition boundary shared by live invited-member fixtures. Identity
 * cleanup is registered before an invite or browser login can mint the user,
 * and a context that does not make it all the way into the returned fixture is
 * closed here rather than left for a caller that never received it.
 */
export async function acquireTrackedInvitedMember<
  Invite,
  Context extends CloseableContext,
  Member,
>(args: {
  recordIdentityCleanup: () => void
  createInvite: () => Promise<Invite>
  openContext: () => Promise<Context>
  login: (invite: Invite, context: Context) => Promise<Member>
}): Promise<{ context: Context; member: Member }> {
  args.recordIdentityCleanup()
  const invite = await args.createInvite()
  let context: Context | undefined
  try {
    context = await args.openContext()
    return { context, member: await args.login(invite, context) }
  } catch (error) {
    await context?.close().catch(() => undefined)
    throw error
  }
}

export type InvitedMemberBrowser = {
  context: BrowserContext
  page: Page
  apiToken: string
  userId: string
  memberId: string
  email: string
  close: () => Promise<void>
}

export async function acquireInvitedMemberBrowser(args: {
  env: InvitedMemberEnv
  browser: Browser
  workspace: Workspace
  ownerToken: string
  email: string
  role: 'editor' | 'viewer'
  runId: string
  mailCorrelationMarker?: string
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
  artifacts: StagingArtifactCollector
  inboxId?: string
}): Promise<InvitedMemberBrowser> {
  const acquired = await acquireTrackedInvitedMember({
    recordIdentityCleanup: () =>
      recordInvitedMemberIdentityCleanup({
        env: args.env,
        email: args.email,
        runId: args.runId,
        ledger: args.ledger,
        convex: args.convex,
      }),
    createInvite: async () =>
      await createTrackedWorkspaceInvite({
        env: args.env,
        workspace: args.workspace,
        ownerToken: args.ownerToken,
        email: args.email,
        role: args.role,
        runId: args.runId,
        mailCorrelationMarker: args.mailCorrelationMarker,
        ledger: args.ledger,
        convex: args.convex,
        artifacts: args.artifacts,
        inboxId: args.inboxId,
      }),
    openContext: async () => {
      const context = await args.browser.newContext({ viewport: { width: 1440, height: 900 } })
      try {
        await installStagingProtection(context, {
          ...args.env,
          landerUrl: args.env.appUrl,
          docsUrl: args.env.appUrl,
        })
        attachBrowserDiagnostics(context, args.artifacts)
        return context
      } catch (error) {
        await context.close().catch(() => undefined)
        throw error
      }
    },
    login: async (invite, context) => {
      const signedIn = await loginInvitedMember({
        env: args.env,
        context,
        inviteLink: invite.link,
        workspaceSlug: args.workspace.slug,
        email: args.email,
        runId: args.runId,
        mailCorrelationMarker: args.mailCorrelationMarker,
        inboxId: args.inboxId,
        ledger: args.ledger,
        artifacts: args.artifacts,
      })
      const member = await waitForWorkspaceMember(
        args.env.apiUrl,
        args.workspace.slug,
        args.ownerToken,
        args.email,
        args.artifacts,
      )
      assert.equal(member.id, signedIn.identity.user.id, 'invited member identity changed')
      return { ...signedIn, member }
    },
  })

  return {
    context: acquired.context,
    page: acquired.member.page,
    apiToken: acquired.member.apiToken,
    userId: acquired.member.identity.user.id,
    memberId: acquired.member.member.id,
    email: args.email,
    close: async () => {
      for (const page of acquired.context.pages()) markExpectedBrowserTransition(page)
      await acquired.context.close()
    },
  }
}

export function recordInvitedMemberIdentityCleanup(args: {
  env: Pick<LiveEnv, 'apiUrl' | 'internalKey'>
  email: string
  runId: string
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
  id?: string
}): void {
  args.ledger.record({
    kind: 'user',
    id: args.id ?? args.email,
    label: `${args.runId}:invite-identity:${args.email}`,
    cleanupPriority: -100,
    cleanup: async () => {
      await args.convex.mutation(fnMutation('testing/stagingE2e:retireUserByEmailForTest'), {
        internalKey: args.env.internalKey,
        email: args.email,
      })
    },
    verify: async () =>
      (await args.convex.query(fnQuery('testing/stagingE2e:userByEmailForTest'), {
        internalKey: args.env.internalKey,
        email: args.email,
      })) === null,
  })
}

export async function createTrackedWorkspaceInvite(args: {
  env: Pick<LiveEnv, 'apiUrl' | 'internalKey' | 'agentMailApiKey' | 'agentMailInboxId'>
  workspace: Workspace
  ownerToken: string
  email: string
  role: 'editor' | 'viewer'
  runId: string
  mailCorrelationMarker?: string
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
  artifacts: StagingArtifactCollector
  inboxId?: string
}): Promise<{ id: string; link: string }> {
  const requestedAt = Date.now()
  const invite = await apiJson<{ id: string; email: string }>(
    `${args.env.apiUrl}/v1/ws/${args.workspace.slug}/invites`,
    {
      method: 'POST',
      headers: bearerJson(args.ownerToken),
      body: JSON.stringify({ email: args.email, role: args.role }),
    },
    201,
    'workspace invite',
    args.artifacts,
  )
  assert.equal(invite.email, args.email)
  args.ledger.record({
    kind: 'invite',
    id: invite.id,
    label: `${args.runId}:invite:${invite.id}:${args.email}`,
    cleanup: async () => {
      const response = await stagingFetch(
        `${args.env.apiUrl}/v1/ws/${args.workspace.slug}/invites/${invite.id}`,
        { method: 'DELETE', headers: bearer(args.ownerToken) },
      )
      assert(
        response.status === 200 || response.status === 404,
        `invite cleanup returned HTTP ${response.status}`,
      )
    },
    verify: async () =>
      await workspaceIsDeleted(args.convex, args.env.internalKey, args.workspace._id),
  })
  const message = await waitForMailboxLink({
    apiKey: args.env.agentMailApiKey,
    inboxId: args.inboxId ?? args.env.agentMailInboxId,
    expected: {
      after: requestedAt,
      recipient: args.email,
      subject: /invited.*duet/i,
      runId: args.mailCorrelationMarker ?? args.runId,
    },
  })
  recordMailboxMessageCleanup(
    args.env,
    args.ledger,
    args.runId,
    message.messageId,
    args.inboxId ?? args.env.agentMailInboxId,
  )
  return { id: invite.id, link: message.url }
}

type BrowserIdentity = ReturnType<typeof WhoamiResponseSchema.parse>

async function loginInvitedMember(args: {
  env: InvitedMemberEnv
  context: BrowserContext
  inviteLink: string
  workspaceSlug: string
  email: string
  runId: string
  mailCorrelationMarker?: string
  inboxId?: string
  artifacts: StagingArtifactCollector
  ledger: StagingResourceLedger
}): Promise<{ page: Page; identity: BrowserIdentity; apiToken: string }> {
  const page = await args.context.newPage()
  const assertNoOnboarding = observeInviteNavigation(page)
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, args.inviteLink)
  await page.waitForURL(url => url.pathname === '/sign-in', { waitUntil: 'domcontentloaded' })
  const pendingInvite = (await args.context.cookies(args.env.appUrl)).find(
    cookie => cookie.name === 'duet_pending_invite',
  )
  assert(pendingInvite?.httpOnly, 'pending invitation token was not HttpOnly')
  assert(!page.url().includes(pendingInvite.value), 'invitation token remained in the browser URL')

  const controls = await waitForHydratedMagicLinkControls(page)
  await controls.email.fill(args.email)
  const requestedAt = Date.now()
  const [intent] = await Promise.all([
    page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/auth/magic-link',
      { timeout: BROWSER_TRANSITION_TIMEOUT_MS },
    ),
    controls.submit.click({ noWaitAfter: true, timeout: BROWSER_TRANSITION_TIMEOUT_MS }),
  ])
  assert.equal(intent.status(), 204, 'invite magic-link intent failed')
  await assertBrowserResponseFinished(intent, 'invite magic-link intent')
  const magicLink = await waitForBrowserMagicLink({
    env: args.env,
    page,
    ledger: args.ledger,
    email: args.email,
    requestedAt,
    runId: args.runId,
    mailCorrelationMarker: args.mailCorrelationMarker,
    inboxId: args.inboxId,
    returnTo: '/',
  })
  const sessionResponse = page.waitForResponse(
    response =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/duet/session',
  )
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, magicLink)
  const completed = await sessionResponse
  await assertBrowserResponseFinished(completed, 'invite session')
  assert.equal(completed.status(), 204, 'valid invitation did not create a browser session')
  await page.waitForURL(
    url =>
      url.pathname.endsWith('/onboarding') || url.pathname.startsWith(`/w/${args.workspaceSlug}/`),
    {
      timeout: 120_000,
    },
  )
  assertNoOnboarding()
  await waitForInviteSessionDestination(page)
  assertNoOnboarding()
  const identityResponse = await page.evaluate(async () => {
    const response = await fetch('/api/duet/whoami')
    return { status: response.status, body: await response.json() }
  })
  assert.equal(identityResponse.status, 200, 'invitee browser identity request failed')
  const identity = WhoamiResponseSchema.parse(identityResponse.body)
  const apiToken = await readBrowserSessionCredential(args.context, args.env.appUrl)
  return { page, identity, apiToken }
}

type InviteBrowserAttempt = {
  env: InvitedMemberEnv
  browser: Browser
  inviteLink: string
  email: string
  runId: string
  mailCorrelationMarker?: string
  inboxId?: string
  artifacts: StagingArtifactCollector
  ledger: StagingResourceLedger
  screenshotPath?: string
}

export async function runInviteBrowserAttempt(
  args: InviteBrowserAttempt & { expected: 'accepted'; workspaceSlug: string },
): Promise<BrowserIdentity>
export async function runInviteBrowserAttempt(
  args: InviteBrowserAttempt & { expected: 'rejected' },
): Promise<undefined>
export async function runInviteBrowserAttempt(
  args: InviteBrowserAttempt &
    ({ expected: 'accepted'; workspaceSlug: string } | { expected: 'rejected' }),
): Promise<BrowserIdentity | undefined> {
  const context = await args.browser.newContext({ viewport: { width: 1440, height: 900 } })
  try {
    await installStagingProtection(context, {
      ...args.env,
      landerUrl: args.env.appUrl,
      docsUrl: args.env.appUrl,
    })
  } catch (error) {
    await context.close().catch(() => undefined)
    throw error
  }
  attachBrowserDiagnostics(context, args.artifacts, {
    responses:
      args.expected === 'rejected'
        ? [{ method: 'POST', pathname: '/api/duet/session', status: 400, remaining: 1 }]
        : [],
  })
  const page = await context.newPage()
  const assertNoOnboarding = observeInviteNavigation(page)
  let finished = false
  try {
    markExpectedBrowserTransition(page)
    await navigateDeployedPage(page, args.inviteLink)
    await page.waitForURL(url => url.pathname === '/sign-in', { waitUntil: 'domcontentloaded' })
    const pendingInvite = (await context.cookies(args.env.appUrl)).find(
      cookie => cookie.name === 'duet_pending_invite',
    )
    assert(pendingInvite?.httpOnly, 'pending invitation token was not HttpOnly')
    assert(
      !page.url().includes(pendingInvite.value),
      'invitation token remained in the browser URL',
    )
    const controls = await waitForHydratedMagicLinkControls(page)
    await controls.email.fill(args.email)
    assert.equal(
      await controls.email.inputValue(),
      args.email,
      'invitee email did not remain filled',
    )
    const requestedAt = Date.now()
    const [intent] = await Promise.all([
      page.waitForResponse(
        response =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/auth/magic-link',
        { timeout: BROWSER_TRANSITION_TIMEOUT_MS },
      ),
      controls.submit.click({ noWaitAfter: true, timeout: BROWSER_TRANSITION_TIMEOUT_MS }),
    ])
    assert.equal(intent.status(), 204, 'invite magic-link intent failed')
    const magicLink = await waitForBrowserMagicLink({
      env: args.env,
      page,
      ledger: args.ledger,
      email: args.email,
      requestedAt,
      runId: args.runId,
      mailCorrelationMarker: args.mailCorrelationMarker,
      inboxId: args.inboxId,
      returnTo: '/',
    })
    const responsePromise = page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/duet/session',
    )
    markExpectedBrowserTransition(page)
    await navigateDeployedPage(page, magicLink)
    const response = await responsePromise
    await assertBrowserResponseFinished(response, 'invite session')
    if (args.expected === 'rejected') {
      assert.equal(response.status(), 400, 'invalid invitation unexpectedly created a session')
      await page.waitForURL(url => url.pathname === '/sign-in', { waitUntil: 'domcontentloaded' })
      assert(
        !(await context.cookies(args.env.appUrl)).some(cookie => cookie.name === 'duet_session'),
        'invalid invitation created a browser session',
      )
      assert(
        !(await context.cookies(args.env.appUrl)).some(
          cookie => cookie.name === 'duet_pending_invite',
        ),
        'rejected invitation left a token that could block ordinary sign-in',
      )
      finished = true
      return undefined
    }
    assert.equal(response.status(), 204, 'valid invitation did not create a browser session')
    await page.waitForURL(
      url =>
        url.pathname.endsWith('/onboarding') ||
        url.pathname.startsWith(`/w/${args.workspaceSlug}/`),
      {
        timeout: 120_000,
      },
    )
    assertNoOnboarding()
    await waitForInviteSessionDestination(page)
    assertNoOnboarding()
    if (args.screenshotPath !== undefined) {
      await page.screenshot({ path: args.screenshotPath, fullPage: true })
    }
    const responseIdentity = await page.evaluate(async () => {
      const response = await fetch('/api/duet/whoami')
      return { status: response.status, body: await response.json() }
    })
    assert.equal(responseIdentity.status, 200, 'invitee browser identity request failed')
    finished = true
    return WhoamiResponseSchema.parse(responseIdentity.body)
  } finally {
    if (finished) for (const openPage of context.pages()) markExpectedBrowserTransition(openPage)
    await context.close()
  }
}

export async function waitForInviteSessionDestination(page: Pick<Page, 'locator'>): Promise<void> {
  await page.locator('[data-destination-content]').waitFor({ timeout: 120_000 })
}

function observeInviteNavigation(page: Page): () => void {
  const onboardingVisits: string[] = []
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame() && new URL(frame.url()).pathname.endsWith('/onboarding')) {
      onboardingVisits.push(frame.url())
    }
  })
  return () => assert.deepEqual(onboardingVisits, [], 'invitation navigation showed onboarding')
}

export async function waitForWorkspaceMember(
  apiUrl: string,
  workspaceSlug: string,
  token: string,
  email: string,
  artifacts: StagingArtifactCollector,
): Promise<{ id: string; email: string }> {
  const deadline = Date.now() + 60_000
  for (;;) {
    const result = await apiJson<{
      items: Array<{ id: string; email: string }>
      nextCursor: string | null
    }>(
      `${apiUrl}/v1/ws/${workspaceSlug}/members?search=${encodeURIComponent(normalizeWorkspaceMemberSearch(email))}`,
      { headers: bearer(token) },
      200,
      'workspace members',
      artifacts,
    )
    const member = result.items.find(candidate => candidate.email === email)
    if (member !== undefined) return member
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for invited member ${email}`)
    await Bun.sleep(1_000)
  }
}

export async function readBrowserSessionCredential(
  context: BrowserContext,
  appUrl: string,
): Promise<string> {
  const cookie = (await context.cookies(appUrl)).find(
    candidate => candidate.name === 'duet_session',
  )
  assert(cookie !== undefined, 'invited member browser session cookie was missing')
  const value = JSON.parse(Buffer.from(cookie.value, 'base64url').toString('utf8')) as {
    token?: unknown
  }
  assert(typeof value.token === 'string', 'invited member browser session omitted its token')
  return value.token
}
