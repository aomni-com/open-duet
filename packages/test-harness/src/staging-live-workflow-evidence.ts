import assert from 'node:assert/strict'

import { waitForForwardProgress } from './staging-live-forward-progress.ts'
import { parseRuntimeReleaseManifest } from './staging-live-runtime'

export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Works on raw event payloads so additive runner evidence is retained verbatim. */
export function inspectWorkflowHistory(
  rows: readonly { seq: number; event: unknown }[],
  toolLimit: number,
) {
  const calls: Array<{
    seq: number
    toolName: string
    input: unknown
    output: unknown
    isError: boolean
  }> = []
  const routes: unknown[] = []
  const receipts = new Map<string, { seq: number; execution: Record<string, unknown> }>()
  let diagnosticSeq: number | undefined
  const questions: unknown[] = []
  const userInputs: unknown[] = []
  const seenCalls = new Set<string>()
  for (const row of rows) {
    const event = record(row.event)
    const step = record(event.step)
    if (event.type === 'step' && (step.type === 'tool_call' || step.type === 'tool_call_start')) {
      assert.notEqual(step.toolName, 'ask_advisor', 'workflow invoked an advisor')
      seenCalls.add(String(step.toolCallId ?? row.seq))
      if (step.type === 'tool_call')
        calls.push({
          seq: row.seq,
          toolName: String(step.toolName),
          input: step.input,
          output: step.output,
          isError: step.isError === true,
        })
    }
    if (event.type === 'router_switch') {
      assert.notEqual(event.trigger, 'advisor', 'workflow routed through an advisor')
      routes.push(event)
    }
    if (event.type === 'prompt_submitted') userInputs.push(row)
    if (event.type === 'ask') questions.push(row)
    const systemMessage =
      event.type === 'system' ? event.message : step.type === 'system' ? step.message : undefined
    if (
      typeof systemMessage === 'string' &&
      /^(?:<system-reminder>\s*)?UNCHANGED EXECUTION:/.test(systemMessage.trim())
    )
      diagnosticSeq ??= row.seq
    const stateMachine = record(event.stateMachine)
    if (Array.isArray(stateMachine.history)) {
      for (const history of stateMachine.history) {
        const item = record(history)
        const execution = record(item.execution)
        if (
          item.type === 'state_started' &&
          typeof execution.id === 'string' &&
          !receipts.has(execution.id)
        )
          receipts.set(execution.id, { seq: row.seq, execution })
      }
    }
  }
  const toolCalls = seenCalls.size
  assert(toolCalls <= toolLimit, `workflow exceeded ${toolLimit} tool calls: ${toolCalls}`)
  return {
    toolCalls,
    calls,
    routes,
    receipts: [...receipts.values()],
    questions,
    unchangedRetriesAfterDiagnostic:
      diagnosticSeq === undefined
        ? 0
        : [...receipts.values()].filter(
            receipt =>
              receipt.seq > diagnosticSeq! && receipt.execution.unchangedFrom !== undefined,
          ).length,
    userInputs,
    relayCreations: calls.filter(call => call.toolName === 'create_state_machine_definition')
      .length,
  }
}

export function assertWorkflowRoutingOff(value: unknown): void {
  const tiers = record(record(value).tiers)
  assert(Object.keys(tiers).length > 0, 'managed routing omitted tiers')
  for (const [name, tier] of Object.entries(tiers)) {
    assert.equal(record(record(tier).advisor).enabled, false, `${name} advisor enabled`)
  }
}

export function historyHasTerminalAfter(
  rows: readonly { seq: number; event: unknown }[],
  prompt: string,
): boolean {
  const input = rows.findLast(
    row => record(row.event).type === 'prompt_submitted' && record(row.event).prompt === prompt,
  )
  return (
    input !== undefined &&
    rows.some(
      row =>
        row.seq > input.seq &&
        ['complete', 'ask', 'sleep', 'interrupted'].includes(String(record(row.event).type)),
    )
  )
}

/** All runtime components converge under the identity of one constructed inventory. */
export async function waitForWorkflowRuntime(args: {
  loadAnnouncement: () => Promise<unknown>
  load: () => Promise<{ runtimeVersion?: string }>
}) {
  return await waitForForwardProgress({
    label: 'workflow runtime release convergence',
    load: async () => ({
      announced: parseRuntimeReleaseManifest(await args.loadAnnouncement()),
      health: await args.load(),
    }),
    isComplete: ({ announced, health }) => health.runtimeVersion === announced.version,
    hasProgress: (before, after) =>
      before.announced.version !== after.announced.version ||
      before.health.runtimeVersion !== after.health.runtimeVersion,
    // Stable identity during the existing rollout window is expected; a stalled activation remains bounded.
    timeoutMs: 40 * 60_000,
    pollMs: 1_000,
    maxConsecutiveUnchangedObservations: 2_400,
  })
}

/** Fresh workspace generation rows prove execution, unlike catalog or routing metadata. */
export function findWorkflowGeneration(
  generations: readonly Record<string, unknown>[],
  advertisedModels: readonly string[],
): Record<string, unknown> | undefined {
  return generations.find(row => {
    const outputTokens = record(record(row.upstreamMetadata).usage).outputTokens
    return (
      row.tier === 'balanced' &&
      typeof row.model === 'string' &&
      advertisedModels.includes(row.model) &&
      row.status === 'settled' &&
      typeof outputTokens === 'number' &&
      outputTokens > 0
    )
  })
}
