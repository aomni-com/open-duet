import { describe, expect, test } from 'bun:test'

import { NextRequest } from 'next/server'

import { GET as inviteResponse } from '../../app/invite/[token]/route'
import { completeBrowserSession } from './complete-browser-session'
import { clearPendingInviteCookie, normalizedPendingInviteToken } from './pending-invite'
import { safeReturnTo } from './return-to'

describe('pending invitation continuity', () => {
  test('acceptance directs the browser to the invited workspace instead of its default', async () => {
    const response = await completeBrowserSession({
      request: sameOriginSessionRequest(),
      tokens: { invite: 'invite-token' },
      bootstrap: async () => ({ workspaceSlug: 'newera', invited: true }),
      exchange: async () =>
        new Response(null, {
          status: 204,
          headers: { 'set-cookie': 'duet_session=fixture; HttpOnly' },
        }),
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('location')).toBe('/w/newera')
    expect(response.headers.get('set-cookie')).toContain('duet_session=fixture')
  })

  test('a failed session exchange retains the invitation for the next attempt', async () => {
    const response = await completeBrowserSession({
      request: sameOriginSessionRequest(),
      tokens: { invite: 'invite-token' },
      bootstrap: async () => ({ workspaceSlug: 'newera', invited: true }),
      exchange: async () => new Response(null, { status: 502 }),
    })

    expect(response.status).toBe(502)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  test('lost invitation context permits ordinary login without a signup restriction', async () => {
    const response = await completeBrowserSession({
      request: sameOriginSessionRequest({ invited: true }),
      bootstrap: async () => ({ workspaceSlug: 'personal', invited: false }),
      exchange: async () => new Response(null, { status: 204 }),
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('location')).toBeNull()
  })

  test('the invitation token is HttpOnly and omitted from the redirect destination', async () => {
    const token = 'a'.repeat(64)
    const response = await inviteResponse(new NextRequest(`https://app.example/invite/${token}`), {
      params: Promise.resolve({ token }),
    })
    const cookie = response.headers.get('set-cookie')
    expect(cookie).toContain(`duet_pending_invite=${token}`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=lax')
    expect(response.headers.get('location')).toBe('https://app.example/sign-in?invited=1')
    expect(response.headers.get('location')).not.toContain(token)
  })

  test('only fixed-size generated invite tokens reach the pending cookie', () => {
    const token = 'a'.repeat(64)
    expect(normalizedPendingInviteToken(token)).toBe(token)
    expect(normalizedPendingInviteToken('oversized-untrusted-token'.repeat(500))).toBe('invalid')
  })

  test('post-auth redirects remain same-origin even for URL parser edge cases', () => {
    expect(safeReturnTo(undefined)).toBe('/')
    expect(safeReturnTo('/w/acme/sessions?from=invite#latest')).toBe(
      '/w/acme/sessions?from=invite#latest',
    )
    expect(safeReturnTo('/device?user_code=DJ7K-MP4Q')).toBe('/device?user_code=DJ7K-MP4Q')
    expect(safeReturnTo('/oauth/authorize?request=opaque-request')).toBe(
      '/oauth/authorize?request=opaque-request',
    )
    expect(
      safeReturnTo(
        '/oauth/authorize?request=opaque-request&redirect_uri=https%3A%2F%2Fattacker.example&client_name=Trusted',
      ),
    ).toBe('/oauth/authorize?request=opaque-request')
    expect(safeReturnTo('/oauth/authorize?redirect_uri=https%3A%2F%2Fattacker.example')).toBe('/')
    expect(safeReturnTo('/api/duet/session')).toBe('/')
    expect(safeReturnTo('/sign-in')).toBe('/')
    expect(safeReturnTo('/app')).toBe('/')
    expect(safeReturnTo('//evil.example/steal')).toBe('/')
    expect(safeReturnTo('/\\evil.example/steal')).toBe('/')
    expect(safeReturnTo('https://evil.example/steal')).toBe('/')
  })

  test('browser session completion bootstraps with the cookie token before exchange and clears it', async () => {
    const calls: string[] = []
    const response = await completeBrowserSession({
      request: sameOriginSessionRequest(),
      tokens: { invite: 'invite-token' },
      bootstrap: async tokens => {
        calls.push(`bootstrap:${tokens?.invite}`)
        return { workspaceSlug: 'newera', invited: true }
      },
      exchange: async () => {
        calls.push('exchange')
        return new Response('{}')
      },
    })
    expect(calls).toEqual(['bootstrap:invite-token', 'exchange'])
    expect(response.headers.get('set-cookie')).toBe(clearPendingInviteCookie())
  })

  test('a rejected invitation does not poison the next ordinary sign-in', async () => {
    const failed = await completeBrowserSession({
      request: sameOriginSessionRequest(),
      tokens: { invite: 'revoked-invite-token' },
      bootstrap: async () => {
        throw new Error('Invite could not be accepted')
      },
      exchange: async () => {
        throw new Error('must not exchange a rejected invitation')
      },
    })
    expect(failed.status).toBe(400)
    expect(failed.headers.get('set-cookie')).toBe(clearPendingInviteCookie())
    const next = await completeBrowserSession({
      request: sameOriginSessionRequest(),
      bootstrap: async () => ({ workspaceSlug: 'my-workspace', invited: false }),
      exchange: async () => new Response(null, { status: 204 }),
    })
    expect(next.status).toBe(204)
    expect(next.headers.get('location')).toBeNull()
  })

  test('a full workspace returns the typed admission conflict without consuming browser auth', async () => {
    let exchanged = false
    const response = await completeBrowserSession({
      request: sameOriginSessionRequest(),
      tokens: { invite: 'valid-but-last-slot-lost' },
      bootstrap: async () => {
        throw Object.assign(new Error('workspace admission refused'), {
          data: { error: 'workspace_member_limit_reached', limit: 100 },
        })
      },
      exchange: async () => {
        exchanged = true
        return new Response('{}')
      },
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'workspace_member_limit_reached',
      limit: 100,
    })
    expect(exchanged).toBe(false)
    expect(response.headers.get('set-cookie')).toBe(clearPendingInviteCookie())
  })
})

function sameOriginSessionRequest(body?: unknown): Request {
  return new Request('http://localhost/api/duet/session', {
    method: 'POST',
    headers: {
      origin: 'http://localhost',
      'sec-fetch-site': 'same-origin',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
