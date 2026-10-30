import { expect, test } from 'bun:test'

import {
  COLLECTION_PAGE_MAX_LIMIT,
  CONVEX_EVENT_BUDGET_BYTES,
  SESSION_LIST_MAX_LIMIT,
} from '@repo/contract'

import { discoveryLaneRowCount, discoveryRequestCeiling } from './discovery'
import {
  sessionEventFitsStorageBudget,
  SESSION_LIST_EXCLUDE_ALLOWANCE,
  SESSION_PAGE_ENVELOPE_BYTES,
  SESSION_HISTORY_PAGE_LIMITS,
  SESSION_HISTORY_SUPPORT_RESERVATION,
  SessionHistoryPageBudget,
  SESSION_LIST_CANDIDATE_RESERVATION,
  SESSION_LIST_PAGE_LIMITS,
  SESSION_LIST_SOURCE_RESERVATION,
  SessionListPageBudget,
  serializedSessionPageBytes,
} from './pageBudget'

test('accepts an event at the storage boundary and refuses the next byte', () => {
  const eventAt = eventWithJsonBytes(CONVEX_EVENT_BUDGET_BYTES)
  const eventOver = eventWithJsonBytes(CONVEX_EVENT_BUDGET_BYTES + 1)

  expect(sessionEventFitsStorageBudget(eventAt)).toBe(true)
  expect(sessionEventFitsStorageBudget(eventOver)).toBe(false)
})

/* The page fetches rows a batch at a time, so the reservation has to hold for
   every row a batch may bring back — not merely for the next one. Asserted
   against the count the scan is actually sized by. */
test('history reserves a platform-maximum document for every row a scan may fetch', () => {
  const budget = new SessionHistoryPageBudget()
  expect(budget.snapshot()).toEqual(SESSION_HISTORY_SUPPORT_RESERVATION)

  const rows = budget.readableRows()
  expect(rows).toBeGreaterThan(0)
  expect(
    SESSION_HISTORY_SUPPORT_RESERVATION.bytes + rows * SESSION_HISTORY_PAGE_LIMITS.documentBytes,
  ).toBeLessThanOrEqual(SESSION_HISTORY_PAGE_LIMITS.readBytes)

  budget.commitScan(Array.from({ length: rows }, () => SESSION_HISTORY_PAGE_LIMITS.documentBytes))
  expect(budget.readableRows()).toBe(0)

  /* One scan is one range however many rows it carried. The sizer above
     bounds a scan by what the budget has left, so charging a range per row
     would have it bounding scans against a cost they never incur. */
  expect(budget.snapshot().ranges).toBe(SESSION_HISTORY_SUPPORT_RESERVATION.ranges + 1)
  expect(budget.snapshot().documents).toBe(SESSION_HISTORY_SUPPORT_RESERVATION.documents + rows)
})

/* The emit gate admits one measured item at a time and carries the running
   total, rather than re-serializing the accepted page to weigh each new row —
   which is what made a page cost the square of what it carried. So the claim
   worth pinning is no longer "this page object measures under the cap"; it is
   that the running total, envelope allowance included, never lets through a
   page that would not really fit. Asserted by filling a page through the gate
   and then serializing what it accepted for real. */
test('history admits items until the real serialized page reaches its cap', () => {
  const budget = new SessionHistoryPageBudget()
  const item = itemWithJsonBytes(64 * 1024)
  const measured = serializedSessionPageBytes(item)
  const admitted: unknown[] = []
  while (budget.canEmit(measured)) {
    budget.commitEmit(measured)
    admitted.push(item)
  }

  expect(admitted.length).toBeGreaterThan(1)
  const page = { items: admitted, nextCursor: 'x'.repeat(256) }
  const realBytes = serializedSessionPageBytes(page)
  expect(Math.max(realBytes.json, realBytes.convex)).toBeLessThanOrEqual(
    SESSION_HISTORY_PAGE_LIMITS.responseBytes,
  )
  // Conservative, not slack: one more item would have overrun the cap.
  expect(Math.max(realBytes.json, realBytes.convex) + measured.json).toBeGreaterThan(
    SESSION_HISTORY_PAGE_LIMITS.responseBytes,
  )
})

/* The allowance stands in for the page's own JSON so the gate never has to
   serialize the page to weigh a row. It is only safe while it over-estimates,
   and the widest real cursor is the part of it most likely to drift. */
test('the page envelope allowance covers the widest cursor a page can carry', () => {
  const emptyPage = serializedSessionPageBytes({ items: [], nextCursor: '' })
  const widestCursor = 1024
  const separatorsAtMaximumPage = COLLECTION_PAGE_MAX_LIMIT
  expect(
    Math.max(emptyPage.json, emptyPage.convex) + widestCursor + separatorsAtMaximumPage,
  ).toBeLessThanOrEqual(SESSION_PAGE_ENVELOPE_BYTES)
})

/* The claim, rather than the number. This used to assert
   `rowsPerLane === SESSION_LIST_MAX_LIMIT + 1`, which is the reservation
   restating its own definition — so when the list started asking for one extra
   candidate to hold its default chat out of the page, the read grew, the
   reservation did not, and the test that exists to catch exactly that stayed
   green. Asserted against the widest read a lane can actually be asked to
   perform, through the function the selector itself calls. */
test('one lane reserves at least the widest read the list can ask it for', () => {
  const widestRequest = SESSION_LIST_MAX_LIMIT + SESSION_LIST_EXCLUDE_ALLOWANCE
  expect(widestRequest).toBeLessThanOrEqual(discoveryRequestCeiling())
  expect(discoveryLaneRowCount(widestRequest)).toBeLessThanOrEqual(
    SESSION_LIST_SOURCE_RESERVATION.rowsPerLane,
  )
})

test('reserves one complete maximum candidate before any candidate work begins', () => {
  const budget = new SessionListPageBudget({
    ranges: SESSION_LIST_PAGE_LIMITS.ranges - SESSION_LIST_CANDIDATE_RESERVATION.read.ranges,
    documents:
      SESSION_LIST_PAGE_LIMITS.documents - SESSION_LIST_CANDIDATE_RESERVATION.read.documents,
    bytes: 12 * 1024 * 1024,
  })
  expect(budget.canReserveCandidate()).toBe(true)
  budget.commitCandidate(
    SESSION_LIST_CANDIDATE_RESERVATION.read,
    serializedSessionPageBytes({ id: 'maximum-valid' }),
  )
  expect(budget.canReserveCandidate()).toBe(false)
})

test('counts the larger of JSON and Convex wire encoding', () => {
  const bytes = new Uint8Array([1, 2, 3, 4]).buffer
  const measured = serializedSessionPageBytes({ payload: bytes })
  expect(measured).toEqual({
    json: new TextEncoder().encode('{"payload":{}}').byteLength,
    convex: new TextEncoder().encode('{"payload":{"$bytes":"AQIDBA=="}}').byteLength,
  })
  const budget = new SessionHistoryPageBudget()
  const wider = Math.max(measured.json, measured.convex)
  budget.commitEmit({
    json: SESSION_HISTORY_PAGE_LIMITS.responseBytes - SESSION_PAGE_ENVELOPE_BYTES - wider,
    convex: SESSION_HISTORY_PAGE_LIMITS.responseBytes - SESSION_PAGE_ENVELOPE_BYTES - wider,
  })
  expect(budget.canEmit(measured)).toBe(true)
  expect(budget.canEmit({ ...measured, convex: measured.convex + 1 })).toBe(false)
})

test('a near-document-sized canonical read and bounded list summary fit a fresh page', () => {
  const budget = new SessionListPageBudget({ ranges: 2, documents: 2, bytes: 64 * 1024 })
  expect(budget.canReserveCandidate()).toBe(true)
  expect(() =>
    budget.commitCandidate(
      { ranges: 4, documents: 4, bytes: 3 * 1024 * 1024 },
      serializedSessionPageBytes({ machine: { step: 'bounded', activity: 'running' } }),
    ),
  ).not.toThrow()
})

/* The list weighs each projected row once and carries the total, the same way
   the history page does, so what is worth pinning is the same claim: a page
   the running total admitted really does serialize under the cap, envelope and
   cursor included. A candidate the scan drops adds reads and no row. */
test('the list admits rows until the real serialized page reaches its cap', () => {
  const budget = new SessionListPageBudget({ ranges: 0, documents: 0, bytes: 0 })
  const row = itemWithJsonBytes(SESSION_LIST_CANDIDATE_RESERVATION.responseBytes)
  const measured = serializedSessionPageBytes(row)
  const noReads = { ranges: 0, documents: 0, bytes: 0 }
  const admitted: unknown[] = []
  while (budget.canReserveCandidate()) {
    budget.commitCandidate(noReads)
    budget.commitCandidate(noReads, measured)
    admitted.push(row)
  }

  expect(admitted.length).toBeGreaterThan(1)
  const real = serializedSessionPageBytes({ items: admitted, nextCursor: 'x'.repeat(256) })
  expect(Math.max(real.json, real.convex)).toBeLessThanOrEqual(
    SESSION_LIST_PAGE_LIMITS.responseBytes,
  )
  expect(budget.snapshot().responseBytes).toBeGreaterThanOrEqual(Math.max(real.json, real.convex))
})

test('a row wider than its response reservation is refused', () => {
  const budget = new SessionListPageBudget({ ranges: 0, documents: 0, bytes: 0 })
  const tooWide = serializedSessionPageBytes(
    itemWithJsonBytes(SESSION_LIST_CANDIDATE_RESERVATION.responseBytes + 1),
  )
  expect(() => budget.commitCandidate({ ranges: 0, documents: 0, bytes: 0 }, tooWide)).toThrow(
    /response reservation/,
  )
})

test('maximum discovery prefetch plus page support and one full candidate fit before reading', () => {
  const sourceBytes =
    SESSION_LIST_SOURCE_RESERVATION.lanes *
    SESSION_LIST_SOURCE_RESERVATION.rowsPerLane *
    SESSION_LIST_SOURCE_RESERVATION.bytesPerRow
  const maximumPageSupportBytes = sourceBytes + 2 * 1024 * 1024
  expect(maximumPageSupportBytes + SESSION_LIST_CANDIDATE_RESERVATION.read.bytes).toBeLessThan(
    SESSION_LIST_PAGE_LIMITS.readBytes,
  )
  const fresh = new SessionListPageBudget({
    ranges: 5,
    documents: 305,
    bytes: maximumPageSupportBytes,
  })
  expect(fresh.canReserveCandidate()).toBe(true)
})

function eventWithJsonBytes(bytes: number) {
  const empty = { type: 'task_output', taskId: 't1', chunk: '' }
  const overhead = new TextEncoder().encode(JSON.stringify(empty)).byteLength
  return { ...empty, chunk: 'x'.repeat(bytes - overhead) }
}

function itemWithJsonBytes(bytes: number) {
  const empty = { seq: 1, createdAt: 0, event: { chunk: '' } }
  const overhead = new TextEncoder().encode(JSON.stringify(empty)).byteLength
  return { ...empty, event: { chunk: 'x'.repeat(bytes - overhead) } }
}
