import assert from 'node:assert/strict'

import { type Page } from '@playwright/test'
import { ConvexHttpClient } from 'convex/browser'

import {
  DeviceApprovalResponseSchema,
  DeviceCodeResponseSchema,
  DeviceTokenResponseSchema,
  hashApiKey,
  WhoamiResponseSchema,
} from '@repo/contract'

import { StagingArtifactCollector } from './staging-live-artifacts.ts'
import { waitForFinishedBrowserResponse } from './staging-live-browser-response.ts'
import { markExpectedBrowserTransition, navigateDeployedPage } from './staging-live-browser.ts'
import { fnMutation, type LiveEnv, type Workspace } from './staging-live-env.ts'
import { apiJson, bearer, stagingFetch, vercelBypassHeaders } from './staging-live-http.ts'
import { StagingResourceLedger, workspaceIsDeleted } from './staging-live-resource-ledger.ts'

const BROWSER_TRANSITION_TIMEOUT_MS = 60_000
export interface DeviceApprovalArgs {
  env: Pick<LiveEnv, 'apiUrl' | 'appUrl' | 'internalKey' | 'vercelBypassSecret'>
  page: Page
  workspace: Workspace
  email: string
  runId: string
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
  artifacts: StagingArtifactCollector
}

export async function runDeviceApproval(args: DeviceApprovalArgs): Promise<void> {
  const { env, page, workspace, runId, ledger, convex, artifacts } = args
  const requestHeaders = new Headers(vercelBypassHeaders(env.vercelBypassSecret))
  requestHeaders.set('content-type', 'application/json')
  await runHumanDeviceLogin(args)

  const denied = await apiJson<{
    device_code: string
    user_code: string
    interval: number
  }>(
    `${env.apiUrl}/v1/device/code`,
    {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({ client_name: 'Duet CLI' }),
    },
    200,
    'denied device code create',
    artifacts,
  )
  let denialVerified = false
  ledger.record({
    kind: 'device-code',
    id: denied.user_code,
    label: `${runId}:device-denied:${denied.user_code}`,
    cleanup: async () => undefined,
    verify: async () =>
      denialVerified || (await workspaceIsDeleted(convex, env.internalKey, workspace._id)),
  })
  markExpectedBrowserTransition(page)
  const deniedInspect = waitForFinishedBrowserResponse(page, 'POST', '/api/duet/device/inspect')
  await navigateDeployedPage(
    page,
    `${env.appUrl}/device?user_code=${encodeURIComponent(denied.user_code)}`,
  )
  await deniedInspect
  const deny = page.getByRole('button', { name: 'Deny', exact: true })
  await Promise.all([
    waitForFinishedBrowserResponse(page, 'POST', '/api/duet/device/deny'),
    deny.click({ noWaitAfter: true, timeout: BROWSER_TRANSITION_TIMEOUT_MS }),
  ])
  await page.getByText('Device denied.').waitFor()
  await Bun.sleep((denied.interval + 1) * 1_000)
  const deniedPoll = await apiJson<{ status: string }>(
    `${env.apiUrl}/v1/device/token`,
    {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({ device_code: denied.device_code }),
    },
    200,
    'denied device token poll',
    artifacts,
  )
  denialVerified = deniedPoll.status === 'denied'
  assert(denialVerified, 'denied device code did not remain denied')

  await runHumanDeviceLogin(args)
}

export async function runHumanDeviceLogin(
  args: DeviceApprovalArgs,
): Promise<{ accessToken: string; prefix: string }> {
  const { env, page, workspace, email, runId, ledger, convex, artifacts } = args
  const requestHeaders = new Headers(vercelBypassHeaders(env.vercelBypassSecret))
  requestHeaders.set('content-type', 'application/json')
  const code = DeviceCodeResponseSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/device/code`,
      {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({ client_name: 'Duet CLI' }),
      },
      200,
      'human device code create',
      artifacts,
    ),
  )
  let consumed = false
  ledger.record({
    kind: 'device-code',
    id: code.user_code,
    label: `${runId}:device-login:${code.user_code}`,
    cleanup: async () => undefined,
    verify: async () =>
      consumed || (await workspaceIsDeleted(convex, env.internalKey, workspace._id)),
  })

  markExpectedBrowserTransition(page)
  // The device page auto-inspects a complete prefilled code (spec ledger
  // #29) — no Inspect button exists; await the fetch the page fires itself.
  const inspectResponsePromise = waitForFinishedBrowserResponse(
    page,
    'POST',
    '/api/duet/device/inspect',
  )
  await navigateDeployedPage(
    page,
    `${env.appUrl}/device?user_code=${encodeURIComponent(code.user_code)}`,
  )
  const inspectResponse = await inspectResponsePromise
  const inspection = DeviceApprovalResponseSchema.parse(await inspectResponse.json())
  assert.equal(inspection.status, 'pending')
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor()
  assert.equal(await page.locator('input[name="consent-workspace"]').count(), 0)
  const approve = page.getByRole('button', { name: 'Sign in', exact: true })
  const [approveResponse] = await Promise.all([
    waitForFinishedBrowserResponse(page, 'POST', '/api/duet/device/approve'),
    approve.click({ noWaitAfter: true, timeout: BROWSER_TRANSITION_TIMEOUT_MS }),
  ])
  assert.deepEqual(approveResponse.request().postDataJSON(), {
    userCode: code.user_code,
  })
  const approval = DeviceApprovalResponseSchema.parse(await approveResponse.json())
  assert.equal(approval.status, 'approved')
  await page.getByText('Signed in. Return to your terminal.').waitFor()

  await Bun.sleep((code.interval + 1) * 1_000)
  const approved = DeviceTokenResponseSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/device/token`,
      {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({ device_code: code.device_code }),
      },
      200,
      'human device token poll',
      artifacts,
    ),
  )
  assert.equal(approved.status, 'approved', 'human device did not return an API key')
  const deviceToken = approved.access_token
  const deviceHash = await hashApiKey(deviceToken)
  ledger.record({
    kind: 'api-key',
    id: approved.prefix,
    label: `${runId}:device-login-key:${approved.prefix}`,
    cleanup: async () => {
      await convex.mutation(fnMutation('testing/stagingE2e:revokeApiKeyByHashForTest'), {
        internalKey: env.internalKey,
        hashedKey: deviceHash,
        expectedPrefix: approved.prefix,
        expectedOwnerEmail: email,
      })
    },
    verify: async () => {
      const response = await stagingFetch(`${env.apiUrl}/v1/whoami`, {
        headers: bearer(deviceToken),
      })
      return response.status === 401
    },
  })

  const whoami = WhoamiResponseSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/whoami`,
      { headers: bearer(deviceToken) },
      200,
      'human device whoami',
      artifacts,
    ),
  )
  assert.equal(whoami.user.email, email)
  const browserIdentityResponse = await page.request.get(`${env.appUrl}/api/duet/whoami`)
  assert.equal(browserIdentityResponse.status(), 200)
  const browserIdentity = WhoamiResponseSchema.parse(await browserIdentityResponse.json())
  const memberships = (identity: typeof whoami) =>
    identity.workspaces
      .map(({ id, slug, role }) => ({ id, slug, role }))
      .sort((left, right) => left.id.localeCompare(right.id))
  assert.deepEqual(
    memberships(whoami),
    memberships(browserIdentity),
    'device login changed current workspace membership or roles',
  )
  assert.deepEqual(
    [...whoami.scopes].sort(),
    [...browserIdentity.scopes].sort(),
    'device login changed current role capabilities',
  )
  assert(
    whoami.workspaces.some(candidate => candidate.slug === workspace.slug),
    'minted user key omitted the current workspace',
  )

  const consumedPoll = DeviceTokenResponseSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/device/token`,
      {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({ device_code: code.device_code }),
      },
      200,
      'human device token consumed poll',
      artifacts,
    ),
  )
  consumed = consumedPoll.status === 'consumed'
  assert(consumed, 'human device token was reusable after consumption')
  return { accessToken: deviceToken, prefix: approved.prefix }
}
