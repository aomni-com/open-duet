/* The row across the top of the agent's card, as an ordering problem.

   The reader arranges it and the arrangement outlives the session, which is the
   whole of why this is pure and tested away from the DOM: what makes an ordering
   wrong is never the drag, it is what happens to a saved order when the world
   underneath it changes. An agent gains an app. An agent loses one. The reader
   arranged the row on a *different* agent. The row itself lost two of its four
   kinds. The stored value is a string somebody hand-edited into nonsense. Each
   of those is a case where the honest answer is "show a sensible row anyway",
   and none of them is visible in a happy-path test.
*/
import { expect, test } from 'bun:test'

import { orderedItems, readOrder, reorder, writeOrder } from './header-order'

test('the row leads with apps, then carries files and the shared desktop', () => {
  const items = orderedItems({ appIds: ['metrics', 'inbox'], saved: null })
  expect(items.map(item => item.key)).toEqual(['app:metrics', 'app:inbox', 'files', 'desktop'])
})

test('an agent that reaches no apps still has a row to arrive at', () => {
  // The row is the only way back to the rest of the agent, so it is never empty.
  const items = orderedItems({ appIds: [], saved: null })
  expect(items.map(item => item.key)).toEqual(['files', 'desktop'])
})

test('a saved order can put files first', () => {
  const items = orderedItems({ appIds: ['metrics'], saved: ['files', 'app:metrics'] })
  expect(items.map(item => item.key)).toEqual(['files', 'app:metrics', 'desktop'])
  expect(items[0]).toEqual({ key: 'files', kind: 'files' })
})

test('an app the agent gained lands among the apps, not behind the files', () => {
  // The reader arranged this row when `inbox` did not exist yet.
  const items = orderedItems({
    appIds: ['metrics', 'inbox'],
    saved: ['files', 'app:metrics'],
  })
  expect(items.map(item => item.key)).toEqual(['files', 'app:metrics', 'app:inbox', 'desktop'])
})

test('an app the agent lost leaves the row rather than drawing a dead selector', () => {
  const items = orderedItems({
    appIds: ['inbox'],
    saved: ['app:metrics', 'app:inbox', 'files'],
  })
  expect(items.map(item => item.key)).toEqual(['app:inbox', 'files', 'desktop'])
})

test("another agent's apps ride along in storage without appearing here", () => {
  const items = orderedItems({
    appIds: ['metrics'],
    saved: ['files', 'app:somebody-elses', 'app:metrics'],
  })
  expect(items.map(item => item.key)).toEqual(['files', 'app:metrics', 'desktop'])
})

test('a hand-edited order with repeats and nonsense still draws every real selector', () => {
  const items = orderedItems({
    appIds: ['metrics'],
    saved: ['files', 'files', 'not-a-selector', 'app:metrics', ''],
  })
  // Every selector the agent has, exactly once, and the reader's sequence where
  // it said anything at all.
  expect(items.map(item => item.key)).toEqual(['files', 'app:metrics', 'desktop'])
})

test('every drawn item carries the kind the card switches on', () => {
  const items = orderedItems({ appIds: ['metrics', 'inbox'], saved: null })
  expect(items).toEqual([
    { key: 'app:metrics', kind: 'app', appId: 'metrics' },
    { key: 'app:inbox', kind: 'app', appId: 'inbox' },
    { key: 'files', kind: 'files' },
    { key: 'desktop', kind: 'desktop' },
  ])
})

/* The row now holds apps, files and desktop: the work moved to a door
   beside the agent's name and the connections view left the surface. Every order
   written before that is still in the reader's browser, naming both. */
test('an order stored when the row had jobs and connections in it draws neither', () => {
  const items = orderedItems({
    appIds: ['metrics'],
    saved: ['jobs', 'app:metrics', 'files', 'plugs'],
  })
  // No migration and no version bump: the saved order is applied as a filter
  // over the default, so a key naming something the row no longer has simply
  // finds nothing to place — and the two that survive keep the reader's
  // sequence, which is what they arranged the row for.
  expect(items.map(item => item.key)).toEqual(['app:metrics', 'files', 'desktop'])
  expect(items.map(item => item.kind)).toEqual(['app', 'files', 'desktop'])
})

test('reordering moves one selector and leaves the rest in sequence', () => {
  expect(reorder(['app:metrics', 'app:inbox', 'files'], 'files', 'app:metrics')).toEqual([
    'files',
    'app:metrics',
    'app:inbox',
  ])
})

test('reordering onto itself or absent keys changes nothing', () => {
  const row = ['app:metrics', 'app:inbox', 'files']
  expect(reorder(row, 'files', 'files')).toEqual(row)
  expect(reorder(row, 'files', 'not-in-the-row')).toEqual(row)
  expect(reorder(row, 'not-in-the-row', 'files')).toEqual(row)
})

test('nothing stored, storage refusing, and nonsense stored all mean "no order"', () => {
  expect(readOrder(undefined, 'analyst')).toBeNull()
  expect(readOrder({ getItem: () => null }, 'analyst')).toBeNull()
  expect(readOrder({ getItem: () => 'not json' }, 'analyst')).toBeNull()
  expect(readOrder({ getItem: () => '{"not":"an array"}' }, 'analyst')).toBeNull()
  expect(readOrder({ getItem: () => '[]' }, 'analyst')).toBeNull()
  expect(
    readOrder(
      {
        getItem: () => {
          throw new Error('storage is disabled')
        },
      },
      'analyst',
    ),
  ).toBeNull()
})

test('each agent keeps its own arrangement', () => {
  const kept = new Map<string, string>()
  const storage = {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
  }
  writeOrder(storage, 'analyst', ['files', 'app:metrics'])
  writeOrder(storage, 'seo', ['app:metrics', 'files'])
  expect(readOrder(storage, 'analyst')).toEqual(['files', 'app:metrics'])
  expect(readOrder(storage, 'seo')).toEqual(['app:metrics', 'files'])
  // An agent nobody has arranged is not affected by one somebody has.
  expect(readOrder(storage, 'never-opened')).toBeNull()
})

test('a stored order is decoded with non-strings and empty strings dropped', () => {
  expect(readOrder({ getItem: () => JSON.stringify(['files', 'app:metrics']) }, 'analyst')).toEqual(
    ['files', 'app:metrics'],
  )
  expect(
    readOrder({ getItem: () => JSON.stringify(['files', 7, null, '', 'app:metrics']) }, 'analyst'),
  ).toEqual(['files', 'app:metrics'])
})

test('writing an order tolerates a storage failure', () => {
  expect(() =>
    writeOrder(
      {
        setItem: () => {
          throw new Error('quota exceeded')
        },
      },
      'analyst',
      ['files'],
    ),
  ).not.toThrow()
})
