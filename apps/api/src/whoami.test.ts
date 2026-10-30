import { describe, expect, test } from 'bun:test'

import { API_VERSION, type ApiCredentialKind } from '@repo/contract'

import type { AuthPayload } from './shared'
import { whoamiResponseForAuth } from './whoami'

const EXISTING_KINDS = [
  'user',
  'system_vm',
  'app',
  'impersonation',
  'browser_session',
] as const satisfies readonly ApiCredentialKind[]

function authFor(kind: ApiCredentialKind, audience?: string): AuthPayload {
  return {
    credentialKind: kind,
    user: { id: 'user_1', email: 'owner@example.com', name: 'Owner' },
    workspaces: [],
    scopes: [],
    versions: API_VERSION,
    ...(audience === undefined ? {} : { audience }),
  }
}

describe('whoami credential projection', () => {
  test('adds credential kind for every existing kind without removing prior fields', () => {
    for (const kind of EXISTING_KINDS) {
      expect(whoamiResponseForAuth(authFor(kind))).toEqual({
        user: { id: 'user_1', email: 'owner@example.com', name: 'Owner' },
        workspaces: [],
        scopes: [],
        versions: API_VERSION,
        internalAdmin: false,
        credential: { kind },
      })
    }
  })

  test('includes audience only when the credential carries one', () => {
    expect(whoamiResponseForAuth(authFor('oauth', 'https://mcp.duet.so/'))).toMatchObject({
      credential: { kind: 'oauth', audience: 'https://mcp.duet.so/' },
    })
  })
})
