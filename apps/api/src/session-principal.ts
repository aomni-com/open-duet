import { type SessionRequestIdentity } from '@repo/contract'

import { credentialIdentityForAuth } from './credential-identity'
import { type AuthPayload } from './shared'

export function sessionRequestIdentityForAuth(auth: AuthPayload): SessionRequestIdentity {
  const identity = credentialIdentityForAuth(auth)
  switch (identity.kind) {
    case 'browser-human':
    case 'api-human':
      return {
        principal: { kind: 'human', userId: identity.userId },
        actorId: identity.actorId,
      }
    case 'app':
    case 'workspace':
      return { principal: { kind: 'workspace' }, actorId: identity.actorId }
  }
}
