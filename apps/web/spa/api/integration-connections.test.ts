import { expect, test } from 'bun:test'

import type { IntegrationConnection } from '@repo/contract'

import { integrationConnectionsPollInterval } from './query-options'

const connection = (status: IntegrationConnection['status']): IntegrationConnection => ({
  id: `gmail-${status}`,
  integration: 'gmail',
  status,
  connectedAt: 1,
  updatedAt: 1,
})

test('polls integration connections only while one remains pending', () => {
  expect(integrationConnectionsPollInterval(undefined, 1_500)).toBe(false)
  expect(
    integrationConnectionsPollInterval({ items: [connection('pending')], nextCursor: null }, 1_500),
  ).toBe(1_500)
  expect(
    integrationConnectionsPollInterval(
      { items: [connection('active'), connection('error')], nextCursor: null },
      1_500,
    ),
  ).toBe(false)
})
