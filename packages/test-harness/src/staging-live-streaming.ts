import assert from 'node:assert/strict'

import { ConvexHttpClient } from 'convex/browser'

import { TrainJobResponseSchema } from '@repo/contract'

import { findReconciledLedgerDebitRows, type ReconciledLedgerDebit } from './demo-60s.ts'
import { fnQuery, type Workspace } from './staging-live-env.ts'
import {
  apiJson,
  assertResponse,
  bearer,
  stagingFetch,
  waitForWorkspace as waitForWorkspaceValue,
} from './staging-live-http.ts'

const TERMINAL_TYPES = new Set(['complete', 'ask', 'interrupted', 'sleep'])
const EPHEMERAL_STEP_TYPES = new Set(['text_delta', 'reasoning_delta', 'tool_call_start'])

export interface ParsedSseFrame {
  id?: number
  event: Record<string, unknown>
  receivedAt: number
  chunkIndex: number
  connectionIndex: number
}

export interface StreamStats {
  firstDeltaAt: number
  terminalAt: number
  spreadMs: number
  deltaCount: number
  reconnectOk: boolean
}
export async function proveStreamingAndReconnect(
  url: string,
  token: string,
): Promise<{ stats: StreamStats; answer: string }> {
  const first = await readEventStream(url, token, undefined, 180_000, {
    connectionIndex: 1,
    stopAfterReconnectEvidence: true,
  })
  assert(first.lastId !== undefined, 'initial stream produced no canonical id frame')
  assert(
    !first.terminal,
    'SSE BUFFERING DETECTED: terminal arrived in the same pre-reconnect delivery window as the first delta',
  )

  const resumed = await readEventStream(url, token, first.lastId, 300_000, {
    connectionIndex: 2,
  })
  const all = [...first.frames, ...resumed.frames]
  const canonical = all.filter(frame => frame.id !== undefined)
  for (let index = 1; index < canonical.length; index += 1) {
    assert.equal(
      canonical[index]!.id,
      canonical[index - 1]!.id! + 1,
      `canonical seq gap after reconnect: ${canonical[index - 1]!.id} -> ${canonical[index]!.id}`,
    )
  }
  const deltas = first.frames.filter(isDeltaFrame)
  const startedToolCalls = all.filter(
    frame => frame.id === undefined && stepType(frame.event) === 'tool_call_start',
  )
  const terminal = all.find(frame => TERMINAL_TYPES.has(eventType(frame.event)))
  assert(deltas.length > 0, 'no id-less text_delta/reasoning_delta frame arrived')
  assert(terminal !== undefined, 'resumed stream did not reach a terminal event')
  assert(terminal.id !== undefined, 'terminal event was not durable/id-bearing')
  if (startedToolCalls.length > 0) {
    assert(
      canonical.some(frame => stepType(frame.event) === 'tool_call'),
      'tool_call_start was not replaced by a durable canonical tool_call step',
    )
  }
  const firstDelta = deltas[0]!
  assert(firstDelta.receivedAt < terminal.receivedAt, 'first delta did not arrive before terminal')
  const spreadMs = terminal.receivedAt - firstDelta.receivedAt
  assert.equal(firstDelta.connectionIndex, 1, 'first delta did not arrive before reconnect')
  assert.equal(terminal.connectionIndex, 2, 'terminal did not arrive after reconnect')
  const answer = terminalAnswer(terminal.event, canonical)
  return {
    answer,
    stats: {
      firstDeltaAt: firstDelta.receivedAt,
      terminalAt: terminal.receivedAt,
      spreadMs,
      deltaCount: deltas.length,
      reconnectOk: true,
    },
  }
}

export function parseSseFrames(
  raw: string,
  receivedAt: number,
  chunkIndex: number,
  connectionIndex = 1,
): ParsedSseFrame[] {
  return raw.split('\n\n').flatMap(block => {
    const lines = block.split('\n')
    const data = lines
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
    if (data.length === 0) return []
    const idLine = lines.find(line => line.startsWith('id:'))
    const id = idLine === undefined ? undefined : Number(idLine.slice(3).trim())
    const parsed = JSON.parse(data) as { seq?: number; event?: Record<string, unknown> }
    assert(parsed.event !== undefined, 'SSE data frame omitted event')
    return [
      {
        ...(id === undefined || !Number.isFinite(id) ? {} : { id }),
        event: parsed.event,
        receivedAt,
        chunkIndex,
        connectionIndex,
      },
    ]
  })
}

export function assertDurableRefetch(frames: ParsedSseFrame[]): void {
  assert(frames.length > 0, 'durable refetch returned no events')
  assert(
    frames.every(frame => frame.id !== undefined),
    'durable refetch contained an id-less row',
  )
  assert(
    frames.some(frame => eventType(frame.event) === 'turn_started'),
    'missing turn_started',
  )
  assert(
    frames.some(frame => eventType(frame.event) === 'step' && stepType(frame.event) === 'text'),
    'missing final canonical text step',
  )
  assert(
    frames.some(frame => TERMINAL_TYPES.has(eventType(frame.event))),
    'missing terminal marker',
  )
  assert(
    frames.every(frame => !EPHEMERAL_STEP_TYPES.has(stepType(frame.event))),
    'ephemeral delta/tool_call_start was persisted',
  )
}

export function reconnectChunkDecision(
  frames: ParsedSseFrame[],
): 'continue' | 'reconnect' | 'terminal' {
  if (frames.some(frame => TERMINAL_TYPES.has(eventType(frame.event)))) return 'terminal'
  return frames.some(frame => frame.id !== undefined) && frames.some(isDeltaFrame)
    ? 'reconnect'
    : 'continue'
}

export function answerReferencesSeededDiscount(answer: string): boolean {
  return /(?:^|\D)20\s*(?:percent|%)/i.test(answer)
}

export function answerPreview(answer: string): string {
  return answer.slice(0, 500)
}

export async function readEventStream(
  url: string,
  token: string,
  lastEventId: number | undefined,
  timeoutMs: number,
  options: {
    connectionIndex?: number
    stopAfterReconnectEvidence?: boolean
    // Return what was read instead of throwing when the leg's own timeout
    // fires. A caller that reconnects needs the frames AND the last id it
    // reached: without them it must resume with no `last-event-id`, and the
    // server then streams from NOW rather than replaying, so everything emitted
    // during the abandoned leg is invisible. Off by default — existing callers
    // rely on the throw.
    returnPartialOnTimeout?: boolean
  } = {},
): Promise<{ frames: ParsedSseFrame[]; lastId?: number; terminal: boolean }> {
  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('SSE timeout'))
  }, timeoutMs)
  const headers = bearer(token)
  if (lastEventId !== undefined) headers.set('last-event-id', String(lastEventId))
  // Kept current INSIDE the loop so a timeout mid-turn still reports the id it
  // actually reached; a value captured only at the end would be lost on abort.
  let partial: { frames: ParsedSseFrame[]; lastId?: number } = { frames: [] }
  try {
    const response = await stagingFetch(url, { headers, signal: controller.signal })
    assertResponse(response, 200, 'agent events')
    assert(response.body !== null, 'agent events response had no body')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const frames: ParsedSseFrame[] = []
    let buffer = ''
    let lastId = lastEventId
    let chunkIndex = 0
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      chunkIndex += 1
      buffer += decoder.decode(chunk.value, { stream: true }).replaceAll('\r\n', '\n')
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() ?? ''
      for (const block of blocks) {
        const parsed = parseSseFrames(block, Date.now(), chunkIndex, options.connectionIndex ?? 1)
        for (const frame of parsed) {
          frames.push(frame)
          if (frame.id !== undefined) lastId = frame.id
        }
      }
      const decision = reconnectChunkDecision(frames)
      if (decision === 'terminal') {
        await reader.cancel().catch(() => undefined)
        return { frames, ...(lastId === undefined ? {} : { lastId }), terminal: true }
      }
      if (options.stopAfterReconnectEvidence === true && decision === 'reconnect') {
        await reader.cancel().catch(() => undefined)
        return { frames, lastId, terminal: false }
      }
      partial = { frames, ...(lastId === undefined ? {} : { lastId }) }
    }
    return { frames, ...(lastId === undefined ? {} : { lastId }), terminal: false }
  } catch (error) {
    if (options.returnPartialOnTimeout === true && timedOut) {
      return { ...partial, terminal: false }
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export async function waitForDebit(
  convex: ConvexHttpClient,
  internalKey: string,
  workspaceId: string,
  timeoutMs: number,
): Promise<{ debit: ReconciledLedgerDebit; generations: Array<Record<string, unknown>> }> {
  const deadline = Date.now() + timeoutMs
  let generations: Array<Record<string, unknown>> = []
  for (;;) {
    const transactions = (await convex.query(
      fnQuery('testing/credits:listWorkspaceTransactionsForTest'),
      {
        internalKey,
        workspaceId,
      },
    )) as Array<Record<string, unknown>>
    generations = (await convex.query(fnQuery('testing/modelGateway:listGenerationsForTest'), {
      internalKey,
      workspaceId,
    })) as Array<Record<string, unknown>>
    const debit = findReconciledLedgerDebitRows({ generations, transactions })
    if (debit !== null) return { debit, generations }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for reconciled ledger debit; generations=${JSON.stringify(generations)}`,
      )
    }
    await Bun.sleep(2_000)
  }
}

export async function waitForWorkspace(
  convex: ConvexHttpClient,
  internalKey: string,
  workspaceId: string,
  predicate: (workspace: Workspace) => boolean | Promise<boolean>,
  timeoutMs = 300_000,
): Promise<Workspace> {
  return await waitForWorkspaceValue({
    workspaceId,
    load: async () => {
      const row = (await convex.query(fnQuery('testing/workspaces:rawWorkspaceByIdForTest'), {
        internalKey,
        workspaceId,
      })) as (Workspace & { runtimeVersion?: string }) | null
      return row === null ? undefined : row
    },
    predicate,
    timeoutMs,
    pollMs: 2_000,
    summarize: workspaceWaitSummary,
  })
}

export function assertWorkspaceCanBecomeActive(workspace: { _id: string; status: string }): void {
  if (['unhealthy', 'retired', 'deleted'].includes(workspace.status)) {
    throw new Error(
      `Workspace ${workspace._id} cannot become active after entering ${workspace.status}`,
    )
  }
}

export function workspaceWaitSummary(workspace: Workspace | undefined): Workspace | undefined {
  if (workspace === undefined) return undefined
  return {
    _id: workspace._id,
    slug: workspace.slug,
    status: workspace.status,
    ...(workspace.vmName === undefined ? {} : { vmName: workspace.vmName }),
    ...(workspace.runtimeVersion === undefined ? {} : { runtimeVersion: workspace.runtimeVersion }),
    ...(workspace.lastHeartbeatAt === undefined
      ? {}
      : { lastHeartbeatAt: workspace.lastHeartbeatAt }),
    ...(workspace.vmTeardownRunId === undefined
      ? {}
      : { vmTeardownRunId: workspace.vmTeardownRunId }),
  }
}

export async function waitForTrain(
  apiUrl: string,
  slug: string,
  jobId: string,
  token: string,
  options: { agentSlug?: string; maxReportDelayMs?: number } = {},
): Promise<{ completionReportLagMs: number }> {
  const deadline = Date.now() + 300_000
  const startedAt = Date.now()
  const trainPath =
    options.agentSlug === undefined
      ? 'train'
      : `agents/${encodeURIComponent(options.agentSlug)}/train`
  for (;;) {
    const body = TrainJobResponseSchema.parse(
      await apiJson(
        `${apiUrl}/v1/ws/${slug}/${trainPath}/${encodeURIComponent(jobId)}`,
        { headers: bearer(token) },
        200,
        'train status',
      ),
    )
    if (body.job.state === 'done') {
      assert(body.job.completedAt !== undefined, 'train completion report has no completion time')
      const completionReportLagMs = Date.now() - body.job.completedAt
      // Freshness is meaningful only when the caller polls continuously from acceptance.
      if (options.maxReportDelayMs !== undefined) {
        assert(
          completionReportLagMs < options.maxReportDelayMs,
          `train completion report was delayed ${completionReportLagMs}ms`,
        )
      }
      return { completionReportLagMs }
    }
    if (
      body.job.state === 'queued' &&
      options.maxReportDelayMs !== undefined &&
      Date.now() - startedAt >= options.maxReportDelayMs
    ) {
      throw new Error(
        `Train ${jobId} still queued after acceptance; running report did not arrive promptly`,
      )
    }
    if (body.job.state === 'failed') throw new Error(`Train failed: ${body.job.error ?? 'unknown'}`)
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for train ${jobId}`)
    await Bun.sleep(2_000)
  }
}

function eventType(event: Record<string, unknown>): string {
  return typeof event.type === 'string' ? event.type : ''
}

function stepType(event: Record<string, unknown>): string {
  const step = event.step
  return typeof step === 'object' &&
    step !== null &&
    typeof (step as { type?: unknown }).type === 'string'
    ? (step as { type: string }).type
    : ''
}

function isDeltaFrame(frame: ParsedSseFrame): boolean {
  return (
    frame.id === undefined &&
    eventType(frame.event) === 'step' &&
    ['text_delta', 'reasoning_delta'].includes(stepType(frame.event))
  )
}

function terminalAnswer(terminal: Record<string, unknown>, canonical: ParsedSseFrame[]): string {
  if (typeof terminal.result === 'string') return terminal.result
  return canonical
    .filter(frame => eventType(frame.event) === 'step' && stepType(frame.event) === 'text')
    .map(frame => {
      const step = frame.event.step as { text?: unknown }
      return typeof step.text === 'string' ? step.text : ''
    })
    .join('\n')
}
