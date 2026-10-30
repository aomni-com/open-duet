'use client'

/* ============================================================================
   The listings behind the columns.

   One query per open folder, keyed exactly the way the drive already keys the
   folder you are standing in. That is the whole trick: walking back up a chain
   you have already walked re-reads nothing, because every ancestor's listing is
   still the same cache entry the single-folder drive wrote — and the folder you
   just left revalidates behind its own columns instead of in front of a
   skeleton.

   This owner touches only `IFileSystemProvider`. Projection into rows stays with
   the caller, which is the one that knows about apps, hidden files, and the
   toolbar.
   ========================================================================= */
import { useQueries, useQueryClient } from '@tanstack/react-query'

import { duetQueryKeys } from '../api/query-keys'
import type { ColumnState } from './drive-column'
import { filesViewQueryOptions, loadNextFilesViewPage, nextFilesViewCursor } from './lib/files-view'
import type { DirectoryEntry, IFileSystemProvider } from './lib/types'

const NO_ENTRIES: readonly DirectoryEntry[] = []
export const driveColumnRefreshInterval = 5_000
const MAX_REFRESHING_DRIVE_COLUMNS = 3

export function driveColumnRefetchInterval(
  chain: readonly string[],
  index: number,
): number | false {
  return index >= Math.max(0, chain.length - MAX_REFRESHING_DRIVE_COLUMNS)
    ? driveColumnRefreshInterval
    : false
}

export type ColumnListing = {
  dir: string
  entries: readonly DirectoryEntry[]
  state: ColumnState
  hasNextPage: boolean
  loadingNextPage: boolean
  nextPageFailed: boolean
  loadNextPage(): Promise<void>
}

export function useDriveColumnListings({
  provider,
  workspaceSlug,
  chain,
}: {
  provider: IFileSystemProvider
  workspaceSlug: string
  /** Open folders, root first, from `driveColumnChain`. */
  chain: readonly string[]
}): ColumnListing[] {
  const queryClient = useQueryClient()
  return useQueries({
    queries: chain.map((dir, index) => ({
      ...filesViewQueryOptions(provider, workspaceSlug, dir, { queryClient }),
      /* The nearest three folders are the reader's active context. Older
         ancestors remain visible from cache, but polling an arbitrarily deep
         chain would turn one tab into one VM request per path segment. */
      refetchInterval: driveColumnRefetchInterval(chain, index),
    })),
    combine: results =>
      results.map((result, index) => {
        const dir = chain[index] ?? '/'
        const view = result.data
        const entries =
          view?.status === 'folder' || view?.status === 'file' ? view.entries : NO_ENTRIES

        /* A column that already has a listing keeps showing it while the answer
           is rechecked. Only a column that has never resolved draws a skeleton,
           and only one with nothing to show reports the failure — a refetch that
           fails behind a good listing must not blank the column. */
        let state: ColumnState
        if (result.isPending) state = { kind: 'loading' }
        else if (view?.status === 'error' && entries.length === 0)
          state = { kind: 'error', message: view.error.message }
        else if (view?.status === 'not-found' && entries.length === 0)
          state = { kind: 'error', message: dir }
        else state = { kind: 'ready' }

        return {
          dir,
          entries,
          state,
          hasNextPage: nextFilesViewCursor(view) !== null,
          loadingNextPage:
            (view?.status === 'folder' || view?.status === 'file') &&
            view.continuation === 'loading',
          nextPageFailed:
            (view?.status === 'folder' || view?.status === 'file') && view.continuation === 'error',
          loadNextPage: async () => {
            try {
              await loadNextFilesViewPage({
                queryClient,
                queryKey: duetQueryKeys.workspaces.files.view(workspaceSlug, dir),
                provider,
              })
            } catch {
              // The cache records the continuation error and turns this same
              // control into Retry; event handlers must not leak a rejection.
            }
          },
        }
      }),
  })
}
