import { type FileActorContext } from '@repo/contract'

import { credentialIdentityForAuth } from '../credential-identity'
import { type AuthPayload } from '../shared'

// The SOLE producer of the actor header (spec ownership map): every proxied
// file operation names its actor here, synthesized from authenticated state —
// never from anything a client sent (MAP L4).
export function actorContextForAuth(auth: AuthPayload): FileActorContext {
  const identity = credentialIdentityForAuth(auth)
  switch (identity.kind) {
    case 'browser-human':
      return { kind: 'web', userId: identity.userId }
    case 'workspace':
    case 'app':
      return { kind: 'system' }
    case 'api-human':
      if (identity.credentialId === undefined) throw new Error('API auth is missing credentialId')
      return { kind: 'api-key', keyId: identity.credentialId }
  }
}
