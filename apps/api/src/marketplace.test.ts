import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ConvexHttpClient } from 'convex/browser'

import { VmDesiredMarketplaceAgentsSchema } from '@repo/contract'
import { OFFICIAL_AGENTS_WORKSPACE_SLUG } from '@repo/official-agents-seed/manifest'
import {
  convexDev,
  generateAuthKeys,
  issueKey,
  mutate,
  query,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

import { createApiApp } from './index'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../..', 'packages/backend')
const INTERNAL_KEY = 'test-official-agents-internal-key'
let convex: ConvexDevFixture
let app: ReturnType<typeof createApiApp>
let owner: { client: ConvexHttpClient; user: { _id: string; email: string } }
let sequence = 0
const hubListings: Record<string, string> = {}
let hubConfigured = false
let target: { id: string; slug: string }
let onboardingTarget: { id: string; slug: string }
let campaignOnboardingTarget: { id: string; slug: string } | undefined
let viewerKey: string
let ownerKey: string
let onboardingOwnerKey: string
const gatewayRequests: string[] = []
let gatewayPushStatus = 200
type PostHogCapture = { event: string; properties: Record<string, unknown> }
let postHog: ReturnType<typeof Bun.serve>
const capturedPostHog: PostHogCapture[] = []

describe.serial('official agents API (OA-SLICE-04-KZQ7)', () => {
  beforeAll(async () => {
    // Onboarding's own facts — what the user picked — leave no domain row, so
    // a sink is the only place they can be observed at all.
    postHog = Bun.serve({
      port: 0,
      async fetch(request) {
        capturedPostHog.push((await request.json()) as PostHogCapture)
        return Response.json({ status: 'ok' })
      },
    })
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_APP_URL: 'http://localhost:3000',
        POSTHOG_API_KEY: 'test-posthog-key',
        POSTHOG_HOST: postHog.url.href,
        // The projection derives listing source URLs, and edgeHost() fails
        // closed by design (slice 01) — without this the fixture's pushes 502
        // with no reports applied, which looks like a push bug and is not one.
        DUET_EDGE_HOST: 'edge-staging.duet.so',
      },
      reset: true,
    })
    owner = await signInWithMagicLink(
      convex,
      uniqueEmail('official-agents-api-owner'),
      'Official Agents API Owner',
    )
    const firstWorkspace = (await query(
      owner.client,
      'domains/workspaces/queries:listMine',
      {},
    )) as Array<{ workspace: { _id: string; slug: string } }>
    onboardingTarget = {
      id: firstWorkspace[0]!.workspace._id,
      slug: firstWorkspace[0]!.workspace.slug,
    }
    await mutate(owner.client, 'testing/workspaces:markWorkspaceLiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: onboardingTarget.id,
      now: Date.now(),
    })
    onboardingOwnerKey = (await issueKey(owner.client)).key
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
      },
    )
    await markPaymentReady(onboardingTarget.id)
    app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (input, init) => fixtureFetch(String(input), init),
    })
    // Shared fixture state (golden workspace, target workspace, viewer key).
    // This used to be called from inside the first test, so the whole serial
    // suite silently depended on that test running — and on it never being
    // deleted. It belongs here.
    await configureHub()
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
    postHog?.stop(true)
  })

  test('viewers can read the workspace subscription projection', async () => {
    const response = await authed(`/v1/ws/${target.slug}/marketplace/subscriptions`, viewerKey)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ items: [], nextCursor: null })
  })

  test('campaign agents lead completion order and replay without duplicate rows', async () => {
    const slug = `campaign-onboarding-${Date.now()}-${++sequence}`
    const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug,
      name: 'Campaign onboarding target',
    })) as string
    await mutate(owner.client, 'testing/workspaces:markWorkspaceLiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      now: Date.now(),
    })
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY },
    )
    await markPaymentReady(workspaceId)
    // Occupy the canonical install PATH so the campaign's first agent refuses.
    // It used to occupy only the agent SLUG, which no longer fails: a slug
    // collision is now disambiguated from the install folder rather than
    // throwing, so the path is the one collision the server genuinely cannot
    // resolve for the user.
    await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/fixture-a',
      slug: 'local-fixture-a',
      name: 'Local fixture A',
    })
    campaignOnboardingTarget = { id: workspaceId, slug }
    const key = (await issueKey(owner.client)).key
    app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (input, init) => fixtureFetch(String(input), init),
      campaignStarterAgentsForUser: async () => ['fixture-a', 'fixture-b'],
    })

    const request = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        duetName: 'Milo',
        selectedNames: ['fixture-b', 'client-extra'],
      }),
    }
    const first = await authed(`/v1/ws/${slug}/onboarding`, key, request)
    expect(first.status).toBe(200)
    const firstResults = (
      (await first.json()) as {
        results: Array<{
          name: string
          ok: boolean
          campaign?: true
          failure?: { error: string; path?: string; renameRequired?: true }
        }>
      }
    ).results
    expect(firstResults.map(result => result.name)).toEqual([
      'fixture-a',
      'fixture-b',
      'client-extra',
    ])
    // `campaign: true` marks a failure the user never asked for and cannot act
    // on, so the client stays silent about it instead of greeting every signup
    // through this campaign with an error. A failure for a name the client
    // selected carries no such mark.
    expect(firstResults[0]).toEqual({
      name: 'fixture-a',
      ok: false,
      campaign: true,
      failure: { error: 'path_exists', path: 'agents/fixture-a', renameRequired: true },
    })
    expect(
      firstResults.filter(result => result.campaign === true).map(result => result.name),
    ).toEqual(['fixture-a'])
    const beforeReplay = await campaignInstallRows(workspaceId)

    const replay = await authed(`/v1/ws/${slug}/onboarding`, key, request)
    expect(replay.status).toBe(200)
    expect(
      ((await replay.json()) as { results: Array<{ name: string }> }).results.map(
        result => result.name,
      ),
    ).toEqual(['fixture-a', 'fixture-b', 'client-extra'])
    expect(await campaignInstallRows(workspaceId)).toEqual(beforeReplay)

    app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (input, init) => fixtureFetch(String(input), init),
    })
  })

  test('onboarding installs name who asked for them, the user or the campaign', async () => {
    const slug = `onboarding-source-${Date.now()}-${++sequence}`
    const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug,
      name: 'Onboarding source target',
      requiresOnboarding: true,
    })) as string
    await mutate(owner.client, 'testing/workspaces:markWorkspaceLiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      now: Date.now(),
    })
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY },
    )
    await markPaymentReady(workspaceId)
    const key = (await issueKey(owner.client)).key
    app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (input, init) => fixtureFetch(String(input), init),
      // `fixture-b` arrives BOTH ways: the campaign seeds it and the user also
      // picked it. Someone who chose an agent chose it, whatever else put it in
      // front of them, so their intent is what the install records.
      campaignStarterAgentsForUser: async () => ['fixture-a', 'fixture-b'],
    })

    const response = await authed(`/v1/ws/${slug}/onboarding`, key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ duetName: 'Milo', selectedNames: ['fixture-b', 'client-extra'] }),
    })
    expect(response.status).toBe(200)

    expect(await installSources(workspaceId)).toEqual({
      'fixture-a': 'campaign',
      'fixture-b': 'onboarding',
      'client-extra': 'onboarding',
    })
    // The completion answers a different question than the installs do: what
    // this person picked, campaign seeding excluded.
    expect(await capturedOnboardingCompletion(workspaceId)).toMatchObject({
      selectedAgents: ['fixture-b', 'client-extra'],
      selectedAgentCount: 2,
    })

    app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (input, init) => fixtureFetch(String(input), init),
    })
  }, 60_000)

  test('workspace subscriptions require authentication', async () => {
    const response = await app.request(`/v1/ws/${target.slug}/marketplace/subscriptions`)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
  })

  test('onboarding skip persists one stable completion timestamp', async () => {
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY },
    )
    await markPaymentReady(onboardingTarget.id)
    expect(await rawWorkspace(onboardingTarget.id)).not.toMatchObject({
      duetName: expect.anything(),
      onboardedAt: expect.anything(),
    })
    let completedAt: number | undefined

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const requestedName = attempt === 0 ? '  Milo  ' : 'A retry must not rename Milo'
      const requestedPurpose =
        attempt === 0 ? '  Help my bakery sell online  ' : 'A retry must not repurpose Milo'
      const response = await authed(
        `/v1/ws/${onboardingTarget.slug}/onboarding`,
        onboardingOwnerKey,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            duetName: requestedName,
            skip: true,
            purpose: requestedPurpose,
            goal: attempt === 0 ? 'grow-business' : 'launch-project',
          }),
        },
      )
      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        duetName: string
        onboardedAt: number
        results: []
      }
      completedAt ??= payload.onboardedAt
      expect(payload).toEqual({ duetName: 'Milo', onboardedAt: completedAt, results: [] })
      expect(await rawWorkspace(onboardingTarget.id)).toMatchObject({
        duetName: 'Milo',
        purpose: 'Help my bakery sell online',
        onboardedAt: completedAt,
      })
    }

    const identity = (await (await authed('/v1/whoami', onboardingOwnerKey)).json()) as {
      workspaces: Array<{ slug: string; duetName?: string; purpose?: string; onboardedAt?: number }>
    }
    expect(
      identity.workspaces.find(workspace => workspace.slug === onboardingTarget.slug),
    ).toMatchObject({
      duetName: 'Milo',
      purpose: 'Help my bakery sell online',
      onboardedAt: completedAt,
    })

    // An operator visiting the workspace holds an impersonation credential, and
    // the product routes on `onboardedAt`: withhold it and every visit is sent
    // back through onboarding for a workspace that finished it long ago.
    const impersonation = (await convex.mutation('domains/apiKeys/api:mintImpersonationKey', {
      internalKey: INTERNAL_KEY,
      email: owner.user.email,
      workspaceSlug: onboardingTarget.slug,
      ttlSeconds: 60,
      now: Date.now(),
    })) as { token: string }
    const visited = (await (await authed('/v1/whoami', impersonation.token)).json()) as {
      workspaces: Array<{ slug: string; duetName?: string; purpose?: string; onboardedAt?: number }>
    }
    expect(
      visited.workspaces.find(workspace => workspace.slug === onboardingTarget.slug),
    ).toMatchObject({
      duetName: 'Milo',
      purpose: 'Help my bakery sell online',
      onboardedAt: completedAt,
    })
  })

  test('onboarding reports each installed agent and actionable partial failure', async () => {
    await mutate(owner.client, 'testing/workspaces:markWorkspaceLiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: onboardingTarget.id,
      now: Date.now(),
    })
    app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (input, init) => fixtureFetch(String(input), init),
    })
    gatewayPushStatus = 200
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY },
    )
    await markPaymentReady(onboardingTarget.id)
    await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
      workspaceId: onboardingTarget.id,
      path: 'agents/writer',
      kind: 'agent',
      settings: {},
    })
    gatewayRequests.length = 0

    const response = await authed(
      `/v1/ws/${onboardingTarget.slug}/onboarding`,
      onboardingOwnerKey,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          duetName: 'Milo',
          selectedNames: ['research', 'writer'],
        }),
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      results: [
        {
          name: 'research',
          ok: true,
          subscription: {
            agentName: 'research',
            state: 'active',
            appliedEtag: 'etag-research',
          },
        },
        {
          name: 'writer',
          ok: false,
          failure: {
            error: 'path_exists',
            path: 'agents/writer',
            renameRequired: true,
          },
        },
      ],
    })
    expect(gatewayRequests).toEqual([
      `https://${onboardingTarget.slug}.example.test/v1/marketplace/pull`,
    ])
    expect(await rawWorkspace(onboardingTarget.id)).toHaveProperty('onboardedAt')
  }, 60_000)

  test('the catalog refuses caller-supplied upstream URLs without fetching them', async () => {
    // Survives the move to Convex-backed reads: the route takes no query
    // parameters at all, so there is no seam through which a caller could
    // nominate an origin.
    const upstream = 'https://attacker.example.test/catalog'
    const response = await authed(`/v1/marketplace?url=${encodeURIComponent(upstream)}`, ownerKey)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_request' })
  })

  test('the catalog is signed-in only', async () => {
    // The auth-bypass patterns that made /v1/official-agents anonymous are
    // deleted; MAP decision 15 says marketplace reads require a session.
    expect((await app.request('/v1/marketplace')).status).toBe(401)
  })

  test('viewers cannot install official agents', async () => {
    const response = await authed(`/v1/ws/${target.slug}/marketplace/subscriptions`, viewerKey, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listingId: hubListings.research, name: 'Chosen Name' }),
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'forbidden' })
  })

  test('install returns the applied subscription without creating a session', async () => {
    gatewayRequests.length = 0
    gatewayPushStatus = 200
    const before = await listSessions()
    const response = await authed(`/v1/ws/${target.slug}/marketplace/subscriptions`, ownerKey, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listingId: hubListings.research, name: 'Chosen Name' }),
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      subscription: {
        agentName: 'research',
        path: 'agents/research',
        mode: 'subscribe',
        state: 'active',
        appliedEtag: 'etag-research',
      },
    })
    expect(await rawSubscriptions()).toContainEqual(
      expect.objectContaining({
        agentName: 'research',
        state: 'active',
        appliedEtag: 'etag-research',
      }),
    )
    expect(gatewayRequests).toEqual([`https://${target.slug}.example.test/v1/marketplace/pull`])
    expect(await listSessions()).toEqual(before)
  })

  test('push failure returns a typed 502 after persisting the failed pull report', async () => {
    gatewayPushStatus = 500
    const response = await authed(`/v1/ws/${target.slug}/marketplace/subscriptions`, ownerKey, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listingId: hubListings.writer, name: 'Chosen Name' }),
    })

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'pull_failed' })
    expect(await rawSubscriptions()).toContainEqual(
      expect.objectContaining({
        agentName: 'writer',
        path: 'agents/writer',
        mode: 'subscribe',
        state: 'error',
        lastErrorCode: 'pull_failed',
      }),
    )
  })

  test('reinstalling the same agent adopts its subscription instead of refusing', async () => {
    // `research` is already installed at its canonical path by an earlier test.
    // Campaign auto-install retries this exact call when a response is lost, so
    // refusing here would wedge a signup behind an install it already has.
    gatewayPushStatus = 200
    gatewayRequests.length = 0
    const before = await rawSubscriptions()
    const response = await authed(`/v1/ws/${target.slug}/marketplace/subscriptions`, ownerKey, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listingId: hubListings.research, name: 'Chosen Name' }),
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      subscription: { agentName: 'research', path: 'agents/research', mode: 'subscribe' },
    })
    // Adoption, not a second row.
    expect((await rawSubscriptions()).filter(row => row.agentName === 'research')).toHaveLength(
      before.filter(row => row.agentName === 'research').length,
    )
  })

  test('a foreign occupant of the canonical path still returns the typed refusal', async () => {
    // The refusal exists for the case adoption must NOT cover: something else
    // already owns `agents/<name>`. The API forwards the backend's typed payload
    // verbatim rather than flattening it to a bare status.
    gatewayPushStatus = 200
    gatewayRequests.length = 0
    await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: target.id,
      path: 'agents/analyst',
      slug: 'squatter',
      name: 'Not the official analyst',
    })

    const response = await authed(`/v1/ws/${target.slug}/marketplace/subscriptions`, ownerKey, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listingId: hubListings.analyst, name: 'Chosen Name' }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'path_exists',
      path: 'agents/analyst',
      renameRequired: true,
    })
    expect(gatewayRequests).toEqual([])
  })

  test('clone creates a clone-once subscription at the requested path and pushes a pull', async () => {
    gatewayPushStatus = 200
    gatewayRequests.length = 0
    const response = await authed(
      `/v1/ws/${target.slug}/marketplace/subscriptions/clone`,
      ownerKey,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          listingId: hubListings.analyst,
          name: 'Chosen Name',
          path: 'my-agents/research-copy',
        }),
      },
    )

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      subscription: {
        agentName: 'analyst',
        path: 'my-agents/research-copy',
        mode: 'clone_once',
        state: 'detached',
        appliedEtag: 'etag-analyst',
      },
    })
    expect(gatewayRequests).toEqual([`https://${target.slug}.example.test/v1/marketplace/pull`])
  })

  test('acknowledge durably copies the applied etag without pushing the gateway', async () => {
    const research = (await rawSubscriptions()).find(row => row.agentName === 'research')!
    await mutate(convex, 'domains/marketplace/model:applyPullReports', {
      internalKey: INTERNAL_KEY,
      workspaceId: target.id,
      reports: [
        {
          subscriptionId: research._id,
          state: 'active',
          appliedEtag: 'research-etag-2',
          lastAppliedAt: Date.now(),
        },
      ],
    })
    gatewayRequests.length = 0

    const response = await authed(
      `/v1/ws/${target.slug}/marketplace/subscriptions/${research._id}/acknowledge`,
      ownerKey,
      { method: 'POST' },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      subscription: {
        id: research._id,
        appliedEtag: 'research-etag-2',
        acknowledgedEtag: 'research-etag-2',
      },
    })
    expect(gatewayRequests).toEqual([])
  })

  test('uninstall detaches the subscription without pushing the gateway', async () => {
    const writer = (await rawSubscriptions()).find(row => row.agentName === 'writer')!
    gatewayRequests.length = 0

    const response = await authed(
      `/v1/ws/${target.slug}/marketplace/subscriptions/${writer._id}`,
      ownerKey,
      {
        method: 'DELETE',
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(await rawSubscriptions()).toContainEqual(
      expect.objectContaining({ _id: writer._id, state: 'detached' }),
    )
    expect(gatewayRequests).toEqual([])
  })
})

/** ONE durable official hub for the suite's bare-name onboarding lookups. */
async function configureHub() {
  if (hubConfigured) return
  hubConfigured = true
  const goldenWorkspaceId = (await mutate(
    owner.client,
    'testing/workspaces:createWorkspaceForTest',
    {
      internalKey: INTERNAL_KEY,
      slug: OFFICIAL_AGENTS_WORKSPACE_SLUG,
      name: 'Official Hub',
    },
  )) as string
  await mutate(owner.client, 'testing/workspaces:markWorkspaceLiveForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId: goldenWorkspaceId,
    now: Date.now(),
  })
  await mutate(owner.client, 'domains/publishes/model:createPublish', {
    workspaceId: goldenWorkspaceId,
    path: 'official',
    kind: 'folder',
    slug: 'official-agents',
  })
  await mutate(convex, 'testing/marketplace:markVerifiedPublisherForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId: goldenWorkspaceId,
    now: 10_000,
  })
  const hubPublish = (await query(convex, 'testing/marketplace:publishBySlugForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId: goldenWorkspaceId,
    slug: 'official-agents',
  })) as { _id: string }
  // Every agent these tests install needs a listing, or the bare-name resolver
  // finds nothing and the subscription is unprojectable.
  for (const agentName of [
    'research',
    'writer',
    'analyst',
    'fixture-a',
    'fixture-b',
    'client-extra',
  ]) {
    const registered = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: goldenWorkspaceId,
      path: `official/${agentName}`,
      slug: agentName,
      name: agentName,
    })) as { id: string; anchorId: string }
    hubListings[agentName] = (await mutate(convex, 'testing/marketplace:insertListingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: goldenWorkspaceId,
      agentId: registered.id,
      anchorId: registered.anchorId,
      publishId: hubPublish._id,
      agentName,
      agentSubpath: agentName,
      createdByUserId: owner.user._id,
      now: 10_000,
    })) as string
  }

  const targetSlug = `official-target-${Date.now()}-${++sequence}`
  const targetId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug: targetSlug,
    name: 'Official Target',
  })) as string
  await mutate(owner.client, 'testing/workspaces:markWorkspaceLiveForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId: targetId,
    now: Date.now(),
  })
  target = { id: targetId, slug: targetSlug }
  const viewer = await signInWithMagicLink<{ _id: string }>(
    convex,
    uniqueEmail('official-agents-api-viewer'),
    'Official Agents API Viewer',
  )
  await mutate(convex, 'testing/workspaces:addWorkspaceMemberForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId: targetId,
    userId: viewer.user._id,
    role: 'viewer',
  })
  viewerKey = (await issueKey(viewer.client)).key
  ownerKey = (await issueKey(owner.client)).key
  return goldenWorkspaceId
}

async function fixtureFetch(
  url: string,
  init?: RequestInit,
  catalogRequests: string[] = [],
): Promise<Response> {
  const fixture = catalogFixtures().get(url)
  if (fixture !== undefined) {
    catalogRequests.push(url)
    return fixture
  }
  if (
    url === `https://${target.slug}.example.test/v1/marketplace/pull` ||
    url === `https://${onboardingTarget.slug}.example.test/v1/marketplace/pull` ||
    url === `https://${campaignOnboardingTarget?.slug}.example.test/v1/marketplace/pull`
  ) {
    gatewayRequests.push(url)
    const desired = VmDesiredMarketplaceAgentsSchema.parse(JSON.parse(String(init?.body)))
    const reports = desired.subscriptions.map(subscription =>
      gatewayPushStatus === 200
        ? {
            subscriptionId: subscription.subscriptionId,
            state: 'active' as const,
            appliedEtag: `etag-${subscription.agentName}`,
            lastAppliedAt: 60_000,
          }
        : {
            subscriptionId: subscription.subscriptionId,
            state: 'error' as const,
            lastErrorCode: 'pull_failed',
          },
    )
    return Response.json(
      gatewayPushStatus === 200 ? { ok: true, reports } : { error: 'pull_failed', reports },
      { status: gatewayPushStatus },
    )
  }
  return Response.json({ error: 'fixture_not_found' }, { status: 404 })
}

async function listSessions() {
  return await query(convex, 'domains/agentSessions/model:listSessions', {
    internalKey: INTERNAL_KEY,
    workspaceId: target.id,
    identity: {
      principal: { kind: 'human', userId: owner.user._id },
      actorId: owner.user._id,
    },
    actorId: owner.user._id,
  })
}

async function rawSubscriptions() {
  return (await query(convex, 'testing/marketplace:rawSubscriptionsForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId: target.id,
  })) as Array<Record<string, unknown>>
}

async function rawWorkspace(workspaceId: string) {
  return (await query(convex, 'testing/workspaces:rawWorkspaceByIdForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as Record<string, unknown>
}

/** The sink is fed by a retrier action, so the capture trails the response. */
async function capturedOnboardingCompletion(
  workspaceId: string,
): Promise<Record<string, unknown> | undefined> {
  const find = () =>
    capturedPostHog.find(
      capture =>
        capture.event === 'onboarding.completed' && capture.properties.workspace_id === workspaceId,
    )
  const deadline = Date.now() + 30_000
  while (find() === undefined && Date.now() < deadline) await Bun.sleep(25)
  return find()?.properties
}

/** Every install this workspace recorded, keyed by the listing it installed. */
async function installSources(workspaceId: string): Promise<Record<string, unknown>> {
  const events = (await query(owner.client, 'domains/workspaces/queries:getAuditEvents', {
    workspaceId,
  })) as Array<{ event: string; provenance?: { listingSlug?: string; source?: string } }>
  return Object.fromEntries(
    events
      .filter(event => event.event === 'agent.installed')
      .map(event => [event.provenance?.listingSlug, event.provenance?.source]),
  )
}

async function campaignInstallRows(workspaceId: string) {
  const [subscriptions, agents, anchors] = await Promise.all([
    query(convex, 'testing/marketplace:rawSubscriptionsForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    }),
    query(convex, 'testing/agents:rawAgentsForTest', {
      internalKey: INTERNAL_KEY,
    }),
    query(convex, 'testing/anchors:rawAnchorsForTest', {
      internalKey: INTERNAL_KEY,
    }),
  ])
  return {
    subscriptions,
    agents: (agents as Array<{ workspaceId: string }>).filter(
      agent => agent.workspaceId === workspaceId,
    ),
    anchors: (anchors as Array<{ workspaceId: string }>).filter(
      anchor => anchor.workspaceId === workspaceId,
    ),
  }
}

function catalogFixtures(): Map<string, Response> {
  return new Map([
    [
      'https://edge.example.test/golden/official-agents?list',
      Response.json({
        items: [entry('notes.txt', 'file'), entry('research', 'directory')],
        nextCursor: null,
      }),
    ],
    [
      'https://edge.example.test/golden/official-agents/research/AGENTS.md?raw',
      new Response(
        '# Research Assistant\n\nTurns source material into concise,\n' +
          'cited research briefs.\n\nThis later paragraph is not the description.\n',
      ),
    ],
    [
      'https://edge.example.test/golden/official-agents/research/CHANGELOG.md?raw',
      new Response('# Changelog\n\n## 1.1\n\nAdded citations.\n'),
    ],
    [
      'https://edge.example.test/golden/official-agents/research/.agents/skills?list',
      Response.json({
        items: [
          entry('summarize', 'directory'),
          entry('README.md', 'file'),
          entry('browse', 'directory'),
        ],
        nextCursor: null,
      }),
    ],
  ])
}

function entry(name: string, type: 'file' | 'directory') {
  return {
    name,
    path: name,
    type,
    size: 0,
    mtime: '2026-07-22T00:00:00.000Z',
  }
}

function authed(path: string, key: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${key}`)
  return app.request(path, { ...init, headers })
}

async function markPaymentReady(workspaceId: string): Promise<void> {
  await mutate(owner.client, 'domains/credits/internal:markOnboardingPaymentReady', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    workspaceId,
    attemptId: `test-onboarding-${workspaceId}`,
    paymentIntentId: `pi_test_${workspaceId}`,
    now: Date.now(),
  })
}
