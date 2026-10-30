import {
  fn,
  fnQuery,
  type ApiRouteRuntime,
  type ComposioMcpProvider,
  type ComposioMcpSession,
} from './shared'

interface ToolRouterSessionConfig {
  status: 'found'
  permissionFingerprint: string
  disabledToolkitSlugs: string[]
  providerSessionId?: string
  appliedPermissionFingerprint?: string
  mcpUrl?: string
  toolsList?: { providerSessionId: string; permissionFingerprint: string; resultJson: string }
}

export async function synchronizeComposioSession(
  runtime: ApiRouteRuntime,
  provider: ComposioMcpProvider,
  args: {
    workspaceId: string
    duetSessionId: string
    callbackUrl: string
  },
  missingProviderSessionId?: string,
): Promise<void> {
  const config = await getToolRouterConfig(runtime, args.workspaceId, args.duetSessionId)
  if (
    config.providerSessionId === undefined ||
    config.providerSessionId === missingProviderSessionId
  ) {
    const adoption = await createAndAdoptProviderSession(runtime, provider, {
      ...args,
      config,
      expectedProviderSessionId: config.providerSessionId ?? null,
    })
    if (adoption.status === 'not_found') throw new ToolRouterConfigNotFoundError()
    if (adoption.status === 'changed')
      return await synchronizeComposioSession(runtime, provider, args)
    if (!adoption.applied) throw new ToolRouterPermissionsChangedError()
    return
  }

  const existing = { ...config, providerSessionId: config.providerSessionId }
  if (config.appliedPermissionFingerprint === config.permissionFingerprint) return
  try {
    await provider.updateToolRouterSession({
      providerSessionId: existing.providerSessionId,
      disabledToolkitSlugs: config.disabledToolkitSlugs,
    })
  } catch (error) {
    if (!isMissingProviderSession(error)) throw error
    return await synchronizeComposioSession(runtime, provider, args, existing.providerSessionId)
  }
  const result = (await runtime.convex.mutation(
    fn('domains/integrations/turnConfig:markToolRouterSessionPermissionsApplied'),
    {
      internalKey: runtime.internalKey,
      workspaceId: args.workspaceId,
      duetSessionId: args.duetSessionId,
      providerSessionId: existing.providerSessionId,
      permissionFingerprint: config.permissionFingerprint,
    },
  )) as { applied: boolean }
  if (!result.applied) throw new ToolRouterPermissionsChangedError()
}

export interface ResolvedComposioSession {
  providerSessionId: string
  /** The provider session's MCP endpoint; its credential is the org key. */
  mcpUrl: string
  /** The permissions the provider session currently reflects. */
  permissionFingerprint: string
  /** The `tools/list` result the row remembers for this session under these permissions. */
  toolsList?: unknown
  resetTransportSession: boolean
}

/**
 * Resolve the provider session a Duet session's MCP traffic goes to.
 *
 * The row answers this on its own once it carries the endpoint: the runner's
 * handshake resolves the same session twice within seconds, and a provider
 * lookup on each was the larger half of every MCP round trip. The provider is
 * consulted only when the row predates the endpoint field (and is then taught
 * it) or when the caller says the endpoint refused — the one way a vanished
 * provider session shows itself once nothing asks the provider first.
 */
export async function useComposioSession(
  runtime: ApiRouteRuntime,
  provider: ComposioMcpProvider,
  args: {
    workspaceId: string
    duetSessionId: string
    callbackUrl: string
  },
  options: { lookup?: 'row' | 'provider' } = {},
): Promise<ResolvedComposioSession> {
  const config = await getReadyToolRouterConfig(runtime, args.workspaceId, args.duetSessionId)
  const fingerprint = config.appliedPermissionFingerprint ?? config.permissionFingerprint
  if (options.lookup !== 'provider' && config.mcpUrl !== undefined) {
    const remembered = config.toolsList
    return {
      providerSessionId: config.providerSessionId,
      mcpUrl: config.mcpUrl,
      permissionFingerprint: fingerprint,
      ...(remembered !== undefined &&
      remembered.providerSessionId === config.providerSessionId &&
      remembered.permissionFingerprint === fingerprint
        ? { toolsList: JSON.parse(remembered.resultJson) as unknown }
        : {}),
      resetTransportSession: false,
    }
  }
  try {
    const session = await useStoredProviderSession(provider, config.providerSessionId)
    if (config.mcpUrl === undefined) {
      void rememberToolRouterSessionDetails(runtime, args, {
        providerSessionId: session.providerSessionId,
        mcpUrl: session.mcp.url,
      })
    }
    return resolvedFromProvider(session, fingerprint, false)
  } catch (error) {
    if (!isMissingProviderSession(error)) throw error
    await synchronizeComposioSession(runtime, provider, args, config.providerSessionId)
    const replacement = await getReadyToolRouterConfig(
      runtime,
      args.workspaceId,
      args.duetSessionId,
    )
    return resolvedFromProvider(
      await useStoredProviderSession(provider, replacement.providerSessionId),
      replacement.appliedPermissionFingerprint ?? replacement.permissionFingerprint,
      true,
    )
  }
}

function resolvedFromProvider(
  session: ComposioMcpSession,
  permissionFingerprint: string,
  resetTransportSession: boolean,
): ResolvedComposioSession {
  return {
    providerSessionId: session.providerSessionId,
    mcpUrl: session.mcp.url,
    permissionFingerprint,
    resetTransportSession,
  }
}

/**
 * Teach the row what the proxy learned. Best effort and detached: the lesson
 * shortens the next handshake, and the current one must not wait on it.
 */
export function rememberToolRouterSessionDetails(
  runtime: ApiRouteRuntime,
  args: { workspaceId: string; duetSessionId: string },
  lesson: {
    providerSessionId: string
    mcpUrl?: string
    toolsList?: { permissionFingerprint: string; result: unknown }
  },
): Promise<void> {
  const { toolsList, ...rest } = lesson
  return runtime.convex
    .mutation(fn('domains/integrations/turnConfig:rememberToolRouterSessionDetails'), {
      internalKey: runtime.internalKey,
      workspaceId: args.workspaceId,
      duetSessionId: args.duetSessionId,
      ...rest,
      // Serialized, not nested: tool schemas carry `$schema` keys, and a
      // stored document may not have a field name starting with `$`.
      ...(toolsList === undefined
        ? {}
        : {
            toolsList: {
              permissionFingerprint: toolsList.permissionFingerprint,
              resultJson: JSON.stringify(toolsList.result),
            },
          }),
      now: runtime.now(),
    })
    .then(
      () => undefined,
      (error: unknown) => {
        console.error('[composio-session] Failed to remember session details', {
          workspaceId: args.workspaceId,
          duetSessionId: args.duetSessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      },
    )
}

async function getReadyToolRouterConfig(
  runtime: ApiRouteRuntime,
  workspaceId: string,
  duetSessionId: string,
): Promise<ToolRouterSessionConfig & { providerSessionId: string }> {
  const config = await getToolRouterConfig(runtime, workspaceId, duetSessionId)
  if (
    config.providerSessionId === undefined ||
    config.appliedPermissionFingerprint !== config.permissionFingerprint
  ) {
    throw new ToolRouterSessionNotReadyError()
  }
  return { ...config, providerSessionId: config.providerSessionId }
}

async function useStoredProviderSession(
  provider: Pick<ComposioMcpProvider, 'useToolRouterSession'>,
  providerSessionId: string,
): Promise<ComposioMcpSession> {
  const session = await provider.useToolRouterSession({ providerSessionId })
  if (session.providerSessionId !== providerSessionId) {
    throw new Error('provider_session_identity_mismatch')
  }
  return session
}

type ProviderSessionAdoption =
  | { status: 'not_found' }
  | { status: 'changed' }
  | { status: 'adopted'; applied: boolean }

async function createAndAdoptProviderSession(
  runtime: ApiRouteRuntime,
  provider: ComposioMcpProvider,
  args: {
    workspaceId: string
    duetSessionId: string
    callbackUrl: string
    config: ToolRouterSessionConfig
    expectedProviderSessionId: string | null
  },
): Promise<ProviderSessionAdoption> {
  const created = await provider.createToolRouterSession({
    workspaceId: args.workspaceId,
    callbackUrl: args.callbackUrl,
    disabledToolkitSlugs: args.config.disabledToolkitSlugs,
  })
  try {
    const adoption = (await runtime.convex.mutation(
      fn('domains/integrations/turnConfig:adoptToolRouterSession'),
      {
        internalKey: runtime.internalKey,
        workspaceId: args.workspaceId,
        duetSessionId: args.duetSessionId,
        expectedProviderSessionId: args.expectedProviderSessionId,
        providerSessionId: created.providerSessionId,
        permissionFingerprint: args.config.permissionFingerprint,
        mcpUrl: created.mcp.url,
      },
    )) as { status: 'not_found' | 'changed' } | { status: 'adopted'; applied: boolean }
    if (adoption.status === 'adopted') return adoption
    await deleteBestEffort(provider, created.providerSessionId)
    return adoption
  } catch (error) {
    await deleteBestEffort(provider, created.providerSessionId)
    throw error
  }
}

function isMissingProviderSession(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const providerError = error as { status?: unknown; statusCode?: unknown }
  return providerError.status === 404 || providerError.statusCode === 404
}

async function getToolRouterConfig(
  runtime: ApiRouteRuntime,
  workspaceId: string,
  duetSessionId: string,
): Promise<ToolRouterSessionConfig> {
  const config = (await runtime.convex.query(
    fnQuery('domains/integrations/turnConfig:getToolRouterSession'),
    { internalKey: runtime.internalKey, workspaceId, duetSessionId },
  )) as ToolRouterSessionConfig | { status: 'not_found' }
  if (config.status === 'not_found') throw new ToolRouterConfigNotFoundError()
  return config
}

async function deleteBestEffort(
  provider: Pick<ComposioMcpProvider, 'deleteToolRouterSession'>,
  providerSessionId: string,
): Promise<void> {
  try {
    await provider.deleteToolRouterSession({ providerSessionId })
  } catch {
    // The provider session was never attached to a Duet conversation.
  }
}

export class ToolRouterConfigNotFoundError extends Error {}
export class ToolRouterSessionNotReadyError extends Error {}
export class ToolRouterPermissionsChangedError extends Error {}
