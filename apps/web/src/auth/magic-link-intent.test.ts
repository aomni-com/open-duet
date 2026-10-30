import { describe, expect, test } from 'bun:test'

import { createMagicLinkIntent, type MagicLinkStart } from './magic-link-intent'

describe('magic-link browser intent', () => {
  test('returns the magic link to the browser origin that requested it', async () => {
    let start: MagicLinkStart | undefined
    const response = await createMagicLinkIntent(
      new Request('http://localhost:3000/api/auth/magic-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({ email: 'person@example.com', returnTo: '/w/acme/sessions' }),
      }),
      async value => {
        start = value
      },
      () => 'a'.repeat(32),
    )

    expect(response.status).toBe(204)
    expect(start).toEqual({
      email: 'person@example.com',
      redirectTo: `http://localhost:3000/auth/magic-link/callback?returnTo=%2Fw%2Facme%2Fsessions&intent=${'a'.repeat(32)}`,
    })
    expect(response.headers.getSetCookie()).toEqual([
      `duet_magic_link_intent=${'a'.repeat(32)}; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax`,
      '__convexAuthOAuthVerifier=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
    ])
  })

  test('binds a safe email-link request to an HttpOnly browser intent', async () => {
    let start: MagicLinkStart | undefined
    const response = await createMagicLinkIntent(
      new Request('https://app-staging.duet.so/api/auth/magic-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://app-staging.duet.so' },
        body: JSON.stringify({
          email: ' person@example.com ',
          returnTo: '/w/acme/sessions',
        }),
      }),
      async value => {
        start = value
      },
      () => 'a'.repeat(32),
    )

    expect(response.status).toBe(204)
    expect(start).toEqual({
      email: 'person@example.com',
      redirectTo: `https://app-staging.duet.so/auth/magic-link/callback?returnTo=%2Fw%2Facme%2Fsessions&intent=${'a'.repeat(32)}`,
    })
    expect(response.headers.getSetCookie()).toEqual([
      `__Host-duet_magic_link_intent=${'a'.repeat(32)}; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax; Secure`,
      '__Host-__convexAuthOAuthVerifier=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
    ])
  })

  test('rejects a cross-origin attempt to preload another browser with an intent', async () => {
    let sent = false
    const response = await createMagicLinkIntent(
      new Request('https://app-staging.duet.so/api/auth/magic-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
        body: JSON.stringify({ email: 'attacker@example.com', returnTo: '/' }),
      }),
      async () => {
        sent = true
      },
    )

    expect(response.status).toBe(403)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(sent).toBe(false)
  })
})

describe('magic-link delivery failures', () => {
  test('fails loudly on delivery error', async () => {
    await expect(
      createMagicLinkIntent(
        new Request('http://localhost:3000/api/auth/magic-link', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
          body: JSON.stringify({ email: 'person@example.com', returnTo: '/' }),
        }),
        async () => {
          throw new Error('Magic-link delivery did not start')
        },
        () => 'a'.repeat(32),
      ),
    ).rejects.toThrow('Magic-link delivery did not start')
  })
})
