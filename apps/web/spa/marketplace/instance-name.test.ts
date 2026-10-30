import { expect, test } from 'bun:test'

import {
  marketplaceAdditionalInstallTarget,
  marketplaceNamedInstallRequest,
  nextMarketplaceInstanceName,
} from './instance-name'

test('turns a confirmed additional-instance name into its explicit install target', () => {
  expect(marketplaceAdditionalInstallTarget('  Customer Portal  ')).toEqual({
    name: 'Customer Portal',
    slug: 'customer-portal',
    path: 'agents/customer-portal',
  })
  expect(marketplaceAdditionalInstallTarget('   ')).toBeUndefined()
})

test('proposes the next editable human name after each explicit-path collision', () => {
  expect(nextMarketplaceInstanceName('Customer Portal')).toBe('Customer Portal 2')
  expect(nextMarketplaceInstanceName('Customer Portal 2')).toBe('Customer Portal 3')
})

test('keeps initial installs pathless while additional installs carry the confirmed target', () => {
  expect(marketplaceNamedInstallRequest('initial', 'listing-web', '')).toEqual({
    listingId: 'listing-web',
  })
  expect(marketplaceNamedInstallRequest('initial', 'listing-web', 'Customer Portal')).toEqual({
    listingId: 'listing-web',
    name: 'Customer Portal',
  })
  expect(marketplaceNamedInstallRequest('additional', 'listing-web', '')).toBeUndefined()
  expect(marketplaceNamedInstallRequest('additional', 'listing-web', 'Customer Portal')).toEqual({
    listingId: 'listing-web',
    name: 'Customer Portal',
    path: 'agents/customer-portal',
  })
})
