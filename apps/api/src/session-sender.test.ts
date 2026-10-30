import { describe, expect, test } from 'bun:test'

import { API_VERSION, type ApiCredentialKind } from '@repo/contract'

import { deriveCredentialSender, resolveInputSender } from './session-sender'
import { type AuthPayload } from './shared'

const OWNER = { id: 'user_owner', email: 'owner@example.com', name: 'Owner' }

function auth(
  credentialKind: ApiCredentialKind,
  overrides: Partial<AuthPayload> = {},
): AuthPayload {
  return {
    credentialKind,
    user: OWNER,
    workspaces: [],
    scopes: ['ws:acme:sessions'],
    versions: API_VERSION,
    ...overrides,
  }
}

describe('durable input sender derivation', () => {
  test('every human-carrying credential authors as the authenticated user', () => {
    for (const kind of ['browser_session', 'user', 'oauth', 'impersonation'] as const) {
      expect(deriveCredentialSender(auth(kind))).toEqual({ kind: 'user', userId: 'user_owner' })
    }
  })

  test('an app key authors as its app and a VM key as the system, never as the owner', () => {
    // Both credentials are provisioned by, and carry, the workspace owner's
    // account. Authorship must come from the credential, not that actor.
    const appAuth = auth('app', { app: { id: 'app_calendar', slug: 'calendar' } })
    const vmAuth = auth('system_vm')

    expect(deriveCredentialSender(appAuth)).toEqual({ kind: 'app', appId: 'app_calendar' })
    expect(deriveCredentialSender(vmAuth)).toEqual({ kind: 'system' })
    expect(appAuth.user.id).toBe(vmAuth.user.id)
  })

  test('an app credential without its app identity fails closed', () => {
    expect(() => deriveCredentialSender(auth('app'))).toThrow(/app identity/i)
  })
})

describe('resolved input sender', () => {
  test('a nested create authors as its parent session whatever the credential is', () => {
    for (const kind of ['browser_session', 'user', 'app', 'system_vm'] as const) {
      expect(
        resolveInputSender({
          auth: auth(kind, { app: { id: 'app_calendar', slug: 'calendar' } }),
          parentSessionId: 'session_parent',
        }),
      ).toEqual({ kind: 'session', sessionId: 'session_parent' })
    }
  })

  test('any sessions-scoped credential may name a source session', () => {
    for (const kind of [
      'browser_session',
      'user',
      'oauth',
      'impersonation',
      'system_vm',
    ] as const) {
      expect(resolveInputSender({ auth: auth(kind), sourceSessionId: 'session_source' })).toEqual({
        kind: 'session',
        sessionId: 'session_source',
      })
    }
    expect(
      resolveInputSender({
        auth: auth('app', { app: { id: 'app_calendar', slug: 'calendar' } }),
        sourceSessionId: 'session_source',
      }),
    ).toEqual({ kind: 'session', sessionId: 'session_source' })
  })

  test('without a route parent or a named source the credential decides', () => {
    expect(resolveInputSender({ auth: auth('browser_session') })).toEqual({
      kind: 'user',
      userId: 'user_owner',
    })
    expect(resolveInputSender({ auth: auth('system_vm') })).toEqual({ kind: 'system' })
  })
})
