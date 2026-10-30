import assert from 'node:assert/strict'
import path from 'node:path'

import { type Browser, type Page } from '@playwright/test'
import { ConvexHttpClient } from 'convex/browser'

import { hashApiKey, UserBillingOverviewSchema, WhoamiResponseSchema } from '@repo/contract'

import { StagingArtifactCollector } from './staging-live-artifacts.ts'
import { waitForBrowserApiResponse } from './staging-live-browser-response.ts'
import { markExpectedBrowserTransition, navigateDeployedPage } from './staging-live-browser.ts'
import { fnMutation, type LiveEnv, type Workspace } from './staging-live-env.ts'
import { apiJson, assertResponse, bearer, bearerJson, stagingFetch } from './staging-live-http.ts'
import {
  createTrackedWorkspaceInvite as createTrackedInvite,
  recordInvitedMemberIdentityCleanup as recordSyntheticUserCleanup,
  runInviteBrowserAttempt,
  waitForWorkspaceMember,
} from './staging-live-invited-member.ts'
import { recordWorkspaceCleanup, StagingResourceLedger } from './staging-live-resource-ledger.ts'
import type { TimelineOutput } from './staging-live.ts'

export { waitForInviteSessionDestination } from './staging-live-invited-member.ts'

export async function runInviteAndPayerAcceptance(args: {
  env: LiveEnv
  browser: Browser
  ownerPage: Page
  ownerToken: string
  ownerEmail: string
  runId: string
  workspace: Workspace
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
  output: TimelineOutput
  artifacts: StagingArtifactCollector
  identities: {
    firstTime: string
    existing: string
    expired: string
    revoked: string
    existingName: string
  }
}): Promise<void> {
  const { env, browser, ownerPage, ownerToken, runId, workspace, ledger, convex, artifacts } = args
  const { firstTime, existing, expired, revoked, existingName } = args.identities
  for (const candidate of [firstTime, existing, expired, revoked]) {
    assert.notEqual(candidate, args.ownerEmail)
  }

  const existingFixture = await createSyntheticExistingUser({
    env,
    email: existing,
    name: existingName,
    runId,
    ledger,
    convex,
    output: args.output,
    artifacts,
  })

  const firstTimeInvite = await createTrackedInvite({
    env,
    workspace,
    ownerToken,
    email: firstTime,
    role: 'editor',
    runId,
    ledger,
    convex,
    artifacts,
  })
  await runInviteBrowserAttempt({
    env,
    browser,
    ledger,
    inviteLink: firstTimeInvite.link,
    email: existing,
    runId,
    artifacts,
    expected: 'rejected',
  })

  const existingInvite = await createTrackedInvite({
    env,
    workspace,
    ownerToken,
    email: existing,
    role: 'viewer',
    runId,
    ledger,
    convex,
    artifacts,
  })
  const existingIdentity = await runInviteBrowserAttempt({
    env,
    browser,
    ledger,
    inviteLink: existingInvite.link,
    email: existing,
    runId,
    artifacts,
    expected: 'accepted',
    workspaceSlug: workspace.slug,
  })
  assert.deepEqual(
    existingIdentity.workspaces.map(row => `${row.id}:${row.role}`).sort(),
    [`${existingFixture.workspace.id}:owner`, `${workspace._id}:viewer`].sort(),
    'existing invitee memberships changed unexpectedly',
  )

  recordSyntheticUserCleanup({ env, email: firstTime, runId, ledger, convex })
  const firstTimeIdentity = await runInviteBrowserAttempt({
    env,
    browser,
    ledger,
    inviteLink: firstTimeInvite.link,
    email: firstTime,
    runId,
    artifacts,
    expected: 'accepted',
    workspaceSlug: workspace.slug,
    screenshotPath: path.join(artifacts.directory, 'invite-first.png'),
  })
  assert.equal(
    firstTimeIdentity.workspaces.length,
    1,
    'first-time invitee received a workspace other than the invited workspace',
  )
  assert.equal(firstTimeIdentity.workspaces[0]?.id, workspace._id)

  await runInviteBrowserAttempt({
    env,
    browser,
    ledger,
    inviteLink: firstTimeInvite.link,
    email: existing,
    runId,
    artifacts,
    expected: 'rejected',
  })

  const expiredInvite = await createTrackedInvite({
    env,
    workspace,
    ownerToken,
    email: expired,
    role: 'editor',
    runId,
    ledger,
    convex,
    artifacts,
  })
  await convex.mutation(fnMutation('testing/stagingE2e:expireInviteForTest'), {
    internalKey: env.internalKey,
    inviteId: expiredInvite.id,
    expectedEmail: expired,
    now: Date.now(),
  })
  recordSyntheticUserCleanup({ env, email: expired, runId, ledger, convex })
  await runInviteBrowserAttempt({
    env,
    browser,
    ledger,
    inviteLink: expiredInvite.link,
    email: expired,
    runId,
    artifacts,
    expected: 'rejected',
  })

  const revokedInvite = await createTrackedInvite({
    env,
    workspace,
    ownerToken,
    email: revoked,
    role: 'viewer',
    runId,
    ledger,
    convex,
    artifacts,
  })
  const revokeResponse = await stagingFetch(
    `${env.apiUrl}/v1/ws/${workspace.slug}/invites/${revokedInvite.id}`,
    { method: 'DELETE', headers: bearer(ownerToken) },
  )
  assertResponse(revokeResponse, 200, 'workspace invite revocation')
  recordSyntheticUserCleanup({ env, email: revoked, runId, ledger, convex })
  await runInviteBrowserAttempt({
    env,
    browser,
    ledger,
    inviteLink: revokedInvite.link,
    email: revoked,
    runId,
    artifacts,
    expected: 'rejected',
  })

  const firstTimeMember = await waitForWorkspaceMember(
    env.apiUrl,
    workspace.slug,
    ownerToken,
    firstTime,
    artifacts,
  )
  assert.equal(firstTimeMember.id, firstTimeIdentity.user.id)
  await apiJson(
    `${env.apiUrl}/v1/ws/${workspace.slug}/members/${firstTimeMember.id}`,
    {
      method: 'PATCH',
      headers: bearerJson(ownerToken),
      body: JSON.stringify({ role: 'owner' }),
    },
    200,
    'invitee owner promotion',
    artifacts,
  )
  const ownerIdentity = await apiJson<{ user: { id: string } }>(
    `${env.apiUrl}/v1/whoami`,
    { headers: bearer(ownerToken) },
    200,
    'owner identity for payer restore',
    artifacts,
  )
  const payer = await apiJson<{ billingUserId: string }>(
    `${env.apiUrl}/v1/ws/${workspace.slug}/billing-user`,
    {
      method: 'PUT',
      headers: bearerJson(ownerToken),
      body: JSON.stringify({ userId: firstTimeMember.id }),
    },
    200,
    'payer reassignment',
    artifacts,
  )
  assert.equal(payer.billingUserId, firstTimeMember.id)
  // The invitee has no subscription or trial of their own, so making them
  // the payer removes the workspace's entitlement: it must pause and show
  // the wall to the (now non-payer) owner.
  markExpectedBrowserTransition(ownerPage)
  await navigateDeployedPage(ownerPage, `${env.appUrl}/w/${workspace.slug}/settings/billing-user`)
  await ownerPage.locator('[data-entitlement-wall]').waitFor()
  // Restore the entitled owner as payer through the API; the workspace wakes.
  await apiJson(
    `${env.apiUrl}/v1/ws/${workspace.slug}/billing-user`,
    {
      method: 'PUT',
      headers: bearerJson(ownerToken),
      body: JSON.stringify({ userId: ownerIdentity.user.id }),
    },
    200,
    'payer restore',
    artifacts,
  )
  markExpectedBrowserTransition(ownerPage)
  await navigateDeployedPage(ownerPage, `${env.appUrl}/w/${workspace.slug}/settings/billing-user`)
  await ownerPage.locator('[data-entitlement-wall]').waitFor({ state: 'detached' })
  await ownerPage.getByRole('heading', { name: 'Designated payer', exact: true }).last().waitFor()
  // The UI-driven switch back to the invitee proves the card seam and — by
  // pausing again — the payer-entitlement rule end to end.
  const inviteeCard = ownerPage.getByRole('button').filter({ hasText: firstTime })
  await inviteeCard.waitFor()
  await Promise.all([
    waitForBrowserApiResponse(ownerPage, 'PUT', `/api/duet/ws/${workspace.slug}/billing-user`),
    inviteeCard.click(),
  ])
  const ownerBillingResponse = await ownerPage.evaluate(async () => {
    const response = await fetch('/api/duet/user/billing')
    return { status: response.status, body: await response.json() }
  })
  assert.equal(ownerBillingResponse.status, 200, 'browser billing after payer reassignment failed')
  const ownerBilling = UserBillingOverviewSchema.parse(ownerBillingResponse.body)
  assert(
    !ownerBilling.workspaces.some(candidate => candidate.id === workspace._id),
    'reassigned workspace remained on the former payer account',
  )
  assert(ownerBilling.workspaces.length > 0, 'unrelated funded workspace disappeared')
  markExpectedBrowserTransition(ownerPage)
  await navigateDeployedPage(ownerPage, `${env.appUrl}/settings/billing`)
  await ownerPage.getByRole('heading', { name: 'Billing', exact: true }).last().waitFor()
  const fundedCount = ownerBilling.workspaces.length
  await ownerPage
    .getByText(`You currently fund ${fundedCount} drive${fundedCount === 1 ? '' : 's'}.`, {
      exact: true,
    })
    .waitFor()
  // Hand the suite back an entitled workspace: restore the owner as payer and
  // wait out the wall, or every later journey inherits a paused workspace.
  await apiJson(
    `${env.apiUrl}/v1/ws/${workspace.slug}/billing-user`,
    {
      method: 'PUT',
      headers: bearerJson(ownerToken),
      body: JSON.stringify({ userId: ownerIdentity.user.id }),
    },
    200,
    'payer final restore',
    artifacts,
  )
  markExpectedBrowserTransition(ownerPage)
  await navigateDeployedPage(ownerPage, `${env.appUrl}/w/${workspace.slug}/sessions`)
  await ownerPage.locator('[data-entitlement-wall]').waitFor({ state: 'detached' })
}

async function createSyntheticExistingUser(args: {
  env: LiveEnv
  email: string
  name: string
  runId: string
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
  output: TimelineOutput
  artifacts: StagingArtifactCollector
}): Promise<{ workspace: { id: string; slug: string } }> {
  const login = await apiJson<{
    token: string
    userId: string
    workspaceSlug: string
    created: boolean
  }>(
    `${args.env.apiUrl}/v1/admin/login-as`,
    {
      method: 'POST',
      headers: bearerJson(args.env.loginSecret),
      body: JSON.stringify({ email: args.email, create: true, ephemeral: true, name: args.name }),
    },
    200,
    'existing invitee setup',
    args.artifacts,
  )
  assert.equal(login.created, true, 'existing-invite fixture was unexpectedly reused')
  recordSyntheticUserCleanup({
    env: args.env,
    email: args.email,
    runId: args.runId,
    ledger: args.ledger,
    convex: args.convex,
    id: login.userId,
  })

  const prefix = login.token.slice(0, 'duet_sk_'.length + 8)
  const hashedKey = await hashApiKey(login.token)
  args.ledger.record({
    kind: 'api-key',
    id: prefix,
    label: `${args.runId}:existing-invitee-key:${prefix}`,
    cleanup: async () => {
      await args.convex.mutation(fnMutation('testing/stagingE2e:revokeApiKeyByHashForTest'), {
        internalKey: args.env.internalKey,
        hashedKey,
        expectedPrefix: prefix,
        expectedOwnerEmail: args.email,
      })
    },
    verify: async () => {
      const response = await stagingFetch(`${args.env.apiUrl}/v1/whoami`, {
        headers: bearer(login.token),
      })
      return response.status === 401
    },
  })

  const identity = WhoamiResponseSchema.parse(
    await apiJson(
      `${args.env.apiUrl}/v1/whoami`,
      { headers: bearer(login.token) },
      200,
      'existing invitee identity',
      args.artifacts,
    ),
  )
  const workspace = identity.workspaces.find(row => row.slug === login.workspaceSlug)
  assert(workspace !== undefined, 'existing invitee workspace was absent from whoami')
  assert.equal(workspace.name, `${args.name}'s Workspace`)
  recordWorkspaceCleanup({
    ledger: args.ledger,
    convex: args.convex,
    env: args.env,
    output: args.output,
    workspaceId: workspace.id,
    slug: workspace.slug,
  })
  return { workspace }
}

export async function logoutAndAssertCurrentBrowserSessionRevoked<T>(args: {
  getCookies: () => Promise<ReadonlyArray<{ name: string; value: string }>>
  logout: () => Promise<T>
  assertRevoked: (credential: string) => Promise<void>
}): Promise<T> {
  const credential = currentBrowserSessionCredential(await args.getCookies())
  const result = await args.logout()
  await args.assertRevoked(credential)
  return result
}

export function currentBrowserSessionCredential(
  cookies: ReadonlyArray<{ name: string; value: string }>,
): string {
  const sessionCookie = cookies.find(cookie => cookie.name === 'duet_session')
  assert(sessionCookie !== undefined, 'browser session cookie was missing')
  return decodeBrowserSessionToken(sessionCookie.value)
}

export async function waitForBrowserSessionCredential(args: {
  cookies: () => Promise<ReadonlyArray<{ name: string; value: string }>>
  timeoutMs?: number
  pollMs?: number
}): Promise<string> {
  const deadline = Date.now() + (args.timeoutMs ?? 120_000)
  for (;;) {
    try {
      return currentBrowserSessionCredential(await args.cookies())
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await Bun.sleep(args.pollMs ?? 500)
    }
  }
}

function decodeBrowserSessionToken(cookie: string): string {
  const value = JSON.parse(Buffer.from(cookie, 'base64url').toString('utf8')) as { token?: unknown }
  assert(typeof value.token === 'string', 'browser session cookie omitted token')
  return value.token
}
