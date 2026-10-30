import { describe, expect, test } from 'bun:test'

import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query'

import {
  projectActivitySessionSummary,
  projectSessionListItem,
  ROOT_AGENT_SCOPE,
} from '@repo/contract'
import type {
  SessionActivityResponse,
  SessionInitialHistorySnapshot,
  SessionListPage,
  SessionSnapshot,
  SessionSummary,
} from '@repo/contract'

import { duetQueryKeys } from '../api/query-keys'
import {
  commitSessionArchiveCache,
  commitRemovedSessionCache,
  commitSessionSummaryFields,
  findCachedSessionSummary,
  patchSessionChatPreviewCache,
  patchSessionSummaryCaches,
  refreshCreatedSessionCollections,
  rollbackSessionChatPreviewCache,
  seedCreatedSessionCache,
  type SessionChronologicalHistory,
} from './session-cache'

test('archive commits the server summary across projections and removes only active-to-archived rows', () => {
  const client = new QueryClient()
  const activeKey = sessionKeys.list(WS, { search: '', archived: 'exclude' })
  const archiveKey = sessionKeys.list(WS, { search: '', archived: 'only' })
  const initial = snapshot()
  for (const key of [activeKey, archiveKey]) {
    client.setQueryData(key, { pages: [{ items: [summary()], nextCursor: null }], pageParams: [] })
  }
  client.setQueryData(sessionKeys.detail(WS, 's_1'), initial)
  client.setQueryData(sessionKeys.activity(WS), {
    owners: [{ agentId: ROOT_AGENT_SCOPE, sessions: [summary()], truncated: false }],
  })
  client.setQueryData(sessionKeys.default(WS, 'root'), initial)

  const archived = summary({
    archive: { globalArchivedAt: 20, personalArchivedAt: 10, reason: 'global' },
  })
  commitSessionArchiveCache(client, WS, null, archived)

  expect(client.getQueryData<SessionSnapshot>(sessionKeys.detail(WS, 's_1'))?.archive).toEqual(
    archived.archive,
  )
  expect(client.getQueryData<SessionSnapshot>(sessionKeys.default(WS, 'root'))?.archive).toEqual(
    archived.archive,
  )
  expect(client.getQueryData<{ pages: SessionListPage[] }>(activeKey)?.pages[0]?.items).toEqual([])
  expect(client.getQueryData<SessionActivityResponse>(sessionKeys.activity(WS))?.owners).toEqual([])
})

test('an intermediate both-to-personal restore stays seated because it remains archived', () => {
  const client = new QueryClient()
  const archiveKey = sessionKeys.list(WS, { search: '', archived: 'only' })
  client.setQueryData(archiveKey, {
    pages: [{ items: [summary()], nextCursor: null }],
    pageParams: [],
  })
  const personal = summary({
    archive: { globalArchivedAt: null, personalArchivedAt: 10, reason: 'personal' },
  })

  commitSessionArchiveCache(client, WS, 'global', personal)

  expect(
    client.getQueryData<{ pages: SessionListPage[] }>(archiveKey)?.pages[0]?.items[0]?.archive,
  ).toEqual(personal.archive)
})

const sessionKeys = duetQueryKeys.workspaces.sessions
const WS = 'acme'

test('a created job replaces an unanswered pre-create collection read', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const key = sessionKeys.list(WS, {
    search: '',
    archived: 'exclude',
    bucket: 'running',
    agentId: ROOT_AGENT_SCOPE,
    excludeDefault: true,
  })
  let calls = 0
  let releaseFirst!: () => void
  let startedFirst!: () => void
  const firstStarted = new Promise<void>(resolve => {
    startedFirst = resolve
  })
  const firstRelease = new Promise<void>(resolve => {
    releaseFirst = resolve
  })
  const observer = new InfiniteQueryObserver(client, {
    queryKey: key,
    queryFn: async () => {
      calls += 1
      if (calls === 1) {
        startedFirst()
        await firstRelease
      }
      return {
        items: [projectSessionListItem(summary({ id: calls === 1 ? 'old' : 'created' }))],
        nextCursor: null,
      }
    },
    initialPageParam: undefined,
    getNextPageParam: page => page.nextCursor,
  })
  const unsubscribe = observer.subscribe(() => {})
  await firstStarted

  const refresh = refreshCreatedSessionCollections(client, WS)
  releaseFirst()
  await refresh

  const cached = client.getQueryData<{ pages: SessionListPage[] }>(key)
  expect(cached?.pages[0]?.items.map(item => item.id)).toEqual(['created'])
  expect(calls).toBe(2)
  unsubscribe()
})

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's_1',
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
    turnStatus: 'complete',
    bucket: 'done',
    title: 'Reconcile Q3',
    titleOrigin: 'auto',
    titleStatus: 'complete',
    createdAt: 1_000,
    updatedAt: 2_000,
    lastEventSeq: 7,
    unread: true,
    ...overrides,
  }
}

test('a summary patch leaves non-list session caches intact', () => {
  const client = new QueryClient()
  const listKey = sessionKeys.list(WS, { search: '', archived: 'exclude' })
  const presenceKey = sessionKeys.workConversationPresence(WS, ['agent-1:all:s_1@2000'])
  const presence = { visibleOwnerIds: ['agent-1'], failedOwnerIds: [] }
  client.setQueryData(listKey, {
    pages: [{ items: [projectSessionListItem(summary())], nextCursor: null }],
    pageParams: [undefined],
  })
  client.setQueryData(presenceKey, presence)

  expect(() =>
    commitSessionSummaryFields(client, WS, summary({ unread: false }), ['unread']),
  ).not.toThrow()

  expect(
    client.getQueryData<{ pages: SessionListPage[] }>(listKey)?.pages[0]?.items[0]?.unread,
  ).toBe(false)
  expect(client.getQueryData<typeof presence>(presenceKey)).toEqual(presence)
})

test('a summary patch tolerates persisted non-list data under the list prefix', () => {
  const client = new QueryClient()
  const persistedPresenceKey = [
    ...sessionKeys.lists(WS),
    'work-conversation-presence',
    ['agent-1:all:s_1@2000'],
  ] as const
  const presence = { visibleOwnerIds: ['agent-1'], failedOwnerIds: [] }
  client.setQueryData(persistedPresenceKey, presence)

  expect(findCachedSessionSummary(client, WS, 'missing')).toBeUndefined()
  expect(() =>
    commitSessionSummaryFields(client, WS, summary({ unread: false }), ['unread']),
  ).not.toThrow()
  expect(client.getQueryData<typeof presence>(persistedPresenceKey)).toEqual(presence)
})

test('a full detail frame stays bounded when it patches a known list row', () => {
  const client = new QueryClient()
  const key = sessionKeys.list(WS, { search: '', archived: 'exclude' })
  const initial = summary({
    machine: { orderedPath: [], activity: 'running', currentState: 'old' },
  })
  client.setQueryData(key, {
    pages: [{ items: [projectSessionListItem(initial)], nextCursor: null }],
    pageParams: [undefined],
  })

  patchSessionSummaryCaches(client, WS, {
    ...initial,
    machine: {
      definitionName: 'large definition',
      currentState: '🚀'.repeat(200),
      orderedPath: [
        { key: 'large-definition', index: 0, name: 'large definition', phase: 'current' },
      ],
      activity: 'running',
    },
  })

  const row = client.getQueryData<{ pages: SessionListPage[] }>(key)?.pages[0]?.items[0]
  expect(row?.machine?.step).toBe('🚀'.repeat(120))
  expect('orderedPath' in (row?.machine ?? {})).toBe(false)
})

function snapshot(overrides: Partial<SessionSummary> = {}): SessionSnapshot {
  return { ...summary(overrides), workspaceId: 'w_1', lastDeliveredInputSeq: 0 }
}

test('a stale creation snapshot cannot replace a generated sidebar title', () => {
  const client = new QueryClient()
  const key = sessionKeys.list(WS, { search: '', archived: 'exclude' })
  const generated = summary({
    title: 'Diagnose checkout latency',
    titleOrigin: 'auto',
    titleStatus: 'complete',
    updatedAt: 3_000,
  })
  client.setQueryData(sessionKeys.detail(WS, generated.id), snapshot(generated))
  client.setQueryData(key, {
    pages: [{ items: [projectSessionListItem(generated)], nextCursor: null }],
    pageParams: [undefined],
  })

  patchSessionSummaryCaches(
    client,
    WS,
    summary({
      title: 'Please investigate why checkout has become slow',
      titleOrigin: 'excerpt',
      titleStatus: 'generating',
      turnStatus: 'running',
      updatedAt: 4_000,
    }),
  )

  expect(client.getQueryData<SessionSnapshot>(sessionKeys.detail(WS, generated.id))).toMatchObject({
    title: 'Diagnose checkout latency',
    titleOrigin: 'auto',
    titleStatus: 'complete',
    turnStatus: 'running',
    updatedAt: 4_000,
  })
  expect(client.getQueryData<{ pages: SessionListPage[] }>(key)?.pages[0]?.items[0]).toMatchObject({
    title: 'Diagnose checkout latency',
    titleOrigin: 'auto',
    titleStatus: 'complete',
    turnStatus: 'running',
    updatedAt: 4_000,
  })
})

/**
 * The map's feed and the default-chat alias both carry `unread`, and both sit
 * outside `sessionKeys.lists()` by design. Reading a session has to reach them
 * anyway — the numeral the reader clears by looking is drawn from these two.
 */
describe('commitSessionSummaryFields reaches every family that draws unread', () => {
  test('activity rows never stand in for full detail', () => {
    const client = new QueryClient()
    client.setQueryData<SessionActivityResponse>(sessionKeys.activity(WS), {
      owners: [
        {
          agentId: 'a_1',
          sessions: [
            { id: 's_1', title: 'Thin row', bucket: 'running', updatedAt: 2, unread: false },
          ],
          truncated: false,
        },
      ],
    })

    expect(findCachedSessionSummary(client, WS, 's_1')).toBeUndefined()
  })

  test('full-detail cache patches merge only activity-owned fields', () => {
    const client = new QueryClient()
    client.setQueryData<SessionActivityResponse>(sessionKeys.activity(WS), {
      owners: [
        {
          agentId: 'a_1',
          sessions: [
            {
              id: 's_1',
              title: 'Old',
              bucket: 'running',
              updatedAt: 2,
              unread: true,
              machine: { step: 'Stale', activity: 'running' },
            },
          ],
          truncated: false,
        },
      ],
    })

    patchSessionSummaryCaches(client, WS, summary({ title: 'New' }))

    const row = client.getQueryData<SessionActivityResponse>(sessionKeys.activity(WS))!.owners[0]!
      .sessions[0]!
    expect(row.title).toBe('New')
    expect(Object.keys(row).sort()).toEqual(['bucket', 'id', 'title', 'unread', 'updatedAt'])
  })

  test('clears unread in the activity feed', () => {
    const client = new QueryClient()
    const activity: SessionActivityResponse = {
      owners: [{ agentId: 'a_1', sessions: [summary()], truncated: false }],
    }
    client.setQueryData(sessionKeys.activity(WS), activity)

    commitSessionSummaryFields(client, WS, summary({ unread: false }), ['unread'])

    const next = client.getQueryData<SessionActivityResponse>(sessionKeys.activity(WS))
    expect(next?.owners[0]?.sessions[0]?.unread).toBe(false)
  })

  test('a null default-chat entry — no chat yet — is left alone, not read', () => {
    const client = new QueryClient()
    client.setQueryData(sessionKeys.default(WS, 'ops'), null)

    commitSessionSummaryFields(client, WS, summary({ unread: false }), ['unread'])

    expect(client.getQueryData(sessionKeys.default(WS, 'ops'))).toBeNull()
  })

  test('clears unread in the default-chat entry', () => {
    const client = new QueryClient()
    client.setQueryData(sessionKeys.default(WS, 'ops'), snapshot())

    commitSessionSummaryFields(client, WS, summary({ unread: false }), ['unread'])

    expect(client.getQueryData<SessionSnapshot>(sessionKeys.default(WS, 'ops'))?.unread).toBe(false)
  })

  /**
   * Reading must not move the row. `updatedAt` is deliberately not among the
   * fields a read commits — every list ordered by recency would reshuffle the
   * instant somebody looked — and that invariant has to survive into the two
   * families above, not just the ones it was written for.
   */
  test('does not move the row it clears', () => {
    const client = new QueryClient()
    const activity: SessionActivityResponse = {
      owners: [{ agentId: 'a_1', sessions: [summary()], truncated: false }],
    }
    client.setQueryData(sessionKeys.activity(WS), activity)

    commitSessionSummaryFields(client, WS, summary({ unread: false, updatedAt: 9_999 }), ['unread'])

    const next = client.getQueryData<SessionActivityResponse>(sessionKeys.activity(WS))
    expect(next?.owners[0]?.sessions[0]?.updatedAt).toBe(2_000)
  })

  /** A session this reader has not got cached anywhere must not mint an entry. */
  test('leaves an absent entry absent', () => {
    const client = new QueryClient()

    commitSessionSummaryFields(client, WS, summary({ unread: false }), ['unread'])

    expect(client.getQueryData(sessionKeys.activity(WS))).toBeUndefined()
    expect(client.getQueryData(sessionKeys.default(WS, 'ops'))).toBeUndefined()
  })
})

test('a session becoming active immediately enters the workspace activity view', () => {
  const client = new QueryClient()
  client.setQueryData<SessionActivityResponse>(sessionKeys.activity(WS), { owners: [] })
  const running = summary({
    agent: { id: 'a_1', name: 'Research' },
    turnStatus: 'running',
    updatedAt: 3_000,
  })

  patchSessionSummaryCaches(client, WS, running)

  expect(client.getQueryData<SessionActivityResponse>(sessionKeys.activity(WS))).toEqual({
    owners: [
      {
        agentId: 'a_1',
        sessions: [projectActivitySessionSummary(running)],
        truncated: false,
      },
    ],
  })
})

test('a session that finishes stays in the workspace activity view as completed history', () => {
  const client = new QueryClient()
  const running = summary({
    agent: { id: 'a_1', name: 'Research' },
    turnStatus: 'running',
    bucket: 'running',
    updatedAt: 2_000,
  })
  client.setQueryData<SessionActivityResponse>(sessionKeys.activity(WS), {
    owners: [{ agentId: 'a_1', sessions: [running], truncated: false }],
  })

  patchSessionSummaryCaches(
    client,
    WS,
    summary({
      agent: { id: 'a_1', name: 'Research' },
      turnStatus: 'complete',
      bucket: 'done',
      updatedAt: 3_000,
    }),
  )

  expect(
    client
      .getQueryData<SessionActivityResponse>(sessionKeys.activity(WS))
      ?.owners[0]?.sessions.map(session => [session.id, session.bucket]),
  ).toEqual([['s_1', 'done']])
})

/* List membership belongs to the server. Patching a summary changes a known
   row; alias or activity knowledge never admits an unseen row into a list. */
describe('list patches preserve server-owned membership', () => {
  const jobsKey = sessionKeys.list(WS, {
    search: '',
    archived: 'exclude',
    bucket: 'running',
    agentId: 'a_1',
    excludeDefault: true,
  })
  const chat = summary({
    id: 's_chat',
    agent: { id: 'a_1', name: 'UGC Content' },
    bucket: 'running',
    turnStatus: 'running',
    updatedAt: 3_000,
  })
  const work = summary({
    id: 's_job',
    agent: { id: 'a_1', name: 'UGC Content' },
    bucket: 'running',
    turnStatus: 'running',
    updatedAt: 1_000,
  })

  function client(): QueryClient {
    const queryClient = new QueryClient()
    queryClient.setQueryData(sessionKeys.default(WS, 'ugc-content'), snapshot({ id: 's_chat' }))
    queryClient.setQueryData(jobsKey, {
      pages: [{ items: [work], nextCursor: null }],
      pageParams: [undefined],
    })
    return queryClient
  }

  function listed(queryClient: QueryClient): string[] {
    const data = queryClient.getQueryData<{ pages: { items: SessionSummary[] }[] }>(jobsKey)
    return (data?.pages ?? []).flatMap(page => page.items).map(session => session.id)
  }

  test('a frame from the default chat does not splice it into the work list', () => {
    const queryClient = client()

    patchSessionSummaryCaches(queryClient, WS, { ...snapshot({ id: 's_chat' }), ...chat })

    expect(listed(queryClient)).toEqual(['s_job'])
  })

  test('an unseen chat is not inserted into an agent list without excludeDefault', () => {
    const queryClient = client()
    const plainKey = sessionKeys.list(WS, { search: '', archived: 'exclude', agentId: 'a_1' })
    queryClient.setQueryData(plainKey, {
      pages: [{ items: [work], nextCursor: null }],
      pageParams: [undefined],
    })

    patchSessionSummaryCaches(queryClient, WS, { ...snapshot({ id: 's_chat' }), ...chat })

    const data = queryClient.getQueryData<{ pages: { items: SessionSummary[] }[] }>(plainKey)
    expect((data?.pages ?? []).flatMap(page => page.items).map(session => session.id)).toEqual([
      's_job',
    ])
  })

  test('a null default alias does not admit an unseen row into a work list', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(sessionKeys.default(WS, 'ugc-content'), null)
    queryClient.setQueryData(jobsKey, {
      pages: [{ items: [work], nextCursor: null }],
      pageParams: [undefined],
    })

    patchSessionSummaryCaches(queryClient, WS, { ...snapshot({ id: 's_chat' }), ...chat })

    expect(listed(queryClient)).toEqual(['s_job'])
  })

  test("the drive root's own chat is withheld from the drive's work", () => {
    const queryClient = new QueryClient()
    const rootKey = sessionKeys.list(WS, {
      search: '',
      archived: 'exclude',
      bucket: 'running',
      agentId: ROOT_AGENT_SCOPE,
      excludeDefault: true,
    })
    queryClient.setQueryData(
      sessionKeys.default(WS, ROOT_AGENT_SCOPE),
      snapshot({ id: 's_root_chat' }),
    )
    queryClient.setQueryData(rootKey, {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [undefined],
    })

    patchSessionSummaryCaches(queryClient, WS, {
      ...snapshot({ id: 's_root_chat' }),
      ...summary({ id: 's_root_chat', bucket: 'running', turnStatus: 'running' }),
    })

    const data = queryClient.getQueryData<{ pages: { items: SessionSummary[] }[] }>(rootKey)
    expect((data?.pages ?? []).flatMap(page => page.items).map(session => session.id)).toEqual([])
  })

  test('clearing unread patches a known row without re-deciding list membership', () => {
    const queryClient = client()
    queryClient.setQueryData(jobsKey, {
      pages: [{ items: [chat, work], nextCursor: null }],
      pageParams: [undefined],
    })

    commitSessionSummaryFields(queryClient, WS, summary({ id: 's_chat', unread: false }), [
      'unread',
    ])

    expect(listed(queryClient)).toEqual(['s_chat', 's_job'])
  })

  test('an unseen ordinary job is not inserted into a loaded work list', () => {
    const queryClient = client()

    patchSessionSummaryCaches(queryClient, WS, {
      ...snapshot({ id: 's_other' }),
      ...summary({
        id: 's_other',
        agent: { id: 'a_1', name: 'UGC Content' },
        bucket: 'running',
        turnStatus: 'running',
        updatedAt: 4_000,
      }),
    })

    expect(listed(queryClient)).toEqual(['s_job'])
  })
})

test('activity knowledge does not admit an unseen chat into a loaded work list', () => {
  const queryClient = new QueryClient()
  const key = sessionKeys.list(WS, {
    search: '',
    archived: 'exclude',
    bucket: 'running',
    agentId: 'a_1',
    excludeDefault: true,
  })
  const chat = summary({ id: 's_chat', agent: { id: 'a_1', name: 'UGC' }, bucket: 'running' })
  queryClient.setQueryData<SessionActivityResponse>(sessionKeys.activity(WS), {
    owners: [{ agentId: 'a_1', sessions: [], truncated: false, chat }],
  })
  queryClient.setQueryData(key, {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [undefined],
  })

  patchSessionSummaryCaches(queryClient, WS, { ...snapshot({ id: 's_chat' }), ...chat })

  const data = queryClient.getQueryData<{ pages: { items: SessionSummary[] }[] }>(key)
  expect((data?.pages ?? []).flatMap(page => page.items).map(session => session.id)).toEqual([])
})

/* ============================================================================
   The other writer into the activity cache.

   `patchSessionListCaches` is not the only door: every durable frame also
   reconciles the map's own read, and that read now holds two different things
   per owner — the work it did, and the conversation it is. A reconciler that
   knew only `sessions` put the chat back among the work on the first frame of
   the conversation the reader was having, which is a job bead on the face
   beside it and a numeral that counts a chat as a job.
   ========================================================================= */
describe('the map’s read keeps the chat out of the work', () => {
  const chat = summary({ id: 's_chat', agent: { id: 'a_1', name: 'UGC' }, bucket: 'running' })
  const work = summary({ id: 's_job', agent: { id: 'a_1', name: 'UGC' }, bucket: 'running' })

  function activity(client: QueryClient, owners: SessionActivityResponse['owners']): void {
    client.setQueryData<SessionActivityResponse>(sessionKeys.activity(WS), { owners })
  }
  const read = (client: QueryClient) =>
    client.getQueryData<SessionActivityResponse>(sessionKeys.activity(WS))

  test('a frame from the chat patches the chat, and seats nothing', () => {
    const client = new QueryClient()
    activity(client, [{ agentId: 'a_1', sessions: [work], truncated: false, chat }])

    patchSessionSummaryCaches(client, WS, {
      ...snapshot({ id: 's_chat' }),
      ...chat,
      turnStatus: 'complete',
      bucket: 'done',
    })

    const owner = read(client)?.owners[0]
    expect(owner?.sessions.map(session => session.id)).toEqual(['s_job'])
    expect(owner?.chat?.id).toBe('s_chat')
    expect(owner?.chat?.bucket).toBe('done')
  })

  /* Lifecycle summaries carry no preview opinion. Replacing the chat wholesale
     would erase whichever preview owner wrote last — a durable event or an
     optimistic input — until the next activity read repairs it. */
  test('a client-authored frame carries no preview, and does not erase the one there', () => {
    const client = new QueryClient()
    const previewed = {
      ...chat,
      preview: { text: 'ship the lander', author: { kind: 'user', userId: 'u_1' } as const },
    }
    activity(client, [{ agentId: 'a_1', sessions: [], truncated: false, chat: previewed }])

    patchSessionSummaryCaches(client, WS, {
      ...snapshot({ id: 's_chat' }),
      ...chat,
      turnStatus: 'complete',
      bucket: 'done',
    })

    const owner = read(client)?.owners[0]
    expect(owner?.chat?.bucket).toBe('done')
    expect(owner?.chat?.preview).toEqual({
      text: 'ship the lander',
      author: { kind: 'user', userId: 'u_1' },
    })
  })

  test('an optimistic input replaces the chat row preview immediately', () => {
    const client = new QueryClient()
    const previous = {
      text: 'The deploy is green.',
      author: { kind: 'agent' as const },
    }
    const optimistic = {
      text: 'Ship the landing page now.',
      author: { kind: 'user' as const, userId: 'u_1' },
    }
    activity(client, [
      {
        agentId: 'a_1',
        sessions: [],
        truncated: false,
        chat: { ...chat, preview: previous },
      },
    ])

    patchSessionChatPreviewCache(client, WS, chat.id, optimistic)

    expect(read(client)?.owners[0]?.chat).toEqual({ ...chat, preview: optimistic })
  })

  test('a rejected optimistic input restores the preceding chat preview', () => {
    const client = new QueryClient()
    const previous = {
      text: 'The deploy is green.',
      author: { kind: 'agent' as const },
    }
    const optimistic = {
      text: 'Ship the landing page now.',
      author: { kind: 'user' as const, userId: 'u_1' },
    }
    activity(client, [
      {
        agentId: 'a_1',
        sessions: [],
        truncated: false,
        chat: { ...chat, preview: previous },
      },
    ])

    const captured = patchSessionChatPreviewCache(client, WS, chat.id, optimistic)
    rollbackSessionChatPreviewCache(client, WS, chat.id, captured, optimistic)

    expect(read(client)?.owners[0]?.chat?.preview).toEqual(previous)
  })

  test('a rejected optimistic input cannot erase a newer chat preview', () => {
    const client = new QueryClient()
    const previous = {
      text: 'The deploy is green.',
      author: { kind: 'agent' as const },
    }
    const optimistic = {
      text: 'Ship the landing page now.',
      author: { kind: 'user' as const, userId: 'u_1' },
    }
    const newer = {
      text: 'It is already live.',
      author: { kind: 'agent' as const },
    }
    activity(client, [
      {
        agentId: 'a_1',
        sessions: [],
        truncated: false,
        chat: { ...chat, preview: previous },
      },
    ])

    const captured = patchSessionChatPreviewCache(client, WS, chat.id, optimistic)
    patchSessionChatPreviewCache(client, WS, chat.id, newer)
    rollbackSessionChatPreviewCache(client, WS, chat.id, captured, optimistic)

    expect(read(client)?.owners[0]?.chat?.preview).toEqual(newer)
  })

  /* The server emits owners whose only session is their chat. Any frame of any
     unrelated session used to delete them from this cache. */
  test('an owner whose only session is its chat survives an unrelated frame', () => {
    const client = new QueryClient()
    activity(client, [{ agentId: 'a_1', sessions: [], truncated: false, chat }])

    patchSessionSummaryCaches(client, WS, {
      ...snapshot({ id: 's_other' }),
      ...summary({ id: 's_other', agent: { id: 'a_2', name: 'Other' }, bucket: 'running' }),
    })

    expect(read(client)?.owners.find(owner => owner.agentId === 'a_1')?.chat?.id).toBe('s_chat')
  })

  /* The mark the ring draws lives on the chat now, so the read stamp has to
     reach it — a dot left lit on the conversation you are looking at is the one
     thing a read stamp exists to prevent. */
  test('reading the chat clears the mark the face draws', () => {
    const client = new QueryClient()
    activity(client, [
      { agentId: 'a_1', sessions: [], truncated: false, chat: { ...chat, unread: true } },
    ])

    commitSessionSummaryFields(client, WS, summary({ id: 's_chat', unread: false }), ['unread'])

    expect(read(client)?.owners[0]?.chat?.unread).toBe(false)
  })

  /* The shared contract rule, on the half that also has to obey it. Every frame
     through this door is client-authored from the preceding snapshot, so it
     arrives carrying the *preceding* bucket and this projection is what makes it
     current. Applied to the work and not to the chat, a conversation that just
     finished goes on drawing itself as running on the face. */
  test('a chat frame is bucketed by the contract rule, not by what it arrived with', () => {
    const client = new QueryClient()
    activity(client, [{ agentId: 'a_1', sessions: [], truncated: false, chat }])

    patchSessionSummaryCaches(client, WS, {
      ...snapshot({ id: 's_chat' }),
      ...chat,
      // what a streamed frame looks like: the new status, the old bucket
      turnStatus: 'complete',
      bucket: 'running',
    })

    expect(read(client)?.owners[0]?.chat?.bucket).toBe('done')
  })

  /* The server owns whether the deleted row was still the default. Evict both
     projections so their next reads receive that answer; never synthesize a
     replacement pointer in the browser. */
  test('deleting the chat evicts the face and default projections', () => {
    const client = new QueryClient()
    activity(client, [{ agentId: 'a_1', sessions: [work], truncated: false, chat }])
    client.setQueryData(sessionKeys.default(WS, 'ugc'), snapshot({ id: 's_chat' }))

    commitRemovedSessionCache(client, WS, 's_chat')

    expect(read(client)).toBeUndefined()
    expect(client.getQueryData(sessionKeys.default(WS, 'ugc'))).toBeUndefined()
  })

  /* And work is still work: the reconciler's ordinary path must not be narrowed
     by the branch above it. */
  test('a frame from an ordinary job still reaches the work', () => {
    const client = new QueryClient()
    activity(client, [{ agentId: 'a_1', sessions: [work], truncated: false, chat }])

    patchSessionSummaryCaches(client, WS, {
      ...snapshot({ id: 's_job' }),
      ...work,
      turnStatus: 'complete',
      bucket: 'done',
    })

    const owner = read(client)?.owners[0]
    expect(owner?.sessions.map(session => [session.id, session.bucket])).toEqual([
      ['s_job', 'done'],
    ])
    expect(owner?.chat?.id).toBe('s_chat')
  })
})

test('disagreeing default and activity aliases do not admit an unseen row', () => {
  const queryClient = new QueryClient()
  const key = sessionKeys.list(WS, {
    search: '',
    archived: 'exclude',
    bucket: 'running',
    agentId: 'a_1',
    excludeDefault: true,
  })
  const demoted = summary({
    id: 's_was_chat',
    agent: { id: 'a_1', name: 'UGC' },
    bucket: 'running',
  })
  queryClient.setQueryData<SessionActivityResponse>(sessionKeys.activity(WS), {
    owners: [{ agentId: 'a_1', sessions: [], truncated: false, chat: demoted }],
  })
  queryClient.setQueryData(sessionKeys.default(WS, 'ugc'), snapshot({ id: 's_new_chat' }))
  queryClient.setQueryData(key, {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [undefined],
  })

  patchSessionSummaryCaches(queryClient, WS, { ...snapshot({ id: 's_was_chat' }), ...demoted })

  const data = queryClient.getQueryData<{ pages: { items: SessionSummary[] }[] }>(key)
  expect((data?.pages ?? []).flatMap(page => page.items).map(session => session.id)).toEqual([])
})

/* ============================================================================
   What a create response is worth.

   The server has just written the session and its first events, and says so in
   the reply. The surface that opens on it next is a different mount — the
   address changed — so anything it has to ask for again is a skeleton on the
   screen where the reader just pressed Send.
   ========================================================================= */
describe('a created session arrives with its conversation', () => {
  const created = snapshot({ id: 's_new', title: 'Audit the checkout funnel' })
  const history: SessionInitialHistorySnapshot = {
    events: [
      {
        seq: 1,
        createdAt: 1_000,
        event: {
          type: 'session_created',
          prompt: 'Audit it',
          createdAt: '1970-01-01T00:00:01.000Z',
        },
      },
    ],
  }

  test('stores the create response snapshot under its detail key', () => {
    const client = new QueryClient()

    seedCreatedSessionCache(client, WS, created, history)

    expect(client.getQueryData<SessionSnapshot>(sessionKeys.detail(WS, 's_new'))).toEqual(created)
  })

  test('stores the create response events with exhausted chronological history metadata', () => {
    const client = new QueryClient()

    seedCreatedSessionCache(client, WS, created, history)

    expect(
      client.getQueryData<SessionChronologicalHistory>(sessionKeys.history(WS, 's_new')),
    ).toEqual({
      events: history.events,
      nextCursor: null,
      pagedThroughSeq: 1,
    })
  })
})
