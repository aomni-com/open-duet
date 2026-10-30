export type ShareLifecycleState = 'pending' | 'active' | 'revoked' | 'unlinked'
export type ShareLifecycleAction =
  | { kind: 'accept' }
  | { kind: 'decline' }
  | { kind: 'unlink' }
  | { kind: 'revoke' }

export type ShareLifecycleIntent = 'none' | 'attach' | 'detach-replicas' | 'delete-replicas'

export interface ShareLifecycleTransition {
  patch: {
    state?: ShareLifecycleState
    acceptedAt?: number
    declinedAt?: number
    revokedAt?: number
    unlinkedAt?: number
  }
  intent: ShareLifecycleIntent
}

/**
 * The pure owner of share state transitions. Persistence, authorization,
 * anchors, replica effects, and audit all remain in the model wrapper.
 */
export function transitionShareLifecycle(
  state: ShareLifecycleState,
  action: ShareLifecycleAction,
  now: number,
): ShareLifecycleTransition {
  if (action.kind === 'revoke') {
    if (state === 'revoked') return { patch: {}, intent: 'none' }
    return {
      patch: { state: 'revoked', revokedAt: now },
      intent: 'delete-replicas',
    }
  }
  if (state === 'pending' && action.kind === 'accept') {
    return {
      patch: { state: 'active', acceptedAt: now, declinedAt: undefined },
      intent: 'attach',
    }
  }
  if (state === 'pending' && action.kind === 'decline') {
    return { patch: { declinedAt: now }, intent: 'none' }
  }
  if (state === 'active' && action.kind === 'unlink') {
    return {
      patch: { state: 'unlinked', unlinkedAt: now },
      intent: 'detach-replicas',
    }
  }
  throw new Error(`Cannot ${action.kind} a ${state} share`)
}
