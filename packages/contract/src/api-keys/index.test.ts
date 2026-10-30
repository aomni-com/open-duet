import { describe, expect, test } from 'bun:test'

import { MAX_CAPABILITY_REQUEST_ITEMS, StoredApiKeyScopesSchema } from '../scopes/index'
import {
  DeviceApprovalRequestSchema,
  DeviceApprovalResponseSchema,
  DUET_API_KEY_PREFIX,
  DeviceCodeRequestSchema,
  DevicePollResultSchema,
  DeviceTokenResponseSchema,
  assertSingleWorkspaceScopes,
  extractApiKeyCredential,
  extractBearerToken,
  hashApiKey,
} from './index'

describe('api key contract', () => {
  test('canonicalizes stored scopes within a finite raw request bound', () => {
    expect(
      StoredApiKeyScopesSchema.parse([
        'ws:demo:sessions',
        'ws:demo:files:read',
        'ws:demo:sessions',
      ]),
    ).toEqual(['ws:demo:files:read', 'ws:demo:sessions'])
    expect(
      StoredApiKeyScopesSchema.safeParse(
        Array.from({ length: MAX_CAPABILITY_REQUEST_ITEMS + 1 }, () => 'ws:demo:sessions'),
      ).success,
    ).toBe(false)
  })

  test('extracts Authorization bearer credentials', () => {
    const headers = new Headers({ authorization: 'Bearer duet_sk_bearer' })
    expect(extractApiKeyCredential(headers)).toEqual({ token: 'duet_sk_bearer' })
  })

  test('extracts x-api-key credentials', () => {
    const headers = new Headers({ 'x-api-key': 'duet_sk_anthropic' })
    expect(extractApiKeyCredential(headers)).toEqual({ token: 'duet_sk_anthropic' })
  })

  test('rejects Vercel and malformed credentials', () => {
    expect(extractApiKeyCredential(new Headers({ authorization: 'Bearer vck_test' }))).toBeNull()
    expect(extractApiKeyCredential(new Headers({ authorization: 'Bearer nope' }))).toBeNull()
    expect(extractApiKeyCredential(new Headers({ authorization: 'Token duet_sk_test' }))).toBeNull()
    expect(extractApiKeyCredential(new Headers({ 'x-api-key': DUET_API_KEY_PREFIX }))).toBeNull()
  })

  test('parses generic Authorization bearer tokens strictly', () => {
    expect(extractBearerToken('Bearer any-token')).toBe('any-token')
    expect(extractBearerToken('bearer any-token')).toBe('any-token')
    expect(extractBearerToken(' Bearer   spaced-token ')).toBe('spaced-token')
    expect(extractBearerToken('Bearer')).toBeNull()
    expect(extractBearerToken('Bearer token extra')).toBeNull()
    expect(extractBearerToken('Token token')).toBeNull()
    expect(extractBearerToken(null)).toBeNull()
  })

  test('hashes with the existing sha256 hex contract', async () => {
    await expect(hashApiKey('duet_sk_contract_test')).resolves.toBe(
      'c4d0be74bb0305f3af5e5ff41751f38126c101ce46737027bd469e2c7fee5621',
    )
  })

  test('allows many capabilities for one workspace and rejects mixed workspace scopes', () => {
    expect(
      assertSingleWorkspaceScopes(['ws:demo:files:read', 'ws:demo:services', 'ws:demo:admin']),
    ).toEqual({ workspaceSlug: 'demo' })

    expect(() =>
      assertSingleWorkspaceScopes(['ws:demo:files:read', 'ws:other:files:write']),
    ).toThrow('exactly one workspace')
  })

  test('device approval identifies the user without a workspace grant', () => {
    expect(DeviceApprovalRequestSchema.parse({ userCode: 'ABCD-EFGH' })).toEqual({
      userCode: 'ABCD-EFGH',
    })
    expect(
      DeviceApprovalRequestSchema.safeParse({ userCode: 'ABCD-EFGH', workspaceSlug: 'demo' })
        .success,
    ).toBe(false)
    expect(
      DeviceApprovalResponseSchema.parse({
        userCode: 'ABCD-EFGH',
        status: 'pending',
        expiresAt: 1,
      }),
    ).toEqual({ userCode: 'ABCD-EFGH', status: 'pending', expiresAt: 1 })
  })

  test('workspace grant grammar rejects user-wide sync scopes', () => {
    // A managed or delegated workspace grant cannot contain a user-wide sync scope.
    expect(() => assertSingleWorkspaceScopes(['user:files:read'])).toThrow('Invalid scope')
    expect(() => assertSingleWorkspaceScopes(['ws:demo:files:read', 'user:files:read'])).toThrow(
      'Invalid scope',
    )
  })

  test('human device login requires no grant and rejects workspace permissions', () => {
    expect(DeviceCodeRequestSchema.parse({})).toEqual({})
    for (const request of [
      { scopes: ['ws:demo:admin'] },
      { capabilities: ['files:read'] },
      { device_name: 'Laptop' },
    ]) {
      expect(DeviceCodeRequestSchema.safeParse(request).success).toBe(false)
    }
  })

  test('approved login returns an identity key without a bound workspace', () => {
    expect(
      DeviceTokenResponseSchema.parse({
        status: 'approved',
        access_token: 'duet_sk_approved',
        token_type: 'bearer',
        prefix: 'duet_sk_',
      }),
    ).toEqual({
      status: 'approved',
      access_token: 'duet_sk_approved',
      token_type: 'bearer',
      prefix: 'duet_sk_',
    })
    expect(
      DevicePollResultSchema.parse({
        status: 'approved',
        key: 'duet_sk_approved',
        prefix: 'duet_sk_',
      }),
    ).toEqual({ status: 'approved', key: 'duet_sk_approved', prefix: 'duet_sk_' })
  })
})
