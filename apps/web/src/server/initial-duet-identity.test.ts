import { describe, expect, test } from 'bun:test'

import {
  BROWSER_SESSION_ROTATE_BEFORE_MS,
  type BrowserSessionCredential,
  type WhoamiResponse,
} from '@repo/contract'

import { loadInitialDuetIdentity } from './initial-duet-identity'

const identity = {
  user: { id: 'user_owner', email: 'owner@duet.so', name: 'Ada Lovelace' },
  workspaces: [
    {
      id: 'workspace_acme',
      slug: 'acme',
      name: 'Acme Studio',
      status: 'active',
      role: 'owner',
      billingUserId: 'user_owner',
      funding: { plan: null, active: true },
      creditRecovery: null,
      defaultTier: { effective: 'balanced' },
      servicingStatus: 'active',
    },
  ],
  scopes: ['ws:acme:admin'],
  versions: { api: 1 },
  internalAdmin: false,
} as const satisfies WhoamiResponse

const requestNow = 1_000_000

function sessionCookie(expiresAt = requestNow + BROWSER_SESSION_ROTATE_BEFORE_MS + 1): string {
  const session = {
    token: 'duet_sk_browser_token',
    prefix: 'duet_sk_browser',
    expiresAt,
  } satisfies BrowserSessionCredential
  return `duet_session=${Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')}`
}

describe('loadInitialDuetIdentity', () => {
  test('loads a valid identity with the existing browser-session cookie', async () => {
    let proxiedRequest: Request | undefined
    const cookie = sessionCookie()
    const result = await loadInitialDuetIdentity(
      cookie,
      async request => {
        proxiedRequest = request
        return Response.json(identity)
      },
      () => requestNow,
    )

    expect(result).toEqual(identity)
    expect(proxiedRequest?.headers.get('cookie')).toBe(cookie)
    expect(proxiedRequest?.method).toBe('GET')
  })

  test('does not start a second session exchange when the cookie is absent', async () => {
    let proxyCalls = 0
    const result = await loadInitialDuetIdentity(undefined, async () => {
      proxyCalls += 1
      return Response.json(identity)
    })

    expect(result).toBeUndefined()
    expect(proxyCalls).toBe(0)
  })

  test('leaves malformed and rotation-window sessions to the client bootstrap', async () => {
    let proxyCalls = 0
    const proxy = async () => {
      proxyCalls += 1
      return Response.json(identity)
    }

    expect(
      await loadInitialDuetIdentity('duet_session=malformed', proxy, () => requestNow),
    ).toBeUndefined()
    expect(
      await loadInitialDuetIdentity(
        sessionCookie(requestNow + BROWSER_SESSION_ROTATE_BEFORE_MS),
        proxy,
        () => requestNow,
      ),
    ).toBeUndefined()
    expect(proxyCalls).toBe(0)
  })

  test('falls back to client bootstrap for upstream and schema failures', async () => {
    expect(
      await loadInitialDuetIdentity(
        sessionCookie(),
        async () => Response.json({ error: 'upstream_unavailable' }, { status: 502 }),
        () => requestNow,
      ),
    ).toBeUndefined()
    expect(
      await loadInitialDuetIdentity(
        sessionCookie(),
        async () => Response.json({ user: null }),
        () => requestNow,
      ),
    ).toBeUndefined()
  })
})
