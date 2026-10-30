import { describe, expect, test } from 'bun:test'

import { AGENT_SESSION_STATUSES, type AgentSessionStatus } from '../agent/index'
import { bucketOf, type Machine, type SessionBucket } from './index'

/** A machine projection carrying only the three fields `bucketOf` reads. */
function machine(overrides: Partial<Machine>): Machine {
  return { orderedPath: [], activity: 'running', ...overrides }
}

describe('bucketOf', () => {
  test('a conversation is described by its turn alone', () => {
    const byTurnStatus: Record<AgentSessionStatus, SessionBucket> = {
      ask: 'asking',
      running: 'running',
      // A plain conversation that slept is on a clock exactly like a machine is.
      sleep: 'scheduled',
      complete: 'done',
      interrupted: 'done',
    }
    for (const turnStatus of AGENT_SESSION_STATUSES) {
      expect(bucketOf({ turnStatus }), turnStatus).toBe(byTurnStatus[turnStatus])
    }
  })

  test('a live machine outranks the turn — the L1 case', () => {
    // The machine finished one state and moved to the next, so the *turn* is
    // complete while the machine runs on. Reading the turn here is what filed
    // live work under "finished" on every surface that groups sessions.
    expect(bucketOf({ turnStatus: 'complete', machine: machine({ activity: 'idle' }) })).toBe(
      'running',
    )
    expect(bucketOf({ turnStatus: 'complete', machine: machine({ activity: 'running' }) })).toBe(
      'running',
    )
  })

  test('an interrupted turn is inactive even when its machine is unfinished', () => {
    for (const activity of ['running', 'sleeping', 'waiting', 'idle'] as const) {
      expect(
        bucketOf({
          turnStatus: 'interrupted',
          machine: machine({ activity, nextWakeAt: 4_000 }),
        }),
        activity,
      ).toBe('done')
    }
    expect(bucketOf({ turnStatus: 'running', machine: machine({ activity: 'idle' }) })).toBe(
      'running',
    )
  })

  test('a finished machine outranks nothing — the other half of L1', () => {
    // Its outcome is a fact about the past. Reading it as the present is how a
    // follow-up message on a completed job stayed filed under "done" while its
    // runner worked — invisible to the reader and to the terminalization sweep.
    const over = machine({ activity: 'idle', outcome: 'completed' })
    expect(bucketOf({ turnStatus: 'running', machine: over })).toBe('running')
    expect(bucketOf({ turnStatus: 'complete', machine: over })).toBe('done')
    expect(bucketOf({ turnStatus: 'sleep', machine: over })).toBe('scheduled')
  })

  test('a cancelled machine is no longer in an active bucket', () => {
    expect(
      bucketOf({
        turnStatus: 'complete',
        machine: machine({ activity: 'idle', outcome: 'cancelled' }),
      }),
    ).toBe('done')
  })

  test('sleeping is only a clock when there is a time on it — the L2 case', () => {
    // A sleep event that carried no machine shape used to leave `activity`
    // stale, stranding a job asleep-on-a-clock as live work. Without a wake
    // time there is no clock to report, so "running" is the honest answer.
    expect(bucketOf({ turnStatus: 'complete', machine: machine({ activity: 'sleeping' }) })).toBe(
      'running',
    )
    expect(
      bucketOf({
        turnStatus: 'complete',
        machine: machine({ activity: 'sleeping', nextWakeAt: 4_000 }),
      }),
    ).toBe('scheduled')
  })

  test('waiting on a person outranks every machine reading', () => {
    // `asking` is the only bucket the reader can clear themselves, so it must
    // never be filed under whatever the machine happens to be doing.
    for (const activity of ['running', 'sleeping', 'waiting', 'idle'] as const) {
      expect(bucketOf({ turnStatus: 'ask', machine: machine({ activity }) }), activity).toBe(
        'asking',
      )
    }
    expect(
      bucketOf({ turnStatus: 'ask', machine: machine({ activity: 'idle', outcome: 'completed' }) }),
    ).toBe('asking')
  })

})
