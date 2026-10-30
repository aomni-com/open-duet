import type { ZodType } from 'zod'

import {
  AgentAnswerWaitRequestSchema,
  AgentMessageWaitRequestSchema,
  AgentStartSessionWaitRequestSchema,
  AgentStartNestedSessionWaitRequestSchema,
  DefaultSessionMessageWaitRequestSchema,
  effectiveSessionCreationAudience,
  type AgentAnswerWaitRequest,
  type AgentMessageWaitRequest,
  type AgentStartSessionWaitRequest,
  type AgentStartNestedSessionWaitRequest,
  type DefaultSessionMessageWaitRequest,
} from '@repo/contract'

import { fingerprintAgentInput } from '../agent-runner'
import type { GatewayClient } from '../gateway/client'
import { sessionErrorResponse } from '../session-errors'
import { sessionRequestIdentityForAuth } from '../session-principal'
import { requireInputSender } from '../session-sender'
import { submitSessionInput } from '../session-submission'
import {
  createSessionWaitDependencies,
  observeSessionWait,
  SESSION_WAIT_TIMEOUT_MS,
} from '../session-wait'
import {
  fnQuery,
  readJson,
  requireAuthedWorkspace,
  requirePreflightedSpendWorkspace,
  requirePreflightedSessionCreationWorkspace,
  requirePreflightedSessionSpendWorkspace,
  requirePreflightedDefaultSessionSpendWorkspace,
  type ApiApp,
  type ApiContext,
  type ApiRouteRuntime,
  type ComposioMcpProvider,
  type SessionInputTestHooks,
  type WaitUntil,
  type WorkspaceRef,
} from '../shared'
import { defaultOwnerWire, resolveDefaultSessionOwner } from './default-session'

interface SessionWaitRouteOptions {
  waitUntil: WaitUntil
  composioMcpProvider?: ComposioMcpProvider
  sessionInputTestHooks?: SessionInputTestHooks
}

type WaitSubmission = Pick<
  Parameters<typeof submitSessionInput>[0],
  'images' | 'deliveryKind' | 'prepare'
>

export function registerSessionWaitRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
  options: SessionWaitRouteOptions,
): void {
  // Literals precede parameterized routes so "wait" and "default" can never
  // be interpreted as canonical session identifiers.
  app.post('/v1/ws/:workspaceSlug/agent/sessions/wait', c =>
    createWait(c, runtime, gatewayClient, options),
  )
  app.post('/v1/ws/:workspaceSlug/agents/:agentSlug/sessions/default/messages/wait', c =>
    defaultWait(c, runtime, gatewayClient, options, c.req.param('agentSlug')),
  )
  app.post('/v1/ws/:workspaceSlug/agent/sessions/:parentSessionId/sessions/wait', c =>
    createWait(c, runtime, gatewayClient, options, c.req.param('parentSessionId')),
  )
  app.post('/v1/ws/:workspaceSlug/agent/sessions/:sessionId/messages/wait', c =>
    messageWait(c, runtime, gatewayClient, options),
  )
  app.post('/v1/ws/:workspaceSlug/agent/sessions/:sessionId/answer/wait', c =>
    answerWait(c, runtime, gatewayClient, options),
  )
}

async function createWait(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
  options: SessionWaitRouteOptions,
  createdBySessionId?: string,
): Promise<Response> {
  return runWaitRoute<AgentStartSessionWaitRequest | AgentStartNestedSessionWaitRequest>(
    c,
    runtime,
    gatewayClient,
    createdBySessionId === undefined
      ? AgentStartSessionWaitRequestSchema
      : AgentStartNestedSessionWaitRequestSchema,
    async ({ request, authorized, deadlineAt }) => {
      const sender = requireInputSender(c, { parentSessionId: createdBySessionId })
      if ('response' in sender) return sender.response
      const identity = sessionRequestIdentityForAuth(c.get('auth'))
      const audience =
        createdBySessionId === undefined
          ? effectiveSessionCreationAudience(
              identity.principal,
              'audience' in request ? request.audience : undefined,
            )
          : undefined
      if (audience === null) return c.json({ error: 'invalid_audience_member' }, 400)
      const fingerprint = await fingerprintAgentInput({
        kind: 'initial_prompt',
        prompt: request.prompt,
        behavior: request.behavior,
        cwd: request.cwd,
        tier: request.tier,
        sender,
        ...(createdBySessionId === undefined ? { audience } : { createdBySessionId }),
        images: request.images,
        attachments: request.attachments,
        mode: request.mode,
      })
      return runInitialWait(c, runtime, gatewayClient, options, authorized, deadlineAt, {
        clientRequestId: request.clientRequestId,
        fingerprint,
        ...(audience === undefined
          ? {}
          : {
              preflightCreation: {
                clientRequestId: request.clientRequestId,
                clientRequestFingerprint: fingerprint,
                ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
                audience,
              },
            }),
        ...(createdBySessionId === undefined
          ? {}
          : {
              recoveryParentSessionId: createdBySessionId,
              preflightSessionId: createdBySessionId,
            }),
        prepareSubmission: () => ({
          images: request.images,
          deliveryKind: 'prompt',
          prepare: images => ({
            input: {
              kind: 'initial_prompt',
              prompt: request.prompt,
              behavior: request.behavior,
              sender,
              clientRequestId: request.clientRequestId,
              clientRequestFingerprint: fingerprint,
              ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
              ...(images === undefined ? {} : { images }),
              ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
              ...(request.tier === undefined ? {} : { tier: request.tier }),
              ...(request.mode === undefined ? {} : { mode: request.mode }),
              ...(audience === undefined ? {} : { audience }),
            },
            ...(createdBySessionId === undefined ? {} : { createdBySessionId }),
            attemptPrefix: 'create-wait',
            projectIntegrations: options.composioMcpProvider !== undefined,
          }),
        }),
      })
    },
  )
}

async function messageWait(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
  options: SessionWaitRouteOptions,
): Promise<Response> {
  return runWaitRoute<AgentMessageWaitRequest>(
    c,
    runtime,
    gatewayClient,
    AgentMessageWaitRequestSchema,
    async ({ request, authorized, deadlineAt }) => {
      const sessionId = c.req.param('sessionId')
      const sender = requireInputSender(c, { sourceSessionId: request.sourceSessionId })
      if ('response' in sender) return sender.response
      const fingerprint = await fingerprintAgentInput({
        kind: 'message',
        prompt: request.prompt,
        behavior: request.behavior,
        tier: request.tier,
        images: request.images,
        attachments: request.attachments,
        sender,
      })
      return runInitialWait(c, runtime, gatewayClient, options, authorized, deadlineAt, {
        clientRequestId: request.clientRequestId,
        fingerprint,
        recoverySessionId: sessionId,
        sourceSessionId: request.sourceSessionId,
        prepareSubmission: () => ({
          images: request.images,
          deliveryKind: 'prompt',
          prepare: images => ({
            sessionId,
            input: {
              kind: 'message',
              prompt: request.prompt,
              behavior: request.behavior,
              sender,
              clientRequestId: request.clientRequestId,
              clientRequestFingerprint: fingerprint,
              ...(images === undefined ? {} : { images }),
              ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
              ...(request.tier === undefined ? {} : { tier: request.tier }),
            },
            attemptPrefix: 'message-wait',
            projectIntegrations: options.composioMcpProvider !== undefined,
          }),
        }),
      })
    },
  )
}

async function answerWait(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
  options: SessionWaitRouteOptions,
): Promise<Response> {
  return runWaitRoute<AgentAnswerWaitRequest>(
    c,
    runtime,
    gatewayClient,
    AgentAnswerWaitRequestSchema,
    async ({ request, authorized, deadlineAt }) => {
      const sessionId = c.req.param('sessionId')
      const sender = requireInputSender(c, { sourceSessionId: request.sourceSessionId })
      if ('response' in sender) return sender.response
      const fingerprint = await fingerprintAgentInput({
        kind: 'answer',
        answer: request.answer,
        images: request.images,
        attachments: request.attachments,
        sender,
      })
      return runInitialWait(c, runtime, gatewayClient, options, authorized, deadlineAt, {
        clientRequestId: request.clientRequestId,
        fingerprint,
        recoverySessionId: sessionId,
        sourceSessionId: request.sourceSessionId,
        prepareSubmission: () => ({
          images: request.images,
          deliveryKind: 'answer',
          prepare: images => ({
            sessionId,
            input: {
              kind: 'answer',
              answer: request.answer,
              sender,
              clientRequestId: request.clientRequestId,
              clientRequestFingerprint: fingerprint,
              ...(images === undefined ? {} : { images }),
              ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
            },
            attemptPrefix: 'answer-wait',
            projectIntegrations: options.composioMcpProvider !== undefined,
          }),
        }),
      })
    },
  )
}

async function defaultWait(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
  options: SessionWaitRouteOptions,
  agentSlug: string,
): Promise<Response> {
  return runWaitRoute<DefaultSessionMessageWaitRequest>(
    c,
    runtime,
    gatewayClient,
    DefaultSessionMessageWaitRequestSchema,
    async ({ request, authorized, deadlineAt }) => {
      const sender = requireInputSender(c, { sourceSessionId: request.sourceSessionId })
      if ('response' in sender) return sender.response
      const owner = await resolveDefaultSessionOwner(runtime, authorized.id, agentSlug)
      if (owner === null) return c.json({ error: 'not_found' }, 404)
      const ownerWire = defaultOwnerWire(owner)
      const fingerprint = await fingerprintAgentInput({
        kind: 'message',
        defaultOwner: agentSlug,
        prompt: request.prompt,
        behavior: request.behavior,
        tier: request.tier,
        images: request.images,
        attachments: request.attachments,
        agentFirstMessage: request.agentFirstMessage,
        sender,
      })
      return runInitialWait(c, runtime, gatewayClient, options, authorized, deadlineAt, {
        clientRequestId: request.clientRequestId,
        fingerprint,
        recoveryDefaultOwner: ownerWire,
        preflightDefaultOwner: ownerWire,
        sourceSessionId: request.sourceSessionId,
        prepareSubmission: () => {
          return {
            images: request.images,
            deliveryKind: 'prompt',
            prepare: images => ({
              defaultOwner: ownerWire,
              input: {
                kind: 'initial_prompt',
                prompt: request.prompt,
                behavior: request.behavior,
                sender,
                clientRequestId: request.clientRequestId,
                clientRequestFingerprint: fingerprint,
                ...(owner.kind === 'root' ? {} : { cwd: owner.cwd }),
                ...(images === undefined ? {} : { images }),
                ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
                ...(request.tier === undefined ? {} : { tier: request.tier }),
                ...(request.agentFirstMessage === undefined
                  ? {}
                  : { agentFirstMessage: request.agentFirstMessage }),
              },
              attemptPrefix: 'default-wait',
              projectIntegrations: options.composioMcpProvider !== undefined,
            }),
          }
        },
      })
    },
  )
}

async function runWaitRoute<Request extends { clientRequestId: string }>(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
  schema: ZodType<Request>,
  submitInitial: (args: {
    request: Request
    authorized: WorkspaceRef
    deadlineAt: number
  }) => Promise<Response>,
): Promise<Response> {
  const deadlineAt = runtime.now() + SESSION_WAIT_TIMEOUT_MS
  const authorized = requireAuthedWorkspace(c, 'sessions')
  if ('response' in authorized) return authorized.response
  const body = schema.safeParse(await readJson(c.req.raw))
  if (!body.success) return c.json({ error: 'invalid_request' }, 400)
  return submitInitial({
    request: body.data,
    authorized,
    deadlineAt,
  })
}

async function runInitialWait(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
  options: SessionWaitRouteOptions,
  authorized: WorkspaceRef,
  deadlineAt: number,
  args: {
    clientRequestId: string
    fingerprint: string
    recoverySessionId?: string
    recoveryParentSessionId?: string
    recoveryDefaultOwner?: { kind: 'root' } | { kind: 'agent'; agentId: string }
    preflightSessionId?: string
    preflightDefaultOwner?: { kind: 'root' } | { kind: 'agent'; agentId: string }
    preflightCreation?: Parameters<typeof requirePreflightedSessionCreationWorkspace>[3]
    sourceSessionId?: string
    prepareSubmission: (
      workspace: WorkspaceRef,
    ) => WaitSubmission | { response: Response } | Promise<WaitSubmission | { response: Response }>
  },
): Promise<Response> {
  const recover = (workspace: WorkspaceRef) =>
    recoverWaitSubmission(
      c,
      runtime,
      workspace,
      args.clientRequestId,
      args.fingerprint,
      args.recoverySessionId,
      args.recoveryParentSessionId,
      args.recoveryDefaultOwner,
      args.sourceSessionId,
    )
  let recovered: { sessionId: string; inputSeq: number } | null
  try {
    recovered = await recover(authorized)
  } catch (error) {
    return sessionErrorResponse(c, error)
  }
  if (recovered !== null) {
    return respondToObservation(
      c,
      runtime,
      gatewayClient,
      authorized,
      recovered.sessionId,
      recovered.inputSeq,
      deadlineAt,
    )
  }
  await options.sessionInputTestHooks?.beforePreflight?.()
  const workspace =
    args.preflightCreation !== undefined
      ? await requirePreflightedSessionCreationWorkspace(
          c,
          runtime,
          authorized,
          args.preflightCreation,
        )
      : args.preflightDefaultOwner !== undefined
        ? await requirePreflightedDefaultSessionSpendWorkspace(
            c,
            runtime,
            authorized,
            args.preflightDefaultOwner,
            sessionRequestIdentityForAuth(c.get('auth')),
            args.sourceSessionId,
          )
        : args.preflightSessionId !== undefined || args.recoverySessionId !== undefined
          ? await requirePreflightedSessionSpendWorkspace(
              c,
              runtime,
              authorized,
              args.preflightSessionId ?? args.recoverySessionId!,
              sessionRequestIdentityForAuth(c.get('auth')),
              undefined,
              args.sourceSessionId,
            )
          : await requirePreflightedSpendWorkspace(c, runtime, authorized)
  if ('response' in workspace) return workspace.response
  const submission = await args.prepareSubmission(workspace)
  if ('response' in submission) return submission.response
  const submitted = await submitSessionInput({
    c,
    runtime,
    gatewayClient,
    workspace,
    options,
    ...submission,
    beforePrepare: options.sessionInputTestHooks?.afterImagesStored,
  })
  if (submitted.kind === 'rejected') return submitted.response
  if (submitted.kind === 'integration_unavailable') {
    return c.json({ error: 'integration_unavailable' }, 503)
  }
  return respondToObservation(
    c,
    runtime,
    gatewayClient,
    workspace,
    submitted.prepared.sessionId,
    submitted.prepared.submittedThroughSeq,
    deadlineAt,
  )
}

async function recoverWaitSubmission(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  workspace: WorkspaceRef,
  clientRequestId: string,
  clientRequestFingerprint: string,
  sessionId?: string,
  parentSessionId?: string,
  defaultOwner?: { kind: 'root' } | { kind: 'agent'; agentId: string },
  sourceSessionId?: string,
): Promise<{ sessionId: string; inputSeq: number } | null> {
  return (await runtime.convex.query(fnQuery('domains/agentSessions/model:findWaitSubmission'), {
    internalKey: runtime.apiInternalKey,
    workspaceId: workspace.id,
    identity: sessionRequestIdentityForAuth(c.get('auth')),
    clientRequestId,
    clientRequestFingerprint,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(defaultOwner === undefined ? {} : { defaultOwner }),
    ...(sourceSessionId === undefined ? {} : { sourceSessionId }),
  })) as { sessionId: string; inputSeq: number } | null
}

async function respondToObservation(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
  workspace: WorkspaceRef,
  sessionId: string,
  inputSeq: number,
  deadlineAt: number,
): Promise<Response> {
  const observation = await observeSessionWait(
    createSessionWaitDependencies({
      convex: runtime.convex,
      internalKey: runtime.apiInternalKey,
      gatewayClient,
      workspaceSlug: workspace.slug,
      now: runtime.now,
    }),
    {
      workspaceId: workspace.id,
      sessionId,
      inputSeq,
      signal: c.req.raw.signal,
      deadlineAt,
    },
  )
  if (observation.status === 'completed') {
    return c.json({
      sessionId,
      inputSeq,
      // The covered session's cwd, when it has one: the terminal result's
      // relative file paths resolve in that frame, not the caller's.
      ...(observation.cwd === undefined ? {} : { cwd: observation.cwd }),
      terminal: observation.terminal,
    })
  }
  return c.json(
    {
      sessionId,
      inputSeq,
      status: 'pending' as const,
    },
    202,
  )
}
