import { expect, test } from 'bun:test'

import { QueryClient } from '@tanstack/react-query'

import {
  ROOT_AGENT_SCOPE,
  type SessionActivityResponse,
  type SessionSnapshot,
} from '@repo/contract'

import { DuetApiError } from '../api/client'
import { duetQueryKeys } from '../api/query-keys'
import type { SpaApi } from '../context'
import {
  defaultChatAgentSlug,
  defaultChatCreatedId,
  defaultChatMount,
  defaultChatOwnerKey,
  defaultChatQueryOptions,
  stampDefaultChat,
} from './default-chat'

/** Records which read an api call actually was, so the endpoint is the assertion. */
function recordingApi(reads: string[]): SpaApi {
  return {
    getDefaultSession: async (_workspaceSlug: string, agentSlug: string) => {
      // The owner is a token now, root included, so the recorder can print it
      // verbatim. No agent can be confused with the drive root here because no
      // agent may claim `root` — the slug grammar reserves it.
      reads.push(`default:${agentSlug}`)
      return { id: 'session_default' }
    },
    listSessions: async () => {
      reads.push('list')
      return { sessions: [] }
    },
  } as unknown as SpaApi
}

/** Runs a query's fetcher with only the field it reads, as react-query would. */
async function run(options: { queryFn?: unknown }) {
  await (options.queryFn as (ctx: { signal: AbortSignal }) => Promise<unknown>)({
    signal: new AbortController().signal,
  })
}

/* The bug this guards: the panel used to pick a session out of the agent's
   *list*, so anything the agent started — a subagent's own session included —
   could take it over. The default session is addressed by alias and resolved
   server-side; the list is not a source for it at all. */
test('opening an agent asks for its default session, and never for a session list', async () => {
  const reads: string[] = []
  await run(defaultChatQueryOptions(recordingApi(reads), 'acme', 'research-assistant'))
  expect(reads).toEqual(['default:research-assistant'])
})

test('the drive root asks for the root default session, not an agent-scoped one', async () => {
  const reads: string[] = []
  await run(defaultChatQueryOptions(recordingApi(reads), 'acme', ROOT_AGENT_SCOPE))
  expect(reads).toEqual(['default:root'])
})

/* ------------------------------------------------------- what the panel shows

   The distinction that matters in every case below is "no default chat yet"
   versus "we could not find out". Only the first may open a composer: offering
   to start a chat on top of one that already exists is how a reader ends up
   with two, and how the one they were reading disappears. */

test('an owner with a default chat opens on it', () => {
  expect(defaultChatMount({ isPending: false, session: { id: 'session_7' } })).toEqual({
    kind: 'session',
    sessionId: 'session_7',
  })
})

test('an owner nobody has written to yet opens the composer', () => {
  expect(defaultChatMount({ isPending: false, session: null })).toEqual({ kind: 'compose' })
})

test('a read that failed says so instead of offering to start a second chat', () => {
  expect(defaultChatMount({ isPending: false, error: new DuetApiError(500, 'internal') })).toEqual({
    kind: 'unavailable',
  })
  expect(defaultChatMount({ isPending: false, error: new Error('offline') })).toEqual({
    kind: 'unavailable',
  })
})

/* Any error — a 404 for a route that genuinely misses included — is a failed
   read, not an empty chat: the composer would be pointed at nothing. */
test('a 404 for any other reason is not an empty default chat', () => {
  expect(defaultChatMount({ isPending: false, error: new DuetApiError(404, 'not_found') })).toEqual(
    {
      kind: 'unavailable',
    },
  )
})

test('an in-flight read waits rather than flashing the composer', () => {
  expect(defaultChatMount({ isPending: true })).toEqual({ kind: 'loading' })
})

/* The pointer is stamped by the same request that created the row, so the
   refetch can only agree — and waiting for it would blink the conversation the
   reader just started back out to the composer. */
test('the chat just created holds the panel before the read catches up', () => {
  expect(defaultChatMount({ isPending: true, created: 'session_new' })).toEqual({
    kind: 'session',
    sessionId: 'session_new',
  })
})

/* ------------------------------------------------- and letting go of it again

   `created` beats the read, and for a while nothing ever cleared it. Archiving
   the chat refetches `null` — and the panel is keyed by the agent, not by the
   session, so it never remounts — which left the one person who had started the
   conversation in that tab reading the chat they had just archived. No error,
   no spinner, and the composer branch unreachable for them. */

test('archiving lets go of the chat this tab started, and the empty chat comes back', () => {
  const held = { owner: defaultChatOwnerKey('acme', 'research'), sessionId: 'session_new' }

  // While it is theirs: the minted id holds the panel until the read agrees.
  expect(
    defaultChatMount({
      isPending: true,
      created: defaultChatCreatedId(held, defaultChatOwnerKey('acme', 'research')),
    }),
  ).toEqual({ kind: 'session', sessionId: 'session_new' })

  // Once archived: the same held id, the same owner, and the alias settled on
  // "no chat here" — which is what the reader must now be shown.
  const archived = defaultChatOwnerKey('acme', 'research', 1_777_000_000_000)
  expect(
    defaultChatMount({
      isPending: false,
      session: null,
      created: defaultChatCreatedId(held, archived),
    }),
  ).toEqual({ kind: 'compose' })
})

/* Archiving is not a one-way door: the next message mints a chat like any
   first message, and that one has to hold the panel the same way. */
test('a chat started after archiving holds the panel again', () => {
  const owner = defaultChatOwnerKey('acme', 'research', 1_777_000_000_000)
  const held = { owner, sessionId: 'session_after' }
  expect(defaultChatMount({ isPending: true, created: defaultChatCreatedId(held, owner) })).toEqual(
    { kind: 'session', sessionId: 'session_after' },
  )
})

/* --------------------------------------------------------------- the owner

   The drive root is an owner like any agent — you click into the centre of the
   map the same way you click a face — but it is not a row in `agents`, so its
   pointer lives on the workspace (`rootDefaultSessionId`). On the wire it is
   addressed like every other owner, under the reserved slug `root` — which is
   what the client spells too, so no layer carries a null owner to translate. */

test('the root scope is the drive root, not an agent named "root"', () => {
  expect(defaultChatAgentSlug(ROOT_AGENT_SCOPE)).toBe(ROOT_AGENT_SCOPE)
  expect(defaultChatAgentSlug(null)).toBe(ROOT_AGENT_SCOPE)
  expect(defaultChatAgentSlug('')).toBe(ROOT_AGENT_SCOPE)
})

test('a named agent keeps its own slug', () => {
  expect(defaultChatAgentSlug('research-assistant')).toBe('research-assistant')
})

/* End to end, because the mapping above is only worth anything if it reaches
   the root alias: clicking the centre of the map must resolve the workspace's
   own pointer, exactly as clicking a face resolves that agent's. */
test('clicking into the root agent reads the root default session', async () => {
  const reads: string[] = []
  await run(
    defaultChatQueryOptions(recordingApi(reads), 'acme', defaultChatAgentSlug(ROOT_AGENT_SCOPE)),
  )
  expect(reads).toEqual(['default:root'])
})

/* ============================================================================
   The window a first message opens.

   The pointer moves on the server and the refetches that notice it are a round
   trip away — but the frames of the conversation that just started are not.
   Every reader of "which session is this owner's chat" answers *none* until one
   of those refetches lands, and in that gap the optimistic patchers file the
   new conversation as ordinary work. The create response carries the row, so
   the client can stop answering wrongly immediately.
   ========================================================================= */
const CHAT: SessionSnapshot = {
  id: 's_minted',
  audience: { kind: 'workspace' },
  archive: { globalArchivedAt: null, personalArchivedAt: null, reason: null },
  permissions: {
    send: true,
    answer: true,
    interrupt: true,
    rename: true,
    manageAudience: false,
    personalArchive: true,
    globalArchive: true,
    delete: true,
  },
  workspaceId: 'w_1',
  turnStatus: 'running',
  bucket: 'running',
  title: 'Weekly check-in',
  titleOrigin: 'auto',
  titleStatus: 'complete',
  createdAt: 1,
  updatedAt: 2,
  lastEventSeq: 1,
  lastDeliveredInputSeq: 0,
  unread: false,
  agent: { id: 'a_1', name: 'UGC' },
} as SessionSnapshot

test('the minted chat reaches the alias its own panel opens on', () => {
  const queryClient = new QueryClient()

  stampDefaultChat(queryClient, 'acme', 'ugc', CHAT)

  expect(
    queryClient.getQueryData<SessionSnapshot>(
      duetQueryKeys.workspaces.sessions.default('acme', 'ugc'),
    )?.id,
  ).toBe('s_minted')
})

/* Keyed by agent id there, and addressed by slug above — the snapshot carries
   both, so nothing has to translate between them. */
test('the minted chat reaches the drive-wide read the map and the splicer use', () => {
  const queryClient = new QueryClient()
  queryClient.setQueryData<SessionActivityResponse>(
    duetQueryKeys.workspaces.sessions.activity('acme'),
    { owners: [{ agentId: 'a_1', sessions: [], truncated: false }] },
  )

  stampDefaultChat(queryClient, 'acme', 'ugc', CHAT)

  const owners = queryClient.getQueryData<SessionActivityResponse>(
    duetQueryKeys.workspaces.sessions.activity('acme'),
  )?.owners
  expect(owners?.[0]?.chat?.id).toBe('s_minted')
})

/* An owner nobody had anything for is not in that answer yet — the first
   message is what gives it something. */
test('an owner the drive-wide read has never mentioned is added, not dropped', () => {
  const queryClient = new QueryClient()
  queryClient.setQueryData<SessionActivityResponse>(
    duetQueryKeys.workspaces.sessions.activity('acme'),
    { owners: [] },
  )

  stampDefaultChat(queryClient, 'acme', 'ugc', CHAT)

  const owners = queryClient.getQueryData<SessionActivityResponse>(
    duetQueryKeys.workspaces.sessions.activity('acme'),
  )?.owners
  expect(owners).toEqual([{ agentId: 'a_1', sessions: [], truncated: false, chat: CHAT }])
})

/* The drive root is an owner like any face, and the one whose key is not an id. */
test('the drive root’s minted chat is filed under the reserved token', () => {
  const queryClient = new QueryClient()
  queryClient.setQueryData<SessionActivityResponse>(
    duetQueryKeys.workspaces.sessions.activity('acme'),
    { owners: [] },
  )
  const { agent: _agent, ...rootChat } = CHAT

  stampDefaultChat(queryClient, 'acme', ROOT_AGENT_SCOPE, rootChat as SessionSnapshot)

  expect(
    queryClient.getQueryData<SessionActivityResponse>(
      duetQueryKeys.workspaces.sessions.activity('acme'),
    )?.owners[0]?.agentId,
  ).toBe(ROOT_AGENT_SCOPE)
})
