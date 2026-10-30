import { expect, test } from 'bun:test'

import { QueryClient } from '@tanstack/react-query'

import { duetQueryKeys } from './query-keys'
import { invalidateAfterCheckoutReturn } from './query-options'

test('returning from checkout stales the wallet, the receipts, and the servicing verdict', () => {
  const queryClient = new QueryClient()
  const keys = [
    duetQueryKeys.user.billing.overview,
    duetQueryKeys.user.billing.history,
    duetQueryKeys.identity,
    duetQueryKeys.workspaces.apps.list('acme'),
  ]
  for (const key of keys) queryClient.setQueryData(key, { value: 'cached' })

  invalidateAfterCheckoutReturn(queryClient)

  expect(keys.map(key => queryClient.getQueryState(key)?.isInvalidated)).toEqual([
    true,
    true,
    true,
    false,
  ])
  queryClient.clear()
})
