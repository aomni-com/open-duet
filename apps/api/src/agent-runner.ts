import { type ConvexHttpClient } from 'convex/browser'

import {
  AgentInputImageSchema,
  GatewayRunnerInputReceiptSchema,
  type GatewayRunnerInputRequest,
  type AgentEventAttachment,
  type AgentInputImage,
  type IntegrationTurnLaunch,
  type McpServerTurnLaunch,
  type AgentStateMachineDefinition,
  type ModelSelectionId,
  type AgentPromptBehavior,
  type AgentSessionStatus,
  type RunnerDeliveryAttempt,
  type SessionInitialHistorySnapshot,
  type SessionInputSender,
  type SessionSnapshot,
} from '@repo/contract'

import { type GatewayClient } from './gateway/client'
import { sessionErrorResponse } from './session-errors'
import { sessionRequestIdentityForAuth } from './session-principal'
import {
  fn,
  fnAction,
  fnQuery,
  sessionCreationSpendErrorResponse,
  preflightRefusalResponse,
  type ApiContext,
  type ApiRouteRuntime,
  type SessionSpendPreflightOutcome,
  type WaitUntil,
  type WorkspaceRef,
} from './shared'

const RUNNER_INPUT_DRAIN_LIMIT = 10

export type RunnerDeliveryKind = 'prompt' | 'answer'

export interface PreparedRunnerInputLease {
  sessionId: string
  status: AgentSessionStatus
  submittedThroughSeq: number
  dispatch: {
    attemptId: string
    throughSeq: number
    inputKind: 'initial_prompt' | 'message' | 'answer'
    message: string
    behavior: AgentPromptBehavior
    resolvedModelId: ModelSelectionId
    cwd?: string
    onboarding?: boolean
    mode?: AgentStateMachineDefinition
    createdBySessionId?: string
    defaultSession?: true
    integrations?: IntegrationTurnLaunch
    /** The provider session already reflects this turn's permissions. */
    integrationsReady?: boolean
    mcpServers?: McpServerTurnLaunch
    images?: Array<{ storageId: string; mimeType: string }>
  }
  created?: { snapshot: SessionSnapshot; history: SessionInitialHistorySnapshot }
  deduplicated?: true
}

export type PreparedRunnerInputDelivery =
  | PreparedRunnerInputLease
  | {
      sessionId: string
      status: AgentSessionStatus
      submittedThroughSeq: number
      queued: true
      alreadyDelivered?: true
      created?: { snapshot: SessionSnapshot; history: SessionInitialHistorySnapshot }
      deduplicated?: true
    }

export type AgentStoredInputImage = { storageId: string; mimeType: string; bytes: number }

export interface MarkRunnerInputDeliveredResult {
  status: AgentSessionStatus
  lastDeliveredInputSeq: number
  deliveryAttempt?: RunnerDeliveryAttempt
}

type RunnerDispatchResult =
  | { ok: true; receipt: ReturnType<typeof GatewayRunnerInputReceiptSchema.parse> }
  // `terminal` marks a failure that will never succeed on retry — the
  // gateway's envelope for this session is permanently gone — as opposed to
  // the ordinary case, which stays queued for the next drain tick.
  | { response: Response; terminal?: 'session_discarded' }
type RunnerDeliveryWorkspace = Pick<WorkspaceRef, 'id' | 'slug'>

export async function drainRunnerInputQueue(args: {
  convex: Pick<ConvexHttpClient, 'mutation' | 'query'>
  internalKey: string
  workspaceId: string
  sessionId: string
  now: () => number
  dispatch: (
    prepared: PreparedRunnerInputLease,
    kind: RunnerDeliveryKind,
  ) => Promise<RunnerDispatchResult>
  beforeDispatch?: (prepared: PreparedRunnerInputLease) => Promise<boolean>
  maxIterations?: number
  projectIntegrations?: boolean
}): Promise<{
  delivered: number
  stopped: 'empty' | 'failed' | 'limit' | 'busy'
  response?: Response
}> {
  const maxIterations = args.maxIterations ?? RUNNER_INPUT_DRAIN_LIMIT
  let delivered = 0
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const prepared = (await args.convex.mutation(
      fn('domains/agentSessions/model:prepareRunnerInputDelivery'),
      {
        internalKey: args.internalKey,
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
        attemptId: runnerAttemptId('drain'),
        projectIntegrations: args.projectIntegrations ?? false,
        input: { kind: 'drain' },
        now: args.now(),
      },
    )) as PreparedRunnerInputDelivery
    if ('queued' in prepared) {
      return { delivered, stopped: prepared.alreadyDelivered ? 'empty' : 'busy' }
    }
    if (args.beforeDispatch !== undefined && !(await args.beforeDispatch(prepared))) {
      await args.convex.mutation(fn('domains/agentSessions/model:abandonRunnerInputDelivery'), {
        internalKey: args.internalKey,
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
        attemptId: prepared.dispatch.attemptId,
      })
      return { delivered, stopped: 'failed' }
    }

    const kind = prepared.dispatch.inputKind === 'answer' ? 'answer' : 'prompt'
    const dispatched = await args.dispatch(prepared, kind)
    if ('response' in dispatched) {
      // A discarded session will never accept this input on any retry —
      // abandoning just the lease would leave it queued for the next drain
      // tick to find and fail on again, forever. End the turn instead.
      if (dispatched.terminal === 'session_discarded') {
        await args.convex.mutation(fn('domains/agentSessions/model:finalizeDiscardedSession'), {
          internalKey: args.internalKey,
          workspaceId: args.workspaceId,
          sessionId: args.sessionId,
          now: args.now(),
        })
      } else {
        await args.convex.mutation(fn('domains/agentSessions/model:abandonRunnerInputDelivery'), {
          internalKey: args.internalKey,
          workspaceId: args.workspaceId,
          sessionId: args.sessionId,
          attemptId: prepared.dispatch.attemptId,
        })
      }
      return { delivered, stopped: 'failed', response: dispatched.response }
    }

    await retryRunnerDeliveryMark(
      async () =>
        (await args.convex.mutation(fn('domains/agentSessions/model:markRunnerInputDelivered'), {
          internalKey: args.internalKey,
          workspaceId: args.workspaceId,
          sessionId: args.sessionId,
          attemptId: prepared.dispatch.attemptId,
          throughSeq: prepared.dispatch.throughSeq,
          now: args.now(),
        })) as MarkRunnerInputDeliveredResult,
    )
    delivered += 1
  }

  return { delivered, stopped: 'limit' }
}

export async function drainWorkspaceOnRegister(args: {
  c: ApiContext
  runtime: ApiRouteRuntime
  gatewayClient: GatewayClient
  workspaceId: string
  projectIntegrations?: boolean
  beforeDispatch?: (
    workspace: RunnerDeliveryWorkspace,
    prepared: PreparedRunnerInputLease,
  ) => Promise<boolean>
}): Promise<{
  delivered: number
  stopped: 'empty' | 'failed' | 'limit' | 'busy'
  response?: Response
}> {
  const candidates = (await args.runtime.convex.query(
    fnQuery('domains/agentSessions/model:listRunnerInputDrainCandidates'),
    {
      internalKey: args.runtime.apiInternalKey,
      workspaceId: args.workspaceId,
      limit: RUNNER_INPUT_DRAIN_LIMIT,
    },
  )) as {
    workspaceSlug: string
    sessions: Array<{ sessionId: string }>
  }
  const beforeDispatch = args.beforeDispatch
  let delivered = 0
  let firstFailure: { delivered: number; stopped: 'failed'; response?: Response } | undefined
  for (const session of candidates.sessions) {
    const remaining = RUNNER_INPUT_DRAIN_LIMIT - delivered
    // A failure already caught this pass is more worth the caller's attention
    // than merely hitting the delivery cap — the cap is routine; a failure
    // earlier in the SAME candidate list must not go unreported just because
    // a later session also happened to exhaust the limit.
    if (remaining === 0) {
      return firstFailure === undefined
        ? { delivered, stopped: 'limit' }
        : { ...firstFailure, delivered }
    }
    let drain
    try {
      drain = await drainRunnerInputQueue({
        convex: args.runtime.convex,
        internalKey: args.runtime.apiInternalKey,
        workspaceId: args.workspaceId,
        sessionId: session.sessionId,
        now: args.runtime.now,
        maxIterations: remaining,
        projectIntegrations: args.projectIntegrations,
        beforeDispatch:
          beforeDispatch === undefined
            ? undefined
            : prepared =>
                beforeDispatch({ id: args.workspaceId, slug: candidates.workspaceSlug }, prepared),
        dispatch: (prepared, kind) =>
          dispatchPreparedRunnerInput(
            args.c,
            args.runtime,
            args.gatewayClient,
            { id: args.workspaceId, slug: candidates.workspaceSlug },
            prepared,
            kind,
          ),
      })
    } catch (error) {
      // A wedged session (e.g. its event tail is over the pending limit) must
      // not block input delivery for the sessions behind it; it stays queued
      // and is retried on the next sync pass.
      console.error(`runner input drain failed for session ${session.sessionId}: ${String(error)}`)
      continue
    }
    delivered += drain.delivered
    if (drain.stopped === 'failed') {
      // Same rule as the thrown-failure path above, which this used to miss: a
      // session the gateway refuses must not starve the ones behind it. The
      // next tick re-selects the same ordered set, so returning here turned a
      // deterministically-wedged session into a permanent head-of-line
      // blocker — everything behind it re-queued forever. It stays queued and
      // is retried, and the pass still reports the failure to its caller.
      console.error(
        `[runner-drain] dispatch failed for session ${session.sessionId} on workspace ${args.workspaceId}`,
      )
      firstFailure ??= {
        delivered: 0,
        stopped: 'failed' as const,
        ...(drain.response === undefined ? {} : { response: drain.response }),
      }
      continue
    }
    if (drain.stopped === 'limit') {
      return firstFailure === undefined
        ? { delivered, stopped: 'limit' }
        : { ...firstFailure, delivered }
    }
    if (drain.stopped === 'busy') continue
  }
  return firstFailure === undefined
    ? { delivered, stopped: 'empty' }
    : { ...firstFailure, delivered }
}

export interface PrepareRunnerInputArgs {
  sessionId?: string
  defaultOwner?: { kind: 'root' } | { kind: 'agent'; agentId: string }
  createdBySessionId?: string
  /** Run the session spend preflight inside the prepare transaction. */
  preflight?: { sourceSessionId?: string; estimatedCostMicroUsd?: number }
  input:
    | {
        kind: 'initial_prompt'
        prompt: string
        behavior: AgentPromptBehavior
        clientRequestId?: string
        clientRequestFingerprint?: string
        cwd?: string
        images?: AgentStoredInputImage[]
        attachments?: AgentEventAttachment[]
        tier?: string
        mode?: AgentStateMachineDefinition
        audience?: { kind: 'workspace' } | { kind: 'specific'; memberUserIds: string[] }
        agentFirstMessage?: string
        sender: SessionInputSender
      }
    | {
        kind: 'message'
        prompt: string
        behavior: AgentPromptBehavior
        clientRequestId?: string
        clientRequestFingerprint?: string
        images?: AgentStoredInputImage[]
        attachments?: AgentEventAttachment[]
        tier?: string
        sender: SessionInputSender
      }
    | {
        kind: 'answer'
        answer: string
        clientRequestId?: string
        clientRequestFingerprint?: string
        images?: AgentStoredInputImage[]
        attachments?: AgentEventAttachment[]
        sender: SessionInputSender
      }
  attemptPrefix: string
  projectIntegrations?: boolean
}

export async function prepareRunnerInputForRoute(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  workspaceId: string,
  args: PrepareRunnerInputArgs,
): Promise<PreparedRunnerInputDelivery | { response: Response }> {
  try {
    const prepared = (await runtime.convex.mutation(
      fn('domains/agentSessions/model:prepareRunnerInputDelivery'),
      {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        identity: sessionRequestIdentityForAuth(c.get('auth')),
        workspaceId,
        ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
        ...(args.defaultOwner === undefined ? {} : { defaultOwner: args.defaultOwner }),
        ...(args.createdBySessionId === undefined
          ? {}
          : { createdBySessionId: args.createdBySessionId }),
        ...(args.preflight === undefined ? {} : { preflight: args.preflight }),
        attemptId: runnerAttemptId(args.attemptPrefix),
        projectIntegrations: args.projectIntegrations ?? false,
        input: args.input,
        now: runtime.now(),
      },
    )) as PreparedRunnerInputDelivery | { refused: SessionSpendPreflightOutcome }
    if ('refused' in prepared) {
      return {
        response:
          preflightRefusalResponse(runtime, prepared.refused) ??
          c.json({ error: 'spend_preflight_refused' }, 500),
      }
    }
    return prepared
  } catch (error) {
    const spendResponse = sessionCreationSpendErrorResponse(runtime, error)
    if (spendResponse !== null) return { response: spendResponse }
    return { response: sessionErrorResponse(c, error) }
  }
}

export async function dispatchAndMarkRunnerInput(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
  workspace: WorkspaceRef,
  prepared: PreparedRunnerInputLease,
  kind: RunnerDeliveryKind,
  options: {
    waitUntil?: WaitUntil
    projectIntegrations?: boolean
    beforeQueuedDispatch?: (prepared: PreparedRunnerInputLease) => Promise<boolean>
  } = {},
): Promise<{
  delivery: 'accepted' | 'queued'
  marked?: MarkRunnerInputDeliveredResult
}> {
  let gatewayAccepted = false
  try {
    const dispatched = await dispatchPreparedRunnerInput(
      c,
      runtime,
      gatewayClient,
      workspace,
      prepared,
      kind,
    )
    if ('response' in dispatched) {
      await bestEffortAbandonPreparedRunnerInput(runtime, workspace.id, prepared)
      return { delivery: 'queued' }
    }
    if (dispatched.receipt.acceptedThroughSeq < prepared.dispatch.throughSeq) {
      await bestEffortAbandonPreparedRunnerInput(runtime, workspace.id, prepared)
      return { delivery: 'queued' }
    }
    gatewayAccepted = true
    const marked = await retryRunnerDeliveryMark(() =>
      markPreparedRunnerInput(runtime, workspace.id, prepared),
    )
    options.waitUntil?.(
      drainRunnerInputQueue({
        convex: runtime.convex,
        internalKey: runtime.apiInternalKey,
        workspaceId: workspace.id,
        sessionId: prepared.sessionId,
        now: runtime.now,
        projectIntegrations: options.projectIntegrations,
        beforeDispatch: options.beforeQueuedDispatch,
        dispatch: (nextPrepared, nextKind) =>
          dispatchPreparedRunnerInput(c, runtime, gatewayClient, workspace, nextPrepared, nextKind),
      }),
    )
    return {
      delivery:
        marked.lastDeliveredInputSeq >= prepared.submittedThroughSeq ? 'accepted' : 'queued',
      marked,
    }
  } catch {
    if (!gatewayAccepted) {
      await bestEffortAbandonPreparedRunnerInput(runtime, workspace.id, prepared)
    }
    return { delivery: 'queued' }
  }
}

export async function retryRunnerDeliveryMark<T>(
  mark: () => Promise<T>,
  pause: (delayMs: number) => Promise<void> = delay =>
    new Promise(resolve => setTimeout(resolve, delay)),
): Promise<T> {
  let lastError: unknown
  for (const delayMs of [0, 25, 100]) {
    if (delayMs > 0) await pause(delayMs)
    try {
      return await mark()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

async function markPreparedRunnerInput(
  runtime: ApiRouteRuntime,
  workspaceId: string,
  prepared: PreparedRunnerInputLease,
): Promise<MarkRunnerInputDeliveredResult> {
  return (await runtime.convex.mutation(
    fn('domains/agentSessions/model:markRunnerInputDelivered'),
    {
      internalKey: runtime.internalKey,
      workspaceId,
      sessionId: prepared.sessionId,
      attemptId: prepared.dispatch.attemptId,
      throughSeq: prepared.dispatch.throughSeq,
      now: runtime.now(),
    },
  )) as MarkRunnerInputDeliveredResult
}

async function abandonPreparedRunnerInput(
  runtime: ApiRouteRuntime,
  workspaceId: string,
  prepared: PreparedRunnerInputLease,
): Promise<void> {
  await runtime.convex.mutation(fn('domains/agentSessions/model:abandonRunnerInputDelivery'), {
    internalKey: runtime.internalKey,
    workspaceId,
    sessionId: prepared.sessionId,
    attemptId: prepared.dispatch.attemptId,
  })
}

export async function bestEffortAbandonPreparedRunnerInput(
  runtime: ApiRouteRuntime,
  workspaceId: string,
  prepared: PreparedRunnerInputLease,
): Promise<void> {
  try {
    await abandonPreparedRunnerInput(runtime, workspaceId, prepared)
  } catch {
    // The input is already durable; a cleanup outage must not turn acceptance into rejection.
  }
}

export function sessionResponse(prepared: PreparedRunnerInputLease, lastDeliveredInputSeq: number) {
  return {
    sessionId: prepared.sessionId,
    status: prepared.status,
    lastEventSeq: prepared.dispatch.throughSeq,
    lastDeliveredInputSeq,
  }
}

async function dispatchPreparedRunnerInput(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
  workspace: RunnerDeliveryWorkspace,
  prepared: PreparedRunnerInputLease,
  kind: RunnerDeliveryKind,
): Promise<RunnerDispatchResult> {
  const images = await resolvePreparedRunnerImages(runtime, workspace.id, prepared)
  const inputPath = `/v1/agent/sessions/${encodeURIComponent(prepared.sessionId)}/input`
  if (kind === 'answer') {
    return parseRunnerInputReceipt(
      c,
      await gatewayClient.callAgent(c, workspace.slug, {
        path: inputPath,
        method: 'POST',
        // A discarded session's 410 must reach us verbatim — the default
        // path collapses every non-2xx but 409 to a generic 502.
        passthroughStatuses: [410],
        body: JSON.stringify(
          runnerInputRequest(prepared, {
            kind: 'answer',
            answer: prepared.dispatch.message,
            ...(images === undefined ? {} : { images }),
          }),
        ),
      }),
    )
  }
  return parseRunnerInputReceipt(
    c,
    await gatewayClient.callAgent(c, workspace.slug, {
      path: inputPath,
      method: 'POST',
      passthroughStatuses: [410],
      body: JSON.stringify(
        runnerInputRequest(prepared, {
          kind: 'prompt',
          message: prepared.dispatch.message,
          behavior: prepared.dispatch.behavior,
          ...(images === undefined ? {} : { images }),
        }),
      ),
    }),
  )
}

export function runnerInputRequest(
  prepared: PreparedRunnerInputLease,
  input: GatewayRunnerInputRequest['input'],
): GatewayRunnerInputRequest {
  return {
    attemptId: prepared.dispatch.attemptId,
    throughSeq: prepared.dispatch.throughSeq,
    input,
    launch: {
      tier: prepared.dispatch.resolvedModelId,
      ...(prepared.dispatch.cwd === undefined ? {} : { cwd: prepared.dispatch.cwd }),
      // Session identity, re-derived from the row on every dispatch. The
      // gateway pins it at creation and ignores later flips, but sending it
      // every time is what keeps a resumed or drained turn on the onboarding
      // prompt instead of silently reverting to AGENTS.md.
      ...(prepared.dispatch.onboarding === true ? { onboarding: true } : {}),
      ...(prepared.dispatch.createdBySessionId === undefined
        ? {}
        : { createdBySessionId: prepared.dispatch.createdBySessionId }),
      ...(prepared.dispatch.defaultSession === true ? { defaultSession: true } : {}),
      ...(prepared.dispatch.mode === undefined ? {} : { mode: prepared.dispatch.mode }),
      ...(prepared.dispatch.integrations === undefined
        ? {}
        : { integrations: prepared.dispatch.integrations }),
      // Independent of `integrations` at every layer: the projection behind it
      // is unconditional and reads durable rows, so a workspace with custom
      // servers and no Composio connection still gets its tools.
      ...(prepared.dispatch.mcpServers === undefined
        ? {}
        : { mcpServers: prepared.dispatch.mcpServers }),
    },
  }
}

function parseRunnerInputReceipt(
  c: ApiContext,
  result: Awaited<ReturnType<GatewayClient['callAgent']>>,
): RunnerDispatchResult {
  if ('response' in result) {
    return result.response.status === 410
      ? { response: result.response, terminal: 'session_discarded' }
      : result
  }
  const receipt = GatewayRunnerInputReceiptSchema.safeParse(result.body)
  if (!receipt.success) {
    return { response: c.json({ error: 'agent_gateway_invalid_receipt' }, 502) }
  }
  return { ok: true, receipt: receipt.data }
}

export async function storeAgentInputImages(
  runtime: ApiRouteRuntime,
  images: Array<{ data: string; mimeType: string }> | undefined,
): Promise<AgentStoredInputImage[] | undefined> {
  if (images === undefined || images.length === 0) return undefined
  return (await runtime.convex.action(fnAction('domains/agentSessions/model:storeInputImages'), {
    internalKey: runtime.internalKey,
    images,
  })) as AgentStoredInputImage[]
}

export async function discardAgentInputImages(
  runtime: ApiRouteRuntime,
  images: AgentStoredInputImage[] | undefined,
): Promise<void> {
  if (images === undefined || images.length === 0) return
  try {
    await runtime.convex.action(fnAction('domains/agentSessions/model:deleteStoredInputImages'), {
      internalKey: runtime.internalKey,
      storageIds: images.map(image => image.storageId),
    })
  } catch (error) {
    console.error(`agent input image cleanup failed: ${String(error)}`)
  }
}

export async function fingerprintAgentInput(input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(input))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function resolvePreparedRunnerImages(
  runtime: ApiRouteRuntime,
  workspaceId: string,
  prepared: PreparedRunnerInputLease,
): Promise<AgentInputImage[] | undefined> {
  const refs = prepared.dispatch.images
  if (refs === undefined || refs.length === 0) return undefined
  const urls = (await runtime.convex.action(
    fnAction('domains/agentSessions/model:resolveSessionImageUrls'),
    {
      internalKey: runtime.internalKey,
      workspaceId,
      sessionId: prepared.sessionId,
      images: refs,
    },
  )) as Array<{ url: string; mimeType: string }>
  const images: AgentInputImage[] = []
  for (const image of urls) {
    const response = await fetch(image.url)
    if (!response.ok) throw new Error('Image not found')
    images.push(
      AgentInputImageSchema.parse({
        data: Buffer.from(await response.arrayBuffer()).toString('base64'),
        mimeType: image.mimeType,
      }),
    )
  }
  return images
}

function runnerAttemptId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`
}
