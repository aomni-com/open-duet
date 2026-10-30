import { expect, test } from 'bun:test'

import { createRestoreWindow } from './restore-window'

test('the shared restore window covers only awaited restore work and clears on failure', async () => {
  const window = createRestoreWindow()
  const observed: boolean[] = []

  await expect(
    window.run(async () => {
      observed.push(window.inFlight())
      throw new Error('restore failed')
    }),
  ).rejects.toThrow('restore failed')

  observed.push(window.inFlight())
  expect(observed).toEqual([true, false])
})

test('overlapping restore callers cannot clear the shared window early', async () => {
  const window = createRestoreWindow()
  const releases: Array<() => void> = []
  const restore = () => new Promise<void>(resolve => releases.push(resolve))

  const first = window.run(restore)
  const second = window.run(restore)
  await Promise.resolve()
  expect(releases).toHaveLength(1)
  releases[0]!()
  await first

  expect(window.inFlight()).toBe(true)
  await Promise.resolve()
  releases[1]!()
  await second
  expect(window.inFlight()).toBe(false)
})
