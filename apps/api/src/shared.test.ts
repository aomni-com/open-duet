import { describe, expect, test } from 'bun:test'

import { Hono } from 'hono'

import {
  API_VERSION,
  X_DUET_GATEWAY_CODE_HEADER,
  X_DUET_GATEWAY_HEADER,
  type ApiCredentialKind,
  type Capability,
} from '@repo/contract'

import {
  appHref,
  requireHumanActor,
  requireBrowserSession,
  requireAuthedWorkspace,
  requirePreflightedSpendWorkspace,
  requireWorkspaceFromKey,
  type ApiContext,
  type ApiRouteRuntime,
  type ApiVariables,
  type AuthPayload,
  type WorkspaceRef,
} from './shared'

describe('product app links', () => {
  test('constructs callback paths from the configured app origin', () => {
    expect(appHref('https://app-staging.duet.so/', '/settings/billing?from=checkout')).toBe(
      'https://app-staging.duet.so/settings/billing?from=checkout',
    )
  })

  test('rejects raw origins and parser attacks', () => {
    for (const path of ['https://evil.example', '//evil.example', 'settings', '/\\evil']) {
      expect(() => appHref('https://app.duet.so', path)).toThrow()
    }
  })
})

describe('keyed workspace selection', () => {
  test('honors an authorized hint, infers a sole workspace, and marks ambiguity', async () => {
    const alpha = workspace('alpha')
    const beta = workspace('beta')

    const explicit = await workspaceSelectionResponse(auth([alpha, beta]), 'beta')
    expect(explicit.status).toBe(200)
    expect(await explicit.json()).toEqual({ id: 'workspace-beta', slug: 'beta', role: 'owner' })

    const inferred = await workspaceSelectionResponse(auth([alpha]))
    expect(inferred.status).toBe(200)
    expect(await inferred.json()).toEqual({ id: 'workspace-alpha', slug: 'alpha', role: 'owner' })

    const ambiguous = await workspaceSelectionResponse(auth([alpha, beta]))
    expect(ambiguous.status).toBe(403)
    expect(await ambiguous.json()).toEqual({
      error: 'Specify a workspace granted by this API key.',
      code: 'workspace_ambiguous',
    })
    expect(ambiguous.headers.get(X_DUET_GATEWAY_HEADER)).toBe('block')
    expect(ambiguous.headers.get(X_DUET_GATEWAY_CODE_HEADER)).toBe('workspace_ambiguous')
  })

  test('rejects an explicit workspace hint that the key does not grant', async () => {
    const response = await workspaceSelectionResponse(auth([workspace('alpha')]), 'beta')

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: 'Specify a workspace granted by this API key.',
      code: 'workspace_ambiguous',
    })
    expect(response.headers.get(X_DUET_GATEWAY_HEADER)).toBe('block')
    expect(response.headers.get(X_DUET_GATEWAY_CODE_HEADER)).toBe('workspace_ambiguous')
  })

  test('requires the selected workspace capability and honors admin as wildcard', async () => {
    const alpha = workspace('alpha')
    const blocked = await workspaceSelectionResponse(auth([alpha], 'files:read'))
    expect(blocked.status).toBe(403)
    expect(await blocked.json()).toEqual({
      error: 'insufficient_scope',
      scope: 'ws:alpha:services',
    })

    const exact = await workspaceSelectionResponse(auth([alpha], 'services'))
    expect(exact.status).toBe(200)
    const admin = await workspaceSelectionResponse(auth([alpha], 'admin'))
    expect(admin.status).toBe(200)
  })
})

describe('workspace onboarding admission', () => {
  test('refuses incomplete workspaces with a stable retry URL', async () => {
    const app = new Hono<{ Variables: ApiVariables }>()
    app.use('*', async (c, next) => {
      c.set('auth', {
        ...auth([{ ...workspace('acme'), onboardedAt: undefined }]),
        scopes: ['ws:acme:sessions'],
      })
      await next()
    })
    app.get('/v1/ws/:workspaceSlug/agent/sessions', c => {
      const selected = requireAuthedWorkspace(c, 'sessions')
      return 'response' in selected ? selected.response : c.json(selected)
    })

    const response = await app.request('/v1/ws/acme/agent/sessions')

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'onboarding_required',
      code: 'onboarding_required',
      onboardingUrl: '/w/acme/onboarding',
    })
  })

  test('keeps the exact onboarding exception available', async () => {
    const app = new Hono<{ Variables: ApiVariables }>()
    app.use('*', async (c, next) => {
      c.set('auth', {
        ...auth([{ ...workspace('acme'), onboardedAt: undefined }]),
        scopes: ['ws:acme:agents'],
      })
      await next()
    })
    app.post('/v1/ws/:workspaceSlug/onboarding/recommendations', c => {
      const selected = requireAuthedWorkspace(c, 'agents', { allowIncomplete: true })
      return 'response' in selected ? selected.response : c.json(selected)
    })

    const response = await app.request('/v1/ws/acme/onboarding/recommendations', {
      method: 'POST',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: 'workspace-acme', slug: 'acme', role: 'owner' })
  })

  test('admits a completed workspace through the normal path', async () => {
    const app = new Hono<{ Variables: ApiVariables }>()
    app.use('*', async (c, next) => {
      c.set('auth', {
        ...auth([{ ...workspace('acme'), onboardedAt: 1_700_000_000_000 }]),
        scopes: ['ws:acme:sessions'],
      })
      await next()
    })
    app.get('/v1/ws/:workspaceSlug/agent/sessions', c => {
      const selected = requireAuthedWorkspace(c, 'sessions')
      return 'response' in selected ? selected.response : c.json(selected)
    })

    const response = await app.request('/v1/ws/acme/agent/sessions')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: 'workspace-acme', slug: 'acme', role: 'owner' })
  })
})

describe('spend preflight', () => {
  test('returns marked gateway blocks for credit and cap decisions', async () => {
    const subscriptionRequired = await preflightResponse({
      proceed: false,
      reason: 'subscription_required',
      balanceMicroUsd: 5_000_000,
    })
    expect(subscriptionRequired.status).toBe(402)
    expect(await subscriptionRequired.json()).toEqual({
      error: 'subscription_required',
      code: 'subscription_required',
      billingUrl: 'https://app.duet.so/settings/billing',
    })
    expect(subscriptionRequired.headers.get(X_DUET_GATEWAY_HEADER)).toBe('block')
    expect(subscriptionRequired.headers.get(X_DUET_GATEWAY_CODE_HEADER)).toBe(
      'subscription_required',
    )

    const insufficient = await preflightResponse({
      proceed: false,
      reason: 'insufficient_credits',
      balanceMicroUsd: 125_000,
    })
    expect(insufficient.status).toBe(402)
    expect(await insufficient.json()).toEqual({
      error: 'insufficient_credits',
      code: 'insufficient_credits',
      tier: 'account',
      balanceMicroUsd: 125_000,
      autoTopupScheduled: false,
      billingUrl: 'https://app.duet.so/settings/billing',
    })
    expect(insufficient.headers.get(X_DUET_GATEWAY_HEADER)).toBe('block')
    expect(insufficient.headers.get(X_DUET_GATEWAY_CODE_HEADER)).toBe('insufficient_credits')

    const capped = await preflightResponse({
      proceed: false,
      reason: 'monthly_cap',
      tier: 'workspace',
      balanceMicroUsd: 900_000,
    })
    expect(capped.status).toBe(402)
    expect(await capped.json()).toEqual({
      error: 'monthly_cap',
      code: 'monthly_cap',
      tier: 'workspace',
      balanceMicroUsd: 900_000,
      autoTopupScheduled: false,
      billingUrl: 'https://app.duet.so/settings/billing',
    })
    expect(capped.headers.get(X_DUET_GATEWAY_HEADER)).toBe('block')
    expect(capped.headers.get(X_DUET_GATEWAY_CODE_HEADER)).toBe('monthly_cap')
  })

  test('returns marked gateway blocks for paused and banned workspaces', async () => {
    const paused = await preflightResponse({ proceed: true, balanceMicroUsd: 2_000_000 }, 'paused')
    expect(paused.status).toBe(402)
    expect(await paused.json()).toEqual({
      error: 'subscription_inactive',
      code: 'subscription_inactive',
      billingUrl: 'https://app.duet.so/settings/billing',
    })
    expect(paused.headers.get(X_DUET_GATEWAY_HEADER)).toBe('block')
    expect(paused.headers.get(X_DUET_GATEWAY_CODE_HEADER)).toBe('subscription_inactive')

    const banned = await preflightResponse({ proceed: true, balanceMicroUsd: 2_000_000 }, 'banned')
    expect(banned.status).toBe(402)
    expect(await banned.json()).toEqual({
      error: 'payment_required',
      code: 'payment_required',
      billingUrl: 'https://app.duet.so/settings/billing',
    })
    expect(banned.headers.get(X_DUET_GATEWAY_HEADER)).toBe('block')
    expect(banned.headers.get(X_DUET_GATEWAY_CODE_HEADER)).toBe('payment_required')
  })
})

describe('human account admission', () => {
  const kinds = [
    'browser_session',
    'impersonation',
    'user',
    'app',
    'system_vm',
    'oauth',
  ] as const satisfies readonly ApiCredentialKind[]

  test('admits a user key alongside the product tab, and nothing else', async () => {
    const admitted: Record<string, number> = {}
    for (const kind of kinds) {
      const response = await railResponse(requireHumanActor, kind)
      admitted[kind] = response.status
      if (response.status === 403) {
        // Never `browser_session_required`: an agent holding a good user key
        // must not be sent looking for a browser it does not have.
        expect(await response.json()).toEqual({ error: 'human_credential_required' })
      }
    }

    expect(admitted).toEqual({
      browser_session: 200,
      impersonation: 200,
      user: 200,
      app: 403,
      system_vm: 403,
      oauth: 403,
    })
  })

  test('leaves the tab-only rail exactly where it was', async () => {
    for (const kind of kinds) {
      const response = await railResponse(requireBrowserSession, kind)
      const tabOnly = kind === 'browser_session' || kind === 'impersonation'
      expect(response.status).toBe(tabOnly ? 200 : 403)
      if (!tabOnly) expect(await response.json()).toEqual({ error: 'browser_session_required' })
    }
  })
})

async function railResponse(
  gate: (c: ApiContext) => { userId: string } | { response: Response },
  credentialKind: ApiCredentialKind,
): Promise<Response> {
  const app = new Hono<{ Variables: ApiVariables }>()
  app.use('*', async (c, next) => {
    c.set('auth', { ...auth([]), credentialKind })
    await next()
  })
  app.get('/rail', c => {
    const actor = gate(c)
    return 'response' in actor ? actor.response : c.json({ userId: actor.userId })
  })
  return await app.request('/rail')
}

function workspace(slug: string): AuthPayload['workspaces'][number] {
  return {
    id: `workspace-${slug}`,
    slug,
    name: slug,
    status: 'active',
    servicingStatus: 'active',
    onboardedAt: 1,
    role: 'owner',
    billingUserId: 'billing-user',
    funding: { plan: null, active: true },
    creditRecovery: null,
    defaultTier: { effective: 'balanced' },
  }
}

function auth(
  workspaces: AuthPayload['workspaces'],
  capability: Capability = 'services',
): AuthPayload {
  return {
    credentialKind: 'user',
    user: { id: 'user', email: 'user@example.com' },
    workspaces,
    scopes: workspaces.map(item => `ws:${item.slug}:${capability}`),
    versions: API_VERSION,
  }
}

async function workspaceSelectionResponse(
  payload: AuthPayload,
  explicitSlug?: string,
): Promise<Response> {
  const app = new Hono<{ Variables: ApiVariables }>()
  app.use('*', async (c, next) => {
    c.set('auth', payload)
    await next()
  })
  app.get('/workspace', c => {
    const selected = requireWorkspaceFromKey(c, 'services', explicitSlug)
    return 'response' in selected ? selected.response : c.json(selected)
  })
  return app.request('/workspace')
}

async function preflightResponse(
  decision: {
    proceed: boolean
    reason?: 'subscription_required' | 'insufficient_credits' | 'monthly_cap'
    tier?: 'account' | 'workspace'
    balanceMicroUsd: number
  },
  servicingStatus: 'active' | 'paused' | 'banned' = 'active',
): Promise<Response> {
  const payload = auth([workspace('alpha')])
  const selected: WorkspaceRef = { id: 'workspace-alpha', slug: 'alpha', role: 'owner' }
  const runtime = {
    convex: {
      query: async () => ({ servicingStatus }),
      mutation: async () => decision,
    },
    internalKey: 'internal',
    apiInternalKey: 'api-internal',
    fetchImpl: fetch,
    now: () => 123,
    appUrl: 'https://app.duet.so',
  } as unknown as ApiRouteRuntime
  const app = new Hono<{ Variables: ApiVariables }>()
  app.use('*', async (c, next) => {
    c.set('auth', payload)
    await next()
  })
  app.get('/preflight', async c => {
    const result = await requirePreflightedSpendWorkspace(c, runtime, selected)
    return 'response' in result ? result.response : c.json(result)
  })
  return app.request('/preflight')
}
