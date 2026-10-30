/* ============================================================================
   Archiving an owner's default chat.

   Two things can go silently wrong here and both are pinned below.

   The refresh is three families, not one. `defaults` (the alias the panel is
   drawn from) and `activity` (the map's one read — the work under every face,
   and the chat on it) sit deliberately *outside* the `lists()` prefix, because
   neither has filters or a cursor. A refresh aimed one segment wrong is silent:
   the surface simply keeps the answer it already had, which is the bug wearing
   the costume of nothing happening. So these assert that the *observers* re-ask.

   And the control has to be shut while a first message is landing. That send
   ends by stamping the owner's pointer at the session it just minted, so a
   clear that races it is undone a moment later — and the reader is left looking
   at the conversation they archived.
   ========================================================================= */
import { afterEach, expect, test } from 'bun:test'

import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
  type QueryKey,
} from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { duetQueryKeys } from '../api/query-keys'
import { SpaContext, type SpaApi, type SpaContextValue } from '../context'
import { archiveDefaultChatState, useArchiveDefaultChat } from './archive-default-chat'
import { invalidateDefaultChatPointer } from './default-chat'

const WS = 'acme'
const observers: Array<() => void> = []
const clients = new Set<QueryClient>()

afterEach(() => {
  for (const unsubscribe of observers.splice(0)) unsubscribe()
  for (const client of clients) client.clear()
  clients.clear()
})

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
    // The map's reads carry the client's 30s default, so a refresh that only
    // worked on already-stale data would pass here and fail on the surface.
    staleTime: 30_000,
  })
  observers.push(observer.subscribe(() => {}))
  clients.add(queryClient)
  return { asked }
}

/** Let the observers' refetches settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

test('moving the pointer re-asks the alias, the map’s activity and the jobs list together', async () => {
  const queryClient = new QueryClient()
  const sessions = duetQueryKeys.workspaces.sessions
  const alias = watch(queryClient, sessions.default(WS, 'research'))
  const activity = watch(queryClient, sessions.activity(WS))
  const jobs = watch(
    queryClient,
    sessions.list(WS, { search: '', archived: 'exclude', agentId: 'agent_research' }),
  )
  await settle()
  expect([alias.asked.count, activity.asked.count, jobs.asked.count]).toEqual([1, 1, 1])

  invalidateDefaultChatPointer(queryClient, WS)
  await settle()

  /* All three, and in the same tick, because all three carry the answer: the
     alias for one owner, the activity read for every owner, and the lists that
     are drawn by withholding whichever id those two name. One left holding the
     old pointer contradicts the others. */
  expect([alias.asked.count, activity.asked.count, jobs.asked.count]).toEqual([2, 2, 2])
})

/* The refresh above is a function anyone could forget to call. This drives the
   hook the surface actually uses, so deleting its `onSuccess` fails here rather
   than shipping a control that writes the pointer and leaves every list holding
   the conversation it just moved. */
test('the hook the control uses re-asks those reads when the write lands', async () => {
  const queryClient = new QueryClient()
  const sessions = duetQueryKeys.workspaces.sessions
  const alias = watch(queryClient, sessions.default(WS, 'research'))
  const activity = watch(queryClient, sessions.activity(WS))
  await settle()
  expect([alias.asked.count, activity.asked.count]).toEqual([1, 1])

  const asked: Array<[string, string, string | null]> = []
  const api = {
    setDefaultSession: async (slug: string, agentSlug: string, sessionId: string | null) => {
      asked.push([slug, agentSlug, sessionId])
      return null
    },
  } as unknown as SpaApi

  let archive: ReturnType<typeof useArchiveDefaultChat> | undefined
  function Probe() {
    archive = useArchiveDefaultChat(WS)
    return null
  }
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        SpaContext.Provider,
        { value: { api } as unknown as SpaContextValue },
        createElement(Probe),
      ),
    ),
  )

  await archive!.mutateAsync('research')
  await settle()

  // The owner token rides the call, and clearing is what the product asks for.
  expect(asked).toEqual([[WS, 'research', null]])
  expect([alias.asked.count, activity.asked.count]).toEqual([2, 2])
})

/* Another workspace's caches are somebody else's drive. */
test('archiving leaves another workspace’s reads alone', async () => {
  const queryClient = new QueryClient()
  const other = watch(queryClient, duetQueryKeys.workspaces.sessions.default('globex', 'research'))
  await settle()
  expect(other.asked.count).toBe(1)

  invalidateDefaultChatPointer(queryClient, WS)
  await settle()
  expect(other.asked.count).toBe(1)
})

/* ------------------------------------------------------ when it can be used */

test('an absent or unknown default session classifies archival as absent', () => {
  expect(archiveDefaultChatState({ session: null, sending: false })).toBe('absent')
  // Not known yet is not "there is one": the control appears with the answer.
  expect(archiveDefaultChatState({ sending: false })).toBe('absent')
})

test('a known default session without a pending send classifies archival as ready', () => {
  expect(archiveDefaultChatState({ session: { id: 'session_7' }, sending: false })).toBe('ready')
})

/* The send that is in flight ends by pointing this owner at the session it just
   minted. Clearing the pointer underneath it clears something that is about to
   be written again — so the control is shut until the send has landed. */
test('a pending send with a known default session classifies archival as busy', () => {
  expect(archiveDefaultChatState({ session: { id: 'session_7' }, sending: true })).toBe('busy')
})

/* Absent beats busy: there is nothing to archive either way, and a control that
   appears greyed-out the instant somebody types announces a thing they cannot
   do yet. */
test('an absent default session takes precedence over a pending send', () => {
  expect(archiveDefaultChatState({ session: null, sending: true })).toBe('absent')
})
