import { useQuery } from '@tanstack/react-query'

import { duetQueryKeys } from '../api/query-keys'
import type { SpaApi } from '../context'

/* ============================================================================
   The conversation that sets an agent up, opened by looking at it.

   A locked agent has exactly one thing to do and the surface gives it the
   whole card, so the conversation may as well be there rather than behind a
   button that goes somewhere else. Opening it on sight is safe because the
   endpoint is open-or-CREATE, keyed on the agent: the second look resumes the
   first look's session, and there is no way to end up with two.

   A POST behind `useQuery` rather than a mutation fired from an effect, and
   that is the honest shape here rather than a shortcut: this is a read of "the
   onboarding conversation for this agent" whose backing row happens to be
   created on first read. React Query then owns the deduplication — one request
   per agent across every mount, no effect racing a second one — which is
   exactly what a mutation in an effect would have to hand-build.
   ========================================================================= */

export function agentOnboardingSessionQueryOptions(
  api: Pick<SpaApi, 'openAgentOnboardingSession'>,
  workspaceSlug: string,
  agent: { id: string; slug: string },
) {
  const agentSlug = agent.slug
  return {
    /* Keyed by the ROW, addressed by the slug. The endpoint speaks slug, but a
       slug outlives the agent that wore it: delete an agent and reinstall it
       and the newcomer answers to the same slug with a fresh row and a fresh
       interview. Keyed by slug, `staleTime: Infinity` served the dead agent's
       conversation to its successor. */
    queryKey: duetQueryKeys.workspaces.agents.onboardingSession(workspaceSlug, agent.id),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api.openAgentOnboardingSession(workspaceSlug, agentSlug, signal),
    /* Once per agent per visit. The row is durable and the id cannot change
       under us — a second call would return the same session — so refetching
       buys nothing and costs a write path. */
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    /* One retry, because the failure the user actually hits is a cold VM
       answering slowly rather than a refusal. Past that the surface says so
       and offers the button, which is the same call again. */
    retry: 1,
  }
}

/**
 * The onboarding conversation for a locked agent, or nothing while it opens.
 *
 * `enabled` is the whole gate: an agent that is not locked, or whose setup is
 * an app rather than a conversation, must not have one created for it.
 *
 * `retry` is the failed read asked again — the one control the surface offers
 * when the open did not come back, and the same call it already made.
 */
export function useAgentOnboardingSession(
  api: Pick<SpaApi, 'openAgentOnboardingSession'>,
  workspaceSlug: string,
  agent: { id: string; slug: string } | undefined,
  enabled: boolean,
): { sessionId?: string; failed: boolean; retry: () => void } {
  const query = useQuery({
    ...agentOnboardingSessionQueryOptions(api, workspaceSlug, agent ?? { id: '', slug: '' }),
    enabled: enabled && agent !== undefined && agent.slug !== '',
  })
  return {
    ...(query.data === undefined ? {} : { sessionId: query.data.sessionId }),
    failed: query.isError,
    retry: () => void query.refetch(),
  }
}
