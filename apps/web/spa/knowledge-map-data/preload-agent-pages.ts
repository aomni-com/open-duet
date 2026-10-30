'use client'

/* ============================================================================
   Warming every agent's page while the reader is still deciding which to open.

   Flying between agents is the product's ordinary gesture, and each landing
   used to pay a skeleton for reads that were entirely predictable the moment
   the drive's roster answered: the agent's `agent.json` (the one read the
   full-page skeleton gates on), its default chat and that chat's transcript,
   its skills, the line it describes itself with, and its folder. This asks for
   all of it once, up front, through the same option factories the page mounts
   with — a prefetch that lands under any other key is a prefetch for nobody.

   ---- the cost, stated ----
   This is a deliberate exception to "read one agent at a time" (the
   performance ledger's P12 removed exactly this fan-out from the session
   surface's critical path). The difference is where it sits: nothing waits on
   these reads, they run once per workspace visit rather than per navigation,
   and the fleet is bounded by the 50-agent workspace ceiling. They run a few
   agents at a time so the burst cannot crowd out the landing page's own
   critical reads, and they never poll — keeping a page *live* stays the job of
   the queries the page mounts, with their own focus/poll rules.

   ---- and the scope of that exception, stated ----
   The description read (`agentRoleQueryOptions`) is the one warmed read that is
   not about opening an agent. The roster is a permanent column beside every
   destination in the agents section, so each of its rows reads its own agent's
   `AGENTS.md` to paint: leaving it out would not remove that fan-out, only move
   it onto the landing's critical path as one uncoordinated read per row. It
   costs an owner's width — five reads at once rather than four. A read no
   surface draws, or one an agent's own page can ask for when it opens, does not
   belong here.

   Nothing here sets a retention of its own. A warmed entry has no observer
   until somebody opens that agent, and outliving that gap is exactly what the
   client's own `gcTime` is for (`api/query-client.ts`) — one owner for how
   long an unwatched answer lives, rather than a second, shorter clock over
   the entries that can least afford one. Stale is fine, because the page
   revalidates in the background on mount; gone is a skeleton.
   ========================================================================= */
import {
  useQueryClient,
  type FetchQueryOptions,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query'
import { useEffect } from 'react'

import { ROOT_AGENT_SCOPE, type Agent } from '@repo/contract'

import { collectionItems, duetQueryOptions } from '../api/query-options'
import { useSpa, type SpaApi } from '../context'
import { agentConfigQueryOptions } from '../drive/agent-config'
import { agentRoleQueryOptions, agentSkillsQueryOptions } from '../drive/agent-profile'
import { defaultChatQueryOptions } from '../sessions/default-chat'
import { sessionQueryOptions } from '../sessions/session-data'
import { agentFilesQueryOptions } from './use-agent-reads'

/** Owners warmed together; the rest queue behind them. */
const OWNERS_AT_A_TIME = 4

type AgentRef = Pick<Agent, 'id' | 'slug' | 'anchorPath'>

/**
 * Warm everything an agent page waits on, for every agent handed in — plus the
 * drive root's own chat, which is the map's centre, and its own description,
 * which is Duet's row on the roster. Resolves when the fleet is done; a read
 * that fails is that page's problem to retell on open, never a reason to leave
 * the rest of the fleet cold.
 *
 * `isCancelled` is consulted between batches: leaving the workspace removes
 * its cache entries wholesale, and a preload that kept marching would recreate
 * entries for a drive the reader just left. A batch already in flight is let
 * finish — it is bounded, and its entries are removed by the same transition.
 */
export async function preloadAgentPages(
  api: SpaApi,
  queryClient: QueryClient,
  workspaceSlug: string,
  agents: readonly AgentRef[],
  isCancelled: () => boolean = () => false,
): Promise<void> {
  const prefetch = <TData, TKey extends QueryKey>(
    options: FetchQueryOptions<TData, Error, TData, TKey>,
  ) => queryClient.prefetchQuery(options)

  /* `null` for the ordinary "no chat yet" and for a failed read alike: a
     transcript can only be asked for under an id this alias answers with. */
  const readChat = (ownerSlug: string) =>
    queryClient
      .ensureQueryData(defaultChatQueryOptions(api, workspaceSlug, ownerSlug))
      .catch(() => null)

  const warmTranscript = async (chat: { id: string } | null) => {
    if (chat == null) return
    await Promise.all([
      prefetch(sessionQueryOptions.detail(api, workspaceSlug, chat.id)),
      prefetch(sessionQueryOptions.history(api, queryClient, workspaceSlug, chat.id)),
    ])
  }

  /* The transcript reads wait for the whole first wave rather than starting
     the moment the alias lands: the ceiling below is owners × this width, and
     a fast alias next to a slow folder read would stack six reads where the
     ceiling says five. */
  const warmAgent = async (agent: AgentRef) => {
    const [chat] = await Promise.all([
      readChat(agent.slug),
      prefetch(agentConfigQueryOptions(api, workspaceSlug, agent)),
      queryClient.prefetchInfiniteQuery(agentSkillsQueryOptions(api, workspaceSlug, agent)),
      prefetch(agentRoleQueryOptions(api, workspaceSlug, agent)),
      queryClient.prefetchInfiniteQuery(
        agentFilesQueryOptions(api, workspaceSlug, agent.anchorPath),
      ),
    ])
    await warmTranscript(chat)
  }

  /* The drive root is an owner like any other: the map's centre conversation,
     and — because the roster draws Duet as a row of its own — the line under
     that row, which is the drive root's `AGENTS.md`. Its anchor is the empty
     path; `agent-profile.ts` is what knows how to address a file there. */
  const warmRoot = async () => {
    const [chat] = await Promise.all([
      readChat(ROOT_AGENT_SCOPE),
      prefetch(agentRoleQueryOptions(api, workspaceSlug, { id: ROOT_AGENT_SCOPE, anchorPath: '' })),
    ])
    await warmTranscript(chat)
  }

  const owners: ReadonlyArray<() => Promise<void>> = [
    warmRoot,
    ...agents.map(agent => () => warmAgent(agent)),
  ]
  for (let at = 0; at < owners.length; at += OWNERS_AT_A_TIME) {
    if (isCancelled()) return
    await Promise.all(owners.slice(at, at + OWNERS_AT_A_TIME).map(warm => warm()))
  }
}

/**
 * Run the preload once per workspace visit, off the roster the landing surface
 * reads anyway (same cache entry — the roster is never asked for twice).
 *
 * Mounted only once the workspace is the *active* one: switching workspaces
 * removes the previous slug's cache wholesale, and a preload racing that
 * transition would either be wiped or warm a drive the reader just left.
 * An agent registered after landing is not chased — its first open pays the
 * ordinary skeleton once, and the next visit finds it warmed.
 */
export function usePreloadAgentPages(workspaceSlug: string): void {
  const { api } = useSpa()
  const queryClient = useQueryClient()
  useEffect(() => {
    let cancelled = false
    void queryClient
      .ensureInfiniteQueryData(duetQueryOptions.workspaces.agents(api, workspaceSlug))
      .then(roster => {
        if (cancelled) return
        return preloadAgentPages(
          api,
          queryClient,
          workspaceSlug,
          collectionItems(roster),
          () => cancelled,
        )
      })
      /* A roster that never answers is the landing page's error to tell. */
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [api, queryClient, workspaceSlug])
}
