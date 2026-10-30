import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'

import {
  AGENT_INPUT_ATTACHMENT_MAX_COUNT,
  AGENT_INPUT_IMAGE_MAX_COUNT,
  AgentEventAttachmentSchema,
  AgentInputImageSchema,
  isKnownTimelineEvent,
  isSameInputSender,
  messagePreviewFromInput,
  type SentMedia,
  messagePreviewOf,
  type AgentAnswerRequest,
  type AgentMessageRequestInput,
  type AgentNoteRequest,
  type AgentSessionTimelineEvent,
  type SessionInputSender,
  type MessagePreview,
  type SessionAudienceDeltaRequest,
  type SessionSnapshot,
  type SessionSummary,
  type SessionTimelineEntry,
} from '@repo/contract'

import { DuetApiError } from '../api/client'
import {
  duetMutationKeys,
  duetQueryKeys,
  type SessionChildrenKeyFilters,
  type SessionListKeyFilters,
} from '../api/query-keys'
import { openSessionEventStream } from '../api/stream'
import { useWorkspaceCacheScope } from '../api/workspace-cache-scope'
import { useSpa, type SpaApi } from '../context'
import { createIncrementalSessionProjector, type SessionEphemeralFrame } from './projection'
import {
  cancelSessionOptimisticQueries,
  chronologicalSessionHistory,
  commitSessionArchiveCache,
  commitRemovedSessionCache,
  commitSessionSummaryFields,
  mergeSessionHistory,
  patchSessionDetailCache,
  patchSessionChatPreviewCache,
  patchSessionListCaches,
  patchSessionSummaryCaches,
  prependOlderSessionHistory,
  removeSessionFromActiveListCaches,
  rollbackSessionChatPreviewCache,
  type SessionChronologicalHistory,
  rollbackSessionDetailFields,
} from './session-cache'
import { useSessionReadStamp } from './session-reads'

export type SessionFilters = SessionListKeyFilters
export type SessionChildrenFilters = SessionChildrenKeyFilters

export const sessionKeys = duetQueryKeys.workspaces.sessions

/** Titles normally settle in seconds; the window keeps a wedged job from polling forever. */
const TITLE_POLL_WINDOW_MS = 60_000

/** The stream is the fast path; a dropped one must not leave a live turn frozen on screen. */
const LIVE_TURN_POLL_MS = 5_000

function sessionNeedsTitlePoll(
  session: Pick<SessionSummary, 'titleStatus' | 'createdAt'> | undefined,
  now: number,
): boolean {
  return session?.titleStatus === 'generating' && now - session.createdAt < TITLE_POLL_WINDOW_MS
}

export const sessionQueryOptions = {
  // `limit` is the page size, not part of the cache key: a card and its "Show
  // all" expansion page through the same agent-scoped list. The roster passes
  // the previewLimit + 1 lookahead (D18); every other caller keeps the default.
  list: (api: SpaApi, workspaceSlug: string, filters: SessionFilters, limit = 30) =>
    infiniteQueryOptions({
      queryKey: sessionKeys.list(workspaceSlug, filters),
      queryFn: ({ pageParam, signal }) =>
        api.listSessions(
          workspaceSlug,
          {
            cursor: pageParam,
            limit,
            search: filters.search || undefined,
            bucket: filters.bucket,
            archived: filters.archived,
            agentId: filters.agentId,
            excludeDefault: filters.excludeDefault,
            topLevel: filters.topLevel,
          },
          signal,
        ),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: page => page.nextCursor,
      refetchInterval: query =>
        query.state.data?.pages.some(page =>
          page.items.some(session => sessionNeedsTitlePoll(session, Date.now())),
        )
          ? 1_000
          : false,
    }),
  children: (
    api: SpaApi,
    workspaceSlug: string,
    sessionId: string,
    filters: SessionChildrenFilters = { archived: 'exclude' },
    limit = 30,
  ) =>
    infiniteQueryOptions({
      queryKey: sessionKeys.children(workspaceSlug, sessionId, filters),
      queryFn: ({ pageParam, signal }) =>
        api.listSessionChildren(
          workspaceSlug,
          sessionId,
          {
            cursor: pageParam,
            limit,
            bucket: filters.bucket,
            archived: filters.archived,
          },
          signal,
        ),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: page => page.nextCursor,
      refetchInterval: query =>
        query.state.data?.pages.some(page =>
          page.items.some(session => sessionNeedsTitlePoll(session, Date.now())),
        )
          ? 1_000
          : false,
    }),
  detail: (api: SpaApi, workspaceSlug: string, sessionId: string) =>
    queryOptions({
      queryKey: sessionKeys.detail(workspaceSlug, sessionId),
      queryFn: ({ signal }) => api.getSession(workspaceSlug, sessionId, signal),
      refetchInterval: query => {
        const session = query.state.data
        if (sessionNeedsTitlePoll(session, Date.now()) || session?.deliveryAttempt !== undefined) {
          return 1_000
        }
        return session?.turnStatus === 'running' ? LIVE_TURN_POLL_MS : false
      },
    }),
  history: (api: SpaApi, queryClient: QueryClient, workspaceSlug: string, sessionId: string) =>
    queryOptions({
      queryKey: sessionKeys.history(workspaceSlug, sessionId),
      queryFn: async ({ signal }) =>
        mergeSessionHistory(
          chronologicalSessionHistory(
            await api.getSessionHistory(workspaceSlug, sessionId, { view: 'transcript' }, signal),
          ),
          queryClient.getQueryData<SessionChronologicalHistory>(
            sessionKeys.history(workspaceSlug, sessionId),
          ),
        ),
    }),
  audience: (api: SpaApi, workspaceSlug: string, sessionId: string, limit = 30) =>
    infiniteQueryOptions({
      queryKey: sessionKeys.audience(workspaceSlug, sessionId),
      queryFn: ({ pageParam, signal }) =>
        api.getSessionAudience(workspaceSlug, sessionId, { cursor: pageParam, limit }, signal),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: page => page.nextCursor,
    }),
}

export function useUpdateSessionAudience(workspaceSlug: string, sessionId: string) {
  const { api } = useSpa()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (delta: SessionAudienceDeltaRequest) =>
      api.updateSessionAudience(workspaceSlug, sessionId, delta),
    onSuccess: summary =>
      commitSessionAudienceUpdateCache(queryClient, workspaceSlug, sessionId, summary),
  })
}

export function commitSessionAudienceUpdateCache(
  queryClient: QueryClient,
  workspaceSlug: string,
  sessionId: string,
  summary: SessionSummary | null,
): void {
  queryClient.removeQueries({
    queryKey: sessionKeys.audience(workspaceSlug, sessionId),
  })
  if (summary === null) {
    commitRemovedSessionCache(queryClient, workspaceSlug, sessionId)
    return
  }
  patchSessionSummaryCaches(queryClient, workspaceSlug, summary)
  if (summary.archive.globalArchivedAt !== null) {
    removeSessionFromActiveListCaches(queryClient, workspaceSlug, sessionId)
  }
  void queryClient.invalidateQueries({
    queryKey: sessionKeys.lists(workspaceSlug),
  })
}

type SessionInputKind = 'message' | 'note' | 'answer'

type PendingSessionInput = {
  mutationId: number
  kind: SessionInputKind
  variables: unknown
  submittedAt: number
  cursorAtSubmit?: number
}

type SessionInputMutationContext = {
  cursorAtSubmit: number
  previousSnapshot?: SessionSnapshot
  optimisticSnapshot?: SessionSnapshot
  previousPreview?: MessagePreview
  optimisticPreview?: MessagePreview
}

export function createSessionDetailRefreshSignal(args: {
  invalidate: () => void
  invalidateChildren?: () => void
  isActive: () => boolean
  now?: () => number
  coalescingWindowMs?: number
}): (event: SessionTimelineEntry['event']) => void {
  const now = args.now ?? Date.now
  const coalescingWindowMs = args.coalescingWindowMs ?? 1_000
  let lastToolCallRefreshAt = Number.NEGATIVE_INFINITY

  return event => {
    if (!args.isActive()) return
    // An unknown-typed event (newer deploy, map D10) carries no status and no
    // step — nothing here can read it.
    if (!isKnownTimelineEvent(event)) return
    if (isTerminalStatus(statusFromEvent(event))) {
      args.invalidate()
      args.invalidateChildren?.()
      return
    }
    if (event.type !== 'step' || event.step.type !== 'tool_call') return
    const observedAt = now()
    if (observedAt - lastToolCallRefreshAt < coalescingWindowMs) return
    lastToolCallRefreshAt = observedAt
    args.invalidate()
    args.invalidateChildren?.()
  }
}

/**
 * The author the browser stamps on its own optimistic rows. Input typed in this
 * tab is always the signed-in person: a source session or an app is something
 * only the API can derive from a credential.
 */
export function useViewerInputSender(): SessionInputSender {
  const { identity } = useSpa()
  return useMemo<SessionInputSender>(
    () => ({ kind: 'user', userId: identity.user.id }),
    [identity.user.id],
  )
}

/**
 * One agent's — or the whole workspace's — sessions, optionally one bucket.
 *
 * `enabled` matters here because `agentId: undefined` is a *different filter*,
 * not a pending one: react-query drops the key and fetches the whole drive's
 * sessions. A caller still resolving its agent must wait rather than ask the
 * wrong question first. Carried verbatim from the job list this absorbed — the
 * hazard survived the merge even though the module did not.
 */
export function useSessionList(
  workspaceSlug: string,
  filters: SessionFilters,
  options: { enabled?: boolean } = {},
) {
  const { api } = useSpa()
  return useInfiniteQuery({
    ...sessionQueryOptions.list(api, workspaceSlug, filters),
    ...options,
  })
}

// `sessionId === undefined` keeps this hook mounted but dormant while a new
// session is still being created, so the chat surface can render the pending
// prompt and then adopt the real session without ever unmounting.
export function useSessionDetail(
  workspaceSlug: string,
  sessionId: string | undefined,
  onEvent?: (event: AgentSessionTimelineEvent) => void,
) {
  const { api } = useSpa()
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent
  const queryClient = useQueryClient()
  const cacheScope = useWorkspaceCacheScope(workspaceSlug)
  const enabled = sessionId !== undefined
  const queryId = sessionId ?? '__creating__'
  /* Opening a session is what marks it read, so the observer is bound here
     rather than at any of the three surfaces that mount this hook. It decides
     nothing on its own: presence and the coalescing window are the signal's. */
  const observeRead = useSessionReadStamp(workspaceSlug, sessionId)
  const ephemeralRef = useRef<SessionEphemeralFrame[]>([])
  const [, setEphemeralRevision] = useState(0)
  const [reconnectGeneration, setReconnectGeneration] = useState(0)
  const [isLoadingOlder, setIsLoadingOlder] = useState(false)
  const [loadOlderFailed, setLoadOlderFailed] = useState(false)
  const loadingOlderRef = useRef(false)
  const cursorRef = useRef(0)
  const cursorOwnerRef = useRef('')
  const ephemeralSequenceRef = useRef(0)
  const reconnectAttemptRef = useRef(0)
  const projectorRef = useRef(createIncrementalSessionProjector())
  const pendingInputs = useMutationState({
    filters: {
      mutationKey: duetMutationKeys.workspaces.sessions.inputs(workspaceSlug, queryId),
      status: 'pending',
    },
    select: mutation => {
      const context = mutation.state.context as SessionInputMutationContext | undefined
      return {
        mutationId: mutation.mutationId,
        kind: mutation.options.mutationKey?.at(-1) as SessionInputKind,
        variables: mutation.state.variables,
        submittedAt: mutation.state.submittedAt,
        cursorAtSubmit: context?.cursorAtSubmit,
      }
    },
  })
  const snapshot = useQuery({
    ...sessionQueryOptions.detail(api, workspaceSlug, queryId),
    enabled,
  })
  const history = useQuery({
    ...sessionQueryOptions.history(api, queryClient, workspaceSlug, queryId),
    enabled,
  })
  const cursorOwner = `${workspaceSlug}:${queryId}`
  const cursor = ownSessionCursor(
    cursorOwnerRef.current,
    cursorOwner,
    cursorRef.current,
    history.data,
  )
  cursorOwnerRef.current = cursor.owner
  cursorRef.current = cursor.value
  const reconciledSnapshot = useMemo(
    () => reconcileSessionSnapshot(snapshot.data, history.data),
    [history.data, snapshot.data],
  )
  const shouldOpenStream = shouldOpenSessionStream(
    snapshot.data,
    reconciledSnapshot,
    cursorRef.current,
    pendingInputs.length > 0,
  )

  useEffect(() => {
    ephemeralSequenceRef.current = 0
    reconnectAttemptRef.current = 0
    ephemeralRef.current = []
    setLoadOlderFailed(false)
    setEphemeralRevision(revision => revision + 1)
  }, [cursorOwner])

  useEffect(() => {
    if (!snapshot.isSuccess || !history.isSuccess || !shouldOpenStream) return
    let active = true
    const canWrite = () => active && cacheScope.isActive()
    ephemeralRef.current = []
    setEphemeralRevision(revision => revision + 1)
    ephemeralSequenceRef.current = 0
    let stream: ReturnType<typeof openSessionEventStream> | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    const refreshDetail = createSessionDetailRefreshSignal({
      invalidate: () => {
        void queryClient.invalidateQueries({
          queryKey: sessionKeys.detail(workspaceSlug, queryId),
          exact: true,
        })
      },
      invalidateChildren: () => {
        void queryClient.invalidateQueries({
          queryKey: sessionKeys.children(workspaceSlug, queryId),
        })
      },
      isActive: canWrite,
    })
    stream = openSessionEventStream({
      workspaceSlug,
      sessionId: queryId,
      afterSeq: cursorRef.current,
      onFrame: frame => {
        if (!canWrite()) return
        if (isKnownTimelineEvent(frame.event)) onEventRef.current?.(frame.event)
        reconnectAttemptRef.current = 0
        if (frame.seq !== undefined) {
          const durableSeq = frame.seq
          refreshDetail(frame.event)
          queryClient.setQueryData<SessionChronologicalHistory>(
            sessionKeys.history(workspaceSlug, queryId),
            current => appendDurableFrame(current, durableSeq, frame.event, frame.createdAt),
          )
          cursorRef.current = Math.max(cursorRef.current, durableSeq)
          observeRead(durableSeq)
          ephemeralRef.current = reconcileEphemeralFrames(
            ephemeralRef.current,
            durableSeq,
            frame.event,
          )
          setEphemeralRevision(revision => revision + 1)
          const current = queryClient.getQueryData<SessionSnapshot>(
            sessionKeys.detail(workspaceSlug, queryId),
          )
          if (isKnownTimelineEvent(frame.event)) {
            const preview = messagePreviewOf(frame.event)
            if (preview !== null)
              patchSessionChatPreviewCache(queryClient, workspaceSlug, queryId, preview)
          }
          if (current !== undefined) {
            patchSessionSummaryCaches(queryClient, workspaceSlug, {
              ...current,
              lastEventSeq: Math.max(current.lastEventSeq, durableSeq),
              turnStatus: statusFromEvent(frame.event) ?? current.turnStatus,
              updatedAt: Date.now(),
            })
          }
        } else {
          ephemeralSequenceRef.current += 1
          ephemeralRef.current.push({
            cursor: cursorRef.current,
            correlationId: eventCorrelation(frame.event, ephemeralSequenceRef.current),
            event: frame.event,
          })
          setEphemeralRevision(revision => revision + 1)
        }
      },
      onError: () => {
        if (!canWrite() || reconnectTimer !== undefined) return
        stream?.close()
        ephemeralRef.current = []
        setEphemeralRevision(revision => revision + 1)
        void queryClient.invalidateQueries({
          queryKey: sessionKeys.detail(workspaceSlug, queryId),
          exact: true,
        })
        void queryClient.invalidateQueries({
          queryKey: sessionKeys.history(workspaceSlug, queryId),
        })
        const delay = sessionReconnectDelay(reconnectAttemptRef.current)
        reconnectAttemptRef.current += 1
        reconnectTimer = setTimeout(() => {
          if (!canWrite()) return
          setReconnectGeneration(current => current + 1)
        }, delay)
      },
    })
    return () => {
      active = false
      stream?.close()
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
    }
  }, [
    cacheScope,
    history.isSuccess,
    observeRead,
    queryClient,
    queryId,
    reconciledSnapshot?.turnStatus,
    reconnectGeneration,
    shouldOpenStream,
    snapshot.data?.turnStatus,
    snapshot.isSuccess,
    workspaceSlug,
  ])

  /* The stream is not the only way a session gets read, and it is not even the
     main one: a session whose work *finished* while the reader was away opens no
     stream at all, and that is precisely the session carrying the unread mark.
     So the loaded snapshot is observed too — whatever seq the reader is looking
     at, however it arrived. */
  const loadedSeq = reconciledSnapshot?.lastEventSeq
  useEffect(() => {
    if (loadedSeq === undefined) return
    observeRead(loadedSeq)
  }, [loadedSeq, observeRead])

  const viewerSender = useViewerInputSender()
  const optimisticFrames = useMemo(() => {
    if (history.data === undefined) return []
    return pendingSessionInputFrames(
      pendingInputs,
      cursorRef.current,
      viewerSender,
      history.data.events,
    )
  }, [history.data, pendingInputs, viewerSender])
  const projected =
    reconciledSnapshot === undefined || history.data === undefined
      ? undefined
      : projectorRef.current.project({
          snapshot: reconciledSnapshot,
          durableEvents: history.data.events,
          durableGeneration: history.data.durableGeneration,
          ephemeralFrames: ephemeralRef.current,
          optimisticFrames,
          startsAtSeq: history.data.nextCursor === null ? 1 : history.data.events[0]?.seq,
          pagedThroughSeq: history.data.pagedThroughSeq,
        }).projection

  const loadOlder = async () => {
    const cursor = queryClient.getQueryData<SessionChronologicalHistory>(
      sessionKeys.history(workspaceSlug, queryId),
    )?.nextCursor
    if (cursor === null || cursor === undefined || loadingOlderRef.current) return
    loadingOlderRef.current = true
    setIsLoadingOlder(true)
    setLoadOlderFailed(false)
    try {
      const older = chronologicalSessionHistory(
        await api.getSessionHistory(workspaceSlug, queryId, { cursor, view: 'transcript' }),
      )
      if (!cacheScope.isActive()) return
      queryClient.setQueryData<SessionChronologicalHistory>(
        sessionKeys.history(workspaceSlug, queryId),
        current => (current === undefined ? older : prependOlderSessionHistory(current, older)),
      )
    } catch (error) {
      if (cacheScope.isActive()) setLoadOlderFailed(true)
      throw error
    } finally {
      loadingOlderRef.current = false
      if (cacheScope.isActive()) setIsLoadingOlder(false)
    }
  }

  return {
    snapshot: { ...snapshot, data: reconciledSnapshot },
    history,
    projected,
    loadOlder,
    isLoadingOlder,
    loadOlderFailed,
    hasOlder: history.data?.nextCursor != null,
  }
}

export function ownSessionCursor(
  previousOwner: string,
  nextOwner: string,
  previousCursor: number,
  history: SessionChronologicalHistory | undefined,
): { owner: string; value: number } {
  const historyCursor = history?.events.at(-1)?.seq ?? 0
  return {
    owner: nextOwner,
    value: previousOwner === nextOwner ? Math.max(previousCursor, historyCursor) : historyCursor,
  }
}

export function reconcileSessionSnapshot(
  snapshot: SessionSnapshot | undefined,
  history: SessionChronologicalHistory | undefined,
): SessionSnapshot | undefined {
  if (snapshot === undefined) return undefined
  const historyCursor = history?.events.at(-1)?.seq ?? 0
  // Only an event at or past the row's own last write can be newer than the
  // row: the control plane stamps the row's status in the mutation that
  // appends each event, so an older event's status is one the row has already
  // superseded.
  const durableStatus = [...(history?.events ?? [])]
    .filter(entry => entry.seq >= snapshot.lastEventSeq)
    .reverse()
    .map(entry => statusFromEvent(entry.event))
    .find(status => status !== undefined)
  return {
    ...snapshot,
    lastEventSeq: Math.max(snapshot.lastEventSeq, historyCursor),
    turnStatus: durableStatus ?? snapshot.turnStatus,
  }
}

export function sessionReconnectDelay(attempt: number): number {
  return Math.min(250 * 2 ** Math.max(0, attempt), 10_000)
}

export function shouldOpenSessionStream(
  canonicalSnapshot: SessionSnapshot | undefined,
  reconciledSnapshot: SessionSnapshot | undefined,
  historyCursor: number,
  hasPendingRunnerInput = false,
): boolean {
  if (canonicalSnapshot === undefined || reconciledSnapshot === undefined) return false
  return (
    hasPendingRunnerInput ||
    !isTerminalStatus(reconciledSnapshot.turnStatus) ||
    historyCursor < canonicalSnapshot.lastEventSeq
  )
}

export function useSessionActions(workspaceSlug: string, sessionId?: string) {
  const { api } = useSpa()
  const viewerSender = useViewerInputSender()
  const queryClient = useQueryClient()
  const cacheScope = useWorkspaceCacheScope(workspaceSlug)
  const reconciledMutations = useRef(new Set<string>())
  const invalidateLists = () =>
    queryClient.invalidateQueries({
      queryKey: sessionKeys.lists(workspaceSlug),
    })
  const refreshExactSession = async () => {
    if (sessionId === undefined || !cacheScope.isActive()) return
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(workspaceSlug, sessionId),
        exact: true,
      }),
      queryClient.invalidateQueries({
        queryKey: sessionKeys.history(workspaceSlug, sessionId),
        exact: true,
      }),
      invalidateLists(),
    ])
  }
  const captureInputCursor = (): SessionInputMutationContext => ({
    cursorAtSubmit:
      queryClient
        .getQueryData<SessionChronologicalHistory>(
          sessionKeys.history(workspaceSlug, required(sessionId)),
        )
        ?.events.at(-1)?.seq ?? 0,
  })
  const beginSessionInput = async (
    value: string,
    startsRunner: boolean,
    media: SentMedia,
  ): Promise<SessionInputMutationContext> => {
    const id = required(sessionId)
    await cancelSessionOptimisticQueries(queryClient, workspaceSlug, id)
    const context = captureInputCursor()
    if (!cacheScope.isActive()) return context
    const optimisticPreview = messagePreviewFromInput(viewerSender, value, media)
    const previewContext =
      optimisticPreview === null
        ? {}
        : {
            previousPreview: patchSessionChatPreviewCache(
              queryClient,
              workspaceSlug,
              id,
              optimisticPreview,
            ),
            optimisticPreview,
          }
    const previousSnapshot = queryClient.getQueryData<SessionSnapshot>(
      sessionKeys.detail(workspaceSlug, id),
    )
    if (previousSnapshot !== undefined) {
      const optimisticSnapshot = {
        ...previousSnapshot,
        ...(startsRunner ? { turnStatus: 'running' as const } : {}),
        updatedAt: Date.now(),
      } satisfies SessionSnapshot
      patchSessionSummaryCaches(queryClient, workspaceSlug, optimisticSnapshot)
      return { ...context, ...previewContext, previousSnapshot, optimisticSnapshot }
    }
    return { ...context, ...previewContext }
  }
  const restoreRunnerInput = (
    _error: unknown,
    _input: unknown,
    context?: SessionInputMutationContext,
  ) => {
    if (context === undefined || !cacheScope.isActive()) return
    if (context.optimisticPreview !== undefined)
      rollbackSessionChatPreviewCache(
        queryClient,
        workspaceSlug,
        required(sessionId),
        context.previousPreview,
        context.optimisticPreview,
      )
    if (context.previousSnapshot === undefined || context.optimisticSnapshot === undefined) return
    const key = sessionKeys.detail(workspaceSlug, context.previousSnapshot.id)
    rollbackSessionDetailFields(
      queryClient,
      key,
      context.previousSnapshot,
      context.optimisticSnapshot,
      [['turnStatus'], ['updatedAt']],
    )
    const current = queryClient.getQueryData<SessionSnapshot>(key)
    if (current !== undefined) patchSessionSummaryCaches(queryClient, workspaceSlug, current)
  }
  const reconcileInputAcceptance = async (
    kind: SessionInputKind,
    value: string,
    cursorAtSubmit: number,
    clientRequestId: string,
  ): Promise<boolean> => {
    const id = required(sessionId)
    if (!cacheScope.isActive()) return false
    try {
      const history = await queryClient.fetchQuery({
        ...sessionQueryOptions.history(api, queryClient, workspaceSlug, id),
        staleTime: 0,
      })
      if (!cacheScope.isActive()) return false
      return durableSessionInputExists(
        history.events,
        kind,
        value,
        cursorAtSubmit,
        viewerSender,
        clientRequestId,
      )
    } catch {
      return false
    }
  }
  const rememberReconciled = (key: string) => reconciledMutations.current.add(key)
  const consumeReconciled = (key: string): boolean => {
    const accepted = reconciledMutations.current.has(key)
    reconciledMutations.current.delete(key)
    return accepted
  }
  const reconcileRunnerInputError = async (
    error: unknown,
    kind: SessionInputKind,
    value: string,
    clientRequestId: string | undefined,
    context: SessionInputMutationContext | undefined,
  ) => {
    if (
      isDeterministicMutationError(error) ||
      clientRequestId === undefined ||
      context === undefined ||
      !cacheScope.isActive()
    ) {
      restoreRunnerInput(error, undefined, context)
      return
    }
    const accepted = await reconcileInputAcceptance(
      kind,
      value,
      context.cursorAtSubmit,
      clientRequestId,
    )
    if (accepted) {
      rememberReconciled(`input:${clientRequestId}`)
      return
    }
    restoreRunnerInput(error, undefined, context)
  }
  const reconcileSnapshotChange = async (
    key: string,
    matches: (snapshot: SessionSnapshot) => boolean,
  ): Promise<boolean> => {
    if (sessionId === undefined || !cacheScope.isActive()) return false
    try {
      const snapshot = await queryClient.fetchQuery({
        ...sessionQueryOptions.detail(api, workspaceSlug, sessionId),
        staleTime: 0,
      })
      if (!cacheScope.isActive()) return false
      patchSessionListCaches(queryClient, workspaceSlug, snapshot)
      if (!matches(snapshot)) return false
      rememberReconciled(key)
      return true
    } catch {
      return false
    }
  }
  const reconcileInterrupt = async (cursorAtSubmit: number): Promise<boolean> => {
    if (sessionId === undefined || !cacheScope.isActive()) return false
    try {
      const history = await queryClient.fetchQuery({
        ...sessionQueryOptions.history(api, queryClient, workspaceSlug, sessionId),
        staleTime: 0,
      })
      if (!cacheScope.isActive()) return false
      const accepted = history.events.some(
        entry => entry.seq > cursorAtSubmit && entry.event.type === 'interrupt_requested',
      )
      if (accepted) rememberReconciled('interrupt')
      return accepted
    } catch {
      return false
    }
  }
  const reconcileRemovedSession = async (error: unknown): Promise<void> => {
    if (
      sessionId === undefined ||
      !cacheScope.isActive() ||
      (isDeterministicMutationError(error) &&
        !(error instanceof DuetApiError && error.status === 404))
    )
      return
    try {
      await api.getSession(workspaceSlug, sessionId)
    } catch (readError) {
      if (cacheScope.isActive() && readError instanceof DuetApiError && readError.status === 404) {
        commitRemovedSessionCache(queryClient, workspaceSlug, sessionId)
        rememberReconciled('remove')
      }
    }
  }
  const metadataScope = {
    id: `duet:${workspaceSlug}:sessions:${sessionId ?? 'unselected'}:metadata`,
  }

  return {
    consumeReconciled,
    message: useMutation({
      mutationKey: duetMutationKeys.workspaces.sessions.input(
        workspaceSlug,
        sessionId ?? 'unselected',
        'message',
      ),
      mutationFn: (input: AgentMessageRequestInput) =>
        api.sendSessionMessage(workspaceSlug, required(sessionId), input),
      onMutate: input => beginSessionInput(input.prompt, true, input),
      onError: (error, input, context) =>
        reconcileRunnerInputError(error, 'message', input.prompt, input.clientRequestId, context),
      onSettled: refreshExactSession,
    }),
    note: useMutation({
      mutationKey: duetMutationKeys.workspaces.sessions.input(
        workspaceSlug,
        sessionId ?? 'unselected',
        'note',
      ),
      mutationFn: (input: AgentNoteRequest) =>
        api.addSessionNote(workspaceSlug, required(sessionId), input),
      onMutate: input => beginSessionInput(input.note, false, input),
      onError: (error, input, context) =>
        reconcileRunnerInputError(error, 'note', input.note, input.clientRequestId, context),
      onSettled: refreshExactSession,
    }),
    answer: useMutation({
      mutationKey: duetMutationKeys.workspaces.sessions.input(
        workspaceSlug,
        sessionId ?? 'unselected',
        'answer',
      ),
      mutationFn: (input: AgentAnswerRequest) =>
        api.answerSession(workspaceSlug, required(sessionId), input),
      onMutate: input => beginSessionInput(input.answer, true, input),
      onError: (error, input, context) =>
        reconcileRunnerInputError(error, 'answer', input.answer, input.clientRequestId, context),
      onSettled: refreshExactSession,
    }),
    interrupt: useMutation({
      mutationFn: () => api.interruptSession(workspaceSlug, required(sessionId)),
      onMutate: captureInputCursor,
      onError: (error, _input, context) =>
        isDeterministicMutationError(error) || context === undefined
          ? undefined
          : reconcileInterrupt(context.cursorAtSubmit),
      onSettled: refreshExactSession,
    }),
    rename: useMutation({
      scope: metadataScope,
      mutationFn: (title: string) => api.renameSession(workspaceSlug, required(sessionId), title),
      onMutate: async title => {
        const id = required(sessionId)
        const key = sessionKeys.detail(workspaceSlug, id)
        await cancelSessionOptimisticQueries(queryClient, workspaceSlug, id)
        if (!cacheScope.isActive()) return { key }
        let optimistic: SessionSnapshot | undefined
        const previous = patchSessionDetailCache(queryClient, key, current => {
          optimistic = {
            ...current,
            title,
            titleOrigin: 'manual',
            titleStatus: 'complete',
            updatedAt: Date.now(),
          }
          return optimistic
        })
        if (previous !== undefined && optimistic !== undefined) {
          patchSessionListCaches(queryClient, workspaceSlug, optimistic)
        }
        return { key, previous, optimistic }
      },
      onError: async (error, title, context) => {
        if (
          !isDeterministicMutationError(error) &&
          (await reconcileSnapshotChange(
            `rename:${title.trim()}`,
            snapshot => snapshot.title === title.trim(),
          ))
        )
          return
        if (!cacheScope.isActive()) return
        if (context?.previous !== undefined && context.optimistic !== undefined) {
          rollbackSessionDetailFields(
            queryClient,
            context.key,
            context.previous,
            context.optimistic,
            [['title', 'titleOrigin', 'titleStatus'], ['updatedAt']],
          )
          const current = queryClient.getQueryData<SessionSnapshot>(context.key)
          if (current !== undefined) patchSessionListCaches(queryClient, workspaceSlug, current)
        }
      },
      onSuccess: summary => {
        if (!cacheScope.isActive()) return
        commitSessionSummaryFields(queryClient, workspaceSlug, summary, [
          'title',
          'titleOrigin',
          'titleStatus',
          'updatedAt',
        ])
      },
      onSettled: refreshExactSession,
    }),
    archive: useMutation({
      scope: metadataScope,
      mutationFn: (input: { kind: 'personal' | 'global'; archived: boolean }) =>
        api.archiveSession(workspaceSlug, required(sessionId), input.kind, input.archived),
      onMutate: () => ({
        previousReason:
          queryClient.getQueryData<SessionSnapshot>(
            sessionKeys.detail(workspaceSlug, required(sessionId)),
          )?.archive.reason ?? null,
      }),
      onError: async (error, input, context) => {
        if (isDeterministicMutationError(error) || !cacheScope.isActive()) return
        try {
          const snapshot = await queryClient.fetchQuery({
            ...sessionQueryOptions.detail(api, workspaceSlug, required(sessionId)),
            staleTime: 0,
          })
          if (!cacheScope.isActive()) return
          const matches =
            (input.kind === 'global'
              ? snapshot.archive.globalArchivedAt !== null
              : snapshot.archive.personalArchivedAt !== null) === input.archived
          if (!matches) return
          commitSessionArchiveCache(
            queryClient,
            workspaceSlug,
            context?.previousReason ?? null,
            snapshot,
          )
          rememberReconciled(`archive:${input.kind}:${input.archived}`)
        } catch {
          return
        }
      },
      onSuccess: (summary, _input, context) => {
        if (!cacheScope.isActive()) return
        commitSessionArchiveCache(queryClient, workspaceSlug, context.previousReason, summary)
      },
      onSettled: refreshExactSession,
    }),
    remove: useMutation({
      mutationFn: () => api.deleteSession(workspaceSlug, required(sessionId)),
      onError: reconcileRemovedSession,
      onSuccess: () =>
        cacheScope.isActive()
          ? commitRemovedSessionCache(queryClient, workspaceSlug, required(sessionId))
          : undefined,
    }),
  }
}

/**
 * The rows the browser shows for input the server has not acknowledged yet.
 * They are authored by the person typing them and carry no durable sequence, so
 * they can never move the SSE resume cursor ahead of the real event.
 */
export function pendingSessionInputFrames(
  inputs: readonly PendingSessionInput[],
  cursor: number,
  sender: SessionInputSender,
  durableEvents: readonly SessionTimelineEntry[] = [],
): SessionEphemeralFrame[] {
  const orderedDurableEvents = [...durableEvents].sort((left, right) => left.seq - right.seq)
  const matchedDurableIndexes = new Set<number>()

  return inputs.flatMap(input => {
    const variables = input.variables
    const optimisticImages = parseOptimisticImages(variables)
    const optimisticAttachments = parseOptimisticAttachments(variables)
    let event: SessionTimelineEntry['event'] | undefined
    if (input.kind === 'message' && hasStringField(variables, 'prompt')) {
      event = {
        type: 'prompt_submitted',
        prompt: variables.prompt,
        inputKind: 'message',
        behavior:
          hasStringField(variables, 'behavior') && variables.behavior === 'follow_up'
            ? 'follow_up'
            : 'steer',
        sender,
        ...(hasStringField(variables, 'clientRequestId')
          ? { clientRequestId: variables.clientRequestId }
          : {}),
        ...(optimisticAttachments === undefined ? {} : { attachments: optimisticAttachments }),
      }
    } else if (input.kind === 'note' && hasStringField(variables, 'note')) {
      event = {
        type: 'note_submitted',
        note: variables.note,
        sender,
        ...(hasStringField(variables, 'clientRequestId')
          ? { clientRequestId: variables.clientRequestId }
          : {}),
        ...(optimisticAttachments === undefined ? {} : { attachments: optimisticAttachments }),
      }
    } else if (input.kind === 'answer' && hasStringField(variables, 'answer')) {
      event = {
        type: 'answer_submitted',
        answer: variables.answer,
        sender,
        ...(hasStringField(variables, 'clientRequestId')
          ? { clientRequestId: variables.clientRequestId }
          : {}),
        ...(optimisticAttachments === undefined ? {} : { attachments: optimisticAttachments }),
      }
    }
    if (event === undefined) return []

    const cursorAtSubmit = input.cursorAtSubmit ?? cursor
    const matchingDurableIndex = orderedDurableEvents.findIndex(
      (entry, index) =>
        !matchedDurableIndexes.has(index) &&
        entry.seq > cursorAtSubmit &&
        isMatchingSessionInput(event, entry.event),
    )
    if (matchingDurableIndex >= 0) {
      matchedDurableIndexes.add(matchingDurableIndex)
      return []
    }

    return [
      {
        cursor,
        correlationId: `optimistic:${input.kind}:${input.mutationId}`,
        createdAt: input.submittedAt,
        event,
        ...(optimisticImages === undefined ? {} : { optimisticImages }),
      },
    ]
  })
}

const OptimisticImagesSchema = AgentInputImageSchema.array().max(AGENT_INPUT_IMAGE_MAX_COUNT)
const OptimisticAttachmentsSchema = AgentEventAttachmentSchema.array().max(
  AGENT_INPUT_ATTACHMENT_MAX_COUNT,
)

function parseOptimisticImages(value: unknown) {
  if (typeof value !== 'object' || value === null || !('images' in value)) return undefined
  const parsed = OptimisticImagesSchema.safeParse(value.images)
  return parsed.success ? parsed.data : undefined
}

function parseOptimisticAttachments(value: unknown) {
  if (typeof value !== 'object' || value === null || !('attachments' in value)) return undefined
  const parsed = OptimisticAttachmentsSchema.safeParse(value.attachments)
  return parsed.success ? parsed.data : undefined
}

export function reconcileEphemeralFrames(
  frames: readonly SessionEphemeralFrame[],
  durableSeq: number,
  durableEvent: SessionTimelineEntry['event'],
): SessionEphemeralFrame[] {
  return frames.filter(
    frame =>
      frame.cursor !== durableSeq - 1 ||
      !durableEventSupersedesEphemeral(durableEvent, frame.event),
  )
}

function durableEventSupersedesEphemeral(
  durableEvent: SessionTimelineEntry['event'],
  ephemeralEvent: unknown,
): boolean {
  if (!isKnownTimelineEvent(durableEvent)) return false
  if (durableEvent.type !== 'step' || !hasStep(ephemeralEvent)) return false
  const durableStep = durableEvent.step
  const ephemeralStep = ephemeralEvent.step
  if (durableStep.type === 'text') return ephemeralStep.type === 'text_delta'
  if (durableStep.type === 'reasoning') return ephemeralStep.type === 'reasoning_delta'
  // Either half of a tool call retires the live frame that announced it. The
  // start is durable in its own right, so during a long call its row arrives
  // first and supersedes there — waiting for the completed call would hold
  // both copies for exactly as long as the call takes.
  if (durableStep.type !== 'tool_call' && durableStep.type !== 'tool_call_start') return false
  return (
    ephemeralStep.type === 'tool_call_start' && ephemeralStep.toolCallId === durableStep.toolCallId
  )
}

function hasStep(value: unknown): value is { step: Record<string, unknown> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'step' in value &&
    typeof value.step === 'object' &&
    value.step !== null
  )
}

/**
 * Whether the server already accepted this input, for a mutation whose response
 * was lost. Without a request id the only evidence is the payload, so the author
 * counts as part of it: two members can send the same words in the same second.
 */
export function durableSessionInputExists(
  events: readonly SessionTimelineEntry[],
  kind: SessionInputKind,
  value: string,
  cursorAtSubmit: number,
  sender: SessionInputSender,
  clientRequestId?: string,
): boolean {
  return events.some(entry => {
    if (entry.seq <= cursorAtSubmit) return false
    const durableRequestId = sessionInputClientRequestId(entry.event)
    if (clientRequestId !== undefined)
      return durableRequestId === clientRequestId && sessionInputKind(entry.event) === kind
    if (sessionInputKind(entry.event) !== kind) return false
    if (!isSameSender(sessionInputSender(entry.event), sender)) return false
    if (kind === 'message') {
      return entry.event.type === 'prompt_submitted' && entry.event.prompt === value
    }
    if (kind === 'note') return entry.event.type === 'note_submitted' && entry.event.note === value
    return entry.event.type === 'answer_submitted' && entry.event.answer === value
  })
}

function isMatchingSessionInput(
  expected: SessionTimelineEntry['event'],
  durable: SessionTimelineEntry['event'],
): boolean {
  const expectedRequestId = sessionInputClientRequestId(expected)
  const durableRequestId = sessionInputClientRequestId(durable)
  if (expectedRequestId !== undefined) {
    return (
      expectedRequestId === durableRequestId &&
      sessionInputKind(expected) === sessionInputKind(durable)
    )
  }
  if (!isSameSender(sessionInputSender(expected), sessionInputSender(durable))) return false
  switch (expected.type) {
    case 'prompt_submitted':
      return durable.type === 'prompt_submitted' && durable.prompt === expected.prompt
    case 'note_submitted':
      return durable.type === 'note_submitted' && durable.note === expected.note
    case 'answer_submitted':
      return durable.type === 'answer_submitted' && durable.answer === expected.answer
    default:
      return false
  }
}

function sessionInputSender(event: SessionTimelineEntry['event']): SessionInputSender | undefined {
  return isKnownTimelineEvent(event) && 'sender' in event ? event.sender : undefined
}

function isSameSender(
  left: SessionInputSender | undefined,
  right: SessionInputSender | undefined,
): boolean {
  return left !== undefined && right !== undefined && isSameInputSender(left, right)
}

function sessionInputClientRequestId(event: SessionTimelineEntry['event']): string | undefined {
  return 'clientRequestId' in event && typeof event.clientRequestId === 'string'
    ? event.clientRequestId
    : undefined
}

function sessionInputKind(event: SessionTimelineEntry['event']): SessionInputKind | undefined {
  if (event.type === 'prompt_submitted') return 'message'
  if (event.type === 'note_submitted') return 'note'
  if (event.type === 'answer_submitted') return 'answer'
  return undefined
}

function hasStringField<Key extends string>(
  value: unknown,
  key: Key,
): value is Record<Key, string> {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, key) === 'string'
}

function isDeterministicMutationError(error: unknown): boolean {
  return (
    error instanceof DuetApiError &&
    ((error.status >= 400 && error.status < 500) ||
      error.code === 'runner_unavailable' ||
      error.code === 'agent_gateway_failed' ||
      error.code === 'workspace_paused')
  )
}

/**
 * A durable frame joins the history cache under the row's own clock, so the
 * span the turn footer reads is the same one a later history load carries.
 * A frame from an API that predates the stamp gets its arrival time — the
 * only clock the browser has, and a refetch corrects it.
 */
export function appendDurableFrame(
  current: SessionChronologicalHistory | undefined,
  seq: number,
  event: SessionTimelineEntry['event'],
  createdAt: number | undefined,
): SessionChronologicalHistory {
  const events = current?.events ?? []
  const entry = { seq, event, createdAt: createdAt ?? Date.now() }
  const rest = {
    nextCursor: current?.nextCursor ?? null,
    pagedThroughSeq: current?.pagedThroughSeq ?? 0,
  }
  /* The stream delivers in order, so the ordinary frame is the next one and
     needs neither the scan for a duplicate nor the sort. This runs once per
     event against the whole cached transcript; on a conversation of tens of
     thousands of events those two passes were most of what a frame cost. */
  const last = events.at(-1)
  if (last === undefined || seq > last.seq)
    return {
      events: [...events, entry],
      ...rest,
      durableGeneration: current?.durableGeneration ?? crypto.randomUUID(),
    }

  if (events.some(held => held.seq === seq)) return current ?? { events, ...rest }
  return { events: [...events, entry].sort((a, b) => a.seq - b.seq), ...rest }
}

function eventCorrelation(event: SessionTimelineEntry['event'], sequence: number): string {
  if (isKnownTimelineEvent(event) && event.type === 'step' && 'toolCallId' in event.step)
    return event.step.toolCallId
  return `${event.type}:${sequence}`
}

function statusFromEvent(
  event: SessionTimelineEntry['event'],
): SessionSnapshot['turnStatus'] | undefined {
  switch (event.type) {
    case 'complete':
    case 'ask':
    case 'interrupted':
    case 'sleep':
      return event.type
    case 'turn_started':
    case 'session_created':
    case 'prompt_submitted':
    case 'answer_submitted':
      return 'running'
    default:
      return undefined
  }
}

function isTerminalStatus(status: SessionSnapshot['turnStatus'] | undefined): boolean {
  return status === 'complete' || status === 'ask' || status === 'interrupted' || status === 'sleep'
}

function required(value: string | undefined): string {
  if (value === undefined) throw new Error('A session must be selected')
  return value
}
