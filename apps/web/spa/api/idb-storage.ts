import type { AsyncStorage } from '@tanstack/react-query-persist-client'

/* ============================================================================
   One cell of IndexedDB, behind the smallest interface that can hold a cache.

   The query cache needs three operations on one key, so this is three
   operations on one key. What a browser can refuse here — IndexedDB missing
   entirely, a private window that will not open a database, a quota the write
   no longer fits in — must degrade to *no persistence* and never to a broken
   app: the cache is an accelerator, and an accelerator that can take the
   product down with it is not worth having. Which of the three swallows and
   which reports is therefore a decision per operation, and each says why.
   ========================================================================= */

/**
 * The object store and the schema version behind it.
 *
 * Exported because the cache-continuity walk opens this same database to prove
 * a surface was drawn from a cache that *survived* rather than one still in
 * memory — and a walk that guessed either would quietly read an empty store.
 */
export const QUERY_CACHE_IDB = { store: 'cache', version: 1 } as const

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result)
    source.onerror = () => reject(source.error ?? new Error('IndexedDB request failed'))
  })
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(databaseName, QUERY_CACHE_IDB.version)
    open.onupgradeneeded = () => open.result.createObjectStore(QUERY_CACHE_IDB.store)
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error ?? new Error('IndexedDB unavailable'))
    /* A tab holding an old version open blocks the upgrade forever. Refusing
       here rather than hanging is what keeps `isRestoring` short. */
    open.onblocked = () => reject(new Error('IndexedDB upgrade blocked'))
  })
}

/**
 * `undefined` when this browser has no IndexedDB to offer, which is the value
 * the persister already understands as "do not persist".
 */
export function createIndexedDbStorage(databaseName: string): AsyncStorage<string> | undefined {
  if (typeof indexedDB === 'undefined') return undefined

  /* Opened once, lazily, and re-opened after a failure: a browser that refused
     at load may be a private window the reader has since left, and the next
     write is a cheap place to find out. */
  let database: Promise<IDBDatabase> | undefined
  const connect = () => {
    database ??= openDatabase(databaseName).catch(error => {
      database = undefined
      throw error
    })
    return database
  }

  const transact = async <T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const open = await connect()
    return await request(
      run(open.transaction(QUERY_CACHE_IDB.store, mode).objectStore(QUERY_CACHE_IDB.store)),
    )
  }

  return {
    getItem: async key => {
      /* Swallowed: a store that cannot be read is a browser with no cache,
         which is a state the product already draws — the cold first load. */
      try {
        return (await transact('readonly', store => store.get(key))) ?? null
      } catch {
        return null
      }
    },
    /* The one operation that deliberately does NOT swallow. A quota rejection
       is the ordinary end of a growing cache, and the persister above answers
       it by dropping the oldest query and writing again (`removeOldestQuery`) —
       which it can only do if the failure reaches it. It owns the error from
       there: its own save is wrapped, and its throttle discards what escapes,
       so nothing here can reach the reader. */
    setItem: async (key, value) => await transact('readwrite', store => store.put(value, key)),
    removeItem: async key => {
      /* Swallowed, because the caller is signing out: a store that cannot be
         cleared must not be the reason somebody stays signed in. The refusal
         to write again is already latched in memory by then, and the next
         reader's buster discards whatever was left behind. */
      try {
        await transact('readwrite', store => store.delete(key))
      } catch {
        /* nothing left to do */
      }
    },
  }
}
