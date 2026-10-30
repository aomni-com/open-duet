import {
  discardAgentInputImages,
  dispatchAndMarkRunnerInput,
  prepareRunnerInputForRoute,
  storeAgentInputImages,
  type AgentStoredInputImage,
  type MarkRunnerInputDeliveredResult,
  type PrepareRunnerInputArgs,
  type PreparedRunnerInputDelivery,
} from './agent-runner'
import type { GatewayClient } from './gateway/client'
import {
  synchronizeLeasedSessionIntegrations,
  synchronizePreparedSessionIntegrations,
  type SessionIntegrationOptions,
} from './routes/session-integrations'
import type { PhaseTimer } from './server-timing'
import { type ApiContext, type ApiRouteRuntime, type WaitUntil, type WorkspaceRef } from './shared'

export type SessionSubmissionResult =
  | { kind: 'rejected'; response: Response }
  | { kind: 'integration_unavailable' }
  | {
      kind: 'submitted'
      prepared: PreparedRunnerInputDelivery
      delivery: 'accepted' | 'queued'
      marked?: MarkRunnerInputDeliveredResult
    }

interface SubmitSessionInputArgs {
  c: ApiContext
  runtime: ApiRouteRuntime
  gatewayClient: GatewayClient
  workspace: WorkspaceRef
  images: Array<{ data: string; mimeType: string }> | undefined
  prepare: (images: AgentStoredInputImage[] | undefined) => PrepareRunnerInputArgs
  deliveryKind: 'prompt' | 'answer'
  options: SessionIntegrationOptions & { waitUntil?: WaitUntil }
  beforePrepare?: () => Promise<void>
  /** Receives one mark per pipeline phase, so the route can report the split. */
  timer?: PhaseTimer
}

export async function submitSessionInput(
  args: SubmitSessionInputArgs,
): Promise<SessionSubmissionResult> {
  const images = await storeAgentInputImages(args.runtime, args.images)
  args.timer?.mark('images')
  try {
    await args.beforePrepare?.()
  } catch (error) {
    await discardAgentInputImages(args.runtime, images)
    throw error
  }
  const prepared = await prepareRunnerInputForRoute(
    args.c,
    args.runtime,
    args.workspace.id,
    args.prepare(images),
  )
  args.timer?.mark('prepare')
  if ('response' in prepared) {
    await discardAgentInputImages(args.runtime, images)
    return { kind: 'rejected', response: prepared.response }
  }
  if (prepared.deduplicated === true) await discardAgentInputImages(args.runtime, images)
  const integrationsReady = await synchronizePreparedSessionIntegrations(
    args.c,
    args.runtime,
    args.options,
    args.workspace,
    prepared,
  )
  args.timer?.mark('integrations')
  if (!integrationsReady) {
    return { kind: 'integration_unavailable' }
  }
  if ('queued' in prepared) {
    args.timer?.mark('dispatch')
    return {
      kind: 'submitted',
      prepared,
      delivery: prepared.alreadyDelivered === true ? 'accepted' : 'queued',
    }
  }

  const dispatched = await dispatchAndMarkRunnerInput(
    args.c,
    args.runtime,
    args.gatewayClient,
    args.workspace,
    prepared,
    args.deliveryKind,
    {
      waitUntil: args.options.waitUntil,
      projectIntegrations: args.options.composioMcpProvider !== undefined,
      beforeQueuedDispatch: queued =>
        synchronizeLeasedSessionIntegrations(
          args.c,
          args.runtime,
          args.options,
          args.workspace,
          queued,
        ),
    },
  )
  args.timer?.mark('dispatch')
  return {
    kind: 'submitted',
    prepared,
    delivery: dispatched.delivery,
    ...(dispatched.marked === undefined ? {} : { marked: dispatched.marked }),
  }
}
