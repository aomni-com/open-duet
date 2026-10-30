import { type SessionInputSender } from '@repo/contract'

import { credentialIdentityForAuth } from './credential-identity'
import { type ApiContext, type AuthPayload } from './shared'

// The API is the only owner of authorship derivation: clients name at most a
// source session, and every other sender comes from the authenticated
// credential or the route's own path.
export class SenderDerivationError extends Error {}

export function deriveCredentialSender(auth: AuthPayload): SessionInputSender {
  const identity = credentialIdentityForAuth(auth)
  switch (identity.kind) {
    case 'browser-human':
    case 'api-human':
      return { kind: 'user', userId: identity.userId }
    case 'app':
      if (identity.appId === undefined) {
        throw new SenderDerivationError('Credential carries no app identity')
      }
      return { kind: 'app', appId: identity.appId }
    case 'workspace':
      return { kind: 'system' }
  }
}

export function resolveInputSender(args: {
  auth: AuthPayload
  parentSessionId?: string
  sourceSessionId?: string
}): SessionInputSender {
  if (args.parentSessionId !== undefined) {
    return { kind: 'session', sessionId: args.parentSessionId }
  }
  if (args.sourceSessionId !== undefined) {
    return { kind: 'session', sessionId: args.sourceSessionId }
  }
  return deriveCredentialSender(args.auth)
}

// Route-facing adapter in the local `{ response }` idiom. Convex owns the
// authoritative same-workspace check on a session sender.
export function requireInputSender(
  c: ApiContext,
  args: { parentSessionId?: string; sourceSessionId?: string } = {},
): SessionInputSender | { response: Response } {
  try {
    return resolveInputSender({ auth: c.get('auth'), ...args })
  } catch (error) {
    if (error instanceof SenderDerivationError)
      return { response: c.json({ error: 'forbidden' }, 403) }
    throw error
  }
}
