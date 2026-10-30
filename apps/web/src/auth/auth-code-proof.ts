import { MAGIC_LINK_INTENT_PATTERN } from './magic-link-intent'

export type AuthCodeProof = 'magic-link' | 'oauth'

/** How the sign-in card names the exchange the browser just came back from. */
export type AuthReturn = 'google' | 'magic-link'

/**
 * Translate the proof the proxy stamped on the return URL into the card's own
 * vocabulary. The proof is provider-shaped ('oauth' covers whichever provider
 * owns the verifier cookie); the card is phase-shaped, and Google is the only
 * OAuth provider it renders a handoff for.
 */
export function authReturnFromProof(proof: string | undefined): AuthReturn | undefined {
  if (proof === 'oauth') return 'google'
  return proof === 'magic-link' ? 'magic-link' : undefined
}

export function resolveAuthCodeProof(input: {
  pathname: string
  code: string | null
  intent: string | null
  intentCookie: string | undefined
  oauthVerifierCookie: string | undefined
}): AuthCodeProof | undefined {
  if (input.pathname !== '/sign-in' || input.code === null) return undefined
  if (matchesMagicLinkIntent(input.intent, input.intentCookie)) return 'magic-link'
  return input.oauthVerifierCookie === undefined ? undefined : 'oauth'
}

export function matchesMagicLinkIntent(
  linkIntent: string | null,
  cookieIntent: string | undefined,
): boolean {
  if (
    linkIntent === null ||
    cookieIntent === undefined ||
    !MAGIC_LINK_INTENT_PATTERN.test(linkIntent) ||
    !MAGIC_LINK_INTENT_PATTERN.test(cookieIntent)
  ) {
    return false
  }
  let difference = 0
  for (let index = 0; index < linkIntent.length; index += 1) {
    difference |= linkIntent.charCodeAt(index) ^ cookieIntent.charCodeAt(index)
  }
  return difference === 0
}
