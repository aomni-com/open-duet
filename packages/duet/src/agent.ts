import {
  AGENT_TERMINAL_STATES,
  AgentSessionTimelineEventReadSchema,
  isKnownTimelineEvent,
  type AgentSessionTimelineEvent,
  type AgentSessionTimelineEventRead,
  type AgentTurnEvent,
} from '@repo/contract'

import { resolveWorkspace } from './cli-support.js'
import { CliError, EXIT_CODES, usageError } from './exit-codes.js'
import type { ApiClient } from './http.js'

export interface AgentCliContext {
  global: { json: boolean; workspace?: string }
  config: { defaultWorkspace?: string }
  api: ApiClient
  io: {
    stdout: { write(chunk: string | Buffer): unknown }
  }
}

export async function agent(args: string[], ctx: AgentCliContext): Promise<void> {
  const [subcommand, ...rest] = args
  if (subcommand === 'run') return await runAgent(rest, ctx)
  if (subcommand === 'answer') return await answerAgent(rest, ctx)
  if (subcommand === 'interrupt') return await interruptAgent(rest, ctx)
  throw usageError('Usage: agent run|answer|interrupt ...')
}

async function runAgent(args: string[], ctx: AgentCliContext): Promise<void> {
  if (args.length !== 1) throw usageError('Usage: agent run <prompt>')
  const workspace = resolveWorkspace(ctx)
  const created = await ctx.api.request(`/ws/${encodeURIComponent(workspace)}/agent/sessions`, {
    method: 'POST',
    json: { prompt: args[0] },
  })
  const body = await responseJson(created)
  print(ctx, body)
  const sessionId = sessionIdFrom(body)
  if (sessionId === null)
    throw new CliError(
      'invalid_response',
      'Agent session response was malformed.',
      EXIT_CODES.generic,
    )
  const events = await ctx.api.request(
    `/ws/${encodeURIComponent(workspace)}/agent/sessions/${encodeURIComponent(sessionId)}/events`,
  )
  await streamSse(events, ctx)
}

async function answerAgent(args: string[], ctx: AgentCliContext): Promise<void> {
  if (args.length !== 2) throw usageError('Usage: agent answer <session-id> <answer>')
  const workspace = resolveWorkspace(ctx)
  const response = await ctx.api.request(
    `/ws/${encodeURIComponent(workspace)}/agent/sessions/${encodeURIComponent(args[0]!)}/answer`,
    {
      method: 'POST',
      json: { answer: args[1] },
    },
  )
  print(ctx, await responseJson(response))
}

async function interruptAgent(args: string[], ctx: AgentCliContext): Promise<void> {
  if (args.length !== 1) throw usageError('Usage: agent interrupt <session-id>')
  const workspace = resolveWorkspace(ctx)
  const response = await ctx.api.request(
    `/ws/${encodeURIComponent(workspace)}/agent/sessions/${encodeURIComponent(args[0]!)}/interrupt`,
    {
      method: 'POST',
      json: {},
    },
  )
  print(ctx, await responseJson(response))
}

interface SseFrame {
  id?: number
  data: { seq?: number; event: AgentSessionTimelineEventRead }
}

type AgentStep = Extract<AgentTurnEvent, { type: 'step' }>['step']

interface SseStreamResult {
  lastEventId?: number
}

interface HumanStreamState {
  streamingStepType: 'text_delta' | 'reasoning_delta' | null
  streamingHasContent: boolean
}

async function streamSse(response: Response, ctx: AgentCliContext): Promise<SseStreamResult> {
  if (response.body === null) return {}
  const reader = response.body.getReader()
  try {
    const decoder = new TextDecoder()
    let buffer = ''
    const state: HumanStreamState = { streamingStepType: null, streamingHasContent: false }
    let lastEventId: number | undefined
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) {
        buffer += decoder.decode()
        break
      }
      buffer += decoder.decode(chunk.value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const parsed = parseSseFrame(frame)
        if (parsed === null) continue
        if (parsed.id !== undefined) lastEventId = parsed.id
        if (ctx.global.json) {
          print(ctx, parsed.data)
        } else {
          renderHumanAgentEvent(ctx, state, parsed)
        }
        if (isTerminalAgentEvent(parsed.data.event)) {
          return lastEventId === undefined ? {} : { lastEventId }
        }
      }
    }
    const parsed = parseSseFrame(buffer)
    if (parsed !== null) {
      if (parsed.id !== undefined) lastEventId = parsed.id
      if (ctx.global.json) {
        print(ctx, parsed.data)
      } else {
        renderHumanAgentEvent(ctx, state, parsed)
      }
    }
    return lastEventId === undefined ? {} : { lastEventId }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function parseSseFrame(frame: string): SseFrame | null {
  const fields: { id?: number; data: string[] } = { data: [] }
  for (const rawLine of frame.replace(/\r\n/g, '\n').split('\n')) {
    if (rawLine.length === 0 || rawLine.startsWith(':')) continue
    const separator = rawLine.indexOf(':')
    const name = separator === -1 ? rawLine : rawLine.slice(0, separator)
    const value = separator === -1 ? '' : rawLine.slice(separator + 1).replace(/^ /, '')
    if (name === 'id') {
      const id = Number(value)
      if (Number.isInteger(id)) fields.id = id
    } else if (name === 'data') {
      fields.data.push(value)
    }
  }
  if (fields.data.length === 0) return null
  const parsed = JSON.parse(fields.data.join('\n')) as { seq?: unknown; event?: unknown }
  const event = AgentSessionTimelineEventReadSchema.parse(parsed.event)
  const data: SseFrame['data'] = { event }
  if (typeof parsed.seq === 'number' && Number.isInteger(parsed.seq)) data.seq = parsed.seq
  return fields.id === undefined ? { data } : { id: fields.id, data }
}

function renderHumanAgentEvent(
  ctx: AgentCliContext,
  state: HumanStreamState,
  frame: SseFrame,
): void {
  const event = frame.data.event
  if (!isKnownTimelineEvent(event)) return
  if (event.type === 'step') {
    renderHumanStep(ctx, state, event.step)
    return
  }
  if (event.type === 'turn_started') {
    finishStreamingLine(ctx, state)
    ctx.io.stdout.write('turn: started\n')
    return
  }
  if (event.type === 'system') {
    finishStreamingLine(ctx, state)
    ctx.io.stdout.write(`system ${event.level}: ${event.message}\n`)
    return
  }
  if (
    event.type === 'todos' ||
    event.type === 'follow_up_queue' ||
    event.type === 'state_machine'
  ) {
    finishStreamingLine(ctx, state)
    ctx.io.stdout.write(`${event.type}: ${summarizeDocPatch(event)}\n`)
    return
  }
  if (event.type === 'usage' || event.type === 'memory') return
  if (isTerminalAgentEvent(event)) {
    finishStreamingLine(ctx, state)
    ctx.io.stdout.write(`${event.type}: ${summarizeTerminal(event)}\n`)
  }
}

function renderHumanStep(ctx: AgentCliContext, state: HumanStreamState, step: AgentStep): void {
  switch (step.type) {
    case 'text_delta':
    case 'reasoning_delta':
      if (state.streamingStepType !== null && state.streamingStepType !== step.type) {
        finishStreamingLine(ctx, state)
      }
      state.streamingStepType = step.type
      state.streamingHasContent = true
      ctx.io.stdout.write(step.delta)
      return
    case 'text':
    case 'reasoning':
      if (
        state.streamingHasContent &&
        state.streamingStepType === canonicalStepDeltaType(step.type)
      ) {
        finishStreamingLine(ctx, state)
      } else {
        finishStreamingLine(ctx, state)
        ctx.io.stdout.write(`${step.type}: ${step.text}\n`)
      }
      return
    case 'tool_call_start':
      finishStreamingLine(ctx, state)
      ctx.io.stdout.write(`tool: ${step.toolName} ${step.toolCallId} running\n`)
      return
    case 'tool_call':
      finishStreamingLine(ctx, state)
      ctx.io.stdout.write(
        `tool: ${step.toolName} ${step.toolCallId} ${step.isError ? 'error' : 'ok'}\n`,
      )
      return
    case 'system':
      finishStreamingLine(ctx, state)
      ctx.io.stdout.write(`system: ${step.message}\n`)
      return
  }
}

function finishStreamingLine(ctx: AgentCliContext, state: HumanStreamState): void {
  if (state.streamingHasContent) ctx.io.stdout.write('\n')
  state.streamingStepType = null
  state.streamingHasContent = false
}

function canonicalStepDeltaType(type: 'text' | 'reasoning'): HumanStreamState['streamingStepType'] {
  return type === 'text' ? 'text_delta' : 'reasoning_delta'
}

function summarizeDocPatch(
  event: Extract<AgentTurnEvent, { type: 'todos' | 'follow_up_queue' | 'state_machine' }>,
): string {
  if (event.type === 'todos') return summarizeUnknownCollection(event.todos, 'todo')
  if (event.type === 'follow_up_queue')
    return summarizeUnknownCollection(event.followUpQueue, 'follow-up')
  return 'updated'
}

function summarizeUnknownCollection(value: unknown, label: string): string {
  if (Array.isArray(value)) return `${value.length} ${label}${value.length === 1 ? '' : 's'}`
  return 'updated'
}

function summarizeTerminal(event: AgentSessionTimelineEvent): string {
  if (event.type === 'complete') return event.result ?? event.status ?? 'done'
  if (event.type === 'ask') return 'waiting for answer'
  if (event.type === 'interrupted') return 'interrupted'
  if (event.type === 'sleep') return `sleep until ${event.wakeAt}`
  return event.type
}

function isTerminalAgentEvent(event: AgentSessionTimelineEventRead): boolean {
  return (
    isKnownTimelineEvent(event) &&
    AGENT_TERMINAL_STATES.includes(event.type as (typeof AGENT_TERMINAL_STATES)[number])
  )
}

function print(ctx: AgentCliContext, value: unknown): void {
  if (ctx.global.json) {
    ctx.io.stdout.write(`${JSON.stringify(value)}\n`)
    return
  }
  const type =
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
      ? (value as { type: string }).type
      : 'agent'
  ctx.io.stdout.write(`${type}: ${JSON.stringify(value)}\n`)
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function sessionIdFrom(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const session = (body as { session?: unknown }).session
  if (typeof session !== 'object' || session === null) return null
  const sessionId = (session as { sessionId?: unknown }).sessionId
  return typeof sessionId === 'string' ? sessionId : null
}
