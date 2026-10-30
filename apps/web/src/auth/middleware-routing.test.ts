import { describe, expect, test } from 'bun:test'

import {
  shouldHandleAuthCode,
  usesAuthMiddleware,
  usesInternalAdminDuetSession,
} from './middleware-routing'

describe('auth middleware routing', () => {
  test('runs the server-side auth code exchange on the canonical sign-in route', () => {
    expect(usesAuthMiddleware('/sign-in')).toBe(true)
    expect(usesAuthMiddleware('/es/sign-in')).toBe(false)
    expect(usesAuthMiddleware('/pricing')).toBe(false)
    expect(shouldHandleAuthCode('/sign-in', true)).toBe(true)
    expect(shouldHandleAuthCode('/sign-in', false)).toBe(false)
    expect(shouldHandleAuthCode('/auth/magic-link/callback', true)).toBe(false)
  })

  test('admits only the internal-admin shell through an existing Duet session', () => {
    expect(usesInternalAdminDuetSession('/internal-admin', true)).toBe(true)
    expect(usesInternalAdminDuetSession('/internal-admin', false)).toBe(false)
    expect(usesInternalAdminDuetSession('/w/acme/sessions', true)).toBe(false)
    expect(usesInternalAdminDuetSession('/internal-admin/workspace', true)).toBe(false)
  })

  test('protects every root-mounted product path while leaving removed app paths unsupported', () => {
    for (const pathname of ['/', '/w/acme/sessions', '/settings/billing', '/internal-admin']) {
      expect(usesAuthMiddleware(pathname)).toBe(true)
    }
    expect(usesAuthMiddleware('/app')).toBe(false)
    expect(usesAuthMiddleware('/app/w/acme/sessions')).toBe(false)
  })
})
