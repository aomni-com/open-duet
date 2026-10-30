import {
  AGENT_TERMINAL_STATES,
  AgentAnswerRequestSchema,
  AgentMessageRequestSchema,
  AgentNoteRequestSchema,
  AgentStartSessionRequestSchema,
  AgentStartNestedSessionRequestSchema,
  AgentVmRelayEventRequestSchema,
  InterruptedCheckpointTargetSchema,
  effectiveSessionCreationAudience,
  GatewaySessionIntegrationsRefreshResponseSchema,
  GatewaySessionCwdReceiptSchema,
  GatewaySessionInterruptReceiptSchema,
  SessionCwdRequestSchema,
  SessionActivityQuerySchema,
  SessionArchiveRequestSchema,
  SessionAudienceDeltaRequestSchema,
  SessionAudiencePageQuerySchema,
  SessionReadRequestSchema,
  SessionEventResumeQuerySchema,
  SessionHistoryQuerySchema,
  SessionChildrenQuerySchema,
  SessionListQuerySchema,
  SessionRenameRequestSchema,
  parseSessionLastEventId,
  extractBearerToken,
  hashApiKey,
  isCollectionCursorError,
  type SessionSnapshot,
  type AgentStartSessionRequest,
} from '@repo/contract'

import {
  discardAgentInputImages,
  fingerprintAgentInput,
  sessionResponse,
  storeAgentInputImages,
} from '../agent-runner'
import { synchronizeComposioSession } from '../composio-session'
import { type GatewayClient, type GatewayConnection } from '../gateway/client'
import { createPhaseTimer } from '../server-timing'
import { sessionErrorResponse } from '../session-errors'
import { createSessionEventStream } from '../session-event-stream'
import { sessionRequestIdentityForAuth } from '../session-principal'
import { requireInputSender } from '../session-sender'
import { submitSessionInput } from '../session-submission'
import {
  fn,
  fnAction,
  fnQuery,
  requireWorkspaceAdmission,
  readJson,
  requireAuthedWorkspace,
  requirePreflightedSessionCreationWorkspace,
  requirePreflightedSessionSpendWorkspace,
  type ApiApp,
  type ApiContext,
  type ApiRouteRuntime,
  type ComposioMcpProvider,
  type SessionInputTestHooks,
  type WaitUntil,
} from '../shared'
import { createComposioToolRouterCallbackUrl } from './composio-oauth'
import { registerDefaultSessionRoutes } from './default-session'
import { registerSessionWaitRoutes } from './session-waits'

export const AGENT_AUTH_BYPASS_PATTERNS = [
  /^\/v1\/vm\/agent\/sessions\/[^/]+\/interrupted-checkpoint$/,
  /^\/v1\/vm\/agent\/sessions\/[^/]+\/events$/,
  /^\/v1\/vm\/agent\/sessions\/[^/]+\/integrations$/,
] as const

export function registerAgentRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
  options: {
    waitUntil: WaitUntil
    composioMcpProvider?: ComposioMcpProvider
    sessionInputTestHooks?: SessionInputTestHooks
  },
): void {
  registerDefaultSessionRoutes(app, runtime, gatewayClient, options)
  registerSessionWaitRoutes(app, runtime, gatewayClient, options)

  app.post('/v1/vm/agent/sessions/:sessionId/integrations', async c => {
    const token = extractBearerToken(c.req.header('authorization') ?? null)
    if (token === null) return c.json({ error: 'unauthorized' }, 401)
    let gateway: GatewayConnection | null
    try {
      const vmTokenHash = await hashApiKey(token)
      gateway = (await runtime.convex.query(
        fnQuery('domains/workspaces/provisioning:gatewayConnectionByVmToken'),
        { internalKey: runtime.internalKey, vmTokenHash },
      )) as GatewayConnection | null
    } catch {
      return c.json({ error: 'unauthorized' }, 401)
    }
    if (gateway === null) return c.json({ error: 'unauthorized' }, 401)
    const admission = requireWorkspaceAdmission(c, gateway)
    if ('response' in admission) return admission.response
    try {
      await runtime.convex.query(
        fnQuery('domains/agentSessions/model:authorizeWorkspaceSessionPoint'),
        {
          internalKey: runtime.internalKey,
          workspaceId: gateway.workspaceId,
          sessionId: c.req.param('sessionId'),
        },
      )
    } catch (error) {
      return sessionErrorResponse(c, error)
    }
    // Above the Composio branch and outside its failure, because the two are
    // independent lifecycles that happen to share one refresh call. Composio
    // being unconfigured, or its synchronization throwing, must not cost this
    // session the custom servers its own workspace registered — and this
    // projection is a read of durable rows that answers either way. A failure
    // here is best-effort by D17: the wake spawns without custom tools rather
    // than not at all.
    let mcpServers: Array<{ name: string }> | null = null
    try {
      mcpServers = (await runtime.convex.query(
        fnQuery('domains/mcpServers/turnConfig:projectMcpServersForSession'),
        {
          internalKey: runtime.internalKey,
          workspaceId: gateway.workspaceId,
          duetSessionId: c.req.param('sessionId'),
        },
      )) as Array<{ name: string }> | null
    } catch (error) {
      console.error('[agent-integrations-refresh] MCP server projection failed', {
        workspaceId: gateway.workspaceId,
        duetSessionId: c.req.param('sessionId'),
        error: error instanceof Error ? error.message : String(error),
      })
    }
    const refreshed = (integrations?: true) =>
      c.json(
        GatewaySessionIntegrationsRefreshResponseSchema.parse({
          ...(integrations === undefined ? {} : { integrations }),
          ...(mcpServers === null ? {} : { mcpServers }),
        }),
      )
    try {
      if (options.composioMcpProvider === undefined) {
        return refreshed()
      }
      const integrations = (await runtime.convex.mutation(
        fn('domains/integrations/turnConfig:projectToolRouterConfigForSession'),
        {
          internalKey: runtime.internalKey,
          workspaceId: gateway.workspaceId,
          duetSessionId: c.req.param('sessionId'),
          now: runtime.now(),
        },
      )) as true | null
      if (integrations !== null) {
        await synchronizeComposioSession(runtime, options.composioMcpProvider, {
          workspaceId: gateway.workspaceId,
          duetSessionId: c.req.param('sessionId'),
          callbackUrl: await createComposioToolRouterCallbackUrl({
            requestUrl: c.req.url,
            workspaceSlug: gateway.workspaceSlug,
            secret: runtime.apiInternalKey,
          }),
        })
      }
      return refreshed(integrations === null ? undefined : true)
    } catch (error) {
      // Composio's half fails closed — omitting `integrations` is exactly how
      // this response says "no integrations this turn", and the gateway's merge
      // reads the absence that way. It is not an error status, because the rest
      // of the answer is still good and a 503 would discard it.
      console.error('[agent-integrations-refresh] Synchronization failed', {
        workspaceId: gateway.workspaceId,
        duetSessionId: c.req.param('sessionId'),
        error: error instanceof Error ? error.message : String(error),
      })
      return refreshed()
    }
  })

  const createSession = async (c: ApiContext, createdBySessionId?: string) => {
    const authorized = requireAuthedWorkspace(c, 'sessions')
    if ('response' in authorized) return authorized.response
    const body = (
      createdBySessionId === undefined
        ? AgentStartSessionRequestSchema
        : AgentStartNestedSessionRequestSchema
    ).safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    // A nested create is authored by its parent session structurally: the
    // credential that carried the request never decides the child's author.
    const sender = requireInputSender(c, { parentSessionId: createdBySessionId })
    if ('response' in sender) return sender.response
    const identity = sessionRequestIdentityForAuth(c.get('auth'))
    const audience =
      createdBySessionId === undefined
        ? effectiveSessionCreationAudience(
            identity.principal,
            (body.data as AgentStartSessionRequest).audience,
          )
        : undefined
    if (audience === null) return c.json({ error: 'invalid_audience_member' }, 400)
    const clientRequestFingerprint =
      body.data.clientRequestId === undefined
        ? undefined
        : await fingerprintAgentInput({
            kind: 'initial_prompt',
            prompt: body.data.prompt,
            behavior: body.data.behavior,
            cwd: body.data.cwd,
            tier: body.data.tier,
            sender,
            ...(createdBySessionId === undefined ? { audience } : { createdBySessionId }),
            images: body.data.images,
            attachments: body.data.attachments,
            mode: body.data.mode,
          })
    const timer = createPhaseTimer()
    await options.sessionInputTestHooks?.beforePreflight?.()
    const workspace =
      createdBySessionId === undefined
        ? await requirePreflightedSessionCreationWorkspace(c, runtime, authorized, {
            ...(body.data.clientRequestId === undefined
              ? {}
              : { clientRequestId: body.data.clientRequestId }),
            ...(clientRequestFingerprint === undefined ? {} : { clientRequestFingerprint }),
            ...(body.data.cwd === undefined ? {} : { cwd: body.data.cwd }),
            audience: audience!,
          })
        : await requirePreflightedSessionSpendWorkspace(
            c,
            runtime,
            authorized,
            createdBySessionId,
            identity,
          )
    if ('response' in workspace) return workspace.response
    timer.mark('preflight')
    const submitted = await submitSessionInput({
      c,
      runtime,
      gatewayClient,
      workspace,
      images: body.data.images,
      deliveryKind: 'prompt',
      options,
      timer,
      beforePrepare: options.sessionInputTestHooks?.afterImagesStored,
      prepare: images => ({
        input: {
          kind: 'initial_prompt',
          prompt: body.data.prompt,
          behavior: body.data.behavior,
          sender,
          ...(body.data.clientRequestId === undefined
            ? {}
            : { clientRequestId: body.data.clientRequestId }),
          ...(clientRequestFingerprint === undefined ? {} : { clientRequestFingerprint }),
          ...(body.data.cwd === undefined ? {} : { cwd: body.data.cwd }),
          ...(images === undefined ? {} : { images }),
          ...(body.data.attachments === undefined ? {} : { attachments: body.data.attachments }),
          ...(body.data.tier === undefined ? {} : { tier: body.data.tier }),
          ...(body.data.mode === undefined ? {} : { mode: body.data.mode }),
          ...(audience === undefined ? {} : { audience }),
        },
        ...(createdBySessionId === undefined ? {} : { createdBySessionId }),
        attemptPrefix: 'create',
        projectIntegrations: options.composioMcpProvider !== undefined,
      }),
    })
    if (submitted.kind === 'rejected') return submitted.response
    if (submitted.kind === 'integration_unavailable') {
      return c.json({ error: 'integration_unavailable' }, 503)
    }
    const prepared = submitted.prepared
    if (prepared.created === undefined) throw new Error('Created session state is missing')
    const delivery = submitted
    const snapshot: SessionSnapshot =
      delivery.marked === undefined
        ? prepared.created.snapshot
        : {
            ...prepared.created.snapshot,
            turnStatus: delivery.marked.status,
            lastDeliveredInputSeq: delivery.marked.lastDeliveredInputSeq,
            deliveryAttempt: delivery.marked.deliveryAttempt,
          }
    c.header('server-timing', timer.header())
    return c.json(
      {
        session:
          'queued' in prepared
            ? {
                sessionId: prepared.sessionId,
                status: prepared.created.snapshot.turnStatus,
                lastEventSeq: prepared.created.snapshot.lastEventSeq,
                lastDeliveredInputSeq: prepared.created.snapshot.lastDeliveredInputSeq,
              }
            : sessionResponse(prepared, delivery.marked?.lastDeliveredInputSeq ?? 0),
        snapshot,
        history: prepared.created.history,
        dispatched: false,
        delivery: delivery.delivery,
      },
      201,
    )
  }

  app.post('/v1/ws/:workspaceSlug/agent/sessions', c => createSession(c))
  app.post('/v1/ws/:workspaceSlug/agent/sessions/:sessionId/sessions', c =>
    createSession(c, c.req.param('sessionId')),
  )

  app.get('/v1/ws/:workspaceSlug/agent/sessions', async c => {
    const workspace = requireAuthedWorkspace(c, 'sessions')
    if ('response' in workspace) return workspace.response
    const url = new URL(c.req.url)
    const query = SessionListQuerySchema.safeParse(Object.fromEntries(url.searchParams))
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const identity = sessionRequestIdentityForAuth(c.get('auth'))
    try {
      const sessions = await runtime.convex.query(
        fnQuery('domains/agentSessions/model:listSessions'),
        {
          internalKey: runtime.internalKey,
          identity,
          ...(identity.principal.kind === 'human' ? { actorId: identity.principal.userId } : {}),
          workspaceId: workspace.id,
          cursor: query.data.cursor,
          limit: query.data.limit,
          search: query.data.search,
          bucket: query.data.bucket,
          archived: query.data.archived,
          agentId: query.data.agentId,
          excludeDefault: query.data.excludeDefault,
          topLevel: query.data.topLevel,
        },
      )
      return c.json(sessions)
    } catch (error) {
      if (isCollectionCursorError(error)) return c.json({ error: 'invalid_cursor' }, 400)
      throw error
    }
  })

  /* Declared *before* `/:sessionId`. Hono matches in registration order, so a
     literal segment registered after a parameter loses to it — and the loss is
     silent: `activity` arrives as a session id and the route answers 404 for a
     session nobody asked for. `agent-routes.test.ts` pins the order. */
  app.get('/v1/ws/:workspaceSlug/agent/sessions/activity', async c => {
    const workspace = requireAuthedWorkspace(c, 'sessions')
    if ('response' in workspace) return workspace.response
    const url = new URL(c.req.url)
    const query = SessionActivityQuerySchema.safeParse(Object.fromEntries(url.searchParams))
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const activity = await runtime.convex.query(
      fnQuery('domains/agentSessions/model:sessionActivity'),
      {
        internalKey: runtime.internalKey,
        identity: sessionRequestIdentityForAuth(c.get('auth')),
        workspaceId: workspace.id,
        limitPerAgent: query.data.limitPerAgent,
      },
    )
    return c.json(activity)
  })

  app.get('/v1/ws/:workspaceSlug/agent/sessions/:sessionId/sessions', async c => {
    const workspace = requireAuthedWorkspace(c, 'sessions')
    if ('response' in workspace) return workspace.response
    const query = SessionChildrenQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    )
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const identity = sessionRequestIdentityForAuth(c.get('auth'))
    try {
      return c.json(
        await runtime.convex.query(fnQuery('domains/agentSessions/model:listChildSessions'), {
          internalKey: runtime.internalKey,
          identity,
          ...(identity.principal.kind === 'human' ? { actorId: identity.principal.userId } : {}),
          workspaceId: workspace.id,
          parentSessionId: c.req.param('sessionId'),
          cursor: query.data.cursor,
          limit: query.data.limit,
          bucket: query.data.bucket,
          archived: query.data.archived,
        }),
      )
    } catch (error) {
      if (isCollectionCursorError(error)) return c.json({ error: 'invalid_cursor' }, 400)
      return sessionErrorResponse(c, error)
    }
  })

  app.get('/v1/ws/:workspaceSlug/agent/sessions/:sessionId/audience', async c => {
    const workspace = requireAuthedWorkspace(c, 'sessions')
    if ('response' in workspace) return workspace.response
    const query = SessionAudiencePageQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    )
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      return c.json(
        await runtime.convex.query(fnQuery('domains/agentSessions/model:listSessionAudience'), {
          internalKey: runtime.internalKey,
          workspaceId: workspace.id,
          sessionId: c.req.param('sessionId'),
          identity: sessionRequestIdentityForAuth(c.get('auth')),
          cursor: query.data.cursor,
          limit: query.data.limit,
        }),
      )
    } catch (error) {
      if (isCollectionCursorError(error)) return c.json({ error: 'invalid_cursor' }, 400)
      return sessionErrorResponse(c, error)
    }
  })

  app.patch('/v1/ws/:workspaceSlug/agent/sessions/:sessionId/audience', async c => {
    const workspace = requireAuthedWorkspace(c, 'sessions')
    if ('response' in workspace) return workspace.response
    const body = SessionAudienceDeltaRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_audience_delta' }, 400)
    try {
      const session = await runtime.convex.mutation(
        fn('domains/agentSessions/model:applySessionAudienceDelta'),
        {
          internalKey: runtime.internalKey,
          workspaceId: workspace.id,
          sessionId: c.req.param('sessionId'),
          identity: sessionRequestIdentityForAuth(c.get('auth')),
          add: body.data.add ?? [],
          remove: body.data.remove ?? [],
          now: runtime.now(),
        },
      )
      return session === null ? c.body(null, 204) : c.json(session)
    } catch (error) {
      return sessionErrorResponse(c, error)
    }
  })

  app.get('/v1/ws/:workspaceSlug/agent/sessions/:sessionId', async c => {
    const workspace = requireAuthedWorkspace(c, 'sessions')
    if ('response' in workspace) return workspace.response
    const session = await getSessionPointForRoute(
      c,
      runtime,
      workspace.id,
      c.req.param('sessionId'),
    )
    if (session !== null && 'errorResponse' in session) return session.errorResponse
    return session === null ? c.json({ error: 'not_found' }, 404) : c.json(session)
  })

  app.get('/v1/ws/:workspaceSlug/agent/sessions/:sessionId/history', async c => {
    const workspace = requireAuthedWorkspace(c, 'sessions')
    if ('response' in workspace) return workspace.response
    const url = new URL(c.req.url)
    const query = SessionHistoryQuerySchema.safeParse(Object.fromEntries(url.searchParams))
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      return c.json(
        await runtime.convex.query(fnQuery('domains/agentSessions/model:listSessionHistoryPage'), {
          internalKey: runtime.internalKey,
          identity: sessionRequestIdentityForAuth(c.get('auth')),
          workspaceId: workspace.id,
          sessionId: c.req.param('sessionId'),
          ...query.data,
        }),
      )
    } catch (error) {
      if (isCollectionCursorError(error)) return c.json({ error: 'invalid_cursor' }, 400)
      return sessionErrorResponse(c, error)
    }
  })

  app.post('/v1/ws/:workspaceSlug/agent/sessions/:sessionId/cwd', async c => {
    const workspace = requireAuthedWorkspace(c, 'sessions')
    if ('response' in workspace) return workspace.response
    const body = SessionCwdRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const sessionId = c.req.param('sessionId')
    const session = await getSessionPointForRoute(c, runtime, workspace.id, sessionId)
    if (session !== null && 'errorResponse' in session) return session.errorResponse
    if (session === null) return c.json({ error: 'not_found' }, 404)
    const gateway = await gatewayClient
      .callAgent(c, workspace.slug, {
        path: `/v1/agent/sessions/${encodeURIComponent(sessionId)}/cwd`,
        method: 'POST',
        body: JSON.stringify(body.data),
        passthroughStatuses: [422],
        failureOperation: 'session_cwd',
      })
      .catch(() => null)
    if (gateway === null) return c.json({ error: 'agent_gateway_unavailable' }, 502)
    if ('response' in gateway) return gateway.response
    const receipt = GatewaySessionCwdReceiptSchema.parse(gateway.body)
    try {
      const committed = await runtime.convex.mutation(
        fn('domains/agentSessions/model:setSessionCwd'),
        {
          internalKey: runtime.internalKey,
          actorId: c.get('auth').user.id,
          identity: sessionRequestIdentityForAuth(c.get('auth')),
          workspaceId: workspace.id,
          sessionId,
          ...(session.cwd === undefined ? {} : { expectedCwd: session.cwd }),
          cwd: receipt.cwd,
          now: runtime.now(),
        },
      )
      return c.json({ session: committed })
    } catch (error) {
      if (error instanceof Error && /Cwd conflict/i.test(error.message)) {
        // The gateway already adopted this request's cwd before the CAS
        // lost. Re-align it with the row's authoritative value (best-effort;
        // ordinary dispatch re-projection remains the backstop).
        const current = await getSessionPointForRoute(c, runtime, workspace.id, sessionId)
        const authoritativeCwd =
          current !== null && !('errorResponse' in current) ? current.cwd : undefined
        if (authoritativeCwd !== undefined) {
          await gatewayClient
            .callAgent(c, workspace.slug, {
              path: `/v1/agent/sessions/${encodeURIComponent(sessionId)}/cwd`,
              method: 'POST',
              body: JSON.stringify({ cwd: authoritativeCwd }),
            })
            .catch(() => undefined)
        }
        return c.json({ error: 'cwd_conflict' }, 409)
      }
      return sessionErrorResponse(c, error)
    }
  })

  app.patch('/v1/ws/:workspaceSlug/agent/sessions/:sessionId', async c => {
    const workspace = requireAuthedWorkspace(c, 'sessions')
    if ('response' in workspace) return workspace.response
    const body = SessionRenameRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const session = await runtime.convex.mutation(
        fn('domains/agentSessions/model:renameSession'),
        {
          internalKey: runtime.internalKey,
          actorId: c.get('auth').user.id,
          identity: sessionRequestIdentityForAuth(c.get('auth')),
          workspaceId: workspace.id,
          sessionId: c.req.param('sessionId'),
          title: body.data.title,
          now: runtime.now(),
        },
      )
      return c.json(session)
    } catch (error) {
      return sessionErrorResponse(c, error)
    }
  })

  app.put('/v1/ws/:workspaceSlug/agent/sessions/:sessionId/archive', async c => {
    const workspace = requireAuthedWorkspace(c, 'sessions')
    if ('response' in workspace) return workspace.response
    const body = SessionArchiveRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const session = await runtime.convex.mutation(
        fn('domains/agentSessions/model:setSessionArchive'),
        {
          internalKey: runtime.internalKey,
          actorId: c.get('auth').user.id,
          identity: sessionRequestIdentityForAuth(c.get('auth')),
          workspaceId: workspace.id,
          sessionId: c.req.param('sessionId'),
          kind: body.data.kind,
          archived: body.data.archived,
          now: runtime.now(),
        },
      )
      return c.json(session)
    } catch (error) {
      return sessionErrorResponse(c, error)
    }
  })

  /* The only writer of a read cursor anywhere in the product. Nothing on the
     agent's own path calls it: an agent watching its own work must not clear a
     human's badge, and the way that is guaranteed is that no agent code path
     reaches this route — not a scope check on a route both share. */
  app.put('/v1/ws/:workspaceSlug/agent/sessions/:sessionId/read', async c => {
    const workspace = requireAuthedWorkspace(c, 'sessions')
    if ('response' in workspace) return workspace.response
    const body = SessionReadRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const result = await runtime.convex.mutation(
        fn('domains/agentSessions/model:markSessionRead'),
        {
          internalKey: runtime.internalKey,
          actorId: c.get('auth').user.id,
          identity: sessionRequestIdentityForAuth(c.get('auth')),
          workspaceId: workspace.id,
          sessionId: c.req.param('sessionId'),
          seq: body.data.seq,
          now: runtime.now(),
        },
      )
      return c.json(result)
    } catch (error) {
      return sessionErrorResponse(c, error)
    }
  })

  app.post('/v1/ws/:workspaceSlug/agent/sessions/:sessionId/messages', async c => {
    const authorized = requireAuthedWorkspace(c, 'sessions')
    if ('response' in authorized) return authorized.response
    const body = AgentMessageRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const sender = requireInputSender(c, { sourceSessionId: body.data.sourceSessionId })
    if ('response' in sender) return sender.response
    const timer = createPhaseTimer()
    await options.sessionInputTestHooks?.beforePreflight?.()
    // The spend preflight runs inside the prepare transaction (one round trip
    // decides and prepares); a refusal comes back from there as the response.
    const workspace = authorized
    const clientRequestFingerprint =
      body.data.clientRequestId === undefined
        ? undefined
        : await fingerprintAgentInput({
            kind: 'message',
            prompt: body.data.prompt,
            behavior: body.data.behavior,
            tier: body.data.tier,
            images: body.data.images,
            attachments: body.data.attachments,
            sender,
          })
    const submitted = await submitSessionInput({
      c,
      runtime,
      gatewayClient,
      workspace,
      images: body.data.images,
      deliveryKind: 'prompt',
      options,
      timer,
      beforePrepare: options.sessionInputTestHooks?.afterImagesStored,
      prepare: images => ({
        sessionId: c.req.param('sessionId'),
        preflight: {
          ...(body.data.sourceSessionId === undefined
            ? {}
            : { sourceSessionId: body.data.sourceSessionId }),
        },
        input: {
          kind: 'message',
          prompt: body.data.prompt,
          behavior: body.data.behavior,
          sender,
          ...(body.data.clientRequestId === undefined
            ? {}
            : { clientRequestId: body.data.clientRequestId }),
          ...(clientRequestFingerprint === undefined ? {} : { clientRequestFingerprint }),
          ...(images === undefined ? {} : { images }),
          ...(body.data.attachments === undefined ? {} : { attachments: body.data.attachments }),
          ...(body.data.tier === undefined ? {} : { tier: body.data.tier }),
        },
        attemptPrefix: 'message',
        projectIntegrations: options.composioMcpProvider !== undefined,
      }),
    })
    if (submitted.kind === 'rejected') return submitted.response
    if (submitted.kind === 'integration_unavailable') {
      return c.json({ error: 'integration_unavailable' }, 503)
    }
    c.header('server-timing', timer.header())
    return c.json({ ok: true, delivery: submitted.delivery }, 202)
  })

  app.post('/v1/ws/:workspaceSlug/agent/sessions/:sessionId/note', async c => {
    const workspace = requireAuthedWorkspace(c, 'sessions')
    if ('response' in workspace) return workspace.response
    const body = AgentNoteRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const admitted = await getSessionPointForRoute(
      c,
      runtime,
      workspace.id,
      c.req.param('sessionId'),
    )
    if (admitted !== null && 'errorResponse' in admitted) return admitted.errorResponse
    if (admitted === null) return c.json({ error: 'not_found' }, 404)
    const sender = requireInputSender(c, { sourceSessionId: body.data.sourceSessionId })
    if ('response' in sender) return sender.response
    const clientRequestFingerprint =
      body.data.clientRequestId === undefined
        ? undefined
        : await fingerprintAgentInput({
            kind: 'note',
            note: body.data.note,
            images: body.data.images,
            attachments: body.data.attachments,
            sender,
          })
    const images = await storeAgentInputImages(runtime, body.data.images)
    try {
      const result = (await runtime.convex.mutation(
        fn('domains/agentSessions/model:appendSessionNote'),
        {
          internalKey: runtime.internalKey,
          actorId: c.get('auth').user.id,
          identity: sessionRequestIdentityForAuth(c.get('auth')),
          workspaceId: workspace.id,
          sessionId: c.req.param('sessionId'),
          note: body.data.note,
          sender,
          ...(body.data.clientRequestId === undefined
            ? {}
            : { clientRequestId: body.data.clientRequestId }),
          ...(clientRequestFingerprint === undefined ? {} : { clientRequestFingerprint }),
          ...(images === undefined ? {} : { images }),
          ...(body.data.attachments === undefined ? {} : { attachments: body.data.attachments }),
          now: runtime.now(),
        },
      )) as { seq: number; deduplicated?: true }
      if (result.deduplicated === true) await discardAgentInputImages(runtime, images)
      return c.json({ seq: result.seq }, 202)
    } catch (error) {
      try {
        const response = sessionErrorResponse(c, error)
        await discardAgentInputImages(runtime, images)
        return response
      } catch {
        // A Convex transport error can arrive after the append committed.
        // Keep the blobs because the durable event may reference them.
        throw error
      }
    }
  })

  app.get('/v1/ws/:workspaceSlug/agent/sessions/:sessionId/events', async c => {
    const workspace = requireAuthedWorkspace(c, 'sessions')
    if ('response' in workspace) return workspace.response
    const sessionId = c.req.param('sessionId')
    const admitted = await getSessionPointForRoute(c, runtime, workspace.id, sessionId)
    if (admitted !== null && 'errorResponse' in admitted) return admitted.errorResponse
    const session = admitted
    if (session === null) return c.json({ error: 'not_found' }, 404)
    const query = SessionEventResumeQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    )
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const resume = parseSessionLastEventId(c.req.header('last-event-id'))
    if (!resume.ok) return c.json({ error: resume.error }, 400)
    if (resume.afterSeq > session.lastEventSeq) {
      return c.json({ error: 'last_event_id_ahead' }, 409)
    }
    return new Response(
      createSessionEventStream({
        convex: runtime.convex,
        internalKey: runtime.internalKey,
        gatewayClient,
        workspaceSlug: workspace.slug,
        workspaceId: workspace.id,
        sessionId: session.id,
        afterSeq: resume.afterSeq,
      }),
      {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
      },
    )
  })

  app.get('/v1/ws/:workspaceSlug/agent/sessions/:sessionId/images/:storageId', async c => {
    const workspace = requireAuthedWorkspace(c, 'sessions')
    if ('response' in workspace) return workspace.response
    const admitted = await getSessionPointForRoute(
      c,
      runtime,
      workspace.id,
      c.req.param('sessionId'),
    )
    if (admitted !== null && 'errorResponse' in admitted) return admitted.errorResponse
    if (admitted === null) return c.json({ error: 'not_found' }, 404)
    try {
      const image = (await runtime.convex.action(
        fnAction('domains/agentSessions/model:sessionImageUrl'),
        {
          internalKey: runtime.internalKey,
          workspaceId: workspace.id,
          sessionId: c.req.param('sessionId'),
          storageId: c.req.param('storageId'),
          identity: sessionRequestIdentityForAuth(c.get('auth')),
        },
      )) as { url: string; mimeType: string } | null
      if (image === null) return c.json({ error: 'not_found' }, 404)
      const upstream = await fetch(image.url)
      if (!upstream.ok || upstream.body === null) return c.json({ error: 'not_found' }, 404)
      return new Response(upstream.body, {
        status: 200,
        headers: {
          'content-type': image.mimeType,
          ...(upstream.headers.get('content-length') === null
            ? {}
            : { 'content-length': upstream.headers.get('content-length')! }),
        },
      })
    } catch (error) {
      return sessionErrorResponse(c, error)
    }
  })

  app.post('/v1/ws/:workspaceSlug/agent/sessions/:sessionId/answer', async c => {
    const authorized = requireAuthedWorkspace(c, 'sessions')
    if ('response' in authorized) return authorized.response
    const body = AgentAnswerRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const sender = requireInputSender(c, { sourceSessionId: body.data.sourceSessionId })
    if ('response' in sender) return sender.response
    const timer = createPhaseTimer()
    await options.sessionInputTestHooks?.beforePreflight?.()
    // The spend preflight runs inside the prepare transaction (one round trip
    // decides and prepares); a refusal comes back from there as the response.
    const workspace = authorized
    const clientRequestFingerprint =
      body.data.clientRequestId === undefined
        ? undefined
        : await fingerprintAgentInput({
            kind: 'answer',
            answer: body.data.answer,
            images: body.data.images,
            attachments: body.data.attachments,
            sender,
          })
    const submitted = await submitSessionInput({
      c,
      runtime,
      gatewayClient,
      workspace,
      images: body.data.images,
      deliveryKind: 'answer',
      options,
      timer,
      beforePrepare: options.sessionInputTestHooks?.afterImagesStored,
      prepare: images => ({
        sessionId: c.req.param('sessionId'),
        preflight: {
          ...(body.data.sourceSessionId === undefined
            ? {}
            : { sourceSessionId: body.data.sourceSessionId }),
        },
        input: {
          kind: 'answer',
          answer: body.data.answer,
          sender,
          ...(body.data.clientRequestId === undefined
            ? {}
            : { clientRequestId: body.data.clientRequestId }),
          ...(clientRequestFingerprint === undefined ? {} : { clientRequestFingerprint }),
          ...(images === undefined ? {} : { images }),
          ...(body.data.attachments === undefined ? {} : { attachments: body.data.attachments }),
        },
        attemptPrefix: 'answer',
        projectIntegrations: options.composioMcpProvider !== undefined,
      }),
    })
    if (submitted.kind === 'rejected') return submitted.response
    if (submitted.kind === 'integration_unavailable') {
      return c.json({ error: 'integration_unavailable' }, 503)
    }
    c.header('server-timing', timer.header())
    return c.json({ ok: true, delivery: submitted.delivery }, 202)
  })

  app.post('/v1/ws/:workspaceSlug/agent/sessions/:sessionId/interrupt', async c => {
    const workspace = requireAuthedWorkspace(c, 'sessions')
    if ('response' in workspace) return workspace.response
    try {
      await runtime.convex.mutation(fn('domains/agentSessions/model:requestInterrupt'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        identity: sessionRequestIdentityForAuth(c.get('auth')),
        workspaceId: workspace.id,
        sessionId: c.req.param('sessionId'),
        now: runtime.now(),
      })
    } catch (error) {
      return sessionErrorResponse(c, error)
    }
    const dispatched = await gatewayClient.callAgent(c, workspace.slug, {
      path: `/v1/agent/sessions/${encodeURIComponent(c.req.param('sessionId'))}/interrupt`,
      method: 'POST',
      body: JSON.stringify({}),
    })
    // Local cancellation cannot cover input the VM has not accepted. When no
    // native runner received the interrupt (or the gateway never answered),
    // also consume the backend queue so delivery cannot undo the user's stop.
    if ('response' in dispatched || !interruptWasDelivered(dispatched.body)) {
      await runtime.convex.mutation(
        fn('domains/agentSessions/model:finalizeUndeliverableInterrupt'),
        {
          internalKey: runtime.internalKey,
          workspaceId: workspace.id,
          sessionId: c.req.param('sessionId'),
          now: runtime.now(),
        },
      )
    }
    return c.json({ ok: true })
  })

  app.on(['GET', 'POST'], '/v1/vm/agent/sessions/:sessionId/interrupted-checkpoint', async c => {
    const token = extractBearerToken(c.req.header('authorization') ?? null)
    if (token === null) return c.json({ error: 'unauthorized' }, 401)
    const gateway = (await runtime.convex.query(
      fnQuery('domains/workspaces/provisioning:gatewayConnectionByVmToken'),
      { internalKey: runtime.internalKey, vmTokenHash: await hashApiKey(token) },
    )) as GatewayConnection | null
    if (gateway === null) return c.json({ error: 'unauthorized' }, 401)
    const admission = requireWorkspaceAdmission(c, gateway)
    if ('response' in admission) return admission.response
    const point = {
      internalKey: runtime.internalKey,
      workspaceId: gateway.workspaceId,
      sessionId: c.req.param('sessionId'),
    }
    try {
      if (c.req.method === 'GET') {
        const target = await runtime.convex.query(
          fnQuery('domains/agentSessions/model:interruptedCheckpointTarget'),
          point,
        )
        return c.json(target)
      }
      const body = InterruptedCheckpointTargetSchema.safeParse(await readJson(c.req.raw))
      if (!body.success) return c.json({ error: 'invalid_request' }, 400)
      const repaired = await runtime.convex.mutation(
        fn('domains/agentSessions/model:reconcileInterruptedCheckpoint'),
        { ...point, ...body.data, now: runtime.now() },
      )
      return c.json({ repaired })
    } catch (error) {
      return sessionErrorResponse(c, error)
    }
  })

  app.post('/v1/vm/agent/sessions/:sessionId/events', async c => {
    const token = extractBearerToken(c.req.header('authorization') ?? null)
    if (token === null) return c.json({ error: 'unauthorized' }, 401)
    try {
      const vmTokenHash = await hashApiKey(token)
      const gateway = (await runtime.convex.query(
        fnQuery('domains/workspaces/provisioning:gatewayConnectionByVmToken'),
        {
          internalKey: runtime.internalKey,
          vmTokenHash,
        },
      )) as GatewayConnection | null
      if (gateway !== null) {
        const admission = requireWorkspaceAdmission(c, gateway)
        if ('response' in admission) return admission.response
      }
      const body = AgentVmRelayEventRequestSchema.safeParse(await readJson(c.req.raw))
      if (!body.success) return c.json({ error: 'invalid_request' }, 400)
      let workspaceId = gateway?.workspaceId
      if (workspaceId === undefined) {
        if (
          !AGENT_TERMINAL_STATES.includes(
            body.data.event.type as (typeof AGENT_TERMINAL_STATES)[number],
          )
        ) {
          return c.json({ error: 'unauthorized' }, 401)
        }
        const paused = (await runtime.convex.query(
          fnQuery('domains/workspaces/provisioning:workspaceForVmTerminalRelay'),
          { internalKey: runtime.internalKey, vmTokenHash },
        )) as {
          workspaceId: string
          workspaceSlug: string
          servicingStatus: string
          onboardedAt?: number
        } | null
        if (
          paused === null ||
          (paused.servicingStatus !== 'paused' && paused.servicingStatus !== 'banned')
        ) {
          return c.json({ error: 'unauthorized' }, 401)
        }
        const admission = requireWorkspaceAdmission(c, paused)
        if ('response' in admission) return admission.response
        workspaceId = paused.workspaceId
      }
      await runtime.convex.query(
        fnQuery('domains/agentSessions/model:authorizeWorkspaceSessionPoint'),
        {
          internalKey: runtime.internalKey,
          workspaceId,
          sessionId: c.req.param('sessionId'),
        },
      )
      const result = await runtime.convex.mutation(
        fn('domains/agentSessions/model:relayRunnerEvent'),
        {
          internalKey: runtime.internalKey,
          workspaceId,
          sessionId: c.req.param('sessionId'),
          relayId: body.data.relayId,
          event: body.data.event,
          ...(body.data.acceptedThroughSeq === undefined
            ? {}
            : { acceptedThroughSeq: body.data.acceptedThroughSeq }),
          now: runtime.now(),
        },
      )
      return c.json(result)
    } catch (error) {
      try {
        return sessionErrorResponse(c, error)
      } catch {
        // Continue to protocol and infrastructure mappings below.
      }
      if (error instanceof Error && /protocol mismatch/i.test(error.message)) {
        return c.json({ error: 'agent_protocol_mismatch' }, 409)
      }
      // Every authorization failure on this route is an explicit answer above;
      // nothing that lands here is one. A document the store refuses reported
      // as `401` sent a live incident's diagnosis to the wrong rail for hours,
      // so what arrives here reports as ours, with the cause in the log.
      console.error(
        `[agent-relay] ${c.req.param('sessionId')} relay failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return c.json({ error: 'relay_failed' }, 502)
    }
  })
}

async function getSessionPointForRoute(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  workspaceId: string,
  sessionId: string,
): Promise<SessionSnapshot | null | { errorResponse: Response }> {
  try {
    return (await runtime.convex.query(fnQuery('domains/agentSessions/model:getSessionPoint'), {
      internalKey: runtime.internalKey,
      identity: sessionRequestIdentityForAuth(c.get('auth')),
      workspaceId,
      sessionId,
    })) as SessionSnapshot | null
  } catch (error) {
    return { errorResponse: sessionErrorResponse(c, error) }
  }
}

function interruptWasDelivered(body: unknown): boolean {
  const receipt = GatewaySessionInterruptReceiptSchema.safeParse(body)
  return receipt.success && receipt.data.interrupted
}
