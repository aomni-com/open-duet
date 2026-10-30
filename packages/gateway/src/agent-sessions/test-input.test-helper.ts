import type { GatewayRunnerInputRequest, ModelSelectionId } from '@repo/contract'

import type { AgentSessionsController } from './coordinator'

type PromptInput = Extract<GatewayRunnerInputRequest['input'], { kind: 'prompt' }>
type AnswerInput = Extract<GatewayRunnerInputRequest['input'], { kind: 'answer' }>

interface PromptSpec {
  sessionId: string
  prompt: string
  behavior: PromptInput['behavior']
  tier: ModelSelectionId
  cwd?: string
  integrations?: GatewayRunnerInputRequest['launch']['integrations']
  throughSeq?: number
  attemptId?: string
  images?: PromptInput['images']
}

interface AnswerSpec {
  answer: string
  throughSeq?: number
  attemptId?: string
  images?: AnswerInput['images']
  launch: {
    tier: ModelSelectionId
    cwd?: string
  }
}

interface TestDeliveryState {
  readonly sequenceBySession: Map<string, number>
  readonly sequenceByDelivery: Map<string, number>
}

const deliveryState = new WeakMap<AgentSessionsController, TestDeliveryState>()

export async function deliverPrompt(
  controller: AgentSessionsController,
  spec: PromptSpec,
): Promise<void> {
  await deliverPromptWithReceipt(controller, spec)
}

export async function deliverPromptWithReceipt(
  controller: AgentSessionsController,
  spec: PromptSpec,
): ReturnType<AgentSessionsController['deliverInput']> {
  const throughSeq = testThroughSeq(controller, spec.sessionId, spec)
  return controller.deliverInput(spec.sessionId, {
    attemptId: spec.attemptId ?? `test:${spec.sessionId}:${throughSeq}`,
    throughSeq,
    input: {
      kind: 'prompt',
      message: spec.prompt,
      behavior: spec.behavior,
      ...(spec.images === undefined ? {} : { images: spec.images }),
    },
    launch: {
      tier: spec.tier,
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      ...(spec.integrations === undefined ? {} : { integrations: spec.integrations }),
    },
  })
}

export async function deliverAnswer(
  controller: AgentSessionsController,
  sessionId: string,
  spec: AnswerSpec,
): Promise<void> {
  const throughSeq = testThroughSeq(controller, sessionId, {
    attemptId: spec.attemptId,
    throughSeq: spec.throughSeq,
  })
  await controller.deliverInput(sessionId, {
    attemptId: spec.attemptId ?? `test:${sessionId}:${throughSeq}`,
    throughSeq,
    input: {
      kind: 'answer',
      answer: spec.answer,
      ...(spec.images === undefined ? {} : { images: spec.images }),
    },
    launch: {
      tier: spec.launch.tier,
      ...(spec.launch.cwd === undefined ? {} : { cwd: spec.launch.cwd }),
    },
  })
}

function testThroughSeq(
  controller: AgentSessionsController,
  sessionId: string,
  spec: { attemptId?: string; throughSeq?: number },
): number {
  let state = deliveryState.get(controller)
  if (state === undefined) {
    state = { sequenceBySession: new Map(), sequenceByDelivery: new Map() }
    deliveryState.set(controller, state)
  }
  const deliveryKey = spec.attemptId === undefined ? undefined : `${sessionId}:${spec.attemptId}`
  const priorDeliverySeq =
    deliveryKey === undefined ? undefined : state.sequenceByDelivery.get(deliveryKey)
  if (priorDeliverySeq !== undefined) return priorDeliverySeq

  const parsedDeliverySeq = spec.attemptId?.match(/:(\d+)$/)?.[1]
  const throughSeq =
    spec.throughSeq ??
    (parsedDeliverySeq === undefined
      ? (state.sequenceBySession.get(sessionId) ?? 0) + 1
      : Number(parsedDeliverySeq))
  state.sequenceBySession.set(
    sessionId,
    Math.max(state.sequenceBySession.get(sessionId) ?? 0, throughSeq),
  )
  if (deliveryKey !== undefined) state.sequenceByDelivery.set(deliveryKey, throughSeq)
  return throughSeq
}
