import { expect, test } from 'bun:test'

import { driveColumnRefreshInterval, driveColumnRefetchInterval } from './drive-columns-data'

test('only the three deepest visible folders refresh periodically', () => {
  const chain = ['/', '/1', '/1/2', '/1/2/3', '/1/2/3/4']
  expect(chain.map((_, index) => driveColumnRefetchInterval(chain, index))).toEqual([
    false,
    false,
    driveColumnRefreshInterval,
    driveColumnRefreshInterval,
    driveColumnRefreshInterval,
  ])
})

test('every visible folder refreshes when the chain has at most three columns', () => {
  const chain = ['/', '/research', '/research/notes']
  expect(chain.map((_, index) => driveColumnRefetchInterval(chain, index))).toEqual([
    driveColumnRefreshInterval,
    driveColumnRefreshInterval,
    driveColumnRefreshInterval,
  ])
})
