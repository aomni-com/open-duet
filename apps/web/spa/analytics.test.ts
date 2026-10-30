import { describe, expect, test } from 'bun:test'

import type { WhoamiResponse } from '@repo/contract'

import { identifyProductUserOnce } from './analytics'

describe('product analytics identity ordering', () => {
  test('identifies once per canonical whoami user', () => {
    const calls: unknown[] = []
    const analytics = { identify: (...args: unknown[]) => calls.push(args) }
    const identity = {
      user: { id: 'user_1', email: 'person@example.com', name: 'Person' },
      workspaces: [],
      scopes: [],
      versions: { api: 1 },
      internalAdmin: false,
    } satisfies WhoamiResponse

    const identifiedUserId = identifyProductUserOnce(analytics, identity)
    expect(identifyProductUserOnce(analytics, identity, identifiedUserId)).toBe('user_1')

    expect(calls).toEqual([['user_1', { email: 'person@example.com', name: 'Person' }]])
  })
})
