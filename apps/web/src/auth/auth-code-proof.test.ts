import { describe, expect, test } from 'bun:test'

import { authReturnFromProof, resolveAuthCodeProof } from './auth-code-proof'

describe('auth code exchange proof', () => {
  test('rejects direct magic codes and accepts only browser intent or OAuth proof', () => {
    const intent = 'a'.repeat(32)
    const base = { pathname: '/sign-in', code: 'c'.repeat(32) }

    expect(
      resolveAuthCodeProof({
        ...base,
        intent,
        intentCookie: undefined,
        oauthVerifierCookie: undefined,
      }),
    ).toBeUndefined()
    expect(
      resolveAuthCodeProof({
        ...base,
        intent,
        intentCookie: intent,
        oauthVerifierCookie: undefined,
      }),
    ).toBe('magic-link')
    expect(
      resolveAuthCodeProof({
        ...base,
        intent: null,
        intentCookie: undefined,
        oauthVerifierCookie: 'oauth-browser-verifier',
      }),
    ).toBe('oauth')
    expect(
      resolveAuthCodeProof({
        ...base,
        intent,
        intentCookie: intent,
        oauthVerifierCookie: 'stale-oauth-verifier',
      }),
    ).toBe('magic-link')
  })

  test('the card understands every proof the proxy stamps on the return URL', () => {
    // The proxy writes resolveAuthCodeProof's value into `authReturn` verbatim,
    // so the sign-in card has to speak the same vocabulary. Feed it the real
    // proofs rather than string literals: renaming a proof then has to keep
    // this pairing honest. An unmapped proof costs more than the handoff
    // spinner -- the card only reports a failed exchange when it knows it just
    // came back from one, so the user lands on a bare form with no error.
    const base = { pathname: '/sign-in', code: 'c'.repeat(32) }
    const intent = 'a'.repeat(32)
    const oauth = resolveAuthCodeProof({
      ...base,
      intent: null,
      intentCookie: undefined,
      oauthVerifierCookie: 'oauth-browser-verifier',
    })
    const magicLink = resolveAuthCodeProof({
      ...base,
      intent,
      intentCookie: intent,
      oauthVerifierCookie: undefined,
    })

    expect(authReturnFromProof(oauth)).toBe('google')
    expect(authReturnFromProof(magicLink)).toBe('magic-link')
    expect(authReturnFromProof(undefined)).toBeUndefined()
    expect(authReturnFromProof('not-a-proof')).toBeUndefined()
  })
})
