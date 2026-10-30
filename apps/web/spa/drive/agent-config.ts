import { queryOptions } from '@tanstack/react-query'

import { resolveAgentConfig, type Agent, type AgentEffectiveConfig } from '@repo/contract'

import { duetQueryKeys } from '../api/query-keys'
import type { SpaApi } from '../context'

export type AgentConfigApi = Pick<SpaApi, 'readOptionalWorkspaceFile'>

export function agentConfigQueryOptions(
  api: AgentConfigApi,
  workspaceSlug: string,
  agent: Pick<Agent, 'id' | 'anchorPath'>,
) {
  return queryOptions({
    queryKey: duetQueryKeys.workspaces.agents.config(workspaceSlug, agent.id),
    queryFn: ({ signal }) => loadAgentConfig(api, workspaceSlug, agent.anchorPath, signal),
    retry: false,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
  })
}

async function loadAgentConfig(
  api: AgentConfigApi,
  workspaceSlug: string,
  anchorPath: string,
  signal: AbortSignal,
): Promise<AgentEffectiveConfig> {
  // Most agents never write an `agent.json`, so the read is declared optional
  // and a missing file is an ordinary empty answer, never a 404 for the browser
  // to log. A read that fails for any other reason resolves the same way: the
  // config is fail-open by contract.
  let source: string | undefined
  try {
    const file = await api.readOptionalWorkspaceFile(
      workspaceSlug,
      `${anchorPath.replace(/\/+$/, '')}/agent.json`,
      { signal },
    )
    source = file === null ? undefined : new TextDecoder().decode(file.data)
  } catch {
    source = undefined
  }
  return resolveAgentConfig(source)
}
