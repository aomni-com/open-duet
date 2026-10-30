import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import type { QueryClient } from '@tanstack/react-query'
import { persistQueryClientSave, removeOldestQuery } from '@tanstack/react-query-persist-client'
import type {
  AsyncStorage,
  PersistedClient,
  PersistQueryClientOptions,
  Persister,
} from '@tanstack/react-query-persist-client'

import { createIndexedDbStorage } from './idb-storage'
import { QUERY_CACHE_SCHEMA_VERSION } from './query-cache-version'

export { QUERY_CACHE_SCHEMA_VERSION } from './query-cache-version'

/* ============================================================================
   The read a reader already paid for, kept.

   Every product surface here is a REST read behind TanStack Query, and the
   cache holding those answers used to live only in the tab's memory. Reload,
   open a second tab, come back tomorrow — and home, agents and sessions each
   drew their full-page skeleton again for rows the browser had already been
   told. `preload-agent-pages` warms the fleet *within* a sitting; this is the
   same promise across sittings, and offline.

   It is TanStack's own persistence rather than a sync engine of our own,
   because the data layer is already the shape a persister needs: one map of
   `queryOptions` factories under one disciplined key hierarchy
   (`query-keys.ts`). An engine of our own would have to re-own fetching,
   ordering, invalidation and optimistic writes, all of which the option
   factories and `sessions/session-cache.ts` already own correctly.

   ---- what makes it IndexedDB and not localStorage ----
   Two reasons, both fatal to the simpler choice. A workspace's cache is
   megabytes — rosters, transcripts, folder listings, one entry per agent — and
   localStorage caps an origin at about five. And every write there is
   synchronous on the main thread: serializing the whole cache on a 2s throttle
   would jank the surface it exists to make feel instant.
   ========================================================================= */

/**
 * Bumped when a persisted response shape loses or renames a field.
 *
 * A restored answer is drawn before the network can correct it, so a cache
 * written by an older bundle has to be *shape*-compatible with this one.
 * Optional additive contract changes are safe by construction, but a new
 * required field is not: an older answer cannot supply its meaning. Removals,
 * renames, and required additions bump this number and cost every reader one
 * cold load.
 */
/** How long an untouched cache is still worth drawing before it is discarded. */
const QUERY_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000

/** Writes are coalesced: a live surface must not serialize the cache per event. */
const PERSIST_THROTTLE_MS = 2_000

/**
 * The one cell inside that database every tab of one browser shares.
 *
 * Deliberately not the database's own name: they are two different things, and
 * a reader who greps one should not land on the other.
 */
export const QUERY_CACHE_STORAGE_KEY = 'client'

/**
 * The cache is one user's, and the buster is how that is enforced.
 *
 * On a mismatch TanStack discards *and removes* the stored client rather than
 * merging it, so signing in as somebody else on a shared browser cannot draw
 * the previous reader's workspace for even one frame.
 */
function queryCacheBuster(userId: string): string {
  return `v${QUERY_CACHE_SCHEMA_VERSION}:${userId}`
}

/**
 * Whether one cache entry is worth carrying into the next sitting.
 *
 * Asked of the query key rather than of a flag at each call site: the key
 * hierarchy is the one place that already knows what a read *is*, and a policy
 * spread across forty option factories is a policy nobody can read. Failures
 * and in-flight reads are already excluded by the caller — this decides only
 * among answers that succeeded.
 */
function shouldPersistQueryKey(queryKey: readonly unknown[]): boolean {
  if (queryKey[0] !== 'duet') return false
  const scope = queryKey[1]
  /* Another workspace's internals, read by staff, at a size no reader of this
     browser benefits from carrying. */
  if (scope === 'internal-admin') return false
  /* A consuming read: the server hands a landing share over exactly once and
     the SPA navigates on it. Persisted, every later load would re-run that
     navigation off an answer already spent. */
  if (scope === 'user' && queryKey[2] === 'share-requests' && queryKey[3] === 'landing') {
    return false
  }
  if (scope === 'workspaces') {
    const family = queryKey[3]
    /* A live screen and a live OAuth handshake — connections, not records. A
       restored "connected" or "pending" describes a machine and a browser
       window that are no longer there. */
    if (family === 'desktop') return false
    if (family === 'connected-providers' && queryKey[4] === 'connect') return false
  }
  return true
}

/**
 * Whose cache to keep, and where.
 *
 * Absent means no persistence at all, which is what every playground fixture
 * and every signed-out surface passes: a fixture's invented workspace must
 * never end up in the store a real reader's product restores from.
 */
export type QueryCachePersistence = {
  readonly userId: string
  /** Fixtures name their own database so they cannot collide with the product's. */
  readonly databaseName?: string
}

/** The IndexedDB database the signed-in product keeps its cache in. */
const QUERY_CACHE_DATABASE = 'duet-query-cache'

/**
 * `undefined` storage is the persister's own word for "do not persist", which
 * is what a browser with no IndexedDB and the server render both hand it. The
 * decision to persist therefore stays a prop, identical on both sides of
 * hydration, and only the storage under it varies.
 */
/**
 * How a `Date` survives this store, which is a store of strings.
 *
 * `JSON.stringify` turns a `Date` into an ISO string and `JSON.parse` has no
 * way to know it was ever anything else, so a restored read hands the app a
 * string wearing a `Date`'s type. Nothing complains at the boundary: it fails
 * later and elsewhere, as `getTime is not a function` from inside whichever
 * column first did arithmetic on it.
 *
 * So dates are tagged on the way out and revived on the way in. The replacer
 * reads `this[key]` rather than `value`, because by the time a replacer sees a
 * value `toJSON` has already flattened the `Date` to a string.
 */
const DATE_TAG = '$date'

function serializeCache(client: PersistedClient): string {
  return JSON.stringify(client, function (this: Record<string, unknown>, key, value: unknown) {
    const original = this[key]
    return original instanceof Date ? { [DATE_TAG]: original.toISOString() } : value
  })
}

function deserializeCache(cached: string): PersistedClient {
  return JSON.parse(cached, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object') return value
    const tagged = value as Record<string, unknown>
    /* Exactly the one key, so a real payload that happens to carry a `$date`
       field beside others is left as the object it is. */
    if (Object.keys(tagged).length !== 1 || typeof tagged[DATE_TAG] !== 'string') return value
    return new Date(tagged[DATE_TAG])
  }) as PersistedClient
}

function persisterOver(storage: AsyncStorage<string> | undefined, throttleTime: number): Persister {
  return createAsyncStoragePersister({
    storage,
    key: QUERY_CACHE_STORAGE_KEY,
    throttleTime,
    /* A cache that has outgrown its quota drops its oldest answer and tries
       again, rather than giving up on persistence for the rest of the sitting.
       Oldest is the right one to lose: it is the read furthest from what the
       reader is doing now. */
    retry: removeOldestQuery,
    serialize: serializeCache,
    deserialize: deserializeCache,
  })
}

/**
 * Everything one browser needs to keep its cache: the standing options the
 * provider subscribes with, a way to write it out *now*, and a way to stop.
 *
 * The flush exists because the standing write is throttled, and the reader who
 * most needs this feature is the one moving fast: land on an agent, read it,
 * click away inside two seconds, and the throttle has not written that page
 * down yet. Leaving is the one moment worth paying an unthrottled serialize
 * for, so the same storage gets a second, immediate persister for it.
 *
 * `forget` and `flush` are returned together rather than living apart, and that
 * is the whole reason this is one object: signing out deletes the store and
 * then navigates, the navigation fires `pagehide`, and a flusher that did not
 * know about the deletion would write the cache straight back out on the way to
 * the sign-out page. One latch, consulted by both.
 *
 * `storage` is injectable so a test can drive this exact construction against a
 * Map rather than a browser's IndexedDB. The policy under test is then the one
 * the product runs, not a second assembly of the same parts that can drift.
 */
export function duetQueryPersistence(
  persistence: QueryCachePersistence,
  storage: AsyncStorage<string> | undefined = createIndexedDbStorage(
    persistence.databaseName ?? QUERY_CACHE_DATABASE,
  ),
): {
  options: Omit<PersistQueryClientOptions, 'queryClient'>
  flush(queryClient: QueryClient): Promise<void>
  forget(): Promise<void>
} {
  const options: Omit<PersistQueryClientOptions, 'queryClient'> = {
    persister: persisterOver(storage, PERSIST_THROTTLE_MS),
    buster: queryCacheBuster(persistence.userId),
    maxAge: QUERY_CACHE_MAX_AGE_MS,
    dehydrateOptions: {
      shouldDehydrateQuery: query =>
        query.state.status === 'success' && shouldPersistQueryKey(query.queryKey),
    },
  }
  const immediate = { ...options, persister: persisterOver(storage, 0) }
  let forgotten = false
  return {
    options,
    flush: async queryClient => {
      if (forgotten) return
      await persistQueryClientSave({ ...immediate, queryClient })
    },
    /**
     * Drop the stored cache outright.
     *
     * Signing out is the one moment the buster cannot cover: the next reader of
     * this browser may be nobody in particular, and what they must not find is
     * the last one's workspace sitting in IndexedDB.
     */
    forget: async () => {
      forgotten = true
      await storage?.removeItem(QUERY_CACHE_STORAGE_KEY)
    },
  }
}
