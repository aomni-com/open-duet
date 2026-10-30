import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { ComposeBarMentionPicker } from './compose-bar-mention-picker'

const suggestion = {
  trigger: 'skillMention',
  char: '/',
  query: '',
  items: [{ id: '/skills/one', name: 'one', path: '/skills/one' }],
  activeIndex: 0,
  select: () => {},
}

const labels = {
  list: 'Skills',
  loading: 'Loading skills…',
  empty: 'No matching skills',
  unavailable: "Couldn't reach your workspace",
}

test('a loaded picker offers the next page without hiding its rows', () => {
  const markup = renderToStaticMarkup(
    <ComposeBarMentionPicker
      suggestion={suggestion}
      labels={labels}
      loading={false}
      continuation={{
        loading: false,
        unavailable: false,
        onLoadMore: () => {},
        labels: { loadMore: 'Load more', loading: 'Loading more…', retry: 'Try again' },
      }}
    />,
  )

  expect(markup).toContain('/one')
  expect(markup).toContain('Load more')
})

test('a requested next page keeps rows visible and disables duplicate requests', () => {
  const markup = renderToStaticMarkup(
    <ComposeBarMentionPicker
      suggestion={suggestion}
      labels={labels}
      loading={false}
      continuation={{
        loading: true,
        unavailable: false,
        onLoadMore: () => {},
        labels: { loadMore: 'Load more', loading: 'Loading more…', retry: 'Try again' },
      }}
    />,
  )

  expect(markup).toContain('/one')
  expect(markup).toContain('Loading more…')
  expect(markup).toContain('disabled=""')
})

test('a failed next page keeps rows visible and offers an enabled retry', () => {
  const markup = renderToStaticMarkup(
    <ComposeBarMentionPicker
      suggestion={suggestion}
      labels={labels}
      loading={false}
      continuation={{
        loading: false,
        unavailable: true,
        onLoadMore: () => {},
        labels: { loadMore: 'Load more', loading: 'Loading more…', retry: 'Try again' },
      }}
    />,
  )

  expect(markup).toContain('/one')
  expect(markup).toContain('Try again')
  expect(markup).not.toContain('disabled=""')
})
