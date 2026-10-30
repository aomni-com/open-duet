import { describe, expect, test } from 'bun:test'

import { QueryClient } from '@tanstack/react-query'

import type { SessionSummary } from '@repo/contract'

import { duetQueryKeys } from '../api/query-keys'
import { commitSessionSummaryFields, findCachedSessionSummary } from './session-cache'
import { createSessionReadSignal } from './session-reads'

/**
 * A hand-cranked clock and timer queue. `setTimeout` is the seam the signal
 * uses to close its coalescing window, so a real one would make every test here
 * a sleep — and the trailing stamp is precisely the behaviour worth pinning.
 */
function harness(options: { visible?: boolean } = {}) {
  let clock = 10_000
  let visible = options.visible ?? true
  const stamps: number[] = []
  const timers = new Map<number, { at: number; fn: () => void }>()
  let nextHandle = 1

  const signal = createSessionReadSignal({
    stamp: seq => stamps.push(seq),
    isVisible: () => visible,
    now: () => clock,
    setTimer: (fn, ms) => {
      const handle = nextHandle++
      timers.set(handle, { at: clock + ms, fn })
      return handle
    },
    clearTimer: handle => {
      timers.delete(handle as number)
    },
    coalescingWindowMs: 1_000,
  })

  return {
    signal,
    stamps,
    pendingTimers: () => timers.size,
    /** Advance the clock, firing anything due — the event loop, by hand. */
    advance(ms: number) {
      clock += ms
      // Snapshotted: the loop deletes from the map it is walking.
      for (const [handle, timer] of Array.from(timers)) {
        if (timer.at > clock) continue
        timers.delete(handle)
        timer.fn()
      }
    },
    hide() {
      visible = false
      signal.presenceChanged()
    },
    show() {
      visible = true
      signal.presenceChanged()
    },
  }
}

describe('session read signal', () => {
  test('the first observation of a visible session stamps immediately', () => {
    const h = harness()
    h.signal.observe(7)
    expect(h.stamps).toEqual([7])
  })

  test('a burst inside the window collapses to one stamp carrying the highest seq', () => {
    const h = harness()
    h.signal.observe(1)
    expect(h.stamps).toEqual([1])

    h.advance(100)
    h.signal.observe(2)
    h.advance(100)
    h.signal.observe(3)
    h.advance(100)
    h.signal.observe(4)
    // Still inside the window opened by seq 1 — nothing more has gone out.
    expect(h.stamps).toEqual([1])

    h.advance(1_000)
    // The trailing stamp is the point: without it seq 4 waits for an event that,
    // at the end of a turn, never arrives.
    expect(h.stamps).toEqual([1, 4])
  })

  test('a hidden tab holds its mark and sends it on return', () => {
    const h = harness({ visible: false })
    h.signal.observe(5)
    h.advance(10_000)
    // Work finished while away. That is exactly what unread means.
    expect(h.stamps).toEqual([])

    h.show()
    expect(h.stamps).toEqual([5])
  })

  test('a stamp armed while visible does not land after the tab is hidden', () => {
    const h = harness()
    h.signal.observe(1)
    h.advance(100)
    h.signal.observe(2)
    expect(h.pendingTimers()).toBe(1)

    h.hide()
    h.advance(10_000)
    expect(h.stamps).toEqual([1])

    h.show()
    expect(h.stamps).toEqual([1, 2])
  })

  test('closing the tab never stamps — dispose drops the pending mark', () => {
    const h = harness()
    h.signal.observe(1)
    h.advance(100)
    h.signal.observe(2)

    h.signal.dispose()
    h.advance(10_000)
    // A lid closing is not someone reading, and the cursor is a maximum: the
    // dropped mark costs one badge that clears on the next visit.
    expect(h.stamps).toEqual([1])
  })

  test('a seq at or below what was sent is not resent', () => {
    const h = harness()
    h.signal.observe(9)
    h.advance(10_000)
    h.signal.observe(9)
    h.signal.observe(3)
    h.advance(10_000)
    expect(h.stamps).toEqual([9])
    expect(h.pendingTimers()).toBe(0)
  })

  test('presence changes on an already-read session send nothing', () => {
    const h = harness()
    h.signal.observe(4)
    h.advance(10_000)
    h.hide()
    h.show()
    h.hide()
    h.show()
    expect(h.stamps).toEqual([4])
  })
})

/* ---------------------------------------------------------------------------
   The dot clears without a refetch — and without moving the row.
   ------------------------------------------------------------------------ */

const SUMMARY: SessionSummary = {
  id: 'session_1',
  audience: { kind: 'workspace' },
  archive: { globalArchivedAt: null, personalArchivedAt: null, reason: null },
  permissions: {
    send: true,
    answer: true,
    interrupt: true,
    rename: true,
    manageAudience: false,
    personalArchive: true,
    globalArchive: true,
    delete: true,
  },
  turnStatus: 'complete',
  bucket: 'done',
  title: 'Finished while you were away',
  titleOrigin: 'auto',
  titleStatus: 'complete',
  createdAt: 1,
  updatedAt: 2,
  lastEventSeq: 9,
  unread: true,
}

function cacheWithUnreadRow() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  queryClient.setQueryData(duetQueryKeys.workspaces.sessions.detail('acme', SUMMARY.id), {
    ...SUMMARY,
    workspaceId: 'ws_1',
    lastDeliveredInputSeq: 0,
  })
  return queryClient
}

describe('clearing the dot', () => {
  test('only unread is copied, even when the summary handed in disagrees elsewhere', () => {
    const queryClient = cacheWithUnreadRow()
    const cached = findCachedSessionSummary(queryClient, 'acme', SUMMARY.id)!
    expect(cached.unread).toBe(true)

    /* Deliberately stale in two other fields. The field list is the whole
       defence: a list ordered by `updatedAt` would reshuffle under the reader
       the instant they looked at a row, and a title would flicker back to an
       older one. */
    commitSessionSummaryFields(
      queryClient,
      'acme',
      { ...cached, unread: false, updatedAt: 999, title: 'a stale title' },
      ['unread'],
    )

    const after = findCachedSessionSummary(queryClient, 'acme', SUMMARY.id)!
    expect(after.unread).toBe(false)
    expect(after.updatedAt).toBe(SUMMARY.updatedAt)
    expect(after.title).toBe(SUMMARY.title)
  })
})
