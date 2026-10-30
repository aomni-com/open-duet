import { expect, test } from 'bun:test'

import {
  firstEligibleIndex,
  isEligibleIndex,
  stepEligibleIndex,
} from './compose-bar-suggestion-rows'

const rows = (...disabled: boolean[]) => disabled.map(flag => ({ disabled: flag }))

test('the opening row is the first one that can be picked', () => {
  expect(firstEligibleIndex(rows(true, true, false, false))).toBe(2)
})

test('stepping skips over the rows that cannot be picked', () => {
  const list = rows(false, true, true, false)

  expect(stepEligibleIndex(list, 0, 1)).toBe(3)
  expect(stepEligibleIndex(list, 3, -1)).toBe(0)
})

test('stepping wraps past the ends, counting only pickable rows', () => {
  const list = rows(false, true, false)

  expect(stepEligibleIndex(list, 2, 1)).toBe(0)
  expect(stepEligibleIndex(list, 0, -1)).toBe(2)
})

test('a list with nothing pickable has no row to land on', () => {
  expect(firstEligibleIndex(rows(true, true))).toBeNull()
  expect(stepEligibleIndex(rows(true, true), null, 1)).toBeNull()
  expect(stepEligibleIndex([], null, 1)).toBeNull()
})

test('the only pickable row stays put rather than stepping off itself', () => {
  const list = rows(true, false, true)

  expect(stepEligibleIndex(list, 1, 1)).toBe(1)
  expect(stepEligibleIndex(list, 1, -1)).toBe(1)
})

test('a commit is refused for a row that is missing or cannot be picked', () => {
  const list = rows(false, true)

  expect(isEligibleIndex(list, 0)).toBe(true)
  expect(isEligibleIndex(list, 1)).toBe(false)
  expect(isEligibleIndex(list, 5)).toBe(false)
  expect(isEligibleIndex(list, null)).toBe(false)
})
