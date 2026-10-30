'use client'

/* ============================================================================
   What to re-ask when the reader crosses a boundary.

   ---- why this has to exist at all ----
   The activity read is shared: the graph and every agent draw from the same
   cache entry, and moving between them does not remount it. So the ordinary
   React Query answer to "re-ask when it comes back on screen" —
   `refetchOnMount` — never gets a chance to fire, and the only ordinary
   remaining trigger is a window focus the reader may never give it.

   This module is only about those crossings. **How often the read ticks at all
   is a different question and lives with the other poll rules**, in
   `api/query-options.ts` — it used to be here, which had this file exporting a
   rate that `query-options` imported backwards.

   Meanwhile the conversation they opened writes into the very caches the ring
   draws its dot from: the read stamp and every streamed frame patch `unread:
   false` onto the default chat (`session-cache.ts`). That patch is right —
   they *are* reading it — and it is one-directional by nature. `unread` is the
   server's fact about a reader (their cursor against the session's last event),
   so a client can seed it false and can never seed it true: the events that
   make it true land after they left, down a stream that closed behind them.

   Cleared from the client, re-lit only by the server. Something has to ask.

   ---- so this asks, once, on the way out ----
   On the way out is where the ask buys something — it is the moment the dots
   come back on screen, and the moment the reader's own idea of what is unread
   has just changed.

   Only the one family the ring is drawn from. The reader's session list is a
   different surface with a cursor, and re-asking it here would spend a page
   fetch on something nobody is looking at.

   ---- and the reader who never left ----
   The other half of the same bug is the reader sitting on the graph when the
   agent finishes. No navigation happens, so the paragraph above never fires.
   That half is now structural rather than scheduled: the drive-wide activity
   read answers every owner's own chat beside its work (`AgentActivitySchema`),
   so the poll that keeps the faces fresh keeps their dots fresh too. There is
   no second read to chase, and nothing here has to notice that one moved.
   ========================================================================= */
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { ROOT_AGENT_SCOPE, type SessionActivityResponse } from '@repo/contract'

import { duetQueryKeys } from '../api/query-keys'

/**
 * Whether the reader has just come back out to the ring.
 *
 * The edge, not the state. Firing while they are inside an agent would spend a
 * request behind a surface that draws no dots, and firing on every render of
 * the ring would be a second poll on a read that already has one.
 */
export function ringReturned(wasUnfolded: boolean, unfolded: boolean): boolean {
  return wasUnfolded && !unfolded
}

/**
 * Re-ask what the ring draws: every owner's own chat, and the work under the
 * faces.
 *
 * `invalidateQueries` rather than a hand-written `setQueryData`, because the
 * answer is the server's — this says "what I hold may no longer be true", which
 * is the only honest thing a client can say about somebody else's unread.
 */
export function refreshRingUnread(queryClient: QueryClient, workspaceSlug: string): void {
  void queryClient.invalidateQueries({
    queryKey: duetQueryKeys.workspaces.sessions.activity(workspaceSlug),
  })
}

/**
 * Activity is server-grouped from the current agent table, so a non-root owner
 * missing from the browser's roster is proof that the roster cache is stale.
 * Re-ask that one list; without it the activity row has no face to join onto.
 */
export function refreshAgentRosterForUnknownOwners(
  queryClient: QueryClient,
  workspaceSlug: string,
  hasUnknownOwners: boolean,
): void {
  if (!hasUnknownOwners) return
  void queryClient.invalidateQueries({
    queryKey: duetQueryKeys.workspaces.agents.list(workspaceSlug),
  })
}

export function hasUnknownActivityOwner(
  knownAgentIds: ReadonlySet<string>,
  activity: SessionActivityResponse | undefined,
): boolean {
  return (
    activity?.owners.some(
      owner => owner.agentId !== ROOT_AGENT_SCOPE && !knownAgentIds.has(owner.agentId),
    ) === true
  )
}

/**
 * Bind the refreshes to the transitions that earn them.
 *
 * `unfolded` is read off the URL — which agent, if any, the reader is inside —
 * so this cannot disagree with what is on screen. The previous value is a ref
 * rather than state: nothing renders differently because of it, and making it
 * state would render the whole map twice per zoom.
 */
export function useRingFreshness(
  workspaceSlug: string,
  {
    unfolded,
    activity,
    knownAgentIds,
  }: {
    unfolded: boolean
    activity: SessionActivityResponse | undefined
    knownAgentIds: ReadonlySet<string>
  },
): void {
  const queryClient = useQueryClient()
  const wasUnfolded = useRef(false)
  const hasUnknownOwners = hasUnknownActivityOwner(knownAgentIds, activity)
  useEffect(() => {
    /* The edge itself, asked directly: with one read behind this surface there
       is one thing to decide and `ringReturned` is the whole of it. It used to
       be wrapped in a three-armed verdict because a second read could be
       refreshed on its own. */
    const returned = ringReturned(wasUnfolded.current, unfolded)
    wasUnfolded.current = unfolded
    if (returned) refreshRingUnread(queryClient, workspaceSlug)
  }, [queryClient, unfolded, workspaceSlug])
  useEffect(() => {
    refreshAgentRosterForUnknownOwners(queryClient, workspaceSlug, hasUnknownOwners)
  }, [hasUnknownOwners, queryClient, workspaceSlug])
}
