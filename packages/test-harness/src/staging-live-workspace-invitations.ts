import assert from 'node:assert/strict'

import type { Page } from '@playwright/test'

import { WhoamiResponseSchema, type WhoamiResponse, type WorkspaceSummary } from '@repo/contract'

import { waitForBrowserMagicLink } from './staging-live-browser-acceptance.ts'
import {
  attachBrowserDiagnostics,
  installStagingProtection,
  markExpectedBrowserTransition,
  navigateDeployedPage,
} from './staging-live-browser.ts'
import { fnQuery } from './staging-live-env.ts'
import { apiJson, bearer } from './staging-live-http.ts'
import {
  createTrackedWorkspaceInvite,
  recordInvitedMemberIdentityCleanup,
  runInviteBrowserAttempt,
} from './staging-live-invited-member.ts'
import { resolveAgentMailInbox, taggedInboxAddress } from './staging-live-mailbox.ts'
import { waitForHydratedMagicLinkControls } from './staging-live-public-site.ts'
import { recordWorkspaceCleanup } from './staging-live-resource-ledger.ts'
import { assertWorkspaceCanBecomeActive, waitForWorkspace } from './staging-live-streaming.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'

interface WorkspaceInvitationsEvidence {
  invitedWorkspaceId: string
  scenarios: Array<{
    scenario: 'existing-unfinished' | 'new-account' | 'ordinary-signup'
    destination: string
    workspaceIds: string[]
    onboardingVisits: number
  }>
}

export async function runWorkspaceInvitationsJourney(
  options: {
    onProgress?: (stage: string) => void
  } = {},
): Promise<WorkspaceBrowserJourneyResult<WorkspaceInvitationsEvidence>> {
  return await runWorkspaceBrowserJourney({
    journey: 'workspace-invitations',
    label: 'Workspace Invitations',
    onProgress: options.onProgress,
    run: async context => {
      const { env, workspace, apiToken, artifacts, runId, progress } = context
      const browser = context.page.context().browser()
      assert(browser !== null)
      const owner = WhoamiResponseSchema.parse(
        await apiJson(
          `${env.apiUrl}/v1/whoami`,
          { headers: bearer(apiToken) },
          200,
          'invitation owner',
          artifacts,
        ),
      )
      const invitedWorkspace = owner.workspaces.find(row => row.id === workspace._id)
      assert(
        invitedWorkspace !== undefined && invitedWorkspace.onboardedAt !== undefined,
        'the invited workspace must already be onboarded',
      )
      const inbox = await resolveAgentMailInbox({
        apiKey: env.agentMailApiKey,
        address: env.agentMailInboxAddress,
      })
      const suffix = runId.split('-').slice(-2).join('-')
      const evidence: WorkspaceInvitationsEvidence['scenarios'] = []

      // The existing-account case deliberately starts at an unfinished personal
      // workspace. A fixture minted through login-as would already be onboarded
      // and would hide the customer-visible regression.
      for (const existing of [true, false]) {
        const marker = `staging-e2e-invite-${existing ? 'existing' : 'new'}-${suffix}`
        const email = taggedInboxAddress(inbox.address, marker)
        recordInvitedMemberIdentityCleanup({ ...context, email })
        try {
          const personal = existing
            ? await createUnfinishedPersonalWorkspace(context, email, inbox.id, marker)
            : undefined
          progress(`invite:${existing ? 'existing-unfinished' : 'new-account'}`)
          const invite = await createTrackedWorkspaceInvite({
            ...context,
            ownerToken: apiToken,
            email,
            role: existing ? 'viewer' : 'editor',
            inboxId: inbox.id,
            mailCorrelationMarker: marker,
          })
          const identity: WhoamiResponse = await runInviteBrowserAttempt({
            ...context,
            browser,
            inviteLink: invite.link,
            email,
            inboxId: inbox.id,
            mailCorrelationMarker: marker,
            expected: 'accepted',
            workspaceSlug: workspace.slug,
          })
          assert.deepEqual(
            identity.workspaces
              .map(row => ({ id: row.id, role: row.role }))
              .sort((a, b) => a.id.localeCompare(b.id)),
            [
              { id: workspace._id, role: existing ? 'viewer' : 'editor' },
              ...(personal === undefined ? [] : [{ id: personal.id, role: 'owner' }]),
            ].sort((a, b) => a.id.localeCompare(b.id)),
            'accepting an invitation must not create another workspace',
          )
          if (personal !== undefined) {
            assert.equal(
              identity.workspaces.find(row => row.id === personal.id)?.onboardedAt,
              undefined,
            )
          }
          evidence.push({
            scenario: existing ? 'existing-unfinished' : 'new-account',
            destination: workspace.slug,
            workspaceIds: identity.workspaces.map(row => row.id),
            onboardingVisits: 0,
          })
        } finally {
          await recordOwnedWorkspaceCleanup(context, email)
        }
      }
      const marker = `staging-e2e-invite-ordinary-${suffix}`
      const email = taggedInboxAddress(inbox.address, marker)
      recordInvitedMemberIdentityCleanup({ ...context, email })
      try {
        await createTrackedWorkspaceInvite({
          ...context,
          ownerToken: apiToken,
          email,
          role: 'editor',
          inboxId: inbox.id,
          mailCorrelationMarker: marker,
        })
        progress('invite:ordinary-signup-with-pending-invitation')
        await createUnfinishedPersonalWorkspace(
          context,
          email,
          inbox.id,
          marker,
          async (page, personal) => {
            const banner = page.getByRole('region', { name: 'Workspace invitations' })
            await banner.waitFor({ timeout: 120_000 })
            assert((await banner.innerText()).includes(invitedWorkspace.name))
            const header = page.locator('[data-onboarding-step] header')
            const [bannerBox, headerBox] = await Promise.all([
              banner.boundingBox(),
              header.boundingBox(),
            ])
            assert(bannerBox !== null && headerBox !== null)
            assert(
              headerBox.y >= bannerBox.y + bannerBox.height,
              'invitations must sit above the page header',
            )
            await page.screenshot({
              path: `${artifacts.directory}/ordinary-signup-invitations.png`,
              animations: 'disabled',
            })
            const onboardingVisits: string[] = []
            page.on('framenavigated', frame => {
              if (
                frame === page.mainFrame() &&
                new URL(frame.url()).pathname.endsWith('/onboarding')
              )
                onboardingVisits.push(frame.url())
            })
            await banner
              .getByRole('button', { name: `Accept invitation to ${invitedWorkspace.name}` })
              .click()
            await page.waitForURL(url => url.pathname.startsWith(`/w/${workspace.slug}/`), {
              timeout: 120_000,
            })
            await page.locator('[data-destination-content]').waitFor({ timeout: 120_000 })
            assert.deepEqual(onboardingVisits, [], 'in-app invitation acceptance showed onboarding')
            const identity = WhoamiResponseSchema.parse(
              await page.evaluate(async () => {
                const response = await fetch('/api/duet/whoami')
                if (!response.ok) throw new Error(`whoami failed: ${response.status}`)
                return await response.json()
              }),
            )
            assert.deepEqual(
              identity.workspaces.map(row => [row.id, row.role]).sort(),
              [
                [personal.id, 'owner'],
                [workspace._id, 'editor'],
              ].sort(),
              'ordinary signup keeps its personal workspace; joining creates no additional one',
            )
            await banner.waitFor({ state: 'detached', timeout: 30_000 })
            evidence.push({
              scenario: 'ordinary-signup',
              destination: workspace.slug,
              workspaceIds: identity.workspaces.map(row => row.id),
              onboardingVisits: onboardingVisits.length,
            })
          },
        )
      } finally {
        await recordOwnedWorkspaceCleanup(context, email)
      }
      return { invitedWorkspaceId: workspace._id, scenarios: evidence }
    },
  })
}

async function createUnfinishedPersonalWorkspace(
  context: WorkspaceBrowserJourneyContext,
  email: string,
  inboxId: string,
  marker: string,
  onSignedIn?: (page: Page, personal: WorkspaceSummary) => Promise<void>,
) {
  const { env, runId, ledger, artifacts, convex, progress } = context
  const browser = context.page.context().browser()
  assert(browser !== null)
  const browserContext = await browser.newContext()
  try {
    await installStagingProtection(browserContext, {
      ...env,
      landerUrl: env.appUrl,
      docsUrl: env.appUrl,
    })
    attachBrowserDiagnostics(browserContext, artifacts)
    const page = await browserContext.newPage()
    progress('invite:prepare-unfinished-personal-workspace')
    const returnTo = `/?e2e=${marker}`
    await navigateDeployedPage(
      page,
      `${env.appUrl}/sign-in?returnTo=${encodeURIComponent(returnTo)}`,
    )
    const controls = await waitForHydratedMagicLinkControls(page)
    await controls.email.fill(email)
    const requestedAt = Date.now()
    const sent = page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/auth/magic-link',
    )
    await controls.submit.click({ noWaitAfter: true })
    assert.equal((await sent).status(), 204)
    const link = await waitForBrowserMagicLink({
      env,
      page,
      ledger,
      email,
      inboxId,
      requestedAt,
      runId,
      mailCorrelationMarker: marker,
      returnTo,
    })
    markExpectedBrowserTransition(page)
    await navigateDeployedPage(page, link)
    await page.waitForURL(url => url.pathname.endsWith('/onboarding'), { timeout: 120_000 })
    const identity = WhoamiResponseSchema.parse(
      await page.evaluate(async () => {
        const response = await fetch('/api/duet/whoami')
        if (!response.ok) throw new Error(`whoami failed: ${response.status}`)
        return await response.json()
      }),
    )
    assert.equal(identity.workspaces.length, 1)
    const personal = identity.workspaces[0]!
    assert.equal(personal.role, 'owner')
    assert.equal(personal.onboardedAt, undefined)
    await page.locator('[data-onboarding-step]').waitFor({ timeout: 120_000 })
    await waitForWorkspace(convex, env.internalKey, personal.id, row => {
      assertWorkspaceCanBecomeActive(row)
      return row.vmName !== undefined
    })
    await onSignedIn?.(page, personal)
    return personal
  } finally {
    for (const page of browserContext.pages()) markExpectedBrowserTransition(page)
    await browserContext.close()
  }
}

// Discover resources even when the browser fails before returning its identity.
async function recordOwnedWorkspaceCleanup(context: WorkspaceBrowserJourneyContext, email: string) {
  const { convex, env } = context
  const user = (await convex.query(fnQuery('testing/stagingE2e:userByEmailForTest'), {
    internalKey: env.internalKey,
    email,
  })) as { _id: string } | null
  if (user === null) return
  const owned = (await convex.query(fnQuery('testing/workspaces:workspacesByOwnerForTest'), {
    internalKey: env.internalKey,
    userId: user._id,
  })) as Array<{ _id: string }>
  for (const workspace of owned) {
    recordWorkspaceCleanup({
      ...context,
      output: { vmNames: context.vmNames },
      workspaceId: workspace._id,
      slug: email,
    })
  }
}
