import ComposioClient from '@composio/client'
import { Composio } from '@composio/core'

import {
  IntegrationCatalogItemSchema,
  IntegrationProviderCatalogPageSchema,
  IntegrationProviderConnectionPageSchema,
  IntegrationProviderConnectionSchema,
  MAX_INTEGRATION_CATALOG_NAME_UTF8_BYTES,
  truncateUtf8,
  type FetchLike,
} from '@repo/contract'

import { resolveComposioApiBaseUrl } from '../config'
import {
  IntegrationProviderNotConfiguredError,
  type ComposioMcpProvider,
  type IntegrationProvider,
} from '../shared'

/* Read per call rather than once at construction: a deployment without the
   key must fail the request with 503, not the process at boot. */
function composioApiKey(): string {
  const apiKey = process.env.COMPOSIO_API_KEY
  if (!apiKey) {
    throw new IntegrationProviderNotConfiguredError('integration_provider_not_configured')
  }
  return apiKey
}

function composioClient(): Composio {
  // The SDK otherwise phones npm for a newer version on every construction —
  // one per cold function instance — which is noise here, not information.
  return new Composio({ apiKey: composioApiKey(), disableVersionCheck: true })
}

interface ComposioToolRouterSession {
  sessionId: string
  mcp: {
    type: string
    url: string
    headers?: Record<string, string>
  }
  update(config: { toolkits: { disable: string[] } }): Promise<void>
}

interface ComposioToolRouterSessions {
  create(
    workspaceId: string,
    config: {
      mcp: true
      toolkits?: { disable: string[] }
      manageConnections: {
        enable: true
        waitForConnections: true
        callbackUrl: string
      }
    },
  ): Promise<ComposioToolRouterSession>
  use(providerSessionId: string, options: { mcp: true }): Promise<ComposioToolRouterSession>
  delete(providerSessionId: string): Promise<unknown>
}

interface ComposioCatalogSession {
  toolkits(args: { limit: number; search?: string; cursor?: string }): Promise<{
    items: Array<{
      slug: string
      name: string
      logo?: string
      isNoAuth?: boolean
      connection?: { isActive?: boolean } | null
    }>
    cursor?: string | null
  }>
}

interface ComposioIntegrationProviderDependencies {
  resolveCatalogSession?: (workspaceId: string) => Promise<ComposioCatalogSession>
}

/**
 * The fields of a Composio account Duet reads, derived from the client's own
 * row so a renamed column fails to compile here rather than at runtime.
 *
 * `user_id` is widened to optional against the vendor's required declaration:
 * Composio marks it deprecated ("we will not be providing userId from this api
 * anymore"), so the ownership check below must survive it going away.
 */
type ComposioAccountRow = Pick<
  ComposioClient.ConnectedAccountListResponse.Item,
  'id' | 'status' | 'toolkit' | 'created_at' | 'updated_at'
> & { user_id?: string }

/**
 * Connected-account calls go through Composio's generated client so the vendor
 * owns its own `/api/vX` path segment. A hand-written URL pins Duet to a
 * version it does not control, and the client's 404 for a retired path is
 * indistinguishable from a 404 for a deleted account.
 */
function lifecycleClient(fetchImpl: FetchLike): ComposioClient {
  return new ComposioClient({
    apiKey: composioApiKey(),
    // Explicit: the client otherwise reads COMPOSIO_BASE_URL from the
    // environment, and this adapter must not inherit a variable set for
    // something else.
    baseURL: resolveComposioApiBaseUrl(),
    fetch: fetchImpl,
    maxRetries: 2,
    timeout: 30_000,
  })
}

/**
 * The sharing model every connected-account read asks for. Composio's default
 * is the same value today but is marked experimental; pinning it keeps the
 * list and the point lookup on one population whatever that default becomes,
 * so a row the page shows is always a row the lookup can find.
 */
const CONNECTED_ACCOUNT_SHARING = 'PRIVATE' as const

/**
 * The single mapping from a Composio account to a Duet connection. Both the
 * list and the point lookup go through it, so the two can never disagree about
 * what a connection's status is.
 */
function toConnection(account: ComposioAccountRow) {
  return {
    id: account.id,
    integration: account.toolkit.slug,
    status:
      account.status === 'ACTIVE'
        ? ('active' as const)
        : account.status === 'INITIALIZING' || account.status === 'INITIATED'
          ? ('pending' as const)
          : account.status === 'INACTIVE'
            ? ('disconnected' as const)
            : ('error' as const),
    connectedAt: providerTimestamp(account.created_at),
    updatedAt: providerTimestamp(account.updated_at),
  }
}

export function createComposioIntegrationProvider(
  fetchImpl: FetchLike,
  dependencies: ComposioIntegrationProviderDependencies = {},
): IntegrationProvider {
  const resolveCatalogSession =
    dependencies.resolveCatalogSession ??
    (async (workspaceId: string) => await composioClient().create(workspaceId))
  return {
    async listCatalog(args) {
      const session = await resolveCatalogSession(args.workspaceId)
      // The SDK materializes its HTTP response before this adapter sees it, so
      // Duet cannot stream-cap that upstream body here. Keep the requested
      // source page finite, then validate every materialized row before return.
      const page = await session.toolkits({
        // Duet's universal collection contract accepts 100, while Composio's
        // Tool Router toolkit source accepts at most 50. A shorter page keeps
        // the provider cursor intact and lets the caller continue normally.
        limit: Math.min(args.limit, 50),
        search: args.search,
        cursor: args.cursor,
      })
      return IntegrationProviderCatalogPageSchema.parse({
        items: page.items
          .filter(item => !item.isNoAuth)
          .map(item => ({
            integration: item.slug,
            name: truncateUtf8(item.name, MAX_INTEGRATION_CATALOG_NAME_UTF8_BYTES),
            ...boundedLogoUrl(item.logo),
            connected: item.connection?.isActive ?? false,
          })),
        nextCursor: page.cursor ?? null,
      })
    },

    async listConnections(args) {
      // The client owns transport buffering; the parsed page below is the hard
      // boundary for values accepted by Duet.
      const page = await lifecycleClient(fetchImpl).connectedAccounts.list({
        user_ids: [args.workspaceId],
        ...(args.integration === undefined ? {} : { toolkit_slugs: [args.integration] }),
        account_type: CONNECTED_ACCOUNT_SHARING,
        limit: args.limit,
        cursor: args.cursor,
      })
      return IntegrationProviderConnectionPageSchema.parse({
        items: page.items.map(toConnection),
        nextCursor: page.next_cursor ?? null,
      })
    },

    /**
     * The same question `listConnections` asks — "which of this workspace's
     * accounts is this?" — narrowed to one id. Tenancy is Composio's `user_ids`
     * filter, never a string Duet reconstructs, so a connection the workspace
     * can see is always one it can also remove.
     */
    async getConnection(args) {
      const page = await lifecycleClient(fetchImpl).connectedAccounts.list({
        user_ids: [args.workspaceId],
        connected_account_ids: [args.providerConnectionId],
        account_type: CONNECTED_ACCOUNT_SHARING,
        // Two, so a filter that ever widened instead of narrowing is visible
        // here as an extra row rather than silently deleting the wrong account.
        limit: 2,
      })
      const account = page.items.length === 1 ? page.items[0] : undefined
      if (account === undefined || account.id !== args.providerConnectionId) return undefined
      /* No Composio document states that `user_ids` and `connected_account_ids`
         compose as AND rather than the id filter short-circuiting the owner
         filter. It does compose — probed against the live API — but nothing
         contractual holds it there, and a regression would hand one workspace
         another's connection to delete. While Composio still returns the owner,
         hold the row to it; the field is deprecated upstream, so absence falls
         back to the filter, but a mismatch never does. */
      if (account.user_id === undefined) {
        // The day this fires, the request filter is the entire tenancy proof.
        console.warn('[composio] connected account resolved without an owner field', {
          workspaceId: args.workspaceId,
          providerConnectionId: args.providerConnectionId,
        })
      } else if (account.user_id !== args.workspaceId) {
        return undefined
      }
      return IntegrationProviderConnectionSchema.parse(toConnection(account))
    },

    async beginConnection(args) {
      const session = await composioClient().create(args.workspaceId)
      const connection = await session.authorize(args.integration, {
        callbackUrl: args.callbackUrl,
        alias: args.label,
      })
      if (connection.redirectUrl === null || connection.redirectUrl === undefined) {
        throw new Error('provider_missing_authorize_url')
      }
      return { authorizeUrl: connection.redirectUrl }
    },

    async disconnect(args) {
      try {
        await lifecycleClient(fetchImpl).connectedAccounts.delete(args.providerConnectionId)
      } catch (error) {
        /* Callers resolve the connection inside this workspace first, so a 404
           here means it went away between that read and this delete. The end
           state the caller asked for already holds. */
        if (isComposioNotFound(error)) return
        throw error
      }
    },
  }
}

function boundedLogoUrl(value: string | undefined): { logoUrl?: string } {
  if (value === undefined) return {}
  const parsed = IntegrationCatalogItemSchema.shape.logoUrl.safeParse(value)
  return parsed.success ? { logoUrl: parsed.data } : {}
}

export function createComposioMcpProvider(
  resolveSessions: () => ComposioToolRouterSessions = () => composioClient().sessions,
): ComposioMcpProvider {
  return {
    async createToolRouterSession(args) {
      const session = await resolveSessions().create(args.workspaceId, {
        mcp: true,
        ...(args.disabledToolkitSlugs.length === 0
          ? {}
          : { toolkits: { disable: [...args.disabledToolkitSlugs] } }),
        manageConnections: {
          enable: true,
          waitForConnections: true,
          callbackUrl: args.callbackUrl,
        },
      })
      return composioMcpSession(session)
    },

    async useToolRouterSession(args) {
      const session = await resolveSessions().use(args.providerSessionId, { mcp: true })
      return composioMcpSession(session)
    },

    async updateToolRouterSession(args) {
      const session = await resolveSessions().use(args.providerSessionId, { mcp: true })
      await session.update({ toolkits: { disable: [...args.disabledToolkitSlugs] } })
    },

    async deleteToolRouterSession(args) {
      await resolveSessions().delete(args.providerSessionId)
    },
  }
}

function composioMcpSession(session: ComposioToolRouterSession) {
  if (session.mcp.type !== 'http') throw new Error('provider_mcp_transport_unsupported')
  return {
    providerSessionId: session.sessionId,
    mcp: {
      type: 'http' as const,
      url: session.mcp.url,
      headers: session.mcp.headers,
    },
  }
}

function providerTimestamp(value: string): number {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : 0
}

function isComposioNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404
}
