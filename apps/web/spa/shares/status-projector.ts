import type { ShareState, ShareSyncStatus } from '@repo/contract'

export type ShareManagementDirection = 'incoming' | 'outgoing'
export type ShareManagementAction = 'unlink' | 'revoke'
export type ShareStatusPill =
  | 'pending'
  | 'expired'
  | 'unlinked'
  | 'revoked'
  | 'paused'
  | 'syncing'
  | 'upToDate'
export type ShareStatusExplanation =
  | 'awaitingAcceptance'
  | 'invitationExpired'
  | 'linkEnded'
  | 'accessRevoked'
  | 'sharingPaused'
  | 'applyingCurrentConfiguration'
  | 'currentConfigurationReady'

type ProjectableRealization = Pick<
  NonNullable<ShareSyncStatus['origin']>,
  'state' | 'matchesCurrentGeneration'
>

export type ShareStatusInput = {
  direction: ShareManagementDirection
  state: ShareState
  sync?: {
    origin?: ProjectableRealization
    recipient?: ProjectableRealization
  }
}

export type ProjectedShareStatus = {
  pill: ShareStatusPill
  explanation: ShareStatusExplanation
  actions: ShareManagementAction[]
}

export function projectShareStatus(input: ShareStatusInput): ProjectedShareStatus {
  if (input.state === 'pending') {
    return {
      pill: 'pending',
      explanation: 'awaitingAcceptance',
      actions: input.direction === 'outgoing' ? ['revoke'] : [],
    }
  }
  if (input.state === 'expired') {
    return {
      pill: 'expired',
      explanation: 'invitationExpired',
      actions: input.direction === 'outgoing' ? ['revoke'] : [],
    }
  }
  if (input.state === 'unlinked') {
    return { pill: 'unlinked', explanation: 'linkEnded', actions: [] }
  }
  if (input.state === 'revoked') {
    return { pill: 'revoked', explanation: 'accessRevoked', actions: [] }
  }
  if (
    input.sync?.origin?.state === 'paused' &&
    input.sync.origin.matchesCurrentGeneration &&
    input.sync.recipient?.state === 'paused' &&
    input.sync.recipient.matchesCurrentGeneration
  ) {
    return {
      pill: 'paused',
      explanation: 'sharingPaused',
      actions: input.direction === 'incoming' ? ['unlink'] : ['revoke'],
    }
  }
  if (
    input.sync?.origin?.state === 'ready' &&
    input.sync.origin.matchesCurrentGeneration &&
    input.sync.recipient?.state === 'ready' &&
    input.sync.recipient.matchesCurrentGeneration
  ) {
    return {
      // "Up to date" means both VMs applied the current sync configuration
      // healthily. It never claims byte-for-byte file equality.
      pill: 'upToDate',
      explanation: 'currentConfigurationReady',
      actions: input.direction === 'incoming' ? ['unlink'] : ['revoke'],
    }
  }

  return {
    pill: 'syncing',
    explanation: 'applyingCurrentConfiguration',
    actions: input.direction === 'incoming' ? ['unlink'] : ['revoke'],
  }
}
