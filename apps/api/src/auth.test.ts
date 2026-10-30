import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AdminLoginAsResponseSchema,
  AUTHENTICATED_API_RATE_LIMIT,
  BACKEND_SCHEMA_VERSION,
} from '@repo/contract'

import {
  INTERNAL_KEY,
  app,
  auditEvents,
  authed,
  authedWith,
  bootApiSuite,
  convex,
  countOccurrences,
  createApiApp,
  createIdentityWorkspace,
  deviceApprovalRequest,
  expectOneAudit,
  hashApiKey,
  issueKey,
  humanWorkspaceFixture,
  listMine,
  listUserKeys,
  mintBrowserSession,
  mutate,
  mutateDeviceApproval,
  nextSequence,
  oauthToken,
  owner,
  postJson,
  provisionRegisteredWorkspace,
  query,
  requestDeviceCode,
  resetApiSuiteBetweenTests,
  revokeKey,
  signInWithMagicLink,
  stopApiSuite,
  uniqueEmail,
  uniqueSlug,
  workspace,
} from './index-suite'
import type {
  DeviceCodeResponse,
  DeviceTokenResponse,
  FeedbackRow,
  RawApiKeyRow,
  UserRow,
} from './index-suite'

// Human identity, device login, managed credentials, and account access.
// One topic slice of the api v1 suite; each slice file boots its own
// deployment through the shared kit in index-suite.ts.
describe('api v1: auth and devices', () => {
  let ownerBrowserKey: string

  beforeAll(async () => {
    await bootApiSuite()
    ownerBrowserKey = await mintBrowserSession(owner.client)
  }, 240_000)
  afterAll(stopApiSuite)
  afterEach(resetApiSuiteBetweenTests)

  test('a recipient can discover and accept an invitation from their existing browser session', async () => {
    const recipient = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('incoming-invite'),
      'Recipient',
    )
    const key = await mintBrowserSession(recipient.client)
    const personal = (await listMine(recipient.client))[0]!.workspace
    const invite = (await mutate(owner.client, 'testing/invitations:createForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      email: recipient.user.email,
      role: 'viewer',
      token: 'b'.repeat(64),
      now: Date.now(),
    })) as { _id: string }
    const listed = await authed('/v1/user/invitations', key)
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({
      items: [
        expect.objectContaining({
          id: invite._id,
          workspace: { id: workspace._id, name: workspace.name, slug: workspace.slug },
          role: 'viewer',
        }),
      ],
      nextCursor: null,
    })
    expect(await (await authed('/v1/user/invitations', ownerBrowserKey)).json()).toEqual({
      items: [],
      nextCursor: null,
    })
    const accept = (token: string) =>
      authedWith(app, `/v1/user/invitations/${invite._id}/accept`, token, { method: 'POST' })
    expect((await accept(ownerBrowserKey)).status).toBe(404)
    const accepted = await accept(key)
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({
      workspaceId: workspace._id,
      workspaceSlug: workspace.slug,
    })
    expect((await accept(key)).status).toBe(200)
    expect(await (await authed('/v1/user/invitations', key)).json()).toEqual({
      items: [],
      nextCursor: null,
    })
    const identity = (await (await authed('/v1/whoami', key)).json()) as {
      workspaces: Array<{ id: string; role: string }>
    }
    expect(identity.workspaces.map(row => [row.id, row.role]).sort()).toEqual(
      [
        [personal._id, 'owner'],
        [workspace._id, 'viewer'],
      ].sort(),
    )
  })

  test('401/403 matrix and valid whoami payload', async () => {
    const readScope = `ws:${workspace.slug}:files:read`
    const readKey = await issueKey(owner.client)
    const outsider = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('auth-outsider'),
      'Outsider',
    )
    const outsiderKey = await issueKey(outsider.client)
    const expiredKey = await issueKey(owner.client, { expiresAt: Date.now() - 1 })
    const revokedKey = await issueKey(owner.client)
    await revokeKey(owner.client, revokedKey.prefix)

    expect((await app.request('/v1/whoami')).status).toBe(401)
    expect(
      (await app.request('/v1/whoami', { headers: { authorization: 'Token nope' } })).status,
    ).toBe(401)
    expect(
      (await app.request('/v1/whoami', { headers: { 'x-api-key': readKey.key } })).status,
    ).toBe(200)
    expect(
      (
        await app.request('/v1/whoami', {
          headers: {
            authorization: 'Bearer duet_sk_unknownunknownunknownunknown',
            'x-api-key': readKey.key,
          },
        })
      ).status,
    ).toBe(401)
    expect((await app.request(`/v1/whoami?apiKey=${readKey.key}`)).status).toBe(401)
    expect((await authed('/v1/whoami', 'duet_sk_unknownunknownunknownunknown')).status).toBe(401)
    expect((await authed('/v1/whoami', expiredKey.key)).status).toBe(401)
    expect((await authed('/v1/whoami', revokedKey.key)).status).toBe(401)
    expect((await authed('/v1/whoami', readKey.key.replace('duet_sk_', 'duet_bad_'))).status).toBe(
      401,
    )

    const insufficient = await authed(`/v1/ws/${workspace.slug}/files`, outsiderKey.key)
    expect(insufficient.status).toBe(403)
    expect(await insufficient.json()).toEqual({
      error: 'insufficient_scope',
      scope: readScope,
    })

    const whoami = await authed('/v1/whoami', readKey.key)
    expect(whoami.status).toBe(200)
    expect(await whoami.json()).toEqual({
      user: { id: owner.user._id, email: owner.user.email },
      workspaces: [
        {
          id: workspace._id,
          slug: workspace.slug,
          name: workspace.name,
          status: workspace.status,
          servicingStatus: 'active',
          onboardedAt: expect.any(Number),
          servicingStatusChangedAt: expect.any(Number),
          role: 'owner',
          billingUserId: workspace.billingUserId,
          duetName: 'Test User',
          // Reads the payer's entitlement, which for this fixture is the
          // owner's own synthetic Starter subscription.
          funding: { plan: 'starter', active: true },
          creditRecovery: null,
          defaultTier: { effective: 'balanced' },
        },
      ],
      scopes: expect.arrayContaining([readScope, `ws:${workspace.slug}:admin`]),
      versions: { api: 1 },
      internalAdmin: false,
      credential: { kind: 'user' },
    })
  })

  test('one grant-free device login authenticates the person in two current workspaces', async () => {
    const second = await createIdentityWorkspace(owner.client, 'identity-login')
    const requestedResponse = await postJson('/v1/device/code', { client_name: 'Duet CLI' })
    expect(requestedResponse.status).toBe(200)
    const requested = (await requestedResponse.json()) as DeviceCodeResponse
    const approval = await authedWith(app, '/v1/device/approve', ownerBrowserKey, {
      method: 'POST',
      body: JSON.stringify({ userCode: requested.user_code }),
    })
    expect(approval.status).toBe(200)
    expect(await approval.json()).toMatchObject({ status: 'approved', clientName: 'Duet CLI' })
    const tokenResponse = await postJson('/v1/device/token', { device_code: requested.device_code })
    const token = (await tokenResponse.json()) as {
      status: string
      access_token: string
      prefix: string
    }
    expect(tokenResponse.status).toBe(200)
    expect(token).not.toHaveProperty('scopes')
    expect(token).not.toHaveProperty('workspace')
    const whoami = await authed('/v1/whoami', token.access_token)
    const identity = (await whoami.json()) as {
      user: { id: string }
      workspaces: Array<{ slug: string }>
    }
    expect(identity.user.id).toBe(owner.user._id)
    expect(identity.workspaces.map(row => row.slug)).toContain(workspace.slug)
    expect(identity.workspaces.map(row => row.slug)).toContain(second.slug)
    expect((await authed('/v1/user/profile', token.access_token)).status).toBe(200)
    const issuedResponse = await authedWith(app, '/v1/user/api-keys', token.access_token, {
      method: 'POST',
      body: JSON.stringify({ name: 'Automation' }),
    })
    expect(issuedResponse.status).toBe(201)
    const issued = (await issuedResponse.json()) as {
      key: string
      record: { id: string; name: string }
    }
    expect(issued.record.name).toBe('Automation')
    expect(issued.record).not.toHaveProperty('scopes')
    const list = await authed('/v1/user/api-keys', token.access_token)
    expect(list.status).toBe(200)
    const page = (await list.json()) as { items: Array<{ id: string }> }
    expect(page.items.map(row => row.id)).toContain(issued.record.id)
    expect(
      (
        await authedWith(app, `/v1/user/api-keys/${issued.record.id}`, token.access_token, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(200)
    expect((await authed('/v1/whoami', issued.key)).status).toBe(401)

    expect(
      await (await postJson('/v1/device/token', { device_code: requested.device_code })).json(),
    ).toEqual({ status: 'consumed' })
  })

  test('device flow redirects to approval and issues a single-use human key', async () => {
    const requested = await requestDeviceCode()
    const verification = await app.request(new URL(requested.verification_uri).pathname)
    expect(verification.status).toBe(302)
    expect(verification.headers.get('location')).toBe('http://localhost:3000/device')
    await mutateDeviceApproval(owner.client, 'approve', requested.user_code)

    const tokenResponse = await postJson('/v1/device/token', {
      device_code: requested.device_code,
    })
    expect(tokenResponse.status).toBe(200)
    const tokenBody = (await tokenResponse.json()) as DeviceTokenResponse
    expect(tokenBody.status).toBe('approved')
    expect(tokenBody.access_token).toStartWith('duet_sk_')
    expect(tokenBody).not.toHaveProperty('scopes')
    expect(tokenBody).not.toHaveProperty('workspace')

    const whoami = await authed('/v1/whoami', tokenBody.access_token!)
    expect(whoami.status).toBe(200)

    const secondPoll = await postJson('/v1/device/token', { device_code: requested.device_code })
    expect(await secondPoll.json()).toEqual({ status: 'consumed' })
  })

  test('human device approval enforces expiry, replay, and audit', async () => {
    const humanKey = await issueKey(owner.client)
    const requested = await requestDeviceCode()
    const machineKey = (await convex.mutation('domains/apiKeys/mutations:mintVmModelKey', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      now: Date.now(),
    })) as { key: string }
    for (const action of ['inspect', 'approve', 'deny'] as const) {
      const refused = await deviceApprovalRequest(action, machineKey.key, requested.user_code)
      expect(refused.status).toBe(403)
      expect(await refused.json()).toEqual({ error: 'human_credential_required' })
    }
    const smuggled = await authedWith(app, '/v1/device/inspect', humanKey.key, {
      method: 'POST',
      body: JSON.stringify({ userCode: requested.user_code, operation: 'approve' }),
    })
    expect(smuggled.status).toBe(400)
    const inspected = await deviceApprovalRequest('inspect', humanKey.key, requested.user_code)
    expect(inspected.status).toBe(200)
    expect(await inspected.json()).toMatchObject({
      userCode: requested.user_code,
      status: 'pending',
      expiresAt: expect.any(Number),
    })
    const beforeApprovalAudit = await auditEvents()
    const approved = await deviceApprovalRequest('approve', humanKey.key, requested.user_code)
    expect(approved.status).toBe(200)
    expect(await approved.json()).toMatchObject({ status: 'approved' })
    const afterApprovalAudit = await auditEvents()
    expect(afterApprovalAudit.slice(beforeApprovalAudit.length)).toEqual([
      expect.objectContaining({ event: 'device_code.approved', actorId: owner.user._id }),
    ])
    const replay = await deviceApprovalRequest('approve', humanKey.key, requested.user_code)
    expect(replay.status).toBe(409)
    expect(await replay.json()).toEqual({ error: 'device_code_not_pending', status: 'approved' })
    expect(await auditEvents()).toHaveLength(afterApprovalAudit.length)
    const token = await postJson('/v1/device/token', { device_code: requested.device_code })
    expect((await token.json()).status).toBe('approved')
    expect(
      await (await postJson('/v1/device/token', { device_code: requested.device_code })).json(),
    ).toEqual({ status: 'consumed' })
    const deniedRequest = await requestDeviceCode()
    const beforeDenialAudit = await auditEvents()
    const denied = await deviceApprovalRequest('deny', humanKey.key, deniedRequest.user_code)
    expect(denied.status).toBe(200)
    expect(await denied.json()).toMatchObject({ status: 'denied' })
    expect((await auditEvents()).slice(beforeDenialAudit.length)).toEqual([
      expect.objectContaining({ event: 'device_code.denied', actorId: owner.user._id }),
    ])
    const denialReplay = await deviceApprovalRequest('deny', humanKey.key, deniedRequest.user_code)
    expect(denialReplay.status).toBe(409)
    expect(await denialReplay.json()).toEqual({
      error: 'device_code_not_pending',
      status: 'denied',
    })
    const expiredRequest = await requestDeviceCode()
    await mutate(convex, 'testing/apiKeys:expireDeviceCodeForTest', {
      internalKey: INTERNAL_KEY,
      deviceCode: expiredRequest.device_code,
      now: Date.now(),
    })
    const expired = await deviceApprovalRequest('inspect', humanKey.key, expiredRequest.user_code)
    expect(expired.status).toBe(200)
    expect(await expired.json()).toMatchObject({ status: 'expired' })
    const beforeExpiredAudit = await auditEvents()
    const expiredApproval = await deviceApprovalRequest(
      'approve',
      humanKey.key,
      expiredRequest.user_code,
    )
    expect(expiredApproval.status).toBe(410)
    expect(await expiredApproval.json()).toEqual({ error: 'device_code_expired' })
    expect(await auditEvents()).toHaveLength(beforeExpiredAudit.length)
    for (const action of ['approve', 'deny'] as const) {
      const terminal = await requestDeviceCode()
      expect((await deviceApprovalRequest(action, humanKey.key, terminal.user_code)).status).toBe(
        200,
      )
      await mutate(convex, 'testing/apiKeys:expireDeviceCodeForTest', {
        internalKey: INTERNAL_KEY,
        deviceCode: terminal.device_code,
        now: Date.now(),
      })
      expect(
        await (await deviceApprovalRequest('inspect', humanKey.key, terminal.user_code)).json(),
      ).toMatchObject({ status: 'expired' })
      expect(
        await (await postJson('/v1/device/token', { device_code: terminal.device_code })).json(),
      ).toEqual({ status: 'expired' })
    }
  }, 60_000)

  test('a members app key can manage invites but cannot call admin routes', async () => {
    const registered = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: workspace._id,
      path: `apps/inviter-${Date.now()}`,
      command: 'bun run start',
      apiScopes: ['members'],
      slug: `inviter-${Date.now()}`,
      now: Date.now(),
    })) as { id: string }
    const credential = (await convex.mutation('domains/apiKeys/mutations:mintAppKey', {
      internalKey: INTERNAL_KEY,
      appId: registered.id,
      now: Date.now(),
    })) as { key: string }
    const created = await authedWith(app, `/v1/ws/${workspace.slug}/invites`, credential.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: uniqueEmail('app-key-invite'), role: 'viewer' }),
    })
    expect(created.status).toBe(201)

    const admin = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/members/${owner.user._id}`,
      credential.key,
      { method: 'DELETE' },
    )
    expect(admin.status).toBe(403)
    expect(await admin.json()).toEqual({
      error: 'insufficient_scope',
      scope: `ws:${workspace.slug}:admin`,
    })
  })

  test('admin login-as requires its dedicated secret and mints an authenticating session', async () => {
    const secret = 'programmatic-login-secret'
    const now = Date.now()
    const loginApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      programmaticLoginSecret: secret,
      now: () => now,
    })

    const missingSecret = await loginApp.request('/v1/admin/login-as', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: owner.user.email }),
    })
    expect(missingSecret.status).toBe(401)
    expect(await missingSecret.json()).toEqual({ error: 'unauthorized' })

    const wrongSecret = await loginApp.request('/v1/admin/login-as', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ email: owner.user.email }),
    })
    expect(wrongSecret.status).toBe(401)
    expect(await wrongSecret.json()).toEqual({ error: 'unauthorized' })

    const emptySecretApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      programmaticLoginSecret: '',
    })
    const emptySecret = await emptySecretApp.request('/v1/admin/login-as', {
      method: 'POST',
      headers: { authorization: 'Bearer anything', 'content-type': 'application/json' },
      body: JSON.stringify({ email: owner.user.email }),
    })
    expect(emptySecret.status).toBe(401)
    expect(await emptySecret.json()).toEqual({ error: 'unauthorized' })

    const broaderPath = await loginApp.request('/v1/admin/login-as/extra', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email: owner.user.email }),
    })
    expect(broaderPath.status).toBe(401)

    const unknownEmail = await loginApp.request('/v1/admin/login-as', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email: uniqueEmail('missing-login-as') }),
    })
    expect(unknownEmail.status).toBe(404)
    expect(await unknownEmail.json()).toEqual({ error: 'not_found' })

    const response = await loginApp.request('/v1/admin/login-as', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        email: owner.user.email.toUpperCase(),
        workspaceSlug: workspace.slug,
        ttlSeconds: 100_000,
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain('duet_session=duet_sk_')
    expect(response.headers.get('set-cookie')).toContain('Max-Age=86400')
    // The response is the contract's shape, not a hand-mirrored one: any
    // caller (try.ts included) parses it through the shared schema.
    const body = AdminLoginAsResponseSchema.parse(await response.json())
    expect(body.token).toStartWith('duet_sk_')
    expect(body.expiresAt).toBe(now + 86_400_000)
    expect(body.userId).toBe(owner.user._id)
    expect(body.workspaceSlug).toBe(workspace.slug)

    const whoami = await authedWith(loginApp, '/v1/whoami', body.token)
    expect(whoami.status).toBe(200)
    expect(await whoami.json()).toMatchObject({
      user: { id: owner.user._id, email: owner.user.email },
      workspaces: [
        { id: workspace._id, slug: workspace.slug, name: workspace.name, role: 'owner' },
      ],
    })

    // `ephemeral` is an explicit option with route-owned error mapping: a
    // deletion moment already in the past is the caller's bug (400), and a
    // real, previously-created identity can never be made disposable by a
    // later caller (409) — deletion is not a retrofit.
    const pastExpiry = await loginApp.request('/v1/admin/login-as', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        email: uniqueEmail('ephemeral-login-past'),
        create: true,
        ephemeral: now - 1,
      }),
    })
    expect(pastExpiry.status).toBe(400)
    expect(await pastExpiry.json()).toEqual({ error: 'invalid_request' })

    const retrofit = await loginApp.request('/v1/admin/login-as', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email: owner.user.email, ephemeral: true }),
    })
    expect(retrofit.status).toBe(409)
    expect(await retrofit.json()).toEqual({ error: 'ephemeral_conflict' })
  })

  test('device code rejects syntactically valid scopes spanning multiple workspaces', async () => {
    const response = await postJson('/v1/device/code', {
      scopes: [`ws:${workspace.slug}:files:read`, 'ws:other-workspace:files:write'],
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_request' })
  })

  test('device polling pins pending, slow_down, denial, expiry, and unknown-code oracle resistance', async () => {
    const pending = await requestDeviceCode()
    const pendingPoll = await postJson('/v1/device/token', { device_code: pending.device_code })
    expect(await pendingPoll.json()).toEqual({ status: 'pending', interval: 5 })
    const fastPoll = await postJson('/v1/device/token', { device_code: pending.device_code })
    expect(await fastPoll.json()).toEqual({ status: 'slow_down', interval: 10 })

    const denied = await requestDeviceCode()
    await mutateDeviceApproval(owner.client, 'deny', denied.user_code)
    const deniedPoll = await postJson('/v1/device/token', { device_code: denied.device_code })
    expect(await deniedPoll.json()).toEqual({ status: 'denied' })

    const expired = await requestDeviceCode()
    await convex.mutation('testing/apiKeys:expireDeviceCodeForTest', {
      internalKey: INTERNAL_KEY,
      deviceCode: expired.device_code,
      now: Date.now(),
    })
    const expiredPoll = await postJson('/v1/device/token', { device_code: expired.device_code })
    expect(await expiredPoll.json()).toEqual({ status: 'expired' })

    const unknownPoll = await postJson('/v1/device/token', { device_code: 'f'.repeat(64) })
    expect(await unknownPoll.json()).toEqual({ status: 'pending', interval: 5 })
  })

  test('feedback accepts anonymous reports, validates shape, stores rows, and rate limits', async () => {
    let rateNow = 1_200_000
    const rateLimitedApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      now: () => rateNow,
      trustProxyHeaders: true,
    })
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.20' }

    const accepted = await rateLimitedApp.request('/v1/feedback', {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'gateway embeddings worked', source: 'duet-agent' }),
    })
    expect(accepted.status).toBe(202)
    expect(await accepted.json()).toEqual({})

    const malformed = await rateLimitedApp.request('/v1/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.21' },
      body: JSON.stringify({ content: '', source: 'duet-agent' }),
    })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: 'invalid_request' })

    const rows = (await convex.query('testing/feedback:listForTest', {
      internalKey: INTERNAL_KEY,
    })) as FeedbackRow[]
    expect(rows).toContainEqual(
      expect.objectContaining({
        content: 'gateway embeddings worked',
        source: 'duet-agent',
        createdAt: rateNow,
      }),
    )

    for (let i = 0; i < 19; i += 1) {
      const response = await rateLimitedApp.request('/v1/feedback', {
        method: 'POST',
        headers,
        body: JSON.stringify({ content: `feedback ${i}` }),
      })
      expect(response.status).toBe(202)
    }
    const limited = await rateLimitedApp.request('/v1/feedback', {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'too many' }),
    })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    expect(await limited.json()).toEqual({ error: 'rate_limited', retryAfterSeconds: 60 })

    rateNow += 60_000
    const nextWindow = await rateLimitedApp.request('/v1/feedback', {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'next window' }),
    })
    expect(nextWindow.status).toBe(202)
  })

  test('device denial audits the deciding person without a workspace grant', async () => {
    const person = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('device-denier'),
      'Device Denier',
    )
    const personal = (await listMine(person.client))[0]!.workspace
    const requested = await requestDeviceCode()
    const beforeOwner = await auditEvents()
    const beforePerson = await auditEvents(person.client, personal._id)
    expect(await mutateDeviceApproval(person.client, 'deny', requested.user_code)).toMatchObject({
      status: 'denied',
    })
    expect(await auditEvents()).toHaveLength(beforeOwner.length)
    expect((await auditEvents(person.client, personal._id)).slice(beforePerson.length)).toEqual([
      expect.objectContaining({ event: 'device_code.denied', actorId: person.user._id }),
    ])
    expect(
      await (await postJson('/v1/device/token', { device_code: requested.device_code })).json(),
    ).toEqual({ status: 'denied' })
  })

  test('a Starter member at capacity receives the structured workspace limit', async () => {
    const unpaid = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('api-unpaid'),
      'API Unpaid',
    )
    const key = await issueKey(unpaid.client)

    const response = await app.request('/v1/workspaces', {
      method: 'POST',
      headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ slug: uniqueSlug('api-unpaid-second'), name: 'Second Drive' }),
    })

    expect(response.status).toBe(402)
    expect(await response.json()).toEqual({
      error: 'workspace_limit_reached',
      plan: 'starter',
      limit: 1,
    })
    // The refusal is the whole answer: no half-born workspace is left behind for
    // the owner to find on the switcher.
    expect(await listMine(unpaid.client)).toHaveLength(1)
  }, 60_000)

  test('human keys follow current workspace identity after slug reuse and role demotion', async () => {
    const reusedSlug = uniqueSlug('reused-scope')
    const firstWorkspaceId = (await mutate(
      owner.client,
      'testing/workspaces:createWorkspaceForTest',
      {
        internalKey: INTERNAL_KEY,
        slug: reusedSlug,
        name: 'Old Scope Owner',
      },
    )) as string
    const oldKey = await issueKey(owner.client)
    await mutate(owner.client, 'domains/workspaces/mutations:deleteWorkspace', {
      workspaceId: firstWorkspaceId,
    })
    await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug: reusedSlug,
      name: 'New Scope Owner',
    })
    const reusedIdentity = await (await authed('/v1/whoami', oldKey.key)).json()
    const replacement = reusedIdentity.workspaces.find(
      (row: { slug: string }) => row.slug === reusedSlug,
    )
    expect(replacement).toMatchObject({ role: 'owner' })
    expect(replacement.id).not.toBe(firstWorkspaceId)
    expect(reusedIdentity.scopes).toContain(`ws:${reusedSlug}:admin`)

    const demotedSlug = uniqueSlug('demoted-scope')
    const demotedWorkspaceId = (await mutate(
      owner.client,
      'testing/workspaces:createWorkspaceForTest',
      {
        internalKey: INTERNAL_KEY,
        slug: demotedSlug,
        name: 'Demoted Scope Owner',
      },
    )) as string
    const adminKey = await issueKey(owner.client)
    const replacementPayer = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('demoted-scope-payer'),
      'Replacement Payer',
    )
    // Taking over the billing for a second drive is capacity a Starter payer
    // does not have — they already fund the one their signup created.
    await mutate(
      replacementPayer.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY, plan: 'pro' },
    )
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: demotedWorkspaceId,
      userId: replacementPayer.user._id,
      role: 'owner',
    })
    await mutate(owner.client, 'domains/workspaces/mutations:setBillingUser', {
      workspaceId: demotedWorkspaceId,
      newBillingUserId: replacementPayer.user._id,
    })
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: demotedWorkspaceId,
      userId: owner.user._id,
      role: 'viewer',
    })
    const demotedIdentity = await (await authed('/v1/whoami', adminKey.key)).json()
    expect(
      demotedIdentity.workspaces.find((row: { slug: string }) => row.slug === demotedSlug),
    ).toMatchObject({ id: demotedWorkspaceId, role: 'viewer' })
    expect(demotedIdentity.scopes).toContain(`ws:${demotedSlug}:files:read`)
    expect(demotedIdentity.scopes).not.toContain(`ws:${demotedSlug}:files:write`)
    expect(demotedIdentity.scopes).not.toContain(`ws:${demotedSlug}:admin`)
  })

  test('an impersonated visit is the same identity as a browser session, workspace for workspace', async () => {
    const second = await provisionRegisteredWorkspace(uniqueSlug('parity-second'))
    const impersonation = (await convex.mutation('domains/apiKeys/api:mintImpersonationKey', {
      internalKey: INTERNAL_KEY,
      email: owner.user.email,
      workspaceSlug: workspace.slug,
      ttlSeconds: 60,
      now: Date.now(),
    })) as { token: string }

    const viaSession = await (await authedWith(app, '/v1/whoami', ownerBrowserKey)).json()
    const viaVisit = await (await authedWith(app, '/v1/whoami', impersonation.token)).json()

    // Which credential you hold is reportable; what the product does with it is
    // not allowed to differ in any other field.
    expect(viaVisit).toEqual({ ...viaSession, credential: { kind: 'impersonation' } })
    // Guard against a vacuous pass: the visit names a single workspace, so a
    // payload that stopped at that one would still match an equally-truncated
    // browser session if the fixture only ever had one.
    expect(viaVisit.workspaces.map((row: { slug: string }) => row.slug)).toContain(second.slug)
  })

  test('parallel startup requests share one browser budget without surfacing counter contention', async () => {
    const rateNow = Math.floor(Date.now() / 60_000) * 60_000
    await convex.mutation('testing/apiKeys:setRateLimitForTest', {
      internalKey: INTERNAL_KEY,
      key: `api:user:${owner.user._id}`,
      windowStart: rateNow,
      count: 100,
      updatedAt: rateNow,
      // A browser session's budget is spread over counter documents, so both
      // the spend and the reading of it are stated in budgets. Naming the bare
      // key would seed one shard with a whole window's traffic — a state real
      // traffic cannot reach, whose refusal is the fixture's, not the rule's.
      limit: AUTHENTICATED_API_RATE_LIMIT,
    })
    const instances = Array.from({ length: 16 }, () =>
      createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY, now: () => rateNow }),
    )
    const responses = await Promise.all(
      instances.map(instance => authedWith(instance, '/v1/whoami', ownerBrowserKey)),
    )

    // Not one request lost to contention, and not one counted twice: 16
    // concurrent writers to a principal's window is the burst that used to
    // make every one of them an OCC retry the surrounding mutation lost.
    expect(responses.map(response => response.status)).toEqual(Array(16).fill(200))
    const bucket = await query(convex, 'testing/apiKeys:rateLimitForKeyForTest', {
      internalKey: INTERNAL_KEY,
      key: `api:user:${owner.user._id}`,
      limit: AUTHENTICATED_API_RATE_LIMIT,
    })
    expect(bucket).toMatchObject({ count: 116, windowStart: rateNow })
  })

  test('root serves an unauthenticated health response', async () => {
    const response = await app.request('https://api.example/')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, service: 'duet-api' })
  })

  test('deployment probe joins the API revision to the live backend schema', async () => {
    const revision = '0123456789abcdef0123456789abcdef01234567'
    const releaseApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      env: { VERCEL_GIT_COMMIT_SHA: revision },
      runtimeReleaseDir: join(tmpdir(), 'missing-deployment-probe-runtime-release'),
    })

    const response = await releaseApp.request('https://api.example/deployment')

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(await response.json()).toEqual({
      revision,
      backend: { revision: null, schema: BACKEND_SCHEMA_VERSION },
      runtime: { version: null },
    })
  })

  test('returns the standard authenticated API refusal and recovers in the next window', async () => {
    let rateNow = 1_200_000
    await convex.mutation('testing/apiKeys:setRateLimitForTest', {
      internalKey: INTERNAL_KEY,
      key: `api:user:${owner.user._id}`,
      windowStart: rateNow,
      count: AUTHENTICATED_API_RATE_LIMIT,
      updatedAt: rateNow,
      limit: AUTHENTICATED_API_RATE_LIMIT,
    })
    const rateLimitedApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      now: () => rateNow,
    })

    const limited = await authedWith(rateLimitedApp, '/v1/whoami', ownerBrowserKey)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    expect(await limited.json()).toEqual({ error: 'rate_limited', retryAfterSeconds: 60 })

    /* A refused request does not count. The window is already spent, so
       counting further changes no answer — and the client doing the counting is
       the one flooding, which is what made this row a write on every request
       and every request an OCC retry. The budget is the ceiling on what is
       WRITTEN, not just on what is served. */
    const afterRefusals = await query(convex, 'testing/apiKeys:rateLimitForKeyForTest', {
      internalKey: INTERNAL_KEY,
      key: `api:user:${owner.user._id}`,
      limit: AUTHENTICATED_API_RATE_LIMIT,
    })
    expect(afterRefusals).toMatchObject({
      count: AUTHENTICATED_API_RATE_LIMIT,
      windowStart: rateNow,
    })

    rateNow += 60_000
    const recovered = await authedWith(rateLimitedApp, '/v1/whoami', ownerBrowserKey)
    expect(recovered.status).toBe(200)

    // Neither neighbour shares this limiter: a spent API budget is not an
    // authentication verdict, and the preauth routes count on their own key.
    await convex.mutation('testing/apiKeys:setRateLimitForTest', {
      internalKey: INTERNAL_KEY,
      key: `api:user:${owner.user._id}`,
      windowStart: rateNow,
      count: AUTHENTICATED_API_RATE_LIMIT,
      updatedAt: rateNow,
      limit: AUTHENTICATED_API_RATE_LIMIT,
    })
    expect(
      (
        await rateLimitedApp.request('/v1/whoami', {
          headers: { authorization: 'Bearer duet_invalid' },
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await rateLimitedApp.request('/v1/feedback', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: 'preauth routes use their own limiter' }),
        })
      ).status,
    ).toBe(202)
    expect((await authedWith(rateLimitedApp, '/v1/whoami', ownerBrowserKey)).status).toBe(429)
  })

  test('runs the headless OAuth authorization, consent, exchange, refresh, and reuse-revocation flow', async () => {
    const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~'
    const challenge = Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    ).toString('base64url')
    const redirectUri = 'http://127.0.0.1:43191/callback?exact=1'
    const resource = 'https://mcp.duet.so/'
    const registeredResponse = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        client_name: 'Headless OAuth integration client',
      }),
    })
    expect(registeredResponse.status).toBe(201)
    const registered = (await registeredResponse.json()) as { client_id: string }

    const state = `headless-state-${nextSequence()}`
    const authorize = await app.request(
      `/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: registered.client_id,
        redirect_uri: redirectUri,
        scope: 'files:read memory',
        state,
        resource,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })}`,
    )
    const handoff = new URL(authorize.headers.get('location')!)
    expect(handoff.origin + handoff.pathname).toBe('http://localhost:3000/oauth/authorize')
    expect([...handoff.searchParams.keys()]).toEqual(['request'])
    const requestId = handoff.searchParams.get('request')!

    const inspection = await authed(
      `/v1/oauth/authorization/${encodeURIComponent(requestId)}`,
      ownerBrowserKey,
    )
    expect(inspection.status).toBe(200)
    expect(await inspection.json()).toMatchObject({
      status: 'pending',
      client: { id: registered.client_id, name: 'Headless OAuth integration client' },
      redirect: { hostname: '127.0.0.1', localhost: true },
      capabilities: ['files:read', 'memory'],
    })

    const approval = await authedWith(
      app,
      `/v1/oauth/authorization/${encodeURIComponent(requestId)}/approve`,
      ownerBrowserKey,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceSlug: workspace.slug }),
      },
    )
    expect(approval.status).toBe(200)
    const completion = new URL(((await approval.json()) as { redirectUrl: string }).redirectUrl)
    expect(completion.searchParams.get('state')).toBe(state)
    const code = completion.searchParams.get('code')!

    const wrongVerifier = await oauthToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: registered.client_id,
      code_verifier: `${verifier}wrong`,
      resource,
    })
    expect(wrongVerifier.error).toEqual({ error: 'invalid_grant' })
    const initial = await oauthToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: registered.client_id,
      code_verifier: verifier,
      resource,
    })
    expect(initial.response.status).toBe(200)
    if (initial.tokens === undefined) throw new Error('authorization-code exchange failed')
    expect(
      await authed('/v1/whoami', initial.tokens.access_token).then(r => r.json()),
    ).toMatchObject({ credential: { kind: 'oauth', audience: resource } })

    // Account settings require a human: a live OAuth credential is
    // rejected for its kind, not for being expired. Asserting it here — while
    // the token still authenticates — is what keeps 403 from being satisfied
    // by the 401 that family revocation produces later in this flow.
    expect((await authed('/v1/user/oauth-grants', initial.tokens.access_token)).status).toBe(403)

    expect(
      (
        await oauthToken({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: registered.client_id,
          code_verifier: verifier,
          resource,
        })
      ).error,
    ).toEqual({ error: 'invalid_grant' })

    const firstSuccessor = await oauthToken({
      grant_type: 'refresh_token',
      refresh_token: initial.tokens.refresh_token,
      client_id: registered.client_id,
      resource,
    })
    const graceReplacement = await oauthToken({
      grant_type: 'refresh_token',
      refresh_token: initial.tokens.refresh_token,
      client_id: registered.client_id,
      resource,
    })
    expect(firstSuccessor.response.status).toBe(200)
    expect(graceReplacement.response.status).toBe(200)
    if (firstSuccessor.tokens === undefined || graceReplacement.tokens === undefined) {
      throw new Error('refresh grace rotation failed')
    }
    expect((await authed('/v1/whoami', firstSuccessor.tokens.access_token)).status).toBe(401)

    const generationThree = await oauthToken({
      grant_type: 'refresh_token',
      refresh_token: graceReplacement.tokens.refresh_token,
      client_id: registered.client_id,
      resource,
    })
    expect(generationThree.response.status).toBe(200)
    if (generationThree.tokens === undefined) throw new Error('current refresh rotation failed')
    const ancestorReuse = await oauthToken({
      grant_type: 'refresh_token',
      refresh_token: initial.tokens.refresh_token,
      client_id: registered.client_id,
      resource,
    })
    expect(ancestorReuse.response.status).toBe(400)
    expect(ancestorReuse.error).toEqual({ error: 'invalid_grant' })
    expect((await authed('/v1/whoami', generationThree.tokens.access_token)).status).toBe(401)

    // Human account settings expose a secret-free grant projection.
    // Family access/refresh invalidation is
    // pinned in packages/backend/src/oauth.test.ts.
    const listed = await authed('/v1/user/oauth-grants', ownerBrowserKey)
    expect(listed.status).toBe(200)
    const listedText = await listed.text()
    expect(listedText).not.toContain(initial.tokens.access_token)
    expect(listedText).not.toContain(initial.tokens.refresh_token)
    expect(listedText).not.toMatch(/hashed|generation|family/i)
    const grant = (
      JSON.parse(listedText) as {
        items: Array<{
          id: string
          clientId: string
          clientName: string
          redirectHost: string
          workspace: { slug: string; name: string }
          scopes: string[]
          createdAt: number
          revokedAt?: number
        }>
      }
    ).items.find(candidate => candidate.clientId === registered.client_id)!
    expect(grant).toEqual({
      id: expect.any(String),
      clientId: registered.client_id,
      clientName: 'Headless OAuth integration client',
      // The grant persists the authorized redirect host (slice 12 fix),
      // truthful even for opaque DCR client ids.
      redirectHost: '127.0.0.1',
      workspace: { slug: workspace.slug, name: workspace.name },
      scopes: [`ws:${workspace.slug}:files:read`, `ws:${workspace.slug}:memory`],
      createdAt: expect.any(Number),
      revokedAt: expect.any(Number),
    })

    const other = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('oauth-settings-other'),
      'OAuth Settings Other',
    )
    const otherBrowserKey = await mintBrowserSession(other.client)
    const crossUser = await authedWith(
      app,
      `/v1/user/oauth-grants/${encodeURIComponent(grant.id)}`,
      otherBrowserKey,
      { method: 'DELETE' },
    )
    expect(crossUser.status).toBe(404)

    const firstRevoke = await authedWith(
      app,
      `/v1/user/oauth-grants/${encodeURIComponent(grant.id)}`,
      ownerBrowserKey,
      { method: 'DELETE' },
    )
    expect(firstRevoke.status).toBe(200)
    const firstRevoked = (await firstRevoke.json()) as { grantId: string; revokedAt: number }
    if (grant.revokedAt === undefined) throw new Error('ancestor reuse did not revoke the grant')
    expect(firstRevoked).toEqual({ grantId: grant.id, revokedAt: grant.revokedAt })
    const secondRevoke = await authedWith(
      app,
      `/v1/user/oauth-grants/${encodeURIComponent(grant.id)}`,
      ownerBrowserKey,
      { method: 'DELETE' },
    )
    expect(secondRevoke.status).toBe(200)
    expect(await secondRevoke.json()).toEqual(firstRevoked)
  }, 240_000)

  test('issuance returns the full key once and stores only its hash', async () => {
    const issue = await issueKey(owner.client)
    expect(countOccurrences(JSON.stringify(issue), issue.key)).toBe(1)

    const rows = (await convex.query('testing/apiKeys:rawApiKeysForTest', {
      internalKey: INTERNAL_KEY,
    })) as RawApiKeyRow[]
    const row = rows.find(candidate => candidate.prefix === issue.prefix)
    expect(row).toBeDefined()
    expect(row!.hashedKey).not.toBe(issue.key)
    expect(JSON.stringify(row)).not.toContain(issue.key)
  })

  test('retired ai workspace scopes remain invalid device requests', async () => {
    const response = await postJson('/v1/device/code', {
      scopes: [`ws:${workspace.slug}:ai`],
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_request' })
  })

  test('pre-auth device endpoints are fixed-window rate limited per client IP', async () => {
    let rateNow = 900_000
    const rateLimitedApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      now: () => rateNow,
      trustProxyHeaders: true,
    })
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10' }
    for (let i = 0; i < 20; i += 1) {
      const response = await rateLimitedApp.request('/v1/device/code', {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      })
      expect(response.status).toBe(200)
    }
    const limited = await rateLimitedApp.request('/v1/device/code', {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    expect(await limited.json()).toEqual({ error: 'rate_limited', retryAfterSeconds: 60 })
    const rawIp = '203.0.113.10'
    // The hashed plaintext is namespaced, so an address bucket and a network
    // bucket cannot collide however alike they read.
    const persistedKey = `preauth:device_code:${await hashApiKey(`net:${rawIp}`)}`
    const rateLimit = await query(convex, 'testing/apiKeys:rateLimitForKeyForTest', {
      internalKey: INTERNAL_KEY,
      key: persistedKey,
    })
    expect(rateLimit).not.toBeNull()
    expect(persistedKey).not.toContain(rawIp)

    rateNow += 60_000
    const nextWindow = await rateLimitedApp.request('/v1/device/code', {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    })
    expect(nextWindow.status).toBe(200)
    const secondNextWindow = await rateLimitedApp.request('/v1/device/code', {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    })
    expect(secondNextWindow.status).toBe(200)

    const untrustedHeadersApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      now: () => 1_000_000,
      trustProxyHeaders: false,
    })
    for (let i = 0; i < 20; i += 1) {
      const response = await untrustedHeadersApp.request('/v1/device/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${i}` },
        body: JSON.stringify({}),
      })
      expect(response.status).toBe(200)
    }
    const spoofed = await untrustedHeadersApp.request('/v1/device/code', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.250' },
      body: JSON.stringify({}),
    })
    expect(spoofed.status).toBe(429)
  }, 60_000)

  test('key and device mutations write exactly one audit event with the actor', async () => {
    await expectOneAudit('api_key.issued', () => issueKey(owner.client))
    const key = await issueKey(owner.client)
    await expectOneAudit('api_key.revoked', () => revokeKey(owner.client, key.prefix))

    const approved = await requestDeviceCode()
    await expectOneAudit('device_code.approved', () =>
      mutateDeviceApproval(owner.client, 'approve', approved.user_code),
    )

    const denied = await requestDeviceCode()
    await expectOneAudit('device_code.denied', () =>
      mutateDeviceApproval(owner.client, 'deny', denied.user_code),
    )
  })

  test('revocation still works after a member workspace is renamed', async () => {
    const originalSlug = uniqueSlug('rename-revoke')
    const renamedSlug = uniqueSlug('renamed-revoke')
    const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug: originalSlug,
      name: 'Rename Revoke',
    })) as string
    const key = await issueKey(owner.client)

    await mutate(owner.client, 'domains/workspaces/mutations:rename', {
      workspaceId,
      slug: renamedSlug,
    })

    await revokeKey(owner.client, key.prefix)
    const keys = await listUserKeys(owner.client)
    expect(keys.find(candidate => candidate.prefix === key.prefix)?.revokedAt).toBeNumber()
  })

  test('profile and ordinary keys belong to the human and reveal a secret once', async () => {
    const adminKey = await issueKey(owner.client)
    expect((await authed('/v1/user/profile', adminKey.key)).status).toBe(200)
    const updatedProfile = await authedWith(app, '/v1/user/profile', ownerBrowserKey, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ firstName: 'API', lastName: 'Owner' }),
    })
    expect(updatedProfile.status).toBe(200)
    expect(await updatedProfile.json()).toMatchObject({
      id: owner.user._id,
      firstName: 'API',
      lastName: 'Owner',
      name: 'API Owner',
    })

    const issued = await authedWith(app, '/v1/user/api-keys', ownerBrowserKey, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Local CLI',
      }),
    })
    expect(issued.status).toBe(201)
    const issuedBody = (await issued.json()) as {
      key: string
      record: { id: string; name?: string; prefix: string }
    }
    expect(issuedBody.key).toStartWith('duet_sk_')
    expect(issuedBody.record.name).toBe('Local CLI')
    expect(issuedBody.record).not.toHaveProperty('scopes')

    const listed = await authed('/v1/user/api-keys?limit=1', ownerBrowserKey)
    expect(listed.status).toBe(200)
    const listedText = await listed.text()
    expect(listedText).not.toContain(issuedBody.key)
    const listedBody = JSON.parse(listedText) as {
      items: Array<{ id: string; name?: string; prefix: string }>
      nextCursor: string
    }
    expect(listedBody.items.find(key => key.id === issuedBody.record.id)).toMatchObject({
      id: issuedBody.record.id,
      name: 'Local CLI',
      prefix: issuedBody.record.prefix,
    })
    const secondPage = (await (
      await authed(
        `/v1/user/api-keys?limit=1&cursor=${encodeURIComponent(listedBody.nextCursor)}`,
        ownerBrowserKey,
      )
    ).json()) as { items: Array<{ id: string }>; nextCursor: string | null }
    expect(secondPage.items).toHaveLength(1)
    expect(secondPage.items[0]?.id).not.toBe(issuedBody.record.id)
    expect((await authed('/v1/user/api-keys?unknown=1', ownerBrowserKey)).status).toBe(400)

    const revoked = await authedWith(
      app,
      `/v1/user/api-keys/${issuedBody.record.id}`,
      ownerBrowserKey,
      { method: 'DELETE' },
    )
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toMatchObject({ prefix: issuedBody.record.prefix })
  })

  test('whoami exposes oauth credential kind and audience without changing identity fields', async () => {
    const token = 'duet_sk_oauth_whoami_fixture'
    const prefix = token.slice(0, 'duet_sk_'.length + 8)
    const scope = `ws:${workspace.slug}:files:read`
    const audience = 'https://mcp.duet.so/'
    await mutate(convex, 'testing/apiKeys:insertOAuthApiKeyForTest', {
      internalKey: INTERNAL_KEY,
      userId: owner.user._id,
      workspaceId: workspace._id,
      hashedKey: await hashApiKey(token),
      prefix,
      scopes: [scope],
      audience,
      expiresAt: Date.now() + 60_000,
    })

    const response = await authed('/v1/whoami', token)
    expect(response.status).toBe(200)
    // The claim under test is the credential projection and untouched identity
    // fields — not the owner's full workspace inventory, which other tests in
    // this file legitimately grow. Identity is compared against a same-user
    // browser-session whoami rather than fixture state (which earlier tests
    // may drift); the exact workspace shape is pinned by the '401/403 matrix
    // and valid whoami payload' test.
    const body = (await response.json()) as {
      user: unknown
      workspaces: Array<{ id: string }>
      scopes: string[]
      versions: unknown
      internalAdmin: boolean
      credential: unknown
    }
    const baselineResponse = await authed('/v1/whoami', ownerBrowserKey)
    expect(baselineResponse.status).toBe(200)
    const baseline = (await baselineResponse.json()) as { user: unknown }
    expect(body.user).toEqual(baseline.user)
    expect(body.workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: workspace._id, slug: workspace.slug, role: 'owner' }),
      ]),
    )
    expect(body.scopes).toEqual([scope])
    expect(body.versions).toEqual({ api: 1 })
    expect(body.internalAdmin).toBe(false)
    expect(body.credential).toEqual({ kind: 'oauth', audience })
  })

  test('whoami derives internal-admin status from the fixed team domains', async () => {
    const team = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('api-team').replace(/@[^@]+$/, '@aomni.com'),
      'API Team',
    )
    const impersonation = (await convex.mutation('domains/apiKeys/api:mintImpersonationKey', {
      internalKey: INTERNAL_KEY,
      email: team.user.email,
      ttlSeconds: 60,
      now: Date.now(),
    })) as { token: string }

    const response = await authedWith(app, '/v1/whoami', impersonation.token)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      user: { email: team.user.email },
      internalAdmin: true,
    })
  })

  test('device approval rejects a workspace selector on every human decision', async () => {
    const requested = await requestDeviceCode()
    for (const action of ['inspect', 'approve', 'deny'] as const) {
      const response = await authedWith(app, `/v1/device/${action}`, ownerBrowserKey, {
        method: 'POST',
        body: JSON.stringify({ userCode: requested.user_code, workspaceSlug: workspace.slug }),
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_request' })
    }
    expect(
      await (await deviceApprovalRequest('inspect', ownerBrowserKey, requested.user_code)).json(),
    ).toMatchObject({ status: 'pending' })
  })

  test('workspace invite API creates, lists, and revokes an email-bound non-owner invite', async () => {
    const target = await createIdentityWorkspace(owner.client, 'invite-api')
    const key = await issueKey(owner.client)
    const viewerKey = await issueKey((await humanWorkspaceFixture(target.id, 'viewer')).client)
    const email = uniqueEmail('api-invite')
    const created = await authedWith(app, `/v1/ws/${target.slug}/invites`, key.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email.toUpperCase(), role: 'viewer' }),
    })
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as { id: string; email: string; role: string }
    expect(createdBody).toMatchObject({ email, role: 'viewer' })
    expect(createdBody).not.toHaveProperty('token')
    expect(createdBody).not.toHaveProperty('tokenHash')

    const duplicate = await authedWith(app, `/v1/ws/${target.slug}/invites`, key.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, role: 'editor' }),
    })
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toEqual({ error: 'invite_exists' })

    const ownerRole = await authedWith(app, `/v1/ws/${target.slug}/invites`, key.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: uniqueEmail('owner-role'), role: 'owner' }),
    })
    expect(ownerRole.status).toBe(400)

    const otherEmail = uniqueEmail('api-invite-page-two')
    expect(
      (
        await authedWith(app, `/v1/ws/${target.slug}/invites`, key.key, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: otherEmail, role: 'editor' }),
        })
      ).status,
    ).toBe(201)

    const listed = await authed(`/v1/ws/${target.slug}/invites?limit=1`, key.key)
    expect(listed.status).toBe(200)
    const listedBody = (await listed.json()) as {
      items: Array<Record<string, unknown>>
      nextCursor: string
    }
    const next = (await (
      await authed(
        `/v1/ws/${target.slug}/invites?limit=1&cursor=${encodeURIComponent(listedBody.nextCursor)}`,
        key.key,
      )
    ).json()) as { items: Array<Record<string, unknown>>; nextCursor: string | null }
    const inviteItems = [...listedBody.items, ...next.items]
    expect(inviteItems).toContainEqual(expect.objectContaining({ email, role: 'viewer' }))
    expect(inviteItems.find(invite => invite.email === email)).not.toHaveProperty('tokenHash')

    const revoked = await authedWith(
      app,
      `/v1/ws/${target.slug}/invites/${createdBody.id}`,
      key.key,
      { method: 'DELETE' },
    )
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toEqual({ revokedAt: expect.any(Number) })

    const blockedRemoval = await authedWith(
      app,
      `/v1/ws/${target.slug}/members/${owner.user._id}`,
      viewerKey.key,
      { method: 'DELETE' },
    )
    expect(blockedRemoval.status).toBe(403)
    expect(await blockedRemoval.json()).toEqual({
      error: 'insufficient_scope',
      scope: `ws:${target.slug}:admin`,
    })

    expect((await authed(`/v1/ws/${target.slug}/invites`, key.key)).status).toBe(200)
  })

  test('share requests serve the same person through impersonation and a human key', async () => {
    await mutate(owner.client, 'testing/workspaces:markWorkspaceLiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      now: Date.now(),
    })
    const created = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: workspace._id,
      toEmail: owner.user.email,
      path: 'control-plane/impersonated',
      mode: 'read',
    })) as { share: { id: string } }
    const impersonation = (await convex.mutation('domains/apiKeys/api:mintImpersonationKey', {
      internalKey: INTERNAL_KEY,
      email: owner.user.email,
      workspaceSlug: workspace.slug,
      ttlSeconds: 60,
      now: Date.now(),
    })) as { token: string }
    const programKey = await issueKey(owner.client)

    const visited = await authedWith(app, '/v1/share-requests', impersonation.token)
    expect(visited.status).toBe(200)
    expect((await visited.json()).items).toContainEqual(
      expect.objectContaining({ id: created.share.id }),
    )

    const program = await authedWith(app, '/v1/share-requests', programKey.key)
    expect(program.status).toBe(200)
    expect((await program.json()).items).toContainEqual(
      expect.objectContaining({ id: created.share.id }),
    )
  })
})
