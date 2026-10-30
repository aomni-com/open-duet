import type { ConnectedProviderId, ConnectPollResponse, ConnectStartResponse } from '@repo/contract'

import type { ConnectedProviderListItem } from '../api/client'

export type ConnectedProviderPresentation =
  | { provider: ConnectedProviderId; state: 'disconnected' }
  | { provider: ConnectedProviderId; state: 'connecting' }
  | {
      provider: ConnectedProviderId
      state: 'awaiting_code'
      userCode: string
      verificationUri: string
    }
  | {
      provider: ConnectedProviderId
      state: 'connected'
      connectedByLabel?: string
      canDisconnect: boolean
    }
  | { provider: ConnectedProviderId; state: 'plan_ineligible'; canDisconnect: boolean }
  | { provider: ConnectedProviderId; state: 'reconnect_needed'; canDisconnect: boolean }
  | { provider: ConnectedProviderId; state: 'failed' }
  | { provider: ConnectedProviderId; state: 'disconnecting' }

const CONNECTED_PROVIDER_IDS = ['openai-codex', 'github-copilot'] as const

export function projectConnectedProviderRows({
  listed,
  connectSession,
  poll,
  connectingProvider,
  failedProvider,
  disconnectingProvider,
}: {
  listed: ConnectedProviderListItem[]
  connectSession?: ConnectStartResponse & { provider: ConnectedProviderId }
  poll?: ConnectPollResponse
  connectingProvider?: ConnectedProviderId
  failedProvider?: ConnectedProviderId
  disconnectingProvider?: ConnectedProviderId
}): ConnectedProviderPresentation[] {
  return CONNECTED_PROVIDER_IDS.map(provider => {
    if (disconnectingProvider === provider) return { provider, state: 'disconnecting' }
    if (connectingProvider === provider) return { provider, state: 'connecting' }
    if (failedProvider === provider) return { provider, state: 'failed' }

    const connection = listed.find(candidate => candidate.provider === provider)
    if (connectSession?.provider === provider) {
      if (poll?.status === 'failed') {
        if (poll.reason === 'plan_ineligible') {
          if (connection?.state === 'plan_ineligible') return listedProviderRow(connection)
          return { provider, state: 'plan_ineligible', canDisconnect: false }
        }
        return { provider, state: 'failed' }
      }
      if (poll?.status === 'connected') {
        if (connection?.state === 'connected') return listedProviderRow(connection)
        return {
          provider,
          state: 'connected',
          connectedByLabel: poll.connection.connectedByLabel,
          canDisconnect: false,
        }
      }
      if (poll?.status === 'awaiting_code') {
        return {
          provider,
          state: 'awaiting_code',
          userCode: poll.userCode,
          verificationUri: poll.verificationUri,
        }
      }
      return { provider, state: 'connecting' }
    }

    return connection === undefined
      ? { provider, state: 'disconnected' }
      : listedProviderRow(connection)
  })
}

function listedProviderRow(connection: ConnectedProviderListItem): ConnectedProviderPresentation {
  if (connection.state === 'connected') {
    return {
      provider: connection.provider,
      state: 'connected',
      connectedByLabel: connection.connectedByLabel,
      canDisconnect: connection.canDisconnect,
    }
  }
  return {
    provider: connection.provider,
    state: connection.state,
    canDisconnect: connection.canDisconnect,
  }
}
