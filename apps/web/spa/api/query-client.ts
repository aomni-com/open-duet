import { QueryClient } from '@tanstack/react-query'

/**
 * How long an answer with nobody watching it stays in the cache.
 *
 * TanStack's default is five minutes, which is shorter than an ordinary walk
 * around this product: read home, open an agent, sit in a session for ten, go
 * back to home — and the map's reads had been collected, so the reader paid a
 * full-page skeleton for rows they had already been told. It is also what
 * decides how much survives a reload, because a collected entry is gone from
 * the next snapshot the persister writes (see `query-persistence.ts`).
 *
 * A day, then: long enough that a sitting cannot outlast it, and short enough
 * that a tab left open for a week is not still holding a workspace it has since
 * left. It is the only retention in the app on purpose — anything warmed ahead
 * of a reader (`knowledge-map-data/preload-agent-pages.ts`) is the last thing
 * that should be given a shorter clock than the rest of the cache.
 */
const CACHE_RETENTION_MS = 24 * 60 * 60_000

export function createDuetQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 30_000,
        gcTime: CACHE_RETENTION_MS,
        /* `always`, not the default `true`, and the difference is the whole
           point of a cache that outlives its network. `true` refetches only
           what `staleTime` calls stale, which is a clock — and a clock is a
           poor proxy for "nothing has been missed" precisely when the
           connection was the thing that was down. Coming back is the moment
           everything on screen is unverified by definition, so everything on
           screen asks again. It is bounded by what is mounted, and it happens
           once per reconnection. */
        refetchOnReconnect: 'always',
      },
      mutations: {
        retry: false,
      },
    },
  })
}
