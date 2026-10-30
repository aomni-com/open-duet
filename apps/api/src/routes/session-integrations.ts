import {
  bestEffortAbandonPreparedRunnerInput,
  type PreparedRunnerInputDelivery,
  type PreparedRunnerInputLease,
} from '../agent-runner'
import { synchronizeComposioSession } from '../composio-session'
import {
  type ApiContext,
  type ApiRouteRuntime,
  type ComposioMcpProvider,
  type WorkspaceRef,
} from '../shared'
import { createComposioToolRouterCallbackUrl } from './composio-oauth'

export interface SessionIntegrationOptions {
  composioMcpProvider?: ComposioMcpProvider
}

export async function synchronizePreparedSessionIntegrations(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  options: SessionIntegrationOptions,
  workspace: Pick<WorkspaceRef, 'id' | 'slug'>,
  prepared: PreparedRunnerInputDelivery,
): Promise<boolean> {
  if (options.composioMcpProvider === undefined) return true
  // The runner delivery lease already serializes dispatch for a conversation.
  // A queued caller does no provider work; the lease holder (or a later drain)
  // prepares the shared Composio session immediately before gateway dispatch.
  if ('queued' in prepared) return true
  if (prepared.dispatch.integrations !== true) {
    await bestEffortAbandonPreparedRunnerInput(runtime, workspace.id, prepared)
    return false
  }
  // Prepare read the provider session in its own transaction; when it already
  // reflects this turn's permissions there is nothing left to synchronize.
  if (prepared.dispatch.integrationsReady === true) return true
  const ready = await synchronizeLeasedSessionIntegrations(c, runtime, options, workspace, prepared)
  if (!ready) {
    await bestEffortAbandonPreparedRunnerInput(runtime, workspace.id, prepared)
  }
  return ready
}

export async function synchronizeLeasedSessionIntegrations(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  options: SessionIntegrationOptions,
  workspace: Pick<WorkspaceRef, 'id' | 'slug'>,
  prepared: PreparedRunnerInputLease,
): Promise<boolean> {
  if (options.composioMcpProvider === undefined) return true
  try {
    await synchronizeComposioSession(runtime, options.composioMcpProvider, {
      workspaceId: workspace.id,
      duetSessionId: prepared.sessionId,
      callbackUrl: await createComposioToolRouterCallbackUrl({
        requestUrl: c.req.url,
        workspaceSlug: workspace.slug,
        secret: runtime.apiInternalKey,
      }),
    })
    return true
  } catch (error) {
    logSessionIntegrationFailure(workspace.id, prepared.sessionId, error)
    return false
  }
}

function logSessionIntegrationFailure(
  workspaceId: string,
  sessionId: string,
  error: unknown,
): void {
  console.error('[composio-session] Failed to prepare conversation integrations', {
    workspaceId,
    sessionId,
    error: error instanceof Error ? error.message : String(error),
  })
}
