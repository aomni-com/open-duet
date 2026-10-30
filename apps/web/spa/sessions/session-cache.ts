import type { InfiniteData, QueryClient } from '@tanstack/react-query'

import {
  isSameInputSender,
  projectActivitySessionSummary,
  projectSessionListItem,
  ROOT_AGENT_SCOPE,
  SESSION_ACTIVITY_PRIORITY,
  SESSION_ACTIVITY_DEFAULT_LIMIT,
  type SessionActivityResponse,
  type ActivitySessionSummary,
  type ChatActivity,
  type SessionHistoryPage,
  type SessionInitialHistorySnapshot,
  type SessionListPage,
  type SessionListItem,
  type SessionSnapshot,
  type SessionSummary,
} from '@repo/contract'

import { duetQueryKeys } from '../api/query-keys'

const sessionKeys = duetQueryKeys.workspaces.sessions
type SessionSummaryField = keyof SessionSummary
type CachedSessionSummary = SessionSummary | SessionListItem

function isSessionListCacheData(data: unknown): data is InfiniteData<SessionListPage> {
  return data !== null && typeof data === 'object' && Array.isArray(Reflect.get(data, 'pages'))
}

/** Invalidate every server-owned collection and refresh the active views. */
export async function refreshCreatedSessionCollections(
  queryClient: QueryClient,
  workspaceSlug: string,
): Promise<void> {
  const keys = [sessionKeys.lists(workspaceSlug), sessionKeys.activity(workspaceSlug)] as const
  /* Invalidation normally cancels a refetch only after cached data exists. A
     first read still in flight has no data, so it would be reused even though
     it began before creation and cannot contain the new row. */
  await Promise.all(keys.map(queryKey => queryClient.cancelQueries({ queryKey })))
  await Promise.all(keys.map(queryKey => queryClient.invalidateQueries({ queryKey })))
}

export function findCachedSessionSummary(
  queryClient: QueryClient,
  workspaceSlug: string,
  sessionId: string,
): CachedSessionSummary | undefined {
  const detail = queryClient.getQueryData<SessionSnapshot>(
    sessionKeys.detail(workspaceSlug, sessionId),
  )
  if (detail !== undefined) return detail
  for (const [, data] of queryClient.getQueriesData<unknown>({
    queryKey: sessionKeys.lists(workspaceSlug),
  })) {
    if (!isSessionListCacheData(data)) continue
    const summary = data.pages.flatMap(page => page.items).find(session => session.id === sessionId)
    if (summary !== undefined) return summary
  }
  return undefined
}

export function patchSessionSummaryCaches(
  queryClient: QueryClient,
  workspaceSlug: string,
  summary: SessionSummary,
): void {
  queryClient.setQueryData<SessionSnapshot>(
    sessionKeys.detail(workspaceSlug, summary.id),
    current =>
      current === undefined ? current : preserveDurableTitle(current, { ...current, ...summary }),
  )
  patchSessionListCaches(queryClient, workspaceSlug, summary)
  patchSessionAsideCaches(queryClient, workspaceSlug, summary)
}

/** Keep the roster current before the server has an event-derived preview to return. */
export function patchSessionChatPreviewCache(
  queryClient: QueryClient,
  workspaceSlug: string,
  sessionId: string,
  preview: NonNullable<ChatActivity['preview']>,
): ChatActivity['preview'] {
  return replaceSessionChatPreviewCache(queryClient, workspaceSlug, sessionId, preview)
}

/** A late rejection cannot erase a newer send or server-authored reply. */
export function rollbackSessionChatPreviewCache(
  queryClient: QueryClient,
  workspaceSlug: string,
  sessionId: string,
  previous: ChatActivity['preview'],
  optimistic: NonNullable<ChatActivity['preview']>,
): void {
  replaceSessionChatPreviewCache(queryClient, workspaceSlug, sessionId, previous, optimistic)
}

function replaceSessionChatPreviewCache(
  queryClient: QueryClient,
  workspaceSlug: string,
  sessionId: string,
  replacement: ChatActivity['preview'],
  expected?: ChatActivity['preview'],
): ChatActivity['preview'] {
  let previous: ChatActivity['preview']
  queryClient.setQueryData<SessionActivityResponse>(
    sessionKeys.activity(workspaceSlug),
    current => {
      if (current === undefined) return current
      let touched = false
      const owners = current.owners.map(owner => {
        if (owner.chat?.id !== sessionId) return owner
        if (expected !== undefined && !sameMessagePreview(owner.chat.preview, expected))
          return owner
        touched = true
        previous = owner.chat.preview
        const chat: ChatActivity = { ...owner.chat }
        if (replacement === undefined) delete chat.preview
        else chat.preview = replacement
        return { ...owner, chat }
      })
      return touched ? { ...current, owners } : current
    },
  )
  return previous
}

function sameMessagePreview(
  left: ChatActivity['preview'],
  right: ChatActivity['preview'],
): boolean {
  if (left === undefined || right === undefined || left.text !== right.text) return false
  if (left.author.kind === 'agent' || right.author.kind === 'agent')
    return left.author.kind === right.author.kind
  return isSameInputSender(left.author, right.author)
}

/** Commit the server's lifecycle answer without inventing local archive state. */
export function commitSessionArchiveCache(
  queryClient: QueryClient,
  workspaceSlug: string,
  previousReason: SessionSummary['archive']['reason'],
  summary: SessionSummary,
): void {
  patchSessionSummaryCaches(queryClient, workspaceSlug, summary)
  if (previousReason === null && summary.archive.reason !== null) {
    removeSessionFromActiveListCaches(queryClient, workspaceSlug, summary.id)
  }
  void queryClient.invalidateQueries({ queryKey: sessionKeys.lists(workspaceSlug) })
}

export function commitSessionSummaryFields(
  queryClient: QueryClient,
  workspaceSlug: string,
  summary: CachedSessionSummary,
  fields: readonly SessionSummaryField[],
): void {
  let projected: CachedSessionSummary = summary
  queryClient.setQueryData<SessionSnapshot>(
    sessionKeys.detail(workspaceSlug, summary.id),
    current => {
      if (current === undefined) return current
      const next = copySessionSummaryFields(current, summary, fields)
      projected = next
      return next
    },
  )
  patchSessionListCaches(queryClient, workspaceSlug, projected, fields)
  patchSessionAsideCaches(queryClient, workspaceSlug, projected, fields)
}

/* ---------------------------------------------------------- the two asides

   `activity` and `default` are families of their own, deliberately outside
   `lists()` — see the note on `sessionKeys.activity`. That placement is right,
   and it is also why they were missed: every writer here reached `detail` and
   `lists`, so a session read cleared the dot on a list and left it lit on the
   map. This module is the one owner of *which caches a summary lives in*, so
   the fix is to complete the owner rather than add a second patcher beside it.

   Field-only patches preserve each aside's structure: the server seats the
   activity feed and an alias holds exactly one row. A full summary patch can
   cross an activity boundary, though, so it recomputes membership and order. */
function patchSessionAsideCaches(
  queryClient: QueryClient,
  workspaceSlug: string,
  summary: CachedSessionSummary,
  fields?: readonly SessionSummaryField[],
): void {
  const mergeSummary = <T extends SessionSummary>(current: T): T =>
    fields === undefined
      ? preserveDurableTitle(current, { ...current, ...summary } as T)
      : copySessionSummaryFields(current, summary, fields)
  const projectedActivity = projectActivitySessionSummary(summary)
  const mergeActivity = <T extends ActivitySessionSummary>(current: T): T => {
    if (fields === undefined) return mergeActivityProjection(current, projectedActivity)
    const next = { ...current }
    for (const field of fields) {
      if (
        field === 'title' ||
        field === 'bucket' ||
        field === 'updatedAt' ||
        field === 'unread' ||
        field === 'machine'
      ) {
        if (field === 'machine' && projectedActivity.machine === undefined) delete next.machine
        else Reflect.set(next, field, projectedActivity[field])
      }
    }
    return next
  }
  queryClient.setQueryData<SessionActivityResponse>(
    sessionKeys.activity(workspaceSlug),
    current => {
      if (current === undefined) return current
      if (fields === undefined) return reconcileSessionActivity(current, summary)
      let touched = false
      const owners = current.owners.map(owner => {
        /* Both halves of an owner, because this cache now holds both: the work
           it did, and the conversation it is. The mark the ring draws on a face
           lives on the second one — so a patcher that walked only `sessions`
           would leave a dot lit on a chat the reader is looking at, which is
           the one thing a read stamp exists to prevent. */
        const inChat = owner.chat?.id === summary.id
        if (!inChat && !owner.sessions.some(session => session.id === summary.id)) return owner
        touched = true
        return {
          ...owner,
          sessions: owner.sessions.map(session =>
            session.id === summary.id ? mergeActivity(session) : session,
          ),
          ...(inChat && owner.chat !== undefined ? { chat: mergeActivity(owner.chat) } : {}),
        }
      })
      return touched ? { ...current, owners } : current
    },
  )

  /* Every owner's alias at once: the key carries an agent slug this module has
     no way to know, and the session it is being handed belongs to exactly one
     of them. Patching by id over the family is the only honest lookup. */
  for (const query of queryClient
    .getQueryCache()
    .findAll({ queryKey: sessionKeys.defaults(workspaceSlug) })) {
    queryClient.setQueryData<SessionSnapshot | null>(query.queryKey, current =>
      // `null` is the alias's settled "no chat yet" answer, not an entry to patch.
      current == null || current.id !== summary.id ? current : mergeSummary(current),
    )
  }
}

function reconcileSessionActivity(
  current: SessionActivityResponse,
  summary: CachedSessionSummary,
): SessionActivityResponse {
  /* Full cache patches include optimistic and streamed status transitions. The
     server materialises `bucket`, but those client-authored summaries begin
     from the preceding snapshot, so carry the preceding bucket until this
     projection applies the shared contract rule. */
  const previous = current.owners
    .flatMap(owner => [...owner.sessions, ...(owner.chat === undefined ? [] : [owner.chat])])
    .find(session => session.id === summary.id)
  const projectedSummary = projectActivitySessionSummary(summary)
  // Activity rows deliberately omit title provenance. An excerpt is the only
  // provisional title, so it may seat a new row but cannot replace any title
  // this feed already observed. Auto and manual titles remain authoritative.
  const projected =
    summary.titleOrigin === 'excerpt' && previous !== undefined
      ? { ...projectedSummary, title: previous.title }
      : projectedSummary
  const ownerId = summary.agent?.id ?? ROOT_AGENT_SCOPE

  /* ---- an owner's own chat is not work, and this is where that is easiest to
     forget ----
     The row being patched may be somebody's chat, and the wire keeps those out
     of `sessions` on purpose. Re-seating one here is how the conversation the
     reader is *having* becomes a job bead on the face beside it — every durable
     frame of that conversation comes through this function. So the chat is
     patched where it lives and the work below is left alone. */
  const chatOwner = current.owners.find(owner => owner.chat?.id === projected.id)
  if (chatOwner !== undefined) {
    /* `projected`, not `summary`: every frame through this door is
       client-authored from the preceding snapshot and arrives carrying the
       *preceding* bucket. The work path below projects it; skipping that here
       would leave a chat that just finished drawing itself as running on the
       face until the next poll.

       Merged onto the entry rather than replacing it, because lifecycle
       summaries have no preview opinion. Durable events and optimistic inputs
       update that field through its own cache owner; overwriting here would
       make the roster's newest band blink out until the next activity read. */
    return {
      owners: current.owners.map(owner =>
        owner.chat?.id === projected.id
          ? { ...owner, chat: mergeActivityProjection(owner.chat, projected) }
          : owner,
      ),
    }
  }

  const owners = current.owners
    .map(owner => ({
      ...owner,
      sessions: owner.sessions.filter(session => session.id !== projected.id),
    }))
    /* A chat is enough to keep an owner: the server emits owners whose only
       session is the conversation you have with them, and dropping those here
       takes the face's chat bead, its unread dot, and the id the `excludeDefault`
       withhold is drawn from — on any frame of any unrelated session. */
    .filter(owner => owner.sessions.length > 0 || owner.truncated || owner.chat !== undefined)

  const visible = summary.onboarding !== true && summary.archive.reason === null
  if (visible) {
    const existing = owners.find(owner => owner.agentId === ownerId)
    if (existing === undefined) {
      owners.push({
        agentId: ownerId,
        sessions: [projected],
        truncated: false,
      })
      /* No `chat` on a freshly-invented owner, and that is honest rather than
         lossy: this client has never been told what that owner's chat is. The
         next answer from the wire carries it. */
    } else {
      const sessions = [...existing.sessions, projected].sort(compareActivitySessions)
      existing.sessions = sessions.slice(0, SESSION_ACTIVITY_DEFAULT_LIMIT)
      existing.truncated = existing.truncated || sessions.length > existing.sessions.length
    }
  }

  owners.sort((left, right) => newestActivityAt(right.sessions) - newestActivityAt(left.sessions))
  return { owners }
}

function compareActivitySessions(
  left: ActivitySessionSummary,
  right: ActivitySessionSummary,
): number {
  return (
    SESSION_ACTIVITY_PRIORITY.indexOf(left.bucket) -
      SESSION_ACTIVITY_PRIORITY.indexOf(right.bucket) || right.updatedAt - left.updatedAt
  )
}

function newestActivityAt(sessions: readonly ActivitySessionSummary[]): number {
  return sessions.reduce((newest, session) => Math.max(newest, session.updatedAt), 0)
}

function mergeActivityProjection<T extends ActivitySessionSummary>(
  current: T,
  projected: ActivitySessionSummary,
): T {
  const next = { ...current, ...projected }
  if (projected.machine === undefined) delete next.machine
  return next
}

export function patchSessionListCaches(
  queryClient: QueryClient,
  workspaceSlug: string,
  summary: CachedSessionSummary,
  fields?: readonly SessionSummaryField[],
): void {
  for (const query of queryClient
    .getQueryCache()
    .findAll({ queryKey: sessionKeys.lists(workspaceSlug) })) {
    queryClient.setQueryData<unknown>(query.queryKey, (current: unknown) => {
      /* Persisted entries outlive the bundle that wrote their query key, so a
         prefix match alone cannot prove that the value still has list shape. */
      if (!isSessionListCacheData(current)) return current
      const projected = hasFullMachine(summary) ? projectSessionListItem(summary) : summary
      let found: SessionListItem | undefined
      const pages = current.pages.map(page => ({
        ...page,
        items: page.items.map(session => {
          if (session.id !== summary.id) return session
          found = session
          return fields === undefined
            ? preserveDurableTitle(session, projected)
            : copySessionListItemFields(session, projected, fields)
        }),
      }))
      // List membership is server policy. A local event may update a row this
      // exact answer already contained, but never invent one for a filtered page.
      if (found === undefined) return current
      const ordered = pages
        .flatMap(page => page.items)
        .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))
      let offset = 0
      for (let index = 0; index < pages.length; index += 1) {
        const page = pages[index]!
        const length = page.items.length
        pages[index] = { ...page, items: ordered.slice(offset, offset + length) }
        offset += length
      }
      return { ...current, pages }
    })
  }
}

/** A server-confirmed global archive leaves detail usable for archive views but
 * must disappear synchronously from every active-session page. */
export function removeSessionFromActiveListCaches(
  queryClient: QueryClient,
  workspaceSlug: string,
  sessionId: string,
): void {
  for (const query of queryClient
    .getQueryCache()
    .findAll({ queryKey: sessionKeys.lists(workspaceSlug) })) {
    const tail = query.queryKey.at(-1) as { filters?: { archived?: string } } | undefined
    if (tail?.filters?.archived !== 'exclude') continue
    queryClient.setQueryData<InfiniteData<SessionListPage>>(query.queryKey, current =>
      current === undefined
        ? current
        : {
            ...current,
            pages: current.pages.map(page => ({
              ...page,
              items: page.items.filter(session => session.id !== sessionId),
            })),
          },
    )
  }
}

/**
 * Excerpt titles are scaffolding while generation is in flight. Once a cache
 * has observed an automatic or manual title, a streamed frame copied from an
 * older detail snapshot may update live state but must never restore that
 * scaffolding. Explicit title mutations use the field-only commit path and are
 * therefore still free to replace one durable title with another.
 */
function preserveDurableTitle<T extends CachedSessionSummary>(
  current: CachedSessionSummary,
  incoming: T,
): T {
  if (current.titleOrigin === 'excerpt') return incoming
  if (current.titleOrigin === 'auto' && incoming.titleOrigin === 'manual') return incoming
  return {
    ...incoming,
    title: current.title,
    titleOrigin: current.titleOrigin,
    titleStatus: current.titleStatus,
  }
}

function hasFullMachine(
  summary: CachedSessionSummary,
): summary is SessionSummary & { machine: NonNullable<SessionSummary['machine']> } {
  return summary.machine !== undefined && 'orderedPath' in summary.machine
}

function copySessionListItemFields(
  current: SessionListItem,
  projected: SessionListItem,
  fields: readonly SessionSummaryField[],
): SessionListItem {
  const next = { ...current }
  for (const field of fields) {
    Reflect.set(
      next,
      field,
      field === 'updatedAt' ? Math.max(current.updatedAt, projected.updatedAt) : projected[field],
    )
  }
  return next
}

function copySessionSummaryFields<T extends CachedSessionSummary>(
  current: T,
  summary: CachedSessionSummary,
  fields: readonly SessionSummaryField[],
): T {
  const next = { ...current }
  for (const field of fields) {
    Reflect.set(
      next,
      field,
      field === 'updatedAt' ? Math.max(current.updatedAt, summary.updatedAt) : summary[field],
    )
  }
  return next
}

export async function cancelSessionOptimisticQueries(
  queryClient: QueryClient,
  workspaceSlug: string,
  sessionId: string,
): Promise<void> {
  await Promise.all([
    queryClient.cancelQueries({
      queryKey: sessionKeys.detail(workspaceSlug, sessionId),
      exact: true,
    }),
    queryClient.cancelQueries({ queryKey: sessionKeys.lists(workspaceSlug) }),
    queryClient.cancelQueries({
      queryKey: sessionKeys.activity(workspaceSlug),
      exact: true,
    }),
  ])
}

export function commitRemovedSessionCache(
  queryClient: QueryClient,
  workspaceSlug: string,
  sessionId: string,
): void {
  /* The server alone decides whether deletion clears a default pointer. Evict
     every collection/aside family so its next read receives that answer;
     writing a synthetic null here would make the browser a second owner. */
  queryClient.removeQueries({ queryKey: sessionKeys.lists(workspaceSlug) })
  queryClient.removeQueries({ queryKey: sessionKeys.activity(workspaceSlug), exact: true })
  queryClient.removeQueries({ queryKey: sessionKeys.defaults(workspaceSlug) })
  queryClient.removeQueries({
    queryKey: sessionKeys.detail(workspaceSlug, sessionId),
    exact: true,
  })
  queryClient.removeQueries({
    queryKey: sessionKeys.history(workspaceSlug, sessionId),
    exact: true,
  })
  queryClient.removeQueries({
    queryKey: sessionKeys.audience(workspaceSlug, sessionId),
    exact: true,
  })
}

/**
 * Put a just-created session's own answer where its surface will look for it.
 *
 * The create response carries the whole conversation — the snapshot and the
 * history — because the server has just written both. The surface that opens on
 * it next is a *different* mount (the address changed, so the pane is keyed to
 * a session id it did not have a moment ago), and without this it would ask the
 * server for what the reply in hand already said: a skeleton beat on the one
 * screen where the reader has just pressed Send and is watching.
 *
 * Not an optimistic patch — nothing here is guessed. It is the server's own
 * response, filed under the keys that response answers.
 */
export function seedCreatedSessionCache(
  queryClient: QueryClient,
  workspaceSlug: string,
  snapshot: SessionSnapshot,
  history: SessionInitialHistorySnapshot,
): void {
  queryClient.setQueryData<SessionSnapshot>(
    sessionKeys.detail(workspaceSlug, snapshot.id),
    snapshot,
  )
  queryClient.setQueryData<SessionChronologicalHistory>(
    sessionKeys.history(workspaceSlug, snapshot.id),
    { events: history.events, nextCursor: null, pagedThroughSeq: history.events.at(-1)?.seq ?? 0 },
  )
}

export function patchSessionDetailCache(
  queryClient: QueryClient,
  key: ReturnType<typeof sessionKeys.detail>,
  patch: (current: SessionSnapshot) => SessionSnapshot,
): SessionSnapshot | undefined {
  const previous = queryClient.getQueryData<SessionSnapshot>(key)
  if (previous !== undefined) queryClient.setQueryData(key, patch(previous))
  return previous
}

export function rollbackSessionDetailFields(
  queryClient: QueryClient,
  key: ReturnType<typeof sessionKeys.detail>,
  previous: SessionSnapshot,
  optimistic: SessionSnapshot,
  fieldGroups: ReadonlyArray<ReadonlyArray<keyof SessionSnapshot>>,
): void {
  queryClient.setQueryData<SessionSnapshot>(key, current => {
    if (current === undefined) return current
    let restored = current
    for (const fields of fieldGroups) {
      if (!fields.every(field => Object.is(current[field], optimistic[field]))) continue
      restored = { ...restored }
      for (const field of fields) Reflect.set(restored, field, previous[field])
    }
    return restored
  })
}

export type SessionChronologicalHistory = {
  /** Browser-cache lineage, retained only for ordered stream appends. */
  durableGeneration?: string
  events: SessionHistoryPage['items']
  nextCursor: string | null
  /**
   * The newest seq a history page delivered, 0 before any page. Transcript
   * pages skip the task rail by design, so below this line a hole between two
   * rows is normal; above it every row arrived by stream, and a hole is a real
   * gap.
   */
  pagedThroughSeq: number
}

/** The route is newest-first; the UI cache is always chronological. */
export function chronologicalSessionHistory(page: SessionHistoryPage): SessionChronologicalHistory {
  return {
    events: page.items.toReversed(),
    nextCursor: page.nextCursor,
    pagedThroughSeq: page.items[0]?.seq ?? 0,
  }
}

export function mergeSessionHistory(
  canonical: SessionChronologicalHistory,
  live: SessionChronologicalHistory | undefined,
): SessionChronologicalHistory {
  if (live === undefined) return canonical
  // A fresh page covers everything from its oldest row up. It connects to the
  // cache when the cache's newest row reaches into that range; a cached prefix
  // it does not reach would be a gap, and the projection stops at a gap and
  // shows the prefix; nothing fills one. What is dropped stays reachable
  // through the canonical page's opaque cursor, the way older pages always are.
  const canonicalFloor = canonical.events[0]?.seq
  const liveCeiling = live.events.at(-1)?.seq
  const connected =
    canonical.nextCursor === null ||
    canonicalFloor === undefined ||
    liveCeiling === undefined ||
    canonicalFloor <= liveCeiling + 1
  if (!connected) return canonical
  const bySequence = new Map(live.events.map(event => [event.seq, event]))
  for (const event of canonical.events) bySequence.set(event.seq, event)
  const ordered = [...bySequence.values()].sort((left, right) => left.seq - right.seq)
  const liveStartsEarlier =
    live.events[0] !== undefined &&
    canonical.events[0] !== undefined &&
    live.events[0].seq < canonical.events[0].seq
  const nextCursor = liveStartsEarlier ? live.nextCursor : canonical.nextCursor
  return {
    events: ordered,
    nextCursor,
    pagedThroughSeq: Math.max(live.pagedThroughSeq, canonical.pagedThroughSeq),
  }
}

export function prependOlderSessionHistory(
  current: SessionChronologicalHistory,
  older: SessionChronologicalHistory,
): SessionChronologicalHistory {
  const bySequence = new Map(current.events.map(event => [event.seq, event]))
  for (const event of older.events) bySequence.set(event.seq, event)
  return {
    events: [...bySequence.values()].sort((left, right) => left.seq - right.seq),
    nextCursor: older.nextCursor,
    pagedThroughSeq: current.pagedThroughSeq,
  }
}
