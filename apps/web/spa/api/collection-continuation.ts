'use client'

import { useCallback, useMemo } from 'react'

type CollectionContinuationQuery = {
  hasNextPage: boolean
  isFetchingNextPage: boolean
  isFetchNextPageError: boolean
  fetchNextPage: () => Promise<unknown>
}

/**
 * The browser's one imperative owner for requesting another collection page.
 * Presentation receives a named continuation state and action; it never calls
 * a query transport method directly or loses the failed-page retry lane.
 */
export function useCollectionContinuation(query: CollectionContinuationQuery) {
  const requestNextPage = query.fetchNextPage
  const load = useCallback(() => {
    void requestNextPage()
  }, [requestNextPage])

  return useMemo(
    () => ({
      available: query.hasNextPage,
      loading: query.isFetchingNextPage,
      failed: query.isFetchNextPageError,
      load,
    }),
    [load, query.hasNextPage, query.isFetchNextPageError, query.isFetchingNextPage],
  )
}
