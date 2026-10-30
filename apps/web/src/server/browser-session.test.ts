import { describe, expect, test } from 'bun:test'

import { hashApiKey, type BrowserSessionCredential } from '@repo/contract'

import { createBrowserSessionService } from './browser-session'

const SESSION: BrowserSessionCredential = {
  token: 'duet_sk_browser_session_fixture',
  prefix: 'duet_sk_browser_',
  expiresAt: 10_000_000,
}

describe('server-only browser session exchange', () => {
  test('passes the identity token and hashed credentials to the supplied operations', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown>; identityToken: string }> = []
    const service = createBrowserSessionService({
      getIdentityToken: async () => 'identity.jwt.fixture',
      mint: async (args, identityToken) => {
        calls.push({ name: 'domains/apiKeys/mutations:mintBrowserSession', args, identityToken })
        return SESSION
      },
      revoke: async (args, identityToken) => {
        calls.push({ name: 'domains/apiKeys/mutations:revokeBrowserSession', args, identityToken })
      },
    })

    const previousToken = 'duet_sk_previous_browser_session'
    expect(await service.rotate(previousToken)).toEqual(SESSION)
    await service.revoke(SESSION.token)

    expect(calls).toEqual([
      {
        name: 'domains/apiKeys/mutations:mintBrowserSession',
        args: { previousHashedKey: await hashApiKey(previousToken) },
        identityToken: 'identity.jwt.fixture',
      },
      {
        name: 'domains/apiKeys/mutations:revokeBrowserSession',
        args: { hashedKey: await hashApiKey(SESSION.token) },
        identityToken: 'identity.jwt.fixture',
      },
    ])
  })

  test('passes a rotation handoff through as null rather than a parse failure', async () => {
    const service = createBrowserSessionService({
      getIdentityToken: async () => 'identity.jwt.fixture',
      mint: async () => null,
      revoke: async () => {},
    })
    expect(await service.rotate('duet_sk_previous_browser_session')).toBeNull()
  })

  test('coalesces concurrent exchanges for one identity and previous session', async () => {
    let mutations = 0
    let release!: (session: BrowserSessionCredential) => void
    let markStarted!: () => void
    const started = new Promise<void>(resolve => {
      markStarted = resolve
    })
    const pending = new Promise<BrowserSessionCredential>(resolve => {
      release = resolve
    })
    const service = createBrowserSessionService({
      getIdentityToken: async () => 'identity.jwt.fixture',
      mint: async () => {
        mutations += 1
        markStarted()
        return await pending
      },
      revoke: async () => {},
    })

    const first = service.rotate('duet_sk_previous_browser_session')
    const second = service.rotate('duet_sk_previous_browser_session')
    await started
    await Bun.sleep(0)
    const whilePending = mutations
    release(SESSION)
    const completed = await Promise.all([first, second])
    expect(whilePending).toBe(1)
    expect(completed).toEqual([SESSION, SESSION])
    expect(mutations).toBe(1)
  })

  test('binds exchanges to both supplied authenticated identities', async () => {
    let currentIdentity = 'identity.one'
    const identities: string[] = []
    const service = createBrowserSessionService({
      getIdentityToken: async () => currentIdentity,
      mint: async (_args, identityToken) => {
        identities.push(identityToken)
        return SESSION
      },
      revoke: async () => {},
    })

    const first = service.mint()
    currentIdentity = 'identity.two'
    const second = service.mint()
    await Promise.all([first, second])
    expect(identities).toEqual(['identity.one', 'identity.two'])
  })

  test('rejects exchange and revocation without an authenticated identity', async () => {
    const service = createBrowserSessionService({
      getIdentityToken: async () => undefined,
      mint: async () => SESSION,
      revoke: async () => {},
    })

    await expect(service.mint()).rejects.toThrow('Convex Auth identity required')
    await expect(service.revoke(SESSION.token)).rejects.toThrow('Convex Auth identity required')
  })
})
