/* Where the card opens, which is the row's whole reason for being arranged.

   The interesting case is not "the reader picked something" — that one is a
   lookup. It is what the card does when the reader's first choice no longer
   exists: an app uninstalled since they last opened this agent is still first
   in their stored order, and the selector that would take them somewhere else is
   the one that is gone. Opening on it would strand them.
*/
import { describe, expect, test } from 'bun:test'

import type { Read } from '../../../knowledge-map-data/use-agent-reads'
import type { AppItem } from '../../../knowledge-map/types'
import { orderedItems } from './header-order'
import { entryCardCanArrive, pickOf, showingOf, stageOf } from './stage'

const app = (id: string): AppItem => ({ id, title: id, when: 'now', state: 'connected' })

const ready = (items: AppItem[]): Read<AppItem> => ({ phase: 'ready', items })

test('the card opens on whatever the reader put first', () => {
  // A drag stores the whole drawn row, never a fragment of it — see `reorder`.
  const row = orderedItems({ appIds: ['metrics'], saved: ['files', 'app:metrics'] })
  expect(stageOf(null, ready([app('metrics')]), row).kind).toBe('files')
})

test('a fragment of an order only says where the keys it names go', () => {
  // Not a case the UI can produce, and worth pinning because it is what an
  // older stored value looks like: keys nobody placed keep their default
  // neighbours, so a lone 'files' does not vault over the app in front of it.
  const row = orderedItems({ appIds: ['metrics'], saved: ['files'] })
  expect(row.map(item => item.key)).toEqual(['app:metrics', 'files', 'desktop'])
})

test('an app deleted since the reader arranged the row falls through to the next item', () => {
  // Their order still leads with an app this agent no longer reaches.
  const row = orderedItems({ appIds: ['inbox'], saved: ['app:metrics', 'files', 'app:inbox'] })
  const stage = stageOf(null, ready([app('inbox')]), row)
  // Not `none`, and not a card opened on an app that is not there: the reader
  // loses their first choice and keeps their second.
  expect(stage.kind).toBe('files')
})

test('a row of nothing but dead apps still resolves rather than stranding the reader', () => {
  const row = [
    { key: 'app:gone', kind: 'app' as const, appId: 'gone' },
    { key: 'files', kind: 'files' as const },
  ]
  expect(stageOf(null, ready([]), row).kind).toBe('files')
})

test('an agent that truly has nothing to show says so', () => {
  expect(stageOf(null, ready([]), []).kind).toBe('none')
})

test('a list still in flight is never mistaken for an agent with no apps', () => {
  const row = orderedItems({ appIds: [], saved: null })
  const stage = stageOf(null, { phase: 'pending', items: [] }, row)
  expect(stage).toEqual({ kind: 'reading', phase: 'pending' })
})

test("the reader's own choice always wins over the row", () => {
  const row = orderedItems({ appIds: ['metrics'], saved: ['files', 'app:metrics'] })
  const chosen = app('metrics')
  expect(stageOf({ kind: 'app', app: chosen }, ready([chosen, app('inbox')]), row)).toEqual({
    kind: 'app',
    app: chosen,
  })
})

/* The row's keys and the lit selector are one vocabulary. They were two — a
   `*_PICK` alias per kind, each assigned from the header order's own key — and
   that layer was an indirection whose only job was to be
   kept in step with the thing it copied. */
test('what the card draws and what the row lights are named the same thing', () => {
  const row = orderedItems({ appIds: ['metrics'], saved: null })
  expect(pickOf(stageOf(null, ready([app('metrics')]), row))).toBe(row[0]!.key)
  expect(pickOf({ kind: 'files' })).toBe('files')
  expect(pickOf({ kind: 'desktop' })).toBe('desktop')
  // Both non-choices are states of the apps half of the row, and in both of them
  // that half is empty — there is nothing to light.
  expect(pickOf({ kind: 'none' })).toBeNull()
  expect(pickOf({ kind: 'reading', phase: 'pending' })).toBeNull()
})

/* ------------------------------------------------------- the card from a URL */

test('the card a URL names is the app it names', () => {
  const invoices = app('invoices')
  expect(showingOf({ kind: 'app', appSlug: 'invoices' }, ready([invoices]))).toEqual({
    kind: 'app',
    app: invoices,
  })
  expect(showingOf({ kind: 'files', path: '/agents/ops' }, ready([]))).toEqual({ kind: 'files' })
  expect(showingOf({ kind: 'desktop' }, ready([]))).toEqual({ kind: 'desktop' })
  expect(showingOf({ kind: 'default' }, ready([]))).toBeNull()
  expect(showingOf({ kind: 'files-entry' }, ready([]))).toBeNull()
})

/* A cold deep link arrives before the app list does. Answering "no choice" for
   that moment would open the card on the reader's default and then jump to the
   app they actually asked for, which reads as the product changing its mind. */
test('holds the app a link names while the list is still in flight', () => {
  expect(showingOf({ kind: 'app', appSlug: 'invoices' }, { phase: 'pending', items: [] })).toEqual({
    kind: 'app',
    app: { id: 'invoices', title: '', when: '', state: 'connected' },
  })
})

/* Once the list has answered and the app is not in it, it has been uninstalled.
   The row's own next item is the honest fallback — the same rule `stageOf`
   keeps for a stored key that outlived its app. */
test('falls through to the reader’s row when the app a link names is gone', () => {
  expect(showingOf({ kind: 'app', appSlug: 'invoices' }, ready([]))).toBeNull()
})

/* The withholding that keeps a cold link from painting one destination and
   jumping to another is only honest while the answer is still coming. These
   are the two ways it never comes — and both of them used to leave the page
   without a card forever: blank at first, and then, once the blank was replaced
   by the page's own skeleton, a skeleton with no way out. */
describe('whether a bare agent URL can still name a card', () => {
  test('it can, while the read that decides it is still out', () => {
    expect(entryCardCanArrive(true, { kind: 'reading', phase: 'pending' })).toBe(true)
  })

  test('an errored read is not going to answer', () => {
    expect(entryCardCanArrive(true, { kind: 'reading', phase: 'error' })).toBe(false)
  })

  test('an agent that reaches nothing has answered', () => {
    expect(entryCardCanArrive(true, { kind: 'none' })).toBe(false)
  })

  test('and a card the URL already names is not resolving at all', () => {
    expect(entryCardCanArrive(false, { kind: 'reading', phase: 'pending' })).toBe(false)
    expect(entryCardCanArrive(true, { kind: 'files' })).toBe(false)
  })
})
