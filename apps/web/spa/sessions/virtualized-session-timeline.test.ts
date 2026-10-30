import { describe, expect, test } from 'bun:test'

import {
  historyContinuationState,
  historyNeedsUnpromptedPage,
  reachesHistoryTrigger,
  timelineHasLeadingClip,
} from './virtualized-session-timeline'

describe('virtualized session timeline pagination', () => {
  test('classifies available history as available continuation', () => {
    expect(
      historyContinuationState({ hasOlder: true, isLoadingOlder: false, loadOlderFailed: false }),
    ).toBe('available')
  })

  test('classifies failed and loading history continuation', () => {
    expect(
      historyContinuationState({ hasOlder: true, isLoadingOlder: false, loadOlderFailed: true }),
    ).toBe('failed')
    expect(
      historyContinuationState({ hasOlder: true, isLoadingOlder: true, loadOlderFailed: false }),
    ).toBe('loading')
  })

  test('classifies continuation hidden when no older history remains', () => {
    expect(
      historyContinuationState({ hasOlder: false, isLoadingOlder: false, loadOlderFailed: false }),
    ).toBe('hidden')
  })
})

test('leading-clip eligibility ignores initial and subpixel scroll positions', () => {
  expect(timelineHasLeadingClip(0)).toBe(false)
  expect(timelineHasLeadingClip(0.5)).toBe(false)
  expect(timelineHasLeadingClip(2)).toBe(true)
})

describe('scroll-trigger eligibility near the history beginning', () => {
  const readingBack = { scrollTop: 200, previousScrollTop: 900 }

  test('arms only while more history is available and unclaimed', () => {
    expect(reachesHistoryTrigger({ ...readingBack, continuation: 'available' })).toBe(true)
    expect(reachesHistoryTrigger({ ...readingBack, continuation: 'loading' })).toBe(false)
    expect(reachesHistoryTrigger({ ...readingBack, continuation: 'failed' })).toBe(false)
    expect(reachesHistoryTrigger({ ...readingBack, continuation: 'hidden' })).toBe(false)
  })

  test('permits backward-scroll triggers near the beginning and excludes a distant tail', () => {
    // A reader deep in the tail is not owed older history yet.
    expect(
      reachesHistoryTrigger({
        scrollTop: 4000,
        previousScrollTop: 4800,
        continuation: 'available',
      }),
    ).toBe(false)
    // Within a screenful of the beginning the page is already on its way, so
    // the reader never meets the edge of the loaded range.
    expect(
      reachesHistoryTrigger({ scrollTop: 200, previousScrollTop: 900, continuation: 'available' }),
    ).toBe(true)
  })

  test('rejects stationary and forward scroll coordinates', () => {
    // Opening a chat drops the reader at the live tail, and restoring their
    // place after a prepend puts them back where they were. Both travel *away*
    // from the beginning through the trigger zone, and neither is a request
    // for more history — reading them as one fetches a page on every open.
    expect(
      reachesHistoryTrigger({ scrollTop: 0, previousScrollTop: 0, continuation: 'available' }),
    ).toBe(false)
    expect(
      reachesHistoryTrigger({ scrollTop: 240, previousScrollTop: 0, continuation: 'available' }),
    ).toBe(false)
  })
})

describe('unprompted-history eligibility', () => {
  test('an empty transcript permits an unprompted available page', () => {
    // An event-only page projects to no message. There is nothing to read and
    // nothing to scroll, so waiting for a gesture leaves the chat blank
    // forever.
    expect(
      historyNeedsUnpromptedPage({
        visibleMessageCount: 0,
        canScrollBack: false,
        continuation: 'available',
      }),
    ).toBe(true)
  })

  /* The case the empty-only rule left open, and the one readers actually hit: a
     long agent turn fills its page with the agent's own work and pushes the
     prompt that started it onto the page behind. One message lands, it does not
     fill the viewport, and an upward gesture cannot be made on a transcript
     that does not scroll — so the reader is stuck looking at an answer with no
     question and no way to ask for it. */
  test('an unscrollable single message permits an unprompted available page', () => {
    expect(
      historyNeedsUnpromptedPage({
        visibleMessageCount: 1,
        canScrollBack: false,
        continuation: 'available',
      }),
    ).toBe(true)
  })

  test('a scrollable nonempty transcript rejects an unprompted page', () => {
    // Reading back is the reader's to start. Fetching on their behalf would
    // spend a second page on every chat that opens.
    expect(
      historyNeedsUnpromptedPage({
        visibleMessageCount: 1,
        canScrollBack: true,
        continuation: 'available',
      }),
    ).toBe(false)
  })

  test('unprompted eligibility rejects loading, failed and hidden continuation', () => {
    for (const continuation of ['loading', 'failed', 'hidden'] as const) {
      expect(
        historyNeedsUnpromptedPage({ visibleMessageCount: 0, canScrollBack: false, continuation }),
      ).toBe(false)
    }
  })
})
