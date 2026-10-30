import { describe, expect, test } from 'bun:test'

import { API_VERSION, DUET_ACTOR_CONTEXT_HEADER, encodeActorContext } from '@repo/contract'

import { type AuthPayload } from '../shared'
import { actorContextForAuth } from './actor'
import { FILES_REQUEST_HEADERS, MEMORY_REQUEST_HEADERS, TRAIN_REQUEST_HEADERS } from './client'

function authFor(
  credentialKind: AuthPayload['credentialKind'],
  credentialId?: string,
): AuthPayload {
  return {
    credentialKind,
    ...(credentialId === undefined ? {} : { credentialId }),
    user: { id: 'user_123', email: 'actor@example.com' },
    workspaces: [],
    scopes: [],
    versions: API_VERSION,
  }
}

describe('actorContextForAuth', () => {
  test('maps every credential kind onto the file-attribution actor grammar', () => {
    expect(actorContextForAuth(authFor('browser_session'))).toEqual({
      kind: 'web',
      userId: 'user_123',
    })
    expect(actorContextForAuth(authFor('user', 'kd7credential'))).toEqual({
      kind: 'api-key',
      keyId: 'kd7credential',
    })
    // Impersonation sits with browser_session, not with the key kinds: the
    // person whose tab holds it is the one touching the files.
    expect(actorContextForAuth(authFor('impersonation'))).toEqual({
      kind: 'web',
      userId: 'user_123',
    })
    expect(actorContextForAuth(authFor('oauth', 'kd7oauth'))).toEqual({
      kind: 'api-key',
      keyId: 'kd7oauth',
    })
    expect(actorContextForAuth(authFor('system_vm'))).toEqual({ kind: 'system' })
    expect(actorContextForAuth(authFor('app'))).toEqual({ kind: 'system' })
  })

  test('encoded values match the contract grammar for the header wire format', () => {
    expect(encodeActorContext(actorContextForAuth(authFor('browser_session')))).toBe('web:user_123')
    expect(encodeActorContext(actorContextForAuth(authFor('user', 'kd7credential')))).toBe(
      'api-key:kd7credential',
    )
    expect(encodeActorContext(actorContextForAuth(authFor('system_vm')))).toBe('system')
    expect(encodeActorContext(actorContextForAuth(authFor('app')))).toBe('system')
  })

  test('an api key without a credential id fails loudly instead of misattributing', () => {
    expect(() => actorContextForAuth(authFor('user'))).toThrow('missing credentialId')
    expect(() => actorContextForAuth(authFor('oauth'))).toThrow('missing credentialId')
  })

  test('the actor header is never a forwarded (client-copyable) header', () => {
    for (const list of [FILES_REQUEST_HEADERS, MEMORY_REQUEST_HEADERS, TRAIN_REQUEST_HEADERS]) {
      expect(list).not.toContain(DUET_ACTOR_CONTEXT_HEADER)
    }
  })
})
