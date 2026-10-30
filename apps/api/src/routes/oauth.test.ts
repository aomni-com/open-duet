import { describe, expect, test } from 'bun:test'

import { Hono } from 'hono'

import {
  AuthorizationServerMetadataSchema,
  CAPABILITIES,
  DynamicClientRegistrationResponseSchema,
  MAX_OAUTH_AUTHORIZATION_STATE_UTF8_BYTES,
} from '@repo/contract'

import type { ApiRouteRuntime, ApiVariables } from '../shared'
import { registerOAuthRoutes } from './oauth'

describe('OAuth registration and discovery routes', () => {
  test('forwards a valid authorization request and hands the browser only its opaque id', async () => {
    const { app, mutations } = routeFixture()
    const response = await app.request(
      `/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: 'duet_client_fixture',
        redirect_uri: 'http://127.0.0.1:43191/callback?exact=1',
        scope: 'files:read memory',
        state: 'unchanged-client-state',
        resource: 'https://mcp-staging.duet.so/',
        code_challenge: 'A'.repeat(43),
        code_challenge_method: 'S256',
      })}`,
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      'https://app-staging.duet.so/oauth/authorize?request=oauth_request_fixture',
    )
    expect(response.headers.get('location')).not.toContain('redirect_uri')
    expect(mutations.find(call => call.clientId === 'duet_client_fixture')).toMatchObject({
      clientName: 'MCP client',
      redirectUri: 'http://127.0.0.1:43191/callback?exact=1',
      state: 'unchanged-client-state',
      capabilities: ['files:read', 'memory'],
      resource: 'https://mcp-staging.duet.so/',
      codeChallenge: 'A'.repeat(43),
    })
  })

  test('forwards authorization-code binding and returns the backend token envelope', async () => {
    const { app, mutations } = routeFixture()
    const response = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'duet_ac_fixture',
        redirect_uri: 'http://127.0.0.1:43191/callback?exact=1',
        client_id: 'duet_client_fixture',
        code_verifier: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~',
        resource: 'https://mcp-staging.duet.so/',
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      access_token: 'duet_sk_oauth_fixture',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'duet_rt_fixture',
      scope: 'files:read memory',
    })
    expect(mutations.find(call => call.code === 'duet_ac_fixture')).toMatchObject({
      clientId: 'duet_client_fixture',
      redirectUri: 'http://127.0.0.1:43191/callback?exact=1',
      resource: 'https://mcp-staging.duet.so/',
      codeVerifier: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~',
    })
  })

  test('returns only the trusted authorization snapshot to a browser session', async () => {
    const { app } = routeFixture()
    const response = await app.request('/v1/oauth/authorization/oauth_request_fixture')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'pending',
      client: { id: 'duet_client_fixture', name: 'MCP client' },
      redirect: { hostname: '127.0.0.1', localhost: true },
      capabilities: ['files:read', 'memory'],
      workspaces: [{ slug: 'personal', name: 'Personal', role: 'owner' }],
      expiresAt: 310_000,
    })
  })

  test('approval and denial return only server-built redirect envelopes', async () => {
    const { app, mutations } = routeFixture()
    const approved = await app.request('/v1/oauth/authorization/oauth_request_fixture/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceSlug: 'personal' }),
    })
    const denied = await app.request('/v1/oauth/authorization/oauth_request_fixture/deny', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

    expect(await approved.json()).toEqual({
      redirectUrl:
        'http://127.0.0.1:43191/callback?exact=1&code=duet_ac_fixture&state=unchanged-client-state',
    })
    expect(await denied.json()).toEqual({
      redirectUrl:
        'http://127.0.0.1:43191/callback?exact=1&error=access_denied&state=unchanged-client-state',
    })
    expect(mutations.filter(call => call.requestId === 'oauth_request_fixture')).toEqual([
      expect.objectContaining({ workspaceSlug: 'personal', actorId: 'user_fixture' }),
      expect.objectContaining({ actorId: 'user_fixture' }),
    ])
  })

  test('redirects protocol errors only after the exact registered redirect is trusted', async () => {
    const { app } = routeFixture()
    const safeError = await app.request(
      `/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: 'duet_client_fixture',
        redirect_uri: 'http://127.0.0.1:43191/callback?exact=1',
        scope: 'not-a-capability',
        state: 'round-trip-state',
        resource: 'https://mcp-staging.duet.so/',
        code_challenge: 'A'.repeat(43),
        code_challenge_method: 'S256',
      })}`,
    )
    const unsafeError = await app.request(
      `/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: 'duet_client_fixture',
        redirect_uri: 'https://attacker.example/callback',
        scope: 'files:read',
        state: 'must-not-leak',
        resource: 'https://mcp-staging.duet.so/',
        code_challenge: 'A'.repeat(43),
        code_challenge_method: 'S256',
      })}`,
    )
    const plainPkce = await app.request(
      `/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: 'duet_client_fixture',
        redirect_uri: 'http://127.0.0.1:43191/callback?exact=1',
        scope: 'files:read',
        state: 'pkce-state',
        resource: 'https://mcp-staging.duet.so/',
        code_challenge: 'A'.repeat(43),
        code_challenge_method: 'plain',
      })}`,
    )
    const missingPkce = await app.request(
      `/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: 'duet_client_fixture',
        redirect_uri: 'http://127.0.0.1:43191/callback?exact=1',
        scope: 'files:read',
        state: 'missing-pkce-state',
        resource: 'https://mcp-staging.duet.so/',
      })}`,
    )
    const oversizedState = await app.request(
      `/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: 'duet_client_fixture',
        redirect_uri: 'http://127.0.0.1:43191/callback?exact=1',
        scope: 'files:read',
        state: 's'.repeat(MAX_OAUTH_AUTHORIZATION_STATE_UTF8_BYTES + 1),
        resource: 'https://mcp-staging.duet.so/',
        code_challenge: 'A'.repeat(43),
        code_challenge_method: 'S256',
      })}`,
    )

    expect(safeError.headers.get('location')).toBe(
      'http://127.0.0.1:43191/callback?exact=1&error=invalid_scope&state=round-trip-state',
    )
    expect(unsafeError.status).toBe(400)
    expect(unsafeError.headers.get('location')).toBeNull()
    expect(await unsafeError.json()).toEqual({ error: 'invalid_request' })
    expect(plainPkce.headers.get('location')).toContain('error=invalid_request&state=pkce-state')
    expect(missingPkce.headers.get('location')).toContain(
      'error=invalid_request&state=missing-pkce-state',
    )
    expect(oversizedState.headers.get('location')).toBe(
      'http://127.0.0.1:43191/callback?exact=1&error=invalid_request',
    )
  })

  test('returns backend refresh envelopes and maps binding failures to invalid_grant', async () => {
    const { app } = routeFixture()
    const rotated = await tokenRequest(app, {
      grant_type: 'refresh_token',
      refresh_token: 'duet_rt_fixture',
      client_id: 'duet_client_fixture',
      resource: 'https://mcp-staging.duet.so/',
    })
    const mismatched = await tokenRequest(app, {
      grant_type: 'refresh_token',
      refresh_token: 'duet_rt_fixture',
      client_id: 'wrong-client',
      resource: 'https://mcp-staging.duet.so/',
    })
    const missingResource = await tokenRequest(app, {
      grant_type: 'refresh_token',
      refresh_token: 'duet_rt_fixture',
      client_id: 'duet_client_fixture',
    })

    expect(await rotated.json()).toEqual({
      access_token: 'duet_sk_refreshed_fixture',
      token_type: 'Bearer',
      expires_in: 3599,
      refresh_token: 'duet_rt_rotated_fixture',
      scope: 'files:read memory',
    })
    expect(await mismatched.json()).toEqual({ error: 'invalid_grant' })
    expect(await missingResource.json()).toEqual({ error: 'invalid_request' })
  })

  test('advertises configured canonical endpoints and MCP resource without reading Host', async () => {
    const { app, mutations } = routeFixture()
    const response = await app.request(
      'https://attacker-controlled.example/.well-known/oauth-authorization-server',
    )

    expect(response.status).toBe(200)
    expect(AuthorizationServerMetadataSchema.parse(await response.json())).toEqual({
      issuer: 'https://ctl-staging.duet.so',
      authorization_endpoint: 'https://ctl-staging.duet.so/oauth/authorize',
      token_endpoint: 'https://ctl-staging.duet.so/oauth/token',
      registration_endpoint: 'https://ctl-staging.duet.so/oauth/register',
      scopes_supported: [...CAPABILITIES].sort(),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      protected_resources: ['https://mcp-staging.duet.so/'],
    })
    expect(mutations[0]?.endpoint).toBe('oauth_metadata')
  })

  test('registers public clients with exact redirect URIs through the normalized storage seam', async () => {
    const { app, mutations } = routeFixture()
    const request = {
      redirect_uris: ['http://127.0.0.1:43191/callback?exact=1', 'https://client.example/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'MCP client',
    }
    const response = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })

    expect(response.status).toBe(201)
    const registered = DynamicClientRegistrationResponseSchema.parse(await response.json())
    expect(registered).toMatchObject(request)
    expect(registered.client_id).toStartWith('duet_client_')
    expect(mutations.find(call => call.source === 'dcr')).toMatchObject({
      clientId: registered.client_id,
      clientName: 'MCP client',
      redirectUris: request.redirect_uris,
      tokenEndpointAuthMethod: 'none',
      source: 'dcr',
    })
  })

  test('rejects confidential asks with a protocol-shaped error', async () => {
    const { app, mutations } = routeFixture()
    const response = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://client.example/callback'],
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        client_name: 'Confidential client',
        client_secret: 'requested',
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'invalid_client_metadata',
      error_description: 'Only public clients with token_endpoint_auth_method none are supported',
    })
    expect(mutations.some(call => call.source === 'dcr')).toBe(false)
  })

  test('classifies an invalid redirect URI as invalid_redirect_uri', async () => {
    const { app } = routeFixture()
    const response = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['not a URI'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        client_name: 'Broken redirect client',
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'invalid_redirect_uri',
      error_description: 'Every redirect URI must be an exact absolute URI',
    })
  })

  test('rate limits discovery and registration in separate endpoint buckets', async () => {
    const { app, mutations } = routeFixture({ limited: true })
    const metadata = await app.request('/.well-known/oauth-authorization-server')
    const registration = await app.request('/oauth/register', { method: 'POST' })
    const authorize = await app.request('/oauth/authorize')
    const token = await app.request('/oauth/token', { method: 'POST' })

    expect(metadata.status).toBe(429)
    expect(registration.status).toBe(429)
    expect(authorize.status).toBe(429)
    expect(token.status).toBe(429)
    expect(mutations.map(call => call.endpoint)).toEqual([
      'oauth_metadata',
      'oauth_register',
      'oauth_authorize',
      'oauth_token',
    ])
  })
})

function routeFixture(options: { limited?: boolean } = {}) {
  const mutations: Array<Record<string, unknown>> = []
  const runtime = {
    internalKey: 'test-internal-key',
    now: () => 10_000,
    appUrl: 'https://app-staging.duet.so',
    convex: {
      query: async (_reference: unknown, args: Record<string, unknown>) => {
        if (args.requestId === 'oauth_request_fixture') {
          return {
            status: 'pending',
            client: { id: 'duet_client_fixture', name: 'MCP client' },
            redirect: { hostname: '127.0.0.1', localhost: true },
            capabilities: ['files:read', 'memory'],
            workspaces: [{ slug: 'personal', name: 'Personal', role: 'owner' }],
            expiresAt: 310_000,
          }
        }
        if (args.clientId === 'duet_client_fixture') {
          return {
            clientId: 'duet_client_fixture',
            clientName: 'MCP client',
            redirectUris: ['http://127.0.0.1:43191/callback?exact=1'],
            tokenEndpointAuthMethod: 'none',
            source: 'dcr',
          }
        }
        return null
      },
      mutation: async (_reference: unknown, args: Record<string, unknown>) => {
        mutations.push(args)
        if (typeof args.endpoint === 'string') {
          return options.limited
            ? { ok: false, retryAfterSeconds: 60 }
            : { ok: true, remaining: 10, resetAt: 70_000 }
        }
        if (args.code === 'duet_ac_fixture') {
          return {
            access_token: 'duet_sk_oauth_fixture',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'duet_rt_fixture',
            scope: 'files:read memory',
          }
        }
        if (args.workspaceSlug === 'personal') {
          return {
            redirectUrl:
              'http://127.0.0.1:43191/callback?exact=1&code=duet_ac_fixture&state=unchanged-client-state',
          }
        }
        if (args.refreshToken === 'duet_rt_fixture') {
          if (args.clientId !== 'duet_client_fixture') {
            return { ok: false, reason: 'invalid_grant' }
          }
          return {
            access_token: 'duet_sk_refreshed_fixture',
            token_type: 'Bearer',
            expires_in: 3599,
            refresh_token: 'duet_rt_rotated_fixture',
            scope: 'files:read memory',
          }
        }
        if (args.requestId === 'oauth_request_fixture') {
          return {
            redirectUrl:
              'http://127.0.0.1:43191/callback?exact=1&error=access_denied&state=unchanged-client-state',
          }
        }
        if (args.codeChallenge !== undefined) return 'oauth_request_fixture'
        return {
          clientId: args.clientId,
          clientName: args.clientName,
          redirectUris: args.redirectUris,
          tokenEndpointAuthMethod: args.tokenEndpointAuthMethod,
          source: args.source,
        }
      },
    },
  } as unknown as ApiRouteRuntime
  const app = new Hono<{ Variables: ApiVariables }>()
  app.use('/v1/*', async (c, next) => {
    c.set('auth', {
      credentialKind: 'browser_session',
      user: { id: 'user_fixture', email: 'person@example.com' },
      workspaces: [],
      scopes: [],
      versions: { api: 'v1', contract: 'v1' },
    } as never)
    await next()
  })
  registerOAuthRoutes(app, runtime, {
    trustProxyHeaders: true,
    apiUrl: 'https://ctl-staging.duet.so',
    mcpPublicUrl: 'https://mcp-staging.duet.so/',
  })
  return { app, mutations }
}

function tokenRequest(
  app: Hono<{ Variables: ApiVariables }>,
  body: Record<string, string>,
): Promise<Response> {
  return Promise.resolve(
    app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    }),
  )
}
