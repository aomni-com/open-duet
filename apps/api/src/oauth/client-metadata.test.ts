import { describe, expect, test } from 'bun:test'

import {
  OAuthClientResolutionError,
  normalizeDcrClient,
  resolveOAuthClientForAuthorizationSnapshot,
} from './client-metadata'

const CLIENT_ID = 'duet_client_fixture'

describe('normalized OAuth client resolution', () => {
  test('normalizeDcrClient projects registration metadata into the immutable client shape', () => {
    const redirectUris = ['http://127.0.0.1:43191/callback', 'https://client.example/callback']
    expect(
      normalizeDcrClient(CLIENT_ID, {
        redirect_uris: redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        client_name: 'Fixture client',
      }),
    ).toEqual({
      clientId: CLIENT_ID,
      clientName: 'Fixture client',
      redirectUris,
      tokenEndpointAuthMethod: 'none',
      source: 'dcr',
    })
  })

  test('returns the cached authorization snapshot without any further resolution', async () => {
    const cached = {
      clientId: CLIENT_ID,
      clientName: 'Cached client',
      redirectUris: ['https://client.example/callback'],
      tokenEndpointAuthMethod: 'none' as const,
      source: 'dcr' as const,
    }
    const runtime = {
      internalKey: 'test-internal-key',
      now: () => 30_000,
      convex: {
        query: async () => cached,
      },
    } as never

    expect(await resolveOAuthClientForAuthorizationSnapshot(CLIENT_ID, runtime)).toEqual(cached)
  })

  test('rejects an unregistered client_id when the store has no client', async () => {
    const runtime = {
      internalKey: 'test-internal-key',
      now: () => 30_000,
      convex: {
        query: async () => null,
      },
    } as never

    await expect(
      resolveOAuthClientForAuthorizationSnapshot(CLIENT_ID, runtime),
    ).rejects.toBeInstanceOf(OAuthClientResolutionError)
  })
})
