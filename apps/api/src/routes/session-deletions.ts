import {
  extractBearerToken,
  SessionDeletionDisposalPlanSchema,
  type SessionDeletionDisposalResult,
} from '@repo/contract'

import type { GatewayClient } from '../gateway/client'
import { constantTimeSecretMatches } from '../secret-auth'
import { mapSessionError } from '../session-errors'
import { sessionRequestIdentityForAuth } from '../session-principal'
import {
  fn,
  fnQuery,
  requireAuthedWorkspace,
  type ApiApp,
  type ApiRouteRuntime,
  type ComposioMcpProvider,
} from '../shared'

export const SESSION_DELETION_AUTH_BYPASS_PATTERNS = [
  /^\/v1\/internal\/session-deletions\/[^/]+\/dispose$/,
] as const

export function registerSessionDeletionRoutes(app: ApiApp, runtime: ApiRouteRuntime): void {
  app.delete('/v1/ws/:workspaceSlug/agent/sessions/:sessionId', async c => {
    const workspace = requireAuthedWorkspace(c, 'sessions')
    if ('response' in workspace) return workspace.response
    try {
      await runtime.convex.mutation(fn('domains/agentSessions/model:beginSessionSubtreeDeletion'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        identity: sessionRequestIdentityForAuth(c.get('auth')),
        workspaceId: workspace.id,
        sessionId: c.req.param('sessionId'),
        now: runtime.now(),
      })
      return c.body(null, 204)
    } catch (error) {
      const mapped = mapSessionError(error)
      // Missing, hidden, and already-sealed all read as the same accepted state.
      if (mapped.status === 404) return c.body(null, 204)
      return c.json(mapped.body, mapped.status)
    }
  })
}

export function registerSessionDeletionInternalRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  gateway: Pick<GatewayClient, 'discardAgentSession'>,
  provider?: Pick<ComposioMcpProvider, 'deleteToolRouterSession'>,
): void {
  app.post('/v1/internal/session-deletions/:workId/dispose', async c => {
    const bearer = extractBearerToken(c.req.header('authorization') ?? null)
    if (!constantTimeSecretMatches(bearer, runtime.apiInternalKey)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    const plan = SessionDeletionDisposalPlanSchema.parse(
      await runtime.convex.query(
        fnQuery('domains/agentSessions/model:sessionDeletionDisposalPlan'),
        {
          internalKey: runtime.internalKey,
          workId: c.req.param('workId'),
        },
      ),
    )
    if (plan === null) return c.json({ status: 'noop' } satisfies SessionDeletionDisposalResult)

    const discarded = await gateway.discardAgentSession(plan.workspaceSlug, plan.sessionId)
    if (!discarded.ok) {
      return c.json({ error: 'session_disposal_retryable', code: discarded.error }, 503)
    }

    let providerAttempted = false
    if (plan.providerSessionId !== undefined && provider !== undefined) {
      providerAttempted = true
      try {
        await provider.deleteToolRouterSession({ providerSessionId: plan.providerSessionId })
      } catch (error) {
        console.error('[agent-session-delete] Provider session cleanup failed', {
          workId: c.req.param('workId'),
          workspaceSlug: plan.workspaceSlug,
          duetSessionId: plan.sessionId,
          providerSessionId: plan.providerSessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return c.json({
      status: 'disposed',
      runner: 'absent',
      providerAttempted,
    } satisfies SessionDeletionDisposalResult)
  })
}
