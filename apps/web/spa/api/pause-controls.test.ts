import { expect, test } from 'bun:test'

import { QueryClient } from '@tanstack/react-query'

import type { SpaApi } from '../context'
import { duetQueryKeys } from './query-keys'
import { duetQueryOptions, invalidateAfterPauseMutation } from './query-options'

// OA-SLICE-12-KZQ7

test('publish query options use the workspace publish cache owner', () => {
  const api = {} as SpaApi

  expect([...duetQueryOptions.workspaces.publishes(api, 'acme').queryKey]).toEqual([
    ...duetQueryKeys.workspaces.publishes('acme'),
  ])
})

test('pause mutations invalidate only the affected workspace resource family', () => {
  for (const resource of ['publish', 'share'] as const) {
    const queryClient = new QueryClient()
    const publishKey = duetQueryKeys.workspaces.publishes('acme')
    const shareKey = duetQueryKeys.workspaces.shares('acme')
    const expected = resource === 'publish' ? publishKey : shareKey
    const keys = [
      publishKey,
      shareKey,
      [...expected, 'detail', 'one'] as const,
      duetQueryKeys.workspaces.publishes('other'),
      duetQueryKeys.workspaces.shares('other'),
    ]
    for (const key of keys) queryClient.setQueryData(key, { id: 'one' })

    invalidateAfterPauseMutation(queryClient, 'acme', resource)

    expect(keys.map(key => queryClient.getQueryState(key)?.isInvalidated)).toEqual([
      resource === 'publish',
      resource === 'share',
      true,
      false,
      false,
    ])
    queryClient.clear()
  }
})
