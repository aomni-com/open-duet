import { describe, expect, test } from 'bun:test'

import { clearPendingShareCookie, consumePendingShareCookie } from './pending-share'

describe('pending share continuity', () => {
  test('provides the exact clearing cookie for successful accept or decline', () => {
    expect(clearPendingShareCookie()).toBe(
      'duet_pending_share=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
    )
  })

  test('consumes a valid token server-side and clears it without exposing the token', async () => {
    const token = `duet_share_${'a'.repeat(64)}`
    const response = await consumePendingShareCookie({
      token,
      resolve: async received => {
        expect(received).toBe(token)
        return Response.json({ share: { id: 'share_1' } })
      },
    })
    expect(await response.clone().json()).toEqual({ share: { id: 'share_1' } })
    expect(await response.text()).not.toContain(token)
    expect(response.headers.get('set-cookie')).toBe(clearPendingShareCookie())
  })

  test('clears a malformed token without sending it to the API', async () => {
    let resolved = false
    const response = await consumePendingShareCookie({
      token: 'oversized-untrusted-token'.repeat(500),
      resolve: async () => {
        resolved = true
        return Response.json({})
      },
    })
    expect(response.status).toBe(204)
    expect(resolved).toBe(false)
    expect(response.headers.get('set-cookie')).toBe(clearPendingShareCookie())
  })

  test('preserves the pending token when resolution fails transiently', async () => {
    const response = await consumePendingShareCookie({
      token: `duet_share_${'a'.repeat(64)}`,
      resolve: async () => Response.json({ error: 'upstream_failed' }, { status: 503 }),
    })
    expect(response.status).toBe(503)
    expect(response.headers.get('set-cookie')).toBeNull()
  })
})
