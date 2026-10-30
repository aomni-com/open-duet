/* The Work rail's one promise is that it holds every conversation this
   workspace is having that is not an owner's own chat. It used to hold rather
   less than that, and the shortfall was invisible: the rail's own list dropped
   any session carrying a `machine`, while the per-agent groups underneath it —
   the same rows, the same server filter — kept them. One surface, two answers,
   and the half that hid work was the half a reader lands on first. */
import { expect, test } from 'bun:test'

import type { SessionListItem, SessionListPage } from '@repo/contract'

import { projectWorkConversationRows, workCollectionPhase } from './work-collection'

function session(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: 'session_1',
    title: 'Launch planning',
    titleOrigin: 'auto',
    titleStatus: 'complete',
    turnStatus: 'complete',
    bucket: 'done',
    createdAt: 1,
    updatedAt: 2,
    lastEventSeq: 1,
    unread: false,
    audience: { kind: 'workspace' },
    archive: { globalArchivedAt: null, personalArchivedAt: null, reason: null },
    permissions: {
      send: true,
      answer: true,
      interrupt: true,
      rename: true,
      manageAudience: true,
      personalArchive: true,
      globalArchive: true,
      delete: true,
    },
    ...overrides,
  }
}

function page(
  items: readonly SessionListItem[],
  nextCursor: string | null = null,
): SessionListPage {
  return { items: [...items], nextCursor }
}

test('a session that ran a state machine is a Work row like any other', () => {
  const items = [
    session({ id: 's_plain' }),
    session({
      id: 's_machine',
      bucket: 'running',
      turnStatus: 'running',
      machine: { activity: 'running', progress: { completed: 2, total: 5 }, step: 'Drafting' },
    }),
  ]
  const projected = projectWorkConversationRows([page(items)], 12)
  expect(projected.items).toEqual(items)
})

/* A page the server emptied is not an empty list. The rows this endpoint drops
   are not all dropped before the page is measured: a candidate the reader
   cannot see, or that is archived for them alone, or that the search text
   misses, is dropped *inside* the page and the cursor still advances past it —
   so `{items: [], nextCursor: '…'}` is an ordinary answer, and it means "keep
   reading", not "there is nothing here". Saying "no delegated work" over a
   live cursor tells the reader their conversation spawned nothing while its
   children sit one page behind. */
test('an empty page behind a live cursor asks for the next one', () => {
  const projected = projectWorkConversationRows([page([], 'cursor_1')], 12)
  expect(projected.items).toEqual([])
  expect(projected.fetchNext).toBe(true)
})

test('an empty page with no cursor behind it is an empty list', () => {
  expect(projectWorkConversationRows([page([])], 12).fetchNext).toBe(false)
})

/* The reason this is a projection and not a `while` loop. A conversation whose
   children are all hidden from this reader would otherwise read the whole tail
   of the workspace one page at a time, in the background, to draw nothing. */
test('the drain stops at a request budget rather than reading the whole tail', () => {
  const emptyPages = Array.from({ length: 4 }, (_, index) => page([], `cursor_${index}`))
  expect(projectWorkConversationRows(emptyPages, 12, 4).fetchNext).toBe(false)
})

/* A row already drawn is an answer; the panel never keeps reading past one. */
test('a page that drew something never drains', () => {
  expect(projectWorkConversationRows([page([session()], 'cursor_1')], 12).fetchNext).toBe(false)
})

test('a list still draining is loading, not empty', () => {
  expect(
    workCollectionPhase({
      pending: false,
      initialError: false,
      continuationError: false,
      itemCount: 0,
      draining: true,
    }),
  ).toBe('pending')
})

test('a list that has finished draining with nothing is empty', () => {
  expect(
    workCollectionPhase({
      pending: false,
      initialError: false,
      continuationError: false,
      itemCount: 0,
      draining: false,
    }),
  ).toBe('empty')
})
