import { ConvexError } from 'convex/values'

import {
  IntegrationCatalogPageSchema,
  IntegrationCatalogQuerySchema,
  IntegrationAgentPolicyResponseSchema,
  IntegrationConnectionIdSchema,
  IntegrationConnectionListSchema,
  IntegrationConnectionListQuerySchema,
  IntegrationConnectRequestSchema,
  IntegrationConnectResponseSchema,
  IntegrationDisconnectResponseSchema,
  IntegrationProviderCatalogPageSchema,
  IntegrationProviderConnectionPageSchema,
  IntegrationSlugSchema,
  isCollectionCursorError,
  SetIntegrationAgentPolicyRequestSchema,
  allowedIntegrationRedirect,
} from '@repo/contract'

import { createContinuationCollectionPage } from '../collection-page'
import { resolveEdgeHost } from '../config'
import {
  IntegrationProviderNotConfiguredError,
  fn,
  fnQuery,
  readJson,
  requireAuthedWorkspace,
  type ApiApp,
  type ApiRouteRuntime,
  type IntegrationProvider,
  type IntegrationProviderConnection,
} from '../shared'
import { createComposioUserConnectCallbackUrl } from './composio-oauth'

const catalogPages = createContinuationCollectionPage('integrations.catalog')
const connectionPages = createContinuationCollectionPage('integrations.connections')

export function registerIntegrationRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  integrationProvider: IntegrationProvider,
): void {
  app.get('/v1/ws/:workspaceSlug/integrations/catalog', async c => {
    const workspace = requireAuthedWorkspace(c, 'integrations')
    if ('response' in workspace) return workspace.response
    const parsed = IntegrationCatalogQuerySchema.safeParse(c.req.query())
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const binding = {
        subject: `workspace:${workspace.id}`,
        filters: { q: parsed.data.q },
        order: 'provider-native order',
      }
      const pagination = await catalogPages.paginationOpts(parsed.data, binding)
      const page = IntegrationProviderCatalogPageSchema.parse(
        await integrationProvider.listCatalog({
          workspaceId: workspace.id,
          search: parsed.data.q,
          ...(pagination.cursor === null ? {} : { cursor: pagination.cursor }),
          limit: pagination.numItems,
        }),
      )
      return c.json(
        IntegrationCatalogPageSchema.parse(
          await catalogPages.response(
            {
              page: page.items,
              continueCursor: page.nextCursor ?? '',
              isDone: page.nextCursor === null,
            },
            binding,
          ),
        ),
      )
    } catch (error) {
      if (isCollectionCursorError(error)) return c.json({ error: 'invalid_cursor' }, 400)
      return c.json({ error: lifecycleErrorCode(error) }, lifecycleErrorStatus(error))
    }
  })

  app.post('/v1/ws/:workspaceSlug/integrations/connect', async c => {
    const workspace = requireAuthedWorkspace(c, 'integrations')
    if ('response' in workspace) return workspace.response
    const body = IntegrationConnectRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const redirectTo = allowedIntegrationRedirect(body.data.redirectTo, {
      webAppUrl: runtime.appUrl,
      workspaceSlug: workspace.slug,
      edgeHost: resolveEdgeHost(),
    })
    if (redirectTo === null) return c.json({ error: 'redirect_not_allowed' }, 400)
    try {
      const existing = await findProviderConnection(
        integrationProvider,
        workspace.id,
        body.data.integration,
      )
      /* Only `active` is a connection. `pending` is an authorization that was
         started and never came back — the provider mints the row with the
         authorize URL and nothing clears it if the user hits an error, says
         no, or closes the tab. Treating it as already-connected made that a
         permanent dead end: the row never turns active on its own, and this
         route refused to start a new attempt. Pressing Connect replaces it,
         exactly as it replaces an errored one.

         The cost is a genuinely in-flight authorization in another tab, which
         a second Connect now invalidates. That is the right way round: the
         user just asked to start over, and the alternative strands them. */
      if (existing?.status === 'active') {
        throw new Error('integration_already_connected')
      }
      if (existing !== undefined) {
        await integrationProvider.disconnect({
          workspaceId: workspace.id,
          providerConnectionId: existing.id,
        })
      }
      const callbackUrl = await createComposioUserConnectCallbackUrl({
        requestUrl: c.req.url,
        workspaceSlug: workspace.slug,
        destination: redirectTo,
        secret: runtime.apiInternalKey,
        now: runtime.now(),
      })
      const result = await integrationProvider.beginConnection({
        workspaceId: workspace.id,
        integration: body.data.integration,
        callbackUrl,
        label: `${workspace.id}:${body.data.integration}`,
      })
      return c.json(
        IntegrationConnectResponseSchema.parse({
          integration: body.data.integration,
          authorizeUrl: result.authorizeUrl,
        }),
      )
    } catch (error) {
      return c.json({ error: lifecycleErrorCode(error) }, lifecycleErrorStatus(error))
    }
  })

  app.get('/v1/ws/:workspaceSlug/integrations/connections', async c => {
    const workspace = requireAuthedWorkspace(c, 'integrations')
    if ('response' in workspace) return workspace.response
    const query = IntegrationConnectionListQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const binding = {
        subject: `workspace:${workspace.id}`,
        filters: {},
        order: 'provider-native order',
      }
      const pagination = await connectionPages.paginationOpts(query.data, binding)
      const providerConnections = IntegrationProviderConnectionPageSchema.parse(
        await integrationProvider.listConnections({
          workspaceId: workspace.id,
          ...(pagination.cursor === null ? {} : { cursor: pagination.cursor }),
          limit: pagination.numItems,
        }),
      )
      const toolkitSlugs = [
        ...new Set(providerConnections.items.map(connection => connection.integration)),
      ]
      const policyRows = await runtime.convex.query(
        fnQuery('domains/integrations/model:integrationAgentPoliciesForToolkits'),
        {
          internalKey: runtime.internalKey,
          workspaceId: workspace.id,
          toolkitSlugs,
        },
      )
      const policies = new Map(
        (policyRows as unknown[]).map(row => {
          const policy = IntegrationAgentPolicyResponseSchema.parse(row)
          return [policy.integration, policy.allowedAgentIds] as const
        }),
      )
      const items = providerConnections.items.map(connection => {
        const allowedAgentIds = policies.get(connection.integration)
        return allowedAgentIds === undefined ? connection : { ...connection, allowedAgentIds }
      })
      return c.json(
        IntegrationConnectionListSchema.parse(
          await connectionPages.response(
            {
              page: items,
              continueCursor: providerConnections.nextCursor ?? '',
              isDone: providerConnections.nextCursor === null,
            },
            binding,
          ),
        ),
      )
    } catch (error) {
      if (isCollectionCursorError(error)) return c.json({ error: 'invalid_cursor' }, 400)
      return c.json({ error: lifecycleErrorCode(error) }, lifecycleErrorStatus(error))
    }
  })

  app.put('/v1/ws/:workspaceSlug/integrations/:toolkitSlug/agent-policy', async c => {
    const workspace = requireAuthedWorkspace(c, 'integrations')
    if ('response' in workspace) return workspace.response
    const toolkitSlug = IntegrationSlugSchema.safeParse(c.req.param('toolkitSlug'))
    const body = SetIntegrationAgentPolicyRequestSchema.safeParse(await readJson(c.req.raw))
    if (!toolkitSlug.success || !body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const result = await runtime.convex.mutation(
        fn(
          body.data.allowedAgentIds === undefined
            ? 'domains/integrations/model:clearIntegrationAgentPolicy'
            : 'domains/integrations/model:setIntegrationAgentPolicy',
        ),
        {
          internalKey: runtime.internalKey,
          workspaceId: workspace.id,
          toolkitSlug: toolkitSlug.data,
          ...(body.data.allowedAgentIds === undefined
            ? {}
            : { allowedAgentIds: body.data.allowedAgentIds }),
        },
      )
      return c.json(IntegrationAgentPolicyResponseSchema.parse(result))
    } catch (error) {
      if (
        error instanceof ConvexError &&
        typeof error.data === 'object' &&
        error.data !== null &&
        (error.data as { error?: unknown }).error === 'invalid_agent'
      ) {
        return c.json({ error: 'invalid_request' }, 400)
      }
      throw error
    }
  })

  app.delete('/v1/ws/:workspaceSlug/integrations/connections/:connectionId', async c => {
    const workspace = requireAuthedWorkspace(c, 'integrations')
    if ('response' in workspace) return workspace.response
    const connectionId = IntegrationConnectionIdSchema.safeParse(c.req.param('connectionId'))
    if (!connectionId.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      /* Ownership is the provider's answer to "is this one of this
         workspace's connections", the same question the list above asks. It
         used to be a label Duet wrote at connect time and compared here, which
         no connection made any other way — an agent's own connect flow, or any
         account predating the label — could ever satisfy: those rows listed
         and then refused to disconnect. */
      const connection = await integrationProvider.getConnection({
        workspaceId: workspace.id,
        providerConnectionId: connectionId.data,
      })
      if (connection !== undefined) {
        await integrationProvider.disconnect({
          workspaceId: workspace.id,
          providerConnectionId: connection.id,
        })
      }
      return c.json(
        IntegrationDisconnectResponseSchema.parse({
          id: connectionId.data,
          disconnected: connection !== undefined,
        }),
      )
    } catch (error) {
      return c.json({ error: lifecycleErrorCode(error) }, lifecycleErrorStatus(error))
    }
  })
}

async function findProviderConnection(
  provider: IntegrationProvider,
  workspaceId: string,
  integration: string,
): Promise<IntegrationProviderConnection | undefined> {
  // Connect narrows lifecycle discovery by toolkit and keeps it to one bounded
  // provider read. Disconnect narrows the same read to a single id instead, so
  // a connection's list-page position cannot decide whether it can be removed.
  const page = IntegrationProviderConnectionPageSchema.parse(
    await provider.listConnections({
      workspaceId,
      integration,
      limit: 100,
    }),
  )
  return page.items.find(
    connection => connection.integration === integration && connection.status !== 'disconnected',
  )
}

function lifecycleErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('integration_already_connected')) return 'integration_already_connected'
  return providerErrorCode(error)
}

function lifecycleErrorStatus(error: unknown): 409 | 502 | 503 {
  const code = lifecycleErrorCode(error)
  if (code === 'integration_already_connected') return 409
  return providerErrorStatus(error)
}

function providerErrorCode(error: unknown): string {
  if (error instanceof IntegrationProviderNotConfiguredError) return error.message
  return 'integration_provider_failed'
}

function providerErrorStatus(error: unknown): 502 | 503 {
  return error instanceof IntegrationProviderNotConfiguredError ? 503 : 502
}
