/* ============================================================================
   Coming back out to the ring re-asks what the ring draws.

   The bug these pin: the map route stays mounted while you are inside an agent
   — the conversation is a *place* on the same route, not a route of its own —
   so React Query's `refetchOnMount` never gets a chance to fire on the way
   back. Meanwhile the open conversation writes `unread: false` into the very
   caches the ring's dot is drawn from. The dot can be cleared from the client
   and never re-lit by it, because `unread` is the server's fact about a reader
   and no amount of cache-seeding can invent it.

   The realistic regression is a key that stops matching: `defaults()` is the
   dot's only source and `activity()` is a family of its own, deliberately
   outside `lists()`. A refresh aimed one segment wrong is silent — the map
   simply keeps the answer it already had, which is what the bug looked like.
   So these assert that the *observers* re-ask, rather than that some function
   was called.
   ========================================================================= */
import { afterEach, expect, test } from 'bun:test'

import { QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query'

import type { ActivitySessionSummary } from '@repo/contract'

import { duetQueryKeys } from '../api/query-keys'
import {
  hasUnknownActivityOwner,
  refreshAgentRosterForUnknownOwners,
  refreshRingUnread,
  ringReturned,
} from './ring-freshness'

const WS = 'acme'

const clients: QueryClient[] = []
const subscriptions: Array<() => void> = []
afterEach(() => {
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe()
  for (const client of clients.splice(0)) client.clear()
})

function client() {
  const queryClient = new QueryClient()
  clients.push(queryClient)
  return queryClient
}

function row(
  id: string,
  updatedAt: number,
  bucket: ActivitySessionSummary['bucket'],
): ActivitySessionSummary {
  return {
    id,
    bucket,
    title: id,
    updatedAt,
    unread: false,
  }
}

/** A live observer over one key, reporting how many times its read has run. */
function watch(queryClient: QueryClient, queryKey: QueryKey) {
  const asked = { count: 0 }
  const observer = new QueryObserver(queryClient, {
    queryKey,
    queryFn: async () => {
      asked.count += 1
      return { asked: asked.count }
    },
    retry: false,
    /* The map's reads carry the client's 30s default. Left in on purpose: a
       refresh that only worked on already-stale data would pass a test that
       forgot to set this and fail on the surface, where a reader is back on the
       ring seconds after leaving it. */
    staleTime: 30_000,
  })
  const unsubscribe = observer.subscribe(() => {})
  subscriptions.push(unsubscribe)
  return { asked, unsubscribe }
}

/** Let the observers' refetches settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

/* One family now, and that is the point: the activity read answers every
   owner's own chat beside its work, so the dots and the rows behind them come
   back together. The per-face alias reads this used to fan out to are gone. */
test('returning to the ring leaves the per-owner alias reads alone', async () => {
  const queryClient = client()
  const a0 = watch(queryClient, duetQueryKeys.workspaces.sessions.default(WS, 'a0'))
  await settle()
  expect(a0.asked.count).toBe(1)

  refreshRingUnread(queryClient, WS)
  await settle()

  expect(a0.asked.count).toBe(1)
  a0.unsubscribe()
})

test('returning to the ring re-asks the work under the faces', async () => {
  const queryClient = client()
  const activity = watch(queryClient, duetQueryKeys.workspaces.sessions.activity(WS))
  await settle()
  expect(activity.asked.count).toBe(1)

  refreshRingUnread(queryClient, WS)
  await settle()
  expect(activity.asked.count).toBe(2)

  activity.unsubscribe()
})

/* The reader's own session list is not on this surface, and re-asking it here
   would spend a page fetch — with a cursor — on nothing anyone is looking at. */
test('returning to the ring leaves the session list alone', async () => {
  const queryClient = client()
  const list = watch(
    queryClient,
    duetQueryKeys.workspaces.sessions.list(WS, { search: '', archived: 'exclude' }),
  )
  await settle()
  expect(list.asked.count).toBe(1)

  refreshRingUnread(queryClient, WS)
  await settle()
  expect(list.asked.count).toBe(1)

  list.unsubscribe()
})

test('an unknown activity owner causes the agent roster observer to re-read', async () => {
  const queryClient = client()
  const roster = watch(queryClient, duetQueryKeys.workspaces.agents.list(WS))
  await settle()
  const unknown = hasUnknownActivityOwner(new Set(['agent_a0']), {
    owners: [
      {
        agentId: 'agent_new',
        sessions: [row('new-work', 1, 'running')],
        truncated: false,
      },
    ],
  })

  expect(unknown).toBe(true)
  refreshAgentRosterForUnknownOwners(queryClient, WS, unknown)
  await settle()

  expect(roster.asked.count).toBe(2)
  roster.unsubscribe()
})

/* ---------------------------------------------------------- the edge itself
   Once, on the way out. Firing while the reader is *inside* an agent would put
   one request per face behind a surface that draws no dots; firing every render
   on the ring would be a poll nobody asked for. */
test('the return-edge predicate accepts only leaving an unfolded agent', () => {
  expect(ringReturned(true, false)).toBe(true)
  // still inside, arriving, and sitting on the ring
  expect(ringReturned(true, true)).toBe(false)
  expect(ringReturned(false, true)).toBe(false)
  expect(ringReturned(false, false)).toBe(false)
})
