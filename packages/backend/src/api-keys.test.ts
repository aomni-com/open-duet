import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'

import {
  BROWSER_SESSION_TTL_MS,
  CAPABILITIES,
  LOW_CREDIT_RECOVERY_THRESHOLD_MICRO_USD,
  MAX_SLUG_LENGTH,
  PRE_AUTH_RATE_LIMIT_ENDPOINTS,
  canonicalizeApiKeyScopes,
  hashApiKey,
  type WorkspaceFunding,
  type WorkspaceCreditRecovery,
} from '@repo/contract'
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

import type { Doc } from '../convex/_generated/dataModel'
import { DEFAULT_API_KEY_LAST_USED_WINDOW_MS } from '../convex/config'
import {
  BROWSER_SESSION_MINT_LIMIT,
  BROWSER_SESSION_MINT_WINDOW_MS,
  BROWSER_SESSION_ROTATION_HANDOFF_MS,
} from '../convex/domains/apiKeys/mutations'
import {
  browserSessionMintRateLimitKey,
  rateLimitShardCount,
} from '../convex/domains/shared/rateLimits'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'test-api-internal-key'

let convex: ConvexDevFixture
let owner: SignedInUser
let firstWorkspace: WorkspaceRow['workspace']
let sequence = 0

function workspaceScopes(slug: string, capabilities = CAPABILITIES): string[] {
  return capabilities.map(capability => `ws:${slug}:${capability}`)
}

function canonicalVmScopes(slug: string): string[] {
  return canonicalizeApiKeyScopes(
    ['services', 'apps', 'agents', 'sessions', 'integrations', 'admin'].map(
      capability => `ws:${slug}:${capability}`,
    ),
  )
}

describe('api keys', () => {
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
      uniqueEmail('api-keys-owner'),
      'API Keys Owner',
    )
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
      },
    )
    firstWorkspace = (await listMine(owner.client))[0]!.workspace
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('human issuance saves identity and authenticates current memberships without grants', async () => {
    const issued = (await mutatePublic('domains/apiKeys/userApi:issue', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      name: 'Duet CLI',
      now: Date.now(),
    })) as { key: string; record: { id: string; prefix: string } }
    const before = (await rawApiKeys()).find(row => row._id === issued.record.id)!
    expect(before.hashedKey).toBe(await hashApiKey(issued.key))
    expect(before.userId).toBe(owner.user._id)
    expect(before.paginationId).toBe(before._id)
    expect(before.paginationCreatedAt).toBe(before._creationTime)
    expect(before).not.toHaveProperty('scopes')
    expect(before).not.toHaveProperty('workspaceIds')
    const slug = uniqueSlug('identity-joined')
    const joinedId = await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug,
      name: 'Joined workspace',
    })
    const auth = (await authenticate(issued.key, issued.record.prefix, Date.now())) as AuthResult
    expect(auth).toMatchObject({
      ok: true,
      auth: { credentialKind: 'user', user: { id: owner.user._id } },
    })
    expect(auth.auth.workspaces.map(row => row.id)).toEqual(
      expect.arrayContaining([firstWorkspace._id, joinedId]),
    )
    expect(auth.auth.workspaces.find(row => row.id === joinedId)).toMatchObject({
      slug,
      role: 'owner',
    })
  })

  test('a concurrent API burst spends its budget without losing requests to write conflicts', async () => {
    const issued = (await mutate(
      owner.client,
      'domains/apiKeys/mutations:mintBrowserSession',
      {},
    )) as { token: string }
    const hashedKey = await hashApiKey(issued.token)
    const record = makeFunctionReference<'mutation'>('domains/apiKeys/api:recordCredentialUse')
    const now = Date.now()
    // The HTTP client normally queues mutations; skipQueue exercises the
    // independent API workers that race in production.
    for (let window = 0; window < 3; window += 1) {
      const at = now + window * 60_000
      await convex.client.mutation(record, { internalKey: INTERNAL_KEY, hashedKey, now: at })
      const outcomes = await Promise.allSettled(
        Array.from({ length: 64 }, () =>
          convex.client.mutation(
            record,
            { internalKey: INTERNAL_KEY, hashedKey, now: at },
            { skipQueue: true },
          ),
        ),
      )
      expect(outcomes.filter(result => result.status === 'rejected')).toEqual([])
      for (const result of outcomes) {
        if (result.status === 'fulfilled') expect(result.value).toEqual({ ok: true })
      }
    }
  }, 60_000)

  test('a provisioning workspace remains visible to owner auth but not VM dispatch', async () => {
    const provisioningOwner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('api-keys-provisioning-owner'),
      'API Keys Provisioning Owner',
    )
    const workspace = (await listMine(provisioningOwner.client))[0]!.workspace
    await prepareWorkspaceForRegistration(provisioningOwner, workspace)

    const now = 500_000
    const impersonation = (await mutatePublic('domains/apiKeys/api:mintImpersonationKey', {
      internalKey: INTERNAL_KEY,
      email: provisioningOwner.user.email,
      ttlSeconds: 600,
      now,
    })) as ImpersonationKeyResult
    const impersonationAuth = (await authenticate(
      impersonation.token,
      impersonation.token.slice(0, 'duet_sk_'.length + 8),
      now + 1,
    )) as AuthResult
    const ownerScopes = workspaceScopes(workspace.slug)
    expect(impersonationAuth.auth.scopes).toEqual(ownerScopes)
    expect(impersonationAuth.auth.workspaces.map(candidate => candidate.id)).toEqual([
      workspace._id,
    ])

    const issued = await issueKey(provisioningOwner.client)
    expect(issued).not.toHaveProperty('scopes')
    expect(await listApiKeys(provisioningOwner)).toContainEqual(
      expect.objectContaining({ prefix: issued.prefix }),
    )

    // Not dispatchable, but not invisible either: the resolution is the typed
    // provisioning refusal (never a connection, never `null` — null means the
    // workspace does not exist).
    expect(
      await queryPublic('domains/workspaces/provisioning:gatewayConnectionBySlug', {
        internalKey: INTERNAL_KEY,
        slug: workspace.slug,
      }),
    ).toEqual({ refusal: 'provisioning' })
  })

  test('an active workspace remains visible to owner auth', async () => {
    const activeOwner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('api-keys-active-owner'),
      'API Keys Active Owner',
    )
    const workspace = (await listMine(activeOwner.client))[0]!.workspace
    const now = 600_000
    const impersonation = (await mutatePublic('domains/apiKeys/api:mintImpersonationKey', {
      internalKey: INTERNAL_KEY,
      email: activeOwner.user.email,
      workspaceSlug: workspace.slug,
      ttlSeconds: 600,
      now,
    })) as ImpersonationKeyResult
    const authenticated = (await authenticate(
      impersonation.token,
      impersonation.token.slice(0, 'duet_sk_'.length + 8),
      now + 1,
    )) as AuthResult

    expect(authenticated.auth.scopes).toEqual(workspaceScopes(workspace.slug))
    expect(authenticated.auth.workspaces.map(candidate => candidate.id)).toEqual([workspace._id])
  })

  test('retired and deleted workspaces remain hidden from auth resolution', async () => {
    for (const status of ['retired', 'deleted'] as const) {
      const terminalOwner = await signInWithMagicLink<UserRow>(
        convex,
        uniqueEmail(`api-keys-${status}-owner`),
        `API Keys ${status} Owner`,
      )
      const workspace = await createWorkspace(terminalOwner, `api-keys-${status}`)
      const issued = await issueKey(terminalOwner.client)
      await makeWorkspaceTerminal(terminalOwner, workspace, status)

      expect((await issueKey(terminalOwner.client)).key).toStartWith('duet_sk_')
      await expect(
        mutatePublic('domains/apiKeys/api:mintImpersonationKey', {
          internalKey: INTERNAL_KEY,
          email: terminalOwner.user.email,
          workspaceSlug: workspace.slug,
          ttlSeconds: 600,
          now: 700_000,
        }),
      ).rejects.toThrow('Workspace not found')

      const authenticated = (await authenticate(issued.key, issued.prefix, 700_001)) as AuthResult
      expect(authenticated.auth.workspaces.map(row => row.id)).not.toContain(workspace._id)
      expect(
        authenticated.auth.scopes.some(scope => scope.startsWith(`ws:${workspace.slug}:`)),
      ).toBeFalse()
    }
  })

  test('a non-member cannot resolve a workspace in any status', async () => {
    const nonMember = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('api-keys-non-member'),
      'API Keys Non-member',
    )
    const workspaces = await Promise.all(
      (['active', 'provisioning', 'retired', 'deleted'] as const).map(async status => ({
        status,
        workspace: await createWorkspace(owner, `nonmem-${status}`),
      })),
    )
    for (const candidate of workspaces) {
      if (candidate.status === 'provisioning') {
        await prepareWorkspaceForRegistration(owner, candidate.workspace)
      } else if (candidate.status === 'retired' || candidate.status === 'deleted') {
        await makeWorkspaceTerminal(owner, candidate.workspace, candidate.status)
      }
    }

    const issued = await issueKey(nonMember.client)
    const authenticated = (await authenticate(issued.key, issued.prefix, Date.now())) as AuthResult
    for (const { workspace } of workspaces) {
      expect(authenticated.auth.workspaces.map(row => row.id)).not.toContain(workspace._id)
      expect(
        authenticated.auth.scopes.some(scope => scope.startsWith(`ws:${workspace.slug}:`)),
      ).toBeFalse()
    }
  })

  test('authenticate patches lastUsedAt at most once per throttle window', async () => {
    const issued = await issueKey(owner.client)
    const windowMs = DEFAULT_API_KEY_LAST_USED_WINDOW_MS
    const base = 8_000_000

    const first = (await authenticate(issued.key, issued.prefix, base)) as AuthResult
    expect(first.ok).toBeTrue()
    const rawAfterFirst = (await rawApiKeys()).find(key => key.prefix === issued.prefix)!
    expect(rawAfterFirst.lastUsedAt).toBe(base)

    // Repeated calls inside the window are query-only: identical authorization,
    // no patch.
    for (const now of [base + 1, base + Math.floor(windowMs / 2), base + windowMs - 1]) {
      expect(authorization(await authenticate(issued.key, issued.prefix, now))).toEqual(
        authorization(first),
      )
    }
    const rawInsideWindow = (await rawApiKeys()).find(key => key.prefix === issued.prefix)!
    expect(rawInsideWindow.lastUsedAt).toBe(base)

    // The window boundary yields exactly one more write.
    expect(authorization(await authenticate(issued.key, issued.prefix, base + windowMs))).toEqual(
      authorization(first),
    )
    const rawNextWindow = (await rawApiKeys()).find(key => key.prefix === issued.prefix)!
    expect(rawNextWindow.lastUsedAt).toBe(base + windowMs)

    // Revocation is never throttled: it wins immediately, mid-window.
    await revokeApiKey(owner, rawNextWindow._id)
    expect(await authenticate(issued.key, issued.prefix, base + windowMs + 1)).toEqual({
      ok: false,
      reason: 'revoked',
    })
  })

  test('oauth keys authenticate like user keys and expire through the shared guard', async () => {
    const token = 'duet_sk_oauth_contract_fixture'
    const prefix = token.slice(0, 'duet_sk_'.length + 8)
    const expiresAt = 8_100_000
    const scope = `ws:${firstWorkspace.slug}:files:read`
    const audience = 'https://mcp.duet.so/'
    await mutatePublic('testing/apiKeys:insertOAuthApiKeyForTest', {
      internalKey: INTERNAL_KEY,
      userId: owner.user._id,
      workspaceId: firstWorkspace._id,
      hashedKey: await hashApiKey(token),
      prefix,
      scopes: [scope],
      audience,
      expiresAt,
    })

    expect(await authenticate(token, prefix, expiresAt - 1)).toMatchObject({
      ok: true,
      auth: {
        credentialKind: 'oauth',
        audience,
        scopes: [scope],
        workspaces: [{ id: firstWorkspace._id }],
      },
    })
    expect(await authenticate(token, prefix, expiresAt)).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  test('authenticate returns the credential document id — not the prefix, not the secret', async () => {
    const issued = await issueKey(owner.client)
    const raw = (await rawApiKeys()).find(key => key.prefix === issued.prefix)!

    const authenticated = (await authenticate(issued.key, issued.prefix, Date.now())) as AuthResult
    expect(authenticated.ok).toBeTrue()
    expect(authenticated.auth.credentialId).toBe(raw._id)
    expect(authenticated.auth.credentialId).not.toBe(issued.prefix)
    expect(authenticated.auth.credentialId).not.toBe(issued.key)
    expect(JSON.stringify(authenticated)).not.toContain(issued.key)

    // Browser sessions attribute by user, not by credential — no id.
    const mintedAfter = Date.now()
    const minted = (await mutate(
      owner.client,
      'domains/apiKeys/mutations:mintBrowserSession',
      {},
    )) as BrowserSessionResult
    const mintedBefore = Date.now()
    // Born used: the page-load burst that follows a mint must find the row
    // already stamped, or every request in it is a writer to one fresh row.
    const mintedRow = (await rawApiKeys()).find(key => key.prefix === minted.prefix)!
    expect(mintedRow.lastUsedAt).toBeGreaterThanOrEqual(mintedAfter)
    expect(mintedRow.lastUsedAt).toBeLessThanOrEqual(mintedBefore)
    const sessionAuth = (await authenticate(minted.token, minted.prefix, Date.now())) as AuthResult
    expect(sessionAuth.ok).toBeTrue()
    expect(sessionAuth.auth.credentialId).toBeUndefined()
  })

  test('browser sessions resolve live memberships and roles on every authentication', async () => {
    const browserUser = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('browser-session-member'),
      'Browser Session Member',
    )
    const personalWorkspace = (await listMine(browserUser.client))[0]!.workspace
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: firstWorkspace._id,
      userId: browserUser.user._id,
      role: 'viewer',
    })

    const mintedAfter = Date.now()
    const minted = (await mutate(
      browserUser.client,
      'domains/apiKeys/mutations:mintBrowserSession',
      {},
    )) as BrowserSessionResult

    expect(minted.token).toStartWith('duet_sk_')
    expect(minted.expiresAt).toBeGreaterThanOrEqual(mintedAfter + BROWSER_SESSION_TTL_MS)
    expect(minted.expiresAt).toBeLessThanOrEqual(Date.now() + BROWSER_SESSION_TTL_MS)
    const stored = (await rawApiKeys()).find(key => key.prefix === minted.prefix)
    expect(stored).toMatchObject({
      kind: 'browser_session',
      userId: browserUser.user._id,
      hashedKey: await hashApiKey(minted.token),
      scopes: [],
      workspaceIds: expect.arrayContaining([personalWorkspace._id, firstWorkspace._id]),
      expiresAt: minted.expiresAt,
    })
    expect(stored?.hashedKey).not.toBe(minted.token)

    const viewerAuth = (await authenticate(minted.token, minted.prefix, Date.now())) as AuthResult
    expect(viewerAuth.auth.workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: personalWorkspace._id, role: 'owner' }),
        expect.objectContaining({ id: firstWorkspace._id, role: 'viewer' }),
      ]),
    )
    expect(viewerAuth.auth.scopes).toContain(`ws:${firstWorkspace.slug}:files:read`)
    expect(viewerAuth.auth.scopes).toContain(`ws:${firstWorkspace.slug}:apps`)
    expect(viewerAuth.auth.scopes).not.toContain(`ws:${firstWorkspace.slug}:files:write`)

    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: firstWorkspace._id,
      userId: browserUser.user._id,
      role: 'editor',
    })
    const editorAuth = (await authenticate(minted.token, minted.prefix, Date.now())) as AuthResult
    expect(editorAuth.auth.workspaces).toContainEqual(
      expect.objectContaining({ id: firstWorkspace._id, role: 'editor' }),
    )
    expect(editorAuth.auth.scopes).toContain(`ws:${firstWorkspace.slug}:files:write`)
    expect(editorAuth.auth.scopes).not.toContain(`ws:${firstWorkspace.slug}:admin`)

    await mutate(owner.client, 'domains/workspaces/mutations:removeMember', {
      workspaceId: firstWorkspace._id,
      userId: browserUser.user._id,
    })
    const removedAuth = (await authenticate(minted.token, minted.prefix, Date.now())) as AuthResult
    expect(removedAuth.auth.workspaces.map(workspace => workspace.id)).toEqual([
      personalWorkspace._id,
    ])
    expect(
      removedAuth.auth.scopes.every(scope => !scope.startsWith(`ws:${firstWorkspace.slug}:`)),
    ).toBeTrue()

    const addedAfterMint = await createWorkspace(owner, 'browser-added')
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: addedAfterMint._id,
      userId: browserUser.user._id,
      role: 'viewer',
    })
    const liveAfterMembership = (await authenticate(
      minted.token,
      minted.prefix,
      Date.now(),
    )) as AuthResult
    expect(liveAfterMembership.auth.workspaces.map(workspace => workspace.id)).toContain(
      addedAfterMint._id,
    )

    const refreshed = (await mutate(
      browserUser.client,
      'domains/apiKeys/mutations:mintBrowserSession',
      { previousHashedKey: await hashApiKey(minted.token) },
    )) as BrowserSessionResult
    const refreshedAuth = (await authenticate(
      refreshed.token,
      refreshed.prefix,
      Date.now(),
    )) as AuthResult
    expect(refreshedAuth.auth.workspaces).toContainEqual(
      expect.objectContaining({ id: addedAfterMint._id, role: 'viewer' }),
    )
  })

  test('SUBS-IMPL-11 browser identity projects the workspace servicing status', async () => {
    const browserUser = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('browser-servicing'),
      'Browser Servicing',
    )
    const workspace = (await listMine(browserUser.client))[0]!.workspace
    await mutatePublic('testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      servicingStatus: 'paused',
      now: Date.now(),
    })
    const minted = (await mutate(
      browserUser.client,
      'domains/apiKeys/mutations:mintBrowserSession',
      {},
    )) as BrowserSessionResult

    const authenticated = (await authenticate(
      minted.token,
      minted.prefix,
      Date.now(),
    )) as AuthResult
    expect(authenticated.auth.workspaces).toContainEqual(
      expect.objectContaining({ id: workspace._id, servicingStatus: 'paused' }),
    )
  })

  test('a configured paid tier survives the billing owner churning, as the viewing member reads it', async () => {
    const billingOwner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('tier-summary-owner'),
      'Tier Summary Owner',
    )
    await mutate(
      billingOwner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY },
    )
    const workspace = (await listMine(billingOwner.client))[0]!.workspace
    await mutate(billingOwner.client, 'domains/workspaces/mutations:setDefaultModel', {
      workspaceId: workspace._id,
      tier: 'balanced',
    })
    const viewer = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('tier-summary-viewer'),
      'Tier Summary Viewer',
    )
    await mutate(billingOwner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      userId: viewer.user._id,
      role: 'viewer',
    })
    const minted = (await mutate(
      viewer.client,
      'domains/apiKeys/mutations:mintBrowserSession',
      {},
    )) as BrowserSessionResult

    const subscribed = (await authenticate(minted.token, minted.prefix, Date.now())) as AuthResult
    expect(subscribed.auth.workspaces).toContainEqual(
      expect.objectContaining({
        id: workspace._id,
        defaultTier: { configured: 'balanced', effective: 'balanced' },
      }),
    )

    await mutate(billingOwner.client, 'testing/workspaces:clearCurrentUserPaidForTest', {
      internalKey: INTERNAL_KEY,
    })
    const churned = (await authenticate(minted.token, minted.prefix, Date.now())) as AuthResult
    expect(churned.auth.workspaces).toContainEqual(
      expect.objectContaining({
        id: workspace._id,
        defaultTier: { configured: 'balanced', effective: 'balanced' },
      }),
    )
  })

  /* F2, the whole reason `funding` is per-workspace: a member of a workspace
     someone else pays for is entitled THROUGH that person. A top-level block
     would report the reader's own plan — nothing — and the agent holding this
     credential would ask its human to buy what its host already bought. The
     same payload carries the member's own trialing workspace, so one reader
     genuinely needs two different answers at once. */
  test('funding reports each workspace payer, on every credential kind', async () => {
    const payer = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('funding-payer'),
      'Funding Payer',
    )
    await mutate(
      payer.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY, plan: 'pro' },
    )
    const funded = (await listMine(payer.client))[0]!.workspace
    const member = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('funding-member'),
      'Funding Member',
    )
    const ownTrial = (await listMine(member.client))[0]!.workspace
    const trialPayer = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('funding-trial-payer'),
      'Funding Trial Payer',
    )
    const trialFunded = (await listMine(trialPayer.client))[0]!.workspace
    await mutate(payer.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: funded._id,
      userId: member.user._id,
      role: 'editor',
    })
    await mutate(trialPayer.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: trialFunded._id,
      userId: member.user._id,
      role: 'viewer',
    })
    await setBalanceForRecoveryFixture(
      payer.user._id,
      funded._id,
      LOW_CREDIT_RECOVERY_THRESHOLD_MICRO_USD,
    )
    await setBalanceForRecoveryFixture(
      member.user._id,
      ownTrial._id,
      LOW_CREDIT_RECOVERY_THRESHOLD_MICRO_USD,
    )
    await setBalanceForRecoveryFixture(
      trialPayer.user._id,
      trialFunded._id,
      LOW_CREDIT_RECOVERY_THRESHOLD_MICRO_USD,
    )

    const session = (await mutate(
      member.client,
      'domains/apiKeys/mutations:mintBrowserSession',
      {},
    )) as BrowserSessionResult
    const browser = (await authenticate(session.token, session.prefix, Date.now())) as AuthResult
    expect(fundingFor(browser, funded._id)).toEqual({ plan: 'pro', active: true })
    expect(creditRecoveryFor(browser, funded._id)).toBe('topup')
    // The member subscribes to nothing, so their own workspace is on the trial
    // grant: no plan, still funded, and counting down.
    expect(fundingFor(browser, ownTrial._id)).toMatchObject({ plan: null, active: true })
    expect(fundingFor(browser, ownTrial._id)?.trialEndsAt).toBeGreaterThan(Date.now())
    expect(creditRecoveryFor(browser, ownTrial._id)).toBe('subscribe')
    expect(creditRecoveryFor(browser, trialFunded._id)).toBe('subscribe')

    const reviewableFragments = browser.auth.workspaces
      .filter(candidate =>
        [funded._id, ownTrial._id, trialFunded._id].some(id => id === candidate.id),
      )
      .map(({ slug, billingUserId, funding, creditRecovery }) => ({
        slug,
        billingUserId,
        funding,
        creditRecovery,
      }))
      .sort((left, right) => left.slug.localeCompare(right.slug))
    expect(reviewableFragments).toEqual(
      [
        {
          slug: funded.slug,
          billingUserId: payer.user._id,
          funding: { plan: 'pro' as const, active: true },
          creditRecovery: 'topup' as const,
        },
        {
          slug: ownTrial.slug,
          billingUserId: member.user._id,
          funding: expect.objectContaining({ plan: null, active: true }),
          creditRecovery: 'subscribe' as const,
        },
        {
          slug: trialFunded.slug,
          billingUserId: trialPayer.user._id,
          funding: expect.objectContaining({ plan: null, active: true }),
          creditRecovery: 'subscribe' as const,
        },
      ].sort((left, right) => left.slug.localeCompare(right.slug)),
    )
    expect(JSON.stringify(reviewableFragments)).not.toContain('balanceMicroUsd')
    expect(JSON.stringify(reviewableFragments)).not.toContain('autoTopupEnabled')

    await mutate(convex, 'domains/credits/internal:setTopupConfig', {
      internalKey: INTERNAL_KEY,
      workspaceId: funded._id,
      autoTopupEnabled: true,
    })
    const autoTopup = (await authenticate(session.token, session.prefix, Date.now())) as AuthResult
    expect(creditRecoveryFor(autoTopup, funded._id)).toBeNull()
    await mutate(convex, 'domains/credits/internal:setTopupConfig', {
      internalKey: INTERNAL_KEY,
      workspaceId: funded._id,
      autoTopupEnabled: false,
    })

    const userKey = await issueKey(member.client)
    const keyed = (await authenticate(userKey.key, userKey.prefix, Date.now())) as AuthResult
    expect(fundingFor(keyed, funded._id)).toEqual({ plan: 'pro', active: true })
    expect(creditRecoveryFor(keyed, funded._id)).toBe('topup')

    const device = await mintHumanDeviceKey(member, 'Funding Laptop')
    const synced = (await authenticate(device.key, device.prefix, Date.now())) as AuthResult
    expect(fundingFor(synced, funded._id)).toEqual({ plan: 'pro', active: true })
    expect(creditRecoveryFor(synced, funded._id)).toBe('topup')

    const vmKey = (await mutatePublic('domains/apiKeys/mutations:mintVmModelKey', {
      internalKey: INTERNAL_KEY,
      workspaceId: funded._id,
      now: Date.now(),
    })) as VmModelKeyResult
    const vm = (await authenticate(vmKey.key!, vmKey.prefix, Date.now())) as AuthResult
    expect(fundingFor(vm, funded._id)).toEqual({ plan: 'pro', active: true })
    expect(creditRecoveryFor(vm, funded._id)).toBe('topup')

    // A lapse is reported to the member by the same object that tells them the
    // workspace stopped being serviced — one payer fact, two consequences.
    await mutate(payer.client, 'testing/workspaces:lapseCurrentUserSyntheticSubscriptionForTest', {
      internalKey: INTERNAL_KEY,
    })
    await mutatePublic('testing/workspaces:reconcileServicingStatusForTest', {
      internalKey: INTERNAL_KEY,
      userId: payer.user._id,
      now: Date.now(),
    })
    const churned = (await authenticate(session.token, session.prefix, Date.now())) as AuthResult
    expect(churned.auth.workspaces).toContainEqual(
      expect.objectContaining({
        id: funded._id,
        funding: { plan: null, active: false },
        creditRecovery: null,
        servicingStatus: 'paused',
      }),
    )
    // The member's own workspace is untouched: funding follows the payer of
    // each workspace, never the reader.
    expect(fundingFor(churned, ownTrial._id)).toMatchObject({ plan: null, active: true })
  })

  test('an unconfigured workspace defaults to the billing owner plan tier', async () => {
    // $200 max plan -> frontier default (David, 2026-07-30). The projection
    // must read the plan from the billing owner's live subscription; nothing
    // is stored on the workspace.
    const maxOwner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('tier-plan-default-owner'),
      'Tier Plan Default Owner',
    )
    await mutate(
      maxOwner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY, plan: 'max' },
    )
    const workspace = (await listMine(maxOwner.client))[0]!.workspace
    const minted = (await mutate(
      maxOwner.client,
      'domains/apiKeys/mutations:mintBrowserSession',
      {},
    )) as BrowserSessionResult

    const authed = (await authenticate(minted.token, minted.prefix, Date.now())) as AuthResult
    expect(authed.auth.workspaces).toContainEqual(
      expect.objectContaining({
        id: workspace._id,
        defaultTier: { effective: 'frontier' },
      }),
    )
  })

  test('browser session rotation shortens old credentials while logout revokes immediately', async () => {
    const browserUser = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('browser-session-lifecycle'),
      'Browser Session Lifecycle',
    )
    const first = (await mutate(
      browserUser.client,
      'domains/apiKeys/mutations:mintBrowserSession',
      {},
    )) as BrowserSessionResult
    const otherUser = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('browser-session-other-user'),
      'Browser Session Other User',
    )
    expect(
      await mutate(otherUser.client, 'domains/apiKeys/mutations:revokeBrowserSession', {
        hashedKey: await hashApiKey(first.token),
      }),
    ).toEqual({ revoked: false })
    expect(
      ((await authenticate(first.token, first.prefix, Date.now())) as AuthResult).ok,
    ).toBeTrue()
    expect(await authenticate(first.token, first.prefix, first.expiresAt)).toEqual({
      ok: false,
      reason: 'expired',
    })
    const rotated = (await mutate(
      browserUser.client,
      'domains/apiKeys/mutations:mintBrowserSession',
      { previousHashedKey: await hashApiKey(first.token) },
    )) as BrowserSessionResult

    expect(
      ((await authenticate(first.token, first.prefix, Date.now())) as AuthResult).ok,
    ).toBeTrue()
    const firstAfterRotation = (await rawApiKeys()).find(key => key.prefix === first.prefix)!
    expect(firstAfterRotation.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000)
    expect(await authenticate(first.token, first.prefix, firstAfterRotation.expiresAt!)).toEqual({
      ok: false,
      reason: 'expired',
    })
    expect(
      ((await authenticate(rotated.token, rotated.prefix, Date.now())) as AuthResult).ok,
    ).toBeTrue()

    expect(
      await mutate(browserUser.client, 'domains/apiKeys/mutations:revokeBrowserSession', {
        hashedKey: await hashApiKey(rotated.token),
      }),
    ).toEqual(expect.objectContaining({ revoked: true }))
    expect(await authenticate(rotated.token, rotated.prefix, Date.now())).toEqual({
      ok: false,
      reason: 'revoked',
    })

    await mutate(browserUser.client, 'domains/apiKeys/mutations:mintBrowserSession', {})
    const rows = (await rawApiKeys()).filter(key => key.userId === browserUser.user._id)
    expect(rows).toContainEqual(
      expect.objectContaining({ prefix: first.prefix, expiresAt: firstAfterRotation.expiresAt }),
    )
    expect(rows.some(key => key.prefix === rotated.prefix)).toBeFalse()
  })

  test('concurrent rotations of one browser session mint a single replacement', async () => {
    // Every proxied request inside the rotation window rotates, and a page
    // load fans out across lambdas that share no memory — so the backend is
    // the only place the burst can be collapsed. One rotation wins; the rest
    // hand back nothing and the proxy keeps the still-valid current token.
    const browserUser = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('browser-session-rotation-burst'),
      'Browser Session Rotation Burst',
    )
    const first = (await mutate(
      browserUser.client,
      'domains/apiKeys/mutations:mintBrowserSession',
      {},
    )) as BrowserSessionResult
    const previousHashedKey = await hashApiKey(first.token)
    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, async () =>
        mutate(browserUser.client, 'domains/apiKeys/mutations:mintBrowserSession', {
          previousHashedKey,
        }),
      ),
    )
    expect(outcomes.map(outcome => outcome.status)).toEqual(Array(6).fill('fulfilled'))
    const results = outcomes.map(outcome =>
      outcome.status === 'fulfilled' ? (outcome.value as BrowserSessionResult | null) : null,
    )
    const winners = results.filter(result => result !== null)
    expect(winners).toHaveLength(1)
    expect(winners[0]!.token).toStartWith('duet_sk_')
    const rowsAfterBurst = (await rawApiKeys()).filter(key => key.userId === browserUser.user._id)
    expect(rowsAfterBurst.map(key => key.prefix).sort()).toEqual(
      [first.prefix, winners[0]!.prefix].sort(),
    )
    const firstAfterBurst = rowsAfterBurst.find(key => key.prefix === first.prefix)!
    expect(firstAfterBurst.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000)

    // A browser still presenting the old cookie once the handoff window has
    // passed never received the winner's Set-Cookie; it must be able to
    // rotate again, without the old credential's grace being extended.
    await mutate(convex, 'testing/apiKeys:ageBrowserSessionRotationForTest', {
      internalKey: INTERNAL_KEY,
      keyPrefix: first.prefix,
      rotatedAt: Date.now() - BROWSER_SESSION_ROTATION_HANDOFF_MS,
    })
    const recovered = (await mutate(
      browserUser.client,
      'domains/apiKeys/mutations:mintBrowserSession',
      { previousHashedKey },
    )) as BrowserSessionResult | null
    expect(recovered?.token).toStartWith('duet_sk_')
    const firstAfterRecovery = (await rawApiKeys()).find(key => key.prefix === first.prefix)!
    expect(firstAfterRecovery.expiresAt).toBe(firstAfterBurst.expiresAt)
  })

  test('every mint in a cold-start burst commits and gets its own credential', async () => {
    // The rotation burst above is collapsed to one winner because a previous
    // key exists to stamp. A browser whose cookie has lapsed presents no
    // previous key, so there is nothing to stamp and nothing to collapse: the
    // page load fans out across lambdas and every one of them must mint. Each
    // of those siblings has to commit, so the mint may not read or write any
    // document another sibling touches (Convex error #1).
    const browserUser = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('browser-session-cold-burst'),
      'Browser Session Cold Burst',
    )
    const outcomes = await Promise.allSettled(
      Array.from({ length: 14 }, async () =>
        mutate(browserUser.client, 'domains/apiKeys/mutations:mintBrowserSession', {}),
      ),
    )
    expect(
      outcomes.map(outcome =>
        outcome.status === 'rejected' ? String(outcome.reason) : 'fulfilled',
      ),
    ).toEqual(Array(14).fill('fulfilled'))
    const minted = outcomes.map(outcome =>
      outcome.status === 'fulfilled' ? (outcome.value as BrowserSessionResult) : null,
    )
    expect(new Set(minted.map(session => session!.prefix)).size).toBe(14)
  })

  test('browser session minting is rate limited per authenticated user', async () => {
    const browserUser = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('browser-session-rate-limit'),
      'Browser Session Rate Limit',
    )
    const remainingInWindow =
      BROWSER_SESSION_MINT_WINDOW_MS - (Date.now() % BROWSER_SESSION_MINT_WINDOW_MS)
    if (remainingInWindow < 2_000) await Bun.sleep(remainingInWindow)
    const now = Date.now()
    const windowStart =
      Math.floor(now / BROWSER_SESSION_MINT_WINDOW_MS) * BROWSER_SESSION_MINT_WINDOW_MS
    const shards = rateLimitShardCount(BROWSER_SESSION_MINT_LIMIT)
    // The budget is spread over counter shards and a mint picks one at random,
    // so "one short of the bound" names no particular shard. Leaving exactly
    // one slot in every shard is the state where the next mint is admitted
    // whichever it lands on, and a full budget the state where none is.
    await mutate(convex, 'testing/apiKeys:setRateLimitForTest', {
      internalKey: INTERNAL_KEY,
      key: browserSessionMintRateLimitKey(browserUser.user._id),
      limit: BROWSER_SESSION_MINT_LIMIT,
      windowStart,
      count: BROWSER_SESSION_MINT_LIMIT - shards,
      updatedAt: now,
    })
    const minted = (await mutate(
      browserUser.client,
      'domains/apiKeys/mutations:mintBrowserSession',
      {},
    )) as BrowserSessionResult
    expect(minted.token).toStartWith('duet_sk_')

    await mutate(convex, 'testing/apiKeys:setRateLimitForTest', {
      internalKey: INTERNAL_KEY,
      key: browserSessionMintRateLimitKey(browserUser.user._id),
      limit: BROWSER_SESSION_MINT_LIMIT,
      windowStart,
      count: BROWSER_SESSION_MINT_LIMIT,
      updatedAt: now,
    })
    await expect(
      mutate(browserUser.client, 'domains/apiKeys/mutations:mintBrowserSession', {}),
    ).rejects.toThrow('Browser session mint rate limit exceeded')
  })

  test('system VM model keys are hidden, idempotent, expiring, and authenticate with the VM scopes', async () => {
    const now = 1_000_000
    const slug = uniqueSlug('vm-model-hidden')
    const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug,
      name: 'VM Model Hidden',
    })) as string
    const beforeKeys = await listApiKeys(owner)
    const minted = (await mutatePublic('domains/apiKeys/mutations:mintVmModelKey', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      now,
    })) as VmModelKeyResult

    expect(minted.key).toStartWith('duet_sk_')
    expect(minted.scopes).toEqual(canonicalVmScopes(slug))
    expect(minted.expiresAt).toBeGreaterThan(now)
    expect(await listApiKeys(owner)).toEqual(beforeKeys)

    const rawKey = (await rawApiKeys()).find(key => key.prefix === minted.prefix)
    expect(rawKey).toMatchObject({
      kind: 'system_vm',
      userId: owner.user._id,
      workspaceIds: [workspaceId],
      scopes: canonicalVmScopes(slug),
      expiresAt: minted.expiresAt,
    })

    const authenticated = (await authenticate(minted.key!, minted.prefix, now + 1)) as AuthResult
    expect(authenticated.ok).toBeTrue()
    expect(authenticated.auth.scopes).toEqual(canonicalVmScopes(slug))
    expect(authenticated.auth.workspaces.map(workspace => workspace.id)).toEqual([workspaceId])

    const second = (await mutatePublic('domains/apiKeys/mutations:mintVmModelKey', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      now: now + 2,
    })) as VmModelKeyResult
    expect(second).toMatchObject({
      key: null,
      prefix: minted.prefix,
      scopes: canonicalVmScopes(slug),
      minted: false,
    })
    expect(
      (await rawApiKeys()).filter(
        key => key.kind === 'system_vm' && key.workspaceIds.some(id => id === workspaceId),
      ),
    ).toHaveLength(1)
  })

  test('exported app keys survive managed redelivery and concurrent issuance respects live capacity', async () => {
    const slug = uniqueSlug('app-export-race')
    const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug,
      name: 'App Export Race',
    })) as string
    const app = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/external',
      command: 'bun run start',
      apiScopes: ['services'],
      slug: 'external',
    })) as { id: string; slug: string }
    const now = Date.now()
    const buildingAgent = (await mutatePublic('domains/apiKeys/mutations:mintVmModelKey', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      now,
    })) as VmModelKeyResult
    const args = {
      internalKey: INTERNAL_KEY,
      workspaceId,
      appSlug: app.slug,
      caller: { hashedKey: await hashApiKey(buildingAgent.key!), keyPrefix: buildingAgent.prefix },
      expiration: 'never',
    }
    const exported = (await mutatePublic('domains/apiKeys/appExports:exportCredential', args)) as {
      credentialId: string
      key: string
      prefix: string
    }
    const firstManaged = (await mutatePublic('domains/apiKeys/mutations:mintAppKey', {
      internalKey: INTERNAL_KEY,
      appId: app.id,
      now,
    })) as AppKeyResult
    const redelivered = (await mutatePublic('domains/apiKeys/mutations:rotateAppKey', {
      internalKey: INTERNAL_KEY,
      appId: app.id,
      now: now + 1,
    })) as AppKeyResult
    expect(await authenticate(firstManaged.key!, firstManaged.prefix, now + 2)).toEqual({
      ok: false,
      reason: 'revoked',
    })
    expect(await authenticate(redelivered.key!, redelivered.prefix, now + 2)).toMatchObject({
      ok: true,
    })
    expect(await authenticate(exported.key, exported.prefix, now + 2)).toMatchObject({ ok: true })
    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        convex.client.mutation(
          makeFunctionReference<'mutation'>('domains/apiKeys/appExports:exportCredential'),
          args,
          { skipQueue: true },
        ),
      ),
    )
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(4)
    const refusal = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(refusal.reason.data).toMatchObject({
      status: 409,
      code: 'app_credential_limit',
      limit: 5,
    })
    const list = (await queryPublic('domains/apiKeys/appExports:listCredentials', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      appSlug: app.slug,
      caller: args.caller,
    })) as { items: Array<{ credentialId: string }> }
    expect(list.items).toHaveLength(5)
    expect(list.items.map(item => item.credentialId)).toContain(exported.credentialId)
    expect(JSON.stringify(list)).not.toContain(exported.key)
  }, 60_000)

  test('app keys store only a hash, stay hidden, and authenticate as their bound app', async () => {
    const now = 1_500_000
    const slug = uniqueSlug('app-key-hidden')
    const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug,
      name: 'App Key Hidden',
    })) as string
    const registered = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/inviter',
      command: 'bun run start',
      apiScopes: ['members'],
      slug: 'inviter',
      now,
    })) as { id: string; slug: string }
    const beforeKeys = await listApiKeys(owner)

    const minted = (await mutatePublic('domains/apiKeys/mutations:mintAppKey', {
      internalKey: INTERNAL_KEY,
      appId: registered.id,
      now,
    })) as AppKeyResult

    expect(minted.key).toStartWith('duet_sk_')
    expect(minted.scopes).toEqual([`ws:${slug}:members`])
    expect(await listApiKeys(owner)).toEqual(beforeKeys)
    const stored = (await rawApiKeys()).find(key => key.prefix === minted.prefix)!
    expect(stored).toMatchObject({
      kind: 'app',
      appId: registered.id,
      userId: owner.user._id,
      workspaceIds: [workspaceId],
      scopes: [`ws:${slug}:members`],
    })
    expect(JSON.stringify(stored)).not.toContain(minted.key!)
    expect(JSON.stringify(registered)).not.toContain(minted.key!)

    const authenticated = (await authenticate(minted.key!, minted.prefix, now + 1)) as AuthResult
    expect(authenticated).toMatchObject({
      ok: true,
      auth: {
        credentialKind: 'app',
        app: { id: registered.id, slug: 'inviter' },
        scopes: [`ws:${slug}:members`],
        workspaces: [{ id: workspaceId }],
      },
    })
    expect(await authenticate(minted.key!, minted.prefix, minted.expiresAt)).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  test('app-key mint is idempotent and rotates stale declared scopes with the workspace creator as actor', async () => {
    const now = 1_600_000
    const slug = uniqueSlug('app-key-rotate')
    const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug,
      name: 'App Key Rotate',
    })) as string
    const registrar = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('app-key-registrar'),
      'App Key Registrar',
    )
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: registrar.user._id,
      role: 'editor',
    })
    const app = (await mutate(registrar.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/worker',
      command: 'bun run start',
      apiScopes: ['files:read'],
      slug: 'worker',
      now,
    })) as { id: string; slug: string }
    const beforeAudit = await auditEvents(owner.client, workspaceId)
    const first = (await mutatePublic('domains/apiKeys/mutations:mintAppKey', {
      internalKey: INTERNAL_KEY,
      appId: app.id,
      now,
    })) as AppKeyResult
    const repeated = (await mutatePublic('domains/apiKeys/mutations:mintAppKey', {
      internalKey: INTERNAL_KEY,
      appId: app.id,
      now: now + 1,
    })) as AppKeyResult
    expect(repeated).toMatchObject({ key: null, prefix: first.prefix, minted: false })

    await mutate(registrar.client, 'domains/apps/model:updateApp', {
      workspaceId,
      slug: app.slug,
      apiScopes: ['members'],
      now: now + 2,
    })
    expect(await authenticate(first.key!, first.prefix, now + 2)).toEqual({
      ok: false,
      reason: 'unknown',
    })
    const rotated = (await mutatePublic('domains/apiKeys/mutations:mintAppKey', {
      internalKey: INTERNAL_KEY,
      appId: app.id,
      now: now + 3,
    })) as AppKeyResult
    expect(rotated).toMatchObject({ minted: true, scopes: [`ws:${slug}:members`] })
    expect(await authenticate(first.key!, first.prefix, now + 4)).toEqual({
      ok: false,
      reason: 'revoked',
    })
    const trail = newAuditEvents(beforeAudit, await auditEvents(owner.client, workspaceId))
    expect(trail.filter(event => event.event.startsWith('api_key.app_key_'))).toEqual([
      expect.objectContaining({
        event: 'api_key.app_key_minted',
        actorId: owner.user._id,
        provenance: expect.objectContaining({
          appId: app.id,
          appSlug: app.slug,
          prefix: first.prefix,
          scopes: [`ws:${slug}:files:read`],
          expiresAt: first.expiresAt,
        }),
      }),
      expect.objectContaining({
        event: 'api_key.app_key_rotated',
        actorId: owner.user._id,
        provenance: expect.objectContaining({
          appId: app.id,
          appSlug: app.slug,
          oldPrefixes: [first.prefix],
          prefix: rotated.prefix,
          scopes: [`ws:${slug}:members`],
          expiresAt: rotated.expiresAt,
        }),
      }),
    ])
    expect(JSON.stringify(trail)).not.toContain(first.key!)
    expect(JSON.stringify(trail)).not.toContain(rotated.key!)
  })

  test('app-key auth rejects deleted rows and forged app bindings', async () => {
    const now = 1_700_000
    const slug = uniqueSlug('app-key-binding')
    const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug,
      name: 'App Key Binding',
    })) as string
    const first = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/first',
      command: 'bun run start',
      apiScopes: ['members'],
      slug: 'first',
      now,
    })) as { id: string; slug: string }
    const otherWorkspaceId = (await mutate(
      owner.client,
      'testing/workspaces:createWorkspaceForTest',
      {
        internalKey: INTERNAL_KEY,
        slug: uniqueSlug('app-key-binding-other'),
        name: 'App Key Binding Other',
      },
    )) as string
    const second = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: otherWorkspaceId,
      path: 'apps/second',
      command: 'bun run start',
      apiScopes: ['members'],
      slug: 'second',
      now,
    })) as { id: string; slug: string }
    const minted = (await mutatePublic('domains/apiKeys/mutations:mintAppKey', {
      internalKey: INTERNAL_KEY,
      appId: first.id,
      now,
    })) as AppKeyResult
    await mutatePublic('testing/apiKeys:replaceApiKeyAppIdForTest', {
      internalKey: INTERNAL_KEY,
      keyPrefix: minted.prefix,
      appId: second.id,
    })
    expect(await authenticate(minted.key!, minted.prefix, now + 1)).toEqual({
      ok: false,
      reason: 'unknown',
    })

    const deletable = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/deletable',
      command: 'bun run start',
      apiScopes: ['members'],
      slug: 'deletable',
      now,
    })) as { id: string; slug: string }
    const deletedKey = (await mutatePublic('domains/apiKeys/mutations:mintAppKey', {
      internalKey: INTERNAL_KEY,
      appId: deletable.id,
      now,
    })) as AppKeyResult
    await mutate(owner.client, 'domains/apps/model:deleteApp', {
      workspaceId,
      slug: deletable.slug,
      now: now + 2,
    })
    expect(await authenticate(deletedKey.key!, deletedKey.prefix, now + 3)).toEqual({
      ok: false,
      reason: 'revoked',
    })
    expect(
      (await auditEvents(owner.client, workspaceId)).findLast(
        event => event.event === 'api_key.app_key_revoked',
      ),
    ).toMatchObject({
      actorId: owner.user._id,
      provenance: {
        appId: deletable.id,
        appSlug: deletable.slug,
        prefix: deletedKey.prefix,
        scopes: [`ws:${slug}:members`],
        expiresAt: deletedKey.expiresAt,
      },
    })
  })

  test('empty declarations mint no app key and admin cannot be declared', async () => {
    const now = 1_800_000
    const slug = uniqueSlug('app-key-ceiling')
    const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug,
      name: 'App Key Ceiling',
    })) as string
    const empty = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/empty',
      command: 'bun run start',
      apiScopes: [],
      slug: 'empty',
      now,
    })) as { id: string }
    expect(
      await mutatePublic('domains/apiKeys/mutations:mintAppKey', {
        internalKey: INTERNAL_KEY,
        appId: empty.id,
        now,
      }),
    ).toBeNull()
    expect(
      (await rawApiKeys()).filter(key => key.kind === 'app' && key.appId === empty.id),
    ).toEqual([])
    await expect(
      mutate(owner.client, 'domains/apps/model:registerApp', {
        workspaceId,
        path: 'apps/admin',
        command: 'bun run start',
        apiScopes: ['admin'],
        slug: 'admin-app',
        now,
      }),
    ).rejects.toThrow()
  })

  test('internal impersonation mint creates an expiring scoped key that authenticates', async () => {
    const now = 3_000_000
    const beforeAudit = await auditEvents(owner.client, firstWorkspace._id)
    const minted = (await mutatePublic('domains/apiKeys/api:mintImpersonationKey', {
      internalKey: INTERNAL_KEY,
      email: owner.user.email.toUpperCase(),
      ttlSeconds: 600,
      now,
    })) as ImpersonationKeyResult

    expect(minted.token).toStartWith('duet_sk_')
    expect(minted.expiresAt).toBe(now + 600_000)
    expect(minted.userId).toBe(owner.user._id)
    expect(minted.workspaceSlug).toBe(firstWorkspace.slug)

    const expectedScopes = workspaceScopes(firstWorkspace.slug)
    const storedScopes = canonicalizeApiKeyScopes(expectedScopes)
    const rawKey = (await rawApiKeys()).find(
      key => key.prefix === minted.token.slice(0, 'duet_sk_'.length + 8),
    )
    expect(rawKey).toMatchObject({
      kind: 'impersonation',
      userId: owner.user._id,
      workspaceIds: [firstWorkspace._id],
      scopes: storedScopes,
      expiresAt: minted.expiresAt,
    })

    const authenticated = (await authenticate(
      minted.token,
      minted.token.slice(0, 'duet_sk_'.length + 8),
      now + 1,
    )) as AuthResult
    expect(authenticated.ok).toBeTrue()
    expect(authenticated.auth.user.id).toBe(owner.user._id)
    const newAudit = newAuditEvents(
      beforeAudit,
      await auditEvents(owner.client, firstWorkspace._id),
    )
    expect(newAudit).toHaveLength(1)
    expect(newAudit[0]).toMatchObject({
      event: 'api_key.impersonation_issued',
      actorId: owner.user._id,
      provenance: {
        actor: 'programmatic-login',
        targetEmail: owner.user.email,
        scopes: expectedScopes,
        expiresAt: minted.expiresAt,
      },
    })

    // The row above records what was minted — one workspace, named scopes, an
    // expiry. What it AUTHENTICATES AS is the user's own session: whoever holds
    // it is browsing as that person, so the payload matches a browser session
    // field for field. `workspaceSlug` at mint time says which workspace to
    // open, not which one the session may see.
    const session = (await mutate(
      owner.client,
      'domains/apiKeys/mutations:mintBrowserSession',
      {},
    )) as BrowserSessionResult
    const viaSession = (await authenticate(session.token, session.prefix, now + 1)) as AuthResult
    expect(viaSession.ok).toBeTrue()
    expect(authenticated.auth).toEqual({
      ...viaSession.auth,
      credentialKind: 'impersonation',
    })
    expect(authenticated.auth.workspaces.map(workspace => workspace.id)).toContain(
      firstWorkspace._id,
    )

    await expect(
      mutatePublic('domains/apiKeys/api:mintImpersonationKey', {
        internalKey: 'wrong-internal-key',
        email: owner.user.email,
        ttlSeconds: 600,
        now,
      }),
    ).rejects.toThrow('Unauthorized API internal key')
  })

  test('staging E2E cleanup revokes only synthetic ordinary keys and finds exact run resources', async () => {
    const runId = `staging-e2e-${crypto.randomUUID()}`
    const email = `${runId}@agentmail.to`
    const syntheticUser = await signInWithMagicLink<UserRow>(convex, email, 'Staging E2E Cleanup')
    await mutate(
      syntheticUser.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
      },
    )
    const initialWorkspace = (await listMine(syntheticUser.client))[0]!.workspace
    const workspaceId = (await mutate(
      syntheticUser.client,
      'testing/workspaces:createWorkspaceForTest',
      {
        internalKey: INTERNAL_KEY,
        slug: uniqueSlug('staging-e2e-cleanup'),
        name: `${runId} workspace`,
      },
    )) as string
    const issued = await issueKey(syntheticUser.client)
    const invite = (await mutate(syntheticUser.client, 'testing/invitations:createForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      email,
      role: 'viewer',
      token: `${crypto.randomUUID()}${crypto.randomUUID()}`,
      now: Date.now(),
    })) as { _id: string }
    const orphans = (await queryPublic('testing/stagingE2e:orphanedResourcesByRunIdForTest', {
      internalKey: INTERNAL_KEY,
      runId,
      emails: [email, email.toUpperCase()],
      workspaceNames: [`${runId}'s Workspace`, `${runId} workspace`],
    })) as {
      users: Array<{ id: string; label: string }>
      workspaces: Array<{ id: string; label: string }>
      invites: Array<{ id: string; label: string }>
    }
    expect(orphans.users).toEqual([{ id: syntheticUser.user._id, label: email }])
    expect(orphans.workspaces).toHaveLength(2)
    expect(orphans.workspaces).toEqual(
      expect.arrayContaining([
        { id: workspaceId, label: `${runId} workspace` },
        {
          id: initialWorkspace._id,
          label: `${runId}'s Workspace`,
        },
      ]),
    )
    expect(orphans.invites).toEqual([{ id: invite._id, label: email }])

    await mutatePublic('testing/stagingE2e:revokeApiKeyByHashForTest', {
      internalKey: INTERNAL_KEY,
      hashedKey: await hashApiKey(issued.key),
      expectedPrefix: issued.prefix,
      expectedOwnerEmail: email,
      now: 2_500_000,
    })
    expect(await authenticate(issued.key, issued.prefix, 2_500_001)).toEqual({
      ok: false,
      reason: 'revoked',
    })

    const ordinaryOwnerKey = await issueKey(owner.client)
    await expect(
      mutatePublic('testing/stagingE2e:revokeApiKeyByHashForTest', {
        internalKey: INTERNAL_KEY,
        hashedKey: await hashApiKey(ordinaryOwnerKey.key),
        expectedPrefix: ordinaryOwnerKey.prefix,
        expectedOwnerEmail: owner.user.email,
      }),
    ).rejects.toThrow('Only staging E2E synthetic identities are allowed')

    const impersonation = (await mutatePublic('domains/apiKeys/api:mintImpersonationKey', {
      internalKey: INTERNAL_KEY,
      email: owner.user.email,
      ttlSeconds: 600,
      now: 2_600_000,
    })) as ImpersonationKeyResult
    const impersonationPrefix = impersonation.token.slice(0, 'duet_sk_'.length + 8)
    await expect(
      mutatePublic('testing/stagingE2e:revokeApiKeyByHashForTest', {
        internalKey: INTERNAL_KEY,
        hashedKey: await hashApiKey(impersonation.token),
        expectedPrefix: 'duet_sk_wrong',
        expectedOwnerEmail: owner.user.email,
      }),
    ).rejects.toThrow('API key cleanup identity mismatch')
    await mutatePublic('testing/stagingE2e:revokeApiKeyByHashForTest', {
      internalKey: INTERNAL_KEY,
      hashedKey: await hashApiKey(impersonation.token),
      expectedPrefix: impersonationPrefix,
      expectedOwnerEmail: owner.user.email,
      now: 2_600_001,
    })
    expect(await authenticate(impersonation.token, impersonationPrefix, 2_600_002)).toEqual({
      ok: false,
      reason: 'revoked',
    })
  })

  test('staging E2E cleanup retires a unique synthetic internal admin identity', async () => {
    const runId = `staging-e2e-${crypto.randomUUID()}`
    const email = `${runId}-admin@duet.so`
    await expect(
      queryPublic('testing/stagingE2e:userByEmailForTest', {
        internalKey: INTERNAL_KEY,
        email: `owner+${runId}@duet.so`,
      }),
    ).rejects.toThrow('Only staging E2E synthetic identities are allowed')
    const syntheticAdmin = await signInWithMagicLink<UserRow>(convex, email, 'Staging E2E Admin')
    const workspace = (await listMine(syntheticAdmin.client))[0]!.workspace

    await mutatePublic('testing/workspaces:deleteWorkspaceByIdForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
    })
    await mutatePublic('testing/stagingE2e:retireUserByEmailForTest', {
      internalKey: INTERNAL_KEY,
      email,
    })

    expect(
      await queryPublic('testing/stagingE2e:userByEmailForTest', {
        internalKey: INTERNAL_KEY,
        email,
      }),
    ).toBeNull()
  })

  test('impersonation mint with createIfMissing creates the account then mints a working key', async () => {
    const now = 4_000_000
    const email = `e2e-${now}@duet-test.local`

    // Unknown email without the create flag is rejected.
    await expect(
      mutatePublic('domains/apiKeys/api:mintImpersonationKey', {
        internalKey: INTERNAL_KEY,
        email,
        ttlSeconds: 600,
        now,
      }),
    ).rejects.toThrow('User not found')

    // With createIfMissing, the real signup path runs: user + first workspace.
    const minted = (await mutatePublic('domains/apiKeys/api:mintImpersonationKey', {
      internalKey: INTERNAL_KEY,
      email,
      ttlSeconds: 600,
      now,
      createIfMissing: true,
      name: 'E2E Test',
    })) as ImpersonationKeyResult
    expect(minted.token).toStartWith('duet_sk_')
    expect(minted.created).toBeTrue()
    expect(minted.workspaceSlug.length).toBeGreaterThan(0)

    // The minted key authenticates as the freshly created user, scoped to its workspace.
    const authenticated = (await authenticate(
      minted.token,
      minted.token.slice(0, 'duet_sk_'.length + 8),
      now + 1,
    )) as AuthResult
    expect(authenticated.ok).toBeTrue()
    expect(authenticated.auth.user.id).toBe(minted.userId)
    // The created user owns exactly the one workspace the key is scoped to.
    expect(authenticated.auth.workspaces).toHaveLength(1)
    const createdWorkspace = authenticated.auth.workspaces[0]!
    expect(
      await queryPublic('testing/workspaces:rawWorkspaceByIdForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: createdWorkspace.id,
      }),
    ).toHaveProperty('onboardedAt')
    expect(authenticated.auth.scopes).toEqual(workspaceScopes(minted.workspaceSlug))

    // Second mint for the same email reuses the account (created=false), even with the flag.
    const again = (await mutatePublic('domains/apiKeys/api:mintImpersonationKey', {
      internalKey: INTERNAL_KEY,
      email,
      ttlSeconds: 600,
      now: now + 10,
      createIfMissing: true,
    })) as ImpersonationKeyResult
    expect(again.created).toBeFalse()
    expect(again.userId).toBe(minted.userId)
  })

  test('minting rotates a pre-backup VM key into the current scope set', async () => {
    const now = 3_500_000
    const slug = uniqueSlug('vm-model-stale-scope')
    const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug,
      name: 'VM Model Stale Scope',
    })) as string
    const minted = (await mutatePublic('domains/apiKeys/mutations:mintVmModelKey', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      now,
    })) as VmModelKeyResult
    // Simulate a key minted before VM credentials gained workspace administration.
    await mutatePublic('testing/apiKeys:replaceApiKeyScopesForTest', {
      internalKey: INTERNAL_KEY,
      keyPrefix: minted.prefix,
      scopes: canonicalVmScopes(slug).filter(scope => !scope.endsWith(':admin')),
    })
    const reminted = (await mutatePublic('domains/apiKeys/mutations:mintVmModelKey', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      now: now + 1_000,
    })) as VmModelKeyResult
    expect(reminted.minted).toBe(true)
    expect(reminted.scopes).toEqual(canonicalVmScopes(slug))
    expect(await authenticate(minted.key!, minted.prefix, now + 2_000)).toEqual({
      ok: false,
      reason: 'revoked',
    })
  })

  test('system VM model key rotate and revoke kill old hashes and write exact audit transitions', async () => {
    const slug = uniqueSlug('vm-model-key')
    const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug,
      name: 'VM Model Key',
    })) as string
    const beforeAudit = await auditEvents(owner.client, workspaceId)
    const minted = (await mutatePublic('domains/apiKeys/mutations:mintVmModelKey', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      now: 2_000_000,
    })) as VmModelKeyResult
    const rotated = (await mutatePublic('domains/apiKeys/mutations:rotateVmModelKey', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      now: 2_001_000,
    })) as VmModelKeyResult

    expect(await authenticate(minted.key!, minted.prefix, 2_001_001)).toEqual({
      ok: false,
      reason: 'revoked',
    })
    const rotatedAuth = (await authenticate(rotated.key!, rotated.prefix, 2_001_001)) as AuthResult
    expect(rotatedAuth.ok).toBeTrue()
    expect(rotatedAuth.auth.scopes).toEqual(canonicalVmScopes(slug))

    await mutatePublic('domains/apiKeys/mutations:revokeVmModelKey', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      now: 2_002_000,
    })
    expect(await authenticate(rotated.key!, rotated.prefix, 2_002_001)).toEqual({
      ok: false,
      reason: 'revoked',
    })

    const newAudit = newAuditEvents(beforeAudit, await auditEvents(owner.client, workspaceId))
    expect(newAudit.map(event => event.event)).toEqual([
      'api_key.vm_model_key_minted',
      'api_key.vm_model_key_rotated',
      'api_key.vm_model_key_revoked',
    ])
    expect(newAudit.map(event => event.actorId)).toEqual([
      owner.user._id,
      owner.user._id,
      owner.user._id,
    ])
    expect(newAudit[0]!.provenance).toMatchObject({
      prefix: minted.prefix,
      scopes: canonicalVmScopes(slug),
      expiresAt: minted.expiresAt,
    })
    expect(newAudit[1]!.provenance).toMatchObject({
      oldPrefixes: [minted.prefix],
      prefix: rotated.prefix,
      scopes: canonicalVmScopes(slug),
      expiresAt: rotated.expiresAt,
    })
    expect(newAudit[2]!.provenance).toMatchObject({
      prefixes: [rotated.prefix],
      scopes: canonicalVmScopes(slug),
    })
  })

  test('one human key follows viewer, editor, and removed membership', async () => {
    const roaming = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('human-device-roaming'),
      'Human Device Roaming',
    )
    const personal = (await listMine(roaming.client))[0]!.workspace
    const key = await mintHumanDeviceKey(roaming, 'Roaming Laptop')

    // The same human key observes changes to the person's current role.
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: firstWorkspace._id,
      userId: roaming.user._id,
      role: 'viewer',
    })
    const asViewer = (await authenticate(key.key, key.prefix, Date.now())) as AuthResult
    expect(asViewer.auth.workspaces.map(workspace => workspace.id)).toContain(firstWorkspace._id)
    expect(asViewer.auth.scopes).toContain(`ws:${firstWorkspace.slug}:files:read`)
    expect(asViewer.auth.scopes).not.toContain(`ws:${firstWorkspace.slug}:files:write`)

    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: firstWorkspace._id,
      userId: roaming.user._id,
      role: 'editor',
    })
    const asEditor = (await authenticate(key.key, key.prefix, Date.now())) as AuthResult
    expect(asEditor.auth.scopes).toContain(`ws:${firstWorkspace.slug}:files:write`)

    await mutate(owner.client, 'domains/workspaces/mutations:removeMember', {
      workspaceId: firstWorkspace._id,
      userId: roaming.user._id,
    })
    const removed = (await authenticate(key.key, key.prefix, Date.now())) as AuthResult
    expect(removed.auth.workspaces.map(workspace => workspace.id)).toEqual([personal._id])
    expect(
      removed.auth.scopes.every(scope => !scope.startsWith(`ws:${firstWorkspace.slug}:`)),
    ).toBeTrue()
  })

  test('named human-key revocation is immediate inside the last-used throttle window', async () => {
    const person = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('human-key-revoke'),
      'Human Key Revocation',
    )
    const first = await mintHumanDeviceKey(person, 'Duet CLI')
    const second = await issueKey(person.client, { name: 'Automation' })
    const listed = await listApiKeys(person)
    const revoked = listed.find(row => row.prefix === first.prefix)!
    expect(listed.find(row => row.prefix === second.prefix)?.name).toBe('Automation')
    const now = Date.now()
    expect(((await authenticate(first.key, first.prefix, now)) as AuthResult).ok).toBeTrue()
    await mutatePublic('domains/apiKeys/userApi:revoke', {
      internalKey: INTERNAL_KEY,
      actorId: person.user._id,
      keyId: revoked.id,
      now: now + 1,
    })
    expect(await authenticate(first.key, first.prefix, now + 2)).toEqual({
      ok: false,
      reason: 'revoked',
    })
    expect(((await authenticate(second.key, second.prefix, now + 3)) as AuthResult).ok).toBeTrue()
    expect((await listApiKeys(person)).find(row => row.id === revoked.id)?.revokedAt).toBe(now + 1)
    expect(
      (await listApiKeys(person)).find(row => row.prefix === second.prefix)?.revokedAt,
    ).toBeUndefined()
  })

  // The endpoint argument is a bare `v.string()` on purpose — the vocabulary
  // lives in @repo/contract. Fire the names at the real mutation, because a
  // closed validator would reject them at runtime with every type-check green.
  test('accepts every contract pre-auth endpoint and refuses a name outside it', async () => {
    const identityHash = await hashApiKey(`email:${uniqueEmail('preauth')}`)
    const now = 4_000_000
    const consume = (endpoint: string): Promise<unknown> =>
      mutatePublic('domains/apiKeys/api:consumePreAuthRateLimit', {
        internalKey: INTERNAL_KEY,
        identityHash,
        endpoint,
        limit: 1,
        windowMs: 60_000,
        now,
      })

    for (const endpoint of PRE_AUTH_RATE_LIMIT_ENDPOINTS) {
      // A fresh bucket per endpoint on one identity: separate keys, not a shared count.
      expect(await consume(endpoint), endpoint).toMatchObject({ ok: true, remaining: 0 })
    }
    expect(await consume('auth_email_start')).toMatchObject({ ok: false })
    await expect(consume('auth_email')).rejects.toThrow(
      'Unknown pre-auth rate-limit endpoint: auth_email',
    )
  })
})

async function mintHumanDeviceKey(
  user: SignedInUser,
  clientName: string,
): Promise<{ key: string; prefix: string }> {
  const device = (await convex.mutation('domains/apiKeys/mutations:createDeviceCode', {
    clientName,
  })) as DeviceCodeResponse
  await approveDeviceCode(user, device.user_code)
  const poll = (await convex.mutation('domains/apiKeys/api:pollDeviceCode', {
    internalKey: INTERNAL_KEY,
    deviceCode: device.device_code,
    now: Date.now(),
  })) as { status: string; key: string; prefix: string }
  if (poll.status !== 'approved') throw new Error(`human device poll: ${poll.status}`)
  return { key: poll.key, prefix: poll.prefix }
}

async function listMine(client: ConvexHttpClient): Promise<WorkspaceRow[]> {
  return (await query(client, 'domains/workspaces/queries:listMine', {})) as WorkspaceRow[]
}

async function revokeApiKey(user: SignedInUser, keyId: string): Promise<unknown> {
  return await mutatePublic('domains/apiKeys/userApi:revoke', {
    internalKey: INTERNAL_KEY,
    actorId: user.user._id,
    keyId,
    now: Date.now(),
  })
}

async function approveDeviceCode(user: SignedInUser, userCode: string): Promise<unknown> {
  return await mutatePublic('domains/apiKeys/deviceApi:approve', {
    internalKey: INTERNAL_KEY,
    actorId: user.user._id,
    userCode,
    now: Date.now(),
  })
}

async function listApiKeys(user: SignedInUser): Promise<ListedKey[]> {
  const result = (await queryPublic('domains/apiKeys/userApi:list', {
    internalKey: INTERNAL_KEY,
    actorId: user.user._id,
    paginationOpts: { cursor: null, numItems: 100 },
  })) as { page: ListedKey[] }
  return result.page
}

async function rawApiKeys(): Promise<RawApiKey[]> {
  return (await queryPublic('testing/apiKeys:rawApiKeysForTest', {
    internalKey: INTERNAL_KEY,
  })) as RawApiKey[]
}

// The API's authentication, as the API issues it: resolve and record asked
// together, a credential that does not resolve refused before its budget is.
async function authenticate(key: string, prefix: string, now: number): Promise<unknown> {
  const hashedKey = await hashApiKey(key)
  const [resolved, recorded] = await Promise.all([
    queryPublic('domains/apiKeys/api:resolveCredential', {
      internalKey: INTERNAL_KEY,
      hashedKey,
      keyPrefix: prefix,
      now,
    }) as Promise<{ ok: boolean }>,
    mutatePublic('domains/apiKeys/api:recordCredentialUse', {
      internalKey: INTERNAL_KEY,
      hashedKey,
      now,
    }) as Promise<{ ok: boolean }>,
  ])
  if (!resolved.ok) return resolved
  if (!recorded.ok) return recorded
  return resolved
}

async function prepareWorkspaceForRegistration(
  user: SignedInUser,
  workspace: WorkspaceRow['workspace'],
) {
  const now = Date.now()
  await mutatePublic('testing/workspaces:prepareWorkspaceForRegistration', {
    internalKey: INTERNAL_KEY,
    actorId: user.user._id,
    workspaceId: workspace._id,
    slug: workspace.slug,
    name: 'Provisioning auth fixture',
    imageRef: 'ttl.sh/duet-auth-slice-1:1h',
    provisioningTokenHash: await hashApiKey(`provisioning-${workspace._id}`),
    provisioningTokenExpiresAt: now + 60_000,
    now,
  })
}

async function createWorkspace(
  user: SignedInUser,
  slugPrefix: string,
): Promise<WorkspaceRow['workspace']> {
  await mutate(user.client, 'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest', {
    internalKey: INTERNAL_KEY,
  })
  const slug = uniqueSlug(slugPrefix)
  const workspaceId = (await mutate(user.client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug,
    name: `${slugPrefix} fixture`,
  })) as Doc<'workspaces'>['_id']
  return { _id: workspaceId, slug }
}

async function makeWorkspaceTerminal(
  user: SignedInUser,
  workspace: WorkspaceRow['workspace'],
  status: 'retired' | 'deleted',
): Promise<void> {
  if (status === 'deleted') {
    await mutate(user.client, 'domains/workspaces/mutations:deleteWorkspace', {
      workspaceId: workspace._id,
    })
    return
  }
  await mutatePublic('domains/workspaces/provisioning:markRetired', {
    internalKey: INTERNAL_KEY,
    workspaceId: workspace._id,
    now: Date.now(),
  })
}

async function auditEvents(client: ConvexHttpClient, workspaceId: string): Promise<AuditRow[]> {
  return (await query(client, 'domains/workspaces/queries:getAuditEvents', {
    workspaceId,
  })) as AuditRow[]
}

function newAuditEvents(before: AuditRow[], after: AuditRow[]): AuditRow[] {
  const existingIds = new Set(before.map(event => event.id))
  return after.filter(event => !existingIds.has(event.id))
}

function mutatePublic(name: string, args: Record<string, unknown>): Promise<unknown> {
  return convex.mutation(name, args)
}

function queryPublic(name: string, args: Record<string, unknown>): Promise<unknown> {
  return convex.query(name, args)
}

// The uniqueness suffix is 15+ characters, so a descriptive prefix silently
// pushed slugs past MAX_SLUG_LENGTH once the sequence reached two digits —
// which made ADDING a test fail unrelated tests. Trim the prefix to whatever
// the limit leaves rather than rationing prefix length by hand.
function uniqueSlug(prefix: string): string {
  sequence += 1
  const suffix = `-${Date.now()}-${sequence}`
  return `${prefix.slice(0, MAX_SLUG_LENGTH - suffix.length)}${suffix}`
}

interface SignedInUser {
  client: ConvexHttpClient
  user: UserRow
}

interface UserRow {
  _id: Doc<'users'>['_id']
  email: string
}

interface WorkspaceRow {
  workspace: {
    _id: Doc<'workspaces'>['_id']
    slug: string
  }
}

interface ListedKey {
  id: string
  name?: string
  prefix: string
  revokedAt?: number
}

type RawApiKey = Doc<'apiKeys'>

interface BrowserSessionResult {
  token: string
  prefix: string
  expiresAt: number
}

interface VmModelKeyResult {
  key: string | null
  prefix: string
  scopes: string[]
  expiresAt: number
  minted: boolean
}

interface AppKeyResult extends VmModelKeyResult {}

interface ImpersonationKeyResult {
  token: string
  expiresAt: number
  userId: string
  workspaceSlug: string
  created: boolean
}

type AuthResult = {
  ok: true
  auth: {
    credentialKind?: string
    credentialId?: string
    audience?: string
    user: { id: string }
    scopes: string[]
    workspaces: Array<{
      id: string
      role: 'owner' | 'editor' | 'viewer'
      slug: string
      billingUserId: string
      servicingStatus: string
      funding: WorkspaceFunding
      creditRecovery: WorkspaceCreditRecovery
    }>
  }
}

function fundingFor(result: AuthResult, workspaceId: string): WorkspaceFunding | undefined {
  return result.auth.workspaces.find(workspace => workspace.id === workspaceId)?.funding
}

function creditRecoveryFor(
  result: AuthResult,
  workspaceId: string,
): WorkspaceCreditRecovery | undefined {
  return result.auth.workspaces.find(workspace => workspace.id === workspaceId)?.creditRecovery
}

async function setBalanceForRecoveryFixture(
  userId: string,
  workspaceId: string,
  balanceMicroUsd: number,
): Promise<void> {
  const wallet = (await query(convex, 'testing/credits:walletForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as { balanceMicroUsd: number }
  await mutate(convex, 'testing/credits:applyAccountAdjustmentForTest', {
    internalKey: INTERNAL_KEY,
    userId,
    amountMicroUsd: balanceMicroUsd - wallet.balanceMicroUsd,
    reference: `adjustment:credit-recovery:${userId}:${workspaceId}`,
    now: Date.now(),
  })
}

/**
 * The authorization a credential carries — the part a throttle, a repeat call,
 * or a replay must never change. The full payload also embeds live workspace
 * projections (lifecycle `status`, a `defaultTier` computed from `Date.now()`),
 * which a provisioning watchdog moves on wall-clock and which no key mutation
 * owns. Deep-equalling whole payloads across calls pulls those in and fails
 * whenever the run is merely slow, so compare through this instead.
 */
function authorization(result: unknown): unknown {
  const { ok, auth } = result as AuthResult
  return {
    ok,
    credentialKind: auth.credentialKind,
    credentialId: auth.credentialId,
    audience: auth.audience,
    user: auth.user,
    scopes: auth.scopes,
    workspaces: auth.workspaces.map(workspace => ({
      id: workspace.id,
      role: workspace.role,
    })),
  }
}

interface AuditRow {
  id: string
  event: string
  actorId: string
  provenance?: Record<string, unknown>
}

interface DeviceCodeResponse {
  device_code: string
  user_code: string
}
