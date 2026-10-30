import { expect, test } from 'bun:test'

import { QueryClient } from '@tanstack/react-query'

import type { SpaApi } from '../context'
import { duetQueryKeys } from './query-keys'
import {
  connectedProviderPollInterval,
  duetMutationOptions,
  duetQueryOptions,
} from './query-options'

test('polls a connect session only while the server reports a transient state', () => {
  expect(connectedProviderPollInterval(undefined, 1_500)).toBe(false)
  expect(connectedProviderPollInterval({ status: 'pending' }, 1_500)).toBe(1_500)
  expect(
    connectedProviderPollInterval(
      {
        status: 'awaiting_code',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://provider.example.test/device',
        expiresAt: 10_000,
      },
      1_500,
    ),
  ).toBe(1_500)
  expect(
    connectedProviderPollInterval(
      {
        status: 'connected',
        connection: {
          provider: 'openai-codex',
          state: 'connected',
          connectedAt: 1,
        },
      },
      1_500,
    ),
  ).toBe(false)
  expect(connectedProviderPollInterval({ status: 'failed', reason: 'expired' }, 1_500)).toBe(false)
})

test('connect and disconnect mutations invalidate the authoritative provider list', async () => {
  const queryClient = new QueryClient()
  const keys = [
    duetQueryKeys.workspaces.connectedProviders.list('acme'),
    duetQueryKeys.workspaces.connectedProviders.list('other'),
    duetQueryKeys.workspaces.connectedProviders.connectPoll('acme', 'session-1'),
  ]
  const api = {
    connectConnectedProvider: async () => ({
      sessionId: 'session-1',
      intervalMs: 1_500,
    }),
    disconnectConnectedProvider: async () => ({ ok: true as const }),
  } satisfies Pick<SpaApi, 'connectConnectedProvider' | 'disconnectConnectedProvider'>

  for (const kind of ['connect', 'disconnect'] as const) {
    for (const key of keys) queryClient.setQueryData(key, { value: 'cached' })
    if (kind === 'connect') {
      await queryClient
        .getMutationCache()
        .build(
          queryClient,
          duetMutationOptions.workspaces.connectedProviders.connect(api, queryClient, 'acme'),
        )
        .execute('openai-codex')
    } else {
      await queryClient
        .getMutationCache()
        .build(
          queryClient,
          duetMutationOptions.workspaces.connectedProviders.disconnect(api, queryClient, 'acme'),
        )
        .execute('openai-codex')
    }
    expect(keys.map(key => queryClient.getQueryState(key)?.isInvalidated)).toEqual([
      true,
      false,
      false,
    ])
  }
  queryClient.clear()
})

test('keeps provider list and connect-session polling in separate workspace cache entries', () => {
  const api = {} as SpaApi

  expect([...duetQueryOptions.workspaces.connectedProviders.list(api, 'acme').queryKey]).toEqual([
    ...duetQueryKeys.workspaces.connectedProviders.list('acme'),
  ])
  expect([
    ...duetQueryOptions.workspaces.connectedProviders.poll(api, 'acme', 'session-1', 1_500)
      .queryKey,
  ]).toEqual([...duetQueryKeys.workspaces.connectedProviders.connectPoll('acme', 'session-1')])
})
