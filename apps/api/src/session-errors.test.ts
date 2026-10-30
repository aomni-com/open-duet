import { describe, expect, test } from 'bun:test'

import { ConvexError } from 'convex/values'

import { mapSessionError } from './session-errors'

describe('session error mapping', () => {
  test.each([
    ['not_found', 404],
    ['audience_kind_immutable', 409],
    ['invalid_audience_member', 400],
    ['invalid_audience_delta', 400],
    ['forbidden', 403],
  ] as const)('maps %s structurally', (error, status) => {
    expect(mapSessionError(new ConvexError({ error }))).toEqual({ body: { error }, status })
  })

  test('rethrows unknown Convex and ordinary errors', () => {
    const unknown = new ConvexError({ error: 'new_session_error' })
    const ordinary = new Error('Session not found')
    expect(() => mapSessionError(unknown)).toThrow(unknown)
    expect(() => mapSessionError(ordinary)).toThrow(ordinary)
  })
})
