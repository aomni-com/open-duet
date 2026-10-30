import { describe, expect, test } from 'bun:test'

import { completeMagicLinkCallback } from './magic-link-callback'

const INTENT = 'a'.repeat(32)
const CODE = 'RNP4-4Y37'

function callback(params: { intent: string; code: string; cookie?: string }): Response {
  return completeMagicLinkCallback(
    new Request(
      `https://app-staging.duet.so/auth/magic-link/callback?returnTo=%2Fw%2Facme%2Fsessions` +
        `&intent=${params.intent}&code=${encodeURIComponent(params.code)}`,
    ),
    params.cookie ?? params.intent,
  )
}

describe('magic-link callback', () => {
  test('forwards the code only when the link matches the requesting browser', () => {
    const valid = callback({ intent: INTENT, code: CODE })
    expect(valid.status).toBe(307)
    expect(valid.headers.get('location')).toBe(
      `https://app-staging.duet.so/sign-in?returnTo=%2Fw%2Facme%2Fsessions&code=${CODE}&intent=${INTENT}`,
    )
    expect(valid.headers.get('set-cookie')).toBeNull()

    const forwarded = callback({ intent: INTENT, code: CODE, cookie: 'b'.repeat(32) })
    expect(forwarded.status).toBe(307)
    expect(forwarded.headers.get('location')).toBe(
      'https://app-staging.duet.so/sign-in?returnTo=%2Fw%2Facme%2Fsessions&authError=invalid-link',
    )
    expect(forwarded.headers.get('location')).not.toContain(CODE)
    expect(forwarded.headers.get('set-cookie')).toBe(
      '__Host-duet_magic_link_intent=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
    )
  })

  // The nonce and the code used to share one 32-hex pattern, so a code-shaped
  // change to the sign-in provider would have failed here silently — the old
  // fixture handed the callback a 32-hex "code" and it passed. These two cases
  // pin the split: each grammar judges its own field, and neither accepts the
  // other's.
  test('judges the code by the code grammar, not the intent nonce pattern', () => {
    const hexCode = callback({ intent: INTENT, code: 'c'.repeat(32) })
    expect(hexCode.headers.get('location')).toContain('authError=invalid-link')
    expect(hexCode.headers.get('location')).not.toContain('c'.repeat(32))
  })

  test('still judges the intent by the nonce pattern', () => {
    const typedIntent = callback({ intent: CODE, code: CODE })
    expect(typedIntent.headers.get('location')).toContain('authError=invalid-link')
  })
})
