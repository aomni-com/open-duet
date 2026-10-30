import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { CollectionLoadMore } from './collection-load-more'

test('collection continuation names idle, loading, and retry states', () => {
  const labels = { load: 'Load more', loading: 'Loading…', retry: 'Try loading more again' }

  expect(renderToStaticMarkup(<CollectionLoadMore labels={labels} onLoad={() => {}} />)).toContain(
    labels.load,
  )
  expect(
    renderToStaticMarkup(<CollectionLoadMore labels={labels} loading onLoad={() => {}} />),
  ).toContain(labels.loading)
  const failedMarkup = renderToStaticMarkup(
    <CollectionLoadMore
      labels={{ ...labels, retry: 'Try again' }}
      failed
      failureMessage="Older activity could not be loaded."
      onLoad={() => {}}
    />,
  )
  expect(failedMarkup).toContain('Older activity could not be loaded.')
  expect(failedMarkup).toContain('Try again')
})
