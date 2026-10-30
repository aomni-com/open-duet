import { type Infer, v } from 'convex/values'

export const sessionRequestIdentityValidator = v.object({
  principal: v.union(
    v.object({ kind: v.literal('human'), userId: v.id('users') }),
    v.object({ kind: v.literal('workspace') }),
  ),
  actorId: v.id('users'),
})

export type SessionRequestIdentity = Infer<typeof sessionRequestIdentityValidator>

export function assertSessionIdentityAttribution(
  identity: SessionRequestIdentity,
  actorId: SessionRequestIdentity['actorId'],
): void {
  if (
    identity.actorId !== actorId ||
    (identity.principal.kind === 'human' && identity.principal.userId !== identity.actorId)
  ) {
    throw new Error('Session creation identity does not match attribution')
  }
}
