import {
  agentIsLaunchable,
  DefaultSessionMessageRequestSchema,
  ROOT_AGENT_SCOPE,
  isCollectionCursorError,
  SessionHistoryQuerySchema,
  SetDefaultSessionRequestSchema,
  type SessionSnapshot,
} from '@repo/contract'

import { fingerprintAgentInput, sessionResponse } from '../agent-runner'
import type { GatewayClient } from '../gateway/client'
import { sessionErrorResponse } from '../session-errors'
import { sessionRequestIdentityForAuth } from '../session-principal'
import { requireInputSender } from '../session-sender'
import { submitSessionInput } from '../session-submission'
import {
  fn,
  fnQuery,
  readJson,
  requireAuthedWorkspace,
  requirePreflightedDefaultSessionSpendWorkspace,
  type ApiApp,
  type ApiContext,
  type ApiRouteRuntime,
  type ComposioMcpProvider,
  type SessionInputTestHooks,
  type WaitUntil,
} from '../shared'

interface DefaultSessionRouteOptions {
  waitUntil: WaitUntil
  composioMcpProvider?: ComposioMcpProvider
  sessionInputTestHooks?: SessionInputTestHooks
}

export type ResolvedDefaultSessionOwner =
  | { kind: 'root' }
  | { kind: 'agent'; agentId: string; cwd: string }

export function registerDefaultSessionRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
  options: DefaultSessionRouteOptions,
): void {
  app.get('/v1/ws/:workspaceSlug/agents/:agentSlug/sessions/default', c =>
    getDefaultSessionRoute(c, runtime, c.req.param('agentSlug')),
  )
  app.put('/v1/ws/:workspaceSlug/agents/:agentSlug/sessions/default', c =>
    putDefaultSessionRoute(c, runtime, c.req.param('agentSlug')),
  )
  app.get('/v1/ws/:workspaceSlug/agents/:agentSlug/sessions/default/history', c =>
    getDefaultSessionHistoryRoute(c, runtime, c.req.param('agentSlug')),
  )
  app.post('/v1/ws/:workspaceSlug/agents/:agentSlug/sessions/default/messages', c =>
    postDefaultSessionMessageRoute(c, runtime, gatewayClient, options, c.req.param('agentSlug')),
  )
}

export async function resolveDefaultSessionOwner(
  runtime: ApiRouteRuntime,
  workspaceId: string,
  agentSlug: string,
): Promise<ResolvedDefaultSessionOwner | null> {
  // The drive root is an owner like any agent and is addressed the same way.
  // `root` is reserved in the slug grammar, so it can never name a real agent —
  // and `getBySlug` would throw on it rather than miss, which is why this
  // returns before the query rather than after.
  if (agentSlug === ROOT_AGENT_SCOPE) return { kind: 'root' }
  const agent = (await runtime.convex.query(fnQuery('domains/agents/model:getBySlug'), {
    internalKey: runtime.internalKey,
    workspaceId,
    slug: agentSlug,
  })) as { id: string; anchorPath: string; disabledAt?: number; anchorState: string } | null
  if (agent === null) return null
  // A disabled or broken-anchor agent has no folder to run in; without this
  // the backend's owner-mismatch guard rejects the create and the alias
  // surfaces a 500 instead of a deliberate miss.
  if (
    !agentIsLaunchable({ disabledAt: agent.disabledAt, anchorState: agent.anchorState as never })
  ) {
    return null
  }
  return { kind: 'agent', agentId: agent.id, cwd: agent.anchorPath }
}

export function defaultOwnerWire(owner: ResolvedDefaultSessionOwner) {
  return owner.kind === 'root'
    ? ({ kind: 'root' } as const)
    : ({ kind: 'agent', agentId: owner.agentId } as const)
}

async function queryDefaultSession(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  workspaceId: string,
  owner: ResolvedDefaultSessionOwner,
): Promise<SessionSnapshot | null> {
  return (await runtime.convex.query(fnQuery('domains/agentSessions/model:getDefaultSession'), {
    internalKey: runtime.internalKey,
    identity: sessionRequestIdentityForAuth(c.get('auth')),
    workspaceId,
    owner: defaultOwnerWire(owner),
  })) as SessionSnapshot | null
}

async function getDefaultSessionRoute(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  agentSlug: string,
): Promise<Response> {
  const workspace = requireAuthedWorkspace(c, 'sessions')
  if ('response' in workspace) return workspace.response
  const owner = await resolveDefaultSessionOwner(runtime, workspace.id, agentSlug)
  // `session: null` on a 200, never a 404: "no chat yet" is this read's
  // ordinary answer (most of a fresh drive), and browsers log every 4xx —
  // the map used to paint a console error per agent for a designed state.
  // An unknown or unlaunchable owner folds into the same null: either way
  // there is no conversation behind the alias to mount.
  if (owner === null) return c.json({ session: null })
  try {
    const session = await queryDefaultSession(c, runtime, workspace.id, owner)
    return c.json({ session })
  } catch (error) {
    return sessionErrorResponse(c, error)
  }
}

/**
 * Point the alias at a session, or — with `sessionId: null` — at nothing.
 *
 * Clearing is the demote gesture: the conversation is not archived and not
 * deleted, it simply stops being the owner's default, which is what puts it in
 * Jobs and empties the chat panel. The answer is the same `{ session }` body
 * the GET returns, so a clear reads back `{ session: null }` — whatever the
 * next GET would say.
 */
async function putDefaultSessionRoute(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  agentSlug: string,
): Promise<Response> {
  const workspace = requireAuthedWorkspace(c, 'sessions')
  if ('response' in workspace) return workspace.response
  const body = SetDefaultSessionRequestSchema.safeParse(await readJson(c.req.raw))
  if (!body.success) return c.json({ error: 'invalid_request' }, 400)
  const owner = await resolveDefaultSessionOwner(runtime, workspace.id, agentSlug)
  // Unlike the GET, which folds an unresolvable owner into its ordinary null,
  // a write must not report success against an owner that does not exist.
  if (owner === null) return c.json({ error: 'not_found' }, 404)
  try {
    const session = (await runtime.convex.mutation(
      fn('domains/agentSessions/model:setDefaultSession'),
      {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        identity: sessionRequestIdentityForAuth(c.get('auth')),
        workspaceId: workspace.id,
        owner: defaultOwnerWire(owner),
        sessionId: body.data.sessionId,
      },
    )) as SessionSnapshot | null
    return c.json({ session })
  } catch (error) {
    return sessionErrorResponse(c, error)
  }
}

async function getDefaultSessionHistoryRoute(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  agentSlug: string,
): Promise<Response> {
  const workspace = requireAuthedWorkspace(c, 'sessions')
  if ('response' in workspace) return workspace.response
  const query = SessionHistoryQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  )
  if (!query.success) return c.json({ error: 'invalid_request' }, 400)
  const owner = await resolveDefaultSessionOwner(runtime, workspace.id, agentSlug)
  if (owner === null) return c.json({ error: 'no_default_session' }, 404)
  try {
    return c.json(
      await runtime.convex.query(
        fnQuery('domains/agentSessions/model:listDefaultSessionHistoryPage'),
        {
          internalKey: runtime.internalKey,
          identity: sessionRequestIdentityForAuth(c.get('auth')),
          workspaceId: workspace.id,
          owner: defaultOwnerWire(owner),
          ...query.data,
        },
      ),
    )
  } catch (error) {
    if (isCollectionCursorError(error)) return c.json({ error: 'invalid_cursor' }, 400)
    return sessionErrorResponse(c, error)
  }
}

async function postDefaultSessionMessageRoute(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
  options: DefaultSessionRouteOptions,
  agentSlug: string,
): Promise<Response> {
  const authorized = requireAuthedWorkspace(c, 'sessions')
  if ('response' in authorized) return authorized.response
  const body = DefaultSessionMessageRequestSchema.safeParse(await readJson(c.req.raw))
  if (!body.success) return c.json({ error: 'invalid_request' }, 400)
  const sender = requireInputSender(c, { sourceSessionId: body.data.sourceSessionId })
  if ('response' in sender) return sender.response
  const owner = await resolveDefaultSessionOwner(runtime, authorized.id, agentSlug)
  if (owner === null) return c.json({ error: 'not_found' }, 404)
  await options.sessionInputTestHooks?.beforePreflight?.()
  const workspace = await requirePreflightedDefaultSessionSpendWorkspace(
    c,
    runtime,
    authorized,
    defaultOwnerWire(owner),
    sessionRequestIdentityForAuth(c.get('auth')),
    body.data.sourceSessionId,
  )
  if ('response' in workspace) return workspace.response
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
          agentFirstMessage: body.data.agentFirstMessage,
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
    beforePrepare: options.sessionInputTestHooks?.afterImagesStored,
    prepare: images => ({
      defaultOwner: defaultOwnerWire(owner),
      input: {
        kind: 'initial_prompt',
        prompt: body.data.prompt,
        behavior: body.data.behavior,
        sender,
        ...(body.data.clientRequestId === undefined
          ? {}
          : { clientRequestId: body.data.clientRequestId }),
        ...(clientRequestFingerprint === undefined ? {} : { clientRequestFingerprint }),
        ...(owner.kind === 'root' ? {} : { cwd: owner.cwd }),
        ...(images === undefined ? {} : { images }),
        ...(body.data.attachments === undefined ? {} : { attachments: body.data.attachments }),
        ...(body.data.tier === undefined ? {} : { tier: body.data.tier }),
        ...(body.data.agentFirstMessage === undefined
          ? {}
          : { agentFirstMessage: body.data.agentFirstMessage }),
      },
      attemptPrefix: 'default',
      projectIntegrations: options.composioMcpProvider !== undefined,
    }),
  })
  if (submitted.kind === 'rejected') return submitted.response
  if (submitted.kind === 'integration_unavailable') {
    return c.json({ error: 'integration_unavailable' }, 503)
  }
  const prepared = submitted.prepared
  const created = prepared.created
  if (created === undefined) {
    return c.json({ sessionId: prepared.sessionId, ok: true, delivery: submitted.delivery }, 202)
  }
  if ('queued' in prepared) {
    return c.json(
      {
        session: {
          sessionId: prepared.sessionId,
          status: created.snapshot.turnStatus,
          lastEventSeq: created.snapshot.lastEventSeq,
          lastDeliveredInputSeq: created.snapshot.lastDeliveredInputSeq,
        },
        snapshot: created.snapshot,
        history: created.history,
        dispatched: false,
        delivery: submitted.delivery,
      },
      201,
    )
  }
  const snapshot: SessionSnapshot =
    submitted.marked === undefined
      ? created.snapshot
      : {
          ...created.snapshot,
          turnStatus: submitted.marked.status,
          lastDeliveredInputSeq: submitted.marked.lastDeliveredInputSeq,
          deliveryAttempt: submitted.marked.deliveryAttempt,
        }
  return c.json(
    {
      session: sessionResponse(prepared, submitted.marked?.lastDeliveredInputSeq ?? 0),
      snapshot,
      history: created.history,
      dispatched: false,
      delivery: submitted.delivery,
    },
    201,
  )
}
