import { expect, test } from 'bun:test'

import {
  AgentTurnEventSchema,
  CONVEX_EVENT_BUDGET_BYTES,
  type AgentTurnEvent,
} from '@repo/contract'

import { storableEvent } from './storable-event'

function toolCall(output: unknown[]): AgentTurnEvent {
  return {
    type: 'step',
    step: {
      type: 'tool_call',
      toolName: 'read',
      toolCallId: 'call_1',
      input: { path: 'ads/story-b.png' },
      isError: false,
      output,
    },
  } as AgentTurnEvent
}

test('an event already inside the budget is passed through untouched', () => {
  const event = toolCall([{ type: 'text', text: 'Read 12 lines' }])

  // The journal uses unchanged identity as its signal to avoid rewriting an
  // already normalized record; this is part of that module boundary.
  expect(storableEvent(event)).toBe(event)
})

test('tool output is a small preview across blocks while the local result stays whole', () => {
  const output = [
    { type: 'text', text: 'start: ' + '"\\\n☃'.repeat(4_000) },
    { type: 'text', text: 'tail: ' + 'z'.repeat(8_000) },
  ]
  const event = toolCall(output)
  const original = structuredClone(event)
  const relayed = storableEvent(event)
  const preview = (relayed as { step: { output: Array<{ text: string }> } }).step.output
  expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThanOrEqual(CONVEX_EVENT_BUDGET_BYTES)
  expect(preview[0]?.text).toStartWith(output[0]!.text.slice(0, 12))
  expect(preview[0]?.text).toContain('[truncated')
  expect(preview[0]?.text).not.toContain('�')
  expect(event).toEqual(original)
  expect(storableEvent(relayed)).toEqual(relayed)
})

test('script output publishes a small preview without changing the local task output', () => {
  const event: AgentTurnEvent = {
    type: 'task_output',
    taskId: 't1',
    chunk: 'build log: ' + '☃\\\n'.repeat(8_000),
  }
  const original = structuredClone(event)
  const relayed = storableEvent(event)
  if (relayed.type !== 'task_output') throw new Error('task output changed type')
  expect(Buffer.byteLength(JSON.stringify(relayed.chunk))).toBeLessThanOrEqual(
    CONVEX_EVENT_BUDGET_BYTES,
  )
  expect(relayed.chunk).toStartWith('build log: ')
  expect(relayed.chunk).toContain('[truncated')
  expect(relayed.chunk).not.toContain('�')
  expect(event).toEqual(original)
  expect(storableEvent(relayed)).toEqual(relayed)
})

test('machine failure history previews every independent terminal reason copy', () => {
  const reason = 'build failed: ' + 'x'.repeat(350 * 1024)
  const terminal = { state: 'build', status: 'error', reason }
  const event = AgentTurnEventSchema.parse({
    type: 'state_machine',
    stateMachine: {
      definition: {
        name: 'build',
        prompt: 'build',
        states: [{ name: 'build', kind: 'script', command: 'build' }],
      },
      prompt: 'build',
      createdAt: 0,
      updatedAt: 1,
      terminal,
      history: [
        { type: 'state_failed', timestamp: 1, state: 'build', error: reason },
        { type: 'state_machine_completed', timestamp: 1, terminal },
        {
          type: 'state_machine_reactivated',
          timestamp: 2,
          state: 'build',
          priorTerminal: terminal,
        },
      ],
    },
  })
  const original = structuredClone(event)
  const relayed = storableEvent(event)
  if (relayed.type !== 'state_machine') throw new Error('machine changed type')
  for (const entry of relayed.stateMachine.history) {
    const text =
      'terminal' in entry
        ? entry.terminal.reason
        : 'priorTerminal' in entry
          ? entry.priorTerminal.reason
          : 'error' in entry
            ? entry.error
            : undefined
    expect(Buffer.byteLength(JSON.stringify(text))).toBeLessThanOrEqual(CONVEX_EVENT_BUDGET_BYTES)
    expect(text).toStartWith('build failed: ')
    expect(text).toContain('[truncated')
  }
  expect(relayed.stateMachine.terminal).toMatchObject({ state: 'build', status: 'error' })
  expect(relayed.stateMachine.terminal?.reason).toStartWith('build failed: ')
  expect(relayed.stateMachine.terminal?.reason).toContain('[truncated')
  expect(Buffer.byteLength(JSON.stringify(relayed))).toBeLessThanOrEqual(CONVEX_EVENT_BUDGET_BYTES)
  expect(event).toEqual(original)
  expect(storableEvent(relayed)).toEqual(relayed)
})

test('task settlements keep their identity and status while bounding diagnostic values', () => {
  for (const settlement of [
    {
      id: 't1' as const,
      status: 'completed' as const,
      settledAt: 10,
      result: { stdout: 'x'.repeat(350 * 1024), exitCode: 0 },
    },
    {
      id: 't1' as const,
      status: 'failed' as const,
      settledAt: 10,
      error: { message: 'x'.repeat(350 * 1024), code: 1 },
    },
    {
      id: 't1' as const,
      status: 'stopped' as const,
      settledAt: 10,
      reason: 'x'.repeat(350 * 1024),
    },
  ]) {
    const event: AgentTurnEvent = { type: 'task_settled', settlement }
    const original = structuredClone(event)
    const relayed = storableEvent(event)
    if (relayed.type !== 'task_settled') throw new Error('settlement changed type')
    const { id, status, settledAt, ...payload } = relayed.settlement
    expect({ id, status, settledAt }).toEqual({
      id: 't1' as const,
      status: settlement.status,
      settledAt: 10,
    })
    expect(Buffer.byteLength(JSON.stringify(Object.values(payload)[0]))).toBeLessThanOrEqual(
      CONVEX_EVENT_BUDGET_BYTES,
    )
    expect(JSON.stringify(payload)).toContain('[truncated')
    expect(event).toEqual(original)
    expect(storableEvent(relayed)).toEqual(relayed)
  }
})

test('tool input and details previews retain small arguments without copying large payloads', () => {
  const event = toolCall([{ type: 'text', text: 'wrote file' }])
  if (event.type !== 'step' || event.step.type !== 'tool_call') throw new Error('not a tool')
  event.step.input = { path: '/site/index.html', content: 'html'.repeat(70_000) }
  event.step.details = { exitCode: 0, logs: 'log'.repeat(70_000) }
  const original = structuredClone(event)
  const relayed = storableEvent(event)
  if (relayed.type !== 'step' || relayed.step.type !== 'tool_call') throw new Error('not a tool')
  expect(Buffer.byteLength(JSON.stringify(relayed.step.input))).toBeLessThanOrEqual(
    CONVEX_EVENT_BUDGET_BYTES,
  )
  expect(Buffer.byteLength(JSON.stringify(relayed.step.details))).toBeLessThanOrEqual(
    CONVEX_EVENT_BUDGET_BYTES,
  )
  expect(relayed.step.input?.path).toBe('/site/index.html')
  expect(relayed.step.details).toMatchObject({ exitCode: 0 })
  expect(relayed.step.output).toEqual([{ type: 'text', text: 'wrote file' }])
  expect(Buffer.byteLength(JSON.stringify(relayed))).toBeLessThanOrEqual(CONVEX_EVENT_BUDGET_BYTES)
  expect(JSON.stringify(relayed.step.input)).toContain('[truncated')
  expect(JSON.stringify(relayed.step.details)).toContain('[truncated')
  expect(event).toEqual(original)
  expect(storableEvent(relayed)).toEqual(relayed)
})

test('a tool output relays its text and replaces image data with a marker', () => {
  const event = toolCall([
    { type: 'text', text: 'Read image file [image/png]' },
    { type: 'image', mimeType: 'image/png', data: 'A'.repeat(1_353_092) },
  ])

  const relayed = storableEvent(event)

  const step = (relayed as { step: { output: Array<{ type: string; text?: string }> } }).step
  expect(step.output.map(part => part.type)).toEqual(['text', 'text'])
  expect(step.output[0]?.text).toBe('Read image file [image/png]')
  // The size is the point of the marker: a reader can tell an image from a log.
  expect(step.output[1]?.text).toBe('[image omitted — 1.3 MB image/png]')
})

test('an oversized tool output keeps its head and says how much was cut', () => {
  const event = toolCall([{ type: 'text', text: 'x'.repeat(32 * 1024) }])

  const relayed = storableEvent(event)

  const text = (relayed as { step: { output: Array<{ text: string }> } }).step.output[0]?.text ?? ''
  expect(text.startsWith('xxxx')).toBe(true)
  expect(text.endsWith('[truncated — 32 KB total]')).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(relayed))).toBeLessThanOrEqual(CONVEX_EVENT_BUDGET_BYTES)
})

test('an oversized tool input is cut like any other prose, keeping its shape', () => {
  // A file-write's content rides in the INPUT — the only unbounded string a
  // tool_call_start carries, since it has no output yet.
  const event = {
    type: 'step',
    step: {
      type: 'tool_call_start',
      toolName: 'write',
      toolCallId: 'call_2',
      input: { path: 'site/page.html', content: 'w'.repeat(32 * 1024) },
    },
  } as unknown as AgentTurnEvent

  const relayed = storableEvent(event)

  const input = (relayed as unknown as { step: { input: { path: string; content: string } } }).step
    .input
  expect(input.path).toBe('site/page.html')
  expect(input.content.startsWith('wwww')).toBe(true)
  expect(input.content.endsWith('[truncated — 32 KB total]')).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(relayed))).toBeLessThanOrEqual(CONVEX_EVENT_BUDGET_BYTES)
})

test('a terminal sheds its transcript and keeps what the control plane projects', () => {
  // A terminal carries the whole turn. The control plane projects todos, the
  // follow-up queue and the state machine off it and reads nothing else, so
  // the messages are pure weight on a mutation that has to parse them.
  const event = {
    type: 'complete',
    status: 'completed',
    result: 'done',
    state: {
      status: 'completed',
      mode: 'agent',
      agent: {
        status: 'completed',
        messages: [{ role: 'assistant', text: 'y'.repeat(CONVEX_EVENT_BUDGET_BYTES + 1) }],
      },
      todos: [{ id: 'ship', content: 'Ship it', status: 'completed' }],
    },
  } as unknown as AgentTurnEvent

  const relayed = storableEvent(event) as unknown as {
    state: { agent: { messages: unknown[] }; todos: unknown }
  }

  expect(relayed.state.agent.messages).toEqual([])
  expect(relayed.state.todos).toEqual([{ id: 'ship', content: 'Ship it', status: 'completed' }])
  expect(Buffer.byteLength(JSON.stringify(relayed))).toBeLessThanOrEqual(CONVEX_EVENT_BUDGET_BYTES)
})

test('a terminal relays only the state the control plane reads', () => {
  // Convex refuses any object value with more than 1,024 entries at the
  // argument boundary, and `taskOutputTails` carries one key per tool call, so
  // a long enough turn could never deliver its terminal. Two tasks are enough
  // to prove their complete omission without building a boundary-sized crowd.
  // Nothing on the
  // control plane reads tasks, tails, queued commands or the runner's counters
  // — the VM checkpoint keeps them — so they stay home.
  const tails: Record<string, string[]> = {}
  const tasks: unknown[] = []
  for (let i = 0; i < 2; i += 1) {
    tails[`t${i}`] = ['line']
    tasks.push({ id: `t${i}`, kind: 'tool', status: 'completed' })
  }
  const stateMachine = {
    currentState: 'completed',
    definition: {
      name: 'import',
      prompt: 'import',
      states: [{ name: 'completed', kind: 'terminal', status: 'completed' }],
    },
    prompt: 'import',
    history: [],
    createdAt: 0,
    updatedAt: 0,
  }
  const event = {
    type: 'complete',
    status: 'completed',
    result: 'done',
    state: {
      status: 'completed',
      mode: 'agent',
      options: { model: 'frontier' },
      agent: { status: 'completed', messages: [{ role: 'assistant', text: 'y' }] },
      stateMachine,
      todos: [{ id: 'ship', content: 'Ship it', status: 'completed' }],
      followUpQueue: [{ id: 'f1', message: 'next' }],
      queuedCommands: [],
      tasks,
      taskOutputTails: tails,
      pendingLostTaskReminderTaskIds: ['t3'],
      nextTaskId: 3,
      wireGuardHorizon: { evictionHorizon: 5 },
    },
  } as unknown as AgentTurnEvent

  const relayed = storableEvent(event) as unknown as { state: Record<string, unknown> }

  expect(Object.keys(relayed.state).sort()).toEqual(
    ['agent', 'followUpQueue', 'mode', 'stateMachine', 'status', 'todos'].sort(),
  )
  expect(relayed.state.stateMachine).toEqual(stateMachine)
  expect(relayed.state.followUpQueue).toEqual([{ id: 'f1', message: 'next' }])
  expect(relayed.state.agent).toEqual({ status: 'completed', messages: [] })
})

test('nested relay tool inputs fit the API budget without changing the executed input', () => {
  const prompt = 'x'.repeat(350 * 1024)
  const input = {
    decision: { state: 'await-approval', override: { kind: 'agent', state: { prompt } } },
  }
  const event: AgentTurnEvent = {
    type: 'step',
    step: {
      type: 'tool_call',
      toolName: 'select_state_machine_state',
      toolCallId: 'nested',
      input,
      isError: false,
      output: [{ type: 'text', text: 'selected' }],
    },
  }
  const relayed = storableEvent(event)
  expect(Buffer.byteLength(JSON.stringify(relayed))).toBeLessThanOrEqual(CONVEX_EVENT_BUDGET_BYTES)
  expect(relayed).toMatchObject({
    step: {
      input: { decision: { state: 'await-approval' } },
      output: [{ type: 'text', text: 'selected' }],
    },
  })
  expect(JSON.stringify(relayed)).toContain('[truncated')
  expect(input.decision.override.state.prompt).toBe(prompt)
  expect(storableEvent(relayed)).toEqual(relayed)
})

test('structural tool input bulk is replaced by an explicit omission without losing the result', () => {
  const event: AgentTurnEvent = {
    type: 'step',
    step: {
      type: 'tool_call',
      toolName: 'batch',
      toolCallId: 'structural',
      input: { values: Array.from({ length: 160_000 }, () => 0) },
      isError: false,
      output: [{ type: 'text', text: 'batch completed' }],
    },
  }
  const relayed = storableEvent(event)
  expect(Buffer.byteLength(JSON.stringify(relayed))).toBeLessThanOrEqual(CONVEX_EVENT_BUDGET_BYTES)
  expect(relayed).toMatchObject({
    step: {
      toolCallId: 'structural',
      isError: false,
      output: [{ type: 'text', text: 'batch completed' }],
    },
  })
  expect(JSON.stringify(relayed)).toContain('input omitted')
  expect(JSON.stringify(event)).not.toContain('input omitted')
})

test('many short output blocks still shrink when a marker saves encoded bytes', () => {
  const block = { type: 'text', text: 'x'.repeat(40) }
  const count = Math.floor(CONVEX_EVENT_BUDGET_BYTES / Buffer.byteLength(JSON.stringify(block))) + 1
  const event = toolCall(Array.from({ length: count }, () => ({ ...block })))
  const relayed = storableEvent(event)
  expect(Buffer.byteLength(JSON.stringify(relayed))).toBeLessThanOrEqual(CONVEX_EVENT_BUDGET_BYTES)
  expect(JSON.stringify(relayed)).toContain('[truncated')
})
