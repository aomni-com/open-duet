import { describe, expect, test } from 'bun:test'

import { NextRequest } from 'next/server'

import { GET } from './route'

describe('share deep link', () => {
  test('parks a valid token in an HttpOnly cookie and redirects without leaking it', async () => {
    const token = `duet_share_${'a'.repeat(64)}`
    const response = await GET(new NextRequest(`https://app.duet.so/share/${token}`), {
      params: Promise.resolve({ token }),
    })
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(
      'https://app.duet.so/sign-in?shared=1&returnTo=%2F%3Fshared%3D1',
    )
    expect(response.headers.get('location')).not.toContain(token)
    expect(response.headers.get('set-cookie')).toContain(`duet_pending_share=${token}`)
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
    expect(response.headers.get('set-cookie')).toContain('Max-Age=604800')
    expect(response.headers.get('set-cookie')).toContain('SameSite=lax')
  })

  test('normalizes a malformed path token instead of reflecting it into a cookie', async () => {
    const response = await GET(
      new NextRequest('https://app.duet.so/share/oversized-untrusted-token'),
      {
        params: Promise.resolve({ token: 'oversized-untrusted-token'.repeat(500) }),
      },
    )
    expect(response.headers.get('set-cookie')).toContain('duet_pending_share=invalid')
    expect(response.headers.get('set-cookie')).not.toContain('oversized-untrusted-token')
  })
})
