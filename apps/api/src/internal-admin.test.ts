import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ConvexHttpClient } from 'convex/browser'

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
const INTERNAL_KEY = 'test-admin-internal-key'
let convex: ConvexDevFixture
let client: ConvexHttpClient
let user: { _id: string; email: string }
let workspace: { _id: string; slug: string }
let app: ReturnType<typeof createApiApp>
let browserKey: string

async function seedUnpaidPayers(args: {
  count: number
  balanceMicroUsd: number
  now: number
  startIndex?: number
  ownerMembership?: boolean
}): Promise<void> {
  const batchSize = 25
  const first = args.startIndex ?? 0
  for (let startIndex = first; startIndex < first + args.count; startIndex += batchSize) {
    await convex.mutation('testing/internalAdmin:seedUnpaidPayers', {
      internalKey: INTERNAL_KEY,
      startIndex,
      count: Math.min(batchSize, first + args.count - startIndex),
      balanceMicroUsd: args.balanceMicroUsd,
      now: args.now,
      ...(args.ownerMembership === undefined ? {} : { ownerMembership: args.ownerMembership }),
    })
  }
}

describe('Duet internal admin API', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_TEST_FAKE_EXE: '1',
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })
    const signedIn = await signInWithMagicLink<{ _id: string; email: string }>(
      convex,
      uniqueEmail('admin').replace(/@[^@]+$/, '@duet.so'),
      'Admin Operator',
    )
    client = signedIn.client
    user = signedIn.user
    await mutate(client, 'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest', {
      internalKey: INTERNAL_KEY,
    })
    workspace = (
      (await query(client, 'domains/workspaces/queries:listMine', {})) as Array<{
        workspace: { _id: string; slug: string }
      }>
    )[0]!.workspace
    const session = (await mutate(client, 'domains/apiKeys/mutations:mintBrowserSession', {})) as {
      token: string
    }
    browserKey = session.token
    app = createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY })
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('denies ordinary API keys even for a team-domain operator', async () => {
    const key = await issueKey(client)
    const response = await authed('/v1/internal-admin/search?q=admin', key.key)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'internal_admin_required' })
  })

  test('admits a short-lived internal impersonation credential for a team-domain operator', async () => {
    const impersonation = (await convex.mutation('domains/apiKeys/api:mintImpersonationKey', {
      internalKey: INTERNAL_KEY,
      email: user.email,
      ttlSeconds: 60,
      now: Date.now(),
    })) as { token: string }

    const response = await authed('/v1/internal-admin/search?q=admin', impersonation.token)
    expect(response.status).toBe(200)
  })

  test('server-denies an ordinary browser session outside the team domains', async () => {
    const ordinary = await signInWithMagicLink<{ _id: string; email: string }>(
      convex,
      uniqueEmail('ordinary-admin-deny'),
      'Ordinary User',
    )
    await mutate(
      ordinary.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
      },
    )
    const session = (await mutate(
      ordinary.client,
      'domains/apiKeys/mutations:mintBrowserSession',
      {},
    )) as { token: string }
    const creation = await authed('/v1/internal-admin/users', session.token, {
      method: 'POST',
      body: JSON.stringify({ email: uniqueEmail('ordinary-cannot-create') }),
    })
    expect(creation.status).toBe(403)
    expect(await creation.json()).toEqual({ error: 'internal_admin_required' })
    const response = await authed('/v1/internal-admin/search?q=acme', session.token)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'internal_admin_required' })
  })

  test('denies official hub seeding to a non-admin browser session', async () => {
    const ordinary = await signInWithMagicLink<{ _id: string; email: string }>(
      convex,
      uniqueEmail('ordinary-hub-seed-deny'),
      'Ordinary Hub User',
    )
    await mutate(
      ordinary.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY },
    )
    const session = (await mutate(
      ordinary.client,
      'domains/apiKeys/mutations:mintBrowserSession',
      {},
    )) as { token: string }

    const response = await authed('/v1/internal-admin/official-hub/sync', session.token, {
      method: 'POST',
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'internal_admin_required' })
  })

  // Log reads are unredacted by design, so this gate is the only thing between
  // an ordinary signed-in user and a VM's credentials, prompts, and file paths.
  test('denies operator log reads to a non-admin browser session', async () => {
    const ordinary = await signInWithMagicLink<{ _id: string; email: string }>(
      convex,
      uniqueEmail('ordinary-logs-deny'),
      'Ordinary Logs User',
    )
    await mutate(
      ordinary.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY },
    )
    const session = (await mutate(
      ordinary.client,
      'domains/apiKeys/mutations:mintBrowserSession',
      {},
    )) as { token: string }

    const response = await authed(
      `/v1/internal-admin/workspaces/${workspace._id}/logs?source=gateway`,
      session.token,
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'internal_admin_required' })
  })

  test('opens the golden workspace with the login-as cookie shape', async () => {
    // The hub is now identified by the slug the seed manifest owns, not by a
    // singleton row pointing at an arbitrary workspace.
    const hubWorkspaceId = (await mutate(client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug: OFFICIAL_AGENTS_WORKSPACE_SLUG,
      name: 'Official Agents Hub',
    })) as string
    await mutate(client, 'testing/workspaces:markWorkspaceLiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: hubWorkspaceId,
      now: Date.now(),
    })

    const response = await authed('/v1/internal-admin/official-hub/access', browserKey, {
      method: 'POST',
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toMatch(
      /^duet_session=.+; Path=\/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax$/,
    )
    expect(await response.json()).toMatchObject({
      workspaceSlug: OFFICIAL_AGENTS_WORKSPACE_SLUG,
      token: expect.any(String),
      prefix: expect.any(String),
      expiresAt: expect.any(Number),
    })
  })

  test('an admin outside a paused workspace can restore its subscribed payer', async () => {
    const former = await signInWithMagicLink<{ _id: string; email: string }>(
      convex,
      uniqueEmail('former-payer'),
      'Former payer',
    )
    const next = await signInWithMagicLink<{ _id: string; email: string }>(
      convex,
      uniqueEmail('next-payer'),
      'Next payer',
    )
    await mutate(
      next.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
        plan: 'starter',
      },
    )
    const target = (
      (await query(former.client, 'domains/workspaces/queries:listMine', {})) as Array<{
        workspace: { _id: string }
      }>
    )[0]!.workspace
    await mutate(client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: target._id,
      userId: next.user._id,
      role: 'owner',
    })
    await mutate(client, 'testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: target._id,
      servicingStatus: 'paused',
      now: Date.now(),
    })
    const transfer = () =>
      authed(`/v1/internal-admin/workspaces/${target._id}`, browserKey, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'payer',
          newBillingUserId: next.user._id,
          reason: 'Restore subscribed payer',
        }),
      })
    expect((await transfer()).status).toBe(200)
    const detail = await authed(`/v1/internal-admin/workspaces/${target._id}`, browserKey)
    expect(await detail.json()).toMatchObject({
      workspace: {
        billingUserId: next.user._id,
        billingEmail: next.user.email,
        servicingStatus: 'active',
      },
    })
    expect((await transfer()).status).toBe(200)
    const audits = await convex.query('testing/internalAdmin:auditEvents', {
      internalKey: INTERNAL_KEY,
    })
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: 'admin.workspace.payer',
        actorEmail: user.email,
        workspaceId: target._id,
        reason: 'Restore subscribed payer',
        status: 'completed',
      }),
    )
    // Keep the shared fixture's later unpaid-credit totals independent of this transfer.
    await mutate(
      former.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY },
    )
  })

  test('searches, inspects, mutates, and writes mandatory audit provenance', async () => {
    const search = await authed(
      `/v1/internal-admin/search?q=${encodeURIComponent(user.email)}`,
      browserKey,
    )
    expect(search.status).toBe(200)
    const searchBody = (await search.json()) as {
      workspaces: Array<{ id: string; slug: string }>
      auditId: string
    }
    expect(searchBody.workspaces).toContainEqual(
      expect.objectContaining({ id: workspace._id, slug: workspace.slug }),
    )
    expect(searchBody.auditId).toBeString()

    const detail = await authed(`/v1/internal-admin/workspaces/${workspace._id}`, browserKey)
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({
      workspace: { id: workspace._id },
      usage: { members: expect.any(Array) },
      ledger: expect.any(Array),
      auditId: expect.any(String),
    })

    const adjustment = await authed(`/v1/internal-admin/workspaces/${workspace._id}`, browserKey, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'credit',
        amountMicroUsd: 2_500_000,
        reason: 'Customer support correction',
      }),
    })
    expect(adjustment.status).toBe(200)
    const legacyPause = await authed(`/v1/internal-admin/workspaces/${workspace._id}`, browserKey, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'servicing',
        servicingStatus: 'paused',
        reason: 'Incident containment',
      }),
    })
    expect(legacyPause.status).toBe(400)
    const ban = await authed(`/v1/internal-admin/workspaces/${workspace._id}`, browserKey, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'ban', reason: 'Incident containment' }),
    })
    expect(ban.status).toBe(200)

    const audits = (await convex.query('testing/internalAdmin:auditEvents', {
      internalKey: INTERNAL_KEY,
    })) as Array<{
      action: string
      actorEmail: string
      reason: string
      requestId: string
      status: string
    }>
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: 'admin.search',
        actorEmail: user.email,
        status: 'completed',
      }),
    )
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: 'admin.workspace.credit',
        reason: 'Customer support correction',
        status: 'completed',
      }),
    )
    expect(audits.every(row => row.requestId.length >= 8 && row.reason.length >= 3)).toBe(true)
  })

  test('reprovisions a workspace the operator is not a member of, keeping admin audit provenance', async () => {
    // The workspace must belong to someone else: the one configuration where a
    // member-owner assertion on the shared reprovision path would pass by luck
    // is "the calling admin owns the fixture", which is what this test used to
    // set up.
    const owner = await signInWithMagicLink<{ _id: string; email: string }>(
      convex,
      uniqueEmail('reprovision-owner'),
      'Reprovision Owner',
    )
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY },
    )
    const slug = `admin-reprovision-${crypto.randomUUID().slice(0, 8)}`
    const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug,
      name: 'Admin reprovision fixture',
    })) as string

    const response = await authed(
      `/v1/internal-admin/workspaces/${workspaceId}/vm/reprovision`,
      browserKey,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          confirmation: slug,
          reason: 'Restore unhealthy VM',
        }),
      },
    )
    expect(response.status).toBe(202)

    const audits = (await convex.query('testing/internalAdmin:auditEvents', {
      internalKey: INTERNAL_KEY,
    })) as Array<{ action: string; actorEmail: string; reason: string; status: string }>
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: 'admin.vm.reprovision',
        actorEmail: user.email,
        reason: 'Restore unhealthy VM',
        status: 'accepted',
      }),
    )
  })

  test('workspace detail sums monthly spend and tokens from unified usage rollups', async () => {
    const month = new Date().toISOString().slice(0, 7)
    await mutate(convex, 'domains/credits/internal:applyUsageRollupBatch', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      periodKeys: { daily: `${month}-01`, weekly: '2000-W01', monthly: month },
      spendMicroUsd: 321,
      inputTokens: 34,
      outputTokens: 12,
      userId: user._id,
    })

    const response = await authed(`/v1/internal-admin/workspaces/${workspace._id}`, browserKey)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      usage: {
        month: string
        spendMicroUsd: number
        inputTokens: number
        outputTokens: number
        members: Array<{
          userId: string
          spendMicroUsd: number
          inputTokens: number
          outputTokens: number
        }>
      }
    }
    expect(body.usage).toMatchObject({
      month,
      spendMicroUsd: 321,
      inputTokens: 34,
      outputTokens: 12,
    })
    expect(body.usage.members).toContainEqual(
      expect.objectContaining({
        userId: user._id,
        spendMicroUsd: 321,
        inputTokens: 34,
        outputTokens: 12,
      }),
    )
  })

  test('reboots the attached VM through exe and records the original audit name', async () => {
    await mutate(client, 'testing/workspaces:markWorkspaceLiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      now: Date.now(),
    })
    const restarted: string[] = []
    const rebootApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      internalAdminExeClient: {
        getStatus: async () => 'running',
        restart: async vmName => {
          restarted.push(vmName)
        },
      },
    })

    const response = await authedWith(
      rebootApp,
      `/v1/internal-admin/workspaces/${workspace._id}/vm/reboot`,
      browserKey,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmation: workspace.slug, reason: 'Recover unhealthy VM' }),
      },
    )
    expect(response.status).toBe(200)
    expect(restarted).toEqual([`vm-${workspace.slug}`])

    const audits = (await convex.query('testing/internalAdmin:auditEvents', {
      internalKey: INTERNAL_KEY,
    })) as Array<{ action: string; reason: string; status: string }>
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: 'admin.vm.reboot',
        reason: 'Recover unhealthy VM',
        status: 'completed',
      }),
    )
  })

  test('updates Chrome through the attached gateway and records operator provenance', async () => {
    await mutate(client, 'testing/workspaces:markWorkspaceLiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      now: Date.now(),
    })
    const gatewayRequests: Array<{ url: string; method: string; authorization: string | null }> = []
    const updateApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (input, init) => {
        const request = new Request(input, init)
        gatewayRequests.push({
          url: request.url,
          method: request.method,
          authorization: request.headers.get('authorization'),
        })
        return Response.json({ ok: true })
      },
    })

    const response = await authedWith(
      updateApp,
      `/v1/internal-admin/workspaces/${workspace._id}/vm/chrome-update`,
      browserKey,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          confirmation: workspace.slug,
          reason: 'Apply the audited browser security pin',
        }),
      },
    )

    expect(response.status).toBe(200)
    expect(gatewayRequests).toEqual([
      expect.objectContaining({
        url: expect.stringMatching(/\/v1\/internal-admin\/chrome-update$/),
        method: 'POST',
        authorization: expect.stringMatching(/^Bearer /),
      }),
    ])
    const audits = (await convex.query('testing/internalAdmin:auditEvents', {
      internalKey: INTERNAL_KEY,
    })) as Array<{ action: string; actorEmail: string; reason: string; status: string }>
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: 'admin.vm.chrome-update',
        actorEmail: user.email,
        reason: 'Apply the audited browser security pin',
        status: 'completed',
      }),
    )
  })

  test('requires the workspace slug before the Chrome update reaches the VM', async () => {
    await mutate(client, 'testing/workspaces:markWorkspaceLiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      now: Date.now(),
    })
    let gatewayCalls = 0
    const updateApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => {
        gatewayCalls += 1
        return Response.json({ ok: true })
      },
    })

    const response = await authedWith(
      updateApp,
      `/v1/internal-admin/workspaces/${workspace._id}/vm/chrome-update`,
      browserKey,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          confirmation: 'the-wrong-workspace',
          reason: 'Attempt the browser security pin',
        }),
      },
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'confirmation_mismatch' })
    expect(gatewayCalls).toBe(0)
  })

  test('preserves the gateway desktop_busy refusal and records a failed audit', async () => {
    await mutate(client, 'testing/workspaces:markWorkspaceLiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      now: Date.now(),
    })
    const updateApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => Response.json({ error: 'desktop_busy' }, { status: 409 }),
    })

    const response = await authedWith(
      updateApp,
      `/v1/internal-admin/workspaces/${workspace._id}/vm/chrome-update`,
      browserKey,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          confirmation: workspace.slug,
          reason: 'Retry the browser security pin',
        }),
      },
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'desktop_busy' })
    const audits = (await convex.query('testing/internalAdmin:auditEvents', {
      internalKey: INTERNAL_KEY,
    })) as Array<{ action: string; reason: string; status: string }>
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: 'admin.vm.chrome-update',
        reason: 'Retry the browser security pin',
        status: 'failed',
      }),
    )
  })

  test('reports the gateway process identity used to prove a VM restart', async () => {
    await mutate(client, 'testing/workspaces:markWorkspaceLiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      now: Date.now(),
    })
    const statusApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      internalAdminExeClient: { getStatus: async () => 'running', restart: async () => {} },
      fetch: async () =>
        Response.json({
          instanceId: 'gateway-instance-after-restart',
          runtimeVersion: 'gateway-test',
          uptimeSeconds: 3,
        }),
    })

    const response = await authedWith(
      statusApp,
      `/v1/internal-admin/workspaces/${workspace._id}/vm`,
      browserKey,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      gateway: {
        reachable: true,
        instanceId: 'gateway-instance-after-restart',
        runtimeVersion: 'gateway-test',
        uptimeSeconds: 3,
      },
    })
  })

  test('triages feedback and rejects destructive operations without a reason', async () => {
    const feedbackId = (await convex.mutation('domains/feedback/model:create', {
      internalKey: INTERNAL_KEY,
      content: 'Fixture feedback',
      source: 'test',
      now: Date.now(),
    })) as string
    const list = await authed('/v1/internal-admin/feedback', browserKey)
    expect(list.status).toBe(200)
    expect(await list.json()).toMatchObject({
      feedback: [expect.objectContaining({ id: feedbackId, content: 'Fixture feedback' })],
    })
    const invalid = await authed(`/v1/internal-admin/feedback/${feedbackId}`, browserKey, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'delete', reason: '' }),
    })
    expect(invalid.status).toBe(400)
    const archived = await authed(`/v1/internal-admin/feedback/${feedbackId}`, browserKey, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'archive', reason: 'Feedback handled' }),
    })
    expect(archived.status).toBe(200)
    const archivedList = await authed('/v1/internal-admin/feedback?archived=1', browserKey)
    expect(await archivedList.json()).toMatchObject({
      feedback: [expect.objectContaining({ id: feedbackId, archivedAt: expect.any(Number) })],
    })
  })

  test('reports file-sync batch health on the workspace detail', async () => {
    await mutate(client, 'domains/fileActivity/api:recordBatchFromApi', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      batch: {
        batchId: 'admin-health-1',
        events: [{ kind: 'write', path: 'health/probe.md', actor: 'terminal', at: 1_000 }],
        droppedReads: 3,
        overflow: 1,
      },
    })
    const detail = await authed(`/v1/internal-admin/workspaces/${workspace._id}`, browserKey)
    expect(detail.status).toBe(200)
    const body = (await detail.json()) as { syncHealth: Record<string, unknown> }
    expect(body.syncHealth).toEqual({
      batches: 1,
      droppedReads: 3,
      overflow: 1,
      lastRecordedAt: expect.any(Number),
    })
  })

  test('lists the operator audit trail newest-first and audits the read itself', async () => {
    const seeded = await authed('/v1/internal-admin/feedback', browserKey)
    expect(seeded.status).toBe(200)

    const list = await authed('/v1/internal-admin/audit', browserKey)
    expect(list.status).toBe(200)
    const body = (await list.json()) as {
      events: Array<Record<string, unknown>>
      auditId: string
    }
    expect(body.auditId).toEqual(expect.any(String))
    expect(body.events.length).toBeGreaterThan(0)
    const ats = body.events.map(event => event.at as number)
    expect(ats).toEqual([...ats].sort((a, b) => b - a))
    const first = body.events[0]!
    expect(first.actorEmail).toBe(user.email)
  })

  test('finalizes one effect audit truthfully instead of appending contradictory events', async () => {
    const base = {
      internalKey: INTERNAL_KEY,
      actorId: user._id,
      requestId: 'effect_audit_1234',
      reason: 'Runtime investigation',
      now: Date.now(),
      workspaceId: workspace._id,
      action: 'admin.vm.status',
      target: 'vm/status',
    }
    const started = (await convex.mutation(
      'domains/internalAdmin/model:authorizeEffect',
      base,
    )) as { auditId: string }
    let audits = (await convex.query('testing/internalAdmin:auditEvents', {
      internalKey: INTERNAL_KEY,
    })) as Array<{ _id: string; requestId: string; status: string; detail?: string }>
    expect(audits.find(row => row._id === started.auditId)).toMatchObject({
      requestId: base.requestId,
      status: 'started',
    })
    await convex.mutation('domains/internalAdmin/model:finalizeEffect', {
      internalKey: INTERNAL_KEY,
      actorId: user._id,
      requestId: base.requestId,
      reason: base.reason,
      now: Date.now(),
      auditId: started.auditId,
      success: false,
      detail: 'gateway_http_503',
    })
    audits = (await convex.query('testing/internalAdmin:auditEvents', {
      internalKey: INTERNAL_KEY,
    })) as Array<{ _id: string; requestId: string; status: string; detail?: string }>
    expect(audits.filter(row => row.requestId === base.requestId)).toHaveLength(1)
    expect(audits.find(row => row._id === started.auditId)).toMatchObject({
      status: 'failed',
      detail: 'gateway_http_503',
    })
  })

  test('deleted-workspace tombstones never count against the exactness cap', async () => {
    // Staging reality: every e2e run leaves a status:'deleted' workspace row
    // forever, so tombstones outnumber live rows by orders of magnitude. The
    // report's exact-or-refuse cap must measure its actual domain (billing
    // users), not dead rows.
    const now = Date.now()
    await convex.mutation('testing/internalAdmin:seedDeletedWorkspaceTombstones', {
      internalKey: INTERNAL_KEY,
      count: 1_100,
      now,
    })
    await seedUnpaidPayers({
      count: 3,
      balanceMicroUsd: 2_000_000,
      now,
    })
    const summary = await authed('/v1/internal-admin/free-credits', browserKey)
    expect(summary.status).toBe(200)
    expect(await summary.json()).toMatchObject({
      totalFreeCreditsMicroUsd: 6_000_000,
      unpaidUserCount: 3,
      usersWithBalanceCount: 3,
    })
    const reset = await authed('/v1/internal-admin/free-credits/reset', browserKey, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'RESET FREE CREDITS', reason: 'Tombstone fixture' }),
    })
    expect(reset.status).toBe(200)
    expect(
      await convex.query('testing/internalAdmin:countPositiveUnpaidPayers', {
        internalKey: INTERNAL_KEY,
      }),
    ).toBe(0)
    // The reset is one leg per payer, not one transaction, so the audit row it
    // returns must be the one opened before the first debit, closed with the
    // total once every leg has run.
    const { auditId } = (await reset.json()) as { auditId: string }
    const audits = (await convex.query('testing/internalAdmin:auditEvents', {
      internalKey: INTERNAL_KEY,
    })) as Array<{ _id: string; action: string; status: string; detail?: string }>
    expect(audits.find(row => row._id === auditId)).toMatchObject({
      action: 'admin.credits.reset',
      status: 'completed',
      detail: 'removed=6000000',
    })
    // Leave no unpaid-billed-user residue for the exact-count test below.
    await convex.mutation('testing/internalAdmin:markSeededPayersPaid', {
      internalKey: INTERNAL_KEY,
      now,
      count: 3,
    })
  }, 60_000)

  test('a payer whose leg fails is recorded and skipped, never a head-of-line blocker', async () => {
    // The poisoned payer enumerates first: on an all-or-nothing loop it would
    // stop the reset before any healthy payer, and every re-run would stop at
    // the same place because its balance never clears.
    const now = Date.now()
    await seedUnpaidPayers({ count: 1, balanceMicroUsd: 3_000_000, now, ownerMembership: false })
    await seedUnpaidPayers({ count: 2, balanceMicroUsd: 2_000_000, now, startIndex: 1 })
    const reset = await authed('/v1/internal-admin/free-credits/reset', browserKey, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'RESET FREE CREDITS', reason: 'Poisoned payer' }),
    })
    expect(reset.status).toBe(500)
    expect(await reset.json()).toEqual({ error: 'admin_operation_failed' })
    // Only the poisoned payer still holds a balance.
    expect(
      await convex.query('testing/internalAdmin:countPositiveUnpaidPayers', {
        internalKey: INTERNAL_KEY,
      }),
    ).toBe(1)
    const audits = (await convex.query('testing/internalAdmin:auditEvents', {
      internalKey: INTERNAL_KEY,
    })) as Array<{ action: string; status: string; detail?: string }>
    const failedReset = audits.find(
      row => row.action === 'admin.credits.reset' && row.status === 'failed',
    )
    expect(failedReset?.detail).toMatch(/^removed=4000000 failed=1 /)
    await convex.mutation('testing/internalAdmin:markSeededPayersPaid', {
      internalKey: INTERNAL_KEY,
      now,
      count: 3,
    })
  }, 60_000)

  test('the reset action refuses a wrong confirmation as typed ConvexError data', async () => {
    // The API already rejects the phrase at its boundary, so this leg is the
    // action's own guard: a refusal thrown from an action must reach the client
    // with its code intact, exactly as one thrown from a query or mutation does.
    await expect(
      convex.action('domains/internalAdmin/actions:resetFreeCredits', {
        internalKey: INTERNAL_KEY,
        actorId: user._id,
        requestId: crypto.randomUUID(),
        reason: 'Typo in the phrase',
        now: Date.now(),
        confirmation: 'reset free credits',
      }),
    ).rejects.toMatchObject({ data: { error: 'confirmation_mismatch' } })
  })

  test('summarizes and resets every payer beyond one pagination page without a partial result', async () => {
    await seedUnpaidPayers({
      count: 260,
      balanceMicroUsd: 1_000_000,
      now: Date.now(),
    })
    const summary = await authed('/v1/internal-admin/free-credits', browserKey)
    expect(summary.status).toBe(200)
    expect(await summary.json()).toMatchObject({
      totalFreeCreditsMicroUsd: 260_000_000,
      unpaidUserCount: 260,
      usersWithBalanceCount: 260,
    })
    const reset = await authed('/v1/internal-admin/free-credits/reset', browserKey, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        confirmation: 'RESET FREE CREDITS',
        reason: 'Fixture pagination reset',
      }),
    })
    expect(reset.status).toBe(200)
    expect(
      await convex.query('testing/internalAdmin:countPositiveUnpaidPayers', {
        internalKey: INTERNAL_KEY,
      }),
    ).toBe(0)

    await seedUnpaidPayers({
      count: 741,
      balanceMicroUsd: 1_000_000,
      now: Date.now(),
    })
    const tooLarge = await authed('/v1/internal-admin/free-credits', browserKey)
    expect(tooLarge.status).toBe(409)
    expect(await tooLarge.json()).toEqual({ error: 'admin_dataset_too_large' })
  }, 60_000)

  test('the fleet update brake reads and flips the global control row', async () => {
    // No row yet (or a cleared one) means updates flow.
    const before = await authed('/v1/internal-admin/vm-updates', browserKey)
    expect(before.status).toBe(200)
    expect(await before.json()).toMatchObject({ paused: false })

    const pause = await authed('/v1/internal-admin/vm-updates', browserKey, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paused: true, reason: 'Bad release grounding' }),
    })
    expect(pause.status).toBe(200)
    expect(await pause.json()).toMatchObject({ ok: true })

    // The admin read and the sync path share one reader (readUpdatesControl)
    // and one writer (setUpdatesPausedImpl), so this also proves the row the
    // VM sync compose collapses to {paused: true}.
    const paused = await authed('/v1/internal-admin/vm-updates', browserKey)
    expect(paused.status).toBe(200)
    expect(await paused.json()).toMatchObject({ paused: true, reason: 'Bad release grounding' })

    const resume = await authed('/v1/internal-admin/vm-updates', browserKey, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paused: false, reason: 'Release fixed' }),
    })
    expect(resume.status).toBe(200)
    expect(await (await authed('/v1/internal-admin/vm-updates', browserKey)).json()).toMatchObject({
      paused: false,
    })
  })

  test('the fleet update brake refuses non-admin credentials', async () => {
    const key = await issueKey(client)
    const read = await authed('/v1/internal-admin/vm-updates', key.key)
    expect(read.status).toBe(403)
    const write = await authed('/v1/internal-admin/vm-updates', key.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paused: true, reason: 'nope' }),
    })
    expect(write.status).toBe(403)
  })

  test('fleet health reports version drift and the latest CPU sample per live VM', async () => {
    const now = Date.now()
    const busySlug = `fleet-busy-${now}`
    const freshSlug = `fleet-fresh-${now}`
    // A VM burning most of a core, with a stored sample...
    await convex.mutation('testing/internalAdmin:seedFleetVm', {
      internalKey: INTERNAL_KEY,
      slug: busySlug,
      vmName: `vm-${busySlug}`,
      runtimeVersion: 'gw-build-a',
      lastHeartbeatAt: now - 30_000,
      now,
      sample: {
        at: now - 5 * 60_000,
        cpuCores: 1.5,
        cpuNominalCores: 10,
        memUsedBytes: 3 * 1024 * 1024 * 1024,
        memTotalBytes: 8 * 1024 * 1024 * 1024,
      },
    })
    // ...and a VM on a different runtime build with no sample yet.
    await convex.mutation('testing/internalAdmin:seedFleetVm', {
      internalKey: INTERNAL_KEY,
      slug: freshSlug,
      vmName: `vm-${freshSlug}`,
      runtimeVersion: 'gw-build-b',
      lastHeartbeatAt: now - 30_000,
      now,
    })

    const response = await authed('/v1/internal-admin/fleet-health', browserKey)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      versions: { runtime: { label: string; count: number }[] }
      telemetry: { withSample: number; missing: number }
      vms: {
        slug: string
        cpuCores?: number
        cpuPct?: number
        runtimeVersion?: string
      }[]
    }

    // Two distinct runtime builds among live VMs is drift, not convergence.
    const runtimeBuilds = new Set(body.versions.runtime.map(entry => entry.label))
    expect(runtimeBuilds.has('gw-build-a')).toBe(true)
    expect(runtimeBuilds.has('gw-build-b')).toBe(true)

    const busy = body.vms.find(vm => vm.slug === busySlug)
    expect(busy?.cpuCores).toBe(1.5)
    // 1.5 of 10 nominal cores, through the shared cpuPctFromCores owner.
    expect(busy?.cpuPct).toBe(15)

    const fresh = body.vms.find(vm => vm.slug === freshSlug)
    expect(fresh?.runtimeVersion).toBe('gw-build-b')
    expect(fresh?.cpuCores).toBeUndefined()

    // The stored-sample VM counts as sampled; the fresh one as missing.
    expect(body.telemetry.withSample).toBeGreaterThanOrEqual(1)
    expect(body.telemetry.missing).toBeGreaterThanOrEqual(1)
  })

  test('inference margin reports folded cost against billed per period and audits the read', async () => {
    const now = Date.now()
    const model = `test/margin-${now}`
    await convex.mutation('testing/internalAdmin:seedSettledGeneration', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      userId: user._id,
      model,
      upstreamCostMicroUsd: 1_000_000,
      billedCostMicroUsd: 2_300_000,
      now,
    })
    await convex.mutation('domains/modelGateway/model:foldInferenceMargin', {
      internalKey: INTERNAL_KEY,
    })

    const response = await authed(
      '/v1/internal-admin/inference-margin?granularity=monthly',
      browserKey,
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      granularity: string
      window: { start: string; end: string }
      olderThrough: number
      periods: { period: string; billedCostMicroUsd: number }[]
      models: { model: string; upstreamCostMicroUsd: number; billedCostMicroUsd: number }[]
    }
    expect(body.granularity).toBe('monthly')
    expect(body.models.find(row => row.model === model)).toMatchObject({
      upstreamCostMicroUsd: 1_000_000,
      billedCostMicroUsd: 2_300_000,
    })
    expect(body.periods[0]?.period).toBe(new Date(now).toISOString().slice(0, 7))

    // Paging back reaches the window before this month's, which holds none of it.
    const older = await authed(
      `/v1/internal-admin/inference-margin?granularity=monthly&through=${body.olderThrough}`,
      browserKey,
    )
    const olderBody = (await older.json()) as {
      window: { end: string }
      models: { model: string }[]
    }
    expect(olderBody.window.end < body.window.start).toBe(true)
    expect(olderBody.models.some(row => row.model === model)).toBe(false)

    const events = (await convex.query('testing/internalAdmin:auditEvents', {
      internalKey: INTERNAL_KEY,
    })) as { action: string; target: string }[]
    expect(
      events.some(
        event => event.action === 'admin.inferenceMargin.read' && event.target === 'monthly',
      ),
    ).toBe(true)

    const invalid = await authed(
      '/v1/internal-admin/inference-margin?granularity=hourly',
      browserKey,
    )
    expect(invalid.status).toBe(400)
    const key = await issueKey(client)
    const denied = await authed('/v1/internal-admin/inference-margin?granularity=daily', key.key)
    expect(denied.status).toBe(403)
  })

  test('fleet health audits the read and refuses non-admin credentials', async () => {
    const ok = await authed('/v1/internal-admin/fleet-health', browserKey)
    expect(ok.status).toBe(200)
    const events = (await convex.query('testing/internalAdmin:auditEvents', {
      internalKey: INTERNAL_KEY,
    })) as { action: string; target: string }[]
    expect(events.some(event => event.action === 'admin.fleetHealth.read')).toBe(true)

    const key = await issueKey(client)
    const denied = await authed('/v1/internal-admin/fleet-health', key.key)
    expect(denied.status).toBe(403)
  })
})

function authed(path: string, key: string, init: RequestInit = {}) {
  return authedWith(app, path, key, init)
}

function authedWith(
  target: ReturnType<typeof createApiApp>,
  path: string,
  key: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${key}`)
  return target.request(path, { ...init, headers })
}
