import { expect, test } from 'bun:test'

import { createBootIdReader } from './boot-identity'

test('a process retains one OS boot identity across repeated status reads', () => {
  let reads = 0
  const read = createBootIdReader(
    'linux',
    () => `${++reads === 1 ? 'boot-original' : 'other-value'}\n`,
  )
  expect(read()).toBe('boot-original')
  expect(read()).toBe('boot-original')
})

test('non-Linux status omits OS boot identity without reading Linux procfs', () => {
  const read = createBootIdReader('darwin', () => {
    throw new Error('Linux procfs was read')
  })
  expect(read()).toBeUndefined()
})
