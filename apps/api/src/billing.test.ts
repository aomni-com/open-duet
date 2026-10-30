import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

import { vmUsageDayWindow } from '@repo/contract'

import {
  BACKEND_DIR,
  BillingHistoryPageSchema,
  BillingHostedSessionResponseSchema,
  INTERNAL_KEY,
  SubscriptionPlanChangeResponseSchema,
  TEST_AUTH_CODE,
  UserBillingOverviewSchema,
  app,
  auditEvents,
  authed,
  authedWith,
  bootApiSuite,
  convex,
  convexDev,
  createApiApp,
  generateAuthKeys,
  issueKey,
  humanWorkspaceFixture,
  listMine,
  mintBrowserSession,
  mintHumanDeviceKey,
  mutate,
  owner,
  query,
  rawWorkspace,
  resetApiSuiteBetweenTests,
  signInWithMagicLink,
  stopApiSuite,
  uniqueEmail,
  uniqueSlug,
  workspace,
} from './index-suite'
import type { UserRow } from './index-suite'

// Billing routes, subscriptions, payer controls, workspace admin and telemetry.
// One topic slice of the api v1 suite; each slice file boots its own
// deployment through the shared kit in index-suite.ts.
describe('api v1: billing and workspace administration', () => {
  beforeAll(bootApiSuite, 240_000)
  afterAll(stopApiSuite)
  afterEach(resetApiSuiteBetweenTests)

  test('billing ledger lists workspace transactions newest-first without internal references', async () => {
    const readKey = await issueKey((await humanWorkspaceFixture(workspace._id, 'viewer')).client)
    const tieAt = Date.now() + 10_000
    const grant = (await convex.mutation('domains/credits/internal:applyLedgerEntry', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      amountMicroUsd: 5_000_000,
      type: 'grant',
      reference: 'grant:ledger-route-seed',
      now: tieAt,
    })) as { transactionId: string }
    const usage = (await convex.mutation('domains/credits/internal:applyLedgerEntry', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      amountMicroUsd: -250_000,
      type: 'usage',
      reference: 'usage:ledger-route-seed',
      userId: owner.user._id,
      now: tieAt,
    })) as { transactionId: string }

    const response = await authed(`/v1/ws/${workspace.slug}/billing/ledger?limit=1`, readKey.key)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      items: Array<Record<string, unknown>>
      nextCursor: string
    }
    expect(body.items).toHaveLength(1)
    const second = (await (
      await authed(
        `/v1/ws/${workspace.slug}/billing/ledger?limit=1&cursor=${encodeURIComponent(body.nextCursor)}`,
        readKey.key,
      )
    ).json()) as { items: Array<Record<string, unknown>>; nextCursor: string | null }
    const entries = [...body.items, ...second.items]
    const createdAts = entries.map(entry => entry.createdAt as number)
    expect(createdAts).toEqual([...createdAts].sort((a, b) => b - a))
    expect(entries.map(entry => entry.id)).toEqual(
      [grant.transactionId, usage.transactionId].sort().reverse(),
    )
    const history = (await convex.query('domains/credits/internal:getBillingHistory', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      paginationOpts: { cursor: null, numItems: 100 },
    })) as { page: Array<{ id: string; createdAt: number }> }
    expect(history.page.filter(item => item.createdAt === tieAt).map(item => item.id)).toEqual(
      [grant.transactionId, usage.transactionId].sort().reverse(),
    )
    const usageEntry = entries.find(entry => entry.amountMicroUsd === -250_000)!
    expect(usageEntry).toMatchObject({ type: 'usage', actorUserId: owner.user._id })
    expect(entries.some(entry => 'reference' in entry || 'metadata' in entry)).toBe(false)

    expect((await app.request(`/v1/ws/${workspace.slug}/billing/ledger`)).status).toBe(401)
    expect(
      (await authed(`/v1/ws/${workspace.slug}/billing/ledger?unknown=1`, readKey.key)).status,
    ).toBe(400)

    const malformedCursor = await authed(
      `/v1/ws/${workspace.slug}/billing/ledger?limit=1&cursor=${encodeURIComponent(`${body.nextCursor}tampered`)}`,
      readKey.key,
    )
    expect(malformedCursor.status).toBe(400)
    expect(await malformedCursor.json()).toEqual({ error: 'invalid_cursor' })

    const cursorPayload = JSON.parse(Buffer.from(body.nextCursor, 'base64url').toString()) as {
      position: { cursor: string }
    }
    cursorPayload.position.cursor = 'not-a-convex-cursor'
    const invalidProviderCursor = Buffer.from(JSON.stringify(cursorPayload)).toString('base64url')
    const structuredCursorErrorClient = new Proxy(owner.client, {
      get(target, property) {
        if (property !== 'query') {
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return async (...args: Parameters<typeof owner.client.query>) => {
          const queryArgs = args[1] as { paginationOpts?: { cursor?: string | null } }
          if (queryArgs.paginationOpts?.cursor === 'not-a-convex-cursor') {
            throw Object.assign(new Error('provider rejected continuation'), {
              data: { isConvexSystemError: true, paginationError: 'InvalidCursor' },
            })
          }
          return await Reflect.apply(owner.client.query, owner.client, args)
        }
      },
    })
    const providerErrorApp = createApiApp({
      convexUrl: convex.url,
      convexClient: structuredCursorErrorClient,
      internalKey: INTERNAL_KEY,
    })
    const invalidProvider = await authedWith(
      providerErrorApp,
      `/v1/ws/${workspace.slug}/billing/ledger?limit=1&cursor=${encodeURIComponent(invalidProviderCursor)}`,
      readKey.key,
    )
    expect(invalidProvider.status).toBe(400)
    expect(await invalidProvider.json()).toEqual({ error: 'invalid_cursor' })
  })

  test('billing usage stays workspace-readable while human payer controls retain payment requirements', async () => {
    const readKey = await issueKey((await humanWorkspaceFixture(workspace._id, 'viewer')).client)
    const adminKey = await issueKey(owner.client)

    const report = await authed(
      `/v1/ws/${workspace.slug}/billing/usage?period=monthly&group=workspace`,
      readKey.key,
    )
    expect(report.status).toBe(200)
    expect(await report.json()).toMatchObject({
      period: 'monthly',
      group: 'workspace',
      rows: expect.any(Array),
    })

    const deletedWorkspaceTopup = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/billing/topup`,
      adminKey.key,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autoTopupEnabled: true }),
      },
    )
    expect(deletedWorkspaceTopup.status).toBe(404)

    const denied = await authedWith(app, '/v1/user/billing', readKey.key, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceSlug: workspace.slug, autoTopupEnabled: true }),
    })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: 'payer_required' })

    const keyedPayer = await authedWith(app, '/v1/user/billing', adminKey.key, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceSlug: workspace.slug, autoTopupEnabled: true }),
    })
    expect(keyedPayer.status).toBe(409)
    expect(await keyedPayer.json()).toEqual({ error: 'payment_method_required' })

    const browserKey = await mintBrowserSession(owner.client)
    const methodRequired = await authedWith(app, '/v1/user/billing', browserKey, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceSlug: workspace.slug, autoTopupEnabled: true }),
    })
    expect(methodRequired.status).toBe(409)
    expect(await methodRequired.json()).toEqual({ error: 'payment_method_required' })

    const removedAcknowledgement = await authedWith(app, '/v1/user/billing', browserKey, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceSlug: workspace.slug,
        acknowledgeLowCreditWarningPeriodStart: Date.now(),
      }),
    })
    expect(removedAcknowledgement.status).toBe(400)

    const belowMinimumThreshold = await authedWith(app, '/v1/user/billing', browserKey, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceSlug: workspace.slug,
        autoTopupThresholdMicroUsd: 4_999_999,
      }),
    })
    expect(belowMinimumThreshold.status).toBe(400)

    const updated = await authedWith(app, '/v1/user/billing', browserKey, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceSlug: workspace.slug,
        autoTopupEnabled: false,
        autoTopupAmountMicroUsd: 20_000_000,
      }),
    })
    expect(updated.status).toBe(200)
    const updatedBody = (await updated.json()) as Record<string, unknown>
    expect(updatedBody).toMatchObject({
      autoTopupEnabled: false,
      autoTopupAmountMicroUsd: 20_000_000,
    })
    expect(updatedBody.hasPaymentMethod).toBe(false)
    expect(updatedBody).not.toHaveProperty('lowCreditWarning')
    expect(
      (updatedBody.workspaces as Array<{ slug: string }>).some(
        candidate => candidate.slug === workspace.slug,
      ),
    ).toBe(true)

    const clearedLimit = await authedWith(app, '/v1/user/billing', browserKey, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceSlug: workspace.slug, maxMonthlySpendMicroUsd: null }),
    })
    expect(clearedLimit.status).toBe(200)
    expect((await clearedLimit.json()).maxMonthlySpendMicroUsd).toBeUndefined()
  })

  test('browser settings enforce live-owner payer races and paginate audit through HTTP', async () => {
    const secondOwner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('api-settings-owner'),
      'Settings Owner',
    )
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      userId: secondOwner.user._id,
      role: 'viewer',
    })
    const ownerBrowserKey = await mintBrowserSession(owner.client)
    const members = await authed(`/v1/ws/${workspace.slug}/members?limit=1`, ownerBrowserKey)
    expect(members.status).toBe(200)
    const firstMembers = (await members.json()) as {
      items: Array<{ id: string; role: string }>
      nextCursor: string | null
      members?: unknown
    }
    expect(firstMembers.items).toEqual([
      expect.objectContaining({ id: owner.user._id, role: 'owner' }),
    ])
    expect(firstMembers).not.toHaveProperty('members')
    expect(firstMembers.nextCursor).toBeString()
    const secondMembers = await authed(
      `/v1/ws/${workspace.slug}/members?limit=1&cursor=${encodeURIComponent(firstMembers.nextCursor!)}`,
      ownerBrowserKey,
    )
    expect((await secondMembers.json()).items).toEqual([
      expect.objectContaining({ id: secondOwner.user._id, role: 'viewer' }),
    ])
    const searchedMembers = await authed(
      `/v1/ws/${workspace.slug}/members?limit=1&search=${encodeURIComponent(secondOwner.user.email.slice(0, 8))}`,
      ownerBrowserKey,
    )
    expect((await searchedMembers.json()).items).toEqual([
      expect.objectContaining({ id: secondOwner.user._id }),
    ])
    const reboundCursor = await authed(
      `/v1/ws/${workspace.slug}/members?limit=1&search=other&cursor=${encodeURIComponent(firstMembers.nextCursor!)}`,
      ownerBrowserKey,
    )
    expect(reboundCursor.status).toBe(400)
    expect(await reboundCursor.json()).toEqual({ error: 'invalid_cursor' })
    const overMaxMembers = await authed(
      `/v1/ws/${workspace.slug}/members?limit=101`,
      ownerBrowserKey,
    )
    expect(overMaxMembers.status).toBe(400)

    const viewerPayer = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/billing-user`,
      ownerBrowserKey,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: secondOwner.user._id }),
      },
    )
    expect(viewerPayer.status).toBe(422)
    expect(await viewerPayer.json()).toEqual({ error: 'owner_candidate_required' })

    const promoted = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/members/${secondOwner.user._id}`,
      ownerBrowserKey,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'owner' }),
      },
    )
    expect(promoted.status).toBe(200)
    expect(await promoted.json()).toMatchObject({ member: { role: 'owner' } })

    const reassigned = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/billing-user`,
      ownerBrowserKey,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: secondOwner.user._id }),
      },
    )
    expect(reassigned.status).toBe(200)

    const oldPayerOverviewResponse = await authedWith(app, '/v1/user/billing', ownerBrowserKey)
    expect(oldPayerOverviewResponse.status).toBe(200)
    const oldPayerOverview = UserBillingOverviewSchema.parse(await oldPayerOverviewResponse.json())
    expect(oldPayerOverview.workspaces.some(candidate => candidate.id === workspace._id)).toBe(
      false,
    )

    const oldPayerDenied = await authedWith(app, '/v1/user/billing', ownerBrowserKey, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceSlug: workspace.slug, autoTopupEnabled: false }),
    })
    expect(oldPayerDenied.status).toBe(403)
    expect(await oldPayerDenied.json()).toEqual({ error: 'payer_required' })

    const oldPayerPlanDenied = await authedWith(
      app,
      '/v1/user/billing/subscription/plan',
      ownerBrowserKey,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceSlug: workspace.slug, cancel: true }),
      },
    )
    expect(oldPayerPlanDenied.status).toBe(403)
    expect(await oldPayerPlanDenied.json()).toEqual({ error: 'payer_required' })

    const secondOwnerBrowserKey = await mintBrowserSession(secondOwner.client)
    const payerUpdated = await authedWith(app, '/v1/user/billing', secondOwnerBrowserKey, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceSlug: workspace.slug, autoTopupEnabled: false }),
    })
    expect(payerUpdated.status).toBe(200)
    const newPayerOverview = UserBillingOverviewSchema.parse(await payerUpdated.json())
    expect(newPayerOverview.workspaces).toContainEqual(
      expect.objectContaining({
        id: workspace._id,
        storage: expect.objectContaining({ plan: 'starter', usableGb: 20 }),
      }),
    )

    const firstAuditPage = await authed(`/v1/ws/${workspace.slug}/audit?limit=1`, ownerBrowserKey)
    expect(firstAuditPage.status).toBe(200)
    const firstAudit = (await firstAuditPage.json()) as {
      items: Array<{ id: string; event: string }>
      nextCursor: string | null
    }
    expect(firstAudit.items).toHaveLength(1)
    expect(firstAudit.items[0]?.event).toBe('billing.settings_updated')
    expect(firstAudit.nextCursor).toBeString()
    expect(firstAudit).not.toHaveProperty('events')
    expect(firstAudit).not.toHaveProperty('cursor')
    expect(firstAudit).not.toHaveProperty('done')
    const crossDomainAuditCursor = await authed(
      `/v1/ws/${workspace.slug}/audit?cursor=${encodeURIComponent(firstMembers.nextCursor!)}`,
      ownerBrowserKey,
    )
    expect(crossDomainAuditCursor.status).toBe(400)
    expect(await crossDomainAuditCursor.json()).toEqual({ error: 'invalid_cursor' })
    const secondAuditPage = await authed(
      `/v1/ws/${workspace.slug}/audit?limit=1&cursor=${encodeURIComponent(firstAudit.nextCursor!)}`,
      ownerBrowserKey,
    )
    expect(secondAuditPage.status).toBe(200)
    const secondAudit = (await secondAuditPage.json()) as {
      items: Array<{ id: string }>
    }
    expect(secondAudit.items).toHaveLength(1)
    expect(secondAudit.items[0]?.id).not.toBe(firstAudit.items[0]?.id)
    const recentAudit = await authed(`/v1/ws/${workspace.slug}/audit?limit=25`, ownerBrowserKey)
    const recentEvents = ((await recentAudit.json()) as { items: Array<{ event: string }> }).items
    expect(recentEvents.map(event => event.event)).toEqual(
      expect.arrayContaining(['billing.settings_updated', 'workspace.billing_user_changed']),
    )

    await authedWith(app, `/v1/ws/${workspace.slug}/billing-user`, ownerBrowserKey, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: owner.user._id }),
    })
    await authedWith(
      app,
      `/v1/ws/${workspace.slug}/members/${secondOwner.user._id}`,
      ownerBrowserKey,
      {
        method: 'DELETE',
      },
    )
  })

  test('a sessions-scoped app key can page the member directory for audience selection', async () => {
    const registered = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: workspace._id,
      path: `apps/session-audience-${Date.now()}`,
      command: 'bun run start',
      apiScopes: ['sessions'],
      slug: `session-audience-${Date.now()}`,
      now: Date.now(),
    })) as { id: string }
    const credential = (await convex.mutation('domains/apiKeys/mutations:mintAppKey', {
      internalKey: INTERNAL_KEY,
      appId: registered.id,
      now: Date.now(),
    })) as { key: string }

    const response = await authed(`/v1/ws/${workspace.slug}/members?limit=1`, credential.key)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      items: [expect.objectContaining({ id: owner.user._id })],
    })
  })

  test('workspace billing-user and member routes expose and enforce payer membership', async () => {
    const slug = uniqueSlug('billing-user-api')
    const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug,
      name: 'Billing User API',
    })) as string
    const payer = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('billing-payer'),
      'Billing Payer',
    )
    const removable = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('billing-removable'),
      'Billing Removable',
    )
    const outsider = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('billing-outsider'),
      'Billing Outsider',
    )
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: payer.user._id,
      role: 'editor',
    })
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: removable.user._id,
      role: 'viewer',
    })
    const adminKey = await issueKey(owner.client)
    const payerKey = await issueKey(payer.client)

    const missing = await authedWith(
      app,
      `/v1/ws/${uniqueSlug('missing')}/billing-user`,
      adminKey.key,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: payer.user._id }),
      },
    )
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'not_found' })

    const denied = await authedWith(app, `/v1/ws/${slug}/billing-user`, payerKey.key, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: payer.user._id }),
    })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({
      error: 'insufficient_scope',
      scope: `ws:${slug}:admin`,
    })

    const nonMember = await authedWith(app, `/v1/ws/${slug}/billing-user`, adminKey.key, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: outsider.user._id }),
    })
    expect(nonMember.status).toBe(422)
    expect(await nonMember.json()).toEqual({ error: 'owner_candidate_required' })

    const editorPayer = await authedWith(app, `/v1/ws/${slug}/billing-user`, adminKey.key, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: payer.user._id }),
    })
    expect(editorPayer.status).toBe(422)
    expect(await editorPayer.json()).toEqual({ error: 'owner_candidate_required' })

    const promoted = await authedWith(
      app,
      `/v1/ws/${slug}/members/${payer.user._id}`,
      adminKey.key,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'owner' }),
      },
    )
    expect(promoted.status).toBe(200)

    const reassigned = await authedWith(app, `/v1/ws/${slug}/billing-user`, adminKey.key, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: payer.user._id }),
    })
    expect(reassigned.status).toBe(200)
    expect(await reassigned.json()).toMatchObject({
      billingUserId: payer.user._id,
      member: { id: payer.user._id, role: 'owner', isBillingUser: true },
    })

    const whoami = await authed('/v1/whoami', adminKey.key)
    expect((await whoami.json()).workspaces).toContainEqual(
      expect.objectContaining({ id: workspaceId, billingUserId: payer.user._id }),
    )

    const members = await authed(`/v1/ws/${slug}/members`, adminKey.key)
    expect(members.status).toBe(200)
    expect(await members.json()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: owner.user._id, role: 'owner', isBillingUser: false }),
        expect.objectContaining({ id: payer.user._id, role: 'owner', isBillingUser: true }),
        expect.objectContaining({
          id: removable.user._id,
          role: 'viewer',
          isBillingUser: false,
        }),
      ]),
    })

    const payerRemoval = await authedWith(
      app,
      `/v1/ws/${slug}/members/${payer.user._id}`,
      adminKey.key,
      { method: 'DELETE' },
    )
    expect(payerRemoval.status).toBe(409)
    expect(await payerRemoval.json()).toEqual({ error: 'billing_user' })

    const removed = await authedWith(
      app,
      `/v1/ws/${slug}/members/${removable.user._id}`,
      adminKey.key,
      { method: 'DELETE' },
    )
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ removed: true })
    const afterRemoval = await authed(`/v1/ws/${slug}/members`, adminKey.key)
    expect((await afterRemoval.json()).items).not.toContainEqual(
      expect.objectContaining({ id: removable.user._id }),
    )
  })

  test('workspace billing-cap route sets, clears, and restricts workspace caps', async () => {
    const slug = uniqueSlug('billing-cap-api')
    const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug,
      name: 'Billing Cap API',
    })) as string
    const member = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('billing-cap-member'),
      'Billing Cap Member',
    )
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: member.user._id,
      role: 'viewer',
    })
    const adminKey = await issueKey(owner.client)
    const memberKey = await issueKey(member.client)

    const missing = await authedWith(
      app,
      `/v1/ws/${uniqueSlug('missing')}/billing-cap`,
      adminKey.key,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ monthlyCapMicroUsd: 3_000_000 }),
      },
    )
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'not_found' })

    const denied = await authedWith(app, `/v1/ws/${slug}/billing-cap`, memberKey.key, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ monthlyCapMicroUsd: 3_000_000 }),
    })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({
      error: 'insufficient_scope',
      scope: `ws:${slug}:admin`,
    })

    const set = await authedWith(app, `/v1/ws/${slug}/billing-cap`, adminKey.key, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ monthlyCapMicroUsd: 3_000_000 }),
    })
    expect(set.status).toBe(200)
    expect(await set.json()).toEqual({ monthlyCapMicroUsd: 3_000_000 })
    expect(await rawWorkspace(workspaceId)).toMatchObject({
      billing: { maxMonthlySpendMicroUsd: 3_000_000 },
    })

    const cleared = await authedWith(app, `/v1/ws/${slug}/billing-cap`, adminKey.key, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ monthlyCapMicroUsd: null }),
    })
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toEqual({ monthlyCapMicroUsd: null })
    expect((await rawWorkspace(workspaceId)).billing as Record<string, unknown>).not.toHaveProperty(
      'maxMonthlySpendMicroUsd',
    )
  })

  test('workspace default-model route accepts tiers and rejects the retired shape', async () => {
    const adminKey = await issueKey(owner.client)

    const set = await authedWith(app, `/v1/ws/${workspace.slug}/default-model`, adminKey.key, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tier: 'frontier' }),
    })
    expect(set.status).toBe(200)
    expect(await set.json()).toEqual({ tier: 'frontier' })

    const rejected = await authedWith(app, `/v1/ws/${workspace.slug}/default-model`, adminKey.key, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultModelId: 'recommended' }),
    })
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toEqual({ error: 'invalid_request' })
  })

  test('workspace rename route requires admin scope and explicit public URL break acknowledgement', async () => {
    const originalSlug = uniqueSlug('api-rename')
    const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug: originalSlug,
      name: 'API Rename',
    })) as string
    const viewerKey = await issueKey((await humanWorkspaceFixture(workspaceId, 'viewer')).client)
    const adminKey = await issueKey(owner.client)

    const denied = await authedWith(app, `/v1/workspaces/${originalSlug}`, viewerKey.key, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: uniqueSlug('api-renamed'), publicUrlBreakAcknowledged: true }),
    })
    expect(denied.status).toBe(403)

    const missingAck = await authedWith(app, `/v1/workspaces/${originalSlug}`, adminKey.key, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: uniqueSlug('api-renamed') }),
    })
    expect(missingAck.status).toBe(400)

    const renamedSlug = uniqueSlug('api-renamed')
    const renamed = await authedWith(app, `/v1/workspaces/${originalSlug}`, adminKey.key, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: renamedSlug, publicUrlBreakAcknowledged: true }),
    })
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toEqual({ ok: true, breaksPublicUrls: true })
    const audit = (await query(owner.client, 'domains/workspaces/queries:getAuditEvents', {
      workspaceId,
    })) as Array<{ event: string; provenance?: unknown }>
    expect(audit.at(-1)).toMatchObject({
      event: 'workspace.renamed',
      provenance: { breaksPublicUrls: true, acknowledged: true },
    })
  })

  test('workspace suspension route requires admin scope and audits takedowns', async () => {
    const viewerKey = await issueKey((await humanWorkspaceFixture(workspace._id, 'viewer')).client)
    const adminKey = await issueKey(owner.client)

    const denied = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/admin/suspension`,
      viewerKey.key,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ suspended: true, reason: 'phishing report' }),
      },
    )
    expect(denied.status).toBe(403)

    const before = await auditEvents()
    const suspended = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/admin/suspension`,
      adminKey.key,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ suspended: true, reason: 'phishing report' }),
      },
    )
    expect(suspended.status).toBe(200)
    expect(await suspended.json()).toMatchObject({
      suspended: true,
      suspendedAt: expect.any(Number),
      suspensionReason: 'phishing report',
    })

    const suspensionState = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/admin/suspension`,
      adminKey.key,
    )
    expect(suspensionState.status).toBe(200)
    expect(await suspensionState.json()).toMatchObject({
      suspended: true,
      suspendedAt: expect.any(Number),
      suspensionReason: 'phishing report',
    })
    const afterSuspend = await auditEvents()
    expect(afterSuspend).toHaveLength(before.length + 1)
    expect(afterSuspend.at(-1)).toMatchObject({
      event: 'workspace.suspended',
      actorId: owner.user._id,
    })

    const unsuspended = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/admin/suspension`,
      adminKey.key,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ suspended: false, reason: 'review cleared' }),
      },
    )
    expect(unsuspended.status).toBe(200)
    expect(await unsuspended.json()).toEqual({ suspended: false })
    expect((await auditEvents()).at(-1)).toMatchObject({
      event: 'workspace.unsuspended',
      actorId: owner.user._id,
    })
  })

  test('SUBS-IMPL-08/SUBS-IMPL-FIX1 subscription routes enforce payer ownership, idempotency, conflicts, schemas, and overview totals', async () => {
    const browserKey = await mintBrowserSession(owner.client)
    expect((await app.request('/v1/user/billing/subscription/checkout')).status).toBe(401)
    // A user key is on the payer rail now (decision 3), so it meets the same
    // payer-bound refusal the tab does rather than a credential-kind 403.
    const apiKey = await issueKey(owner.client)
    const keyedCheckout = await authedWith(
      app,
      '/v1/user/billing/subscription/checkout',
      apiKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceSlug: workspace.slug, plan: 'starter' }),
      },
    )
    expect(keyedCheckout.status).toBe(409)
    expect(await keyedCheckout.json()).toEqual({ error: 'subscription_exists' })

    const invalidPlan = await authedWith(
      app,
      '/v1/user/billing/subscription/checkout',
      browserKey,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceSlug: workspace.slug, plan: 'enterprise' }),
      },
    )
    expect(invalidPlan.status).toBe(400)

    const secondSubscription = await authedWith(
      app,
      '/v1/user/billing/subscription/checkout',
      browserKey,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceSlug: workspace.slug, plan: 'pro' }),
      },
    )
    expect(secondSubscription.status).toBe(409)
    expect(await secondSubscription.json()).toEqual({ error: 'subscription_exists' })

    const nothingToResume = await authedWith(
      app,
      '/v1/user/billing/subscription/plan',
      browserKey,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceSlug: workspace.slug, resume: true }),
      },
    )
    expect(nothingToResume.status).toBe(409)
    expect(await nothingToResume.json()).toEqual({ error: 'subscription_not_canceling' })
    await mutate(
      owner.client,
      'testing/workspaces:setCurrentUserSubscriptionCancelAtPeriodEndForTest',
      { internalKey: INTERNAL_KEY, cancelAtPeriodEnd: true },
    )
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const resumed = await authedWith(app, '/v1/user/billing/subscription/plan', browserKey, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceSlug: workspace.slug, resume: true }),
      })
      expect(resumed.status).toBe(200)
      expect(SubscriptionPlanChangeResponseSchema.parse(await resumed.json())).toEqual({
        ok: true,
      })
    }

    const checkoutUser = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('subscription-checkout'),
      'Subscription Checkout',
    )
    await mutate(checkoutUser.client, 'testing/workspaces:activateCurrentUserTrialForTest', {
      internalKey: INTERNAL_KEY,
      now: Date.now(),
    })
    const checkoutWorkspace = (await listMine(checkoutUser.client))[0]!.workspace
    const checkoutBrowserKey = await mintBrowserSession(checkoutUser.client)
    const missingSubscription = await authedWith(
      app,
      '/v1/user/billing/subscription/plan',
      checkoutBrowserKey,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceSlug: checkoutWorkspace.slug, cancel: true }),
      },
    )
    expect(missingSubscription.status).toBe(409)
    expect(await missingSubscription.json()).toEqual({ error: 'subscription_not_found' })

    const checkout = await authedWith(
      app,
      '/v1/user/billing/subscription/checkout',
      checkoutBrowserKey,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceSlug: checkoutWorkspace.slug, plan: 'starter' }),
      },
    )
    expect(checkout.status).toBe(200)
    const checkoutBody = BillingHostedSessionResponseSchema.parse(await checkout.json())
    expect(checkoutBody.url).toStartWith('https://checkout.stripe.test/')
    const differentPlanCheckout = await authedWith(
      app,
      '/v1/user/billing/subscription/checkout',
      checkoutBrowserKey,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceSlug: checkoutWorkspace.slug, plan: 'pro' }),
      },
    )
    const differentPlanCheckoutBody = BillingHostedSessionResponseSchema.parse(
      await differentPlanCheckout.json(),
    )
    expect(differentPlanCheckoutBody.url).not.toBe(checkoutBody.url)
    const checkoutRetry = await authedWith(
      app,
      '/v1/user/billing/subscription/checkout',
      checkoutBrowserKey,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceSlug: checkoutWorkspace.slug, plan: 'pro' }),
      },
    )
    expect(BillingHostedSessionResponseSchema.parse(await checkoutRetry.json())).toEqual(
      differentPlanCheckoutBody,
    )

    for (const change of [{ plan: 'pro' }, { plan: 'pro' }, { cancel: true }] as const) {
      const response = await authedWith(app, '/v1/user/billing/subscription/plan', browserKey, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceSlug: workspace.slug, ...change }),
      })
      expect(response.status).toBe(200)
      expect(SubscriptionPlanChangeResponseSchema.parse(await response.json())).toEqual({
        ok: true,
      })
    }

    const overviewResponse = await authed('/v1/user/billing', browserKey)
    expect(overviewResponse.status).toBe(200)
    const overview = UserBillingOverviewSchema.parse(await overviewResponse.json())
    expect(overview.balanceMicroUsd).toBe(
      overview.paidCreditBalanceMicroUsd + overview.monthlyCreditBalanceMicroUsd,
    )
    expect(overview.subscription).toMatchObject({ plan: 'starter', isActive: true })
    expect(overview.trial.status).toBe('ended')
    const overviewWorkspace = overview.workspaces.find(candidate => candidate.id === workspace._id)
    expect(overviewWorkspace?.storage).toEqual({
      usableGb: 20,
      plan: 'starter',
      nextPlan: 'pro',
      nextUsableGb: 50,
    })

    const historyResponse = await authed('/v1/user/billing/history', browserKey)
    expect(historyResponse.status).toBe(200)
    const history = BillingHistoryPageSchema.parse(await historyResponse.json())
    expect(history.items.some(item => item.scope === 'account')).toBe(true)
    expect(
      history.items.some(item => 'reference' in item || 'metadata' in item || 'stripeId' in item),
    ).toBe(false)
    const firstHistoryPage = BillingHistoryPageSchema.parse(
      await (await authed('/v1/user/billing/history?limit=1', browserKey)).json(),
    )
    expect(firstHistoryPage.items).toHaveLength(1)
    expect(firstHistoryPage.nextCursor).toBeString()
    const secondHistoryPage = BillingHistoryPageSchema.parse(
      await (
        await authed(
          `/v1/user/billing/history?limit=1&cursor=${encodeURIComponent(firstHistoryPage.nextCursor!)}`,
          browserKey,
        )
      ).json(),
    )
    expect(secondHistoryPage.items[0]?.id).not.toBe(firstHistoryPage.items[0]?.id)
    expect((await authed('/v1/user/billing/history?unknown=1', browserKey)).status).toBe(400)
  })

  test('billing history names a VM compute fee and still hides the rest of the metadata', async () => {
    const browserKey = await mintBrowserSession(owner.client)
    const dayKey = '2026-08-01'
    const day = vmUsageDayWindow(dayKey)
    const tick = 10 * 60 * 1000

    /* A pegged VM held for seven hours: forty-two ticks plus the point that
       opens them, since each point owns the interval behind it.

       Both numbers are load-bearing. The tick stays under
       `VM_USAGE_MAX_POINT_GAP_MS`, or every interval is discarded as an outage
       and the day measures nothing at all. The seven hours are what clear
       `VM_USAGE_MIN_CHARGEABLE_MICRO_USD`: 28 core-hours and 56 GiB-hours come
       to $0.1176, where the single hour of one core and one GiB this used to
       hold came to $0.0036 and stopped at `below_charge_floor` — a day too
       small to be worth a ledger row, and so too small to leave a fee for the
       history to name. */
    await convex.mutation('testing/vmTelemetry:recordVmSamplesForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      points: Array.from({ length: 43 }, (_, index) => ({
        at: day.startAt + index * tick,
        cpuCores: 4,
        cpuNominalCores: 4,
        memUsedGb: 8,
        memTotalGb: 8,
      })),
    })
    expect(
      await convex.mutation('testing/vmTelemetry:chargeVmComputeDayForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: workspace._id,
        dayKey,
        now: day.endAt + tick,
      }),
    ).toMatchObject({ status: 'applied' })

    await convex.mutation('domains/credits/internal:applyLedgerEntry', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      amountMicroUsd: -250_000,
      type: 'usage',
      reference: 'usage:model-spend-history-seed',
      userId: owner.user._id,
    })

    const response = await authed('/v1/user/billing/history', browserKey)
    expect(response.status).toBe(200)
    const history = BillingHistoryPageSchema.parse(await response.json())
    const usage = history.items.filter(item => item.type === 'usage')
    expect(usage.filter(item => item.usageKind === 'vm_compute')).toHaveLength(1)
    // Model spend carries no kind, which is what makes the fee distinguishable.
    expect(usage.some(item => item.usageKind === undefined)).toBe(true)
    expect(
      history.items.some(item => 'reference' in item || 'metadata' in item || 'stripeId' in item),
    ).toBe(false)
  })

  test('workspace telemetry history is member-readable and range-filtered', async () => {
    const readKey = await issueKey((await humanWorkspaceFixture(workspace._id, 'viewer')).client)
    const now = Date.now()
    await convex.mutation('testing/vmTelemetry:seedTelemetrySamplesForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      /* Stored columns are the provider's units; the chart's percent-and-MB wire
         shape is derived on read and is what this route asserts. Ratios are
         chosen to divide exactly so the assertion is not a float comparison. */
      samples: [
        { at: now - 10_000, cpuCores: 1, cpuNominalCores: 8 },
        {
          at: now - 1_000,
          cpuCores: 1,
          cpuNominalCores: 4,
          memUsedBytes: 512 * 1024 * 1024,
          memTotalBytes: 1024 * 1024 * 1024,
          fsUsedGb: 2,
          fsTotalGb: 4,
        },
      ],
    })

    const response = await authed(
      `/v1/ws/${workspace.slug}/telemetry?sinceAt=${now - 5_000}`,
      readKey.key,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      samples: [
        {
          at: now - 1_000,
          cpuPct: 25,
          memUsedMb: 512,
          memTotalMb: 1024,
          diskUsedMb: 2048,
          diskTotalMb: 4096,
        },
      ],
    })
  })

  test('human keys and device login share the payer account boundary', async () => {
    const agentKey = await issueKey(owner.client)
    const secondSlug = uniqueSlug('payer-rail-second')
    await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug: secondSlug,
      name: 'Payer Rail Second',
    })

    const overview = await authed('/v1/user/billing', agentKey.key)
    expect(overview.status).toBe(200)
    // Account reads include every workspace funded by this person.
    expect(
      UserBillingOverviewSchema.parse(await overview.json())
        .workspaces.map(funded => funded.slug)
        .sort(),
    ).toEqual([workspace.slug, secondSlug].sort())

    // A plan change is admitted, and it really lands: the key resumes a
    // subscription this test scheduled for cancellation a moment earlier.
    await mutate(
      owner.client,
      'testing/workspaces:setCurrentUserSubscriptionCancelAtPeriodEndForTest',
      { internalKey: INTERNAL_KEY, cancelAtPeriodEnd: true },
    )
    const resumed = await authedWith(app, '/v1/user/billing/subscription/plan', agentKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceSlug: workspace.slug, resume: true }),
    })
    expect(resumed.status).toBe(200)
    expect(SubscriptionPlanChangeResponseSchema.parse(await resumed.json())).toEqual({ ok: true })

    const accountOperations: [string, RequestInit][] = [
      ['/v1/user/billing/history', {}],
      [
        '/v1/user/billing',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceSlug: workspace.slug, autoTopupEnabled: false }),
        },
      ],
      [
        '/v1/user/billing/checkout',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceSlug: workspace.slug }),
        },
      ],
      [
        '/v1/user/billing/portal',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceSlug: workspace.slug }),
        },
      ],
    ]
    const deviceKey = await mintHumanDeviceKey('Duet CLI')
    for (const bearer of [agentKey.key, deviceKey]) {
      const deviceOverview = await authed('/v1/user/billing', bearer)
      expect(deviceOverview.status).toBe(200)
      expect(
        UserBillingOverviewSchema.parse(await deviceOverview.json())
          .workspaces.map(row => row.slug)
          .sort(),
      ).toEqual([workspace.slug, secondSlug].sort())
      for (const [path, init] of accountOperations) {
        const response = await authedWith(app, path, bearer, init)
        const hosted = path.endsWith('/checkout') || path.endsWith('/portal')
        expect([path, response.status]).toEqual([path, hosted ? 503 : 200])
        const body = await response.json()
        if (path.endsWith('/history')) {
          expect(BillingHistoryPageSchema.parse(body).items.map(row => row.type)).toContain(
            'subscription_grant',
          )
        } else if (init.method === 'PUT') {
          expect(UserBillingOverviewSchema.parse(body).autoTopupEnabled).toBe(false)
        } else {
          // This local fixture has no live Stripe secret; admission reaches the
          // configured-service refusal without making a provider request.
          expect(body).toEqual({ error: 'billing_not_configured' })
        }
      }
    }
  })

  /* Correct, and worth pinning rather than fixing: relaxing the credential
     does not relax the payer check underneath it. */
  test('a keyed agent acting for a non-payer member cannot start a subscription', async () => {
    const memberSlug = uniqueSlug('payer-rail-member')
    const memberWorkspaceId = (await mutate(
      owner.client,
      'testing/workspaces:createWorkspaceForTest',
      { internalKey: INTERNAL_KEY, slug: memberSlug, name: 'Payer Rail Member' },
    )) as string
    const member = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('payer-rail-member'),
      'Payer Rail Member',
    )
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: memberWorkspaceId,
      userId: member.user._id,
      role: 'editor',
    })
    const memberKey = await issueKey(member.client)

    const refused = await authedWith(app, '/v1/user/billing/subscription/checkout', memberKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceSlug: memberSlug, plan: 'pro' }),
    })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: 'payer_required' })
  })

  test('SUBS-IMPL-FIX2 half-configured Stripe returns 503 without a fake checkout URL', async () => {
    const halfConfigured = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_APP_URL: 'http://localhost:3000',
        STRIPE_STARTER_RECURRING_PRICE_ID: 'price_half_starter',
        STRIPE_PRO_RECURRING_PRICE_ID: 'price_half_pro',
        STRIPE_MAX_RECURRING_PRICE_ID: 'price_half_max',
      },
      reset: true,
    })
    try {
      const halfConfiguredApp = createApiApp({
        convexUrl: halfConfigured.url,
        internalKey: INTERNAL_KEY,
        appUrl: 'http://localhost:3000',
      })
      const payer = await signInWithMagicLink<UserRow>(
        halfConfigured,
        uniqueEmail('half-configured-stripe'),
        'Half Configured Stripe',
      )
      const payerWorkspace = (await listMine(payer.client))[0]!.workspace
      const browserKey = await mintBrowserSession(payer.client)
      const response = await authedWith(
        halfConfiguredApp,
        '/v1/user/billing/subscription/checkout',
        browserKey,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceSlug: payerWorkspace.slug, plan: 'starter' }),
        },
      )

      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'billing_not_configured' })
    } finally {
      await halfConfigured.stop()
    }
  }, 240_000)
})
