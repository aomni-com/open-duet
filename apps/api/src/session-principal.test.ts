import { describe, expect, test } from 'bun:test'

import { API_VERSION, type ApiCredentialKind } from '@repo/contract'

import { sessionRequestIdentityForAuth } from './session-principal'
import { type AuthPayload } from './shared'

function auth(credentialKind: ApiCredentialKind): AuthPayload {
  return {
    credentialKind,
    ...(credentialKind === 'user' || credentialKind === 'oauth'
      ? { credentialId: `key_${credentialKind}` }
      : {}),
    user: { id: 'user_owner', email: 'owner@example.com' },
    workspaces: [],
    scopes: ['ws:acme:sessions'],
    versions: API_VERSION,
  }
}

describe('session request identity', () => {
  test('human credentials authorize as their authenticated user', () => {
    for (const credentialKind of ['browser_session', 'user', 'oauth', 'impersonation'] as const) {
      expect(sessionRequestIdentityForAuth(auth(credentialKind))).toEqual({
        principal: { kind: 'human', userId: 'user_owner' },
        actorId: 'user_owner',
      })
    }
  })

  test('app and VM credentials authorize as the workspace, not their actor', () => {
    const app = auth('app')
    app.app = { id: 'app_calendar', slug: 'calendar' }

    expect(sessionRequestIdentityForAuth(app)).toEqual({
      principal: { kind: 'workspace' },
      actorId: 'user_owner',
    })
    expect(sessionRequestIdentityForAuth(auth('system_vm'))).toEqual({
      principal: { kind: 'workspace' },
      actorId: 'user_owner',
    })
  })
})
