/* The one request that watches the whole drive, and how fast it ticks.

   These cases moved here with the function. They lived beside the ring's
   invalidation edges, in a module whose subject is what to re-ask when the
   reader crosses a boundary — a different question from how often to ask at
   all, and the reason `query-options` was importing *backwards* out of it. */
import { expect, test } from 'bun:test'

import type { SessionActivityResponse } from '@repo/contract'

import {
  ACTIVE_POLL_MS,
  activityPollInterval,
  duetQueryOptions,
  QUIET_POLL_MS,
} from './query-options'

const WS = 'acme'
const EMPTY: SessionActivityResponse = { owners: [] }

/* The rate turns on whether anything on screen is actually reading it. It used
   to turn on whether an agent was *unfolded*, which meant the same thing while
   the roster only ever stood beside the canvas — and stopped meaning it the
   moment the roster became the agents section's own furniture, standing beside
   an agent with live job dots and a preview of the conversation on the next
   screen. At the slow rate that row lagged the chat beside it by a minute. */
test('a surface that is reading the drive is watched closely', () => {
  expect(activityPollInterval({ liveActivity: true })).toBe(ACTIVE_POLL_MS)
})

test('a surface that is not slows the feed nobody is looking at', () => {
  expect(activityPollInterval({ liveActivity: false })).toBe(QUIET_POLL_MS)
  expect(ACTIVE_POLL_MS).toBeLessThan(QUIET_POLL_MS)
})

/* Never `false`: a drive that went quiet is exactly the drive where the next
   thing to happen is somebody else starting work, and a poll that switched
   itself off would never see it. */
test('the drive is never left unwatched', () => {
  expect(activityPollInterval({ liveActivity: false })).toBeGreaterThan(0)
  expect(activityPollInterval({ liveActivity: true })).toBeGreaterThan(0)
})

/* A rate nothing consults is a constant. The way this stops ticking is somebody
   deleting one line from the query options, which no assertion about
   `activityPollInterval` itself would notice. */
test('the drive’s watch is actually attached to the drive’s read', () => {
  const options = duetQueryOptions.workspaces.sessionActivity(
    { listSessionActivity: async () => EMPTY },
    WS,
  )
  const rate = options.refetchInterval
  expect(typeof rate).toBe('function')
  expect((rate as (query: unknown) => number | false)({})).toBe(ACTIVE_POLL_MS)
})
