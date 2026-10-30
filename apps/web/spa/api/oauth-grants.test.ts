import { expect, test } from 'bun:test'

import { duetQueryOptions } from './query-options'

test('OAuth grants use their own user cache key', () => {
  const api = {
    listOAuthGrants: async () => ({ items: [], nextCursor: null }),
  } as never
  expect([...duetQueryOptions.user.oauthGrants(api).queryKey]).toEqual([
    'duet',
    'user',
    'oauth-grants',
  ])
})
