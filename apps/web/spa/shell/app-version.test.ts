import { expect, test } from 'bun:test'

import { advanceVersionWatch, INITIAL_VERSION_WATCH } from './app-version'

test('the first answer establishes what this tab is running, without announcing it', () => {
  const next = advanceVersionWatch(INITIAL_VERSION_WATCH, 'dpl_abc')

  expect(next.shouldNotify).toBe(false)
  expect(next.watch.loaded).toBe('dpl_abc')
})

test('repeated answers from the same deployment stay silent', () => {
  const booted = advanceVersionWatch(INITIAL_VERSION_WATCH, 'dpl_abc').watch
  const next = advanceVersionWatch(booted, 'dpl_abc')

  expect(next.shouldNotify).toBe(false)
  expect(next.watch.loaded).toBe('dpl_abc')
})

test('a different deployment answering means this tab is running stale code', () => {
  const booted = advanceVersionWatch(INITIAL_VERSION_WATCH, 'dpl_abc').watch
  const next = advanceVersionWatch(booted, 'dpl_xyz')

  expect(next.shouldNotify).toBe(true)
})

test('the tab is told once, no matter how many further deployments land', () => {
  const booted = advanceVersionWatch(INITIAL_VERSION_WATCH, 'dpl_abc').watch
  const announced = advanceVersionWatch(booted, 'dpl_xyz').watch

  expect(advanceVersionWatch(announced, 'dpl_xyz').shouldNotify).toBe(false)
  expect(advanceVersionWatch(announced, 'dpl_later').shouldNotify).toBe(false)
})

test('a failed probe leaves the tab believing what it already believed', () => {
  const booted = advanceVersionWatch(INITIAL_VERSION_WATCH, 'dpl_abc').watch
  const next = advanceVersionWatch(booted, null)

  expect(next.shouldNotify).toBe(false)
  expect(next.watch.loaded).toBe('dpl_abc')
})

test('a failed first probe does not let the next answer read as a new deployment', () => {
  const unknown = advanceVersionWatch(INITIAL_VERSION_WATCH, null).watch
  const next = advanceVersionWatch(unknown, 'dpl_abc')

  expect(next.shouldNotify).toBe(false)
  expect(next.watch.loaded).toBe('dpl_abc')
})
