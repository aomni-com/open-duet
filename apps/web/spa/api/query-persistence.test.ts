import { expect, test } from 'bun:test'

import type { QueryClient } from '@tanstack/react-query'
import {
  persistQueryClientRestore,
  persistQueryClientSave,
} from '@tanstack/react-query-persist-client'

import { createDuetQueryClient } from './query-client'
import { duetQueryKeys } from './query-keys'
import {
  duetQueryPersistence,
  QUERY_CACHE_SCHEMA_VERSION,
  QUERY_CACHE_STORAGE_KEY,
} from './query-persistence'

/** An `AsyncStorage` that is nothing but a Map, standing in for IndexedDB. */
function memoryStorage() {
  const cells = new Map<string, string>()
  return {
    cells,
    getItem: async (key: string) => cells.get(key) ?? null,
    setItem: async (key: string, value: string) => void cells.set(key, value),
    removeItem: async (key: string) => void cells.delete(key),
  }
}

type Storage = ReturnType<typeof memoryStorage>

/** Close a sitting: write what this client learned into the browser's store. */
async function endSitting(storage: Storage, userId: string, queryClient: QueryClient) {
  const { options } = duetQueryPersistence({ userId }, storage)
  await persistQueryClientSave({ ...options, queryClient })
}

/** Open the next one: a fresh client, restored from that same store. */
async function nextSitting(storage: Storage, userId: string) {
  const { options } = duetQueryPersistence({ userId }, storage)
  const queryClient = createDuetQueryClient()
  await persistQueryClientRestore({ ...options, queryClient })
  return queryClient
}

test('discards a persisted single-page collection after its cache shape becomes paged', async () => {
  const storage = memoryStorage()
  const old = createDuetQueryClient()
  old.setQueryData(duetQueryKeys.user.oauthGrants, {
    items: [{ id: 'grant_older' }],
    nextCursor: null,
  })
  await endSitting(storage, 'user_ada', old)
  const serialized = storage.cells.get(QUERY_CACHE_STORAGE_KEY)
  expect(serialized).toBeDefined()
  storage.cells.set(
    QUERY_CACHE_STORAGE_KEY,
    serialized!.replace(
      `v${QUERY_CACHE_SCHEMA_VERSION}:user_ada`,
      `v${QUERY_CACHE_SCHEMA_VERSION - 1}:user_ada`,
    ),
  )

  const current = await nextSitting(storage, 'user_ada')
  expect(current.getQueryData(duetQueryKeys.user.oauthGrants)).toBeUndefined()
  expect([...storage.cells.keys()]).toEqual([])
})

test('restores the roster value read in the previous sitting', async () => {
  const storage = memoryStorage()
  const roster = { agents: [{ id: 'agent_research', slug: 'research' }] }

  const first = createDuetQueryClient()
  await first.fetchQuery({
    queryKey: duetQueryKeys.workspaces.agents.list('acme'),
    queryFn: async () => {
      return roster
    },
  })
  await endSitting(storage, 'user_ada', first)

  const next = await nextSitting(storage, 'user_ada')
  expect(next.getQueryData<typeof roster>(duetQueryKeys.workspaces.agents.list('acme'))).toEqual(
    roster,
  )
})

test('a landing share is spent in the sitting that got it, never restored into the next', async () => {
  const storage = memoryStorage()
  const first = createDuetQueryClient()
  await first.fetchQuery({
    queryKey: duetQueryKeys.user.pendingShareLanding,
    queryFn: async () => ({ id: 'share_abc' }),
  })
  await first.fetchQuery({
    queryKey: duetQueryKeys.user.shareRequests,
    queryFn: async () => ({ shares: [{ id: 'share_abc' }] }),
  })
  await endSitting(storage, 'user_ada', first)

  const next = await nextSitting(storage, 'user_ada')
  expect(next.getQueryData(duetQueryKeys.user.pendingShareLanding)).toBeUndefined()
  /* The ordinary half of the same family is still there, so what is excluded is
     this one consuming read rather than everything under `share-requests`. */
  expect(next.getQueryData<{ shares: { id: string }[] }>(duetQueryKeys.user.shareRequests)).toEqual(
    {
      shares: [{ id: 'share_abc' }],
    },
  )
})

test("another user's cache is discarded rather than drawn", async () => {
  const storage = memoryStorage()
  const first = createDuetQueryClient()
  await first.fetchQuery({
    queryKey: duetQueryKeys.workspaces.agents.list('acme'),
    queryFn: async () => ({ agents: [{ id: 'agent_research' }] }),
  })
  await endSitting(storage, 'user_ada', first)

  const grace = await nextSitting(storage, 'user_grace')
  expect(grace.getQueryData(duetQueryKeys.workspaces.agents.list('acme'))).toBeUndefined()
  // And it is gone from the browser, not merely skipped on this one load.
  expect([...storage.cells.keys()]).toEqual([])
})

test('signing out drops the store, and leaving the page cannot write it back', async () => {
  const storage = memoryStorage()
  const queryClient = createDuetQueryClient()
  await queryClient.fetchQuery({
    queryKey: duetQueryKeys.workspaces.agents.list('acme'),
    queryFn: async () => ({ agents: [{ id: 'agent_research' }] }),
  })
  const { flush, forget } = duetQueryPersistence({ userId: 'user_ada' }, storage)
  await flush(queryClient)
  expect([...storage.cells.keys()]).not.toEqual([])

  await forget()
  /* Signing out deletes the store and then navigates, and that navigation fires
     `pagehide` — so the flush racing behind it must find the door shut rather
     than write this reader's workspace back out for the next one. */
  await flush(queryClient)

  expect([...storage.cells.keys()]).toEqual([])
})

/* The drive hands rows a real `Date`, and this cache is written through
   `JSON.stringify`. A round trip that quietly returns the ISO string instead
   does not fail here — it fails later, at the first `modifiedAt.getTime()`, as
   a `getTime is not a function` from inside a rendered column. */
test('a Date survives the sitting as a Date, not as the string it serializes to', async () => {
  const storage = memoryStorage()
  const modifiedAt = new Date('2026-07-11T08:30:00.000Z')
  const first = createDuetQueryClient()
  await first.fetchQuery({
    queryKey: [...duetQueryKeys.workspaces.all, 'acme', 'files', '/'],
    queryFn: async () => ({ entries: [{ name: 'notes.md', modifiedAt }] }),
  })
  await endSitting(storage, 'user_ada', first)

  const next = await nextSitting(storage, 'user_ada')
  const restored = next.getQueryData<{
    entries: { name: string; modifiedAt: Date }[]
  }>([...duetQueryKeys.workspaces.all, 'acme', 'files', '/'])
  expect(restored?.entries[0]?.modifiedAt).toBeInstanceOf(Date)
  expect(restored?.entries[0]?.modifiedAt.getTime()).toBe(modifiedAt.getTime())
})
