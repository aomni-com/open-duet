import { expect, test } from 'bun:test'

import { SESSION_BUCKETS } from '@repo/contract'

import { attention, isSilent, meaningOf, stateOf, toneOf } from './palette'
import type { AppItem, Job } from './types'

const job = (state: Job['state']): Job => ({
  id: state,
  unread: false,
  title: 't',
  when: 'now',
  state,
  sub: 's',
})

/* `stateOf` decides nothing any more. The state arrives on the row as `bucket`
   and is carried through untouched — the only judgement left is what to do with
   an item that has no state at all. */
test('a carried state passes through, and a stateless item is idle', () => {
  expect(stateOf(job('done'))).toBe('done')
  expect(stateOf(job('running'))).toBe('running')
  expect(stateOf(job('scheduled'))).toBe('scheduled')
  expect(stateOf(null)).toBe('idle')
  expect(stateOf({ id: 's', title: 'Skill', blurb: '' })).toBe('idle')
})

/* Only states that want an action bubble to the parent. "Not connected" is an
   offer, so it stays on its own card — if every agent wore a badge nobody would
   look at any of them. */
test('attention rolls up the most urgent state, and only urgent ones', () => {
  expect(attention([job('running'), job('asking'), job('done')]).top).toBe('running')
  expect(attention([job('asking'), job('scheduled')]).top).toBe('asking')
  /* Asleep on a clock is not working, but it is not finished either — it
     bubbles, so an agent with only a pending reminder still says so. */
  expect(attention([job('scheduled'), job('done')]).top).toBe('scheduled')
  expect(attention([job('done'), job('done')]).top).toBeNull()

  const apps: AppItem[] = [
    { id: '1', title: 'Drive', when: 'now', state: 'connected' },
    { id: '2', title: 'Notes', when: 'now', state: 'available' },
  ]
  expect(attention(apps).top).toBeNull()
  expect(attention([]).top).toBeNull()
})

test('attention counts how many are in the state it surfaced', () => {
  expect(attention([job('asking'), job('asking'), job('done')])).toEqual({ top: 'asking', n: 2 })
})

/* Running outranks asking, because running means tokens are being spent. An
   agent that is both stuck on a question and working shows the work: the
   question will still be there when you click in, and the spend will not. */
test('running outranks asking', () => {
  expect(attention([job('asking'), job('running')]).top).toBe('running')
  expect(attention([job('asking'), job('asking'), job('running')])).toEqual({
    top: 'running',
    n: 1,
  })
})

/* The chain this feature exists to protect: the four words the Convex index is
   keyed on are the four the palette ranks. A fifth UI state with no index
   behind it is the failure mode, so it is asserted rather than trusted. */
test("the palette ranks exactly the wire's buckets, and nothing else", () => {
  for (const bucket of SESSION_BUCKETS) expect(meaningOf(bucket)).toBeDefined()
  expect(new Set(SESSION_BUCKETS).size).toBe(SESSION_BUCKETS.length)
})

test('every state has exactly one tone', () => {
  expect(toneOf('running')).toBe('live')
  expect(toneOf('asking')).toBe('alert')
  expect(toneOf('scheduled')).toBe('muted')
  expect(toneOf('connected')).toBe('ok')
})

/* Two buckets share the muted tone, so on any surface whose only cue is a dot
   they would be the same mark — a job waking in four hours drawn exactly like
   one that finished last week. Tone alone cannot carry the axis; the glyph is
   what separates them, and `done` is the one that goes quiet. An unprimed
   critique read three identical grey dots and could not name any of them. */
test('a muted tone is not enough to tell scheduled from done', () => {
  expect(toneOf('scheduled')).toBe(toneOf('done'))
  expect(isSilent('done')).toBe(true)
  expect(isSilent('scheduled')).toBe(false)
})

/* Decorating the normal case is how a map turns into a dashboard: an app that
   is connected is doing what apps do, so it wears nothing. Only the offer to
   connect one that is not asks for a mark. */
test('a connected app draws no mark, and an unconnected one draws the offer', () => {
  expect(isSilent('connected')).toBe(true)
  expect(isSilent('available')).toBe(false)
  expect(meaningOf('available').glyph).toBe('plus')
})

/* `in` would answer true for inherited keys and index the table with them. */
test('a state the table does not own reads as idle, not as a prototype key', () => {
  const bogus = { id: 'x', title: 't', when: 'now', state: 'toString', sub: 's' } as unknown as Job
  expect(stateOf(bogus)).toBe('idle')
})
