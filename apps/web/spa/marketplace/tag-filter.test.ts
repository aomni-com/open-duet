import { describe, expect, test } from 'bun:test'

import { orderListings, selectListings } from './tag-filter'

const listing = (
  title: string,
  tags: readonly string[],
  installs = 0,
): { title: string; tags: readonly string[]; installs: number } => ({ title, tags, installs })

describe('catalog tag rail', () => {
  test('All keeps every listing, including one with no tags', () => {
    const rows = [listing('Tagged', ['sales']), listing('Untagged', [])]
    expect(selectListings(rows, null).map(row => row.title)).toEqual(['Tagged', 'Untagged'])
  })

  test('a chip keeps only the listings carrying that tag', () => {
    const rows = [
      listing('Sales one', ['sales']),
      listing('Both', ['sales', 'marketing']),
      listing('Marketing only', ['marketing']),
    ]
    expect(selectListings(rows, 'sales').map(row => row.title)).toEqual(['Both', 'Sales one'])
  })

  test('orders by installs, then alphabetically', () => {
    const rows = [listing('Zebra', [], 5), listing('Apple', [], 9), listing('Mango', [], 5)]
    expect(orderListings(rows).map(row => row.title)).toEqual(['Apple', 'Mango', 'Zebra'])
  })

  test('the order is stable when every listing has the same install count', () => {
    /* At launch installs are all zero. Sorting on installs alone leaves ties
       to the engine and the gallery reshuffles between renders; the
       alphabetical tiebreak is what makes the order a fact rather than an
       accident. */
    const rows = [listing('Charlie', []), listing('Alpha', []), listing('Bravo', [])]
    expect(orderListings(rows).map(row => row.title)).toEqual(['Alpha', 'Bravo', 'Charlie'])
    expect(orderListings([...rows].reverse()).map(row => row.title)).toEqual([
      'Alpha',
      'Bravo',
      'Charlie',
    ])
  })

  test('does not mutate the array it was handed', () => {
    const rows = [listing('Zebra', [], 1), listing('Apple', [], 2)]
    orderListings(rows)
    expect(rows.map(row => row.title)).toEqual(['Zebra', 'Apple'])
  })
})
