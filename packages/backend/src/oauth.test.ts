import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ConvexHttpClient } from 'convex/browser'

import { MAX_OAUTH_AUTHORIZATION_STATE_UTF8_BYTES, hashApiKey } from '@repo/contract'
import {
  convexDev,
  generateAuthKeys,
  mutate,
  query,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

import {
  ACCESS_TOKEN_TTL_MS,
  AUTHORIZATION_CODE_TTL_MS,
  AUTHORIZATION_REQUEST_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
} from '../convex/domains/oauth/api'
import { REFRESH_GRACE_MS } from '../convex/domains/oauth/refresh'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'test-api-internal-key'
const CLIENT_ID = 'device-auth-oauth-test-client'
const REDIRECT_URI = 'http://127.0.0.1:43191/callback'
const RESOURCE = 'https://mcp.duet.so/'
const VERIFIER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~'
const NOW = 10_000_000

let convex: ConvexDevFixture
let owner: SignedInUser
let workspace: Workspace

describe('OAuth grant and refresh kernel', () => {
  test('refuses oversized authorization state before durable request storage', async () => {
    await expect(
      mutatePublic('domains/oauth/api:createAuthorizationRequest', {
        internalKey: INTERNAL_KEY,
        clientId: CLIENT_ID,
        clientName: 'OAuth kernel fixture',
        redirectUri: REDIRECT_URI,
        state: 's'.repeat(MAX_OAUTH_AUTHORIZATION_STATE_UTF8_BYTES + 1),
        capabilities: ['files:read'],
        resource: RESOURCE,
        codeChallenge: await s256(VERIFIER),
        now: NOW,
      }),
    ).rejects.toThrow('OAuth authorization state')
  })
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_TEST_AUTH_GOOGLE: '1',
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })
    owner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('oauth-kernel-owner'),
      'OAuth Kernel Owner',
    )
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
      },
    )
    workspace = (
      (await query(owner.client, 'domains/workspaces/queries:listMine', {})) as Array<{
        workspace: Workspace
      }>
    )[0]!.workspace
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('DCR rows persist exact redirects and read back as one normalized client shape', async () => {
    const dcr = await mutatePublic('domains/oauth/api:registerDynamicClient', {
      internalKey: INTERNAL_KEY,
      clientId: 'duet_client_registration_fixture',
      clientName: 'Registration fixture',
      redirectUris: ['http://127.0.0.1:43191/callback?exact=1', 'https://client.example/callback'],
      tokenEndpointAuthMethod: 'none',
      source: 'dcr',
      now: NOW,
    })
    const normalized = {
      clientId: 'duet_client_registration_fixture',
      clientName: 'Registration fixture',
      redirectUris: ['http://127.0.0.1:43191/callback?exact=1', 'https://client.example/callback'],
      tokenEndpointAuthMethod: 'none',
      source: 'dcr',
    }
    expect(dcr).toEqual(normalized)
    expect(
      await queryPublic('domains/oauth/api:getCachedClient', {
        internalKey: INTERNAL_KEY,
        clientId: 'duet_client_registration_fixture',
        now: NOW,
      }),
    ).toEqual(normalized)
    expect(
      await queryPublic('domains/oauth/api:getCachedClient', {
        internalKey: INTERNAL_KEY,
        clientId: 'unregistered-client',
        now: NOW,
      }),
    ).toBeNull()
  })

  test('approval binds an eligible workspace and a code exchanges once with hashes only at rest', async () => {
    const requestId = await createRequest(NOW)
    const pending = (await rawState()).requests.find(request => request._id === requestId)!
    await expect(approve(requestId, 'not-eligible', NOW + 1)).rejects.toThrow(
      'Workspace is not eligible',
    )
    const code = codeFromRedirect(await approve(requestId, workspace.slug, NOW + 2))
    await expect(approve(requestId, workspace.slug, NOW + 2)).rejects.toThrow(
      'Authorization request is not pending',
    )
    const tokens = await exchange(code, NOW + 3)

    expect(tokens).toMatchObject({
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      scope: 'files:read memory',
    })
    const state = await rawState()
    expect(state.requests.find(request => request._id === requestId)).toMatchObject({
      clientId: pending.clientId,
      clientName: pending.clientName,
      redirectUri: pending.redirectUri,
      state: pending.state,
      capabilities: pending.capabilities,
      resource: pending.resource,
      codeChallenge: pending.codeChallenge,
      expiresAt: pending.expiresAt,
      status: 'approved',
      userId: owner.user._id,
      workspaceId: workspace._id,
    })
    const grant = state.grants.find(candidate => candidate.clientId === CLIENT_ID)!
    expect(grant).toMatchObject({
      userId: owner.user._id,
      workspaceId: workspace._id,
      scopes: [`ws:${workspace.slug}:files:read`, `ws:${workspace.slug}:memory`],
      generation: 1,
    })
    expect(state.codes.find(candidate => candidate.requestId === requestId)).toMatchObject({
      hashedCode: await hashApiKey(code),
      expiresAt: NOW + 2 + AUTHORIZATION_CODE_TTL_MS,
    })
    expect(state.refreshTokens.find(candidate => candidate.grantId === grant._id)).toMatchObject({
      hashedToken: await hashApiKey(tokens.refresh_token),
      expiresAt: NOW + 3 + REFRESH_TOKEN_TTL_MS,
    })
    expect(state.apiKeys.find(candidate => candidate.oauthGrantId === grant._id)).toMatchObject({
      hashedKey: await hashApiKey(tokens.access_token),
      expiresAt: NOW + 3 + ACCESS_TOKEN_TTL_MS,
    })
    expect(JSON.stringify(state)).not.toContain(code)
    expect(JSON.stringify(state)).not.toContain(tokens.refresh_token)
    expect(JSON.stringify(state)).not.toContain(tokens.access_token)
    expect((await authenticate(tokens.access_token, NOW + 3)).ok).toBeTrue()
    await expect(exchange(code, NOW + 4)).rejects.toThrow('Invalid authorization code')
  })

  test('inspection exposes the trusted snapshot and denial round-trips state exactly once', async () => {
    const requestId = await createRequest(NOW + 25)
    expect(
      await queryPublic('domains/oauth/api:inspectAuthorization', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        requestId,
        now: NOW + 26,
      }),
    ).toEqual({
      status: 'pending',
      client: { id: CLIENT_ID, name: 'OAuth kernel fixture' },
      redirect: { hostname: '127.0.0.1', localhost: true },
      capabilities: ['files:read', 'memory'],
      workspaces: [{ slug: workspace.slug, name: expect.any(String), role: 'owner' }],
      expiresAt: NOW + 25 + AUTHORIZATION_REQUEST_TTL_MS,
    })

    const denied = (await mutatePublic('domains/oauth/api:denyAuthorization', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      requestId,
      now: NOW + 27,
    })) as { redirectUrl: string }
    const completion = new URL(denied.redirectUrl)
    expect(completion.origin + completion.pathname).toBe(
      new URL(REDIRECT_URI).origin + new URL(REDIRECT_URI).pathname,
    )
    expect(completion.searchParams.get('error')).toBe('access_denied')
    expect(completion.searchParams.get('state')).toBe(`state-${NOW + 25}`)
    await expect(
      mutatePublic('domains/oauth/api:denyAuthorization', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        requestId,
        now: NOW + 28,
      }),
    ).rejects.toThrow('Authorization request is not pending')
  })

  test('a user with zero eligible workspaces may inspect but cannot approve', async () => {
    const actorId = (await mutatePublic('testing/oauth:createUserWithoutWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      email: uniqueEmail('oauth-no-workspace'),
      name: 'No Workspace',
    })) as string
    const requestId = await createRequest(NOW + 30)
    const inspected = (await queryPublic('domains/oauth/api:inspectAuthorization', {
      internalKey: INTERNAL_KEY,
      actorId,
      requestId,
      now: NOW + 31,
    })) as { workspaces: unknown[] }
    expect(inspected.workspaces).toEqual([])
    await expect(
      mutatePublic('domains/oauth/api:approveAuthorization', {
        internalKey: INTERNAL_KEY,
        actorId,
        requestId,
        workspaceSlug: workspace.slug,
        now: NOW + 32,
      }),
    ).rejects.toThrow('Workspace is not eligible')
  })

  test('every capability is requestable and the requester role is the only ceiling', async () => {
    // One capability list for membership-backed credentials: `admin` and
    // `members` reach the consent screen, and roleCanGrant — not the app
    // declaration grammar — decides who may approve them.
    const editorId = (await mutatePublic('testing/oauth:createUserWithoutWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      email: uniqueEmail('oauth-widening-editor'),
      name: 'Widening Editor',
    })) as string
    await mutatePublic('testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      userId: editorId,
      role: 'editor',
    })

    const requestId = (await mutatePublic('domains/oauth/api:createAuthorizationRequest', {
      internalKey: INTERNAL_KEY,
      clientId: CLIENT_ID,
      clientName: 'OAuth kernel fixture',
      redirectUri: REDIRECT_URI,
      state: `state-${NOW + 40}`,
      capabilities: ['members', 'admin', 'files:read', 'admin'],
      resource: RESOURCE,
      codeChallenge: await s256(VERIFIER),
      now: NOW + 40,
    })) as string

    const inspectAs = async (actorId: string, now: number) =>
      (await queryPublic('domains/oauth/api:inspectAuthorization', {
        internalKey: INTERNAL_KEY,
        actorId,
        requestId,
        now,
      })) as { capabilities: string[]; workspaces: Array<{ slug: string; role: string }> }

    const ownerView = await inspectAs(owner.user._id, NOW + 41)
    expect(ownerView.capabilities).toEqual(['admin', 'files:read', 'members'])
    expect(ownerView.workspaces).toContainEqual(
      expect.objectContaining({ slug: workspace.slug, role: 'owner' }),
    )

    const editorView = await inspectAs(editorId, NOW + 41)
    expect(editorView.capabilities).toEqual(['admin', 'files:read', 'members'])
    expect(editorView.workspaces).toEqual([])
    await expect(
      mutatePublic('domains/oauth/api:approveAuthorization', {
        internalKey: INTERNAL_KEY,
        actorId: editorId,
        requestId,
        workspaceSlug: workspace.slug,
        now: NOW + 42,
      }),
    ).rejects.toThrow('Workspace is not eligible')

    // The same editor is eligible for a request that stays inside what an
    // editor may grant — the exclusion above is the capability, not the seat.
    const editorGrantable = await createRequest(NOW + 43)
    expect(
      (
        (await queryPublic('domains/oauth/api:inspectAuthorization', {
          internalKey: INTERNAL_KEY,
          actorId: editorId,
          requestId: editorGrantable,
          now: NOW + 44,
        })) as { workspaces: Array<{ slug: string }> }
      ).workspaces,
    ).toContainEqual(expect.objectContaining({ slug: workspace.slug, role: 'editor' }))

    const code = codeFromRedirect(await approve(requestId, workspace.slug, NOW + 45))
    expect(await exchange(code, NOW + 46)).toMatchObject({
      scope: 'admin files:read members',
    })
    expect(
      (await rawState()).grants.find(candidate => candidate.createdAt === NOW + 46)?.scopes,
    ).toEqual([
      `ws:${workspace.slug}:admin`,
      `ws:${workspace.slug}:files:read`,
      `ws:${workspace.slug}:members`,
    ])
  })

  test('a failed PKCE check does not consume or disclose the authorization code', async () => {
    const requestId = await createRequest(NOW + 50)
    const code = codeFromRedirect(await approve(requestId, workspace.slug, NOW + 51))
    const failed = mutatePublic('domains/oauth/api:exchangeAuthorizationCode', {
      internalKey: INTERNAL_KEY,
      code,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      resource: RESOURCE,
      codeVerifier: `${VERIFIER}wrong`,
      now: NOW + 52,
    })
    await expect(failed).rejects.toThrow('Invalid authorization code')
    await expect(failed).rejects.not.toThrow(code)
    expect((await exchange(code, NOW + 53)).access_token).toStartWith('duet_sk_')
  })

  test('request expiry and every authorization-code binding reject without consuming a valid code', async () => {
    const expiredRequestId = await createRequest(NOW + 70)
    await expect(
      approve(expiredRequestId, workspace.slug, NOW + 70 + AUTHORIZATION_REQUEST_TTL_MS),
    ).rejects.toThrow('Authorization request expired')

    const requestId = await createRequest(NOW + 80)
    const code = codeFromRedirect(await approve(requestId, workspace.slug, NOW + 81))
    for (const mismatch of [
      { clientId: `${CLIENT_ID}-wrong` },
      { redirectUri: `${REDIRECT_URI}/wrong` },
      { resource: 'https://other-resource.example/' },
    ]) {
      await expect(
        mutatePublic('domains/oauth/api:exchangeAuthorizationCode', {
          internalKey: INTERNAL_KEY,
          code,
          clientId: mismatch.clientId ?? CLIENT_ID,
          redirectUri: mismatch.redirectUri ?? REDIRECT_URI,
          resource: mismatch.resource ?? RESOURCE,
          codeVerifier: VERIFIER,
          now: NOW + 82,
        }),
      ).rejects.toThrow('Invalid authorization code')
    }
    expect((await exchange(code, NOW + 83)).token_type).toBe('Bearer')

    const expiringRequestId = await createRequest(NOW + 90)
    const expiringCode = codeFromRedirect(
      await approve(expiringRequestId, workspace.slug, NOW + 91),
    )
    await expect(exchange(expiringCode, NOW + 91 + AUTHORIZATION_CODE_TTL_MS)).rejects.toThrow(
      'Invalid authorization code',
    )
  })

  test('concurrent authorization-code exchange has exactly one success', async () => {
    const requestId = await createRequest(NOW + 100)
    const code = codeFromRedirect(await approve(requestId, workspace.slug, NOW + 101))
    const results = await Promise.allSettled([exchange(code, NOW + 102), exchange(code, NOW + 102)])
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    const state = await rawState()
    expect(state.codes.find(candidate => candidate.requestId === requestId)?.consumedAt).toBe(
      NOW + 102,
    )
    const grants = state.grants.filter(candidate => candidate.createdAt === NOW + 102)
    expect(grants.map(grant => grant.generation)).toEqual([1])
    expect(
      state.refreshTokens
        .filter(token => token.grantId === grants[0]!._id)
        .map(token => token.generation),
    ).toEqual([1])
    expect(
      state.apiKeys.filter(key => key.oauthGrantId === grants[0]!._id).map(key => key.kind),
    ).toEqual(['oauth'])
  })

  test('concurrent refresh and grace re-rotation leave one descendant and invalidate the replaced pair', async () => {
    const initial = await authorizedPair(NOW + 200)
    const concurrent = await Promise.all([
      rotate(initial.tokens.refresh_token, NOW + 204),
      rotate(initial.tokens.refresh_token, NOW + 204),
    ])
    const state = await rawState()
    const family = state.grants.find(candidate => candidate._id === initial.grantId)!
    const heads = state.refreshTokens.filter(
      candidate => candidate.grantId === family._id && candidate.supersededAt === undefined,
    )
    expect(family.generation).toBe(2)
    expect(heads).toHaveLength(1)
    const concurrentHashes = await Promise.all(
      concurrent.map(candidate => hashApiKey(candidate.refresh_token)),
    )
    const liveIndex = concurrentHashes.findIndex(hash => hash === heads[0]!.hashedToken)
    expect(liveIndex).not.toBe(-1)
    const live = concurrent[liveIndex]!
    const discarded = concurrent[liveIndex === 0 ? 1 : 0]!
    expect((await authenticate(live.access_token, NOW + 205)).ok).toBeTrue()
    expect(await authenticate(discarded.access_token, NOW + 205)).toEqual({
      ok: false,
      reason: 'revoked',
    })
    await expect(rotate(discarded.refresh_token, NOW + 205)).rejects.toThrow(
      'Invalid refresh token',
    )
    expect((await authenticate(live.access_token, NOW + 206)).ok).toBeTrue()

    const serial = await authorizedPair(NOW + 300)
    const firstSuccessor = await rotate(serial.tokens.refresh_token, NOW + 304)
    const firstState = await rawState()
    const predecessorHash = await hashApiKey(serial.tokens.refresh_token)
    const firstHeadHash = await hashApiKey(firstSuccessor.refresh_token)
    const predecessor = firstState.refreshTokens.find(
      token => token.hashedToken === predecessorHash,
    )
    const firstHead = firstState.refreshTokens.find(token => token.hashedToken === firstHeadHash)!
    const firstAccess = firstState.apiKeys.find(key => key._id === firstHead.accessKeyId)!
    const replacement = await rotate(serial.tokens.refresh_token, NOW + 305)
    const replacementState = await rawState()
    const replacementHeadHash = await hashApiKey(replacement.refresh_token)
    const replacementHead = replacementState.refreshTokens.find(
      token => token.hashedToken === replacementHeadHash,
    )!
    const replacementAccess = replacementState.apiKeys.find(
      key => key._id === replacementHead.accessKeyId,
    )!
    expect(predecessor?.graceUntil).toBe(NOW + 304 + REFRESH_GRACE_MS)
    expect(replacementHead.expiresAt).toBe(firstHead.expiresAt)
    expect(replacementAccess.expiresAt).toBe(firstAccess.expiresAt)
    await expect(rotate(firstSuccessor.refresh_token, NOW + 306)).rejects.toThrow(
      'Invalid refresh token',
    )
    expect(await authenticate(firstSuccessor.access_token, NOW + 306)).toEqual({
      ok: false,
      reason: 'revoked',
    })
    expect((await authenticate(replacement.access_token, NOW + 306)).ok).toBeTrue()
  })

  test('family revocation kills linked access and refresh credentials while non-OAuth auth is unchanged', async () => {
    const issued = await authorizedPair(NOW + 400)
    const rotated = await rotate(issued.tokens.refresh_token, NOW + 403)
    const browser = (await mutate(
      owner.client,
      'domains/apiKeys/mutations:mintBrowserSession',
      {},
    )) as {
      token: string
      prefix: string
    }
    expect(
      await mutatePublic('domains/oauth/api:revokeGrant', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        grantId: issued.grantId,
        now: NOW + 404,
      }),
    ).toEqual({ grantId: issued.grantId, revokedAt: NOW + 404 })
    expect(await authenticate(issued.tokens.access_token, NOW + 405)).toEqual({
      ok: false,
      reason: 'revoked',
    })
    expect(await authenticate(rotated.access_token, NOW + 405)).toEqual({
      ok: false,
      reason: 'revoked',
    })
    await expect(rotate(issued.tokens.refresh_token, NOW + 405)).rejects.toThrow(
      'Invalid refresh token',
    )
    await expect(rotate(rotated.refresh_token, NOW + 405)).rejects.toThrow('Invalid refresh token')
    expect((await authenticate(browser.token, NOW + 405, browser.prefix)).ok).toBeTrue()
    const listed = (await queryPublic('domains/oauth/api:listGrants', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      paginationOpts: { cursor: null, numItems: 100 },
    })) as { page: Array<{ id: string; revokedAt?: number }> }
    expect(listed.page).toContainEqual(
      expect.objectContaining({ id: issued.grantId, revokedAt: NOW + 404 }),
    )
    expect(JSON.stringify(listed)).not.toContain('hashed')
  })

  test('grant inventory returns bounded cursor pages', async () => {
    await authorizedPair(NOW + 450)
    await authorizedPair(NOW + 450)
    const tiedIds = (await rawState()).grants
      .filter(grant => grant.createdAt === NOW + 452)
      .map(grant => grant._id)
      .sort()
      .reverse()
    const first = (await queryPublic('domains/oauth/api:listGrants', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      paginationOpts: { cursor: null, numItems: 1 },
    })) as { page: Array<{ id: string }>; continueCursor: string; isDone: boolean }
    const continueCursor = first.continueCursor
    expect(first.page).toHaveLength(1)
    expect(first.isDone).toBe(false)
    const second = (await queryPublic('domains/oauth/api:listGrants', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      paginationOpts: { cursor: continueCursor, numItems: 1 },
    })) as { page: Array<{ id: string }> }
    expect([...first.page, ...second.page].map(grant => grant.id)).toEqual(tiedIds)
  })

  test('deeper-ancestor and post-grace reuse revoke their families', async () => {
    const ancestor = await authorizedPair(NOW + 500)
    const generation2 = await rotate(ancestor.tokens.refresh_token, NOW + 503)
    const generation3 = await rotate(generation2.refresh_token, NOW + 504)
    await expect(rotate(ancestor.tokens.refresh_token, NOW + 505)).rejects.toThrow(
      'Invalid refresh token',
    )
    expect(await authenticate(generation3.access_token, NOW + 506)).toEqual({
      ok: false,
      reason: 'revoked',
    })

    const expiredGrace = await authorizedPair(NOW + 600)
    const successor = await rotate(expiredGrace.tokens.refresh_token, NOW + 603)
    await expect(
      rotate(expiredGrace.tokens.refresh_token, NOW + 603 + REFRESH_GRACE_MS + 1),
    ).rejects.toThrow('Invalid refresh token')
    expect(await authenticate(successor.access_token, NOW + 603 + REFRESH_GRACE_MS + 2)).toEqual({
      ok: false,
      reason: 'revoked',
    })
  })
})

async function authorizedPair(now: number): Promise<{ grantId: string; tokens: Tokens }> {
  const requestId = await createRequest(now)
  const code = codeFromRedirect(await approve(requestId, workspace.slug, now + 1))
  const tokens = await exchange(code, now + 2)
  const state = await rawState()
  const grant = state.grants.find(
    candidate => candidate.clientId === CLIENT_ID && candidate.createdAt === now + 2,
  )!
  return { grantId: grant._id, tokens }
}

async function createRequest(now: number): Promise<string> {
  return (await mutatePublic('domains/oauth/api:createAuthorizationRequest', {
    internalKey: INTERNAL_KEY,
    clientId: CLIENT_ID,
    clientName: 'OAuth kernel fixture',
    redirectUri: REDIRECT_URI,
    state: `state-${now}`,
    capabilities: ['files:read', 'memory'],
    resource: RESOURCE,
    codeChallenge: await s256(VERIFIER),
    now,
  })) as string
}

async function approve(requestId: string, workspaceSlug: string, now: number): Promise<string> {
  const result = (await mutatePublic('domains/oauth/api:approveAuthorization', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    requestId,
    workspaceSlug,
    now,
  })) as { redirectUrl: string }
  return result.redirectUrl
}

async function exchange(code: string, now: number): Promise<Tokens> {
  return (await mutatePublic('domains/oauth/api:exchangeAuthorizationCode', {
    internalKey: INTERNAL_KEY,
    code,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    resource: RESOURCE,
    codeVerifier: VERIFIER,
    now,
  })) as Tokens
}

async function rotate(refreshToken: string, now: number): Promise<Tokens> {
  const result = (await mutatePublic('domains/oauth/api:rotateRefreshToken', {
    internalKey: INTERNAL_KEY,
    refreshToken,
    clientId: CLIENT_ID,
    resource: RESOURCE,
    now,
  })) as Tokens | { ok: false; reason: string }
  if ('access_token' in result) return result
  throw new Error('Invalid refresh token')
}

// Every claim in this file is about who a token resolves to, never about the
// budget it spends, so only the resolving half of the API's authentication is
// asked here.
async function authenticate(token: string, now: number, prefix?: string): Promise<AuthResult> {
  return (await queryPublic('domains/apiKeys/api:resolveCredential', {
    internalKey: INTERNAL_KEY,
    hashedKey: await hashApiKey(token),
    keyPrefix: prefix ?? token.slice(0, 'duet_sk_'.length + 8),
    now,
  })) as AuthResult
}

async function rawState(): Promise<RawState> {
  return (await queryPublic('testing/oauth:rawStateForTest', {
    internalKey: INTERNAL_KEY,
  })) as RawState
}

function codeFromRedirect(redirectUrl: string): string {
  const code = new URL(redirectUrl).searchParams.get('code')
  if (code === null) throw new Error('approval did not return a code')
  return code
}

async function s256(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  )
  return Buffer.from(digest).toString('base64url')
}

function mutatePublic(name: string, args: Record<string, unknown>): Promise<unknown> {
  return convex.mutation(name, args)
}

function queryPublic(name: string, args: Record<string, unknown>): Promise<unknown> {
  return convex.query(name, args)
}

interface SignedInUser {
  client: ConvexHttpClient
  user: UserRow
}
interface UserRow {
  _id: string
  email: string
}
interface Workspace {
  _id: string
  slug: string
}
interface Tokens {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}
interface AuthResult {
  ok: boolean
  reason?: string
}
interface RawState {
  requests: Array<{
    _id: string
    clientId: string
    clientName: string
    redirectUri: string
    state?: string
    capabilities: string[]
    resource: string
    codeChallenge: string
    status: string
    expiresAt: number
    userId?: string
    workspaceId?: string
  }>
  codes: Array<{
    requestId: string
    hashedCode: string
    expiresAt: number
    consumedAt?: number
  }>
  grants: Array<{
    _id: string
    clientId: string
    userId: string
    workspaceId: string
    scopes: string[]
    generation: number
    createdAt: number
  }>
  refreshTokens: Array<{
    grantId: string
    hashedToken: string
    accessKeyId: string
    generation: number
    expiresAt: number
    supersededAt?: number
    graceUntil?: number
  }>
  apiKeys: Array<{
    _id: string
    oauthGrantId?: string
    kind?: string
    hashedKey: string
    expiresAt?: number
  }>
}
