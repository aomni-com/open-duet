import { describe, expect, test } from 'bun:test'

import {
  AGENT_SESSION_EVENT_TYPES,
  AgentSessionTimelineEventSchema,
  classifyAgentTurnEvent,
  TurnStepSchema,
  type AgentSessionTimelineEvent,
} from '../agent/index'
import {
  CHAT_PREVIEW_MAX,
  MessagePreviewSchema,
  messagePreviewFromInput,
  messagePreviewOf,
} from './message-preview'
import type { MessagePreview } from './message-preview'

const TURN_STATE = {
  status: 'running' as const,
  mode: 'agent' as const,
  agent: { status: 'running' as const, messages: [] },
}

const SENDER = { kind: 'user' as const, userId: 'user-1' }

const TOKEN_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const USAGE_FIELDS = {
  turnUsage: TOKEN_USAGE,
  usageByModel: [],
  lastMessageUsage: TOKEN_USAGE,
  effectiveContextWindow: 200_000,
  contextWindowUsage: { systemPrompt: 0, messages: 0, localMemory: 0, globalMemory: 0 },
}

type TurnStep = Extract<AgentSessionTimelineEvent, { type: 'step' }>['step']

/**
 * Every step shape, and whether it is something the agent *said*.
 *
 * Typed as a total record so a new step arm cannot be added to the contract
 * without a decision landing here — the same guard the event table below gets
 * from iterating the contract's own list.
 */
const STEP_CASES: Record<TurnStep['type'], { step: unknown; preview: MessagePreview | null }> = {
  text: {
    step: { type: 'text', text: 'the deploy is green' },
    preview: { text: 'the deploy is green', author: { kind: 'agent' } },
  },
  reasoning: { step: { type: 'reasoning', text: 'first I should check the logs' }, preview: null },
  tool_call_start: {
    step: { type: 'tool_call_start', toolName: 'read_file', toolCallId: 'call-1' },
    preview: null,
  },
  tool_call: {
    step: { type: 'tool_call', toolName: 'read_file', toolCallId: 'call-1', isError: false },
    preview: null,
  },
  system: { step: { type: 'system', message: 'context compacted' }, preview: null },
  text_delta: { step: { type: 'text_delta', delta: 'the depl' }, preview: null },
  reasoning_delta: { step: { type: 'reasoning_delta', delta: 'first I' }, preview: null },
}

/**
 * One real event per type the journal can hold, and what the rule says it is.
 *
 * Driven off `AGENT_SESSION_EVENT_TYPES` rather than a list of its own, so an
 * event type minted without a decision here fails as a missing case rather
 * than as a preview nobody notices is absent.
 */
const EVENT_CASES: Record<
  (typeof AGENT_SESSION_EVENT_TYPES)[number],
  { event: unknown; preview: MessagePreview | null }
> = {
  prompt_submitted: {
    event: {
      type: 'prompt_submitted',
      prompt: 'ship the lander copy',
      inputKind: 'message',
      behavior: 'steer',
      sender: SENDER,
    },
    preview: { text: 'ship the lander copy', author: SENDER },
  },
  note_submitted: {
    event: { type: 'note_submitted', note: 'also check the pricing page', sender: SENDER },
    preview: { text: 'also check the pricing page', author: SENDER },
  },
  answer_submitted: {
    event: { type: 'answer_submitted', answer: 'yes, overwrite it', sender: SENDER },
    preview: { text: 'yes, overwrite it', author: SENDER },
  },
  agent_message: {
    event: { type: 'agent_message', message: 'I keep the lander honest.', createdAt: '2026-08-23' },
    preview: { text: 'I keep the lander honest.', author: { kind: 'agent' } },
  },
  // The one arm with an interior of its own; `STEP_CASES` walks the rest of it.
  step: {
    event: { type: 'step', step: { type: 'text', text: 'the deploy is green' } },
    preview: { text: 'the deploy is green', author: { kind: 'agent' } },
  },
  // A conversation's opening prompt is journaled twice — here and as the
  // `prompt_submitted` beside it — so previewing both would write the first
  // word of every conversation twice.
  session_created: {
    event: { type: 'session_created', prompt: 'ship the lander copy', createdAt: '2026-08-23' },
    preview: null,
  },
  interrupt_requested: {
    event: { type: 'interrupt_requested', requestedAt: '2026-08-23' },
    preview: null,
  },
  turn_started: { event: { type: 'turn_started', state: TURN_STATE }, preview: null },
  task_started: {
    event: {
      type: 'task_started',
      task: {
        id: 't1',
        kind: 'tool',
        name: 'build',
        label: 'Build',
        ownerScopeId: 'turn-1',
        status: 'running',
        startedAt: 1,
      },
    },
    preview: null,
  },
  task_output: { event: { type: 'task_output', taskId: 't1', chunk: 'compiling…' }, preview: null },
  task_settled: {
    event: {
      type: 'task_settled',
      settlement: { id: 't1', status: 'completed', settledAt: 2, result: 'ok' },
    },
    preview: null,
  },
  heartbeat: { event: { type: 'heartbeat', timestamp: 1, activeTaskIds: [] }, preview: null },
  todos: { event: { type: 'todos', todos: [] }, preview: null },
  follow_up_queue: { event: { type: 'follow_up_queue', followUpQueue: [] }, preview: null },
  state_machine: {
    event: {
      type: 'state_machine',
      stateMachine: {
        definition: { name: 'review', prompt: 'Review it.', states: [] },
        prompt: 'Review it.',
        currentState: 'review',
        history: [],
        createdAt: 1,
        updatedAt: 1,
      },
    },
    preview: null,
  },
  memory: {
    event: { type: 'memory', phase: 'observation', status: 'running', message: 'Indexing' },
    preview: null,
  },
  usage: { event: { type: 'usage', ...USAGE_FIELDS }, preview: null },
  // Even at `error`, where it is durable and a reader is meant to see it: a
  // system notice is the product speaking about the conversation, not somebody
  // speaking in it.
  system: {
    event: { type: 'system', level: 'error', message: 'the provider refused' },
    preview: null,
  },
  router_switch: {
    event: {
      type: 'router_switch',
      tier: 'max',
      route: 'advisor',
      fromModel: 'a',
      toModel: 'b',
      thinkingLevel: 'high',
      trigger: 'cadence',
      probabilities: { implement: 0.82, general: 0.18 },
      visionFallback: false,
    },
    preview: null,
  },
  complete: {
    event: { type: 'complete', status: 'completed', result: 'shipped it' },
    preview: null,
  },
  ask: { event: { type: 'ask', questions: [] }, preview: null },
  interrupted: { event: { type: 'interrupted' }, preview: null },
  sleep: { event: { type: 'sleep', wakeAt: 9_000 }, preview: null },
}

describe('messagePreviewOf', () => {
  test('a just-typed input uses the same prose rule before it becomes an event', () => {
    expect(messagePreviewFromInput(SENDER, '## Ship it\n\n- [x] now')).toEqual({
      text: 'Ship it now',
      author: SENDER,
    })
  })

  /* The whole event union, one case at a time. A message is exactly what the
     browser's transcript turns into a bubble: the three inputs, the agent's
     out-of-turn message, and a finished text step. */
  for (const type of AGENT_SESSION_EVENT_TYPES) {
    test(`${type} is${EVENT_CASES[type].preview === null ? ' not' : ''} a message`, () => {
      const event = AgentSessionTimelineEventSchema.parse(EVENT_CASES[type].event)
      expect(event.type).toBe(type)
      expect(messagePreviewOf(event)).toEqual(EVENT_CASES[type].preview)
    })
  }

  for (const type of Object.keys(STEP_CASES) as readonly TurnStep['type'][]) {
    const expected = STEP_CASES[type]
    test(`a ${type} step is${expected.preview === null ? ' not' : ''} a message`, () => {
      const step = TurnStepSchema.parse(expected.step)
      expect(step.type).toBe(type)
      const event = AgentSessionTimelineEventSchema.parse({ type: 'step', step })
      expect(messagePreviewOf(event)).toEqual(expected.preview)
    })
  }

  /* ---- never a streaming partial ----
     Not enforced by a filter anywhere, and deliberately so: the deltas are
     `ephemeral`, and the relay's store path takes `Exclude<AgentEventClass,
     'ephemeral'>`, so no delta can reach a stored event to be previewed from.
     This pins the classification that makes the filter unnecessary; the backend
     pins the other half, that a relayed delta stores nothing. */
  test('a streaming delta never becomes durable, so it can never be a preview', () => {
    expect(
      classifyAgentTurnEvent({ type: 'step', step: { type: 'text_delta', delta: 'half a ' } }),
    ).toBe('ephemeral')
    expect(
      classifyAgentTurnEvent({ type: 'step', step: { type: 'reasoning_delta', delta: 'half a ' } }),
    ).toBe('ephemeral')
  })

  test('markdown arrives as the prose inside it', () => {
    const event = AgentSessionTimelineEventSchema.parse({
      type: 'agent_message',
      createdAt: '2026-08-23',
      message:
        '## Done\n\n- Shipped **the lander** and [the pricing page](/pricing)\n- Left `robots.txt` alone',
    })
    expect(messagePreviewOf(event)).toEqual({
      text: 'Done Shipped the lander and the pricing page Left robots.txt alone',
      author: { kind: 'agent' },
    })
  })

  test('a fenced block is dropped, not flattened', () => {
    // The one kind of message whose first hundred characters say nothing about
    // it. The prose around the fence is what the reader was looking for.
    const event = AgentSessionTimelineEventSchema.parse({
      type: 'note_submitted',
      sender: SENDER,
      note: 'this keeps failing:\n\n```ts\nconst x: number = "1"\nconst y = x + 1\n```\n\nany idea?',
    })
    expect(messagePreviewOf(event)).toEqual({
      text: 'this keeps failing: any idea?',
      author: SENDER,
    })
  })

  test('a message with no prose in it is not a message', () => {
    // An empty band under a name reads as a line that failed rather than as an
    // agent nobody has written to, so there is no preview rather than a blank.
    const event = AgentSessionTimelineEventSchema.parse({
      type: 'note_submitted',
      sender: SENDER,
      note: '```\nnpm run build\n```',
    })
    expect(messagePreviewOf(event)).toBeNull()
  })

  test('a message that is only files is previewed by them', () => {
    // A files-only send is the newest thing said; without this the row would
    // keep showing the message before it as the last word.
    const filesOnly = AgentSessionTimelineEventSchema.parse({
      type: 'prompt_submitted',
      inputKind: 'message',
      behavior: 'steer',
      sender: SENDER,
      prompt: '',
      attachments: [{ path: 'uploads/brief.pdf', name: 'brief.pdf', bytes: 1 }],
    })
    expect(messagePreviewOf(filesOnly)).toEqual({ text: 'brief.pdf', author: SENDER })
    const imageOnly = AgentSessionTimelineEventSchema.parse({
      type: 'note_submitted',
      sender: SENDER,
      note: '',
      images: [{ storageId: 'storage-1', mimeType: 'image/png', bytes: 1 }],
    })
    expect(messagePreviewOf(imageOnly)).toEqual({ text: 'Image', author: SENDER })
    expect(
      messagePreviewFromInput(SENDER, '', {
        attachments: [{ name: 'a.csv' }],
      }),
    ).toEqual({ text: 'a.csv', author: SENDER })
  })

  test('the cut is the contract constant, ellipsis included', () => {
    const event = AgentSessionTimelineEventSchema.parse({
      type: 'prompt_submitted',
      inputKind: 'message',
      behavior: 'steer',
      sender: SENDER,
      prompt: 'word '.repeat(CHAT_PREVIEW_MAX),
    })
    const preview = messagePreviewOf(event)
    expect(preview?.text.length).toBe(CHAT_PREVIEW_MAX)
    expect(preview?.text.endsWith('…')).toBe(true)
    // The schema is what the wire enforces, so the cut has to satisfy it.
    expect(MessagePreviewSchema.parse(preview)).toEqual(preview!)
  })
})

/* ---------------------------------------------------- who actually said it

   A two-value category is true and useless: a workspace has several members,
   so it can say a person spoke and never which one. The stored input events
   carry a full sender identity — `{ kind: 'user', userId }`, or an app, a
   session, or the system — and the contract's rule for those is that ids are
   stored and names are resolved by the reader. The preview keeps that rule
   rather than collapsing them.

   The agent's own voice is not a `SessionInputSender` (nothing submitted it),
   so it gets a kind of its own beside them. */
test('a person’s message carries the identity that submitted it, not just “user”', () => {
  const sender = { kind: 'user', userId: 'user_ada' } as const
  const event = AgentSessionTimelineEventSchema.parse({
    type: 'prompt_submitted',
    prompt: 'ship it',
    inputKind: 'message',
    behavior: 'steer',
    sender,
  })
  expect(messagePreviewOf(event)?.author).toEqual(sender)
})

test('an app and a sending session keep their own identities too', () => {
  const app = { kind: 'app', appId: 'app_invoices' } as const
  const note = AgentSessionTimelineEventSchema.parse({
    type: 'note_submitted',
    note: 'reconciled',
    sender: app,
  })
  expect(messagePreviewOf(note)?.author).toEqual(app)

  const session = { kind: 'session', sessionId: 'ses_7' } as const
  const answer = AgentSessionTimelineEventSchema.parse({
    type: 'answer_submitted',
    answer: '1-7 August',
    sender: session,
  })
  expect(messagePreviewOf(answer)?.author).toEqual(session)
})

/* Nothing submitted the agent's own words, so there is no sender to carry and
   the kind stands alone. A reader draws no name for it either: the row is
   already under the agent's name, and a second copy fifteen pixels lower is
   redundancy in a line that is already truncating. */
test('the agent’s own voice is its own kind, with no identity behind it', () => {
  const event = AgentSessionTimelineEventSchema.parse({
    type: 'agent_message',
    message: 'done',
    createdAt: '2026-08-23T00:00:00.000Z',
  })
  expect(messagePreviewOf(event)?.author).toEqual({ kind: 'agent' })
})
