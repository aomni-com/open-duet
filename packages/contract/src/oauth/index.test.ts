import { describe, expect, test } from 'bun:test'

import { CAPABILITIES } from '../scopes/index'
import {
  AuthorizationServerMetadataSchema,
  DynamicClientRegistrationErrorResponseSchema,
  DynamicClientRegistrationRequestSchema,
  DynamicClientRegistrationResponseSchema,
  MAX_OAUTH_AUTHORIZATION_STATE_UTF8_BYTES,
  MAX_OAUTH_CLIENT_METADATA_ARRAY_ITEMS,
  MAX_OAUTH_CLIENT_NAME_UTF8_BYTES,
  OAuthAuthorizationErrorResponseSchema,
  OAuthAuthorizationRequestSchema,
  OAuthAuthorizationResponseSchema,
  OAuthConsentApproveRequestSchema,
  OAuthConsentApproveResponseSchema,
  OAuthConsentDenyRequestSchema,
  OAuthConsentDenyResponseSchema,
  OAuthConsentInspectResponseSchema,
  OAuthGrantStorageMetadataSchema,
  OAuthTokenErrorResponseSchema,
  OAuthTokenRequestSchema,
  OAuthTokenResponseSchema,
  ProtectedResourceMetadataSchema,
} from './index'

describe('OAuth contract', () => {
  test('bounds DCR names by UTF-8 bytes and metadata arrays before persistence', () => {
    const registration = {
      redirect_uris: ['https://client.example/callback'],
      token_endpoint_auth_method: 'none' as const,
      grant_types: ['authorization_code'] as const,
      response_types: ['code'] as const,
      client_name: 'Example client',
    }
    expect(
      DynamicClientRegistrationRequestSchema.safeParse({
        ...registration,
        client_name: 'a'.repeat(MAX_OAUTH_CLIENT_NAME_UTF8_BYTES),
      }).success,
    ).toBe(true)
    expect(
      DynamicClientRegistrationRequestSchema.safeParse({
        ...registration,
        client_name: `${'a'.repeat(MAX_OAUTH_CLIENT_NAME_UTF8_BYTES - 3)}🚀`,
      }).success,
    ).toBe(false)
    expect(
      DynamicClientRegistrationRequestSchema.safeParse({
        ...registration,
        redirect_uris: Array.from(
          { length: MAX_OAUTH_CLIENT_METADATA_ARRAY_ITEMS + 1 },
          (_, index) => `https://client.example/${index}`,
        ),
      }).success,
    ).toBe(false)
  })

  test('pins bounded workspace and client snapshots on persisted grants', () => {
    const metadata = {
      clientId: 'client_01',
      clientName: 'Example client',
      redirectHost: 'client.example',
      capabilities: ['sessions', 'files:read', 'sessions'],
      scopes: ['ws:acme:sessions', 'ws:acme:files:read', 'ws:acme:sessions'],
      audience: 'https://mcp.duet.so/',
      workspaceSlug: 'acme',
      workspaceName: 'Acme',
    }
    expect(OAuthGrantStorageMetadataSchema.parse(metadata)).toMatchObject({
      capabilities: ['files:read', 'sessions'],
      scopes: ['ws:acme:files:read', 'ws:acme:sessions'],
      workspaceSlug: 'acme',
      workspaceName: 'Acme',
    })
    expect(
      OAuthGrantStorageMetadataSchema.safeParse({
        ...metadata,
        clientName: `${'a'.repeat(MAX_OAUTH_CLIENT_NAME_UTF8_BYTES - 3)}🚀`,
      }).success,
    ).toBe(false)
  })

  test('pins Duet authorization-server discovery to public PKCE clients and resource indicators', () => {
    expect(
      AuthorizationServerMetadataSchema.parse({
        issuer: 'https://ctl.duet.so',
        authorization_endpoint: 'https://ctl.duet.so/oauth/authorize',
        token_endpoint: 'https://ctl.duet.so/oauth/token',
        registration_endpoint: 'https://ctl.duet.so/oauth/register',
        scopes_supported: CAPABILITIES,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        protected_resources: ['https://mcp.duet.so/'],
      }),
    ).toEqual({
      issuer: 'https://ctl.duet.so',
      authorization_endpoint: 'https://ctl.duet.so/oauth/authorize',
      token_endpoint: 'https://ctl.duet.so/oauth/token',
      registration_endpoint: 'https://ctl.duet.so/oauth/register',
      scopes_supported: [...CAPABILITIES].sort(),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      protected_resources: ['https://mcp.duet.so/'],
    })
    expect(
      AuthorizationServerMetadataSchema.safeParse({
        issuer: 'http://ctl.duet.so',
        authorization_endpoint: 'https://ctl.duet.so/oauth/authorize',
        token_endpoint: 'https://ctl.duet.so/oauth/token',
        registration_endpoint: 'https://ctl.duet.so/oauth/register',
        scopes_supported: CAPABILITIES,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        protected_resources: ['https://mcp.duet.so/'],
      }).success,
    ).toBe(false)
  })

  test('parses protected-resource and DCR documents as public clients', () => {
    expect(
      ProtectedResourceMetadataSchema.parse({
        resource: 'https://mcp.duet.so/',
        authorization_servers: ['https://ctl.duet.so'],
        scopes_supported: CAPABILITIES,
        bearer_methods_supported: ['header'],
      }),
    ).toEqual({
      resource: 'https://mcp.duet.so/',
      authorization_servers: ['https://ctl.duet.so'],
      scopes_supported: [...CAPABILITIES].sort(),
      bearer_methods_supported: ['header'],
    })

    const registration = {
      redirect_uris: ['http://127.0.0.1:49152/callback'],
      token_endpoint_auth_method: 'none' as const,
      grant_types: ['authorization_code', 'refresh_token'] as (
        | 'authorization_code'
        | 'refresh_token'
      )[],
      response_types: ['code'] as ['code'],
      client_name: 'Example MCP client',
      scope: CAPABILITIES.join(' '),
    }
    expect(DynamicClientRegistrationRequestSchema.parse(registration)).toEqual(registration)
    expect(
      DynamicClientRegistrationResponseSchema.parse({
        ...registration,
        client_id: 'client_01',
        client_id_issued_at: 1_750_000_000,
      }),
    ).toMatchObject({ client_id: 'client_01', token_endpoint_auth_method: 'none' })
    expect(
      DynamicClientRegistrationRequestSchema.safeParse({
        ...registration,
        token_endpoint_auth_method: 'client_secret_basic',
      }).success,
    ).toBe(false)
    expect(
      DynamicClientRegistrationErrorResponseSchema.parse({
        error: 'invalid_client_metadata',
        error_description: 'Only public clients are supported.',
      }),
    ).toMatchObject({ error: 'invalid_client_metadata' })

    // A redirect_uri is a browser navigation target: HTTPS or HTTP loopback
    // only. Executable/opaque schemes must be rejected at registration so they
    // can never reach window.location.assign at consent completion.
    for (const redirect of [
      'https://client.example/callback',
      'http://127.0.0.1:49152/callback',
      'http://localhost:3000/callback',
    ]) {
      expect(
        DynamicClientRegistrationRequestSchema.safeParse({
          ...registration,
          redirect_uris: [redirect],
        }).success,
      ).toBe(true)
    }
    for (const redirect of [
      'javascript:alert(1)',
      'javascript://client.example/%0aalert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'http://evil.example/callback',
      'https://user:pw@client.example/callback',
      'https://client.example/callback#frag',
    ]) {
      expect(
        DynamicClientRegistrationRequestSchema.safeParse({
          ...registration,
          redirect_uris: [redirect],
        }).success,
        `redirect_uri must be rejected: ${redirect}`,
      ).toBe(false)
    }
  })

  test('pins authorization and token exchange to code flow, S256, and one resource audience', () => {
    const authorization = {
      response_type: 'code' as const,
      client_id: 'client_01',
      redirect_uri: 'http://127.0.0.1:49152/callback',
      scope: 'files:read memory',
      state: 'client-state',
      resource: 'https://mcp.duet.so/',
      code_challenge: 'A'.repeat(43),
      code_challenge_method: 'S256' as const,
    }
    expect(OAuthAuthorizationRequestSchema.parse(authorization)).toEqual(authorization)
    expect(
      OAuthAuthorizationRequestSchema.safeParse({
        ...authorization,
        code_challenge_method: 'plain',
      }).success,
    ).toBe(false)
    expect(
      OAuthAuthorizationResponseSchema.parse({ code: 'authorization-code', state: 'client-state' }),
    ).toEqual({ code: 'authorization-code', state: 'client-state' })
    const oversizedState = 's'.repeat(MAX_OAUTH_AUTHORIZATION_STATE_UTF8_BYTES + 1)
    expect(
      OAuthAuthorizationRequestSchema.safeParse({ ...authorization, state: oversizedState })
        .success,
    ).toBe(false)
    expect(
      OAuthAuthorizationResponseSchema.safeParse({
        code: 'authorization-code',
        state: oversizedState,
      }).success,
    ).toBe(false)

    const codeExchange = {
      grant_type: 'authorization_code' as const,
      code: 'authorization-code',
      redirect_uri: authorization.redirect_uri,
      client_id: authorization.client_id,
      code_verifier: 'v'.repeat(43),
      resource: authorization.resource,
    }
    const refreshExchange = {
      grant_type: 'refresh_token' as const,
      refresh_token: 'refresh-token',
      client_id: authorization.client_id,
      resource: authorization.resource,
    }
    expect(OAuthTokenRequestSchema.parse(codeExchange)).toEqual(codeExchange)
    expect(OAuthTokenRequestSchema.parse(refreshExchange)).toEqual(refreshExchange)
    expect(
      OAuthTokenResponseSchema.parse({
        access_token: 'duet_sk_example',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'refresh-token',
        scope: authorization.scope,
      }),
    ).toMatchObject({ token_type: 'Bearer', expires_in: 3600 })
  })

  test('uses protocol error vocabularies for authorization redirects and RFC 6749 token bodies', () => {
    expect(
      OAuthAuthorizationErrorResponseSchema.parse({
        error: 'access_denied',
        error_description: 'The user denied access.',
        state: 'client-state',
      }),
    ).toMatchObject({ error: 'access_denied', state: 'client-state' })
    expect(
      OAuthTokenErrorResponseSchema.parse({
        error: 'invalid_grant',
        error_description: 'The code is expired.',
      }),
    ).toEqual({ error: 'invalid_grant', error_description: 'The code is expired.' })
    expect(OAuthTokenErrorResponseSchema.safeParse({ error: 'access_denied' }).success).toBe(false)
  })

  test('keeps browser consent on a trusted request snapshot and server-built completion URL', () => {
    const inspection = {
      status: 'pending' as const,
      client: { id: 'client_01', name: 'Example MCP client' },
      redirect: { hostname: '127.0.0.1', localhost: true },
      capabilities: ['files:read', 'memory'] as ('files:read' | 'memory')[],
      workspaces: [{ slug: 'acme', name: 'Acme', role: 'owner' as const }],
      expiresAt: 1_750_000_000_000,
    }
    expect(OAuthConsentInspectResponseSchema.parse(inspection)).toEqual(inspection)
    expect(OAuthConsentApproveRequestSchema.parse({ workspaceSlug: 'acme' })).toEqual({
      workspaceSlug: 'acme',
    })
    expect(
      OAuthConsentApproveResponseSchema.parse({
        redirectUrl: 'http://127.0.0.1:49152/callback?code=code_01&state=client-state',
      }),
    ).toMatchObject({ redirectUrl: expect.stringContaining('code=code_01') })
    expect(OAuthConsentDenyRequestSchema.parse({})).toEqual({})
    expect(
      OAuthConsentDenyResponseSchema.parse({
        redirectUrl: 'http://127.0.0.1:49152/callback?error=access_denied&state=client-state',
      }),
    ).toMatchObject({ redirectUrl: expect.stringContaining('error=access_denied') })
  })
})
