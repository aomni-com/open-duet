import { describe, expect, test } from 'bun:test'

import { InfiniteQueryObserver, QueryClient, QueryObserver } from '@tanstack/react-query'

import {
  ROOT_AGENT_SCOPE,
  appForCwd,
  bucketOf,
  type App,
  type SessionActivityResponse,
  type SessionSnapshot,
  type SessionInputSender,
  type SessionSummary,
} from '@repo/contract'

import type { SessionListKeyFilters } from '../api/query-keys'
import {
  createIncrementalSessionProjector,
  projectSession,
  type SessionEphemeralFrame,
} from './projection'
import { TRANSCRIPT_SNAPSHOT } from './projection/fixtures'
import {
  cancelSessionOptimisticQueries,
  commitRemovedSessionCache,
  commitSessionSummaryFields,
  mergeSessionHistory,
  prependOlderSessionHistory,
  patchSessionListCaches,
  patchSessionSummaryCaches,
  rollbackSessionDetailFields,
  type SessionChronologicalHistory,
} from './session-cache'
import {
  appendDurableFrame,
  createSessionDetailRefreshSignal,
  commitSessionAudienceUpdateCache,
  durableSessionInputExists,
  ownSessionCursor,
  pendingSessionInputFrames,
  reconcileEphemeralFrames,
  reconcileSessionSnapshot,
  sessionQueryOptions,
  sessionKeys,
  sessionReconnectDelay,
  shouldOpenSessionStream,
} from './session-data'

const VIEWER_SENDER = { kind: 'user', userId: 'user_1' } as const satisfies SessionInputSender

test('a top-level session list forwards its collection boundary to the API', async () => {
  const requests: Array<Record<string, unknown>> = []
  const api = {
    listSessions: async (_workspaceSlug: string, request: Record<string, unknown>) => {
      requests.push(request)
      return { items: [], nextCursor: null }
    },
  } as unknown as Parameters<typeof sessionQueryOptions.list>[0]
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const observer = new InfiniteQueryObserver(
    queryClient,
    sessionQueryOptions.list(api, 'acme', {
      search: '',
      archived: 'exclude',
      topLevel: true,
    }),
  )
  const unsubscribe = observer.subscribe(() => {})

  await observer.refetch()

  expect(requests).toEqual([
    {
      cursor: undefined,
      limit: 30,
      search: undefined,
      bucket: undefined,
      archived: 'exclude',
      agentId: undefined,
      excludeDefault: undefined,
      topLevel: true,
    },
  ])
  unsubscribe()
})

test('direct session children retain page one while requesting the continuation cursor', async () => {
  const requests: Array<Record<string, unknown>> = []
  const api = {
    listSessionChildren: async (
      _workspaceSlug: string,
      _sessionId: string,
      request: Record<string, unknown>,
    ) => {
      requests.push(request)
      return request.cursor === undefined
        ? { items: [summary({ id: 'child_1' })], nextCursor: 'children-next' }
        : { items: [summary({ id: 'child_2' })], nextCursor: null }
    },
  } as unknown as Parameters<typeof sessionQueryOptions.children>[0]
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const observer = new InfiniteQueryObserver(
    queryClient,
    sessionQueryOptions.children(
      api,
      'acme',
      'parent_1',
      { bucket: 'running', archived: 'exclude' },
      12,
    ),
  )
  const unsubscribe = observer.subscribe(() => {})

  await observer.refetch()
  await observer.fetchNextPage()

  expect(requests).toEqual([
    { cursor: undefined, limit: 12, bucket: 'running', archived: 'exclude' },
    { cursor: 'children-next', limit: 12, bucket: 'running', archived: 'exclude' },
  ])
  expect(
    observer.getCurrentResult().data?.pages.map(page => page.items.map(item => item.id)),
  ).toEqual([['child_1'], ['child_2']])
  unsubscribe()
})

test('an audience update invalidates list membership after patching its summary', () => {
  const queryClient = new QueryClient()
  const filters = { search: '', archived: 'exclude' as const }
  const key = sessionKeys.list('acme', filters)
  queryClient.setQueryData(key, {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [undefined],
  })

  commitSessionAudienceUpdateCache(
    queryClient,
    'acme',
    'session_1',
    summary({
      id: 'session_1',
      archive: { globalArchivedAt: 2, personalArchivedAt: null, reason: 'global' },
    }),
  )

  expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
})

test('a 200 audience update atomically replaces audience, permissions, and archive everywhere', () => {
  const queryClient = new QueryClient()
  const current = summary({ id: 'session_1' })
  const filters = { search: '', archived: 'exclude' as const }
  const snapshot = { ...current, workspaceId: 'workspace_1', lastDeliveredInputSeq: 0 }
  queryClient.setQueryData(sessionKeys.detail('acme', current.id), snapshot)
  queryClient.setQueryData(sessionKeys.default('acme', 'research'), snapshot)
  queryClient.setQueryData(sessionKeys.list('acme', filters), {
    pages: [{ items: [current], nextCursor: null }],
    pageParams: [undefined],
  })
  const updated = summary({
    id: current.id,
    audience: {
      kind: 'specific',
      count: 1,
      preview: [
        {
          memberId: 'membership_1',
          userId: 'user_1',
          name: 'Ada',
          email: 'ada@example.com',
          role: 'viewer',
        },
      ],
    },
    permissions: { ...current.permissions, manageAudience: true, globalArchive: false },
    archive: { globalArchivedAt: null, personalArchivedAt: 3, reason: 'personal' },
  })

  commitSessionAudienceUpdateCache(queryClient, 'acme', current.id, updated)

  for (const cached of [
    queryClient.getQueryData<SessionSnapshot>(sessionKeys.detail('acme', current.id)),
    queryClient.getQueryData<SessionSnapshot>(sessionKeys.default('acme', 'research')),
    queryClient.getQueryData<{ pages: Array<{ items: SessionSummary[] }> }>(
      sessionKeys.list('acme', filters),
    )?.pages[0]?.items[0],
  ]) {
    expect(cached).toMatchObject({
      audience: updated.audience,
      permissions: updated.permissions,
      archive: updated.archive,
    })
  }
})

test('a 200 final-audience archive removes the session from active list caches immediately', () => {
  const queryClient = new QueryClient()
  const activeKey = sessionKeys.list('acme', { search: '', archived: 'exclude' })
  const archivedKey = sessionKeys.list('acme', { search: '', archived: 'only' })
  const current = summary({ id: 'session_1' })
  queryClient.setQueryData(activeKey, {
    pages: [{ items: [current], nextCursor: null }],
    pageParams: [undefined],
  })
  queryClient.setQueryData(archivedKey, {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [undefined],
  })

  commitSessionAudienceUpdateCache(
    queryClient,
    'acme',
    'session_1',
    summary({
      id: 'session_1',
      audience: { kind: 'specific', count: 0, preview: [] },
      archive: { globalArchivedAt: 2, personalArchivedAt: null, reason: 'global' },
    }),
  )

  expect(
    queryClient.getQueryData<{ pages: Array<{ items: SessionSummary[] }> }>(activeKey)?.pages[0]
      ?.items,
  ).toEqual([])
  expect(
    queryClient.getQueryData<{ pages: Array<{ items: SessionSummary[] }> }>(archivedKey)?.pages[0]
      ?.items,
  ).toEqual([])
})

test('the shared session-removal transition evicts loaded audience pages', () => {
  const queryClient = new QueryClient()
  const key = sessionKeys.audience('acme', 'session_1')
  queryClient.setQueryData(key, {
    pages: [{ items: [{ userId: 'user_1' }], nextCursor: null }],
    pageParams: [undefined],
  })

  commitRemovedSessionCache(queryClient, 'acme', 'session_1')

  expect(queryClient.getQueryData(key)).toBeUndefined()
})

describe('session title polling', () => {
  const api = {} as Parameters<typeof sessionQueryOptions.detail>[0]
  const intervalsFor = (session: SessionSummary) => {
    const listInterval = sessionQueryOptions.list(api, 'acme', {
      search: '',
      archived: 'exclude',
    }).refetchInterval
    const detailInterval = sessionQueryOptions.detail(api, 'acme', session.id).refetchInterval
    if (typeof listInterval !== 'function' || typeof detailInterval !== 'function') {
      throw new Error('session query polling must be data-dependent')
    }
    return [
      listInterval({
        state: { data: { pages: [{ items: [session], nextCursor: null }] } },
      } as never),
      detailInterval({ state: { data: session } } as never),
    ]
  }

  test('list and detail share the same title age and terminal policy', () => {
    expect(intervalsFor(summary({ titleStatus: 'generating', createdAt: Date.now() }))).toEqual([
      1_000, 1_000,
    ])
    expect(intervalsFor(summary({ titleStatus: 'generating', createdAt: 0 }))).toEqual([
      false,
      false,
    ])
    expect(intervalsFor(summary({ titleStatus: 'complete', createdAt: Date.now() }))).toEqual([
      false,
      false,
    ])
  })

  /* The live stream is the fast path, not the only path: a snapshot that
     claims a live turn has to be re-read on its own clock, or a dropped stream
     freezes "working" on screen for good. */
  test('the detail interval policy keeps running turns eligible for fallback reads', () => {
    expect(intervalsFor(summary({ turnStatus: 'running' }))).toEqual([false, 5_000])
    expect(intervalsFor(summary({ turnStatus: 'complete' }))).toEqual([false, false])
  })
})

describe('session cache projection', () => {
  test('opening an activity row fetches its full detail contract', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData<SessionActivityResponse>(sessionKeys.activity('acme'), {
      owners: [
        {
          agentId: 'a_1',
          sessions: [
            { id: 'session_1', title: 'Thin', bucket: 'running', updatedAt: 2, unread: false },
          ],
          truncated: false,
        },
      ],
    })
    const full: SessionSnapshot = {
      ...summary({ id: 'session_1' }),
      workspaceId: 'workspace_1',
      lastDeliveredInputSeq: 0,
    }
    let reads = 0
    const api = {
      getSession: async () => {
        reads += 1
        return full
      },
    } as unknown as Parameters<typeof sessionQueryOptions.detail>[0]

    const opened = await queryClient.fetchQuery(
      sessionQueryOptions.detail(api, 'acme', 'session_1'),
    )

    expect(reads).toBe(1)
    expect(opened.audience).toEqual(full.audience)
  })

  test('coalesces durable tool-call frames into one detail refresh signal per window', () => {
    const invalidated: string[] = []
    let now = 10_000
    const signal = createSessionDetailRefreshSignal({
      invalidate: () => invalidated.push('detail'),
      isActive: () => true,
      now: () => now,
      coalescingWindowMs: 1_000,
    })
    const toolCall = {
      type: 'step' as const,
      step: {
        type: 'tool_call' as const,
        toolName: 'write_file',
        toolCallId: 'tool-1',
        isError: false,
      },
    }

    signal(toolCall)
    signal({ ...toolCall, step: { ...toolCall.step, toolCallId: 'tool-2' } })
    now += 999
    signal({ ...toolCall, step: { ...toolCall.step, toolCallId: 'tool-3' } })

    expect(invalidated).toEqual(['detail'])

    now += 1
    signal({ ...toolCall, step: { ...toolCall.step, toolCallId: 'tool-4' } })
    expect(invalidated).toEqual(['detail', 'detail'])
  })

  test('terminal durable frames trigger a detail backstop even inside the tool-call window', () => {
    let invalidations = 0
    const signal = createSessionDetailRefreshSignal({
      invalidate: () => {
        invalidations += 1
      },
      isActive: () => true,
      now: () => 10_000,
    })

    signal({
      type: 'step',
      step: {
        type: 'tool_call',
        toolName: 'write_file',
        toolCallId: 'tool-1',
        isError: false,
      },
    })
    signal({ type: 'complete' })

    expect(invalidations).toBe(2)
  })

  test('a durable tool call signals both detail and direct-child refresh ports', () => {
    const invalidated: string[] = []
    const signal = createSessionDetailRefreshSignal({
      invalidate: () => invalidated.push('detail'),
      invalidateChildren: () => invalidated.push('children'),
      isActive: () => true,
    })

    signal({
      type: 'step',
      step: {
        type: 'tool_call',
        toolName: 'Task',
        toolCallId: 'tool-1',
        isError: false,
      },
    })

    expect(invalidated).toEqual(['detail', 'children'])
  })

  test('inactive workspace scope ignores causal detail refresh signals', () => {
    let invalidations = 0
    const signal = createSessionDetailRefreshSignal({
      invalidate: () => {
        invalidations += 1
      },
      isActive: () => false,
    })

    signal({
      type: 'step',
      step: {
        type: 'tool_call',
        toolName: 'write_file',
        toolCallId: 'tool-1',
        isError: false,
      },
    })
    signal({ type: 'complete' })

    expect(invalidations).toBe(0)
  })

  test('a durable tool call refreshes the mounted snapshot and reveals its cwd app', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const initial = {
      ...summary({ turnStatus: 'running' }),
      workspaceId: 'workspace_1',
      lastDeliveredInputSeq: 0,
      cwd: 'notes',
    } satisfies SessionSnapshot
    const moved = { ...initial, cwd: 'apps/reports' }
    let serverSnapshot = initial
    let requests = 0
    const options = {
      queryKey: sessionKeys.detail('acme', initial.id),
      queryFn: () => {
        requests += 1
        return Promise.resolve(serverSnapshot)
      },
      staleTime: Number.POSITIVE_INFINITY,
    }
    await queryClient.fetchQuery(options)
    const observer = new QueryObserver(queryClient, options)
    const unsubscribe = observer.subscribe(() => {})
    const reports = { slug: 'reports', anchorPath: 'apps/reports' } satisfies Pick<
      App,
      'slug' | 'anchorPath'
    >
    expect(appForCwd(observer.getCurrentResult().data?.cwd, [reports])).toBeUndefined()

    let refresh: Promise<void> | undefined
    const signal = createSessionDetailRefreshSignal({
      invalidate: () => {
        refresh = queryClient.invalidateQueries({
          queryKey: sessionKeys.detail('acme', initial.id),
          exact: true,
        })
      },
      isActive: () => true,
    })
    serverSnapshot = moved
    signal({
      type: 'step',
      step: {
        type: 'tool_call',
        toolName: 'set_session_cwd',
        toolCallId: 'tool-1',
        isError: false,
      },
    })
    await refresh

    expect(requests).toBe(2)
    expect(appForCwd(observer.getCurrentResult().data?.cwd, [reports])).toBe(reports)
    unsubscribe()
  })

  test('cancels in-flight detail, list, and activity refetches before optimistic cache writes', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const detailKey = sessionKeys.detail('acme', 'session_1')
    const listKey = sessionKeys.list('acme', { search: '', archived: 'exclude' })
    const activityKey = sessionKeys.activity('acme')
    let detailSignal: AbortSignal | undefined
    let listSignal: AbortSignal | undefined
    let activitySignal: AbortSignal | undefined
    let releaseDetail: ((value: SessionSnapshot) => void) | undefined
    let releaseList:
      | ((value: {
          pages: Array<{ items: SessionSummary[]; nextCursor: null }>
          pageParams: undefined[]
        }) => void)
      | undefined
    let releaseActivity: ((value: SessionActivityResponse) => void) | undefined

    const staleDetail: SessionSnapshot = {
      ...summary({ title: 'Stale detail' }),
      workspaceId: 'workspace_1',
      lastDeliveredInputSeq: 0,
    }
    const staleList = {
      pages: [{ items: [summary({ title: 'Stale list' })], nextCursor: null }],
      pageParams: [undefined],
    }
    const detailRequest = queryClient
      .fetchQuery({
        queryKey: detailKey,
        queryFn: ({ signal }) => {
          detailSignal = signal
          return new Promise<SessionSnapshot>(resolve => {
            releaseDetail = resolve
          })
        },
      })
      .catch(() => undefined)
    const listRequest = queryClient
      .fetchQuery({
        queryKey: listKey,
        queryFn: ({ signal }) => {
          listSignal = signal
          return new Promise<typeof staleList>(resolve => {
            releaseList = resolve
          })
        },
      })
      .catch(() => undefined)
    const activityRequest = queryClient
      .fetchQuery({
        queryKey: activityKey,
        queryFn: ({ signal }) => {
          activitySignal = signal
          return new Promise<SessionActivityResponse>(resolve => {
            releaseActivity = resolve
          })
        },
      })
      .catch(() => undefined)

    await Promise.resolve()
    await cancelSessionOptimisticQueries(queryClient, 'acme', 'session_1')
    const optimistic = { ...staleDetail, title: 'Optimistic' }
    queryClient.setQueryData(detailKey, optimistic)
    queryClient.setQueryData(listKey, {
      pages: [{ items: [optimistic], nextCursor: null }],
      pageParams: [undefined],
    })
    releaseDetail?.(staleDetail)
    releaseList?.(staleList)
    releaseActivity?.({ owners: [] })
    await Promise.all([detailRequest, listRequest, activityRequest])

    expect(detailSignal?.aborted).toBe(true)
    expect(listSignal?.aborted).toBe(true)
    expect(activitySignal?.aborted).toBe(true)
    expect(queryClient.getQueryData<SessionSnapshot>(detailKey)?.title).toBe('Optimistic')
    expect(queryClient.getQueryData<typeof staleList>(listKey)?.pages[0]?.items[0]?.title).toBe(
      'Optimistic',
    )
  })

  // The turn footer reads a span off these stamps; a live frame stamped with
  // the browser's arrival clock and a refetched row stamped with the API's
  // disagree by the delivery lag, so the same turn re-reads shorter after any
  // history refetch. The frame carries the row's clock and the cache keeps it.
  test('a live durable frame keeps the row clock, not its arrival time', () => {
    const history = appendDurableFrame(undefined, 7, { type: 'turn_started' }, 1_700_000_000_000)

    expect(history.events).toEqual([
      { seq: 7, createdAt: 1_700_000_000_000, event: { type: 'turn_started' } },
    ])
  })

  // The stream delivers in order, so the ordinary frame is simply the next one;
  // a reconnect can replay a frame already held, and a backfill can deliver one
  // that belongs before the tail. All three have to leave one row per seq, in
  // seq order — the projection stops at the first gap it meets.
  test('durable frames land once each and in sequence, however they arrive', () => {
    const frame = (seq: number) => ({ type: 'turn_started' as const, seq })
    let history = appendDurableFrame(undefined, 1, frame(1), 10)
    history = appendDurableFrame(history, 2, frame(2), 20)
    history = appendDurableFrame(history, 4, frame(4), 40)
    expect(history.events.map(entry => entry.seq)).toEqual([1, 2, 4])

    const replayed = appendDurableFrame(history, 4, frame(4), 99)
    expect(replayed.events).toEqual(history.events)

    const backfilled = appendDurableFrame(history, 3, frame(3), 30)
    expect(backfilled.events.map(entry => [entry.seq, entry.createdAt])).toEqual([
      [1, 10],
      [2, 20],
      [3, 30],
      [4, 40],
    ])
  })

  test('merging canonical history preserves a newer live durable event', () => {
    const canonical: SessionChronologicalHistory = {
      events: [timelineEntry(1)],
      nextCursor: null,
      pagedThroughSeq: 0,
    }
    const live: SessionChronologicalHistory = {
      events: [timelineEntry(1), timelineEntry(2)],
      nextCursor: null,
      pagedThroughSeq: 0,
    }

    expect(mergeSessionHistory(canonical, live).events.map(event => event.seq)).toEqual([1, 2])
  })

  /* A fetched page that does not connect to what the cache already holds is
     not more history, it is a gap: the projection stops at the first missing
     sequence and shows the stale prefix, and nothing ever fills the hole. Only
     the run that reaches the newest event is history; anything before the
     break is reachable again through the cursor, as older pages always were. */
  test('a fetched page that does not connect to the cached prefix replaces it', () => {
    const canonical: SessionChronologicalHistory = {
      events: [timelineEntry(8), timelineEntry(9), timelineEntry(10)],
      nextCursor: 'older-8',
      pagedThroughSeq: 0,
    }
    const live: SessionChronologicalHistory = {
      events: [timelineEntry(1), timelineEntry(2), timelineEntry(3)],
      nextCursor: null,
      pagedThroughSeq: 0,
    }

    const merged = mergeSessionHistory(canonical, live)
    expect(merged.events.map(event => event.seq)).toEqual([8, 9, 10])
    expect(merged.nextCursor).toBe('older-8')
  })

  /* Transcript pages skip the task rail by design, so two cached rows with a
     hole between them are not evidence of a gap. What connects a fresh page to
     the cache is overlap: the page covers everything from its oldest row up,
     and the cache's newest row reaches into that range. The seq the page
     delivered through is kept so the projection can tell paged history, where
     holes are normal, from the streamed tail, where a hole is a real gap. */
  test('a refetched transcript page joins a cache it overlaps even though pages skip rows', () => {
    const canonical: SessionChronologicalHistory = {
      events: [timelineEntry(5), timelineEntry(9)],
      nextCursor: 'older-5',
      pagedThroughSeq: 9,
    }
    const live: SessionChronologicalHistory = {
      events: [timelineEntry(2), timelineEntry(5), timelineEntry(6), timelineEntry(7)],
      nextCursor: 'older-2',
      pagedThroughSeq: 5,
    }

    expect(mergeSessionHistory(canonical, live)).toEqual({
      events: [2, 5, 6, 7, 9].map(timelineEntry),
      nextCursor: 'older-2',
      pagedThroughSeq: 9,
    })
  })

  test('an explicit older-page read prepends ordered rows and carries only its remaining cursor', () => {
    const current: SessionChronologicalHistory = {
      events: [timelineEntry(4), timelineEntry(5)],
      nextCursor: 'older-4',
      pagedThroughSeq: 5,
    }
    const older: SessionChronologicalHistory = {
      events: [timelineEntry(2), timelineEntry(3)],
      nextCursor: 'older-2',
      pagedThroughSeq: 3,
    }

    expect(prependOlderSessionHistory(current, older)).toEqual({
      events: [timelineEntry(2), timelineEntry(3), timelineEntry(4), timelineEntry(5)],
      nextCursor: 'older-2',
      pagedThroughSeq: 5,
    })
  })

  test('a session is never inserted into an unseen filtered list', () => {
    // Job lists used to live under their own key prefix, so they were
    // structurally immune to this splicer. After the merge every cached list is
    // a candidate, and a matcher that does not know `bucket` will insert a
    // running session into the Finished group — where it sits until the next
    // refetch quietly removes it again. That is the same failure the onboarding
    // guard below was added for, one dimension over.
    const queryClient = new QueryClient()
    const snapshot: SessionSnapshot = {
      ...summary({ id: 'session_running', turnStatus: 'running' }),
      workspaceId: 'workspace_1',
      lastDeliveredInputSeq: 0,
    }
    const wrongBucket = { search: '', archived: 'exclude' as const, bucket: 'done' as const }
    const rightBucket = { search: '', archived: 'exclude' as const, bucket: 'running' as const }
    for (const filters of [wrongBucket, rightBucket]) {
      queryClient.setQueryData(sessionKeys.list('acme', filters), {
        pages: [{ items: [], nextCursor: null }],
        pageParams: [undefined],
      })
    }

    patchSessionListCaches(queryClient, 'acme', snapshot)

    expect(
      queryClient.getQueryData<{ pages: Array<{ items: SessionSummary[] }> }>(
        sessionKeys.list('acme', wrongBucket),
      )?.pages[0]?.items,
    ).toEqual([])
    expect(
      queryClient.getQueryData<{ pages: Array<{ items: SessionSummary[] }> }>(
        sessionKeys.list('acme', rightBucket),
      )?.pages[0]?.items,
    ).toEqual([])
  })

  test('an onboarding session is never inserted into a list cache that did not ask for one', () => {
    const queryClient = new QueryClient()
    const snapshot: SessionSnapshot = {
      ...summary({ id: 'session_onboarding', turnStatus: 'running', onboarding: true }),
      workspaceId: 'workspace_1',
      lastDeliveredInputSeq: 0,
    }
    // Every list the product can show: unscoped, agent-scoped, archived-only.
    // The backend hides onboarding rows from all of them, so the optimistic
    // matcher has to hide them too — otherwise an onboarding session's own
    // cache patches splice the hidden session into every open list until the
    // next refetch quietly removes it again.
    const scopes = [
      { search: '', archived: 'exclude' as const },
      { search: '', archived: 'exclude' as const, agentId: 'agent_1' },
      { search: '', archived: 'only' as const },
    ]
    for (const filters of scopes) {
      queryClient.setQueryData(sessionKeys.list('acme', filters), {
        pages: [{ items: [], nextCursor: null }],
        pageParams: [undefined],
      })
    }

    patchSessionListCaches(queryClient, 'acme', snapshot)

    for (const filters of scopes) {
      expect(
        queryClient.getQueryData<{ pages: Array<{ items: SessionSummary[] }> }>(
          sessionKeys.list('acme', filters),
        )?.pages[0]?.items,
      ).toEqual([])
    }
  })

  test('changing detail identity resets the reconnect cursor to the new session history', () => {
    expect(
      ownSessionCursor('acme:session_a', 'acme:session_b', 500, {
        events: [timelineEntry(1), timelineEntry(2)],
        nextCursor: null,
        pagedThroughSeq: 0,
      }),
    ).toEqual({ owner: 'acme:session_b', value: 2 })
  })

  test('terminal durable history overrides a stale running snapshot', () => {
    const snapshot: SessionSnapshot = {
      ...summary({ turnStatus: 'running', lastEventSeq: 2 }),
      workspaceId: 'workspace_1',
      lastDeliveredInputSeq: 0,
    }
    const history: SessionChronologicalHistory = {
      events: [timelineEntry(1), { seq: 2, createdAt: 2, event: { type: 'complete' } }],
      nextCursor: null,
      pagedThroughSeq: 0,
    }

    const reconciled = reconcileSessionSnapshot(snapshot, history)
    expect(reconciled?.turnStatus).toBe('complete')
    expect(shouldOpenSessionStream(snapshot, reconciled, 2)).toBe(false)
    expect(shouldOpenSessionStream(snapshot, reconciled, 2, true)).toBe(true)
  })

  test('keeps live cursor anchors and retires only an explicitly matching tool precursor', () => {
    const frames: SessionEphemeralFrame[] = [
      {
        cursor: 4,
        correlationId: 'live-text',
        event: { type: 'step', step: { type: 'text_delta', delta: 'Still streaming' } },
      },
      {
        cursor: 4,
        correlationId: 'tool-1',
        event: {
          type: 'step',
          step: { type: 'tool_call_start', toolName: 'read', toolCallId: 'tool-1' },
        },
      },
      {
        cursor: 4,
        correlationId: 'tool-2',
        event: {
          type: 'step',
          step: { type: 'tool_call_start', toolName: 'write', toolCallId: 'tool-2' },
        },
      },
    ]

    expect(
      reconcileEphemeralFrames(frames, 5, {
        type: 'todos',
        todos: [{ id: 'todo-1', content: 'Unrelated durable update', status: 'pending' }],
      }),
    ).toEqual(frames)
    expect(
      reconcileEphemeralFrames(frames, 5, {
        type: 'step',
        step: { type: 'tool_call', toolName: 'read', toolCallId: 'tool-1', isError: false },
      }),
    ).toEqual([frames[0]!, frames[2]!])
    expect(
      reconcileEphemeralFrames(frames, 6, {
        type: 'step',
        step: { type: 'tool_call', toolName: 'read', toolCallId: 'tool-1', isError: false },
      }),
    ).toEqual(frames)
    // A tool call's start is durable now, so its own durable row retires the
    // live frame that announced it — otherwise a long call keeps both for the
    // whole time it runs, which is exactly when it runs longest.
    expect(
      reconcileEphemeralFrames(frames, 5, {
        type: 'step',
        step: { type: 'tool_call_start', toolName: 'read', toolCallId: 'tool-1' },
      }),
    ).toEqual([frames[0]!, frames[2]!])
  })

  /* The control plane stamps the row's status in the mutation that appends each
     event, so an event older than the row's last write carries a status the row
     has already superseded. Reading it back as "the latest" is how a cached
     `turn_started` from the head of a long turn overrode a row that said the
     turn was over. */
  test('a status older than the row never overrides the row', () => {
    const snapshot: SessionSnapshot = {
      ...summary({ turnStatus: 'interrupted', lastEventSeq: 1266 }),
      workspaceId: 'workspace_1',
      lastDeliveredInputSeq: 0,
    }
    const history: SessionChronologicalHistory = {
      events: [
        { seq: 63, createdAt: 63, event: { type: 'turn_started' } },
        {
          seq: 1266,
          createdAt: 1266,
          event: { type: 'step', step: { type: 'text', text: 'Done.' } },
        },
      ],
      nextCursor: 'older-63',
      pagedThroughSeq: 0,
    }

    const reconciled = reconcileSessionSnapshot(snapshot, history)
    expect(reconciled).toMatchObject({ turnStatus: 'interrupted', lastEventSeq: 1266 })
  })

  test('terminal snapshots retain their promised cursor while history catches up', () => {
    const snapshot: SessionSnapshot = {
      ...summary({ turnStatus: 'complete', lastEventSeq: 8 }),
      workspaceId: 'workspace_1',
      lastDeliveredInputSeq: 0,
    }

    const reconciled = reconcileSessionSnapshot(snapshot, {
      events: [timelineEntry(1)],
      nextCursor: null,
      pagedThroughSeq: 0,
    })
    expect(reconciled).toMatchObject({
      turnStatus: 'complete',
      lastEventSeq: 8,
    })
    expect(shouldOpenSessionStream(snapshot, reconciled, 1)).toBe(true)
  })

  test('the reconnect delay schedule grows exponentially up to its cap', () => {
    expect([0, 1, 2, 3, 8].map(sessionReconnectDelay)).toEqual([250, 500, 1_000, 2_000, 10_000])
  })

  test('accepted follow-up input supersedes an older terminal history event', () => {
    const snapshot: SessionSnapshot = {
      ...summary({ turnStatus: 'running', lastEventSeq: 3 }),
      workspaceId: 'workspace_1',
      lastDeliveredInputSeq: 0,
    }
    const history: SessionChronologicalHistory = {
      events: [
        timelineEntry(1),
        { seq: 2, createdAt: 2, event: { type: 'complete' } },
        timelineEntry(3),
      ],
      nextCursor: null,
      pagedThroughSeq: 0,
    }
    const reconciled = reconcileSessionSnapshot(snapshot, history)

    expect(reconciled?.turnStatus).toBe('running')
    expect(shouldOpenSessionStream(snapshot, reconciled, 3)).toBe(true)
  })

  test('projects pending inputs at the current cursor without pretending they are durable', () => {
    const submittedAt = Date.parse('2026-07-19T12:34:56.000Z')

    expect(
      pendingSessionInputFrames(
        [
          {
            mutationId: 1,
            kind: 'message',
            variables: { prompt: 'Deploy the fix' },
            submittedAt,
            cursorAtSubmit: 17,
          },
          {
            mutationId: 2,
            kind: 'note',
            variables: { note: 'Customer approved' },
            submittedAt: submittedAt + 1,
            cursorAtSubmit: 17,
          },
          {
            mutationId: 3,
            kind: 'answer',
            variables: { answer: 'Proceed' },
            submittedAt: submittedAt + 2,
            cursorAtSubmit: 17,
          },
          {
            mutationId: 4,
            kind: 'message',
            variables: { prompt: 42 },
            submittedAt: submittedAt + 3,
            cursorAtSubmit: 17,
          },
        ],
        18,
        VIEWER_SENDER,
      ),
    ).toEqual([
      expect.objectContaining({
        cursor: 18,
        correlationId: 'optimistic:message:1',
        createdAt: submittedAt,
        event: expect.objectContaining({
          type: 'prompt_submitted',
          prompt: 'Deploy the fix',
          sender: VIEWER_SENDER,
        }),
      }),
      expect.objectContaining({
        cursor: 18,
        correlationId: 'optimistic:note:2',
        createdAt: submittedAt + 1,
        event: expect.objectContaining({
          type: 'note_submitted',
          note: 'Customer approved',
          sender: VIEWER_SENDER,
        }),
      }),
      expect.objectContaining({
        cursor: 18,
        correlationId: 'optimistic:answer:3',
        createdAt: submittedAt + 2,
        event: expect.objectContaining({ type: 'answer_submitted', answer: 'Proceed' }),
      }),
    ])
  })

  test('an optimistic row is authored by the viewer and leaves the durable cursor behind', () => {
    const submittedAt = Date.parse('2026-07-19T12:34:56.000Z')
    const durableEvents: SessionChronologicalHistory['events'] = [timelineEntry(1)]
    const projected = projectSession({
      snapshot: {
        ...summary({ turnStatus: 'running', lastEventSeq: 1 }),
        workspaceId: 'workspace_1',
        lastDeliveredInputSeq: 0,
      },
      durableEvents,
      ephemeralFrames: pendingSessionInputFrames(
        [{ mutationId: 1, kind: 'message', variables: { prompt: 'Deploy' }, submittedAt }],
        1,
        VIEWER_SENDER,
        durableEvents,
      ),
    })

    expect(projected.messages.at(-1)).toEqual(
      expect.objectContaining({
        role: 'input',
        text: 'Deploy',
        sender: VIEWER_SENDER,
        pending: true,
      }),
    )
    // The row the server has not written yet cannot move the resume cursor.
    expect(projected.cursor).toBe(1)
  })

  test('a same-text input from another author cannot retire the viewer’s optimistic row', () => {
    const submittedAt = Date.parse('2026-07-19T12:34:56.000Z')
    const durableEvents: SessionChronologicalHistory['events'] = [
      {
        seq: 2,
        createdAt: submittedAt,
        event: {
          type: 'prompt_submitted',
          prompt: 'Deploy the fix',
          inputKind: 'message',
          behavior: 'steer',
          sender: { kind: 'session', sessionId: 'session_ops' },
        },
      },
    ]

    const frames = pendingSessionInputFrames(
      [
        {
          mutationId: 1,
          kind: 'message',
          variables: { prompt: 'Deploy the fix' },
          submittedAt,
          cursorAtSubmit: 1,
        },
      ],
      2,
      VIEWER_SENDER,
      durableEvents,
    )

    expect(frames).toEqual([
      expect.objectContaining({
        correlationId: 'optimistic:message:1',
        event: expect.objectContaining({ type: 'prompt_submitted', sender: VIEWER_SENDER }),
      }),
    ])
  })

  test('canonical input retires its optimistic row even while the mutation is pending', () => {
    const submittedAt = Date.parse('2026-07-19T12:34:56.000Z')
    const snapshot: SessionSnapshot = {
      ...summary({ turnStatus: 'running', lastEventSeq: 2 }),
      workspaceId: 'workspace_1',
      lastDeliveredInputSeq: 0,
    }
    const pendingInputs = [
      {
        mutationId: 1,
        kind: 'message' as const,
        variables: {
          prompt: 'Deploy the fix',
          images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
          attachments: [
            {
              path: 'uploads/release-notes.pdf',
              name: 'release-notes.pdf',
              bytes: 84_203,
              mimeType: 'application/pdf',
            },
          ],
        },
        submittedAt,
        cursorAtSubmit: 1,
      },
    ]
    const beforeCanonicalEvents: SessionChronologicalHistory['events'] = [
      {
        seq: 1,
        createdAt: submittedAt - 1,
        event: {
          type: 'session_created',
          prompt: 'Initial prompt',
          createdAt: new Date(submittedAt - 1).toISOString(),
        },
      },
    ]

    const beforeCanonical = projectSession({
      snapshot: { ...snapshot, lastEventSeq: 1 },
      durableEvents: beforeCanonicalEvents,
      ephemeralFrames: pendingSessionInputFrames(
        pendingInputs,
        1,
        VIEWER_SENDER,
        beforeCanonicalEvents,
      ),
    })
    expect(beforeCanonical.messages).toEqual([
      expect.objectContaining({
        text: 'Deploy the fix',
        pending: true,
        images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
        attachments: [
          {
            path: 'uploads/release-notes.pdf',
            name: 'release-notes.pdf',
            bytes: 84_203,
            mimeType: 'application/pdf',
          },
        ],
      }),
    ])

    const afterCanonicalEvents: SessionChronologicalHistory['events'] = [
      ...beforeCanonicalEvents,
      {
        seq: 2,
        createdAt: submittedAt,
        event: {
          type: 'prompt_submitted',
          prompt: 'Deploy the fix',
          inputKind: 'message',
          behavior: 'steer',
          sender: VIEWER_SENDER,
          attachments: [
            {
              path: 'uploads/release-notes.pdf',
              name: 'release-notes.pdf',
              bytes: 84_203,
              mimeType: 'application/pdf',
            },
          ],
        },
      },
    ]
    const afterCanonical = projectSession({
      snapshot,
      durableEvents: afterCanonicalEvents,
      ephemeralFrames: pendingSessionInputFrames(
        pendingInputs,
        2,
        VIEWER_SENDER,
        afterCanonicalEvents,
      ),
    })
    const canonicalRows = afterCanonical.messages.filter(
      message => message.role === 'input' && message.text === 'Deploy the fix',
    )
    expect(canonicalRows).toHaveLength(1)
    const canonicalRow = canonicalRows[0]
    if (canonicalRow?.role !== 'input') throw new Error('canonical message row missing')
    expect(canonicalRow.pending).not.toBe(true)
    expect(canonicalRow.attachments).toEqual([
      {
        path: 'uploads/release-notes.pdf',
        name: 'release-notes.pdf',
        bytes: 84_203,
        mimeType: 'application/pdf',
      },
    ])
  })

  test('unrelated durable output cannot retire an unmatched optimistic input', () => {
    const submittedAt = Date.parse('2026-07-19T12:34:56.000Z')
    const snapshot: SessionSnapshot = {
      ...summary({ turnStatus: 'running', lastEventSeq: 2 }),
      workspaceId: 'workspace_1',
      lastDeliveredInputSeq: 0,
    }
    const durableEvents: SessionChronologicalHistory['events'] = [
      {
        seq: 1,
        createdAt: submittedAt - 1,
        event: {
          type: 'session_created',
          prompt: 'Initial prompt',
          createdAt: new Date(submittedAt - 1).toISOString(),
        },
      },
      {
        seq: 2,
        createdAt: submittedAt,
        event: { type: 'step', step: { type: 'text', text: 'Finishing earlier work.' } },
      },
    ]
    const projected = projectSession({
      snapshot,
      durableEvents,
      ephemeralFrames: pendingSessionInputFrames(
        [
          {
            mutationId: 1,
            kind: 'message',
            variables: { prompt: 'Deploy the fix' },
            submittedAt,
            cursorAtSubmit: 1,
          },
        ],
        2,
        VIEWER_SENDER,
        durableEvents,
      ),
    })

    expect(projected.messages.filter(message => message.role === 'input')).toEqual([
      expect.objectContaining({ text: 'Deploy the fix', pending: true }),
    ])
  })

  test('one durable input retires only one of two identical optimistic inputs', () => {
    const submittedAt = Date.parse('2026-07-19T12:34:56.000Z')
    const durableEvents: SessionChronologicalHistory['events'] = [
      {
        seq: 2,
        createdAt: submittedAt,
        event: {
          type: 'prompt_submitted',
          prompt: 'Run it again',
          inputKind: 'message',
          behavior: 'steer',
          sender: VIEWER_SENDER,
        },
      },
    ]

    expect(
      pendingSessionInputFrames(
        [
          {
            mutationId: 1,
            kind: 'message',
            variables: { prompt: 'Run it again' },
            submittedAt,
            cursorAtSubmit: 1,
          },
          {
            mutationId: 2,
            kind: 'message',
            variables: { prompt: 'Run it again' },
            submittedAt: submittedAt + 1,
            cursorAtSubmit: 1,
          },
        ],
        2,
        VIEWER_SENDER,
        durableEvents,
      ),
    ).toEqual([
      expect.objectContaining({
        cursor: 2,
        correlationId: 'optimistic:message:2',
        event: expect.objectContaining({ type: 'prompt_submitted', prompt: 'Run it again' }),
      }),
    ])
  })

  test('durable acceptance matches input kind, payload, author, and post-submit cursor', () => {
    const events: SessionChronologicalHistory['events'] = [
      {
        seq: 2,
        createdAt: 2,
        event: {
          type: 'prompt_submitted',
          prompt: 'Already accepted',
          inputKind: 'message',
          behavior: 'steer',
          sender: VIEWER_SENDER,
        },
      },
      {
        seq: 3,
        createdAt: 3,
        event: {
          type: 'note_submitted',
          note: 'Keep this context',
          sender: VIEWER_SENDER,
        },
      },
      {
        seq: 4,
        createdAt: 4,
        event: {
          type: 'answer_submitted',
          answer: 'Proceed',
          sender: VIEWER_SENDER,
        },
      },
    ]

    expect(durableSessionInputExists(events, 'message', 'Already accepted', 1, VIEWER_SENDER)).toBe(
      true,
    )
    expect(durableSessionInputExists(events, 'note', 'Keep this context', 2, VIEWER_SENDER)).toBe(
      true,
    )
    expect(durableSessionInputExists(events, 'answer', 'Proceed', 3, VIEWER_SENDER)).toBe(true)
    expect(durableSessionInputExists(events, 'message', 'Different text', 1, VIEWER_SENDER)).toBe(
      false,
    )
    expect(durableSessionInputExists(events, 'message', 'Already accepted', 2, VIEWER_SENDER)).toBe(
      false,
    )
    // A row with the same text from a different author is somebody else's input.
    expect(
      durableSessionInputExists(events, 'message', 'Already accepted', 1, {
        kind: 'user',
        userId: 'user_teammate',
      }),
    ).toBe(false)
  })

  test('uses the client request id to distinguish identical concurrent input', () => {
    const events: SessionChronologicalHistory['events'] = [
      {
        seq: 2,
        createdAt: 2,
        event: {
          type: 'prompt_submitted',
          prompt: 'Proceed',
          inputKind: 'message',
          behavior: 'steer',
          sender: VIEWER_SENDER,
          clientRequestId: '018f47a0-4dd1-7c2e-9cb7-8f4e71da8b91',
        },
      },
    ]

    expect(
      durableSessionInputExists(
        events,
        'message',
        'Proceed',
        1,
        VIEWER_SENDER,
        '018f47a0-4dd1-7c2e-9cb7-8f4e71da8b91',
      ),
    ).toBe(true)
    expect(
      durableSessionInputExists(
        events,
        'message',
        'Proceed',
        1,
        VIEWER_SENDER,
        '018f47a0-4dd1-7c2e-9cb7-8f4e71da8b92',
      ),
    ).toBe(false)
    expect(
      durableSessionInputExists(
        [
          {
            seq: 2,
            createdAt: 2,
            event: {
              type: 'prompt_submitted',
              prompt: 'Proceed',
              inputKind: 'message',
              behavior: 'steer',
              sender: VIEWER_SENDER,
            },
          },
        ],
        'message',
        'Proceed',
        1,
        VIEWER_SENDER,
        '018f47a0-4dd1-7c2e-9cb7-8f4e71da8b91',
      ),
    ).toBe(false)
  })

  test('does not retire an identified optimistic input against a row carrying no request id', () => {
    const submittedAt = Date.parse('2026-07-19T12:34:56.000Z')
    const durableEvents: SessionChronologicalHistory['events'] = [
      {
        seq: 2,
        createdAt: submittedAt,
        event: {
          type: 'prompt_submitted',
          prompt: 'Proceed',
          inputKind: 'message',
          behavior: 'steer',
          sender: VIEWER_SENDER,
        },
      },
    ]

    expect(
      pendingSessionInputFrames(
        [
          {
            mutationId: 1,
            kind: 'message',
            variables: {
              prompt: 'Proceed',
              clientRequestId: '018f47a0-4dd1-7c2e-9cb7-8f4e71da8b91',
            },
            submittedAt,
            cursorAtSubmit: 1,
          },
        ],
        2,
        VIEWER_SENDER,
        durableEvents,
      ),
    ).toEqual([
      {
        cursor: 2,
        correlationId: 'optimistic:message:1',
        createdAt: submittedAt,
        event: {
          type: 'prompt_submitted',
          prompt: 'Proceed',
          inputKind: 'message',
          behavior: 'steer',
          sender: VIEWER_SENDER,
          clientRequestId: '018f47a0-4dd1-7c2e-9cb7-8f4e71da8b91',
        },
      },
    ])
  })

  test('updates detail, loaded list, and direct-child projections without changing history', () => {
    const queryClient = new QueryClient()
    const original = summary({ title: 'Generated title', titleOrigin: 'auto' })
    const renamed = summary({ title: 'Release decision', titleOrigin: 'manual' })
    const filters = { search: '', archived: 'exclude' as const }
    const history: SessionChronologicalHistory = {
      events: [
        {
          seq: 1,
          createdAt: 1,
          event: {
            type: 'session_created',
            prompt: 'Investigate',
            createdAt: '2026-07-11T00:00:00.000Z',
          },
        },
      ],
      nextCursor: null,
      pagedThroughSeq: 0,
    }
    queryClient.setQueryData(sessionKeys.list('acme', filters), {
      pages: [{ items: [original], nextCursor: null }],
      pageParams: [undefined],
    })
    queryClient.setQueryData(sessionKeys.children('acme', 'parent_1'), {
      pages: [{ items: [original], nextCursor: null }],
      pageParams: [undefined],
    })
    queryClient.setQueryData<SessionSnapshot>(sessionKeys.detail('acme', original.id), {
      ...original,
      workspaceId: 'workspace_1',
      lastDeliveredInputSeq: 0,
    })
    queryClient.setQueryData(sessionKeys.history('acme', original.id), history)

    patchSessionSummaryCaches(queryClient, 'acme', renamed)

    expect(
      queryClient.getQueryData<{ pages: Array<{ items: SessionSummary[] }> }>(
        sessionKeys.list('acme', filters),
      )?.pages[0]?.items[0]?.title,
    ).toBe('Release decision')
    expect(
      queryClient.getQueryData<{ pages: Array<{ items: SessionSummary[] }> }>(
        sessionKeys.children('acme', 'parent_1'),
      )?.pages[0]?.items[0]?.title,
    ).toBe('Release decision')
    expect(
      queryClient.getQueryData<SessionSnapshot>(sessionKeys.detail('acme', original.id))?.title,
    ).toBe('Release decision')
    expect(
      queryClient.getQueryData<SessionChronologicalHistory>(
        sessionKeys.history('acme', original.id),
      ),
    ).toEqual(history)
  })

  test('commits only mutation-owned summary fields over newer SSE state', () => {
    const queryClient = new QueryClient()
    const filters = { search: '', archived: 'exclude' as const }
    const live: SessionSnapshot = {
      ...summary({
        title: 'Optimistic title',
        turnStatus: 'complete',
        updatedAt: 20,
        lastEventSeq: 9,
      }),
      workspaceId: 'workspace_1',
      lastDeliveredInputSeq: 8,
    }
    const staleResponse = summary({
      title: 'Canonical title',
      titleOrigin: 'manual',
      turnStatus: 'running',
      updatedAt: 10,
      lastEventSeq: 4,
    })
    queryClient.setQueryData(sessionKeys.detail('acme', live.id), live)
    queryClient.setQueryData(sessionKeys.list('acme', filters), {
      pages: [{ items: [live], nextCursor: null }],
      pageParams: [undefined],
    })
    const emptyFilters = { search: 'Canonical', archived: 'exclude' as const }
    queryClient.setQueryData(sessionKeys.list('acme', emptyFilters), {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [undefined],
    })

    commitSessionSummaryFields(queryClient, 'acme', staleResponse, [
      'title',
      'titleOrigin',
      'titleStatus',
      'updatedAt',
    ])

    expect(
      queryClient.getQueryData<SessionSnapshot>(sessionKeys.detail('acme', live.id)),
    ).toMatchObject({
      title: 'Canonical title',
      titleOrigin: 'manual',
      updatedAt: 20,
      turnStatus: 'complete',
      lastEventSeq: 9,
      lastDeliveredInputSeq: 8,
    })
    expect(
      queryClient.getQueryData<{ pages: Array<{ items: SessionSummary[] }> }>(
        sessionKeys.list('acme', filters),
      )?.pages[0]?.items[0],
    ).toMatchObject({
      title: 'Canonical title',
      turnStatus: 'complete',
      lastEventSeq: 9,
    })
    expect(
      queryClient.getQueryData<{ pages: Array<{ items: SessionSummary[] }> }>(
        sessionKeys.list('acme', emptyFilters),
      )?.pages[0]?.items,
    ).toEqual([])
  })

  test('session removal evicts loaded detail, history, list, and direct-child caches', async () => {
    const queryClient = new QueryClient()
    const session = summary({ id: 'session_deleted' })
    const filters = { search: '', archived: 'exclude' as const }
    queryClient.setQueryData(sessionKeys.detail('acme', session.id), {
      ...session,
      workspaceId: 'workspace_1',
      lastDeliveredInputSeq: 0,
    })
    queryClient.setQueryData(sessionKeys.history('acme', session.id), { events: [] })
    queryClient.setQueryData(sessionKeys.list('acme', filters), {
      pages: [{ items: [session], nextCursor: null }],
      pageParams: [undefined],
    })
    queryClient.setQueryData(sessionKeys.children('acme', 'parent_1'), {
      pages: [{ items: [session], nextCursor: null }],
      pageParams: [undefined],
    })

    await commitRemovedSessionCache(queryClient, 'acme', session.id)

    expect(queryClient.getQueryData(sessionKeys.detail('acme', session.id))).toBeUndefined()
    expect(queryClient.getQueryData(sessionKeys.history('acme', session.id))).toBeUndefined()
    expect(queryClient.getQueryData(sessionKeys.list('acme', filters))).toBeUndefined()
    expect(queryClient.getQueryData(sessionKeys.children('acme', 'parent_1'))).toBeUndefined()
  })

  test('does not infer agent-filter membership for an unseen row', () => {
    const queryClient = new QueryClient()
    const mutated = summary({
      id: 'session_1',
      title: 'Ship the roster',
      agent: { id: 'agent_a', name: 'Agent A' },
    })
    const unscoped = { search: '', archived: 'exclude' as const }
    const ownScope = { search: '', archived: 'exclude' as const, agentId: 'agent_a' }
    const foreignScope = { search: '', archived: 'exclude' as const, agentId: 'agent_b' }
    for (const filters of [unscoped, ownScope, foreignScope]) {
      queryClient.setQueryData(sessionKeys.list('acme', filters), {
        pages: [{ items: [], nextCursor: null }],
        pageParams: [undefined],
      })
    }

    patchSessionSummaryCaches(queryClient, 'acme', mutated)

    const idsIn = (filters: SessionListKeyFilters) =>
      queryClient
        .getQueryData<{ pages: Array<{ items: SessionSummary[] }> }>(
          sessionKeys.list('acme', filters),
        )
        ?.pages[0]?.items.map(session => session.id)
    expect(idsIn(unscoped)).toEqual([])
    expect(idsIn(ownScope)).toEqual([])
    expect(idsIn(foreignScope)).toEqual([])
  })

  test('does not infer root or agent scope for unseen rows', () => {
    const queryClient = new QueryClient()
    const rootScope = { search: '', archived: 'exclude' as const, agentId: ROOT_AGENT_SCOPE }
    const agentScope = { search: '', archived: 'exclude' as const, agentId: 'agent_a' }
    for (const filters of [rootScope, agentScope]) {
      queryClient.setQueryData(sessionKeys.list('acme', filters), {
        pages: [{ items: [], nextCursor: null }],
        pageParams: [undefined],
      })
    }

    const rootSession = summary({ id: 'session_root', title: 'Drive-root work' })
    const attributed = summary({
      id: 'session_agent',
      title: 'Agent work',
      agent: { id: 'agent_a', name: 'Agent A' },
    })
    patchSessionSummaryCaches(queryClient, 'acme', rootSession)
    patchSessionSummaryCaches(queryClient, 'acme', attributed)

    const idsIn = (filters: SessionListKeyFilters) =>
      queryClient
        .getQueryData<{ pages: Array<{ items: SessionSummary[] }> }>(
          sessionKeys.list('acme', filters),
        )
        ?.pages[0]?.items.map(session => session.id)
    expect(idsIn(rootScope)).toEqual([])
    expect(idsIn(agentScope)).toEqual([])
  })

  test('preserves known search membership and moves a freshly updated session to the front', () => {
    const queryClient = new QueryClient()
    const updated = summary({ id: 'session_1', title: 'Short title', updatedAt: 10 })
    const newer = summary({ id: 'session_2', title: 'Another session', updatedAt: 9 })
    const filters = { search: 'prompt text beyond title', archived: 'exclude' as const }
    queryClient.setQueryData(sessionKeys.list('acme', filters), {
      pages: [{ items: [newer, { ...updated, updatedAt: 1 }], nextCursor: null }],
      pageParams: [undefined],
    })

    patchSessionSummaryCaches(queryClient, 'acme', updated)

    expect(
      queryClient
        .getQueryData<{ pages: Array<{ items: SessionSummary[] }> }>(
          sessionKeys.list('acme', filters),
        )
        ?.pages[0]?.items.map(session => session.id),
    ).toEqual(['session_1', 'session_2'])
  })

  test('re-sorts a rolled-back session by canonical updated time instead of prepending it', () => {
    const queryClient = new QueryClient()
    const rolledBack = summary({ id: 'session_1', title: 'Old session', updatedAt: 1 })
    const newer = summary({ id: 'session_2', title: 'Newer session', updatedAt: 9 })
    const filters = { search: '', archived: 'exclude' as const }
    queryClient.setQueryData(sessionKeys.list('acme', filters), {
      pages: [{ items: [rolledBack, newer], nextCursor: null }],
      pageParams: [undefined],
    })

    patchSessionSummaryCaches(queryClient, 'acme', rolledBack)

    expect(
      queryClient
        .getQueryData<{ pages: Array<{ items: SessionSummary[] }> }>(
          sessionKeys.list('acme', filters),
        )
        ?.pages[0]?.items.map(session => session.id),
    ).toEqual(['session_2', 'session_1'])
  })

  test('rolls back only mutation-owned fields and preserves newer canonical state', () => {
    const queryClient = new QueryClient()
    const key = sessionKeys.detail('acme', 'session_1')
    const previous: SessionSnapshot = {
      ...summary({ title: 'Original', turnStatus: 'ask', updatedAt: 1, lastEventSeq: 2 }),
      workspaceId: 'workspace_1',
      lastDeliveredInputSeq: 0,
    }
    const optimistic: SessionSnapshot = {
      ...previous,
      title: 'Optimistic',
      titleOrigin: 'manual',
      titleStatus: 'complete',
      turnStatus: 'running',
      updatedAt: 2,
    }
    queryClient.setQueryData(key, {
      ...optimistic,
      turnStatus: 'complete',
      updatedAt: 3,
      lastEventSeq: 7,
    })

    rollbackSessionDetailFields(queryClient, key, previous, optimistic, [
      ['title', 'titleOrigin', 'titleStatus'],
      ['turnStatus', 'updatedAt'],
    ])

    expect(queryClient.getQueryData<SessionSnapshot>(key)).toMatchObject({
      title: 'Original',
      titleOrigin: previous.titleOrigin,
      titleStatus: previous.titleStatus,
      turnStatus: 'complete',
      updatedAt: 3,
      lastEventSeq: 7,
    })
  })
})

function timelineEntry(seq: number): SessionChronologicalHistory['events'][number] {
  return {
    seq,
    createdAt: seq,
    event: {
      type: 'prompt_submitted',
      prompt: `Prompt ${seq}`,
      inputKind: seq === 1 ? 'initial' : 'message',
      behavior: 'steer',
      sender: VIEWER_SENDER,
    },
  }
}

function summary(overrides: Partial<SessionSummary>): SessionSummary {
  const turnStatus = overrides.turnStatus ?? 'ask'
  return {
    id: 'session_1',
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
    turnStatus,
    bucket: bucketOf({ turnStatus, ...(overrides.machine ? { machine: overrides.machine } : {}) }),
    title: 'Generated title',
    titleOrigin: 'auto',
    titleStatus: 'complete',
    createdAt: 1,
    updatedAt: 2,
    lastEventSeq: 1,
    unread: false,
    ...overrides,
  }
}

test('canonical tool appends project once through the query cache and match replay', () => {
  const client = new QueryClient()
  const key = sessionKeys.history('acme', 'projection-work')
  const projector = createIncrementalSessionProjector()
  let processed = 0
  let projection: ReturnType<typeof projectSession> | undefined
  for (let seq = 1; seq <= 2001; seq += 1) {
    client.setQueryData<SessionChronologicalHistory>(key, current =>
      appendDurableFrame(
        current,
        seq,
        seq === 2001
          ? { type: 'complete', status: 'completed' }
          : {
              type: 'step',
              step: {
                type: 'tool_call',
                toolName: 'read',
                toolCallId: `tool-${seq}`,
                isError: false,
                output: [{ type: 'text', text: `result-${seq}` }],
              },
            },
        seq,
      ),
    )
    const history = client.getQueryData<SessionChronologicalHistory>(key)!
    const result = projector.project({
      snapshot: { ...TRANSCRIPT_SNAPSHOT, lastEventSeq: seq },
      durableEvents: history.events,
      durableGeneration: history.durableGeneration,
    })
    processed += result.processedEvents
    projection = result.projection
  }
  const history = client.getQueryData<SessionChronologicalHistory>(key)!
  expect(projection).toEqual(
    projectSession({
      snapshot: { ...TRANSCRIPT_SNAPSHOT, lastEventSeq: 2001 },
      durableEvents: history.events,
    }),
  )
  expect(processed).toBeLessThanOrEqual(2001)
  client.clear()
})

test('live tool starts reconcile with canonical start/end without replaying history', () => {
  const client = new QueryClient()
  const key = sessionKeys.history('acme', 'live-projection-work')
  const projector = createIncrementalSessionProjector()
  let frames: SessionEphemeralFrame[] = []
  let seq = 0
  let processed = 0
  const check = () => {
    const history = client.getQueryData<SessionChronologicalHistory>(key)!
    const args = {
      snapshot: { ...TRANSCRIPT_SNAPSHOT, lastEventSeq: seq },
      durableEvents: history.events,
      durableGeneration: history.durableGeneration,
      ephemeralFrames: frames,
    }
    const result = projector.project(args)
    processed += result.processedEvents
    expect(result.projection).toEqual(projectSession(args))
  }
  const append = (event: Parameters<typeof appendDurableFrame>[2]) => {
    seq += 1
    client.setQueryData<SessionChronologicalHistory>(key, current =>
      appendDurableFrame(current, seq, event, seq),
    )
    frames = reconcileEphemeralFrames(frames, seq, event)
    check()
  }
  append({ type: 'turn_started' })
  // Some transports never emit canonical reasoning; its live frame stays
  // behind the cursor throughout the following tool-heavy turn.
  frames.push({
    cursor: seq,
    correlationId: 'reasoning',
    event: { type: 'step', step: { type: 'reasoning_delta', delta: 'Inspecting files' } },
  })
  check()
  for (let index = 0; index < 100; index += 1) {
    const step = { type: 'tool_call_start' as const, toolName: 'read', toolCallId: `tool-${index}` }
    frames.push({ cursor: seq, correlationId: step.toolCallId, event: { type: 'step', step } })
    check()
    append({ type: 'step', step })
    append({
      type: 'step',
      step: {
        ...step,
        type: 'tool_call',
        isError: false,
        output: [{ type: 'text', text: `output-${index}` }],
      },
    })
  }
  append({ type: 'complete', status: 'completed' })
  expect(processed).toBeLessThanOrEqual(seq + 103)
  client.clear()
})

test('incremental replay reconciles optimism, historical live frames, gaps, and replaced pages', () => {
  const client = new QueryClient()
  const key = sessionKeys.history('acme', 'reconciliation')
  const projector = createIncrementalSessionProjector()
  let frames: SessionEphemeralFrame[] = []
  let optimistic: SessionEphemeralFrame[] = []
  const check = () => {
    const history = client.getQueryData<SessionChronologicalHistory>(key)!
    const args = {
      snapshot: { ...TRANSCRIPT_SNAPSHOT },
      durableEvents: history.events,
      durableGeneration: history.durableGeneration,
      ephemeralFrames: frames,
      optimisticFrames: optimistic,
      startsAtSeq: history.nextCursor === null ? 1 : history.events[0]?.seq,
      pagedThroughSeq: history.pagedThroughSeq,
    }
    expect(projector.project(args).projection).toEqual(
      projectSession({ ...args, ephemeralFrames: [...frames, ...optimistic] }),
    )
  }
  const append = (seq: number, event: Parameters<typeof appendDurableFrame>[2]) => {
    client.setQueryData<SessionChronologicalHistory>(key, current =>
      appendDurableFrame(current, seq, event, seq),
    )
    frames = reconcileEphemeralFrames(frames, seq, event)
    check()
  }
  append(1, { type: 'turn_started' })
  frames.push({
    cursor: 1,
    correlationId: 'reasoning',
    event: { type: 'step', step: { type: 'reasoning_delta', delta: 'thinking' } },
  })
  check()
  // A correlation replacement is a replacement, not another token append.
  frames.push({
    cursor: 1,
    correlationId: 'reasoning',
    event: { type: 'step', step: { type: 'reasoning_delta', delta: 'revised' } },
  })
  check()
  append(2, {
    type: 'step',
    step: { type: 'tool_call_start', toolName: 'read', toolCallId: 'read-1' },
  })
  append(3, { type: 'step', step: { type: 'reasoning', text: 'canonical reasoning' } })
  frames = []
  check()
  optimistic = [
    {
      cursor: 3,
      correlationId: 'input',
      event: { type: 'note_submitted', note: 'next', sender: VIEWER_SENDER },
    },
  ]
  check()
  optimistic = []
  append(4, { type: 'note_submitted', note: 'next', sender: VIEWER_SENDER })
  append(5, { type: 'complete', status: 'completed' })
  append(5, { type: 'complete', status: 'completed' })
  append(7, { type: 'step', step: { type: 'text', text: 'after gap' } })
  append(6, { type: 'turn_started' })
  client.setQueryData<SessionChronologicalHistory>(key, {
    events: [
      { seq: 20, createdAt: 20, event: { type: 'step', step: { type: 'text', text: 'new page' } } },
    ],
    nextCursor: 'older',
    pagedThroughSeq: 20,
  })
  check()
  client.setQueryData<SessionChronologicalHistory>(key, current =>
    prependOlderSessionHistory(current!, {
      events: [{ seq: 19, createdAt: 19, event: { type: 'turn_started' } }],
      nextCursor: null,
      pagedThroughSeq: 20,
    }),
  )
  check()
  // Reconnect replaces content at an existing sequence, not just the endpoints.
  client.setQueryData<SessionChronologicalHistory>(key, current =>
    mergeSessionHistory(
      {
        events: [
          {
            seq: 20,
            createdAt: 20,
            event: { type: 'step', step: { type: 'text', text: 'corrected page' } },
          },
        ],
        nextCursor: 'older',
        pagedThroughSeq: 20,
      },
      current,
    ),
  )
  check()
  append(21, { type: 'complete', status: 'completed' })
  client.clear()
})
