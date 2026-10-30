import { type AuthPayload } from './shared'

type CredentialIdentity =
  | { kind: 'browser-human'; userId: string; actorId: string }
  | { kind: 'api-human'; userId: string; actorId: string; credentialId?: string }
  | { kind: 'app'; appId?: string; actorId: string }
  | { kind: 'workspace'; actorId: string }

export function credentialIdentityForAuth(auth: AuthPayload): CredentialIdentity {
  const actorId = requireIdentity(auth.user?.id, 'user identity')
  switch (auth.credentialKind) {
    case 'browser_session':
    case 'impersonation':
      return { kind: 'browser-human', userId: actorId, actorId }
    case 'user':
    case 'oauth':
      return {
        kind: 'api-human',
        userId: actorId,
        actorId,
        ...(auth.credentialId === undefined ? {} : { credentialId: auth.credentialId }),
      }
    case 'app':
      return { kind: 'app', ...(auth.app === undefined ? {} : { appId: auth.app.id }), actorId }
    case 'system_vm':
      return { kind: 'workspace', actorId }
  }
}

function requireIdentity(value: string | undefined, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Authenticated credential is missing ${label}`)
  }
  return value
}
