import { ConvexError } from 'convex/values'

import {
  ConnectedProviderIdSchema,
  ConnectPollResponseSchema,
  ConnectStartResponseSchema,
} from '@repo/contract'

import type { GatewayClient } from '../gateway/client'
import {
  fn,
  fnQuery,
  requireWorkspaceMember,
  type ApiApp,
  type ApiContext,
  type ApiRouteRuntime,
  requireHumanActor,
} from '../shared'

export function registerConnectedProvidersRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
): void {
  app.get('/v1/ws/:workspaceSlug/connected-providers', async c => {
    const session = requireHumanActor(c)
    if ('response' in session) return session.response
    const workspace = requireWorkspaceMember(c)
    if ('response' in workspace) return workspace.response
    // The VM owns the truth — the credential store lives there and can change
    // out of band, so read it when someone actually looks rather than polling
    // it into the control plane forever. The reading is folded into the stored
    // rows, which then answer this and any read taken while the VM is paused or
    // unreachable; a VM we cannot reach costs freshness, never the page.
    const observed = await gatewayClient.listConnectedProviders(workspace.slug)
    if (Array.isArray(observed)) {
      await runtime.convex.mutation(fn('domains/connectedProviders/model:applyObservation'), {
        internalKey: runtime.internalKey,
        workspaceId: workspace.id,
        connectedProviders: observed,
      })
    }
    const connections = await runtime.convex.query(
      fnQuery('domains/connectedProviders/model:listForWorkspace'),
      {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
      },
    )
    return c.json(connections)
  })

  app.post('/v1/ws/:workspaceSlug/connected-providers/:provider/connect', async c => {
    const session = requireHumanActor(c)
    if ('response' in session) return session.response
    const workspace = requireWorkspaceMember(c)
    if ('response' in workspace) return workspace.response
    const provider = ConnectedProviderIdSchema.safeParse(c.req.param('provider'))
    if (!provider.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      await runtime.convex.mutation(fn('domains/connectedProviders/model:authorizeConnect'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
        provider: provider.data,
      })
      const result = await gatewayClient.startProviderConnect(workspace.slug, provider.data)
      if (result instanceof Response) return result
      return c.json(ConnectStartResponseSchema.parse(result))
    } catch (error) {
      return connectedProviderMutationError(c, error)
    }
  })

  app.get('/v1/ws/:workspaceSlug/connected-providers/connect/:sessionId', async c => {
    const session = requireHumanActor(c)
    if ('response' in session) return session.response
    const workspace = requireWorkspaceMember(c)
    if ('response' in workspace) return workspace.response
    try {
      const result = await gatewayClient.pollProviderConnect(
        workspace.slug,
        c.req.param('sessionId'),
      )
      if (result instanceof Response) return result
      const poll = ConnectPollResponseSchema.parse(result)
      if (poll.status === 'connected') {
        await runtime.convex.mutation(fn('domains/connectedProviders/model:completeConnect'), {
          internalKey: runtime.internalKey,
          actorId: c.get('auth').user.id,
          workspaceId: workspace.id,
          connection: poll.connection,
        })
      }
      if (poll.status === 'failed' && poll.reason === 'plan_ineligible' && poll.provider) {
        // The agent has already persisted the (ineligible) credential; record
        // the initiating member so observation ingestion doesn't attribute the
        // row to the workspace owner.
        await runtime.convex.mutation(fn('domains/connectedProviders/model:completeConnect'), {
          internalKey: runtime.internalKey,
          actorId: c.get('auth').user.id,
          workspaceId: workspace.id,
          connection: {
            provider: poll.provider,
            state: 'plan_ineligible',
            connectedAt: Date.now(),
          },
        })
      }
      return c.json(poll)
    } catch (error) {
      return connectedProviderMutationError(c, error)
    }
  })

  app.delete('/v1/ws/:workspaceSlug/connected-providers/:provider', async c => {
    const session = requireHumanActor(c)
    if ('response' in session) return session.response
    const workspace = requireWorkspaceMember(c)
    if ('response' in workspace) return workspace.response
    const provider = ConnectedProviderIdSchema.safeParse(c.req.param('provider'))
    if (!provider.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      await runtime.convex.mutation(fn('domains/connectedProviders/model:requestDisconnect'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
        provider: provider.data,
      })
      const result = await gatewayClient.disconnectProvider(workspace.slug, provider.data)
      return result instanceof Response ? result : c.json(result)
    } catch (error) {
      return connectedProviderMutationError(c, error)
    }
  })
}

function connectedProviderMutationError(c: ApiContext, error: unknown): Response {
  if (
    error instanceof ConvexError &&
    typeof error.data === 'object' &&
    error.data !== null &&
    (error.data as { error?: unknown }).error === 'disconnect_forbidden'
  ) {
    return c.json({ error: 'forbidden' }, 403)
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/Requires viewer access/i.test(message)) return c.json({ error: 'forbidden' }, 403)
  if (/not found/i.test(message)) return c.json({ error: 'not_found' }, 404)
  throw error
}
