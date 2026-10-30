import { describe, expect, test } from 'bun:test'

import { COLLECTION_PAGE_DEFAULT_LIMIT } from '../pagination/index'

import {
  OAuthGrantListQuerySchema,
  OAuthGrantPageSchema,
  OAuthGrantRevokedSchema,
  SyncMachineListQuerySchema,
  SyncMachinePageSchema,
  SyncMachineRegisterRequestSchema,
  UserApiKeyListQuerySchema,
  UserApiKeyIssueRequestSchema,
  UserApiKeyPageSchema,
} from './index'

describe('account settings contracts', () => {
  test('key issuance needs identity metadata and refuses permission grants', () => {
    expect(UserApiKeyIssueRequestSchema.parse({ name: '  CLI  ' })).toEqual({ name: 'CLI' })
    expect(
      UserApiKeyIssueRequestSchema.safeParse({
        name: 'CLI',
        workspaceSlug: 'acme',
        capabilities: ['sessions'],
      }).success,
    ).toBe(false)
    expect(UserApiKeyIssueRequestSchema.safeParse({ name: '   ' }).success).toBe(false)
  })

  test('uses universal pages for user API keys', () => {
    expect(UserApiKeyListQuerySchema.parse({})).toEqual({ limit: COLLECTION_PAGE_DEFAULT_LIMIT })
    expect(
      UserApiKeyPageSchema.parse({ items: [], nextCursor: null, keys: [{ id: 'legacy' }] }),
    ).toEqual({ items: [], nextCursor: null })
    expect(UserApiKeyListQuerySchema.safeParse({ keys: 'legacy' }).success).toBe(false)
  })

  test('lists only the browser-safe grant projection', () => {
    const result = OAuthGrantPageSchema.parse({
      items: [
        {
          id: 'grant_1',
          clientId: 'https://client.example/oauth.json',
          clientName: 'Example client',
          redirectHost: 'client.example',
          workspace: { slug: 'acme', name: 'Acme' },
          scopes: ['ws:acme:files:read'],
          createdAt: 1,
          lastUsedAt: 2,
          hashedToken: 'must-not-survive',
          generation: 4,
        },
      ],
      nextCursor: null,
    })

    expect(result).toEqual({
      items: [
        {
          id: 'grant_1',
          clientId: 'https://client.example/oauth.json',
          clientName: 'Example client',
          redirectHost: 'client.example',
          workspace: { slug: 'acme', name: 'Acme' },
          scopes: ['ws:acme:files:read'],
          createdAt: 1,
          lastUsedAt: 2,
        },
      ],
      nextCursor: null,
    })
  })

  test('account machine registration uses the authenticated person and peer, refusing cached server IDs', () => {
    expect(
      SyncMachineRegisterRequestSchema.parse({
        name: ' Mac ',
        syncthingDeviceId: 'AAAAAAA-BBBBBBB',
      }),
    ).toEqual({ name: 'Mac', syncthingDeviceId: 'AAAAAAA-BBBBBBB' })
    expect(
      SyncMachineRegisterRequestSchema.safeParse({
        name: 'Mac',
        syncthingDeviceId: 'AAAAAAA-BBBBBBB',
        machineId: 'foreign-machine',
      }).success,
    ).toBe(false)
  })

  test('uses bound page queries for OAuth grants and sync machines', () => {
    expect(OAuthGrantListQuerySchema.parse({ limit: '2', cursor: 'opaque' })).toEqual({
      limit: 2,
      cursor: 'opaque',
    })
    expect(SyncMachineListQuerySchema.parse({})).toEqual({ limit: COLLECTION_PAGE_DEFAULT_LIMIT })
    expect(SyncMachinePageSchema.parse({ items: [], nextCursor: null })).toEqual({
      items: [],
      nextCursor: null,
    })
  })

  test('revoke returns the stable grant identity and timestamp', () => {
    expect(OAuthGrantRevokedSchema.parse({ grantId: 'grant_1', revokedAt: 3 })).toEqual({
      grantId: 'grant_1',
      revokedAt: 3,
    })
  })
})
